/** Pure, DOM-free FFmpeg `lut3d=` filter fragment builder — mirrors `curvesFilter.ts`'s own shape:
 *  no filesystem access, just string formatting, so it's directly unit-testable and reusable from
 *  both `buildExportPlan.ts` (desktop/server FFmpeg) and `api/nativeExport.ts` (mobile). */

/** One FFmpeg `lut3d=` filter stage, given the already-escaped absolute path to a `.cube` file.
 *  `escapedLutPath` MUST already be run through `buildExportPlan.ts`'s own module-private `ffmpegPath()`
 *  helper — the same Windows drive-letter-colon + backslash escaping every other file-path filter
 *  argument in that file goes through (`fontfile=`, `textfile=`) — this function does no escaping of
 *  its own, same division of responsibility `buildCurvesFilterFragment` leaves to its caller for `n()`.
 *
 *  `interp=tetrahedral`, not trilinear: tetrahedral interpolation is a strictly higher-quality variant
 *  (4 lattice samples per pixel instead of trilinear's 8-weighted-corner blend, but along the actual
 *  diagonal that minimizes interpolation error) that FFmpeg's own `lut3d` filter supports natively —
 *  worth spending here since export runs once, offline, with no per-frame budget, unlike
 *  `timeline/lut.ts`'s `applyLut3D`, which trades a little accuracy for the real-time trilinear pass a
 *  live preview canvas can actually afford at 60fps. This is a deliberate, acceptable preview/export
 *  MISMATCH (unlike `curves=interp=natural`, which was chosen specifically to MATCH `colorCurves.ts`'s
 *  own spline) — a LUT lattice is dense enough (typically 17/33/65^3) that trilinear-vs-tetrahedral is
 *  visually indistinguishable, so export getting the slightly sharper variant for free is a pure
 *  upside, not a parity risk. */
export function buildLut3DFilterFragment(escapedLutPath: string): string {
  return `lut3d=file=${escapedLutPath}:interp=tetrahedral`;
}
