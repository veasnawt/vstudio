import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapSequenceRectToSourceRect, mapSourceRectToSequenceRect } from "../src/playback/maskGeometry.ts";
import { computeTransformedBox } from "../src/playback/transformGeometry.ts";
import { IDENTITY_TRANSFORM } from "../src/project/types.ts";
import { closeTo } from "./fixture.ts";

describe("mapSequenceRectToSourceRect", () => {
  it("at identity (no crop/scale/rotation beyond the automatic fit), maps back through the fit scale alone", () => {
    // 1920x1080 source fit into a 1080x1920 canvas — same fixture shape transformGeometry.test.ts
    // uses. fitScale = min(1080/1920, 1920/1080) = 0.5625, so a 200x100 sequence-space rect should
    // become a (200/0.5625) x (100/0.5625) source-space rect.
    const box = computeTransformedBox(1920, 1080, 1080, 1920, IDENTITY_TRANSFORM)!;
    const sequenceRect = { x: box.centerX - 100, y: box.centerY - 50, width: 200, height: 100 };

    const source = mapSequenceRectToSourceRect(sequenceRect, box, 0);

    assert.ok(closeTo(source.width, 200 / 0.5625, 1e-6));
    assert.ok(closeTo(source.height, 100 / 0.5625, 1e-6));
    // Centered on the box's own center, so it should also land centered on the source's own center.
    assert.ok(closeTo(source.x + source.width / 2, box.cropX + box.cropWidth / 2, 1e-6));
    assert.ok(closeTo(source.y + source.height / 2, box.cropY + box.cropHeight / 2, 1e-6));
  });

  it("accounts for a crop offset — a rect at the very top-left of the displayed box maps to the crop's own top-left, not (0,0)", () => {
    const transform = { ...IDENTITY_TRANSFORM, crop: { top: 0, bottom: 0, left: 0.25, right: 0 } };
    const box = computeTransformedBox(1920, 1080, 1080, 1920, transform)!;
    // The box's own visible top-left corner in sequence space.
    const topLeft = { x: box.centerX - box.width / 2, y: box.centerY - box.height / 2, width: 1, height: 1 };

    const source = mapSequenceRectToSourceRect(topLeft, box, 0);

    assert.ok(closeTo(source.x, box.cropX, 1));
    assert.ok(closeTo(source.y, box.cropY, 1));
  });

  it("accounts for the user scale multiplier — zooming in 2x halves the source-space size of a given sequence-space rect", () => {
    const fitBox = computeTransformedBox(1920, 1080, 1080, 1920, IDENTITY_TRANSFORM)!;
    const zoomedBox = computeTransformedBox(1920, 1080, 1080, 1920, { ...IDENTITY_TRANSFORM, scale: 2 })!;
    // Centered on the box (both boxes share the same center — scale doesn't move it) and well inside
    // the visible frame, so the function's own negative-coordinate clamp never kicks in and distorts
    // the otherwise-linear scale relationship this test is checking.
    const sequenceRect = { x: fitBox.centerX - 50, y: fitBox.centerY - 50, width: 100, height: 100 };

    const atFit = mapSequenceRectToSourceRect(sequenceRect, fitBox, 0);
    const atZoomed = mapSequenceRectToSourceRect(sequenceRect, zoomedBox, 0);

    assert.ok(closeTo(atZoomed.width, atFit.width / 2, 1e-6));
    assert.ok(closeTo(atZoomed.height, atFit.height / 2, 1e-6));
  });

  it("a 90° clockwise rotation maps a point to the RIGHT of center to a point ABOVE center in source space", () => {
    // A clean case with no fractional trig noise: identity scale/crop (finalScale === 1), so
    // cos/sin(-90°) are exactly 0/-1/1 with no floating-point residue to tolerance-check around.
    const box = computeTransformedBox(1920, 1080, 1920, 1080, IDENTITY_TRANSFORM)!;
    const rightOfCenter = { x: box.centerX + 100, y: box.centerY, width: 1, height: 1 };

    const source = mapSequenceRectToSourceRect(rightOfCenter, box, 90);

    // Hand-derived: rotating a point that sits at source "top" (above center) by 90° clockwise
    // moves it to screen "right" of center — so inverting that (screen-right → source) must land
    // above center, i.e. at a smaller y than the crop's own center.
    assert.ok(source.y < box.cropY + box.cropHeight / 2, `expected the mapped point above source center, got y=${source.y}`);
    assert.ok(closeTo(source.x, box.cropX + box.cropWidth / 2, 1), `expected the mapped point on-center horizontally, got x=${source.x}`);
  });

  it("clamps a rect that would extend past the top-left into negative source coordinates", () => {
    const box = computeTransformedBox(1920, 1080, 1080, 1920, IDENTITY_TRANSFORM)!;
    // Drawn well outside the box's own top-left corner.
    const offscreen = { x: box.centerX - box.width, y: box.centerY - box.height, width: 10, height: 10 };

    const source = mapSequenceRectToSourceRect(offscreen, box, 0);

    assert.ok(source.x >= 0, `expected x clamped to >= 0, got ${source.x}`);
    assert.ok(source.y >= 0, `expected y clamped to >= 0, got ${source.y}`);
  });

  it("never returns a zero or negative width/height even for a degenerate input rect", () => {
    const box = computeTransformedBox(1920, 1080, 1080, 1920, IDENTITY_TRANSFORM)!;
    const source = mapSequenceRectToSourceRect({ x: box.centerX, y: box.centerY, width: 0, height: 0 }, box, 0);

    assert.ok(source.width >= 1);
    assert.ok(source.height >= 1);
  });
});

describe("mapSourceRectToSequenceRect", () => {
  it("round-trips a source rect back to the same sequence rect it came from, at zero rotation", () => {
    const box = computeTransformedBox(1920, 1080, 1080, 1920, IDENTITY_TRANSFORM)!;
    const originalSequenceRect = { x: box.centerX - 80, y: box.centerY - 40, width: 160, height: 80 };

    const source = mapSequenceRectToSourceRect(originalSequenceRect, box, 0);
    const roundTripped = mapSourceRectToSequenceRect(source, box, 0);

    // Exact at rotation 0 — no bounding-box approximation loss happens in either direction when the
    // rectangle never gets rotated relative to the axes it's already aligned with.
    assert.ok(closeTo(roundTripped.x, originalSequenceRect.x, 1e-6));
    assert.ok(closeTo(roundTripped.y, originalSequenceRect.y, 1e-6));
    assert.ok(closeTo(roundTripped.width, originalSequenceRect.width, 1e-6));
    assert.ok(closeTo(roundTripped.height, originalSequenceRect.height, 1e-6));
  });
});
