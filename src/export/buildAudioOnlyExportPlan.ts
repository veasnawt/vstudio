import { findAsset, sequenceDuration } from "../project/createProject.ts";
import type { Project } from "../project/types.ts";
import { buildSegments, ExportError } from "./buildExportPlan.ts";

/** Builds the FFmpeg invocation that mixes a project's audio down to a single mono MP3 — no video at
 *  all, no encoder, no text — for feeding to a speech-to-text API (Auto Captions).
 *
 *  Deliberately NOT a "skip the video half" option bolted onto `buildExportPlan` itself: that
 *  function's video and audio filter construction share one running `inputIndex` counter per segment
 *  (a clip's `-i` is pushed once, then referenced by BOTH its video and audio filter chains), so
 *  splitting "build video" and "build audio" into independent passes over the same option object would
 *  mean either duplicating input pushes or re-deriving matching indices across two passes — a riskier
 *  change to code `buildExportPlan.ts`'s own comments repeatedly flag as empirically tuned against the
 *  real FFmpeg binary. Standing alone, this file owns its OWN `inputIndex` from zero and only ever
 *  needs an input for a segment that genuinely HAS audio to contribute — unlike the video pipeline, a
 *  silent segment (an image, a muted clip, gap) never needs its source file opened at all here, only a
 *  same-length `anullsrc` placeholder. It reuses `buildSegments` (the clip/gap/transition walk itself,
 *  including transition-shortened heads) so the two pipelines can never disagree about where a segment
 *  boundary falls, and mirrors `buildExportPlan`'s own audio-only branches (resample/gain/mute,
 *  `acrossfade`, `adelay`-positioned overlay clips, a final `normalize=0` `amix`) so what gets
 *  transcribed is exactly what the export's own audio track would sound like over the same range.
 *
 *  One deliberate exception: `Track.pan` is NOT applied here, unlike in `buildExportPlan.ts`'s own
 *  `buildAudioTrackStream`. This file's entire output is downmixed to mono (`-ac 1` below) for Whisper
 *  transcription — a stereo pan value's only effect on a mono downmix would be a marginal,
 *  near-inaudible loudness wobble around the equal-power law's own center-pan constant, swamped by
 *  `amix`'s own normalization. Not a forgotten spot; see `Track.pan`'s own doc comment. */

export interface AudioOnlyPlanOptions {
  /** Absolute path to the media file backing an asset — same contract as `ExportPlanOptions`. */
  inputPathFor: (assetId: string) => string;
  outputPath: string;
}

export interface AudioOnlyPlan {
  args: string[];
  /** Total output length in seconds — what progress is measured against. */
  duration: number;
}

function t(seconds: number): string {
  return seconds.toFixed(6);
}

function n(value: number): string {
  return value.toFixed(6);
}

