import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyLut3D, LutParseError, parseCubeLut } from "../src/timeline/lut.ts";

// A minimal, valid 2x2x2 identity LUT — rows in the .cube spec's own "red fastest" order.
const IDENTITY_2_CUBE = `TITLE "Identity"
LUT_3D_SIZE 2

0.0 0.0 0.0
1.0 0.0 0.0
0.0 1.0 0.0
1.0 1.0 0.0
0.0 0.0 1.0
1.0 0.0 1.0
0.0 1.0 1.0
1.0 1.0 1.0
`;

describe("parseCubeLut", () => {
  it("parses a valid 2x2x2 LUT: size, default domain, and data in file order", () => {
    const lut = parseCubeLut(IDENTITY_2_CUBE);
    assert.equal(lut.size, 2);
    assert.deepEqual(lut.domainMin, [0, 0, 0]);
    assert.deepEqual(lut.domainMax, [1, 1, 1]);
    assert.equal(lut.data.length, 2 * 2 * 2 * 3);
    // First row (0,0,0) -> black.
    assert.deepEqual(Array.from(lut.data.slice(0, 3)), [0, 0, 0]);
    // Second row, lattice coord (1,0,0) -> red-fastest means this is index 1 -> pure red.
    assert.deepEqual(Array.from(lut.data.slice(3, 6)), [1, 0, 0]);
    // Last row (1,1,1) -> white.
    assert.deepEqual(Array.from(lut.data.slice(21, 24)), [1, 1, 1]);
  });

  it("parses explicit DOMAIN_MIN/DOMAIN_MAX lines", () => {
    const text = `LUT_3D_SIZE 2
DOMAIN_MIN 0.1 0.1 0.1
DOMAIN_MAX 0.9 0.9 0.9
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;
    const lut = parseCubeLut(text);
    assert.deepEqual(lut.domainMin, [0.1, 0.1, 0.1]);
    assert.deepEqual(lut.domainMax, [0.9, 0.9, 0.9]);
  });

  it("skips blank lines and # comments", () => {
    const text = `# a comment

LUT_3D_SIZE 2
# another comment
0 0 0
1 0 0
0 1 0
1 1 0

0 0 1
1 0 1
0 1 1
1 1 1
`;
    assert.doesNotThrow(() => parseCubeLut(text));
  });

  it("throws LutParseError when LUT_3D_SIZE is missing entirely", () => {
    assert.throws(() => parseCubeLut("0 0 0\n1 1 1\n"), LutParseError);
  });

  it("throws LutParseError for a LUT_1D_SIZE-only file, with a message naming the 1D scope cut", () => {
    const text = `LUT_1D_SIZE 2
0 0 0
1 1 1
`;
    assert.throws(() => parseCubeLut(text), (err: unknown) => {
      assert.ok(err instanceof LutParseError);
      assert.match(err.message, /1D/);
      return true;
    });
  });

  it("throws LutParseError when the data row count doesn't match size^3 exactly", () => {
    const text = `LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
`;
    assert.throws(() => parseCubeLut(text), LutParseError);
  });
});

describe("applyLut3D", () => {
  it("is a passthrough (within interpolation rounding) for an identity LUT", () => {
    const lut = parseCubeLut(IDENTITY_2_CUBE);
    const imageData = { data: new Uint8ClampedArray([10, 128, 250, 200, 0, 64, 255, 77]) };
    const before = Array.from(imageData.data);
    applyLut3D(imageData, lut);
    for (let i = 0; i < before.length; i += 4) {
      assert.ok(Math.abs(imageData.data[i] - before[i]) <= 1, `R mismatch at pixel ${i / 4}`);
      assert.ok(Math.abs(imageData.data[i + 1] - before[i + 1]) <= 1, `G mismatch at pixel ${i / 4}`);
      assert.ok(Math.abs(imageData.data[i + 2] - before[i + 2]) <= 1, `B mismatch at pixel ${i / 4}`);
    }
  });

  it("never touches alpha", () => {
    const lut = parseCubeLut(IDENTITY_2_CUBE);
    const imageData = { data: new Uint8ClampedArray([10, 20, 30, 42]) };
    applyLut3D(imageData, lut);
    assert.equal(imageData.data[3], 42);
  });

  it("applies a non-identity LUT (channel swap) correctly", () => {
    // A LUT that swaps R and B — index order still red-fastest, but each row's OUTPUT has r/b swapped
    // versus the identity cube above.
    const text = `LUT_3D_SIZE 2
0 0 0
0 0 1
0 1 0
0 1 1
1 0 0
1 0 1
1 1 0
1 1 1
`;
    const lut = parseCubeLut(text);
    const imageData = { data: new Uint8ClampedArray([255, 0, 0, 255]) }; // pure red in
    applyLut3D(imageData, lut);
    // Pure red (1,0,0) should map to pure blue (0,0,1) under an R/B swap LUT.
    assert.ok(imageData.data[0] < 5, `expected R~0, got ${imageData.data[0]}`);
    assert.ok(imageData.data[2] > 250, `expected B~255, got ${imageData.data[2]}`);
  });
});
