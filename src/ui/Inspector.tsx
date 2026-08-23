"use client";

import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Close } from "@veasnawt/vicons";
import {
  cancelCaptions,
  cancelInpaint,
  cancelLocalSetup,
  captionsAvailable,
  getCaptionsKeyStatus,
  getInpaintKeyStatus,
  inpaintAvailable,
  setActiveInpaintProvider,
  setCaptionsApiKey,
  setInpaintApiKey,
  startCaptions,
  startInpaint,
  startLocalSetup,
  watchCaptions,
  watchInpaint,
  watchLocalSetup,
} from "../api/client.ts";
import type { CaptionsKeyStatus, CaptionsProgress, InpaintKeyStatus, InpaintProgress, InpaintProvider, LocalSetupProgress } from "../api/client.ts";
import {
  SetClipChromaKeyCommand,
  SetClipColorGradingCommand,
  SetClipColorGradingKeyframesCommand,
  SetClipEffectsCommand,
  SetClipEffectsKeyframesCommand,
  SetClipGainCommand,
  SetClipMutedCommand,
  SetClipTextAnimationCommand,
  SetClipTextCropCommand,
  SetClipTextStyleKeyframesCommand,
  SetClipTransformCommand,
  SetClipTransformKeyframesCommand,
  SetClipTransitionCommand,
  SetClipTransitionOutCommand,
  SetTextCommand,
} from "../commands/index.ts";
import { clipDuration, findAsset, findClip } from "../project/createProject.ts";
import { FONT_REGISTRY, fontById, preloadFont } from "../project/fonts.ts";
import type { ClipEffects, ClipTransform, ColorGrading, TextCrop, TextStyle } from "../project/types.ts";
import { DEFAULT_CHROMA_KEY, DEFAULT_TEXT_STYLE, IDENTITY_COLOR_GRADING, IDENTITY_EFFECTS, IDENTITY_TEXT_CROP, IDENTITY_TRANSFORM } from "../project/types.ts";
import { applyTextStylePreset, TEXT_STYLE_PRESETS } from "../project/textStylePresets.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { formatTimecode } from "../timeline/time.ts";
import { DEFAULT_WORD_HIGHLIGHT_COLOR, TEXT_ANIMATION_TYPE_LABEL, TEXT_ANIMATION_TYPE_OPTIONS } from "../timeline/textAnimation.ts";
import {
  hasColorGradingKeyframes,
  hasEffectsKeyframes,
  hasTextStyleKeyframes,
  hasTransformKeyframes,
  resolveClipColorGrading,
  resolveClipEffects,
  resolveClipTransform,
  resolveTextStyle,
  upsertKeyframe,
} from "../timeline/keyframes.ts";
import {
  DEFAULT_TRANSITION,
  findTransitionCandidate,
  TRANSITION_TYPE_LABEL,
  TRANSITION_TYPE_OPTIONS,
} from "../timeline/transitions.ts";
import { CurveEditor } from "./CurveEditor.tsx";
import { Dropdown, type DropdownOption } from "./Dropdown.tsx";
import { KeyframeTrack } from "./KeyframeTrack.tsx";
import { NumberField } from "./NumberField.tsx";
import { TextAnimationPreviewTile } from "./TextAnimationPreviewTile.tsx";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-1.5">
      <span className="text-[12px] text-white/50">{label}</span>
      <span className="font-mono text-[12px] tabular-nums text-white/85">{value}</span>
    </div>
  );
}

/** A collapsible section — a small colored dot as a scannable per-section accent (Transform/Effects/
 *  etc. each get a distinct hue), the label, and a chevron, at a size that actually reads as a heading
 *  rather than blending into the field labels beneath it. Replaces what used to be a plain non-
 *  interactive `SectionHeader`: a video/image clip has Transform + Effects + Transition + Audio +
 *  Timeline + Source + Media, and a text clip's own Text section alone is a dozen-plus fields — all
 *  permanently expanded meant reaching, say, Rotation meant scrolling past everything above it every
 *  single time, worst on mobile where this panel is a full-height sheet rather than a side column with
 *  room to spare. Collapsing what you're not using now is a tap on the header, not a re-navigation. */
function CollapsibleSection({
  title,
  accent = "bg-sky-400",
  open,
  onToggle,
  children,
}: {
  title: string;
  accent?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-white/10 pt-3">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="-mx-1 mb-2 flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] font-semibold uppercase tracking-wide text-white/45 transition hover:text-white/80"
      >
        <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${accent}`} />
        <span className="flex-1">{title}</span>
        <ChevronDown size={13} className={`shrink-0 text-white/30 transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && children}
    </div>
  );
}

/** A multi-line text field that commits on blur, not per-keystroke — same reasoning as `NumberField`:
 *  committing every keystroke would push a new `SetTextCommand` (and undo-stack entry) per character,
 *  so undoing "typed a caption" would take one step per letter instead of one. */
function TextContentField({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const t = useTranslation();
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(value);
    // Only the real value should resync the field — see NumberField's identical note on why
    // `focused` itself must not be a dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <textarea
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        if (text !== value) onCommit(text);
      }}
      rows={3}
      placeholder={t("Text")}
      // 16px below `lg` to avoid iOS Safari's focus-zoom — same reasoning as every other text input
      // in this app (see MediaLibrary's search box).
      className="w-full resize-none rounded bg-white/5 px-2.5 py-2 text-[16px] text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-sky-400/60 lg:text-[13px]"
    />
  );
}

function AlignButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded px-2 py-1.5 text-[12px] capitalize transition ${
        active ? "bg-sky-500/30 text-white" : "bg-white/5 text-white/60 hover:bg-white/10"
      }`}
    >
      {children}
    </button>
  );
}

type CaptionsPhase = "idle" | "running" | "failed" | "cancelled";

/** Auto Captions' Inspector content — transcribes THIS clip's own on-screen time range (via
 *  `/api/vstudio/captions`, `clipId` present) and lands the result as real, editable text clips on a
 *  new "Captions" track, all in one undo-able step (`landCaptions` → `AddCaptionsCommand`).
 *
 *  Structurally a smaller `RemoveObjectSection`: same availability/credentials/progress-phase shape,
 *  simplified to ONE provider (OpenAI) — no provider dropdown, no per-provider key map, just
 *  "configured or not." No separate "done" phase either, unlike Remove Object: there's no draw-a-new-
 *  region follow-up action to offer, so a successful run resets straight back to `"idle"` — the global
 *  status toast `landCaptions` already sets is the confirmation, not a second local one. */
function AutoCaptionsSection({ clipId, projectId }: { clipId: string; projectId: string | null }) {
  const t = useTranslation();
  const save = useEditorStore((s) => s.save);
  const landCaptions = useEditorStore((s) => s.landCaptions);

  const [available, setAvailable] = useState<boolean | null>(null);
  const [status, setStatus] = useState<CaptionsKeyStatus | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);

  const [phase, setPhase] = useState<CaptionsPhase>("idle");
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
    // Same reasoning as ExportDialog's/RemoveObjectSection's own `await save()` first: the server
    // resolves this clip's sourceIn/sourceOut from the SAVED project file, so an unsaved trim would
    // otherwise be silently ignored.
    await save();
    try {
      const started = await startCaptions(projectId, clipId);
      jobIdRef.current = started.jobId;
      unwatchRef.current = watchCaptions(
        started.jobId,
        (update: CaptionsProgress) => {
          setStage(update.stage);
          setProgress(update.progress);
          if (update.status === "done") {
            if (update.captions) landCaptions(update.captions);
            setPhase("idle");
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

  if (available === null || status === null) {
    return <p className="text-[12px] text-white/35">{t("Checking…")}</p>;
  }

  const credentialsBlock = (
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

  if (!status.configured) {
    return (
      <>
        <p className="mb-2 text-[12px] leading-relaxed text-white/50">
          {t("Transcribes this clip's audio and adds the result as editable caption clips. Needs an OpenAI API key — the clip's audio is sent there for processing.")}
        </p>
        {credentialsBlock}
        {error && <p className="text-[12px] text-rose-300">{error}</p>}
      </>
    );
  }

  if (!available) {
    return (
      <>
        {credentialsBlock}
        <p className="text-[12px] leading-relaxed text-rose-300">{t("FFmpeg isn't available — reinstall dependencies to use this.")}</p>
      </>
    );
  }

  if (phase === "running") {
    return (
      <>
        {credentialsBlock}
        <p className="text-[12px] text-white/60 capitalize">{(stage || t("Starting…")).replaceAll("-", " ")}</p>
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-sky-400 transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <button onClick={stop} className="mt-2 rounded bg-white/5 px-2.5 py-1 text-[11px] text-white/60 transition hover:bg-white/10 hover:text-white">
          {t("Cancel")}
        </button>
      </>
    );
  }

  return (
    <>
      {credentialsBlock}
      {error && <p className="mb-2 text-[12px] text-rose-300">{error}</p>}
      <p className="mb-2 text-[12px] leading-relaxed text-white/50">
        {t("Transcribes this clip's audio and adds the result as editable caption clips on a new track.")}
      </p>
      <button
        onClick={() => void begin()}
        className="w-full rounded bg-sky-500 py-1.5 text-[12px] font-semibold text-white transition hover:bg-sky-400"
      >
        {t("Generate Captions")}
      </button>
    </>
  );
}

type InpaintPhase = "idle" | "running" | "done" | "failed" | "cancelled";

const INPAINT_PROVIDER_LABELS: Record<InpaintProvider, string> = {
  replicate: "Replicate",
  fal: "fal.ai",
  local: "Local (CPU)",
};

type LocalSetupPhase = "idle" | "running" | "done" | "failed" | "cancelled";

/** The "Remove Object" tool's Inspector content — a v1 AI object/watermark-removal prototype, now
 *  able to run against either of two cloud providers (Replicate or fal.ai) — see
 *  `_lib/inpaintEnvFile.ts`'s own header for why a runtime choice, not a fixed one, is needed here.
 *  The provider dropdown/status-sentence/key-input interaction below is a direct port of Universe's
 *  `RixieApiKeySection` (packages/universe/src/components/SettingsPanel.tsx) — same "switching to an
 *  already-configured provider activates it immediately, a new one just reveals its key field" rule —
 *  adapted to VStudio's own flat-function API client and Tailwind styling instead of Universe's
 *  bridge-object pattern and `--os-*` CSS variables.
 *
 *  Job phase state is LOCAL to this component (not the store), exactly like `ExportDialog` keeps its
 *  own `Phase` state rather than putting it in `editorStore` — it's view-only and single-consumer, the
 *  same reasoning that keeps it out of the store there. `removeObjectRect`/`removeObjectArmedClipId`
 *  DO live in the store (see its own comment) since `RemoveObjectOverlay`, a completely different
 *  component mounted over the Preview canvas, needs to read/drive the same drawn rectangle. */
function RemoveObjectSection({ clipId, assetName, projectId }: { clipId: string; assetName: string; projectId: string | null }) {
  const t = useTranslation();
  const armRemoveObject = useEditorStore((s) => s.armRemoveObject);
  const clearRemoveObject = useEditorStore((s) => s.clearRemoveObject);
  const removeObjectArmedClipId = useEditorStore((s) => s.removeObjectArmedClipId);
  const removeObjectRect = useEditorStore((s) => s.removeObjectRect);
  const save = useEditorStore((s) => s.save);
  const landInpaintedAsset = useEditorStore((s) => s.landInpaintedAsset);

  const [available, setAvailable] = useState<boolean | null>(null);
  const [status, setStatus] = useState<InpaintKeyStatus | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<InpaintProvider>("replicate");
  const [keyInput, setKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [backgroundPrompt, setBackgroundPrompt] = useState("");

  const [phase, setPhase] = useState<InpaintPhase>("idle");
  const [stage, setStage] = useState<string>("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const unwatchRef = useRef<(() => void) | null>(null);

  // Separate from the inpaint-job state above — "provisioning the local Python runtime" and "running
  // a removal job" are different concerns that could otherwise be confused sharing one state shape.
  const [setupPhase, setSetupPhase] = useState<LocalSetupPhase>("idle");
  const [setupStage, setSetupStage] = useState<string>("");
  const [setupProgress, setSetupProgress] = useState(0);
  const setupJobIdRef = useRef<string | null>(null);
  const setupUnwatchRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // Checked separately from `inpaintAvailable()` (a combined FFmpeg+active-provider-key check,
    // matching `exportAvailable`'s own single-precondition shape) so this section can tell the two
    // "not ready" reasons apart and show the right one — a bare HEAD response can't distinguish them
    // without a body, and "reinstall FFmpeg" is not an actionable message for a missing API key.
    void inpaintAvailable().then(setAvailable);
    void getInpaintKeyStatus().then((s) => {
      if (s) setSelectedProvider(s.activeProvider);
      setStatus(s);
    });
  }, []);

  useEffect(() => () => unwatchRef.current?.(), []);
  useEffect(() => () => setupUnwatchRef.current?.(), []);

  const armed = removeObjectArmedClipId === clipId;
  const rect = removeObjectRect?.clipId === clipId ? removeObjectRect : null;

  async function handleProviderChange(next: InpaintProvider) {
    setSelectedProvider(next);
    setKeyInput("");
    setError(null);
    // Already has a key on file — switch straight to it, no re-entry needed. A provider with no
    // saved key just updates the local selection; handleSaveKey below is what actually persists
    // anything for it.
    if (status?.configured[next] && next !== status.activeProvider) {
      try {
        await setActiveInpaintProvider(next);
        setStatus((prev) => (prev ? { ...prev, activeProvider: next } : prev));
        setAvailable(await inpaintAvailable());
      } catch {
        setError(t("Couldn't switch providers"));
      }
    }
  }

  async function handleSaveKey() {
    // Never reachable for "local" (the UI renders a setup button, not a key field, for it — see
    // `credentialsBlock` below) — guarded here too since `setInpaintApiKey` has no key concept for it.
    if (selectedProvider === "local" || !keyInput.trim()) return;
    setSavingKey(true);
    try {
      await setInpaintApiKey(selectedProvider, keyInput);
      setKeyInput("");
      setStatus((prev) => ({
        activeProvider: selectedProvider,
        configured: { ...(prev?.configured ?? { replicate: false, fal: false, local: false }), [selectedProvider]: true },
      }));
      setAvailable(await inpaintAvailable());
    } catch {
      setError(t("Couldn't save that API key"));
    } finally {
      setSavingKey(false);
    }
  }

  async function handleStartLocalSetup() {
    setError(null);
    setSetupProgress(0);
    setSetupStage("");
    setSetupPhase("running");
    try {
      const started = await startLocalSetup();
      setupJobIdRef.current = started.jobId;
      setupUnwatchRef.current = watchLocalSetup(
        started.jobId,
        (update: LocalSetupProgress) => {
          setSetupStage(update.stage);
          setSetupProgress(update.progress);
          setSetupPhase(update.status);
          if (update.status === "done") {
            // Also ACTIVATES local, not just marks it configured — the user explicitly set this up
            // while it was selected, the same clear intent signal `handleSaveKey` already treats as
            // "activate immediately" for the cloud providers. Without this, the real backend
            // provider would stay whatever it was before, silently — the exact mismatch that let a
            // job run against Replicate while the dropdown showed Local (CPU) selected.
            setStatus((prev) => (prev ? { ...prev, activeProvider: "local", configured: { ...prev.configured, local: true } } : prev));
            void setActiveInpaintProvider("local").catch(() => {});
            void inpaintAvailable().then(setAvailable);
          }
          if (update.status === "failed" && update.error) setError(update.error);
        },
        (message) => setError(message)
      );
    } catch (err) {
      setSetupPhase("failed");
      setError(err instanceof Error ? err.message : t("Could not start setup"));
    }
  }

  function stopLocalSetup() {
    if (setupJobIdRef.current) void cancelLocalSetup(setupJobIdRef.current);
    setSetupPhase("cancelled");
  }

  async function begin() {
    if (!rect || !projectId) return;
    setError(null);
    setProgress(0);
    setStage("");
    setPhase("running");
    // Same reasoning as ExportDialog's own `await save()` first: the server resolves this clip's
    // sourceIn/sourceOut and the asset's relPath from the SAVED project file, so an unsaved trim
    // would otherwise be silently ignored.
    await save();
    try {
      const started = await startInpaint(projectId, clipId, rect, selectedProvider === "fal" ? backgroundPrompt : undefined);
      jobIdRef.current = started.jobId;
      unwatchRef.current = watchInpaint(
        started.jobId,
        (update: InpaintProgress) => {
          setStage(update.stage);
          setProgress(update.progress);
          setPhase(update.status);
          if (update.status === "done" && update.asset) landInpaintedAsset(update.asset);
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
    if (jobIdRef.current) void cancelInpaint(jobIdRef.current);
    setPhase("cancelled");
  }

  function startOver() {
    setPhase("idle");
    setError(null);
    clearRemoveObject();
  }

  if (available === null || status === null) {
    return <p className="text-[12px] text-white/35">{t("Checking…")}</p>;
  }

  const isActive = selectedProvider === status.activeProvider;
  const isConfigured = status.configured[selectedProvider];
  // Whether the SELECTED provider (what the dropdown shows) is actually the one that will run —
  // both that it's ready AND that it's genuinely the active one server-side, not just
  // `status.configured[status.activeProvider]` (the real active provider's own readiness). Using
  // only the latter let a user select an unconfigured provider (e.g. Local before setup) while the
  // REAL backend provider silently stayed whatever it was before — the dropdown showed the new
  // selection, but "Remove Object" ran against the old, unswitched provider with no warning.
  const ready = isActive && isConfigured;
  const providerOptions: DropdownOption<InpaintProvider>[] = (Object.keys(INPAINT_PROVIDER_LABELS) as InpaintProvider[]).map((p) => ({
    value: p,
    label: `${p === "local" ? t("Local (CPU)") : INPAINT_PROVIDER_LABELS[p]}${status.configured[p] ? " ✓" : ""}`,
  }));

  // Provider switcher + key entry — always visible (not gated behind "unconfigured"), so a saved key
  // can be replaced later too, not just entered for the first time. Uses the app's own `Dropdown`
  // (NOT a native `<select>`) — see that component's own header comment: a native `<select>`'s open
  // popup is unstyled OS chrome on Windows Chromium and does not honor this app's dark theme, which is
  // exactly the bug a plain `<select>` here originally had. Mirrors `RixieApiKeySection`'s own
  // interaction (packages/universe/src/components/SettingsPanel.tsx): picking an already-configured
  // provider switches to it immediately; picking a fresh one just reveals its own empty key field.
  const credentialsBlock = (
    <div className="mb-3 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-white/40">{t("Provider")}</span>
        <Dropdown
          value={selectedProvider}
          options={providerOptions}
          onChange={(v) => void handleProviderChange(v)}
          ariaLabel={t("Remove Object provider")}
          disabled={phase === "running"}
          className="w-32 text-[11px]"
        />
      </div>
      <p className="text-[11px] text-white/35">
        {selectedProvider === "local"
          ? isConfigured
            ? isActive
              ? t("Using Local (CPU).")
              : t("Switching to Local (CPU) — it's already set up.")
            : t("Not set up yet.")
          : isActive
            ? isConfigured
              ? t("Using {provider}.", { provider: INPAINT_PROVIDER_LABELS[selectedProvider] })
              : t("Set to {provider}, but no key is saved for it yet.", { provider: INPAINT_PROVIDER_LABELS[selectedProvider] })
            : isConfigured
              ? t("Switching to {provider} — it already has a saved key.", { provider: INPAINT_PROVIDER_LABELS[selectedProvider] })
              : t("No key saved for {provider} yet.", { provider: INPAINT_PROVIDER_LABELS[selectedProvider] })}
      </p>
      {selectedProvider === "local" ? (
        <>
          <p className="text-[11px] leading-relaxed text-amber-300/80">
            {t("Runs ProPainter locally via Python — free, but")}{" "}
            <span className="font-medium">{t("non-commercial use only")}</span>
            {t(". CPU inference is slow: expect minutes per clip, and the very first run also downloads ~1-2GB of model weights.")}
          </p>
          {!isConfigured &&
            (setupPhase === "running" ? (
              <>
                <p className="text-[11px] text-white/50 capitalize">{setupStage || t("Starting…")}</p>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-sky-400 transition-all" style={{ width: `${Math.round(setupProgress * 100)}%` }} />
                </div>
                <button
                  onClick={stopLocalSetup}
                  className="rounded bg-white/5 px-2.5 py-1 text-[11px] text-white/60 transition hover:bg-white/10 hover:text-white"
                >
                  {t("Cancel setup")}
                </button>
              </>
            ) : (
              <button
                onClick={() => void handleStartLocalSetup()}
                className="w-full rounded bg-sky-500 py-1.5 text-[12px] font-medium text-white transition hover:bg-sky-400"
              >
                {t("Set up local model")}
              </button>
            ))}
        </>
      ) : (
        <div className="flex gap-2">
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder={
              isConfigured
                ? t("Paste a new key to replace the saved one")
                : selectedProvider === "fal"
                  ? t("fal.ai API key")
                  : t("Replicate API token")
            }
            className="min-w-0 flex-1 rounded bg-white/5 px-2.5 py-1.5 text-[12px] text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-sky-400/60"
          />
          <button
            onClick={() => void handleSaveKey()}
            disabled={savingKey || !keyInput.trim()}
            className="shrink-0 rounded bg-sky-500 px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-sky-400 disabled:opacity-50"
          >
            {savingKey ? t("Saving…") : isConfigured ? t("Replace") : t("Save")}
          </button>
        </div>
      )}
    </div>
  );

  if (!ready) {
    return (
      <>
        <p className="mb-2 text-[12px] leading-relaxed text-white/50">
          {selectedProvider === "local"
            ? t("Erases an object or watermark from this clip using a locally-run AI model — free, but slower than a cloud provider.")
            : t("Erases an object or watermark from this clip using a cloud AI model. Needs an API key — the clip is sent there for processing.")}
        </p>
        {credentialsBlock}
        {error && <p className="text-[12px] text-rose-300">{error}</p>}
      </>
    );
  }

  if (!available) {
    return (
      <>
        {credentialsBlock}
        <p className="text-[12px] leading-relaxed text-rose-300">{t("FFmpeg isn't available — reinstall dependencies to use this.")}</p>
      </>
    );
  }

  if (phase === "running") {
    return (
      <>
        {credentialsBlock}
        <p className="text-[12px] text-white/60 capitalize">{stage || t("Starting…")}</p>
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-sky-400 transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <button onClick={stop} className="mt-2 rounded bg-white/5 px-2.5 py-1 text-[11px] text-white/60 transition hover:bg-white/10 hover:text-white">
          {t("Cancel")}
        </button>
      </>
    );
  }

  if (phase === "done") {
    return (
      <>
        {credentialsBlock}
        <p className="text-[12px] text-emerald-300">{t("Added to the Media Library.")}</p>
        <button onClick={startOver} className="mt-2 rounded bg-white/5 px-2.5 py-1 text-[11px] text-white/60 transition hover:bg-white/10 hover:text-white">
          {t("Start over")}
        </button>
      </>
    );
  }

  return (
    <>
      {credentialsBlock}
      {error && <p className="mb-2 text-[12px] text-rose-300">{error}</p>}
      {!rect ? (
        <>
          <p className="text-[12px] leading-relaxed text-white/50">
            {t(
              "Draw a box over the object or watermark on the preview. Works best for a mostly-static background — the same region is erased across the whole clip."
            )}
          </p>
          <button
            onClick={() => armRemoveObject(clipId)}
            className={`mt-2 w-full rounded py-1.5 text-[12px] font-medium transition ${
              armed ? "bg-rose-500/30 text-white" : "bg-white/5 text-white/70 hover:bg-white/10 hover:text-white"
            }`}
          >
            {armed ? t("Drawing… click and drag on the preview") : t("Draw region")}
          </button>
        </>
      ) : (
        <>
          <p className="text-[12px] text-white/50">
            {t("Region: {width}×{height} px", { width: Math.round(rect.width), height: Math.round(rect.height) })}
          </p>
          <p className="mt-1 text-[11px] text-white/35">
            {t('Result has no audio — "{name}"\'s own audio isn\'t affected either way.', { name: assetName })}
          </p>
          {selectedProvider === "fal" && (
            <input
              type="text"
              value={backgroundPrompt}
              onChange={(e) => setBackgroundPrompt(e.target.value)}
              placeholder={t("Describe the background that should appear (optional)")}
              className="mt-2 w-full rounded bg-white/5 px-2.5 py-1.5 text-[12px] text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-sky-400/60"
            />
          )}
          <div className="mt-2 flex gap-2">
            <button onClick={() => void begin()} className="flex-1 rounded bg-sky-500 py-1.5 text-[12px] font-semibold text-white transition hover:bg-sky-400">
              {t("Remove Object")}
            </button>
            <button onClick={clearRemoveObject} className="rounded bg-white/5 px-3 py-1.5 text-[12px] text-white/60 transition hover:bg-white/10 hover:text-white">
              {t("Clear")}
            </button>
          </div>
        </>
      )}
    </>
  );
}

/** Properties for the current selection — timeline/source facts are read-only (renaming a clip's
 *  position happens by dragging it, not typing here), while Position/Scale/Rotation/Crop and
 *  Brightness/Contrast/Saturation/Blur/Opacity are real, wired-up, undo-able controls. Both can also
 *  be KEYFRAMED over the clip's own duration — see each section's own `KeyframeTrack` (the stopwatch
 *  toggle) — in which case every field here reads/writes the value at the CURRENT PLAYHEAD instead of
 *  one static value for the whole clip; `patchTransform`/`patchEffects` below branch on whether
 *  keyframing is armed for the clip currently selected. */
export function Inspector() {
  const t = useTranslation();
  const project = useEditorStore((s) => s.project);
  const projectId = useEditorStore((s) => s.projectId);
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds);
  const run = useEditorStore((s) => s.run);

  // Exactly one clip, not just "at least one" — `selectedClipIds[0]` alone would still resolve to a
  // real clip during a genuine multi-select (both/all of them normally still exist in the project), so
  // checking that on its own silently showed clip[0]'s properties while a second, third, etc. clip was
  // ALSO selected — editing a value then only affected that one clip, with nothing on screen to say a
  // bigger selection existed. Requiring the selection to be a single clip is what actually reaches the
  // "N clips selected" messaging below for a real multi-select, instead of that branch being live only
  // for the edge case of a stale id.
  const selectedId = selectedClipIds.length === 1 ? selectedClipIds[0] : undefined;
  const found = project && selectedId ? findClip(project, selectedId) : undefined;
  const fps = project?.sequence.fps ?? 30;
  // Needed for the keyframe-armed branch below (`patchTransform`/`patchEffects`/their `preview*`
  // siblings, and `KeyframeTrack`'s own live playhead tick) to know WHICH instant an edit targets.
  // Same live re-render-during-playback cost `TransformHandles.tsx` already accepts for the identical
  // reason — there's no way to know "is the playhead currently over a keyframe" without it.
  const playhead = useEditorStore((s) => s.playhead);

  /** Which sections are collapsed — shared across every clip selected in this session (collapse
   *  "Details" once, it stays collapsed switching to the next clip too, which is what makes
   *  collapsing worth doing at all rather than just a per-clip toggle that resets itself away the
   *  moment you select something else). "Details" (Timeline/Source/Media — all read-only reference
   *  values, never what someone opens this panel TO edit) starts collapsed; every actually-editable
   *  section starts open, preserving today's "everything visible" behavior for the common case. */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(["Details"]));
  function toggleSection(name: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  /** Which tab the user last clicked — a raw request, not necessarily valid for whatever clip is
   *  CURRENTLY selected (switching from a text clip to a video clip makes "text" stop existing, for
   *  instance). `tabs`/`activeTab` below (computed once a clip is actually found) fall back to the
   *  first tab that DOES apply whenever this doesn't match one, so there's no separate effect needed
   *  to "fix up" a stale selection after switching clips — the fallback is a plain derived value,
   *  recomputed on every render, so it can never show a blank or wrong-for-this-clip tab even for one
   *  frame the way a `useEffect`-based reset could. */
  const [requestedTab, setRequestedTab] = useState("text");

  const setLivePreviewOverrides = useEditorStore((s) => s.setLivePreviewOverrides);
  /** Clears whatever this panel was previewing — called right after every REAL commit below, so a
   *  stale override never outlives the edit that produced it (see `EditorState.livePreviewOverrides`'s
   *  own doc comment: it's a pure rendering hint, and the just-committed `clip.transform`/`effects`/
   *  `textStyle` already IS the previewed value the instant the command lands). */
  function clearPreview() {
    setLivePreviewOverrides([]);
  }

  /** Reads the clip's CURRENT effective transform (interpolated, when keyframes are armed for this
   *  clip — same "at whatever instant the playhead is over" resolution `TransformHandles` uses),
   *  patches ONE field, and dispatches it as a single command. When keyframes are armed, this is the
   *  auto-key rule (`timeline/keyframes.ts`'s `upsertKeyframe`): editing at a time within half a frame
   *  of an existing keyframe updates it in place; editing anywhere else inserts a new one there,
   *  leaving every other keyframe untouched. When NOT armed, unchanged from before — clamping (in
   *  `setClipTransform`) and undo grouping stay consistent regardless of which field the user
   *  touched. */
  function patchTransform(clipId: string, patch: Partial<ClipTransform>) {
    const clip = found?.clip;
    if (clip && hasTransformKeyframes(clip)) {
      const elapsed = playhead - clip.timelineStart;
      const next = { ...resolveClipTransform(clip, elapsed), ...patch };
      run(new SetClipTransformKeyframesCommand(clipId, upsertKeyframe(clip.transformKeyframes!, elapsed, next, fps)));
    } else {
      const current = clip?.transform ?? IDENTITY_TRANSFORM;
      run(new SetClipTransformCommand(clipId, { ...current, ...patch }));
    }
    clearPreview();
  }

  /** Mirrors `patchTransform`'s merge exactly, but only pushes a live `livePreviewOverrides` entry —
   *  no command, no undo-stack entry — so a NumberField's `onPreview` (mid-type/mid-drag, called on
   *  every keystroke/pixel) can make the canvas track the in-progress value the same way a canvas
   *  transform handle already does, without spamming undo history the way committing that often would.
   *  `patchTransform` above (fired once, on blur/release) is what actually replaces this with the real
   *  committed value and clears the override. The live override still wins outright over a keyframed
   *  value at draw time (see `PlaybackEngine.drawVideoClip`'s own resolution order), so this reads
   *  correctly whether or not keyframing is armed — no branch needed here, unlike `patchTransform`. */
  function previewTransform(clipId: string, patch: Partial<ClipTransform>) {
    const clip = found?.clip;
    const current = clip ? resolveClipTransform(clip, playhead - clip.timelineStart) : IDENTITY_TRANSFORM;
    setLivePreviewOverrides([{ clipId, transform: { ...current, ...patch } }]);
  }

  function patchCrop(clipId: string, patch: Partial<ClipTransform["crop"]>) {
    const clip = found?.clip;
    if (clip && hasTransformKeyframes(clip)) {
      const elapsed = playhead - clip.timelineStart;
      const current = resolveClipTransform(clip, elapsed);
      const next = { ...current, crop: { ...current.crop, ...patch } };
      run(new SetClipTransformKeyframesCommand(clipId, upsertKeyframe(clip.transformKeyframes!, elapsed, next, fps)));
    } else {
      const current = clip?.transform ?? IDENTITY_TRANSFORM;
      run(new SetClipTransformCommand(clipId, { ...current, crop: { ...current.crop, ...patch } }));
    }
    clearPreview();
  }

  function previewCrop(clipId: string, patch: Partial<ClipTransform["crop"]>) {
    const clip = found?.clip;
    const current = clip ? resolveClipTransform(clip, playhead - clip.timelineStart) : IDENTITY_TRANSFORM;
    setLivePreviewOverrides([{ clipId, transform: { ...current, crop: { ...current.crop, ...patch } } }]);
  }

  /** Same pattern as `patchTransform`, for `ClipEffects` instead. */
  function patchEffects(clipId: string, patch: Partial<ClipEffects>) {
    const clip = found?.clip;
    if (clip && hasEffectsKeyframes(clip)) {
      const elapsed = playhead - clip.timelineStart;
      const next = { ...resolveClipEffects(clip, elapsed), ...patch };
      run(new SetClipEffectsKeyframesCommand(clipId, upsertKeyframe(clip.effectsKeyframes!, elapsed, next, fps)));
    } else {
      const current = clip?.effects ?? IDENTITY_EFFECTS;
      run(new SetClipEffectsCommand(clipId, { ...current, ...patch }));
    }
    clearPreview();
  }

  /** Same pattern as `previewTransform`, for `ClipEffects` instead. */
  function previewEffects(clipId: string, patch: Partial<ClipEffects>) {
    const clip = found?.clip;
    const current = clip ? resolveClipEffects(clip, playhead - clip.timelineStart) : IDENTITY_EFFECTS;
    setLivePreviewOverrides([{ clipId, effects: { ...current, ...patch } }]);
  }

  /** Same pattern as `patchEffects`, for `ColorGrading` instead — but takes the FULL next value, not a
   *  `Partial` patch: `CurveEditor` itself already computes the complete next `ColorGrading` (a curve
   *  edit always replaces one channel's whole point list), so there's no per-field patch to merge here. */
  function patchColorGrading(clipId: string, next: ColorGrading) {
    const clip = found?.clip;
    if (clip && hasColorGradingKeyframes(clip)) {
      const elapsed = playhead - clip.timelineStart;
      run(new SetClipColorGradingKeyframesCommand(clipId, upsertKeyframe(clip.colorGradingKeyframes!, elapsed, next, fps)));
    } else {
      run(new SetClipColorGradingCommand(clipId, next));
    }
    clearPreview();
  }

  /** Same pattern as `previewEffects`, for `ColorGrading` instead. */
  function previewColorGrading(clipId: string, next: ColorGrading) {
    setLivePreviewOverrides([{ clipId, colorGrading: next }]);
  }

  /** Reads the asset's current EFFECTIVE style (interpolated, when Text keyframes are armed for the
   *  clip currently selected — same resolution `patchTransform` uses), patches ONE field, and
   *  dispatches it as a single command. Same auto-key rule as `patchTransform` when armed: editing
   *  within half a frame of an existing keyframe updates it in place, editing anywhere else inserts a
   *  new one. Addressed by ASSET id (content/style live on the text asset, not the clip — see
   *  `Asset.textContent`'s own doc comment) for the static path, but keyframe presence/timing is read
   *  off `found?.clip` — same "clipId param, but check the one actually-selected clip" convention
   *  `patchTransform` already uses. */
  function patchTextStyle(assetId: string, content: string, patch: Partial<TextStyle>) {
    const baseStyle = project?.assets.find((a) => a.id === assetId)?.textStyle ?? DEFAULT_TEXT_STYLE;
    const clip = found?.clip;
    if (clip && hasTextStyleKeyframes(clip)) {
      const elapsed = playhead - clip.timelineStart;
      const next = { ...resolveTextStyle(clip, elapsed, baseStyle), ...patch };
      run(new SetClipTextStyleKeyframesCommand(clip.id, upsertKeyframe(clip.textStyleKeyframes!, elapsed, next, fps)));
    } else {
      run(new SetTextCommand(assetId, content, { ...baseStyle, ...patch }));
    }
    clearPreview();
  }

  /** Same pattern as `previewTransform`, for `TextStyle` — keyed by the CLIP id (not the asset id
   *  `patchTextStyle` above uses), matching how `PlaybackEngine.drawTextLayer` and a text drag handle
   *  both key their own override lookups: the override slot is per rendered clip, not per asset. The
   *  live override wins outright over a keyframed value at draw time (same as `previewTransform`'s own
   *  comment), so this needs no keyframe branch either. */
  function previewTextStyle(clipId: string, assetId: string, patch: Partial<TextStyle>) {
    const baseStyle = project?.assets.find((a) => a.id === assetId)?.textStyle ?? DEFAULT_TEXT_STYLE;
    const clip = found?.clip;
    const current = clip ? resolveTextStyle(clip, playhead - clip.timelineStart, baseStyle) : baseStyle;
    setLivePreviewOverrides([{ clipId, textStyle: { ...current, ...patch } }]);
  }

  /** Same shape as `patchTransform`'s own crop handling, for a text clip's `TextCrop` — simpler than
   *  `patchTextStyle`: `textCrop` isn't keyframed (see its own doc comment), so there's no auto-key
   *  branch to choose between. */
  function patchTextCrop(clipId: string, patch: Partial<TextCrop>) {
    const current = found?.clip.textCrop ?? IDENTITY_TEXT_CROP;
    run(new SetClipTextCropCommand(clipId, { ...current, ...patch }));
    clearPreview();
  }

  /** Same pattern as `previewCrop`, for `TextCrop` instead. */
  function previewTextCrop(clipId: string, patch: Partial<TextCrop>) {
    const current = found?.clip.textCrop ?? IDENTITY_TEXT_CROP;
    setLivePreviewOverrides([{ clipId, textCrop: { ...current, ...patch } }]);
  }

  /** `patchTextStyle`/`previewTextStyle` above both merge their `patch` argument ONTO the clip's
   *  current style (`{ ...current, ...patch }`) — correct for every OTHER caller, which passes a
   *  genuinely partial patch (one field changing, everything else meant to stay). A style PRESET is
   *  the opposite case: `applyTextStylePreset` already computed a complete, self-sufficient
   *  `TextStyle` — including DELETING `backgroundColor`/`strokeColor`/`shadowColor` when the preset
   *  doesn't want them. Feeding that result back through the merge-with-current helpers above would
   *  silently UNDO those deletions (a key absent from `patch` just falls back to whatever `current`
   *  still had — that's exactly what merging means), leaving a stale background/outline/shadow from
   *  whatever style was active before. These two apply/preview a full style directly, no merge. */
  function applyFullTextStyle(assetId: string, content: string, fullStyle: TextStyle) {
    run(new SetTextCommand(assetId, content, fullStyle));
    clearPreview();
  }

  function previewFullTextStyle(clipId: string, fullStyle: TextStyle) {
    setLivePreviewOverrides([{ clipId, textStyle: fullStyle }]);
  }

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-white/10 bg-[#0d0f14]">
      <header className="border-b border-white/10 px-3 py-2.5">
        <h2 className="text-[13px] font-semibold uppercase tracking-wider text-white/70">{t("Properties")}</h2>
      </header>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-3.5">
        {!found ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-2 text-center">
            {selectedClipIds.length > 1 ? (
              <>
                <p className="text-[13px] font-medium text-white/60">{t("{n} clips selected", { n: selectedClipIds.length })}</p>
                <p className="max-w-[200px] text-[11px] leading-relaxed text-white/35">
                  {t("Properties are shown one clip at a time — select just one to edit it.")}
                </p>
              </>
            ) : (
              <p className="text-[12px] leading-relaxed text-white/35">{t("Select a clip to see its properties")}</p>
            )}
          </div>
        ) : (
          (() => {
            const { clip, track } = found;
            const asset = findAsset(project!, clip.assetId);

            // One tab per natural cluster of sections already implicit in each section's own
            // track-kind/asset-kind gate below (those gates are UNCHANGED — a tab just adds one more
            // condition alongside whichever one a section already had). Built as a plain array, not a
            // static constant, because which tabs even EXIST depends on this specific clip — a text
            // clip never gets a "Transform" tab, an audio-only clip never gets "Text" or "Transform".
            // "Details" (Timeline/Source/Media) deliberately has no tab of its own — see its own
            // render below, kept as a persistent section under every tab instead, since read-only
            // reference facts about the clip aren't really "a category of editing" the way the others
            // are, and duplicating it per-tab would mean duplicating its own collapsed/expanded state
            // bookkeeping for no benefit.
            const tabs: { id: string; label: string }[] = [
              ...(asset?.kind === "text" ? [{ id: "text", label: t("Text") }] : []),
              ...(track.kind === "video" ? [{ id: "transform", label: t("Transform") }] : []),
              ...(track.kind === "video" || track.kind === "text" || track.kind === "audio"
                ? [{ id: "transitions", label: t("Transitions") }]
                : []),
              ...(asset?.hasAudio ? [{ id: "audio", label: t("Audio") }] : []),
            ];
            const activeTab = tabs.some((tab) => tab.id === requestedTab) ? requestedTab : (tabs[0]?.id ?? "text");

            return (
              <div className="space-y-5">
                <div>
                  <p className="truncate text-[13px] font-semibold text-white/90">{asset?.name ?? t("Missing media")}</p>
                  <p className="text-[12px] text-white/40">{track.name}</p>
                </div>

                {tabs.length > 1 && (
                  <div role="tablist" className="-mx-1 flex gap-1 overflow-x-auto pb-0.5">
                    {tabs.map((tab) => (
                      <button
                        key={tab.id}
                        role="tab"
                        aria-selected={activeTab === tab.id}
                        onClick={() => setRequestedTab(tab.id)}
                        className={`shrink-0 rounded-full px-3 py-1 text-[12px] font-medium transition ${
                          activeTab === tab.id ? "bg-sky-500/25 text-sky-200" : "text-white/50 hover:bg-white/5 hover:text-white/80"
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                )}

                {/* Text has no video content to Transform (no scale/rotation/crop — font size already
                    covers "how big", and the position it DOES have is a simpler offsetX/offsetY pair
                    living on the asset's own style, not the video/image ClipTransform system — see
                    TextStyle's own doc comment for why). */}
                {activeTab === "text" && asset?.kind === "text" && (
                  <CollapsibleSection
                    title={t("Text")}
                    accent="bg-violet-400"
                    open={!collapsed.has("Text")}
                    onToggle={() => toggleSection("Text")}
                  >
                    <TextContentField
                      value={asset.textContent ?? ""}
                      onCommit={(content) => run(new SetTextCommand(asset.id, content, asset.textStyle ?? DEFAULT_TEXT_STYLE))}
                    />
                    {(() => {
                      const baseStyle = asset.textStyle ?? DEFAULT_TEXT_STYLE;
                      // Interpolated when Text keyframes are armed for this clip — same "every field
                      // here reads/writes the value at the CURRENT PLAYHEAD" resolution `patchTransform`'s
                      // own doc comment describes, just for TextStyle instead of ClipTransform.
                      const style = hasTextStyleKeyframes(clip) ? resolveTextStyle(clip, playhead - clip.timelineStart, baseStyle) : baseStyle;
                      const content = asset.textContent ?? "";
                      const font = fontById(style.fontFamily);
                      return (
                        <>
                          <KeyframeTrack
                            clip={clip}
                            property="textStyle"
                            playhead={playhead}
                            fps={fps}
                            run={run}
                            textAsset={{ id: asset.id, content, style: baseStyle }}
                          />
                          {/* A plain `<div>`, not `<label>` — a `<label>` wrapping a `<button>` (the
                              Dropdown's own toggle) makes the BROWSER forward any click landing
                              anywhere inside it to that button natively, per HTML's label-forwarding
                              behavior. That includes clicks on the popup's OWN options once it's open
                              (still a DOM descendant of this wrapper), which re-toggled the button
                              immediately after a selection closed it — confirmed the hard way: the
                              dropdown reopened itself right after picking an option. The Dropdown's own
                              `ariaLabel` prop already gives the button its accessible name, so the
                              `<label>` wasn't buying anything a `<span>` here doesn't already provide. */}
                          <div className="flex items-center justify-between gap-2 py-1.5">
                            <span className="text-[12px] text-white/50">{t("Font")}</span>
                            <Dropdown
                              value={style.fontFamily}
                              onChange={(v) => {
                                clearPreview();
                                patchTextStyle(asset.id, content, { fontFamily: v });
                              }}
                              onHoverOption={(v) => {
                                // Live-previews the hovered font on the actual canvas before it's
                                // committed — `previewTextStyle` already exists for exactly this (see
                                // its own doc comment); `null` (mouse left the option, or the popup
                                // closed) reverts to the clip's real, committed style. Also kicks off
                                // `preloadFont` for whichever font is hovered — belt-and-suspenders on
                                // top of the app-wide `preloadAllFonts` warm-up, in case this picker
                                // was opened before that had a chance to finish (a slow connection, or
                                // a font added to the registry after that warm-up already ran).
                                if (v) {
                                  preloadFont(fontById(v));
                                  previewTextStyle(clip.id, asset.id, { fontFamily: v });
                                } else {
                                  clearPreview();
                                }
                              }}
                              ariaLabel={t("Font")}
                              className="min-w-0 flex-1 text-[13px]"
                              searchable
                              searchPlaceholder={t("Search fonts…")}
                              options={FONT_REGISTRY.map((f) => ({
                                value: f.id,
                                label: f.label,
                                style: { fontFamily: `"${f.cssFamily}"` },
                              }))}
                            />
                          </div>
                          <NumberField
                            label={t("Size")}
                            value={style.fontSize}
                            suffix="px"
                            step={2}
                            onPreview={(v) => previewTextStyle(clip.id, asset.id, { fontSize: v })}
                            onCommit={(v) => patchTextStyle(asset.id, content, { fontSize: v })}
                          />
                          <label className="flex items-center justify-between gap-2 py-1.5">
                            <span className="text-[12px] text-white/50">{t("Color")}</span>
                            <input
                              type="color"
                              value={style.color}
                              onChange={(e) => patchTextStyle(asset.id, content, { color: e.target.value })}
                              className="h-7 w-11 cursor-pointer rounded border border-white/10 bg-transparent"
                            />
                          </label>
                          <div className="flex items-center gap-1 py-1.5">
                            <button
                              onClick={() => patchTextStyle(asset.id, content, { bold: !style.bold })}
                              aria-pressed={style.bold}
                              // No bundled file to show it with (`font.files.bold` is missing — Moul,
                              // for instance) isn't reason to hide the toggle: the intent still saves,
                              // and applies the moment the user switches to a font that DOES have one.
                              // Dimmed, not disabled, to say "saved but has no effect right now".
                              title={font.files.bold ? undefined : t("{font} has no bold face — this won't change how it looks", { font: font.label })}
                              className={`flex-1 rounded px-2 py-1.5 text-[12px] font-bold transition ${
                                style.bold ? "bg-sky-500/30 text-white" : "bg-white/5 text-white/60 hover:bg-white/10"
                              } ${font.files.bold ? "" : "opacity-40"}`}
                            >
                              B
                            </button>
                            <button
                              onClick={() => patchTextStyle(asset.id, content, { italic: !style.italic })}
                              aria-pressed={style.italic}
                              title={font.files.italic ? undefined : t("{font} has no italic face — this won't change how it looks", { font: font.label })}
                              className={`flex-1 rounded px-2 py-1.5 text-[12px] italic transition ${
                                style.italic ? "bg-sky-500/30 text-white" : "bg-white/5 text-white/60 hover:bg-white/10"
                              } ${font.files.italic ? "" : "opacity-40"}`}
                            >
                              I
                            </button>
                          </div>
                          <div className="flex items-center gap-1 py-1.5">
                            {(["left", "center", "right"] as const).map((align) => (
                              <AlignButton
                                key={align}
                                active={style.align === align}
                                onClick={() => patchTextStyle(asset.id, content, { align })}
                              >
                                {align === "left" ? t("Left") : align === "center" ? t("Center") : t("Right")}
                              </AlignButton>
                            ))}
                          </div>
                          <label className="flex items-center justify-between gap-2 py-1.5 text-[12px] text-white/70">
                            <span>{t("Background")}</span>
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5 accent-sky-400"
                              checked={Boolean(style.backgroundColor)}
                              onChange={(e) =>
                                patchTextStyle(asset.id, content, {
                                  backgroundColor: e.target.checked ? "#000000" : undefined,
                                })
                              }
                            />
                          </label>
                          {style.backgroundColor && (
                            <label className="flex items-center justify-between gap-2 py-1.5">
                              <span className="text-[12px] text-white/50">{t("Background color")}</span>
                              <input
                                type="color"
                                value={style.backgroundColor}
                                onChange={(e) => patchTextStyle(asset.id, content, { backgroundColor: e.target.value })}
                                className="h-7 w-11 cursor-pointer rounded border border-white/10 bg-transparent"
                              />
                            </label>
                          )}
                          <label className="flex items-center justify-between gap-2 py-1.5 text-[12px] text-white/70">
                            <span>{t("Outline")}</span>
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5 accent-sky-400"
                              checked={Boolean(style.strokeColor)}
                              onChange={(e) =>
                                patchTextStyle(asset.id, content, {
                                  strokeColor: e.target.checked ? "#000000" : undefined,
                                })
                              }
                            />
                          </label>
                          {style.strokeColor && (
                            <>
                              <label className="flex items-center justify-between gap-2 py-1.5">
                                <span className="text-[12px] text-white/50">{t("Outline color")}</span>
                                <input
                                  type="color"
                                  value={style.strokeColor}
                                  onChange={(e) => patchTextStyle(asset.id, content, { strokeColor: e.target.value })}
                                  className="h-7 w-11 cursor-pointer rounded border border-white/10 bg-transparent"
                                />
                              </label>
                              <NumberField
                                label={t("Outline width")}
                                value={style.strokeWidth}
                                suffix="px"
                                step={1}
                                onPreview={(v) => previewTextStyle(clip.id, asset.id, { strokeWidth: v })}
                                onCommit={(v) => patchTextStyle(asset.id, content, { strokeWidth: v })}
                              />
                            </>
                          )}
                          <label className="flex items-center justify-between gap-2 py-1.5 text-[12px] text-white/70">
                            <span>{t("Shadow")}</span>
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5 accent-sky-400"
                              checked={Boolean(style.shadowColor)}
                              onChange={(e) =>
                                patchTextStyle(asset.id, content, {
                                  shadowColor: e.target.checked ? "#000000" : undefined,
                                })
                              }
                            />
                          </label>
                          {style.shadowColor && (
                            <>
                              <label className="flex items-center justify-between gap-2 py-1.5">
                                <span className="text-[12px] text-white/50">{t("Shadow color")}</span>
                                <input
                                  type="color"
                                  value={style.shadowColor}
                                  onChange={(e) => patchTextStyle(asset.id, content, { shadowColor: e.target.value })}
                                  className="h-7 w-11 cursor-pointer rounded border border-white/10 bg-transparent"
                                />
                              </label>
                              <NumberField
                                label={t("Shadow X")}
                                value={style.shadowOffsetX}
                                suffix="px"
                                step={1}
                                onPreview={(v) => previewTextStyle(clip.id, asset.id, { shadowOffsetX: v })}
                                onCommit={(v) => patchTextStyle(asset.id, content, { shadowOffsetX: v })}
                              />
                              <NumberField
                                label={t("Shadow Y")}
                                value={style.shadowOffsetY}
                                suffix="px"
                                step={1}
                                onPreview={(v) => previewTextStyle(clip.id, asset.id, { shadowOffsetY: v })}
                                onCommit={(v) => patchTextStyle(asset.id, content, { shadowOffsetY: v })}
                              />
                            </>
                          )}
                          <NumberField
                            label={t("Line spacing")}
                            value={style.lineHeightMultiplier}
                            step={0.1}
                            onPreview={(v) => previewTextStyle(clip.id, asset.id, { lineHeightMultiplier: v })}
                            onCommit={(v) => patchTextStyle(asset.id, content, { lineHeightMultiplier: v })}
                          />
                          <p className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-white/30">
                            {t("Position")}
                          </p>
                          <NumberField
                            label={t("Offset X")}
                            value={style.offsetX}
                            suffix="px"
                            step={5}
                            onPreview={(v) => previewTextStyle(clip.id, asset.id, { offsetX: v })}
                            onCommit={(v) => patchTextStyle(asset.id, content, { offsetX: v })}
                          />
                          <NumberField
                            label={t("Offset Y")}
                            value={style.offsetY}
                            suffix="px"
                            step={5}
                            onPreview={(v) => previewTextStyle(clip.id, asset.id, { offsetY: v })}
                            onCommit={(v) => patchTextStyle(asset.id, content, { offsetY: v })}
                          />
                          <NumberField
                            label={t("Rotation")}
                            value={style.rotationDeg}
                            suffix="°"
                            step={1}
                            onPreview={(v) => previewTextStyle(clip.id, asset.id, { rotationDeg: v })}
                            onCommit={(v) => patchTextStyle(asset.id, content, { rotationDeg: v })}
                          />
                          {/* A frame-space mask (CSS overflow:hidden), independent of the text's own
                              position above — see `TextCrop`'s own doc comment. Same 2-row-paired
                              layout as the video Transform tab's own Crop subsection (Top/Bottom, then
                              Left/Right). */}
                          <p className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-white/30">{t("Crop")}</p>
                          <div className="flex gap-3">
                            <div className="flex-1">
                              <NumberField
                                label={t("Top")}
                                value={clip.textCrop?.top ?? 0}
                                suffix="%"
                                step={1}
                                min={0}
                                max={100}
                                compact
                                toDisplay={(v) => v * 100}
                                fromDisplay={(v) => v / 100}
                                onPreview={(v) => previewTextCrop(clip.id, { top: v })}
                                onCommit={(v) => patchTextCrop(clip.id, { top: v })}
                              />
                            </div>
                            <div className="flex-1">
                              <NumberField
                                label={t("Bottom")}
                                value={clip.textCrop?.bottom ?? 0}
                                suffix="%"
                                step={1}
                                min={0}
                                max={100}
                                compact
                                toDisplay={(v) => v * 100}
                                fromDisplay={(v) => v / 100}
                                onPreview={(v) => previewTextCrop(clip.id, { bottom: v })}
                                onCommit={(v) => patchTextCrop(clip.id, { bottom: v })}
                              />
                            </div>
                          </div>
                          <div className="flex gap-3">
                            <div className="flex-1">
                              <NumberField
                                label={t("Left")}
                                value={clip.textCrop?.left ?? 0}
                                suffix="%"
                                step={1}
                                min={0}
                                max={100}
                                compact
                                toDisplay={(v) => v * 100}
                                fromDisplay={(v) => v / 100}
                                onPreview={(v) => previewTextCrop(clip.id, { left: v })}
                                onCommit={(v) => patchTextCrop(clip.id, { left: v })}
                              />
                            </div>
                            <div className="flex-1">
                              <NumberField
                                label={t("Right")}
                                value={clip.textCrop?.right ?? 0}
                                suffix="%"
                                step={1}
                                min={0}
                                max={100}
                                compact
                                toDisplay={(v) => v * 100}
                                fromDisplay={(v) => v / 100}
                                onPreview={(v) => previewTextCrop(clip.id, { right: v })}
                                onCommit={(v) => patchTextCrop(clip.id, { right: v })}
                              />
                            </div>
                          </div>
                          {clip.textCrop && (
                            <button
                              onClick={() => run(new SetClipTextCropCommand(clip.id, IDENTITY_TEXT_CROP))}
                              className="mt-2.5 w-full rounded bg-white/5 py-1.5 text-[12px] text-white/60 transition hover:bg-white/10 hover:text-white"
                            >
                              {t("Reset crop")}
                            </button>
                          )}
                        </>
                      );
                    })()}
                  </CollapsibleSection>
                )}

                {/* Quick-apply preset "looks" — color/background/outline/shadow combinations a caption
                    tool would offer as one-click presets, distinct from the granular controls in the
                    Text section above (which stay the place to fine-tune afterward, or build a look
                    that isn't one of these). Hover live-previews the SAME way the Font picker's own
                    options do (`previewTextStyle`), so a user can compare a few before committing. */}
                {activeTab === "text" && asset?.kind === "text" && (
                  <CollapsibleSection
                    title={t("Styles")}
                    accent="bg-violet-400"
                    open={!collapsed.has("Styles")}
                    onToggle={() => toggleSection("Styles")}
                  >
                    {(() => {
                      const style = asset.textStyle ?? DEFAULT_TEXT_STYLE;
                      const content = asset.textContent ?? "";
                      return (
                        <div className="grid grid-cols-3 gap-1.5">
                          {TEXT_STYLE_PRESETS.map((preset) => (
                            <button
                              key={preset.id}
                              onClick={() => applyFullTextStyle(asset.id, content, applyTextStylePreset(style, preset))}
                              onMouseEnter={() => previewFullTextStyle(clip.id, applyTextStylePreset(style, preset))}
                              onMouseLeave={clearPreview}
                              className="flex flex-col items-center gap-1 rounded p-1 transition hover:bg-white/10"
                            >
                              <span
                                className="flex h-[42px] w-full items-center justify-center overflow-hidden rounded border border-white/10 bg-black/40 text-[15px]"
                                style={{
                                  color: preset.color,
                                  fontWeight: preset.bold ? 700 : 400,
                                  backgroundColor: preset.backgroundColor ?? undefined,
                                  WebkitTextStroke: preset.strokeColor ? `1px ${preset.strokeColor}` : undefined,
                                  textShadow: preset.shadowColor
                                    ? `${preset.shadowOffsetX ?? 2}px ${preset.shadowOffsetY ?? 2}px 0 ${preset.shadowColor}`
                                    : undefined,
                                }}
                              >
                                Ag
                              </span>
                              <span className="truncate text-[10px] text-white/60">{t(preset.label)}</span>
                            </button>
                          ))}
                        </div>
                      );
                    })()}
                  </CollapsibleSection>
                )}

                {/* A continuous motion effect over the clip's own visible duration — see
                    `TextAnimationType`'s own doc comment for what each does. All five render for real
                    on desktop/web export; Word Highlight specifically renders through FFmpeg's
                    `subtitles=` (libass) filter rather than `drawtext` (see `buildExportPlan.ts`'s
                    `buildWordHighlightSubtitlesFilter`) and currently falls back to plain static text
                    on MOBILE export only, where that capability isn't wired up yet — no in-UI warning
                    for that gap since the Inspector can't know at edit time which export path a given
                    render will take, matching how every other animation-plus-rotation scope cut already
                    goes undocumented in this same panel. Each tile animates its own small sample
                    continuously (only 5 options total, cheap enough to animate all of them at once
                    rather than gating on hover the way the much longer Transition grid does). */}
                {activeTab === "text" && asset?.kind === "text" && (
                  <CollapsibleSection
                    title={t("Animation")}
                    accent="bg-violet-400"
                    open={!collapsed.has("Animation")}
                    onToggle={() => toggleSection("Animation")}
                  >
                    <div className="grid grid-cols-3 gap-1.5">
                      <button
                        onClick={() => run(new SetClipTextAnimationCommand(clip.id, null))}
                        className={`flex flex-col items-center gap-1 rounded p-1 transition hover:bg-white/10 ${
                          !clip.textAnimation ? "bg-sky-500/20" : ""
                        }`}
                      >
                        <div
                          className="flex items-center justify-center rounded border border-white/10 bg-black/40 text-white/30"
                          style={{ width: 84, height: 48 }}
                        >
                          <Close size={14} />
                        </div>
                        <span className="text-[10px] text-white/70">{t("None")}</span>
                      </button>
                      {TEXT_ANIMATION_TYPE_OPTIONS.map((type) => (
                        <button
                          key={type}
                          onClick={() =>
                            // Switching TYPE keeps whatever `speed`/`highlightColor` was already set —
                            // a user comparing Bounce vs Wiggle at 2x speed shouldn't have speed reset
                            // to 1x on every click, and `highlightColor` re-applies instantly if they
                            // switch back to Word Highlight later.
                            run(
                              new SetClipTextAnimationCommand(clip.id, {
                                type,
                                ...(clip.textAnimation?.highlightColor ? { highlightColor: clip.textAnimation.highlightColor } : null),
                                ...(clip.textAnimation?.speed ? { speed: clip.textAnimation.speed } : null),
                              })
                            )
                          }
                          className={`flex flex-col items-center gap-1 rounded p-1 transition hover:bg-white/10 ${
                            clip.textAnimation?.type === type ? "bg-sky-500/20" : ""
                          }`}
                        >
                          <TextAnimationPreviewTile type={type} />
                          <span className="text-[10px] text-white/70">{t(TEXT_ANIMATION_TYPE_LABEL[type])}</span>
                        </button>
                      ))}
                    </div>
                    {clip.textAnimation && (
                      <>
                        <NumberField
                          label={t("Speed")}
                          value={clip.textAnimation.speed ?? 1}
                          suffix="x"
                          step={0.25}
                          min={0.1}
                          max={10}
                          onCommit={(v) => run(new SetClipTextAnimationCommand(clip.id, { ...clip.textAnimation!, speed: v }))}
                        />
                        {clip.textAnimation.type === "wordHighlight" && (
                          <label className="flex items-center justify-between gap-2 py-1.5">
                            <span className="text-[12px] text-white/50">{t("Highlight color")}</span>
                            <input
                              type="color"
                              value={clip.textAnimation.highlightColor ?? DEFAULT_WORD_HIGHLIGHT_COLOR}
                              onChange={(e) =>
                                run(new SetClipTextAnimationCommand(clip.id, { ...clip.textAnimation!, highlightColor: e.target.value }))
                              }
                              className="h-7 w-11 cursor-pointer rounded border border-white/10 bg-transparent"
                            />
                          </label>
                        )}
                      </>
                    )}
                  </CollapsibleSection>
                )}

                {/* Audio has nothing visual to position/scale/rotate/crop — the section simply isn't
                    shown for a clip on an audio track, rather than showing controls with no effect. */}
                {activeTab === "transform" && track.kind === "video" && (
                  <CollapsibleSection
                    title={t("Transform")}
                    accent="bg-sky-400"
                    open={!collapsed.has("Transform")}
                    onToggle={() => toggleSection("Transform")}
                  >
                    <KeyframeTrack clip={clip} property="transform" playhead={playhead} fps={fps} run={run} />
                    {(() => {
                      // Resolved at the CURRENT PLAYHEAD — for a keyframed clip this is the
                      // interpolated value for whatever frame is actually showing, matching
                      // `TransformHandles`' own resolution, so the fields never show a value that
                      // disagrees with what the canvas is drawing right now.
                      const transform = resolveClipTransform(clip, playhead - clip.timelineStart);
                      return (
                        <>
                          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-white/30">
                            {t("Position")}
                          </p>
                          {/* X/Y paired on one row, like Figma/Photoshop's coordinate fields — reads as
                              one "where" concept instead of two unrelated-looking stacked rows, and
                              saves vertical space now that Rotation below has its own quick-angle row. */}
                          <div className="flex gap-3">
                            <div className="flex-1">
                              <NumberField
                                label="X"
                                value={transform.offsetX}
                                suffix="px"
                                step={5}
                                compact
                                onPreview={(v) => previewTransform(clip.id, { offsetX: v })}
                                onCommit={(v) => patchTransform(clip.id, { offsetX: v })}
                              />
                            </div>
                            <div className="flex-1">
                              <NumberField
                                label="Y"
                                value={transform.offsetY}
                                suffix="px"
                                step={5}
                                compact
                                onPreview={(v) => previewTransform(clip.id, { offsetY: v })}
                                onCommit={(v) => patchTransform(clip.id, { offsetY: v })}
                              />
                            </div>
                          </div>

                          <p className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-white/30">
                            {t("Scale")}
                          </p>
                          <NumberField
                            label={t("Scale")}
                            value={transform.scale}
                            suffix="%"
                            step={5}
                            min={10}
                            max={400}
                            onPreview={(v) => previewTransform(clip.id, { scale: v })}
                            onCommit={(v) => patchTransform(clip.id, { scale: v })}
                            toDisplay={(v) => v * 100}
                            fromDisplay={(v) => v / 100}
                          />
                          {transform.scale !== 1 && (
                            <button
                              onClick={() => patchTransform(clip.id, { scale: 1 })}
                              className="mt-1 rounded bg-white/5 px-2.5 py-1 text-[11px] text-white/60 transition hover:bg-white/10 hover:text-white"
                            >
                              {t("Reset to 100%")}
                            </button>
                          )}

                          <p className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-white/30">
                            {t("Rotation")}
                          </p>
                          <NumberField
                            label={t("Angle")}
                            value={transform.rotationDeg}
                            suffix="°"
                            step={1}
                            onPreview={(v) => previewTransform(clip.id, { rotationDeg: v })}
                            onCommit={(v) => patchTransform(clip.id, { rotationDeg: v })}
                          />
                          {/* Quick rotate-by-90° and reset-to-0° — the common case (a portrait clip on a
                              landscape sequence, or vice versa) needs exactly one of these, not typing
                              "90" by hand every time. Rotation is intentionally unclamped (see
                              ClipTransform's own doc comment on why it isn't limited to -180..180 the
                              way a slider would need), so ±90 just keeps adding/subtracting rather than
                              wrapping — a clip already at 350° and rotated +90 lands at 440°, which
                              renders identically to 80° but preserves "how many turns" if that mattered
                              to the user. */}
                          <div className="mt-1.5 flex gap-1.5">
                            <button
                              onClick={() => patchTransform(clip.id, { rotationDeg: transform.rotationDeg - 90 })}
                              title={t("Rotate 90° counter-clockwise")}
                              className="flex-1 rounded bg-white/5 py-1 text-[12px] text-white/70 transition hover:bg-white/10 hover:text-white"
                            >
                              −90°
                            </button>
                            <button
                              onClick={() => patchTransform(clip.id, { rotationDeg: 0 })}
                              title={t("Reset rotation to 0°")}
                              disabled={transform.rotationDeg === 0}
                              className="flex-1 rounded bg-white/5 py-1 text-[12px] text-white/70 transition hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-30 disabled:hover:bg-white/5"
                            >
                              0°
                            </button>
                            <button
                              onClick={() => patchTransform(clip.id, { rotationDeg: transform.rotationDeg + 90 })}
                              title={t("Rotate 90° clockwise")}
                              className="flex-1 rounded bg-white/5 py-1 text-[12px] text-white/70 transition hover:bg-white/10 hover:text-white"
                            >
                              +90°
                            </button>
                          </div>
                          <p className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-white/30">
                            {t("Crop")}
                          </p>
                          {/* Paired by axis (Top/Bottom, then Left/Right) — same "reads as one concept,
                              not two unrelated rows" reasoning Position's X/Y pairing above already
                              uses, and it halves how much this section adds to the scroll a phone-sized
                              Properties sheet already has plenty of. Each field keeps its own slider
                              (narrower now, but still a full drag target within its own half). */}
                          <div className="flex gap-3">
                            <div className="flex-1">
                              <NumberField
                                label={t("Top")}
                                value={transform.crop.top}
                                suffix="%"
                                step={1}
                                min={0}
                                max={100}
                                compact
                                toDisplay={(v) => v * 100}
                                fromDisplay={(v) => v / 100}
                                onPreview={(v) => previewCrop(clip.id, { top: v })}
                                onCommit={(v) => patchCrop(clip.id, { top: v })}
                              />
                            </div>
                            <div className="flex-1">
                              <NumberField
                                label={t("Bottom")}
                                value={transform.crop.bottom}
                                suffix="%"
                                step={1}
                                min={0}
                                max={100}
                                compact
                                toDisplay={(v) => v * 100}
                                fromDisplay={(v) => v / 100}
                                onPreview={(v) => previewCrop(clip.id, { bottom: v })}
                                onCommit={(v) => patchCrop(clip.id, { bottom: v })}
                              />
                            </div>
                          </div>
                          <div className="flex gap-3">
                            <div className="flex-1">
                              <NumberField
                                label={t("Left")}
                                value={transform.crop.left}
                                suffix="%"
                                step={1}
                                min={0}
                                max={100}
                                compact
                                toDisplay={(v) => v * 100}
                                fromDisplay={(v) => v / 100}
                                onPreview={(v) => previewCrop(clip.id, { left: v })}
                                onCommit={(v) => patchCrop(clip.id, { left: v })}
                              />
                            </div>
                            <div className="flex-1">
                              <NumberField
                                label={t("Right")}
                                value={transform.crop.right}
                                suffix="%"
                                step={1}
                                min={0}
                                max={100}
                                compact
                                toDisplay={(v) => v * 100}
                                fromDisplay={(v) => v / 100}
                                onPreview={(v) => previewCrop(clip.id, { right: v })}
                                onCommit={(v) => patchCrop(clip.id, { right: v })}
                              />
                            </div>
                          </div>
                          {clip.transform && (
                            <button
                              onClick={() => run(new SetClipTransformCommand(clip.id, IDENTITY_TRANSFORM))}
                              className="mt-2.5 w-full rounded bg-white/5 py-1.5 text-[12px] text-white/60 transition hover:bg-white/10 hover:text-white"
                            >
                              {t("Reset transform")}
                            </button>
                          )}
                        </>
                      );
                    })()}
                  </CollapsibleSection>
                )}

                {/* Video only, stricter than Transform's own "video track" gate above — a video track
                    can hold an IMAGE clip too, but ProPainter (the model behind this tool) is a video-
                    inpainting model with no still-image mode, so an image clip has nothing for it to
                    do. `RemoveObjectOverlay`'s own resolved-clip lookup uses this identical check. */}
                {activeTab === "transform" && track.kind === "video" && asset?.kind === "video" && (
                  <CollapsibleSection
                    title={t("Remove Object")}
                    accent="bg-teal-400"
                    open={!collapsed.has("Remove Object")}
                    onToggle={() => toggleSection("Remove Object")}
                  >
                    <RemoveObjectSection clipId={clip.id} assetName={asset.name} projectId={projectId} />
                  </CollapsibleSection>
                )}

                {/* Same gate the "Audio" mute/volume section below already uses — hasAudio, not track
                    kind, so this covers a video clip's own dialogue and a dedicated voiceover/music
                    clip alike. */}
                {activeTab === "audio" && asset?.hasAudio && (
                  <CollapsibleSection
                    title={t("Auto Captions")}
                    accent="bg-emerald-400"
                    open={!collapsed.has("Auto Captions")}
                    onToggle={() => toggleSection("Auto Captions")}
                  >
                    <AutoCaptionsSection clipId={clip.id} projectId={projectId} />
                  </CollapsibleSection>
                )}

                {/* Same video/image-only scope as Transform above (audio has nothing to color-adjust,
                    text has its own separate TextStyle system). See `ClipEffects`'s own doc comment
                    for the preview/export approximation notes on brightness/blur specifically. */}
                {activeTab === "transform" && track.kind === "video" && (
                  <CollapsibleSection
                    title={t("Effects")}
                    accent="bg-amber-400"
                    open={!collapsed.has("Effects")}
                    onToggle={() => toggleSection("Effects")}
                  >
                    <KeyframeTrack clip={clip} property="effects" playhead={playhead} fps={fps} run={run} />
                    {(() => {
                      // Resolved at the CURRENT PLAYHEAD — see the Transform section's own identical
                      // comment above.
                      const effects = resolveClipEffects(clip, playhead - clip.timelineStart);
                      return (
                        <>
                          <NumberField
                            label={t("Brightness")}
                            value={effects.brightness}
                            suffix="%"
                            step={5}
                            min={-100}
                            max={100}
                            toDisplay={(v) => v * 100}
                            fromDisplay={(v) => v / 100}
                            onPreview={(v) => previewEffects(clip.id, { brightness: v })}
                            onCommit={(v) => patchEffects(clip.id, { brightness: v })}
                          />
                          <NumberField
                            label={t("Contrast")}
                            value={effects.contrast}
                            suffix="%"
                            step={5}
                            min={0}
                            max={200}
                            toDisplay={(v) => v * 100}
                            fromDisplay={(v) => v / 100}
                            onPreview={(v) => previewEffects(clip.id, { contrast: v })}
                            onCommit={(v) => patchEffects(clip.id, { contrast: v })}
                          />
                          <NumberField
                            label={t("Saturation")}
                            value={effects.saturation}
                            suffix="%"
                            step={5}
                            min={0}
                            max={200}
                            toDisplay={(v) => v * 100}
                            fromDisplay={(v) => v / 100}
                            onPreview={(v) => previewEffects(clip.id, { saturation: v })}
                            onCommit={(v) => patchEffects(clip.id, { saturation: v })}
                          />
                          <NumberField
                            label={t("Blur")}
                            value={effects.blur}
                            suffix="px"
                            step={1}
                            min={0}
                            max={20}
                            onPreview={(v) => previewEffects(clip.id, { blur: v })}
                            onCommit={(v) => patchEffects(clip.id, { blur: v })}
                          />
                          <NumberField
                            label={t("Opacity")}
                            value={effects.opacity}
                            suffix="%"
                            step={5}
                            min={0}
                            max={100}
                            toDisplay={(v) => v * 100}
                            fromDisplay={(v) => v / 100}
                            onPreview={(v) => previewEffects(clip.id, { opacity: v })}
                            onCommit={(v) => patchEffects(clip.id, { opacity: v })}
                          />
                          {clip.effects && (
                            <button
                              onClick={() => run(new SetClipEffectsCommand(clip.id, IDENTITY_EFFECTS))}
                              className="mt-2.5 w-full rounded bg-white/5 py-1.5 text-[12px] text-white/60 transition hover:bg-white/10 hover:text-white"
                            >
                              {t("Reset effects")}
                            </button>
                          )}
                        </>
                      );
                    })()}
                  </CollapsibleSection>
                )}

                {/* Same video/image-only scope as Transform/Effects above — an RGB tone curve per
                    channel, keyframeable like Effects (a continuously-adjustable dial), unlike the
                    static-only Chroma Key section right below it. See `ColorGrading`'s own doc comment
                    for the master/channel composition order this relies on, and `CurveEditor`'s own doc
                    comment for the drag/add/remove interaction set. */}
                {activeTab === "transform" && track.kind === "video" && (
                  <CollapsibleSection
                    title={t("Color Grading")}
                    accent="bg-fuchsia-400"
                    open={!collapsed.has("Color Grading")}
                    onToggle={() => toggleSection("Color Grading")}
                  >
                    <KeyframeTrack clip={clip} property="colorGrading" playhead={playhead} fps={fps} run={run} />
                    {(() => {
                      // Resolved at the CURRENT PLAYHEAD — same reasoning as the Effects section's own
                      // identical comment above.
                      const colorGrading = resolveClipColorGrading(clip, playhead - clip.timelineStart);
                      return (
                        <>
                          <CurveEditor
                            grading={colorGrading}
                            onPreview={(next) => previewColorGrading(clip.id, next)}
                            onCommit={(next) => patchColorGrading(clip.id, next)}
                          />
                          {clip.colorGrading && (
                            <button
                              onClick={() => run(new SetClipColorGradingCommand(clip.id, IDENTITY_COLOR_GRADING))}
                              className="mt-2.5 w-full rounded bg-white/5 py-1.5 text-[12px] text-white/60 transition hover:bg-white/10 hover:text-white"
                            >
                              {t("Reset color grading")}
                            </button>
                          )}
                        </>
                      );
                    })()}
                  </CollapsibleSection>
                )}

                {/* Same video/image-only scope as Transform/Effects above — see
                    `ChromaKeySettings`'s own doc comment. No `KeyframeTrack` here: a green screen's key
                    color/similarity/smoothness are static per-clip data, not something that animates
                    over the clip's own duration the way position/effects sometimes do. */}
                {activeTab === "transform" && track.kind === "video" && (
                  <CollapsibleSection
                    title={t("Chroma Key")}
                    accent="bg-lime-400"
                    open={!collapsed.has("Chroma Key")}
                    onToggle={() => toggleSection("Chroma Key")}
                  >
                    {clip.chromaKey ? (
                      <>
                        <label className="flex items-center justify-between gap-2 py-1.5">
                          <span className="text-[12px] text-white/50">{t("Key Color")}</span>
                          <input
                            type="color"
                            value={clip.chromaKey.color}
                            onChange={(e) => run(new SetClipChromaKeyCommand(clip.id, { ...clip.chromaKey!, color: e.target.value }))}
                            className="h-7 w-11 cursor-pointer rounded border border-white/10 bg-transparent"
                          />
                        </label>
                        <NumberField
                          label={t("Similarity")}
                          value={clip.chromaKey.similarity}
                          suffix="%"
                          step={2}
                          min={0}
                          max={100}
                          toDisplay={(v) => v * 100}
                          fromDisplay={(v) => v / 100}
                          onCommit={(v) => run(new SetClipChromaKeyCommand(clip.id, { ...clip.chromaKey!, similarity: v }))}
                        />
                        <NumberField
                          label={t("Smoothness")}
                          value={clip.chromaKey.smoothness}
                          suffix="%"
                          step={2}
                          min={0}
                          max={100}
                          toDisplay={(v) => v * 100}
                          fromDisplay={(v) => v / 100}
                          onCommit={(v) => run(new SetClipChromaKeyCommand(clip.id, { ...clip.chromaKey!, smoothness: v }))}
                        />
                        <button
                          onClick={() => run(new SetClipChromaKeyCommand(clip.id, null))}
                          className="mt-2.5 w-full rounded bg-white/5 py-1.5 text-[12px] text-white/60 transition hover:bg-white/10 hover:text-white"
                        >
                          {t("Remove chroma key")}
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => run(new SetClipChromaKeyCommand(clip.id, DEFAULT_CHROMA_KEY))}
                        className="w-full rounded bg-white/5 py-1.5 text-[12px] text-white/70 transition hover:bg-white/10 hover:text-white"
                      >
                        {t("Enable chroma key")}
                      </button>
                    )}
                  </CollapsibleSection>
                )}

                {/* Shown for every video/image, text, or audio clip now, not just one with a
                    genuinely adjacent predecessor — `findTransitionPartner` resolves a clip with no
                    eligible neighbor into a solo fade (from black for video, from transparent for
                    text, from/to silence for audio) rather than refusing to apply at all, so there's
                    no longer a real reason to hide this section on the first clip of a track.
                    `findTransitionCandidate` is still used below, just for wording the checkbox label
                    correctly, not for gating whether it appears. Video/image, text, AND audio —
                    `findTransitionPartner` itself is track-kind-agnostic, and all three renderers
                    blend an adjacent pair the same way (video: `PlaybackEngine.drawTextLayer`'s own
                    comment; audio: `buildAudioTrackStream`'s own comment on why it's always a plain
                    `acrossfade`) — one section covers all three rather than a near-duplicate copy per
                    kind. */}
                {activeTab === "transitions" &&
                  (track.kind === "video" || track.kind === "text" || track.kind === "audio") &&
                  (() => {
                    const hasPredecessor = Boolean(findTransitionCandidate(track, clip));
                    const transitionIn = clip.transitionIn;
                    const enableLabel = hasPredecessor
                      ? track.kind === "video"
                        ? t("Crossfade from previous clip")
                        : t("Transition from previous clip")
                      : track.kind === "video"
                        ? t("Fade in from black")
                        : t("Fade in");
                    return (
                      <CollapsibleSection
                        title={t("Transition In")}
                        accent="bg-fuchsia-400"
                        open={!collapsed.has("Transition In")}
                        onToggle={() => toggleSection("Transition In")}
                      >
                        <label className="flex items-center justify-between gap-2 py-1.5 text-[12px] text-white/70">
                          <span>{enableLabel}</span>
                          <input
                            type="checkbox"
                              className="h-3.5 w-3.5 accent-sky-400"
                            checked={!!transitionIn}
                            onChange={(e) =>
                              run(new SetClipTransitionCommand(clip.id, e.target.checked ? DEFAULT_TRANSITION : null))
                            }
                          />
                        </label>
                        {transitionIn && (
                          <>
                            {track.kind === "audio" ? (
                              // No Style picker for audio — `acrossfade` (FFmpeg's audio crossfade
                              // filter) has no "shape" concept at all beyond a linear blend, unlike
                              // the video xfade transitions this same field drives for a video clip
                              // (see `buildAudioTrackStream`'s own comment) — offering 12 styles that
                              // all sound identical would just be confusing, not more capable.
                              <p className="mb-1 text-[11px] leading-relaxed text-white/30">
                                {t("Audio transitions are always a crossfade — there's no separate visual style to pick.")}
                              </p>
                            ) : (
                              <>
                                <div className="flex items-center justify-between gap-2 py-1.5">
                                  <span className="text-[12px] text-white/50">{t("Style")}</span>
                                  <Dropdown
                                    value={transitionIn.type}
                                    onChange={(v) => run(new SetClipTransitionCommand(clip.id, { ...transitionIn, type: v }))}
                                    ariaLabel={t("Transition style")}
                                    className="min-w-0 flex-1 text-[13px]"
                                    options={TRANSITION_TYPE_OPTIONS.map((type) => ({ value: type, label: t(TRANSITION_TYPE_LABEL[type]) }))}
                                  />
                                </div>
                                {track.kind === "text" && (
                                  <p className="mb-1 text-[11px] leading-relaxed text-white/30">
                                    {t("Export always renders this as a dissolve for text — the full style shows in the preview.")}
                                  </p>
                                )}
                              </>
                            )}
                            <NumberField
                              label={t("Duration")}
                              value={transitionIn.duration}
                              suffix="s"
                              step={0.1}
                              onCommit={(v) => run(new SetClipTransitionCommand(clip.id, { ...transitionIn, duration: v }))}
                            />
                          </>
                        )}
                      </CollapsibleSection>
                    );
                  })()}

                {/* `transitionOut`'s own counterpart, immediately below "Transition In" — always a
                    solo fade (to black for video, to transparent for text, to silence for audio),
                    never a blend, since a genuine successor's boundary already belongs to THAT clip's
                    own "Transition In" (see `Clip.transitionOut`'s and `findTransitionOut`'s own doc
                    comments). No predecessor/successor-dependent wording needed here the way
                    "Transition In" has — the caveat note below covers the one case worth calling out
                    instead. */}
                {activeTab === "transitions" &&
                  (track.kind === "video" || track.kind === "text" || track.kind === "audio") &&
                  (() => {
                    const transitionOut = clip.transitionOut;
                    return (
                      <CollapsibleSection
                        title={t("Transition Out")}
                        accent="bg-fuchsia-400"
                        open={!collapsed.has("Transition Out")}
                        onToggle={() => toggleSection("Transition Out")}
                      >
                        <label className="flex items-center justify-between gap-2 py-1.5 text-[12px] text-white/70">
                          <span>{track.kind === "video" ? t("Fade out to black") : t("Fade out")}</span>
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 accent-sky-400"
                            checked={!!transitionOut}
                            onChange={(e) =>
                              run(new SetClipTransitionOutCommand(clip.id, e.target.checked ? DEFAULT_TRANSITION : null))
                            }
                          />
                        </label>
                        {transitionOut && (
                          <>
                            {track.kind === "audio" ? (
                              <p className="mb-1 text-[11px] leading-relaxed text-white/30">
                                {t("Audio transitions are always a crossfade — there's no separate visual style to pick.")}
                              </p>
                            ) : (
                              <>
                                <div className="flex items-center justify-between gap-2 py-1.5">
                                  <span className="text-[12px] text-white/50">{t("Style")}</span>
                                  <Dropdown
                                    value={transitionOut.type}
                                    onChange={(v) => run(new SetClipTransitionOutCommand(clip.id, { ...transitionOut, type: v }))}
                                    ariaLabel={t("Transition style")}
                                    className="min-w-0 flex-1 text-[13px]"
                                    options={TRANSITION_TYPE_OPTIONS.map((type) => ({ value: type, label: t(TRANSITION_TYPE_LABEL[type]) }))}
                                  />
                                </div>
                                {track.kind === "text" && (
                                  <p className="mb-1 text-[11px] leading-relaxed text-white/30">
                                    {t("Export always renders this as a dissolve for text — the full style shows in the preview.")}
                                  </p>
                                )}
                              </>
                            )}
                            <NumberField
                              label={t("Duration")}
                              value={transitionOut.duration}
                              suffix="s"
                              step={0.1}
                              onCommit={(v) => run(new SetClipTransitionOutCommand(clip.id, { ...transitionOut, duration: v }))}
                            />
                            <p className="mb-1 mt-1 text-[11px] leading-relaxed text-white/30">
                              {t("Only takes effect when nothing follows this clip on the track.")}
                            </p>
                          </>
                        )}
                      </CollapsibleSection>
                    );
                  })()}

                {/* Shown for any clip whose asset actually has audio to mute, on either a video or an
                    audio track — a video clip's own embedded sound and a music/voiceover clip are the
                    same kind of toggle, just living on different track kinds. */}
                {activeTab === "audio" && asset?.hasAudio && (
                  <CollapsibleSection
                    title={t("Audio")}
                    accent="bg-rose-400"
                    open={!collapsed.has("Audio")}
                    onToggle={() => toggleSection("Audio")}
                  >
                    <label className="flex items-center justify-between gap-2 py-1.5 text-[12px] text-white/70">
                      <span>{t("Mute clip")}</span>
                      <input
                        type="checkbox"
                              className="h-3.5 w-3.5 accent-sky-400"
                        checked={clip.mutedAudio ?? false}
                        onChange={(e) => run(new SetClipMutedCommand(clip.id, e.target.checked))}
                      />
                    </label>
                    {/* Independent of Mute above — see `Clip.gain`'s own doc comment on why the two
                        compose rather than one replacing the other. Capped at 400%, not 100% — routed
                        through `AudioMixEngine`'s Web Audio graph rather than a plain element's native
                        `.volume`, so real amplification (not just attenuation) is genuinely possible;
                        see `setClipGain`'s own comment for why 400 specifically. */}
                    <NumberField
                      label={t("Volume")}
                      value={clip.gain ?? 1}
                      suffix="%"
                      step={5}
                      min={0}
                      max={400}
                      toDisplay={(v) => v * 100}
                      fromDisplay={(v) => v / 100}
                      onCommit={(v) => run(new SetClipGainCommand(clip.id, v))}
                    />
                  </CollapsibleSection>
                )}

                {/* Timeline/Source/Media merged into one "Details" section, collapsed by default (see
                    `collapsed`'s own initializer) — all three are pure read-only reference facts, never
                    what opening this panel is FOR, so folding them under one closed-by-default toggle
                    is what actually shortens the common "adjust a clip's properties" scroll instead of
                    just rearranging the same always-visible length into fewer headers. Sub-groups keep
                    their own small caption (same style Transform's Position/Scale/Rotation/Crop already
                    use) so the three kinds of fact stay visually distinct within the one section. */}
                <CollapsibleSection
                  title={t("Details")}
                  accent="bg-white/30"
                  open={!collapsed.has("Details")}
                  onToggle={() => toggleSection("Details")}
                >
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-white/30">{t("Timeline")}</p>
                  <Row label={t("Start")} value={formatTimecode(clip.timelineStart, fps)} />
                  <Row label={t("End")} value={formatTimecode(clip.timelineStart + clipDuration(clip), fps)} />
                  <Row label={t("Duration")} value={formatTimecode(clipDuration(clip), fps)} />

                  <p className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-white/30">{t("Source")}</p>
                  <Row label={t("In")} value={formatTimecode(clip.sourceIn, fps)} />
                  <Row label={t("Out")} value={formatTimecode(clip.sourceOut, fps)} />
                  {asset && <Row label={t("Full length")} value={formatTimecode(asset.duration, fps)} />}

                  {asset && (asset.width || asset.fps) && (
                    <>
                      <p className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-white/30">{t("Media")}</p>
                      {asset.width && asset.height && <Row label={t("Size")} value={`${asset.width}×${asset.height}`} />}
                      {asset.fps && <Row label={t("Rate")} value={`${Math.round(asset.fps)} fps`} />}
                      <Row label={t("Audio")} value={asset.hasAudio ? t("Yes") : t("No")} />
                    </>
                  )}
                </CollapsibleSection>
              </div>
            );
          })()
        )}
      </div>
    </aside>
  );
}
