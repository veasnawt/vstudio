"use client";

import React, { useEffect, useRef, useState } from "react";
import { Delete, Pause, Play, Redo, Save, Split, Text, Transition, Undo } from "@veasnawt/vicons";
import { DeleteClipsCommand, SetClipTransitionCommand, SplitClipCommand } from "../commands/index.ts";
import { findClip } from "../project/createProject.ts";
import { flushPendingSave, useEditorStore } from "../store/editorStore.ts";
import { clipAtTime } from "../timeline/queries.ts";
import { DEFAULT_TRANSITION, findTransitionCandidate } from "../timeline/transitions.ts";
import { ExportDialog } from "./ExportDialog.tsx";
import { Inspector } from "./Inspector.tsx";
import { MediaLibrary } from "./MediaLibrary.tsx";
import { addDragListeners, clientPoint, preventDefaultIfMouse } from "./pointerEvents.ts";
import { Preview } from "./Preview.tsx";
import { Timeline } from "./Timeline.tsx";
import { VoiceoverRecorder } from "./VoiceoverRecorder.tsx";

/** Bounds for the draggable Preview/Timeline divider (desktop only) — see `beginTimelineResize`. A
 *  fixed pixel floor for Timeline (below this a track row plus its ruler stops being useful) and a
 *  viewport-relative ceiling for Preview (a fixed pixel floor there would break on a short laptop
 *  screen; unlike Timeline, Preview's minimum useful height scales with how much screen exists at all). */
const MIN_TIMELINE_HEIGHT = 120;
const MAX_TIMELINE_HEIGHT_RATIO = 0.75;

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
  if (!target) return state.setStatus("Put the playhead over a clip to split it", "error");
  state.run(new SplitClipCommand(target.id, state.playhead));
}

/** Toggles a crossfade transition on the selected clip — the toolbar's quick on/off counterpart to
 *  the Inspector's own "Transition In" section (which stays the place to fine-tune the duration
 *  afterward; this button and that checkbox both dispatch the identical `SetClipTransitionCommand`,
 *  so neither can drift out of sync with the other). Turning ON only ever fires when
 *  `findTransitionCandidate` confirms a genuinely adjacent predecessor exists — same gate the
 *  Inspector uses to decide whether to even show its own section — but turning OFF an existing
 *  `transitionIn` is always allowed regardless, since removing one is safe even if the clip's
 *  adjacency has since broken. */
function toggleTransitionOnSelected() {
  const state = useEditorStore.getState();
  const current = state.project;
  const selectedId = state.selectedClipIds[0];
  if (!current || !selectedId) return;
  const found = findClip(current, selectedId);
  if (!found) return;
  const { clip, track } = found;

  if (clip.transitionIn) {
    state.run(new SetClipTransitionCommand(clip.id, null));
    return;
  }
  if (!findTransitionCandidate(track, clip)) {
    return state.setStatus("Move this clip flush against the previous one to add a transition", "error");
  }
  state.run(new SetClipTransitionCommand(clip.id, DEFAULT_TRANSITION));
}

/** One toolbar icon — fixed square, disabled state, an optional highlighted "active" state (used by
 *  toggles like Transition, where the button itself IS the on/off indicator), and a `title` that
 *  doubles as the tooltip AND the keyboard-shortcut hint the old plain-text status bar used to show
 *  permanently. */
