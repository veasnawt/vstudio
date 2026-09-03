"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Ai,
  ArrowLeft,
  Art,
  ClosedCaption,
  Copy,
  Delete,
  Document,
  Filter,
  Gauge,
  Headphone,
  Save,
  Settings,
  Split,
  Text,
  Transition,
  Video,
  Volume,
} from "@veasnawt/vicons";
import { reportError } from "../api/crashLog.ts";
import { DeleteClipsCommand, SetClipTransitionCommand, SetClipTransitionOutCommand, SplitClipCommand } from "../commands/index.ts";
import { translateText } from "../i18n/translations.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { findAsset, findClip } from "../project/createProject.ts";
import { preloadAllFonts } from "../project/fonts.ts";
import { flushPendingSave, useEditorStore } from "../store/editorStore.ts";
import { clipAtTime } from "../timeline/queries.ts";
import { DEFAULT_TRANSITION } from "../timeline/transitions.ts";
import { AutoCaptionsDialog } from "./AutoCaptionsDialog.tsx";
import { ColorPickerMenu } from "./ColorPickerMenu.tsx";
import { EffectsPickerMenu } from "./EffectsPickerMenu.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { ExportDialog } from "./ExportDialog.tsx";
import { TextToClipsDialog } from "./TextToClipsDialog.tsx";
import { Inspector } from "./Inspector.tsx";
import { MediaLibrary } from "./MediaLibrary.tsx";
import { FloatablePanel, type FloatRect } from "./FloatablePanel.tsx";
import { MixerPanel } from "./MixerPanel.tsx";
import { PixelEffectPickerMenu } from "./PixelEffectPickerMenu.tsx";
import { addDragListeners, clientPoint, preventDefaultIfMouse } from "./pointerEvents.ts";
import { Preview } from "./Preview.tsx";
import { ScopesPanel } from "./ScopesPanel.tsx";
import { SfxPanel } from "./SfxPanel.tsx";
import { Timeline } from "./Timeline.tsx";
import { TransitionPickerMenu } from "./TransitionPickerMenu.tsx";
import { VoiceoverRecorder } from "./VoiceoverRecorder.tsx";

/** Bounds for the draggable Preview/Timeline divider — see `beginTimelineResize`. A fixed pixel
 *  floor for Timeline (below this a track row plus its ruler stops being useful) and a
 *  viewport-relative ceiling for Preview (a fixed pixel floor there would break on a short laptop —
 *  or phone — screen; unlike Timeline, Preview's minimum useful height scales with how much screen
 *  exists at all). */
const MIN_TIMELINE_HEIGHT = 120;
const MAX_TIMELINE_HEIGHT_RATIO = 0.75;

/** Approx combined height of the fixed header + footer rows that sit outside the Preview/Timeline
 *  grid — what's left of `window.innerHeight` after this is the real budget the grid has to split.
 *  Footer grew from ~44px to ~52px when toolbar buttons gained a label under each icon (h-8→h-10). */
const CHROME_HEIGHT = 93;
/** Preview's floor: short of this, a letterboxed frame stops reading as an image at all. Used to
 *  derive how much Timeline is allowed to claim on a short viewport — see `timelineHeight`'s comment
 *  in `VCutApp` for why this replaced an earlier, looser ratio-of-viewport attempt. */
const MIN_PREVIEW_HEIGHT = 120;

/** Shrinks `height` only as far as needed to guarantee Preview keeps `MIN_PREVIEW_HEIGHT`, given how
 *  much total vertical space actually exists — never grows it. Shared by the initial seed (so a page
 *  freshly loaded in landscape never renders the broken state to begin with) and the resize listener
 *  (so rotating mid-session reaches the same safe result). */
function clampTimelineHeight(height: number, viewportHeight: number): number {
  const maxForPreview = viewportHeight - CHROME_HEIGHT - MIN_PREVIEW_HEIGHT;
  return Math.max(MIN_TIMELINE_HEIGHT, Math.min(height, Math.max(MIN_TIMELINE_HEIGHT, maxForPreview)));
}

/** Same floor/ceiling shape as `MIN_TIMELINE_HEIGHT`/`clampTimelineHeight`, along the horizontal axis
 *  for Media/Properties instead — a fixed pixel floor per side panel (below this its own content, a
 *  media grid or a Properties field's label+input+suffix row, starts wrapping badly) and Preview kept
 *  to at least `MIN_PREVIEW_WIDTH` between whichever two widths (this panel's, and the OTHER side
 *  panel's current width) are currently competing for the same viewport. */
const MIN_SIDE_PANEL_WIDTH = 180;
const MIN_PREVIEW_WIDTH = 320;

function clampSideWidth(width: number, otherSideWidth: number, viewportWidth: number): number {
  const maxForPreview = viewportWidth - otherSideWidth - MIN_PREVIEW_WIDTH;
  return Math.max(MIN_SIDE_PANEL_WIDTH, Math.min(width, Math.max(MIN_SIDE_PANEL_WIDTH, maxForPreview)));
}

/** Input types that accept typed text. Everything else — file, button, checkbox, radio, range — can
 *  hold focus without swallowing a keystroke, so shortcuts must keep working while they're focused.
 *  Getting this wrong is easy to miss: clicking "Import" leaves focus on a file input, and treating
 *  that as "the user is typing" silently kills every shortcut until they click elsewhere. */
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number", "date", "time"]);
/** Types whose own arrow-key handling would otherwise fight a global shortcut bound to the same key —
 *  `range` specifically, since Left/Right (and Up/Down) are its native way to nudge a value, exactly
 *  the same keys `stepFrames` is bound to. Distinct from `TEXT_INPUT_TYPES`: a range input doesn't
 *  accept typed text, so it can't trip the "typing" checks elsewhere, but it still needs arrow keys
 *  reserved for itself while focused. */
const ARROW_KEY_INPUT_TYPES = new Set(["range"]);

/** Whether a keystroke is being typed into something, in which case editor shortcuts must not fire —
 *  otherwise pressing "s" in the media search box would split a clip. Also true for a focused range
 *  slider (Effects/Crop) specifically for arrow keys — see `ARROW_KEY_INPUT_TYPES` — so nudging a
 *  slider with the keyboard doesn't ALSO step the playhead one frame per press. */
function isTypingTarget(target: EventTarget | null, key?: string): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === "TEXTAREA" || target.tagName === "SELECT") return true;
  if (target instanceof HTMLInputElement) {
    // An input with no explicit type defaults to "text".
    const type = target.type || "text";
    if (TEXT_INPUT_TYPES.has(type)) return true;
    if (ARROW_KEY_INPUT_TYPES.has(type) && key?.startsWith("Arrow")) return true;
  }
  return false;
}

/** Splits the selected clip, or whatever sits under the playhead when nothing is selected — shared
 *  between the global "S" shortcut and the toolbar's Split button so the two can never drift apart.
 *  A plain function (not a hook) reading `getState()` directly, so it's callable from an imperative
 *  keydown handler exactly as easily as from a button's onClick. */
