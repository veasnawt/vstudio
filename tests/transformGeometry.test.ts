import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IDENTITY_TRANSFORM } from "../src/project/types.ts";
import { clampPointToRect, computeTransformedBox, rotatedPoint } from "../src/playback/transformGeometry.ts";
import { closeTo } from "./fixture.ts";

describe("computeTransformedBox", () => {
  it("letterboxes a wider-than-tall source into a taller-than-wide frame at identity", () => {
    // 16:9 source into a 9:16 frame — width is the constraint, so the fit scale comes from width.
    const box = computeTransformedBox(1920, 1080, 1080, 1920, IDENTITY_TRANSFORM)!;

    assert.ok(closeTo(box.width, 1080));
    assert.ok(closeTo(box.height, 1080 * (1080 / 1920)));
    assert.ok(closeTo(box.centerX, 540));
    assert.ok(closeTo(box.centerY, 960));
  });

  it("crops before fitting, so the fit scale reflects the CROPPED dimensions, not the original", () => {
    // Cropping 28% off each side narrows a 1920×1080 source to 844.8×1080 — a shape closer to
    // square, though still wide enough that width (not height) remains the fitting constraint
    // against the 1080×1920 frame.
    const transform = { ...IDENTITY_TRANSFORM, crop: { top: 0, bottom: 0, left: 0.28, right: 0.28 } };
    const box = computeTransformedBox(1920, 1080, 1080, 1920, transform)!;
    const croppedWidth = 1920 * (1 - 0.28 - 0.28);
    const expectedFitScale = Math.min(1080 / croppedWidth, 1920 / 1080);

    assert.ok(closeTo(box.cropWidth, croppedWidth));
    assert.ok(closeTo(box.cropHeight, 1080));
    assert.ok(closeTo(box.width, croppedWidth * expectedFitScale));
    assert.ok(closeTo(box.height, 1080 * expectedFitScale));
    // Both the cropped and uncropped cases happen to be width-constrained here (the source stays
    // wider than the frame either way), so `width` alone doesn't show the crop's effect — `height`
    // does: fitting a NARROWER cropped source to the same available width means zooming in more,
    // which makes the rendered box taller, not shorter. The point isn't "bigger" or "smaller" in the
    // abstract, it's that the crop's dimensions are what fitting was computed against, not the
    // original source's.
    const uncropped = computeTransformedBox(1920, 1080, 1080, 1920, IDENTITY_TRANSFORM)!;
    assert.ok(box.height > uncropped.height, `expected the crop to zoom in (taller box), got ${box.height} vs ${uncropped.height}`);
  });

  it("applies the user scale multiplier on top of the fit scale", () => {
    const fit = computeTransformedBox(1920, 1080, 1080, 1920, IDENTITY_TRANSFORM)!;
    const zoomed = computeTransformedBox(1920, 1080, 1080, 1920, { ...IDENTITY_TRANSFORM, scale: 2 })!;

    assert.ok(closeTo(zoomed.width, fit.width * 2));
    assert.ok(closeTo(zoomed.height, fit.height * 2));
  });

  it("offsets the center without affecting size", () => {
    const box = computeTransformedBox(1920, 1080, 1080, 1920, { ...IDENTITY_TRANSFORM, offsetX: 40, offsetY: -25 })!;

    assert.ok(closeTo(box.centerX, 540 + 40));
    assert.ok(closeTo(box.centerY, 960 - 25));
  });

  it("returns null for a crop that would leave nothing visible", () => {
    // setClipTransform always clamps against this in practice, but the geometry function itself
    // shouldn't divide by zero or return a negative-size box if it's ever handed one anyway.
    const box = computeTransformedBox(1920, 1080, 1080, 1920, {
      ...IDENTITY_TRANSFORM,
      crop: { top: 0, bottom: 0, left: 0.6, right: 0.6 },
    });

    assert.equal(box, null);
  });
});

