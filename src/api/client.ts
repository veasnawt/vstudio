import { Capacitor } from "@capacitor/core";
import { deserializeProject } from "../project/serialize.ts";
import type { Asset, CustomFontAsset, CustomSfxAsset, LutAsset, Project } from "../project/types.ts";
import { nativeCancelExport, nativeExportAvailable, nativeStartExport, nativeWatchExport } from "./nativeExport.ts";
import { nativeDeleteMedia, nativeImportMedia, nativeLoadProject, nativeMediaUrl, nativeSaveProject } from "./nativeStorage.ts";

/** Browser-side client for VCut's server routes.
 *
 *  All paths are relative, so this works unchanged whether the app is served from `next dev` on
 *  :3001 or from the packaged desktop app's own loopback port. On the native (Capacitor) shell —
 *  where there is no server at all — each function below branches on `Capacitor.isNativePlatform()`
 *  and delegates to `nativeStorage.ts` instead, which is the ONE thing this session's mobile-app plan
 *  documents as needing per-function runtime branches rather than two parallel files (Capacitor
 *  bundles a single JS build that must also run in a plain dev browser). */
const BASE = "/api/vcut";
const isNative = Capacitor.isNativePlatform();

export class ApiRequestError extends Error {
  code?: string;
  status: number;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

async function unwrap<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  // Routes report failures as JSON `{ error, code }`; anything else (a crash, a proxy error page)
  // still has to produce a usable message rather than "unexpected token < in JSON".
  let message = `Request failed (${response.status})`;
  let code: string | undefined;
  try {
    const body = (await response.json()) as { error?: string; code?: string };
    if (body?.error) message = body.error;
    code = body?.code;
  } catch {
    /* keep the status-based message */
  }
  throw new ApiRequestError(message, response.status, code);
}

/** `projectName` is only ever CONSULTED server-side when no project exists yet at this id — it seeds
 *  the real `project.name` on first creation (see the route's own comment for why that matters: a
 *  host app's title would otherwise never make it past a display-only prop). Ignored entirely for an
 *  already-existing project, which keeps whatever name it was actually given/renamed to. */
export async function loadProject(projectId: string, projectName?: string): Promise<Project> {
  if (isNative) return nativeLoadProject(projectId, projectName);
  const nameParam = projectName ? `&projectName=${encodeURIComponent(projectName)}` : "";
  const response = await fetch(`${BASE}/project?projectId=${encodeURIComponent(projectId)}${nameParam}`, { cache: "no-store" });
  const body = await unwrap<{ project: unknown }>(response);
  // Validated on the way in as well as on the way out of the server: a project that can't be read
  // correctly should fail loudly here rather than half-populate the editor.
  return deserializeProject(JSON.stringify(body.project));
}

