"use client";

import React, { useRef, useState } from "react";
import { findAsset, findClip } from "../project/createProject.ts";
import { mapSequenceRectToSourceRect, mapSourceRectToSequenceRect } from "../playback/maskGeometry.ts";
import { computeTransformedBox } from "../playback/transformGeometry.ts";
import { IDENTITY_TRANSFORM } from "../project/types.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { clipAtTime } from "../timeline/queries.ts";
import { addDragListeners, clientPoint, preventDefaultIfMouse } from "./pointerEvents.ts";
import { useTranslation } from "../i18n/useTranslation.ts";

const DRAG_THRESHOLD = 3;

/** Drag-to-draw rectangle overlay for the "Remove Object" tool — the on-canvas half of the Inspector's
 *  "Remove Object" section, structurally parallel to `TransformHandles` (same resolved-clip lookup,
 *  same `cssScale` screen↔sequence conversion, same deferred-threshold drag pattern) but much simpler:
 *  one gesture (draw a rectangle), no scale/rotate handles, and it's armed EXPLICITLY by the Inspector
 *  rather than merely following selection — `TransformHandles` already owns whatever happens on a
 *  plain click/drag of a selected clip's box, so this needs its own distinct "the user asked to draw a
 *  region" signal to avoid the two overlays fighting over the same mousedown. */
