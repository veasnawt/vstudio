"use client";

import { Capacitor } from "@capacitor/core";
import { Share } from "@capacitor/share";
import { useEffect, useRef, useState } from "react";
import { cancelExport, exportAvailable, exportUrl, startExport, watchExport } from "../api/client.ts";
import { nativeExportUrl, nativeSaveExportToGallery } from "../api/nativeExport.ts";
import { trimProjectToRange } from "../export/trimForExport.ts";
import { sequenceDuration } from "../project/createProject.ts";
import { FPS_PRESETS, RESOLUTION_PRESETS } from "../project/types.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { formatTimecode } from "../timeline/time.ts";
import { Dropdown } from "./Dropdown.tsx";

type Phase = "idle" | "running" | "done" | "failed" | "cancelled";

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useEditorStore((s) => s.project);
  const projectId = useEditorStore((s) => s.projectId);
  const save = useEditorStore((s) => s.save);
  const exportRangeStart = useEditorStore((s) => s.exportRangeStart);
  const exportRangeEnd = useEditorStore((s) => s.exportRangeEnd);
  const clearExportRange = useEditorStore((s) => s.clearExportRange);

  const total = project ? sequenceDuration(project) : 0;
  const hasRange = exportRangeStart !== null || exportRangeEnd !== null;

  const [width, setWidth] = useState(project?.exportSettings.width ?? 1080);
  const [height, setHeight] = useState(project?.exportSettings.height ?? 1920);
  const [fps, setFps] = useState(project?.exportSettings.fps ?? 30);
  const [crf, setCrf] = useState(project?.exportSettings.crf ?? 20);

  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [sharing, setSharing] = useState(false);
  // Native only — an export left sitting only in the app's own private storage is easy to lose track
  // of, so a finished render is copied into the device's Gallery automatically (see
  // `nativeSaveExportToGallery`) rather than requiring a manual "Save / Share" tap just to keep a
  // copy. That button stays for picking a specific app to send it to.
  const [gallerySave, setGallerySave] = useState<"idle" | "saving" | "done" | "failed">("idle");

  const isNative = Capacitor.isNativePlatform();

  const jobIdRef = useRef<string | null>(null);
  const unwatchRef = useRef<(() => void) | null>(null);

  // Checked up front rather than on click: if export can't work, the dialog says so plainly instead
  // of presenting a button that fails.
  useEffect(() => {
    void exportAvailable().then(setAvailable);
  }, []);

  useEffect(() => () => unwatchRef.current?.(), []);

  async function autoSaveToGallery(name: string) {
    if (!projectId) return;
    setGallerySave("saving");
    try {
      await nativeSaveExportToGallery(projectId, name);
      setGallerySave("done");
    } catch {
      // Not surfaced as a full export failure — the render itself succeeded, this is just the
      // automatic copy-to-gallery step; the "Save / Share" button below still works as a fallback.
      setGallerySave("failed");
    }
  }

  async function begin() {
    if (!project || !projectId) return;
    setError(null);
    setProgress(0);
    setPhase("running");
    setGallerySave("idle");

    // The export renders whatever the SERVER has, so an unsaved edit would silently export a stale
    // timeline. Saving first makes what's exported match what's on screen.
    await save();

    try {
      const settings = { ...project.exportSettings, width, height, fps, crf };

      // Only clone/trim when a real (non-full) range is set — an untouched export keeps sending
      // the original project object, unchanged from before this feature existed.
      const { start, end } = useEditorStore.getState().exportRange();
      const seqTotal = sequenceDuration(project);
      const isFullRange = start <= 1e-6 && end >= seqTotal - 1e-6;
      const exportProject = isFullRange ? project : trimProjectToRange(project, start, end);

      const started = await startExport(projectId, { ...exportProject, exportSettings: settings });
      jobIdRef.current = started.jobId;
      setFileName(started.fileName);

      unwatchRef.current = watchExport(
        started.jobId,
        (update) => {
          setProgress(update.progress);
          if (update.status === "done") {
            setPhase("done");
            if (isNative) void autoSaveToGallery(started.fileName);
          } else if (update.status === "failed") {
            setPhase("failed");
            setError(update.error ?? "Export failed");
          } else if (update.status === "cancelled") setPhase("cancelled");
        },
        (message) => {
          setPhase("failed");
          setError(message);
        }
      );
    } catch (err) {
      setPhase("failed");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function stop() {
    if (jobIdRef.current) await cancelExport(jobIdRef.current);
  }

  // Native has no browser download — a `download` anchor is meaningless in a WebView. The OS share
  // sheet (save to Files, send to another app, etc.) is the native equivalent of "here's your file."
  async function shareNative() {
    if (!projectId || !fileName) return;
    setSharing(true);
    try {
      const url = await nativeExportUrl(projectId, fileName);
      // `files` (a real attachment another app can read), not `url` — `url` is for sharing a WEB
      // link/text, and silently degrades to just the `title` text when handed a local file:// path
      // instead, which is exactly what looked like "sharing only copies the text, not the video."
      await Share.share({ files: [url], title: fileName, dialogTitle: "Save or share video" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSharing(false);
    }
  }

  const busy = phase === "running";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={() => {
        if (!busy) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Export video"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-white/10 bg-[#12151c] p-5 shadow-2xl"
      >
        <h2 className="text-sm font-semibold text-white">Export</h2>

        {available === false ? (
          <p className="mt-3 rounded-lg bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200">
            FFmpeg isn&apos;t available on this machine, so VStudio can&apos;t render a file. Reinstall dependencies
            (<code className="font-mono">pnpm install</code>) to restore it.
          </p>
        ) : (
          <>
            {hasRange && (
              <div className="mt-4 flex items-center justify-between rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                <span>
                  Exporting range {formatTimecode(Math.min(exportRangeStart ?? 0, exportRangeEnd ?? total), fps)}{" "}
                  – {formatTimecode(Math.max(exportRangeStart ?? 0, exportRangeEnd ?? total), fps)}
                </span>
                <button
                  disabled={busy}
                  onClick={clearExportRange}
                  className="font-medium text-amber-100 underline decoration-amber-100/40 underline-offset-2 transition hover:text-white disabled:opacity-50"
                >
                  Reset to full timeline
                </button>
              </div>
            )}

            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-white/50">
                  Resolution
                </span>
                <Dropdown
                  disabled={busy}
                  ariaLabel="Resolution"
                  value={`${width}x${height}`}
                  onChange={(next) => {
                    const [w, h] = next.split("x").map(Number);
                    setWidth(w);
                    setHeight(h);
                  }}
                  options={RESOLUTION_PRESETS.map((preset) => ({
                    value: `${preset.width}x${preset.height}`,
                    label: preset.label,
                  }))}
                />
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-white/50">
                    Frame rate
                  </span>
                  <Dropdown
                    disabled={busy}
                    ariaLabel="Frame rate"
                    value={String(fps)}
                    onChange={(next) => setFps(Number(next))}
                    options={FPS_PRESETS.map((value) => ({ value: String(value), label: `${value} fps` }))}
                  />
                </label>

                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-white/50">
                    Quality
                  </span>
                  {/* CRF is inverted (lower = better), which is unintuitive — the labels say what the
                      user actually cares about and keep the numbers out of the way. */}
                  <Dropdown
                    disabled={busy}
                    ariaLabel="Quality"
                    value={String(crf)}
                    onChange={(next) => setCrf(Number(next))}
                    options={[
                      { value: "18", label: "High" },
                      { value: "20", label: "Balanced" },
                      { value: "26", label: "Small file" },
                    ]}
                  />
                </label>
              </div>
            </div>

            {phase !== "idle" && (
              <div className="mt-4">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className={`h-full rounded-full transition-all ${
                      phase === "failed" ? "bg-rose-400" : phase === "done" ? "bg-emerald-400" : "bg-sky-400"
                    }`}
                    style={{ width: `${Math.round((phase === "done" ? 1 : progress) * 100)}%` }}
                  />
                </div>
                <p className="mt-2 text-[11px] text-white/60">
                  {phase === "running" && `Rendering… ${Math.round(progress * 100)}%`}
                  {phase === "done" && "Export complete"}
                  {phase === "cancelled" && "Export cancelled"}
                  {phase === "failed" && <span className="text-rose-300">{error}</span>}
                </p>
                {phase === "done" && isNative && (
                  <p className="mt-1 text-[11px] text-white/40">
                    {gallerySave === "saving" && "Saving to Gallery…"}
                    {gallerySave === "done" && "Saved to Gallery"}
                    {gallerySave === "failed" && (
                      <span className="text-amber-300">Couldn&apos;t auto-save — use Save / Share below</span>
                    )}
                  </p>
                )}
              </div>
            )}

            <div className="mt-5 flex items-center justify-end gap-2">
              {phase === "done" && fileName && projectId && (
                isNative ? (
                  <button
                    onClick={() => void shareNative()}
                    disabled={sharing}
                    className="mr-auto rounded-md bg-emerald-500/20 px-3 py-1.5 text-xs font-medium text-emerald-200 transition hover:bg-emerald-500/30 disabled:opacity-50"
                  >
                    {sharing ? "Sharing…" : "Save / Share"}
                  </button>
                ) : (
                  <a
                    href={exportUrl(projectId, fileName)}
                    download={fileName}
                    className="mr-auto rounded-md bg-emerald-500/20 px-3 py-1.5 text-xs font-medium text-emerald-200 transition hover:bg-emerald-500/30"
                  >
                    Save video
                  </a>
                )
              )}

              {busy ? (
                <button
                  onClick={() => void stop()}
                  className="rounded-md bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/20"
                >
                  Cancel export
                </button>
              ) : (
                <>
                  <button
                    onClick={onClose}
                    className="rounded-md px-3 py-1.5 text-xs font-medium text-white/60 transition hover:bg-white/10 hover:text-white"
                  >
                    Close
                  </button>
                  <button
                    onClick={() => void begin()}
                    disabled={available === null}
                    className="rounded-md bg-sky-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-400 disabled:opacity-50"
                  >
                    {phase === "idle" ? "Export" : "Export again"}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