export async function saveProject(projectId: string, project: Project): Promise<void> {
  if (isNative) return nativeSaveProject(projectId, project);
  const response = await fetch(`${BASE}/project?projectId=${encodeURIComponent(projectId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project }),
  });
  await unwrap<{ ok: boolean }>(response);
}

export async function importMedia(projectId: string, file: File): Promise<Asset> {
  if (isNative) return nativeImportMedia(projectId, file);
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${BASE}/media?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    body: form,
  });
  const body = await unwrap<{ asset: Asset }>(response);
  return body.asset;
}

export async function deleteMedia(projectId: string, asset: Asset): Promise<void> {
  // A text asset has no backing file at all (`relPath` is always `""` — see project/types.ts), so
  // there's nothing on disk to ask the server to remove. Skipping the request entirely rather than
  // sending an empty relPath avoids a pointless round-trip for the one asset kind that never needs it.
  if (!asset.relPath) return;
  if (isNative) return nativeDeleteMedia(projectId, asset);
  const params = new URLSearchParams({ projectId, relPath: asset.relPath });
  if (asset.thumbnailRelPath) params.set("thumbnailRelPath", asset.thumbnailRelPath);
  if (asset.waveformRelPath) params.set("waveformRelPath", asset.waveformRelPath);
  await unwrap<{ ok: boolean }>(await fetch(`${BASE}/media?${params}`, { method: "DELETE" }));
}

/** URL for the actual media bytes — what a `<video>`/`<audio>` element's `src` points at. The route
 *  behind it supports HTTP Range, which is what makes seeking possible (native uses
 *  `Capacitor.convertFileSrc`, whose local scheme handler supports Range natively too). */
export function mediaUrl(projectId: string, relPath: string): string {
  if (isNative) return nativeMediaUrl(projectId, relPath);
  return `${BASE}/media/raw?projectId=${encodeURIComponent(projectId)}&relPath=${encodeURIComponent(relPath)}`;
}

export function thumbnailUrl(projectId: string, asset: Asset): string | null {
  // Images are their own preview; everything else needs a generated thumbnail to have one.
  if (asset.kind === "image") return mediaUrl(projectId, asset.relPath);
  if (!asset.thumbnailRelPath) return null;
  return `${mediaUrl(projectId, asset.thumbnailRelPath)}&kind=thumbnail`;
}

/** The multi-frame sprite `TimelineClip` tiles for a filmstrip — `null` for anything that doesn't have
 *  one (audio, text, images, or a video imported before this existed), in which case the caller falls
 *  back to `thumbnailUrl`'s single frame. */
export function filmstripUrl(projectId: string, asset: Asset): string | null {
  if (!asset.filmstripRelPath) return null;
  return `${mediaUrl(projectId, asset.filmstripRelPath)}&kind=thumbnail`;
}

/** A waveform PNG spanning the asset's FULL duration — `null` for anything that doesn't have one
 *  (non-audio, or an audio file FFmpeg couldn't read). `TimelineClip` stretches/positions it via CSS
 *  to match each clip's own trim, the same way `filmstripUrl`'s sprite is tiled rather than the
 *  frontend doing any per-clip image generation of its own. */
export function waveformUrl(projectId: string, asset: Asset): string | null {
  if (!asset.waveformRelPath) return null;
  return `${mediaUrl(projectId, asset.waveformRelPath)}&kind=thumbnail`;
}

export function exportUrl(projectId: string, fileName: string): string {
  return `${mediaUrl(projectId, fileName)}&kind=export`;
}

/** URL for one bundled `SFX_REGISTRY` catalog entry's audio file (`project/sfx.ts`'s own `file`) —
 *  served as a plain static asset, not project-scoped the way `mediaUrl` is: a bundled sound effect
 *  isn't stored per-project, it ships with the app the same way a bundled font's `.ttf` does (see
 *  `fonts.ts`'s own `resolveFontVariant` doc comment for the matching "packages/vcut/assets/" bundled-
 *  file convention this mirrors, one directory over — `packages/vcut/assets/sfx/`).
 *
 *  Routed through `sfx/[file]/route.ts` (`_lib/sfx.ts`'s `sfxAssetPath`), same as every other bundled
 *  asset this app serves via its own API route rather than Next's `public/` static folder — there's
 *  no `studios/vcut/public/sfx/` directory for a bare `/sfx/${file}` to ever resolve against. */
export function sfxAssetUrl(file: string): string {
  return `${BASE}/sfx/${file}`;
}

/** URL for one entry in the project's own "My Sounds" library (`project.customSfx`) — reuses
 *  `mediaUrl`'s exact same project-relative-path convention a placed `Asset` uses, since a
 *  `CustomSfxAsset` lives in the SAME project media tree, just not itself placed on the timeline (see
 *  `CustomSfxAsset`'s own doc comment for why it's a separate library, not a plain `Asset`). */
export function customSfxUrl(projectId: string, sfx: CustomSfxAsset): string {
  return `${mediaUrl(projectId, sfx.relPath)}&kind=customSfx`;
}

/** Imports a file into the project's own "My Sounds" library — same `FormData` upload shape as
 *  `importMedia`, against a dedicated route so the result lands in `project.customSfx` (a reusable
 *  library entry) rather than `project.assets` (a placeable clip source); see `CustomSfxAsset`'s own
 *  doc comment for why the two are kept separate. No native branch yet — same v1 scope cut
 *  `startInpaint`/`startCaptions` already document for a feature that needs the desktop/browser server,
 *  not (yet) the on-device native shell. */
export async function importCustomSfx(projectId: string, file: File): Promise<CustomSfxAsset> {
  if (isNative) throw new ApiRequestError("Importing sound effects isn't available on this device yet.", 501, "sfx-unavailable");
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${BASE}/sfx?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    body: form,
  });
  const body = await unwrap<{ sfx: CustomSfxAsset }>(response);
  return body.sfx;
}

/** Removes one "My Sounds" library entry — `sfxId`-keyed, matching `sfx/route.ts`'s own `DELETE`
 *  handler exactly (it looks the entry up by id to find its own `relPath` server-side, the same
 *  "id in, full updated project back out" shape `deleteLut` uses). */
export async function deleteCustomSfx(projectId: string, sfx: CustomSfxAsset): Promise<Project> {
  // Unreachable in practice today — `importCustomSfx` already refuses on native, so there's never a
  // "My Sounds" entry to remove there — but throws rather than silently no-opping for the same
  // "surface the real reason, don't pretend it worked" consistency `importLut`/`importCustomFont` give.
  if (isNative) throw new ApiRequestError("Removing sound effects isn't available on this device yet.", 501, "sfx-unavailable");
  const params = new URLSearchParams({ projectId, sfxId: sfx.id });
  const body = await unwrap<{ project: Project }>(await fetch(`${BASE}/sfx?${params}`, { method: "DELETE" }));
  return body.project;
}

/** URL for one entry in the project's own LUT library (`project.luts`) — a fetchable `.cube` text file,
 *  same `media/raw`-route-with-a-`kind`-tag shape `thumbnailUrl`/`filmstripUrl` already use, just
 *  `kind=lut` instead of `kind=thumbnail` (see that route's own `CONTENT_TYPES`/`baseDir` comment for
 *  why `.cube` is served through this same generic route rather than a dedicated one). Read by
 *  `PlaybackEngine.lutUrlFor` (live preview) — export never fetches this URL at all, it hands FFmpeg
 *  the LUT's real on-disk path directly (`export/lutFilter.ts`). */
export function lutUrl(projectId: string, lut: LutAsset): string {
  return `${mediaUrl(projectId, lut.relPath)}&kind=lut`;
}

/** Imports a `.cube` file into the project's own LUT library — same `FormData` upload shape as
 *  `importCustomSfx`, against `lut/route.ts` instead. No native branch yet, same v1 scope cut. */
export async function importLut(projectId: string, file: File): Promise<LutAsset> {
  if (isNative) throw new ApiRequestError("Importing LUTs isn't available on this device yet.", 501, "lut-unavailable");
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${BASE}/lut?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    body: form,
  });
  const body = await unwrap<{ lut: LutAsset }>(response);
  return body.lut;
}

/** Removes a LUT from the project's library and cascades the clear across every clip that referenced it
 *  — `lut/route.ts`'s own `DELETE` does the cascade server-side and hands back the fully-updated
 *  project, so the caller swaps it straight in rather than reconciling clip-level `lutId`s itself. */
export async function deleteLut(projectId: string, lutId: string): Promise<Project> {
  if (isNative) throw new ApiRequestError("Removing LUTs isn't available on this device yet.", 501, "lut-unavailable");
  const params = new URLSearchParams({ projectId, lutId });
  const body = await unwrap<{ project: Project }>(await fetch(`${BASE}/lut?${params}`, { method: "DELETE" }));
  return body.project;
}

/** URL for one entry in the project's own custom-font library (`project.customFonts`) — same
 *  `kind`-tagged `media/raw` shape as `lutUrl`, just `kind=customFont`. Fetched by
 *  `registerCustomFont` (`project/fonts.ts`) to construct the real `FontFace` a bundled font's static
 *  `@font-face` rule already gives it for free. */
export function customFontUrl(projectId: string, font: CustomFontAsset): string {
  return `${mediaUrl(projectId, font.relPath)}&kind=customFont`;
}

/** Imports a `.ttf`/`.otf` file into the project's own custom-font library — same shape as
 *  `importCustomSfx`, against `fonts/route.ts` instead. */
export async function importCustomFont(projectId: string, file: File): Promise<CustomFontAsset> {
  if (isNative) throw new ApiRequestError("Importing fonts isn't available on this device yet.", 501, "font-unavailable");
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${BASE}/fonts?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    body: form,
  });
  const body = await unwrap<{ font: CustomFontAsset }>(response);
  return body.font;
}

/** Removes one custom-font library entry — same `id`-keyed delete shape `fonts/route.ts`'s own
 *  `DELETE` expects (a custom font needs no clip-level cascade — see that route's own doc comment for
 *  why `fontById`'s existing fallback already covers it). Returns the server's own updated `Project`,
 *  same "client applies what the server actually persisted, never a local guess" shape `deleteLut`
 *  already uses — the route already computes and returns exactly this. */
export async function deleteCustomFont(projectId: string, font: CustomFontAsset): Promise<Project> {
  if (isNative) throw new ApiRequestError("Removing fonts isn't available on this device yet.", 501, "font-unavailable");
  const params = new URLSearchParams({ projectId, fontId: font.id });
  const body = await unwrap<{ project: Project }>(await fetch(`${BASE}/fonts?${params}`, { method: "DELETE" }));
  return body.project;
}

export interface ExportStarted {
  jobId: string;
  fileName: string;
  duration: number;
}

export interface ExportProgress {
  status: "running" | "done" | "failed" | "cancelled";
  /** `preparing`/`rendering-text` cover everything before FFmpeg exists to report a real `progress`
   *  fraction (the Khmer pre-pass's own browser launch and per-clip text rendering) — `message` is a
   *  human-readable status for exactly those two phases; `encoding` is everything after, where
   *  `progress` is the meaningful number. Optional (native mobile export has no such pre-pass phase
   *  at all — see `nativeExport.ts` — so its own progress payloads never set this). */
  phase?: "preparing" | "rendering-text" | "encoding";
  message?: string;
  progress: number;
  fileName: string;
  error?: string;
}

export async function startExport(projectId: string, project: Project, fileName?: string): Promise<ExportStarted> {
  if (isNative) return nativeStartExport(projectId, project, fileName);
  const response = await fetch(`${BASE}/export?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, fileName }),
  });
  return unwrap<ExportStarted>(response);
}

