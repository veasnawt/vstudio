import { TEXT_BOX_PADDING, TEXT_MARGIN_PX } from "../playback/textLayout.ts";
import { clipDuration, clipEnd, findAsset, sequenceDuration } from "../project/createProject.ts";
import { fontById, fontFileFor, resolveFontVariant } from "../project/fonts.ts";
import type { AssFontMetrics, FontDefinition } from "../project/fonts.ts";
import type { ChromaKeySettings, Clip, ClipEffects, ClipTransform, ColorGrading, Project, TextCrop, TextStyle, TransitionType, Track } from "../project/types.ts";
import { IDENTITY_EFFECTS, IDENTITY_TRANSFORM, isIdentityColorGrading, isIdentityEffects, isIdentityTextCrop, isIdentityTransform } from "../project/types.ts";
import {
  activeWordIndex,
  BOUNCE_AMPLITUDE_PX,
  BOUNCE_PERIOD_SECONDS,
  DEFAULT_WORD_HIGHLIGHT_COLOR,
  PULSE_AMPLITUDE,
  PULSE_PERIOD_SECONDS,
  segmentLine,
  splitWords,
  TYPEWRITER_CHARS_PER_SECOND,
  WIGGLE_AMPLITUDE_DEG,
  WIGGLE_PERIOD_SECONDS,
} from "../timeline/textAnimation.ts";
import { hasColorGradingKeyframes, hasEffectsKeyframes, hasTextStyleKeyframes, hasTransformKeyframes, resolveClipColorGrading, resolveClipEffects, resolveClipTransform, resolveTextStyle } from "../timeline/keyframes.ts";
import { snapToFrame } from "../timeline/time.ts";
import { findTransitionOut, findTransitionPartner } from "../timeline/transitions.ts";
import { buildCurvesFilterFragment } from "./curvesFilter.ts";
import { buildPanFilterStage } from "./panFilter.ts";

/** `TransitionType` → FFmpeg's own `xfade` filter transition name — a 1:1 mapping (every value here
 *  IS the real xfade name already, see `TransitionType`'s own doc comment on why only names from
 *  xfade's ORIGINAL 4.3 set were chosen), kept as an explicit table anyway rather than a
 *  lowercase-the-enum-value trick so the two can never silently drift if either naming convention ever
 *  changes independently. Used for BOTH video/image clips (`xfade=transition=...`) and text clips
 *  (the text-blend filter graph `buildDrawTextTransitionFilters` builds) — export renders the exact
 *  distinct type either way, unlike the canvas preview's four-family grouping (see
 *  `PlaybackEngine.transitionFamily`). */
const TRANSITION_XFADE_NAME: Record<TransitionType, string> = {
  crossfade: "fade",
  dissolve: "dissolve",
  wipeLeft: "wipeleft",
  wipeRight: "wiperight",
  wipeUp: "wipeup",
  wipeDown: "wipedown",
  slideLeft: "slideleft",
  slideRight: "slideright",
  slideUp: "slideup",
  slideDown: "slidedown",
  circleOpen: "circleopen",
  circleClose: "circleclose",
};

/** Builds the FFmpeg invocation that renders a project to a finished file.
 *
 *  Kept as a pure function — project in, argument list out — specifically so the hardest part of
 *  export (getting the filter graph right) can be unit-tested without spawning anything or touching
 *  a disk. The route layer only resolves paths and runs what this returns.
 *
 *  ## Why one input per clip, with `-ss`/`-t`
 *
 *  Each clip becomes its own `-i` with `-ss <in> -t <duration>` in front of it, rather than one
 *  input per file with `trim` filters. Two reasons: placing `-ss` BEFORE `-i` makes FFmpeg seek and
 *  decode only the range actually needed (dramatically faster on long sources — the exact case
 *  non-destructive editing creates), and it sidesteps having to `split` a reused input pad when the
 *  same file appears in several clips.
 *
 *  ## Why gaps become real black segments
 *
 *  A timeline with a hole in it has to export with that hole intact, or the exported video would be
 *  shorter than the edit and every clip after the gap would land at the wrong time. Gaps are filled
 *  with generated black video and silence so the output matches the timeline exactly. */

export interface ExportPlanOptions {
  /** Absolute path to the media file backing an asset. Injected rather than computed here so this
   *  module stays free of any filesystem or path knowledge. */
  inputPathFor: (assetId: string) => string;
  outputPath: string;
  /** Absolute path to a bundled font FILE, given its filename (e.g. "Battambang-Bold.ttf" — see the
   *  registry in `project/fonts.ts`, which is what this module uses to turn a clip's `fontFamily`/
   *  `bold`/`italic` into that filename before calling this). Only called when the project actually
   *  has a text clip — a project with none never needs to know fonts exist. */
  fontPathFor: (fileName: string) => string;
  /** Writes `content` to a text file FFmpeg's `drawtext` can read via `textfile=`, and returns its
   *  absolute path. A real (if small) side effect behind an injected function, same as `inputPathFor`
   *  implicitly assumes its files already exist on disk — kept out of this module directly so a unit
   *  test can inject a fake resolver that never touches disk. `textfile=` rather than escaping
   *  `content` into `text=` directly: user-authored text can contain `:`, `'`, `\`, or `%`, every one
   *  of them meaningful to FFmpeg's OWN filter-string grammar, and a text FILE sidesteps that whole
   *  class of injection/escaping bugs by never putting the content in the filter string at all.
   *
   *  `variant` distinguishes the several DIFFERENT text files one clip can now need — `typewriter`
   *  export renders one `drawtext` per revealed-prefix state (see `buildTypewriterDrawTextCalls`), each
   *  needing its own file so an earlier prefix's file isn't overwritten by a later one before FFmpeg
   *  reads it. Omitted (the plain, single-file case) for every other clip, unchanged from before this
   *  existed. */
  textFilePathFor: (clip: Clip, content: string, variant?: string) => string;
  /** The video encoder + its own rate-control flags, as one pre-built arg fragment — defaults to
   *  libx264 (desktop/server behavior, unchanged) when omitted. Injected rather than hardcoded because
   *  the encoder NAME alone isn't swappable in isolation: `-preset`/`-crf` are libx264-specific flags,
   *  meaningless (or rejected outright) by another encoder, so a caller needing a different one has to
   *  supply its complete matching fragment, not just a different `-c:v` value. `nativeExport.ts` passes
   *  one — the FFmpeg engine bundled for on-device mobile export doesn't include libx264 at all (a real
   *  gap discovered testing on a physical device, not a hypothetical). */
  videoEncoderArgs?: string[];
  /** The three capabilities `wordHighlight` export needs — ALL THREE optional together, not
   *  independently: a `clip.textAnimation.type === "wordHighlight"` clip renders through FFmpeg's
   *  `subtitles=` (libass) filter instead of `drawtext`, since coloring individual WORDS within one
   *  call is beyond what `drawtext` can express and there's no way to feed one `drawtext` call's
   *  measured `text_w` into another's position (see `buildWordHighlightSubtitlesFilter`'s own comment
   *  for the full reasoning). Omitting any of the three makes `wordHighlight` fall back to rendering as
   *  plain static text — the same behavior every OTHER animation type already falls back to when
   *  combined with a scope cut (e.g. a static `rotationDeg` alongside `bounce`/`pulse`) — rather than
   *  this module assuming libass is always available. `nativeExport.ts` (mobile) currently omits all
   *  three: the bundled on-device FFmpeg engine's libass support hasn't been confirmed, so mobile export
   *  keeps the pre-existing plain-text behavior rather than risking a broken filtergraph on a build that
   *  might not have the filter at all. */
  assFilePathFor?: (clip: Clip, assContent: string) => string;
  /** Resolves a font's real ASS metrics (family name + fontsize scale) from its own file bytes — see
   *  `AssFontMetrics`'s own doc comment in `project/fonts.ts` for why both are needed and how
   *  `fontsizeScale` was derived. Returning `null` (a font whose bytes didn't parse as expected) is
   *  treated the same as the option being entirely absent for THAT font — `wordHighlight` falls back to
   *  plain text for that one clip rather than emitting a filter libass can't resolve a font for. */
  fontMetricsFor?: (font: FontDefinition) => AssFontMetrics | null;
  /** Absolute path to the directory containing every bundled font file — libass's `subtitles=` filter
   *  resolves a `Style: Fontname` by NAME via its own `fontsdir=` directory scan (unlike `drawtext`'s
   *  `fontfile=`, which points at one exact file), so this needs the whole folder, not a per-file path
   *  the way `fontPathFor` is. */
  fontsDirFor?: () => string;
}

export interface ExportPlan {
  args: string[];
  /** Total output length in seconds — what progress is measured against. */
  duration: number;
}

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportError";
  }
}

/** One side of a transition segment — the clip it's drawn from, plus everything needed to build its
 *  own filter chain, mirroring the fields a plain "clip" segment already carries. */
interface TransitionSide {
  clip: Clip;
  hasAudio: boolean;
  isImage: boolean;
  path: string;
}

export type Segment =
  | {
      kind: "clip";
      clip: Clip;
      hasAudio: boolean;
      isImage: boolean;
      path: string;
      sourceIn: number;
      duration: number;
      /** Set only for a SOLO transition-in — `findTransitionPartner` resolved `clip.transitionIn` but
       *  found no adjacent predecessor to blend from (see that function's own doc comment). `xfade`
       *  needs two real streams, which a solo fade doesn't have, so this renders as a plain `fade`/
       *  `afade` on the clip's own stream instead of a `"transition"` segment — see `buildTrackStreams`'s
       *  own handling. Absent (not 0) for every ordinary clip, same "small/cheap default path"
       *  convention the rest of this codebase uses for optional fields. */
      fadeIn?: number;
      /** `findTransitionOut`'s resolved duration, when this segment is the TAIL segment of a clip that
       *  has one (see that function's own doc comment — always a solo fade, there's no blend-into-next
       *  shape to speak of). Rendered the same way as `fadeIn`: a plain `fade`/`afade` stage, just
       *  anchored at this segment's own END instead of its start. NOT attached when a real
       *  `"transition"` segment consumes this clip's ENTIRE duration (no separate tail segment exists
       *  to attach it to) — an edge case narrow enough (a transition-in longer than the whole clip)
       *  that a fade-out simply doesn't apply there, rather than adding a third rendering shape for it. */
      fadeOut?: number;
    }
  | { kind: "gap"; duration: number }
  | { kind: "transition"; duration: number; from: TransitionSide; to: TransitionSide };

/** Walks the track start-to-end, emitting a segment per clip and a gap wherever the timeline is
 *  empty between them — plus, wherever `findTransitionPartner` confirms a real crossfade into a
 *  clip, a `"transition"` segment spliced in front of that clip's own (now head-shortened) one.
 *  Finally, a trailing gap fills any remaining space between this track's own last clip and
 *  `targetDuration` (the FULL project duration, not just this track's own content) — without it, a
 *  track whose own content ends early would produce a SHORTER stream than a track that runs the
 *  whole timeline. That's harmless for a single video track (nothing to compare it against), but
 *  fatal once multiple video tracks are layered with `overlay`: FFmpeg's `overlay` filter defaults to
 *  `eof_action=repeat`, freezing on the shorter stream's OWN last frame for the rest of the export
 *  the moment it runs out — so a short overlay clip (a watermark, a PIP insert) would otherwise stay
 *  frozen on-screen long after its own clip actually ended. Always padding every track's stream out
 *  to the same `targetDuration` is what keeps every layer's own EOF landing at the same instant.
 *
 *  The split is deliberately ASYMMETRIC, to exactly match `PlaybackEngine.drawVideoLayer`'s own
 *  preview behavior (see its comment): the transition's `duration` seconds live entirely within the
 *  INCOMING clip's own nominal timeline window (`[clip.timelineStart, clip.timelineStart+duration)`),
 *  never inside the OUTGOING clip's. So the outgoing clip's segment is emitted in full, unshortened
 *  — the same tail frames it ends on play twice (once plainly, once blended into the transition),
 *  same as preview replays them — while only the incoming clip's own segment is shortened, at its
 *  HEAD, by however much the transition already covers. This keeps the total exported duration
 *  exactly equal to the sum of every clip's own nominal length, matching `sequenceDuration` with no
 *  separate accounting needed. */
/** Exported so `buildAudioOnlyExportPlan.ts` can reuse the exact same segment-walk (clip/gap/
 *  transition boundaries, transition-shortened heads) an audio-only mixdown needs to match precisely
 *  — narrowed to `Pick<ExportPlanOptions, "inputPathFor">` rather than the full options shape, since
 *  that's the only field this function itself ever reads (fonts/text-file paths are video-layer-only
 *  concerns, resolved by callers that actually draw text). */
export function buildSegments(
  project: Project,
  track: Track,
  clips: Clip[],
  options: Pick<ExportPlanOptions, "inputPathFor">,
  targetDuration: number
): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;

  for (const clip of clips) {
    if (clip.timelineStart > cursor + 1e-6) {
      segments.push({ kind: "gap", duration: clip.timelineStart - cursor });
    }
    const asset = findAsset(project, clip.assetId);
    if (!asset) throw new ExportError(`A clip references media that is no longer in the project`);
    if (asset.offline) throw new ExportError(`"${asset.name}" is offline. Relink it before exporting.`);

    const isImage = asset.kind === "image";
    const path = options.inputPathFor(clip.assetId);
    const fullDuration = clipDuration(clip);
    const transition = findTransitionPartner(track, clip);
    const transitionOut = findTransitionOut(track, clip);
    const fadeOut = transitionOut?.duration;

    if (transition?.partner) {
      const partner = transition.partner;
      const partnerAsset = findAsset(project, partner.assetId);
      if (!partnerAsset) throw new ExportError(`A clip references media that is no longer in the project`);
      if (partnerAsset.offline) throw new ExportError(`"${partnerAsset.name}" is offline. Relink it before exporting.`);

      segments.push({
        kind: "transition",
        duration: transition.duration,
        from: {
          clip: partner,
          hasAudio: partnerAsset.hasAudio,
          isImage: partnerAsset.kind === "image",
          path: options.inputPathFor(partner.assetId),
        },
        to: { clip, hasAudio: asset.hasAudio, isImage, path },
      });

      const remaining = fullDuration - transition.duration;
      if (remaining > 1e-6) {
        segments.push({
          kind: "clip",
          clip,
          hasAudio: asset.hasAudio,
          isImage,
          path,
          sourceIn: clip.sourceIn + transition.duration,
          duration: remaining,
          fadeOut,
        });
      }
      // else: the transition-in blend consumes this clip's entire duration — no separate tail
      // segment exists to attach `fadeOut` to (see `Segment["clip"]["fadeOut"]`'s own doc comment).
    } else if (transition) {
      // Solo fade-in: no adjacent predecessor to blend from, so this is the clip's full, unshortened
      // segment (nothing stole a "head" duration from it) with `fadeIn` set instead of being split into
      // a `"transition"` segment — see `Segment["clip"]["fadeIn"]`'s own doc comment.
      segments.push({
        kind: "clip",
        clip,
        hasAudio: asset.hasAudio,
        isImage,
        path,
        sourceIn: clip.sourceIn,
        duration: fullDuration,
        fadeIn: transition.duration,
        fadeOut,
      });
    } else {
      segments.push({ kind: "clip", clip, hasAudio: asset.hasAudio, isImage, path, sourceIn: clip.sourceIn, duration: fullDuration, fadeOut });
    }

    cursor = clipEnd(clip);
  }

  if (targetDuration > cursor + 1e-6) {
    segments.push({ kind: "gap", duration: targetDuration - cursor });
  }

  return segments;
}

/** Rounds to millisecond precision. FFmpeg parses these as decimal seconds, and full float precision
 *  produces unreadable argument lists without improving accuracy at frame granularity. */
function t(seconds: number): string {
  return seconds.toFixed(6);
}

/** Same rounding for a plain numeric expression fragment (crop fractions, scale, degrees, pixel
 *  offsets) — not a time value, but the same "readable, frame/pixel-accurate precision" reasoning. */
function n(value: number): string {
  return value.toFixed(6);
}

