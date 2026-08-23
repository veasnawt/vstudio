/** The core project model. Everything here is PLAIN SERIALIZABLE DATA — no class instances, no
 *  functions, no Dates — so `structuredClone` and a JSON round-trip are both trivially lossless.
 *  That property is what makes undo (which clones state) and save/reopen (which JSON-round-trips it)
 *  correct by construction rather than by careful maintenance. */

import { DEFAULT_FONT_ID } from "./fonts.ts";

/** Bumped whenever a change to these types would make an older `project.json` misread rather than
 *  merely incomplete. `deserializeProject` refuses anything newer than it understands instead of
 *  silently mangling a project a future version wrote. */
export const PROJECT_SCHEMA_VERSION = 1;

export type AssetKind = "video" | "audio" | "image" | "text";
export type TrackKind = "video" | "audio" | "text";

/** An imported media file. `relPath` is relative to the project's own media folder — never an
 *  absolute machine path, so a project folder stays portable between machines and between dev and
 *  the packaged app. */
export interface Asset {
  id: string;
  kind: AssetKind;
  /** Original filename as imported, shown in the library. */
  name: string;
  /** Path relative to the project's media directory (e.g. "clip-a1b2.mp4"). */
  relPath: string;
  /** Path relative to the project's thumbnails directory; absent until one is generated (images
   *  use themselves, audio has none). One SINGLE representative frame — what the Media Library shows,
   *  where one frame is the more useful preview than a filmstrip would be. */
  thumbnailRelPath?: string;
  /** Path to a SPRITE SHEET of several evenly-spaced frames from across the source, tiled in a single
   *  row — video only. What the Timeline tiles across a clip's width for an actual (if approximate)
   *  filmstrip, as opposed to `thumbnailRelPath`'s one frame: tiling that single frame repeatedly
   *  looks like a stamp, not a filmstrip, since it's the exact same image over and over rather than
   *  different points in the source. Optional/absent (not a hard failure) the same way
   *  `thumbnailRelPath` is — a project imported before this existed, or a source FFmpeg couldn't
   *  sample enough distinct frames from, still opens and just falls back to the single-frame tiling
   *  `TimelineClip` already had. */
  filmstripRelPath?: string;
  /** Path to a PNG waveform image (peaks over the asset's FULL duration, transparent background) —
   *  audio only. One static image per asset, the same "generate once at import, let CSS handle
   *  per-clip positioning" split `filmstripRelPath` uses: `TimelineClip` stretches/offsets it via
   *  `background-size`/`background-position` percentages to match each clip's own trim and on-screen
   *  width, rather than regenerating a new image per placement. Optional/absent the same way the other
   *  two are — a project imported before this existed, or a source FFmpeg couldn't read, still opens
   *  and just shows a flat-color clip. */
  waveformRelPath?: string;
  /** Seconds. Images have no intrinsic duration — they get `IMAGE_DEFAULT_DURATION` when placed. */
  duration: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio: boolean;
  sizeBytes: number;
  /** Epoch millis. A number rather than a Date specifically to keep this JSON-round-trippable. */
  importedAt: number;
  /** Set when the file backing this asset can't be found on disk — the UI shows "Media Offline"
   *  and offers Relink rather than pretending the clip is fine. */
  offline?: boolean;
  /** Set on an asset created by `VoiceoverRecorder` — it still exists as a normal `Asset` (a placed
   *  clip references it by id like any other), but `MediaLibrary` excludes it from the list. A quick
   *  voiceover take is meant to live on the timeline, not clutter the library with one-off recordings
   *  the user never deliberately "imported" — absent (the default) for everything else, including a
   *  plain drag-dropped audio file. */
  hiddenFromLibrary?: boolean;
  /** Present only when `kind === "text"`. A text asset has no backing file — `relPath` is an empty
   *  string and `hasAudio` is always false — its "content" is this string, authored directly rather
   *  than imported. Lives on the ASSET (not the clip) for the same reason a video's pixels do: it's
   *  what the asset intrinsically IS, not something that varies per placement on the timeline. */
  textContent?: string;
  /** Present only when `kind === "text"`, alongside `textContent`. */
  textStyle?: TextStyle;
}

/** Visual style for a text asset. Simpler than `ClipTransform`: font size already controls "how big"
 *  (no separate scale multiplier), and there's no crop — but position AND rotation are real, on-canvas-
 *  draggable properties, same as a video clip's. */
