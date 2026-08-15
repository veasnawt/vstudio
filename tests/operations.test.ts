import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clipDuration, findClip } from "../src/project/createProject.ts";
import { DEFAULT_TEXT_STYLE, IDENTITY_EFFECTS, IDENTITY_TRANSFORM } from "../src/project/types.ts";
import {
  addClip,
  addTrack,
  deleteClips,
  EditError,
  moveClip,
  removeTrack,
  reorderTrack,
  setClipEffects,
  setClipGain,
  setClipMuted,
  setClipTransform,
  setClipTransitionIn,
  setTextAsset,
  setTrackFlag,
  splitClip,
  trimClip,
} from "../src/timeline/operations.ts";
import { audioTrackId, clipsOf, closeTo, comparable, emptyProject, imageAsset, textAsset, textTrackId, videoAsset, videoTrackId } from "./fixture.ts";

describe("addClip", () => {
  it("places a clip spanning the asset's full duration", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    assert.equal(clip.timelineStart, 0);
    assert.equal(clip.sourceIn, 0);
    assert.ok(closeTo(clip.sourceOut, 10));
  });

  it("does not mutate the project it was given", () => {
    const base = emptyProject();
    const before = structuredClone(base);
    addClip(base, videoTrackId(base), "asset1", 0);

    assert.deepEqual(base, before);
  });

  it("rejects an unknown asset", () => {
    const base = emptyProject();
    assert.throws(() => addClip(base, videoTrackId(base), "nope", 0), EditError);
  });

  it("refuses to edit a locked track", () => {
    const base = emptyProject();
    const locked = setTrackFlag(base, videoTrackId(base), "locked", true);

    assert.throws(() => addClip(locked, videoTrackId(locked), "asset1", 0), EditError);
  });
});

describe("splitClip", () => {
  it("splits one clip into two adjacent clips at the playhead", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [original] = clipsOf(project, videoTrackId(project));

    const split = splitClip(project, original.id, 3);
    const clips = clipsOf(split, videoTrackId(split));

    assert.equal(clips.length, 2);
    assert.ok(closeTo(clips[0].timelineStart, 0));
    assert.ok(closeTo(clips[0].sourceOut, 3));
    assert.ok(closeTo(clips[1].timelineStart, 3));
    assert.ok(closeTo(clips[1].sourceIn, 3));
    assert.ok(closeTo(clips[1].sourceOut, 10));
  });

  it("preserves total duration across the split", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [original] = clipsOf(project, videoTrackId(project));

    const split = splitClip(project, original.id, 4.5);
    const total = clipsOf(split, videoTrackId(split)).reduce((sum, c) => sum + clipDuration(c), 0);

    assert.ok(closeTo(total, 10, 1e-6));
  });

  it("carries the source offset through when splitting a clip placed later on the timeline", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 5);
    const [original] = clipsOf(project, videoTrackId(project));

    // Timeline 8s is 3s into a clip that starts at timeline 5s, so the source cut lands at 3s.
    const split = splitClip(project, original.id, 8);
    const clips = clipsOf(split, videoTrackId(split));

    assert.ok(closeTo(clips[1].sourceIn, 3));
    assert.ok(closeTo(clips[1].timelineStart, 8));
  });

  it("refuses to split exactly on either edge, which would make a zero-length clip", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    assert.throws(() => splitClip(project, clip.id, 0), EditError);
    assert.throws(() => splitClip(project, clip.id, 10), EditError);
  });

  it("refuses to split outside the clip entirely", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    assert.throws(() => splitClip(project, clip.id, 50), EditError);
  });
});