/** Finds the currently-running export for a project, if any — `null` when nothing's running.
 *  `startExport` rejects a second concurrent export for the same project (see its own route's doc
 *  comment), which is correct for a genuine double-submit but leaves nothing for a FRESH dialog to
 *  do with that 409 by itself: a page reload, a second tab, or just re-opening the dialog after
 *  closing it all lose the in-memory `jobIdRef` a running export needs to be watched or cancelled by.
 *  This is what lets the dialog recover from any of those — see its own call site. */
export async function findRunningExport(projectId: string): Promise<string | null> {
  if (isNative) return null; // native export has no server-side job registry to look one up in
  const response = await fetch(`${BASE}/export?projectId=${encodeURIComponent(projectId)}`);
  const { jobId } = await unwrap<{ jobId: string | null }>(response);
  return jobId;
}

export async function cancelExport(jobId: string): Promise<void> {
  if (isNative) return nativeCancelExport(jobId);
  // A cancel racing the job's own completion is normal, not an error worth surfacing.
  await fetch(`${BASE}/export?jobId=${encodeURIComponent(jobId)}`, { method: "DELETE" }).catch(() => {});
}

/** Subscribes to an export's progress. Returns an unsubscribe function that also closes the stream.
 *
 *  Uses `EventSource` rather than polling so the UI updates as FFmpeg reports progress, with no
 *  request storm and no artificial lag between the render finishing and the user being told. */
