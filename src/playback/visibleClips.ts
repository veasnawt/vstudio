import { findAsset } from "../project/createProject.ts";
import type { Project } from "../project/types.ts";
import { IDENTITY_TRANSFORM } from "../project/types.ts";
import { clipAtTime } from "../timeline/queries.ts";
import type { AlignBox } from "./alignmentGuides.ts";
import { computeTextBlock } from "./textLayout.ts";
import { computeTransformedBox } from "./transformGeometry.ts";

export interface VisibleClipBox {
  clipId: string;
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

    if (track.kind === "video" && (asset.kind === "video" || asset.kind === "image") && asset.width && asset.height) {
      const box = computeTransformedBox(asset.width, asset.height, canvasWidth, canvasHeight, clip.transform ?? IDENTITY_TRANSFORM);
      if (box) {
        results.push({
          clipId: clip.id,
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
      const block = computeTextBlock(context, canvasWidth, canvasHeight, asset.textContent ?? "", asset.textStyle);
      results.push({
        clipId: clip.id,
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
