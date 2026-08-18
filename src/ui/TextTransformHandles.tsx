"use client";

import React, { useEffect, useRef, useState } from "react";
import type { Command } from "../commands/index.ts";
import { BatchCommand, SetClipTransformCommand, SetTextCommand } from "../commands/index.ts";
import { findAsset, findClip } from "../project/createProject.ts";
import type { TextStyle } from "../project/types.ts";
import { DEFAULT_TEXT_STYLE } from "../project/types.ts";
import type { AlignBox, AlignmentGuide } from "../playback/alignmentGuides.ts";
import { computeAlignmentGuides } from "../playback/alignmentGuides.ts";
import { computeTextBlock } from "../playback/textLayout.ts";
import { computeVisibleClipBoxes } from "../playback/visibleClips.ts";
import { fontById, resolveFontVariant } from "../project/fonts.ts";
import { useEditorStore } from "../store/editorStore.ts";
import type { ClipOverride } from "../timeline/groupMove.ts";
import { computeGroupMoveOverrides } from "../timeline/groupMove.ts";
import { clipAtTime } from "../timeline/queries.ts";
import { addDragListeners, clientPoint, preventDefaultIfMouse } from "./pointerEvents.ts";
import { AlignmentGuideOverlay } from "./AlignmentGuideOverlay.tsx";

/** Same value, same reasoning as `TransformHandles`' own constant — see there. */
const ALIGN_SNAP_PIXELS = 8;

// Same constants, same drag pattern, same thresholds as `TransformHandles` (video/image clips) — see
// that file's own comments for the reasoning behind each. Text gets its own component rather than a
// shared/generalized one because the underlying model differs too much to unify cleanly: a text
// block's "size" IS `fontSize` (no separate scale multiplier, no crop), and its box comes from
// measuring rendered glyphs (`computeTextBlock`) rather than a source asset's own width/height.
const DRAG_THRESHOLD = 3;
// Kept in sync with TransformHandles.tsx's own identical constant and its comment: 16px was too
// small to reliably hit on a touch device, 24px roughly doubles the actual hit area.
const HANDLE_SIZE = 24;
const ROTATE_HANDLE_OFFSET = 28;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 600;
// Must match the edit textarea's own `border-2 px-2 py-1` classes below. Those are fixed CSS pixels
// regardless of `editScale`, so for a short/small text block (the common case at typical preview
// zoom — see `editScale`'s own comment) they can eat most or all of a box that's only ever sized to
// fit the TEXT, not any UI chrome around it. Left unaccounted for, the textarea's actually-usable
// (content-box) area ends up narrower than the real render's line-wrap math assumed, so text wraps
// into extra lines despite `editScale` already matching box and font growth. Inflating the box by
// exactly this much keeps the INNER usable area equal to `cssWidth/cssHeight * editScale` — the size
// the wrap math was computed for — with the border/padding added on top rather than eaten out of it.
const EDIT_BOX_BORDER_PX = 2;
const EDIT_BOX_PADDING_X_PX = 8;
const EDIT_BOX_PADDING_Y_PX = 4;

type DragMode = "move" | "resize" | "rotate";

const CORNERS: { x: number; y: number; cursor: string; label: string }[] = [
  { x: 0, y: 0, cursor: "cursor-nwse-resize", label: "top-left" },
  { x: 1, y: 0, cursor: "cursor-nesw-resize", label: "top-right" },
  { x: 0, y: 1, cursor: "cursor-nesw-resize", label: "bottom-left" },
  { x: 1, y: 1, cursor: "cursor-nwse-resize", label: "bottom-right" },
];

/** Draggable Position/Size/Rotation handles overlaid on the Preview canvas for the selected TEXT clip
 *  — the on-canvas counterpart to the Inspector's numeric Position/Size/Rotation fields, exactly the
 *  relationship `TransformHandles` already has with video/image clips' own numeric fields. Shown only
 *  when exactly one clip is selected, it's on a text track, AND it's the clip actually under the
 *  playhead right now (same "don't float over content you don't belong to" reasoning as
 *  `TransformHandles`). */
