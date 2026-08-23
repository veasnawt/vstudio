import type { ColorCurve, CurvePoint } from "../project/types.ts";

/** Pure, DOM-free curve/LUT math — split out specifically so it's unit-testable under this repo's
 *  `node --test` runner without a real `ImageData`/canvas, the same reasoning `export/panFilter.ts` and
 *  `playback/AudioMixEngine.ts`'s own `timeline/audioScheduling.ts` were pulled out for. Lives in
 *  `timeline/` (not colocated with a single caller) because it has three real callers —
 *  `playback/PlaybackEngine.ts`, `ui/CurveEditor.tsx`, and indirectly `export/curvesFilter.ts` — the
 *  same cross-cutting role `keyframes.ts` already plays in this codebase. */

/** Sorts ascending by `x`, drops duplicate-`x` points (the tridiagonal solve below divides by
 *  `x[i+1]-x[i]`, which must never be zero), and guarantees both fixed endpoint anchors exist —
 *  synthesized at `y=0`/`y=1` if genuinely missing. Defensive for a hand-edited/malformed project file;
 *  the UI (`CurveEditor`) never lets the two endpoints be deleted, so this path isn't reachable through
 *  normal editing. */
function normalizePoints(points: ColorCurve): ColorCurve {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const deduped: CurvePoint[] = [];
  for (const p of sorted) {
    if (deduped.length > 0 && deduped[deduped.length - 1].x === p.x) {
      deduped[deduped.length - 1] = p;
    } else {
      deduped.push(p);
    }
  }
  if (deduped.length === 0) return [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  if (deduped[0].x !== 0) deduped.unshift({ x: 0, y: 0 });
  if (deduped[deduped.length - 1].x !== 1) deduped.push({ x: 1, y: 1 });
  return deduped;
}

/** Second-derivative solve for a natural cubic spline (second derivative = 0 at both endpoints) through
 *  `points` — the standard tridiagonal (Thomas algorithm) pass. Matches FFmpeg's OWN default `curves`
 *  filter interpolation (`INTERP_NATURAL`, confirmed from `libavfilter/vf_curves.c`'s own `AVOption`
 *  table) — not pixel-identical (different implementations), but the same algorithm family, for the
 *  closest achievable preview/export visual parity. */
function solveSplineSecondDerivatives(points: ColorCurve): number[] {
  const n = points.length;
  const y2 = new Array<number>(n).fill(0);
  if (n < 3) return y2;
  const u = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const x0 = points[i - 1].x;
    const x1 = points[i].x;
    const x2 = points[i + 1].x;
    const sig = (x1 - x0) / (x2 - x0);
    const p = sig * y2[i - 1] + 2;
    y2[i] = (sig - 1) / p;
    const d =
      ((points[i + 1].y - points[i].y) / (x2 - x1) - (points[i].y - points[i - 1].y) / (x1 - x0)) /
      (x2 - x0);
    u[i] = (6 * d - sig * u[i - 1]) / p;
  }
  for (let k = n - 2; k >= 0; k--) {
    y2[k] = y2[k] * y2[k + 1] + u[k];
  }
  return y2;
}

/** Evaluates the natural cubic spline through `points` at a single `x` (0..1), given precomputed
 *  second derivatives from `solveSplineSecondDerivatives`. Standard cubic-spline segment evaluation —
 *  finds the bracketing segment, then interpolates within it. */
function evaluateSplineAt(points: ColorCurve, y2: number[], x: number): number {
  const n = points.length;
  if (x <= points[0].x) return points[0].y;
  if (x >= points[n - 1].x) return points[n - 1].y;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (hi + lo) >> 1;
    if (points[mid].x > x) hi = mid;
    else lo = mid;
  }
  const x0 = points[lo].x;
  const x1 = points[hi].x;
  const h = x1 - x0;
  const a = (x1 - x) / h;
  const b = (x - x0) / h;
  return (
    a * points[lo].y +
    b * points[hi].y +
    (((a * a * a - a) * y2[lo] + (b * b * b - b) * y2[hi]) * (h * h)) / 6
  );
}