describe("trimClip", () => {
  it("trims the out-point without moving the clip", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    const trimmed = trimClip(project, clip.id, "out", 6);
    const [result] = clipsOf(trimmed, videoTrackId(trimmed));

    assert.ok(closeTo(result.timelineStart, 0));
    assert.ok(closeTo(clipDuration(result), 6));
  });

  it("moves timelineStart and sourceIn together when trimming the in-point", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    const trimmed = trimClip(project, clip.id, "in", 2);
    const [result] = clipsOf(trimmed, videoTrackId(trimmed));

    // The visible frames stay locked to the media: pulling the in-point 2s later consumes 2s of
    // source, rather than sliding different frames under the same timeline position.
    assert.ok(closeTo(result.timelineStart, 2));
    assert.ok(closeTo(result.sourceIn, 2));
    assert.ok(closeTo(clipDuration(result), 8));
  });

  it("clamps the out-point to the source's real duration — a trim can't invent frames", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    const trimmed = trimClip(project, clip.id, "out", 999);
    const [result] = clipsOf(trimmed, videoTrackId(trimmed));

    assert.ok(closeTo(result.sourceOut, 10));
  });

  it("never collapses a clip below one frame", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    const trimmed = trimClip(project, clip.id, "out", 0);
    const [result] = clipsOf(trimmed, videoTrackId(trimmed));

    assert.ok(clipDuration(result) >= 1 / 30 - 1e-9, `duration was ${clipDuration(result)}`);
  });

  it("keeps the clip on the timeline when the in-point is dragged past zero", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    const trimmed = trimClip(project, clip.id, "in", -5);
    const [result] = clipsOf(trimmed, videoTrackId(trimmed));

    assert.ok(result.timelineStart >= 0);
    assert.ok(result.sourceIn >= 0);
  });
});

describe("moveClip", () => {
  it("moves a clip to a new position on the same track", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    const moved = moveClip(project, clip.id, videoTrackId(project), 12);
    const [result] = clipsOf(moved, videoTrackId(moved));

    assert.ok(closeTo(result.timelineStart, 12));
    assert.ok(closeTo(clipDuration(result), 10));
  });

  it("clamps a move before zero to the start of the timeline", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 5);
    const [clip] = clipsOf(project, videoTrackId(project));

    const moved = moveClip(project, clip.id, videoTrackId(project), -3);
    const [result] = clipsOf(moved, videoTrackId(moved));

    assert.equal(result.timelineStart, 0);
  });

  it("overwrites what it lands on, trimming the clip underneath", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0); // 0–10
    project = addClip(project, videoTrackId(project), "asset1", 20); // 20–30
    const [first, second] = clipsOf(project, videoTrackId(project));

    // Drop the second clip so it covers the back half of the first.
    const moved = moveClip(project, second.id, videoTrackId(project), 5);
    const clips = clipsOf(moved, videoTrackId(moved));

    const survivor = clips.find((c) => c.id === first.id);
    if (!survivor) throw new Error("the clip underneath should survive as a trimmed head");
    assert.ok(closeTo(clipDuration(survivor), 5), `head was ${clipDuration(survivor)}s`);

    const dropped = clips.find((c) => c.id === second.id);
    if (!dropped) throw new Error("the moved clip should still be on the track");
    assert.ok(closeTo(dropped.timelineStart, 5), "the moved clip lands exactly where dropped");
  });

  it("removes a clip that a move completely covers", () => {
    const base = emptyProject([videoAsset("asset1", 10), videoAsset("short", 2)]);
    let project = addClip(base, videoTrackId(base), "short", 3); // 3–5, fully covered below
    project = addClip(project, videoTrackId(project), "asset1", 20); // 20–30
    const clipsBefore = clipsOf(project, videoTrackId(project));
    const big = clipsBefore.find((c) => c.assetId === "asset1")!;
    const small = clipsBefore.find((c) => c.assetId === "short")!;

    const moved = moveClip(project, big.id, videoTrackId(project), 0); // covers 0–10
    const clips = clipsOf(moved, videoTrackId(moved));

    assert.equal(clips.find((c) => c.id === small.id), undefined);
    assert.equal(clips.length, 1);
  });

  it("splits a clip that a move lands in the middle of", () => {
    const base = emptyProject([videoAsset("asset1", 20), videoAsset("short", 2)]);
    let project = addClip(base, videoTrackId(base), "asset1", 0); // 0–20
    project = addClip(project, videoTrackId(project), "short", 50); // parked out of the way
    const clipsBefore = clipsOf(project, videoTrackId(project));
    const small = clipsBefore.find((c) => c.assetId === "short")!;

    const moved = moveClip(project, small.id, videoTrackId(project), 9); // lands 9–11, inside 0–20
    const clips = clipsOf(moved, videoTrackId(moved));

    // Head 0–9, the dropped clip 9–11, tail 11–20.
    assert.equal(clips.length, 3);
    assert.ok(closeTo(clips[0].timelineStart, 0) && closeTo(clipDuration(clips[0]), 9));
    assert.ok(closeTo(clips[1].timelineStart, 9));
    assert.ok(closeTo(clips[2].timelineStart, 11) && closeTo(clipDuration(clips[2]), 9));
  });

  it("refuses to move a video clip onto an audio track", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    assert.throws(() => moveClip(project, clip.id, audioTrackId(project), 0), EditError);
  });
});

