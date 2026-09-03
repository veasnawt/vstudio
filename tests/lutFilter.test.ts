import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLut3DFilterFragment } from "../src/export/lutFilter.ts";

describe("buildLut3DFilterFragment", () => {
  it("builds the exact lut3d= fragment with tetrahedral interpolation", () => {
    const fragment = buildLut3DFilterFragment("'C:/luts/teal-orange.cube'");
    assert.equal(fragment, "lut3d=file='C:/luts/teal-orange.cube':interp=tetrahedral");
  });

  it("passes the escaped path through verbatim, doing no escaping of its own", () => {
    const escaped = "'D\\:/some\\'path/x.cube'";
    const fragment = buildLut3DFilterFragment(escaped);
    assert.equal(fragment, `lut3d=file=${escaped}:interp=tetrahedral`);
  });
});
