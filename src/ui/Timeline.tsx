"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AddTrackCommand, ReorderTrackCommand } from "../commands/index.ts";
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
  const projectId = useEditorStore((s) => s.projectId);
  const pixelsPerSecond = useEditorStore((s) => s.pixelsPerSecond);
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  // Raw (possibly-null, possibly-unsorted) values — selected directly rather than via the store's own
  // `exportRange()` getter, which returns a freshly-allocated object every call and would defeat
  // Zustand's reference-equality re-render check. Sorted/clamped locally instead, right below.
  const exportRangeStart = useEditorStore((s) => s.exportRangeStart);
  const exportRangeEnd = useEditorStore((s) => s.exportRangeEnd);
  const setExportRangeStart = useEditorStore((s) => s.setExportRangeStart);
  const setExportRangeEnd = useEditorStore((s) => s.setExportRangeEnd);
  const clearExportRange = useEditorStore((s) => s.clearExportRange);
  const select = useEditorStore((s) => s.select);
  const zoomBy = useEditorStore((s) => s.zoomBy);
  const resetZoom = useEditorStore((s) => s.resetZoom);
  const run = useEditorStore((s) => s.run);
  const assetDrag = useEditorStore((s) => s.assetDrag);
  const setResolveTimelineDropTarget = useEditorStore((s) => s.setResolveTimelineDropTarget);
  const recording = useEditorStore((s) => s.recording);

  const scrollRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const headerListRef = useRef<HTMLDivElement>(null);
  /** True while the user has the ruler pressed and is actively dragging it — see the playhead-follow
   *  effect's own comment on why auto-follow is suppressed during this. */
  const isScrubbingRef = useRef(false);
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
  /** Client X of the pointer while it's over the ruler (hovering OR actively scrubbing) — null means
   *  "don't show the tooltip". Only the X coordinate is stored; the TIME it corresponds to is derived
   *  fresh on every render from `timeFromEvent`, which already accounts for the container's current
   *  scroll position, so this never needs to be kept in sync with scrolling by hand. */
  const [hoverX, setHoverX] = useState<number | null>(null);
  /** Mirrors `scrollRef.current.scrollLeft`/`.clientWidth` into React state — the persistent
   *  horizontal scrollbar below the tracks (see `HScrollbar`) needs both to size and position its
   *  thumb, and native scrolling doesn't trigger a re-render on its own. `scrollLeft` updates via the
   *  scroll container's own `onScroll` below; `viewportWidth` via a `ResizeObserver`, same pattern
   *  `TransformHandles` already uses to track its canvas's live on-screen size. */
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setViewportWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A recording still in progress can push past the committed timeline length before it's a real
  // clip `sequenceDuration` would count — folded in here (mirroring `setPlayhead`'s own same fix) so
  // the lane area/ruler don't stay narrower than the indicator actually growing inside them.
  const total = Math.max(project ? sequenceDuration(project) : 0, recording ? recording.start + recording.elapsedSeconds : 0);
  const contentSeconds = Math.max(total + TRAILING_SECONDS, 30);
  const contentWidth = contentSeconds * pixelsPerSecond;

  // Sorted/clamped the same way the store's own `exportRange()` getter does (see that method's own
  // comment) — kept in sync by hand rather than calling it, since this needs to be a REACTIVE value
  // derived from the two primitive selectors above, not a fresh object allocated on every call.
  const hasExportRange = exportRangeStart !== null || exportRangeEnd !== null;
  const rawRangeStart = Math.min(Math.max(0, exportRangeStart ?? 0), total);
  const rawRangeEnd = Math.min(Math.max(0, exportRangeEnd ?? total), total);
  const exportStart = Math.min(rawRangeStart, rawRangeEnd);
  const exportEnd = Math.max(rawRangeStart, rawRangeEnd);

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

  // Registered into the store so MediaLibrary's own touch drag (native HTML5 drag-and-drop never
  // fires from touch input) can hit-test its drop point against these tracks on release, without
  // MediaLibrary needing to know anything about this component's scroll offset or row layout — see
  // `assetDrag`/`resolveTimelineDropTarget`'s own doc comments in editorStore.ts.
  useEffect(() => {
    setResolveTimelineDropTarget((clientX, clientY) => {
      const trackId = resolveTrackAt(clientY);
      if (!trackId) return null;
      return { trackId, time: Math.max(0, timeFromEvent(clientX)) };
    });
    return () => setResolveTimelineDropTarget(null);
  }, [resolveTrackAt, timeFromEvent, setResolveTimelineDropTarget]);

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

      // Auto-follow: once the playhead scrolls past the right edge of the visible timeline (during
      // playback, or a big jump like "Go to end"), snap the view forward so it reappears at the LEFT
      // edge — matching Premiere/Resolve rather than a smooth continuous scroll, which would fight the
      // viewport's own width by constantly re-centering. Skipped entirely while the user is dragging
      // the ruler themselves (`isScrubbingRef`): their own cursor position IS the reference point
      // during a manual scrub, so jumping the view out from under it mid-drag would be actively
      // disorienting rather than helpful.
      const container = scrollRef.current;
      if (container && !isScrubbingRef.current) {
        const playheadPx = playhead * pixelsPerSecond;
        const rightEdge = container.scrollLeft + container.clientWidth;
        if (playheadPx > rightEdge) {
          container.scrollLeft = Math.max(0, Math.min(playheadPx, container.scrollWidth - container.clientWidth));
        }
      }
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
      isScrubbingRef.current = true;
      const start = clientPoint(event);
      setPlayhead(timeFromEvent(start.x));
      setHoverX(start.x);
      const remove = addDragListeners(
        (moveEvent) => {
          const point = clientPoint(moveEvent);
          setPlayhead(timeFromEvent(point.x));
          setHoverX(point.x);
        },
        () => {
          isScrubbingRef.current = false;
          remove();
          // Touch has no hover state to fall back to afterward — a finger lifted off the ruler leaves
          // no cursor sitting there the way a mouse would, so the tooltip has nothing left to track.
          if ("touches" in event) setHoverX(null);
        }
      );
    },
    [setPlayhead, timeFromEvent]
  );

  /** Drag either export-range flag to nudge it — the fine-adjustment half of the "I/O sets it at the
   *  playhead, drag refines it" pair (see `VStudioApp.tsx`'s own `I`/`O` shortcut handlers for the
   *  other half). `stopPropagation` keeps this from ALSO registering as a `scrub` press on the ruler
   *  underneath it, which would yank the playhead to the same spot the instant you grab the flag. */
  const scrubExportStart = useCallback(
    (event: React.MouseEvent | React.TouchEvent) => {
      event.stopPropagation();
      const point = clientPoint(event);
      setExportRangeStart(timeFromEvent(point.x));
      const remove = addDragListeners(
        (moveEvent) => setExportRangeStart(timeFromEvent(clientPoint(moveEvent).x)),
        () => remove()
      );
    },
    [setExportRangeStart, timeFromEvent]
  );
  const scrubExportEnd = useCallback(
    (event: React.MouseEvent | React.TouchEvent) => {
      event.stopPropagation();
      const point = clientPoint(event);
      setExportRangeEnd(timeFromEvent(point.x));
      const remove = addDragListeners(
        (moveEvent) => setExportRangeEnd(timeFromEvent(clientPoint(moveEvent).x)),
        () => remove()
      );
    },
    [setExportRangeEnd, timeFromEvent]
  );

  // Persistent horizontal scrollbar geometry — the track spans the scroll viewport's own width, and
  // the thumb's size/position are the standard scrollbar ratios against `contentWidth`. Floored at
  // 24px so the thumb never shrinks to an ungrabbable sliver on a long edit at low zoom. When there's
  // nothing to scroll (`contentWidth <= viewportWidth`), the thumb simply fills the track and dragging
  // is a no-op (`scrollableTrack` floors at 1 to keep the ratio math from dividing by zero).
  const maxScrollLeft = Math.max(0, contentWidth - viewportWidth);
  const thumbWidth = contentWidth > 0 ? Math.max(24, Math.min(viewportWidth, (viewportWidth / contentWidth) * viewportWidth)) : viewportWidth;
  const scrollableTrack = Math.max(1, viewportWidth - thumbWidth);
  const thumbLeft = maxScrollLeft > 0 ? (scrollLeft / maxScrollLeft) * scrollableTrack : 0;

  function scrollTo(next: number) {
    const clamped = Math.min(maxScrollLeft, Math.max(0, next));
    if (scrollRef.current) scrollRef.current.scrollLeft = clamped;
    setScrollLeft(clamped);
  }

  /** Dragging the thumb itself — pointer-pixel delta converted to scroll-pixel delta via the same
   *  ratio the thumb's own size already encodes (a `scrollableTrack`-pixel drag covers the FULL
   *  `maxScrollLeft` range, same as any native scrollbar). */
  function beginScrollbarThumbDrag(event: React.MouseEvent | React.TouchEvent) {
    event.stopPropagation();
    const start = clientPoint(event);
    const startScrollLeft = scrollLeft;
    const remove = addDragListeners(
      (moveEvent) => {
        const point = clientPoint(moveEvent);
        scrollTo(startScrollLeft + (point.x - start.x) * (maxScrollLeft / scrollableTrack));
      },
      () => remove()
    );
  }

  /** Clicking the TRACK itself (not the thumb, which stops propagation before this ever fires) jumps
   *  straight there — the thumb re-centers on the click position, the same "click to jump" affordance
   *  a native scrollbar's track gives you. */
  function jumpScrollbarTrack(event: React.MouseEvent) {
    const rect = event.currentTarget.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    scrollTo(maxScrollLeft * ((clickX - thumbWidth / 2) / scrollableTrack));
  }

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
        {hasExportRange && (
          // Same amber as the in/out markers themselves — the visual link makes it obvious this
          // button is what removes THOSE, not some unrelated action. Also reachable via Shift+X (see
          // VStudioApp.tsx) — this is the discoverable version for anyone who wouldn't otherwise know
          // the shortcut, or the "Reset to full timeline" link buried inside the Export dialog.
          <button
            onClick={() => clearExportRange()}
            aria-label="Clear export range"
            title="Clear export in/out range (Shift+X)"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-amber-300/80 transition hover:bg-amber-500/15 hover:text-amber-200"
          >
            × Range
          </button>
        )}
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
          <button
            onClick={() => run(new AddTrackCommand("text"))}
            className="rounded px-2 py-1 text-[11px] text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            + Text
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
          id="vstudio-timeline-lanes"
          // Both axes scroll together in this one container now — with more than a handful of tracks,
          // `overflow-y-hidden` here used to CLIP the extra rows entirely rather than making them
          // reachable, silently hiding tracks with no way to scroll down to them. `scrollbar-none`
          // (see globals.css) keeps the scrolling itself while hiding the browser's own thin OS-style
          // scrollbar chrome on BOTH axes — vertical stays gesture-only (wheel/trackpad; track count
          // is usually small, and the header column already shows where you are), but horizontal gets
          // its own deliberate, persistent, always-visible replacement below (`HScrollbar`) instead of
          // nothing: with more than a few seconds of footage, "scroll right" has no other discoverable
          // affordance at all (a plain wheel scrolls vertically here, and Shift+wheel — the native
          // escape hatch — isn't something most people know to reach for).
          className="scrollbar-none relative min-w-0 flex-1 overflow-auto"
          onScroll={() => {
            if (headerListRef.current) {
              headerListRef.current.style.transform = `translateY(${-(scrollRef.current?.scrollTop ?? 0)}px)`;
            }
            setScrollLeft(scrollRef.current?.scrollLeft ?? 0);
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
              onMouseMove={(e) => setHoverX(e.clientX)}
              onMouseLeave={() => setHoverX(null)}
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
                  className={`relative border-b border-white/10 ${
                    // Two independent reasons a track can be a drop target: a clip already on the
                    // timeline being dragged onto a DIFFERENT track (`dropTrackId`, reported by
                    // `TimelineClip`), or an asset being dragged in from the Media Library — mouse via
                    // native drag-and-drop's own hover state (no highlight needed here, the browser
                    // draws its own), touch via `assetDrag`'s live position (see its own doc comment)
                    // hit-tested the same way `resolveTimelineDropTarget` does for the actual drop.
                    dropTrackId === track.id || (assetDrag && resolveTrackAt(assetDrag.clientY) === track.id)
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
                      projectId={projectId}
                      pixelsPerSecond={pixelsPerSecond}
                      selected={selectedClipIds.includes(clip.id)}
                      assetName={assetNames.get(clip.assetId) ?? "Missing media"}
                      resolveTrackAt={resolveTrackAt}
                      onTargetTrackChange={setDropTrackId}
                    />
                  ))}
                  {recording && recording.trackId === track.id && (
                    // A growing placeholder for a voiceover still being captured — no real `Clip`
                    // exists yet (see `VoiceoverRecorder`), so this is a plain overlay, not a
                    // `TimelineClip`. `pointer-events-none`: nothing to select/drag before it's a real
                    // clip. The pulse keeps going into "finalizing" (import in flight after Stop) so
                    // the indicator never just vanishes and pops back in a moment later.
                    <div
                      aria-hidden
                      className={`pointer-events-none absolute top-1 bottom-1 z-10 flex items-center gap-1.5 overflow-hidden rounded-md border border-rose-400/50 bg-rose-500/25 px-2 text-[11px] font-medium text-rose-100 ${
                        recording.phase === "finalizing" ? "opacity-60" : ""
                      }`}
                      style={{
                        left: recording.start * pixelsPerSecond,
                        width: Math.max(2, recording.elapsedSeconds * pixelsPerSecond),
                      }}
                    >
                      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-rose-300" />
                      <span className="truncate">
                        {recording.phase === "recording" ? "Recording…" : "Finishing…"}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Export range dimming: darkens whatever falls OUTSIDE the selected in/out range, so
                it's obvious at a glance which portion of the timeline will actually render.
                `pointer-events-none` — clips underneath (even dimmed ones) stay fully draggable/
                selectable, since dimming is purely a visual cue, never a lock. Only rendered once a
                range has actually been set (`hasExportRange`) — otherwise this would be permanent
                visual noise over the default "export everything" state every project starts in.
                `top: RULER_HEIGHT` keeps the ruler's own timecodes legible; only the lane area (where
                the clips actually live) gets dimmed. */}
            {hasExportRange && exportStart > 0 && (
              <div
                aria-hidden
                style={{ left: 0, width: exportStart * pixelsPerSecond, top: RULER_HEIGHT }}
                className="pointer-events-none absolute bottom-0 z-20 bg-black/55"
              />
            )}
            {hasExportRange && exportEnd < total && (
              <div
                aria-hidden
                style={{ left: exportEnd * pixelsPerSecond, width: Math.max(0, contentWidth - exportEnd * pixelsPerSecond), top: RULER_HEIGHT }}
                className="pointer-events-none absolute bottom-0 z-20 bg-black/55"
              />
            )}

            {/* Export range markers — same shape/positioning convention as the playhead marker below,
                amber instead of rose so the two are never confused. Unlike the playhead, each has a
                real drag handle (the small flag): `I`/`O` (see VStudioApp.tsx) set them at the current
                playhead from nothing, and the flag refines an already-set point from there. Each is
                independent — setting only an out-point (leaving in at the implicit start) is valid. */}
            {exportRangeStart !== null && (
              <div style={{ left: exportStart * pixelsPerSecond }} className="absolute top-0 bottom-0 z-30 w-px bg-amber-400">
                <div
                  role="slider"
                  aria-label="Export range start"
                  aria-valuemin={0}
                  aria-valuemax={Math.round(total)}
                  aria-valuenow={Math.round(exportStart)}
                  tabIndex={0}
                  onMouseDown={scrubExportStart}
                  onTouchStart={scrubExportStart}
                  className="absolute -left-[5px] top-0 h-2.5 w-2.5 cursor-ew-resize touch-none rounded-b-sm bg-amber-400"
                />
              </div>
            )}
            {exportRangeEnd !== null && (
              <div style={{ left: exportEnd * pixelsPerSecond }} className="absolute top-0 bottom-0 z-30 w-px bg-amber-400">
                <div
                  role="slider"
                  aria-label="Export range end"
                  aria-valuemin={0}
                  aria-valuemax={Math.round(total)}
                  aria-valuenow={Math.round(exportEnd)}
                  tabIndex={0}
                  onMouseDown={scrubExportEnd}
                  onTouchStart={scrubExportEnd}
                  className="absolute -left-[5px] top-0 h-2.5 w-2.5 cursor-ew-resize touch-none rounded-b-sm bg-amber-400"
                />
              </div>
            )}

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

      {/* Persistent horizontal scrollbar — see the scroll container's own comment on why this exists
          instead of relying on the browser's native (hidden, gesture-only) one. Offset by
          `HEADER_WIDTH` so it lines up under the scrollable content, not the fixed track-headers
          column beside it. */}
      <div className="flex shrink-0 border-t border-white/5 bg-[#0b0d12] py-1 pr-2">
        <div style={{ width: HEADER_WIDTH }} className="shrink-0" />
        <div
          role="scrollbar"
          aria-controls="vstudio-timeline-lanes"
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={Math.round(maxScrollLeft)}
          aria-valuenow={Math.round(scrollLeft)}
          onMouseDown={jumpScrollbarTrack}
          className="relative min-w-0 flex-1 cursor-pointer"
          style={{ height: 10 }}
        >
          <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/5" />
          <div
            onMouseDown={beginScrollbarThumbDrag}
            onTouchStart={beginScrollbarThumbDrag}
            title="Scroll timeline"
            style={{ left: thumbLeft, width: thumbWidth }}
            className="absolute top-1/2 h-2 -translate-y-1/2 touch-none rounded-full bg-white/25 transition-colors hover:bg-white/40 active:bg-sky-400/70"
          />
        </div>
      </div>

      {/* Follows the cursor while hovering OR actively scrubbing the ruler — `position: fixed` (not
          relative to the scrolling content) so it never gets clipped by `overflow-auto` and never needs
          its own scroll-offset math the way the playhead marker above does. Only reads `hoverX`
          (screen space); the TIME shown is recomputed from it on every render via `timeFromEvent`, so
          it can never drift out of sync with the container's current scroll position the way a
          separately-stored time value could if scrolling happened without a matching update. */}
      {hoverX !== null && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-40 -translate-x-1/2 rounded bg-black/90 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-white shadow-lg"
          style={{
            left: hoverX,
            top: (rulerRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
          }}
        >
          {formatTimecode(Math.max(0, timeFromEvent(hoverX)), project.sequence.fps)}
        </div>
      )}
    </section>
  );
}
