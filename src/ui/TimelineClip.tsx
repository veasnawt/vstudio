"use client";

import React, { useRef, useState } from "react";
import { MoveClipCommand, TrimClipCommand } from "../commands/index.ts";
import { clipDuration } from "../project/createProject.ts";
import type { Clip, Project, Track } from "../project/types.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { snapPoints, snapTime } from "../timeline/queries.ts";
import { formatDuration } from "../timeline/time.ts";
import { addDragListeners, clientPoint, preventDefaultIfMouse } from "./pointerEvents.ts";

/** Pixels the pointer must travel before a press turns into a drag. Without it, a slightly-shaky
 *  click to select a clip would register as a one-pixel move and push a pointless undo entry. */
const DRAG_THRESHOLD = 3;
/** How close (in pixels, so it feels the same at any zoom) an edge must come to a snap point. */
const SNAP_PIXELS = 8;

type DragMode = "move" | "trim-in" | "trim-out";

interface Props {
  clip: Clip;
  track: Track;
  project: Project;
  pixelsPerSecond: number;
  selected: boolean;
  assetName: string;
  /** Which track row a vertical pointer position falls on — supplied by the Timeline, which owns the
   *  row geometry. This is what makes dragging a clip from one track to another possible. */
  resolveTrackAt: (clientY: number) => string | null;
  /** Reports the track a drag is currently over (null when it's the clip's own track) so the Timeline
   *  can highlight the destination. */
  onTargetTrackChange: (trackId: string | null) => void;
}

