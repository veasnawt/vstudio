/** Pure, DOM-free `.cube` 3D LUT parsing + trilinear pixel application — split out for the exact same
 *  reason `timeline/colorCurves.ts` is: directly unit-testable under this repo's `node --test` runner
 *  without a real `ImageData`/canvas, and shared by both real callers, `playback/PlaybackEngine.ts`
 *  (live preview) and indirectly `export/lutFilter.ts` (which hands FFmpeg the raw file instead of
 *  reimplementing this math, but still wants the SAME file format understood/validated at import time
 *  via `parseCubeLut`). Lives in `timeline/` rather than colocated with a single caller, same as
 *  `colorCurves.ts`. */

/** Thrown for any `.cube` file this parser can't trust — missing size line, wrong sample count, or a
 *  1D-only LUT (an explicit v1 scope cut, not a silent misparse; see `parseCubeLut`'s own comment).
 *  Callers surface the message directly to the user (the import route's 400 response) rather than
 *  importing a LUT that would silently do nothing or crash the renderer later. */
export class LutParseError extends Error {}

/** A parsed 3D LUT: an `N x N x N` lattice of RGB output triples, plus the input domain it covers.
 *  `data` is flat, `size^3 * 3` floats — see `parseCubeLut`'s own comment for the exact index math
 *  (red-fastest, matching the `.cube` spec's own row ordering) that fills it. */
export interface Lut3D {
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  data: Float32Array;
}

/** Parses the Adobe/Iridas `.cube` 3D LUT text format (the de-facto standard this file extension
 *  means — FFmpeg's own `lut3d` filter reads it directly, which is exactly why export just hands
 *  FFmpeg the raw file via `export/lutFilter.ts` rather than a derived format).
 *
 *  Recognized lines: `#`-prefixed and blank lines are skipped anywhere; `TITLE "..."` is ignored (this
 *  app doesn't surface it — the import route already asks for a display name via the uploaded
 *  filename); `LUT_3D_SIZE N` is required; `DOMAIN_MIN r g b` / `DOMAIN_MAX r g b` are optional and
 *  default to `[0,0,0]`/`[1,1,1]` per the spec; every other non-blank, non-comment line is expected to
 *  be one `r g b` data row.
 *
 *  A `.cube` file lists its `N^3` rows in a fixed order — the spec's own words are "red fastest, then
 *  green, then blue": for `size = N`, row index `i = r + g*N + b*N*N` for lattice coordinates
 *  `(r, g, b)`, each ranging `0..N-1`. This is EXACTLY the flat index this parser (and `applyLut3D`'s
 *  lattice lookup below) uses, scaled by 3 for the RGB triple — so the file's own row order can be
 *  read straight into `data` with no reordering pass. */
export function parseCubeLut(text: string): Lut3D {
  let size: number | undefined;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const rows: [number, number, number][] = [];
  let saw1dSize = false;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    if (line.startsWith("TITLE")) continue;

    if (line.startsWith("LUT_1D_SIZE")) {
      // Recognized-but-refused: a 1D `.cube` is a real, valid file format this app just doesn't
      // support importing yet (a 1D LUT is a per-channel tone curve, closer to `ColorGrading` than to
      // a full 3D lattice) — flagged explicitly so it fails with a clear message instead of silently
      // falling through to "missing LUT_3D_SIZE" and looking like a corrupt/unrelated file.
      saw1dSize = true;
      continue;
    }

    if (line.startsWith("LUT_3D_SIZE")) {
      const match = line.match(/LUT_3D_SIZE\s+(\d+)/);
      if (!match) throw new LutParseError("Malformed LUT_3D_SIZE line in .cube file");
      size = Number(match[1]);
      continue;
    }

    if (line.startsWith("DOMAIN_MIN")) {
      domainMin = parseTriplet(line, "DOMAIN_MIN");
      continue;
    }
    if (line.startsWith("DOMAIN_MAX")) {
      domainMax = parseTriplet(line, "DOMAIN_MAX");
      continue;
    }

    // Anything else non-blank/non-comment is a data row.
    rows.push(parseTriplet(line, "LUT data row"));
  }

  if (size === undefined) {
    throw new LutParseError(
      saw1dSize
        ? "This .cube file is a 1D LUT (LUT_1D_SIZE) — VCut only supports importing 3D LUTs (LUT_3D_SIZE) today."
        : "This .cube file has no LUT_3D_SIZE line — it doesn't look like a valid 3D LUT."
    );
  }
  if (!Number.isFinite(size) || size < 2) {
    throw new LutParseError(`Invalid LUT_3D_SIZE: ${size}`);
  }

  const expected = size * size * size;
  if (rows.length !== expected) {
    throw new LutParseError(
      `Expected ${expected} data rows for a ${size}x${size}x${size} LUT, found ${rows.length}`
    );
  }

  const data = new Float32Array(expected * 3);
  for (let i = 0; i < expected; i++) {
    data[i * 3] = rows[i][0];
    data[i * 3 + 1] = rows[i][1];
    data[i * 3 + 2] = rows[i][2];
  }

  return { size, domainMin, domainMax, data };
}

