"use client";

import React, { useEffect, useRef, useState } from "react";
import type { Command } from "../commands/index.ts";
import { BatchCommand, SetClipTransformCommand, SetTextCommand } from "../commands/index.ts";
import { findAsset, findClip } from "../project/createProject.ts";
import type { ClipTransform } from "../project/types.ts";
import { IDENTITY_TRANSFORM } from "../project/types.ts";
import type { AlignBox, AlignmentGuide } from "../playback/alignmentGuides.ts";
import { computeAlignmentGuides } from "../playback/alignmentGuides.ts";
import { computeTransformedBox } from "../playback/transformGeometry.ts";
import { computeVisibleClipBoxes } from "../playback/visibleClips.ts";
import { useEditorStore } from "../store/editorStore.ts";
import type { ClipOverride } from "../timeline/groupMove.ts";
import { computeGroupMoveOverrides } from "../timeline/groupMove.ts";
import { clipAtTime } from "../timeline/queries.ts";
import { addDragListeners, clientPoint, preventDefaultIfMouse } from "./pointerEvents.ts";
import { AlignmentGuideOverlay } from "./AlignmentGuideOverlay.tsx";

/** How close (in on-screen CSS pixels, so it feels the same at any zoom) a dragged clip's edge/center
 *  must come to another clip's or the frame's before a guide line appears and the drag snaps to it —
 *  same reasoning and same value as the timeline's own `SNAP_PIXELS`. */
const ALIGN_SNAP_PIXELS = 8;

/** Pixels the pointer must travel before a press counts as a drag rather than a stray click — same
 *  reasoning and same threshold as `TimelineClip`'s own `DRAG_THRESHOLD`: without it, a slightly-shaky
 *  click on a handle would push an imperceptible-but-real undo entry. */
