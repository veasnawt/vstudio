import { Capacitor, registerPlugin } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { buildExportPlan } from "../export/buildExportPlan.ts";
import { findAsset, newId } from "../project/createProject.ts";
import { FONT_REGISTRY } from "../project/fonts.ts";
import type { Clip, Project } from "../project/types.ts";
import { ApiRequestError } from "./client.ts";
import type { ExportProgress, ExportStarted } from "./client.ts";

/** On-device counterpart of `studios/vstudio/app/api/vstudio/export/route.ts`, talking to the native
 *  `Ffmpeg` plugin (`apps/mobile/android/.../FfmpegPlugin.kt`) instead of spawning a server child
 *  process. `buildExportPlan` itself is reused completely unchanged — the only work here is resolving
 *  every path its `ExportPlanOptions` needs to a REAL native filesystem path before calling it, since
 *  (unlike the server's synchronous `fs` calls) every Capacitor `Filesystem` operation is async while
 *  `inputPathFor`/`fontPathFor`/`textFilePathFor` are all synchronous callbacks — so everything they
 *  could need is resolved into plain lookup maps FIRST, and the callbacks just read from those maps. */

interface FfmpegRunOptions {
  jobId: string;
  args: string[];
  duration: number;
}
interface FfmpegCancelOptions {
  jobId: string;
}
interface FfmpegSaveToGalleryOptions {
  path: string;
  fileName: string;
}
interface FfmpegEventPayload {
  jobId: string;
  fraction?: number;
  error?: string;
}
interface FfmpegPluginApi {
  run(options: FfmpegRunOptions): Promise<void>;
  cancel(options: FfmpegCancelOptions): Promise<void>;
  saveToGallery(options: FfmpegSaveToGalleryOptions): Promise<{ uri: string }>;
  addListener(
    eventName: "progress" | "done" | "failed" | "cancelled",
    listenerFunc: (payload: FfmpegEventPayload) => void
  ): Promise<{ remove: () => Promise<void> }>;
}

const Ffmpeg = registerPlugin<FfmpegPluginApi>("Ffmpeg");

const DIRECTORY = Directory.Data;
const ROOT = "vstudio-projects";
const FONTS_DIR = `${ROOT}/_fonts`;
const TEXT_SCRATCH_DIR = "vstudio-text";

function projectDir(projectId: string): string {
  return `${ROOT}/${projectId}`;
}
function mediaDir(projectId: string): string {
  return `${projectDir(projectId)}/media`;
}
function exportsDir(projectId: string): string {
  return `${projectDir(projectId)}/exports`;
}

/** FFmpeg wants a plain filesystem path, not the `file://`-scheme URI `Filesystem.getUri` returns —
 *  the same distinction `nativeStorage.ts`'s `nativeMediaUrl` draws for `Capacitor.convertFileSrc`
 *  (a WebView-only URL), just the native-FFmpeg-side equivalent of it. */
function stripFileScheme(uri: string): string {
  return uri.startsWith("file://") ? uri.slice("file://".length) : uri;
}

async function nativePathFor(path: string): Promise<string> {
  const { uri } = await Filesystem.getUri({ path, directory: DIRECTORY });
  return stripFileScheme(uri);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read a bundled font file"));
    reader.readAsDataURL(blob);
  });
}

function allFontFileNames(): string[] {
  const names = new Set<string>();
  for (const font of FONT_REGISTRY) {
    names.add(font.files.regular);
    if (font.files.bold) names.add(font.files.bold);
    if (font.files.italic) names.add(font.files.italic);
    if (font.files.boldItalic) names.add(font.files.boldItalic);
  }
  return [...names];
}

/** Copies every bundled font file (already shipped to `apps/mobile/public/fonts/` for the preview's
 *  own `@font-face` CSS — see `project/fonts.ts`'s own doc comment) from the WebView's local server to
 *  a real native path, once per app run. Cheap (a handful of small `.ttf` files) and idempotent-enough
 *  via the module-level cache below — no need to skip this for a text-clip-free project, the cost of
 *  doing it unconditionally is negligible next to an actual video render. */
let fontPathsPromise: Promise<Map<string, string>> | null = null;