export function watchExport(
  jobId: string,
  onUpdate: (progress: ExportProgress) => void,
  onError: (message: string) => void
): () => void {
  if (isNative) return nativeWatchExport(jobId, onUpdate, onError);
  const source = new EventSource(`${BASE}/export?jobId=${encodeURIComponent(jobId)}`);

  source.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data) as ExportProgress;
      onUpdate(payload);
      if (payload.status !== "running") source.close();
    } catch {
      /* a malformed frame is not worth tearing the stream down over */
    }
  };

  source.onerror = () => {
    // `readyState` tells apart two very differently-shaped situations `onerror` fires for, and only
    // one of them is a real failure. `CONNECTING` means the browser's own EventSource just lost the
    // connection and is ALREADY retrying it on its own (the platform-standard behavior — no code here
    // makes that happen) — exactly what a plain network blip, a proxy/browser recycling a
    // long-idle-looking connection, or a laptop waking from sleep looks like, and utterly routine for
    // an export that runs several minutes. `CLOSED` means the browser gave up retrying for good
    // (a non-2xx response, e.g. the 404 `job-missing` the route throws once a finished job's own
    // cleanup timer removes it, or the dev server restarting mid-export) — that one really is over.
    // Calling `close()` unconditionally here (an earlier version of this did) used to treat the FIRST
    // case as fatal too, tearing down the very retry already in flight and orphaning the UI from a
    // job that was still running server-side the whole time. Confirmed as the actual cause of exports
    // reported as silently "not working": a 60fps/High-quality render can run many minutes longer
    // than the defaults, which doesn't break anything about FFmpeg — it just keeps the connection
    // open long enough to hit an ordinary drop before finishing, which the defaults rarely do.
    if (source.readyState === EventSource.CLOSED) {
      onError("Lost contact with the export. It may still be running.");
    }
  };

  return () => source.close();
}

