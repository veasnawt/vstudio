import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dbToGain, FADER_MAX_DB, FADER_MIN_DB, gainToDb } from "../src/ui/faderScale.ts";

describe("gainToDb / dbToGain", () => {
  it("round-trips a mid-range gain", () => {
    const gain = 0.5;
    const db = gainToDb(gain);
    assert.ok(Math.abs(dbToGain(db) - gain) < 1e-9);
  });

  it("unity gain (1) is 0dB", () => {
    assert.ok(Math.abs(gainToDb(1) - 0) < 1e-9);
    assert.ok(Math.abs(dbToGain(0) - 1) < 1e-9);
  });

  it("the ceiling gain (4) is +12.04dB, matching setTrackGain's own [0,4] ceiling", () => {
    assert.ok(Math.abs(gainToDb(4) - 20 * Math.log10(4)) < 1e-9);
    assert.ok(gainToDb(4) < FADER_MAX_DB + 0.1);
  });

  it("gainToDb floors a zero/negative gain at FADER_MIN_DB rather than -Infinity", () => {
    assert.equal(gainToDb(0), FADER_MIN_DB);
    assert.equal(gainToDb(-1), FADER_MIN_DB);
  });

  it("dbToGain treats the bottom of travel as exact digital silence, not a tiny nonzero value", () => {
    assert.equal(dbToGain(FADER_MIN_DB), 0);
    assert.equal(dbToGain(FADER_MIN_DB - 10), 0);
  });
});