function splitAtPlayhead() {
  const state = useEditorStore.getState();
  const current = state.project;
  if (!current) return;
  const selectedId = state.selectedClipIds[0];
  const target = selectedId
    ? findClip(current, selectedId)?.clip
    : current.sequence.tracks
        .filter((t) => t.kind === "video" && !t.locked)
        .map((t) => clipAtTime(t, state.playhead))
        .find(Boolean);
  if (!target) return state.setStatus(translateText(state.language, "Put the playhead over a clip to split it"), "error");
  state.run(new SplitClipCommand(target.id, state.playhead));
}

/** One toolbar icon, disabled state, an optional highlighted "active" state (used by toggles like
 *  Transition, where the button itself IS the on/off indicator), and a `title` that doubles as the
 *  tooltip AND the keyboard-shortcut hint the old plain-text status bar used to show permanently.
 *  `label` is a SHORT caption rendered under the icon (not a substitute for `title` — the shortcut
 *  hint only shows up on hover/long-press, the label is what makes each icon identifiable without
 *  either) — a phone user can't hover to discover what an icon-only button does the way a mouse user
 *  can, and even for a mouse this row's icons (Split/Delete/Save/Text/Transition/Media/Properties)
 *  aren't universally self-explanatory the way Play/Pause are. */
const ToolbarButton = React.forwardRef<
  HTMLButtonElement,
  {
    onClick: () => void;
    disabled?: boolean;
    active?: boolean;
    title: string;
    label: string;
    className?: string;
    children: React.ReactNode;
  }
>(function ToolbarButton({ onClick, disabled, active, title, label, className = "", children }, ref) {
  return (
    <button
      ref={ref}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`flex h-10 min-w-11 shrink-0 flex-col items-center justify-center gap-0.5 rounded px-1 leading-none transition disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent ${
        active
          ? "bg-sky-500/30 text-white hover:bg-sky-500/40"
          : "text-white/70 hover:bg-white/10 hover:text-white disabled:hover:text-white/70"
      } ${className}`}
    >
      {children}
      <span className="max-w-full truncate text-[9px] font-medium">{label}</span>
    </button>
  );
});

