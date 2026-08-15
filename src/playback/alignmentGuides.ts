/** An object's bounding box in whatever pixel space the caller is working in (canvas backing-store
 *  pixels for the computations below). Deliberately axis-aligned even for a rotated clip — the same
 *  simplification most editors make for alignment guides: align to the object's nominal box, not its
 *  rotated silhouette, which is both what a user expects ("does this line up with that one") and far
 *  cheaper than computing a rotated shape's true bounds. */
export interface AlignBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
}

export interface AlignmentGuide {
  axis: "x" | "y";
  /** Where this guide line sits, in the same pixel space as the boxes passed in. */
  position: number;
}

export interface AlignmentResult {
  /** Every line worth drawing — one per distinct position where the dragged box's edge/center comes
   *  within `threshold` of some candidate's edge/center. Independent per axis, so a diagonal drag can
   *  show one vertical AND one horizontal guide at once. */
  guides: AlignmentGuide[];
  /** How far to nudge the dragged box so it lands EXACTLY on the closest matching guide — 0 on an
   *  axis with no match within `threshold`. Applying this to the drag's raw position is what makes a
   *  guide a genuine snap, not just a decorative line. */
  snapDx: number;
  snapDy: number;
}

function xValues(b: AlignBox): number[] {
  return [b.left, b.centerX, b.right];
}
function yValues(b: AlignBox): number[] {
  return [b.top, b.centerY, b.bottom];
}

/** Compares `dragged` against every box in `candidates` (every OTHER currently-visible clip, plus the
 *  sequence frame itself) on each axis independently: left-left, left-right, center-center, right-
 *  left, right-right, and the same three pairings for top/center/bottom vertically. The single
 *  CLOSEST match per axis (not necessarily the same candidate on both axes) drives the snap; every
 *  match within `threshold` gets a guide line, even ones that aren't the closest, so a user dragging
 *  near several aligned objects at once sees all of them. */
export function computeAlignmentGuides(dragged: AlignBox, candidates: AlignBox[], threshold: number): AlignmentResult {
  let bestX: { distance: number; position: number; delta: number } | null = null;
  let bestY: { distance: number; position: number; delta: number } | null = null;
  const guides: AlignmentGuide[] = [];
  const seenX = new Set<number>();
  const seenY = new Set<number>();

  for (const candidate of candidates) {
    for (const dv of xValues(dragged)) {
      for (const cv of xValues(candidate)) {
        const distance = Math.abs(dv - cv);
        if (distance > threshold) continue;
        if (!seenX.has(cv)) {
          seenX.add(cv);
          guides.push({ axis: "x", position: cv });
        }
        if (!bestX || distance < bestX.distance) bestX = { distance, position: cv, delta: cv - dv };
      }
    }
    for (const dv of yValues(dragged)) {
      for (const cv of yValues(candidate)) {
        const distance = Math.abs(dv - cv);
        if (distance > threshold) continue;
        if (!seenY.has(cv)) {
          seenY.add(cv);
          guides.push({ axis: "y", position: cv });
        }
        if (!bestY || distance < bestY.distance) bestY = { distance, position: cv, delta: cv - dv };
      }
    }
  }

  return { guides, snapDx: bestX?.delta ?? 0, snapDy: bestY?.delta ?? 0 };
}
