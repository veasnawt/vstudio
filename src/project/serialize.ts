import type { Asset, Clip, ClipTransform, Project, Sequence, Track } from "./types.ts";
import { PROJECT_SCHEMA_VERSION } from "./types.ts";

/** Thrown when a project file can't be trusted. Callers surface the message to the user rather than
 *  loading a half-understood project and letting the damage show up later as a corrupted edit. */
export class ProjectFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectFormatError";
  }
}

export function serializeProject(project: Project): string {
  // Pretty-printed deliberately: a project file a human can read and diff in git is worth far more
  // than the handful of bytes minifying would save on a file this size.
  return JSON.stringify({ ...project, schemaVersion: PROJECT_SCHEMA_VERSION }, null, 2);
}

function req<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new ProjectFormatError(`Project file is missing ${what}`);
  return value;
}

function num(value: unknown, what: string, fallback?: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (fallback !== undefined) return fallback;
  throw new ProjectFormatError(`Project file has an invalid ${what}`);
}

function str(value: unknown, what: string, fallback?: string): string {
  if (typeof value === "string") return value;
  if (fallback !== undefined) return fallback;
  throw new ProjectFormatError(`Project file has an invalid ${what}`);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseAsset(raw: Record<string, unknown>): Asset {
  const kind = str(raw.kind, "asset kind");
  if (kind !== "video" && kind !== "audio" && kind !== "image") {
    throw new ProjectFormatError(`Project file has an unknown asset kind: ${kind}`);
  }
  // Optional fields are spread in only when actually present, never written as an explicit
  // `undefined`. `JSON.stringify` omits undefined values entirely, so setting them unconditionally
  // would make a restored project structurally differ from the one that was saved — the round trip
  // would no longer be lossless, and equality checks built on it (dirty-tracking, undo comparisons)
  // would report phantom differences.
  return {
    id: str(raw.id, "asset id"),
    kind,
    name: str(raw.name, "asset name"),
    relPath: str(raw.relPath, "asset path"),
    ...(typeof raw.thumbnailRelPath === "string" ? { thumbnailRelPath: raw.thumbnailRelPath } : null),
    duration: num(raw.duration, "asset duration", 0),
    ...(typeof raw.width === "number" ? { width: raw.width } : null),
    ...(typeof raw.height === "number" ? { height: raw.height } : null),
    ...(typeof raw.fps === "number" ? { fps: raw.fps } : null),
    hasAudio: bool(raw.hasAudio, false),
    sizeBytes: num(raw.sizeBytes, "asset size", 0),
    importedAt: num(raw.importedAt, "asset import time", 0),
    ...(typeof raw.offline === "boolean" ? { offline: raw.offline } : null),
  };
}

/** Lenient by design, unlike the rest of this file: `transform` is purely additive enhancement data
 *  (see `Clip.transform`'s own doc comment), not something that defines what a clip fundamentally
 *  IS the way `sourceIn`/`sourceOut`/`assetId` do. A missing or partially-malformed transform falls
 *  back to identity values field-by-field rather than throwing and losing the whole clip — the same
 *  "drop what's broken, keep the rest openable" spirit as the missing-asset clip filter below. */
function parseClipTransform(raw: unknown): ClipTransform | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const crop = (r.crop && typeof r.crop === "object" ? r.crop : {}) as Record<string, unknown>;
  return {
    offsetX: num(r.offsetX, "clip transform offset", 0),
    offsetY: num(r.offsetY, "clip transform offset", 0),
    scale: num(r.scale, "clip transform scale", 1),
    rotationDeg: num(r.rotationDeg, "clip transform rotation", 0),
    crop: {
      top: num(crop.top, "clip crop", 0),
      right: num(crop.right, "clip crop", 0),
      bottom: num(crop.bottom, "clip crop", 0),
      left: num(crop.left, "clip crop", 0),
    },
  };
}

