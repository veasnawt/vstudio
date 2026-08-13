"use client";

import React, { useEffect, useState } from "react";
import { DeleteClipsCommand, SplitClipCommand } from "../commands/index.ts";
import { findClip } from "../project/createProject.ts";
import { flushPendingSave, useEditorStore } from "../store/editorStore.ts";
import { clipAtTime } from "../timeline/queries.ts";
import { ExportDialog } from "./ExportDialog.tsx";
import { Inspector } from "./Inspector.tsx";
import { MediaLibrary } from "./MediaLibrary.tsx";
import { Preview } from "./Preview.tsx";
import { Timeline } from "./Timeline.tsx";

/** Input types that accept typed text. Everything else — file, button, checkbox, radio, range — can
 *  hold focus without swallowing a keystroke, so shortcuts must keep working while they're focused.
 *  Getting this wrong is easy to miss: clicking "Import" leaves focus on a file input, and treating
 *  that as "the user is typing" silently kills every shortcut until they click elsewhere. */
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number", "date", "time"]);

/** Whether a keystroke is being typed into something, in which case editor shortcuts must not fire —
 *  otherwise pressing "s" in the media search box would split a clip. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === "TEXTAREA" || target.tagName === "SELECT") return true;
  if (target instanceof HTMLInputElement) {
    // An input with no explicit type defaults to "text".
    return TEXT_INPUT_TYPES.has(target.type || "text");
  }
  return false;
}

function StatusBar() {
  const status = useEditorStore((s) => s.status);
  const dirty = useEditorStore((s) => s.dirty);
  const saving = useEditorStore((s) => s.saving);
  const lastSavedAt = useEditorStore((s) => s.lastSavedAt);
  const setStatus = useEditorStore((s) => s.setStatus);

  // Transient messages clear themselves; errors stay until replaced, since an error the user blinked
  // and missed is worse than one that lingers.
  useEffect(() => {
    if (!status || status.tone === "error") return;
    const timer = setTimeout(() => setStatus(null), 3000);
    return () => clearTimeout(timer);
  }, [status, setStatus]);

  return (
    <footer className="flex shrink-0 items-center gap-3 border-t border-white/10 bg-[#0d0f14] px-3 py-1.5 text-[11px]">
      <span className={status?.tone === "error" ? "text-rose-300" : "text-white/55"}>
        {status?.message ?? "Space play · S split · Del delete · Ctrl+Z undo · Ctrl+S save"}
      </span>

      <span className="ml-auto text-white/40">
        {saving ? "Saving…" : dirty ? "Unsaved changes" : lastSavedAt ? "All changes saved" : ""}
      </span>
    </footer>
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

  useEffect(() => {
    void load(projectId);
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
      if (isTypingTarget(event.target)) return;
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
          // Splits the selected clip, or whatever sits under the playhead when nothing is selected —
          // which is what someone scrubbing to a cut point and hitting S actually means.
          const selectedId = state.selectedClipIds[0];
          const target = selectedId
            ? findClip(current, selectedId)?.clip
            : current.sequence.tracks
                .filter((t) => t.kind === "video" && !t.locked)
                .map((t) => clipAtTime(t, state.playhead))
                .find(Boolean);
          if (!target) return state.setStatus("Put the playhead over a clip to split it", "error");
          state.run(new SplitClipCommand(target.id, state.playhead));
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
        <span className="min-w-0 truncate text-xs text-white/35">{projectName ?? project.name}</span>
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
        className={`grid min-h-0 min-w-0 flex-1 lg:grid-cols-[240px_minmax(0,1fr)_260px] lg:grid-rows-[minmax(0,1fr)_320px] ${
          // The panel slot's row collapses to 0 (rather than the tab content just going `hidden`
          // inside a still-12rem-tall row) so Preview actually reclaims that space — a Tailwind
          // utility class swap, not an inline style: an inline `style` would out-specificity the
          // `lg:grid-rows-[...]` override above and break the desktop layout at that breakpoint.
          mobilePanelCollapsed
            ? "grid-rows-[minmax(0,1fr)_auto_0_12rem]"
            : "grid-rows-[minmax(0,1fr)_auto_12rem_12rem]"
        }`}
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
      </div>

      <StatusBar />
      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
    </div>
  );
}
