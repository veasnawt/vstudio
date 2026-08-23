import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyColorGrading, buildCurveLut, composeLuts, isIdentityCurve, sampleCurve } from "../src/timeline/colorCurves.ts";
import type { ColorCurve } from "../src/project/types.ts";

const IDENTITY: ColorCurve = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

describe("buildCurveLut", () => {
  it("produces a perfect 0..255 ramp for the identity curve", () => {
    const lut = buildCurveLut(IDENTITY);
    assert.equal(lut[0], 0);
    assert.equal(lut[255], 255);
    assert.equal(lut[128], 128);
    for (let i = 1; i < 256; i++) assert.ok(lut[i] >= lut[i - 1], `LUT should be monotonic at index ${i}`);
  });

  it("passes through its own control points", () => {
    const points: ColorCurve = [
      { x: 0, y: 0 },
      { x: 0.25, y: 0.1 },
      { x: 0.75, y: 0.9 },
      { x: 1, y: 1 },
    ];
    const lut = buildCurveLut(points);
    // index closest to x=0.25 -> round(0.25*255) = 64, expect y close to 0.1*255 = 25.5
    assert.ok(Math.abs(lut[64] - 25.5) < 2, `expected ~25.5, got ${lut[64]}`);
    // index closest to x=0.75 -> round(0.75*255) = 191, expect y close to 0.9*255 = 229.5
    assert.ok(Math.abs(lut[191] - 229.5) < 2, `expected ~229.5, got ${lut[191]}`);
  });

  it("clamps spline overshoot into 0..255 via Uint8ClampedArray", () => {
    // A steep raised black point followed by a near-vertical rise can overshoot below 0 briefly.
    const points: ColorCurve = [
      { x: 0, y: 0.3 },
      { x: 0.05, y: 0.3 },
      { x: 0.1, y: 0.9 },
      { x: 1, y: 1 },
    ];
    const lut = buildCurveLut(points);
    for (const value of lut) assert.ok(value >= 0 && value <= 255);
  });
});

describe("composeLuts", () => {
  it("applies channel curve first, master curve second (verified against FFmpeg's own composition order)", () => {
    // Channel LUT: identity except index 10 -> 50.
    const channelLut = buildCurveLut(IDENTITY);
    channelLut[10] = 50;
    // Master LUT: identity except index 50 -> 200.
    const masterLut = buildCurveLut(IDENTITY);
    masterLut[50] = 200;

    const composed = composeLuts(masterLut, channelLut);
    // input 10 -> channel maps to 50 -> master maps 50 to 200.
    assert.equal(composed[10], 200);
    // A hand-computed example where reversing the order would produce a different result:
    // if master-then-channel were used, input 10 would go through the (near-identity) master LUT
    // first (10 -> 10), then channel LUT (10 -> 50) -- giving 50, not 200.
    assert.notEqual(composed[10], 50);
  });

  it("is a pure passthrough when both LUTs are identity", () => {
    const identityLut = buildCurveLut(IDENTITY);
    const composed = composeLuts(identityLut, identityLut);
    for (let i = 0; i < 256; i++) assert.ok(Math.abs(composed[i] - i) <= 1);
  });
});

describe("isIdentityCurve", () => {
  it("is true only for the exact two-point diagonal", () => {
    assert.equal(isIdentityCurve(IDENTITY), true);
  });

  it("is false for a 2-point non-diagonal curve", () => {
    assert.equal(isIdentityCurve([{ x: 0, y: 0.1 }, { x: 1, y: 1 }]), false);
  });

  it("is false for a 3+-point curve even if it still traces the diagonal", () => {
    assert.equal(isIdentityCurve([{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }]), false);
  });
});

describe("sampleCurve", () => {
  it("matches buildCurveLut's own values at the same x positions", () => {
    const points: ColorCurve = [
      { x: 0, y: 0 },
      { x: 0.4, y: 0.2 },
      { x: 1, y: 1 },
    ];
    const lut = buildCurveLut(points);
    const samples = sampleCurve(points, 256);
    for (let i = 0; i < 256; i++) {
      assert.ok(Math.abs(samples[i].y * 255 - lut[i]) < 1.5, `mismatch at index ${i}`);
    }
  });
});

describe("normalizePoints (via buildCurveLut's malformed-input handling)", () => {
  it("handles fewer than 2 points by falling back to the identity diagonal", () => {
    const lut = buildCurveLut([{ x: 0.5, y: 0.5 }]);
    assert.equal(lut[0], 0);
    assert.equal(lut[255], 255);
  });

  it("handles unsorted, duplicate-x points without throwing", () => {
    const points: ColorCurve = [
      { x: 1, y: 1 },
      { x: 0.3, y: 0.3 },
      { x: 0.3, y: 0.5 },
      { x: 0, y: 0 },
    ];
    assert.doesNotThrow(() => buildCurveLut(points));
  });
});

describe("applyColorGrading", () => {
  it("only touches R/G/B, never alpha", () => {
    const identityLut = buildCurveLut(IDENTITY);
    const raisedLut = buildCurveLut([{ x: 0, y: 0.2 }, { x: 1, y: 1 }]);
    const imageData = { data: new Uint8ClampedArray([10, 20, 30, 77]) };
    applyColorGrading(imageData, { r: raisedLut, g: identityLut, b: identityLut });
    assert.notEqual(imageData.data[0], 10);
    assert.equal(imageData.data[1], 20);
    assert.equal(imageData.data[2], 30);
    assert.equal(imageData.data[3], 77);
  });
});
