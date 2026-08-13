"use client";

import React, { useEffect, useRef, useState } from "react";
import { cancelExport, exportAvailable, exportUrl, startExport, watchExport } from "../api/client.ts";
import { FPS_PRESETS, RESOLUTION_PRESETS } from "../project/types.ts";
import { useEditorStore } from "../store/editorStore.ts";

type Phase = "idle" | "running" | "done" | "failed" | "cancelled";

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useEditorStore((s) => s.project);
  const projectId = useEditorStore((s) => s.projectId);
  const save = useEditorStore((s) => s.save);

  const [width, setWidth] = useState(project?.exportSettings.width ?? 1080);
  const [height, setHeight] = useState(project?.exportSettings.height ?? 1920);
  const [fps, setFps] = useState(project?.exportSettings.fps ?? 30);
  const [crf, setCrf] = useState(project?.exportSettings.crf ?? 20);

  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);

  const jobIdRef = useRef<string | null>(null);
  const unwatchRef = useRef<(() => void) | null>(null);

  // Checked up front rather than on click: if export can't work, the dialog says so plainly instead
  // of presenting a button that fails.
  useEffect(() => {
    void exportAvailable().then(setAvailable);
  }, []);

  useEffect(() => () => unwatchRef.current?.(), []);

  async function begin() {
    if (!project || !projectId) return;
    setError(null);
    setProgress(0);
    setPhase("running");

    // The export renders whatever the SERVER has, so an unsaved edit would silently export a stale
    // timeline. Saving first makes what's exported match what's on screen.
    await save();

    try {
      const settings = { ...project.exportSettings, width, height, fps, crf };
      const started = await startExport(projectId, { ...project, exportSettings: settings });
      jobIdRef.current = started.jobId;
      setFileName(started.fileName);

      unwatchRef.current = watchExport(
        started.jobId,
        (update) => {
          setProgress(update.progress);
          if (update.status === "done") setPhase("done");
          else if (update.status === "failed") {
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
            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-white/50">
                  Resolution
                </span>
                <select
                  disabled={busy}
                  value={`${width}x${height}`}
                  onChange={(e) => {
                    const [w, h] = e.target.value.split("x").map(Number);
                    setWidth(w);
                    setHeight(h);
                  }}
                  className="w-full rounded-md bg-white/5 px-2 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-sky-400/60 disabled:opacity-50"
                >
                  {RESOLUTION_PRESETS.map((preset) => (
                    <option key={preset.label} value={`${preset.width}x${preset.height}`}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-white/50">
                    Frame rate
                  </span>
                  <select
                    disabled={busy}
                    value={fps}
                    onChange={(e) => setFps(Number(e.target.value))}
                    className="w-full rounded-md bg-white/5 px-2 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-sky-400/60 disabled:opacity-50"
                  >
                    {FPS_PRESETS.map((value) => (
                      <option key={value} value={value}>
                        {value} fps
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-white/50">
                    Quality
                  </span>
                  <select
                    disabled={busy}
                    value={crf}
                    onChange={(e) => setCrf(Number(e.target.value))}
                    className="w-full rounded-md bg-white/5 px-2 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-sky-400/60 disabled:opacity-50"
                  >
                    {/* CRF is inverted (lower = better), which is unintuitive — the labels say what
                        the user actually cares about and keep the numbers out of the way. */}
                    <option value={18}>High</option>
                    <option value={20}>Balanced</option>
                    <option value={26}>Small file</option>
                  </select>
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
              </div>
            )}

            <div className="mt-5 flex items-center justify-end gap-2">
              {phase === "done" && fileName && projectId && (
                <a
                  href={exportUrl(projectId, fileName)}
                  download={fileName}
                  className="mr-auto rounded-md bg-emerald-500/20 px-3 py-1.5 text-xs font-medium text-emerald-200 transition hover:bg-emerald-500/30"
                >
                  Save video
                </a>
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
