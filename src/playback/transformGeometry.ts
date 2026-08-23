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

export interface ScreenPoint {
  x: number;
  y: number;
}

/** Screen position of a point `localX`/`localY` CSS px from `pivotX`/`pivotY` (before rotation),
 *  rotated by `rotationDeg` around that pivot. Extracted from `TransformHandles`'/`TextTransformHandles`'
 *  own scale-anchor and corner/rotate-handle math so drag math and render-position math share one
 *  implementation, and it's unit-testable without a DOM. */
export function rotatedPoint(pivotX: number, pivotY: number, localX: number, localY: number, rotationDeg: number): ScreenPoint {
  const theta = (rotationDeg * Math.PI) / 180;
  return {
    x: pivotX + localX * Math.cos(theta) - localY * Math.sin(theta),
    y: pivotY + localX * Math.sin(theta) + localY * Math.cos(theta),
  };
}

/** Clamps `point` into `rect`, inset by `margin` on every side — so a circular handle of that radius
 *  is never visually cut at the edge of the visible frame. Used to keep a Transform/Effects clip's
 *  on-canvas Position/Scale/Rotation handles reachable even when the clip is scaled up far larger than
 *  the visible preview — without this, a corner or rotate handle can render entirely outside the
 *  browser viewport (or behind another panel) with nothing to grab, which is a real, confirmed bug, not
 *  a hypothetical one. `rect` is a plain structural type, not `DOMRect` itself, so a test can pass a
 *  bare object literal — no DOM/jsdom needed. A `rect` narrower or shorter than `2 * margin` caps the
 *  margin down to half that axis's own extent, so the resulting min/max bounds can never invert. */
export function clampPointToRect(
  point: ScreenPoint,
  rect: { left: number; top: number; right: number; bottom: number },
  margin: number
): ScreenPoint {
  const marginX = Math.min(margin, (rect.right - rect.left) / 2);
  const marginY = Math.min(margin, (rect.bottom - rect.top) / 2);
  return {
    x: Math.min(rect.right - marginX, Math.max(rect.left + marginX, point.x)),
    y: Math.min(rect.bottom - marginY, Math.max(rect.top + marginY, point.y)),
  };
}
