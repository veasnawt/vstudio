import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyGlitch,
  applyWaterRipple,
  WATER_RIPPLE_AMPLITUDE_PX,
  WATER_RIPPLE_WAVELENGTH_PX,
  WATER_RIPPLE_PERIOD_SECONDS,
} from "../src/timeline/pixelEffects.ts";

/** Node has no native `ImageData` (a browser/Canvas API) — this stub matches the exact shape
 *  `applyGlitch`/`applyWaterRipple` actually read (`width`/`height`/`data`), same "just the shape
 *  under test, not a real DOM" reasoning any other non-DOM stub in this test suite already follows. */
function makeImageData(width: number, height: number): ImageData {
  return { width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: "srgb" } as ImageData;
}

function setPixel(imageData: ImageData, x: number, y: number, r: number, g: number, b: number, a = 255): void {
  const i = (y * imageData.width + x) * 4;
  imageData.data[i] = r;
  imageData.data[i + 1] = g;
  imageData.data[i + 2] = b;
  imageData.data[i + 3] = a;
}

function getPixel(imageData: ImageData, x: number, y: number): [number, number, number, number] {
  const i = (y * imageData.width + x) * 4;
  return [imageData.data[i], imageData.data[i + 1], imageData.data[i + 2], imageData.data[i + 3]];
}

describe("applyWaterRipple", () => {
  it("is a pure function of elapsedSeconds — same input twice produces byte-identical output", () => {
    const a = makeImageData(120, 60);
    setPixel(a, 60, 30, 255, 255, 255);
    const b = makeImageData(120, 60);
    setPixel(b, 60, 30, 255, 255, 255);
    applyWaterRipple(a, 1.7, 1);
    applyWaterRipple(b, 1.7, 1);
    assert.deepEqual(Array.from(a.data), Array.from(b.data), "identical elapsedSeconds must produce identical output");
  });

  it("displaces a bright pixel horizontally by the exact offset the sine formula predicts", () => {
    const width = 200;
    const height = 60;
    const y = 30;
    const elapsedSeconds = 0.4;
    const speed = 1.3;
    const image = makeImageData(width, height);
    const originalX = 100;
    setPixel(image, originalX, y, 200, 100, 50);
    applyWaterRipple(image, elapsedSeconds, speed);

    // Same formula `applyWaterRipple` itself uses — `output(x) = source(x + offset)`, so the bright
    // source pixel (at `originalX`) shows up in the OUTPUT at `originalX - offset`.
    const rate = (2 * Math.PI) / WATER_RIPPLE_PERIOD_SECONDS;
    const phase = elapsedSeconds * speed * rate;
    const offset = WATER_RIPPLE_AMPLITUDE_PX * Math.sin(y / WATER_RIPPLE_WAVELENGTH_PX + phase);
    const expectedX = Math.round(originalX - offset);

    const [r, g, b] = getPixel(image, expectedX, y);
    assert.deepEqual([r, g, b], [200, 100, 50], `expected the bright pixel to land at x=${expectedX} on row ${y}`);
  });

  it("clamps at the frame edges instead of wrapping the opposite edge's color in", () => {
    const width = 50;
    const height = 20;
    const image = makeImageData(width, height);
    // Fill the whole frame a distinct color so a wrapped sample (reading from the far edge) would be
    // detectably different from a clamped one (reading the SAME near edge repeated).
    for (let y = 0; y < height; y++) {
      setPixel(image, 0, y, 10, 20, 30);
      setPixel(image, width - 1, y, 200, 210, 220);
    }
    // A large amplitude/elapsed combination guaranteed to push some row's sample request past the
    // frame's own width — if this ever threw or produced NaN-derived garbage, the assertions below
    // would fail rather than the test crashing outright either way.
    assert.doesNotThrow(() => applyWaterRipple(image, 100, 5));
    for (let i = 0; i < image.data.length; i++) assert.ok(Number.isFinite(image.data[i]), "no NaN/undefined pixel bytes");
  });
});

