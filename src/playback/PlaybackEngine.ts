import { clipDuration, clipEnd } from "../project/createProject.ts";
import type { ChromaKeySettings, Clip, ClipEffects, ClipTransform, ColorGrading, Project, TextStyle, TransitionType, Track } from "../project/types.ts";
import { isIdentityColorGrading, isIdentityEffects, isIdentityTextCrop } from "../project/types.ts";
import type { ClipOverride } from "../timeline/groupMove.ts";
import { applyColorGrading, buildCurveLut, composeLuts } from "../timeline/colorCurves.ts";
import { resolveClipColorGrading, resolveClipEffects, resolveClipTransform, resolveTextStyle } from "../timeline/keyframes.ts";
import { audibleClips, clipAtTime } from "../timeline/queries.ts";
import {
  activeWordIndex,
  computeTextAnimationTransform,
  DEFAULT_WORD_HIGHLIGHT_COLOR,
  segmentLine,
  splitWords,
  typewriterVisibleContent,
} from "../timeline/textAnimation.ts";
import { findTransitionOut, findTransitionPartner, resolveAudioTransitionGain } from "../timeline/transitions.ts";
import { AudioMixEngine } from "./AudioMixEngine.ts";
import { computeTransformedBox } from "./transformGeometry.ts";
import { computeTextBlock, TEXT_BOX_PADDING } from "./textLayout.ts";

/** How far ahead of the playhead `tick()` looks when deciding whether to kick off decoding an
 *  upcoming audio-track clip's asset early — see the prefetch scan in `tick()` itself. */
const AUDIO_PREFETCH_LOOKAHEAD_SECONDS = 5;
/** How often the prefetch scan actually runs — throttled well below the render loop's own ~60Hz cadence
 *  since it walks every audio-track clip on every audio track, real but modest work not worth paying
 *  every single frame for a decision that only matters on a several-second timescale anyway. */
const AUDIO_PREFETCH_SCAN_INTERVAL_MS = 1000;

/** Groups `TransitionType`'s ten styles into the four shapes the canvas preview actually knows how to
 *  render — exported (not a private switch inline) so it's directly unit-testable without a canvas.
 *  `compositeTransitionFrame` is what turns one of these into real pixels; `export/buildExportPlan.ts`
 *  never calls this at all — FFmpeg gets the exact distinct filter name for every type regardless of
 *  which family it maps to here (see `TRANSITION_XFADE_NAME` there). */
export type TransitionFamily =
  | { kind: "dissolve" }
  | { kind: "wipe"; edge: "left" | "right" | "up" | "down" }
  | { kind: "slide"; edge: "left" | "right" | "up" | "down" }
  | { kind: "circle"; opening: boolean };

export function transitionFamily(type: TransitionType): TransitionFamily {
  switch (type) {
    case "wipeLeft":
      return { kind: "wipe", edge: "left" };
    case "wipeRight":
      return { kind: "wipe", edge: "right" };
    case "wipeUp":
      return { kind: "wipe", edge: "up" };
    case "wipeDown":
      return { kind: "wipe", edge: "down" };
    case "slideLeft":
      return { kind: "slide", edge: "left" };
    case "slideRight":
      return { kind: "slide", edge: "right" };
    case "slideUp":
      return { kind: "slide", edge: "up" };
    case "slideDown":
      return { kind: "slide", edge: "down" };
    case "circleOpen":
      return { kind: "circle", opening: true };
    case "circleClose":
      return { kind: "circle", opening: false };
    case "crossfade":
    case "dissolve":
    default:
      return { kind: "dissolve" };
  }
}

/** Blends two ALREADY-FULLY-DRAWN flat images (`outgoing`/`incoming`) onto `context`, per
 *  `transitionFamily`'s own shape for `type` — a pure, standalone function (not a method) for the same
 *  reason `transitionFamily` above is: directly usable without a live `PlaybackEngine` instance, which
 *  `TransitionPreviewTile.tsx`'s picker-grid thumbnails rely on (they animate a `progress` loop over
 *  two flat placeholder images with no clip/track/asset in sight). Shared verbatim by video and text
 *  transitions in `drawVideoClip`/`drawTextLayer` below — this function doesn't know or care whether
 *  what's IN the two images came from `drawTransformed`, `drawText`, or a preview-tile placeholder,
 *  only that each is a flat, fully-opaque-where-it-matters image the same size as `frameWidth`×
 *  `frameHeight`. */
export function compositeTransitionFrame(
  context: CanvasRenderingContext2D,
  frameWidth: number,
  frameHeight: number,
  type: TransitionType,
  progress: number,
  outgoing: CanvasImageSource,
  incoming: CanvasImageSource
): void {
  const family = transitionFamily(type);

  if (family.kind === "wipe") {
    context.drawImage(outgoing, 0, 0, frameWidth, frameHeight);
    context.save();
    context.beginPath();
    // The REVEALED (incoming) rect grows from whichever edge the name points at — e.g. "wipeLeft"
    // reveals starting at the RIGHT edge and grows leftward, matching FFmpeg's own `xfade=wipeleft`
    // (see `TransitionType`'s own doc comment on why these names track `xfade`'s exactly).
    if (family.edge === "left") context.rect(frameWidth * (1 - progress), 0, frameWidth * progress, frameHeight);
    else if (family.edge === "right") context.rect(0, 0, frameWidth * progress, frameHeight);
    else if (family.edge === "up") context.rect(0, frameHeight * (1 - progress), frameWidth, frameHeight * progress);
    else context.rect(0, 0, frameWidth, frameHeight * progress);
    context.clip();
    context.drawImage(incoming, 0, 0, frameWidth, frameHeight);
    context.restore();
    return;
  }

  if (family.kind === "slide") {
    // Whole-frame "push": the outgoing side exits fully in the named direction while the incoming
    // side enters from the opposite edge, both moving at the same rate — the standard slide-
    // transition look (not a single edge sweeping across a STATIONARY frame, which is what `wipe`
    // above already covers). `sign` is the outgoing side's own exit direction: negative x/y for
    // "left"/"up", positive for "right"/"down".
    const horizontal = family.edge === "left" || family.edge === "right";
    const sign = family.edge === "left" || family.edge === "up" ? -1 : 1;
    const outgoingDx = horizontal ? sign * frameWidth * progress : 0;
    const outgoingDy = horizontal ? 0 : sign * frameHeight * progress;
    const incomingDx = horizontal ? -sign * frameWidth * (1 - progress) : 0;
    const incomingDy = horizontal ? 0 : -sign * frameHeight * (1 - progress);
    context.drawImage(outgoing, outgoingDx, outgoingDy, frameWidth, frameHeight);
    context.drawImage(incoming, incomingDx, incomingDy, frameWidth, frameHeight);
    return;
  }

  if (family.kind === "circle") {
    const maxRadius = Math.hypot(frameWidth, frameHeight) / 2;
    context.save();
    context.beginPath();
    if (family.opening) {
      // A growing circle reveals the incoming side over the outgoing one — same "revealed side
      // clipped, base side drawn first" shape `wipe` above uses, just a circular region instead of
      // a rectangular one.
      context.drawImage(outgoing, 0, 0, frameWidth, frameHeight);
      context.arc(frameWidth / 2, frameHeight / 2, maxRadius * progress, 0, Math.PI * 2);
    } else {
      // The mirror: incoming is already fully drawn underneath, and a SHRINKING circle of the
      // outgoing side closes in on nothing, revealing more of the incoming as it collapses.
      context.drawImage(incoming, 0, 0, frameWidth, frameHeight);
      context.arc(frameWidth / 2, frameHeight / 2, maxRadius * (1 - progress), 0, Math.PI * 2);
    }
    context.clip();
    context.drawImage(family.opening ? incoming : outgoing, 0, 0, frameWidth, frameHeight);
    context.restore();
    return;
  }

  // dissolve (and crossfade, the default) — a plain alpha cross-dissolve. FFmpeg's real `dissolve`
  // xfade type is a per-pixel randomized reveal rather than a uniform blend; a flat alpha blend is
  // this canvas approximation's stand-in for it, the same "preview approximates, export is exact"
  // trade-off `ClipEffects`' own doc comment already accepts for brightness/blur.
  context.drawImage(outgoing, 0, 0, frameWidth, frameHeight);
  context.globalAlpha = progress;
  context.drawImage(incoming, 0, 0, frameWidth, frameHeight);
  context.globalAlpha = 1;
}

/** The SOLO-transition counterpart to `compositeTransitionFrame` — used when there's only ONE real
 *  image to animate (a fade-in/out with no partner clip on the other side), not two. This can't just
 *  reuse `compositeTransitionFrame` with a blank stand-in for the missing side: that function's
 *  dissolve/wipe/circle math all work by drawing a SECOND, real opaque image to reveal or overwrite the
 *  first — a fully transparent stand-in for "nothing" is a no-op in `drawImage` regardless of alpha or
 *  clip region, so a transparent "outgoing"/"incoming" simply never affects the canvas. That's exactly
 *  right for the specific case `compositeTransitionFrame` was written for (fading the real content IN
 *  from a transparent "before"), which is why it went unnoticed there, but it silently does nothing at
 *  all for the mirror case (fading OUT to transparent) and for `circleClose`'s own asymmetric draw
 *  order in EITHER direction (it draws "incoming" fully, unclipped, before "outgoing" ever gets a
 *  chance to cover anything).
 *
 *  This sidesteps the whole issue by never drawing a stand-in for the missing side at all: it clips/
 *  fades the ONE real `draw()` call directly against `reveal` (0 = fully hidden, 1 = fully shown),
 *  needing no second image to composite against — whatever's already on `context` (a black clear, or a
 *  lower track's content) simply shows through wherever `draw()` doesn't paint. `draw` receives an
 *  `alphaMultiplier` for the dissolve family specifically: `drawTransformed` already exposes its own
 *  `alphaMultiplier` parameter for exactly this (see its own doc comment) — setting ambient
 *  `context.globalAlpha` instead wouldn't work for a video draw, since `drawTransformed` overwrites it
 *  internally with the clip's own `effects.opacity`. `drawText` has no such parameter, but never
 *  touches `globalAlpha` itself, so the ambient value this function sets works fine there — the
 *  argument is simply unused by text callers. */
