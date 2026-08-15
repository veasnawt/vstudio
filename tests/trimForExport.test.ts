import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sequenceDuration } from "../src/project/createProject.ts";
import { trimProjectToRange } from "../src/export/trimForExport.ts";
import { addClip, addTrack, setClipTransitionIn } from "../src/timeline/operations.ts";
import { closeTo, clipsOf, emptyProject, videoTrackId } from "./fixture.ts";

describe("trimProjectToRange", () => {
  it("a clip fully inside the range is kept, only shifted", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 2); // 2..12

    const trimmed = trimProjectToRange(project, 0, 20);
    const [clip] = clipsOf(trimmed, videoTrackId(trimmed));

    assert.ok(closeTo(clip.timelineStart, 2));
    assert.ok(closeTo(clip.sourceIn, 0));
    assert.ok(closeTo(clip.sourceOut, 10));
  });

  it("a clip entirely before the range is dropped", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0); // 0..10

    const trimmed = trimProjectToRange(project, 20, 30);

    assert.equal(clipsOf(trimmed, videoTrackId(trimmed)).length, 0);
  });

  it("a clip entirely after the range is dropped", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 50); // 50..60

    const trimmed = trimProjectToRange(project, 0, 10);

    assert.equal(clipsOf(trimmed, videoTrackId(trimmed)).length, 0);
  });

  it("trims a clip's head when the range starts partway through it, shifting the timeline back", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0); // 0..10

    // Range starts 3s into the clip.
    const trimmed = trimProjectToRange(project, 3, 10);
    const [clip] = clipsOf(trimmed, videoTrackId(trimmed));

    assert.ok(closeTo(clip.timelineStart, 0), "shifted back so the range start becomes timeline 0");
    assert.ok(closeTo(clip.sourceIn, 3), "consumed 3s more of the source");
    assert.ok(closeTo(clip.sourceOut, 10));
  });

  it("trims a clip's tail when the range ends partway through it", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0); // 0..10

    const trimmed = trimProjectToRange(project, 0, 7);
    const [clip] = clipsOf(trimmed, videoTrackId(trimmed));

    assert.ok(closeTo(clip.timelineStart, 0));
    assert.ok(closeTo(clip.sourceIn, 0));
    assert.ok(closeTo(clip.sourceOut, 7));
  });

  it("trims BOTH edges when the range is entirely inside one clip", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0); // 0..10

    const trimmed = trimProjectToRange(project, 2, 6);
    const [clip] = clipsOf(trimmed, videoTrackId(trimmed));

    assert.ok(closeTo(clip.timelineStart, 0));
    assert.ok(closeTo(clip.sourceIn, 2));
    assert.ok(closeTo(clip.sourceOut, 6));
  });

  it("the resulting project's own duration matches the requested range when a clip reaches the end", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0); // 0..10

    const trimmed = trimProjectToRange(project, 2, 8);

    assert.ok(closeTo(sequenceDuration(trimmed), 6));
  });

  it("keeps two adjacent clips that remain adjacent after a uniform shift, preserving a transition between them", () => {
    let project = emptyProject([
      { id: "asset1", kind: "video", name: "a.mp4", relPath: "a.mp4", duration: 10, width: 1080, height: 1920, fps: 30, hasAudio: true, sizeBytes: 0, importedAt: 0 },
    ]);
    project = addClip(project, videoTrackId(project), "asset1", 0); // clip A: 0..10
    project = addClip(project, videoTrackId(project), "asset1", 10, "clipB"); // clip B: 10..20, adjacent to A
    project = setClipTransitionIn(project, "clipB", { duration: 1, type: "crossfade" });

    // Range covers both clips fully — adjacency and the transition should survive the shift untouched.
    const trimmed = trimProjectToRange(project, 0, 20);
    const clips = clipsOf(trimmed, videoTrackId(trimmed));

    assert.equal(clips.length, 2);
    assert.ok(closeTo(clips[0].timelineStart + (clips[0].sourceOut - clips[0].sourceIn), clips[1].timelineStart), "still adjacent");
    assert.deepEqual(clips[1].transitionIn, { duration: 1, type: "crossfade" });
  });

  it("a transition partner dropped by the range simply leaves the survivor's transitionIn inert (no crash)", () => {
    let project = emptyProject([
      { id: "asset1", kind: "video", name: "a.mp4", relPath: "a.mp4", duration: 10, width: 1080, height: 1920, fps: 30, hasAudio: true, sizeBytes: 0, importedAt: 0 },
    ]);
    project = addClip(project, videoTrackId(project), "asset1", 0); // clip A: 0..10
    project = addClip(project, videoTrackId(project), "asset1", 10, "clipB"); // clip B: 10..20
    project = setClipTransitionIn(project, "clipB", { duration: 1, type: "crossfade" });

    // Range starts AFTER clip A ends — only clip B survives, now with no adjacent predecessor.
    const trimmed = trimProjectToRange(project, 10, 20);
    const clips = clipsOf(trimmed, videoTrackId(trimmed));

    assert.equal(clips.length, 1);
    assert.equal(clips[0].id, "clipB");
    // The field itself is harmless to leave in place — findTransitionPartner re-validates adjacency
    // fresh against the (now clip-B-only) track and simply finds no partner, falling back to a plain
    // cut, exactly like a manually-opened gap already does elsewhere in this app.
  });

  it("a gap before the first surviving clip is preserved (not silently collapsed)", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 5); // 5..15, gap 0..5

    const trimmed = trimProjectToRange(project, 0, 15);
    const [clip] = clipsOf(trimmed, videoTrackId(trimmed));

    assert.ok(closeTo(clip.timelineStart, 5), "the leading gap survives the shift unchanged");
  });

  it("does not mutate the project it was given", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const before = structuredClone(project);

    trimProjectToRange(project, 2, 8);

    assert.deepEqual(project, before);
  });

  it("clips on multiple tracks are each trimmed independently", () => {
    let project = emptyProject([
      { id: "asset1", kind: "video", name: "a.mp4", relPath: "a.mp4", duration: 10, width: 1080, height: 1920, fps: 30, hasAudio: true, sizeBytes: 0, importedAt: 0 },
    ]);
    project = addTrack(project, "video"); // [V1, V2, A1]
    const v2 = project.sequence.tracks[1].id;
    project = addClip(project, videoTrackId(project), "asset1", 0); // V1: 0..10
    project = addClip(project, v2, "asset1", 5); // V2: 5..15

    const trimmed = trimProjectToRange(project, 0, 8);

    const v1Clip = clipsOf(trimmed, videoTrackId(trimmed))[0];
    const v2Clip = clipsOf(trimmed, v2)[0];
    assert.ok(closeTo(v1Clip.sourceOut, 8), "V1's clip trimmed at the range end");
    assert.ok(closeTo(v2Clip.timelineStart, 5), "V2's clip shifted the same way, unaffected by V1");
    assert.ok(closeTo(v2Clip.sourceOut, 3), "V2's clip trimmed to only the 3s that fall inside the range");
  });
});
