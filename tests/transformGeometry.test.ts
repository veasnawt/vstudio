import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IDENTITY_TRANSFORM } from "../src/project/types.ts";
import { computeTransformedBox } from "../src/playback/transformGeometry.ts";
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