export function TextTransformHandles({ canvas }: { canvas: HTMLCanvasElement | null }) {
  const project = useEditorStore((s) => s.project);
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds);
  const playhead = useEditorStore((s) => s.playhead);
  const run = useEditorStore((s) => s.run);

  const [preview, setPreview] = useState<TextStyle | null>(null);
  const previewRef = useRef<TextStyle | null>(null);
  // Which asset is being inline-edited right now (null = none) — keyed by asset id, not a plain
  // boolean, so a selection change to a DIFFERENT text clip while mid-edit is detectable (see the
  // effect below) rather than silently continuing to edit the wrong one.
  const [editingAssetId, setEditingAssetId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  // Set right before an Escape-triggered exit, so the `onBlur` that follows (removing the textarea
  // from the DOM mid-focus fires one) knows to discard rather than commit — Escape means "cancel", not
  // "save whatever's currently typed".
  const skipCommitRef = useRef(false);
  const dragRef = useRef<{
    mode: DragMode;
    origin: TextStyle;
    assetId: string;
    content: string;
    startClientX: number;
    startClientY: number;
    centerScreenX: number;
    centerScreenY: number;
    startDistance: number;
    startAngleOffset: number;
    moved: boolean;
  } | null>(null);

  // Same live-canvas-sync mechanism as `TransformHandles` — see its own comment on `updatePreview`
  // for why `groupOverrides` (every OTHER selected clip's live position during a group move) is
  // combined with this clip's own `next` and published to the store for `PlaybackEngine` to draw.
  function updatePreview(next: TextStyle | null, groupOverrides: ClipOverride[] = []) {
    previewRef.current = next;
    setPreview(next);
    const overrides = next ? [{ clipId: resolved!.clipId, textStyle: next }, ...groupOverrides] : [];
    useEditorStore.getState().setLivePreviewOverrides(overrides);
  }

  const [guides, setGuides] = useState<AlignmentGuide[]>([]);

  // Same "stay correct across a paused-window-resize" fix as `TransformHandles` — see its own comment.
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    if (!canvas) return;
    const observer = new ResizeObserver(() => forceUpdate((n) => n + 1));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [canvas]);

  const resolved = (() => {
    if (!project || !canvas || selectedClipIds.length === 0) return null;
    // Same "resolve the first matching clip, not just selectedClipIds[0]" relaxation as
    // `TransformHandles` — see its own comment on `isGroupSelection` for the full reasoning.
    for (const clipId of selectedClipIds) {
      const found = findClip(project, clipId);
      if (!found || found.track.kind !== "text") continue;
      if (clipAtTime(found.track, playhead)?.id !== found.clip.id) continue;
      const asset = project.assets.find((a) => a.id === found.clip.assetId);
      if (!asset || asset.kind !== "text") continue;
      return {
        clipId: found.clip.id,
        assetId: asset.id,
        content: asset.textContent ?? "",
        savedStyle: asset.textStyle ?? DEFAULT_TEXT_STYLE,
        sequence: project.sequence,
      };
    }
    return null;
  })();

  const isGroupSelection = selectedClipIds.length > 1;

  // Selection moved to a different clip (or away entirely) while mid-edit — exit without committing,
  // the same "leaving cancels" reasoning Escape uses, rather than silently saving to the WRONG asset
  // once the user's attention (and the visible textarea) has already moved on.
  useEffect(() => {
    if (editingAssetId && editingAssetId !== resolved?.assetId) setEditingAssetId(null);
  }, [resolved?.assetId, editingAssetId]);

  if (!resolved || !canvas) return null;
  const context = canvas.getContext("2d");
  if (!context) return null;

  const style = preview ?? resolved.savedStyle;
  // Sequence resolution, not `canvas.width` — the canvas's own BACKING STORE is capped to its
  // on-screen size for performance (see `PlaybackEngine.setDisplaySize`'s own comment) and no longer
  // reliably equals the sequence's real resolution. `style.offsetX`/`fontSize` are authored (and
  // exported) in true sequence pixels, so that's the space this whole component has to compute in.
  const block = computeTextBlock(context, resolved.sequence.width, resolved.sequence.height, resolved.content, style);

  // Every screen measurement (handle position, drag deltas) has to go through this ratio to land in
  // the right place and track the pointer 1:1 — CSS pixels per SEQUENCE pixel, matching `block` above.
  const canvasRect = canvas.getBoundingClientRect();
  const cssScale = resolved.sequence.width > 0 ? canvasRect.width / resolved.sequence.width : 1;

  // The box's NATURAL (align-anchored, offset-EXCLUDED) position and size — what actually gets rotated
  // — plus the rotation PIVOT (frame center, offset applied AFTER rotation). See
  // `PlaybackEngine.drawText`'s matching comment for why the pivot is the frame's own center rather
  // than the box's true visual center: FFmpeg's export can't compute the latter for `align: "left"`/
  // `"right"` (it depends on measured glyph width, invisible outside one `drawtext` call), so both
  // renderers — and these handles, to visually track what's actually drawn — use the one pivot both
  // CAN compute identically. For `align: "center"` (the default) this pivot IS the box's true center,
  // so nothing looks different there.
  const naturalLeft = block.blockLeft - style.offsetX;
  const naturalTop = block.blockTop - style.offsetY;
  const boxCssLeft = canvasRect.left + naturalLeft * cssScale;
  const boxCssTop = canvasRect.top + naturalTop * cssScale;
  const cssWidth = block.blockWidth * cssScale;
  const cssHeight = block.blockHeight * cssScale;

  const pivotCssX = canvasRect.left + (resolved.sequence.width / 2) * cssScale;
  const pivotCssY = canvasRect.top + (resolved.sequence.height / 2) * cssScale;
  const offsetCssX = style.offsetX * cssScale;
  const offsetCssY = style.offsetY * cssScale;
  // Where the pivot sits RIGHT NOW on screen — invariant under rotation (rotating around a point
  // never moves that point), so this is also the fixed reference every drag below measures from.
  const centerScreenX = pivotCssX + offsetCssX;
  const centerScreenY = pivotCssY + offsetCssY;

  const isEditing = editingAssetId === resolved.assetId;

  // At typical preview zoom, `style.fontSize * cssScale` (how big the text ACTUALLY renders on
  // screen) is well under 16px — editing at that natural size would trip iOS Safari's auto-zoom on
  // focus (the same reason every other text input in this app floors at 16px). But flooring the
  // TEXTAREA's font to 16px while leaving the BOX at its natural (smaller) size doesn't just look
  // bigger — it makes the SAME text wrap into more lines than the real render ever would, since a
  // bigger font needs more width per character. Scaling the box up by the SAME factor the font is
  // floored by keeps "how much text fits per line" identical to the real render, just presented
  // larger — this is why the edit box and the preview can show a different LINE COUNT for the exact
  // same content otherwise: a size mismatch between the box and its own font, not a real difference
  // in what the content needs. No scaling at all (factor 1) once the natural size already clears 16px.
  const naturalFontPx = style.fontSize * cssScale;
  const editScale = isEditing && naturalFontPx > 0 ? Math.max(1, 16 / naturalFontPx) : 1;
  const editFontPx = naturalFontPx * editScale;
  // Same family/weight/slant `computeTextBlock` resolves for the canvas's own `context.font` string
  // (see that function's comment) — without this the textarea falls back to the page's default font,
  // whose glyphs are very often a different width than the clip's actual font, so the SAME box size
  // that correctly fits the real render's line count can still wrap differently here.
  const editFont = fontById(style.fontFamily);
  const editVariant = resolveFontVariant(editFont, style.bold, style.italic);
  // Grown from the CENTER, not the top-left corner, so enlarging the box for legibility doesn't also
  // shift where it visually sits relative to the text it's replacing. Equal to the natural (unscaled)
  // box whenever `editScale` is 1 — not editing, or already comfortably above the 16px floor. The
  // chrome term (0 unless actually editing) is ADDED on top of the scaled content size rather than
  // eating into it — see `EDIT_BOX_BORDER_PX`'s comment for why that's what keeps line-wrapping
  // faithful to the real render.
  const chromeWidth = isEditing ? 2 * (EDIT_BOX_BORDER_PX + EDIT_BOX_PADDING_X_PX) : 0;
  const chromeHeight = isEditing ? 2 * (EDIT_BOX_BORDER_PX + EDIT_BOX_PADDING_Y_PX) : 0;
  const effectiveWidth = cssWidth * editScale + chromeWidth;
  const effectiveHeight = cssHeight * editScale + chromeHeight;
  const effectiveLeftPx = boxCssLeft - (effectiveWidth - cssWidth) / 2;
  const effectiveTopPx = boxCssTop - (effectiveHeight - cssHeight) / 2;
  // `transform-origin`, expressed relative to the box's own top-left corner (CSS convention) —
  // recomputed against whichever box (natural or edit-enlarged) is actually being rendered, or the
  // rotation pivot would drift the instant editing enlarges the box.
  const originXpx = pivotCssX - effectiveLeftPx;
  const originYpx = pivotCssY - effectiveTopPx;

  function beginDrag(startEvent: React.MouseEvent | React.TouchEvent, mode: DragMode) {
    startEvent.stopPropagation();
    preventDefaultIfMouse(startEvent);
    const origin = resolved!.savedStyle;
    const start = clientPoint(startEvent);
    const startAngle = Math.atan2(start.y - centerScreenY, start.x - centerScreenX);

    dragRef.current = {
      mode,
      origin,
      assetId: resolved!.assetId,
      content: resolved!.content,
      startClientX: start.x,
      startClientY: start.y,
      centerScreenX,
      centerScreenY,
      startDistance: Math.hypot(start.x - centerScreenX, start.y - centerScreenY),
      // Recorded once so the handle doesn't visually "jump" to realign with the cursor the instant the
      // drag starts — subsequent rotation is this offset applied to wherever the pointer is now.
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

        // Same alignment-guide mechanism as `TransformHandles` (video/image) — see its own comment.
        // `naturalLeft`/`naturalTop` are the offset-EXCLUDED anchor position, so adding the raw
        // (not-yet-snapped) offset reconstructs where this box would land.
        let offsetX = rawOffsetX;
        let offsetY = rawOffsetY;
        if (project) {
          const draggedLeft = naturalLeft + rawOffsetX;
          const draggedTop = naturalTop + rawOffsetY;
          const draggedBox: AlignBox = {
            left: draggedLeft,
            top: draggedTop,
            right: draggedLeft + block.blockWidth,
            bottom: draggedTop + block.blockHeight,
            centerX: draggedLeft + block.blockWidth / 2,
            centerY: draggedTop + block.blockHeight / 2,
          };
          const frameBox: AlignBox = {
            left: 0,
            top: 0,
            right: project.sequence.width,
            bottom: project.sequence.height,
            centerX: project.sequence.width / 2,
            centerY: project.sequence.height / 2,
          };
          const others = computeVisibleClipBoxes(project, playhead, context!, project.sequence.width, project.sequence.height).filter(
            (v) => v.clipId !== resolved!.clipId
          );
          const result = computeAlignmentGuides(draggedBox, [frameBox, ...others.map((o) => o.box)], ALIGN_SNAP_PIXELS / cssScale);
          offsetX += result.snapDx;
          offsetY += result.snapDy;
          setGuides(result.guides);
        }

        // A multi-select group move: every OTHER selected clip live-tracks by the same delta this one
        // just moved by — see `TransformHandles`' identical comment on its own `onMove`.
        const groupOverrides: ClipOverride[] =
          project && selectedClipIds.length > 1 && selectedClipIds.includes(resolved!.clipId)
            ? computeGroupMoveOverrides(project, selectedClipIds, resolved!.clipId, offsetX - drag.origin.offsetX, offsetY - drag.origin.offsetY)
            : [];

        updatePreview({ ...drag.origin, offsetX, offsetY }, groupOverrides);
      } else if (drag.mode === "resize") {
        // No separate scale field for text — a corner drag multiplies `fontSize` directly, clamped the
        // same way `setTextAsset` clamps it server-side, so the preview never shows a value the commit
        // would silently correct out from under the user.
        setGuides([]);
        const distance = Math.hypot(point.x - drag.centerScreenX, point.y - drag.centerScreenY);
        const ratio = drag.startDistance > 0 ? distance / drag.startDistance : 1;
        const fontSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, drag.origin.fontSize * ratio));
        updatePreview({ ...drag.origin, fontSize });
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

      // Same group-move mechanism as `TransformHandles` — see its own comment on `onUp` for why this
      // reuses the exact same `computeGroupMoveOverrides` call `onMove` already used to live-preview
      // the group, so what was shown live and what commits can never disagree.
      if (drag.mode === "move" && project && selectedClipIds.length > 1 && selectedClipIds.includes(resolved!.clipId)) {
        const deltaX = final.offsetX - drag.origin.offsetX;
        const deltaY = final.offsetY - drag.origin.offsetY;
        const groupOverrides = computeGroupMoveOverrides(project, selectedClipIds, resolved!.clipId, deltaX, deltaY);
        const commands: Command[] = [new SetTextCommand(drag.assetId, drag.content, final)];
        for (const o of groupOverrides) {
          if (o.textStyle) {
            const found = findClip(project, o.clipId);
            const asset = found && findAsset(project, found.clip.assetId);
            if (asset) commands.push(new SetTextCommand(asset.id, asset.textContent ?? "", o.textStyle));
          } else if (o.transform) {
            commands.push(new SetClipTransformCommand(o.clipId, o.transform));
          }
        }
        run(commands.length > 1 ? new BatchCommand("Move Clips", commands) : commands[0]);
      } else {
        run(new SetTextCommand(drag.assetId, drag.content, final));
      }
    }

    const removeListeners = addDragListeners(onMove, onUp);
  }

  function commitEdit() {
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      return;
    }
    setEditingAssetId(null);
    if (editText !== resolved!.content) run(new SetTextCommand(resolved!.assetId, editText, resolved!.savedStyle));
  }

  return (
    <>
      <AlignmentGuideOverlay guides={guides} canvasRect={canvasRect} cssScale={cssScale} />
      <div
      style={{
        position: "fixed",
        left: effectiveLeftPx,
        top: effectiveTopPx,
        width: effectiveWidth,
        height: effectiveHeight,
        transformOrigin: `${originXpx}px ${originYpx}px`,
        // Rotate FIRST (around the pivot, via transformOrigin above), THEN translate by the offset —
        // CSS applies a transform function list right-to-left, so this order is what makes the offset
        // land AFTER rotation, matching `PlaybackEngine.drawText`'s identical two-stage transform.
        transform: `translate(${offsetCssX}px, ${offsetCssY}px) rotate(${style.rotationDeg}deg)`,
        zIndex: 40,
      }}
      className={isEditing ? "" : "pointer-events-none"}
    >
      {isEditing ? (
        // A plain, always-legible edit box rather than trying to match the text's own font/color/
        // background pixel-for-pixel — matching would risk invisible-on-invisible (white text on a
        // white-ish edit box) depending on the style being edited, and this is a transient editing
        // affordance, not part of the rendered output, so it doesn't need to be. Font size (not a
        // fixed Tailwind class) is `editFontPx`, computed above alongside the box's own enlargement —
        // see that comment for why the two have to move together.
        <textarea
          ref={(el) => el?.focus()}
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              skipCommitRef.current = true;
              setEditingAssetId(null);
            }
            // Enter commits (matching a single-line-ish "done typing" expectation); Shift+Enter still
            // inserts a newline, same convention chat inputs use, since a plain textarea's own default
            // (Enter always inserts a newline) would make "commit" require clicking away every time.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            fontSize: editFontPx,
            lineHeight: style.lineHeightMultiplier,
            fontFamily: `"${editFont.cssFamily}", sans-serif`,
            fontWeight: editVariant.bold ? "bold" : "normal",
            fontStyle: editVariant.italic ? "italic" : "normal",
          }}
          className="h-full w-full resize-none rounded border-2 border-sky-400 bg-black/85 px-2 py-1 text-white outline-none"
        />
      ) : (
        <>
          <div
            role="button"
            tabIndex={0}
            aria-label="Move text"
            onMouseDown={(e) => beginDrag(e, "move")}
            onTouchStart={(e) => beginDrag(e, "move")}
            onDoubleClick={() => {
              setEditText(resolved!.content);
              setEditingAssetId(resolved!.assetId);
            }}
            className="pointer-events-auto absolute inset-0 touch-none cursor-move border-2 border-sky-400/80"
          />

          {/* Resize/rotate hidden for a multi-selection — same reasoning as `TransformHandles`'
              identical gate: no well-defined group meaning for either yet, only move. Double-click-
              to-edit on the move handle above stays available regardless — it only ever affects
              THIS one clip's own text, unrelated to the group. */}
          {!isGroupSelection && (
            <>
              {CORNERS.map(({ x, y, cursor, label }) => (
                <div
                  key={label}
                  role="button"
                  tabIndex={0}
                  aria-label={`Resize text (${label})`}
                  onMouseDown={(e) => beginDrag(e, "resize")}
                  onTouchStart={(e) => beginDrag(e, "resize")}
                  style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: HANDLE_SIZE, height: HANDLE_SIZE }}
                  className={`pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 touch-none rounded-full border border-white bg-sky-400 shadow ${cursor}`}
                />
              ))}

              {/* Connecting line is purely visual — decorative, so it's excluded from the
                  accessibility tree rather than announced as an unlabeled element. */}
              <div
                aria-hidden
                style={{ left: "50%", top: -ROTATE_HANDLE_OFFSET, height: ROTATE_HANDLE_OFFSET }}
                className="pointer-events-none absolute w-px -translate-x-1/2 bg-white/50"
              />
              <div
                role="button"
                tabIndex={0}
                aria-label="Rotate text"
                onMouseDown={(e) => beginDrag(e, "rotate")}
                onTouchStart={(e) => beginDrag(e, "rotate")}
                style={{ left: "50%", top: -ROTATE_HANDLE_OFFSET, width: HANDLE_SIZE, height: HANDLE_SIZE }}
                className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 touch-none cursor-grab rounded-full border border-white bg-emerald-400 shadow"
              />
            </>
          )}
        </>
      )}
      </div>
    </>
  );
}