function StatusBar({
  mobileSheet,
  setMobileSheet,
  bottomPanel,
  setBottomPanel,
  floatingPanel,
  onDockFloating,
}: {
  mobileSheet: "media" | "inspector" | null;
  setMobileSheet: (next: "media" | "inspector" | null) => void;
  bottomPanel: "timeline" | "mixer" | "scopes";
  setBottomPanel: (next: "timeline" | "mixer" | "scopes") => void;
  /** Which of Mixer/Scopes (if either) is currently popped out into its own floating window — see
   *  `VCutApp.tsx`'s own `floatState` comment. Drives these two buttons' `active` look (a floating
   *  panel still reads as "open", just not docked) and what tapping one while it's floating does. */
  floatingPanel: "mixer" | "scopes" | null;
  onDockFloating: () => void;
}) {
  const setStatus = useEditorStore((s) => s.setStatus);
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds);
  const run = useEditorStore((s) => s.run);
  const save = useEditorStore((s) => s.save);
  const addTextAtPlayhead = useEditorStore((s) => s.addTextAtPlayhead);
  const addColorAtPlayhead = useEditorStore((s) => s.addColorAtPlayhead);
  const duplicateSelectedClips = useEditorStore((s) => s.duplicateSelectedClips);
  const project = useEditorStore((s) => s.project);
  const projectId = useEditorStore((s) => s.projectId);
  const t = useTranslation();
  const [showCaptions, setShowCaptions] = useState(false);
  const [showTextImport, setShowTextImport] = useState(false);
  const [showTransitionMenu, setShowTransitionMenu] = useState(false);
  const [showColorMenu, setShowColorMenu] = useState(false);
  const [showEffectsMenu, setShowEffectsMenu] = useState(false);
  const [showPixelEffectMenu, setShowPixelEffectMenu] = useState(false);
  const [showSfx, setShowSfx] = useState(false);
  const transitionButtonRef = useRef<HTMLButtonElement>(null);
  const colorButtonRef = useRef<HTMLButtonElement>(null);
  const effectsButtonRef = useRef<HTMLButtonElement>(null);
  const pixelEffectButtonRef = useRef<HTMLButtonElement>(null);
  // Whether the scrollable tool row (below) is scrolled away from its own left edge — drives the
  // Media/Properties cluster's auto-hide (see its own comment for why). `> 4`, not `> 0`: a bounce/
  // rubber-band scroll on iOS Safari can report a few stray sub-pixel values at rest, which would
  // otherwise flicker the collapse in and out right at the resting position.
  const [toolsScrolled, setToolsScrolled] = useState(false);

  // Drives the Transition button's active/disabled look, and what `TransitionPickerMenu` (opened by
  // that button) applies to and highlights as currently selected. Enabled for ANY video/text clip now,
  // not just one with a genuinely adjacent predecessor — `findTransitionPartner` resolves a clip with
  // no eligible neighbor into a solo fade (from black for video, from transparent for text) rather than
  // refusing to apply at all, so there's no longer a real reason to gate the button on adjacency.
  const selectedId = selectedClipIds[0];
  const foundForTransition = project && selectedId ? findClip(project, selectedId) : undefined;
  const transitionActive = Boolean(foundForTransition?.clip.transitionIn || foundForTransition?.clip.transitionOut);
  const transitionDisabled = !foundForTransition || (foundForTransition.track.kind !== "video" && foundForTransition.track.kind !== "text");

  // Effects/Pixel Effects — video-track clips only (video/image/color-matte), same gating `ClipEffects`/
  // `pixelEffect`'s own doc comments give; a text/audio clip has neither. Reuses `foundForTransition`'s
  // already-resolved clip/track rather than a second `findClip` lookup for the same selection.
  const foundForVideoEffects = foundForTransition && foundForTransition.track.kind === "video" ? foundForTransition : undefined;
  const effectsDisabled = !foundForVideoEffects;
  const effectsActive = Boolean(foundForVideoEffects?.clip.effects);
  const pixelEffectActive = Boolean(foundForVideoEffects?.clip.pixelEffect);
  const assetForVideoEffects = project && foundForVideoEffects ? findAsset(project, foundForVideoEffects.clip.assetId) : undefined;

  return (
    <footer className="flex shrink-0 items-center gap-1 border-t border-white/10 bg-[#0d0f14] px-2 py-1.5 text-[11px]">
      {/* Icons only now — the status message and save-state text that used to share this row moved to
          a floating toast (`StatusToast`) and the header (`SaveStatus`) respectively. This row was
          already the tightest space in the whole editor (up to 11 icons, some already pushed into
          horizontal overflow scroll on a phone — see the comment below), and neither of those two
          pieces of text is something a user is trying to TAP; keeping them here only ever cost this
          row space without adding anything reachable. Below `lg`, Media/Properties have no permanent
          side column anymore (see VCutApp's own comment on `mobileSheet`) — this is where they're
          reached instead, which pushed the button count past what a phone's width can show without
          scrolling; `scrollbar-none` matches Timeline's own horizontal scrollbar treatment. */}
      {/* Media/Properties, mobile-only — sits at the row's LEFT edge, ahead of the scrollable tool row,
          and auto-collapses (width/opacity transition, not unmounted — `toolsScrolled` just tracks the
          tool row's own `scrollLeft`) the instant that row is scrolled away from its start, reappearing
          the moment it's scrolled back. Media/Properties are the two a mobile user reaches for
          constantly (they're the ONLY way in to either panel below `lg` — see `mobileSheet`'s own
          comment), so they stay right there at rest — but the tool row alone already needs horizontal
          scrolling to show every tool (see that row's own comment), and permanently reserving space for
          this cluster while actively scrolling through Split/Transition/Effects/etc. just eats into the
          same cramped width without being reachable mid-scroll anyway. Desktop keeps its permanent side
          columns (see VCutApp's grid) and never sets `mobileSheet`, so this stays irrelevant there
          regardless of `lg:hidden`. Toggling: tapping the already-open one returns to Timeline, matching
          `active`'s highlighted state always reflecting what's actually showing below. */}
      <div
        className={`flex shrink-0 items-center gap-0.5 overflow-hidden border-r border-white/10 pr-1 transition-all duration-200 ease-out lg:hidden ${
          toolsScrolled ? "max-w-0 border-r-0 pr-0 opacity-0" : "max-w-[120px] opacity-100"
        }`}
      >
        <ToolbarButton
          title={t("Media")}
          label={t("Media")}
          active={mobileSheet === "media"}
          onClick={() => setMobileSheet(mobileSheet === "media" ? null : "media")}
        >
          <Video size={18} />
        </ToolbarButton>
        <ToolbarButton
          title={t("Properties")}
          label={t("Properties")}
          active={mobileSheet === "inspector"}
          onClick={() => setMobileSheet(mobileSheet === "inspector" ? null : "inspector")}
        >
          <Settings size={18} />
        </ToolbarButton>
      </div>

      <div
        className="scrollbar-none flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        onScroll={(e) => setToolsScrolled(e.currentTarget.scrollLeft > 4)}
      >
        {/* Workflow order, left to right: ADD content first (what you reach for to put something new
            on the timeline), then STRUCTURAL edits (reshaping what's already there), then
            destructive/save actions last (Delete right before Save specifically — "remove, then commit
            the result" is the natural order those two get used in together, and it keeps the one
            irreversible-feeling action away from the row's own leading edge, where a stray tap/click
            during a fast workflow is most likely to land). */}

        {/* Text and voiceover recording: moved here from the Media panel so both land straight on the
            timeline (and so in the preview) the instant they're created, rather than sitting as a
            library-only asset waiting for a separate double-click/drag to place. */}
        <ToolbarButton title={t("Add text")} label={t("Text")} onClick={addTextAtPlayhead}>
          <Text size={18} />
        </ToolbarButton>
        <VoiceoverRecorder />
        <ToolbarButton title={t("Import Text as Clips")} label={t("Script")} onClick={() => setShowTextImport(true)}>
          <Document size={18} />
        </ToolbarButton>
        <ToolbarButton title={t("Auto Captions")} label={t("Captions")} onClick={() => setShowCaptions(true)}>
          <ClosedCaption size={18} />
        </ToolbarButton>
        <ToolbarButton title={t("Sound Effects")} label={t("SFX")} onClick={() => setShowSfx(true)}>
          <Headphone size={18} />
        </ToolbarButton>
        <ToolbarButton
          ref={colorButtonRef}
          title={t("Add a color background")}
          label={t("Color")}
          active={showColorMenu}
          onClick={() => setShowColorMenu((v) => !v)}
        >
          <Art size={18} />
        </ToolbarButton>
        {showColorMenu && (
          <ColorPickerMenu
            anchorRef={colorButtonRef}
            onPick={(color) => addColorAtPlayhead(color)}
            onClose={() => setShowColorMenu(false)}
          />
        )}
        <ToolbarButton
          title={t("Audio Mixer")}
          label={t("Mixer")}
          active={bottomPanel === "mixer" || floatingPanel === "mixer"}
          onClick={() => {
            if (floatingPanel === "mixer") {
              onDockFloating();
              setBottomPanel("mixer");
            } else {
              setBottomPanel(bottomPanel === "mixer" ? "timeline" : "mixer");
            }
          }}
        >
          <Volume size={18} />
        </ToolbarButton>
        <ToolbarButton
          title={t("Scopes")}
          label={t("Scopes")}
          active={bottomPanel === "scopes" || floatingPanel === "scopes"}
          onClick={() => {
            if (floatingPanel === "scopes") {
              onDockFloating();
              setBottomPanel("scopes");
            } else {
              setBottomPanel(bottomPanel === "scopes" ? "timeline" : "scopes");
            }
          }}
        >
          <Gauge size={18} />
        </ToolbarButton>

        <span className="mx-1 h-5 w-px shrink-0 bg-white/10" />

        <ToolbarButton title={t("Split at playhead (S)")} label={t("Split")} onClick={splitAtPlayhead}>
          <Split size={18} />
        </ToolbarButton>
        <ToolbarButton
          title={t("Duplicate selected (Ctrl+D)")}
          label={t("Duplicate")}
          disabled={selectedClipIds.length === 0}
          onClick={duplicateSelectedClips}
        >
          <Copy size={18} />
        </ToolbarButton>

        {/* Opens a grid of every transition style, each tile a live animated preview
            (`TransitionPickerMenu`), with an In/Out tab switch covering both `transitionIn` and
            `transitionOut` — the Inspector's own "Transition In"/"Transition Out" sections (the same
            underlying `SetClipTransitionCommand`/`SetClipTransitionOutCommand`) are still where each
            direction's duration gets fine-tuned afterward. */}
        <ToolbarButton
          ref={transitionButtonRef}
          title={transitionActive ? t("Change or remove transition") : t("Choose a transition")}
          label={t("Transition")}
          disabled={transitionDisabled}
          active={transitionActive}
          onClick={() => setShowTransitionMenu((v) => !v)}
        >
          <Transition size={18} />
        </ToolbarButton>
        {showTransitionMenu && foundForTransition && (
          <TransitionPickerMenu
            anchorRef={transitionButtonRef}
            isAudioTrack={foundForTransition.track.kind === "audio"}
            isTextTrack={foundForTransition.track.kind === "text"}
            activeIn={foundForTransition.clip.transitionIn?.type ?? null}
            activeOut={foundForTransition.clip.transitionOut?.type ?? null}
            onChangeIn={(type) => {
              if (!type) {
                run(new SetClipTransitionCommand(foundForTransition.clip.id, null));
                return;
              }
              const duration = foundForTransition.clip.transitionIn?.duration ?? DEFAULT_TRANSITION.duration;
              run(new SetClipTransitionCommand(foundForTransition.clip.id, { duration, type }));
            }}
            onChangeOut={(type) => {
              if (!type) {
                run(new SetClipTransitionOutCommand(foundForTransition.clip.id, null));
                return;
              }
              const duration = foundForTransition.clip.transitionOut?.duration ?? DEFAULT_TRANSITION.duration;
              run(new SetClipTransitionOutCommand(foundForTransition.clip.id, { duration, type }));
            }}
            onClose={() => setShowTransitionMenu(false)}
          />
        )}

        {/* Quick-pick popovers over the selected clip's own Effects/Pixel Effects — the Inspector's
            Effects section still has the full brightness/contrast/saturation/blur/opacity sliders for
            fine-tuning afterward; these are the fast, preset-driven path, same split
            `EffectsPickerMenu`/`PixelEffectPickerMenu`'s own doc comments describe. */}
        <ToolbarButton
          ref={effectsButtonRef}
          title={t("Effects")}
          label={t("Effects")}
          disabled={effectsDisabled}
          active={effectsActive}
          onClick={() => setShowEffectsMenu((v) => !v)}
        >
          <Filter size={18} />
        </ToolbarButton>
        {showEffectsMenu && foundForVideoEffects && (
          <EffectsPickerMenu
            anchorRef={effectsButtonRef}
            clip={foundForVideoEffects.clip}
            asset={assetForVideoEffects}
            projectId={projectId}
            onClose={() => setShowEffectsMenu(false)}
          />
        )}
        <ToolbarButton
          ref={pixelEffectButtonRef}
          title={t("Pixel Effects")}
          label={t("Pixel FX")}
          disabled={effectsDisabled}
          active={pixelEffectActive}
          onClick={() => setShowPixelEffectMenu((v) => !v)}
        >
          <Ai size={18} />
        </ToolbarButton>
        {showPixelEffectMenu && foundForVideoEffects && (
          <PixelEffectPickerMenu
            anchorRef={pixelEffectButtonRef}
            clip={foundForVideoEffects.clip}
            asset={assetForVideoEffects}
            projectId={projectId}
            onClose={() => setShowPixelEffectMenu(false)}
          />
        )}

        <span className="mx-1 h-5 w-px shrink-0 bg-white/10" />

        <ToolbarButton
          title={t("Delete selected (Del)")}
          label={t("Delete")}
          disabled={selectedClipIds.length === 0}
          onClick={() => run(new DeleteClipsCommand(selectedClipIds))}
        >
          <Delete size={18} />
        </ToolbarButton>
        <ToolbarButton
          title={t("Save (Ctrl+S)")}
          label={t("Save")}
          onClick={() => {
            void save();
            setStatus(t("Project saved"));
          }}
        >
          <Save size={18} />
        </ToolbarButton>
      </div>
      {showCaptions && <AutoCaptionsDialog onClose={() => setShowCaptions(false)} />}
      {showTextImport && <TextToClipsDialog onClose={() => setShowTextImport(false)} />}
      {showSfx && <SfxPanel onClose={() => setShowSfx(false)} />}
    </footer>
  );
}