function ToolbarButton({
  onClick,
  disabled,
  active,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded text-base leading-none transition disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent ${
        active
          ? "bg-sky-500/30 text-white hover:bg-sky-500/40"
          : "text-white/70 hover:bg-white/10 hover:text-white disabled:hover:text-white/70"
      }`}
    >
      {children}
    </button>
  );
}

function StatusBar() {
  const status = useEditorStore((s) => s.status);
  const dirty = useEditorStore((s) => s.dirty);
  const saving = useEditorStore((s) => s.saving);
  const lastSavedAt = useEditorStore((s) => s.lastSavedAt);
  const setStatus = useEditorStore((s) => s.setStatus);
  const playing = useEditorStore((s) => s.playing);
  const togglePlay = useEditorStore((s) => s.togglePlay);
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds);
  const run = useEditorStore((s) => s.run);
  const canUndo = useEditorStore((s) => s.canUndo);
  const canRedo = useEditorStore((s) => s.canRedo);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const save = useEditorStore((s) => s.save);
  const addTextAtPlayhead = useEditorStore((s) => s.addTextAtPlayhead);
  const project = useEditorStore((s) => s.project);

  // Transient messages clear themselves; errors stay until replaced, since an error the user blinked
  // and missed is worse than one that lingers.
  useEffect(() => {
    if (!status || status.tone === "error") return;
    const timer = setTimeout(() => setStatus(null), 3000);
    return () => clearTimeout(timer);
  }, [status, setStatus]);

  // Drives the Transition button's active/disabled look — recomputed on every render from the same
  // store state `toggleTransitionOnSelected` itself reads imperatively, so the two can never disagree
  // about what clicking the button will actually do.
  const selectedId = selectedClipIds[0];
  const foundForTransition = project && selectedId ? findClip(project, selectedId) : undefined;
  const transitionActive = Boolean(foundForTransition?.clip.transitionIn);
  const transitionCandidate = foundForTransition && findTransitionCandidate(foundForTransition.track, foundForTransition.clip);
  const transitionDisabled = !foundForTransition || (!transitionActive && !transitionCandidate);

  return (
    <footer className="flex shrink-0 items-center gap-0.5 border-t border-white/10 bg-[#0d0f14] px-2 py-1.5 text-[11px]">
      <ToolbarButton title="Play/Pause (Space)" onClick={togglePlay}>
        {playing ? <Pause size={20} /> : <Play size={20} />}
      </ToolbarButton>
      <ToolbarButton title="Split at playhead (S)" onClick={splitAtPlayhead}>
        <Split size={20} />
      </ToolbarButton>
      <ToolbarButton
        title="Delete selected (Del)"
        disabled={selectedClipIds.length === 0}
        onClick={() => run(new DeleteClipsCommand(selectedClipIds))}
      >
        <Delete size={20} />
      </ToolbarButton>
      <ToolbarButton title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
        <Undo size={20} />
      </ToolbarButton>
      <ToolbarButton title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}>
        <Redo size={20} />
      </ToolbarButton>
      <ToolbarButton
        title="Save (Ctrl+S)"
        onClick={() => {
          void save();
          setStatus("Project saved");
        }}
      >
        <Save size={20} />
      </ToolbarButton>

      <span className="mx-1 h-5 w-px shrink-0 bg-white/10" />

      {/* Text and voiceover recording: moved here from the Media panel so both land straight on the
          timeline (and so in the preview) the instant they're created, rather than sitting as a
          library-only asset waiting for a separate double-click/drag to place. */}
      <ToolbarButton title="Add text" onClick={addTextAtPlayhead}>
        <Text size={20} />
      </ToolbarButton>
      <VoiceoverRecorder />

      {/* Quick on/off for the selected clip's crossfade — the Inspector's own "Transition In" section
          (same underlying `SetClipTransitionCommand`) is still where the duration gets fine-tuned; see
          `toggleTransitionOnSelected`'s own comment. */}
      <ToolbarButton
        title={transitionActive ? "Remove transition" : "Add crossfade transition from previous clip"}
        disabled={transitionDisabled}
        active={transitionActive}
        onClick={toggleTransitionOnSelected}
      >
        <Transition size={20} />
      </ToolbarButton>

      {status && (
        <span className={`min-w-0 flex-1 truncate px-1 ${status.tone === "error" ? "text-rose-300" : "text-white/55"}`}>
          {status.message}
        </span>
      )}

      <span className="ml-auto shrink-0 pl-2 text-white/40">
        {saving ? "Saving…" : dirty ? "Unsaved changes" : lastSavedAt ? "All changes saved" : ""}
      </span>
    </footer>
  );
}

/** Click-to-rename project title, sitting in the header next to "VStudio". `project.name` (not the
 *  `projectName` prop a host app like BP Studio passes in) is the only thing this reads or writes —
 *  that prop only ever SEEDS `project.name` at creation time (see `load`'s own comment), so once a
 *  project exists its name lives entirely in the project itself, and a rename here is exactly as
 *  durable/visible as any other edit (autosaved, and reflected back in VStudio's own project list). */
function EditableProjectTitle() {
  const name = useEditorStore((s) => s.project?.name ?? "");
  const renameProject = useEditorStore((s) => s.renameProject);
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
        aria-label="Project name"
        className="min-w-0 max-w-[240px] flex-1 rounded bg-white/10 px-1.5 py-0.5 text-xs text-white outline-none ring-1 ring-sky-400/60"
      />
    );
  }

  return (
    <button
      onClick={startEditing}
      title="Rename project"
      aria-label="Rename project"
      className="min-w-0 max-w-[240px] flex-1 truncate rounded px-1.5 py-0.5 text-left text-xs text-white/35 transition hover:bg-white/10 hover:text-white/70"
    >
      {name}
    </button>
  );
}

export function VStudioApp({ projectId, projectName }: { projectId: string; projectName?: string }) {
  const load = useEditorStore((s) => s.load);
  const loading = useEditorStore((s) => s.loading);
  const loadError = useEditorStore((s) => s.loadError);
  const project = useEditorStore((s) => s.project);
  const [exportOpen, setExportOpen] = useState(false);
  // Below the `lg` breakpoint there isn't room for Media and Inspector as permanent side columns
  // (240px + 260px alone exceeds a phone's whole width) — they share one slot, switched by tab,
  // since you're either browsing footage or adjusting a selected clip's properties, never both at
  // once. Irrelevant at `lg`+, where both are always shown side by side as they always have been.
  const [mobilePanel, setMobilePanel] = useState<"media" | "inspector">("media");
  // Separate from WHICH panel is selected — collapsing hands that ~192px slot back to Preview and
  // Timeline (the things you're actually looking at while playing/scrubbing), without losing track of
  // which tab to reopen. A dedicated toggle rather than "tap the active tab again to collapse it": an
  // always-selected-looking tab that sometimes secretly also means "closed" is a worse affordance than
  // a persistent, explicitly-labeled control for the one thing it does.
  const [mobilePanelCollapsed, setMobilePanelCollapsed] = useState(false);

  // Desktop-only: lets the user trade vertical space between Preview (clearer to look at, bigger) and
  // Timeline (more clips/tracks visible at once) via a draggable divider — the same tradeoff
  // `mobilePanelCollapsed` above offers on mobile, just continuously adjustable instead of a fixed
  // toggle, since desktop has the width for both Preview and Timeline to stay visible simultaneously.
  // `MIN_TIMELINE_HEIGHT`/`MAX_TIMELINE_HEIGHT` keep either side from being dragged down to uselessness.
  const [timelineHeight, setTimelineHeight] = useState(320);
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  function beginTimelineResize(startEvent: React.MouseEvent | React.TouchEvent) {
    preventDefaultIfMouse(startEvent);
    const start = clientPoint(startEvent);
    const startHeight = timelineHeight;
    const removeListeners = addDragListeners(
      (moveEvent) => {
        const point = clientPoint(moveEvent);
        // Dragging UP (pointer above the start point) grows the timeline — the divider sits ABOVE it,
        // so moving it toward the top of the screen makes the row below it taller, matching the
        // direction every other "drag this edge to resize" control in a video editor uses.
        const dy = start.y - point.y;
        setTimelineHeight(Math.min(window.innerHeight * MAX_TIMELINE_HEIGHT_RATIO, Math.max(MIN_TIMELINE_HEIGHT, startHeight + dy)));
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
        state.setStatus("Project saved");
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
      // Standard zoom shortcuts, matching every editor: Ctrl/⌘ +/- steps, Ctrl/⌘ 0 resets. "=" is
      // included alongside "+" because that's the un-shifted key that actually produces "+" on a US
      // keyboard, and the numpad's own +/- report as "+"/"-" directly regardless of Shift.
      if (modifier && (event.key === "+" || event.key === "=")) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("vstudio:zoom", { detail: { factor: 1.4 } }));
        return;
      }
      if (modifier && event.key === "-") {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("vstudio:zoom", { detail: { factor: 1 / 1.4 } }));
        return;
      }
      if (modifier && event.key === "0") {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("vstudio:zoom", { detail: { reset: true } }));
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
        Opening VStudio…
      </div>
    );
  }

  if (loadError || !project) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-[#0a0c10] p-6 text-center">
        <p className="text-sm font-medium text-rose-300">VStudio couldn&apos;t open this project</p>
        <p className="max-w-md text-xs leading-relaxed text-white/50">{loadError}</p>
        <button
          onClick={() => void load(projectId)}
          className="rounded-md bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/20"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-[#0a0c10] text-white">
      <header className="flex min-w-0 shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2">
        <span className="shrink-0 text-sm font-semibold tracking-tight">VStudio</span>
        <EditableProjectTitle />
        <button
          onClick={() => setExportOpen(true)}
          className="ml-auto shrink-0 rounded-md bg-sky-500 px-3 py-1 text-[11px] font-semibold text-white transition hover:bg-sky-400"
        >
          Export
        </button>
      </header>

      {/* Three panes at `lg`+ (1024px): media on the left, preview + inspector in the middle,
          timeline across the bottom — the original desktop layout, unchanged. Below `lg`, 240px +
          260px of fixed side columns simply doesn't fit next to a preview that still needs to show a
          legible frame, so it stacks instead: Preview stays always visible (the one thing you always
          need on screen), Media and Inspector share a single slot behind the tab switcher below, and
          Timeline keeps its own fixed, independently-scrollable share — it already scrolls both axes
          (see Timeline.tsx), so a shorter allotment there is "less at a glance," not "unreachable". */}
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
        className={`relative grid min-h-0 min-w-0 flex-1 lg:grid-cols-[240px_minmax(0,1fr)_260px] lg:grid-rows-[minmax(0,1fr)_320px] ${
          // Below `lg`, Timeline gets more room than its desktop 320px counterpart would suggest at
          // this size — 14rem (up from an earlier 12rem) is what a track row (56px) plus the ruler
          // and the persistent horizontal scrollbar actually need to show more than a sliver of clips
          // at once on a phone/tablet. Collapsing the Media/Properties panel goes further still: the
          // panel slot's row drops to 0 (rather than the tab content just going `hidden` inside a
          // still-sized row) so that freed space goes to TIMELINE specifically, not Preview — the
          // whole point of collapsing the panel on a small screen is almost always "let me see more of
          // the timeline," not a bigger preview frame it's already sized reasonably for. A Tailwind
          // utility class swap, not an inline style: an inline `style` would out-specificity the
          // `lg:grid-rows-[...]` override above and break the desktop layout at that breakpoint.
          mobilePanelCollapsed
            ? "grid-rows-[minmax(0,1fr)_auto_0_20rem]"
            : "grid-rows-[minmax(0,1fr)_auto_12rem_14rem]"
        }`}
        // The mobile Tailwind classes above stay in full control below `lg` — this inline override
        // only ever applies once `isDesktop` is confirmed via the `matchMedia` effect, and even then
        // starts at the exact same 320px the `lg:grid-rows-[...]` class already specifies, so there's
        // no visible jump the first time it takes over. `undefined` (not a value) below `lg`: an
        // inline style is never conditional on a media query the way a class is, so leaving it SET
        // there would silently override the mobile row template with a desktop one.
        style={isDesktop ? { gridTemplateRows: `minmax(0,1fr) ${timelineHeight}px` } : undefined}
      >
        {/* Every child below gets an EXPLICIT row-start at every breakpoint, mobile included — never
            left to grid auto-placement. Auto-placement assigns visible items to consecutive rows in
            DOM order, skipping anything `display:none`; with Media and Inspector sharing one DOM
            slot and only one of them ever visible, collapsing that slot (`hidden` on BOTH) removed
            an item from the flow and auto-placement compacted everything after it up by one row —
            Timeline included, sliding it into the panel's own now-zero-height row 3 instead of its
            intended row 4. That's why the whole timeline appeared to vanish on collapse. */}
        <div className="row-start-1 min-h-0 min-w-0 lg:order-2 lg:col-start-2 lg:row-start-1">
          <Preview />
        </div>

        <div className="row-start-2 flex shrink-0 items-stretch border-b border-t border-white/10 lg:hidden">
          <button
            onClick={() => {
              setMobilePanel("media");
              setMobilePanelCollapsed(false);
            }}
            className={`flex-1 px-3 py-2 text-xs font-medium transition ${
              mobilePanel === "media" ? "border-b-2 border-sky-400 text-white" : "text-white/45 hover:text-white/70"
            }`}
          >
            Media
          </button>
          <button
            onClick={() => {
              setMobilePanel("inspector");
              setMobilePanelCollapsed(false);
            }}
            className={`flex-1 px-3 py-2 text-xs font-medium transition ${
              mobilePanel === "inspector" ? "border-b-2 border-sky-400 text-white" : "text-white/45 hover:text-white/70"
            }`}
          >
            Properties
          </button>
          <button
            onClick={() => setMobilePanelCollapsed((collapsed) => !collapsed)}
            aria-label={mobilePanelCollapsed ? "Show panel" : "Hide panel"}
            aria-expanded={!mobilePanelCollapsed}
            title={mobilePanelCollapsed ? "Show panel" : "Hide panel"}
            className="shrink-0 border-l border-white/10 px-3 text-white/45 transition hover:bg-white/10 hover:text-white"
          >
            {mobilePanelCollapsed ? "︿" : "﹀"}
          </button>
        </div>

        <div
          className={`row-start-3 min-h-0 min-w-0 lg:col-start-1 lg:row-start-1 lg:block ${
            !mobilePanelCollapsed && mobilePanel === "media" ? "block" : "hidden"
          }`}
        >
          <MediaLibrary />
        </div>
        <div
          className={`row-start-3 min-h-0 min-w-0 lg:col-start-3 lg:row-start-1 lg:block ${
            !mobilePanelCollapsed && mobilePanel === "inspector" ? "block" : "hidden"
          }`}
        >
          <Inspector />
        </div>

        <div className="row-start-4 min-h-0 min-w-0 lg:col-span-3 lg:row-start-2">
          <Timeline />
        </div>

        {/* Desktop-only draggable divider — see `timelineHeight`'s own comment. Absolutely positioned
            (not a real grid row/track) so it never needs its own `row-start`/row-count bookkeeping
            alongside every other item's explicit placement above; `bottom: timelineHeight` lands it
            exactly on the row boundary since Timeline's own row is fixed to that same height. No line
            of its own — Timeline's own `border-t` (its section root, Timeline.tsx) already draws the
            visible boundary line exactly here, so this stays a purely invisible, taller-than-1px grab
            area (`h-2.5`) layered on top of it for an actually-grabbable hit target, rather than
            drawing a second, redundant line right next to Timeline's real one. */}
        <div
          onMouseDown={beginTimelineResize}
          onTouchStart={beginTimelineResize}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize timeline"
          className="absolute inset-x-0 z-20 hidden h-2.5 -translate-y-1/2 cursor-row-resize touch-none lg:block"
          style={{ bottom: timelineHeight }}
        />
      </div>

      <StatusBar />
      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
    </div>
  );
}
