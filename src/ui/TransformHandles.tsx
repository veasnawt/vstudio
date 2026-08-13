"use client";

import React, { useEffect, useRef, useState } from "react";
import { SetClipTransformCommand } from "../commands/index.ts";
import { findAsset, findClip } from "../project/createProject.ts";
import type { ClipTransform } from "../project/types.ts";
import { IDENTITY_TRANSFORM } from "../project/types.ts";
import { computeTransformedBox } from "../playback/transformGeometry.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { clipAtTime } from "../timeline/queries.ts";
import { addDragListeners, clientPoint, preventDefaultIfMouse } from "./pointerEvents.ts";

/** Pixels the pointer must travel before a press counts as a drag rather than a stray click — same
 *  reasoning and same threshold as `TimelineClip`'s own `DRAG_THRESHOLD`: without it, a slightly-shaky
 *  click on a handle would push an imperceptible-but-real undo entry. */
const DRAG_THRESHOLD = 3;
// 16px, not the tighter 12px a mouse cursor could still land precisely — this is a real touch target
// now (see beginDrag's touch support below), and 12px is close to ungrabbable with a fingertip.
const HANDLE_SIZE = 16;
const ROTATE_HANDLE_OFFSET = 28;

type DragMode = "move" | "scale" | "rotate";

const CORNERS: { x: number; y: number; cursor: string; label: string }[] = [
  { x: 0, y: 0, cursor: "cursor-nwse-resize", label: "top-left" },
  { x: 1, y: 0, cursor: "cursor-nesw-resize", label: "top-right" },
  { x: 0, y: 1, cursor: "cursor-nesw-resize", label: "bottom-left" },
  { x: 1, y: 1, cursor: "cursor-nwse-resize", label: "bottom-right" },
];

/** Draggable Position/Scale/Rotation handles overlaid on the Preview canvas — the on-canvas half of
 *  transform editing (Crop stays numeric-only in the Inspector). Shown only when exactly one clip is
 *  selected AND it's the clip the compositor is CURRENTLY drawing — handles floating over content
 *  they don't belong to (a different clip, a gap) would be actively misleading rather than merely
 *  unhelpful.
 *
 *  Uses the exact local-preview-then-single-commit drag pattern `TimelineClip` established: a drag
 *  updates only local state (so React re-renders freely without touching the project or the undo
 *  stack on every pixel of movement), and exactly ONE `SetClipTransformCommand` is dispatched on
 *  release. */
