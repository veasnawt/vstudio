import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeAlignmentGuides } from "../src/playback/alignmentGuides.ts";
import type { AlignBox } from "../src/playback/alignmentGuides.ts";

function box(left: number, top: number, right: number, bottom: number): AlignBox {
  return { left, top, right, bottom, centerX: (left + right) / 2, centerY: (top + bottom) / 2 };
}

describe("computeAlignmentGuides", () => {
  it("finds no guides when nothing is close enough", () => {
    const dragged = box(0, 0, 100, 100);
    const candidates = [box(500, 500, 600, 600)];

    const result = computeAlignmentGuides(dragged, candidates, 5);

    assert.deepEqual(result.guides, []);
    assert.equal(result.snapDx, 0);
    assert.equal(result.snapDy, 0);
  });

  it("snaps center-to-center when the dragged box's center is close to a candidate's center", () => {
    // Dragged center: (50, 50). Candidate center: (53, 50) — 3px off on x, exact on y.
    const dragged = box(0, 0, 100, 100);
    const candidate = box(3, 0, 103, 100);

    const result = computeAlignmentGuides(dragged, [candidate], 8);

    assert.ok(result.guides.some((g) => g.axis === "x" && g.position === 53));
    assert.ok(result.guides.some((g) => g.axis === "y" && g.position === 50));
    // Snapping moves the dragged box so its center LANDS exactly on the candidate's center.
    assert.equal(result.snapDx, 3);
    assert.equal(result.snapDy, 0);
  });

  it("matches a dragged edge against a DIFFERENT candidate edge (left against right, not just left-left)", () => {
    // Dragged left edge at x=100; candidate's RIGHT edge at x=102 — butting up against it.
    const dragged = box(100, 0, 200, 100);
    const candidate = box(0, 0, 102, 100);

    const result = computeAlignmentGuides(dragged, [candidate], 5);

    assert.ok(result.guides.some((g) => g.axis === "x" && g.position === 102));
    assert.equal(result.snapDx, 2);
  });

  it("picks the CLOSEST match per axis when several candidates are within threshold", () => {
    const dragged = box(0, 0, 100, 100); // center (50, 50)
    const near = box(4, 0, 104, 100); // center 54 — 4px off
    const far = box(-9, 0, 91, 100); // center 41 — 9px off, still within a generous threshold

    const result = computeAlignmentGuides(dragged, [near, far], 10);

    // Both should produce guide lines (both within threshold)...
    assert.ok(result.guides.some((g) => g.axis === "x" && g.position === 54));
    assert.ok(result.guides.some((g) => g.axis === "x" && g.position === 41));
    // ...but the snap follows the closer one.
    assert.equal(result.snapDx, 4);
  });

  it("treats each axis independently — a match on x doesn't require one on y", () => {
    const dragged = box(0, 0, 100, 100);
    const candidate = box(0, 500, 100, 600); // same left/center/right x, unrelated y

    const result = computeAlignmentGuides(dragged, [candidate], 5);

    assert.ok(result.guides.some((g) => g.axis === "x"));
    assert.ok(!result.guides.some((g) => g.axis === "y"));
    assert.equal(result.snapDy, 0);
  });

  it("dedupes guide lines at the same position from multiple matching candidates", () => {
    const dragged = box(0, 0, 100, 100);
    const a = box(2, 0, 102, 100);
    const b = box(2, 200, 102, 300);

    const result = computeAlignmentGuides(dragged, [a, b], 5);

    assert.equal(result.guides.filter((g) => g.axis === "x" && g.position === 52).length, 1);
  });
});