function compositeSoloReveal(
  context: CanvasRenderingContext2D,
  frameWidth: number,
  frameHeight: number,
  type: TransitionType,
  reveal: number,
  draw: (alphaMultiplier: number) => void
): void {
  const family = transitionFamily(type);
  context.save();

  if (family.kind === "wipe") {
    context.beginPath();
    if (family.edge === "left") context.rect(frameWidth * (1 - reveal), 0, frameWidth * reveal, frameHeight);
    else if (family.edge === "right") context.rect(0, 0, frameWidth * reveal, frameHeight);
    else if (family.edge === "up") context.rect(0, frameHeight * (1 - reveal), frameWidth, frameHeight * reveal);
    else context.rect(0, 0, frameWidth, frameHeight * reveal);
    context.clip();
    draw(1);
  } else if (family.kind === "slide") {
    // No partner to push out of frame here — the clip simply enters/exits from the edge the type
    // names, sliding itself rather than swapping places with anything.
    const horizontal = family.edge === "left" || family.edge === "right";
    const sign = family.edge === "left" || family.edge === "up" ? -1 : 1;
    context.translate(horizontal ? -sign * frameWidth * (1 - reveal) : 0, horizontal ? 0 : -sign * frameHeight * (1 - reveal));
    draw(1);
  } else if (family.kind === "circle") {
    // `circleOpen`/`circleClose` collapse to the same growing-circle-from-center reveal here — the
    // real two-image distinction between them (which side is the base vs. which shrinks away) has no
    // second image to apply to in a solo fade, so there's nothing left for the two to differ ON.
    const maxRadius = Math.hypot(frameWidth, frameHeight) / 2;
    context.beginPath();
    context.arc(frameWidth / 2, frameHeight / 2, maxRadius * reveal, 0, Math.PI * 2);
    context.clip();
    draw(1);
  } else {
    // dissolve (and crossfade, the default) — a plain alpha reveal.
    context.globalAlpha = reveal;
    draw(reveal);
  }

  context.restore();
}

/** How far a media element may drift from the master clock before it gets HARD re-seeked. Deliberately
 *  large — reserved for a genuinely large, discontinuous jump (scrubbing, the playhead landing on a
 *  brand new clip, resuming after a throttled/backgrounded tab), NOT the everyday correction mechanism.
 *
 *  This used to be 0.2s, tuned assuming drift accumulates slowly (ordinary clock-crystal mismatch
 *  between `performance.now()`, which the master clock in `tick` accumulates, and the element's own
 *  internal playback clock). Direct instrumentation of the real elements during playback (recording
 *  every `seeking`/`waiting`/`seeked` event with timestamps) disproved that: drift regularly ballooned
 *  PAST 0.2s within ~150ms of a `play()` or a seek, not over many seconds — a real per-element STARTUP
 *  LATENCY before it actually begins producing samples, not slow clock jitter. At the OLD, tight 0.2s
 *  threshold this forced a hard seek almost immediately after every play/seek, and a hard seek is even
 *  MORE disruptive than a click: it's a genuine re-buffer, an observed `waiting` (stalled/silent) state
 *  until the seek target re-buffers, THEN resuming — which reintroduces the exact same startup latency,
 *  which soon re-triggers ANOTHER hard seek. That repeating cycle — not slow drift — is what actually
 *  produced the reported "periodic clicks/pops": confirmed via the captured event log, seeks recurring
 *  roughly every 0.7-2s throughout ordinary playback, every single one following the identical seek→
 *  waiting→seeked pattern. Raised high enough that the proportional `playbackRate` correction below (see
 *  `MAX_DRIFT_CORRECTION_RATE_DELTA`) can absorb even that startup-latency spike without ever reaching
 *  this threshold in ordinary use, breaking the cycle instead of just tuning how often it repeats. */
const DRIFT_TOLERANCE = 1.5;
/** Below this, drift is left alone entirely — small enough (one frame or so at 30fps) that neither a
 *  seek nor a rate nudge would be perceptible, and constantly fighting sub-frame jitter would just be
 *  wasted `playbackRate` churn for no audible benefit. Between this and `DRIFT_TOLERANCE`, `syncMedia`
 *  gently speeds up or slows down the element instead of seeking. */
const DRIFT_CORRECTION_TOLERANCE = 0.03;
/** The STRONGEST `playbackRate` offset the proportional correction below will ever apply — reached only
 *  as drift approaches `DRIFT_TOLERANCE` itself (see `syncMedia`'s own interpolation between the two
 *  tolerances). Scaled by how far off the element actually is, rather than one flat nudge regardless of
 *  magnitude — a flat small nudge (this file's own earlier attempt, ±4% always) is what let the startup-
 *  latency spike documented on `DRIFT_TOLERANCE` blow straight through it and force a seek anyway: 4% can
 *  only close a gap by roughly 4% of elapsed real time, nowhere near fast enough for a spike that reaches
 *  0.2s in ~150ms. 50% at the top of the range closes even a near-`DRIFT_TOLERANCE`-sized gap in around a
 *  second — a brief, noticeable-if-you're-listening-for-it pitch/speed change, but nowhere near as
 *  jarring as the seek-induced silence gap it replaces, and it tapers back toward a barely-perceptible
 *  nudge as drift shrinks back toward `DRIFT_CORRECTION_TOLERANCE`. */
const MAX_DRIFT_CORRECTION_RATE_DELTA = 0.5;
/** Media elements kept alive after they stop being needed. Keeping a few around makes scrubbing back
 *  and forth across a cut smooth, since the element is already decoded and buffered. */
const POOL_LIMIT = 8;
/** How far the store's own `playhead` (see `internalClockTime`'s doc comment) may disagree with this
 *  engine's own running clock before it's treated as a REAL external change — a timeline scrub, a
 *  fresh `play()` — rather than the store's own frame-snapping talking back to itself. Discovered via
 *  direct instrumentation of `AudioMixEngine`'s scheduling decisions this session: at a 60Hz `tick()`
 *  cadence against a 30fps project (a common, not edge-case, ratio), `Math.round`-based frame-snapping
 *  produces a "flat, flat, jump" staircase rather than true jitter — and because each tick's `time` was
 *  being RE-DERIVED from that already-snapped store value (see the bug this constant fixes), the error
 *  didn't stay bounded to one frame, it visibly grew past 90ms within a handful of ticks. Comfortably
 *  above a worst-case single-frame snap error even at a low 12fps project (~40ms) and still far below
 *  any real user seek (which jumps by a meaningful fraction of a second at minimum). */
const INTERNAL_CLOCK_RESYNC_TOLERANCE = 0.1;

/** `ClipEffects` → one CSS `filter` string for `context.filter`. A pure, standalone function (not a
 *  method) so it's directly unit-testable without a canvas — the one non-obvious piece here is the
 *  brightness conversion: FFmpeg's `eq=brightness=` is additive (0 = unchanged) but CSS `brightness()`
 *  is multiplicative (100% = unchanged), so `-1..1` is mapped onto `0%..200%` around that midpoint.
 *  See `ClipEffects`'s own doc comment for why this (and `blur`, a different kernel than FFmpeg's
 *  `gblur`) are documented approximations, not exact matches for what export produces. */
export function buildCanvasFilterString(effects: ClipEffects): string {
  if (isIdentityEffects(effects)) return "none";
  return (
    `brightness(${100 + effects.brightness * 100}%) ` +
    `contrast(${effects.contrast * 100}%) ` +
    `saturate(${effects.saturation * 100}%) ` +
    `blur(${effects.blur}px)`
  );
}

/** Mutates `imageData` in place, zeroing (or feathering) alpha on pixels near `settings.color` —
 *  Canvas2D has no native chroma-key filter, so this is a plain, unit-testable pixel loop rather than
 *  a `context.filter` string. Deliberately mirrors FFmpeg's own `colorkey` filter's algorithm (not just
 *  its parameter names) so the preview and `buildExportPlan`'s `colorkey=` filter agree as closely as
 *  possible — see `ChromaKeySettings`'s own doc comment. Per pixel: normalized Euclidean RGB distance
 *  from the key color (0..1, `/sqrt(3)` so pure-white-vs-pure-black is exactly 1) — at or under
 *  `similarity`, fully transparent; within `smoothness` beyond that, a linear alpha ramp (FFmpeg's own
 *  `blend`); further than that, unchanged. Multiplies the EXISTING alpha rather than overwriting it, so
 *  this composes correctly if the source ever already carried partial alpha of its own. */
export function applyChromaKey(imageData: ImageData, settings: ChromaKeySettings): void {
  const keyR = parseInt(settings.color.slice(1, 3), 16);
  const keyG = parseInt(settings.color.slice(3, 5), 16);
  const keyB = parseInt(settings.color.slice(5, 7), 16);
  const similarity = settings.similarity;
  const smoothness = settings.smoothness;
  const data = imageData.data;
  const norm = Math.sqrt(3) * 255;
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - keyR;
    const dg = data[i + 1] - keyG;
    const db = data[i + 2] - keyB;
    const diff = Math.sqrt(dr * dr + dg * dg + db * db) / norm;
    let keyAlpha: number;
    if (diff <= similarity) keyAlpha = 0;
    else if (smoothness > 0 && diff < similarity + smoothness) keyAlpha = (diff - similarity) / smoothness;
    else keyAlpha = 1;
    if (keyAlpha < 1) data[i + 3] = Math.round(data[i + 3] * keyAlpha);
  }
}