describe("rotatedPoint", () => {
  it("returns the local offset unrotated at 0 degrees", () => {
    const p = rotatedPoint(500, 500, 100, 0, 0);
    assert.ok(closeTo(p.x, 600));
    assert.ok(closeTo(p.y, 500));
  });

  it("rotates a point 90 degrees clockwise around the pivot", () => {
    // A point 100px to the right of the pivot, rotated 90°, ends up 100px BELOW it (screen Y grows
    // downward) — the same direction `TransformHandles`'/`TextTransformHandles`' own rotate handles
    // already visibly sweep in the running app.
    const p = rotatedPoint(500, 500, 100, 0, 90);
    assert.ok(closeTo(p.x, 500));
    assert.ok(closeTo(p.y, 600));
  });

  it("rotates a point 180 degrees to the opposite side of the pivot", () => {
    const p = rotatedPoint(500, 500, 100, 0, 180);
    assert.ok(closeTo(p.x, 400, 1e-6));
    assert.ok(closeTo(p.y, 500, 1e-6));
  });

  it("matches the pre-refactor inline anchor formula TransformHandles used to compute directly", () => {
    // Regression pin: the exact expression `beginDrag`'s scale-anchor computation used before it was
    // extracted into this shared helper (cssCenter + local rotated by theta), for a representative
    // scale/rotation combination.
    const cssCenterX = 320;
    const cssCenterY = 480;
    const localX = -150;
    const localY = 90;
    const rotationDeg = 37;
    const theta = (rotationDeg * Math.PI) / 180;
    const expectedX = cssCenterX + localX * Math.cos(theta) - localY * Math.sin(theta);
    const expectedY = cssCenterY + localX * Math.sin(theta) + localY * Math.cos(theta);

    const p = rotatedPoint(cssCenterX, cssCenterY, localX, localY, rotationDeg);

    assert.ok(closeTo(p.x, expectedX));
    assert.ok(closeTo(p.y, expectedY));
  });
});

describe("clampPointToRect", () => {
  const rect = { left: 0, top: 0, right: 200, bottom: 100 };

  it("leaves an in-bounds point unchanged", () => {
    const p = clampPointToRect({ x: 50, y: 50 }, rect, 10);
    assert.deepEqual(p, { x: 50, y: 50 });
  });

  it("clamps a point past the right edge on the X axis only", () => {
    const p = clampPointToRect({ x: 500, y: 50 }, rect, 10);
    assert.ok(closeTo(p.x, 190));
    assert.ok(closeTo(p.y, 50));
  });

  it("clamps a point past the left edge on the X axis only", () => {
    const p = clampPointToRect({ x: -500, y: 50 }, rect, 10);
    assert.ok(closeTo(p.x, 10));
    assert.ok(closeTo(p.y, 50));
  });

  it("clamps a point past the top/bottom edges on the Y axis only", () => {
    const below = clampPointToRect({ x: 50, y: 500 }, rect, 10);
    assert.ok(closeTo(below.y, 90));
    const above = clampPointToRect({ x: 50, y: -500 }, rect, 10);
    assert.ok(closeTo(above.y, 10));
  });

  it("clamps a point past a corner on both axes at once", () => {
    const p = clampPointToRect({ x: 9999, y: -9999 }, rect, 10);
    assert.ok(closeTo(p.x, 190));
    assert.ok(closeTo(p.y, 10));
  });

  it("never inverts min/max for a rect narrower/shorter than 2×margin", () => {
    const tinyRect = { left: 0, top: 0, right: 10, bottom: 4 };
    const p = clampPointToRect({ x: 9999, y: 9999 }, tinyRect, 50);
    // Margin caps to half the axis extent, so the clamped bounds collapse to the rect's own midline
    // rather than crossing over each other.
    assert.ok(closeTo(p.x, 5));
    assert.ok(closeTo(p.y, 2));
  });
});