function parseClip(raw: Record<string, unknown>): Clip {
  const sourceIn = num(raw.sourceIn, "clip in-point");
  const sourceOut = num(raw.sourceOut, "clip out-point");
  if (sourceOut <= sourceIn) {
    throw new ProjectFormatError("Project file has a clip whose out-point is not after its in-point");
  }
  const transform = parseClipTransform(raw.transform);
  return {
    id: str(raw.id, "clip id"),
    assetId: str(raw.assetId, "clip asset reference"),
    sourceIn,
    sourceOut,
    timelineStart: Math.max(0, num(raw.timelineStart, "clip position")),
    ...(transform ? { transform } : null),
    ...(raw.mutedAudio === true ? { mutedAudio: true } : null),
  };
}

function parseTrack(raw: Record<string, unknown>): Track {
  const kind = str(raw.kind, "track kind");
  if (kind !== "video" && kind !== "audio") {
    throw new ProjectFormatError(`Project file has an unknown track kind: ${kind}`);
  }
  const clips = Array.isArray(raw.clips) ? raw.clips.map((c) => parseClip(c as Record<string, unknown>)) : [];
  return {
    id: str(raw.id, "track id"),
    kind,
    name: str(raw.name, "track name", kind === "video" ? "V" : "A"),
    // Sorted on load so every consumer can rely on clip order matching timeline order without
    // re-sorting; edit operations maintain this same invariant.
    clips: clips.sort((a, b) => a.timelineStart - b.timelineStart),
    locked: bool(raw.locked, false),
    visible: bool(raw.visible, true),
    muted: bool(raw.muted, false),
    solo: bool(raw.solo, false),
  };
}

function parseSequence(raw: Record<string, unknown>): Sequence {
  return {
    id: str(raw.id, "sequence id"),
    name: str(raw.name, "sequence name", "Main Sequence"),
    width: num(raw.width, "sequence width", 1080),
    height: num(raw.height, "sequence height", 1920),
    fps: num(raw.fps, "sequence frame rate", 30),
    tracks: Array.isArray(raw.tracks) ? raw.tracks.map((t) => parseTrack(t as Record<string, unknown>)) : [],
  };
}

/** Parses and validates a project file. Deliberately strict: a project that can't be read correctly
 *  raises `ProjectFormatError` instead of loading partially, because a silently-wrong timeline is far
 *  worse for a creator than a clear "this file can't be opened". */
export function deserializeProject(json: string): Project {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new ProjectFormatError("Project file is not valid JSON");
  }
  if (!raw || typeof raw !== "object") throw new ProjectFormatError("Project file is empty");

  const version = num(raw.schemaVersion, "schema version", 0);
  // A file written by a NEWER VStudio may use fields this build would drop on the next save,
  // quietly destroying work. Refuse rather than round-trip it lossily.
  if (version > PROJECT_SCHEMA_VERSION) {
    throw new ProjectFormatError(
      `This project was created by a newer version of VStudio (format ${version}, this build reads ${PROJECT_SCHEMA_VERSION}). Update VStudio to open it.`
    );
  }

  const project: Project = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: str(raw.id, "project id"),
    bpProjectId: str(raw.bpProjectId, "project reference"),
    name: str(raw.name, "project name", "Untitled"),
    createdAt: num(raw.createdAt, "creation time", Date.now()),
    updatedAt: num(raw.updatedAt, "update time", Date.now()),
    assets: Array.isArray(raw.assets) ? raw.assets.map((a) => parseAsset(a as Record<string, unknown>)) : [],
    sequence: parseSequence(req(raw.sequence as Record<string, unknown>, "its sequence")),
    exportSettings: {
      width: num((raw.exportSettings as Record<string, unknown>)?.width, "export width", 1080),
      height: num((raw.exportSettings as Record<string, unknown>)?.height, "export height", 1920),
      fps: num((raw.exportSettings as Record<string, unknown>)?.fps, "export frame rate", 30),
      crf: num((raw.exportSettings as Record<string, unknown>)?.crf, "export quality", 20),
      audioBitrateKbps: num(
        (raw.exportSettings as Record<string, unknown>)?.audioBitrateKbps,
        "export audio bitrate",
        192
      ),
    },
  };

  // A clip pointing at an asset that isn't in the file would crash the compositor on first render.
  // Dropping them keeps the rest of the edit openable, which is the recoverable outcome.
  const assetIds = new Set(project.assets.map((a) => a.id));
  for (const track of project.sequence.tracks) {
    track.clips = track.clips.filter((c) => assetIds.has(c.assetId));
  }

  return project;
}
