import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectRealSeek, lruEvict } from "../src/playback/audioScheduling.ts";

describe("detectRealSeek", () => {
  it("stays false for a gap within tolerance", () => {
    assert.equal(detectRealSeek(10, 10.1, 0.15), false);
  });

  it("treats a gap exactly at the boundary as still within tolerance (strict greater-than)", () => {
    assert.equal(detectRealSeek(10, 10.5, 0.5), false);
  });

  it("flags a gap just past the boundary as a real seek", () => {
    assert.equal(detectRealSeek(10, 10.151, 0.15), true);
  });

  it("is symmetric — a jump backward counts the same as a jump forward", () => {
    assert.equal(detectRealSeek(10, 9.5, 0.15), true);
  });

  it("flags a large jump as a real seek", () => {
    assert.equal(detectRealSeek(2, 45, 0.15), true);
  });
});

describe("lruEvict", () => {
  it("evicts nothing when at or under the limit", () => {
    const entries = [{ key: "a", lastUsed: 1 }, { key: "b", lastUsed: 2 }];
    assert.deepEqual(lruEvict(entries, 2), []);
    assert.deepEqual(lruEvict(entries, 5), []);
  });

  it("evicts the oldest entries first", () => {
    const entries = [
      { key: "a", lastUsed: 100 },
      { key: "b", lastUsed: 10 },
      { key: "c", lastUsed: 50 },
      { key: "d", lastUsed: 5 },
    ];
    assert.deepEqual(lruEvict(entries, 2), ["d", "b"]);
  });

  it("evicts exactly enough to reach the limit, never more", () => {
    const entries = [
      { key: "a", lastUsed: 1 },
      { key: "b", lastUsed: 2 },
      { key: "c", lastUsed: 3 },
    ];
    assert.equal(lruEvict(entries, 1).length, 2);
  });

  it("does not mutate the input array", () => {
    const entries = [{ key: "a", lastUsed: 2 }, { key: "b", lastUsed: 1 }];
    const copy = entries.map((e) => ({ ...e }));
    lruEvict(entries, 1);
    assert.deepEqual(entries, copy);
  });
});