function parseTriplet(line: string, what: string): [number, number, number] {
  const parts = line.split(/\s+/).filter((p) => p.length > 0);
  // A keyword line (DOMAIN_MIN/DOMAIN_MAX) has the keyword as parts[0]; a plain data row is just the
  // three numbers — slicing the last 3 tokens handles both without a separate code path.
  const nums = parts.slice(-3).map(Number);
  if (nums.length !== 3 || nums.some((n) => !Number.isFinite(n))) {
    throw new LutParseError(`Malformed ${what}: "${line}"`);
  }
  return [nums[0], nums[1], nums[2]];
}

/** Looks up the lattice RGB triple at integer coordinates `(r, g, b)` — each clamped to `[0, size-1]`
 *  defensively, since `applyLut3D`'s trilinear interpolation below deliberately calls this one lattice
 *  cell past a pixel that lands exactly on the last step, and clamping is cheaper/safer than special-
 *  casing that boundary at every call site. */
function latticeAt(lut: Lut3D, r: number, g: number, b: number): [number, number, number] {
  const n = lut.size;
  const rc = Math.min(n - 1, Math.max(0, r));
  const gc = Math.min(n - 1, Math.max(0, g));
  const bc = Math.min(n - 1, Math.max(0, b));
  const idx = (rc + gc * n + bc * n * n) * 3;
  return [lut.data[idx], lut.data[idx + 1], lut.data[idx + 2]];
}

/** Mutates `imageData.data` in place, applying `lut` via trilinear interpolation — the standard
 *  approach every real-time LUT renderer uses (FFmpeg's own `lut3d` filter defaults to trilinear too,
 *  though export instead uses `interp=tetrahedral`, a higher-quality variant — see
 *  `export/lutFilter.ts`'s own comment on why that mismatch is an acceptable preview/export tradeoff
 *  rather than a parity bug). Only touches R/G/B, never alpha — mirrors `applyColorGrading`'s own
 *  contract exactly, so the two compose safely with `applyChromaKey` (alpha-only) regardless of order.
 *
 *  Per pixel: normalize 0..255 to 0..1, remap through the LUT's own domain (`DOMAIN_MIN`/`DOMAIN_MAX`,
 *  almost always the default 0..1 — real-world `.cube` files rarely set a non-default domain, but the
 *  spec allows it and FFmpeg's `lut3d` honors it, so this does too) into lattice space `[0, size-1]`,
 *  then blends the 8 surrounding lattice cells weighted by fractional distance along each axis. */
export function applyLut3D(imageData: { data: Uint8ClampedArray }, lut: Lut3D): void {
  const data = imageData.data;
  const n = lut.size;
  const maxIndex = n - 1;
  const [dMinR, dMinG, dMinB] = lut.domainMin;
  const rangeR = lut.domainMax[0] - dMinR || 1;
  const rangeG = lut.domainMax[1] - dMinG || 1;
  const rangeB = lut.domainMax[2] - dMinB || 1;

  for (let i = 0; i < data.length; i += 4) {
    // 0..255 -> 0..1 -> domain-normalized -> lattice space [0, size-1].
    const rNorm = Math.min(1, Math.max(0, (data[i] / 255 - dMinR) / rangeR)) * maxIndex;
    const gNorm = Math.min(1, Math.max(0, (data[i + 1] / 255 - dMinG) / rangeG)) * maxIndex;
    const bNorm = Math.min(1, Math.max(0, (data[i + 2] / 255 - dMinB) / rangeB)) * maxIndex;

    const r0 = Math.floor(rNorm);
    const g0 = Math.floor(gNorm);
    const b0 = Math.floor(bNorm);
    const fr = rNorm - r0;
    const fg = gNorm - g0;
    const fb = bNorm - b0;

    // Trilinear = one lerp along each of the 3 axes, across the 8 corners of the enclosing lattice
    // cube — the standard "lerp along R, then G, then B" reduction.
    const c000 = latticeAt(lut, r0, g0, b0);
    const c100 = latticeAt(lut, r0 + 1, g0, b0);
    const c010 = latticeAt(lut, r0, g0 + 1, b0);
    const c110 = latticeAt(lut, r0 + 1, g0 + 1, b0);
    const c001 = latticeAt(lut, r0, g0, b0 + 1);
    const c101 = latticeAt(lut, r0 + 1, g0, b0 + 1);
    const c011 = latticeAt(lut, r0, g0 + 1, b0 + 1);
    const c111 = latticeAt(lut, r0 + 1, g0 + 1, b0 + 1);

    const out: [number, number, number] = [0, 0, 0];
    for (let ch = 0; ch < 3; ch++) {
      const c00 = c000[ch] * (1 - fr) + c100[ch] * fr;
      const c10 = c010[ch] * (1 - fr) + c110[ch] * fr;
      const c01 = c001[ch] * (1 - fr) + c101[ch] * fr;
      const c11 = c011[ch] * (1 - fr) + c111[ch] * fr;
      const c0 = c00 * (1 - fg) + c10 * fg;
      const c1 = c01 * (1 - fg) + c11 * fg;
      out[ch] = c0 * (1 - fb) + c1 * fb;
    }

    data[i] = out[0] * 255;
    data[i + 1] = out[1] * 255;
    data[i + 2] = out[2] * 255;
  }
}