export function TransformHandles({ canvas }: { canvas: HTMLCanvasElement | null }) {
  const project = useEditorStore((s) => s.project);
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds);
  const playhead = useEditorStore((s) => s.playhead);
  const run = useEditorStore((s) => s.run);

  const [preview, setPreview] = useState<ClipTransform | null>(null);
  const previewRef = useRef<ClipTransform | null>(null);
  const dragRef = useRef<{
    mode: DragMode;
    origin: ClipTransform;
    startClientX: number;
    startClientY: number;
    centerScreenX: number;
    centerScreenY: number;
    startDistance: number;
    startAngleOffset: number;
    moved: boolean;
  } | null>(null);

  function updatePreview(next: ClipTransform | null) {
    previewRef.current = next;
    setPreview(next);
  }

  // The playhead already drives a re-render every animation frame during playback, so the handles'
  // position (which reads `canvas.getBoundingClientRect()` fresh on every render) stays correct while
  // playing without any extra machinery. The gap this closes is a WINDOW resize while paused, which
  // changes the canvas's on-screen size/position with no store state changing to trigger a re-render
  // on its own.
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    if (!canvas) return;
    const observer = new ResizeObserver(() => forceUpdate((n) => n + 1));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [canvas]);

  const resolved = (() => {
    if (!project || !canvas || selectedClipIds.length !== 1) return null;
    const found = findClip(project, selectedClipIds[0]);
    if (!found || found.track.kind !== "video") return null;
    // Not just "is this clip selected" — is it the one actually under the playhead right now.
    if (clipAtTime(found.track, playhead)?.id !== found.clip.id) return null;
    const asset = findAsset(project, found.clip.assetId);
    if (!asset?.width || !asset.height) return null;
    return { clipId: found.clip.id, savedTransform: found.clip.transform, assetWidth: asset.width, assetHeight: asset.height, sequence: project.sequence };
  })();

  if (!resolved || !canvas) return null;

  const transform = preview ?? resolved.savedTransform ?? IDENTITY_TRANSFORM;
  const box = computeTransformedBox(resolved.assetWidth, resolved.assetHeight, resolved.sequence.width, resolved.sequence.height, transform);
  if (!box) return null;

  // The canvas backing store is full sequence resolution but displayed smaller via CSS — every
  // screen measurement (handle position, drag deltas) has to go through this ratio to land in the
  // right place and track the pointer 1:1.
  const canvasRect = canvas.getBoundingClientRect();
  const cssScale = canvas.width > 0 ? canvasRect.width / canvas.width : 1;
  const cssWidth = box.width * cssScale;
  const cssHeight = box.height * cssScale;
  const cssCenterX = canvasRect.left + box.centerX * cssScale;
  const cssCenterY = canvasRect.top + box.centerY * cssScale;

  function beginDrag(startEvent: React.MouseEvent | React.TouchEvent, mode: DragMode) {
    startEvent.stopPropagation();
    preventDefaultIfMouse(startEvent);
    const origin = resolved!.savedTransform ?? IDENTITY_TRANSFORM;
    const start = clientPoint(startEvent);
    const startAngle = Math.atan2(start.y - cssCenterY, start.x - cssCenterX);

    dragRef.current = {
      mode,
      origin,
      startClientX: start.x,
      startClientY: start.y,
      centerScreenX: cssCenterX,
      centerScreenY: cssCenterY,
      startDistance: Math.hypot(start.x - cssCenterX, start.y - cssCenterY),
      // Recorded once so the handle doesn't visually "jump" to realign with the cursor the instant
      // the drag starts — subsequent rotation is this offset applied to wherever the pointer is now.
      startAngleOffset: startAngle - (origin.rotationDeg * Math.PI) / 180,
      moved: false,
    };

    function onMove(moveEvent: MouseEvent | TouchEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const point = clientPoint(moveEvent);
      if (!drag.moved) {
        const traveled = Math.hypot(point.x - drag.startClientX, point.y - drag.startClientY);
        if (traveled < DRAG_THRESHOLD) return;
        drag.moved = true;
      }

      if (drag.mode === "move") {
        const dxCss = point.x - drag.startClientX;
        const dyCss = point.y - drag.startClientY;
        updatePreview({ ...drag.origin, offsetX: drag.origin.offsetX + dxCss / cssScale, offsetY: drag.origin.offsetY + dyCss / cssScale });
      } else if (drag.mode === "scale") {
        const distance = Math.hypot(point.x - drag.centerScreenX, point.y - drag.centerScreenY);
        const ratio = drag.startDistance > 0 ? distance / drag.startDistance : 1;
        updatePreview({ ...drag.origin, scale: drag.origin.scale * ratio });
      } else {
        const angle = Math.atan2(point.y - drag.centerScreenY, point.x - drag.centerScreenX);
        updatePreview({ ...drag.origin, rotationDeg: ((angle - drag.startAngleOffset) * 180) / Math.PI });
      }
    }

    function onUp() {
      removeListeners();
      const drag = dragRef.current;
      dragRef.current = null;
      const final = previewRef.current;
      updatePreview(null);
      if (drag?.moved && final) run(new SetClipTransformCommand(resolved!.clipId, final));
    }

    const removeListeners = addDragListeners(onMove, onUp);
  }

  return (
    <div
      style={{
        position: "fixed",
        left: cssCenterX,
        top: cssCenterY,
        width: cssWidth,
        height: cssHeight,
        transform: `translate(-50%, -50%) rotate(${transform.rotationDeg}deg)`,
        zIndex: 40,
      }}
      className="pointer-events-none"
    >
      <div
        role="button"
        tabIndex={0}
        aria-label="Move clip"
        onMouseDown={(e) => beginDrag(e, "move")}
        onTouchStart={(e) => beginDrag(e, "move")}
        className="pointer-events-auto absolute inset-0 touch-none cursor-move border-2 border-sky-400/80"
      />

      {CORNERS.map(({ x, y, cursor, label }) => (
        <div
          key={label}
          role="button"
          tabIndex={0}
          aria-label={`Resize clip (${label})`}
          onMouseDown={(e) => beginDrag(e, "scale")}
          onTouchStart={(e) => beginDrag(e, "scale")}
          style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: HANDLE_SIZE, height: HANDLE_SIZE }}
          className={`pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 touch-none rounded-full border border-white bg-sky-400 shadow ${cursor}`}
        />
      ))}

      {/* Connecting line is purely visual — decorative, so it's excluded from the accessibility tree
          rather than announced as an unlabeled element. */}
      <div
        aria-hidden
        style={{ left: "50%", top: -ROTATE_HANDLE_OFFSET, height: ROTATE_HANDLE_OFFSET }}
        className="pointer-events-none absolute w-px -translate-x-1/2 bg-white/50"
      />
      <div
        role="button"
        tabIndex={0}
        aria-label="Rotate clip"
        onMouseDown={(e) => beginDrag(e, "rotate")}
        onTouchStart={(e) => beginDrag(e, "rotate")}
        style={{ left: "50%", top: -ROTATE_HANDLE_OFFSET, width: HANDLE_SIZE, height: HANDLE_SIZE }}
        className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 touch-none cursor-grab rounded-full border border-white bg-emerald-400 shadow"
      />
    </div>
  );
}
