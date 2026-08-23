import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPanFilterStage, equalPowerPanGains } from "../src/export/panFilter.ts";

function n(value: number): string {
  return value.toFixed(6);
}

describe("equalPowerPanGains", () => {
  it("is a pure passthrough at center (pan 0)", () => {
    const { gainL, gainR } = equalPowerPanGains(0);
    assert.ok(Math.abs(gainL - 0) < 1e-9);
    assert.ok(Math.abs(gainR - 1) < 1e-9);
  });

  it("sums both channels into the left output at hard left (pan -1)", () => {
    const { gainL, gainR } = equalPowerPanGains(-1);
    assert.ok(Math.abs(gainL - 1) < 1e-9);
    assert.ok(Math.abs(gainR - 0) < 1e-9);
  });

  it("sums both channels into the right output at hard right (pan 1)", () => {
    const { gainL, gainR } = equalPowerPanGains(1);
    assert.ok(Math.abs(gainL - 0) < 1e-9);
    assert.ok(Math.abs(gainR - 1) < 1e-9);
  });

  it("clamps outside -1..1", () => {
    const beyond = equalPowerPanGains(5);
    const atLimit = equalPowerPanGains(1);
    assert.deepEqual(beyond, atLimit);
  });
});

describe("buildPanFilterStage", () => {
  it("emits no filter stage at all when pan is 0", () => {
    assert.equal(buildPanFilterStage(0, n), null);
  });

  it("emits the mono-sum-into-left shape at hard left", () => {
    assert.equal(buildPanFilterStage(-1, n), "pan=stereo|c0=c0+1.000000*c1|c1=0.000000*c1");
  });

  it("emits the mono-sum-into-right shape at hard right", () => {
    assert.equal(buildPanFilterStage(1, n), "pan=stereo|c0=0.000000*c0|c1=1.000000*c0+c1");
  });
});