/** Filter chain for a clip with a REAL transform and/or REAL effects (see `isIdentityTransform`/
 *  `isIdentityEffects` — the plain scale+pad chain below handles the fully-untouched case and is
 *  untouched by this). Empirically verified against the actual bundled FFmpeg binary before being
 *  wired in here — see the "any degree" verification in this feature's development notes for a
 *  rendered example.
 *
 *  Two FFmpeg mechanisms are what make the geometry tractable without any JS-side trigonometry:
 *  `rotate`'s `ow=rotw(a):oh=roth(a)` macros let FFmpeg itself compute the exact bounding box that
 *  fits the rotated content losslessly (no precomputed sizes needed here), and `overlay`'s
 *  `W`/`H`/`w`/`h` expression variables let the composite position reference both the background and
 *  overlay's actual sizes symbolically. `format=rgba` right after `crop` is what makes `rotate`'s
 *  `black@0` fill genuinely transparent PADDING rather than a visible black box — without an alpha
 *  channel there, `overlay` has nothing to composite through and the rotated corners show as solid
 *  black; it's also what `colorchannelmixer=aa=` (opacity) needs an alpha channel to modulate. */
function buildTransformFilters(params: {
  /** A filter-graph SOURCE reference — either a raw FFmpeg input selector (`` `${videoIndex}:v` ``, the
   *  non-keyframed path's own convention) or an already-`trim=`+`setpts=PTS-STARTPTS`-normalized label
   *  produced by `pushKeyframedClipVideoFilters`'s own `split=`/`trim=` fan-out — either way, just
   *  substituted verbatim into `[${source}]`, so this function doesn't need to know or care which. */
  source: string;
  /** Same shape as `source`, for the background input `overlay` composites the transformed clip onto. */
  bg: string;
  outputLabel: string;
  transform: ClipTransform;
  effects: ClipEffects;
  width: number;
  height: number;
  fps: number;
  chromaKey?: ChromaKeySettings;
  colorGrading?: ColorGrading;
}): string[] {
  const { source, bg, outputLabel, transform, effects, width, height, fps, chromaKey, colorGrading } = params;
  const { crop } = transform;
  const clipLabel = `${outputLabel}_src`;
  const bgLabel = `${outputLabel}_bg`;
  const angle = `${n(transform.rotationDeg)}*PI/180`;
  // Applied FIRST, on the raw un-cropped/un-scaled source — keying is a per-pixel color operation that
  // commutes with crop/scale/rotate, so where in the chain it runs doesn't change the RESULT, only
  // performance (fewer pixels to key before a downsize) and needing `format=rgba` right after it rather
  // than a separate reformat, since `colorkey` already outputs an alpha channel itself. `similarity` is
  // floored at 0.01 here (FFmpeg's own documented minimum) without touching the STORED value — 0 stays
  // meaningful in the UI/preview as "key nothing", `buildTransformFilters` just needs a technically
  // valid argument. Mirrors `applyChromaKey` (`playback/PlaybackEngine.ts`)'s own algorithm — see
  // `ChromaKeySettings`'s own doc comment for the shared preview/export parity goal.
  const chromaKeyFilter = chromaKey
    ? `colorkey=color=0x${chromaKey.color.slice(1)}:similarity=${n(Math.max(0.01, chromaKey.similarity))}:blend=${n(chromaKey.smoothness)},`
    : "";

  const cropFilter =
    `crop=w=iw*(1-${n(crop.left)}-${n(crop.right)}):h=ih*(1-${n(crop.top)}-${n(crop.bottom)})` +
    `:x=iw*${n(crop.left)}:y=ih*${n(crop.top)}`;
  // min(iw,ih) here is the CROPPED source's own dimensions — crop runs first in this chain, so
  // every filter after it sees the already-cropped size as its "iw"/"ih", exactly like the plain
  // scale+pad chain below sees the FULL source's iw/ih (there is no crop to have already applied).
  const scaleFilter =
    `scale=w='iw*min(${width}/iw,${height}/ih)*${n(transform.scale)}'` +
    `:h='ih*min(${width}/iw,${height}/ih)*${n(transform.scale)}'`;
  const rotateFilter = `rotate=a=${angle}:ow=rotw(${angle}):oh=roth(${angle}):c=black@0`;
  // eq's own defaults (brightness=0, contrast=1, saturation=1) are genuine no-ops, so — unlike
  // gblur/colorchannelmixer below — it's always safe to include unconditionally, no identity check
  // needed for this one fragment.
  //
  // NOT actually `eq=brightness=...:contrast=...:saturation=...` — `eq` is one of FFmpeg's own
  // GPL-only filters (see FFmpeg's "GPL Licensed Filters" list), so it doesn't exist in the LGPL
  // build the mobile app ships (see apps/mobile/ios/App/FFmpegKitLGPL's own comment on why that
  // build was chosen over a GPL one). This reproduces eq's exact per-plane math instead — from
  // FFmpeg's own vf_eq.c: luma gets `contrast*(v-0.5)+0.5+brightness` (v normalized to 0..1), chroma
  // gets the identical formula with `saturation` standing in for `contrast` and brightness pinned at
  // 0 — via `lutyuv`, which isn't GPL-gated. Same visual result, not an approximation; written
  // directly in the 0..255 pixel domain (127.5 standing in for eq's 0.5 midpoint) rather than
  // normalizing to 0..1 and back, since lutyuv's `val` is already the raw 8-bit sample.
  const eqFilter =
    `lutyuv=y='clip((val-127.5)*${n(effects.contrast)}+127.5+${n(effects.brightness * 255)},0,255)'` +
    `:u='clip((val-127.5)*${n(effects.saturation)}+127.5,0,255)'` +
    `:v='clip((val-127.5)*${n(effects.saturation)}+127.5,0,255)'`;
  // RGB curves color grading — see `curvesFilter.ts`'s own doc comment for why `master=` (never `all=`)
  // and why `curves` (unlike `eq` above) needs no LGPL workaround. Applied right after `eq`, same
  // post-crop/pre-scale pixel-domain position `PlaybackEngine.ts`'s own `drawTransformed` applies its
  // curves LUT pass in (both right after the chroma-key stage, before geometry).
  const curvesFilter = colorGrading ? buildCurvesFilterFragment(colorGrading, n) : null;
  // Applied AFTER scale, not before — so `blur`'s sigma corresponds to the clip's FINAL on-screen
  // pixel size, matching both the "pixels" unit the Inspector's slider promises and how Canvas2D's
  // own `context.filter` blurs the already-scaled draw, not the source's native resolution. Only
  // appended when actually blurring — an unconditional `gblur=sigma=0` is real filter-graph work
  // (unlike `eq` at its defaults) for the common no-blur case.
  const blurFilter = effects.blur > 0 ? `,gblur=sigma=${n(effects.blur)}` : "";
  // Alpha applied right before compositing onto the background, not earlier — the geometric filters
  // upstream (scale/rotate) don't need to see a partially-transparent source, only the final overlay
  // blend does.
  const opacityFilter = effects.opacity < 1 ? `,colorchannelmixer=aa=${n(effects.opacity)}` : "";

  return [
    `[${source}]${chromaKeyFilter}${cropFilter},format=rgba,${eqFilter}${curvesFilter ? `,${curvesFilter}` : ""},${scaleFilter}${blurFilter},${rotateFilter}${opacityFilter},` +
      `setsar=1,fps=${fps},setpts=PTS-STARTPTS[${clipLabel}]`,
    // The background is its own lavfi input (pushed alongside this), not an inline `color=` source
    // filter — matching the pattern gap segments already use elsewhere in this function, so there's
    // only one way black/silence sources get created in this file, not two.
    `[${bg}]setpts=PTS-STARTPTS[${bgLabel}]`,
    `[${bgLabel}][${clipLabel}]overlay=x='(W-w)/2+${n(transform.offsetX)}':y='(H-h)/2+${n(transform.offsetY)}':format=auto[${outputLabel}]`,
  ];
}

/** Base sampling interval for a keyframed clip's export slicing — see `computeKeyframeSlices`'s own
 *  doc comment for the full reasoning. ~4-5 frames at 30fps: each slice is a STATIC image held for its
 *  own duration, so the perceptible "step" between adjacent slices is the size of the VALUE jump, not
 *  the slice's own length — 150ms keeps that jump small for any reasonable keyframe-to-keyframe
 *  distance while keeping a typical 5-15s keyframed clip's slice count in the tens, not hundreds. */
const KEYFRAME_SLICE_SECONDS = 0.15;
/** Ceiling on how many slices ONE clip's own keyframed segment can produce — mirrors
 *  `MAX_TYPEWRITER_STEPS`'s own chosen ceiling (a magnitude already load-tested in this exact
 *  codebase), bounding worst-case filter-graph size for a pathological case (e.g. a keyframe pair
 *  spanning a 60+ second clip) at a KNOWN cost rather than an unbounded one. Unlike
 *  `buildTypewriterDrawTextCalls`, exceeding this does NOT drop the animation — see
 *  `computeKeyframeSlices`'s own comment on why silently discarding it would be a much worse
 *  regression here than in the typewriter case. */
const MAX_KEYFRAME_SLICES_PER_CLIP = 240;

/** Slices ONE keyframed clip's segment — spanning clip-window-relative time
 *  `[elapsedAtSegmentStart, elapsedAtSegmentStart + sliceDuration)` (the same "seconds since this
 *  clip's own timelineStart" space `Keyframe.time` itself uses) — into short STATIC sub-pieces, each
 *  sampled at its own midpoint via `resolveClipTransform`/`resolveClipEffects`. This is what lets a
 *  keyframed Transform/Effects animation (including scale/crop — real zoom/pan) render through the
 *  EXACT SAME `buildTransformFilters` every static clip already uses, unchanged, rather than needing
 *  FFmpeg to animate a filter's own output DIMENSIONS per-frame via an in-expression `t` — which isn't
 *  safely possible (confirmed by this file's own `rotate`'s `ow=`/`oh=` constraint: buffer-geometry
 *  parameters must stay fixed at graph-configure time, only per-pixel/per-sample math can vary with
 *  `t`).
 *
 *  Boundaries: every keyframe time strictly inside the segment, plus the segment's own two endpoints.
 *  Any gap between consecutive boundaries wider than `KEYFRAME_SLICE_SECONDS` is subdivided at fixed
 *  steps — interpolation is CONTINUOUS between keyframes, so even a long gap between two distant
 *  keyframes still needs intermediate sampling to read as motion, not a single static average. If the
 *  resulting count would exceed `MAX_KEYFRAME_SLICES_PER_CLIP`, the whole thing is recomputed with an
 *  ADAPTIVE, coarser interval (`sliceDuration / MAX_KEYFRAME_SLICES_PER_CLIP`) instead — a keyframed
 *  Ken-Burns pan on an ordinary long clip is the COMMON case here, not a rare edge, so silently
 *  dropping the whole animation (the way `buildTypewriterDrawTextCalls` does past ITS own cap) would
 *  be a far worse regression than slightly coarser (but still real) motion.
 *
 *  Every boundary is snapped to the frame grid, EXCEPT the first and last, which are pinned to the
 *  segment's own exact start/end — consecutive slice durations telescope to exactly `sliceDuration`
 *  regardless of how the interior boundaries snap, so no separate "fix up the last slice" step is
 *  needed. */
/** Shared boundary/snap/adaptive-recompute mechanics for BOTH video keyframe slicing
 *  (`computeKeyframeSlices`) and text keyframe slicing (`computeTextStyleKeyframeSlices`) — extracted
 *  so the two can't drift apart on the "how many slices, where do they land" question, even though
 *  what gets SAMPLED at each slice differs (three resolvers for video, one for text; see
 *  `computeTextStyleKeyframeSlices`'s own doc comment for why that stays a separate function rather
 *  than this one growing a generic resolver list). `keyframeTimes` is the flat, already-merged list of
 *  every keyframe time relevant to whichever caller is asking (video: transform+effects+colorGrading;
 *  text: textStyleKeyframes alone) — see `computeKeyframeSlices`'s own comment on why a HOLD-resolved
 *  field's keyframe times still need to be included here, not just interpolated ones. */
function computeSliceBoundaries(keyframeTimes: number[], elapsedAtSegmentStart: number, sliceDuration: number, fps: number): number[] {
  const segmentEnd = elapsedAtSegmentStart + sliceDuration;

  function boundariesAt(interval: number): number[] {
    const filteredTimes = keyframeTimes.filter((time) => time > elapsedAtSegmentStart + 1e-9 && time < segmentEnd - 1e-9);
    const sorted = [...new Set([elapsedAtSegmentStart, segmentEnd, ...filteredTimes])].sort((a, b) => a - b);

    const withSubdivisions: number[] = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const from = sorted[i - 1];
      const to = sorted[i];
      const steps = Math.max(1, Math.ceil((to - from) / interval));
      for (let s = 1; s < steps; s++) withSubdivisions.push(from + ((to - from) * s) / steps);
      withSubdivisions.push(to);
    }
    return withSubdivisions;
  }

  let boundaries = boundariesAt(KEYFRAME_SLICE_SECONDS);
  if (boundaries.length - 1 > MAX_KEYFRAME_SLICES_PER_CLIP) {
    boundaries = boundariesAt(sliceDuration / MAX_KEYFRAME_SLICES_PER_CLIP);
  }

  const snapped = boundaries.map((time) => snapToFrame(time, fps));
  snapped[0] = elapsedAtSegmentStart;
  snapped[snapped.length - 1] = segmentEnd;
  return snapped;
}

function computeKeyframeSlices(
  clip: Clip,
  elapsedAtSegmentStart: number,
  sliceDuration: number,
  fps: number
): { offset: number; duration: number; transform: ClipTransform; effects: ClipEffects; colorGrading: ColorGrading }[] {
  // `colorGradingKeyframes` is included here even though its own resolver HOLDS (never lerps) between
  // keyframes — a HOLD boundary is exactly where the visible value jumps discontinuously, so it needs
  // its own slice boundary the same way a transform/effects keyframe's interpolation midpoint does,
  // otherwise a single slice could straddle the jump and render the WRONG side of it for part of its
  // own duration.
  const keyframeTimes = [...(clip.transformKeyframes ?? []), ...(clip.effectsKeyframes ?? []), ...(clip.colorGradingKeyframes ?? [])].map(
    (k) => k.time
  );
  const snapped = computeSliceBoundaries(keyframeTimes, elapsedAtSegmentStart, sliceDuration, fps);

  const slices: { offset: number; duration: number; transform: ClipTransform; effects: ClipEffects; colorGrading: ColorGrading }[] = [];
  for (let i = 1; i < snapped.length; i++) {
    const offset = snapped[i - 1];
    const sliceLength = snapped[i] - offset;
    if (sliceLength <= 1e-9) continue; // two boundaries snapped onto the same frame — collapse, don't emit a zero-length slice
    const midpoint = offset + sliceLength / 2;
    slices.push({
      offset,
      duration: sliceLength,
      transform: resolveClipTransform(clip, midpoint),
      effects: resolveClipEffects(clip, midpoint),
      colorGrading: resolveClipColorGrading(clip, midpoint),
    });
  }
  return slices;
}

/** `computeKeyframeSlices`'s own counterpart for a text clip's `textStyleKeyframes` — a SEPARATE
 *  function, not a generalized/parameterized version of it, matching this file's existing pattern of
 *  parallel-but-distinct resolvers (`resolveClipTransform`/`resolveClipEffects`/`resolveClipColorGrading`/
 *  `resolveTextStyle` are four separate functions, not one generic one). Simpler than the video case in
 *  one respect: text clips are never run through `buildSegments`/transition-cutting the way video clips
 *  are (the text-track loop iterates `track.clips` directly), so `elapsedAtSegmentStart` is always `0`
 *  and `sliceDuration` is always the clip's own full `clipDuration()` — `slice.offset` is directly
 *  "seconds since `clip.timelineStart`," the same space `Keyframe.time`/`resolveTextStyle`'s own
 *  `elapsedSeconds` already use, with no segment-relative conversion needed anywhere downstream. */