export function buildAudioOnlyExportPlan(project: Project, options: AudioOnlyPlanOptions): AudioOnlyPlan {
  const duration = sequenceDuration(project);
  if (duration <= 0) throw new ExportError("There is nothing on the timeline to transcribe");

  const inputs: string[] = [];
  const filters: string[] = [];
  let inputIndex = 0;

  /** Pushes one segment's own audio: a real, resampled/gain-adjusted input when it genuinely has
   *  audio, else a matching-length silent placeholder — the audio-only equivalent of
   *  `buildExportPlan`'s `pushClipAudioFilters`, except the silent branch here never opens a file at
   *  all (there's no video decode forcing one open the way there is in the full export). */
  function pushAudio(hasAudio: boolean, path: string | null, sourceIn: number, sliceDuration: number, outputLabel: string, gain = 1): void {
    if (hasAudio && path) {
      inputs.push("-ss", t(sourceIn), "-t", t(sliceDuration), "-i", path);
      const sourceIndex = inputIndex++;
      const volumeStage = gain !== 1 ? `,volume=${n(gain)}` : "";
      filters.push(`[${sourceIndex}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS${volumeStage}[${outputLabel}]`);
    } else {
      inputs.push("-f", "lavfi", "-t", t(sliceDuration), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
      filters.push(`[${inputIndex++}:a]asetpts=PTS-STARTPTS[${outputLabel}]`);
    }
  }

  const videoTracks = project.sequence.tracks.filter((track) => track.kind === "video" && track.visible && track.clips.length > 0);
  const extraTrackAudioLabels: string[] = [];

  videoTracks.forEach((track, trackIndex) => {
    const sortedClips = [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart);
    const segments = buildSegments(project, track, sortedClips, options, duration);
    const labels: string[] = [];

    segments.forEach((segment, i) => {
      const label = `a${trackIndex}_${i}`;
      if (segment.kind === "clip") {
        const hasAudio = segment.hasAudio && !segment.clip.mutedAudio && !segment.isImage;
        pushAudio(hasAudio, hasAudio ? segment.path : null, segment.sourceIn, segment.duration, label, segment.clip.gain ?? 1);
      } else if (segment.kind === "transition") {
        // Same two-slice-then-blend shape as buildExportPlan's own transition branch — see its
        // comment on why the split is asymmetric (the transition window lives inside the INCOMING
        // clip's own nominal span).
        const D = segment.duration;
        const fromLabel = `${label}_from`;
        const toLabel = `${label}_to`;
        const fromHasAudio = segment.from.hasAudio && !segment.from.clip.mutedAudio && !segment.from.isImage;
        const toHasAudio = segment.to.hasAudio && !segment.to.clip.mutedAudio && !segment.to.isImage;
        pushAudio(fromHasAudio, fromHasAudio ? segment.from.path : null, segment.from.clip.sourceOut - D, D, fromLabel, segment.from.clip.gain ?? 1);
        pushAudio(toHasAudio, toHasAudio ? segment.to.path : null, segment.to.clip.sourceIn, D, toLabel, segment.to.clip.gain ?? 1);
        filters.push(`[${fromLabel}][${toLabel}]acrossfade=d=${t(D)}[${label}]`);
      } else {
        pushAudio(false, null, 0, segment.duration, label);
      }
      labels.push(`[${label}]`);
    });

    // `v=0:a=1` — the one structural difference from buildExportPlan's own `concat=n=...:v=1:a=1`:
    // there is no video stream in this graph to concatenate alongside the audio.
    filters.push(`${labels.join("")}concat=n=${segments.length}:v=0:a=1[ca${trackIndex}]`);
    if (trackIndex > 0) extraTrackAudioLabels.push(`[ca${trackIndex}]`);
  });

  // Dedicated audio-track clips (voiceover, music) — segment-based, same `buildSegments` walk the
  // video-track loop above uses, so a transition between two audio-track clips gets a real `acrossfade`
  // here too instead of being silently dropped to a hard cut. Previously a flat per-clip `adelay`+
  // `volume` loop over `audibleClips` that never consulted `findTransitionPartner`/`findTransitionOut`
  // at all — that meant Auto-Captions transcribed a hard cut at every audio-track transition boundary
  // even though the real export's own `buildAudioTrackStream` already blended it correctly. Mirrors
  // that function's mute/solo/emptiness gating (`anySoloAudioTrack`/`hasAudibleClip`) exactly, so a
  // track this excludes doesn't even get `buildSegments` run over it.
  const overlayAudio: string[] = [];
  const audioTracks = project.sequence.tracks.filter((track) => track.kind === "audio");
  const anySoloAudioTrack = audioTracks.some((track) => track.solo);
  audioTracks.forEach((track, audioTrackIndex) => {
    if (anySoloAudioTrack ? !track.solo : track.muted) return;
    const hasAudibleClip = track.clips.some((clip) => {
      const asset = findAsset(project, clip.assetId);
      return asset ? !asset.offline && asset.hasAudio && !clip.mutedAudio : false;
    });
    if (!hasAudibleClip) return;

    const sortedClips = [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart);
    const segments = buildSegments(project, track, sortedClips, options, duration);
    const labels: string[] = [];

    segments.forEach((segment, i) => {
      const label = `oa${audioTrackIndex}_${i}`;
      if (segment.kind === "clip") {
        const hasAudio = segment.hasAudio && !segment.clip.mutedAudio;
        pushAudio(hasAudio, hasAudio ? segment.path : null, segment.sourceIn, segment.duration, label, (segment.clip.gain ?? 1) * (track.gain ?? 1));
      } else if (segment.kind === "transition") {
        // Same two-slice-then-blend shape as the video-track loop's own transition branch above.
        const D = segment.duration;
        const fromLabel = `${label}_from`;
        const toLabel = `${label}_to`;
        const fromHasAudio = segment.from.hasAudio && !segment.from.clip.mutedAudio;
        const toHasAudio = segment.to.hasAudio && !segment.to.clip.mutedAudio;
        pushAudio(fromHasAudio, fromHasAudio ? segment.from.path : null, segment.from.clip.sourceOut - D, D, fromLabel, (segment.from.clip.gain ?? 1) * (track.gain ?? 1));
        pushAudio(toHasAudio, toHasAudio ? segment.to.path : null, segment.to.clip.sourceIn, D, toLabel, (segment.to.clip.gain ?? 1) * (track.gain ?? 1));
        filters.push(`[${fromLabel}][${toLabel}]acrossfade=d=${t(D)}[${label}]`);
      } else {
        pushAudio(false, null, 0, segment.duration, label);
      }
      labels.push(`[${label}]`);
    });

    filters.push(`${labels.join("")}concat=n=${segments.length}:v=0:a=1[oa${audioTrackIndex}]`);
    overlayAudio.push(`[oa${audioTrackIndex}]`);
  });

  const allSources = videoTracks.length > 0 ? [`[ca0]`, ...extraTrackAudioLabels, ...overlayAudio] : overlayAudio;
  if (allSources.length === 0) throw new ExportError("There is no audio in this range to transcribe");

  // normalize=0 — same reasoning as buildExportPlan's own final amix: adding more sources shouldn't
  // quietly attenuate the ones already there. Skipped entirely for the single-source case (the common
  // one: one video track, no extra audio clips) — one fewer filter stage when there's nothing to mix.
  let audioOut =
    allSources.length === 1
      ? allSources[0]
      : (() => {
          filters.push(`${allSources.join("")}amix=inputs=${allSources.length}:normalize=0:dropout_transition=0[mixa]`);
          return "[mixa]";
        })();

  // Master fader — same final stage buildExportPlan applies, so what gets transcribed reflects the
  // same overall level the real export would have.
  const masterGain = project.sequence.masterGain ?? 1;
  if (masterGain !== 1) {
    filters.push(`${audioOut}volume=${n(masterGain)}[mastered]`);
    audioOut = "[mastered]";
  }

  return {
    duration,
    args: [
      ...inputs,
      "-filter_complex",
      filters.join(";"),
      "-map",
      audioOut,
      // Mono, low-bitrate MP3 — plenty for speech transcription, and what keeps a whole-sequence
      // upload comfortably under Whisper's 25MB cap for any project up to roughly 45 minutes (an
      // explicit v1 scope cut for longer ones — see AUTO_CAPTIONS scope notes at the call site).
      "-c:a",
      "libmp3lame",
      "-b:a",
      "64k",
      "-ac",
      "1",
      "-y",
      options.outputPath,
    ],
  };
}