export interface PlaybackHost {
  getProject: () => Project | null;
  getPlayhead: () => number;
  isPlaying: () => boolean;
  /** Called as the master clock advances during playback. */
  onTimeUpdate: (seconds: number) => void;
  /** Called when playback runs off the end of the timeline. */
  onEnded: () => void;
  /** Resolves an asset to a streamable URL — injected so this class needs no knowledge of the API. */
  mediaUrlFor: (assetId: string) => string | null;
  /** Every clip `TransformHandles`/`TextTransformHandles` is mid-dragging right now (the actively-
   *  dragged one plus any others moving with it as a multi-select group) — checked on every frame so
   *  the canvas tracks a drag live instead of only updating once it commits. See
   *  `EditorState.livePreviewOverrides`'s own comment for why this lives in the store rather than
   *  `project` itself. */
  getLiveOverrides: () => ClipOverride[];
  /** An in-progress Mixer track-fader drag, if any — wins over the track's own committed `gain` for
   *  exactly that track while dragging, the same override-wins-outright relationship `getLiveOverrides`
   *  has with `Clip.transform`/`effects`. `null` whenever no track fader is being dragged. */
  getLiveTrackGainPreview: () => { trackId: string; gain: number } | null;
  /** Same live-override relationship as `getLiveTrackGainPreview`, for an in-progress Mixer pan-knob
   *  drag. `null` whenever no track pan is being dragged. */
  getLiveTrackPanPreview: () => { trackId: string; pan: number } | null;
  /** Same live-override relationship as `getLiveTrackGainPreview`, for the Mixer's master fader. */
  getLiveMasterGainPreview: () => number | null;
}

/** A still image is decoded into an `<img>` rather than a media element: it has no `currentTime`, no
 *  `play()`, and nothing to keep in sync — it just needs to be decoded once and then drawn on every
 *  frame it covers. No `HTMLAudioElement` variant — audio-track clips are no longer pooled as DOM
 *  elements at all; see `AudioMixEngine`, which schedules them as `AudioBufferSourceNode`s instead. */
type PoolElement = HTMLVideoElement | HTMLImageElement;

interface PooledMedia {
  element: PoolElement;
  lastUsed: number;
}

/** Drives the preview: advances a master clock, keeps media elements slaved to it, and composites
 *  the current frame onto a canvas.
 *
 *  ## Why a master clock rather than following `video.currentTime`
 *
 *  A single `<video>`'s own clock is the obvious choice right up until the timeline has more than one
 *  thing on it — a cut between two clips, a gap with nothing playing, or a voiceover running under
 *  the video. There's no single element whose time is authoritative in any of those cases. So this
 *  keeps its own clock from `performance.now()`, and treats every media element as a follower that
 *  gets re-seeked when it drifts (see DRIFT_TOLERANCE). Gaps then "play" correctly with nothing
 *  loaded at all, and audio stays locked to the same timeline the video is on.
 *
 *  ## Why canvas rather than showing the `<video>` directly
 *
 *  Compositing to a canvas is what lets the preview show the real output frame — correct aspect
 *  ratio, letterboxing, and a hard cut at clip boundaries with no element swap flashing through. It's
 *  also the seam where transforms and effects attach later without changing anything around it. */
export class PlaybackEngine {
  private host: PlaybackHost;
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private pool = new Map<string, PooledMedia>();
  private rafId: number | null = null;
  private lastFrameTime: number | null = null;
  /** This engine's own continuously-accumulated playhead while actively playing — `null` whenever
   *  playback is stopped/paused. Exists because the store's `playhead` (`host.getPlayhead()`) is
   *  frame-snapped (`setPlayhead` → `snapToFrame`, needed for the TIMELINE's own frame-accurate
   *  display/editing) — re-deriving `time` from that snapped value every tick, as `tick()` used to,
   *  re-introduces quantization noise into what needs to be a smooth clock for `AudioMixEngine`'s own
   *  `detectRealSeek` comparisons. See `INTERNAL_CLOCK_RESYNC_TOLERANCE`'s own doc comment for how a
   *  genuine external change (a scrub, a fresh play) is still detected and respected despite ignoring
   *  the store's snapped value on ordinary ticks. */
  private internalClockTime: number | null = null;
  private running = false;
  /** The canvas's own on-screen (CSS) size, in raw CSS pixels — set by `Preview.tsx` via a
   *  `ResizeObserver` (a class outside React has no way to observe layout on its own). Null until the
   *  first observation lands, in which case `tick` falls back to the full sequence resolution rather
   *  than guessing at a size. */
  private displayWidth: number | null = null;
  private displayHeight: number | null = null;
  /** Reused every frame that has a transition to render (video OR text — both go through the same
   *  `compositeTransitionFrame`) — one pair of scratch canvases the outgoing/incoming side are each drawn
   *  to FULLY OPAQUE first, so blending a wipe/slide/circle only ever means compositing two flat
   *  images, never re-deriving each transition's own geometry against `drawTransformed`'s crop/scale/
   *  rotate pipeline (or `drawText`'s glyph layout) directly. Created lazily, resized in place when the
   *  sequence resolution changes — see `transitionCanvas`. */
  private transitionCanvasA: HTMLCanvasElement | null = null;
  private transitionCanvasB: HTMLCanvasElement | null = null;
  /** Scratch canvas `drawTransformed` chroma-keys and/or color-grades a clip's raw source pixels onto,
   *  SOURCE-sized (not frame-sized like the transition scratch canvases above) — both operate on the
   *  un-cropped, un-scaled source, before any of `ClipTransform`'s own geometry pipeline runs. See
   *  `chromaKeyCanvas`'s own doc comment. */
  private chromaKeyCanvasEl: HTMLCanvasElement | null = null;
  /** One entry per clip currently drawing curves — invalidated by REFERENCE inequality against the
   *  `ColorGrading` object last seen for that clip id, not deep-equality. This is cheap AND correct:
   *  `resolveClipColorGrading` (static path: `clip.colorGrading` directly; keyframed/HOLD path: a
   *  bracketing keyframe's own `.value`) always returns the SAME object reference across consecutive
   *  frames unless a real edit (a new command, undo/redo, or a fresh live-preview override) actually
   *  produced a new one — this codebase's Immer-free-but-equivalent `edit()`/`structuredClone` pattern
   *  in `timeline/operations.ts` already guarantees that. So recomputing the natural-cubic-spline solve
   *  for all 4 curves only happens on an actual change, not on every tick of steady, un-edited playback. */
  private colorGradingLutCache = new Map<string, { source: ColorGrading; r: Uint8ClampedArray; g: Uint8ClampedArray; b: Uint8ClampedArray }>();
  /** Owns the entire Web Audio mixing graph — see its own doc comment. Composed here rather than
   *  subclassed: this class stays the video/canvas/clock owner, `AudioMixEngine` is a pure audio-output
   *  concern it delegates to, the same way `PlaybackHost` itself is composition rather than inheritance. */
  private audioMixEngine: AudioMixEngine;
  /** Throttle for the low-frequency upcoming-audio-clip prefetch scan in `tick()` — see
   *  `AUDIO_PREFETCH_SCAN_INTERVAL_MS`'s own comment for why this isn't just done every frame. */
  private lastPrefetchScanAt: number | null = null;