/** Whether export can actually work right now — on native, whether the `Ffmpeg` plugin registered
 *  (see `FfmpegPlugin.kt`); on the server, whether FFmpeg is present and runnable. */
export async function exportAvailable(): Promise<boolean> {
  if (isNative) return nativeExportAvailable();
  try {
    const response = await fetch(`${BASE}/export`, { method: "HEAD" });
    return response.status === 204;
  } catch {
    return false;
  }
}

export interface SourceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InpaintStarted {
  jobId: string;
}

export interface InpaintProgress {
  status: "running" | "done" | "failed" | "cancelled";
  stage: "extracting" | "masking" | "uploading" | "predicting" | "downloading" | "importing";
  progress: number;
  error?: string;
  /** Present once `status === "done"` — the client lands this directly via `landInpaintedAsset`,
   *  no second round-trip needed. */
  asset?: Asset;
}

/** Starts a "Remove Object" job for one clip — desktop/browser-server-backed only for v1, same as
 *  export (no native branch: this needs the same not-yet-built on-device FFmpeg plugin export does,
 *  plus network access for the cloud model itself). `backgroundPrompt` only matters for the fal.ai
 *  provider (its VOID model requires a description of what should fill the removed region); the
 *  server ignores it harmlessly when Replicate is active. */
export async function startInpaint(
  projectId: string,
  clipId: string,
  rect: SourceRect,
  backgroundPrompt?: string
): Promise<InpaintStarted> {
  if (isNative) throw new ApiRequestError("Remove Object isn't available on this device yet.", 501, "inpaint-unavailable");
  const response = await fetch(`${BASE}/inpaint?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clipId, rect, ...(backgroundPrompt ? { backgroundPrompt } : null) }),
  });
  return unwrap<InpaintStarted>(response);
}

export async function cancelInpaint(jobId: string): Promise<void> {
  if (isNative) return;
  // A cancel racing the job's own completion is normal, not an error worth surfacing — same
  // reasoning as `cancelExport`.
  await fetch(`${BASE}/inpaint?jobId=${encodeURIComponent(jobId)}`, { method: "DELETE" }).catch(() => {});
}

/** Subscribes to a "Remove Object" job's progress. Identical shape to `watchExport` — see its own
 *  comment for why `EventSource` over polling. */
export function watchInpaint(
  jobId: string,
  onUpdate: (progress: InpaintProgress) => void,
  onError: (message: string) => void
): () => void {
  if (isNative) {
    onError("Remove Object isn't available on this device yet.");
    return () => {};
  }
  const source = new EventSource(`${BASE}/inpaint?jobId=${encodeURIComponent(jobId)}`);

  source.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data) as InpaintProgress;
      onUpdate(payload);
      if (payload.status !== "running") source.close();
    } catch {
      /* a malformed frame is not worth tearing the stream down over */
    }
  };

  source.onerror = () => {
    // See `watchExport`'s own comment on this exact check — `CONNECTING` means EventSource is
    // already retrying a dropped connection on its own (routine for a job that runs any real
    // length of time); only `CLOSED` means the browser gave up for good.
    if (source.readyState === EventSource.CLOSED) {
      onError("Lost contact with the job. It may still be running.");
    }
  };

  return () => source.close();
}

/** Whether "Remove Object" is usable right now — FFmpeg present AND the active provider has a key
 *  saved. */
export async function inpaintAvailable(): Promise<boolean> {
  if (isNative) return false;
  try {
    const response = await fetch(`${BASE}/inpaint`, { method: "HEAD" });
    return response.status === 204;
  } catch {
    return false;
  }
}

/** "local" runs entirely on this machine (self-hosted ProPainter, see `getLocalSetupStatus`/
 *  `startLocalSetup` below) — no key/token concept, unlike the two cloud providers. */
export type InpaintProvider = "replicate" | "fal" | "local";
type CloudInpaintProvider = "replicate" | "fal";

export interface InpaintKeyStatus {
  activeProvider: InpaintProvider;
  configured: Record<InpaintProvider, boolean>;
}

export async function getInpaintKeyStatus(): Promise<InpaintKeyStatus | null> {
  if (isNative) return null;
  try {
    const response = await fetch(`${BASE}/inpaint/settings`);
    return unwrap<InpaintKeyStatus>(response);
  } catch {
    return null;
  }
}

/** Saves a cloud provider's API key. Saving also activates that provider — same "one action does
 *  both" behavior Rixie's own `setApiKey` uses. Never called with `"local"` — it has no key. */
export async function setInpaintApiKey(provider: CloudInpaintProvider, apiKey: string): Promise<void> {
  if (isNative) throw new ApiRequestError("Not available on this device yet.", 501, "inpaint-unavailable");
  const response = await fetch(`${BASE}/inpaint/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, apiKey }),
  });
  await unwrap<{ ok: true }>(response);
}