describe("deleteClips", () => {
  it("removes the named clips and leaves the rest", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, videoTrackId(project), "asset1", 20);
    const [first, second] = clipsOf(project, videoTrackId(project));

    const deleted = deleteClips(project, [first.id]);
    const clips = clipsOf(deleted, videoTrackId(deleted));

    assert.equal(clips.length, 1);
    assert.equal(clips[0].id, second.id);
  });

  it("leaves clips on locked tracks alone", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setTrackFlag(project, videoTrackId(project), "locked", true);

    const deleted = deleteClips(project, [clip.id]);

    assert.equal(clipsOf(deleted, videoTrackId(deleted)).length, 1);
  });
});

describe("findClip", () => {
  it("locates a clip without the caller knowing its track", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    const found = findClip(project, clip.id);

    assert.equal(found?.clip.id, clip.id);
    assert.equal(found?.track.id, videoTrackId(project));
  });
});

describe("track kind enforcement", () => {
  it("refuses to add visual media to an audio track", () => {
    const base = emptyProject();
    assert.throws(() => addClip(base, audioTrackId(base), "asset1", 0), EditError);
  });

  it("refuses to add an image to an audio track", () => {
    const base = emptyProject([imageAsset()]);
    assert.throws(() => addClip(base, audioTrackId(base), "img1", 0), EditError);
  });

  it("puts an image on a video track, since a still is visual media", () => {
    const base = emptyProject([imageAsset()]);
    const project = addClip(base, videoTrackId(base), "img1", 0);

    assert.equal(clipsOf(project, videoTrackId(project)).length, 1);
  });

  it("allows audio-only media on an audio track", () => {
    const audioOnly = { ...videoAsset("music", 30), kind: "audio" as const, width: undefined, height: undefined };
    const base = emptyProject([audioOnly]);
    const project = addClip(base, audioTrackId(base), "music", 0);

    assert.equal(clipsOf(project, audioTrackId(project)).length, 1);
  });

  it("refuses to add audio-only media to a video track", () => {
    const audioOnly = { ...videoAsset("music", 30), kind: "audio" as const };
    const base = emptyProject([audioOnly]);

    assert.throws(() => addClip(base, videoTrackId(base), "music", 0), EditError);
  });

  it("puts a text asset on a text track, defaulting to TEXT_DEFAULT_DURATION", () => {
    let base = emptyProject([textAsset()]);
    base = addTrack(base, "text");
    const project = addClip(base, textTrackId(base), "text1", 0);
    const [clip] = clipsOf(project, textTrackId(project));

    assert.ok(closeTo(clipDuration(clip), 5));
  });

  it("refuses to add a text asset to a video track", () => {
    const base = emptyProject([textAsset()]);
    assert.throws(() => addClip(base, videoTrackId(base), "text1", 0), EditError);
  });

  it("refuses to add a video asset to a text track", () => {
    let base = emptyProject();
    base = addTrack(base, "text");
    assert.throws(() => addClip(base, textTrackId(base), "asset1", 0), EditError);
  });
});

