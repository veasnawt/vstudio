import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeHistogram, computeVectorscope, computeWaveform } from "../src/timeline/scopes.ts";

/** Builds a flat RGBA buffer for a solid-color `width`x`height` image — the "known pixel values"
 *  fixture shape every test below starts from. */
function solidImage(width: number, height: number, r: number, g: number, b: number, a = 255) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return { data, width, height };
}

describe("computeWaveform", () => {
  it("buckets a solid mid-gray image into one dominant luma level per column", () => {
    const image = solidImage(8, 8, 128, 128, 128);
    const waveform = computeWaveform(image, 4);

    for (let col = 0; col < 4; col++) {
      const row = waveform.slice(col * 256, col * 256 + 256);
      const total = row.reduce((sum, v) => sum + v, 0);
      const maxIndex = row.indexOf(Math.max(...row));
      // Every sampled pixel in this column lands in the SAME luma bucket (128 for pure mid-gray).
      assert.equal(row[maxIndex], total, `column ${col} should have all density in one bucket`);
      assert.equal(maxIndex, 128);
    }
  });

  it("returns an all-zero grid for a degenerate (zero-size) image", () => {
    const waveform = computeWaveform({ data: new Uint8ClampedArray(0), width: 0, height: 0 }, 4);
    assert.equal(waveform.length, 256 * 4);
    assert.ok(waveform.every((v) => v === 0));
  });

  it("separates two differently-lit halves into two distinct dominant columns", () => {
    // Left half black, right half white — sampled columns should land in two very different buckets.
    const width = 8;
    const height = 4;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const v = x < width / 2 ? 0 : 255;
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
    const waveform = computeWaveform({ data, width, height }, width);

    const firstColDominant = waveform.slice(0, 256).indexOf(Math.max(...waveform.slice(0, 256)));
    const lastColDominant = waveform.slice((width - 1) * 256, width * 256).indexOf(Math.max(...waveform.slice((width - 1) * 256, width * 256)));
    assert.equal(firstColDominant, 0);
    assert.equal(lastColDominant, 255);
  });
});

describe("computeVectorscope", () => {
  it("places a fully desaturated (gray) image's density at the grid center", () => {
    const image = solidImage(8, 8, 128, 128, 128);
    const gridSize = 33;
    const vector = computeVectorscope(image, gridSize);

    const total = vector.reduce((sum, v) => sum + v, 0);
    assert.ok(total > 0);
    const center = Math.floor(gridSize / 2);
    // Gray has (near-)zero Cb/Cr, so its density should land at (or immediately adjacent to, given
    // rounding) the grid's own center cell.
    const centerIndex = center * gridSize + center;
    assert.equal(vector[centerIndex], total, "all density should land in the exact center cell for pure gray");
  });

  it("places a saturated color's density off-center", () => {
    const image = solidImage(8, 8, 255, 0, 0); // pure red — strongly non-zero chroma
    const gridSize = 33;
    const vector = computeVectorscope(image, gridSize);
    const center = Math.floor(gridSize / 2);
    const centerIndex = center * gridSize + center;
    assert.equal(vector[centerIndex], 0, "pure red must not land at the zero-chroma center");
  });

  it("returns an all-zero grid for a degenerate (zero-size) image", () => {
    const vector = computeVectorscope({ data: new Uint8ClampedArray(0), width: 0, height: 0 }, 33);
    assert.ok(vector.every((v) => v === 0));
  });
});

describe("computeHistogram", () => {
  it("buckets a solid color image entirely into that color's own bin, per channel", () => {
    const image = solidImage(8, 8, 10, 200, 90);
    const { r, g, b } = computeHistogram(image);

    const totalR = r.reduce((sum, v) => sum + v, 0);
    const totalG = g.reduce((sum, v) => sum + v, 0);
    const totalB = b.reduce((sum, v) => sum + v, 0);
    assert.ok(totalR > 0);

    assert.equal(r[10], totalR);
    assert.equal(g[200], totalG);
    assert.equal(b[90], totalB);
  });

  it("splits density across two bins for a half-and-half image", () => {
    const width = 8;
    const height = 8;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const v = y < height / 2 ? 0 : 255;
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
    const { r } = computeHistogram({ data, width, height });
    assert.ok(r[0] > 0);
    assert.ok(r[255] > 0);
    assert.equal(r[0], r[255], "the two halves are equal in size, so their bin counts should match");
  });

  it("returns all-zero bins for a degenerate (zero-size) image", () => {
    const { r, g, b } = computeHistogram({ data: new Uint8ClampedArray(0), width: 0, height: 0 });
    assert.ok(r.every((v) => v === 0) && g.every((v) => v === 0) && b.every((v) => v === 0));
  });
});
