import type { ClipTransform } from "../project/types.ts";

export interface TransformedBox {
  /** Center of the drawn content, in CANVAS BACKING-STORE pixels (i.e. sequence-resolution pixels,
   *  not the canvas's on-screen CSS size). */
  centerX: number;
  centerY: number;
  /** Size of the drawn content BEFORE rotation is applied, in the same pixel space. */
  width: number;
  height: number;
  /** The cropped source rect, in the SOURCE's own pixel space — exactly what `drawImage`'s 4-argument
   *  source-rect form needs. */
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
}

/** The one place the crop → fit-scale → user-scale → position pipeline is computed, shared by
 *  `PlaybackEngine` (which draws this box, and needs the crop rect for `drawImage`'s source args) and
 *  `TransformHandles` (which needs the resulting box's screen position to draw on-canvas handles at
 *  the right place). Two independent implementations of this math would be exactly the kind of
 *  preview/export drift `ClipTransform`'s own doc comment already warns against — same principle,
 *  applied to preview's two consumers instead of preview vs. export.
 *
 *  Returns `null` when the crop leaves nothing visible (shouldn't happen — `setClipTransform` already
 *  clamps against this — but a corrupted or hand-edited project file could still produce one; treating
 *  clamping as advisory here rather than trusting it blindly is cheap insurance). */
export function computeTransformedBox(
  sourceWidth: number,
  sourceHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  transform: ClipTransform
): TransformedBox | null {
  const { crop } = transform;
  const cropX = sourceWidth * crop.left;
  const cropY = sourceHeight * crop.top;
  const cropWidth = sourceWidth * (1 - crop.left - crop.right);
  const cropHeight = sourceHeight * (1 - crop.top - crop.bottom);
  if (cropWidth <= 0 || cropHeight <= 0) return null;

  const fitScale = Math.min(canvasWidth / cropWidth, canvasHeight / cropHeight);
  const finalScale = fitScale * transform.scale;

  return {
    centerX: canvasWidth / 2 + transform.offsetX,
    centerY: canvasHeight / 2 + transform.offsetY,
    width: cropWidth * finalScale,
    height: cropHeight * finalScale,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
  };
}
