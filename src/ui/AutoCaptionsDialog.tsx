"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  cancelCaptions,
  captionsAvailable,
  getCaptionsKeyStatus,
  setCaptionsApiKey,
  startCaptions,
  watchCaptions,
  type CaptionsKeyStatus,
  type CaptionsProgress,
} from "../api/client.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";

type Phase = "idle" | "running" | "failed" | "cancelled";

/** Whole-sequence Auto Captions — the toolbar's entry point, for when there's no single selected clip
 *  to scope to (Inspector's `AutoCaptionsSection` handles that per-clip case). Same overlay/portal
 *  convention as `ConfirmDialog`, same availability/credentials/progress-phase shape as
 *  `AutoCaptionsSection` — deliberately not shared as one generic component, since the two differ in
 *  container (an inline collapsible section vs. a modal) and trigger payload (`clipId` vs. none) more
 *  than they'd save by unifying; both call the same `api/client.ts` functions and the same
 *  `landCaptions` store action underneath, so there's no duplicated JOB-HANDLING logic, only trigger
 *  UI. */
export function AutoCaptionsDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslation();
  const projectId = useEditorStore((s) => s.projectId);
  const save = useEditorStore((s) => s.save);
  const landCaptions = useEditorStore((s) => s.landCaptions);

  const [available, setAvailable] = useState<boolean | null>(null);
  const [status, setStatus] = useState<CaptionsKeyStatus | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [stage, setStage] = useState<string>("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const unwatchRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    void captionsAvailable().then(setAvailable);
    void getCaptionsKeyStatus().then(setStatus);
  }, []);

  useEffect(() => () => unwatchRef.current?.(), []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && phase !== "running") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [phase, onClose]);

  async function handleSaveKey() {
    if (!keyInput.trim()) return;
    setSavingKey(true);
    try {
      await setCaptionsApiKey(keyInput);
      setKeyInput("");
      setStatus({ configured: true });
      setAvailable(await captionsAvailable());
    } catch {
      setError(t("Couldn't save that API key"));
    } finally {
      setSavingKey(false);
    }
  }

  async function begin() {
    if (!projectId) return;
    setError(null);
    setProgress(0);
    setStage("");
    setPhase("running");
    // Same reasoning as the per-clip section's own `await save()` first — the server transcribes the
    // SAVED project file, so unsaved edits would otherwise be silently ignored.
    await save();
    try {
      const started = await startCaptions(projectId);
      jobIdRef.current = started.jobId;
      unwatchRef.current = watchCaptions(
        started.jobId,
        (update: CaptionsProgress) => {
          setStage(update.stage);
          setProgress(update.progress);
          if (update.status === "done") {
            if (update.captions) landCaptions(update.captions);
            onClose();
          } else {
            setPhase(update.status);
          }
          if (update.status === "failed" && update.error) setError(update.error);
        },
        (message) => setError(message)
      );
    } catch (err) {
      setPhase("failed");
      setError(err instanceof Error ? err.message : t("Could not start the job"));
    }
  }

  function stop() {
    if (jobIdRef.current) void cancelCaptions(jobIdRef.current);
    setPhase("cancelled");
  }

  const credentialsBlock = status && (
    <div className="mb-3 space-y-1.5">
      <p className="text-[11px] text-white/35">
        {status.configured ? t("Using your saved OpenAI key.") : t("No OpenAI key saved yet.")}
      </p>
      <div className="flex gap-2">
        <input
          type="password"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder={status.configured ? t("Paste a new key to replace the saved one") : t("OpenAI API key")}
          className="min-w-0 flex-1 rounded bg-white/5 px-2.5 py-1.5 text-[12px] text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-sky-400/60"
        />
        <button
          onClick={() => void handleSaveKey()}
          disabled={savingKey || !keyInput.trim()}
          className="shrink-0 rounded bg-sky-500 px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-sky-400 disabled:opacity-50"
        >
          {savingKey ? t("Saving…") : status.configured ? t("Replace") : t("Save")}
        </button>
      </div>
    </div>
  );

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={() => phase !== "running" && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label={t("Auto Captions")}
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-xl border border-white/10 bg-[#12151c] p-5 shadow-2xl">
        <h2 className="text-sm font-semibold text-white">{t("Auto Captions")}</h2>
        <p className="mt-2 text-xs leading-relaxed text-white/60">
          {t("Transcribes the whole sequence's audio and adds the result as editable caption clips on a new track.")}
        </p>

        <div className="mt-4">
          {available === null || status === null ? (
            <p className="text-[12px] text-white/35">{t("Checking…")}</p>
          ) : !status.configured ? (
            credentialsBlock
          ) : !available ? (
            <>
              {credentialsBlock}
              <p className="text-[12px] leading-relaxed text-rose-300">{t("FFmpeg isn't available — reinstall dependencies to use this.")}</p>
            </>
          ) : phase === "running" ? (
            <>
              {credentialsBlock}
              <p className="text-[12px] text-white/60 capitalize">{(stage || t("Starting…")).replaceAll("-", " ")}</p>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-sky-400 transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
            </>
          ) : (
            credentialsBlock
          )}
          {error && <p className="mt-2 text-[12px] text-rose-300">{error}</p>}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            onClick={phase === "running" ? stop : onClose}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            {phase === "running" ? t("Cancel") : t("Close")}
          </button>
          {phase !== "running" && available && status?.configured && (
            <button
              onClick={() => void begin()}
              className="rounded-md bg-sky-500 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-400"
            >
              {t("Generate Captions")}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
