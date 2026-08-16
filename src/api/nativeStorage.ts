import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { kindForExtension } from "../import/mediaFormats.ts";
import { createProject, newId } from "../project/createProject.ts";
import { deserializeProject, serializeProject } from "../project/serialize.ts";
import type { Asset, AssetKind, Project } from "../project/types.ts";
import { ApiRequestError } from "./client.ts";

/** On-device counterpart of `studios/vstudio/app/api/vstudio/**`'s filesystem routes, for the native
 *  (Capacitor) shell where there is no server at all — see the "native iOS/Android apps" plan. Mirrors
 *  the server's `.vstudio/<projectId>/{project.json,media/}` layout one-for-one, just rooted under
 *  Capacitor's app-private `Directory.Data` instead of `VSTUDIO_ROOT`.
 *
 *  What this deliberately does NOT do yet: generate thumbnails/filmstrips/waveforms, or export — both
 *  need real FFmpeg, which only exists here once the native `ffmpeg-kit` plugin (plan Step 5) lands.
 *  A native-imported asset simply has no `thumbnailRelPath`/etc., which every existing caller already
 *  treats as "no preview available" rather than an error (see `client.ts`'s `thumbnailUrl` and
 *  friends) — so import/edit/preview work now, export waits on the plugin. */

const DIRECTORY = Directory.Data;
const ROOT = "vstudio-projects";

function projectDir(projectId: string): string {
  return `${ROOT}/${projectId}`;
}
function mediaDir(projectId: string): string {
  return `${projectDir(projectId)}/media`;
}
function projectFile(projectId: string): string {
  return `${projectDir(projectId)}/project.json`;
}

// `mediaUrl` (below) has to be SYNCHRONOUS — every existing caller (`<video src>`, `<img src>`, …)
// calls it directly in render, and changing that shape would ripple through every UI component. But
// resolving a `Directory.Data`-relative path to a real native URI is only available async
// (`Filesystem.getUri`). Splitting the difference: the native media directory's URI is resolved ONCE
// per project (primed by `loadProject`, which every screen already awaits before rendering anything
// that could call `mediaUrl`), then reused synchronously from this cache for the rest of the session.
const mediaBaseUriCache = new Map<string, string>();

async function primeMediaBaseUri(projectId: string): Promise<void> {
  await Filesystem.mkdir({ path: mediaDir(projectId), directory: DIRECTORY, recursive: true }).catch(() => {
    /* already exists */
  });
  const { uri } = await Filesystem.getUri({ path: mediaDir(projectId), directory: DIRECTORY });
  mediaBaseUriCache.set(projectId, uri);
}

export function nativeMediaUrl(projectId: string, relPath: string): string {
  const base = mediaBaseUriCache.get(projectId);
  // Only reachable if something calls this before `loadProject` has resolved, which shouldn't happen
  // in practice — every screen loads the project first. An empty src is a harmless no-op image/video
  // rather than a thrown error mid-render.
  if (!base) return "";
  return Capacitor.convertFileSrc(`${base}/${relPath}`);
}

export async function nativeLoadProject(projectId: string, projectName?: string): Promise<Project> {
  await primeMediaBaseUri(projectId);
  try {
    const { data } = await Filesystem.readFile({ path: projectFile(projectId), directory: DIRECTORY, encoding: Encoding.UTF8 });
    return deserializeProject(typeof data === "string" ? data : await data.text());
  } catch {
    const name = projectName?.trim() ? projectName.trim().slice(0, 120) : undefined;
    const project = createProject(projectId, name);
    await Filesystem.mkdir({ path: projectDir(projectId), directory: DIRECTORY, recursive: true }).catch(() => {});
    await Filesystem.writeFile({ path: projectFile(projectId), directory: DIRECTORY, data: serializeProject(project), encoding: Encoding.UTF8 });
    return project;
  }
}