describe("moving a clip between tracks", () => {
  it("moves a video clip to another video track", () => {
    const base = emptyProject();
    let project = addTrack(base, "video");
    project = addClip(project, videoTrackId(project), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    const secondVideo = project.sequence.tracks.filter((t) => t.kind === "video")[1];

    const moved = moveClip(project, clip.id, secondVideo.id, 2);

    assert.equal(clipsOf(moved, videoTrackId(moved)).length, 0);
    assert.equal(clipsOf(moved, secondVideo.id).length, 1);
    assert.ok(closeTo(clipsOf(moved, secondVideo.id)[0].timelineStart, 2));
  });
});

describe("track ordering", () => {
  it("keeps video tracks grouped above audio tracks when adding", () => {
    // Without grouping the order would be V1, A1, V2 — and "drag one track down" from V1 would land
    // on an audio track and be refused, which reads as a broken drag rather than a rule.
    const project = addTrack(emptyProject(), "video");
    const kinds = project.sequence.tracks.map((t) => t.kind);

    assert.deepEqual(kinds, ["video", "video", "audio"]);
  });

  it("appends new audio tracks below everything", () => {
    const project = addTrack(emptyProject(), "audio");

    assert.deepEqual(project.sequence.tracks.map((t) => t.kind), ["video", "audio", "audio"]);
  });

  it("numbers new tracks by their own kind", () => {
    const project = addTrack(addTrack(emptyProject(), "video"), "video");

    assert.deepEqual(project.sequence.tracks.filter((t) => t.kind === "video").map((t) => t.name), ["V1", "V2", "V3"]);
  });

  it("inserts a text track between video and audio, regardless of add order", () => {
    // [V1, A1] -> add text -> [V1, T1, A1] -> add another video -> [V1, V2, T1, A1]
    let project = addTrack(emptyProject(), "text");
    assert.deepEqual(project.sequence.tracks.map((t) => t.kind), ["video", "text", "audio"]);

    project = addTrack(project, "video");
    assert.deepEqual(project.sequence.tracks.map((t) => t.kind), ["video", "video", "text", "audio"]);
  });
});

describe("removeTrack", () => {
  it("removes the track and everything on it", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const videoId = videoTrackId(project);

    project = removeTrack(project, videoId);

    assert.ok(!project.sequence.tracks.some((t) => t.id === videoId));
  });

  it("refuses to remove a locked track", () => {
    const base = emptyProject();
    const project = setTrackFlag(base, videoTrackId(base), "locked", true);

    assert.throws(() => removeTrack(project, videoTrackId(project)), EditError);
  });

  it("rejects an unknown track", () => {
    assert.throws(() => removeTrack(emptyProject(), "nope"), EditError);
  });

  it("leaves the remaining tracks untouched", () => {
    const project = addTrack(emptyProject(), "video");
    const [first, , third] = project.sequence.tracks;

    const result = removeTrack(project, project.sequence.tracks[1].id);

    assert.deepEqual(result.sequence.tracks.map((t) => t.id), [first.id, third.id]);
  });
});

describe("reorderTrack", () => {
  it("moves a track before another track of the same kind", () => {
    // [V1, V2, V3, A1]
    let project = addTrack(addTrack(emptyProject(), "video"), "video");
    const [v1, v2, v3] = project.sequence.tracks;

    project = reorderTrack(project, v3.id, v1.id);

    assert.deepEqual(project.sequence.tracks.map((t) => t.id), [v3.id, v1.id, v2.id, audioTrackId(project)]);
  });

  it("moves a track to the end of its kind-group when beforeTrackId is null", () => {
    let project = addTrack(addTrack(emptyProject(), "video"), "video"); // [V1, V2, V3, A1]
    const [v1, v2, v3] = project.sequence.tracks;
    const audio = audioTrackId(project);

    project = reorderTrack(project, v1.id, null);

    assert.deepEqual(project.sequence.tracks.map((t) => t.id), [v2.id, v3.id, v1.id, audio]);
  });

  it("moving the ONLY track of its kind to the end is a no-op, not a jump past the other kind", () => {
    const project = emptyProject(); // [V1, A1]
    const result = reorderTrack(project, videoTrackId(project), null);

    assert.deepEqual(result.sequence.tracks.map((t) => t.kind), ["video", "audio"]);
  });

  it("refuses to mix a video track into the audio group", () => {
    const project = emptyProject(); // [V1, A1]
    assert.throws(() => reorderTrack(project, videoTrackId(project), audioTrackId(project)), EditError);
  });

  it("rejects an unknown source or target track", () => {
    const project = emptyProject();
    assert.throws(() => reorderTrack(project, "nope", null), EditError);
    assert.throws(() => reorderTrack(project, videoTrackId(project), "nope"), EditError);
  });

  it("leaves clips and every other track property untouched", () => {
    let project = addTrack(emptyProject(), "video"); // [V1, V2, A1]
    project = addClip(project, videoTrackId(project), "asset1", 0);
    const before = clipsOf(project, videoTrackId(project));

    const [v1, v2] = project.sequence.tracks;
    const reordered = reorderTrack(project, v2.id, v1.id);

    assert.deepEqual(clipsOf(reordered, v1.id), before);
  });
});

