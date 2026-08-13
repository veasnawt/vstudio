import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDuration, formatTimecode, frameDuration, snapToFrame } from "../src/timeline/time.ts";
import { closeTo } from "./fixture.ts";

describe("snapToFrame", () => {
  it("rounds to the nearest frame boundary", () => {
    assert.ok(closeTo(snapToFrame(1.017, 30), 31 / 30));
    assert.ok(closeTo(snapToFrame(1.0, 30), 1.0));
    assert.ok(closeTo(snapToFrame(0.49 / 30, 30), 0));
  });

  it("returns the input unchanged for an unusable fps instead of producing NaN", () => {
    // A malformed project or an asset whose frame rate couldn't be probed must not poison every
    // downstream time value.
    assert.equal(snapToFrame(1.234, 0), 1.234);
    assert.equal(snapToFrame(1.234, Number.NaN), 1.234);
    assert.equal(snapToFrame(1.234, -30), 1.234);
  });
});

describe("frameDuration", () => {
  it("is the reciprocal of fps", () => {
    assert.ok(closeTo(frameDuration(30), 1 / 30));
    assert.ok(closeTo(frameDuration(24), 1 / 24));
  });

  it("is zero for an unusable fps", () => {
    assert.equal(frameDuration(0), 0);
  });
});

describe("formatTimecode", () => {
  it("formats as MM:SS:FF below an hour", () => {
    assert.equal(formatTimecode(0, 30), "00:00:00");
    assert.equal(formatTimecode(1.5, 30), "00:01:15");
    assert.equal(formatTimecode(61, 30), "01:01:00");
  });

  it("widens to HH:MM:SS:FF only once past an hour", () => {
    assert.equal(formatTimecode(3661, 30), "01:01:01:00");
  });

  it("treats negative and non-finite input as zero rather than rendering garbage", () => {
    assert.equal(formatTimecode(-5, 30), "00:00:00");
    assert.equal(formatTimecode(Number.NaN, 30), "00:00:00");
  });
});

describe("formatDuration", () => {
  it("renders library-friendly durations", () => {
    assert.equal(formatDuration(7), "0:07");
    assert.equal(formatDuration(83), "1:23");
    assert.equal(formatDuration(0), "0:00");
  });
});
