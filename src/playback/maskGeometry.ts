import type { TransformedBox } from "./transformGeometry.ts";

/** A rectangle in the SOURCE asset's own native pixel space — what `drawbox` (and, in turn, the
 *  inpainting model's mask video) needs. */
export interface SourceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Inverse of `computeTransformedBox`'s forward pipeline (crop → fit-scale → user-scale → rotate →
 *  translate): given a rectangle drawn on screen — already converted to SEQUENCE pixel space via the
 *  same `canvasRect.width / sequence.width` ratio `TransformHandles` uses — and the clip's resolved
 *  box, returns the equivalent axis-aligned rectangle in the SOURCE asset's own native pixel space.
 *
 *  `box.width === box.cropWidth * finalScale` (see `computeTransformedBox`'s own return shape), so
 *  `finalScale` is recoverable directly from the box alone (`box.width / box.cropWidth`) without
 *  needing the original `ClipTransform.scale` separately — only `rotationDeg` isn't carried on
 *  `TransformedBox`, so it's the one extra parameter this needs.
 *
 *  Rotation is handled by inverse-rotating each of the drawn rectangle's 4 corners individually, then
 *  taking their axis-aligned bounding box in source space — not a perfect inverse when
 *  `rotationDeg !== 0` (the true inverse-mapped shape is itself a rotated rectangle; this is its
 *  bounding box, up to ~40% larger at 45°). That's acceptable here: the inpainting mask has to be an
 *  axis-aligned rectangle regardless of what shape the math would "ideally" produce, so a bounding box
 *  IS the correct target shape — the imprecision only ever erases a bit more margin than the user
 *  literally drew, never the wrong region. */
export function mapSequenceRectToSourceRect(
  sequenceRect: { x: number; y: number; width: number; height: number },
  box: TransformedBox,
  rotationDeg: number
): SourceRect {
  const finalScale = box.cropWidth > 0 ? box.width / box.cropWidth : 1;
  // `rotationDeg` is clockwise in screen (y-down) space — the same convention `ClipTransform`'s own
  // doc comment states and Canvas 2D's `ctx.rotate()` uses for a positive angle. Negating it here is
  // what turns the FORWARD rotation into its inverse.
  const theta = (-rotationDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  const corners = [
    { x: sequenceRect.x, y: sequenceRect.y },
    { x: sequenceRect.x + sequenceRect.width, y: sequenceRect.y },
    { x: sequenceRect.x, y: sequenceRect.y + sequenceRect.height },
    { x: sequenceRect.x + sequenceRect.width, y: sequenceRect.y + sequenceRect.height },
  ].map(({ x, y }) => {
    const localX = x - box.centerX;
    const localY = y - box.centerY;
    const rx = localX * cos - localY * sin;
    const ry = localX * sin + localY * cos;
    return {
      x: box.cropX + rx / finalScale + box.cropWidth / 2,
      y: box.cropY + ry / finalScale + box.cropHeight / 2,
    };
  });

  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const minX = Math.max(0, Math.min(...xs));
  const minY = Math.max(0, Math.min(...ys));
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

/** Forward direction of the same mapping — a rectangle already in SOURCE pixel space (the committed,
 *  previously-drawn rect) back to SEQUENCE pixel space, for rendering it as a static highlight on the
 *  preview canvas when the "Remove Object" tool isn't actively drawing. Only needs to handle the
 *  axis-aligned-rectangle-in, axis-aligned-rectangle-out case (rotation, if any, is applied to the
 *  whole box uniformly) since that's the only shape this module ever stores. */
export function mapSourceRectToSequenceRect(
  sourceRect: SourceRect,
  box: TransformedBox,
  rotationDeg: number
): { x: number; y: number; width: number; height: number } {
  const finalScale = box.cropWidth > 0 ? box.width / box.cropWidth : 1;
  const theta = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  const corners = [
    { x: sourceRect.x, y: sourceRect.y },
    { x: sourceRect.x + sourceRect.width, y: sourceRect.y },
    { x: sourceRect.x, y: sourceRect.y + sourceRect.height },
    { x: sourceRect.x + sourceRect.width, y: sourceRect.y + sourceRect.height },
  ].map(({ x, y }) => {
    const localX = (x - box.cropX - box.cropWidth / 2) * finalScale;
    const localY = (y - box.cropY - box.cropHeight / 2) * finalScale;
    const rx = localX * cos - localY * sin;
    const ry = localX * sin + localY * cos;
    return { x: box.centerX + rx, y: box.centerY + ry };
  });

  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };
}
