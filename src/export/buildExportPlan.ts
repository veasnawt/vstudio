import { clipDuration, clipEnd, findAsset, sequenceDuration } from "../project/createProject.ts";
import type { Clip, ClipTransform, Project } from "../project/types.ts";
import { isIdentityTransform } from "../project/types.ts";
import { audibleClips } from "../timeline/queries.ts";

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

type Segment =
  | { kind: "clip"; clip: Clip; hasAudio: boolean; isImage: boolean; path: string; duration: number }
  | { kind: "gap"; duration: number };

/** Walks the track start-to-end, emitting a segment per clip and a gap wherever the timeline is
 *  empty between them. */
function buildSegments(project: Project, clips: Clip[], options: ExportPlanOptions): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;

  for (const clip of clips) {
    if (clip.timelineStart > cursor + 1e-6) {
      segments.push({ kind: "gap", duration: clip.timelineStart - cursor });
    }
    const asset = findAsset(project, clip.assetId);
    if (!asset) throw new ExportError(`A clip references media that is no longer in the project`);
    if (asset.offline) throw new ExportError(`"${asset.name}" is offline. Relink it before exporting.`);

    segments.push({
      kind: "clip",
      clip,
      hasAudio: asset.hasAudio,
      isImage: asset.kind === "image",
      path: options.inputPathFor(clip.assetId),
      duration: clipDuration(clip),
    });
    cursor = clipEnd(clip);
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

/** Filter chain for a clip with a REAL transform (see `isIdentityTransform` — the plain scale+pad
 *  chain below handles the untransformed case and is untouched by this). Empirically verified against
 *  the actual bundled FFmpeg binary before being wired in here — see the "any degree" verification in
 *  this feature's development notes for a rendered example.
 *
 *  Two FFmpeg mechanisms are what make this tractable without any JS-side trigonometry: `rotate`'s
 *  `ow=rotw(a):oh=roth(a)` macros let FFmpeg itself compute the exact bounding box that fits the
 *  rotated content losslessly (no precomputed sizes needed here), and `overlay`'s `W`/`H`/`w`/`h`
 *  expression variables let the composite position reference both the background and overlay's actual
 *  sizes symbolically. `format=rgba` right after `crop` is what makes `rotate`'s `black@0` fill
 *  genuinely transparent PADDING rather than a visible black box — without an alpha channel there,
 *  `overlay` has nothing to composite through and the rotated corners show as solid black. */
function buildTransformFilters(params: {
  sourceIndex: number;
  bgIndex: number;
  outputLabel: string;
  transform: ClipTransform;
  width: number;
  height: number;
  fps: number;
}): string[] {
  const { sourceIndex, bgIndex, outputLabel, transform, width, height, fps } = params;
  const { crop } = transform;
  const clipLabel = `${outputLabel}_src`;
  const bgLabel = `${outputLabel}_bg`;
  const angle = `${n(transform.rotationDeg)}*PI/180`;

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

  return [
    `[${sourceIndex}:v]${cropFilter},format=rgba,${scaleFilter},${rotateFilter},` +
      `setsar=1,fps=${fps},setpts=PTS-STARTPTS[${clipLabel}]`,
    // The background is its own lavfi input (pushed alongside this), not an inline `color=` source
    // filter — matching the pattern gap segments already use elsewhere in this function, so there's
    // only one way black/silence sources get created in this file, not two.
    `[${bgIndex}:v]setpts=PTS-STARTPTS[${bgLabel}]`,
    `[${bgLabel}][${clipLabel}]overlay=x='(W-w)/2+${n(transform.offsetX)}':y='(H-h)/2+${n(transform.offsetY)}':format=auto[${outputLabel}]`,
  ];
}

export function buildExportPlan(project: Project, options: ExportPlanOptions): ExportPlan {
  const { width, height, fps, crf, audioBitrateKbps } = project.exportSettings;
  const duration = sequenceDuration(project);
  if (duration <= 0) throw new ExportError("There is nothing on the timeline to export");

  // V1 renders a single video track. Compositing several video layers means real overlay/alpha work,
  // which this build deliberately doesn't pretend to do — the UI states this rather than silently
  // dropping a track's content.
  const videoTrack = project.sequence.tracks.find((track) => track.kind === "video" && track.visible && track.clips.length > 0);
  if (!videoTrack) throw new ExportError("There is no visible video track with clips to export");

  const segments = buildSegments(project, [...videoTrack.clips].sort((a, b) => a.timelineStart - b.timelineStart), options);

  const inputs: string[] = [];
  const filters: string[] = [];
  const concatLabels: string[] = [];
  let inputIndex = 0;

  for (const [i, segment] of segments.entries()) {
    const videoLabel = `v${i}`;
    const audioLabel = `a${i}`;

    if (segment.kind === "clip") {
      if (segment.isImage) {
        // A still has no timeline to seek into — `-ss` would be meaningless and `-t` alone would
        // yield a single frame. `-loop 1` repeats the decoded image for the clip's duration, which
        // is what makes an image occupy real time on the timeline.
        inputs.push("-loop", "1", "-framerate", String(fps), "-t", t(segment.duration), "-i", segment.path);
      } else {
        // -ss and -t BEFORE -i: seek-then-decode, so only the needed range is read.
        inputs.push("-ss", t(segment.clip.sourceIn), "-t", t(segment.duration), "-i", segment.path);
      }
      const videoIndex = inputIndex++;
      const transform = segment.clip.transform;

      if (!transform || isIdentityTransform(transform)) {
        // scale + pad preserves the source's aspect ratio and letterboxes it into the export frame,
        // rather than stretching. setsar=1 avoids a non-square pixel aspect leaking through from the
        // source and skewing the result. Kept byte-for-byte identical to the pre-transform-feature
        // behavior — an untouched clip must never regress just because transform support now exists.
        filters.push(
          `[${videoIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
            `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},setpts=PTS-STARTPTS[${videoLabel}]`
        );
      } else {
        // The transform chain composites onto its own black background, so it needs its own lavfi
        // input — pushed here (rather than as an inline `color=` source filter) to keep every
        // black/silence source in this file created the same one way.
        const bgIndex = inputIndex++;
        inputs.push("-f", "lavfi", "-t", t(segment.duration), "-i", `color=c=black:s=${width}x${height}:r=${fps}`);
        filters.push(
          ...buildTransformFilters({
            sourceIndex: videoIndex,
            bgIndex,
            outputLabel: videoLabel,
            transform,
            width,
            height,
            fps,
          })
        );
      }

      if (segment.hasAudio && !segment.clip.mutedAudio) {
        // Every segment is resampled to one common rate/layout; concat refuses to join audio streams
        // whose formats don't match, which is easy to hit when mixing a phone clip with a WAV.
        filters.push(`[${videoIndex}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS[${audioLabel}]`);
      } else {
        inputs.push("-f", "lavfi", "-t", t(segment.duration), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
        filters.push(`[${inputIndex++}:a]asetpts=PTS-STARTPTS[${audioLabel}]`);
      }
    } else {
      inputs.push("-f", "lavfi", "-t", t(segment.duration), "-i", `color=c=black:s=${width}x${height}:r=${fps}`);
      filters.push(`[${inputIndex++}:v]setsar=1,setpts=PTS-STARTPTS[${videoLabel}]`);
      inputs.push("-f", "lavfi", "-t", t(segment.duration), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
      filters.push(`[${inputIndex++}:a]asetpts=PTS-STARTPTS[${audioLabel}]`);
    }

    concatLabels.push(`[${videoLabel}][${audioLabel}]`);
  }

  filters.push(`${concatLabels.join("")}concat=n=${segments.length}:v=1:a=1[cv][ca]`);

  // Audio-track clips (voiceover, music) are positioned with adelay and mixed over the video track's
  // own audio.
  const overlayAudio: string[] = [];
  for (const [j, { clip }] of audibleClips(project).entries()) {
    const asset = findAsset(project, clip.assetId);
    if (!asset || asset.offline || !asset.hasAudio || clip.mutedAudio) continue;

    inputs.push("-ss", t(clip.sourceIn), "-t", t(clipDuration(clip)), "-i", options.inputPathFor(clip.assetId));
    const label = `ov${j}`;
    const delayMs = Math.round(clip.timelineStart * 1000);
    filters.push(
      `[${inputIndex++}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,` +
        `adelay=${delayMs}|${delayMs}[${label}]`
    );
    overlayAudio.push(`[${label}]`);
  }

  let audioOut = "[ca]";
  if (overlayAudio.length > 0) {
    // normalize=0 keeps amix from quietly attenuating every input as more are added, which would
    // make adding a music track mysteriously duck the narration.
    filters.push(
      `[ca]${overlayAudio.join("")}amix=inputs=${overlayAudio.length + 1}:normalize=0:dropout_transition=0[mixa]`
    );
    audioOut = "[mixa]";
  }

  return {
    duration,
    args: [
      ...inputs,
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[cv]",
      "-map",
      audioOut,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      String(crf),
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
