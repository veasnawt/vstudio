import type { Asset, Clip, Project, Sequence, TextStyle, Track, TrackKind } from "./types.ts";
import { DEFAULT_TEXT_STYLE, PROJECT_SCHEMA_VERSION, SHORT_PRESET } from "./types.ts";

/** `crypto.randomUUID` is available in both Node 18+ and every browser this runs in, so there's no
 *  need for a uuid dependency. Prefixed so an id is self-describing in a project file and in logs. */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

const TRACK_ID_PREFIX: Record<TrackKind, string> = { video: "v", audio: "a", text: "t" };

export function createTrack(kind: TrackKind, name: string): Track {
  return {
    id: newId(TRACK_ID_PREFIX[kind]),
    kind,
    name,
    clips: [],
    locked: false,
    visible: true,
    muted: false,
    solo: false,
  };
}

/** A text asset has no backing file — it's authored directly rather than imported, so there's no
 *  import flow to go through (matching how `editorStore.importFiles` works: `assets` gets appended
 *  to directly, not via the undo stack — creating one isn't itself an undo-able edit; the CONTENT/
 *  STYLE edits that follow, via `setTextAsset`, are). */
export function createTextAsset(content = "Text", style: TextStyle = DEFAULT_TEXT_STYLE): Asset {
  const now = Date.now();
  return {
    id: newId("txt"),
    kind: "text",
    name: content.slice(0, 40) || "Text",
    relPath: "",
    duration: 0,
    hasAudio: false,
    sizeBytes: 0,
    importedAt: now,
    textContent: content,
    textStyle: { ...style },
  };
}

export function createClip(params: {
  assetId: string;
  sourceIn: number;
  sourceOut: number;
  timelineStart: number;
}): Clip {
  return { id: newId("c"), ...params };
}

export function createSequence(preset: { width: number; height: number; fps: number } = SHORT_PRESET): Sequence {
  return {
    id: newId("seq"),
    name: "Main Sequence",
    width: preset.width,
    height: preset.height,
    fps: preset.fps,
    // One video and one audio track to start — enough to drop a clip onto immediately, without
    // presenting a wall of empty tracks. More can be added as the edit grows.
    tracks: [createTrack("video", "V1"), createTrack("audio", "A1")],
  };
}

export function createProject(bpProjectId: string, name = "Untitled", preset = SHORT_PRESET): Project {
  const now = Date.now();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: newId("proj"),
    bpProjectId,
    name,
    createdAt: now,
    updatedAt: now,
    assets: [],
    sequence: createSequence(preset),
    exportSettings: {
      width: preset.width,
      height: preset.height,
      fps: preset.fps,
      crf: 20,
      audioBitrateKbps: 192,
    },
  };
}

export function findAsset(project: Project, assetId: string): Asset | undefined {
  return project.assets.find((a) => a.id === assetId);
}

export function findTrack(project: Project, trackId: string): Track | undefined {
  return project.sequence.tracks.find((t) => t.id === trackId);
}

/** Locates a clip without the caller needing to know which track holds it — most edit operations
 *  are handed only a clip id (from a selection) and need both the clip and its track. */
export function findClip(project: Project, clipId: string): { track: Track; clip: Clip } | undefined {
  for (const track of project.sequence.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return undefined;
}

/** Total length of the edit — where the timeline ends and how long an export runs. */
export function sequenceDuration(project: Project): number {
  let end = 0;
  for (const track of project.sequence.tracks) {
    for (const clip of track.clips) {
      end = Math.max(end, clip.timelineStart + (clip.sourceOut - clip.sourceIn));
    }
  }
  return end;
}

export function clipDuration(clip: Clip): number {
  return clip.sourceOut - clip.sourceIn;
}

export function clipEnd(clip: Clip): number {
  return clip.timelineStart + clipDuration(clip);
}