export function TimelineClip({
  clip,
  track,
  project,
  pixelsPerSecond,
  selected,
  assetName,
  resolveTrackAt,
  onTargetTrackChange,
}: Props) {
  const run = useEditorStore((s) => s.run);
  const select = useEditorStore((s) => s.select);

  // Live drag feedback is local state, so dragging repaints this clip without touching the project
  // or the undo stack. Exactly one command is dispatched, on release.
  const [preview, setPreview] = useState<{ start: number; duration: number } | null>(null);
  // The same value mirrored into a ref. The mouse handlers below run outside React, so they can't
  // read `preview` (they'd see the value captured when the drag started) — and reading it inside a
  // `setPreview(current => …)` updater is worse: that updater runs during render, and dispatching a
  // command from there triggers "Cannot update a component while rendering a different component".
  // A ref is the correct place for a value that mouse handlers need to read imperatively.
  const previewRef = useRef<{ start: number; duration: number } | null>(null);
  const dragRef = useRef<{ mode: DragMode; startX: number; origin: Clip; moved: boolean } | null>(null);
  /** Destination track for an in-flight move. Starts as the clip's own track, so a purely horizontal
   *  drag behaves exactly as before. */
  const targetTrackRef = useRef<string>(track.id);

  function updatePreview(next: { start: number; duration: number } | null) {
    previewRef.current = next;
    setPreview(next);
  }

  const duration = preview?.duration ?? clipDuration(clip);
  const start = preview?.start ?? clip.timelineStart;

  function beginDrag(event: React.MouseEvent | React.TouchEvent, mode: DragMode) {
    if (track.locked) return;
    event.stopPropagation();
    preventDefaultIfMouse(event);
    select([clip.id]);

    const start = clientPoint(event);
    dragRef.current = { mode, startX: start.x, origin: { ...clip }, moved: false };
    targetTrackRef.current = track.id;
    // Read imperatively rather than via a reactive subscription — this only needs the CURRENT
    // playhead at the instant a drag starts, not a value that re-renders every clip on the timeline
    // 30-60 times a second during playback (which is exactly what a `useEditorStore((s) => s.playhead)`
    // subscription here used to do, for every clip, the whole time the preview was playing).
    const points = snapPoints(project, clip.id, useEditorStore.getState().playhead);

    function onMove(moveEvent: MouseEvent | TouchEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const point = clientPoint(moveEvent);
      const dx = point.x - drag.startX;
      if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD) return;
      drag.moved = true;

      const deltaSeconds = dx / pixelsPerSecond;
      const snapWindow = SNAP_PIXELS / pixelsPerSecond;
      const origin = drag.origin;
      const originDuration = origin.sourceOut - origin.sourceIn;

      if (drag.mode === "move") {
        // Vertical position picks the destination track. Only trimming is locked to one track — an
        // edge being dragged sideways has no meaningful "other track" to land on.
        const overTrackId = resolveTrackAt(point.y) ?? track.id;
        if (overTrackId !== targetTrackRef.current) {
          targetTrackRef.current = overTrackId;
          onTargetTrackChange(overTrackId === track.id ? null : overTrackId);
        }

        const rawStart = Math.max(0, origin.timelineStart + deltaSeconds);
        // Both edges are candidates for snapping; whichever lands closer wins, which is what makes
        // butting one clip up against another feel reliable.
        const snappedStart = snapTime(rawStart, points, snapWindow);
        const snappedEnd = snapTime(rawStart + originDuration, points, snapWindow) - originDuration;
        const best =
          Math.abs(snappedStart - rawStart) <= Math.abs(snappedEnd - rawStart) ? snappedStart : snappedEnd;
        updatePreview({ start: Math.max(0, best), duration: originDuration });
      } else if (drag.mode === "trim-in") {
        const rawEdge = snapTime(origin.timelineStart + deltaSeconds, points, snapWindow);
        // Clamped here only for the visual preview; the authoritative clamping (against the source's
        // real extent and the one-frame minimum) happens in trimClip when the command runs.
        const edge = Math.min(Math.max(0, rawEdge), origin.timelineStart + originDuration - 1 / project.sequence.fps);
        updatePreview({ start: edge, duration: origin.timelineStart + originDuration - edge });
      } else {
        const rawEdge = snapTime(origin.timelineStart + originDuration + deltaSeconds, points, snapWindow);
        const edge = Math.max(rawEdge, origin.timelineStart + 1 / project.sequence.fps);
        updatePreview({ start: origin.timelineStart, duration: edge - origin.timelineStart });
      }
    }

    function onUp() {
      removeListeners();
      const drag = dragRef.current;
      dragRef.current = null;

      const final = previewRef.current;
      const targetTrackId = targetTrackRef.current;
      updatePreview(null);
      onTargetTrackChange(null);
      targetTrackRef.current = track.id;

      if (drag?.moved && final) {
        // moveClip rejects a video↔audio track mismatch itself, surfacing a status message rather
        // than silently dropping the clip somewhere it can never render.
        if (drag.mode === "move") run(new MoveClipCommand(clip.id, targetTrackId, final.start));
        else if (drag.mode === "trim-in") run(new TrimClipCommand(clip.id, "in", final.start));
        else run(new TrimClipCommand(clip.id, "out", final.start + final.duration));
      }
    }

    const removeListeners = addDragListeners(onMove, onUp);
  }

  const isAudio = track.kind === "audio";

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${assetName}, ${formatDuration(duration)}`}
      onMouseDown={(e) => beginDrag(e, "move")}
      onTouchStart={(e) => beginDrag(e, "move")}
      onClick={(e) => {
        e.stopPropagation();
        select([clip.id]);
      }}
      style={{
        left: start * pixelsPerSecond,
        width: Math.max(2, duration * pixelsPerSecond),
      }}
      // touch-none: without it, a touch-drag on a clip also tries to pan/scroll the timeline
      // underneath it, same reasoning as the ruler's own touch-none (see Timeline.tsx).
      className={`group absolute top-1 bottom-1 touch-none overflow-hidden rounded-md border text-left transition-colors ${
        track.locked ? "cursor-default" : "cursor-grab active:cursor-grabbing"
      } ${
        selected
          ? "border-sky-300 bg-sky-500/35 ring-1 ring-sky-300/70"
          : isAudio
            ? "border-emerald-400/40 bg-emerald-500/20 hover:bg-emerald-500/30"
            : "border-sky-400/40 bg-sky-500/20 hover:bg-sky-500/30"
      } ${preview ? "opacity-80" : ""}`}
    >
      <span className="pointer-events-none block truncate px-2 py-1 text-[11px] font-medium text-white/90">
        {assetName}
      </span>

      {!track.locked && (
        <>
          {/* Trim handles. Wider below `lg` (12px vs 8px) since a fingertip needs a bigger target
              than a mouse cursor does — an edge that's hard to grab is the single most common source
              of frustration in a timeline, and on touch an 8px hit area is close to ungrabbable. */}
          <div
            role="separator"
            aria-label="Trim clip start"
            onMouseDown={(e) => beginDrag(e, "trim-in")}
            onTouchStart={(e) => beginDrag(e, "trim-in")}
            className="absolute inset-y-0 left-0 w-3 touch-none cursor-ew-resize bg-white/0 transition group-hover:bg-white/25 lg:w-2"
          />
          <div
            role="separator"
            aria-label="Trim clip end"
            onMouseDown={(e) => beginDrag(e, "trim-out")}
            onTouchStart={(e) => beginDrag(e, "trim-out")}
            className="absolute inset-y-0 right-0 w-3 touch-none cursor-ew-resize bg-white/0 transition group-hover:bg-white/25 lg:w-2"
          />
        </>
      )}
    </div>
  );
}