describe("applyGlitch", () => {
  it("is a pure function of elapsedSeconds — same input twice produces byte-identical output", () => {
    const a = makeImageData(80, 40);
    setPixel(a, 40, 20, 128, 64, 200);
    const b = makeImageData(80, 40);
    setPixel(b, 40, 20, 128, 64, 200);
    applyGlitch(a, 0.85, 1);
    applyGlitch(b, 0.85, 1);
    assert.deepEqual(Array.from(a.data), Array.from(b.data), "identical elapsedSeconds must produce identical output");
  });

  it("actually changes the image — a real clip's frame isn't left untouched", () => {
    const width = 100;
    const height = 60;
    const image = makeImageData(width, height);
    // A checkerboard-ish pattern with real edges for channel-shift/slice-displacement to act on — a
    // flat single color would hide a channel shift entirely (shifting a uniform color by N pixels is
    // visually and numerically a no-op).
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const on = (Math.floor(x / 10) + Math.floor(y / 10)) % 2 === 0;
        setPixel(image, x, y, on ? 220 : 20, on ? 220 : 20, on ? 220 : 20);
      }
    }
    const before = image.data.slice();
    applyGlitch(image, 1.1, 1);
    assert.notDeepEqual(Array.from(image.data), Array.from(before), "applyGlitch should visibly alter a real frame");
  });

  it("different elapsedSeconds values land in different bursts and produce different output", () => {
    const width = 100;
    const height = 60;
    const makeCheckerboard = () => {
      const image = makeImageData(width, height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const on = (Math.floor(x / 10) + Math.floor(y / 10)) % 2 === 0;
          setPixel(image, x, y, on ? 220 : 20, on ? 220 : 20, on ? 220 : 20);
        }
      }
      return image;
    };
    const early = makeCheckerboard();
    const later = makeCheckerboard();
    applyGlitch(early, 0, 1);
    applyGlitch(later, 5, 1); // several burst periods later — a genuinely different burst index
    assert.notDeepEqual(Array.from(early.data), Array.from(later.data), "different bursts should look different");
  });

  it("stays in bounds — no crash, no NaN — even with an extreme speed", () => {
    const image = makeImageData(40, 40);
    assert.doesNotThrow(() => applyGlitch(image, 3.3, 10));
    for (let i = 0; i < image.data.length; i++) assert.ok(Number.isFinite(image.data[i]), "no NaN/undefined pixel bytes");
  });
});

describe("intensity parameter (transition-style ramping)", () => {
  it("applyWaterRipple with intensity=0 is an exact no-op", () => {
    const width = 60;
    const height = 40;
    const image = makeImageData(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const on = (Math.floor(x / 5) + Math.floor(y / 5)) % 2 === 0;
        setPixel(image, x, y, on ? 220 : 20, on ? 90 : 180, on ? 40 : 210);
      }
    }
    const before = image.data.slice();
    applyWaterRipple(image, 1.5, 1, 0);
    assert.deepEqual(Array.from(image.data), Array.from(before), "intensity=0 must leave every pixel exactly as it was");
  });

  it("applyGlitch with intensity=0 is an exact no-op", () => {
    const width = 60;
    const height = 40;
    const image = makeImageData(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const on = (Math.floor(x / 5) + Math.floor(y / 5)) % 2 === 0;
        setPixel(image, x, y, on ? 220 : 20, on ? 90 : 180, on ? 40 : 210);
      }
    }
    const before = image.data.slice();
    applyGlitch(image, 1.5, 1, 0);
    assert.deepEqual(Array.from(image.data), Array.from(before), "intensity=0 must leave every pixel exactly as it was");
  });

  it("applyWaterRipple with intensity=2 displaces a bright pixel twice as far as intensity=1", () => {
    const width = 200;
    const height = 60;
    const y = 30;
    const elapsedSeconds = 0.4;
    const originalX = 100;

    const at1 = makeImageData(width, height);
    setPixel(at1, originalX, y, 200, 100, 50);
    applyWaterRipple(at1, elapsedSeconds, 1, 1);

    const at2 = makeImageData(width, height);
    setPixel(at2, originalX, y, 200, 100, 50);
    applyWaterRipple(at2, elapsedSeconds, 1, 2);

    const rate = (2 * Math.PI) / WATER_RIPPLE_PERIOD_SECONDS;
    const phase = elapsedSeconds * rate;
    const baseOffset = WATER_RIPPLE_AMPLITUDE_PX * Math.sin(y / WATER_RIPPLE_WAVELENGTH_PX + phase);
    const expectedXAt1 = Math.round(originalX - baseOffset);
    const expectedXAt2 = Math.round(originalX - baseOffset * 2);

    assert.deepEqual(getPixel(at1, expectedXAt1, y).slice(0, 3), [200, 100, 50]);
    assert.deepEqual(getPixel(at2, expectedXAt2, y).slice(0, 3), [200, 100, 50]);
  });

  it("applyGlitch with intensity=1 (the default) is byte-identical to omitting the parameter", () => {
    const width = 80;
    const height = 40;
    const makeCheckerboard = () => {
      const image = makeImageData(width, height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const on = (Math.floor(x / 10) + Math.floor(y / 10)) % 2 === 0;
          setPixel(image, x, y, on ? 220 : 20, on ? 220 : 20, on ? 220 : 20);
        }
      }
      return image;
    };
    const withoutParam = makeCheckerboard();
    const withExplicit1 = makeCheckerboard();
    applyGlitch(withoutParam, 0.85, 1);
    applyGlitch(withExplicit1, 0.85, 1, 1);
    assert.deepEqual(Array.from(withoutParam.data), Array.from(withExplicit1.data));
  });
});
