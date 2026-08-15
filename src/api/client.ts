import { deserializeProject } from "../project/serialize.ts";
import type { Asset, Project } from "../project/types.ts";

/** Browser-side client for VStudio's server routes.
 *
 *  All paths are relative, so this works unchanged whether the app is served from `next dev` on
 *  :3001 or from the packaged desktop app's own loopback port. */
const BASE = "/api/vstudio";

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
  const nameParam = projectName ? `&projectName=${encodeURIComponent(projectName)}` : "";
  const response = await fetch(`${BASE}/project?projectId=${encodeURIComponent(projectId)}${nameParam}`, { cache: "no-store" });
  const body = await unwrap<{ project: unknown }>(response);
  // Validated on the way in as well as on the way out of the server: a project that can't be read
  // correctly should fail loudly here rather than half-populate the editor.
  return deserializeProject(JSON.stringify(body.project));
}

export async function saveProject(projectId: string, project: Project): Promise<void> {
  const response = await fetch(`${BASE}/project?projectId=${encodeURIComponent(projectId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project }),
  });
  await unwrap<{ ok: boolean }>(response);
}

export async function importMedia(projectId: string, file: File): Promise<Asset> {
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
  const params = new URLSearchParams({ projectId, relPath: asset.relPath });
  if (asset.thumbnailRelPath) params.set("thumbnailRelPath", asset.thumbnailRelPath);
  if (asset.waveformRelPath) params.set("waveformRelPath", asset.waveformRelPath);
  await unwrap<{ ok: boolean }>(await fetch(`${BASE}/media?${params}`, { method: "DELETE" }));
}

/** URL for the actual media bytes — what a `<video>`/`<audio>` element's `src` points at. The route
 *  behind it supports HTTP Range, which is what makes seeking possible. */
export function mediaUrl(projectId: string, relPath: string): string {
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

export interface ExportStarted {
  jobId: string;
  fileName: string;
  duration: number;
}

export interface ExportProgress {
  status: "running" | "done" | "failed" | "cancelled";
  progress: number;
  fileName: string;
  error?: string;
}

export async function startExport(projectId: string, project: Project, fileName?: string): Promise<ExportStarted> {
  const response = await fetch(`${BASE}/export?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, fileName }),
  });
  return unwrap<ExportStarted>(response);
}

export async function cancelExport(jobId: string): Promise<void> {
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
    // EventSource fires this both for a genuine failure and for the normal close at end-of-stream,
    // so it's only a real error while the connection was still meant to be open.
    if (source.readyState !== EventSource.CLOSED) {
      onError("Lost contact with the export. It may still be running.");
    }
    source.close();
  };

  return () => source.close();
}

/** Whether the server can actually export right now (FFmpeg present and runnable). */
export async function exportAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE}/export`, { method: "HEAD" });
    return response.status === 204;
  } catch {
    return false;
  }
}
