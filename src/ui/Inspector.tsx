"use client";

import React, { useEffect, useRef, useState } from "react";
import { ChevronDown } from "@veasnawt/vicons";
import {
  cancelInpaint,
  cancelLocalSetup,
  getInpaintKeyStatus,
  inpaintAvailable,
  setActiveInpaintProvider,
  setInpaintApiKey,
  startInpaint,
  startLocalSetup,
  watchInpaint,
  watchLocalSetup,
} from "../api/client.ts";
import type { InpaintKeyStatus, InpaintProgress, InpaintProvider, LocalSetupProgress } from "../api/client.ts";
import {
  SetClipEffectsCommand,
  SetClipGainCommand,
  SetClipMutedCommand,
  SetClipTransformCommand,
  SetClipTransitionCommand,
  SetTextCommand,
} from "../commands/index.ts";
import { clipDuration, findAsset, findClip } from "../project/createProject.ts";
import { FONT_REGISTRY, fontById } from "../project/fonts.ts";
import type { ClipEffects, ClipTransform, TextStyle } from "../project/types.ts";
import { DEFAULT_TEXT_STYLE, IDENTITY_EFFECTS, IDENTITY_TRANSFORM } from "../project/types.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { formatTimecode } from "../timeline/time.ts";
import { DEFAULT_TRANSITION, findTransitionCandidate } from "../timeline/transitions.ts";
import { Dropdown, type DropdownOption } from "./Dropdown.tsx";
import { NumberField } from "./NumberField.tsx";

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
      placeholder="Text"
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
        setError("Couldn't switch providers");
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
      setError("Couldn't save that API key");
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
      setError(err instanceof Error ? err.message : "Could not start setup");
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
      setError(err instanceof Error ? err.message : "Could not start the job");
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
    return <p className="text-[12px] text-white/35">Checking…</p>;
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
    label: `${INPAINT_PROVIDER_LABELS[p]}${status.configured[p] ? " ✓" : ""}`,
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
        <span className="text-[10px] font-medium uppercase tracking-wide text-white/40">Provider</span>
        <Dropdown
          value={selectedProvider}
          options={providerOptions}
          onChange={(v) => void handleProviderChange(v)}
          ariaLabel="Remove Object provider"
          disabled={phase === "running"}
          className="w-32 text-[11px]"
        />
      </div>
      <p className="text-[11px] text-white/35">
        {selectedProvider === "local"
          ? isConfigured
            ? isActive
              ? "Using Local (CPU)."
              : "Switching to Local (CPU) — it's already set up."
            : "Not set up yet."
          : isActive
            ? isConfigured
              ? `Using ${INPAINT_PROVIDER_LABELS[selectedProvider]}.`
              : `Set to ${INPAINT_PROVIDER_LABELS[selectedProvider]}, but no key is saved for it yet.`
            : isConfigured
              ? `Switching to ${INPAINT_PROVIDER_LABELS[selectedProvider]} — it already has a saved key.`
              : `No key saved for ${INPAINT_PROVIDER_LABELS[selectedProvider]} yet.`}
      </p>
      {selectedProvider === "local" ? (
        <>
          <p className="text-[11px] leading-relaxed text-amber-300/80">
            Runs ProPainter locally via Python — free, but{" "}
            <span className="font-medium">non-commercial use only</span>. CPU inference is slow: expect
            minutes per clip, and the very first run also downloads ~1-2GB of model weights.
          </p>
          {!isConfigured &&
            (setupPhase === "running" ? (
              <>
                <p className="text-[11px] text-white/50 capitalize">{setupStage || "Starting…"}</p>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-sky-400 transition-all" style={{ width: `${Math.round(setupProgress * 100)}%` }} />
                </div>
                <button
                  onClick={stopLocalSetup}
                  className="rounded bg-white/5 px-2.5 py-1 text-[11px] text-white/60 transition hover:bg-white/10 hover:text-white"
                >
                  Cancel setup
                </button>
              </>
            ) : (
              <button
                onClick={() => void handleStartLocalSetup()}
                className="w-full rounded bg-sky-500 py-1.5 text-[12px] font-medium text-white transition hover:bg-sky-400"
              >
                Set up local model
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
                ? "Paste a new key to replace the saved one"
                : selectedProvider === "fal"
                  ? "fal.ai API key"
                  : "Replicate API token"
            }
            className="min-w-0 flex-1 rounded bg-white/5 px-2.5 py-1.5 text-[12px] text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-sky-400/60"
          />
          <button
            onClick={() => void handleSaveKey()}
            disabled={savingKey || !keyInput.trim()}
            className="shrink-0 rounded bg-sky-500 px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-sky-400 disabled:opacity-50"
          >
            {savingKey ? "Saving…" : isConfigured ? "Replace" : "Save"}
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
            ? "Erases an object or watermark from this clip using a locally-run AI model — free, but slower than a cloud provider."
            : "Erases an object or watermark from this clip using a cloud AI model. Needs an API key — the clip is sent there for processing."}
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
        <p className="text-[12px] leading-relaxed text-rose-300">FFmpeg isn't available — reinstall dependencies to use this.</p>
      </>
    );
  }

  if (phase === "running") {
    return (
      <>
        {credentialsBlock}
        <p className="text-[12px] text-white/60 capitalize">{stage || "Starting…"}</p>
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-sky-400 transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <button onClick={stop} className="mt-2 rounded bg-white/5 px-2.5 py-1 text-[11px] text-white/60 transition hover:bg-white/10 hover:text-white">
          Cancel
        </button>
      </>
    );
  }

  if (phase === "done") {
    return (
      <>
        {credentialsBlock}
        <p className="text-[12px] text-emerald-300">Added to the Media Library.</p>
        <button onClick={startOver} className="mt-2 rounded bg-white/5 px-2.5 py-1 text-[11px] text-white/60 transition hover:bg-white/10 hover:text-white">
          Start over
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
            Draw a box over the object or watermark on the preview. Works best for a mostly-static
            background — the same region is erased across the whole clip.
          </p>
          <button
            onClick={() => armRemoveObject(clipId)}
            className={`mt-2 w-full rounded py-1.5 text-[12px] font-medium transition ${
              armed ? "bg-rose-500/30 text-white" : "bg-white/5 text-white/70 hover:bg-white/10 hover:text-white"
            }`}
          >
            {armed ? "Drawing… click and drag on the preview" : "Draw region"}
          </button>
        </>
      ) : (
        <>
          <p className="text-[12px] text-white/50">
            Region: {Math.round(rect.width)}×{Math.round(rect.height)} px
          </p>
          <p className="mt-1 text-[11px] text-white/35">Result has no audio — "{assetName}"'s own audio isn't affected either way.</p>
          {selectedProvider === "fal" && (
            <input
              type="text"
              value={backgroundPrompt}
              onChange={(e) => setBackgroundPrompt(e.target.value)}
              placeholder="Describe the background that should appear (optional)"
              className="mt-2 w-full rounded bg-white/5 px-2.5 py-1.5 text-[12px] text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-sky-400/60"
            />
          )}
          <div className="mt-2 flex gap-2">
            <button onClick={() => void begin()} className="flex-1 rounded bg-sky-500 py-1.5 text-[12px] font-semibold text-white transition hover:bg-sky-400">
              Remove Object
            </button>
            <button onClick={clearRemoveObject} className="rounded bg-white/5 px-3 py-1.5 text-[12px] text-white/60 transition hover:bg-white/10 hover:text-white">
              Clear
            </button>
          </div>
        </>
      )}
    </>
  );
}

