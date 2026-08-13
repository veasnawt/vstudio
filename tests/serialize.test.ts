import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deserializeProject, ProjectFormatError, serializeProject } from "../src/project/serialize.ts";
import { PROJECT_SCHEMA_VERSION } from "../src/project/types.ts";
import { addClip } from "../src/timeline/operations.ts";
import { emptyProject, videoTrackId } from "./fixture.ts";

describe("project serialization", () => {
  it("round-trips a project losslessly", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);

    const restored = deserializeProject(serializeProject(project));

    assert.deepEqual(restored, project);
  });

  it("round-trips an edited multi-clip timeline losslessly", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, videoTrackId(project), "asset1", 20);

    const restored = deserializeProject(serializeProject(project));

    assert.deepEqual(restored, project);
    assert.equal(restored.sequence.tracks[0].clips.length, 2);
  });

  it("refuses a file written by a newer VStudio rather than round-tripping it lossily", () => {
    const project = emptyProject();
    const raw = JSON.parse(serializeProject(project));
    raw.schemaVersion = PROJECT_SCHEMA_VERSION + 1;

    assert.throws(() => deserializeProject(JSON.stringify(raw)), ProjectFormatError);
  });

  it("rejects malformed JSON with a clear error", () => {
    assert.throws(() => deserializeProject("{not json"), ProjectFormatError);
  });

  it("rejects a clip whose out-point is not after its in-point", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const raw = JSON.parse(serializeProject(project));
    raw.sequence.tracks[0].clips[0].sourceOut = raw.sequence.tracks[0].clips[0].sourceIn;

    assert.throws(() => deserializeProject(JSON.stringify(raw)), ProjectFormatError);
  });

  it("drops clips whose asset is missing, keeping the rest of the edit openable", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const raw = JSON.parse(serializeProject(project));
    raw.assets = [];

    const restored = deserializeProject(JSON.stringify(raw));

    assert.equal(restored.sequence.tracks[0].clips.length, 0);
  });

  it("sorts clips into timeline order on load", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, videoTrackId(project), "asset1", 30);
    const raw = JSON.parse(serializeProject(project));
    raw.sequence.tracks[0].clips.reverse();

    const restored = deserializeProject(JSON.stringify(raw));
    const starts = restored.sequence.tracks[0].clips.map((c) => c.timelineStart);

    assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  });
});
