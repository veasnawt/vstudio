import { findAsset } from "../project/createProject.ts";
import type { Project } from "../project/types.ts";
import { IDENTITY_TRANSFORM } from "../project/types.ts";
import { clipAtTime } from "../timeline/queries.ts";
import type { AlignBox } from "./alignmentGuides.ts";
import { computeTextBlock } from "./textLayout.ts";
import { computeTransformedBox } from "./transformGeometry.ts";

export interface VisibleClipBox {
  clipId: string;
  /** Which kind of track this box came from — video/image (`"video"`) or `"text"`. Alignment guides
   *  (this function's original caller) never needed to tell the two apart; `hitTestClip` below does,
   *  to replicate the renderer's real z-order rather than just "later in this array." */
  trackKind: "video" | "text";
  box: AlignBox;
}

/** Every clip actually on screen at `playhead` — one per visible track that has something playing at
 *  that instant — reduced to its alignment box. Shared by `TransformHandles` and
 *  `TextTransformHandles` so a video clip being dragged can align against a text clip's box and vice
 *  versa, not just clips of its own kind; this is the ONE place that list gets built, rather than each
 *  handle component re-deriving its own (and inevitably drifting on which clips count as "visible").
 *
 *  Rotation is ignored for every box here — the same axis-aligned-bounding-box simplification
 *  `AlignBox`'s own doc comment describes, applied consistently regardless of clip kind. */
export function computeVisibleClipBoxes(
  project: Project,
  playhead: number,
  context: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number
): VisibleClipBox[] {
  const results: VisibleClipBox[] = [];

  for (const track of project.sequence.tracks) {
    if (!track.visible) continue;
    const clip = clipAtTime(track, playhead);
    if (!clip) continue;
    const asset = findAsset(project, clip.assetId);
    if (!asset) continue;

    // A color-matte clip has no intrinsic `width`/`height` of its own (see `Asset.color`'s own doc
    // comment — it fills the frame edge-to-edge, same as `PlaybackEngine.drawVideoClip`'s own color
    // branch uses `frameWidth`/`frameHeight` as its stand-in "source size") — using the canvas's own
    // dimensions here is what makes it get a real box (and therefore real on-canvas transform handles
    // and alignment guides) at all, instead of silently being excluded for lacking `asset.width`.
    const isColor = asset.kind === "color";
    if (track.kind === "video" && (asset.kind === "video" || asset.kind === "image" || isColor) && (isColor || (asset.width && asset.height))) {
      const box = computeTransformedBox(isColor ? canvasWidth : asset.width!, isColor ? canvasHeight : asset.height!, canvasWidth, canvasHeight, clip.transform ?? IDENTITY_TRANSFORM);
      if (box) {
        results.push({
          clipId: clip.id,
          trackKind: "video",
          box: {
            left: box.centerX - box.width / 2,
            right: box.centerX + box.width / 2,
            top: box.centerY - box.height / 2,
            bottom: box.centerY + box.height / 2,
            centerX: box.centerX,
            centerY: box.centerY,
          },
        });
      }
    } else if (track.kind === "text" && asset.kind === "text" && asset.textStyle) {
      const block = computeTextBlock(context, canvasWidth, canvasHeight, asset.textContent ?? "", asset.textStyle, project.customFonts);
      results.push({
        clipId: clip.id,
        trackKind: "text",
        box: {
          left: block.blockLeft,
          right: block.blockLeft + block.blockWidth,
          top: block.blockTop,
          bottom: block.blockTop + block.blockHeight,
          centerX: block.blockLeft + block.blockWidth / 2,
          centerY: block.blockTop + block.blockHeight / 2,
        },
      });
    }
  }

  return results;
}

/** Finds the topmost visible clip whose box contains `point` (sequence-pixel space, same space
 *  `computeVisibleClipBoxes` returns) — the hit test behind clicking a video/image/text clip directly
 *  in the Preview canvas, the same way the Timeline already lets you click a clip there.
 *
 *  Priority mirrors `PlaybackEngine`'s real draw order, not just "later in this flat array": text
 *  ALWAYS composites over every video track regardless of how the two kinds of track happen to be
 *  interleaved in `project.sequence.tracks` (a user can freely reorder tracks; the renderer still
 *  always draws all video first, then all text over it — see `buildExportPlan`'s own two-pass
 *  structure), so text boxes are checked as a whole group before any video box. WITHIN each group,
 *  though, array order genuinely IS z-order (a later video track composites on top of an earlier one,
 *  and likewise for text) — `computeVisibleClipBoxes` preserves each track's relative array position
 *  in its own output order, so reverse-iterating each group here reaches the topmost match first.
 *
 *  Ignores rotation, same simplification `AlignBox`'s own doc comment already accepts for alignment
 *  guides — a rotated clip's true silhouette is smaller than its axis-aligned box in the corners, so a
 *  click just outside the visible (rotated) shape but still inside that box can select it; a minor,
 *  documented imprecision rather than a full point-in-rotated-rectangle test, consistent with the one
 *  guides already make. */
export function hitTestClip(boxes: VisibleClipBox[], point: { x: number; y: number }): string | null {
  for (const kind of ["text", "video"] as const) {
    const group = boxes.filter((b) => b.trackKind === kind);
    for (let i = group.length - 1; i >= 0; i--) {
      const { box, clipId } = group[i];
      if (point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom) return clipId;
    }
  }
  return null;
}