function computeTextStyleKeyframeSlices(clip: Clip, baseStyle: TextStyle, fps: number): { offset: number; duration: number; style: TextStyle }[] {
  const sliceDuration = clipDuration(clip);
  const keyframeTimes = (clip.textStyleKeyframes ?? []).map((k) => k.time);
  const snapped = computeSliceBoundaries(keyframeTimes, 0, sliceDuration, fps);

  const slices: { offset: number; duration: number; style: TextStyle }[] = [];
  for (let i = 1; i < snapped.length; i++) {
    const offset = snapped[i - 1];
    const sliceLength = snapped[i] - offset;
    if (sliceLength <= 1e-9) continue;
    const midpoint = offset + sliceLength / 2;
    slices.push({ offset, duration: sliceLength, style: resolveTextStyle(clip, midpoint, baseStyle) });
  }
  return slices;
}

/** Windows paths carry a drive-letter colon and, in this repo, spaces (`.../App Development/...`) —
 *  both fatal to FFmpeg's OWN filter-graph string parser unless the whole value is wrapped in single
 *  quotes AND the colon is still separately backslash-escaped even inside them. Empirically verified
 *  against the real bundled binary (not from documentation alone — the colon-inside-quotes requirement
 *  in particular is not obvious and easy to get wrong) before being wired in here.
 *
 *  Backslashes (the path separator `path.join`/`path.resolve`/`os.tmpdir()` actually produce on
 *  Windows) get normalized to forward slashes FIRST, before the colon escape — a raw backslash is
 *  FFmpeg's OWN filtergraph escape character, so an un-normalized Windows path silently eats its own
 *  separators (confirmed live: `C:\Users\...\vstudio-text-xyz\clip.txt` arrived at FFmpeg as
 *  `C:Users...vstudio-text-xyzclip.txt`, "no such file"). Forward slashes work as path separators on
 *  Windows regardless of what produced the string, so this is a safe normalization either way. */
function ffmpegPath(absolutePath: string): string {
  return `'${absolutePath.replace(/\\/g, "/").replace(/:/g, "\\:")}'`;
}

/** "#rrggbb" → "0xrrggbb", FFmpeg's own hex color syntax; passes anything else (a named color, or an
 *  already-`0x`-prefixed value) through untouched. */
function ffmpegColor(hex: string): string {
  return hex.startsWith("#") ? `0x${hex.slice(1)}` : hex;
}

/** The `box=`/`bordercolor=`/`shadowcolor=` fragments — background box, stroke outline, and drop
 *  shadow — shared VERBATIM by both `drawtext` builders below, since all three are purely additive
 *  style knobs that don't interact with either builder's own positioning math. FFmpeg's `drawtext`
 *  composites these in a fixed order (shadow, then outline, then fill) regardless of the order their
 *  key=value pairs appear in the filter string — `PlaybackEngine.drawText` draws in that same order
 *  for the same visual result. */
function buildDrawTextStyleParams(style: TextStyle): string {
  const box = style.backgroundColor
    ? `:box=1:boxcolor=${ffmpegColor(style.backgroundColor)}:boxborderw=${TEXT_BOX_PADDING}`
    : "";
  const border = style.strokeColor ? `:bordercolor=${ffmpegColor(style.strokeColor)}:borderw=${n(style.strokeWidth)}` : "";
  const shadow = style.shadowColor
    ? `:shadowcolor=${ffmpegColor(style.shadowColor)}:shadowx=${n(style.shadowOffsetX)}:shadowy=${n(style.shadowOffsetY)}`
    : "";
  return `${box}${border}${shadow}`;
}

/** Computes the `alpha=` expression and (possibly fade-out-extended) enable-window end for one text
 *  clip's `drawtext` — shared by `buildDrawTextFilter` and `buildRotatedDrawTextFilter`. `fadeIn`/
 *  `fadeOut` are the transition durations at this clip's own head/tail (`fadeIn` from
 *  `findTransitionPartner` resolved against THIS clip; `fadeOut` from resolving it against whichever
 *  clip transitions FROM this one, computed once per track by the caller — see the main text-track
 *  loop's own `fadeOutByClipId` map) — `undefined`/`0` for a plain cut on that side, which is what
 *  every existing non-transitioning clip already has, so it gets byte-for-byte the same filter string
 *  as before this feature existed (no `alpha=` term at all).
 *
 *  Always a plain fade regardless of the clip's own `transitionIn.type` — unlike video's `xfade`,
 *  `drawtext` has no per-type geometry primitive to reach for (a wipe/slide/circle needs masking two
 *  SEPARATE rendered buffers, not a single call's own parameters), so every text transition TYPE
 *  renders as a dissolve in export specifically. The canvas preview's fuller wipe/slide/circle variety
 *  (see `PlaybackEngine.transitionFamily`) is preview-only for text — a deliberate, documented scope
 *  cut, not an oversight. */
function buildTextFadeParams(clip: Clip, fadeIn: number | undefined, fadeOut: number | undefined): { enableEnd: number; alphaParam: string } {
  const start = clip.timelineStart;
  const end = clipEnd(clip);
  const enableEnd = fadeOut ? end + fadeOut : end;

  const terms: string[] = [];
  if (fadeIn) terms.push(`(t-${t(start)})/${t(fadeIn)}`);
  if (fadeOut) terms.push(`(${t(enableEnd)}-t)/${t(fadeOut)}`);
  if (terms.length === 0) return { enableEnd, alphaParam: "" };

  // Nested `min(...)` (FFmpeg's `min`/`max` take exactly two args) clamped against 1 so a fade-in that
  // hasn't started yet — or a fade-out ramp evaluated before its own window — can't push alpha above
  // full opacity; each term individually already reaches exactly 1 at the instant its own ramp ends.
  const expr = terms.reduce((acc, term) => (acc ? `min(${acc}\\,${term})` : term), "");
  return { enableEnd, alphaParam: `:alpha='min(1\\,${expr})'` };
}

/** "#rrggbb" → ASS's own `&H00BBGGRR` color syntax (alpha byte first, then BLUE-GREEN-RED — the
 *  reverse channel order `ffmpegColor`'s plain `0xrrggbb` uses). NO trailing `&` here — a `Style:`
 *  line's color fields are plain comma-delimited values, and the trailing `&` some ASS documentation
 *  shows belongs only to the INLINE `{\c...&}` override tag's own closing delimiter, added explicitly
 *  at that one call site (`buildWordHighlightAss`'s per-word loop) instead of baked in here — empirically
 *  verified against the real bundled FFmpeg/libass to matter: an extra trailing `&` baked into EVERY use
 *  (including the `Style:` line) rendered without erroring, but doubled up into `&&` wherever the inline
 *  call site's own `&}` was then appended on top, an accidental-but-real malformed value this fixes. */
function assColor(hex: string): string {
  const r = hex.slice(1, 3);
  const g = hex.slice(3, 5);
  const b = hex.slice(5, 7);
  return `&H00${b}${g}${r}`;
}

/** Seconds → ASS's own `H:MM:SS.cc` (CENTIsecond, not millisecond) timestamp format. */
function assTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const totalCentiseconds = Math.round(clamped * 100);
  const cs = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/** `{` and `}` delimit ASS override blocks — literal typed text containing either would otherwise
 *  corrupt the `{\c...&}` color tags `buildWordHighlightAss` wraps every word in. ASS has no escape
 *  sequence for a literal brace inside a Dialogue `Text` field, so this strips them rather than risk a
 *  garbled render — a rare enough thing to type in a caption that silently dropping it is the more
 *  defensible failure mode of the two. */
function assEscapeRun(text: string): string {
  return text.replace(/[{}]/g, "");
}

/** Builds one complete `.ass` subtitle document implementing `wordHighlight` — see
 *  `buildWordHighlightSubtitlesFilter`'s own comment for WHY this exists as a wholly separate render
 *  path from every other text clip (`drawtext` fundamentally can't color individual words within one
 *  call). One `Style:` line carries the clip's font/size/color/outline; one `Dialogue:` EVENT per word
 *  covers the clip's ENTIRE text for that word's own active window (`activeWordIndex`'s timing, exactly
 *  matching the canvas preview) with an inline `{\c...&}` override wrapping just that word in
 *  `highlightColor` — everything else stays the Style's own `PrimaryColour`. This is deliberately NOT
 *  built from ASS `\k` karaoke tags: real `\k` karaoke is CUMULATIVE (each syllable, once reached, stays
 *  highlighted for the rest of the line) — a different visual effect from this app's own "exactly one
 *  word lit at a time" design (`PlaybackEngine.drawText`'s own word-highlight fill loop), which plain
 *  per-event color overrides reproduce exactly with no cross-event state needed.
 *
 *  `\pos(...)` + a numpad `Alignment` (4/5/6 — this app never docks text to a frame edge, always
 *  anchoring around `offsetX`/`offsetY` the same way `computeTextBlock` does) gives libass the exact
 *  same anchor point `buildDrawTextFilter`'s own `x`/`y` formulas resolve to, so a `wordHighlight` clip
 *  sits at the same place on screen a plain text clip with the same style would.
 *
 *  Deliberately scoped OUT for v1: `backgroundColor`/`shadowColor` (ASS's model has no independent
 *  shadow color distinct from its outline color, and no clean equivalent to this app's own background-
 *  box padding/border-radius story), and transition fades (no `alpha=`-style mechanism shared with
 *  `drawtext`'s own fade handling here) — a `wordHighlight` clip with either set still exports, just
 *  without that particular styling; documented, not silently almost-right. */
