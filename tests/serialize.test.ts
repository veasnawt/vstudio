import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deserializeProject, ProjectFormatError, serializeProject } from "../src/project/serialize.ts";
import { DEFAULT_TEXT_STYLE, IDENTITY_EFFECTS, PROJECT_SCHEMA_VERSION } from "../src/project/types.ts";
import { addClip, addTrack } from "../src/timeline/operations.ts";
import { emptyProject, textAsset, textTrackId, videoTrackId } from "./fixture.ts";

describe("project serialization", () => {
  it("round-trips a project losslessly", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);

    const restored = deserializeProject(serializeProject(project));

    assert.deepEqual(restored, project);
  });

  it("round-trips an asset's filmstripRelPath", () => {
    const base = emptyProject();
    const raw = JSON.parse(serializeProject(base));
    raw.assets[0].filmstripRelPath = "asset1-filmstrip.jpg";

    const restored = deserializeProject(JSON.stringify(raw));

    assert.equal(restored.assets[0].filmstripRelPath, "asset1-filmstrip.jpg");
  });

  it("round-trips an edited multi-clip timeline losslessly", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, videoTrackId(project), "asset1", 20);

    const restored = deserializeProject(serializeProject(project));

    assert.deepEqual(restored, project);
    assert.equal(restored.sequence.tracks[0].clips.length, 2);
  });

  it("round-trips a clip's effects", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const raw = JSON.parse(serializeProject(project));
    raw.sequence.tracks[0].clips[0].effects = { brightness: 0.2, contrast: 1.3, saturation: 0.5, blur: 4, opacity: 0.8 };

    const restored = deserializeProject(JSON.stringify(raw));

    assert.deepEqual(restored.sequence.tracks[0].clips[0].effects, {
      brightness: 0.2,
      contrast: 1.3,
      saturation: 0.5,
      blur: 4,
      opacity: 0.8,
    });
  });

  it("falls back to default effects values field-by-field for a malformed effects object, keeping the clip", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const raw = JSON.parse(serializeProject(project));
    raw.sequence.tracks[0].clips[0].effects = { brightness: "dim", contrast: 1.3, blur: "none" };

    const restored = deserializeProject(JSON.stringify(raw));

    assert.deepEqual(restored.sequence.tracks[0].clips[0].effects, { ...IDENTITY_EFFECTS, contrast: 1.3 });
  });

  it("round-trips a clip's transitionIn", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const raw = JSON.parse(serializeProject(project));
    raw.sequence.tracks[0].clips[0].transitionIn = { duration: 0.75, type: "crossfade" };

    const restored = deserializeProject(JSON.stringify(raw));

    assert.deepEqual(restored.sequence.tracks[0].clips[0].transitionIn, { duration: 0.75, type: "crossfade" });
  });

  it("drops a malformed/non-positive-duration transitionIn entirely, keeping the clip", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const raw = JSON.parse(serializeProject(project));
    raw.sequence.tracks[0].clips[0].transitionIn = { duration: -1, type: "crossfade" };

    const restored = deserializeProject(JSON.stringify(raw));

    assert.equal(restored.sequence.tracks[0].clips[0].transitionIn, undefined);
    assert.ok(!("transitionIn" in restored.sequence.tracks[0].clips[0]));
  });

  it("forces type to crossfade regardless of what's stored, since it's the only valid value", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const raw = JSON.parse(serializeProject(project));
    raw.sequence.tracks[0].clips[0].transitionIn = { duration: 0.5, type: "wipe" };

    const restored = deserializeProject(JSON.stringify(raw));

    assert.deepEqual(restored.sequence.tracks[0].clips[0].transitionIn, { duration: 0.5, type: "crossfade" });
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

  it("round-trips a text asset and a text track losslessly", () => {
    const base = emptyProject([textAsset("text1", "Hello, world!")]);
    let project = addTrack(base, "text");
    project = addClip(project, textTrackId(project), "text1", 0);

    const restored = deserializeProject(serializeProject(project));

    assert.deepEqual(restored, project);
    assert.equal(restored.assets[0].textContent, "Hello, world!");
    assert.deepEqual(restored.assets[0].textStyle, DEFAULT_TEXT_STYLE);
  });

  it("falls back to default style values field-by-field for a malformed text style, keeping the asset", () => {
    const base = emptyProject([textAsset()]);
    const raw = JSON.parse(serializeProject(base));
    raw.assets[0].textStyle = { fontSize: "not a number", align: "diagonal", color: 5 };

    const restored = deserializeProject(JSON.stringify(raw));

    assert.deepEqual(restored.assets[0].textStyle, DEFAULT_TEXT_STYLE);
  });

  it("round-trips a rotated text style", () => {
    const base = emptyProject([textAsset()]);
    const raw = JSON.parse(serializeProject(base));
    raw.assets[0].textStyle.rotationDeg = 37.5;

    const restored = deserializeProject(JSON.stringify(raw));

    assert.equal(restored.assets[0].textStyle?.rotationDeg, 37.5);
  });

  it("falls back to 0 rotation for a malformed rotationDeg", () => {
    const base = emptyProject([textAsset()]);
    const raw = JSON.parse(serializeProject(base));
    raw.assets[0].textStyle.rotationDeg = "sideways";

    const restored = deserializeProject(JSON.stringify(raw));

    assert.equal(restored.assets[0].textStyle?.rotationDeg, 0);
  });

  it("round-trips a non-default fontFamily", () => {
    const base = emptyProject([textAsset()]);
    const raw = JSON.parse(serializeProject(base));
    raw.assets[0].textStyle.fontFamily = "battambang";

    const restored = deserializeProject(JSON.stringify(raw));

    assert.equal(restored.assets[0].textStyle?.fontFamily, "battambang");
  });

  it("falls back to the default font for an unknown fontFamily id, keeping the asset", () => {
    const base = emptyProject([textAsset()]);
    const raw = JSON.parse(serializeProject(base));
    raw.assets[0].textStyle.fontFamily = "comic-sans-from-the-future";

    const restored = deserializeProject(JSON.stringify(raw));

    assert.equal(restored.assets[0].textStyle?.fontFamily, DEFAULT_TEXT_STYLE.fontFamily);
  });

  it("round-trips stroke, shadow, and line-height style fields", () => {
    const base = emptyProject([textAsset()]);
    const raw = JSON.parse(serializeProject(base));
    raw.assets[0].textStyle.strokeColor = "#ff00ff";
    raw.assets[0].textStyle.strokeWidth = 5;
    raw.assets[0].textStyle.shadowColor = "#123456";
    raw.assets[0].textStyle.shadowOffsetX = 7;
    raw.assets[0].textStyle.shadowOffsetY = -3;
    raw.assets[0].textStyle.lineHeightMultiplier = 1.5;

    const restored = deserializeProject(JSON.stringify(raw));

    assert.deepEqual(restored.assets[0].textStyle, {
      ...DEFAULT_TEXT_STYLE,
      strokeColor: "#ff00ff",
      strokeWidth: 5,
      shadowColor: "#123456",
      shadowOffsetX: 7,
      shadowOffsetY: -3,
      lineHeightMultiplier: 1.5,
    });
  });

  it("falls back field-by-field for malformed stroke/shadow/line-height values, keeping strokeColor/shadowColor absent by default", () => {
    const base = emptyProject([textAsset()]);
    const raw = JSON.parse(serializeProject(base));
    raw.assets[0].textStyle.strokeWidth = "thick";
    raw.assets[0].textStyle.shadowOffsetX = "far";
    raw.assets[0].textStyle.lineHeightMultiplier = "loose";

    const restored = deserializeProject(JSON.stringify(raw));

    assert.deepEqual(restored.assets[0].textStyle, DEFAULT_TEXT_STYLE);
  });

  it("rejects an unknown track kind", () => {
    const base = emptyProject();
    const raw = JSON.parse(serializeProject(base));
    raw.sequence.tracks[0].kind = "subtitle";

    assert.throws(() => deserializeProject(JSON.stringify(raw)), ProjectFormatError);
  });
});