/** Properties for the current selection — timeline/source facts are read-only (renaming a clip's
 *  position happens by dragging it, not typing here), while Position/Scale/Rotation/Crop and
 *  Brightness/Contrast/Saturation/Blur/Opacity are real, wired-up, undo-able controls. Keyframes are
 *  still out of scope: transform and effects are each a single static value per clip, not something
 *  that can animate over the clip's duration. */
export function Inspector() {
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

  /** Reads the clip's current transform (defaulting to identity), patches ONE field, and dispatches
   *  it as a single command — this is the one place every transform field commits through, so
   *  clamping (in `setClipTransform`) and undo grouping stay consistent regardless of which field the
   *  user touched. */
  function patchTransform(clipId: string, patch: Partial<ClipTransform>) {
    const current = found?.clip.transform ?? IDENTITY_TRANSFORM;
    run(new SetClipTransformCommand(clipId, { ...current, ...patch }));
  }

  function patchCrop(clipId: string, patch: Partial<ClipTransform["crop"]>) {
    const current = found?.clip.transform ?? IDENTITY_TRANSFORM;
    run(new SetClipTransformCommand(clipId, { ...current, crop: { ...current.crop, ...patch } }));
  }

  /** Same pattern as `patchTransform`, for `ClipEffects` instead. */
  function patchEffects(clipId: string, patch: Partial<ClipEffects>) {
    const current = found?.clip.effects ?? IDENTITY_EFFECTS;
    run(new SetClipEffectsCommand(clipId, { ...current, ...patch }));
  }

  /** Reads the asset's current content+style, patches ONE field, and dispatches it as a single
   *  command — same pattern as `patchTransform`, except addressed by ASSET id: content/style live on
   *  the text asset itself, not the clip (see `Asset.textContent`'s own doc comment). */
  function patchTextStyle(assetId: string, content: string, patch: Partial<TextStyle>) {
    const current = project?.assets.find((a) => a.id === assetId)?.textStyle ?? DEFAULT_TEXT_STYLE;
    run(new SetTextCommand(assetId, content, { ...current, ...patch }));
  }

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-white/10 bg-[#0d0f14]">
      <header className="border-b border-white/10 px-3 py-2.5">
        <h2 className="text-[13px] font-semibold uppercase tracking-wider text-white/70">Properties</h2>
      </header>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-3.5">
        {!found ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-2 text-center">
            {selectedClipIds.length > 1 ? (
              <>
                <p className="text-[13px] font-medium text-white/60">{selectedClipIds.length} clips selected</p>
                <p className="max-w-[200px] text-[11px] leading-relaxed text-white/35">
                  Properties are shown one clip at a time — select just one to edit it.
                </p>
              </>
            ) : (
              <p className="text-[12px] leading-relaxed text-white/35">Select a clip to see its properties</p>
            )}
          </div>
        ) : (
          (() => {
            const { clip, track } = found;
            const asset = findAsset(project!, clip.assetId);
            return (
              <div className="space-y-5">
                <div>
                  <p className="truncate text-[13px] font-semibold text-white/90">{asset?.name ?? "Missing media"}</p>
                  <p className="text-[12px] text-white/40">{track.name}</p>
                </div>

                {/* Text has no video content to Transform (no scale/rotation/crop — font size already
                    covers "how big", and the position it DOES have is a simpler offsetX/offsetY pair
                    living on the asset's own style, not the video/image ClipTransform system — see
                    TextStyle's own doc comment for why). */}
                {asset?.kind === "text" && (
                  <CollapsibleSection
                    title="Text"
                    accent="bg-violet-400"
                    open={!collapsed.has("Text")}
                    onToggle={() => toggleSection("Text")}
                  >
                    <TextContentField
                      value={asset.textContent ?? ""}
                      onCommit={(content) => run(new SetTextCommand(asset.id, content, asset.textStyle ?? DEFAULT_TEXT_STYLE))}
                    />
                    {(() => {
                      const style = asset.textStyle ?? DEFAULT_TEXT_STYLE;
                      const content = asset.textContent ?? "";
                      const font = fontById(style.fontFamily);
                      return (
                        <>
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
                            <span className="text-[12px] text-white/50">Font</span>
                            <Dropdown
                              value={style.fontFamily}
                              onChange={(v) => patchTextStyle(asset.id, content, { fontFamily: v })}
                              ariaLabel="Font"
                              className="min-w-0 flex-1 text-[13px]"
                              options={FONT_REGISTRY.map((f) => ({
                                value: f.id,
                                label: f.label,
                                style: { fontFamily: `"${f.cssFamily}"` },
                              }))}
                            />
                          </div>
                          <NumberField
                            label="Size"
                            value={style.fontSize}
                            suffix="px"
                            step={2}
                            onCommit={(v) => patchTextStyle(asset.id, content, { fontSize: v })}
                          />
                          <label className="flex items-center justify-between gap-2 py-1.5">
                            <span className="text-[12px] text-white/50">Color</span>
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
                              title={font.files.bold ? undefined : `${font.label} has no bold face — this won't change how it looks`}
                              className={`flex-1 rounded px-2 py-1.5 text-[12px] font-bold transition ${
                                style.bold ? "bg-sky-500/30 text-white" : "bg-white/5 text-white/60 hover:bg-white/10"
                              } ${font.files.bold ? "" : "opacity-40"}`}
                            >
                              B
                            </button>
                            <button
                              onClick={() => patchTextStyle(asset.id, content, { italic: !style.italic })}
                              aria-pressed={style.italic}
                              title={font.files.italic ? undefined : `${font.label} has no italic face — this won't change how it looks`}
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
                                {align}
                              </AlignButton>
                            ))}
                          </div>
                          <label className="flex items-center justify-between gap-2 py-1.5 text-[12px] text-white/70">
                            <span>Background</span>
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
                              <span className="text-[12px] text-white/50">Background color</span>
                              <input
                                type="color"
                                value={style.backgroundColor}
                                onChange={(e) => patchTextStyle(asset.id, content, { backgroundColor: e.target.value })}
                                className="h-7 w-11 cursor-pointer rounded border border-white/10 bg-transparent"
                              />
                            </label>
                          )}
                          <label className="flex items-center justify-between gap-2 py-1.5 text-[12px] text-white/70">
                            <span>Outline</span>
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
                                <span className="text-[12px] text-white/50">Outline color</span>
                                <input
                                  type="color"
                                  value={style.strokeColor}
                                  onChange={(e) => patchTextStyle(asset.id, content, { strokeColor: e.target.value })}
                                  className="h-7 w-11 cursor-pointer rounded border border-white/10 bg-transparent"
                                />
                              </label>
                              <NumberField
                                label="Outline width"
                                value={style.strokeWidth}
                                suffix="px"
                                step={1}
                                onCommit={(v) => patchTextStyle(asset.id, content, { strokeWidth: v })}
                              />
                            </>
                          )}
                          <label className="flex items-center justify-between gap-2 py-1.5 text-[12px] text-white/70">
                            <span>Shadow</span>
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
                                <span className="text-[12px] text-white/50">Shadow color</span>
                                <input
                                  type="color"
                                  value={style.shadowColor}
                                  onChange={(e) => patchTextStyle(asset.id, content, { shadowColor: e.target.value })}
                                  className="h-7 w-11 cursor-pointer rounded border border-white/10 bg-transparent"
                                />
                              </label>
                              <NumberField
                                label="Shadow X"
                                value={style.shadowOffsetX}
                                suffix="px"
                                step={1}
                                onCommit={(v) => patchTextStyle(asset.id, content, { shadowOffsetX: v })}
                              />
                              <NumberField
                                label="Shadow Y"
                                value={style.shadowOffsetY}
                                suffix="px"
                                step={1}
                                onCommit={(v) => patchTextStyle(asset.id, content, { shadowOffsetY: v })}
                              />
                            </>
                          )}
                          <NumberField
                            label="Line spacing"
                            value={style.lineHeightMultiplier}
                            step={0.1}
                            onCommit={(v) => patchTextStyle(asset.id, content, { lineHeightMultiplier: v })}
                          />
                          <p className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-white/30">
                            Position
                          </p>
                          <NumberField
                            label="Offset X"
                            value={style.offsetX}
                            suffix="px"
                            step={5}
                            onCommit={(v) => patchTextStyle(asset.id, content, { offsetX: v })}
                          />
                          <NumberField
                            label="Offset Y"
                            value={style.offsetY}
                            suffix="px"
                            step={5}
                            onCommit={(v) => patchTextStyle(asset.id, content, { offsetY: v })}
                          />
                          <NumberField
                            label="Rotation"
                            value={style.rotationDeg}
                            suffix="°"
                            step={1}
                            onCommit={(v) => patchTextStyle(asset.id, content, { rotationDeg: v })}
                          />
                        </>
                      );
                    })()}
                  </CollapsibleSection>
                )}

                {/* Audio has nothing visual to position/scale/rotate/crop — the section simply isn't
                    shown for a clip on an audio track, rather than showing controls with no effect. */}
                {track.kind === "video" && (
                  <CollapsibleSection
                    title="Transform"
                    accent="bg-sky-400"
                    open={!collapsed.has("Transform")}
                    onToggle={() => toggleSection("Transform")}
                  >
                    {(() => {
                      const transform = clip.transform ?? IDENTITY_TRANSFORM;
                      return (
                        <>
                          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-white/30">
                            Position
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
                                onCommit={(v) => patchTransform(clip.id, { offsetY: v })}
                              />
                            </div>
                          </div>

                          <p className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-white/30">
                            Scale
                          </p>
                          <NumberField
                            label="Scale"
                            value={transform.scale}
                            suffix="%"
                            step={5}
                            onCommit={(v) => patchTransform(clip.id, { scale: v })}
                            toDisplay={(v) => v * 100}
                            fromDisplay={(v) => v / 100}
                          />
                          {transform.scale !== 1 && (
                            <button
                              onClick={() => patchTransform(clip.id, { scale: 1 })}
                              className="mt-1 rounded bg-white/5 px-2.5 py-1 text-[11px] text-white/60 transition hover:bg-white/10 hover:text-white"
                            >
                              Reset to 100%
                            </button>
                          )}

                          <p className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-white/30">
                            Rotation
                          </p>
                          <NumberField
                            label="Angle"
                            value={transform.rotationDeg}
                            suffix="°"
                            step={1}
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
                              title="Rotate 90° counter-clockwise"
                              className="flex-1 rounded bg-white/5 py-1 text-[12px] text-white/70 transition hover:bg-white/10 hover:text-white"
                            >
                              −90°
                            </button>
                            <button
                              onClick={() => patchTransform(clip.id, { rotationDeg: 0 })}
                              title="Reset rotation to 0°"
                              disabled={transform.rotationDeg === 0}
                              className="flex-1 rounded bg-white/5 py-1 text-[12px] text-white/70 transition hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-30 disabled:hover:bg-white/5"
                            >
                              0°
                            </button>
                            <button
                              onClick={() => patchTransform(clip.id, { rotationDeg: transform.rotationDeg + 90 })}
                              title="Rotate 90° clockwise"
                              className="flex-1 rounded bg-white/5 py-1 text-[12px] text-white/70 transition hover:bg-white/10 hover:text-white"
                            >
                              +90°
                            </button>
                          </div>
                          <p className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-white/30">
                            Crop
                          </p>
                          {/* Paired by axis (Top/Bottom, then Left/Right) — same "reads as one concept,
                              not two unrelated rows" reasoning Position's X/Y pairing above already
                              uses, and it halves how much this section adds to the scroll a phone-sized
                              Properties sheet already has plenty of. Each field keeps its own slider
                              (narrower now, but still a full drag target within its own half). */}
                          <div className="flex gap-3">
                            <div className="flex-1">
                              <NumberField
                                label="Top"
                                value={transform.crop.top}
                                suffix="%"
                                step={1}
                                min={0}
                                max={100}
                                compact
                                toDisplay={(v) => v * 100}
                                fromDisplay={(v) => v / 100}
                                onCommit={(v) => patchCrop(clip.id, { top: v })}
                              />
                            </div>
                            <div className="flex-1">
                              <NumberField
                                label="Bottom"
                                value={transform.crop.bottom}
                                suffix="%"
                                step={1}
                                min={0}
                                max={100}
                                compact
                                toDisplay={(v) => v * 100}
                                fromDisplay={(v) => v / 100}
                                onCommit={(v) => patchCrop(clip.id, { bottom: v })}
                              />
                            </div>
                          </div>
                          <div className="flex gap-3">
                            <div className="flex-1">
                              <NumberField
                                label="Left"
                                value={transform.crop.left}
                                suffix="%"
                                step={1}
                                min={0}
                                max={100}
                                compact
                                toDisplay={(v) => v * 100}
                                fromDisplay={(v) => v / 100}
                                onCommit={(v) => patchCrop(clip.id, { left: v })}
                              />
                            </div>
                            <div className="flex-1">
                              <NumberField
                                label="Right"
                                value={transform.crop.right}
                                suffix="%"
                                step={1}
                                min={0}
                                max={100}
                                compact
                                toDisplay={(v) => v * 100}
                                fromDisplay={(v) => v / 100}
                                onCommit={(v) => patchCrop(clip.id, { right: v })}
                              />
                            </div>
                          </div>
                          {clip.transform && (
                            <button
                              onClick={() => run(new SetClipTransformCommand(clip.id, IDENTITY_TRANSFORM))}
                              className="mt-2.5 w-full rounded bg-white/5 py-1.5 text-[12px] text-white/60 transition hover:bg-white/10 hover:text-white"
                            >
                              Reset transform
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
                {track.kind === "video" && asset?.kind === "video" && (
                  <CollapsibleSection
                    title="Remove Object"
                    accent="bg-teal-400"
                    open={!collapsed.has("Remove Object")}
                    onToggle={() => toggleSection("Remove Object")}
                  >
                    <RemoveObjectSection clipId={clip.id} assetName={asset.name} projectId={projectId} />
                  </CollapsibleSection>
                )}

                {/* Same video/image-only scope as Transform above (audio has nothing to color-adjust,
                    text has its own separate TextStyle system) — static per-clip values, not yet
                    animatable over the clip's duration (see ClipEffects's own doc comment for the
                    preview/export approximation notes on brightness/blur specifically). */}
                {track.kind === "video" && (
                  <CollapsibleSection
                    title="Effects"
                    accent="bg-amber-400"
                    open={!collapsed.has("Effects")}
                    onToggle={() => toggleSection("Effects")}
                  >
                    {(() => {
                      const effects = clip.effects ?? IDENTITY_EFFECTS;
                      return (
                        <>
                          <NumberField
                            label="Brightness"
                            value={effects.brightness}
                            suffix="%"
                            step={5}
                            min={-100}
                            max={100}
                            toDisplay={(v) => v * 100}
                            fromDisplay={(v) => v / 100}
                            onCommit={(v) => patchEffects(clip.id, { brightness: v })}
                          />
                          <NumberField
                            label="Contrast"
                            value={effects.contrast}
                            suffix="%"
                            step={5}
                            min={0}
                            max={200}
                            toDisplay={(v) => v * 100}
                            fromDisplay={(v) => v / 100}
                            onCommit={(v) => patchEffects(clip.id, { contrast: v })}
                          />
                          <NumberField
                            label="Saturation"
                            value={effects.saturation}
                            suffix="%"
                            step={5}
                            min={0}
                            max={200}
                            toDisplay={(v) => v * 100}
                            fromDisplay={(v) => v / 100}
                            onCommit={(v) => patchEffects(clip.id, { saturation: v })}
                          />
                          <NumberField
                            label="Blur"
                            value={effects.blur}
                            suffix="px"
                            step={1}
                            min={0}
                            max={20}
                            onCommit={(v) => patchEffects(clip.id, { blur: v })}
                          />
                          <NumberField
                            label="Opacity"
                            value={effects.opacity}
                            suffix="%"
                            step={5}
                            min={0}
                            max={100}
                            toDisplay={(v) => v * 100}
                            fromDisplay={(v) => v / 100}
                            onCommit={(v) => patchEffects(clip.id, { opacity: v })}
                          />
                          {clip.effects && (
                            <button
                              onClick={() => run(new SetClipEffectsCommand(clip.id, IDENTITY_EFFECTS))}
                              className="mt-2.5 w-full rounded bg-white/5 py-1.5 text-[12px] text-white/60 transition hover:bg-white/10 hover:text-white"
                            >
                              Reset effects
                            </button>
                          )}
                        </>
                      );
                    })()}
                  </CollapsibleSection>
                )}

                {/* Shown only when there's genuinely a preceding, zero-gap clip on this track to
                    crossfade FROM — `findTransitionCandidate` is the adjacency-only half of
                    `findTransitionPartner` (see its own doc comment), used here instead since a
                    disabled transition has no `transitionIn` yet for the full check to key off. */}
                {track.kind === "video" &&
                  (() => {
                    const candidate = findTransitionCandidate(track, clip);
                    if (!candidate) return null;
                    const transitionIn = clip.transitionIn;
                    return (
                      <CollapsibleSection
                        title="Transition In"
                        accent="bg-fuchsia-400"
                        open={!collapsed.has("Transition In")}
                        onToggle={() => toggleSection("Transition In")}
                      >
                        <label className="flex items-center justify-between gap-2 py-1.5 text-[12px] text-white/70">
                          <span>Crossfade from previous clip</span>
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
                          <NumberField
                            label="Duration"
                            value={transitionIn.duration}
                            suffix="s"
                            step={0.1}
                            onCommit={(v) => run(new SetClipTransitionCommand(clip.id, { ...transitionIn, duration: v }))}
                          />
                        )}
                      </CollapsibleSection>
                    );
                  })()}

                {/* Shown for any clip whose asset actually has audio to mute, on either a video or an
                    audio track — a video clip's own embedded sound and a music/voiceover clip are the
                    same kind of toggle, just living on different track kinds. */}
                {asset?.hasAudio && (
                  <CollapsibleSection
                    title="Audio"
                    accent="bg-rose-400"
                    open={!collapsed.has("Audio")}
                    onToggle={() => toggleSection("Audio")}
                  >
                    <label className="flex items-center justify-between gap-2 py-1.5 text-[12px] text-white/70">
                      <span>Mute clip</span>
                      <input
                        type="checkbox"
                              className="h-3.5 w-3.5 accent-sky-400"
                        checked={clip.mutedAudio ?? false}
                        onChange={(e) => run(new SetClipMutedCommand(clip.id, e.target.checked))}
                      />
                    </label>
                    {/* Independent of Mute above — see `Clip.gain`'s own doc comment on why the two
                        compose rather than one replacing the other. Capped at 100%, not a wider
                        amplification range: the preview plays back through a plain element's native
                        `.volume`, which the browser itself caps at 1. */}
                    <NumberField
                      label="Volume"
                      value={clip.gain ?? 1}
                      suffix="%"
                      step={5}
                      min={0}
                      max={100}
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
                  title="Details"
                  accent="bg-white/30"
                  open={!collapsed.has("Details")}
                  onToggle={() => toggleSection("Details")}
                >
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-white/30">Timeline</p>
                  <Row label="Start" value={formatTimecode(clip.timelineStart, fps)} />
                  <Row label="End" value={formatTimecode(clip.timelineStart + clipDuration(clip), fps)} />
                  <Row label="Duration" value={formatTimecode(clipDuration(clip), fps)} />

                  <p className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-white/30">Source</p>
                  <Row label="In" value={formatTimecode(clip.sourceIn, fps)} />
                  <Row label="Out" value={formatTimecode(clip.sourceOut, fps)} />
                  {asset && <Row label="Full length" value={formatTimecode(asset.duration, fps)} />}

                  {asset && (asset.width || asset.fps) && (
                    <>
                      <p className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-white/30">Media</p>
                      {asset.width && asset.height && <Row label="Size" value={`${asset.width}×${asset.height}`} />}
                      {asset.fps && <Row label="Rate" value={`${Math.round(asset.fps)} fps`} />}
                      <Row label="Audio" value={asset.hasAudio ? "Yes" : "No"} />
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
