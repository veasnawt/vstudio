"use client";

import React, { useEffect, useRef, useState } from "react";
import type { Command } from "../commands/index.ts";
import { BatchCommand, SetClipTransformCommand, SetClipTransformKeyframesCommand, SetTextCommand } from "../commands/index.ts";
import { findAsset, findClip } from "../project/createProject.ts";
import type { ClipTransform } from "../project/types.ts";
import type { AlignBox, AlignmentGuide } from "../playback/alignmentGuides.ts";
import { computeAlignmentGuides } from "../playback/alignmentGuides.ts";
import { clampPointToRect, computeTransformedBox, rotatedPoint } from "../playback/transformGeometry.ts";
import { computeVisibleClipBoxes } from "../playback/visibleClips.ts";
import { useEditorStore } from "../store/editorStore.ts";
import type { ClipOverride } from "../timeline/groupMove.ts";
import { computeGroupMoveOverrides } from "../timeline/groupMove.ts";
import { hasTransformKeyframes, resolveClipTransform, upsertKeyframe } from "../timeline/keyframes.ts";
import { clipAtTime } from "../timeline/queries.ts";
import { addDragListeners, clientPoint, preventDefaultIfMouse } from "./pointerEvents.ts";
import { AlignmentGuideOverlay } from "./AlignmentGuideOverlay.tsx";
import { useTranslation } from "../i18n/useTranslation.ts";

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
// Still the invisible HIT-AREA size (and `clampPointToRect`'s own clamp margin) — kept unchanged from
// that mobile UX pass. `HANDLE_DOT_SIZE` below is what actually renders now; the two used to be the
// same value, which made the visible dot itself feel oversized on a mouse-driven desktop preview
// (reported directly, not a touch-usability complaint) even though the LARGER touch target was and
// still is the right call.
const HANDLE_SIZE = 24;
// The actual visible circle, centered inside `HANDLE_SIZE`'s invisible hit area — a fingertip or mouse
// cursor still has the full 24px to land on, but the dot itself reads as a precise resize/rotate
// affordance rather than a chunky one.
const HANDLE_DOT_SIZE = 10;
const ROTATE_HANDLE_OFFSET = 28;

type DragMode = "move" | "scale" | "rotate";

const CORNERS: { x: number; y: number; cursor: string; label: string }[] = [
  { x: 0, y: 0, cursor: "cursor-nwse-resize", label: "top-left" },
  { x: 1, y: 0, cursor: "cursor-nesw-resize", label: "top-right" },
  { x: 0, y: 1, cursor: "cursor-nesw-resize", label: "bottom-left" },
  { x: 1, y: 1, cursor: "cursor-nwse-resize", label: "bottom-right" },
];

type Store = ReturnType<typeof useEditorStore.getState>;

/** Shared by `beginDrag`'s single-clip `onUp` path and the pinch-to-scale effect below — commits a
 *  plain (non-group) clip transform, respecting the same auto-keyframe rule the Inspector's
 *  NumberFields use (`upsertKeyframe`) so a canvas gesture and a typed value make the identical
 *  insert-vs-update decision regardless of which surface produced the new value. Takes `project`/
 *  `playhead`/`run` as plain arguments rather than reading them off the store internally so each
 *  caller controls freshness: `onUp` passes its own render-closed-over values (a drag never outlives
 *  one render's worth of relevant state), while the pinch effect below pulls fresh ones off
 *  `useEditorStore.getState()` at the moment the gesture ends, since its listeners are NOT recreated
 *  every render. */