  constructor(host: PlaybackHost) {
    this.host = host;
    this.audioMixEngine = new AudioMixEngine((assetId) => this.host.mediaUrlFor(assetId));
  }

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: false });
    this.start();
  }

  /** Called whenever the canvas's own on-screen size changes — what `tick` uses to cap the canvas
   *  BACKING STORE to only as many physical pixels as are ever actually visible, instead of always
   *  compositing at the full sequence resolution regardless of how small the preview panel is. A
   *  phone/tablet showing a 1080×1920 sequence in a 300px-tall panel was paying the GPU/compositing
   *  cost of well over a million pixels a frame that never reached the screen — on a desktop's own
   *  more powerful GPU this was invisible, but it's a real, confirmed source of dropped frames on
   *  weaker hardware. Multiplied by `devicePixelRatio` and capped at the sequence's own resolution in
   *  `tick` itself (never upscaled — there's no extra detail to render past the source's own
   *  resolution, only more pixels to composite for an identical visual result).
   *
   *  Every drawing call in this class still operates in LOGICAL sequence-pixel coordinates regardless
   *  of the physical backing store size actually chosen — see `drawFrame`'s own `setTransform` call —
   *  so nothing downstream (crop math, `ClipTransform.offsetX`, text font sizes, all authored and
   *  exported in real sequence pixels) needs to know or care that the backing store shrank. */
  setDisplaySize(cssWidth: number, cssHeight: number): void {
    this.displayWidth = cssWidth;
    this.displayHeight = cssHeight;
  }

  /** Pass-through to `AudioMixEngine`'s own read methods — see their doc comments. `LevelMeter` calls
   *  these directly from its own `requestAnimationFrame` loop, bypassing `tick()` entirely: metering
   *  has no connection to the render/composite loop, it just needs a live reading from the engine on
   *  demand, whenever the Mixer panel happens to be open and polling. */
  getTrackLevelDb(trackId: string): number | null {
    return this.audioMixEngine.getTrackLevelDb(trackId);
  }
  getMasterLevelDb(): number {
    return this.audioMixEngine.getMasterLevelDb();
  }

  /** Tears everything down: stops the loop and releases every media element. Without the explicit
   *  `src` clear and `load()`, a detached element can keep its network request and decoder alive. */
  detach(): void {
    this.stop();
    for (const { element } of this.pool.values()) this.release(element);
    this.pool.clear();
    this.audioMixEngine.dispose();
    this.canvas = null;
    this.context = null;
  }

  private start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = null;
    const loop = () => {
      if (!this.running) return;
      this.tick();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private stop(): void {
    this.running = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  /** Gets (or creates) the media element for a clip. Elements are keyed by CLIP, not by asset,
   *  because the same asset can legitimately appear at two different timeline positions at once —
   *  one element can't be in two places. */
  private mediaFor(clip: Clip, kind: "video" | "image"): PoolElement | null {
    const existing = this.pool.get(clip.id);
    if (existing) {
      existing.lastUsed = performance.now();
      return existing.element;
    }

    const url = this.host.mediaUrlFor(clip.assetId);
    if (!url) return null;

    const element = kind === "image" ? document.createElement("img") : document.createElement("video");
    element.src = url;
    // Never attached to the document: the canvas is what the user sees, and an off-DOM element still
    // decodes and plays audio perfectly well (routed through `AudioMixEngine`, not its own native
    // output — see `syncVideoClipAudio`).
    if (element instanceof HTMLVideoElement) {
      element.preload = "auto";
      element.playsInline = true;
      element.muted = false;
    }

    this.pool.set(clip.id, { element, lastUsed: performance.now() });
    this.evictStale();
    return element;
  }

  /** Releases one pooled element. An `<img>` only needs its `src` dropped; a media element also has
   *  to be paused and re-`load()`ed, or it can keep a network request and decoder alive after being
   *  discarded. */
  private release(element: PoolElement): void {
    if (element instanceof HTMLImageElement) {
      element.removeAttribute("src");
      return;
    }
    element.pause();
    element.removeAttribute("src");
    element.load();
  }

  private evictStale(): void {
    if (this.pool.size <= POOL_LIMIT) return;
    const entries = [...this.pool.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [clipId, { element }] of entries.slice(0, this.pool.size - POOL_LIMIT)) {
      // Must run before `release` clears the element's `src` — a dangling `MediaElementAudioSourceNode`
      // left in the graph otherwise. Safe to call even for a clip whose audio was never wired (an
      // image, or a video that never actually produced sound) — `releaseVideoClipAudio` no-ops when it
      // finds nothing registered for that id.
      this.audioMixEngine.releaseVideoClipAudio(clipId);
      this.release(element);
      this.pool.delete(clipId);
    }
  }

  /** Slaves one video element's PICTURE timing to the master clock — `currentTime`/`playbackRate`/
   *  play-pause only. No longer touches `.muted`/`.volume` at all: a video clip's audio is routed
   *  through `AudioMixEngine.syncVideoClipAudio` instead (called separately, right after this, from
   *  `drawVideoClip`), since `createMediaElementSource` captures the element's native output entirely —
   *  setting `.volume` on an element already routed through Web Audio would have no audible effect. */
  private syncMedia(clipId: string, element: HTMLVideoElement, sourceTime: number, playing: boolean): void {
    // readyState 0 means nothing is loaded yet — seeking now would be discarded once metadata
    // arrives, so let it load and correct on a later frame.
    if (element.readyState === 0) return;

    // Positive: the element is AHEAD of where it should be (needs to slow down/seek back). Negative:
    // it's BEHIND (needs to speed up/seek forward).
    const drift = element.currentTime - sourceTime;
    const absDrift = Math.abs(drift);

    if (absDrift > DRIFT_TOLERANCE) {
      // A real jump (scrub, clip switch, a tab that was throttled/backgrounded) — nothing gradual
      // could close a gap this size fast enough to matter, so just snap. `playbackRate` is reset here
      // too: if this element was already mid-correction from a smaller drift, jumping straight to the
      // target makes that in-progress nudge stale. Ducked first — this clip's audio (if it has any and
      // is currently routed) goes silent for the reseek's own brief re-buffer instead of clicking
      // through it; see `duckAroundSeek`'s own doc comment for why this only mitigates rather than
      // eliminates this specific category's click.
      this.audioMixEngine.duckAroundSeek(clipId);
      element.currentTime = sourceTime;
      element.playbackRate = 1;
    } else if (playing && absDrift > DRIFT_CORRECTION_TOLERANCE) {
      // Proportional, not flat — see `MAX_DRIFT_CORRECTION_RATE_DELTA`'s own doc comment for why a
      // fixed small nudge couldn't close the startup-latency spike `DRIFT_TOLERANCE` documents fast
      // enough to matter. Interpolates from ~0 right at the dead-zone edge up to the max rate right at
      // `DRIFT_TOLERANCE` itself, so a small ordinary wobble gets a gentle nudge and a large one gets a
      // genuinely fast catch-up, without ever needing a third tier of its own.
      const t = Math.min(1, (absDrift - DRIFT_CORRECTION_TOLERANCE) / (DRIFT_TOLERANCE - DRIFT_CORRECTION_TOLERANCE));
      const delta = MAX_DRIFT_CORRECTION_RATE_DELTA * t;
      element.playbackRate = drift > 0 ? Math.max(0.1, 1 - delta) : 1 + delta;
    } else if (element.playbackRate !== 1) {
      // Back within the dead zone (or paused) — stop nudging. Explicit rather than relying on the
      // element to already be at 1: the branch above may have left it offset from the previous tick.
      element.playbackRate = 1;
    }

    if (playing) {
      // `play()` rejects if the browser blocks autoplay before a user gesture. Playback here always
      // follows a real click, but the rejection still has to be swallowed or it surfaces as an
      // unhandled promise rejection in the console.
      if (element.paused) void element.play().catch(() => {});
    } else if (!element.paused) {
      element.pause();
    }
  }

  private tick(): void {
    const project = this.host.getProject();
    const context = this.context;
    const canvas = this.canvas;
    if (!project || !context || !canvas) return;

    const now = performance.now();
    const delta = this.lastFrameTime === null ? 0 : (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;

    const playing = this.host.isPlaying();
    const storedPlayhead = this.host.getPlayhead();
    let time = storedPlayhead;

    if (playing && delta > 0) {
      // Resync from the store only on a genuine external change (a scrub while playing, or playback
      // just starting) — otherwise keep accumulating from OUR OWN last computed value, not the store's
      // frame-snapped echo of it. See `internalClockTime`'s own doc comment for why this distinction
      // matters for `AudioMixEngine`'s scheduling.
      const base =
        this.internalClockTime !== null &&
        Math.abs(storedPlayhead - this.internalClockTime) <= INTERNAL_CLOCK_RESYNC_TOLERANCE
          ? this.internalClockTime
          : storedPlayhead;
      time = base + delta;
      const total = this.totalDuration(project);
      if (time >= total) {
        this.internalClockTime = null;
        this.host.onTimeUpdate(total);
        this.host.onEnded();
        this.pauseAll();
        this.drawFrame(project, context, total);
        return;
      }
      this.internalClockTime = time;
      this.host.onTimeUpdate(time);
    } else {
      this.internalClockTime = null;
    }

    // Backing store capped to the panel's own on-screen size (times devicePixelRatio, so it stays
    // crisp) instead of always the full sequence resolution — see `setDisplaySize`'s own comment for
    // why. Every draw call still works in full sequence-pixel LOGICAL coordinates regardless (see
    // `drawFrame`'s `setTransform`), so this is invisible to everything downstream.
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const targetWidth = this.displayWidth
      ? Math.max(1, Math.min(project.sequence.width, Math.round(this.displayWidth * dpr)))
      : project.sequence.width;
    const targetHeight = this.displayHeight
      ? Math.max(1, Math.min(project.sequence.height, Math.round(this.displayHeight * dpr)))
      : project.sequence.height;
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }

    this.drawFrame(project, context, time);
    this.syncAudioTracks(project, time, playing);

    // Live per-track/master mix levels, reconciled once per tick regardless of `playing` — cheap even
    // every frame (each is a single AudioParam.setTargetAtTime call, see AudioMixEngine's own
    // comment), and dragging the Mixer while paused should still feel responsive even though nothing
    // is actually scheduled to play yet. A Mixer fader/knob drag in progress
    // (`getLiveTrackGainPreview`/`getLiveTrackPanPreview`/`getLiveMasterGainPreview`) wins over the real
    // committed project value for exactly the track/master being dragged, the same override-wins-
    // outright relationship `getLiveOverrides` already has with `Clip.transform`/`effects` for the
    // canvas.
    const liveTrackGain = this.host.getLiveTrackGainPreview();
    const liveTrackPan = this.host.getLiveTrackPanPreview();
    const liveMasterGain = this.host.getLiveMasterGainPreview();
    for (const track of project.sequence.tracks) {
      if (track.kind !== "audio") continue;
      const gain = liveTrackGain?.trackId === track.id ? liveTrackGain.gain : (track.gain ?? 1);
      const pan = liveTrackPan?.trackId === track.id ? liveTrackPan.pan : (track.pan ?? 0);
      this.audioMixEngine.setTrackGain(track.id, gain);
      this.audioMixEngine.setTrackPan(track.id, pan);
    }
    this.audioMixEngine.setMasterGain(liveMasterGain ?? (project.sequence.masterGain ?? 1));

    // Mirrors the existing deferred `element.play()` pattern (`togglePlay` itself is a pure Zustand
    // action with no engine reference — the actual gesture-gated call only happens here, on the next
    // tick after `playing` flips true) — see the plan's "Autoplay/gesture handling" section for why this
    // already works under the browser's sticky-activation grace window without a synchronous call from
    // the transport button itself.
    if (playing) this.audioMixEngine.resume();

    // Throttled scan for audio-track clips starting within the next few seconds, so their asset buffer
    // is already decoded by the time playback reaches them instead of decoding on first touch.
    if (
      this.lastPrefetchScanAt === null ||
      now - this.lastPrefetchScanAt >= AUDIO_PREFETCH_SCAN_INTERVAL_MS
    ) {
      this.lastPrefetchScanAt = now;
      for (const { clip } of audibleClips(project)) {
        if (clip.timelineStart < time || clip.timelineStart > time + AUDIO_PREFETCH_LOOKAHEAD_SECONDS) continue;
        const url = this.host.mediaUrlFor(clip.assetId);
        if (url) this.audioMixEngine.prefetchAsset(clip.assetId, url);
      }
    }
  }

  /** Audio-track clips whose time window actually contains `time` right now — as opposed to
   *  `audibleClips`, which returns every clip on every audible (unmuted/soloed) track regardless of
   *  where it sits on the timeline. Each result also carries the exact `sourceTime` its own element
   *  should be seeked to and the `gain` multiplier `syncAudioTracks` should apply — ordinarily just
   *  the clip's own straightforward mapping (`clip.gain`, playhead position translated 1:1 into its
   *  footage), but a clip with a REAL transition active right now needs both computed differently. All
   *  of THAT timing math lives in `timeline/transitions.ts`'s `resolveAudioTransitionGain` (shared,
   *  pure, unit-tested — unlike this class, which needs a real DOM/canvas to run at all) — during a
   *  real crossfade blend it hands back the OUTGOING partner clip too, which is why a single active
   *  clip can expand into two results here.
   *
   *  Without this, a clip with a transition set just played (or stopped) at full/unchanged volume
   *  right up to the exact cut point in the live preview — the transition was real in EXPORT (see
   *  `buildAudioTrackStream`) but silently inert here, since nothing upstream of this function ever
   *  looked at `transitionIn`/`transitionOut` for an audio-track clip's live playback at all.
   *
   *  This distinction (which clips are "active" at all) is also what `drawFrame`'s calls to
   *  `pauseInactive` need, and using the wrong one there was a real, confirmed bug: passing ALL audible
   *  clips as "protected from pausing" meant an audio-track clip's element was NEVER told to pause once
   *  the playhead moved past its window — it just kept playing indefinitely, since `syncAudioTracks`
   *  also stops touching it the moment it's no longer active. The inverse bug hit at the same spot:
   *  during a gap in the video track, `drawFrame`'s early return called `pauseInactive(new Set())` — an
   *  EMPTY protected set — which paused every currently-audible element including audio-track clips
   *  that should keep playing under a video gap (background music, a voiceover with no matching
   *  footage yet). Both call sites now filter through this one method instead of disagreeing about
   *  what "active" means — and, now, both correctly see BOTH clips as active during a blend, so neither
   *  gets paused out from under the crossfade partway through.
   *
   *  `gain` here is `Clip.gain` × the live transition ramp only — it deliberately does NOT include
   *  `Track.gain`. A track's fader is applied downstream instead, by the one shared `GainNode` every
   *  clip on that track routes through (`AudioMixEngine.setTrackGain`) — folding it into this per-clip
   *  scalar would mean recomputing and re-pushing it into every playing clip's own node every time the
   *  fader moves, instead of the one shared-node update `tick()` already does per track per frame. */
  private activeAudioClips(project: Project, time: number): { trackId: string; clip: Clip; sourceTime: number; gain: number }[] {
    const results: { trackId: string; clip: Clip; sourceTime: number; gain: number }[] = [];
    for (const { track, clip } of audibleClips(project)) {
      const duration = clip.sourceOut - clip.sourceIn;
      if (time < clip.timelineStart || time >= clip.timelineStart + duration) continue;
      const sourceTime = clip.sourceIn + (time - clip.timelineStart);

      const { gain, partner } = resolveAudioTransitionGain(track, clip, time);
      results.push({ trackId: track.id, clip, sourceTime, gain: (clip.gain ?? 1) * gain });
      if (partner) {
        results.push({ trackId: track.id, clip: partner.clip, sourceTime: partner.sourceTime, gain: (partner.clip.gain ?? 1) * partner.gain });
      }
    }
    return results;
  }

  private totalDuration(project: Project): number {
    let end = 0;
    for (const track of project.sequence.tracks) {
      for (const clip of track.clips) {
        end = Math.max(end, clip.timelineStart + (clip.sourceOut - clip.sourceIn));
      }
    }
    return end;
  }

  private drawFrame(project: Project, context: CanvasRenderingContext2D, time: number): void {
    const { width: frameWidth, height: frameHeight } = project.sequence;
    // Maps LOGICAL sequence-pixel coordinates — what every draw call below uses, since that's the
    // unit `ClipTransform.offsetX`, crop fractions, and text font sizes are all authored AND exported
    // in — onto the canvas's own physical backing store, which `tick` may have just capped to
    // something smaller than the sequence's real resolution (see `setDisplaySize`'s own comment). Set
    // fresh every frame rather than relying on it surviving one: assigning `canvas.width`/`height`
    // (which `tick` may just have done) already resets the transform to identity on its own, and no
    // `save()`/`restore()` pair anywhere in this file touches this outermost transform, so there's
    // nothing to accidentally compound across frames by setting it unconditionally here too.
    context.setTransform(context.canvas.width / frameWidth, 0, 0, context.canvas.height / frameHeight, 0, 0);

    context.fillStyle = "#000";
    context.fillRect(0, 0, frameWidth, frameHeight);

    // Computed once and reused by every `pauseInactive` call below, so a gap in the video track and a
    // clip actively playing agree on which audio-track elements are currently supposed to be making
    // sound — see this method's own doc comment for the two bugs that came from getting this wrong.
    const activeAudioIds = this.activeAudioClips(project, time).map((c) => c.clip.id);
    this.drawVideoLayer(project, context, frameWidth, frameHeight, time, activeAudioIds);
    // Drawn unconditionally, AFTER the video layer and regardless of whether it drew anything (a gap,
    // a missing asset, no video track at all) — text overlays a video frame OR a gap equally, the
    // same way a caption doesn't disappear just because the footage under it cut to black.
    this.drawTextLayer(project, context, frameWidth, frameHeight, time);
  }

  /** The video/image half of a frame — unchanged from before text existed, just extracted into its
   *  own method so `drawFrame` can guarantee the text pass below always runs regardless of what this
   *  draws.
   *
   *  Composites EVERY visible video track, in array order — later tracks drawn ON TOP of earlier ones,
   *  the identical stacking rule `drawTextLayer` below already uses for text tracks. This needs no
   *  explicit alpha-blending logic of its own: `drawFrame` clears the canvas to opaque black exactly
   *  ONCE per frame (not per track), and every `drawTransformed` call below only ever touches its own
   *  destination rect via `drawImage` — so a track's own gaps and letterbox bars naturally show
   *  whatever was drawn beneath them (a lower track's content, or the original black clear) simply by
   *  never being painted over, and a clip's own `effects.opacity` blends against that same prior
   *  content via `context.globalAlpha`. Real cross-track compositing, with zero new code here beyond
   *  iterating more than one track — `buildExportPlan`'s FFmpeg graph is what has to work to earn this
   *  same result, since it has no equivalent "just don't touch those pixels" primitive. */
  private drawVideoLayer(
    project: Project,
    context: CanvasRenderingContext2D,
    frameWidth: number,
    frameHeight: number,
    time: number,
    activeAudioIds: string[]
  ): void {
    const activeClipIds = new Set<string>();

    for (const track of project.sequence.tracks) {
      if (track.kind !== "video" || !track.visible) continue;
      const clip = clipAtTime(track, time);
      if (!clip) continue;
      // Marked active regardless of whether this frame actually manages to draw it (element still
      // loading, video not yet decoded) — `pauseInactive` protecting it either way is what stops a
      // still-buffering clip from being paused mid-load, matching this method's pre-multi-track
      // behavior exactly.
      activeClipIds.add(clip.id);
      this.drawVideoClip(project, context, frameWidth, frameHeight, track, clip, time);
    }

    this.pauseInactive(new Set([...activeClipIds, ...activeAudioIds]));
  }

  /** Draws ONE video track's own active clip — the entire per-clip body `drawVideoLayer` used to run
   *  once, extracted so it can run once per visible video track without duplicating the readiness/
   *  transition/transform logic. */
  private drawVideoClip(
    project: Project,
    context: CanvasRenderingContext2D,
    frameWidth: number,
    frameHeight: number,
    track: Track,
    clip: Clip,
    time: number
  ): void {
    const asset = project.assets.find((a) => a.id === clip.assetId);
    const isImage = asset?.kind === "image";
    const element = this.mediaFor(clip, isImage ? "image" : "video");
    if (!element) return;

    let sourceWidth: number;
    let sourceHeight: number;

    if (element instanceof HTMLImageElement) {
      // A still has no clock to sync and nothing to pause — it's ready as soon as it has decoded.
      if (!element.complete || element.naturalWidth === 0) return;
      sourceWidth = element.naturalWidth;
      sourceHeight = element.naturalHeight;
    } else if (element instanceof HTMLVideoElement) {
      const sourceTime = clip.sourceIn + (time - clip.timelineStart);
      // The track's own visibility no longer needs checking here: `drawVideoLayer` already skips
      // hidden tracks entirely before this is ever called.
      this.syncMedia(clip.id, element, sourceTime, this.host.isPlaying());
      // A video clip's own audio is silenced/scaled when the clip itself is muted/gained — matching
      // what export does, so preview and output agree. Routed through `AudioMixEngine` (not
      // `element.volume`/`.muted`) so it shares the same mixing graph as audio-track clips and can be
      // ducked around a reseek — see `syncVideoClipAudio`'s own doc comment.
      this.audioMixEngine.syncVideoClipAudio(clip, element, clip.gain ?? 1, clip.mutedAudio ?? false);
      // readyState < 2 means no frame is decoded yet; drawing would throw or paint garbage.
      if (element.readyState < 2) return;
      sourceWidth = element.videoWidth;
      sourceHeight = element.videoHeight;
    } else {
      return;
    }

    if (sourceWidth === 0 || sourceHeight === 0) return;

    // Computed here (not just below, where the OLD code first needed it for transition timing) since
    // the keyframe resolvers just below need it too — one clip-window-relative "how far in are we"
    // value shared by transform/effects resolution AND transition timing.
    const elapsed = time - clip.timelineStart;

    // A live drag in progress on THIS clip (directly, or as part of a multi-select group move)
    // overrides its saved transform — see `getLiveOverrides`' own comment for why: without this, the
    // canvas would only ever show the last COMMITTED position while `TransformHandles`' own overlay
    // box(es) track the pointer, which reads as "only the selection box moves." Still wins outright
    // over a keyframed value — dragging a handle mid-animation previews the dragged value at this
    // exact instant, same as it would for a static (unkeyframed) clip.
    const override = this.host.getLiveOverrides().find((o) => o.clipId === clip.id);
    const transform = override?.transform ?? resolveClipTransform(clip, elapsed);
    // Same live-drag override as `transform` above — an Inspector Effects field mid-drag/mid-type
    // previews here exactly the same way a canvas transform handle does.
    const effects = override?.effects ?? resolveClipEffects(clip, elapsed);
    // Same live-drag override as `transform`/`effects` above — a CurveEditor drag previews here too.
    const colorGrading = override?.colorGrading ?? resolveClipColorGrading(clip, elapsed);

    // A REAL partner is drawn FULLY OPAQUE to its own scratch canvas first, then blended by
    // `compositeTransitionFrame` against this clip (also drawn to its own scratch canvas) according to
    // the clip's own `transitionIn.type` — see that method's own comment for why (a wipe/slide/circle
    // needs two flat images to composite, not an alpha multiplier threaded through `drawTransformed`'s
    // existing geometry pipeline). A `null` partner (solo fade-in) instead goes through
    // `compositeSoloReveal` directly on `context` — see ITS own doc comment for why a solo fade can't
    // reuse the two-panel path with a blank stand-in for the missing side. Only attempted while
    // genuinely inside the blend window; `findTransitionPartner` re-validates adjacency fresh every
    // call (see its own doc comment), so a broken precondition just falls through to drawing this clip
    // alone, same as a plain cut always has. Operates entirely within THIS track — a transition on one
    // track has no effect on any other track's own compositing.
    const transition = findTransitionPartner(track, clip);
    if (transition && elapsed < transition.duration) {
      const progress = elapsed / transition.duration;
      if (transition.partner) {
        const outCtx = this.transitionCanvas("a", frameWidth, frameHeight);
        const inCtx = this.transitionCanvas("b", frameWidth, frameHeight);
        const partnerDrawn = outCtx && this.drawTransitionPartner(project, outCtx, frameWidth, frameHeight, transition.partner, transition.duration, elapsed);
        if (partnerDrawn && inCtx) {
          this.drawTransformed(inCtx, element, sourceWidth, sourceHeight, frameWidth, frameHeight, transform, effects, 1, clip.chromaKey, colorGrading, clip.id);
          compositeTransitionFrame(
            context,
            frameWidth,
            frameHeight,
            clip.transitionIn?.type ?? "crossfade",
            progress,
            this.transitionCanvasA!,
            this.transitionCanvasB!
          );
          return;
        }
      } else {
        compositeSoloReveal(context, frameWidth, frameHeight, clip.transitionIn?.type ?? "crossfade", progress, (alphaMultiplier) => {
          this.drawTransformed(context, element, sourceWidth, sourceHeight, frameWidth, frameHeight, transform, effects, alphaMultiplier, clip.chromaKey, colorGrading, clip.id);
        });
        return;
      }
    }

    // Fade-out: the mirror of the solo fade-in case above, at this clip's own TAIL instead of its
    // head. `reveal` runs from 1 (fade-out window just started, fully visible) down to 0 (clip's own
    // end, fully hidden) — the inverse direction from fade-in's `progress`, but the same
    // `compositeSoloReveal` either way. `findTransitionOut` already resolves to `null` whenever a real
    // successor exists (see its own doc comment), so this can never fire on a boundary the successor's
    // own `transitionIn` is already handling.
    const transitionOut = findTransitionOut(track, clip);
    if (transitionOut) {
      const remaining = clipEnd(clip) - time;
      if (remaining < transitionOut.duration) {
        const reveal = Math.min(1, Math.max(0, remaining / transitionOut.duration));
        compositeSoloReveal(context, frameWidth, frameHeight, clip.transitionOut?.type ?? "crossfade", reveal, (alphaMultiplier) => {
          this.drawTransformed(context, element, sourceWidth, sourceHeight, frameWidth, frameHeight, transform, effects, alphaMultiplier, clip.chromaKey, colorGrading, clip.id);
        });
        return;
      }
    }

    this.drawTransformed(context, element, sourceWidth, sourceHeight, frameWidth, frameHeight, transform, effects, 1, clip.chromaKey, colorGrading, clip.id);
  }

  /** Draws the outgoing clip's own tail frame during a crossfade — a stripped-down sibling of the main
   *  `drawVideoLayer` path above (no live-drag override, no audio sync: the partner isn't "current" for
   *  playback purposes, just visually borrowed for the blend) that seeks the source video to its own
   *  tail position and hands off to the same `drawTransformed` every other draw goes through. Returns
   *  `false` when the partner's element isn't ready to draw yet, so the caller can fall back to drawing
   *  this clip alone rather than blending against nothing. */
  private drawTransitionPartner(
    project: Project,
    context: CanvasRenderingContext2D,
    frameWidth: number,
    frameHeight: number,
    partner: Clip,
    duration: number,
    elapsed: number
  ): boolean {
    const asset = project.assets.find((a) => a.id === partner.assetId);
    const isImage = asset?.kind === "image";
    const element = this.mediaFor(partner, isImage ? "image" : "video");
    if (!element) return false;

    let sourceWidth: number;
    let sourceHeight: number;

    if (element instanceof HTMLImageElement) {
      if (!element.complete || element.naturalWidth === 0) return false;
      sourceWidth = element.naturalWidth;
      sourceHeight = element.naturalHeight;
    } else if (element instanceof HTMLVideoElement) {
      const sourceTime = partner.sourceOut - duration + elapsed;
      if (element.readyState === 0) return false;
      if (Math.abs(element.currentTime - sourceTime) > DRIFT_TOLERANCE) element.currentTime = sourceTime;
      if (!element.paused) element.pause();
      if (element.readyState < 2) return false;
      sourceWidth = element.videoWidth;
      sourceHeight = element.videoHeight;
    } else {
      return false;
    }

    if (sourceWidth === 0 || sourceHeight === 0) return false;

    // The partner's OWN clip-window-relative elapsed time, derived from the tail-slice `sourceTime`
    // already computed above (`partner.sourceOut - duration + elapsed`): subtracting `partner.sourceIn`
    // converts source-media time back to clip-window time, i.e.
    // `partnerElapsed = sourceTime - partner.sourceIn = clipDuration(partner) - duration + elapsed`.
    // No live-drag override here — same reasoning this method's own doc comment already gives for
    // skipping audio sync: the partner isn't "current" for playback purposes.
    const partnerElapsed = clipDuration(partner) - duration + elapsed;
    const transform = resolveClipTransform(partner, partnerElapsed);
    const effects = resolveClipEffects(partner, partnerElapsed);
    const colorGrading = resolveClipColorGrading(partner, partnerElapsed);
    this.drawTransformed(context, element, sourceWidth, sourceHeight, frameWidth, frameHeight, transform, effects, 1, partner.chromaKey, colorGrading, partner.id);
    return true;
  }

  /** Draws one source (video frame or image) into the sequence frame under a transform — the ONE
   *  place this class composites a source onto the canvas, so the untransformed case (identity) and a
   *  fully transformed one are guaranteed to agree on geometry rather than risking two separate code
   *  paths drifting apart.
   *
   *  Pipeline, matching `ClipTransform`'s own doc comment and `buildExportPlan`'s FFmpeg graph exactly:
   *  crop the source rect → scale-to-fit the CROPPED dimensions → apply the user `scale` multiplier →
   *  rotate around center → translate by offset. `drawImage`'s 8-argument form does the crop step
   *  itself (a source rect), so there's no need for an intermediate cropped canvas.
   *
   *  `alphaMultiplier` (default 1) layers on top of the clip's own `effects.opacity` rather than
   *  replacing it, so a crossfade blend and a clip's own opacity setting compose correctly instead of
   *  one silently overriding the other. */
  private drawTransformed(
    context: CanvasRenderingContext2D,
    element: HTMLVideoElement | HTMLImageElement,
    sourceWidth: number,
    sourceHeight: number,
    frameWidth: number,
    frameHeight: number,
    transform: ClipTransform,
    effects: ClipEffects,
    alphaMultiplier = 1,
    chromaKey?: ChromaKeySettings,
    colorGrading?: ColorGrading,
    clipId?: string
  ): void {
    const box = computeTransformedBox(sourceWidth, sourceHeight, frameWidth, frameHeight, transform);
    if (!box) return;

    // Chroma key and color-grading curves BOTH operate on the RAW, un-cropped, un-scaled source, and
    // BOTH need a `getImageData`/`putImageData` round-trip — combined into a SINGLE readback here rather
    // than each running its own (chroma key touches only alpha, curves touch only R/G/B, so the two
    // passes never interact and can share one buffer). Result handed to the exact same crop/scale/
    // rotate/translate `drawImage` call below a plain clip already uses, via `source` standing in for
    // `element`. Zero geometry-path divergence between a processed and unprocessed clip — only which
    // image gets drawn differs.
    let source: CanvasImageSource = element;
    const needsColorGrading = colorGrading !== undefined && !isIdentityColorGrading(colorGrading);
    if (chromaKey || needsColorGrading) {
      const scratch = this.chromaKeyCanvas(sourceWidth, sourceHeight);
      if (scratch) {
        scratch.clearRect(0, 0, sourceWidth, sourceHeight);
        scratch.drawImage(element, 0, 0, sourceWidth, sourceHeight);
        const imageData = scratch.getImageData(0, 0, sourceWidth, sourceHeight);
        if (chromaKey) applyChromaKey(imageData, chromaKey);
        if (needsColorGrading) applyColorGrading(imageData, this.resolveColorGradingLuts(clipId ?? "", colorGrading!));
        scratch.putImageData(imageData, 0, 0);
        source = scratch.canvas;
      }
    }

    context.save();
    // `filter`/`globalAlpha` are both part of the state `save()`/`restore()` already bracket, so
    // there's no separate reset needed beyond the `restore()` this function already had — see
    // `ClipEffects`'s own doc comment for why `brightness`/`blur` are approximations here, not exact
    // matches for what `buildExportPlan`'s `eq`/`gblur` filters produce.
    context.filter = buildCanvasFilterString(effects);
    context.globalAlpha = effects.opacity * alphaMultiplier;
    context.translate(box.centerX, box.centerY);
    if (transform.rotationDeg !== 0) context.rotate((transform.rotationDeg * Math.PI) / 180);
    context.drawImage(
      source,
      box.cropX,
      box.cropY,
      box.cropWidth,
      box.cropHeight,
      -box.width / 2,
      -box.height / 2,
      box.width,
      box.height
    );
    context.restore();
  }

  /** Gets (or creates/resizes) one of the two scratch canvases `compositeTransitionFrame` blends —
   *  `which` picks A (the OUTGOING side) or B (the INCOMING side). Cleared to fully transparent on
   *  every call: a transition's own `drawFrame` already cleared the MAIN canvas to opaque black before
   *  any of this runs, so a transparent scratch canvas composited on top (via plain `drawImage`, no
   *  extra alpha math) naturally reproduces the same "letterbox shows through" result a direct draw
   *  would have. */
  private transitionCanvas(which: "a" | "b", width: number, height: number): CanvasRenderingContext2D | null {
    const existing = which === "a" ? this.transitionCanvasA : this.transitionCanvasB;
    const canvas = existing ?? document.createElement("canvas");
    if (!existing) {
      if (which === "a") this.transitionCanvasA = canvas;
      else this.transitionCanvasB = canvas;
    }
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext("2d");
    if (context) context.clearRect(0, 0, width, height);
    return context;
  }

  /** Gets (or creates/resizes) the one scratch canvas `drawTransformed` chroma-keys a clip's raw
   *  source pixels onto, before handing the result to the SAME crop/scale/rotate/translate pipeline a
   *  plain (non-keyed) clip already goes through — so a chroma-keyed clip's own `ClipTransform` behaves
   *  identically to a plain one, no separate geometry path to keep in sync. `willReadFrequently: true`
   *  since `getImageData` runs here every frame a keyed clip is visible — without this hint, some
   *  browsers keep the canvas's backing store GPU-side and pay a full readback penalty on every call. */
  private chromaKeyCanvas(width: number, height: number): CanvasRenderingContext2D | null {
    const canvas = this.chromaKeyCanvasEl ?? document.createElement("canvas");
    if (!this.chromaKeyCanvasEl) this.chromaKeyCanvasEl = canvas;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return canvas.getContext("2d", { willReadFrequently: true });
  }

  /** Composed per-channel R/G/B LUTs for `grading`, memoized per clip id — see `colorGradingLutCache`'s
   *  own doc comment for the invalidation rule. Composition order (`master(channel(input))`) matches
   *  `colorCurves.ts`'s own `composeLuts` doc comment, verified against FFmpeg's `vf_curves.c`. */
  private resolveColorGradingLuts(clipId: string, grading: ColorGrading) {
    const cached = this.colorGradingLutCache.get(clipId);
    if (cached && cached.source === grading) return cached;
    const masterLut = buildCurveLut(grading.master);
    const next = {
      source: grading,
      r: composeLuts(masterLut, buildCurveLut(grading.red)),
      g: composeLuts(masterLut, buildCurveLut(grading.green)),
      b: composeLuts(masterLut, buildCurveLut(grading.blue)),
    };
    this.colorGradingLutCache.set(clipId, next);
    return next;
  }

  /** Draws every visible text track's active clip, on top of whatever the video layer drew. Several
   *  text tracks can be simultaneously active (each its own overlay) — drawn in track order, so a
   *  lower text track is behind a higher one if they ever visually overlap, matching how stacking
   *  order works for every other track kind in this app. */
  private drawTextLayer(project: Project, context: CanvasRenderingContext2D, frameWidth: number, frameHeight: number, time: number): void {
    const overrides = this.host.getLiveOverrides();
    for (const track of project.sequence.tracks) {
      if (track.kind !== "text" || !track.visible) continue;
      const clip = clipAtTime(track, time);
      if (!clip) continue;
      const asset = project.assets.find((a) => a.id === clip.assetId);
      if (!asset || asset.kind !== "text" || !asset.textStyle) continue;
      const elapsed = time - clip.timelineStart;
      // Same live-drag override as the video layer — see `getLiveOverrides`' own comment. Falls
      // through to `resolveTextStyle` (a keyframed clip's interpolated style at THIS instant) rather
      // than the asset's raw static `textStyle` directly — same "the live override wins outright,
      // otherwise resolve keyframes" order `drawVideoClip` already uses for `transform`. Zero behavior
      // change for a never-keyframed clip: `resolveTextStyle` returns `asset.textStyle` right back.
      const style = overrides.find((o) => o.clipId === clip.id)?.textStyle ?? resolveTextStyle(clip, elapsed, asset.textStyle);

      // A frame-space mask, independent of the text's own position/animation — see `TextCrop`'s own
      // doc comment. Established here, BEFORE any of the transition/animation draws below, so the
      // window stays fixed in place regardless of what `drawAnimatedText`'s bounce/pulse/wiggle
      // transforms or the transition compositors do to the content drawn inside it. Only THIS clip's
      // own `textCrop` gates a transition blend — a differently-cropped partner clip's own crop isn't
      // independently respected mid-blend, a deliberate v1 simplification (crop isn't keyframed and
      // transitions are transient, so this is a narrow, rare edge).
      const textCrop = overrides.find((o) => o.clipId === clip.id)?.textCrop ?? clip.textCrop;
      const cropRect =
        textCrop && !isIdentityTextCrop(textCrop)
          ? {
              x: frameWidth * textCrop.left,
              y: frameHeight * textCrop.top,
              w: frameWidth * (1 - textCrop.left - textCrop.right),
              h: frameHeight * (1 - textCrop.top - textCrop.bottom),
            }
          : null;
      function withCrop(draw: () => void): void {
        if (cropRect) {
          context.save();
          context.beginPath();
          context.rect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
          context.clip();
        }
        draw();
        if (cropRect) context.restore();
      }

      // `findTransitionPartner` is track-kind-agnostic (see its own doc comment) — a text clip with a
      // REAL partner blends from it through the EXACT same `compositeTransitionFrame` a video clip
      // does, just with `drawText` (not `drawTransformed`) filling the two scratch canvases first. A
      // `null` partner (solo fade-in) goes through `compositeSoloReveal` instead — see its own doc
      // comment for why the two-panel path can't represent a solo fade correctly.
      const transition = findTransitionPartner(track, clip);
      if (transition && elapsed < transition.duration) {
        const partner = transition.partner;
        const progress = elapsed / transition.duration;
        if (partner) {
          const partnerAsset = project.assets.find((a) => a.id === partner.assetId);
          if (partnerAsset?.kind === "text" && partnerAsset.textStyle) {
            const outCtx = this.transitionCanvas("a", frameWidth, frameHeight);
            const inCtx = this.transitionCanvas("b", frameWidth, frameHeight);
            if (outCtx && inCtx) {
              this.drawText(outCtx, frameWidth, frameHeight, partnerAsset.textContent ?? "", partnerAsset.textStyle);
              this.drawText(inCtx, frameWidth, frameHeight, asset.textContent ?? "", style);
              withCrop(() => {
                compositeTransitionFrame(
                  context,
                  frameWidth,
                  frameHeight,
                  clip.transitionIn?.type ?? "crossfade",
                  progress,
                  this.transitionCanvasA!,
                  this.transitionCanvasB!
                );
              });
              continue;
            }
          }
        } else {
          withCrop(() => {
            compositeSoloReveal(context, frameWidth, frameHeight, clip.transitionIn?.type ?? "crossfade", progress, () => {
              this.drawText(context, frameWidth, frameHeight, asset.textContent ?? "", style);
            });
          });
          continue;
        }
      }

      // Fade-out: mirror of the fade-in case above, at this clip's own tail. `findTransitionOut` only
      // ever resolves once nothing genuinely follows this clip (see its own doc comment) — a real
      // successor's own `transitionIn` already owns that boundary.
      const transitionOut = findTransitionOut(track, clip);
      if (transitionOut) {
        const remaining = clipEnd(clip) - time;
        if (remaining < transitionOut.duration) {
          const reveal = Math.min(1, Math.max(0, remaining / transitionOut.duration));
          withCrop(() => {
            compositeSoloReveal(context, frameWidth, frameHeight, clip.transitionOut?.type ?? "crossfade", reveal, () => {
              this.drawText(context, frameWidth, frameHeight, asset.textContent ?? "", style);
            });
          });
          continue;
        }
      }

      withCrop(() => {
        this.drawAnimatedText(context, frameWidth, frameHeight, asset.textContent ?? "", style, clip.textAnimation, elapsed, clipDuration(clip));
      });
    }
  }

  /** `drawText`, plus whatever `animation` asks for — a thin wrapper, not folded into `drawText`
   *  itself, since a transitioning clip (the two branches above, both `continue`ing before ever
   *  reaching this call) deliberately does NOT also animate: composing a continuous motion effect with
   *  an in-flight transition blend is real added complexity (which of the two scratch canvases gets
   *  the animated draw? does the transition's own progress interact with the animation's phase?) for a
   *  combination a v1 pass doesn't need to get right — see `TextAnimationType`'s own doc comment on
   *  the export-side scope cut this pairs with. `elapsedSeconds` is simply `time - clip.timelineStart`,
   *  the same value every other per-clip timing calculation in this file already uses.
   *  `clipDurationSeconds` is only ever consulted for `wordHighlight` (see `activeWordIndex`'s own doc
   *  comment on why it needs the clip's own length, unlike every other animation type here). */
  private drawAnimatedText(
    context: CanvasRenderingContext2D,
    frameWidth: number,
    frameHeight: number,
    content: string,
    style: TextStyle,
    animation: Clip["textAnimation"],
    elapsedSeconds: number,
    clipDurationSeconds: number
  ): void {
    if (!animation) {
      this.drawText(context, frameWidth, frameHeight, content, style);
      return;
    }
    // `speed` scales the effective elapsed time fed to EVERY animation type uniformly — applied once,
    // here, rather than threading a speed parameter through `computeTextAnimationTransform`/
    // `typewriterVisibleContent`/`activeWordIndex` individually. None of those functions need their
    // own notion of speed this way; they just see a bigger or smaller elapsed-time number than the
    // clip's real playhead position implies.
    const elapsed = elapsedSeconds * (animation.speed ?? 1);

    if (animation.type === "typewriter") {
      this.drawText(context, frameWidth, frameHeight, typewriterVisibleContent(content, elapsed), style);
      return;
    }
    if (animation.type === "wordHighlight") {
      const words = splitWords(content);
      const active = activeWordIndex(words.length, elapsed, clipDurationSeconds);
      this.drawText(context, frameWidth, frameHeight, content, style, {
        activeWordIndex: active,
        highlightColor: animation.highlightColor ?? DEFAULT_WORD_HIGHLIGHT_COLOR,
      });
      return;
    }

    const { dx, dy, scale, rotationDeg } = computeTextAnimationTransform(animation.type, elapsed);
    // Pivots around the text BLOCK's own real center — NOT `frameWidth/2 + style.offsetX`, which is
    // only correct for `align: "center"`. `computeTextBlock` already resolves `blockLeft`/`blockTop`
    // correctly for `"left"`/`"right"` too (hugging their own frame edge, inset by `TEXT_MARGIN_PX`,
    // not the frame center) — reusing it here, instead of re-deriving a separate approximation, is
    // what keeps a left/right-aligned clip pulsing/wiggling IN PLACE rather than around a point that's
    // nowhere near where the text actually is. Redundant with the measurement `drawText` below does
    // again via its own `computeTextBlock` call — real but cheap (`measureText` on a short string),
    // and simpler than threading the already-measured block through `drawText`'s own signature.
    const block = computeTextBlock(context, frameWidth, frameHeight, content, style);
    const pivotX = block.blockLeft + block.blockWidth / 2;
    const pivotY = block.blockTop + block.blockHeight / 2;
    context.save();
    context.translate(dx, dy);
    context.translate(pivotX, pivotY);
    context.rotate((rotationDeg * Math.PI) / 180);
    context.scale(scale, scale);
    context.translate(-pivotX, -pivotY);
    this.drawText(context, frameWidth, frameHeight, content, style);
    context.restore();
  }

  /** Renders one text asset's content+style. Deliberately reproduces the SAME approximation
   *  `buildExportPlan`'s FFmpeg `drawtext` chain is forced into — see `textLayout.ts`'s own doc
   *  comment for why: every line grows rightward from ONE shared x (computed from the align setting
   *  and the WIDEST line's width), never per-line `textAlign` centering, even though Canvas2D could
   *  do the fancier thing. Agreement with export matters more here than either renderer being
   *  independently more correct.
   *
   *  Rotation pivots around the SEQUENCE FRAME's own center, offset applied AFTER rotating (not the
   *  text block's own visual center) — a second, less obvious instance of that same "match export"
   *  principle. Canvas2D COULD rotate around the block's own true center directly (whatever the align
   *  setting), but FFmpeg's `rotate` filter fundamentally can't: it only spins a buffer around ITS OWN
   *  geometric center, and — critically — the text block's true center for `align: "left"`/`"right"`
   *  depends on the rendered text's actual measured width, which only exists inside FreeType's own
   *  per-frame evaluation of ONE `drawtext` call and isn't exposed to any sibling FFmpeg filter (no
   *  expression variable carries it across). Frame-center is the one pivot BOTH renderers can compute
   *  exactly, with zero text-width dependency, so both use it — see `buildRotatedDrawTextFilter`'s own
   *  comment for the FFmpeg-side half of this. For `align: "center"` (the default) this is invisible:
   *  frame-center-plus-offset IS the block's own true center exactly, so nothing looks different. */
  private drawText(
    context: CanvasRenderingContext2D,
    frameWidth: number,
    frameHeight: number,
    content: string,
    style: TextStyle,
    wordHighlight?: { activeWordIndex: number; highlightColor: string }
  ): void {
    const block = computeTextBlock(context, frameWidth, frameHeight, content, style);
    // The block's NATURAL (align-anchored, offset-EXCLUDED) position — offsetX/Y are additive terms in
    // `computeTextBlock`'s own anchor formula, so subtracting them back out recovers this without a
    // second measurement pass. This is what gets rotated; the offset then applies as a translate
    // OUTSIDE the rotation, exactly mirroring `buildRotatedDrawTextFilter`'s draw-then-rotate-then-
    // overlay order.
    const drawLeft = style.rotationDeg !== 0 ? block.blockLeft - style.offsetX : block.blockLeft;
    const drawTop = style.rotationDeg !== 0 ? block.blockTop - style.offsetY : block.blockTop;
    const frameCenterX = frameWidth / 2;
    const frameCenterY = frameHeight / 2;

    context.save();
    if (style.rotationDeg !== 0) {
      context.translate(style.offsetX, style.offsetY);
      context.translate(frameCenterX, frameCenterY);
      context.rotate((style.rotationDeg * Math.PI) / 180);
      context.translate(-frameCenterX, -frameCenterY);
    }

    if (style.backgroundColor) {
      context.fillStyle = style.backgroundColor;
      context.fillRect(
        drawLeft - TEXT_BOX_PADDING,
        drawTop - TEXT_BOX_PADDING,
        block.blockWidth + TEXT_BOX_PADDING * 2,
        block.blockHeight + TEXT_BOX_PADDING * 2
      );
    }

    // `baselineOffset` is derived from the browser's own real font metrics (see `computeTextBlock`'s
    // own comment) — not a fontSize-based guess, so the glyphs actually center within their own
    // padded background box regardless of how a script's ascent/descent proportions compare to Latin.
    const firstBaseline = drawTop + block.baselineOffset;
    const drawLines = (draw: (line: string, x: number, y: number) => void) =>
      block.lines.forEach((line, i) => draw(line, drawLeft, firstBaseline + block.lineHeight * i));

    // Set AFTER the background box (which shouldn't get a shadow of its own) and left active through
    // both the stroke and fill draws below — canvas naturally draws a shadow under EACH, but since both
    // land on the identical glyph shapes, the two shadow instances just overlap into one, matching
    // FFmpeg's own fixed draw order for `drawtext`: shadow, then outline, then fill (see
    // `buildDrawTextStyleParams`'s comment). `shadowBlur` stays 0 — FFmpeg's shadow is a hard-edged
    // offset duplicate, not a blurred one, and there's no blur radius to match if there were.
    if (style.shadowColor) {
      context.shadowColor = style.shadowColor;
      context.shadowOffsetX = style.shadowOffsetX;
      context.shadowOffsetY = style.shadowOffsetY;
      context.shadowBlur = 0;
    }

    if (style.strokeColor) {
      context.strokeStyle = style.strokeColor;
      // `strokeText` centers the stroke ON the glyph's own outline — half the width lands INSIDE the
      // glyph (invisible, covered by the fill drawn next) and half OUTSIDE (the only part actually
      // visible). Doubling here makes the VISIBLE thickness equal `strokeWidth`, matching FFmpeg's
      // `borderw`, which specifies the outer border thickness directly rather than a centered stroke.
      context.lineWidth = style.strokeWidth * 2;
      context.lineJoin = "round"; // avoids spiky miters at sharp glyph corners, closer to FFmpeg's own border rendering
      drawLines((line, x, y) => context.strokeText(line, x, y));
    }

    if (wordHighlight) {
      // Per-word fill only — shadow/stroke/background above stay whole-line, matching how a caption's
      // outline/box reads as one continuous shape rather than N separate word-sized ones. Walks EVERY
      // `segmentLine` token (not just the word-like ones) so whitespace/punctuation between words
      // still advances `x` by its own measured width rather than an assumed space size — matters for
      // tab-indented or multiple-space-separated captions, where a guessed width would visibly drift
      // the line. `segmentLine` (not a plain `.split(/\s+/)`) is what makes this correct for Khmer and
      // the other scripts that don't space words at all — see its own comment in
      // `timeline/textAnimation.ts`. `globalWordIndex` only advances on WORD segments, matching
      // `splitWords`'s own counting exactly, so `wordHighlight.activeWordIndex` (computed FROM
      // `splitWords`) always lands on the same word this loop actually colors.
      let globalWordIndex = 0;
      block.lines.forEach((line, i) => {
        const y = firstBaseline + block.lineHeight * i;
        let x = drawLeft;
        for (const token of segmentLine(line)) {
          if (token.text.length === 0) continue;
          if (!token.isWord) {
            x += context.measureText(token.text).width;
            continue;
          }
          context.fillStyle = globalWordIndex === wordHighlight.activeWordIndex ? wordHighlight.highlightColor : style.color;
          context.fillText(token.text, x, y);
          x += context.measureText(token.text).width;
          globalWordIndex++;
        }
      });
    } else {
      context.fillStyle = style.color;
      drawLines((line, x, y) => context.fillText(line, x, y));
    }
    context.restore();
  }

  private syncAudioTracks(project: Project, time: number, playing: boolean): void {
    this.audioMixEngine.syncAudioTrackClips(this.activeAudioClips(project, time), playing);
  }

  /** Pauses everything that isn't currently under the playhead. Without this, a clip's audio keeps
   *  playing after the playhead has moved past it. */
  private pauseInactive(activeClipIds: Set<string>): void {
    for (const [clipId, { element }] of this.pool) {
      // Images have nothing to pause — they're just a decoded bitmap sitting in the pool.
      if (element instanceof HTMLImageElement) continue;
      if (!activeClipIds.has(clipId) && !element.paused) element.pause();
    }
  }

  private pauseAll(): void {
    for (const { element } of this.pool.values()) {
      if (!(element instanceof HTMLImageElement)) element.pause();
    }
  }
}
