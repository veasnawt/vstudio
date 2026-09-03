/** Pure, DOM-free video scope math — same reasoning `colorCurves.ts`/`lut.ts` are split out for:
 *  directly unit-testable under this repo's `node --test` runner with a plain `{ data, width, height }`
 *  fixture, no real `ImageData`/canvas needed. The one real caller, `ui/ScopesPanel.tsx`, owns the
 *  canvas sampling and rAF loop; everything here is just density-bucketing arithmetic over pixels it's
 *  handed. */

/** Structural stand-in for a real `ImageData` — same shape `colorCurves.ts`'s `applyColorGrading`
 *  already takes for the same reason: a test fixture can construct this with a plain array, no DOM. */
interface PixelSource {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/** BT.601 luma weights (`0.299/0.587/0.114`) — the same constants FFmpeg's own `lutyuv`/`eq`-replacement
 *  filter fragment in `buildExportPlan.ts` (see its `eqFilter` comment) and `applyChromaKey`'s color-
 *  distance math both implicitly agree with via their own RGB-domain formulas, so a waveform read here
 *  lines up with how brightness is already reasoned about elsewhere in this codebase, not an unrelated
 *  luma convention (e.g. BT.709's 0.2126/0.7152/0.0722) that would make the SAME footage look
 *  differently "bright" depending on which tool is reading it. */
const LUMA_R = 0.299;
const LUMA_G = 0.587;
const LUMA_B = 0.114;

/** Every Nth pixel (row-major) is sampled rather than every single one — a real-time scope reading a
 *  320-wide canvas at up to 60fps has a real per-frame budget, and a waveform/vectorscope/histogram is
 *  a DENSITY readout, not a pixel-exact measurement: a monitor showing every 4th pixel looks visually
 *  identical to one showing every pixel (the shape of the distribution is what matters, not the total
 *  count), while cutting the pixel-loop work by 4x. Shared by all three functions below so they agree
 *  on which pixels contribute to their (otherwise independent) readouts. */
const PIXEL_STRIDE = 4;

function luma(r: number, g: number, b: number): number {
  return LUMA_R * r + LUMA_G * g + LUMA_B * b;
}

/** Buckets luma density per source COLUMN into a flat `256 * sampleColumns` grid — index
 *  `column * 256 + lumaLevel` — what a waveform monitor plots (brightness on the vertical axis, source
 *  x-position on the horizontal one). `sampleColumns` evenly-spaced source columns are read (not every
 *  source column) so this stays cheap regardless of the source's real width — the caller's own
 *  offscreen canvas is already downscaled to ~320px wide for the same reason (see `ScopesPanel.tsx`'s
 *  own comment), so `sampleColumns` is typically that canvas's own width, one sample per on-screen
 *  pixel column. Every ROW within a sampled column is still read (skipping rows would thin out the
 *  vertical density a real waveform relies on to show WHERE in the frame a given brightness lives, not
 *  just how much of it there is) — `PIXEL_STRIDE` only thins the horizontal sampling. */
export function computeWaveform(imageData: PixelSource, sampleColumns: number): Uint32Array {
  const { data, width, height } = imageData;
  const result = new Uint32Array(256 * sampleColumns);
  if (width <= 0 || height <= 0 || sampleColumns <= 0) return result;

  for (let col = 0; col < sampleColumns; col++) {
    // Evenly spaced across the FULL source width, not `PIXEL_STRIDE`-strided like row sampling below —
    // `sampleColumns` is already the caller's deliberate horizontal resolution, so every one of these
    // columns is meant to be read, not skipped further.
    const x = Math.min(width - 1, Math.floor((col / sampleColumns) * width));
    for (let y = 0; y < height; y += PIXEL_STRIDE) {
      const i = (y * width + x) * 4;
      const level = Math.round(luma(data[i], data[i + 1], data[i + 2]));
      result[col * 256 + Math.min(255, Math.max(0, level))]++;
    }
  }
  return result;
}

/** Buckets chroma (Cb/Cr, BT.601 convention matching `luma` above) density into a flat `gridSize *
 *  gridSize` grid — index `v * gridSize + u`, where `u`/`v` are Cb/Cr each remapped from their native
 *  `-0.5..0.5` range into `0..gridSize-1` lattice space. Grid CENTER (`gridSize/2, gridSize/2`) is zero
 *  chroma (a fully desaturated pixel), matching a real vectorscope's own "center = no color" convention
 *  — what a vectorscope plots as a scatter of dots, denser where more pixels share a similar hue/
 *  saturation. Standard BT.601 RGB→Cb/Cr (no legalizing/scaling beyond the 0..1 normalization — this is
 *  a relative density readout, not a broadcast-legal signal measurement). */
export function computeVectorscope(imageData: PixelSource, gridSize: number): Uint32Array {
  const { data, width, height } = imageData;
  const result = new Uint32Array(gridSize * gridSize);
  if (width <= 0 || height <= 0 || gridSize <= 0) return result;

  for (let y = 0; y < height; y += PIXEL_STRIDE) {
    for (let x = 0; x < width; x += PIXEL_STRIDE) {
      const i = (y * width + x) * 4;
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const y601 = LUMA_R * r + LUMA_G * g + LUMA_B * b;
      // BT.601: Cb = 0.564*(B-Y), Cr = 0.713*(R-Y) — each naturally in roughly -0.5..0.5 for in-gamut
      // RGB, matching the "grid center = zero chroma" contract above.
      const cb = 0.564 * (b - y601);
      const cr = 0.713 * (r - y601);
      const u = Math.min(gridSize - 1, Math.max(0, Math.round((cb + 0.5) * (gridSize - 1))));
      const v = Math.min(gridSize - 1, Math.max(0, Math.round((cr + 0.5) * (gridSize - 1))));
      result[v * gridSize + u]++;
    }
  }
  return result;
}

/** Three independent 256-bin R/G/B counts — the plain per-channel level histogram every video scope
 *  set includes alongside waveform/vectorscope. Same `PIXEL_STRIDE` sampling as the other two, for the
 *  same real-time-budget reason. */
export function computeHistogram(imageData: PixelSource): { r: Uint32Array; g: Uint32Array; b: Uint32Array } {
  const { data, width, height } = imageData;
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  if (width <= 0 || height <= 0) return { r, g, b };

  for (let y = 0; y < height; y += PIXEL_STRIDE) {
    for (let x = 0; x < width; x += PIXEL_STRIDE) {
      const i = (y * width + x) * 4;
      r[data[i]]++;
      g[data[i + 1]]++;
      b[data[i + 2]]++;
    }
  }
  return { r, g, b };
}