function commitSingleTransform(
  target: { clipId: string; hasKeyframes: boolean; timelineStart: number; sequence: { fps: number } },
  final: ClipTransform,
  project: Store["project"],
  playhead: Store["playhead"],
  run: Store["run"]
) {
  if (target.hasKeyframes) {
    const elapsed = playhead - target.timelineStart;
    const found = project ? findClip(project, target.clipId) : undefined;
    const existing = found?.clip.transformKeyframes ?? [];
    const next = upsertKeyframe(existing, elapsed, final, target.sequence.fps);
    run(new SetClipTransformKeyframesCommand(target.clipId, next));
  } else {
    run(new SetClipTransformCommand(target.clipId, final));
  }
}

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
export function TransformHandles({
  canvas,
  stageEl,
}: {
  canvas: HTMLCanvasElement | null;
  /** The Preview panel's own stable stage element (`Preview.tsx`'s `previewBoxRef`) — larger than, and
   *  independent of, the canvas's own (possibly zoomed-out) on-screen size. Corner/rotate handles clamp
   *  to THIS rect, not the canvas's, so zooming the preview out actually opens up reachable space for
   *  them (see `clampPointToRect`'s own call sites below) rather than shrinking canvas and overflow by
   *  the same proportion, which would net to nothing. Optional — degrades to clamping against the
   *  canvas's own rect when omitted/not yet mounted. */
  stageEl?: HTMLDivElement | null;
}) {
  const project = useEditorStore((s) => s.project);
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds);
  const playhead = useEditorStore((s) => s.playhead);
  const run = useEditorStore((s) => s.run);
  const t = useTranslation();

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
      // A color-matte clip (see `Asset.color`'s own doc comment) has no intrinsic `width`/`height` of
      // its own — it fills the frame edge-to-edge, same "use the sequence's own size as the stand-in
      // source size" treatment `PlaybackEngine.drawVideoClip`'s color branch and
      // `computeVisibleClipBoxes`'s identical gap-fix already use. Without this, a selected color clip
      // would fail this `width`/`height` guard and simply show no handles at all.
      const assetWidth = asset?.kind === "color" ? project.sequence.width : asset?.width;
      const assetHeight = asset?.kind === "color" ? project.sequence.height : asset?.height;
      if (!assetWidth || !assetHeight) continue;
      // Resolved at the CURRENT PLAYHEAD, not the clip's raw static `transform` — for a keyframed
      // clip this is the interpolated value for whatever frame is actually showing, so the handles
      // draw/drag from where the box visually IS, not a fixed authored value. Zero behavior change
      // for an unkeyframed clip: `resolveClipTransform` falls back to `clip.transform ??
      // IDENTITY_TRANSFORM` internally, so `savedTransform` is never `undefined` either way.
      const savedTransform = resolveClipTransform(found.clip, playhead - found.clip.timelineStart);
      return {
        clipId: found.clip.id,
        savedTransform,
        hasKeyframes: hasTransformKeyframes(found.clip),
        timelineStart: found.clip.timelineStart,
        assetWidth,
        assetHeight,
        sequence: project.sequence,
      };
    }
    return null;
  })();

  // Kept in sync every render so the pinch effect below (which attaches once per `canvas` identity,
  // not once per render) can always read the CURRENT selection/playhead instead of whatever was
  // selected back when the effect happened to be set up — the same staleness `beginDrag` itself never
  // has to worry about, since it's invoked fresh from an inline JSX handler on every render.
  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;

  const isGroupSelection = selectedClipIds.length > 1;

  // Two-finger pinch scales the currently selected clip directly on the canvas — the gesture every
  // mobile video editor uses for "make this bigger/smaller", alongside (not replacing) the
  // corner-handle drag, which stays the way to resize anchored on a specific corner. Scales around the
  // clip's own center (offset unchanged) — the same "no anchor" fallback `beginDrag`'s own scale mode
  // already falls back to, so this is an existing, established transform shape, not a new one.
  //
  // Listens on `window`, not the canvas: the move/corner/rotate handles below are `position: fixed`
  // siblings of the canvas (not DOM descendants of it — see their own JSX comments on why), each with
  // its own `pointer-events-auto` hit area stacked at `zIndex: 40`, ABOVE the canvas. A two-finger
  // touch landing on the move-handle (which covers the clip's full box — the common case, since a
  // pinch naturally starts centered on the clip you're resizing) would hit that div, not the canvas
  // underneath — confirmed live: a canvas-only listener never saw the touch at all, and the move
  // handle's own touchstart quietly turned the gesture into a single-finger move drag instead
  // (confirmed via a real two-touch simulation: the clip visibly slid left, exactly like a single
  // stray finger dragging it, instead of scaling). `touchstart` is registered in the CAPTURE phase
  // specifically so it runs BEFORE any handle's own bubble-phase React `onTouchStart` (React 17+
  // delegates its synthetic handlers to the root in the bubble phase — a capture listener anywhere
  // above always wins the race) — on a genuine 2-touch start with a clip selected, `stopPropagation()`
  // keeps that event from ever reaching the handle at all, so `beginDrag` never starts a move/scale/
  // rotate drag out from under the pinch. `touchmove`/`touchend` don't need capture: by then `dragRef`
  // is guaranteed still null (nothing got the chance to claim it), so there's nothing left to race.
  useEffect(() => {
    if (!canvas) return;
    let lastDistance = 0;
    let pinchTransform: ClipTransform | null = null;

    function distance(touches: TouchList) {
      const [a, b] = [touches[0], touches[1]];
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }

    // Window-scoped listeners have to opt themselves OUT of anything outside the preview — without
    // this, a pinch on the TIMELINE (its own, separate pinch-zoom handler) while a clip happens to be
    // selected would get `stopPropagation()`-ed by this capture listener before Timeline's own bubble-
    // phase one ever saw it, silently breaking timeline pinch-zoom any time a clip is selected. The
    // canvas's own rect (not the handles' possibly-larger/clamped screen extents) is the deliberately
    // simple, good-enough "is this pinch over the preview" test.
    function withinCanvas(touches: TouchList) {
      const rect = canvas!.getBoundingClientRect();
      const midX = (touches[0].clientX + touches[1].clientX) / 2;
      const midY = (touches[0].clientY + touches[1].clientY) / 2;
      return midX >= rect.left && midX <= rect.right && midY >= rect.top && midY <= rect.bottom;
    }

    // A self-contained copy of `updatePreview` that reads `resolvedRef.current` instead of the
    // (potentially stale, closed-over-at-mount) `resolved` — see `resolvedRef`'s own comment above.
    function updatePinchPreview(next: ClipTransform | null) {
      previewRef.current = next;
      setPreview(next);
      const r = resolvedRef.current;
      useEditorStore.getState().setLivePreviewOverrides(next && r ? [{ clipId: r.clipId, transform: next }] : []);
    }

    function onTouchStart(e: TouchEvent) {
      // Bows out if a single-pointer drag (move/corner-scale/rotate) somehow already claimed
      // `dragRef`, and if there's no single video/image clip selected to scale in the first place —
      // in either case, let the event proceed untouched to whatever would normally handle it.
      if (e.touches.length !== 2 || dragRef.current || !resolvedRef.current || !withinCanvas(e.touches)) return;
      e.stopPropagation();
      lastDistance = distance(e.touches);
      pinchTransform = resolvedRef.current.savedTransform;
    }
    function onTouchMove(e: TouchEvent) {
      if (e.touches.length !== 2 || lastDistance === 0 || !pinchTransform) return;
      e.preventDefault();
      const d = distance(e.touches);
      pinchTransform = { ...pinchTransform, scale: pinchTransform.scale * (d / lastDistance) };
      lastDistance = d;
      updatePinchPreview(pinchTransform);
    }
    function onTouchEnd(e: TouchEvent) {
      if (e.touches.length >= 2) return;
      lastDistance = 0;
      const final = pinchTransform;
      pinchTransform = null;
      if (!final) return;
      updatePinchPreview(null);
      const r = resolvedRef.current;
      if (!r) return;
      const store = useEditorStore.getState();
      commitSingleTransform(r, final, store.project, store.playhead, store.run);
    }

    window.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart, { capture: true });
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [canvas]);

  if (!resolved || !canvas) return null;

  const transform = preview ?? resolved.savedTransform;
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

  // The rect corner/rotate handles clamp INTO — the Preview panel's own stable stage, not the
  // (possibly zoomed-out, possibly huge-content-overflowing) canvas rect itself. See `stageEl`'s own
  // prop doc comment for why these need to be different rects.
  const stageRect = stageEl?.getBoundingClientRect() ?? canvasRect;

  // For a corner resize, `anchor` is the OPPOSITE corner (bottom-right dragged → top-left anchor, and
  // so on) — the point that should stay visually fixed in place while the box grows/shrinks around it,
  // matching how resize handles behave in Figma/PowerPoint/etc. `undefined` for move/rotate, which
  // don't have a corner at all.
  function beginDrag(startEvent: React.MouseEvent | React.TouchEvent, mode: DragMode, corner?: { x: number; y: number }) {
    startEvent.stopPropagation();
    preventDefaultIfMouse(startEvent);
    const origin = resolved!.savedTransform;
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
      const anchor = rotatedPoint(cssCenterX, cssCenterY, localX, localY, origin.rotationDeg);
      anchorScreenX = anchor.x;
      anchorScreenY = anchor.y;
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

        // Each clip in the group must respect ITS OWN keyframe state exactly like a solo drag does
        // (the `hasKeyframes` branch below) — `resolveClipTransform` only reads a clip's flat
        // `.transform` when it has NO keyframes, so a bare SetClipTransformCommand on a keyframed
        // clip is silently discarded by playback: the canvas shows the move live during the drag
        // (`livePreviewOverrides` bypasses this entirely) but snaps right back the instant you
        // release, which reads as "group move doesn't work" for any keyframed member.
        function commandForTransform(clipId: string, nextTransform: ClipTransform, ownTimelineStart: number): Command {
          const found = findClip(project!, clipId);
          if (found && hasTransformKeyframes(found.clip)) {
            const elapsed = playhead - ownTimelineStart;
            const next = upsertKeyframe(found.clip.transformKeyframes ?? [], elapsed, nextTransform, resolved!.sequence.fps);
            return new SetClipTransformKeyframesCommand(clipId, next);
          }
          return new SetClipTransformCommand(clipId, nextTransform);
        }

        const commands: Command[] = [commandForTransform(resolved!.clipId, final, resolved!.timelineStart)];
        for (const o of groupOverrides) {
          if (o.transform) {
            const found = findClip(project, o.clipId);
            commands.push(commandForTransform(o.clipId, o.transform, found?.clip.timelineStart ?? 0));
          } else if (o.textStyle) {
            const found = findClip(project, o.clipId);
            const asset = found && findAsset(project, found.clip.assetId);
            if (asset) commands.push(new SetTextCommand(asset.id, asset.textContent ?? "", o.textStyle));
          }
        }
        run(commands.length > 1 ? new BatchCommand("Move Clips", commands) : commands[0]);
      } else {
        commitSingleTransform(resolved!, final, project, playhead, run);
      }
    }

    const removeListeners = addDragListeners(onMove, onUp);
  }

  // Corner/rotate handle SCREEN positions, computed independently of the (possibly huge, possibly
  // off-screen) rotated box below via the exact same rotation math `beginDrag`'s own anchor
  // computation uses, then clamped into `stageRect` — see `clampPointToRect`'s own doc comment for
  // why: without this, a large `transform.scale` pushes these small dots outside the visible preview
  // (or behind another panel) with nothing left to grab, a real, confirmed bug. `beginDrag`'s own drag
  // math is untouched — it only ever reads the pointer's actual position, never these computed points,
  // so clamping is purely a render-time concern.
  const cornerHandles = CORNERS.map(({ x, y, cursor, label }) => {
    const truePoint = rotatedPoint(cssCenterX, cssCenterY, (x - 0.5) * cssWidth, (y - 0.5) * cssHeight, transform.rotationDeg);
    return { x, y, cursor, label, point: clampPointToRect(truePoint, stageRect, HANDLE_SIZE / 2) };
  });
  const rotateTruePoint = rotatedPoint(cssCenterX, cssCenterY, 0, -cssHeight / 2 - ROTATE_HANDLE_OFFSET, transform.rotationDeg);
  const rotatePoint = clampPointToRect(rotateTruePoint, stageRect, HANDLE_SIZE / 2);
  // Whether clamping actually moved the rotate handle from its true position — drives the connecting
  // line below (see its own comment for why a clamped handle hides it rather than trying to draw a
  // correct line to it).
  const rotateHandleClamped = rotatePoint.x !== rotateTruePoint.x || rotatePoint.y !== rotateTruePoint.y;

  return (
    <>
      <AlignmentGuideOverlay guides={guides} canvasRect={canvasRect} cssScale={cssScale} />
      <div
        style={{
          position: "fixed",
          left: stageRect.left,
          top: stageRect.top,
          width: stageRect.right - stageRect.left,
          height: stageRect.bottom - stageRect.top,
          overflow: "hidden",
          zIndex: 40,
        }}
        className="pointer-events-none"
      >
      {/* The rotated box itself — `position: absolute` now, relative to the clipping wrapper above,
          not `fixed` against the viewport. A large `transform.scale` can make this box far bigger
          than the visible frame; unlike the corner/rotate dots below (which clamp to a single grabbable
          POINT), there's no single "clamped rectangle" that stays both correctly rotated AND a
          faithful stand-in for the clip's real size, so this wrapper's own `overflow: hidden` is what
          keeps the oversized box from visually covering (and intercepting clicks meant for) the Media
          Library, Inspector, Timeline, or the Preview's own transport bar — confirmed live: without
          this, dragging a large clip's move-region could sit on TOP of those controls and swallow
          clicks meant for them, not just look messy. */}
      <div
        style={{
          position: "absolute",
          left: cssCenterX - stageRect.left,
          top: cssCenterY - stageRect.top,
          width: cssWidth,
          height: cssHeight,
          transform: `translate(-50%, -50%) rotate(${transform.rotationDeg}deg)`,
        }}
      >
      <div
        role="button"
        tabIndex={0}
        aria-label={t("Move clip")}
        onMouseDown={(e) => beginDrag(e, "move")}
        onTouchStart={(e) => beginDrag(e, "move")}
        className="pointer-events-auto absolute inset-0 touch-none cursor-move border-2 border-sky-400/80"
      />

      {/* Connecting line stays nested in the ROTATED box above (unlike the corner/rotate dots below,
          which render as independent fixed-position siblings so they can be clamped) — its own CSS
          rotation already draws it correctly from the box's top edge up to the rotate handle's TRUE
          (unclamped) position, so this is only ever shown when that position needs no clamping in the
          first place; see the rotate handle's own comment for what happens otherwise. Purely visual —
          decorative, so it's excluded from the accessibility tree rather than announced as an
          unlabeled element. */}
      {!isGroupSelection && !rotateHandleClamped && (
        <div
          aria-hidden
          style={{ left: "50%", top: -ROTATE_HANDLE_OFFSET, height: ROTATE_HANDLE_OFFSET }}
          className="pointer-events-none absolute w-px -translate-x-1/2 bg-white/50"
        />
      )}
      </div>
      </div>

      {/* Resize/rotate hidden for a multi-selection — see `isGroupSelection`'s own comment above:
          there's no well-defined group meaning for either yet, only move. Rendered as independent
          `position: fixed` siblings of the rotated box (not CSS-percentage children of it) precisely
          so each one's CLAMPED position can be expressed in plain screen coordinates — a rotated
          parent's `left: X%` can only ever place a point along ITS OWN (possibly off-screen) rotated
          axis, never clamped to the axis-aligned visible frame. */}
      {!isGroupSelection && (
        <>
          {cornerHandles.map(({ x, y, cursor, label, point }) => (
            <div
              key={label}
              role="button"
              tabIndex={0}
              aria-label={t("Resize clip ({corner})", { corner: t(label) })}
              onMouseDown={(e) => beginDrag(e, "scale", { x, y })}
              onTouchStart={(e) => beginDrag(e, "scale", { x, y })}
              style={{ position: "fixed", left: point.x, top: point.y, width: HANDLE_SIZE, height: HANDLE_SIZE, zIndex: 40 }}
              className={`pointer-events-auto -translate-x-1/2 -translate-y-1/2 flex touch-none items-center justify-center ${cursor}`}
            >
              <div style={{ width: HANDLE_DOT_SIZE, height: HANDLE_DOT_SIZE }} className="rounded-full border border-white bg-sky-400 shadow" />
            </div>
          ))}
          <div
            role="button"
            tabIndex={0}
            aria-label={t("Rotate clip")}
            onMouseDown={(e) => beginDrag(e, "rotate")}
            onTouchStart={(e) => beginDrag(e, "rotate")}
            style={{ position: "fixed", left: rotatePoint.x, top: rotatePoint.y, width: HANDLE_SIZE, height: HANDLE_SIZE, zIndex: 40 }}
            className="pointer-events-auto -translate-x-1/2 -translate-y-1/2 flex touch-none cursor-grab items-center justify-center"
          >
            <div style={{ width: HANDLE_DOT_SIZE, height: HANDLE_DOT_SIZE }} className="rounded-full border border-white bg-emerald-400 shadow" />
          </div>
        </>
      )}
    </>
  );
}