describe("setClipTransform", () => {
  it("stores a real transform on the clip", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    const transformed = setClipTransform(project, clip.id, {
      offsetX: 40,
      offsetY: -20,
      scale: 1.5,
      rotationDeg: 37,
      crop: { top: 0.1, right: 0, bottom: 0, left: 0.05 },
    });
    const [result] = clipsOf(transformed, videoTrackId(transformed));

    assert.deepEqual(result.transform, {
      offsetX: 40,
      offsetY: -20,
      scale: 1.5,
      rotationDeg: 37,
      crop: { top: 0.1, right: 0, bottom: 0, left: 0.05 },
    });
  });

  it("deletes the field entirely when set back to identity, not stores an identity object", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    let transformed = setClipTransform(project, clip.id, {
      offsetX: 10, offsetY: 0, scale: 1, rotationDeg: 0, crop: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    transformed = setClipTransform(transformed, clip.id, {
      offsetX: 0, offsetY: 0, scale: 1, rotationDeg: 0, crop: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    const [result] = clipsOf(transformed, videoTrackId(transformed));

    assert.equal(result.transform, undefined);
    // The round trip must be exact in every field EXCEPT the timestamp `edit()` always bumps — this
    // is what makes undo land back on a project that's otherwise identical to the one before any
    // transform was ever applied.
    assert.deepEqual(comparable(transformed), comparable(project));
  });

  it("never clamps rotation — any real degree, including past 360, is valid", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    const transformed = setClipTransform(project, clip.id, {
      ...IDENTITY_TRANSFORM,
      rotationDeg: 725,
    });

    assert.equal(clipsOf(transformed, videoTrackId(transformed))[0].transform?.rotationDeg, 725);
  });

  it("clamps scale to a sane range instead of accepting zero or absurd values", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    const tiny = setClipTransform(project, clip.id, { ...IDENTITY_TRANSFORM, scale: 0 });
    const huge = setClipTransform(project, clip.id, { ...IDENTITY_TRANSFORM, scale: 999 });

    assert.ok(clipsOf(tiny, videoTrackId(tiny))[0].transform!.scale > 0);
    assert.ok(clipsOf(huge, videoTrackId(huge))[0].transform!.scale < 999);
  });

  it("never lets an opposing crop pair leave nothing visible", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    const transformed = setClipTransform(project, clip.id, {
      ...IDENTITY_TRANSFORM,
      crop: { top: 0.9, bottom: 0.9, left: 0, right: 0 },
    });
    const { top, bottom } = clipsOf(transformed, videoTrackId(transformed))[0].transform!.crop;

    assert.ok(top + bottom < 1, `top+bottom was ${top + bottom}, would leave nothing visible`);
    // Proportionally rebalanced, not just one side arbitrarily favored — the crop's rough shape
    // (roughly equal top/bottom, since both were requested equally) survives the clamp.
    assert.ok(Math.abs(top - bottom) < 1e-9, `expected top and bottom to stay equal, got ${top} vs ${bottom}`);
  });

  it("refuses to transform a clip on a locked track", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setTrackFlag(project, videoTrackId(project), "locked", true);

    assert.throws(() => setClipTransform(project, clip.id, { ...IDENTITY_TRANSFORM, scale: 2 }), EditError);
  });

  it("rejects an unknown clip", () => {
    const project = emptyProject();
    assert.throws(() => setClipTransform(project, "missing", IDENTITY_TRANSFORM), EditError);
  });
});

describe("setClipEffects", () => {
  it("stores real effects on the clip", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    const adjusted = setClipEffects(project, clip.id, {
      brightness: 0.2,
      contrast: 1.3,
      saturation: 0.5,
      blur: 4,
      opacity: 0.8,
    });
    const [result] = clipsOf(adjusted, videoTrackId(adjusted));

    assert.deepEqual(result.effects, { brightness: 0.2, contrast: 1.3, saturation: 0.5, blur: 4, opacity: 0.8 });
  });

  it("deletes the field entirely when set back to identity, not stores an identity object", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    let adjusted = setClipEffects(project, clip.id, { ...IDENTITY_EFFECTS, brightness: 0.3 });
    adjusted = setClipEffects(adjusted, clip.id, IDENTITY_EFFECTS);
    const [result] = clipsOf(adjusted, videoTrackId(adjusted));

    assert.equal(result.effects, undefined);
    assert.deepEqual(comparable(adjusted), comparable(project));
  });

  it("clamps every field to its valid range instead of accepting out-of-range values", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    const extreme = setClipEffects(project, clip.id, {
      brightness: -5,
      contrast: 10,
      saturation: -3,
      blur: 500,
      opacity: 5,
    });
    const effects = clipsOf(extreme, videoTrackId(extreme))[0].effects!;

    assert.equal(effects.brightness, -1);
    assert.equal(effects.contrast, 2);
    assert.equal(effects.saturation, 0);
    assert.equal(effects.blur, 20);
    assert.equal(effects.opacity, 1);
  });

  it("refuses to adjust effects on a locked track", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setTrackFlag(project, videoTrackId(project), "locked", true);

    assert.throws(() => setClipEffects(project, clip.id, { ...IDENTITY_EFFECTS, opacity: 0.5 }), EditError);
  });

  it("rejects an unknown clip", () => {
    const project = emptyProject();
    assert.throws(() => setClipEffects(project, "missing", IDENTITY_EFFECTS), EditError);
  });
});