function primeFontPaths(): Promise<Map<string, string>> {
  if (!fontPathsPromise) {
    fontPathsPromise = (async () => {
      await Filesystem.mkdir({ path: FONTS_DIR, directory: DIRECTORY, recursive: true }).catch(() => {});
      const map = new Map<string, string>();
      await Promise.all(
        allFontFileNames().map(async (fileName) => {
          const relPath = `${FONTS_DIR}/${fileName}`;
          try {
            await Filesystem.stat({ path: relPath, directory: DIRECTORY });
          } catch {
            const response = await fetch(`/fonts/${fileName}`);
            if (!response.ok) throw new ApiRequestError(`Missing bundled font file "${fileName}"`, 500, "font-missing");
            const base64 = await blobToBase64(await response.blob());
            await Filesystem.writeFile({ path: relPath, directory: DIRECTORY, data: base64 });
          }
          map.set(fileName, await nativePathFor(relPath));
        })
      );
      return map;
    })();
  }
  return fontPathsPromise;
}

/** Mirrors `buildExportPlan.ts`'s own text-track traversal (its `videoOut` loop over `project.sequence.
 *  tracks` where `track.kind === "text"`) exactly, so the set of clips this pre-writes a text file for
 *  is identical to the set `buildExportPlan` will actually ask `textFilePathFor` about. Duplicated
 *  rather than shared only because `textFilePathFor` itself must stay a SYNCHRONOUS callback (matching
 *  the server's `fs.writeFileSync`), while writing on native is unavoidably async — so every file this
 *  export could need has to be written up front, not lazily inside the callback. If `buildExportPlan`'s
 *  own text-track loop condition ever changes, this needs to change with it. */
function collectTextClips(project: Project): { clip: Clip; content: string }[] {
  const out: { clip: Clip; content: string }[] = [];
  for (const track of project.sequence.tracks) {
    if (track.kind !== "text" || !track.visible) continue;
    for (const clip of track.clips) {
      const asset = findAsset(project, clip.assetId);
      if (!asset || asset.kind !== "text" || !asset.textStyle) continue;
      out.push({ clip, content: asset.textContent ?? "" });
    }
  }
  return out;
}

async function writeTextFiles(project: Project): Promise<Map<string, string>> {
  const targets = collectTextClips(project);
  const map = new Map<string, string>();
  if (targets.length === 0) return map;

  await Filesystem.mkdir({ path: TEXT_SCRATCH_DIR, directory: Directory.Cache, recursive: true }).catch(() => {});
  await Promise.all(
    targets.map(async ({ clip, content }) => {
      const relPath = `${TEXT_SCRATCH_DIR}/${clip.id}.txt`;
      await Filesystem.writeFile({ path: relPath, directory: Directory.Cache, data: content, encoding: Encoding.UTF8 });
      const { uri } = await Filesystem.getUri({ path: relPath, directory: Directory.Cache });
      map.set(clip.id, stripFileScheme(uri));
    })
  );
  return map;
}

// `projectId` (the storage key `nativeStorage.ts` addresses `Directory.Data` folders with) and
// `project.id` (a separate internal identity field `createProject` stamps via `newId("proj")` — see
// its own doc comment) are DIFFERENT values by design, not interchangeable. Media lives under the
// storage key, so this must take `projectId` explicitly rather than reading `project.id` off the
// object — using the latter resolves every asset path under a directory that was never actually
// written to, which fails as "No such file or directory" only once FFmpeg actually tries to open it.
async function resolveAssetPaths(projectId: string, project: Project): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  await Promise.all(
    project.assets
      .filter((asset) => asset.relPath)
      .map(async (asset) => {
        map.set(asset.id, await nativePathFor(`${mediaDir(projectId)}/${asset.relPath}`));
      })
  );
  return map;
}

export async function nativeExportAvailable(): Promise<boolean> {
  return Capacitor.isPluginAvailable("Ffmpeg");
}

/** libx264 isn't in the FFmpeg engine bundled for on-device export (confirmed on a real device — see
 *  `buildExportPlan.ts`'s own comment on `videoEncoderArgs`); `libopenh264` is, and stays H.264/MP4 so
 *  playback compatibility matches desktop's output. openh264 has no CRF-style quality knob the way
 *  x264 does, only a target bitrate, so `project.exportSettings.crf` (meaningful only to x264's own
 *  scale) is translated into a bits-per-pixel figure instead — coarse, not a claim of equivalent
 *  output to what the same CRF value produces on desktop, just a reasonable size/quality tradeoff
 *  across this app's existing High/Balanced/Small-file quality presets. */
function openh264EncoderArgs(project: Project): string[] {
  const { width, height, fps, crf } = project.exportSettings;
  const bitsPerPixel = crf <= 18 ? 0.12 : crf <= 20 ? 0.09 : 0.05;
  const bitrateKbps = Math.round((width * height * fps * bitsPerPixel) / 1000);
  return ["-c:v", "libopenh264", "-b:v", `${bitrateKbps}k`];
}