const DRAG_THRESHOLD = 3;
// 16px, not the tighter 12px a mouse cursor could still land precisely — this is a real touch target
// now (see beginDrag's touch support below), and 12px is close to ungrabbable with a fingertip.
// 16px read as too small to reliably hit on a touch device (confirmed dragging these one-handed on a
// phone-sized viewport during a mobile UX pass) — 24px keeps the dots visually unobtrusive against a
// full preview frame while roughly doubling the actual hit area (scales with the square of the size).
const HANDLE_SIZE = 24;
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
    // Scale-mode only: the corner OPPOSITE the one being dragged, and its on-screen position at drag
    // start — see `beginDrag`'s own comment on why resizing anchors there instead of the box center.
    anchorLocal: { x: number; y: number } | null;
    anchorScreenX: number;
    anchorScreenY: number;
  } | null>(null);

  /** `groupOverrides` is every OTHER selected clip's live position during a group move (empty for
   *  scale/rotate, which have no group meaning — see `onUp`'s own comment) — combined with this
   *  clip's own `next` and published to the store, which is what `PlaybackEngine` (via
   *  `getLiveOverrides`) actually draws mid-drag. Without this, the canvas only ever shows the last
   *  COMMITTED transform while this component's own overlay box tracks the pointer, which reads as
   *  "only the selection box moves" — and for a group, as "only ONE clip moves." A plain store write
   *  (not a hook-driven one) since this needs to fire from inside `onMove`'s imperative window-event
   *  handler, not React's render cycle. */
  function updatePreview(next: ClipTransform | null, groupOverrides: ClipOverride[] = []) {
    previewRef.current = next;
    setPreview(next);
    const overrides = next ? [{ clipId: resolved!.clipId, transform: next }, ...groupOverrides] : [];
    useEditorStore.getState().setLivePreviewOverrides(overrides);
  }

  const [guides, setGuides] = useState<AlignmentGuide[]>([]);

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
    if (!project || !canvas || selectedClipIds.length === 0) return null;
    // A single overall selection resolves it directly (the common case, unchanged). A MULTI-
    // selection (possibly mixing video/image and text clips — see TextTransformHandles) resolves
    // the FIRST selected clip that's a currently-visible video/image one, so its own move handle
    // exists at all to drag the whole group from — corner/rotate handles are hidden in that case
    // (see `isGroupSelection` below), since resize/rotate has no well-defined group meaning yet.
    for (const clipId of selectedClipIds) {
      const found = findClip(project, clipId);
      if (!found || found.track.kind !== "video") continue;
      // Not just "is this clip selected" — is it the one actually under the playhead right now.
      if (clipAtTime(found.track, playhead)?.id !== found.clip.id) continue;
      const asset = findAsset(project, found.clip.assetId);
      if (!asset?.width || !asset.height) continue;
      return { clipId: found.clip.id, savedTransform: found.clip.transform, assetWidth: asset.width, assetHeight: asset.height, sequence: project.sequence };
    }
    return null;
  })();

  const isGroupSelection = selectedClipIds.length > 1;

  if (!resolved || !canvas) return null;

  const transform = preview ?? resolved.savedTransform ?? IDENTITY_TRANSFORM;
  const box = computeTransformedBox(resolved.assetWidth, resolved.assetHeight, resolved.sequence.width, resolved.sequence.height, transform);
  if (!box) return null;

  // The canvas backing store is full sequence resolution but displayed smaller via CSS — every
  // screen measurement (handle position, drag deltas) has to go through this ratio to land in the
  // right place and track the pointer 1:1.
  const canvasRect = canvas.getBoundingClientRect();
  // Sequence resolution, not `canvas.width` — the canvas's own BACKING STORE is capped to its
  // on-screen size for performance (see `PlaybackEngine.setDisplaySize`'s own comment) and no longer
  // reliably equals the sequence's real resolution, but `box` above is computed in true sequence-pixel
  // space (via `resolved.sequence.width/height`, matching where `transform.offsetX` itself is
  // authored), so THIS conversion has to target that same space to land in the right place.
  const cssScale = resolved.sequence.width > 0 ? canvasRect.width / resolved.sequence.width : 1;
  const cssWidth = box.width * cssScale;
  const cssHeight = box.height * cssScale;
  const cssCenterX = canvasRect.left + box.centerX * cssScale;
  const cssCenterY = canvasRect.top + box.centerY * cssScale;

  // For a corner resize, `anchor` is the OPPOSITE corner (bottom-right dragged → top-left anchor, and
  // so on) — the point that should stay visually fixed in place while the box grows/shrinks around it,
  // matching how resize handles behave in Figma/PowerPoint/etc. `undefined` for move/rotate, which
  // don't have a corner at all.
  function beginDrag(startEvent: React.MouseEvent | React.TouchEvent, mode: DragMode, corner?: { x: number; y: number }) {
    startEvent.stopPropagation();
    preventDefaultIfMouse(startEvent);
    const origin = resolved!.savedTransform ?? IDENTITY_TRANSFORM;
    const start = clientPoint(startEvent);
    const startAngle = Math.atan2(start.y - cssCenterY, start.x - cssCenterX);

    // The anchor corner's on-screen position, computed the same way the handles themselves are drawn
    // below: local (unrotated) offset from the box center, in CSS pixels, rotated by the box's own
    // current angle, then placed at the box's actual screen center.
    let anchorLocal: { x: number; y: number } | null = null;
    let anchorScreenX = cssCenterX;
    let anchorScreenY = cssCenterY;
    if (mode === "scale" && corner) {
      anchorLocal = { x: 1 - corner.x, y: 1 - corner.y };
      const localX = (anchorLocal.x - 0.5) * cssWidth;
      const localY = (anchorLocal.y - 0.5) * cssHeight;
      const theta = (origin.rotationDeg * Math.PI) / 180;
      anchorScreenX = cssCenterX + localX * Math.cos(theta) - localY * Math.sin(theta);
      anchorScreenY = cssCenterY + localX * Math.sin(theta) + localY * Math.cos(theta);
    }

    dragRef.current = {
      mode,
      origin,
      startClientX: start.x,
      startClientY: start.y,
      centerScreenX: cssCenterX,
      centerScreenY: cssCenterY,
      startDistance:
        mode === "scale" && anchorLocal
          ? Math.hypot(start.x - anchorScreenX, start.y - anchorScreenY)
          : Math.hypot(start.x - cssCenterX, start.y - cssCenterY),
      anchorLocal,
      anchorScreenX,
      anchorScreenY,
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
        const rawOffsetX = drag.origin.offsetX + dxCss / cssScale;
        const rawOffsetY = drag.origin.offsetY + dyCss / cssScale;

        // Alignment guides: compare this clip's box (at the RAW, not-yet-snapped position) against
        // every other currently-visible clip's box plus the frame itself, then apply whatever snap
        // the closest match on each axis suggests — see `computeAlignmentGuides`'s own comment for
        // why the closest match per axis, not just the first one found, drives the snap.
        const context = canvas!.getContext("2d");
        let offsetX = rawOffsetX;
        let offsetY = rawOffsetY;
        if (context && project) {
          const draggedCenterX = resolved!.sequence.width / 2 + rawOffsetX;
          const draggedCenterY = resolved!.sequence.height / 2 + rawOffsetY;
          const draggedBox: AlignBox = {
            left: draggedCenterX - box!.width / 2,
            right: draggedCenterX + box!.width / 2,
            top: draggedCenterY - box!.height / 2,
            bottom: draggedCenterY + box!.height / 2,
            centerX: draggedCenterX,
            centerY: draggedCenterY,
          };
          const frameBox: AlignBox = {
            left: 0,
            top: 0,
            right: resolved!.sequence.width,
            bottom: resolved!.sequence.height,
            centerX: resolved!.sequence.width / 2,
            centerY: resolved!.sequence.height / 2,
          };
          // Sequence resolution here too — see `cssScale`'s own comment above for why `canvas.width`
          // itself is no longer the right value to pass for anything expressed in sequence-pixel space.
          const others = computeVisibleClipBoxes(project, playhead, context, resolved!.sequence.width, resolved!.sequence.height).filter(
            (v) => v.clipId !== resolved!.clipId
          );
          const result = computeAlignmentGuides(draggedBox, [frameBox, ...others.map((o) => o.box)], ALIGN_SNAP_PIXELS / cssScale);
          offsetX += result.snapDx;
          offsetY += result.snapDy;
          setGuides(result.guides);
        }

        // A multi-select group move: every OTHER selected clip live-tracks by the same delta this one
        // just moved by, using the exact same computation `onUp` uses to build the final commands —
        // one shared source of truth (`computeGroupMoveOverrides`) for "which clips move and by how
        // much", so the live preview and the committed result can never disagree.
        const groupOverrides: ClipOverride[] =
          project && selectedClipIds.length > 1 && selectedClipIds.includes(resolved!.clipId)
            ? computeGroupMoveOverrides(project, selectedClipIds, resolved!.clipId, offsetX - drag.origin.offsetX, offsetY - drag.origin.offsetY)
            : [];

        updatePreview({ ...drag.origin, offsetX, offsetY }, groupOverrides);
      } else if (drag.mode === "scale") {
        // Alignment guides are a POSITION concept — resizing/rotating don't have a well-defined
        // "edge lines up with another clip's edge" meaning the way a plain move does, so guides are
        // scoped to `mode === "move"` only, and cleared here rather than left stale from an earlier
        // move gesture.
        setGuides([]);
        const distance = Math.hypot(point.x - drag.anchorScreenX, point.y - drag.anchorScreenY);
        const ratio = drag.startDistance > 0 ? distance / drag.startDistance : 1;
        const newScale = drag.origin.scale * ratio;

        const anchor = drag.anchorLocal;
        if (anchor) {
          // Keep the OPPOSITE corner fixed on screen: shrink/grow the box around it in its own local
          // (unrotated) space — half-extents times (1 - ratio) is exactly how far that corner would
          // otherwise drift if the box only scaled around its center — then rotate that correction
          // back into the frame's coordinate space, since `offsetX`/`offsetY` are stored UNROTATED
          // (absolute sequence pixels from frame center), matching every other consumer of `ClipTransform`.
          const localDx = (anchor.x - 0.5) * box!.width * (1 - ratio);
          const localDy = (anchor.y - 0.5) * box!.height * (1 - ratio);
          const theta = (drag.origin.rotationDeg * Math.PI) / 180;
          const rotatedDx = localDx * Math.cos(theta) - localDy * Math.sin(theta);
          const rotatedDy = localDx * Math.sin(theta) + localDy * Math.cos(theta);
          updatePreview({ ...drag.origin, scale: newScale, offsetX: drag.origin.offsetX + rotatedDx, offsetY: drag.origin.offsetY + rotatedDy });
        } else {
          updatePreview({ ...drag.origin, scale: newScale });
        }
      } else {
        setGuides([]);
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
      setGuides([]);
      if (!drag?.moved || !final) return;

      // A group move: this clip is one of SEVERAL selected, all live-tracked together during the
      // drag itself (see `onMove`'s own use of `computeGroupMoveOverrides`) — this reuses the exact
      // same computation to build the final commands, so what was shown live and what actually
      // commits can never disagree on which clips moved or by how much.
      if (drag.mode === "move" && project && selectedClipIds.length > 1 && selectedClipIds.includes(resolved!.clipId)) {
        const deltaX = final.offsetX - drag.origin.offsetX;
        const deltaY = final.offsetY - drag.origin.offsetY;
        const groupOverrides = computeGroupMoveOverrides(project, selectedClipIds, resolved!.clipId, deltaX, deltaY);
        const commands: Command[] = [new SetClipTransformCommand(resolved!.clipId, final)];
        for (const o of groupOverrides) {
          if (o.transform) {
            commands.push(new SetClipTransformCommand(o.clipId, o.transform));
          } else if (o.textStyle) {
            const found = findClip(project, o.clipId);
            const asset = found && findAsset(project, found.clip.assetId);
            if (asset) commands.push(new SetTextCommand(asset.id, asset.textContent ?? "", o.textStyle));
          }
        }
        run(commands.length > 1 ? new BatchCommand("Move Clips", commands) : commands[0]);
      } else {
        run(new SetClipTransformCommand(resolved!.clipId, final));
      }
    }

    const removeListeners = addDragListeners(onMove, onUp);
  }

  return (
    <>
      <AlignmentGuideOverlay guides={guides} canvasRect={canvasRect} cssScale={cssScale} />
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

      {/* Resize/rotate hidden for a multi-selection — see `isGroupSelection`'s own comment above:
          there's no well-defined group meaning for either yet, only move. */}
      {!isGroupSelection && (
        <>
          {CORNERS.map(({ x, y, cursor, label }) => (
            <div
              key={label}
              role="button"
              tabIndex={0}
              aria-label={`Resize clip (${label})`}
              onMouseDown={(e) => beginDrag(e, "scale", { x, y })}
              onTouchStart={(e) => beginDrag(e, "scale", { x, y })}
              style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: HANDLE_SIZE, height: HANDLE_SIZE }}
              className={`pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 touch-none rounded-full border border-white bg-sky-400 shadow ${cursor}`}
            />
          ))}

          {/* Connecting line is purely visual — decorative, so it's excluded from the accessibility
              tree rather than announced as an unlabeled element. */}
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
        </>
      )}
      </div>
    </>
  );
}