describe("setClipTransitionIn", () => {
  it("stores a real transition on the clip", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    const withTransition = setClipTransitionIn(project, clip.id, { duration: 0.5, type: "crossfade" });
    const [result] = clipsOf(withTransition, videoTrackId(withTransition));

    assert.deepEqual(result.transitionIn, { duration: 0.5, type: "crossfade" });
  });

  it("deletes the field entirely when cleared, rather than storing null", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setClipTransitionIn(project, clip.id, { duration: 0.5, type: "crossfade" });

    const cleared = setClipTransitionIn(project, clip.id, null);
    const [result] = clipsOf(cleared, videoTrackId(cleared));

    assert.equal(result.transitionIn, undefined);
    assert.ok(!("transitionIn" in result));
  });

  it("clamps duration up to at least one frame instead of accepting zero or negative", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    const withTransition = setClipTransitionIn(project, clip.id, { duration: -5, type: "crossfade" });
    const [result] = clipsOf(withTransition, videoTrackId(withTransition));

    assert.ok(result.transitionIn!.duration > 0);
    assert.ok(closeTo(result.transitionIn!.duration, 1 / 30));
  });

  it("refuses to set a transition on a locked track", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setTrackFlag(project, videoTrackId(project), "locked", true);

    assert.throws(() => setClipTransitionIn(project, clip.id, { duration: 0.5, type: "crossfade" }), EditError);
  });

  it("rejects an unknown clip", () => {
    const project = emptyProject();
    assert.throws(() => setClipTransitionIn(project, "missing", { duration: 0.5, type: "crossfade" }), EditError);
  });
});

describe("setClipMuted", () => {
  it("mutes a clip, storing the field explicitly", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    const muted = setClipMuted(project, clip.id, true);

    assert.equal(clipsOf(muted, videoTrackId(muted))[0].mutedAudio, true);
  });

  it("unmuting deletes the field entirely rather than storing false", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setClipMuted(project, clip.id, true);

    const unmuted = setClipMuted(project, clip.id, false);

    assert.equal(clipsOf(unmuted, videoTrackId(unmuted))[0].mutedAudio, undefined);
    assert.ok(!("mutedAudio" in clipsOf(unmuted, videoTrackId(unmuted))[0]));
  });

  it("refuses to mute a clip on a locked track", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setTrackFlag(project, videoTrackId(project), "locked", true);

    assert.throws(() => setClipMuted(project, clip.id, true), EditError);
  });

  it("rejects an unknown clip", () => {
    const project = emptyProject();
    assert.throws(() => setClipMuted(project, "missing", true), EditError);
  });
});

describe("setClipGain", () => {
  it("stores a real gain value", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    const adjusted = setClipGain(project, clip.id, 0.5);

    assert.ok(closeTo(clipsOf(adjusted, videoTrackId(adjusted))[0].gain!, 0.5));
  });

  it("clamps to 0..1", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    const tooHigh = setClipGain(project, clip.id, 5);
    const tooLow = setClipGain(project, clip.id, -5);

    // Clamped-to-1 is the IDENTITY value, which the "delete rather than store" convention (tested
    // separately below) means comes back as an absent field, not a literal stored `1`.
    assert.equal(clipsOf(tooHigh, videoTrackId(tooHigh))[0].gain, undefined);
    assert.ok(closeTo(clipsOf(tooLow, videoTrackId(tooLow))[0].gain!, 0));
  });

  it("setting gain back to 1 (unchanged) deletes the field entirely rather than storing 1", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setClipGain(project, clip.id, 0.3);

    const reset = setClipGain(project, clip.id, 1);

    assert.equal(clipsOf(reset, videoTrackId(reset))[0].gain, undefined);
    assert.ok(!("gain" in clipsOf(reset, videoTrackId(reset))[0]));
  });

  it("refuses to adjust gain on a locked track", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setTrackFlag(project, videoTrackId(project), "locked", true);

    assert.throws(() => setClipGain(project, clip.id, 0.5), EditError);
  });

  it("rejects an unknown clip", () => {
    const project = emptyProject();
    assert.throws(() => setClipGain(project, "missing", 0.5), EditError);
  });
});