/** Samples the natural cubic spline through `points` at `steps` evenly-spaced x values across 0..1 —
 *  shared by `buildCurveLut` (256 steps, for actual pixel processing) and `CurveEditor.tsx`'s own drawn
 *  spline path (fewer steps, for display), so the rendered curve line is GUARANTEED to match what
 *  actually gets applied to pixels. */
export function sampleCurve(points: ColorCurve, steps: number): { x: number; y: number }[] {
  const normalized = normalizePoints(points);
  const y2 = solveSplineSecondDerivatives(normalized);
  const result: { x: number; y: number }[] = [];
  for (let i = 0; i < steps; i++) {
    const x = i / (steps - 1);
    result.push({ x, y: evaluateSplineAt(normalized, y2, x) });
  }
  return result;
}

/** Builds a 256-entry lookup table (input level 0..255 -> output level 0..255) from `points`'s natural
 *  cubic spline. Assigning into a `Uint8ClampedArray` auto-clamps/rounds to 0..255, so a wild spline
 *  overshoot between control points needs no manual clamping here. */
export function buildCurveLut(points: ColorCurve): Uint8ClampedArray {
  const normalized = normalizePoints(points);
  const y2 = solveSplineSecondDerivatives(normalized);
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    lut[i] = evaluateSplineAt(normalized, y2, i / 255) * 255;
  }
  return lut;
}

/** Composes two LUTs as `master(channel(input))` — CHANNEL curve applied first, MASTER curve applied
 *  second/on top. Verified against FFmpeg's own `libavfilter/vf_curves.c` `config_input()`:
 *  `graph[i][j] = graph[NB_COMP][graph[i][j]]` — the master slot (`NB_COMP`) is applied to the
 *  ALREADY-CHANNEL-PROCESSED value, not the raw input. Export (`export/curvesFilter.ts`) hands the same
 *  control points straight to FFmpeg's `curves=` filter rather than a precomputed LUT, so preview and
 *  export need to agree on this order to actually look the same. */
export function composeLuts(masterLut: Uint8ClampedArray, channelLut: Uint8ClampedArray): Uint8ClampedArray {
  const result = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) result[i] = masterLut[channelLut[i]];
  return result;
}

/** `true` only for the exact two-point diagonal (0,0)-(1,1) — mirrors `project/types.ts`'s own
 *  `isIdentityColorGrading` per-curve check, intentionally duplicated there rather than imported so
 *  `project/types.ts` stays DOM/math-module-free (every other identity check in that file is similarly
 *  self-contained). This copy is what `buildCurveLut`'s callers and `export/curvesFilter.ts`'s
 *  per-fragment omission actually use. */
export function isIdentityCurve(points: ColorCurve): boolean {
  return points.length === 2 && points[0].x === 0 && points[0].y === 0 && points[1].x === 1 && points[1].y === 1;
}

/** Mutates `imageData.data` in place, applying the three composed R/G/B LUTs — deliberately NOT
 *  colocated in `playback/PlaybackEngine.ts` alongside its structural sibling `applyChromaKey`:
 *  `PlaybackEngine.ts` as a whole isn't importable under this repo's `node --test` runner (needs a real
 *  DOM/canvas). Living here instead makes the actual pixel loop directly unit-testable with a plain
 *  `{ data: Uint8ClampedArray }` fixture — no real `ImageData` construction required. Takes a minimal
 *  structural type for exactly that reason; `PlaybackEngine.ts` passes its real `ImageData` in, which is
 *  structurally compatible. Only touches R/G/B (`data[i]`/`data[i+1]`/`data[i+2]`) — NEVER alpha
 *  (`data[i+3]`) — so this composes safely with `applyChromaKey` (alpha-only) in either order, with no
 *  interaction between the two passes. */
export function applyColorGrading(
  imageData: { data: Uint8ClampedArray },
  luts: { r: Uint8ClampedArray; g: Uint8ClampedArray; b: Uint8ClampedArray },
): void {
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = luts.r[data[i]];
    data[i + 1] = luts.g[data[i + 1]];
    data[i + 2] = luts.b[data[i + 2]];
  }
}
