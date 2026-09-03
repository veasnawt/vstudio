import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { snapPoints, snapTime } from "../src/timeline/queries.ts";
import { clipEnd } from "../src/project/createProject.ts";
import { addClip, addTrack } from "../src/timeline/operations.ts";
import { TrimClipCommand } from "../src/commands/index.ts";
import { audioAsset, audioTrackId, clipsOf, emptyProject, textAsset, videoAsset, videoTrackId } from "./fixture.ts";

describe("snapPoints", () => {
  it("always includes 0, even on an empty project", () => {
    assert.deepEqual(snapPoints(emptyProject()), [0]);
  });

  it("collects every clip's start and end across every track by default", () => {
    const base = emptyProject([videoAsset(), audioAsset()]);
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = new TrimClipCommand(clipsOf(project, videoTrackId(project))[0].id, "out", 3).apply(project);
    project = addClip(project, audioTrackId(project), "music", 10);

    const points = snapPoints(project);
    assert.ok(points.includes(0));
    assert.ok(points.includes(3), "video clip's own end should be a snap point");
    assert.ok(points.includes(10), "audio clip's own start should be a snap point");
  });

  it("trackKind scopes snap points to tracks of that kind only", () => {
    const base = emptyProject([videoAsset(), textAsset()]);
    let project = addTrack(base, "text", "text-track");
    project = addClip(project, videoTrackId(project), "asset1", 2);
    project = addClip(project, "text-track", "text1", 7);

    const videoOnly = snapPoints(project, { trackKind: "video" });
    assert.ok(videoOnly.includes(2), "the video clip's own edge is a candidate for a video-scoped drag");
    assert.ok(!videoOnly.includes(7), "a text clip's edge must NOT pull a video-track drag off course");

    const textOnly = snapPoints(project, { trackKind: "text" });
    assert.ok(textOnly.includes(7));
    assert.ok(!textOnly.includes(2));
  });

  it("excludeClipIds drops every listed clip, not just one — a group drag shouldn't snap against its own group-mates", () => {
    // Clips start at non-zero offsets deliberately — `snapPoints` always includes 0 on its own, so a
    // clip starting AT 0 would still show up in `points` regardless of exclusion, for an unrelated
    // reason, making the exclusion itself untestable at that position.
    const base = emptyProject([videoAsset(), videoAsset("asset2"), videoAsset("asset3")]);
    let project = addClip(base, videoTrackId(base), "asset1", 5);
    project = addClip(project, videoTrackId(project), "asset2", 20);
    project = addClip(project, videoTrackId(project), "asset3", 40);
    const [a, b, c] = clipsOf(project, videoTrackId(project));

    const points = snapPoints(project, { excludeClipIds: [a.id, b.id] });
    assert.ok(!points.includes(a.timelineStart));
    assert.ok(!points.includes(b.timelineStart));
    assert.ok(points.includes(c.timelineStart), "a clip NOT in the exclusion list stays a valid snap target");
    assert.ok(points.includes(clipEnd(c)));
  });

  it("includes the playhead only when one is given", () => {
    const project = emptyProject();
    assert.ok(!snapPoints(project).includes(4.5));
    assert.ok(snapPoints(project, { playhead: 4.5 }).includes(4.5));
  });
});

describe("snapTime", () => {
  it("snaps to the nearest point within the threshold", () => {
    assert.equal(snapTime(5.05, [0, 5, 10], 0.2), 5);
  });

  it("returns the input unchanged when nothing is within the threshold", () => {
    assert.equal(snapTime(5.5, [0, 10], 0.2), 5.5);
  });
});
