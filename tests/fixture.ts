import { createProject } from "../src/project/createProject.ts";
import type { Asset, LutAsset, Project } from "../src/project/types.ts";
import { DEFAULT_TEXT_STYLE } from "../src/project/types.ts";

/** A 10-second 1080×1920 30fps video asset — the shape almost every test starts from. */
export function videoAsset(id = "asset1", duration = 10): Asset {
  return {
    id,
    kind: "video",
    name: `${id}.mp4`,
    relPath: `${id}.mp4`,
    duration,
    width: 1080,
    height: 1920,
    fps: 30,
    hasAudio: true,
    sizeBytes: 1024,
    importedAt: 0,
  };
}

/** A project with one video asset registered and nothing on the timeline yet. */
export function emptyProject(assets: Asset[] = [videoAsset()]): Project {
  const project = createProject("bp1", "Test Project");
  project.assets = assets;
  return project;
}

export function videoTrackId(project: Project): string {
  const track = project.sequence.tracks.find((t) => t.kind === "video");
  if (!track) throw new Error("fixture project has no video track");
  return track.id;
}

export function audioTrackId(project: Project): string {
  const track = project.sequence.tracks.find((t) => t.kind === "audio");
  if (!track) throw new Error("fixture project has no audio track");
  return track.id;
}

export function clipsOf(project: Project, trackId: string) {
  return project.sequence.tracks.find((t) => t.id === trackId)?.clips ?? [];
}

/** Strips the fields that legitimately change on every edit, so a test can assert that undo restored
 *  the *content* of a project without `updatedAt` (a timestamp) reporting a false difference. */
export function comparable(project: Project): unknown {
  const { updatedAt: _ignored, ...rest } = project;
  return rest;
}

/** Floating-point time comparison. Frame-snapped values are exact multiples of 1/fps, which is not
 *  representable in binary floating point (1/30 recurs), so `===` on seconds is the wrong tool. */
export function closeTo(actual: number, expected: number, tolerance = 1e-9): boolean {
  return Math.abs(actual - expected) < tolerance;
}

/** A still image asset — no duration, no audio, no frame rate. */
export function imageAsset(id = "img1"): Asset {
  return {
    id,
    kind: "image",
    name: `${id}.png`,
    relPath: `${id}.png`,
    duration: 0,
    width: 800,
    height: 600,
    hasAudio: false,
    sizeBytes: 2048,
    importedAt: 0,
  };
}

/** An audio-only asset — the only kind that legitimately belongs on an audio track. */
export function audioAsset(id = "music", duration = 30): Asset {
  return {
    id,
    kind: "audio",
    name: `${id}.mp3`,
    relPath: `${id}.mp3`,
    duration,
    hasAudio: true,
    sizeBytes: 4096,
    importedAt: 0,
  };
}

/** A text asset — no backing file, no intrinsic duration, no audio; its own content+style (living on
 *  the ASSET, not the clip — see `Asset.textContent`'s own doc comment) are what define it. */
export function textAsset(id = "text1", content = "Hello"): Asset {
  return {
    id,
    kind: "text",
    name: content,
    relPath: "",
    duration: 0,
    hasAudio: false,
    sizeBytes: 0,
    importedAt: 0,
    textContent: content,
    textStyle: { ...DEFAULT_TEXT_STYLE },
  };
}

/** A color-matte background asset — no backing file, no intrinsic duration, no audio, same shape as
 *  `textAsset` above (see `Asset.color`'s own doc comment). */
export function colorAsset(id = "color1", color = "#224466"): Asset {
  return {
    id,
    kind: "color",
    name: color,
    relPath: "",
    duration: 0,
    hasAudio: false,
    sizeBytes: 0,
    importedAt: 0,
    color,
  };
}

/** A minimal `.cube` LUT registered in the project's LUT library — the shape `setClipLut`/
 *  `SetClipLutCommand` tests reference by id. */
export function lutAsset(id = "lut1"): LutAsset {
  return {
    id,
    name: `${id}.cube`,
    relPath: `${id}.cube`,
    size: 2,
    importedAt: 0,
  };
}

export function textTrackId(project: Project): string {
  const track = project.sequence.tracks.find((t) => t.kind === "text");
  if (!track) throw new Error("fixture project has no text track");
  return track.id;
}
