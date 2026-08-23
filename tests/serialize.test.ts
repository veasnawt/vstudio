import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deserializeProject, ProjectFormatError, serializeProject } from "../src/project/serialize.ts";
import { DEFAULT_TEXT_STYLE, IDENTITY_COLOR_GRADING, IDENTITY_EFFECTS, PROJECT_SCHEMA_VERSION } from "../src/project/types.ts";
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

  it("round-trips a clip's textCrop", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const raw = JSON.parse(serializeProject(project));
    raw.sequence.tracks[0].clips[0].textCrop = { top: 0.1, right: 0.2, bottom: 0.3, left: 0.4 };

    const restored = deserializeProject(JSON.stringify(raw));

    assert.deepEqual(restored.sequence.tracks[0].clips[0].textCrop, { top: 0.1, right: 0.2, bottom: 0.3, left: 0.4 });
  });

  it("falls back to 0 field-by-field for a malformed textCrop object, keeping the clip", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const raw = JSON.parse(serializeProject(project));
    raw.sequence.tracks[0].clips[0].textCrop = { top: "far", right: 0.2, bottom: "none" };

    const restored = deserializeProject(JSON.stringify(raw));

    assert.deepEqual(restored.sequence.tracks[0].clips[0].textCrop, { top: 0, right: 0.2, bottom: 0, left: 0 });
  });

  it("round-trips a clip's transformKeyframes and effectsKeyframes", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const raw = JSON.parse(serializeProject(project));
    raw.sequence.tracks[0].clips[0].transformKeyframes = [
      { id: "kf1", time: 0, value: { offsetX: 0, offsetY: 0, scale: 1, rotationDeg: 0, crop: { top: 0, right: 0, bottom: 0, left: 0 } } },
      { id: "kf2", time: 4, value: { offsetX: 10, offsetY: -5, scale: 1.5, rotationDeg: 20, crop: { top: 0, right: 0, bottom: 0, left: 0 } } },
    ];
    raw.sequence.tracks[0].clips[0].effectsKeyframes = [
      { id: "kf3", time: 0, value: { ...IDENTITY_EFFECTS, opacity: 1 } },
      { id: "kf4", time: 4, value: { ...IDENTITY_EFFECTS, opacity: 0 } },
    ];

    const restored = deserializeProject(JSON.stringify(raw));
    const clip = restored.sequence.tracks[0].clips[0];

    assert.deepEqual(
      clip.transformKeyframes?.map((k) => [k.id, k.time, k.value.scale]),
      [
        ["kf1", 0, 1],
        ["kf2", 4, 1.5],
      ]
    );
    assert.deepEqual(
      clip.effectsKeyframes?.map((k) => [k.id, k.time, k.value.opacity]),
      [
        ["kf3", 0, 1],
        ["kf4", 4, 0],
      ]
    );
  });

  it("treats an empty or malformed keyframe array as absent, not a stored empty array", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const raw = JSON.parse(serializeProject(project));
    raw.sequence.tracks[0].clips[0].transformKeyframes = [{ id: "bad", time: "soon", value: {} }, "not an object"];

    const restored = deserializeProject(JSON.stringify(raw));

    assert.equal(restored.sequence.tracks[0].clips[0].transformKeyframes, undefined);
  });

  it("round-trips a clip's colorGrading", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const raw = JSON.parse(serializeProject(project));
    raw.sequence.tracks[0].clips[0].colorGrading = {
      master: [{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }],
      red: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }],
      green: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      blue: [{ x: 0, y: 0 }, { x: 1, y: 0.9 }],
    };

    const restored = deserializeProject(JSON.stringify(raw));

    assert.deepEqual(restored.sequence.tracks[0].clips[0].colorGrading, raw.sequence.tracks[0].clips[0].colorGrading);
  });

  it("falls back to identity field-by-field for a malformed colorGrading object, keeping the clip", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const raw = JSON.parse(serializeProject(project));
    raw.sequence.tracks[0].clips[0].colorGrading = {
      master: [{ x: 0, y: 0 }, { x: 1, y: 0.5 }],
      red: "not an array",
      // green missing entirely
      blue: [{ x: 0.3, y: 0.3 }], // fewer than 2 points
    };

    const restored = deserializeProject(JSON.stringify(raw));
    const grading = restored.sequence.tracks[0].clips[0].colorGrading!;

    assert.deepEqual(grading.master, [{ x: 0, y: 0 }, { x: 1, y: 0.5 }]);
    assert.deepEqual(grading.red, IDENTITY_COLOR_GRADING.red);
    assert.deepEqual(grading.green, IDENTITY_COLOR_GRADING.green);
    assert.deepEqual(grading.blue, IDENTITY_COLOR_GRADING.blue);
  });

  it("round-trips a clip's colorGradingKeyframes", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const raw = JSON.parse(serializeProject(project));
    raw.sequence.tracks[0].clips[0].colorGradingKeyframes = [
      { id: "kf1", time: 0, value: IDENTITY_COLOR_GRADING },
      { id: "kf2", time: 4, value: { ...IDENTITY_COLOR_GRADING, master: [{ x: 0, y: 0.2 }, { x: 1, y: 1 }] } },
    ];

    const restored = deserializeProject(JSON.stringify(raw));
    const clip = restored.sequence.tracks[0].clips[0];

    assert.deepEqual(
      clip.colorGradingKeyframes?.map((k) => [k.id, k.time, k.value.master]),
      [
        ["kf1", 0, IDENTITY_COLOR_GRADING.master],
        ["kf2", 4, [{ x: 0, y: 0.2 }, { x: 1, y: 1 }]],
      ]
    );
  });

  it("treats an empty or malformed colorGradingKeyframes array as absent", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const raw = JSON.parse(serializeProject(project));
    raw.sequence.tracks[0].clips[0].colorGradingKeyframes = [{ id: "bad", time: "soon", value: {} }, "not an object"];

    const restored = deserializeProject(JSON.stringify(raw));

    assert.equal(restored.sequence.tracks[0].clips[0].colorGradingKeyframes, undefined);
  });

  it("regenerates a missing keyframe id rather than dropping the keyframe", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const raw = JSON.parse(serializeProject(project));
    raw.sequence.tracks[0].clips[0].transformKeyframes = [
      { time: 0, value: { offsetX: 0, offsetY: 0, scale: 1, rotationDeg: 0, crop: { top: 0, right: 0, bottom: 0, left: 0 } } },
    ];

    const restored = deserializeProject(JSON.stringify(raw));
    const kfs = restored.sequence.tracks[0].clips[0].transformKeyframes;

    assert.equal(kfs?.length, 1);
    assert.equal(typeof kfs?.[0].id, "string");
    assert.ok((kfs?.[0].id.length ?? 0) > 0);
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

  it("round-trips a real non-crossfade transitionIn type unchanged", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const raw = JSON.parse(serializeProject(project));
    raw.sequence.tracks[0].clips[0].transitionIn = { duration: 0.5, type: "wipeLeft" };

    const restored = deserializeProject(JSON.stringify(raw));

    assert.deepEqual(restored.sequence.tracks[0].clips[0].transitionIn, { duration: 0.5, type: "wipeLeft" });
  });

  it("falls back to crossfade for a type that isn't one of TRANSITION_TYPE_OPTIONS' real values", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const raw = JSON.parse(serializeProject(project));
    // "wipe" (no direction suffix) was never a real value — every real wipe name is direction-suffixed
    // ("wipeLeft" etc.) — so this exercises the fallback a genuinely unknown/future type would also hit.
    raw.sequence.tracks[0].clips[0].transitionIn = { duration: 0.5, type: "wipe" };

    const restored = deserializeProject(JSON.stringify(raw));

    assert.deepEqual(restored.sequence.tracks[0].clips[0].transitionIn, { duration: 0.5, type: "crossfade" });
  });

  it("round-trips a clip's transitionOut", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const raw = JSON.parse(serializeProject(project));
    raw.sequence.tracks[0].clips[0].transitionOut = { duration: 0.75, type: "circleClose" };

    const restored = deserializeProject(JSON.stringify(raw));

    assert.deepEqual(restored.sequence.tracks[0].clips[0].transitionOut, { duration: 0.75, type: "circleClose" });
  });

  it("drops a malformed/non-positive-duration transitionOut entirely, keeping the clip", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const raw = JSON.parse(serializeProject(project));
    raw.sequence.tracks[0].clips[0].transitionOut = { duration: 0, type: "crossfade" };

    const restored = deserializeProject(JSON.stringify(raw));

    assert.equal(restored.sequence.tracks[0].clips[0].transitionOut, undefined);
    assert.ok(!("transitionOut" in restored.sequence.tracks[0].clips[0]));
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

  it("round-trips a track's gain and the sequence's masterGain", () => {
    const base = emptyProject();
    const raw = JSON.parse(serializeProject(base));
    const audioTrack = raw.sequence.tracks.find((t: { kind: string }) => t.kind === "audio");
    audioTrack.gain = 2.5;
    raw.sequence.masterGain = 1.5;

    const restored = deserializeProject(JSON.stringify(raw));

    const restoredAudioTrack = restored.sequence.tracks.find((t) => t.kind === "audio");
    assert.equal(restoredAudioTrack?.gain, 2.5);
    assert.equal(restored.sequence.masterGain, 1.5);
  });

  it("clamps an out-of-range track gain / masterGain to 0..4 on parse", () => {
    const base = emptyProject();
    const raw = JSON.parse(serializeProject(base));
    const audioTrack = raw.sequence.tracks.find((t: { kind: string }) => t.kind === "audio");
    audioTrack.gain = 50;
    raw.sequence.masterGain = -5;

    const restored = deserializeProject(JSON.stringify(raw));

    const restoredAudioTrack = restored.sequence.tracks.find((t) => t.kind === "audio");
    assert.equal(restoredAudioTrack?.gain, 4);
    assert.equal(restored.sequence.masterGain, 0);
  });

  it("drops a track gain / masterGain of exactly 1 rather than preserving it as a literal 1", () => {
    const base = emptyProject();
    const raw = JSON.parse(serializeProject(base));
    const audioTrack = raw.sequence.tracks.find((t: { kind: string }) => t.kind === "audio");
    audioTrack.gain = 1;
    raw.sequence.masterGain = 1;

    const restored = deserializeProject(JSON.stringify(raw));

    const restoredAudioTrack = restored.sequence.tracks.find((t) => t.kind === "audio");
    assert.ok(!restoredAudioTrack || !("gain" in restoredAudioTrack));
    assert.ok(!("masterGain" in restored.sequence));
  });

  it("round-trips a track's pan", () => {
    const base = emptyProject();
    const raw = JSON.parse(serializeProject(base));
    const audioTrack = raw.sequence.tracks.find((t: { kind: string }) => t.kind === "audio");
    audioTrack.pan = -0.5;

    const restored = deserializeProject(JSON.stringify(raw));

    const restoredAudioTrack = restored.sequence.tracks.find((t) => t.kind === "audio");
    assert.equal(restoredAudioTrack?.pan, -0.5);
  });

  it("clamps an out-of-range track pan to -1..1 on parse", () => {
    const base = emptyProject();
    const raw = JSON.parse(serializeProject(base));
    const audioTrack = raw.sequence.tracks.find((t: { kind: string }) => t.kind === "audio");
    audioTrack.pan = 5;

    const restored = deserializeProject(JSON.stringify(raw));

    const restoredAudioTrack = restored.sequence.tracks.find((t) => t.kind === "audio");
    assert.equal(restoredAudioTrack?.pan, 1);
  });

  it("drops a track pan of exactly 0 rather than preserving it as a literal 0", () => {
    const base = emptyProject();
    const raw = JSON.parse(serializeProject(base));
    const audioTrack = raw.sequence.tracks.find((t: { kind: string }) => t.kind === "audio");
    audioTrack.pan = 0;

    const restored = deserializeProject(JSON.stringify(raw));

    const restoredAudioTrack = restored.sequence.tracks.find((t) => t.kind === "audio");
    assert.ok(!restoredAudioTrack || !("pan" in restoredAudioTrack));
  });
});
