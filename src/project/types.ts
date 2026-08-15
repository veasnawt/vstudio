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
  /** A crossfade FROM whatever clip immediately precedes this one on the same track, INTO this one.
   *  Absent means a plain hard cut — same "small JSON, cheap default path" reasoning as `transform`.
   *
   *  Deliberately NOT validated or repaired by any edit operation (`moveClip`/`trimClip`/`splitClip`/
   *  `carveRange` all stay completely unaware of this field) — a transition only actually renders
   *  when `timeline/transitions.ts`'s `findTransitionPartner` confirms, AT USE TIME, that the
   *  preceding clip is still genuinely adjacent (`clipEnd(prev) === this.timelineStart`, zero gap)
   *  and `duration` still fits within both clips' CURRENT lengths. An edit that breaks either
   *  precondition (dragging a gap open, trimming a clip too short) just makes the transition stop
   *  applying — falls back to a plain cut — rather than needing cleanup logic threaded through every
   *  existing edit path. `type` is a real field, not hardcoded, so a future style is just a new union
   *  member — but `"crossfade"` is the only value worth setting today. */
  transitionIn?: { duration: number; type: "crossfade" };
  /** Silences this clip's OWN embedded audio, independent of the track it's on. Distinct from a
   *  video track's `visible` flag (which already silences a hidden clip's audio as a side effect of
   *  hiding it — muting a clip you can still SEE is a genuinely different thing to ask for) and from
   *  an audio track's `muted`/`solo` (which apply to every clip on that track uniformly). Absent
   *  means audible, same "small JSON, cheap default path" reasoning as `transform`. */
  mutedAudio?: boolean;
  /** Linear volume multiplier for this clip's OWN embedded audio, applied independently of
   *  `mutedAudio` (a hard override — a muted clip stays silent regardless of `gain`, the browser's own
   *  `element.muted`/`.volume` semantics, so toggling mute never loses a gain setting). `0..1`, not a
   *  wider amplification range: the preview plays this back through a plain `<video>`/`<audio>`
   *  element's native `.volume`, which the browser itself caps at 1 — going higher would need routing
   *  through a Web Audio gain node, a real architecture change genuinely out of scope here. Absent
   *  means `1` (unchanged), same "small JSON, cheap default path" reasoning as `transform`/`effects`. */
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
}

export interface Sequence {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  tracks: Track[];
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