/** Persistent save-state indicator — "Saving…" / "Unsaved changes" / "All changes saved" — moved into
 *  the header (see VCutApp's own JSX) out of the toolbar footer, which had no room to spare for
 *  text that isn't a button. The header has exactly three other things in it (the "VCut" wordmark,
 *  the project title, the Export button), so this is genuinely uncrowded space by comparison. */
function SaveStatus() {
  const dirty = useEditorStore((s) => s.dirty);
  const saving = useEditorStore((s) => s.saving);
  const lastSavedAt = useEditorStore((s) => s.lastSavedAt);
  const t = useTranslation();

  const text = saving ? t("Saving…") : dirty ? t("Unsaved changes") : lastSavedAt ? t("All changes saved") : "";
  if (!text) return null;

  return <span className="shrink-0 truncate text-[11px] text-white/40">{text}</span>;
}

/** Transient status/error messages — used to share the toolbar footer with the icon buttons, where
 *  they were squeezed to `max-w-[40vw]` and truncated on top of an already-tight row. A floating toast
 *  instead: full width to breathe, doesn't cost the toolbar a single pixel of its own layout, and (via
 *  `createPortal`) is immune to the same "an ancestor with `transform` becomes a `position: fixed`
 *  descendant's containing block" gotcha `ConfirmDialog` already documents its own portal for — nothing
 *  here currently applies a transform, but nothing guarantees a future ancestor won't either. */
function StatusToast() {
  const status = useEditorStore((s) => s.status);
  const setStatus = useEditorStore((s) => s.setStatus);

  // Every status eventually clears itself — errors just get longer on screen (6s vs. 3s) since one
  // the user blinked and missed is worse than a transient success message would be, but "longer" is
  // not "forever": an error nobody ever replaces with a new status (the common case — most edits
  // never fail again right after one does) used to sit there indefinitely with no way to close it.
  // The manual dismiss button below is the other half of the actual fix — even 6s can be too eager to
  // read a longer message, so closing it shouldn't require waiting out a timer either.
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), status.tone === "error" ? 6000 : 3000);
    return () => clearTimeout(timer);
  }, [status, setStatus]);

  if (!status) return null;

  return createPortal(
    <div
      aria-live="polite"
      role={status.tone === "error" ? "alert" : "status"}
      // `bottom-16` clears the footer toolbar (icon+label buttons are 40px tall plus padding, ~52px
      // total, now that labels were added below each icon) so the toast sits just above it rather than
      // covering the very buttons a user might want to react with. `pointer-events-none` on the
      // wrapper + `-auto` on the pill itself: the empty space around the centered pill must stay
      // click-through (it spans the full width so the pill can center in it), but the pill itself
      // stays interactive for the dismiss button below.
      className="pointer-events-none fixed inset-x-0 bottom-16 z-40 flex justify-center px-4"
    >
      <div
        className={`pointer-events-auto flex max-w-[90vw] items-center gap-2 rounded-md py-1.5 pl-3 pr-1.5 text-xs shadow-lg ${
          status.tone === "error" ? "bg-rose-500/95 text-white" : "border border-white/10 bg-[#181b22] text-white/80"
        }`}
      >
        <span className="truncate">{status.message}</span>
        <button
          onClick={() => setStatus(null)}
          aria-label="Dismiss"
          className={`shrink-0 rounded p-0.5 leading-none transition ${
            status.tone === "error" ? "text-white/70 hover:bg-white/15 hover:text-white" : "text-white/40 hover:bg-white/10 hover:text-white/80"
          }`}
        >
          ✕
        </button>
      </div>
    </div>,
    document.body
  );
}

/** Click-to-rename project title, sitting in the header next to "VCut". `project.name` (not the
 *  `projectName` prop a host app like BP Studio passes in) is the only thing this reads or writes —
 *  that prop only ever SEEDS `project.name` at creation time (see `load`'s own comment), so once a
 *  project exists its name lives entirely in the project itself, and a rename here is exactly as
 *  durable/visible as any other edit (autosaved, and reflected back in VCut's own project list). */
