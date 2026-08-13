"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AddClipCommand, AddTrackCommand, ReorderTrackCommand } from "../commands/index.ts";
import { sequenceDuration } from "../project/createProject.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { formatTimecode } from "../timeline/time.ts";
import { addDragListeners, clientPoint } from "./pointerEvents.ts";
import { TimelineClip } from "./TimelineClip.tsx";
import { TrackHeader } from "./TrackHeader.tsx";

const TRACK_HEIGHT = 56;
const HEADER_WIDTH = 116;
const RULER_HEIGHT = 26;
/** Empty space kept past the end of the edit, so there's always somewhere to drop a clip and extend
 *  the timeline rather than being fenced in at exactly the last frame. */
const TRAILING_SECONDS = 10;

/** Chooses a ruler interval that keeps labels readable at any zoom — roughly one every 80px, snapped
 *  to a human-friendly step so labels land on whole seconds and minutes rather than arbitrary values. */
function tickInterval(pixelsPerSecond: number): number {
  const targetSeconds = 80 / pixelsPerSecond;
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((step) => step >= targetSeconds) ?? 900;
}

export function Timeline() {
  const project = useEditorStore((s) => s.project);
  const pixelsPerSecond = useEditorStore((s) => s.pixelsPerSecond);
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const select = useEditorStore((s) => s.select);
  const zoomBy = useEditorStore((s) => s.zoomBy);
  const resetZoom = useEditorStore((s) => s.resetZoom);
  const run = useEditorStore((s) => s.run);

  const scrollRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const headerListRef = useRef<HTMLDivElement>(null);
  /** Set just before a zoom change, read back by the layout effect below once the new
   *  `pixelsPerSecond` has actually rendered. This is what lets zooming keep a fixed point stationary
   *  under the cursor (or under the viewport's own center for a keyboard/button-triggered zoom that
   *  has no cursor position) instead of always zooming from the left edge of the scroll area, which
   *  is what plain `zoomBy` on its own does and what makes naive timeline zoom feel like it "jumps". */
  const zoomAnchorRef = useRef<{ time: number; clientX: number } | null>(null);
  /** Set while a clip is being dragged onto a DIFFERENT track, so the destination can be highlighted.
   *  Updated only when the target actually changes, not on every mouse move. */
  const [dropTrackId, setDropTrackId] = useState<string | null>(null);
  /** Set while a TRACK is being dragged to reorder it — distinct from `dropTrackId` above, which is
   *  about a CLIP landing on a different track. Only one row can be a drop target at a time, so this
   *  lives here rather than each `TrackHeader` guessing independently. */
  const [trackDropIndicator, setTrackDropIndicator] = useState<{ trackId: string; position: "before" | "after" } | null>(
    null
  );

  const total = project ? sequenceDuration(project) : 0;
  const contentSeconds = Math.max(total + TRAILING_SECONDS, 30);
  const contentWidth = contentSeconds * pixelsPerSecond;

  const assetNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const asset of project?.assets ?? []) map.set(asset.id, asset.name);
    return map;
  }, [project?.assets]);

  /** Converts a pointer position anywhere in the scrollable lane area to a timeline time. */
  const timeFromEvent = useCallback(
    (clientX: number): number => {
      const container = scrollRef.current;
      if (!container) return 0;
      const rect = container.getBoundingClientRect();
      return (clientX - rect.left + container.scrollLeft) / pixelsPerSecond;
    },
    [pixelsPerSecond]
  );

  /** Zooms by `factor`, keeping the time at `clientX` (defaulting to the center of the visible
   *  scroll area, for a keyboard shortcut or button click with no cursor position to anchor to)
   *  stationary on screen. Recording the anchor and correcting `scrollLeft` in a layout effect AFTER
   *  the new `pixelsPerSecond` has rendered — rather than trying to compute the corrected scroll
   *  position up front — is what avoids a visible flash of the wrong scroll position, since
   *  `contentWidth` (which `scrollLeft` is clamped against) only exists once the new width is committed. */
  const zoomAround = useCallback(
    (factor: number, clientX?: number) => {
      const container = scrollRef.current;
      if (!container) return zoomBy(factor);
      const rect = container.getBoundingClientRect();
      const anchorClientX = clientX ?? rect.left + rect.width / 2;
      zoomAnchorRef.current = { time: timeFromEvent(anchorClientX), clientX: anchorClientX };
      zoomBy(factor);
    },
    [zoomBy, timeFromEvent]
  );

  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    const container = scrollRef.current;
    zoomAnchorRef.current = null;
    if (!anchor || !container) return;
    const rect = container.getBoundingClientRect();
    container.scrollLeft = anchor.time * pixelsPerSecond - (anchor.clientX - rect.left);
  }, [pixelsPerSecond]);

  // Ctrl/⌘+wheel zooms, matching the convention in every timeline tool; a plain wheel keeps its
  // normal scroll behavior. Anchored on the cursor, not the left edge of the view, so the point under
  // the mouse stays put — the difference between zoom feeling responsive and feeling like the
  // timeline randomly jumps around underneath you.
  //
  // A NATIVE listener with `{ passive: false }`, not React's `onWheel` prop, because React 17+
  // attaches wheel/touch listeners passively at the root by default for scroll performance — calling
  // `preventDefault()` from a JSX `onWheel` handler throws "Unable to preventDefault inside passive
  // event listener invocation" and, worse, silently does NOTHING, so the browser's native scroll
  // would still fire alongside the zoom.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomAround(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX);
    }
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [zoomAround]);

  // Keyboard shortcuts (Ctrl/⌘ +/-/0) live in VStudioApp's global keydown handler, which has no
  // access to this component's scroll container — it dispatches this event instead of calling the
  // store directly, so a keyboard-triggered zoom gets the same cursor-anchoring treatment (anchored
  // on the viewport center, since a keypress has no cursor position) as the mouse-driven paths below.
  useEffect(() => {
    function onZoomEvent(event: Event) {
      const detail = (event as CustomEvent<{ factor?: number; reset?: boolean }>).detail;
      if (detail.reset) resetZoom();
      else if (detail.factor) zoomAround(detail.factor);
    }
    window.addEventListener("vstudio:zoom", onZoomEvent);
    return () => window.removeEventListener("vstudio:zoom", onZoomEvent);
  }, [zoomAround, resetZoom]);

  /** Which track row a vertical pointer position falls on. Track rows are a uniform height in a
   *  single column, so this is arithmetic rather than a hit-test against every row. */
  const resolveTrackAt = useCallback(
    (clientY: number): string | null => {
      const lanes = lanesRef.current;
      const tracks = project?.sequence.tracks;
      if (!lanes || !tracks) return null;
      const index = Math.floor((clientY - lanes.getBoundingClientRect().top) / TRACK_HEIGHT);
      return index >= 0 && index < tracks.length ? tracks[index].id : null;
    },
    [project?.sequence.tracks]
  );

  // Moves the playhead marker and updates the ruler's aria-valuenow by writing directly to the DOM,
  // rather than through a `useEditorStore((s) => s.playhead)` selector. `PlaybackEngine` updates
  // `playhead` on every animation frame during playback — subscribing to it reactively here would
  // re-render this ENTIRE component, including every track and every `TimelineClip`, 30-60 times a
  // second, which is real, measurable jank competing with the preview's own canvas draw. Zustand's
  // core `subscribe` (no middleware here) has no selector overload, so the diff against the previous
  // value is done by hand.
  useEffect(() => {
    function apply(playhead: number) {
      if (markerRef.current) markerRef.current.style.left = `${playhead * pixelsPerSecond}px`;
      if (rulerRef.current) rulerRef.current.setAttribute("aria-valuenow", String(Math.round(playhead)));
    }
    apply(useEditorStore.getState().playhead);
    return useEditorStore.subscribe((state, prev) => {
      if (state.playhead !== prev.playhead) apply(state.playhead);
    });
  }, [pixelsPerSecond]);

  /** Press-then-drag anywhere on the ruler scrubs continuously — the interaction people reach for
   *  without being taught it, mouse OR touch (see `pointerEvents.ts`). */
  const scrub = useCallback(
    (event: React.MouseEvent | React.TouchEvent) => {
      setPlayhead(timeFromEvent(clientPoint(event).x));
      const remove = addDragListeners(
        (moveEvent) => setPlayhead(timeFromEvent(clientPoint(moveEvent).x)),
        () => remove()
      );
    },
    [setPlayhead, timeFromEvent]
  );

  /** Turns "dropped `sourceId` before/after `targetId`" into the `beforeTrackId` `ReorderTrackCommand`
   *  actually wants — "after `targetId`" means "before whatever CURRENTLY comes right after it", which
   *  only Timeline can resolve since it's the one holding the ordered track list. */
  function dropTrackOnRow(sourceId: string, targetId: string, position: "before" | "after") {
    setTrackDropIndicator(null);
    if (!project) return;
    const tracks = project.sequence.tracks;
    const beforeTrackId =
      position === "before" ? targetId : (tracks[tracks.findIndex((t) => t.id === targetId) + 1]?.id ?? null);
    run(new ReorderTrackCommand(sourceId, beforeTrackId));
  }

  if (!project) return null;

  const interval = tickInterval(pixelsPerSecond);
  const tickCount = Math.ceil(contentSeconds / interval) + 1;

  return (
    <section className="flex h-full min-h-0 flex-col border-t border-white/10 bg-[#0b0d12]">
      {/* flex-wrap rather than a fixed single row: "Timeline" + Add Track + zoom controls is tight
          enough to clip off-screen on a narrow phone otherwise, since this row has no scroll of its
          own — wrapping to a second line is a plain, no-JS way to guarantee nothing gets cut off. */}
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-white/10 px-3 py-1.5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-white/60">Timeline</h2>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => run(new AddTrackCommand("video"))}
            className="rounded px-2 py-1 text-[11px] text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            + Video
          </button>
          <button
            onClick={() => run(new AddTrackCommand("audio"))}
            className="rounded px-2 py-1 text-[11px] text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            + Audio
          </button>
          <span className="mx-1 h-4 w-px bg-white/10" />
          <button
            onClick={() => zoomAround(1 / 1.4)}
            aria-label="Zoom out"
            title="Zoom out (Ctrl/⌘ −)"
            className="rounded px-2 py-1 text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            −
          </button>
          <button
            onClick={() => resetZoom()}
            aria-label="Reset zoom"
            title="Reset zoom (Ctrl/⌘ 0)"
            className="min-w-[3.5ch] rounded px-1 py-1 text-center font-mono text-[11px] tabular-nums text-white/45 transition hover:bg-white/10 hover:text-white"
          >
            {Math.round((pixelsPerSecond / 60) * 100)}%
          </button>
          <button
            onClick={() => zoomAround(1.4)}
            aria-label="Zoom in"
            title="Zoom in (Ctrl/⌘ +)"
            className="rounded px-2 py-1 text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            +
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Track headers sit outside the horizontal scroll so they stay visible while scrubbing far
            along a long edit. */}
        <div className="flex shrink-0 flex-col" style={{ width: HEADER_WIDTH }}>
          <div style={{ height: RULER_HEIGHT }} className="border-b border-r border-white/10 bg-[#0d0f14]" />
          {/* `overflow-hidden` here (no scrollbar of its own) — this column's vertical position is
              driven by the lanes' own scroll via the transform below, so it always tracks exactly,
              rather than being a second independently-scrollable area that could drift out of sync. */}
          <div className="flex-1 overflow-hidden">
            <div ref={headerListRef}>
              {project.sequence.tracks.map((track) => (
                <TrackHeader
                  key={track.id}
                  track={track}
                  height={TRACK_HEIGHT}
                  dropIndicator={trackDropIndicator?.trackId === track.id ? trackDropIndicator.position : null}
                  onDragOverRow={(trackId, position) => setTrackDropIndicator({ trackId, position })}
                  onDropRow={dropTrackOnRow}
                  onDragEndRow={() => setTrackDropIndicator(null)}
                />
              ))}
            </div>
          </div>
        </div>

        <div
          ref={scrollRef}
          // Both axes scroll together in this one container now — with more than a handful of tracks,
          // `overflow-y-hidden` here used to CLIP the extra rows entirely rather than making them
          // reachable, silently hiding tracks with no way to scroll down to them. `scrollbar-none`
          // (see globals.css) keeps the scrolling itself while hiding the browser's own scrollbar
          // chrome — the rose playhead line and clip edges already communicate position and extent,
          // so a visible scrollbar track was just extra chrome, not information.
          className="scrollbar-none relative min-w-0 flex-1 overflow-auto"
          onScroll={() => {
            if (headerListRef.current) {
              headerListRef.current.style.transform = `translateY(${-(scrollRef.current?.scrollTop ?? 0)}px)`;
            }
          }}
        >
          <div style={{ width: contentWidth }} className="relative">
            <div
              ref={rulerRef}
              role="slider"
              aria-label="Playhead"
              aria-valuemin={0}
              aria-valuemax={Math.round(total)}
              aria-valuenow={Math.round(useEditorStore.getState().playhead)}
              tabIndex={0}
              onMouseDown={scrub}
              onTouchStart={scrub}
              style={{ height: RULER_HEIGHT }}
              // touch-none: without it, a touch-drag on the ruler also tries to pan/scroll the
              // Timeline's own scroll container underneath it, fighting the scrub.
              className="sticky top-0 z-20 touch-none cursor-ew-resize select-none border-b border-white/10 bg-[#0d0f14]"
            >
              {Array.from({ length: tickCount }, (_, i) => i * interval).map((seconds) => (
                <div
                  key={seconds}
                  style={{ left: seconds * pixelsPerSecond }}
                  className="absolute top-0 h-full border-l border-white/10 pl-1 text-[10px] leading-[26px] tabular-nums text-white/40"
                >
                  {formatTimecode(seconds, project.sequence.fps)}
                </div>
              ))}
            </div>

            <div ref={lanesRef} onClick={() => select([])}>
              {project.sequence.tracks.map((track) => (
                <div
                  key={track.id}
                  style={{ height: TRACK_HEIGHT }}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes("application/x-vstudio-asset")) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "copy";
                  }}
                  onDrop={(e) => {
                    const assetId = e.dataTransfer.getData("application/x-vstudio-asset");
                    if (!assetId) return;
                    e.preventDefault();
                    run(new AddClipCommand(track.id, assetId, Math.max(0, timeFromEvent(e.clientX))));
                  }}
                  className={`relative border-b border-white/10 ${
                    dropTrackId === track.id
                      ? "bg-sky-500/15 outline outline-1 -outline-offset-1 outline-sky-400/50"
                      : track.locked
                        ? "bg-white/[0.02]"
                        : "bg-white/[0.015] hover:bg-white/[0.03]"
                  }`}
                >
                  {track.clips.map((clip) => (
                    <TimelineClip
                      key={clip.id}
                      clip={clip}
                      track={track}
                      project={project}
                      pixelsPerSecond={pixelsPerSecond}
                      selected={selectedClipIds.includes(clip.id)}
                      assetName={assetNames.get(clip.assetId) ?? "Missing media"}
                      resolveTrackAt={resolveTrackAt}
                      onTargetTrackChange={setDropTrackId}
                    />
                  ))}
                </div>
              ))}
            </div>

            {/* Drawn last and made non-interactive so it's always visible above the clips without
                intercepting the drags that happen underneath it. */}
            <div
              ref={markerRef}
              style={{ left: useEditorStore.getState().playhead * pixelsPerSecond }}
              className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-rose-400"
            >
              <div className="absolute -left-[5px] top-0 h-2.5 w-2.5 rounded-b-sm bg-rose-400" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