function buildWordHighlightAss(params: {
  content: string;
  style: TextStyle;
  clip: Clip;
  family: string;
  fontsizeScale: number;
  frameWidth: number;
  frameHeight: number;
  /** Same meaning as `buildDrawTextFilter`'s own `fadeIn`/`fadeOut` (seconds; `undefined`/`0` = a
   *  plain cut on that side) — see `buildTextFadeParams`'s own doc comment. Rendered here via
   *  libass's `\fad(t1,t2)` override tag rather than `drawtext`'s `alpha=` expression, since this
   *  path renders through `subtitles=`, not `drawtext` — see `buildWordHighlightSubtitlesFilter`'s
   *  own comment for why `wordHighlight` needs a wholly different filter to begin with. */
  fadeIn?: number;
  fadeOut?: number;
}): string | null {
  const { content, style, clip, family, fontsizeScale, frameWidth, frameHeight, fadeIn, fadeOut } = params;
  const words = splitWords(content);
  if (words.length === 0) return null;

  const start = clip.timelineStart;
  const end = clipEnd(clip);
  const duration = clipDuration(clip);
  if (duration <= 0) return null;

  const variant = resolveFontVariant(fontById(style.fontFamily), style.bold, style.italic);
  const fontsize = Math.max(1, Math.round(style.fontSize * fontsizeScale));
  const baseColor = assColor(style.color);
  const highlightColor = assColor(clip.textAnimation?.highlightColor ?? DEFAULT_WORD_HIGHLIGHT_COLOR);
  const alignment = style.align === "left" ? 4 : style.align === "right" ? 6 : 5;
  const outline = style.strokeColor ? 2 : 0;
  const outlineColor = style.strokeColor ? assColor(style.strokeColor) : "&H00000000";
  const anchorX =
    style.align === "left"
      ? TEXT_MARGIN_PX + style.offsetX
      : style.align === "right"
        ? frameWidth - TEXT_MARGIN_PX + style.offsetX
        : frameWidth / 2 + style.offsetX;
  const anchorY = frameHeight / 2 + style.offsetY;

  const lines = content.split("\n");
  const speed = clip.textAnimation?.speed ?? 1;
  const secondsPerWord = duration / words.length / speed;

  // Converted once, outside the loop — `\fad`'s own two args are milliseconds, unlike every other
  // time value in this function (which are libass `H:MM:SS.cc` timestamps via `assTimestamp`).
  const fadeInMs = fadeIn ? Math.round(fadeIn * 1000) : 0;
  const fadeOutMs = fadeOut ? Math.round(fadeOut * 1000) : 0;
  const fadeOutSeconds = fadeOut ?? 0;

  const events: string[] = [];
  for (let k = 0; k < words.length; k++) {
    const windowStart = start + k * secondsPerWord;
    const isLastWord = k === words.length - 1;
    // For a REAL crossfade (not just two independent fades that happen to meet at a hard cut), the
    // OUTGOING clip's own visible window has to genuinely OVERLAP the incoming clip's — otherwise this
    // clip finishes fading to invisible exactly AT its own nominal end, the instant the next clip's
    // fade-in begins, and there's never a moment both are simultaneously part-visible together. Mirrors
    // `buildTextFadeParams`'s own `enableEnd = fadeOut ? end + fadeOut : end` for the plain-drawtext
    // path exactly — the LAST event's own End extends `fadeOutMs` past the clip's nominal `end`, so
    // `\fad`'s fade-out ramp (which ends exactly AT this event's End) lands on the SAME instant the next
    // clip's own fade-in ramp finishes, not `fadeOut` seconds before it. The fade-IN side needs no
    // matching shift on `windowStart` — `buildTextFadeParams` doesn't shift its own `enableStart`
    // either; the incoming clip simply starts ramping at its normal `start`, and the OVERLAP is created
    // entirely by the outgoing clip reaching forward past its own boundary, not by the incoming one
    // reaching back before its own.
    const windowEnd = isLastWord ? end + fadeOutSeconds : start + (k + 1) * secondsPerWord;
    // `\fad(t1,t2)` fades relative to THIS EVENT's own Start/End, not the clip's — applying it to
    // every per-word event would fade each word in/out individually as the highlight moves along,
    // not fade the text BLOCK in once at the clip's head and out once at its tail. Only the FIRST
    // event (fade-in) and the LAST event (fade-out) get a nonzero term; a single-word clip is both at
    // once, correctly getting `\fad(fadeInMs,fadeOutMs)` on its one event.
    const isFirst = k === 0;
    const isLast = k === words.length - 1;
    const fadeTag = (isFirst && fadeInMs) || (isLast && fadeOutMs) ? `{\\fad(${isFirst ? fadeInMs : 0},${isLast ? fadeOutMs : 0})}` : "";

    const textParts: string[] = [];
    let wIndex = 0;
    for (const line of lines) {
      // `segmentLine` (not a plain `.split(/\s+/)`) is what makes this correct for Khmer and every
      // other script that doesn't space words at all — see its own comment in
      // `timeline/textAnimation.ts`. Walking EVERY segment (not just the word-like ones) and re-
      // emitting non-word text verbatim preserves the line's own original spacing/punctuation exactly,
      // rather than collapsing it down to single ASCII spaces the way `.join(" ")` used to.
      const rendered = segmentLine(line).map((segment) => {
        if (!segment.isWord) return assEscapeRun(segment.text);
        const isActive = wIndex === k;
        wIndex++;
        return `{\\c${isActive ? highlightColor : baseColor}&}${assEscapeRun(segment.text)}`;
      });
      textParts.push(rendered.join(""));
    }
    const text = fadeTag + `{\\pos(${n2(anchorX)}\\,${n2(anchorY)})}` + textParts.join("\\N");

    events.push(
      `Dialogue: 0,${assTimestamp(windowStart)},${assTimestamp(windowEnd)},Default,,0,0,0,,${text}`
    );
  }

  const header =
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${frameWidth}\nPlayResY: ${frameHeight}\nScaledBorderAndShadow: yes\n\n` +
    `[V4+ Styles]\n` +
    `Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    `Style: Default,${family},${fontsize},${baseColor},${baseColor},${outlineColor},&H00000000,${variant.bold ? -1 : 0},${variant.italic ? -1 : 0},0,0,100,100,0,0,1,${outline},0,${alignment},10,10,10,1\n\n` +
    `[Events]\n` +
    `Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

  return header + events.join("\n") + "\n";
}

/** Same rounding as `n()` below, but for a value going into an ASS override tag rather than an FFmpeg
 *  filter expression — kept as its own tiny function (not a shared export) since `n()` isn't declared
 *  until later in this file and ASS values don't need `n()`'s six-decimal precision (ASS positions are
 *  already sub-pixel-meaningless at one decimal place). */
function n2(value: number): string {
  return value.toFixed(2);
}

/** `wordHighlight`'s export path — routes through FFmpeg's `subtitles=` (libass) filter instead of
 *  `drawtext`, the one animation type that fundamentally can't be expressed as a single `drawtext` call
 *  no matter how the `x`/`y`/`fontsize` expressions are shaped. The core problem: coloring one WORD
 *  within a longer string needs either (a) knowing that word's exact pixel x-offset to draw it as a
 *  separate, precisely-positioned `drawtext` call, or (b) a renderer with native per-run color support.
 *  FFmpeg's expression language has no way to feed one `drawtext` call's measured `text_w` into ANOTHER
 *  call's `x=` expression — confirmed by re-deriving the filtergraph's actual data-flow model, not
 *  assumed — so (a) would require this module to compute glyph advance widths itself, which is exactly
 *  where it stops being safe: this app is Khmer-first, and Khmer's complex shaping (subscript
 *  consonants, vowel-sign reordering) is NOT correctly reproduced by summing simple per-character
 *  advance widths — only a real shaping engine (HarfBuzz) gets it right. libass already links HarfBuzz/
 *  FreeType/FriBidi (confirmed in the bundled FFmpeg build), so (b) reuses the SAME shaping engine
 *  `drawtext` itself uses, just accessed through the `subtitles=` filter instead, and it's correct for
 *  Khmer by construction rather than by additional effort.
 *
 *  Returns `null` (caller falls back to plain `drawtext`) when the font's metrics couldn't be resolved,
 *  or when `buildWordHighlightAss` itself returns `null` (empty content, non-positive duration) — both
 *  genuinely "nothing sensible to render here" cases, not errors. */
function buildWordHighlightSubtitlesFilter(params: {
  inputLabel: string;
  outputLabel: string;
  content: string;
  style: TextStyle;
  clip: Clip;
  frameWidth: number;
  frameHeight: number;
  assFilePathFor: (clip: Clip, assContent: string) => string;
  fontMetricsFor: (font: FontDefinition) => AssFontMetrics | null;
  fontsDirFor: () => string;
  /** Threaded straight through to `buildWordHighlightAss` — see its own doc comment. */
  fadeIn?: number;
  fadeOut?: number;
}): string[] | null {
  const { inputLabel, outputLabel, content, style, clip, frameWidth, frameHeight, assFilePathFor, fontMetricsFor, fontsDirFor, fadeIn, fadeOut } = params;
  const font = fontById(style.fontFamily);
  const metrics = fontMetricsFor(font);
  if (!metrics) return null;

  const assContent = buildWordHighlightAss({
    content,
    style,
    clip,
    family: metrics.family,
    fontsizeScale: metrics.fontsizeScale,
    frameWidth,
    frameHeight,
    fadeIn,
    fadeOut,
  });
  if (!assContent) return null;

  const assPath = ffmpegPath(assFilePathFor(clip, assContent));
  const fontsDir = ffmpegPath(fontsDirFor());
  return [`${inputLabel}subtitles=${assPath}:fontsdir=${fontsDir}[${outputLabel}]`];
}

/** How many chained `drawtext` calls `buildTypewriterDrawTextCalls` will build for one clip, at most —
 *  one call per character of `content`. An ordinary caption is nowhere near this long; a text clip that
 *  somehow is (a pasted paragraph) degrading to a plain, static, un-animated `drawtext` is a far better
 *  failure mode than a filter graph with thousands of chained nodes. Exported so `nativeExport.ts` can
 *  pre-write the exact same set of per-character text file variants this module will ask for — see its
 *  own `collectTextClips` comment on why that enumeration has to be duplicated rather than shared. */
export const MAX_TYPEWRITER_STEPS = 240;

/** One `drawtext=...` filter body (no `[input]`/`[output]` labels — callers wrap those) — the piece
 *  `buildDrawTextFilter`'s single call and `buildTypewriterDrawTextCalls`'s N chained calls both need,
 *  factored out so the two can never drift on the option list `drawtext` actually takes. */
function drawTextFilterBody(params: {
  fontFile: string;
  textFile: string;
  fontSizeExpr: string;
  color: string;
  styleParams: string;
  lineSpacing: string;
  x: string;
  y: string;
  alphaParam: string;
  enableStart: number;
  enableEnd: number;
}): string {
  const { fontFile, textFile, fontSizeExpr, color, styleParams, lineSpacing, x, y, alphaParam, enableStart, enableEnd } = params;
  return (
    `drawtext=fontfile=${fontFile}:textfile=${textFile}:fontsize=${fontSizeExpr}:` +
    `fontcolor=${color}${styleParams}:line_spacing=${lineSpacing}:x=${x}:y=${y}${alphaParam}:` +
    `enable='between(t\\,${t(enableStart)}\\,${t(enableEnd)})'`
  );
}

/** `typewriter`'s export equivalent of `typewriterVisibleContent` (`../timeline/textAnimation.ts`) —
 *  FFmpeg's `drawtext` has no notion of "reveal one more character every frame" within a single call,
 *  so this instead chains one `drawtext` per distinct visible-prefix state (`content.slice(0, k)` for
 *  `k` = 1..N), each gated to its own `enable=` window on the SAME clock `typewriterVisibleContent`
 *  uses (`TYPEWRITER_CHARS_PER_SECOND`, scaled by the clip's own animation `speed`) — the final, full-
 *  content call's window extends all the way to `enableEnd` so the clip settles on showing everything
 *  for its remaining duration, matching the preview's own clamp. Position/size never move (only the
 *  revealed prefix changes), so every step reuses the same `x`/`y`/`fontSizeExpr` the caller already
 *  resolved. Every step shares one `alphaParam` (built once, against the whole CLIP's fade window, not
 *  any one step's) since it's already a pure function of absolute `t` — correct regardless of which
 *  step happens to be the active one when a fade is in progress. */
function buildTypewriterDrawTextCalls(params: {
  inputLabel: string;
  outputLabel: string;
  content: string;
  fontFile: string;
  fontSizeExpr: string;
  color: string;
  styleParams: string;
  lineSpacing: string;
  x: string;
  y: string;
  clip: Clip;
  speed: number;
  alphaParam: string;
  enableEnd: number;
  textFilePathFor: ExportPlanOptions["textFilePathFor"];
}): string[] {
  const {
    inputLabel,
    outputLabel,
    content,
    fontFile,
    fontSizeExpr,
    color,
    styleParams,
    lineSpacing,
    x,
    y,
    clip,
    speed,
    alphaParam,
    enableEnd,
    textFilePathFor,
  } = params;
  const start = clip.timelineStart;
  const charDuration = 1 / (TYPEWRITER_CHARS_PER_SECOND * speed);
  const stepCount = content.length;

  const calls: string[] = [];
  let currentInput = inputLabel;
  for (let k = 1; k <= stepCount; k++) {
    const isLast = k === stepCount;
    const stepLabel = isLast ? outputLabel : `${outputLabel}_tw${k}`;
    const stepStart = start + (k - 1) * charDuration;
    const stepEnd = isLast ? enableEnd : start + k * charDuration;
    const textFile = ffmpegPath(textFilePathFor(clip, content.slice(0, k), `tw${k}`));
    const body = drawTextFilterBody({
      fontFile,
      textFile,
      fontSizeExpr,
      color,
      styleParams,
      lineSpacing,
      x,
      y,
      alphaParam,
      enableStart: stepStart,
      enableEnd: stepEnd,
    });
    calls.push(`${currentInput}${body}[${stepLabel}]`);
    currentInput = `[${stepLabel}]`;
  }
  return calls;
}

/** One text clip's `drawtext`, chained onto whatever the video layer built (`inputLabel`) — see
 *  `trackKindForAsset`'s own comment on why this, not a true overlay-based multi-layer composite, is
 *  what makes "text over video" tractable at all given a single-video-track export. `drawtext` draws
 *  directly onto its input stream, so stacking N of these in sequence (one per active text clip) is
 *  all "compositing" text over video actually requires here — no alpha blending step needed.
 *
 *  `enable='between(t,start,end)'` is what confines the text to its own clip's timeline window on the
 *  SAME absolute clock the concatenated `[cv]` stream already runs on (concat's own `setpts=PTS-
 *  STARTPTS` per segment is what keeps that clock starting at 0 and matching the sequence exactly).
 *
 *  Positioning mirrors `PlaybackEngine.drawText` exactly (same margin/anchor logic, see
 *  `textLayout.ts`'s own doc comment on the one approximation both renderers deliberately share for
 *  multi-line center/right alignment) — just expressed as an FFmpeg formula instead of a JS number,
 *  since `text_w`/`text_h` only exist once FreeType has actually shaped these exact glyphs.
 *
 *  `clip.textAnimation` (when set) adds a time-varying term on top of that same base formula — `bounce`
 *  into `y` (a `-abs(sin(...))` hop, identical shape to `computeTextAnimationTransform`'s own `dy`) and
 *  `pulse` into `fontsize` (a `sin(...)`-modulated scale) — both proven, against the real bundled FFmpeg
 *  binary, to re-center correctly on their own since `x`/`y` here are already `text_w`/`text_h`-relative
 *  expressions FFmpeg re-evaluates every frame (see this feature's own empirical notes). `typewriter`
 *  branches out entirely into `buildTypewriterDrawTextCalls` (a genuinely different shape — many calls,
 *  not one modified call). `wiggle` needs the ROTATED path instead (`buildRotatedDrawTextFilter`) since
 *  it animates rotation, not position/size — the caller picks between the two based on
 *  `style.rotationDeg`/`animation.type`, same as it already did for a plain static rotation. `bounce`/
 *  `pulse` combined with a nonzero STATIC `style.rotationDeg` is a deliberate, documented scope cut (see
 *  the caller): that combination renders as a plain static rotated clip, animation ignored — a real
 *  filter-graph limitation (this path's `text_w`-relative centering and the rotated path's frame-center
 *  pivot are mutually exclusive constructions), not an oversight. `wordHighlight` has no export
 *  equivalent at all (no per-word color/position within one `drawtext` call, and no way to learn a
 *  word's pixel offset server-side without a new font-metrics dependency) and always renders as plain
 *  static full-text, same as before this feature existed. */
/** The static font/position/style geometry `buildDrawTextFilter` needs — extracted so a keyframed
 *  clip's per-slice renderer (`buildKeyframedDrawTextCalls`) can call this once per slice with that
 *  slice's own `resolveTextStyle`-resolved `TextStyle`, instead of duplicating this math. Pure function
 *  of `style` alone — never touches `clip`/time, which is exactly why it's safe to call once per slice
 *  with a different `style` each time. */
function buildDrawTextGeometry(
  style: TextStyle,
  fontPathFor: ExportPlanOptions["fontPathFor"]
): { fontFile: string; x: string; y: string; fontSizeExpr: string; color: string; styleParams: string; lineSpacing: string } {
  const font = fontById(style.fontFamily);
  const fontFile = ffmpegPath(fontPathFor(fontFileFor(font, style.bold, style.italic)));

  const anchorX =
    style.align === "left"
      ? `${TEXT_MARGIN_PX}+${n(style.offsetX)}`
      : style.align === "right"
        ? `(w-${TEXT_MARGIN_PX})+${n(style.offsetX)}`
        : `(w/2)+${n(style.offsetX)}`;
  const x = style.align === "left" ? anchorX : style.align === "right" ? `(${anchorX})-text_w` : `(${anchorX})-text_w/2`;
  const y = `(h/2)+${n(style.offsetY)}-text_h/2`;

  const styleParams = buildDrawTextStyleParams(style);
  // FFmpeg's `line_spacing` is EXTRA pixels added between lines on top of the font's own natural line
  // height, unlike the multiplier `style.lineHeightMultiplier` applies wholesale in the canvas preview
  // — this converts one convention to the other; see `textLayout.ts` for why exact agreement isn't the
  // bar for text the way it is for video.
  const lineSpacing = n(style.fontSize * (style.lineHeightMultiplier - 1));
  const color = ffmpegColor(style.color);
  const fontSizeExpr = n(style.fontSize);

  return { fontFile, x, y, fontSizeExpr, color, styleParams, lineSpacing };
}

/** Folds `bounce`/`pulse` onto an already-built `y`/`fontSizeExpr` pair — extracted so
 *  `buildKeyframedDrawTextCalls` can apply the SAME animation formula once per slice. Depends only on
 *  `clip.textAnimation`/`clip.timelineStart` (never on `style`), which is exactly why this composes for
 *  free with per-slice re-rendering: every animation term here is anchored to absolute timeline
 *  seconds, not to a per-call local clock, so calling this once per slice — each slice just gating WHEN
 *  its own copy of the always-correctly-phased expression is visible — produces continuous,
 *  uninterrupted motion across slice boundaries with zero change to the formula itself. */
function applyTextMotionAnimation(clip: Clip, y: string, fontSizeExpr: string): { y: string; fontSizeExpr: string } {
  const animation = clip.textAnimation;
  const speed = animation?.speed ?? 1;
  const start = clip.timelineStart;
  if (animation?.type === "bounce") {
    const dyExpr = `-abs(sin(2*PI*((t-${t(start)})*${n(speed)})/${n(BOUNCE_PERIOD_SECONDS)}))*${n(BOUNCE_AMPLITUDE_PX)}`;
    return { y: `${y}${dyExpr}`, fontSizeExpr };
  }
  if (animation?.type === "pulse") {
    const scaleExpr = `(1+sin(2*PI*((t-${t(start)})*${n(speed)})/${n(PULSE_PERIOD_SECONDS)})*${n(PULSE_AMPLITUDE)})`;
    return { y, fontSizeExpr: `'${fontSizeExpr}*${scaleExpr}'` };
  }
  return { y, fontSizeExpr };
}

function buildDrawTextFilter(params: {
  inputLabel: string;
  outputLabel: string;
  content: string;
  style: TextStyle;
  clip: Clip;
  fontPathFor: ExportPlanOptions["fontPathFor"];
  textFilePathFor: ExportPlanOptions["textFilePathFor"];
  fadeIn?: number;
  fadeOut?: number;
}): string[] {
  const { inputLabel, outputLabel, content, style, clip, fontPathFor, textFilePathFor, fadeIn, fadeOut } = params;
  const geo = buildDrawTextGeometry(style, fontPathFor);
  const { enableEnd, alphaParam } = buildTextFadeParams(clip, fadeIn, fadeOut);
  const start = clip.timelineStart;
  const animation = clip.textAnimation;
  const speed = animation?.speed ?? 1;

  if (animation?.type === "typewriter" && content.length > 0 && content.length <= MAX_TYPEWRITER_STEPS) {
    return buildTypewriterDrawTextCalls({
      inputLabel,
      outputLabel,
      content,
      fontFile: geo.fontFile,
      fontSizeExpr: geo.fontSizeExpr,
      color: geo.color,
      styleParams: geo.styleParams,
      lineSpacing: geo.lineSpacing,
      x: geo.x,
      y: geo.y,
      clip,
      speed,
      alphaParam,
      enableEnd,
      textFilePathFor,
    });
  }

  const { y: yExpr, fontSizeExpr } = applyTextMotionAnimation(clip, geo.y, geo.fontSizeExpr);

  const textFile = ffmpegPath(textFilePathFor(clip, content));
  const body = drawTextFilterBody({
    fontFile: geo.fontFile,
    textFile,
    fontSizeExpr,
    color: geo.color,
    styleParams: geo.styleParams,
    lineSpacing: geo.lineSpacing,
    x: geo.x,
    y: yExpr,
    alphaParam,
    enableStart: start,
    enableEnd,
  });
  return [`${inputLabel}${body}[${outputLabel}]`];
}

/** Text clips whose `textStyleKeyframes` is armed slice into short static per-slice renders — same
 *  "many cheap static frames instead of one continuously-varying expression" strategy video's own
 *  Transform/Effects/ColorGrading keyframes already use, but shaped like `buildTypewriterDrawTextCalls`
 *  above (N chained `drawtext` calls onto the already-continuous stream, no `concat=`, no extra source
 *  inputs) rather than video's own `concat=`-based slicing — text has no source media to re-cut, so
 *  there's no independent PTS clock per slice to stitch back together the way video's slicing needs to.
 *  One shared `alphaParam`/`enableEnd` (computed once, exactly like `buildTypewriterDrawTextCalls`'s own
 *  `alphaParam` — see its doc comment) is reused verbatim by every slice; only each slice's own
 *  `enable` WINDOW and `resolveTextStyle`-resolved geometry differ. `content`/`textFile` never vary
 *  with `textStyleKeyframes` (only style/position do), so `textFilePathFor` is called exactly ONCE for
 *  the whole clip — the same `(clip, content)` key every plain (non-typewriter, non-keyframed) clip
 *  already uses, which is load-bearing: `nativeExport.ts`'s `collectTextClips` only pre-writes THAT
 *  variant for a keyframed clip (it only special-cases `typewriter`), so calling this with any other
 *  key would throw on native export. */
function buildKeyframedDrawTextCalls(params: {
  inputLabel: string;
  outputLabel: string;
  content: string;
  baseStyle: TextStyle;
  clip: Clip;
  fontPathFor: ExportPlanOptions["fontPathFor"];
  textFilePathFor: ExportPlanOptions["textFilePathFor"];
  fadeIn?: number;
  fadeOut?: number;
  fps: number;
}): string[] {
  const { inputLabel, outputLabel, content, baseStyle, clip, fontPathFor, textFilePathFor, fadeIn, fadeOut, fps } = params;
  const { enableEnd, alphaParam } = buildTextFadeParams(clip, fadeIn, fadeOut);
  const textFile = ffmpegPath(textFilePathFor(clip, content));
  const slices = computeTextStyleKeyframeSlices(clip, baseStyle, fps);

  const calls: string[] = [];
  let currentInput = inputLabel;
  slices.forEach((slice, i) => {
    const isLast = i === slices.length - 1;
    const stepLabel = isLast ? outputLabel : `${outputLabel}_kf${i}`;
    const geo = buildDrawTextGeometry(slice.style, fontPathFor);
    const { y, fontSizeExpr } = applyTextMotionAnimation(clip, geo.y, geo.fontSizeExpr);
    // Last slice's own window extends to the real fade-adjusted `enableEnd` (not clipped to its own
    // nominal boundary) — matches how the un-sliced path's one-and-only call already extends past the
    // clip's nominal end for a fade-out, and how `buildTypewriterDrawTextCalls`'s own last step does
    // the same for its own last character.
    const body = drawTextFilterBody({
      fontFile: geo.fontFile,
      textFile,
      fontSizeExpr,
      color: geo.color,
      styleParams: geo.styleParams,
      lineSpacing: geo.lineSpacing,
      x: geo.x,
      y,
      alphaParam,
      enableStart: clip.timelineStart + slice.offset,
      enableEnd: isLast ? enableEnd : clip.timelineStart + slice.offset + slice.duration,
    });
    calls.push(`${currentInput}${body}[${stepLabel}]`);
    currentInput = `[${stepLabel}]`;
  });
  return calls;
}

/** The rotated-text equivalent of `buildDrawTextFilter` above, used only when `style.rotationDeg` is
 *  nonzero (see `isIdentityTransform`'s sibling reasoning: the plain, already-tested `drawtext`-onto-
 *  `[cv]` chain handles the unrotated case and stays untouched by this).
 *
 *  FFmpeg's `rotate` filter can only spin a buffer around ITS OWN geometric center — there's no
 *  parameter for an arbitrary pivot, and (the actual constraint that shapes everything below) no
 *  sibling filter can see `text_w`/`text_h` — those only exist inside the ONE `drawtext` call that
 *  computed them from the actual shaped glyphs. So the text's true visual center for `align: "left"`/
 *  `"right"` is fundamentally unknowable outside that one filter, and the pivot this uses is the
 *  SEQUENCE FRAME's own center instead — see `PlaybackEngine.drawText`'s matching comment for why that
 *  (not the text's own center) is the one pivot both renderers can compute identically. For
 *  `align: "center"` (the default) the two coincide exactly, so nothing is actually approximated there.
 *
 *  The construction:
 *   1. Draw the text at its NATURAL align-anchored position (same `x`/`y` formula `buildDrawTextFilter`
 *      uses, just with `offsetX`/`offsetY` left OUT) within a background buffer the size of the whole
 *      sequence frame — so the buffer's own center is the FRAME's center, not the text's.
 *   2. `rotate` that whole buffer around ITS OWN (= the frame's) center. `ow=rotw(a):oh=roth(a)` has
 *      FFmpeg itself compute the exact bounding box a WxH buffer needs once rotated by angle `a` — the
 *      same macro `buildTransformFilters` already relies on for clip rotation.
 *   3. `overlay` the rotated buffer onto the video built so far, offset by `offsetX/offsetY` — applying
 *      the offset AFTER rotation, never before (baking it into step 1's position instead would rotate
 *      the text around a point that itself moves with the offset, making it orbit rather than spin in
 *      place — see `PlaybackEngine.drawText` for the identical two-stage `translate`+`rotate`+
 *      `translate` this mirrors).
 *
 *  `format=rgba` before `rotate` is what makes its `black@0` fill genuinely transparent padding — same
 *  reasoning as `buildTransformFilters`'s identical comment. The background buffer spans the FULL
 *  sequence duration (not just the clip's own) so its PTS stays trivially aligned with `[cv]`'s from
 *  frame 0 with no explicit sync step needed; `enable=` on both `drawtext` and the final `overlay`
 *  confines the actual visible window to the clip's own, same as the unrotated path. Empirically
 *  verified against the real bundled FFmpeg binary before being wired in here (see this feature's own
 *  development notes).
 *
 *  `clip.textAnimation?.type === "wiggle"` layers a time-varying term onto `style.rotationDeg` in the
 *  `a=` (angle) expression — the same `sin(...)` shape `computeTextAnimationTransform`'s own
 *  `rotationDeg` uses. `rotate`'s `ow=`/`oh=` (the buffer FFmpeg allocates to hold the rotated result)
 *  are evaluated ONCE at filter-graph configuration time, before `t` exists, so they can never
 *  themselves reference `t` (confirmed empirically: a `t`-dependent `oh=roth(...)` fails outright with
 *  "non-positive or indefinite value nan") — `maxAngleExpr` sizes that buffer for the worst case
 *  (`|style.rotationDeg| + WIGGLE_AMPLITUDE_DEG`) instead, a fixed constant, while only `a=` itself
 *  varies with time. For every clip that ISN'T wiggling, `maxAngleExpr` reduces to the same fixed value
 *  `a=` already uses, so a plain static rotation renders byte-identically to before this animation
 *  branch existed. */
/** The rotated-path's own static geometry — `buildRotatedDrawTextGeometry`'s counterpart to
 *  `buildDrawTextGeometry` above, extracted for the identical reason (per-slice reuse from
 *  `buildKeyframedRotatedDrawTextCalls`). Pure function of `style` alone. */
function buildRotatedDrawTextGeometry(
  style: TextStyle,
  fontPathFor: ExportPlanOptions["fontPathFor"]
): { fontFile: string; x: string; y: string; color: string; styleParams: string; lineSpacing: string } {
  const font = fontById(style.fontFamily);
  const fontFile = ffmpegPath(fontPathFor(fontFileFor(font, style.bold, style.italic)));

  // Centered within the background buffer's OWN w/h (== the full sequence frame), not the final
  // on-screen position — offset is applied later, at the overlay step, after rotation.
  const anchorX = style.align === "left" ? `${TEXT_MARGIN_PX}` : style.align === "right" ? `(w-${TEXT_MARGIN_PX})` : `(w/2)`;
  const x = style.align === "left" ? anchorX : style.align === "right" ? `(${anchorX})-text_w` : `(${anchorX})-text_w/2`;
  const y = `(h/2)-text_h/2`;

  const styleParams = buildDrawTextStyleParams(style);
  const lineSpacing = n(style.fontSize * (style.lineHeightMultiplier - 1));
  const color = ffmpegColor(style.color);

  return { fontFile, x, y, color, styleParams, lineSpacing };
}

/** `angle`/`maxAngle` for the rotated path's `rotate=` filter — extracted so
 *  `buildKeyframedRotatedDrawTextCalls` can call this once per slice with that slice's own
 *  `rotationDeg` (a real possibility: `rotationDeg` is one of `lerpTextStyle`'s interpolated numeric
 *  fields, so it can legitimately differ from slice to slice for a keyframed clip). Depends on
 *  `clip.textAnimation`/`clip.timelineStart` for the wiggle term (absolute-timeline-anchored, same
 *  "composes for free per-slice" reasoning as `applyTextMotionAnimation`) and on `style.rotationDeg`
 *  for the static base angle. */
function computeWiggleRotationAngle(clip: Clip, style: TextStyle): { angle: string; maxAngle: string } {
  const animation = clip.textAnimation;
  const isWiggle = animation?.type === "wiggle";
  const speed = animation?.speed ?? 1;
  const staticDeg = n(style.rotationDeg);
  const angle = isWiggle
    ? `(${staticDeg}+sin(2*PI*((t-${t(clip.timelineStart)})*${n(speed)})/${n(WIGGLE_PERIOD_SECONDS)})*${n(WIGGLE_AMPLITUDE_DEG)})*PI/180`
    : `${staticDeg}*PI/180`;
  const maxAngleDeg = Math.abs(style.rotationDeg) + (isWiggle ? WIGGLE_AMPLITUDE_DEG : 0);
  const maxAngle = `${n(maxAngleDeg)}*PI/180`;
  return { angle, maxAngle };
}

function buildRotatedDrawTextFilter(params: {
  inputLabel: string;
  bgIndex: number;
  outputLabel: string;
  content: string;
  style: TextStyle;
  clip: Clip;
  fontPathFor: ExportPlanOptions["fontPathFor"];
  textFilePathFor: ExportPlanOptions["textFilePathFor"];
  fadeIn?: number;
  fadeOut?: number;
}): string[] {
  const { inputLabel, bgIndex, outputLabel, content, style, clip, fontPathFor, textFilePathFor, fadeIn, fadeOut } = params;
  const geo = buildRotatedDrawTextGeometry(style, fontPathFor);
  const textFile = ffmpegPath(textFilePathFor(clip, content));

  // Same fade/extended-window logic `buildDrawTextFilter` uses — see `buildTextFadeParams`'s own
  // comment. The extended `enable` window applies to BOTH steps below (the `drawtext` and the final
  // `overlay`): the alpha ramp itself only needs to apply to the `drawtext` call (rotate/overlay both
  // just carry the alpha CHANNEL it already wrote through unchanged), but the overlay's own `enable`
  // still has to stay in sync or it would cut the fade off early.
  const { enableEnd, alphaParam } = buildTextFadeParams(clip, fadeIn, fadeOut);
  const enable = `enable='between(t\\,${t(clip.timelineStart)}\\,${t(enableEnd)})'`;

  const { angle, maxAngle } = computeWiggleRotationAngle(clip, style);

  const drawnLabel = `${outputLabel}_drawn`;
  const rotLabel = `${outputLabel}_rot`;

  return [
    `[${bgIndex}:v]drawtext=fontfile=${geo.fontFile}:textfile=${textFile}:fontsize=${n(style.fontSize)}:` +
      `fontcolor=${geo.color}${geo.styleParams}:line_spacing=${geo.lineSpacing}:x=${geo.x}:y=${geo.y}${alphaParam}:${enable}[${drawnLabel}]`,
    `[${drawnLabel}]format=rgba,rotate=a=${angle}:ow=rotw(${maxAngle}):oh=roth(${maxAngle}):c=black@0[${rotLabel}]`,
    `${inputLabel}[${rotLabel}]overlay=x='(W-w)/2+${n(style.offsetX)}':y='(H-h)/2+${n(style.offsetY)}':` +
      `format=auto:${enable}[${outputLabel}]`,
  ];
}

/** `buildKeyframedDrawTextCalls`'s own counterpart for the rotated path — one chained `drawtext`→
 *  `rotate`→`overlay` triple per slice, all sharing the SAME already-pushed `bgIndex` background input
 *  (FFmpeg allows one numbered input to be referenced by multiple filter chains without an explicit
 *  `split`), each slice's own triple gated by its own `enable` window and using that slice's own
 *  `resolveTextStyle`-resolved geometry/rotation angle. The final slice's own `overlay` output IS
 *  `outputLabel` — same chaining shape `buildKeyframedDrawTextCalls` uses. */
function buildKeyframedRotatedDrawTextCalls(params: {
  inputLabel: string;
  bgIndex: number;
  outputLabel: string;
  content: string;
  baseStyle: TextStyle;
  clip: Clip;
  fontPathFor: ExportPlanOptions["fontPathFor"];
  textFilePathFor: ExportPlanOptions["textFilePathFor"];
  fadeIn?: number;
  fadeOut?: number;
  fps: number;
}): string[] {
  const { inputLabel, bgIndex, outputLabel, content, baseStyle, clip, fontPathFor, textFilePathFor, fadeIn, fadeOut, fps } = params;
  const textFile = ffmpegPath(textFilePathFor(clip, content));
  const { enableEnd, alphaParam } = buildTextFadeParams(clip, fadeIn, fadeOut);
  const slices = computeTextStyleKeyframeSlices(clip, baseStyle, fps);

  const filters: string[] = [];
  let currentInput = inputLabel;
  slices.forEach((slice, i) => {
    const isLast = i === slices.length - 1;
    const stepOutputLabel = isLast ? outputLabel : `${outputLabel}_kf${i}`;
    const sliceStart = clip.timelineStart + slice.offset;
    const sliceEnd = isLast ? enableEnd : clip.timelineStart + slice.offset + slice.duration;
    const enable = `enable='between(t\\,${t(sliceStart)}\\,${t(sliceEnd)})'`;

    const geo = buildRotatedDrawTextGeometry(slice.style, fontPathFor);
    const { angle, maxAngle } = computeWiggleRotationAngle(clip, slice.style);

    const drawnLabel = `${outputLabel}_kf${i}_drawn`;
    const rotLabel = `${outputLabel}_kf${i}_rot`;

    filters.push(
      `[${bgIndex}:v]drawtext=fontfile=${geo.fontFile}:textfile=${textFile}:fontsize=${n(slice.style.fontSize)}:` +
        `fontcolor=${geo.color}${geo.styleParams}:line_spacing=${geo.lineSpacing}:x=${geo.x}:y=${geo.y}${alphaParam}:${enable}[${drawnLabel}]`
    );
    filters.push(`[${drawnLabel}]format=rgba,rotate=a=${angle}:ow=rotw(${maxAngle}):oh=roth(${maxAngle}):c=black@0[${rotLabel}]`);
    filters.push(
      `${currentInput}[${rotLabel}]overlay=x='(W-w)/2+${n(slice.style.offsetX)}':y='(H-h)/2+${n(slice.style.offsetY)}':` +
        `format=auto:${enable}[${stepOutputLabel}]`
    );
    currentInput = `[${stepOutputLabel}]`;
  });
  return filters;
}

export function buildExportPlan(project: Project, options: ExportPlanOptions): ExportPlan {
  const { fps, crf, audioBitrateKbps } = project.exportSettings;
  // Every position/crop/offset in this whole file (`TEXT_MARGIN_PX`, `TextCrop` fractions, `ClipTransform`
  // pixel offsets, drawtext `x=`/`y=`, wordHighlight's ASS geometry, transition wipe/slide/circle
  // directions — all of it) is authored by a user looking at `PlaybackEngine`'s OWN canvas, which is
  // always sized `project.sequence.width/height` — never `exportSettings`'s own, independently-editable
  // width/height (see `ExportDialog`'s resolution dropdown). Building this file's internal canvas at
  // `exportSettings`'s size instead — the ORIGINAL behavior here — silently broke WYSIWYG the moment
  // those two ever diverged: a raw pixel offset authored against a 1080-wide preview lands at a
  // DIFFERENT proportional position once the internal canvas is actually, say, 720 wide, since nothing
  // scales it. Confirmed live: the exact same `offsetX: 100` text landed at 13.6% from the left edge at
  // matched 1080×1920, but 20.4% at a mismatched (same-aspect, just smaller) 720×1280 export — a real,
  // measurable, silent position shift with zero code error, exactly the shape of "text lands in the
  // wrong place after export" bug reports.
  //
  // The fix: build EVERY internal filter using the SEQUENCE's own width/height (`width`/`height` below)
  // — byte-for-byte the same canvas preview renders against, so nothing here needs to know
  // `exportSettings` exists at all — then, once the whole graph (video + every overlay track + every
  // text clip) is fully composited, conform the FINAL result to whatever OUTPUT size was actually
  // requested (`outputWidth`/`outputHeight`, still `exportSettings`'s own) in ONE closing scale/pad
  // stage, mirroring `pushClipVideoFilters`'s own opaque `scale=...force_original_aspect_ratio=decrease,
  // pad=...` pattern exactly. This keeps "export at a smaller/larger/different-aspect resolution than
  // you designed at" working (a legitimate, common request — smaller files, a different platform's
  // aspect ratio) while fixing the actual bug: every POSITION is now computed once, correctly, against
  // the canvas it was authored on, and only pure, uniform, distortion-free scaling happens afterward.
  const { width, height } = project.sequence;
  const outputWidth = project.exportSettings.width;
  const outputHeight = project.exportSettings.height;
  const duration = sequenceDuration(project);
  if (duration <= 0) throw new ExportError("There is nothing on the timeline to export");

  // Every visible video track with clips composites, in array order — later tracks drawn ON TOP of
  // earlier ones, the identical rule `PlaybackEngine.drawVideoLayer` uses for the canvas preview (see
  // its own comment for why that side needs no equivalent transparency plumbing: `drawImage` only
  // ever touches its own destination rect, so a gap there naturally shows whatever's underneath for
  // free). FFmpeg has no such "just don't touch those pixels" primitive, so this function has to
  // build that transparency explicitly — see `transparent` below.
  const videoTracks = project.sequence.tracks.filter(
    (track) => track.kind === "video" && track.visible && track.clips.length > 0
  );
  if (videoTracks.length === 0) throw new ExportError("There is no visible video track with clips to export");

  const inputs: string[] = [];
  const filters: string[] = [];
  let inputIndex = 0;

  // Pushes one source's own video filter chain — the plain scale+pad path for an untouched clip, or
  // the full crop/eq/scale/blur/rotate/opacity chain for a real transform/effects — shared by a
  // normal "clip" segment AND each half of a "transition" segment's crossfade below, so a
  // transitioning clip's own transform/effects still apply to its share of the blend exactly like
  // they would to a plain cut, not just the two branches independently reimplementing the same logic.
  //
  // `transparent` is true for every track EXCEPT the bottom (base) one — false there keeps the
  // single-track case byte-for-byte identical to before multi-track compositing existed (an opaque
  // `pad=`/background, exactly as today). true swaps in `format=rgba` + a `black@0` fill so a clip's
  // own letterbox bars (or a real transform's rotation-corner/opacity blend) stay genuinely
  // transparent instead of being irreversibly pre-blended against black here — letting whatever's on
  // the track(s) below show through once this track's own stream is later composited over them.
  // `fadeIn`/`fadeOut` are only ever set for a SOLO transition (`Segment["clip"]["fadeIn"]`/
  // `["fadeOut"]`'s own doc comments) — when either is present, the normal chain below is built into
  // an intermediate `_prefade` label instead of `outputLabel` directly, then one or two more `fade`
  // stages (chained — FFmpeg's `fade` filter composes fine applied twice, once `t=in` once `t=out`)
  // bridge it to the real output. `alpha=1` (fade the ALPHA channel toward/from transparent) on a
  // `transparent` track matches `PlaybackEngine`'s own preview behavior there (revealing whatever's
  // on a lower track, since an overlay track's gaps are already transparent) — the plain color fade
  // (default black) on the base track matches its own preview behavior (fading in/out against the
  // opaque black `drawFrame` clears to).
  function pushClipVideoFilters(
    clip: Clip,
    videoIndex: number,
    outputLabel: string,
    sliceDuration: number,
    transparent: boolean,
    fadeIn?: number,
    fadeOut?: number
  ): void {
    const label = fadeIn || fadeOut ? `${outputLabel}_prefade` : outputLabel;
    const transform = clip.transform;
    const effects = clip.effects;
    // A chroma key or non-identity color grading forces the "real" (overlay-composited, alpha-carrying)
    // path below even with an otherwise-identity transform/effects — the plain scale+pad path has no
    // background/overlay machinery for a keyed-out region to show through, and no `curves=` stage,
    // only `buildTransformFilters`'s own does.
    const isPlain =
      (!transform || isIdentityTransform(transform)) &&
      (!effects || isIdentityEffects(effects)) &&
      !clip.chromaKey &&
      (!clip.colorGrading || isIdentityColorGrading(clip.colorGrading));

    if (isPlain) {
      filters.push(
        transparent
          ? `[${videoIndex}:v]format=rgba,scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
              `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1,fps=${fps},setpts=PTS-STARTPTS[${label}]`
          : `[${videoIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
              `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},setpts=PTS-STARTPTS[${label}]`
      );
    } else {
      const bgIndex = inputIndex++;
      const bgColor = transparent ? "black@0" : "black";
      // `,format=rgba` when `transparent`: FFmpeg's `color` lavfi source emits `yuv420p` (no alpha
      // channel) by default regardless of the `@0` alpha spec in the color string — `black@0`'s own
      // transparency is silently discarded at the SOURCE unless the source itself is told to carry
      // alpha. See the rotated-text background input below (this module's other `color=c=...@0` lavfi
      // source) for the full empirical confirmation of this FFmpeg behavior.
      inputs.push(
        "-f",
        "lavfi",
        "-t",
        t(sliceDuration),
        "-i",
        `color=c=${bgColor}:s=${width}x${height}:r=${fps}${transparent ? ",format=rgba" : ""}`
      );
      filters.push(
        ...buildTransformFilters({
          source: `${videoIndex}:v`,
          bg: `${bgIndex}:v`,
          outputLabel: label,
          transform: transform ?? IDENTITY_TRANSFORM,
          effects: effects ?? IDENTITY_EFFECTS,
          width,
          height,
          fps,
          chromaKey: clip.chromaKey,
          colorGrading: clip.colorGrading,
        })
      );
    }

    if (fadeIn || fadeOut) {
      const alphaParam = transparent ? ":alpha=1" : "";
      const stages: string[] = [];
      if (fadeIn) stages.push(`fade=t=in:st=0:d=${t(fadeIn)}${alphaParam}`);
      if (fadeOut) stages.push(`fade=t=out:st=${t(sliceDuration - fadeOut)}:d=${t(fadeOut)}${alphaParam}`);
      filters.push(`[${label}]${stages.join(",")}[${outputLabel}]`);
    }
  }

  /** `pushClipVideoFilters`'s own counterpart for a clip whose Transform and/or Effects are keyframed
   *  — see `computeKeyframeSlices`'s own doc comment for why segment-slicing (not a live FFmpeg
   *  expression) is what makes this work. Slices the segment via `computeKeyframeSlices`, opens the
   *  real source and the background color source EACH EXACTLY ONCE for the WHOLE segment (not once per
   *  slice — see below for why that matters), `split=`s each into one copy per slice, `trim=`s each
   *  copy down to that slice's own sub-range, and feeds the result through the EXISTING, unmodified
   *  `buildTransformFilters` per slice exactly like a static clip would be — this function adds no new
   *  geometry/effects logic of its own. The slices concatenate back into ONE output label with the
   *  video-only mirror of this file's own audio-track concat (`concat=n=...:v=0:a=1` — see
   *  `buildAudioTrackStream`) — `v=1:a=0` here, since this concat is video-only; `buildTrackStreams`'s
   *  own OUTER per-segment concat (`v=1:a=1`) is a separate, unrelated concat one level up. fadeIn/
   *  fadeOut wrap the CONCATENATED result exactly like `pushClipVideoFilters` wraps its own single
   *  chain — a fade spans the whole segment, not any one slice.
   *
   *  The one-input-per-SEGMENT (not per-slice) design is load-bearing, not a micro-optimization: a
   *  long, richly keyframed clip can produce up to `MAX_KEYFRAME_SLICES_PER_CLIP` slices, and the
   *  earlier one-input-PER-SLICE version of this function pushed a fresh `-i <sourcePath>` (plus a
   *  fresh `-f lavfi -i color=...`) for every single one — confirmed live, on a real 205-second clip
   *  with keyframes spanning nearly its whole duration, this produced 487 separate `-i` arguments,
   *  ~240 of them repeating the same 145-character absolute source path, and Windows' `CreateProcess`
   *  command-line limit (~32,767 characters) threw `spawn ENAMETOOLONG` — synchronously, before FFmpeg
   *  ever ran. `split=`/`trim=` replace N real re-seeks-and-reopens with one real file open and cheap
   *  in-graph fan-out/slicing, making the input count constant regardless of slice count. */
  function pushKeyframedClipVideoFilters(
    clip: Clip,
    path: string,
    isImage: boolean,
    elapsedAtSegmentStart: number,
    outputLabel: string,
    sliceDuration: number,
    transparent: boolean,
    fadeIn?: number,
    fadeOut?: number
  ): void {
    const label = fadeIn || fadeOut ? `${outputLabel}_prefade` : outputLabel;
    const slices = computeKeyframeSlices(clip, elapsedAtSegmentStart, sliceDuration, fps);
    const bgColor = transparent ? "black@0" : "black";

    // ONE source input for the whole segment — mirrors `pushClipVideoFilters`'s own convention exactly
    // (same `-ss`/seek formula it already uses at its own call site), instead of one per slice.
    const sourceIndex = inputIndex++;
    if (isImage) {
      inputs.push("-loop", "1", "-framerate", String(fps), "-t", t(sliceDuration), "-i", path);
    } else {
      inputs.push("-ss", t(clip.sourceIn + elapsedAtSegmentStart), "-t", t(sliceDuration), "-i", path);
    }
    // ONE background color input for the whole segment too — this was ALSO duplicated per slice
    // before, an independent contributor to the same command-line-length problem.
    const bgIndex = inputIndex++;
    inputs.push(
      "-f",
      "lavfi",
      "-t",
      t(sliceDuration),
      "-i",
      `color=c=${bgColor}:s=${width}x${height}:r=${fps}${transparent ? ",format=rgba" : ""}`
    );

    const srcZeroed = `${label}_kfsrc`;
    const bgZeroed = `${label}_kfbg`;
    filters.push(`[${sourceIndex}:v]setpts=PTS-STARTPTS[${srcZeroed}]`);
    filters.push(`[${bgIndex}:v]setpts=PTS-STARTPTS[${bgZeroed}]`);

    // `split=` fans the ONE zeroed stream out into N independent copies, one per slice, so each can be
    // `trim=`'d to its own sub-range without affecting the others — skipped entirely for a single-slice
    // segment (a short transition-side segment with no interior keyframe boundary is common), avoiding
    // an untested `split=1` construct for the common case.
    let srcPads = [srcZeroed];
    let bgPads = [bgZeroed];
    if (slices.length > 1) {
      const srcSplit = slices.map((_, i) => `${label}_kfsrcsplit${i}`);
      filters.push(`[${srcZeroed}]split=${slices.length}${srcSplit.map((l) => `[${l}]`).join("")}`);
      srcPads = srcSplit;

      const bgSplit = slices.map((_, i) => `${label}_kfbgsplit${i}`);
      filters.push(`[${bgZeroed}]split=${slices.length}${bgSplit.map((l) => `[${l}]`).join("")}`);
      bgPads = bgSplit;
    }

    const sliceLabels: string[] = [];
    slices.forEach((slice, i) => {
      // `trim=` is relative to the ZEROED input's own PTS (already reset above), not clip-window- or
      // source-media-relative — `slice.offset` is segment-relative, starting exactly at
      // `elapsedAtSegmentStart` (`computeSliceBoundaries`'s own guarantee for the first boundary), so
      // subtracting it back out lands correctly at 0 for the first slice and walks forward from there.
      // `trim=` does NOT reset PTS on its own (it only removes out-of-range frames) — the
      // `setpts=PTS-STARTPTS` right after it is what actually renormalizes each slice to start at 0,
      // which `concat=` below requires.
      const trimStart = slice.offset - elapsedAtSegmentStart;
      const trimEnd = trimStart + slice.duration;
      const srcTrimmed = `${label}_kfsrctrim${i}`;
      const bgTrimmed = `${label}_kfbgtrim${i}`;
      filters.push(`[${srcPads[i]}]trim=start=${t(trimStart)}:end=${t(trimEnd)},setpts=PTS-STARTPTS[${srcTrimmed}]`);
      filters.push(`[${bgPads[i]}]trim=start=${t(trimStart)}:end=${t(trimEnd)},setpts=PTS-STARTPTS[${bgTrimmed}]`);

      const sliceLabel = `${label}_kf${i}`;
      filters.push(
        ...buildTransformFilters({
          source: srcTrimmed,
          bg: bgTrimmed,
          outputLabel: sliceLabel,
          transform: slice.transform,
          effects: slice.effects,
          width,
          height,
          fps,
          chromaKey: clip.chromaKey,
          colorGrading: slice.colorGrading,
        })
      );
      sliceLabels.push(`[${sliceLabel}]`);
    });

    filters.push(`${sliceLabels.join("")}concat=n=${slices.length}:v=1:a=0[${label}]`);

    if (fadeIn || fadeOut) {
      const alphaParam = transparent ? ":alpha=1" : "";
      const stages: string[] = [];
      if (fadeIn) stages.push(`fade=t=in:st=0:d=${t(fadeIn)}${alphaParam}`);
      if (fadeOut) stages.push(`fade=t=out:st=${t(sliceDuration - fadeOut)}:d=${t(fadeOut)}${alphaParam}`);
      filters.push(`[${label}]${stages.join(",")}[${outputLabel}]`);
    }
  }

  /** Pushes a keyframed side's OWN audio — never sliced (keyframes only ever touch Transform/Effects,
   *  never audio; re-slicing/re-concatenating audio into N pieces would risk audible clicks at slice
   *  boundaries for zero benefit) — via one dedicated full-duration source input of its own, pushed
   *  ONLY when actually needed (`pushClipAudioFilters`'s own silent-source branch needs no real input
   *  at all, so skipping this when there's nothing to extract avoids decoding a source clip solely to
   *  throw its audio away). `clip.sourceIn + elapsedAtSegmentStart` is the same source-time formula
   *  every slice's own `-ss` above already uses, evaluated once for the segment's start instead of per
   *  slice — correct for both a plain "clip" segment (`elapsedAtSegmentStart = segment.sourceIn -
   *  clip.sourceIn`, so this simplifies back to `segment.sourceIn`) and a transition's own from/to
   *  half. */
  function pushKeyframedAudio(
    clip: Clip,
    path: string,
    isImage: boolean,
    hasAudio: boolean,
    elapsedAtSegmentStart: number,
    audioLabel: string,
    sliceDuration: number,
    fadeIn?: number,
    fadeOut?: number
  ): void {
    const needsAudioSource = hasAudio && !clip.mutedAudio;
    let audioSourceIndex = -1;
    if (needsAudioSource) {
      if (isImage) {
        inputs.push("-loop", "1", "-framerate", String(fps), "-t", t(sliceDuration), "-i", path);
      } else {
        inputs.push("-ss", t(clip.sourceIn + elapsedAtSegmentStart), "-t", t(sliceDuration), "-i", path);
      }
      audioSourceIndex = inputIndex++;
    }
    pushClipAudioFilters(needsAudioSource, audioSourceIndex, audioLabel, sliceDuration, clip.gain ?? 1, fadeIn, fadeOut);
  }

  // Pushes one source's own audio — resampled straight through (with an optional `volume=` stage —
  // see `Clip.gain`'s own doc comment) when it has real audio, else a matching-length silent source —
  // shared the same way `pushClipVideoFilters` is above. `gain` is meaningless for the silent-source
  // branch (nothing to scale), so it's simply ignored there rather than needing its own identity check.
  function pushClipAudioFilters(
    hasAudio: boolean,
    videoIndex: number,
    outputLabel: string,
    sliceDuration: number,
    gain = 1,
    fadeIn?: number,
    fadeOut?: number
  ): void {
    // Silence has nothing to fade (an `afade` on a silent source is a pure no-op), so `fadeIn`/
    // `fadeOut` only ever matter on the `hasAudio` branch — same reasoning `gain`'s own "meaningless
    // for silence" comment below already gives.
    const fadeStages: string[] = [];
    if (fadeIn) fadeStages.push(`afade=t=in:st=0:d=${t(fadeIn)}`);
    if (fadeOut) fadeStages.push(`afade=t=out:st=${t(sliceDuration - fadeOut)}:d=${t(fadeOut)}`);
    const fadeStage = fadeStages.length > 0 ? `,${fadeStages.join(",")}` : "";
    if (hasAudio) {
      // Every segment is resampled to one common rate/layout; concat/acrossfade both refuse to join
      // audio streams whose formats don't match, which is easy to hit when mixing a phone clip with
      // a WAV. `volume=` only appended when it would actually change anything — an unconditional
      // `volume=1.000000` is a harmless no-op filter-graph-wise, but skipping it keeps the untouched
      // (overwhelmingly common) case's generated args byte-for-byte identical to before this feature.
      const volumeStage = gain !== 1 ? `,volume=${n(gain)}` : "";
      filters.push(`[${videoIndex}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS${volumeStage}${fadeStage}[${outputLabel}]`);
    } else {
      inputs.push("-f", "lavfi", "-t", t(sliceDuration), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
      filters.push(`[${inputIndex++}:a]asetpts=PTS-STARTPTS[${outputLabel}]`);
    }
  }

  // Builds ONE video track's own segment-based concat chain — everything the single-track version of
  // this function used to do in its own top-level loop, now run once per visible video track and
  // producing that track's own `[cvT]`/`[caT]` pair instead of the fixed `[cv]`/`[ca]`. `trackIndex`
  // 0 is the base/bottom layer (opaque, unchanged from today); every other index is a layer that
  // composites ON TOP of it later, so its own gaps and letterbox padding need to stay transparent.
  function buildTrackStreams(track: Track, trackIndex: number): void {
    const transparent = trackIndex > 0;
    const segments = buildSegments(project, track, [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart), options, duration);
    const concatLabels: string[] = [];

    for (const [i, segment] of segments.entries()) {
      const videoLabel = `v${trackIndex}_${i}`;
      const audioLabel = `a${trackIndex}_${i}`;

      if (segment.kind === "clip") {
        if (hasTransformKeyframes(segment.clip) || hasEffectsKeyframes(segment.clip) || hasColorGradingKeyframes(segment.clip)) {
          // `sourceIn` (not `segment.clip.sourceIn`) already accounts for a transition-shortened head
          // — see `buildSegments`'s own comment for why — so converting it back to clip-window-
          // relative time (the space `Keyframe.time` itself uses) is a plain subtraction.
          const elapsedAtSegmentStart = segment.sourceIn - segment.clip.sourceIn;
          pushKeyframedClipVideoFilters(
            segment.clip,
            segment.path,
            segment.isImage,
            elapsedAtSegmentStart,
            videoLabel,
            segment.duration,
            transparent,
            segment.fadeIn,
            segment.fadeOut
          );
          pushKeyframedAudio(segment.clip, segment.path, segment.isImage, segment.hasAudio, elapsedAtSegmentStart, audioLabel, segment.duration, segment.fadeIn, segment.fadeOut);
        } else {
          if (segment.isImage) {
            // A still has no timeline to seek into — `-ss` would be meaningless and `-t` alone would
            // yield a single frame. `-loop 1` repeats the decoded image for the clip's duration, which
            // is what makes an image occupy real time on the timeline.
            inputs.push("-loop", "1", "-framerate", String(fps), "-t", t(segment.duration), "-i", segment.path);
          } else {
            // -ss and -t BEFORE -i: seek-then-decode, so only the needed range is read. `sourceIn` (not
            // `segment.clip.sourceIn`) is what accounts for a transition-shortened clip starting partway
            // into its own footage — see `buildSegments`'s own comment for why.
            inputs.push("-ss", t(segment.sourceIn), "-t", t(segment.duration), "-i", segment.path);
          }
          const videoIndex = inputIndex++;
          pushClipVideoFilters(segment.clip, videoIndex, videoLabel, segment.duration, transparent, segment.fadeIn, segment.fadeOut);
          pushClipAudioFilters(
            segment.hasAudio && !segment.clip.mutedAudio,
            videoIndex,
            audioLabel,
            segment.duration,
            segment.clip.gain ?? 1,
            segment.fadeIn,
            segment.fadeOut
          );
        }
      } else if (segment.kind === "transition") {
        // Two small `-ss/-t` slices — the outgoing clip's own tail `D` seconds, the incoming clip's own
        // head `D` seconds — each normalized through the exact same per-clip filter chain a plain
        // segment uses, THEN blended with `xfade`/`acrossfade`. Both slices are already exactly `D`
        // seconds long and start together once prepared, so `offset=0` makes the entire prepared pair
        // the blend window rather than xfade waiting partway into a longer stream first. Empirically
        // verified against the real bundled FFmpeg binary (frame extraction + pixel sampling through
        // the blend) before being trusted, per this feature's own development notes.
        const D = segment.duration;
        const fromVideoLabel = `${videoLabel}_from`;
        const toVideoLabel = `${videoLabel}_to`;
        const fromAudioLabel = `${audioLabel}_from`;
        const toAudioLabel = `${audioLabel}_to`;

        // Each side of a transition is keyframe-aware independently — the OUTGOING clip's own tail D
        // seconds is `elapsedAtSegmentStart = clipDuration(from.clip) - D` (its own final D seconds);
        // the INCOMING clip's own head D seconds starts at `elapsedAtSegmentStart = 0` (its own first
        // D seconds).
        if (hasTransformKeyframes(segment.from.clip) || hasEffectsKeyframes(segment.from.clip) || hasColorGradingKeyframes(segment.from.clip)) {
          const fromElapsedAtSegmentStart = clipDuration(segment.from.clip) - D;
          pushKeyframedClipVideoFilters(segment.from.clip, segment.from.path, segment.from.isImage, fromElapsedAtSegmentStart, fromVideoLabel, D, transparent);
          pushKeyframedAudio(segment.from.clip, segment.from.path, segment.from.isImage, segment.from.hasAudio, fromElapsedAtSegmentStart, fromAudioLabel, D);
        } else {
          if (segment.from.isImage) {
            inputs.push("-loop", "1", "-framerate", String(fps), "-t", t(D), "-i", segment.from.path);
          } else {
            inputs.push("-ss", t(segment.from.clip.sourceOut - D), "-t", t(D), "-i", segment.from.path);
          }
          const fromIndex = inputIndex++;
          pushClipVideoFilters(segment.from.clip, fromIndex, fromVideoLabel, D, transparent);
          pushClipAudioFilters(segment.from.hasAudio && !segment.from.clip.mutedAudio, fromIndex, fromAudioLabel, D, segment.from.clip.gain ?? 1);
        }

        if (hasTransformKeyframes(segment.to.clip) || hasEffectsKeyframes(segment.to.clip) || hasColorGradingKeyframes(segment.to.clip)) {
          pushKeyframedClipVideoFilters(segment.to.clip, segment.to.path, segment.to.isImage, 0, toVideoLabel, D, transparent);
          pushKeyframedAudio(segment.to.clip, segment.to.path, segment.to.isImage, segment.to.hasAudio, 0, toAudioLabel, D);
        } else {
          if (segment.to.isImage) {
            inputs.push("-loop", "1", "-framerate", String(fps), "-t", t(D), "-i", segment.to.path);
          } else {
            inputs.push("-ss", t(segment.to.clip.sourceIn), "-t", t(D), "-i", segment.to.path);
          }
          const toIndex = inputIndex++;
          pushClipVideoFilters(segment.to.clip, toIndex, toVideoLabel, D, transparent);
          pushClipAudioFilters(segment.to.hasAudio && !segment.to.clip.mutedAudio, toIndex, toAudioLabel, D, segment.to.clip.gain ?? 1);
        }

        // `segment.to.clip` is the INCOMING side — `transitionIn` describes the blend FROM its partner
        // INTO it (see that field's own doc comment), matching exactly which clip `findTransitionPartner`
        // was resolved against to produce this segment in the first place.
        const xfadeName = TRANSITION_XFADE_NAME[segment.to.clip.transitionIn?.type ?? "crossfade"];
        filters.push(
          `[${fromVideoLabel}][${toVideoLabel}]xfade=transition=${xfadeName}:duration=${t(D)}:offset=0,setpts=PTS-STARTPTS[${videoLabel}]`
        );
        filters.push(`[${fromAudioLabel}][${toAudioLabel}]acrossfade=d=${t(D)}[${audioLabel}]`);
      } else {
        const gapColor = transparent ? "black@0" : "black";
        // See `pushClipVideoFilters`'s own identical `,format=rgba` comment — a raw lavfi `color=...@0`
        // INPUT needs to be told to carry alpha itself, or the `@0` is silently dropped at the source.
        inputs.push(
          "-f",
          "lavfi",
          "-t",
          t(segment.duration),
          "-i",
          `color=c=${gapColor}:s=${width}x${height}:r=${fps}${transparent ? ",format=rgba" : ""}`
        );
        filters.push(`[${inputIndex++}:v]setsar=1,setpts=PTS-STARTPTS[${videoLabel}]`);
        inputs.push("-f", "lavfi", "-t", t(segment.duration), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
        filters.push(`[${inputIndex++}:a]asetpts=PTS-STARTPTS[${audioLabel}]`);
      }

      concatLabels.push(`[${videoLabel}][${audioLabel}]`);
    }

    filters.push(`${concatLabels.join("")}concat=n=${segments.length}:v=1:a=1[cv${trackIndex}][ca${trackIndex}]`);
  }

  // The audio-only counterpart of `buildTrackStreams` above — same `buildSegments` walk, same
  // `pushClipAudioFilters`/`acrossfade` building blocks the video-track transition branch already
  // uses, just with every video-side call (`pushClipVideoFilters`, `xfade`, the video half of each
  // `concatLabels` entry) dropped entirely, since a dedicated audio track has no picture to composite.
  // This is what makes `Clip.transitionIn`/`transitionOut` actually DO something for a clip on an
  // audio track — before this, `audibleClips`-driven mixing below was a flat per-clip `adelay`+`amix`
  // that never consulted `findTransitionPartner`/`findTransitionOut` at all, so setting a transition
  // on a music/voiceover clip silently had zero effect on the export (transition fields aren't gated
  // to any track kind at the TYPE level — see `Clip.transitionIn`'s own doc comment — only certain
  // CONSUMERS of them were, and this was one of the ones that hadn't caught up yet).
  //
  // Only `"crossfade"` is meaningful for audio (confirmed by how every OTHER `TransitionType` renders:
  // `TRANSITION_XFADE_NAME` maps every one of them to a `xfade` VIDEO filter name, and FFmpeg's
  // `acrossfade` has no "shape" concept at all beyond a linear blend) — so unlike the video-track
  // branch above, this never reads `clip.transitionIn?.type` at all; every audio transition is simply
  // `acrossfade`, matching what the Inspector's Transitions tab actually offers an audio clip (no
  // Style picker — see `Inspector.tsx`'s own comment on why that control is hidden for `track.kind
  // === "audio"`).
  function buildAudioTrackStream(track: Track, trackIndex: number): string {
    const segments = buildSegments(project, track, [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart), options, duration);
    const concatLabels: string[] = [];

    for (const [i, segment] of segments.entries()) {
      const audioLabel = `at${trackIndex}_${i}`;

      if (segment.kind === "clip") {
        if (segment.isImage) {
          // A dedicated audio track can never hold an image clip (`trackKindForAsset` refuses it), so
          // this branch is unreachable here — kept only because `Segment["kind"]["clip"]` is the same
          // shared shape `buildTrackStreams` above uses, and TypeScript can't otherwise know `isImage`
          // is always false for a clip that reached an audio track.
          inputs.push("-loop", "1", "-framerate", String(fps), "-t", t(segment.duration), "-i", segment.path);
        } else {
          inputs.push("-ss", t(segment.sourceIn), "-t", t(segment.duration), "-i", segment.path);
        }
        const audioIndex = inputIndex++;
        pushClipAudioFilters(
          segment.hasAudio && !segment.clip.mutedAudio,
          audioIndex,
          audioLabel,
          segment.duration,
          (segment.clip.gain ?? 1) * (track.gain ?? 1),
          segment.fadeIn,
          segment.fadeOut
        );
      } else if (segment.kind === "transition") {
        const D = segment.duration;
        const fromAudioLabel = `${audioLabel}_from`;
        const toAudioLabel = `${audioLabel}_to`;

        inputs.push("-ss", t(segment.from.clip.sourceOut - D), "-t", t(D), "-i", segment.from.path);
        const fromIndex = inputIndex++;
        pushClipAudioFilters(segment.from.hasAudio && !segment.from.clip.mutedAudio, fromIndex, fromAudioLabel, D, (segment.from.clip.gain ?? 1) * (track.gain ?? 1));

        inputs.push("-ss", t(segment.to.clip.sourceIn), "-t", t(D), "-i", segment.to.path);
        const toIndex = inputIndex++;
        pushClipAudioFilters(segment.to.hasAudio && !segment.to.clip.mutedAudio, toIndex, toAudioLabel, D, (segment.to.clip.gain ?? 1) * (track.gain ?? 1));

        filters.push(`[${fromAudioLabel}][${toAudioLabel}]acrossfade=d=${t(D)}[${audioLabel}]`);
      } else {
        inputs.push("-f", "lavfi", "-t", t(segment.duration), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
        filters.push(`[${inputIndex++}:a]asetpts=PTS-STARTPTS[${audioLabel}]`);
      }

      concatLabels.push(`[${audioLabel}]`);
    }

    const outputLabel = `at${trackIndex}`;
    filters.push(`${concatLabels.join("")}concat=n=${segments.length}:v=0:a=1[${outputLabel}]`);

    // Applied ONCE on the track's own already-concatenated stream, not per-clip/per-segment above —
    // pan is linear and commutes fine either way, so doing it once here is both correct and cheaper
    // than threading it through every `pushClipAudioFilters` call.
    const panStage = buildPanFilterStage(track.pan ?? 0, n);
    if (panStage) {
      const pannedLabel = `${outputLabel}p`;
      filters.push(`[${outputLabel}]${panStage}[${pannedLabel}]`);
      return `[${pannedLabel}]`;
    }
    return `[${outputLabel}]`;
  }

  videoTracks.forEach((track, trackIndex) => buildTrackStreams(track, trackIndex));

  // Layers each track's own composited stream over the ones before it — base first, so the result is
  // guaranteed fully opaque everywhere (required for the `yuv420p` output, which has no alpha channel
  // at all): the base track's own gaps/padding are opaque by construction above, and compositing
  // anything on top of a fully opaque frame always yields a fully opaque result regardless of the
  // top layer's own alpha. A single video track skips this chain entirely — `videoOut` is just
  // `[cv0]`, byte-for-byte the same seed the old literal `[cv]` used to be.
  let videoOut = "[cv0]";
  const videoTrackAudioLabels: string[] = [];
  for (let i = 1; i < videoTracks.length; i++) {
    const label = `layer${i}`;
    filters.push(`${videoOut}[cv${i}]overlay=format=auto[${label}]`);
    videoOut = `[${label}]`;
    videoTrackAudioLabels.push(`[ca${i}]`);
  }

  // Text tracks composite ON TOP of the (possibly multi-layer) video, one `drawtext` per active clip
  // chained onto the growing stream — see `buildDrawTextFilter`'s own comment for why this (not a
  // true overlay-based multi-layer composite) is what makes text-over-video tractable at all. Tracks
  // are walked in their own top-to-bottom order (matching the header list and `PlaybackEngine`'s
  // own `drawTextLayer`), so a lower text track sits behind a higher one wherever they'd overlap.
  let textIndex = 0;
  for (const track of project.sequence.tracks) {
    if (track.kind !== "text" || !track.visible) continue;

    // Precomputed once per track: which clip is the OUTGOING side of some other clip's active
    // transition, and for how long — `findTransitionPartner` only ever answers "what do I blend FROM"
    // (a clip's own `transitionIn`), so the fade-OUT side has to be discovered by resolving every
    // clip's own partner and recording it against THAT partner's id instead. Mirrors how
    // `PlaybackEngine.drawTextLayer` finds the same relationship per-frame instead — this is the
    // export-time, whole-track equivalent, computed once rather than per frame.
    const fadeOutByClipId = new Map<string, number>();
    for (const clip of track.clips) {
      const transition = findTransitionPartner(track, clip);
      // A `null` partner is a solo fade-IN (see `findTransitionPartner`'s own doc comment) — there's
      // no OUTGOING clip to attribute a fade-out to in that case, so it contributes nothing here.
      if (transition?.partner) fadeOutByClipId.set(transition.partner.id, transition.duration);
    }

    for (const clip of track.clips) {
      const asset = findAsset(project, clip.assetId);
      if (!asset || asset.kind !== "text" || !asset.textStyle) continue;
      // `clip.textStyleKeyframes`, when armed, animates on EXPORT too, not just the preview — see
      // `buildKeyframedDrawTextCalls`/`buildKeyframedRotatedDrawTextCalls`'s own doc comments for how
      // (short static per-slice `drawtext` calls chained onto the stream, mirroring
      // `buildTypewriterDrawTextCalls`'s own shape, not video's `concat=`-based slicing — text has no
      // source media to re-cut). One deliberate priority decision: `textStyleKeyframes` wins over
      // `typewriter` when a clip somehow has both armed (checked via `hasTextStyleKeyframes` below,
      // reached before `buildDrawTextFilter`'s own internal typewriter branch ever would be) — combining
      // keyframe-slicing's position-driven chaining with typewriter's character-reveal-driven chaining
      // would need a genuine cross-product of two independent timing mechanisms, real scope beyond this
      // pass, same spirit as the `wordHighlight`-has-no-export-equivalent scope cut already documented
      // on `buildDrawTextFilter` itself. A keyframed+typewriter clip exports with full static text per
      // slice, motion intact, character-reveal ignored.
      const outputLabel = `txt${textIndex++}`;
      const fadeIn = findTransitionPartner(track, clip)?.duration;
      // Two independent sources for a text clip's own fade-out, checked in order: is it the OUTGOING
      // side of some OTHER clip's real transition-in (`fadeOutByClipId`, precomputed above), or — if
      // not — does it have its own `transitionOut` resolving to a solo fade (`findTransitionOut`
      // already returns `null` whenever a genuine successor exists at all, so these two can never
      // both apply to the same clip; checking both here just avoids caring which one it was).
      const fadeOut = fadeOutByClipId.get(clip.id) ?? findTransitionOut(track, clip)?.duration;

      // `wordHighlight` is checked FIRST, ahead of the rotated/plain split below — it renders through a
      // completely different filter (`subtitles=`, not `drawtext`) regardless of `style.rotationDeg`,
      // and `buildWordHighlightSubtitlesFilter` itself returns `null` (falling through to the ordinary
      // plain/rotated path below, same as before this capability existed) whenever the three
      // `ExportPlanOptions` it needs aren't ALL supplied, or a specific clip's font metrics can't be
      // resolved — see that function's own comment.
      const wordHighlightFilter =
        clip.textAnimation?.type === "wordHighlight" && options.assFilePathFor && options.fontMetricsFor && options.fontsDirFor
          ? buildWordHighlightSubtitlesFilter({
              inputLabel: videoOut,
              outputLabel,
              content: asset.textContent ?? "",
              style: asset.textStyle,
              clip,
              frameWidth: width,
              frameHeight: height,
              assFilePathFor: options.assFilePathFor,
              fontMetricsFor: options.fontMetricsFor,
              fontsDirFor: options.fontsDirFor,
              fadeIn,
              fadeOut,
            })
          : null;

      // `wiggle` needs the ROTATED path even for a clip with no STATIC rotation of its own — it's the
      // only branch that can drive FFmpeg's `rotate` filter's angle from a per-frame expression. See
      // `buildRotatedDrawTextFilter`'s own comment for how it folds a zero `style.rotationDeg` in.
      // Keyframed clips ALSO need it whenever any keyframe (not just the static base style) could ever
      // produce a nonzero rotation — `rotationDeg` is one of `lerpTextStyle`'s interpolated numeric
      // fields, so it can legitimately vary per slice, and a single clip's own slice sequence must never
      // mix the plain and rotated chains. Safe for the common (never-rotated) case: `buildRotatedDrawTextFilter`
      // already degrades byte-identically at `rotationDeg = 0`.
      const needsRotatedPath =
        asset.textStyle.rotationDeg !== 0 ||
        clip.textAnimation?.type === "wiggle" ||
        (hasTextStyleKeyframes(clip) && clip.textStyleKeyframes!.some((k) => k.value.rotationDeg !== 0));
      if (wordHighlightFilter) {
        filters.push(...wordHighlightFilter);
      } else {
        // `TextCrop` (frame-space overflow mask, see its own doc comment) is NOT reachable from
        // `wordHighlight` in v1 — that path renders through `subtitles=`/libass, not `drawtext=`, and
        // whether libass draws correctly onto a genuinely transparent isolated buffer (rather than the
        // opaque composited stream every existing use of `subtitles=` here draws onto) is unverified;
        // out of scope for this feature, independent of crop itself.
        //
        // For the plain/rotated `drawtext` paths below: a clip with a real crop gets its ENTIRE existing
        // builder call (unchanged internally — same `buildDrawTextFilter`/`buildRotatedDrawTextFilter`,
        // same bounce/pulse/wiggle/typewriter expression math) redirected onto a fresh isolated
        // transparent buffer instead of the shared `videoOut`, then crop→pad→overlay's the result onto
        // the real `videoOut` afterward. A crop-less clip takes the exact byte-for-byte original path —
        // `drawInputLabel`/`drawOutputLabel` just equal `videoOut`/`outputLabel` unchanged.
        const hasCrop = clip.textCrop && !isIdentityTextCrop(clip.textCrop);
        let drawInputLabel = videoOut;
        const drawOutputLabel = hasCrop ? `${outputLabel}_iso` : outputLabel;

        if (hasCrop) {
          const isoIndex = inputIndex++;
          // Spans the full SEQUENCE duration (not just this clip's own), same reasoning as
          // `buildRotatedDrawTextFilter`'s own `bgIndex` input just below: the animation-type builders'
          // `enable='between(t,...)'` gates are written against ABSOLUTE timeline seconds, so this
          // buffer's own PTS must start at 0 for those gates to ever evaluate true. Same `format=rgba`-
          // chained-into-the-lavfi-source trick as `bgIndex` uses, for the identical reason (`color`'s
          // own `@0` alpha spec is silently discarded at the source otherwise — see that input's own
          // comment for the full empirical confirmation).
          inputs.push("-f", "lavfi", "-t", t(duration), "-i", `color=c=black@0:s=${width}x${height}:r=${fps},format=rgba`);
          drawInputLabel = `[${isoIndex}:v]`;
        }

        if (!needsRotatedPath) {
          filters.push(
            ...(hasTextStyleKeyframes(clip)
              ? buildKeyframedDrawTextCalls({
                  inputLabel: drawInputLabel,
                  outputLabel: drawOutputLabel,
                  content: asset.textContent ?? "",
                  baseStyle: asset.textStyle,
                  clip,
                  fontPathFor: options.fontPathFor,
                  textFilePathFor: options.textFilePathFor,
                  fadeIn,
                  fadeOut,
                  fps,
                })
              : buildDrawTextFilter({
                  inputLabel: drawInputLabel,
                  outputLabel: drawOutputLabel,
                  content: asset.textContent ?? "",
                  style: asset.textStyle,
                  clip,
                  fontPathFor: options.fontPathFor,
                  textFilePathFor: options.textFilePathFor,
                  fadeIn,
                  fadeOut,
                }))
          );
        } else {
          // A rotated text clip needs its own full-sequence-duration transparent background input to
          // draw and rotate onto — see `buildRotatedDrawTextFilter`'s own comment for why. Duration
          // matches `[cv]`'s (not just this clip's own) so the two stay trivially PTS-aligned.
          //
          // The trailing `,format=rgba` is load-bearing, not decorative: FFmpeg's `color` lavfi source
          // emits `yuv420p` (no alpha channel at all) by default regardless of the `@0` alpha spec in the
          // color string — `black@0`'s transparency is silently discarded at the SOURCE, before
          // `buildRotatedDrawTextFilter`'s own `format=rgba` filter (applied downstream, after drawtext)
          // ever gets a chance to see it, so without this the "transparent" background renders as a solid
          // OPAQUE black rectangle once overlaid — confirmed empirically (isolated `color=...@0` → overlay
          // test produced a fully opaque result) after the rotated-text/overlay chain was actually run
          // against a real video for the first time (this feature's own original verification exercised
          // `rotate` on its own, never the full chain through `overlay`). Chaining `format=rgba` directly
          // into the lavfi source string (lavfi accepts a small filter chain, not just one filter) forces
          // the alpha channel to exist from frame one, which is what actually makes it possible for
          // `black@0` to mean something by the time downstream filters touch it.
          //
          // This is a SEPARATE input from the crop-isolation buffer above (when `hasCrop`) — this one is
          // the rotated path's own pre-rotation canvas, an unrelated purpose; only `inputLabel` (what its
          // OWN final overlay step composites onto) changes when cropped, not this.
          const bgIndex = inputIndex++;
          inputs.push("-f", "lavfi", "-t", t(duration), "-i", `color=c=black@0:s=${width}x${height}:r=${fps},format=rgba`);
          filters.push(
            ...(hasTextStyleKeyframes(clip)
              ? buildKeyframedRotatedDrawTextCalls({
                  inputLabel: drawInputLabel,
                  bgIndex,
                  outputLabel: drawOutputLabel,
                  content: asset.textContent ?? "",
                  baseStyle: asset.textStyle,
                  clip,
                  fontPathFor: options.fontPathFor,
                  textFilePathFor: options.textFilePathFor,
                  fadeIn,
                  fadeOut,
                  fps,
                })
              : buildRotatedDrawTextFilter({
                  inputLabel: drawInputLabel,
                  bgIndex,
                  outputLabel: drawOutputLabel,
                  content: asset.textContent ?? "",
                  style: asset.textStyle,
                  clip,
                  fontPathFor: options.fontPathFor,
                  textFilePathFor: options.textFilePathFor,
                  fadeIn,
                  fadeOut,
                }))
          );
        }

        if (hasCrop) {
          const crop = clip.textCrop!;
          const cropX = n(width * crop.left);
          const cropY = n(height * crop.top);
          const cropW = n(width * (1 - crop.left - crop.right));
          const cropH = n(height * (1 - crop.top - crop.bottom));
          // `pad`'s own `x=`/`y=` can't reuse `crop`'s output `iw`/`ih` symbolically the way `crop`'s
          // own `x=`/`y=` can reuse the PRE-crop stream's `iw`/`ih` — after `crop` runs, `iw`/`ih` refer
          // to the smaller cropped buffer, not the original frame. Frame dimensions and crop fractions
          // are both known JS constants here (unlike `buildTransformFilters`'s source crop, where source
          // dimensions vary per asset), so every arg below is a precomputed pixel literal rather than a
          // mix of symbolic and literal forms. `format=rgba` re-applied immediately before `pad`, same
          // defensive convention as everywhere else in this file that depends on alpha surviving a
          // filter — never assumed to have survived untouched.
          filters.push(
            `[${drawOutputLabel}]crop=w=${cropW}:h=${cropH}:x=${cropX}:y=${cropY},format=rgba,` +
              `pad=w=${n(width)}:h=${n(height)}:x=${cropX}:y=${cropY}:color=black@0[${outputLabel}_padded]`
          );
          // No explicit `x=`/`y=` — `pad` already positioned the visible content correctly within a
          // frame-sized buffer, so this is the same plain "two frame-sized buffers, stack one on the
          // other" shape the multi-video-track layering overlay above already uses (`overlay=format=auto`,
          // no position), not the offset overlays elsewhere whose content is smaller than the background.
          const { enableEnd } = buildTextFadeParams(clip, fadeIn, fadeOut);
          filters.push(
            `${videoOut}[${outputLabel}_padded]overlay=format=auto:enable='between(t\\,${t(clip.timelineStart)}\\,${t(enableEnd)})'[${outputLabel}]`
          );
        }
      }
      videoOut = `[${outputLabel}]`;
    }
  }

  // Audio-track clips (voiceover, music) are mixed over the video track's own audio — one stream per
  // audio track, via `buildAudioTrackStream` (its own comment explains why this replaced a flat
  // per-clip `adelay`+`amix`: that never gave `transitionIn`/`transitionOut` any effect at all).
  // Track-level mute/solo resolved once here, per track — the exact same rule `audibleClips` (used
  // elsewhere for the live preview) applies, just against a whole track up front instead of filtering
  // an already-flattened clip list, since a track this excludes needs to skip `buildAudioTrackStream`
  // entirely rather than contribute a silent placeholder stream to the mix.
  const audioTracks = project.sequence.tracks.filter((track) => track.kind === "audio");
  const anySoloAudioTrack = audioTracks.some((track) => track.solo);
  const overlayAudio: string[] = [];
  for (const [trackIndex, track] of audioTracks.entries()) {
    if (anySoloAudioTrack ? !track.solo : track.muted) continue;
    // Skip the whole track — not just an individually-muted clip within it — when NOTHING on it could
    // ever produce real audio (every clip missing/offline/silent-asset/muted). The old flat per-clip
    // loop this replaced got this for free (a muted clip just never contributed a label at all); a
    // per-track stream has to check up front instead, or a track that's ENTIRELY muted clips would
    // still get mixed in as a pointless, fully-silent `amix` input — harmless to the actual audio, but
    // exactly the kind of no-op filter stage this codebase otherwise takes care not to emit (see
    // `pushClipAudioFilters`'s own `volumeStage` comment on the same principle).
    const hasAudibleClip = track.clips.some((clip) => {
      const asset = findAsset(project, clip.assetId);
      return asset ? !asset.offline && asset.hasAudio && !clip.mutedAudio : false;
    });
    if (!hasAudibleClip) continue;
    overlayAudio.push(buildAudioTrackStream(track, trackIndex));
  }

  // Every additional video track's own audio (already a full-timeline-duration stream, silent in its
  // own gaps, exactly like the base track's `[ca0]`) mixes in through the SAME mechanism as an
  // audio-track overlay clip — no separate mixing stage needed for "a second video track's sound".
  let audioOut = "[ca0]";
  const allExtraAudio = [...videoTrackAudioLabels, ...overlayAudio];
  if (allExtraAudio.length > 0) {
    // normalize=0 keeps amix from quietly attenuating every input as more are added, which would
    // make adding a music track mysteriously duck the narration.
    filters.push(
      `${audioOut}${allExtraAudio.join("")}amix=inputs=${allExtraAudio.length + 1}:normalize=0:dropout_transition=0[mixa]`
    );
    audioOut = "[mixa]";
  }

  // Master fader — applied once, after every track/clip gain has already been mixed together, same
  // "only emit a volume= stage when it would do something" principle `pushClipAudioFilters`'s own
  // `volumeStage` uses.
  const masterGain = project.sequence.masterGain ?? 1;
  if (masterGain !== 1) {
    filters.push(`${audioOut}volume=${n(masterGain)}[mastered]`);
    audioOut = "[mastered]";
  }

  // Conform the fully-composited sequence-sized frame to the REQUESTED output size — see this
  // function's own opening comment for why this has to be a closing step, not the canvas size used
  // throughout. Skipped entirely (byte-for-byte identical graph to before this fix) for the
  // overwhelmingly common case where they already match, which every project does until a user
  // explicitly picks a different export resolution.
  if (outputWidth !== width || outputHeight !== height) {
    filters.push(
      `${videoOut}scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=decrease,` +
        `pad=${outputWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1[conformed]`
    );
    videoOut = "[conformed]";
  }

  return {
    duration,
    args: [
      ...inputs,
      "-filter_complex",
      filters.join(";"),
      "-map",
      videoOut,
      "-map",
      audioOut,
      ...(options.videoEncoderArgs ?? ["-c:v", "libx264", "-preset", "medium", "-crf", String(crf)]),
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      `${audioBitrateKbps}k`,
      // Puts the MP4 index at the front so the file can start playing before it's fully downloaded —
      // what every social platform expects of an upload.
      "-movflags",
      "+faststart",
      // Guards against a filter-graph rounding difference making the output a few frames longer than
      // the timeline.
      "-t",
      t(duration),
      "-y",
      options.outputPath,
    ],
  };
}
