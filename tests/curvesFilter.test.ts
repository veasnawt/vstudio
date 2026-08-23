import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCurvesFilterFragment } from "../src/export/curvesFilter.ts";
import type { ColorGrading } from "../src/project/types.ts";
import { IDENTITY_COLOR_GRADING, IDENTITY_CURVE } from "../src/project/types.ts";

function n(value: number): string {
  return value.toFixed(6);
}

describe("buildCurvesFilterFragment", () => {
  it("returns null for an all-identity grading", () => {
    assert.equal(buildCurvesFilterFragment(IDENTITY_COLOR_GRADING, n), null);
  });

  it("emits only the non-identity master fragment", () => {
    const grading: ColorGrading = {
      ...IDENTITY_COLOR_GRADING,
      master: [{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }],
    };
    const fragment = buildCurvesFilterFragment(grading, n);
    assert.equal(fragment, "curves=interp=natural:master='0.000000/0.000000 0.500000/0.600000 1.000000/1.000000'");
  });

  it("uses master=, never all=", () => {
    const grading: ColorGrading = { ...IDENTITY_COLOR_GRADING, master: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }] };
    const fragment = buildCurvesFilterFragment(grading, n)!;
    assert.ok(fragment.includes("master="));
    assert.ok(!fragment.includes("all="));
  });

  it("always includes interp=natural", () => {
    const grading: ColorGrading = { ...IDENTITY_COLOR_GRADING, red: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }] };
    const fragment = buildCurvesFilterFragment(grading, n)!;
    assert.ok(fragment.startsWith("curves=interp=natural:"));
  });

  it("emits both master and per-channel fragments together, in master/red/green/blue order", () => {
    const grading: ColorGrading = {
      master: [{ x: 0, y: 0.05 }, { x: 1, y: 1 }],
      red: [{ x: 0, y: 0 }, { x: 1, y: 0.9 }],
      green: IDENTITY_CURVE,
      blue: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }],
    };
    const fragment = buildCurvesFilterFragment(grading, n)!;
    const masterIdx = fragment.indexOf("master=");
    const redIdx = fragment.indexOf("red=");
    const blueIdx = fragment.indexOf("blue=");
    assert.ok(masterIdx >= 0 && redIdx > masterIdx && blueIdx > redIdx);
    assert.ok(!fragment.includes("green="));
  });
});