/** Switches the active provider without touching any saved key — for a provider that already has
 *  one configured (or, for `"local"`, one that's already set up). */
export async function setActiveInpaintProvider(provider: InpaintProvider): Promise<void> {
  if (isNative) throw new ApiRequestError("Not available on this device yet.", 501, "inpaint-unavailable");
  const response = await fetch(`${BASE}/inpaint/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider }),
  });
  await unwrap<{ ok: true }>(response);
}

export interface LocalSetupProgress {
  status: "running" | "done" | "failed" | "cancelled";
  stage: "cloning" | "venv" | "installing" | "finalizing";
  progress: number;
  error?: string;
}

/** Whether the local ProPainter runtime (Python venv + cloned repo) is provisioned — the Inspector
 *  calls this to decide between offering "Set up local model" and the normal ready-to-use flow. */
export async function getLocalSetupStatus(): Promise<{ ready: boolean } | null> {
  if (isNative) return null;
  try {
    const response = await fetch(`${BASE}/inpaint/local-setup`);
    return unwrap<{ ready: boolean }>(response);
  } catch {
    return null;
  }
}

/** Starts provisioning the local Python runtime — long-running (several minutes, network + disk
 *  heavy), same fire-and-track-via-SSE shape as `startInpaint`/`watchInpaint`. */
export async function startLocalSetup(): Promise<{ jobId: string }> {
  if (isNative) throw new ApiRequestError("Not available on this device yet.", 501, "inpaint-unavailable");
  const response = await fetch(`${BASE}/inpaint/local-setup`, { method: "POST" });
  return unwrap<{ jobId: string }>(response);
}

export async function cancelLocalSetup(jobId: string): Promise<void> {
  if (isNative) return;
  await fetch(`${BASE}/inpaint/local-setup?jobId=${encodeURIComponent(jobId)}`, { method: "DELETE" }).catch(() => {});
}

/** Subscribes to a local-setup job's progress. Identical shape to `watchInpaint`. */
export function watchLocalSetup(
  jobId: string,
  onUpdate: (progress: LocalSetupProgress) => void,
  onError: (message: string) => void
): () => void {
  if (isNative) {
    onError("Not available on this device yet.");
    return () => {};
  }
  const source = new EventSource(`${BASE}/inpaint/local-setup?jobId=${encodeURIComponent(jobId)}`);

  source.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data) as LocalSetupProgress;
      onUpdate(payload);
      if (payload.status !== "running") source.close();
    } catch {
      /* a malformed frame is not worth tearing the stream down over */
    }
  };

  source.onerror = () => {
    // See `watchExport`'s own comment on this exact check — `CONNECTING` means EventSource is
    // already retrying a dropped connection on its own; only `CLOSED` means it gave up for good.
    if (source.readyState === EventSource.CLOSED) {
      onError("Lost contact with the setup job. It may still be running.");
    }
  };

  return () => source.close();
}

// ---------------------------------------------------------------------------
// Auto Captions — same fire-and-track-via-SSE job shape as Remove Object
// (startInpaint/watchInpaint/cancelInpaint/inpaintAvailable above), against
// /api/vcut/captions instead. One provider (OpenAI Whisper), so the
// key-status/save functions are simpler than Remove Object's own
// multi-provider equivalents — no provider argument, no "active provider"
// concept.
// ---------------------------------------------------------------------------

export interface CaptionsStarted {
  jobId: string;
}

export interface CaptionSegment {
  content: string;
  /** Absolute sequence-timeline seconds — already offset server-side, ready to place directly. */
  start: number;
  end: number;
}

export interface CaptionsProgress {
  status: "running" | "done" | "failed" | "cancelled";
  stage: "extracting-audio" | "transcribing" | "building-captions";
  progress: number;
  error?: string;
  /** Present once `status === "done"` — raw segments, not yet real assets/clips. The caller (Inspector's
   *  Auto Captions section, the toolbar's Auto Captions dialog) hands these to
   *  `useEditorStore.getState().landCaptions`, which is what actually creates the text assets and
   *  places their clips as one undo-able step. */
  captions?: CaptionSegment[];
}

/** Starts an Auto Captions job. `clipId` present = transcribe just that clip's own on-screen time
 *  range; omitted = transcribe the whole sequence. Desktop/browser-server-backed only for v1, same as
 *  `startInpaint`. */
export async function startCaptions(projectId: string, clipId?: string): Promise<CaptionsStarted> {
  if (isNative) throw new ApiRequestError("Auto Captions isn't available on this device yet.", 501, "captions-unavailable");
  const response = await fetch(`${BASE}/captions?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(clipId ? { clipId } : {}),
  });
  return unwrap<CaptionsStarted>(response);
}

