/** Pure FFmpeg argument builders for media-library asset generation (thumbnail, filmstrip, waveform)
 *  — extracted from `studios/vstudio/app/api/vstudio/_lib/ffmpeg.ts` so the exact same command shape
 *  is available to more than one EXECUTOR. `_lib/ffmpeg.ts` still owns actually running these (via
 *  Node's `child_process.execFile`, server-side); the native mobile host's own FFmpeg plugin (backed
 *  by ffmpeg-kit's native SDKs, not Node) is the other consumer, and needs the identical argv this
 *  module builds — two hand-maintained copies of these filter graphs would drift apart over time, a
 *  waveform that looks subtly different on mobile vs. web being exactly the kind of bug that's easy
 *  to ship and hard to notice.
 *
 *  Kept as pure `(input, output, ...) -> string[]` functions — no filesystem or process knowledge —
 *  for the same reason `buildExportPlan.ts` is pure: the hardest part (getting the filter graph
 *  right) should be unit-testable without spawning anything or touching a disk. */

/** Grabs a single frame as a JPEG for the media library.
 *  `-ss` before `-i` seeks by keyframe, which is dramatically faster on long files and plenty
 *  accurate for a thumbnail. */
export function buildThumbnailArgs(input: string, output: string, atSeconds: number): string[] {
  return [
    "-ss", String(Math.max(0, atSeconds)),
    "-i", input,
    "-frames:v", "1",
    "-vf", "scale=320:-2",
    "-y", output,
  ];
}

/** How many frames `buildFilmstripArgs` samples, and the fixed size (pixels) each is scaled/cropped to
 *  — fixed, not proportional to the source's own aspect ratio, so every sampled frame is IDENTICALLY
 *  sized and the sprite tiles into a clean, uniform grid regardless of whether the source is portrait,
 *  landscape, or square. */
export const FILMSTRIP_FRAME_COUNT = 8;
const FILMSTRIP_TILE_WIDTH = 160;
const FILMSTRIP_TILE_HEIGHT = 90;

/** Builds args for ONE sprite-sheet image containing `FILMSTRIP_FRAME_COUNT` frames evenly spaced
 *  across the source's duration, tiled left-to-right in a single row — what `TimelineClip` tiles
 *  across a clip's width for a real (if approximate) filmstrip, reusing the exact same CSS
 *  `background-repeat` trick a single-frame thumbnail already used: since the sprite is just a WIDER
 *  image (several frames side by side instead of one), the SAME "repeat this image, sized to the
 *  clip's own height" styling naturally shows frame 1, 2, ... N, 1, 2, ... as it repeats, with no
 *  frontend tiling-index logic needed at all — the image data alone is what makes the difference.
 *
 *  `fps=N/duration` (not `select`+specific timestamps) is what makes ONE filter expression produce
 *  evenly-spaced samples regardless of the source's own frame rate or duration, including sources
 *  shorter than `FILMSTRIP_FRAME_COUNT` seconds — `fps` duplicates frames as needed to hit the target
 *  rate rather than requiring the source to already contain that many distinct frames. `scale=...:
 *  force_original_aspect_ratio=increase,crop=...` is a fixed-size "cover" crop (fill the tile, crop the
 *  overflow) so every source aspect ratio still produces uniformly-sized tiles for `tile` to grid. */
export function buildFilmstripArgs(input: string, output: string, durationSeconds: number): string[] {
  const safeDuration = Math.max(0.1, durationSeconds);
  return [
    "-i", input,
    "-frames:v", "1",
    "-vf",
    `fps=${FILMSTRIP_FRAME_COUNT}/${safeDuration},` +
      `scale=${FILMSTRIP_TILE_WIDTH}:${FILMSTRIP_TILE_HEIGHT}:force_original_aspect_ratio=increase,` +
      `crop=${FILMSTRIP_TILE_WIDTH}:${FILMSTRIP_TILE_HEIGHT},tile=${FILMSTRIP_FRAME_COUNT}x1`,
    "-y", output,
  ];
}

/** Fixed size (pixels) for the waveform PNG — like `FILMSTRIP_TILE_WIDTH/HEIGHT`, not proportional to
 *  anything about the source (audio has no aspect ratio); high enough to stay reasonably crisp once
 *  `TimelineClip` stretches it to match an audio clip's own on-screen width via CSS. */
const WAVEFORM_WIDTH = 1600;
const WAVEFORM_HEIGHT = 100;
// Tailwind's emerald-400, matching the audio-clip color `TimelineClip` already uses for the clip's own
// border/background — so the peaks read as "this clip's own waveform," not an unrelated accent color.
const WAVEFORM_COLOR = "0x34d399";