describe("setTextAsset", () => {
  it("sets content and style, and syncs the asset's display name to the new content", () => {
    const project = emptyProject([textAsset("text1", "Old")]);

    const updated = setTextAsset(project, "text1", "New caption", { ...DEFAULT_TEXT_STYLE, fontSize: 96 });

    const asset = updated.assets[0];
    assert.equal(asset.textContent, "New caption");
    assert.equal(asset.textStyle?.fontSize, 96);
    assert.equal(asset.name, "New caption");
  });

  it("does not mutate the project it was given", () => {
    const project = emptyProject([textAsset()]);
    const before = structuredClone(project);

    setTextAsset(project, "text1", "Changed", DEFAULT_TEXT_STYLE);

    assert.deepEqual(project, before);
  });

  it("rejects an unknown asset", () => {
    const project = emptyProject([textAsset()]);
    assert.throws(() => setTextAsset(project, "missing", "x", DEFAULT_TEXT_STYLE), EditError);
  });

  it("rejects an asset that isn't text", () => {
    const project = emptyProject(); // default video asset
    assert.throws(() => setTextAsset(project, "asset1", "x", DEFAULT_TEXT_STYLE), EditError);
  });

  it("clamps fontSize into a renderable range", () => {
    const project = emptyProject([textAsset("text1")]);

    const tooSmall = setTextAsset(project, "text1", "x", { ...DEFAULT_TEXT_STYLE, fontSize: 1 });
    const tooBig = setTextAsset(project, "text1", "x", { ...DEFAULT_TEXT_STYLE, fontSize: 100000 });

    assert.equal(tooSmall.assets[0].textStyle?.fontSize, 8);
    assert.equal(tooBig.assets[0].textStyle?.fontSize, 600);
  });

  it("leaves rotationDeg unclamped, including a value past a full turn", () => {
    const project = emptyProject([textAsset("text1")]);

    const updated = setTextAsset(project, "text1", "x", { ...DEFAULT_TEXT_STYLE, rotationDeg: 730 });

    assert.equal(updated.assets[0].textStyle?.rotationDeg, 730);
  });

  it("clamps strokeWidth into a renderable range", () => {
    const project = emptyProject([textAsset("text1")]);

    const tooThin = setTextAsset(project, "text1", "x", { ...DEFAULT_TEXT_STYLE, strokeColor: "#000000", strokeWidth: -5 });
    const tooThick = setTextAsset(project, "text1", "x", { ...DEFAULT_TEXT_STYLE, strokeColor: "#000000", strokeWidth: 9999 });

    assert.equal(tooThin.assets[0].textStyle?.strokeWidth, 0);
    assert.equal(tooThick.assets[0].textStyle?.strokeWidth, 60);
  });

  it("clamps lineHeightMultiplier into a renderable range", () => {
    const project = emptyProject([textAsset("text1")]);

    const tooTight = setTextAsset(project, "text1", "x", { ...DEFAULT_TEXT_STYLE, lineHeightMultiplier: 0 });
    const tooLoose = setTextAsset(project, "text1", "x", { ...DEFAULT_TEXT_STYLE, lineHeightMultiplier: 50 });

    assert.equal(tooTight.assets[0].textStyle?.lineHeightMultiplier, 0.5);
    assert.equal(tooLoose.assets[0].textStyle?.lineHeightMultiplier, 3);
  });

  it("leaves shadow offsets unclamped", () => {
    const project = emptyProject([textAsset("text1")]);

    const updated = setTextAsset(project, "text1", "x", {
      ...DEFAULT_TEXT_STYLE,
      shadowColor: "#000000",
      shadowOffsetX: 5000,
      shadowOffsetY: -5000,
    });

    assert.equal(updated.assets[0].textStyle?.shadowOffsetX, 5000);
    assert.equal(updated.assets[0].textStyle?.shadowOffsetY, -5000);
  });
});