export async function cancelCaptions(jobId: string): Promise<void> {
  if (isNative) return;
  // A cancel racing the job's own completion is normal, not an error worth surfacing.
  await fetch(`${BASE}/captions?jobId=${encodeURIComponent(jobId)}`, { method: "DELETE" }).catch(() => {});
}

/** Subscribes to an Auto Captions job's progress. Identical shape to `watchInpaint`. */
export function watchCaptions(jobId: string, onUpdate: (progress: CaptionsProgress) => void, onError: (message: string) => void): () => void {
  if (isNative) {
    onError("Auto Captions isn't available on this device yet.");
    return () => {};
  }
  const source = new EventSource(`${BASE}/captions?jobId=${encodeURIComponent(jobId)}`);

  source.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data) as CaptionsProgress;
      onUpdate(payload);
      if (payload.status !== "running") source.close();
    } catch {
      /* a malformed frame is not worth tearing the stream down over */
    }
  };

  source.onerror = () => {
    if (source.readyState !== EventSource.CLOSED) {
      onError("Lost contact with the captions job. It may still be running.");
    }
    source.close();
  };

  return () => source.close();
}

/** Whether Auto Captions is usable right now — FFmpeg present AND an OpenAI key saved. */
export async function captionsAvailable(): Promise<boolean> {
  if (isNative) return false;
  try {
    const response = await fetch(`${BASE}/captions`, { method: "HEAD" });
    return response.status === 204;
  } catch {
    return false;
  }
}

export interface CaptionsKeyStatus {
  configured: boolean;
}

export async function getCaptionsKeyStatus(): Promise<CaptionsKeyStatus | null> {
  if (isNative) return null;
  try {
    const response = await fetch(`${BASE}/captions/settings`);
    return unwrap<CaptionsKeyStatus>(response);
  } catch {
    return null;
  }
}

export async function setCaptionsApiKey(apiKey: string): Promise<void> {
  if (isNative) throw new ApiRequestError("Not available on this device yet.", 501, "captions-unavailable");
  const response = await fetch(`${BASE}/captions/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  await unwrap<{ ok: true }>(response);
}
