import type { ColorCurve, ColorGrading } from "../project/types.ts";
import { isIdentityCurve } from "../timeline/colorCurves.ts";

/** Pure, DOM-free FFmpeg `curves=` filter fragment builder — mirrors `panFilter.ts`'s own shape. */

function pointsFragment(points: ColorCurve, n: (value: number) => string): string {
  return points.map((p) => `${n(p.x)}/${n(p.y)}`).join(" ");
}

/** One FFmpeg `curves=` filter stage from `grading`'s four channels. Only non-identity channels are
 *  emitted (this codebase's pervasive "only emit a filter/parameter when it would do something"
 *  convention, e.g. `buildPanFilterStage`'s own `null`-when-no-op shape) — `null` when every channel is
 *  identity, meaning no `curves=` stage at all.
 *
 *  Uses `master=`, deliberately NEVER `all=` — verified against FFmpeg's own `libavfilter/vf_curves.c`
 *  `AVOption` table: `all` only back-fills an UNSET R/G/B channel string (`curves_init()`:
 *  `if (!pts[i]) pts[i] = av_strdup(allp)` for i in {R,G,B}) and never touches the master slot
 *  (`comp_points_str[NB_COMP]`, written only by `master`/`m`) — which is exactly the field
 *  `config_input()`'s composition loop gates on (see `colorCurves.ts`'s `composeLuts`). Using `all=`
 *  here would silently produce NO master-curve composition whenever both a master curve and per-channel
 *  curves are set — a materially wrong result, not just a naming nitpick.
 *
 *  `interp=natural` is FFmpeg's own documented default (`{.i64=INTERP_NATURAL}` in the `AVOption`
 *  table, matching the natural-cubic-spline choice in `colorCurves.ts`) but is passed explicitly anyway
 *  — this codebase never relies on an unstated filter default (every other fragment in
 *  `buildExportPlan.ts` is fully explicit too). `n` is the same 6-decimal numeric formatter
 *  `buildExportPlan.ts` already uses everywhere else. */
export function buildCurvesFilterFragment(grading: ColorGrading, n: (value: number) => string): string | null {
  const parts: string[] = [];
  if (!isIdentityCurve(grading.master)) parts.push(`master='${pointsFragment(grading.master, n)}'`);
  if (!isIdentityCurve(grading.red)) parts.push(`red='${pointsFragment(grading.red, n)}'`);
  if (!isIdentityCurve(grading.green)) parts.push(`green='${pointsFragment(grading.green, n)}'`);
  if (!isIdentityCurve(grading.blue)) parts.push(`blue='${pointsFragment(grading.blue, n)}'`);
  if (parts.length === 0) return null;
  return `curves=interp=natural:${parts.join(":")}`;
}