function EditableProjectTitle() {
  const name = useEditorStore((s) => s.project?.name ?? "");
  const renameProject = useEditorStore((s) => s.renameProject);
  const t = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  // Set right before an Escape-triggered exit, so the `onBlur` that follows (removing the input from
  // the DOM mid-focus fires one) knows to discard rather than commit — Escape means "cancel", not
  // "save whatever's currently typed". Same pattern TextTransformHandles.tsx uses for its own inline
  // text editor.
  const skipCommitRef = useRef(false);

  function startEditing() {
    setDraft(name);
    setEditing(true);
  }

  function commit() {
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      return;
    }
    setEditing(false);
    renameProject(draft);
  }

  if (editing) {
    return (
      <input
        ref={(el) => el?.focus()}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            skipCommitRef.current = true;
            setEditing(false);
          }
          // Enter commits, matching a single-line "done typing" expectation — a plain text input has
          // no newline to worry about swallowing the way the tap-to-edit text-clip textarea does.
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        aria-label={t("Project name")}
        className="min-w-0 max-w-[240px] flex-1 rounded bg-white/10 px-1.5 py-0.5 text-xs text-white outline-none ring-1 ring-sky-400/60"
      />
    );
  }

  return (
    <button
      onClick={startEditing}
      title={t("Rename project")}
      aria-label={t("Rename project")}
      className="min-w-0 max-w-[240px] flex-1 truncate rounded px-1.5 py-0.5 text-left text-xs text-white/35 transition hover:bg-white/10 hover:text-white/70"
    >
      {name}
    </button>
  );
}

interface VCutAppProps {
  projectId: string;
  projectName?: string;
  // Optional: a host-embedded editor (BP Studio's `<iframe>`, today) has no "VCut project list" of
  // its own to go back to, so VCutApp itself stays agnostic about whether one exists rather than
  // assuming "/" is always a valid place to send the user — see `edit/page.tsx`'s own comment on how
  // it decides whether to pass this.
  onHome?: () => void;
}