export interface TextStyle {
  /** A `FontDefinition.id` from the registry in `fonts.ts` — never a raw font-family string, so every
   *  text clip is guaranteed to reference a font this build actually bundles a file for. An unknown id
   *  (an older project, or one hand-edited) falls back to the default font — see `fontById`. */
  fontFamily: string;
  /** Pixels, in SEQUENCE space (matches `fontSize`'s own unit) — font size is resolution-relative,
   *  not resolution-independent the way `ClipTransform`'s crop fractions are, since text needs to be
   *  legible at the sequence's actual pixel size in both the preview and the export. Doubles as the
   *  "resize" handle's target: dragging a corner scales this value directly rather than introducing a
   *  separate multiplier redundant with it. */
  fontSize: number;
  /** Hex, e.g. "#ffffff". */
  color: string;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
  /** Hex; absent means no background box — plain text, the more common "title" look. Present enables
   *  a solid box behind the text block, the more common "caption" look. */
  backgroundColor?: string;
  /** Hex; absent means no outline. Present draws a `strokeWidth`-pixel border around each glyph — the
   *  classic "white text, black outline" caption look, legible over any footage without needing
   *  `backgroundColor`'s solid box. Both FFmpeg's `drawtext` (`bordercolor`/`borderw`) and Canvas2D
   *  (`strokeText`) draw this the same way: shadow, then outline, then fill, in that order — see
   *  `PlaybackEngine.drawText`'s and `buildExportPlan`'s shared `buildDrawTextStyleParams` comment. */
  strokeColor?: string;
  /** Pixels; only meaningful when `strokeColor` is set — kept as a plain always-present number (not
   *  bundled into an optional sub-object) for the same reason `offsetX`/`offsetY` are, matching this
   *  style object's existing flat shape. */
  strokeWidth: number;
  /** Hex; absent means no drop shadow. */
  shadowColor?: string;
  /** Pixels; only meaningful when `shadowColor` is set. FFmpeg's `drawtext` shadow is a hard-edged
   *  offset duplicate of the glyphs, not a blurred shadow — there's no blur radius to control, so
   *  neither renderer has one (Canvas2D's `shadowBlur` is left at 0 to match). */
  shadowOffsetX: number;
  shadowOffsetY: number;
  /** Multiplies `fontSize` to get the vertical space each line occupies — was a hardcoded constant
   *  (`textLayout.ts`'s old `LINE_HEIGHT_MULTIPLIER`) until this became a real per-style field. */
  lineHeightMultiplier: number;
  /** Pixels from center, SEQUENCE space — same convention as `ClipTransform.offsetX/Y`. 0,0 is
   *  centered. */
  offsetX: number;
  offsetY: number;
  /** Degrees, clockwise, around the text block's OWN center (not the frame's) — same "never clamped,
   *  a multi-turn drag can exceed 360" convention as `ClipTransform.rotationDeg`. */
  rotationDeg: number;
}

/** The default a freshly-created text asset starts with. Exported so every consumer (creation,
 *  Inspector reset, tests) starts from the same values. Centered, unrotated, no background box, no
 *  outline, no shadow — the "title" look, since that's the more neutral default; captions are a
 *  background-color (or stroke, or shadow) click away. `strokeWidth`/`shadowOffsetX/Y` carry sensible
 *  values ready for the moment `strokeColor`/`shadowColor` gets set, the same way `backgroundColor`
 *  being unset doesn't stop `TEXT_BOX_PADDING` from already being a sensible constant. */
export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: DEFAULT_FONT_ID,
  fontSize: 64,
  color: "#ffffff",
  bold: false,
  italic: false,
  align: "center",
  strokeWidth: 3,
  shadowOffsetX: 2,
  shadowOffsetY: 2,
  lineHeightMultiplier: 1.2,
  offsetX: 0,
  offsetY: 0,
  rotationDeg: 0,
};

/** Position/scale/rotation/crop for a video or image clip, applied identically by the preview
 *  compositor and by export (see PlaybackEngine's `drawTransformed` and buildExportPlan's per-clip
 *  filter chain) so what's previewed is what gets rendered.
 *
 *  Pipeline order, fixed and identical on both renderers: crop the source rect (in the source's own
 *  unrotated pixel space) → scale-to-fit the CROPPED dimensions into the sequence frame → apply the
 *  user `scale` multiplier on top → rotate around center → translate by offset. */
export interface ClipTransform {
  /** Pixels in SEQUENCE space, additional translation from center. 0,0 is centered. */
  offsetX: number;
  offsetY: number;
  /** Multiplier on top of the automatic "fit inside frame" scale. 1 is the untransformed fit — values
   *  above 1 zoom in, which combined with offset is what makes "resize to fill" possible without a
   *  separate mode. */
  scale: number;
  /** Degrees, clockwise. Deliberately never clamped or wrapped — a multi-turn drag can exceed 360,
   *  and rotating by an exact 90° or 270° isn't treated specially. Any real number is valid. */
  rotationDeg: number;
  /** Fractions (0..1) of the SOURCE's own width/height, cropped before any other stage — resolution-
   *  independent regardless of the source's native size. Each pair (`top`+`bottom`, `left`+`right`)
   *  is clamped by `setClipTransform` to leave at least a sliver visible; a crop can never produce a
   *  zero or negative-size rect. */
  crop: { top: number; right: number; bottom: number; left: number };
}

/** The untransformed default — what an absent `Clip.transform` means. Exported so every consumer
 *  (Inspector fields, TransformHandles, tests) starts from the same values rather than each hand-
 *  rolling `{ offsetX: 0, ... }` and risking one of them drifting out of sync. */
export const IDENTITY_TRANSFORM: ClipTransform = {
  offsetX: 0,
  offsetY: 0,
  scale: 1,
  rotationDeg: 0,
  crop: { top: 0, right: 0, bottom: 0, left: 0 },
};