export function RemoveObjectOverlay({ canvas }: { canvas: HTMLCanvasElement | null }) {
  const project = useEditorStore((s) => s.project);
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds);
  const playhead = useEditorStore((s) => s.playhead);
  const armedClipId = useEditorStore((s) => s.removeObjectArmedClipId);
  const committedRect = useEditorStore((s) => s.removeObjectRect);
  const setRemoveObjectRect = useEditorStore((s) => s.setRemoveObjectRect);
  const t = useTranslation();

  const [liveScreenRect, setLiveScreenRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  // Mirrors `liveScreenRect` for `onMove`/`onUp` to read — the same pattern `TransformHandles`'
  // `updatePreview` already uses (see its own comment). `onMove`/`onUp` are plain functions created
  // ONCE per `beginDraw()` call (at mousedown), closing over whatever `liveScreenRect` state value
  // existed at THAT render — they never see later `setLiveScreenRect` calls update it, so `onUp`
  // reading the STATE directly would always see `null` (its value at drag start) and silently drop
  // every completed drag. A ref written alongside every `setLiveScreenRect` call sidesteps this
  // entirely: refs are mutable and read fresh regardless of which render's closure is doing the
  // reading. Confirmed as a real, reproducible bug during this feature's own end-to-end testing
  // (a real mouse drag never committed a rect) before this fix — not a hypothetical.
  const liveScreenRectRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);

  function updateLiveScreenRect(next: { x: number; y: number; width: number; height: number } | null) {
    liveScreenRectRef.current = next;
    setLiveScreenRect(next);
  }

  const resolved = (() => {
    if (!project || !canvas || selectedClipIds.length !== 1) return null;
    const found = findClip(project, selectedClipIds[0]);
    if (!found || found.track.kind !== "video") return null;
    if (clipAtTime(found.track, playhead)?.id !== found.clip.id) return null;
    const asset = findAsset(project, found.clip.assetId);
    // Video only, matching the Inspector's own gating for this tool — ProPainter has no still-image
    // mode, and animating a single image through a video-inpainting model has nothing to propagate
    // across (see the Inspector section's own comment on why this is a v1 scope cut, not an oversight).
    if (!asset || asset.kind !== "video" || !asset.width || !asset.height) return null;
    return { clipId: found.clip.id, transform: found.clip.transform ?? IDENTITY_TRANSFORM, assetWidth: asset.width, assetHeight: asset.height, sequence: project.sequence };
  })();

  const isArmed = resolved !== null && armedClipId === resolved.clipId;
  const rectForThisClip = resolved !== null && committedRect?.clipId === resolved.clipId ? committedRect : null;

  if (!resolved || !canvas || (!isArmed && !rectForThisClip)) return null;

  const box = computeTransformedBox(resolved.assetWidth, resolved.assetHeight, resolved.sequence.width, resolved.sequence.height, resolved.transform);
  if (!box) return null;

  // Same conversion TransformHandles uses — see its own comment on why sequence resolution, not
  // `canvas.width` (the backing store is capped for perf and no longer equals it 1:1).
  const canvasRect = canvas.getBoundingClientRect();
  const cssScale = resolved.sequence.width > 0 ? canvasRect.width / resolved.sequence.width : 1;

  function beginDraw(startEvent: React.MouseEvent | React.TouchEvent) {
    startEvent.stopPropagation();
    preventDefaultIfMouse(startEvent);
    const start = clientPoint(startEvent);
    dragRef.current = { startX: start.x, startY: start.y, moved: false };
    updateLiveScreenRect({ x: start.x, y: start.y, width: 0, height: 0 });

    function onMove(moveEvent: MouseEvent | TouchEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const point = clientPoint(moveEvent);
      if (!drag.moved) {
        const traveled = Math.hypot(point.x - drag.startX, point.y - drag.startY);
        if (traveled < DRAG_THRESHOLD) return;
        drag.moved = true;
      }
      updateLiveScreenRect({
        x: Math.min(drag.startX, point.x),
        y: Math.min(drag.startY, point.y),
        width: Math.abs(point.x - drag.startX),
        height: Math.abs(point.y - drag.startY),
      });
    }

    function onUp() {
      removeListeners();
      const drag = dragRef.current;
      dragRef.current = null;
      const final = liveScreenRectRef.current;
      updateLiveScreenRect(null);
      if (!drag?.moved || !final || !resolved) return;

      // Screen (CSS px, viewport-relative) → sequence pixel space (relative to the canvas's own
      // backing store), the same conversion `TransformHandles`' own onMove does for a move drag.
      const sequenceRect = {
        x: (final.x - canvasRect.left) / cssScale,
        y: (final.y - canvasRect.top) / cssScale,
        width: final.width / cssScale,
        height: final.height / cssScale,
      };
      const sourceRect = mapSequenceRectToSourceRect(sequenceRect, box!, resolved.transform.rotationDeg);
      // Clamp against the asset's own bounds — `mapSequenceRectToSourceRect` only clamps the
      // top/left edge to 0 (it has no notion of the asset's actual width/height), so a rectangle
      // drawn out past the visible frame's edge could otherwise produce a mask rect extending
      // beyond the real source image.
      const clampedWidth = Math.min(sourceRect.width, resolved.assetWidth - sourceRect.x);
      const clampedHeight = Math.min(sourceRect.height, resolved.assetHeight - sourceRect.y);
      setRemoveObjectRect(resolved.clipId, {
        x: sourceRect.x,
        y: sourceRect.y,
        width: Math.max(1, clampedWidth),
        height: Math.max(1, clampedHeight),
      });
    }

    const removeListeners = addDragListeners(onMove, onUp);
  }

  // What to actually draw: the live in-progress drag rect, else the committed rect converted forward
  // back to screen space, else nothing (armed but not yet drawing — just the crosshair surface).
  const displayRect = liveScreenRect
    ? liveScreenRect
    : rectForThisClip
      ? (() => {
          const seq = mapSourceRectToSequenceRect(rectForThisClip, box!, resolved.transform.rotationDeg);
          return {
            x: canvasRect.left + seq.x * cssScale,
            y: canvasRect.top + seq.y * cssScale,
            width: seq.width * cssScale,
            height: seq.height * cssScale,
          };
        })()
      : null;

  return (
    <>
      {isArmed && (
        <div
          role="button"
          tabIndex={0}
          aria-label={t("Draw a region to remove")}
          onMouseDown={beginDraw}
          onTouchStart={beginDraw}
          style={{ position: "fixed", left: canvasRect.left, top: canvasRect.top, width: canvasRect.width, height: canvasRect.height, zIndex: 45 }}
          className="touch-none cursor-crosshair"
        />
      )}
      {displayRect && (
        <div
          aria-hidden
          style={{ position: "fixed", left: displayRect.x, top: displayRect.y, width: displayRect.width, height: displayRect.height, zIndex: 46 }}
          // Dashed border + a distinct rose tint — deliberately different from TransformHandles' own
          // solid sky-blue box, so the two are never confused about which tool is currently active.
          className="pointer-events-none border-2 border-dashed border-rose-400 bg-rose-500/20"
        />
      )}
    </>
  );
}