function VCutAppInner({ projectId, projectName, onHome }: VCutAppProps) {
  const load = useEditorStore((s) => s.load);
  const loading = useEditorStore((s) => s.loading);
  const loadError = useEditorStore((s) => s.loadError);
  const project = useEditorStore((s) => s.project);
  const language = useEditorStore((s) => s.language);
  const setLanguage = useEditorStore((s) => s.setLanguage);
  const t = useTranslation();
  const [exportOpen, setExportOpen] = useState(false);

  // Warms every registered font's real `@font-face` fetch up front — see `preloadAllFonts`'s own
  // doc comment for why this is necessary at all (Canvas-only text rendering doesn't reliably trigger
  // a font's fetch on its own the way a DOM element with real CSS would). Mount-only: the module-scope
  // `preloadedFontIds` set inside `fonts.ts` already makes repeat calls (from here on every remount,
  // or from a hovered/selected font in the Inspector's picker) cheap no-ops regardless.
  useEffect(() => {
    preloadAllFonts();
  }, []);

  // Catches errors OUTSIDE React's own render cycle — `ErrorBoundary` (wrapping this whole component,
  // see `VCutApp`'s own export below) only ever sees throws during render; an error inside an event
  // handler, a `setTimeout`/async callback, or `PlaybackEngine`'s own imperative (non-React) code
  // reaches here instead. Routed through the same `reportError` the boundary uses, so both land in the
  // same crash log regardless of which path caught them.
  useEffect(() => {
    function onError(event: ErrorEvent) {
      reportError("window-error", event.error ?? event.message);
    }
    function onRejection(event: PromiseRejectionEvent) {
      reportError("unhandled-rejection", event.reason);
    }
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  // Below the `lg` breakpoint there's no permanent Media/Inspector column at all (240px + 260px of
  // fixed side columns doesn't fit next to a preview that still needs to show a legible frame) —
  // instead, the toolbar's Media/Properties buttons (see StatusBar) swap the Timeline row's own
  // content for one of these two, full-width, until toggled back. `null` means "show Timeline",
  // which is also what this always stays at `lg`+ (those toolbar buttons are `lg:hidden`, so nothing
  // ever sets it there). Confirmed with the user: the earlier tab-bar-plus-shared-row design (Media
  // and Properties each getting a permanently docked, always-partially-visible slot below Preview)
  // read as too busy and too easy to mis-tap on a real phone — this replaces it entirely rather than
  // adding a third mobile layout mode alongside it.
  //
  // Lives in `useEditorStore` (not a plain local `useState` here) specifically so `TimelineClip`'s own
  // double-tap-a-clip-to-edit gesture can open Properties from deep inside the Timeline tree — see
  // `EditorState.mobileSheet`'s own doc comment for the full reasoning.
  const mobileSheet = useEditorStore((s) => s.mobileSheet);
  const setMobileSheet = useEditorStore((s) => s.setMobileSheet);

  // Independent of `mobileSheet` above — that one is deliberately the mobile-only "borrow the bottom
  // row because there's no side column to put this in" concept (see its own comment). This decides
  // what the SAME row shows at every breakpoint whenever `mobileSheet` isn't itself active: "timeline"
  // (the default) or "mixer" (toggled from the always-visible Mixer toolbar button in `StatusBar`,
  // replacing the track lanes with a row of channel strips — the DaVinci-Resolve-Fairlight-page
  // pattern, not a new grid column). A literal union rather than a boolean in case a future third
  // bottom-panel mode is ever added.
  const [bottomPanel, setBottomPanel] = useState<"timeline" | "mixer" | "scopes">("timeline");

  // Which of Mixer/Scopes (if either) is popped out into its own `FloatablePanel` window instead of
  // docked in the bottom row — `null` means neither is floating (the normal, default state). Only ONE
  // can float at a time in v1 (a second `beginFloat` call while one is already floating just replaces
  // it) — real screen-space-competing floating windows (drag/resize/z-order between several) is real
  // extra machinery this defers, matching `FloatablePanel.tsx`'s own "currently Mixer/Scopes" doc
  // comment. `rect` is fully owned here (passed down as `FloatablePanel`'s own controlled prop) so a
  // dock/re-float cycle doesn't need to remember where the window was last time — it just reseeds a
  // sensible default position near the top-right, clear of the Preview/Timeline the docked panel would
  // otherwise occupy.
  const [floatState, setFloatState] = useState<{ panel: "mixer" | "scopes"; rect: FloatRect } | null>(null);

  function beginFloat(panel: "mixer" | "scopes") {
    setFloatState({ panel, rect: { x: Math.max(8, window.innerWidth - 428), y: 80, width: 400, height: 320 } });
    // The panel is now shown in its OWN floating window — leaving it also selected as the docked
    // `bottomPanel` would render it twice (once floating, once still occupying the Timeline's own
    // row) and silently fall back to Timeline there instead, matching what tapping the SAME toolbar
    // button again already does.
    setBottomPanel((current) => (current === panel ? "timeline" : current));
  }

  function dockPanel() {
    setFloatState(null);
  }

  // Lets the user trade vertical space between Preview (clearer to look at, bigger) and Timeline
  // (more clips/tracks visible at once) via a draggable divider, on every breakpoint. Seeded
  // per-breakpoint, NOT one shared default: desktop's roomy 320px starting point squeezed Preview's
  // row down to a sliver on a short phone the instant it was reused as mobile's default too —
  // confirmed live, the transport bar's own real content then overflowed its row.
  //
  // The per-breakpoint preferred value alone isn't enough, though: it's keyed on `min-width`, which
  // tracks portrait-vs-landscape only by accident. A phone rotated to landscape is still under the
  // 1024px width breakpoint (so gets mobile's 224px preferred height) but only has ~390px of height
  // to begin with — 224px of that going to Timeline left Preview a sliver too short to show anything
  // (confirmed live: the canvas rendered a few px tall, effectively invisible). `clampTimelineHeight`
  // encodes the actual invariant directly — Preview keeps at least `MIN_PREVIEW_HEIGHT` — rather than
  // an indirect ratio of the viewport, which is what the first version of this fix used and got
  // wrong: it reused `MAX_TIMELINE_HEIGHT_RATIO` (a generous 75%, meant for how far a user's own
  // manual drag is allowed to go) for automatic reflow too, so re-rotating portrait's already-small
  // 224px default against a 390px-tall landscape viewport passed that loose check and never shrank.
  //
  // Starts at the plain 224px fallback UNCONDITIONALLY — not a `typeof window === "undefined"` branch
  // in the initializer, which used to read the real `window.innerHeight`/`matchMedia` on the client
  // but not on the server: since the very first CLIENT render (during hydration) ran that same
  // initializer before any effect could run, it was already computing a DIFFERENT number than the
  // server had rendered, tripping a hydration mismatch on every load where the real viewport didn't
  // happen to clamp to exactly 224. `useLayoutEffect` below corrects it to the real per-breakpoint
  // value SYNCHRONOUSLY after mount, before the browser paints — client-only by nature (effects never
  // run during SSR), so the server/first-client-render pair stays byte-for-byte identical, and the
  // correction lands before the user ever sees the placeholder 224px.
  const [timelineHeight, setTimelineHeight] = useState(224);

  useLayoutEffect(() => {
    const preferred = window.matchMedia("(min-width: 1024px)").matches ? 320 : 224;
    setTimelineHeight(clampTimelineHeight(preferred, window.innerHeight));
  }, []);

  // Re-clamps on resize/rotation — the mount effect above only runs once, so rotating a phone
  // mid-session (portrait, where 224px comfortably fits, to landscape, where it doesn't) would
  // otherwise reproduce the exact same squeeze the mount effect fixes for a fresh landscape load. Only
  // ever clamps DOWN (`clampTimelineHeight` never returns more than its input), so it never overrides
  // a height the user deliberately chose via `beginTimelineResize` unless the viewport genuinely no
  // longer fits it.
  useEffect(() => {
    function onResize() {
      setTimelineHeight((h) => clampTimelineHeight(h, window.innerHeight));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function beginTimelineResize(startEvent: React.MouseEvent | React.TouchEvent) {
    preventDefaultIfMouse(startEvent);
    const start = clientPoint(startEvent);
    const startTimelineHeight = timelineHeight;
    const removeListeners = addDragListeners(
      (moveEvent) => {
        const point = clientPoint(moveEvent);
        // Dragging UP (pointer above the start point) grows the timeline — the divider sits ABOVE it,
        // so moving it toward the top of the screen makes the row below it taller, matching the
        // direction every other "drag this edge to resize" control in a video editor uses. One shared
        // formula for every breakpoint now: mobile no longer has a second row (Media/Properties'
        // shared panel) competing for the same budget, so there's nothing left to jointly clamp
        // against — Preview is just `minmax(0,1fr)`, same as desktop.
        const dy = start.y - point.y;
        setTimelineHeight(Math.min(window.innerHeight * MAX_TIMELINE_HEIGHT_RATIO, Math.max(MIN_TIMELINE_HEIGHT, startTimelineHeight + dy)));
      },
      () => removeListeners()
    );
  }

  // Media/Properties column widths — `lg`+ only, same fixed-panel-vs-flexible-Preview shape
  // `timelineHeight` already established for the horizontal divider, just along the other axis. Seeded
  // to the pixel values these two columns used before either was resizable (240px/260px), UNCONDITIONALLY
  // — same reasoning as `timelineHeight`'s own initializer comment above: reading `window.innerWidth`
  // right here would make the client's own first render disagree with the server's, not just the
  // server-vs-nothing case a `typeof window` guard alone protects against. The `useLayoutEffect` below
  // corrects both to their real clamped values synchronously after mount, before paint.
  const [mediaWidth, setMediaWidth] = useState(240);
  const [propertiesWidth, setPropertiesWidth] = useState(260);
  // Read inside the resize-listener effect below, which (like `timelineHeight`'s own) stays mount-only
  // (`[]` deps) — a ref is what lets it see each width's LATEST value without re-subscribing the
  // `resize` listener on every drag pixel the way depending on the state directly would.
  const mediaWidthRef = useRef(mediaWidth);
  mediaWidthRef.current = mediaWidth;
  const propertiesWidthRef = useRef(propertiesWidth);
  propertiesWidthRef.current = propertiesWidth;

  useLayoutEffect(() => {
    setMediaWidth(clampSideWidth(240, 260, window.innerWidth));
    setPropertiesWidth(clampSideWidth(260, 240, window.innerWidth));
  }, []);

  useEffect(() => {
    function onResize() {
      setMediaWidth((w) => clampSideWidth(w, propertiesWidthRef.current, window.innerWidth));
      setPropertiesWidth((w) => clampSideWidth(w, mediaWidthRef.current, window.innerWidth));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function beginMediaResize(startEvent: React.MouseEvent | React.TouchEvent) {
    preventDefaultIfMouse(startEvent);
    const start = clientPoint(startEvent);
    const startWidth = mediaWidth;
    const removeListeners = addDragListeners(
      (moveEvent) => {
        const point = clientPoint(moveEvent);
        // Media is the LEFT column — dragging its right edge further right grows it.
        const dx = point.x - start.x;
        setMediaWidth(clampSideWidth(startWidth + dx, propertiesWidthRef.current, window.innerWidth));
      },
      () => removeListeners()
    );
  }

  function beginPropertiesResize(startEvent: React.MouseEvent | React.TouchEvent) {
    preventDefaultIfMouse(startEvent);
    const start = clientPoint(startEvent);
    const startWidth = propertiesWidth;
    const removeListeners = addDragListeners(
      (moveEvent) => {
        const point = clientPoint(moveEvent);
        // Properties is the RIGHT column — dragging its left edge further left grows it.
        const dx = start.x - point.x;
        setPropertiesWidth(clampSideWidth(startWidth + dx, mediaWidthRef.current, window.innerWidth));
      },
      () => removeListeners()
    );
  }

  useEffect(() => {
    void load(projectId, projectName);
    // Deliberately excludes `projectName` — it should only seed the name of a BRAND NEW project
    // (see loadProject's comment), not re-trigger a reload if a host app's own title changes while
    // this project is already open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, load]);

  // Flush on unmount and on window close, so the autosave debounce can never swallow the final edit.
  useEffect(() => {
    const onBeforeUnload = () => void flushPendingSave();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      void flushPendingSave();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target, event.key)) return;
      const state = useEditorStore.getState();
      const current = state.project;
      if (!current) return;

      const modifier = event.ctrlKey || event.metaKey;

      if (modifier && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void state.save();
        state.setStatus(translateText(state.language, "Project saved"));
        return;
      }
      if (modifier && event.key.toLowerCase() === "z") {
        event.preventDefault();
        // Ctrl+Shift+Z redoes, matching the shortcut listed in the status bar.
        if (event.shiftKey) state.redo();
        else state.undo();
        return;
      }
      if (modifier && event.key.toLowerCase() === "y") {
        event.preventDefault();
        state.redo();
        return;
      }
      if (modifier && event.key.toLowerCase() === "d") {
        // Standard NLE shortcut (Premiere, Final Cut, CapCut all use Ctrl/⌘+D for this).
        event.preventDefault();
        state.duplicateSelectedClips();
        return;
      }
      // Standard zoom shortcuts, matching every editor: Ctrl/⌘ +/- steps, Ctrl/⌘ 0 resets. "=" is
      // included alongside "+" because that's the un-shifted key that actually produces "+" on a US
      // keyboard, and the numpad's own +/- report as "+"/"-" directly regardless of Shift.
      if (modifier && (event.key === "+" || event.key === "=")) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("vcut:zoom", { detail: { factor: 1.4 } }));
        return;
      }
      if (modifier && event.key === "-") {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("vcut:zoom", { detail: { factor: 1 / 1.4 } }));
        return;
      }
      if (modifier && event.key === "0") {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("vcut:zoom", { detail: { reset: true } }));
        return;
      }

      switch (event.key) {
        case " ": {
          event.preventDefault();
          state.togglePlay();
          break;
        }
        case "s":
        case "S": {
          event.preventDefault();
          splitAtPlayhead();
          break;
        }
        case "Delete":
        case "Backspace": {
          if (state.selectedClipIds.length === 0) return;
          event.preventDefault();
          state.run(new DeleteClipsCommand(state.selectedClipIds));
          break;
        }
        case "ArrowLeft": {
          event.preventDefault();
          state.stepFrames(event.shiftKey ? -10 : -1);
          break;
        }
        case "ArrowRight": {
          event.preventDefault();
          state.stepFrames(event.shiftKey ? 10 : 1);
          break;
        }
        case "Home": {
          event.preventDefault();
          state.setPlayhead(0);
          break;
        }
        // Universal NLE convention: mark the export range's in/out points at the CURRENT playhead.
        // Each is independent — pressing one doesn't touch the other, so marking just an out-point
        // (leaving in at the implicit timeline start) is a completely normal, valid thing to do. The
        // resulting markers are then draggable directly on the Timeline ruler for fine adjustment —
        // see its own `scrubExportStart`/`scrubExportEnd`.
        case "i":
        case "I": {
          event.preventDefault();
          state.setExportRangeStart(state.playhead);
          break;
        }
        case "o":
        case "O": {
          event.preventDefault();
          state.setExportRangeEnd(state.playhead);
          break;
        }
        // Clears both points — Premiere's own shortcut for the same action. Also reachable via the
        // Timeline header's own "× Range" button (only shown once a range exists) and the Export
        // dialog's "Reset to full timeline" link, for anyone who wouldn't otherwise find this.
        case "X": {
          if (!event.shiftKey) return;
          event.preventDefault();
          state.clearExportRange();
          break;
        }
        default:
          break;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-[#0a0c10] text-xs text-white/40">
        {t("Opening VCut…")}
      </div>
    );
  }

  if (loadError || !project) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-[#0a0c10] p-6 text-center">
        <p className="text-sm font-medium text-rose-300">{t("VCut couldn't open this project")}</p>
        <p className="max-w-md text-xs leading-relaxed text-white/50">{loadError}</p>
        <button
          onClick={() => void load(projectId)}
          className="rounded-md bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/20"
        >
          {t("Try again")}
        </button>
      </div>
    );
  }

  return (
    // "VCut" is a product name — never translated. `vcut-lang-km` (see studios/vcut's
    // globals.css) swaps the whole chrome's font-family to a Khmer-capable face via inheritance —
    // one place, cascades to every descendant, no per-component font changes needed.
    <div className={`flex h-full min-h-0 min-w-0 flex-col bg-[#0a0c10] text-white ${language === "km" ? "vcut-lang-km" : ""}`}>
      <header className="flex min-w-0 shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2">
        {onHome ? (
          <button
            onClick={onHome}
            title={t("Back to projects")}
            aria-label={t("Back to projects")}
            className="flex shrink-0 items-center gap-1.5 text-sm font-semibold tracking-tight text-white transition hover:text-sky-400"
          >
            {/* An arrow (not a plain "X") — "X" reads as close/discard, which this isn't; this
                genuinely navigates back to the projects list, so an unambiguous back arrow is the
                more literal affordance for what actually happens on click. Prefixed onto the existing
                "VCut" wordmark rather than replacing it — keeps the brand visible while editing,
                the arrow alone already makes the button's clickability/destination obvious without
                needing to sacrifice one for the other. */}
            <ArrowLeft size={16} />
            VCut
          </button>
        ) : (
          <span className="shrink-0 text-sm font-semibold tracking-tight">VCut</span>
        )}
        <EditableProjectTitle />
        <SaveStatus />
        <button
          onClick={() => setLanguage(language === "en" ? "km" : "en")}
          title={t("Switch language")}
          aria-label={t("Switch language")}
          className="ml-auto shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-white/60 transition hover:bg-white/10 hover:text-white"
        >
          {language === "en" ? "ខ្មែរ" : "EN"}
        </button>
        <button
          onClick={() => setExportOpen(true)}
          className="shrink-0 rounded-md bg-sky-500 px-3 py-1 text-[11px] font-semibold text-white transition hover:bg-sky-400"
        >
          {t("Export")}
        </button>
      </header>

      {/* Three panes at `lg`+ (1024px): media on the left, preview + inspector in the middle,
          timeline across the bottom — the original desktop layout, unchanged. Below `lg`, there's no
          room for 240px + 260px of fixed side columns next to a preview that still needs to show a
          legible frame, so Media and Inspector aren't laid out at all there (both `hidden` below
          `lg`) — reached instead through the toolbar's Media/Properties buttons, which swap what
          renders in the SAME row Timeline normally occupies (see `mobileSheet`'s own comment above).
          The grid shape itself is now identical at every breakpoint — 2 rows (Preview, Timeline) —
          only the column count differs (`lg:grid-cols-*` adds the two side columns). */}
      {/* min-w-0 on the grid AND every item below: without it, a grid track defaults to
          `min-width: auto`, meaning it grows to fit its widest child's INTRINSIC content width
          instead of the space actually available. Timeline's own content is a wide, horizontally-
          scrolling area (easily 1500px+) — nested `overflow-auto`/`overflow-hidden` clip that
          visually, but the underlying LAYOUT BOX stayed that wide underneath the clipping, all the
          way up through this grid and BP's own page wrapper. It didn't show up as a visible
          scrollbar, but focusing ANY element (a plain tap/click — `role="button" tabIndex={0}` items
          are natively focusable) made the browser auto-scroll that hidden width into view, yanking
          the whole page sideways. That was the actual "still not functional" bug. */}
      <div
        className="relative grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)_224px] lg:grid-cols-[var(--vs-media-w)_minmax(0,1fr)_var(--vs-props-w)] lg:grid-rows-[minmax(0,1fr)_320px]"
        // The Tailwind row class above is the PRE-HYDRATION fallback only, matched almost exactly by
        // the `gridTemplateRows` inline style (which takes over the instant `timelineHeight` state
        // exists, i.e. immediately on the client) — one shared 2-row shape now, not a
        // breakpoint-dependent one. Columns can't take that same "inline style always wins" shortcut,
        // though: below `lg` there are only ever 1-2 real tracks (Media/Properties don't render at
        // all there — see the comment above), so an unconditional `gridTemplateColumns` override would
        // force 3 columns onto the mobile layout too and squeeze Preview/Timeline into a sliver.
        // Routing the two widths through CSS custom properties instead keeps the `lg:` media query
        // doing the gating in real CSS, same as it already does for every other `lg:`-prefixed class
        // here — the custom properties themselves are harmless to set unconditionally since nothing
        // below `lg` ever references them.
        style={
          {
            gridTemplateRows: `minmax(0,1fr) ${timelineHeight}px`,
            "--vs-media-w": `${mediaWidth}px`,
            "--vs-props-w": `${propertiesWidth}px`,
          } as React.CSSProperties
        }
      >
        <div className="row-start-1 min-h-0 min-w-0 lg:order-2 lg:col-start-2 lg:row-start-1">
          <Preview onResizeStart={beginTimelineResize} />
        </div>

        {/* Permanent side columns, `lg`+ only — below `lg` these render nothing at all (not even
            hidden-but-mounted for state-preservation reasons; there's no state here that needs to
            survive being unmounted). Reached on mobile via the toolbar's Media/Properties buttons
            instead, which swap the Timeline row's content below. */}
        <div className="hidden min-h-0 min-w-0 lg:col-start-1 lg:row-start-1 lg:block">
          <MediaLibrary />
        </div>
        <div className="hidden min-h-0 min-w-0 lg:col-start-3 lg:row-start-1 lg:block">
          <Inspector />
        </div>

        {/* The one row Timeline shares with Media/Properties below `lg`, and with Mixer at every
            breakpoint — `mobileSheet` stays `null` at `lg`+ (nothing there ever sets it), so this falls
            through to `bottomPanel` (Timeline vs. Mixer) once the permanent side columns above are
            visible. See `bottomPanel`'s own comment for why it's a separate concept from
            `mobileSheet`. */}
        <div className="row-start-2 min-h-0 min-w-0 lg:col-span-3 lg:row-start-2">
          {mobileSheet === "media" ? (
            <MediaLibrary onAssetAdded={() => setMobileSheet(null)} />
          ) : mobileSheet === "inspector" ? (
            <Inspector />
          ) : bottomPanel === "mixer" ? (
            <MixerPanel onFloat={() => beginFloat("mixer")} />
          ) : bottomPanel === "scopes" ? (
            <ScopesPanel onFloat={() => beginFloat("scopes")} />
          ) : (
            <Timeline />
          )}
        </div>

        {/* Invisible full-width fallback hit strip, sitting right on the row boundary — the VISIBLE,
            discoverable handle is Preview's own (the small centered bar between its canvas and
            transport bar, wired to this exact same `beginTimelineResize` via `onResizeStart`); this
            is just the "drag from anywhere along the edge" convenience a mouse user gets for free on
            top of that, matching Media/Properties' own two dividers below. Absolutely positioned (not
            a real grid row/track) so it never needs its own `row-start`/row-count bookkeeping
            alongside every other item's explicit placement above; `bottom` lands it exactly on the row
            boundary since that row is fixed to this same height. */}
        <div
          onMouseDown={beginTimelineResize}
          onTouchStart={beginTimelineResize}
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("Resize timeline")}
          className="absolute inset-x-0 z-20 h-2.5 -translate-y-1/2 cursor-row-resize touch-none"
          style={{ bottom: timelineHeight }}
        />

        {/* Media|Preview and Preview|Properties dividers — `lg`+ only, same reasoning as the columns
            they resize (see the grid's own comment above): below `lg` neither side column renders, so
            there's nothing here to drag. Positioned/centered exactly like the timeline divider above,
            just along X instead of Y — `left`/`right` (not `translate-x` alone) anchors each to the
            actual column boundary, which is a real pixel value here (unlike Preview's own width,
            which is never known ahead of time — it's `minmax(0,1fr)`), and the half-width translate
            centers the grabbable strip ON that boundary rather than starting flush against it. */}
        <div
          onMouseDown={beginMediaResize}
          onTouchStart={beginMediaResize}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("Resize media panel")}
          className="absolute inset-y-0 z-20 hidden w-2.5 -translate-x-1/2 cursor-col-resize touch-none lg:block"
          style={{ left: mediaWidth }}
        />
        <div
          onMouseDown={beginPropertiesResize}
          onTouchStart={beginPropertiesResize}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("Resize properties panel")}
          className="absolute inset-y-0 z-20 hidden w-2.5 translate-x-1/2 cursor-col-resize touch-none lg:block"
          style={{ right: propertiesWidth }}
        />
      </div>

      <StatusBar
        mobileSheet={mobileSheet}
        setMobileSheet={setMobileSheet}
        bottomPanel={bottomPanel}
        setBottomPanel={setBottomPanel}
        floatingPanel={floatState?.panel ?? null}
        onDockFloating={dockPanel}
      />
      <StatusToast />
      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
      {floatState && (
        <FloatablePanel
          title={floatState.panel === "mixer" ? t("Audio Mixer") : t("Scopes")}
          rect={floatState.rect}
          onRectChange={(rect) => setFloatState((s) => (s ? { ...s, rect } : s))}
          onDock={dockPanel}
          minWidth={280}
          minHeight={220}
        >
          {floatState.panel === "mixer" ? <MixerPanel /> : <ScopesPanel />}
        </FloatablePanel>
      )}
    </div>
  );
}

/** The real export — wraps `VCutAppInner` in an `ErrorBoundary` from the OUTSIDE, not as the
 *  first thing inside its own return, specifically so the boundary also catches errors thrown by
 *  `VCutAppInner`'s own top-level hooks (a boundary can never catch an error thrown by itself, only
 *  by its children — putting it inside `VCutAppInner`'s own return would miss anything that throws
 *  before that return is ever reached). This protects the editor regardless of who mounts it — the
 *  standalone page, BP Studio's `<iframe>` embed, or any future embedder — without relying on every
 *  call site remembering to add a boundary of its own. */
export function VCutApp(props: VCutAppProps) {
  return (
    <ErrorBoundary>
      <VCutAppInner {...props} />
    </ErrorBoundary>
  );
}