export async function nativeSaveProject(projectId: string, project: Project): Promise<void> {
  await Filesystem.writeFile({ path: projectFile(projectId), directory: DIRECTORY, data: serializeProject(project), encoding: Encoding.UTF8 });
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // "data:<mime>;base64,<payload>" — Filesystem.writeFile wants just the payload when no
      // `encoding` is passed (its default is raw base64 bytes).
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

/** Reads duration/dimensions/audio-presence straight from the WebView's own media decoder — the
 *  on-device equivalent of the server's `ffprobe` call, needing no native plugin at all. Not as
 *  exhaustive as ffprobe (no `fps`), but everything `Asset` actually requires is here. */
function probeViaMediaElement(kind: AssetKind, objectUrl: string): Promise<{ duration: number; width?: number; height?: number; hasAudio: boolean; noVideoStream: boolean }> {
  return new Promise((resolve, reject) => {
    if (kind === "image") {
      const img = new Image();
      img.onload = () => resolve({ duration: 0, width: img.naturalWidth, height: img.naturalHeight, hasAudio: false, noVideoStream: false });
      img.onerror = () => reject(new Error("That file couldn't be read as an image"));
      img.src = objectUrl;
      return;
    }
    const el = document.createElement(kind === "video" ? "video" : "audio");
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      const video = el as HTMLVideoElement;
      const width = kind === "video" ? video.videoWidth : undefined;
      const height = kind === "video" ? video.videoHeight : undefined;
      // A "video"-extension file (e.g. a MediaRecorder .webm voiceover) with no actual video stream
      // decodes with videoWidth/Height === 0 — the same reclassification signal the server's ffprobe
      // path uses, just read off the decoder directly instead of a probe tool.
      const noVideoStream = kind === "video" && width === 0 && height === 0;
      // In-band AudioTrackList isn't universally populated on every WebView build; default to "has
      // audio" when it can't be determined, since a wrongly-present silent track is harmless while a
      // wrongly-absent one would hide real audio behind the mute-toggle UI.
      const audioTracks = (el as unknown as { audioTracks?: { length: number } }).audioTracks;
      const hasAudio = kind === "audio" || noVideoStream || audioTracks === undefined || audioTracks.length > 0;
      resolve({ duration: Number.isFinite(el.duration) ? el.duration : 0, width, height, hasAudio, noVideoStream });
    };
    el.onerror = () => reject(new Error("That file couldn't be read as media"));
    el.src = objectUrl;
  });
}

export async function nativeImportMedia(projectId: string, file: File): Promise<Asset> {
  const ext = `.${file.name.split(".").pop()?.toLowerCase() ?? ""}`;
  const kind = kindForExtension(ext);
  if (!kind) {
    throw new ApiRequestError(`VStudio can't import "${ext || file.name}" on this device.`, 400, "unsupported-format");
  }

  const objectUrl = URL.createObjectURL(file);
  let probe;
  try {
    probe = await probeViaMediaElement(kind, objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
  if (kind !== "image" && probe.duration <= 0) {
    throw new ApiRequestError("That file contains no playable audio or video", 400, "empty-media");
  }
  const resolvedKind: AssetKind = probe.noVideoStream ? "audio" : kind;

  const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "media";
  const dotIndex = safeName.lastIndexOf(".");
  const stem = dotIndex > 0 ? safeName.slice(0, dotIndex) : safeName;
  const suffix = dotIndex > 0 ? safeName.slice(dotIndex) : "";
  const relPath = `${stem}-${newId("m")}${suffix}`;

  await Filesystem.writeFile({ path: `${mediaDir(projectId)}/${relPath}`, directory: DIRECTORY, data: await readFileAsBase64(file) });

  return {
    id: newId("a"),
    kind: resolvedKind,
    name: file.name,
    relPath,
    duration: probe.duration,
    hasAudio: probe.hasAudio,
    sizeBytes: file.size,
    importedAt: Date.now(),
    ...(probe.width ? { width: probe.width } : null),
    ...(probe.height ? { height: probe.height } : null),
  };
}

export async function nativeDeleteMedia(projectId: string, asset: Asset): Promise<void> {
  if (!asset.relPath) return;
  await Filesystem.deleteFile({ path: `${mediaDir(projectId)}/${asset.relPath}`, directory: DIRECTORY }).catch(() => {
    /* already gone */
  });
}