/** Builds args for ONE waveform PNG spanning the source's FULL audio duration, peaks drawn on a
 *  genuinely transparent background — the `color=c=black@0` lavfi input + `overlay` pair already
 *  proven in `buildExportPlan.ts`'s multi-track compositing (see its own comment on `transparent`),
 *  reused here for the same reason: `showwavespic` alone renders on an opaque black canvas, and a
 *  fixed backdrop color would clash with the clip's own hover/selection tinting instead of showing
 *  through it. `aformat=channel_layouts=mono` collapses stereo to one trace — a timeline clip is one
 *  strip, not two channels' worth of vertical space.
 *
 *  `dynaudnorm` runs first, ANALYSIS-ONLY — it only shapes this throwaway PNG, never the real audio
 *  (playback/export both read the original file untouched). Confirmed empirically (this filter's
 *  parameters are exactly the kind of thing ARCHITECTURE.md's own discipline says to verify against
 *  the real binary, not assume): `showwavespic` alone renders a raw sample's LINEAR amplitude, so a
 *  file recorded at a conservative level — extremely common for voiceovers and dialog, which is
 *  exactly the audio most likely to end up on a VStudio timeline — comes out as a near-invisible flat
 *  line even though the content has real dynamic shape. `dynaudnorm`'s OWN defaults (500ms frames)
 *  were tested first and left the line just as flat; a much shorter, more locally-reactive window
 *  (`f=150:g=15`) is what actually pulled out a legible, non-flat envelope on real test audio, and
 *  doesn't visibly over-normalize (flatten into a solid block) already-normal-loudness content either. */
export function buildWaveformArgs(input: string, output: string): string[] {
  return [
    "-i", input,
    "-f", "lavfi", "-i", `color=c=black@0:s=${WAVEFORM_WIDTH}x${WAVEFORM_HEIGHT}`,
    "-filter_complex",
    `[0:a]aformat=channel_layouts=mono,dynaudnorm=f=150:g=15,` +
      `showwavespic=s=${WAVEFORM_WIDTH}x${WAVEFORM_HEIGHT}:colors=${WAVEFORM_COLOR}[wave];` +
      `[1:v][wave]overlay=format=auto[out]`,
    "-map", "[out]",
    "-frames:v", "1",
    "-y", output,
  ];
}

/** Builds args for extracting one clip's trimmed source range to a standalone file — the first step
 *  of the "Remove Object" inpainting pipeline, which needs a plain video file to send to the cloud
 *  model, not a reference into a larger source the model has no notion of trimming.
 *
 *  `-ss` BEFORE `-i` (fast input-side seeking, snapped to the nearest keyframe at or before the
 *  target) rather than after `-i` (frame-accurate but slow, decodes from the start every time) — a
 *  few frames of imprecision at the head doesn't matter here the way it would for the main timeline's
 *  own export, because the very next pipeline step probes THIS file's own actual resulting duration
 *  (not `end - start`) before building the matching mask video, so the two always agree with each
 *  other regardless of exactly where the seek landed. Re-encodes (`-c:v libx264`, not `-c copy`)
 *  since `start`/`end` are arbitrary trim points, not necessarily keyframe-aligned — a stream copy can
 *  only cut on keyframes. `-an`: the inpainting model needs no audio, and the result won't carry any
 *  either (a v1 scope cut, not an oversight). */
export function buildExtractClipArgs(input: string, output: string, startSeconds: number, endSeconds: number): string[] {
  const start = Math.max(0, startSeconds);
  // Clamped against the ALREADY-clamped start, not the raw one — otherwise a negative `endSeconds`
  // (e.g. both start and end negative) could clamp to a value below the real `-ss`, producing an
  // inverted (and ffmpeg-rejected) range instead of the empty-but-valid one intended.
  const end = Math.max(start, endSeconds);
  return [
    "-ss", String(start),
    "-to", String(end),
    "-i", input,
    "-c:v", "libx264",
    "-an",
    "-y", output,
  ];
}

/** Builds args for a black/white mask video for the "Remove Object" inpainting feature — solid black
 *  everywhere except a solid white rectangle over the region to erase, matching the video-inpainting
 *  convention (white = inpaint this, black = keep) the ProPainter model expects. A single synthetic
 *  `color` lavfi source (the same trick `buildWaveformArgs` above already uses for its transparent
 *  backdrop) plus one `drawbox` filter — no real video input needed at all, just the extracted clip's
 *  own already-probed dimensions/duration, since the mask has to match that file frame-for-frame.
 *
 *  `-pix_fmt yuv420p` matters here specifically: a raw black/white `drawbox` output can otherwise land
 *  in a pixel format an inpainting model's ingestion misreads as non-binary, so it's pinned explicitly
 *  rather than left to ffmpeg's own default for a `lavfi` source. */
export function buildMaskVideoArgs(
  output: string,
  width: number,
  height: number,
  fps: number,
  durationSeconds: number,
  rect: { x: number; y: number; width: number; height: number }
): string[] {
  const safeDuration = Math.max(0.1, durationSeconds);
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  return [
    "-f", "lavfi",
    "-i", `color=c=black:s=${width}x${height}:r=${fps}:d=${safeDuration}`,
    "-vf", `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=white:t=fill`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-y", output,
  ];
}

/** Builds args for a black/white mask IMAGE (single still frame, not a video) — the local ProPainter
 *  CLI's `--mask` flag only accepts a static image or a folder of per-frame images, never a video file
 *  (unlike the cloud providers' input schemas, which take a mask video). Since VStudio's "Remove
 *  Object" already applies ONE rectangle across a clip's whole duration, a single static image is both
 *  sufficient and simpler than `buildMaskVideoArgs` above — no duration/fps/video-codec concerns. */
export function buildMaskImageArgs(
  output: string,
  width: number,
  height: number,
  rect: { x: number; y: number; width: number; height: number }
): string[] {
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  return [
    "-f", "lavfi",
    "-i", `color=c=black:s=${width}x${height}`,
    "-vf", `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=white:t=fill`,
    "-frames:v", "1",
    "-y", output,
  ];
}