export async function nativeStartExport(projectId: string, project: Project, fileName?: string): Promise<ExportStarted> {
  await Filesystem.mkdir({ path: exportsDir(projectId), directory: DIRECTORY, recursive: true }).catch(() => {});

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outFileName = `${(fileName || project.name || "export").replace(/[^A-Za-z0-9._-]/g, "_")}-${stamp}.mp4`;
  const outputPath = await nativePathFor(`${exportsDir(projectId)}/${outFileName}`);

  const [assetPaths, textFiles, fontPaths] = await Promise.all([
    resolveAssetPaths(projectId, project),
    writeTextFiles(project),
    collectTextClips(project).length > 0 ? primeFontPaths() : Promise.resolve(new Map<string, string>()),
  ]);

  const plan = buildExportPlan(project, {
    inputPathFor: (assetId) => {
      const path = assetPaths.get(assetId);
      if (!path) throw new ApiRequestError("A clip references media that is no longer in the project", 400, "missing-asset");
      return path;
    },
    outputPath,
    fontPathFor: (fontFileName) => {
      const path = fontPaths.get(fontFileName);
      if (!path) throw new ApiRequestError(`Missing bundled font file "${fontFileName}"`, 500, "font-missing");
      return path;
    },
    textFilePathFor: (clip) => {
      const path = textFiles.get(clip.id);
      if (!path) throw new ApiRequestError("A text clip's content wasn't prepared for export", 500, "text-file-missing");
      return path;
    },
    videoEncoderArgs: openh264EncoderArgs(project),
  });

  const jobId = newId("job");
  await Ffmpeg.run({ jobId, args: plan.args, duration: plan.duration });
  return { jobId, fileName: outFileName, duration: plan.duration };
}

export async function nativeCancelExport(jobId: string): Promise<void> {
  await Ffmpeg.cancel({ jobId }).catch(() => {});
}

export function nativeWatchExport(
  jobId: string,
  onUpdate: (progress: ExportProgress) => void,
  onError: (message: string) => void
): () => void {
  const handles: Promise<{ remove: () => Promise<void> } | null>[] = [];
  let settled = false;

  function stop(): void {
    for (const handle of handles) void handle.then((h) => h?.remove());
  }

  // Registration itself is async (crosses the native bridge) and can reject if the plugin somehow
  // isn't there — surfaced through the same `onError` the web `EventSource` path uses for "lost
  // contact," since both mean the same thing to the caller: progress can no longer be trusted.
  function addSafeListener(
    eventName: "progress" | "done" | "failed" | "cancelled",
    handler: (payload: FfmpegEventPayload) => void
  ): Promise<{ remove: () => Promise<void> } | null> {
    return Ffmpeg.addListener(eventName, handler).catch((err: unknown) => {
      onError(err instanceof Error ? err.message : String(err));
      return null;
    });
  }

  handles.push(
    addSafeListener("progress", (payload) => {
      if (payload.jobId !== jobId || settled) return;
      onUpdate({ status: "running", progress: payload.fraction ?? 0, fileName: "" });
    })
  );
  handles.push(
    addSafeListener("done", (payload) => {
      if (payload.jobId !== jobId || settled) return;
      settled = true;
      onUpdate({ status: "done", progress: 1, fileName: "" });
      stop();
    })
  );
  handles.push(
    addSafeListener("failed", (payload) => {
      if (payload.jobId !== jobId || settled) return;
      settled = true;
      onUpdate({ status: "failed", progress: 0, fileName: "", error: payload.error ?? "Export failed" });
      stop();
    })
  );
  handles.push(
    addSafeListener("cancelled", (payload) => {
      if (payload.jobId !== jobId || settled) return;
      settled = true;
      onUpdate({ status: "cancelled", progress: 0, fileName: "" });
      stop();
    })
  );

  return stop;
}

export async function nativeExportUrl(projectId: string, fileName: string): Promise<string> {
  const { uri } = await Filesystem.getUri({ path: `${exportsDir(projectId)}/${fileName}`, directory: DIRECTORY });
  return uri;
}

/** Copies a finished export into the device's own Gallery/Photos — see `FfmpegPlugin.kt`'s
 *  `saveToGallery` for why this exists alongside the explicit share sheet rather than instead of it:
 *  this is the automatic "don't lose it" path, the share sheet stays for picking a specific app to
 *  send it to. */
export async function nativeSaveExportToGallery(projectId: string, fileName: string): Promise<void> {
  const path = await nativePathFor(`${exportsDir(projectId)}/${fileName}`);
  await Ffmpeg.saveToGallery({ path, fileName });
}
