"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Delete, Save, Settings, Split, Text, Transition, Video } from "@veasnawt/vicons";
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
 *  in `VStudioApp` for why this replaced an earlier, looser ratio-of-viewport attempt. */
const MIN_PREVIEW_HEIGHT = 120;

/** Shrinks `height` only as far as needed to guarantee Preview keeps `MIN_PREVIEW_HEIGHT`, given how
 *  much total vertical space actually exists — never grows it. Shared by the initial seed (so a page
 *  freshly loaded in landscape never renders the broken state to begin with) and the resize listener
 *  (so rotating mid-session reaches the same safe result). */
function clampTimelineHeight(height: number, viewportHeight: number): number {
  const maxForPreview = viewportHeight - CHROME_HEIGHT - MIN_PREVIEW_HEIGHT;
  return Math.max(MIN_TIMELINE_HEIGHT, Math.min(height, Math.max(MIN_TIMELINE_HEIGHT, maxForPreview)));
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

/** One toolbar icon, disabled state, an optional highlighted "active" state (used by toggles like
 *  Transition, where the button itself IS the on/off indicator), and a `title` that doubles as the
 *  tooltip AND the keyboard-shortcut hint the old plain-text status bar used to show permanently.
 *  `label` is a SHORT caption rendered under the icon (not a substitute for `title` — the shortcut
 *  hint only shows up on hover/long-press, the label is what makes each icon identifiable without
 *  either) — a phone user can't hover to discover what an icon-only button does the way a mouse user
 *  can, and even for a mouse this row's icons (Split/Delete/Save/Text/Transition/Media/Properties)
 *  aren't universally self-explanatory the way Play/Pause are. */
function ToolbarButton({
  onClick,
  disabled,
  active,
  title,
  label,
  className = "",
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  title: string;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
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
}

function StatusBar({
  mobileSheet,
  setMobileSheet,
}: {
  mobileSheet: "media" | "inspector" | null;
  setMobileSheet: (next: "media" | "inspector" | null) => void;
}) {
  const setStatus = useEditorStore((s) => s.setStatus);
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds);
  const run = useEditorStore((s) => s.run);
  const save = useEditorStore((s) => s.save);
  const addTextAtPlayhead = useEditorStore((s) => s.addTextAtPlayhead);
  const project = useEditorStore((s) => s.project);

  // Drives the Transition button's active/disabled look — recomputed on every render from the same
  // store state `toggleTransitionOnSelected` itself reads imperatively, so the two can never disagree
  // about what clicking the button will actually do.
  const selectedId = selectedClipIds[0];
  const foundForTransition = project && selectedId ? findClip(project, selectedId) : undefined;
  const transitionActive = Boolean(foundForTransition?.clip.transitionIn);
  const transitionCandidate = foundForTransition && findTransitionCandidate(foundForTransition.track, foundForTransition.clip);
  const transitionDisabled = !foundForTransition || (!transitionActive && !transitionCandidate);

  return (
    <footer className="flex shrink-0 items-center gap-1 border-t border-white/10 bg-[#0d0f14] px-2 py-1.5 text-[11px]">
      {/* Icons only now — the status message and save-state text that used to share this row moved to
          a floating toast (`StatusToast`) and the header (`SaveStatus`) respectively. This row was
          already the tightest space in the whole editor (up to 11 icons, some already pushed into
          horizontal overflow scroll on a phone — see the comment below), and neither of those two
          pieces of text is something a user is trying to TAP; keeping them here only ever cost this
          row space without adding anything reachable. Below `lg`, Media/Properties have no permanent
          side column anymore (see VStudioApp's own comment on `mobileSheet`) — this is where they're
          reached instead, which pushed the button count past what a phone's width can show without
          scrolling; `scrollbar-none` matches Timeline's own horizontal scrollbar treatment. */}
      <div className="scrollbar-none flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        <ToolbarButton title="Split at playhead (S)" label="Split" onClick={splitAtPlayhead}>
          <Split size={18} />
        </ToolbarButton>
        <ToolbarButton
          title="Delete selected (Del)"
          label="Delete"
          disabled={selectedClipIds.length === 0}
          onClick={() => run(new DeleteClipsCommand(selectedClipIds))}
        >
          <Delete size={18} />
        </ToolbarButton>
        <ToolbarButton
          title="Save (Ctrl+S)"
          label="Save"
          onClick={() => {
            void save();
            setStatus("Project saved");
          }}
        >
          <Save size={18} />
        </ToolbarButton>

        <span className="mx-1 h-5 w-px shrink-0 bg-white/10" />

        {/* Text and voiceover recording: moved here from the Media panel so both land straight on the
            timeline (and so in the preview) the instant they're created, rather than sitting as a
            library-only asset waiting for a separate double-click/drag to place. */}
        <ToolbarButton title="Add text" label="Text" onClick={addTextAtPlayhead}>
          <Text size={18} />
        </ToolbarButton>
        <VoiceoverRecorder />

        {/* Quick on/off for the selected clip's crossfade — the Inspector's own "Transition In" section
            (same underlying `SetClipTransitionCommand`) is still where the duration gets fine-tuned; see
            `toggleTransitionOnSelected`'s own comment. */}
        <ToolbarButton
          title={transitionActive ? "Remove transition" : "Add crossfade transition from previous clip"}
          label="Transition"
          disabled={transitionDisabled}
          active={transitionActive}
          onClick={toggleTransitionOnSelected}
        >
          <Transition size={18} />
        </ToolbarButton>

        {/* Media/Properties, mobile-only — desktop keeps its permanent side columns (see
            VStudioApp's grid) and never sets `mobileSheet`, so these stay irrelevant there regardless
            of `lg:hidden`. Toggling: tapping the already-open one returns to Timeline, matching
            `active`'s highlighted state always reflecting what's actually showing below. */}
        <span className="mx-1 h-5 w-px shrink-0 bg-white/10 lg:hidden" />
        <ToolbarButton
          title="Media"
          label="Media"
          className="lg:hidden"
          active={mobileSheet === "media"}
          onClick={() => setMobileSheet(mobileSheet === "media" ? null : "media")}
        >
          <Video size={18} />
        </ToolbarButton>
        <ToolbarButton
          title="Properties"
          label="Properties"
          className="lg:hidden"
          active={mobileSheet === "inspector"}
          onClick={() => setMobileSheet(mobileSheet === "inspector" ? null : "inspector")}
        >
          <Settings size={18} />
        </ToolbarButton>
      </div>
    </footer>
  );
}

/** Persistent save-state indicator — "Saving…" / "Unsaved changes" / "All changes saved" — moved into
 *  the header (see VStudioApp's own JSX) out of the toolbar footer, which had no room to spare for
 *  text that isn't a button. The header has exactly three other things in it (the "VStudio" wordmark,
 *  the project title, the Export button), so this is genuinely uncrowded space by comparison. */
function SaveStatus() {
  const dirty = useEditorStore((s) => s.dirty);
  const saving = useEditorStore((s) => s.saving);
  const lastSavedAt = useEditorStore((s) => s.lastSavedAt);

  const text = saving ? "Saving…" : dirty ? "Unsaved changes" : lastSavedAt ? "All changes saved" : "";
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

  // Transient messages clear themselves; errors stay until replaced, since an error the user blinked
  // and missed is worse than one that lingers.
  useEffect(() => {
    if (!status || status.tone === "error") return;
    const timer = setTimeout(() => setStatus(null), 3000);
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
      // should still be interactive if it's ever given a dismiss control.
      className="pointer-events-none fixed inset-x-0 bottom-16 z-40 flex justify-center px-4"
    >
      <div
        className={`pointer-events-auto max-w-[90vw] truncate rounded-md px-3 py-1.5 text-xs shadow-lg ${
          status.tone === "error" ? "bg-rose-500/95 text-white" : "border border-white/10 bg-[#181b22] text-white/80"
        }`}
      >
        {status.message}
      </div>
    </div>,
    document.body
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
  // Below the `lg` breakpoint there's no permanent Media/Inspector column at all (240px + 260px of
  // fixed side columns doesn't fit next to a preview that still needs to show a legible frame) —
  // instead, the toolbar's Media/Properties buttons (see StatusBar) swap the Timeline row's own
  // content for one of these two, full-width, until toggled back. `null` means "show Timeline",
  // which is also what this always stays at `lg`+ (those toolbar buttons are `lg:hidden`, so nothing
  // ever sets it there). Confirmed with the user: the earlier tab-bar-plus-shared-row design (Media
  // and Properties each getting a permanently docked, always-partially-visible slot below Preview)
  // read as too busy and too easy to mis-tap on a real phone — this replaces it entirely rather than
  // adding a third mobile layout mode alongside it.
  const [mobileSheet, setMobileSheet] = useState<"media" | "inspector" | null>(null);

  // Lets the user trade vertical space between Preview (clearer to look at, bigger) and Timeline
  // (more clips/tracks visible at once) via a draggable divider, on every breakpoint. Seeded
  // per-breakpoint, NOT one shared default: desktop's roomy 320px starting point squeezed Preview's
  // row down to a sliver on a short phone the instant it was reused as mobile's default too —
  // confirmed live, the transport bar's own real content then overflowed its row. `typeof window`
  // guard: this file is "use client", but the very first render (SSR/hydration) still runs once
  // without a real `window`.
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
  const [timelineHeight, setTimelineHeight] = useState(() => {
    if (typeof window === "undefined") return 224;
    const preferred = window.matchMedia("(min-width: 1024px)").matches ? 320 : 224;
    return clampTimelineHeight(preferred, window.innerHeight);
  });

  // Re-clamps on resize/rotation — the initializer above only runs once at mount, so rotating a
  // phone mid-session (portrait, where 224px comfortably fits, to landscape, where it doesn't) would
  // otherwise reproduce the exact same squeeze the initializer fixes for a fresh landscape load. Only
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
        <SaveStatus />
        <button
          onClick={() => setExportOpen(true)}
          className="ml-auto shrink-0 rounded-md bg-sky-500 px-3 py-1 text-[11px] font-semibold text-white transition hover:bg-sky-400"
        >
          Export
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
        className="relative grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)_224px] lg:grid-cols-[240px_minmax(0,1fr)_260px] lg:grid-rows-[minmax(0,1fr)_320px]"
        // The Tailwind class above is the PRE-HYDRATION fallback only, matched almost exactly by this
        // inline style (which takes over the instant `timelineHeight` state exists, i.e. immediately
        // on the client) — one shared 2-row shape now, not a breakpoint-dependent one.
        style={{ gridTemplateRows: `minmax(0,1fr) ${timelineHeight}px` }}
      >
        <div className="row-start-1 min-h-0 min-w-0 lg:order-2 lg:col-start-2 lg:row-start-1">
          <Preview />
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

        {/* The one row Timeline shares with Media/Properties below `lg` — `mobileSheet` stays `null`
            at `lg`+ (nothing there ever sets it), so this always renders Timeline once the permanent
            side columns above are visible. */}
        <div className="row-start-2 min-h-0 min-w-0 lg:col-span-3 lg:row-start-2">
          {mobileSheet === "media" ? (
            <MediaLibrary onAssetAdded={() => setMobileSheet(null)} />
          ) : mobileSheet === "inspector" ? (
            <Inspector />
          ) : (
            <Timeline />
          )}
        </div>

        {/* Draggable divider, every breakpoint — see `timelineHeight`'s own comment. Absolutely
            positioned (not a real grid row/track) so it never needs its own `row-start`/row-count
            bookkeeping alongside every other item's explicit placement above; `bottom` lands it
            exactly on the row boundary since that row is fixed to this same height. No line of its
            own — Timeline's own `border-t` (its section root, Timeline.tsx) already draws the visible
            boundary line exactly here when Timeline itself is what's showing; MediaLibrary/Inspector
            draw their own top edge instead when one of THEM is — either way this stays a purely
            invisible, taller-than-1px grab area (`h-2.5`) layered on top for an actually-grabbable hit
            target, rather than drawing a second, redundant line. */}
        <div
          onMouseDown={beginTimelineResize}
          onTouchStart={beginTimelineResize}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize timeline"
          className="absolute inset-x-0 z-20 block h-2.5 -translate-y-1/2 cursor-row-resize touch-none"
          style={{ bottom: timelineHeight }}
        />
      </div>

      <StatusBar mobileSheet={mobileSheet} setMobileSheet={setMobileSheet} />
      <StatusToast />
      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
    </div>
  );
}