/** Whether a transform is a no-op — either absent, or explicitly set to values equivalent to
 *  `IDENTITY_TRANSFORM`. Both `setClipTransform` (which deletes the field entirely rather than
 *  storing an identity object, so undoing a transform edit restores a truly absent field rather than
 *  a structurally-different "empty" one) and `buildExportPlan` (which picks the plain, already-tested
 *  scale+pad filter chain instead of the full crop/scale/rotate/overlay one) key off this. */
export function isIdentityTransform(transform: ClipTransform | undefined): boolean {
  if (!transform) return true;
  return (
    transform.offsetX === 0 &&
    transform.offsetY === 0 &&
    transform.scale === 1 &&
    transform.rotationDeg === 0 &&
    transform.crop.top === 0 &&
    transform.crop.right === 0 &&
    transform.crop.bottom === 0 &&
    transform.crop.left === 0
  );
}

/** Static, non-keyframed, frame-space rectangular crop for a TEXT clip — CSS `overflow: hidden` over
 *  the rendered text, NOT `ClipTransform.crop`'s pre-scale source-pixel crop (text has no source pixels
 *  to crop from). Shaped identically to `ClipTransform.crop` (4 edge-inset fractions, 0..1 — but of the
 *  SEQUENCE FRAME's own width/height, not the text's own dynamically-measured bounding box) purely
 *  because that's the closest existing UI/data precedent in this codebase, not because the two mean the
 *  same thing: text keeps rendering at its normal computed position (`TextStyle.offsetX/offsetY`/
 *  `align`), and this crop is an independent mask over the FRAME on top of that, not a repositioning of
 *  the text block itself. Not keyframed — mirrors `ChromaKeySettings`'s own "static per-clip data, not
 *  keyframed" precedent. */
