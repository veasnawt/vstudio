/** The core project model. Everything here is PLAIN SERIALIZABLE DATA — no class instances, no
 *  functions, no Dates — so `structuredClone` and a JSON round-trip are both trivially lossless.
 *  That property is what makes undo (which clones state) and save/reopen (which JSON-round-trips it)
 *  correct by construction rather than by careful maintenance. */

/** Bumped whenever a change to these types would make an older `project.json` misread rather than
 *  merely incomplete. `deserializeProject` refuses anything newer than it understands instead of
 *  silently mangling a project a future version wrote. */
export const PROJECT_SCHEMA_VERSION = 1;

export type AssetKind = "video" | "audio" | "image";
export type TrackKind = "video" | "audio";

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
   *  use themselves, audio has none). */
  thumbnailRelPath?: string;
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
}

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
  /** Silences this clip's OWN embedded audio, independent of the track it's on. Distinct from a
   *  video track's `visible` flag (which already silences a hidden clip's audio as a side effect of
   *  hiding it — muting a clip you can still SEE is a genuinely different thing to ask for) and from
   *  an audio track's `muted`/`solo` (which apply to every clip on that track uniformly). Absent
   *  means audible, same "small JSON, cheap default path" reasoning as `transform`. */
  mutedAudio?: boolean;
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  clips: Clip[];
  locked: boolean;
  /** Video tracks only — hidden tracks are skipped by the compositor and by export. */
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

/** The "Short" preset from the product spec — vertical 1080×1920 @ 30fps, the default because
 *  short-form vertical video is VStudio's primary target. */
export const SHORT_PRESET = { width: 1080, height: 1920, fps: 30 } as const;

export const RESOLUTION_PRESETS = [
  { label: "Vertical 1080 × 1920", width: 1080, height: 1920 },
  { label: "Landscape 1920 × 1080", width: 1920, height: 1080 },
  { label: "Square 1080 × 1080", width: 1080, height: 1080 },
] as const;

export const FPS_PRESETS = [24, 25, 30, 50, 60] as const;
