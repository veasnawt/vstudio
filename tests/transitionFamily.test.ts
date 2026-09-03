import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { transitionFamily } from "../src/playback/PlaybackEngine.ts";
import type { TransitionType } from "../src/project/types.ts";

describe("transitionFamily", () => {
  it("maps every TransitionType to its expected family", () => {
    const expected: Record<TransitionType, ReturnType<typeof transitionFamily>> = {
      crossfade: { kind: "dissolve" },
      dissolve: { kind: "dissolve" },
      wipeLeft: { kind: "wipe", edge: "left" },
      wipeRight: { kind: "wipe", edge: "right" },
      wipeUp: { kind: "wipe", edge: "up" },
      wipeDown: { kind: "wipe", edge: "down" },
      slideLeft: { kind: "slide", edge: "left" },
      slideRight: { kind: "slide", edge: "right" },
      slideUp: { kind: "slide", edge: "up" },
      slideDown: { kind: "slide", edge: "down" },
      circleOpen: { kind: "circle", opening: true },
      circleClose: { kind: "circle", opening: false },
      glitchCut: { kind: "glitch" },
      waterRippleCut: { kind: "waterRipple" },
    };

    for (const [type, family] of Object.entries(expected) as [TransitionType, ReturnType<typeof transitionFamily>][]) {
      assert.deepEqual(transitionFamily(type), family, `${type} should map to ${JSON.stringify(family)}`);
    }
  });
});
