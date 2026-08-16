import type { Clip, ClipEffects, ClipTransform, Project, TextStyle, Track } from "../project/types.ts";
import { IDENTITY_EFFECTS, IDENTITY_TRANSFORM, isIdentityEffects } from "../project/types.ts";
import type { ClipOverride } from "../timeline/groupMove.ts";
import { audibleClips, clipAtTime } from "../timeline/queries.ts";
import { findTransitionPartner } from "../timeline/transitions.ts";
import { computeTransformedBox } from "./transformGeometry.ts";
import { computeTextBlock, TEXT_BOX_PADDING } from "./textLayout.ts";

/** How far a media element may drift from the master clock before it gets re-seeked. Below this,
 *  correcting would cause more visible stutter than the drift itself. */
const DRIFT_TOLERANCE = 0.2;
/** Media elements kept alive after they stop being needed. Keeping a few around makes scrubbing back
 *  and forth across a cut smooth, since the element is already decoded and buffered. */
const POOL_LIMIT = 8;

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
}

/** A still image is decoded into an `<img>` rather than a media element: it has no `currentTime`, no
 *  `play()`, and nothing to keep in sync — it just needs to be decoded once and then drawn on every
 *  frame it covers. */
type PoolElement = HTMLVideoElement | HTMLAudioElement | HTMLImageElement;

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
  private running = false;
  /** The canvas's own on-screen (CSS) size, in raw CSS pixels — set by `Preview.tsx` via a
   *  `ResizeObserver` (a class outside React has no way to observe layout on its own). Null until the
   *  first observation lands, in which case `tick` falls back to the full sequence resolution rather
   *  than guessing at a size. */
  private displayWidth: number | null = null;
  private displayHeight: number | null = null;

  constructor(host: PlaybackHost) {
    this.host = host;
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

  /** Tears everything down: stops the loop and releases every media element. Without the explicit
   *  `src` clear and `load()`, a detached element can keep its network request and decoder alive. */
  detach(): void {
    this.stop();
    for (const { element } of this.pool.values()) this.release(element);
    this.pool.clear();
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
  private mediaFor(clip: Clip, kind: "video" | "audio" | "image"): PoolElement | null {
    const existing = this.pool.get(clip.id);
    if (existing) {
      existing.lastUsed = performance.now();
      return existing.element;
    }

    const url = this.host.mediaUrlFor(clip.assetId);
    if (!url) return null;

    const element =
      kind === "image"
        ? document.createElement("img")
        : kind === "video"
          ? document.createElement("video")
          : document.createElement("audio");
    element.src = url;
    // Never attached to the document: the canvas is what the user sees, and an off-DOM element still
    // decodes and plays audio perfectly well.
    if (element instanceof HTMLVideoElement) {
      element.preload = "auto";
      element.playsInline = true;
      element.muted = false;
    } else if (element instanceof HTMLAudioElement) {
      element.preload = "auto";
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
      this.release(element);
      this.pool.delete(clipId);
    }
  }

  /** Slaves one media element to the master clock. */
  private syncMedia(
    element: HTMLVideoElement | HTMLAudioElement,
    sourceTime: number,
    playing: boolean,
    volumeMuted: boolean,
    gain: number
  ): void {
    element.muted = volumeMuted;
    // Independent of `muted`: the browser's own `.muted`/`.volume` semantics already compose exactly
    // the way `Clip.gain`'s own doc comment describes (muted silences regardless of volume, and
    // volume is "how loud when audible") — nothing extra needed here to make the two cooperate.
    element.volume = gain;

    // readyState 0 means nothing is loaded yet — seeking now would be discarded once metadata
    // arrives, so let it load and correct on a later frame.
    if (element.readyState === 0) return;

    if (Math.abs(element.currentTime - sourceTime) > DRIFT_TOLERANCE) {
      element.currentTime = sourceTime;
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
    let time = this.host.getPlayhead();

    if (playing && delta > 0) {
      time += delta;
      const total = this.totalDuration(project);
      if (time >= total) {
        this.host.onTimeUpdate(total);
        this.host.onEnded();
        this.pauseAll();
        this.drawFrame(project, context, total);
        return;
      }
      this.host.onTimeUpdate(time);
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
  }

  /** Audio-track clips whose time window actually contains `time` right now — as opposed to
   *  `audibleClips`, which returns every clip on every audible (unmuted/soloed) track regardless of
   *  where it sits on the timeline.
   *
   *  This distinction is what `drawFrame`'s calls to `pauseInactive` need, and using the wrong one
   *  there was a real, confirmed bug: passing ALL audible clips as "protected from pausing" meant an
   *  audio-track clip's element was NEVER told to pause once the playhead moved past its window — it
   *  just kept playing indefinitely, since `syncAudioTracks` also stops touching it the moment it's
   *  no longer active. The inverse bug hit at the same spot: during a gap in the video track,
   *  `drawFrame`'s early return called `pauseInactive(new Set())` — an EMPTY protected set — which
   *  paused every currently-audible element including audio-track clips that should keep playing
   *  under a video gap (background music, a voiceover with no matching footage yet). Both call sites
   *  now filter through this one method instead of disagreeing about what "active" means. */
  private activeAudioClips(project: Project, time: number): { clip: Clip }[] {
    return audibleClips(project).filter(
      ({ clip }) => time >= clip.timelineStart && time < clip.timelineStart + (clip.sourceOut - clip.sourceIn)
    );
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
      // A video clip's own audio is silenced/scaled when the clip itself is muted/gained — matching
      // what export does, so preview and output agree. The track's own visibility no longer needs
      // checking here: `drawVideoLayer` already skips hidden tracks entirely before this is ever
      // called.
      this.syncMedia(element, sourceTime, this.host.isPlaying(), clip.mutedAudio ?? false, clip.gain ?? 1);
      // readyState < 2 means no frame is decoded yet; drawing would throw or paint garbage.
      if (element.readyState < 2) return;
      sourceWidth = element.videoWidth;
      sourceHeight = element.videoHeight;
    } else {
      return;
    }

    if (sourceWidth === 0 || sourceHeight === 0) return;

    // A live drag in progress on THIS clip (directly, or as part of a multi-select group move)
    // overrides its saved transform — see `getLiveOverrides`' own comment for why: without this, the
    // canvas would only ever show the last COMMITTED position while `TransformHandles`' own overlay
    // box(es) track the pointer, which reads as "only the selection box moves."
    const override = this.host.getLiveOverrides().find((o) => o.clipId === clip.id);
    const transform = override?.transform ?? clip.transform ?? IDENTITY_TRANSFORM;
    const effects = clip.effects ?? IDENTITY_EFFECTS;

    // A crossfade is just a plain alpha cross-dissolve — draw the outgoing clip's own tail frame
    // first at (1 - progress), then this clip's normal frame on top at (progress). Only attempted
    // while genuinely inside the blend window; `findTransitionPartner` re-validates adjacency fresh
    // every call (see its own doc comment), so a broken precondition just falls through to drawing
    // this clip alone, same as a plain cut always has. Operates entirely within THIS track — a
    // transition on one track has no effect on any other track's own compositing.
    const transition = findTransitionPartner(track, clip);
    const elapsed = time - clip.timelineStart;
    if (transition && elapsed < transition.duration) {
      const progress = elapsed / transition.duration;
      const partnerDrawn = this.drawTransitionPartner(
        project,
        context,
        frameWidth,
        frameHeight,
        transition.partner,
        transition.duration,
        elapsed,
        1 - progress
      );
      if (partnerDrawn) {
        this.drawTransformed(context, element, sourceWidth, sourceHeight, frameWidth, frameHeight, transform, effects, progress);
        return;
      }
    }

    this.drawTransformed(context, element, sourceWidth, sourceHeight, frameWidth, frameHeight, transform, effects);
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
    elapsed: number,
    alpha: number
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

    const transform = partner.transform ?? IDENTITY_TRANSFORM;
    const effects = partner.effects ?? IDENTITY_EFFECTS;
    this.drawTransformed(context, element, sourceWidth, sourceHeight, frameWidth, frameHeight, transform, effects, alpha);
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
    alphaMultiplier = 1
  ): void {
    const box = computeTransformedBox(sourceWidth, sourceHeight, frameWidth, frameHeight, transform);
    if (!box) return;

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
      element,
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
      // Same live-drag override as the video layer — see `getLiveOverrides`' own comment.
      const style = overrides.find((o) => o.clipId === clip.id)?.textStyle ?? asset.textStyle;
      this.drawText(context, frameWidth, frameHeight, asset.textContent ?? "", style);
    }
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
  private drawText(context: CanvasRenderingContext2D, frameWidth: number, frameHeight: number, content: string, style: TextStyle): void {
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

    // Baseline of the first line sits one line-height down from the block's top, with the leftover
    // (lineHeight - fontSize) space split so the glyphs are vertically centered within their own line
    // — approximates a font's natural ascent without needing its exact metrics.
    const firstBaseline = drawTop + block.lineHeight - (block.lineHeight - style.fontSize) / 2;
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

    context.fillStyle = style.color;
    drawLines((line, x, y) => context.fillText(line, x, y));
    context.restore();
  }

  private syncAudioTracks(project: Project, time: number, playing: boolean): void {
    for (const { clip } of this.activeAudioClips(project, time)) {
      const element = this.mediaFor(clip, "audio");
      if (element instanceof HTMLAudioElement) {
        this.syncMedia(element, clip.sourceIn + (time - clip.timelineStart), playing, clip.mutedAudio ?? false, clip.gain ?? 1);
      }
    }
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