export interface TextCrop {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The untransformed default — full frame visible, no clipping. Mirrors `IDENTITY_TRANSFORM`. */
export const IDENTITY_TEXT_CROP: TextCrop = { top: 0, right: 0, bottom: 0, left: 0 };

/** Mirrors `isIdentityTransform` — both `setClipTextCrop` (identity-collapse) and `buildExportPlan`
 *  (plain vs. isolate/crop/pad/overlay filter chain) key off this. */
export function isIdentityTextCrop(crop: TextCrop | undefined): boolean {
  if (!crop) return true;
  return crop.top === 0 && crop.right === 0 && crop.bottom === 0 && crop.left === 0;
}

/** Static (non-animating) per-clip color/blur adjustments. Video/image clips only — text has its own
 *  separate `TextStyle` system.
 *
 *  Each field's range/convention is picked so preview (Canvas2D `context.filter`) and export
 *  (FFmpeg's `eq`/`gblur` filters) agree as exactly as possible — `opacity`/`saturation`/`contrast`
 *  are exact matches (both renderers already share the same multiplicative convention, 1 = unchanged,
 *  for the latter two), while `brightness` and `blur` are documented APPROXIMATIONS: FFmpeg's
 *  `eq=brightness=` is additive (0 = unchanged) but CSS `brightness()` is multiplicative, and CSS
 *  `blur(Xpx)` uses a different kernel than FFmpeg's `gblur=sigma=X` — close enough for a slider, not
 *  pixel-identical. Same spirit as `textLayout.ts`'s own documented multi-line-alignment
 *  approximation: state the gap plainly rather than silently pretend it doesn't exist. */
export interface ClipEffects {
  /** -1..1, additive, 0 = unchanged (FFmpeg's own `eq` convention). */
  brightness: number;
  /** 0..2, multiplicative, 1 = unchanged. */
  contrast: number;
  /** 0..2, multiplicative, 1 = unchanged; 0 = fully grayscale. */
  saturation: number;
  /** 0..20, 0 = unchanged (no blur). */
  blur: number;
  /** 0..1, 1 = fully opaque. */
  opacity: number;
}

/** The untransformed default — what an absent `Clip.effects` means. Mirrors `IDENTITY_TRANSFORM`. */
export const IDENTITY_EFFECTS: ClipEffects = {
  brightness: 0,
  contrast: 1,
  saturation: 1,
  blur: 0,
  opacity: 1,
};

/** Mirrors `isIdentityTransform` — both `setClipEffects` (which deletes the field entirely rather
 *  than storing an explicit identity object) and `buildExportPlan` (which picks the plain, already-
 *  tested filter chain instead of the effects-aware one) key off this. */
export function isIdentityEffects(effects: ClipEffects | undefined): boolean {
  if (!effects) return true;
  return (
    effects.brightness === 0 &&
    effects.contrast === 1 &&
    effects.saturation === 1 &&
    effects.blur === 0 &&
    effects.opacity === 1
  );
}

/** Chroma key (green/blue screen) settings for a video/image clip — makes pixels near `color`
 *  transparent so whatever's on the track(s) beneath shows through. Mirrors FFmpeg's own `colorkey`
 *  filter parameters closely (`similarity`→`similarity`, `smoothness`→`blend`) rather than inventing a
 *  different model, specifically so preview (Canvas2D, `PlaybackEngine.applyChromaKey`) and export
 *  (`buildExportPlan`'s `colorkey=` filter) agree as exactly as possible — same "state the algorithm,
 *  don't just approximate it" spirit `ClipEffects`'s own doc comment already follows for
 *  brightness/blur. Static per-clip data, not keyframed — a green screen's key color doesn't need to
 *  animate over a clip's own duration the way position/effects sometimes do, same "not everything needs
 *  a keyframe track" reasoning `textAnimation`/`transitionIn` already follow. */
export interface ChromaKeySettings {
  /** Hex, e.g. "#00ff00" — the color to key OUT (make transparent). */
  color: string;
  /** 0..1, FFmpeg's own `similarity` convention: a pixel within this normalized color-distance of
   *  `color` is keyed out entirely. Larger keys out more shades/lighting variation around `color`, at
   *  the risk of also eating into the subject if it shares that color. */
  similarity: number;
  /** 0..1, FFmpeg's own `blend` convention: pixels JUST beyond `similarity`'s cutoff ramp from fully
   *  transparent to fully opaque over this additional distance, instead of a hard edge — the standard
   *  "feather the key's boundary" control every chroma-key tool exposes, just named for what it does
   *  (how smooth the cutoff is) rather than FFmpeg's more implementation-flavored `blend`. */
  smoothness: number;
}

/** The default a freshly-enabled chroma key starts with — standard green screen, FFmpeg's own
 *  similarity default (0.01) nudged up to 0.4 since that default keys out almost nothing in practice
 *  (real green-screen footage has far more color variation than a studio-perfect 0x00FF00 sample), plus
 *  a touch of smoothness so the cutout edge isn't a hard, aliased line by default. */
export const DEFAULT_CHROMA_KEY: ChromaKeySettings = {
  color: "#00ff00",
  similarity: 0.4,
  smoothness: 0.1,
};

/** One control point of a `ColorCurve`, both axes normalized 0..1 (input level → output level). */
export interface CurvePoint {
  x: number;
  y: number;
}

/** Control points for one tone curve, sorted ascending by `x`. Always includes the two fixed endpoint
 *  anchors (x=0 and x=1) — the UI (`CurveEditor`) never lets those be deleted, only dragged vertically;
 *  interior points are optional. This type only stores the raw editable points — `timeline/colorCurves.ts`'s
 *  spline evaluator is what turns a `ColorCurve` into an actually renderable/appliable LUT. */
export type ColorCurve = CurvePoint[];

/** The untransformed default — a flat diagonal, (0,0) to (1,1), no adjustment. */
export const IDENTITY_CURVE: ColorCurve = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

/** Per-clip RGB curves color grading — four independently-editable curves (the combined "master" tab
 *  plus one per channel), composed per-channel as `master(channel(input))` — see
 *  `timeline/colorCurves.ts`'s `composeLuts` for why that specific order (channel first, master on top),
 *  verified against FFmpeg's own `libavfilter/vf_curves.c` composition loop. This order matters because
 *  export hands these SAME control points straight to FFmpeg's `curves=` filter (`export/curvesFilter.ts`)
 *  rather than a precomputed LUT, so preview and export need to agree on composition order to actually
 *  look the same. */
export interface ColorGrading {
  master: ColorCurve;
  red: ColorCurve;
  green: ColorCurve;
  blue: ColorCurve;
}

/** The untransformed default — every channel a flat diagonal. Mirrors `IDENTITY_EFFECTS`. */
export const IDENTITY_COLOR_GRADING: ColorGrading = {
  master: IDENTITY_CURVE,
  red: IDENTITY_CURVE,
  green: IDENTITY_CURVE,
  blue: IDENTITY_CURVE,
};

/** Mirrors `isIdentityEffects` — both `setClipColorGrading` (identity-collapse) and `buildExportPlan`
 *  (plain vs. curves-aware filter chain) key off this. A curve counts as identity only when it's EXACTLY
 *  the two-point diagonal `IDENTITY_CURVE` is. */
export function isIdentityColorGrading(grading: ColorGrading | undefined): boolean {
  if (!grading) return true;
  const isIdentity = (c: ColorCurve) =>
    c.length === 2 && c[0].x === 0 && c[0].y === 0 && c[1].x === 1 && c[1].y === 1;
  return (
    isIdentity(grading.master) &&
    isIdentity(grading.red) &&
    isIdentity(grading.green) &&
    isIdentity(grading.blue)
  );
}

/** One point in a keyframed animation for a clip property-group (`ClipTransform`, `ClipEffects`, or
 *  `ColorGrading` — never a single field of any of them — see `Clip.transformKeyframes`'s own doc
 *  comment for why). `time` is CLIP-WINDOW-relative seconds (0 = this clip's own `timelineStart`) — the
 *  same "elapsed" space `timeline/textAnimation.ts`'s `elapsedSeconds` and `PlaybackEngine`'s own
 *  repeated inline `time - clip.timelineStart` already use, NOT source-media time. `value` is the FULL
 *  object, never a sparse per-field patch — matches this codebase's pervasive "whole value stored, never
 *  a partial patch" convention (`ClipOverride`, `patchTransform`'s merge-then-replace-whole-object
 *  shape). `id` is a stable identifier (`newId("kf")`) so the UI can select/drag/delete one keyframe
 *  without relying on array index, which shifts under insert. */
export interface Keyframe<T> {
  id: string;
  time: number;
  value: T;
}
export type TransformKeyframe = Keyframe<ClipTransform>;
export type EffectsKeyframe = Keyframe<ClipEffects>;
export type TextStyleKeyframe = Keyframe<TextStyle>;
/** Held (never interpolated) between keyframes — see `Clip.colorGradingKeyframes`'s own doc comment for
 *  why smoothly cross-fading between two differently-shaped curves isn't attempted in v1. */
export type ColorGradingKeyframe = Keyframe<ColorGrading>;

/** Every transition style either renderer can produce. Kept to the subset of FFmpeg's own `xfade`
 *  filter's transition names (see `TRANSITION_XFADE_NAME` in `export/buildExportPlan.ts`) that's been
 *  part of that filter since its ORIGINAL introduction (FFmpeg 4.3) — a newer name like `xfade`'s own
 *  `"zoomin"` (added in 6.1) risks failing export outright against an older bundled `ffmpeg-static`
 *  build, which a name this old can't. `PlaybackEngine`'s canvas preview groups these into FOUR
 *  rendering families (dissolve, wipe, slide, circle — see its own `transitionFamily`), not ten
 *  independent implementations; export always renders the exact distinct FFmpeg filter regardless of
 *  which family the preview approximated it with. */
export type TransitionType =
  | "crossfade"
  | "dissolve"
  | "wipeLeft"
  | "wipeRight"
  | "wipeUp"
  | "wipeDown"
  | "slideLeft"
  | "slideRight"
  | "slideUp"
  | "slideDown"
  | "circleOpen"
  | "circleClose";

/** A continuous MOTION effect for a text clip, distinct from `transitionIn`/`transitionOut` — those
 *  are one-shot events at a clip's own edges (a cut blended/wiped/dissolved into or out of), rendered
 *  identically in preview and export; this is a periodic or progressive effect that plays across the
 *  clip's own ENTIRE visible duration, exactly like the "Bounce"/"Pulse"/"Typewriter" text presets a
 *  captioning or short-form-video tool would offer. `timeline/textAnimation.ts` is the one place the
 *  actual motion math lives (`computeTextAnimationTransform`/`typewriterVisibleContent`) — kept as pure
 *  functions of elapsed time so they're directly unit-testable without a canvas, the same reasoning
 *  `PlaybackEngine.transitionFamily` already follows.
 *
 *  `bounce`/`pulse`/`wiggle`/`typewriter` all render for real in export (see `buildExportPlan.ts`'s
 *  `buildDrawTextFilter`/`buildRotatedDrawTextFilter`) — `bounce`/`pulse` as time-varying `y=`/
 *  `fontsize=` FFmpeg expressions (verified: `x`/`y` there are already `text_w`/`text_h`-relative
 *  expressions FFmpeg re-evaluates every frame, so they re-center correctly on their own as the size/
 *  position animates), `wiggle` via the same ROTATED-text pipeline a static `style.rotationDeg` already
 *  uses (a time-varying `rotate` angle with a FIXED worst-case buffer size — `rotate`'s own `ow=`/`oh=`
 *  can't themselves depend on `t`), and `typewriter` via one chained `drawtext` per revealed-prefix
 *  state (`buildTypewriterDrawTextCalls`), gated to its own `enable=` window. A nonzero STATIC
 *  `style.rotationDeg` combined with `bounce`/`pulse`/`typewriter` is a documented scope cut — that
 *  combination renders as plain static rotated text, animation ignored (the rotated path's frame-center
 *  pivot and the plain path's `text_w`-relative centering are mutually exclusive constructions).
 *
 *  `wordHighlight` renders for real too, but through an entirely different FFmpeg filter —
 *  `subtitles=` (libass), not `drawtext` — since coloring individual WORDS within one string is beyond
 *  what `drawtext` can express, and there's no way to feed one `drawtext` call's measured `text_w` into
 *  another's `x=` (confirmed by re-deriving the filtergraph's actual data-flow model). libass already
 *  links HarfBuzz/FreeType/FriBidi, so it shapes Khmer's complex script (subscript consonants, vowel-
 *  sign reordering) correctly — the reason this reuses libass rather than this app computing its own
 *  glyph advance widths, which would NOT reproduce that shaping correctly. See
 *  `buildWordHighlightSubtitlesFilter`'s own comment for the full reasoning, and `AssFontMetrics` in
 *  `project/fonts.ts` for how a font's real (non-`cssFamily`) name and correct on-screen size are
 *  resolved for libass specifically. Falls back to plain static full text (same as before this existed)
 *  when the exporter hasn't wired up ASS support — currently true only for native/mobile export, where
 *  the bundled FFmpeg engine's own libass support hasn't been confirmed.
 *
 *  `wordHighlight` is the odd one out here: a karaoke/lyrics-style effect where exactly one word is
 *  drawn in a highlight color at a time, jumping word-to-word left-to-right as the clip plays, timed to
 *  spread evenly across the clip's own duration (see `timeline/textAnimation.ts`'s `activeWordIndex`).
 *  Its highlight color is genuinely configurable (`Clip.textAnimation.highlightColor`) — the other four
 *  are fixed motion curves with nothing meaningful to expose as a setting yet. */
export type TextAnimationType = "bounce" | "pulse" | "wiggle" | "typewriter" | "wordHighlight";

/** One clip on a track. The heart of non-destructive editing: a clip is a *reference* to a slice of
 *  a source asset plus a position, never a copy of media. Trimming a 10-minute source down to 15
 *  seconds only moves `sourceIn`/`sourceOut` — the file on disk is never touched. */
export interface Clip {
  id: string;
  assetId: string;
  /** Seconds into the source media where this clip begins. */
  sourceIn: number;
  /** Seconds into the source media where this clip ends (exclusive). Always > `sourceIn`. */
  sourceOut: number;
  /** Seconds along the timeline where this clip begins. */
  timelineStart: number;
  /** Absent means untransformed (equivalent to `IDENTITY_TRANSFORM`) — an untouched clip's JSON stays
   *  small, an older `project.json` written before this field existed loads unchanged, and both
   *  renderers can take a cheaper, already-tested code path when there's nothing to apply. */
  transform?: ClipTransform;
  /** Absent means `IDENTITY_EFFECTS` — same reasoning as `transform`. */
  effects?: ClipEffects;
  /** Absent means `IDENTITY_COLOR_GRADING` — same reasoning as `transform`/`effects`. Video/image clips
   *  only, same gating as `effects`. See `ColorGrading`'s own doc comment for the master/channel
   *  composition order this relies on. */
  colorGrading?: ColorGrading;
  /** Present only when Transform keyframing is ARMED for this clip — ordered ascending by `time`, each
   *  `time` clamped to `[0, clipDuration(clip)]`. When present and non-empty, this — NOT `transform` —
   *  is what both renderers resolve, via `timeline/keyframes.ts`'s `resolveClipTransform`. `transform`
   *  itself is left untouched underneath (never read nor deleted while keyframes exist) specifically so
   *  disarming keyframing has a well-defined static value to bake down to. Absent means "not
   *  keyframed" — the existing single-`transform` behavior, completely unchanged; every clip that never
   *  uses this feature sees zero difference. One keyframe = the FULL `ClipTransform` moving together
   *  (all of offsetX/offsetY/scale/rotationDeg/crop at once), not independent per-field sub-tracks —
   *  matches this codebase's "whole object, never a sparse patch stored" convention and keeps the
   *  Inspector UI to one mini-timeline per property-group rather than nine. Video/image clips only,
   *  same gating as `transform` itself. */
  transformKeyframes?: TransformKeyframe[];
  /** Mirrors `transformKeyframes`, for `ClipEffects` — see its own doc comment for the full reasoning. */
  effectsKeyframes?: EffectsKeyframe[];
  /** Mirrors `transformKeyframes`, for `ColorGrading` — same "present+non-empty is what both renderers
   *  resolve, absent means not keyframed" contract, EXCEPT interpolation: unlike transform/effects
   *  (plain numeric `lerp()`), a keyframed curve is HELD, not blended, between keyframes —
   *  `resolveClipColorGrading` (`timeline/keyframes.ts`) just picks whichever keyframe currently applies.
   *  Control points have no natural pointwise correspondence between two differently-shaped curves
   *  (different point counts/positions), so cross-fading control points (or blending the derived LUTs,
   *  which can't be re-edited back into control points for the UI) isn't attempted in v1 — mirrors
   *  `resolveTextStyle`'s own existing precedent of holding non-numeric fields rather than interpolating
   *  them. A clip with two very different curve keyframes will visibly SNAP at the keyframe boundary
   *  rather than crossfade — a deliberate v1 simplification, not an oversight. */
  colorGradingKeyframes?: ColorGradingKeyframe[];
  /** Mirrors `transformKeyframes`, for a TEXT clip's `TextStyle` — same "present+non-empty is what both
   *  renderers resolve, absent means not keyframed" contract. Lives on the CLIP (not the `Asset`, where
   *  the rest of `TextStyle` lives) for the same reason `transformKeyframes` does: `Keyframe.time` is
   *  clip-window-relative, a placement concept, not an asset one — if the same text asset were ever
   *  placed as two clips, each placement needs its own independent keyframe timeline. `resolveTextStyle`
   *  (`timeline/keyframes.ts`) only animates TextStyle's numeric fields (offsetX/offsetY/fontSize/
   *  rotationDeg/strokeWidth/shadowOffsetX/shadowOffsetY/lineHeightMultiplier) — font/color/bold/italic/
   *  align/backgroundColor/strokeColor/shadowColor have no sensible continuous interpolation, so a
   *  bracketing pair holds the EARLIER keyframe's value for those, same "lerp what's numeric, hold what
   *  isn't" split `resolveTextStyle`'s own comment documents. Video/image clips never carry this field —
   *  same gating as `transformKeyframes` itself. */
  textStyleKeyframes?: TextStyleKeyframe[];
  /** Absent means no chroma key (plain opaque video) — same "small JSON, cheap default path"
   *  reasoning as `transform`. Video/image clips only, same gating as `transform`/`effects` — see
   *  `ChromaKeySettings`'s own doc comment for the full reasoning and the preview/export parity goal. */
  chromaKey?: ChromaKeySettings;
  /** A crossfade FROM whatever clip immediately precedes this one on the same track, INTO this one —
   *  or, when there's no such predecessor (this clip opens the track, or a gap opened up before it),
   *  a fade in from black (video/image), from fully transparent (text), or from silence (audio)
   *  instead. Absent means a plain hard cut — same "small JSON, cheap default path" reasoning as
   *  `transform`.
   *
   *  Deliberately NOT validated or repaired by any edit operation (`moveClip`/`trimClip`/`splitClip`/
   *  `carveRange` all stay completely unaware of this field) — `timeline/transitions.ts`'s
   *  `findTransitionPartner` resolves it fresh, AT USE TIME, into whichever of the two shapes above
   *  currently applies: adjacent (`clipEnd(prev) === this.timelineStart`, zero gap) resolves to a
   *  real blend partner; anything else (no predecessor, or one that's since drifted away) resolves to
   *  a solo fade — `duration` is clamped to fit the CURRENT clip length either way, never dropped
   *  outright. So an edit that breaks adjacency (dragging a gap open, trimming a clip too short)
   *  doesn't need cleanup logic threaded through every existing edit path — the transition just
   *  quietly becomes a solo fade instead of erroring or vanishing. Also valid on a TEXT or AUDIO clip,
   *  not just video/image — `findTransitionPartner` itself is track-kind-agnostic, and every renderer
   *  blends an adjacent pair the same way it blends video ones (text: see
   *  `PlaybackEngine.drawTextLayer`'s own comment; audio: `buildExportPlan.ts`'s
   *  `buildAudioTrackStream`, which always renders `type` as a plain FFmpeg `acrossfade` regardless of
   *  which of the 12 `TransitionType` values is stored — the video-only wipe/slide/circle shapes have
   *  no audio analog, so the Inspector's Style picker doesn't even offer them for an audio clip). */
  transitionIn?: { duration: number; type: TransitionType };
  /** A fade OUT to black (video/image), to fully transparent (text), or to silence (audio), over this
   *  clip's own final `duration` seconds. Unlike `transitionIn`, there is no "blend into the next
   *  clip" shape here — that boundary is already fully described by the NEXT clip's own
   *  `transitionIn` (see its doc comment), so `transitionOut` is ALWAYS a solo effect:
   *  `timeline/transitions.ts`'s `findTransitionOut` resolves it to `null` — same as absent —
   *  whenever a genuine successor exists at all on this track, whether or not that successor actually
   *  set a `transitionIn` of its own. Meaningful only when nothing follows this clip (it's the last
   *  one on the track, or a gap opens up right after it). Absent means no fade-out, same "small JSON,
   *  cheap default path" reasoning as `transform`. Also valid on a TEXT or AUDIO clip, not just
   *  video/image — same reasoning as `transitionIn`. */
  transitionOut?: { duration: number; type: TransitionType };
  /** A continuous motion effect over this clip's own visible duration — see `TextAnimationType`'s own
   *  doc comment for what it is and its preview-only export scope cut. Meaningful only on a TEXT clip
   *  (a video/image clip can carry the field structurally, same "never validated up front" reasoning
   *  as `transitionIn`, but `PlaybackEngine`/`buildExportPlan` only ever look at it on the text render
   *  path). Absent means no animation, same "small JSON, cheap default path" reasoning as `transform`.
   *  `highlightColor` only means anything for `type: "wordHighlight"` (see its own doc comment) —
   *  structurally present-but-ignored for the other four, same "valid but inert" shape `strokeWidth`
   *  already has when `strokeColor` is unset. `speed` is a multiplier on elapsed time (absent/1 = the
   *  animation's own normal pace, 2 = twice as fast, 0.5 = half) applied uniformly by
   *  `PlaybackEngine.drawAnimatedText` BEFORE calling any of `timeline/textAnimation.ts`'s pure
   *  functions — so none of them need their own notion of speed, they just see a bigger or smaller
   *  elapsed-time number than the clip's real playhead position. */
  textAnimation?: { type: TextAnimationType; highlightColor?: string; speed?: number };
  /** Meaningful only on a TEXT clip, same gating as `textAnimation`. Absent means no crop (full frame
   *  visible), same "small JSON, cheap default path" reasoning as `transform`. See `TextCrop`'s own doc
   *  comment for why this is a separate, frame-space mask rather than reusing `ClipTransform.crop`. */
  textCrop?: TextCrop;
  /** Silences this clip's OWN embedded audio, independent of the track it's on. Distinct from a
   *  video track's `visible` flag (which already silences a hidden clip's audio as a side effect of
   *  hiding it — muting a clip you can still SEE is a genuinely different thing to ask for) and from
   *  an audio track's `muted`/`solo` (which apply to every clip on that track uniformly). Absent
   *  means audible, same "small JSON, cheap default path" reasoning as `transform`. */
  mutedAudio?: boolean;
  /** Linear volume multiplier for this clip's OWN embedded audio, applied independently of
   *  `mutedAudio` (a hard override — a muted clip stays silent regardless of `gain`; see
   *  `AudioMixEngine.syncVideoClipAudio`, which folds both into one target on a dedicated `GainNode`).
   *  Routed through Web Audio (`AudioMixEngine`), not a `<video>`/`<audio>` element's native `.volume`
   *  (which the browser caps at 1) — so this can genuinely exceed 1 for real amplification, not just
   *  attenuation; see `setClipGain`'s own ceiling for the UI-facing bound. Absent means `1` (unchanged),
   *  same "small JSON, cheap default path" reasoning as `transform`/`effects`. */
  gain?: number;
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  clips: Clip[];
  locked: boolean;
  /** Video and text tracks — hidden tracks are skipped by the compositor and by export. */
  visible: boolean;
  /** Audio tracks only. */
  muted: boolean;
  solo: boolean;
  /** Linear volume multiplier for every clip on this track, on top of each clip's OWN `Clip.gain` —
   *  the two multiply together (see `PlaybackEngine.activeAudioClips`), the same "track fader on top
   *  of a per-clip trim" relationship a real mixing console has. Audio tracks only, same scope cut as
   *  `muted`/`solo` — structurally present-but-ignored on a video/text track. Routed through a
   *  dedicated per-track `GainNode` in `AudioMixEngine`, not folded into each clip's own node,
   *  specifically so dragging this fader live doesn't restart any `AudioBufferSourceNode` — only the
   *  one scalar on the shared node moves. Absent means `1` (unchanged), same "small JSON, cheap
   *  default path" reasoning as `Clip.gain`; the `[0,4]` clamp `setTrackGain` applies is an ordinary
   *  input-sanity bound, not a `GainNode` ceiling. */
  gain?: number;
  /** Stereo pan for every clip on this track, applied via the equal-power law (a plain crossfade
   *  between L/R, not a simple L/R gain split — the same algorithm a native Web Audio `StereoPannerNode`
   *  computes, and what `AudioMixEngine`'s per-track `StereoPannerNode` uses directly for live preview).
   *  -1 is hard left, 0 is center, 1 is hard right. Applied AFTER `gain` in the signal chain — see
   *  `AudioMixEngine`'s own per-track node-chain comment for why panning sits downstream of the fader
   *  rather than upstream of it. Audio tracks only, same scope cut as `muted`/`solo`/`gain` —
   *  structurally present-but-ignored on a video/text track. Absent means `0` (center), same "small
   *  JSON, cheap default path" reasoning as `Clip.gain`/`Track.gain`; the `[-1,1]` clamp `setTrackPan`
   *  applies is an ordinary input-sanity bound matching `StereoPannerNode.pan`'s own natural range. Not
   *  applied to the master bus — see `Sequence.masterGain`'s sibling comment on why there's no
   *  `Sequence.masterPan`: panning the whole mix isn't a per-channel routing question the same way it is
   *  for an individual track, so the Mixer's Master strip has a fader but no pan knob. */
  pan?: number;
}

export interface Sequence {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  tracks: Track[];
  /** Overall mix level — the single master fader in the Mixer dialog, multiplying every audio track's
   *  already-track-gained, already-clip-gained signal. Lives here (not a separate mixer-settings
   *  object) because there's exactly one per sequence, same cardinality as `width`/`height`/`fps`.
   *  Absent means `1`, same convention as `Track.gain`/`Clip.gain`. Applied live via
   *  `AudioMixEngine.setMasterGain` (its `masterGain` node has existed since the engine's own
   *  constructor, reserved for exactly this) and at export time as a final `volume=` stage after the
   *  last `amix`, in both `buildExportPlan.ts` and `buildAudioOnlyExportPlan.ts`. */
  masterGain?: number;
}

export interface ExportSettings {
  width: number;
  height: number;
  fps: number;
  /** H.264 CRF — lower is higher quality. 18 is visually near-lossless, 23 is FFmpeg's default. */
  crf: number;
  audioBitrateKbps: number;
}

export interface Project {
  schemaVersion: number;
  id: string;
  /** The BP Studio project this belongs to — how a VStudio project is located on disk. */
  bpProjectId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  assets: Asset[];
  sequence: Sequence;
  exportSettings: ExportSettings;
}

/** How long a still image occupies the timeline when first placed, in seconds. */
export const IMAGE_DEFAULT_DURATION = 5;

/** How long a text clip occupies the timeline when first placed, in seconds — same reasoning as
 *  `IMAGE_DEFAULT_DURATION`: text has no intrinsic duration of its own. */
export const TEXT_DEFAULT_DURATION = 5;

/** The "Short" preset from the product spec — vertical 1080×1920 @ 30fps, the default because
 *  short-form vertical video is VStudio's primary target. */
export const SHORT_PRESET = { width: 1080, height: 1920, fps: 30 } as const;

export const RESOLUTION_PRESETS = [
  { label: "Vertical 1080 × 1920", width: 1080, height: 1920 },
  { label: "Landscape 1920 × 1080", width: 1920, height: 1080 },
  { label: "Square 1080 × 1080", width: 1080, height: 1080 },
] as const;

export const FPS_PRESETS = [24, 25, 30, 50, 60] as const;
