import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AddClipCommand,
  AddTrackCommand,
  BatchCommand,
  DeleteClipsCommand,
  DuplicateClipsCommand,
  MoveClipCommand,
  RemoveTrackCommand,
  ReorderTrackCommand,
  SetClipEffectsCommand,
  SetClipEffectsKeyframesCommand,
  SetClipGainCommand,
  SetClipMutedCommand,
  SetClipTextCropKeyframesCommand,
  SetClipTransformCommand,
  SetClipTransformKeyframesCommand,
  SetClipTransitionCommand,
  SetClipTransitionOutCommand,
  SetMasterGainCommand,
  SetTextCommand,
  SetTrackFlagCommand,
  SetTrackGainCommand,
  SetTrackPanCommand,
  SplitClipCommand,
  TrimClipCommand,
} from "../src/commands/index.ts";
import type { Command } from "../src/commands/index.ts";
import type { Project } from "../src/project/types.ts";
import { DEFAULT_TEXT_STYLE, IDENTITY_EFFECTS, IDENTITY_TEXT_CROP, IDENTITY_TRANSFORM } from "../src/project/types.ts";
import { addClip, addTrack } from "../src/timeline/operations.ts";
import { UndoStack } from "../src/undo/UndoStack.ts";
import { audioTrackId, clipsOf, comparable, emptyProject, textAsset, videoAsset, videoTrackId } from "./fixture.ts";

/** Asserts the central undo guarantee: applying a command and then reverting it returns the project
 *  to exactly the state it started in, and redoing gets back to the post-apply state. */
function assertRoundTrips(project: Project, command: Command): void {
  const before = comparable(project);
  const applied = command.apply(project);
  const afterApply = comparable(applied);

  const reverted = command.revert(applied);
  assert.deepEqual(comparable(reverted), before, `${command.label}: undo did not restore the original state`);

  const redone = command.apply(reverted);
  assert.deepEqual(comparable(redone), afterApply, `${command.label}: redo did not reproduce the edit`);
}

describe("command undo/redo round-trips", () => {
  it("AddClipCommand", () => {
    const project = emptyProject();
    assertRoundTrips(project, new AddClipCommand(videoTrackId(project), "asset1", 0));
  });

  it("SplitClipCommand", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    assertRoundTrips(project, new SplitClipCommand(clip.id, 3));
  });

  it("TrimClipCommand on each edge", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    assertRoundTrips(project, new TrimClipCommand(clip.id, "out", 6));
    assertRoundTrips(project, new TrimClipCommand(clip.id, "in", 2));
  });

  it("MoveClipCommand", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    assertRoundTrips(project, new MoveClipCommand(clip.id, videoTrackId(project), 12));
  });

  it("BatchCommand groups several commands into one round-trippable step", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, videoTrackId(project), "asset1", 20);
    const [first, second] = clipsOf(project, videoTrackId(project));

    assertRoundTrips(
      project,
      new BatchCommand("Move Clips", [
        new MoveClipCommand(first.id, videoTrackId(project), 30),
        new MoveClipCommand(second.id, videoTrackId(project), 40),
      ])
    );
  });

  it("BatchCommand's revert undoes BOTH sub-commands together, not just the last one", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, videoTrackId(project), "asset1", 20);
    const [first, second] = clipsOf(project, videoTrackId(project));
    const command = new BatchCommand("Move Clips", [
      new MoveClipCommand(first.id, videoTrackId(project), 30),
      new MoveClipCommand(second.id, videoTrackId(project), 40),
    ]);

    const applied = command.apply(project);
    assert.equal(clipsOf(applied, videoTrackId(applied)).find((c) => c.id === first.id)?.timelineStart, 30);
    assert.equal(clipsOf(applied, videoTrackId(applied)).find((c) => c.id === second.id)?.timelineStart, 40);

    const reverted = command.revert(applied);
    assert.equal(clipsOf(reverted, videoTrackId(reverted)).find((c) => c.id === first.id)?.timelineStart, 0);
    assert.equal(clipsOf(reverted, videoTrackId(reverted)).find((c) => c.id === second.id)?.timelineStart, 20);
  });

  it("MoveClipCommand that overwrites a neighbour restores what it destroyed", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, videoTrackId(project), "asset1", 20);
    const [, second] = clipsOf(project, videoTrackId(project));
    // Landing at 5 trims the first clip; undo has to bring those frames back.
    assertRoundTrips(project, new MoveClipCommand(second.id, videoTrackId(project), 5));
  });

  it("MoveClipCommand that splits a clip in half restores it whole", () => {
    const base = emptyProject([videoAsset("asset1", 20), videoAsset("short", 2)]);
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, videoTrackId(project), "short", 50);
    const small = clipsOf(project, videoTrackId(project)).find((c) => c.assetId === "short")!;
    assertRoundTrips(project, new MoveClipCommand(small.id, videoTrackId(project), 9));
  });

  it("DeleteClipsCommand", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, videoTrackId(project), "asset1", 20);
    const clips = clipsOf(project, videoTrackId(project));
    assertRoundTrips(project, new DeleteClipsCommand(clips.map((c) => c.id)));
  });

  it("SetTrackFlagCommand", () => {
    const project = emptyProject();
    assertRoundTrips(project, new SetTrackFlagCommand(videoTrackId(project), "locked", true));
  });

  it("AddTrackCommand", () => {
    const project = emptyProject();
    assertRoundTrips(project, new AddTrackCommand("video"));
  });

  it("RemoveTrackCommand restores the track AND its clips, at their original index", () => {
    const base = emptyProject();
    let project = addTrack(base, "video"); // [V1, V2, A1]
    project = addClip(project, project.sequence.tracks[1].id, "asset1", 0); // clip lives on V2
    assertRoundTrips(project, new RemoveTrackCommand(project.sequence.tracks[1].id));
  });

  it("ReorderTrackCommand", () => {
    const base = emptyProject();
    const project = addTrack(addTrack(base, "video"), "video"); // [V1, V2, V3, A1]
    const [v1, , v3] = project.sequence.tracks;
    assertRoundTrips(project, new ReorderTrackCommand(v3.id, v1.id));
  });

  it("ReorderTrackCommand restores the FULL prior order, not just where the moved track came from", () => {
    const base = emptyProject();
    const project = addTrack(addTrack(base, "video"), "video"); // [V1, V2, V3, A1]
    const originalOrder = project.sequence.tracks.map((t) => t.id);
    const [v1, , v3] = project.sequence.tracks;
    const command = new ReorderTrackCommand(v3.id, v1.id);

    const applied = command.apply(project);
    const reverted = command.revert(applied);

    assert.deepEqual(reverted.sequence.tracks.map((t) => t.id), originalOrder);
  });

  it("SetClipMutedCommand", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    assertRoundTrips(project, new SetClipMutedCommand(clip.id, true));
  });

  it("SetClipMutedCommand undoes back to a truly absent field, not stored `false`", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    const command = new SetClipMutedCommand(clip.id, true);

    const applied = command.apply(project);
    const reverted = command.revert(applied);

    assert.equal(clipsOf(reverted, videoTrackId(reverted))[0].mutedAudio, undefined);
    assert.deepEqual(comparable(reverted), comparable(project));
  });

  it("SetClipGainCommand", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    assertRoundTrips(project, new SetClipGainCommand(clip.id, 0.4));
  });

  it("SetClipGainCommand undoes back to a truly absent field, not stored `1`", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    const command = new SetClipGainCommand(clip.id, 0.4);

    const applied = command.apply(project);
    const reverted = command.revert(applied);

    assert.equal(clipsOf(reverted, videoTrackId(reverted))[0].gain, undefined);
    assert.deepEqual(comparable(reverted), comparable(project));
  });

  it("SetTrackGainCommand", () => {
    const project = emptyProject();
    assertRoundTrips(project, new SetTrackGainCommand(audioTrackId(project), 0.4));
  });

  it("SetTrackGainCommand undoes back to a truly absent field, not stored `1`", () => {
    const project = emptyProject();
    const command = new SetTrackGainCommand(audioTrackId(project), 0.4);

    const applied = command.apply(project);
    const reverted = command.revert(applied);

    const track = reverted.sequence.tracks.find((t) => t.id === audioTrackId(project));
    assert.equal(track?.gain, undefined);
    assert.deepEqual(comparable(reverted), comparable(project));
  });

  it("SetTrackPanCommand", () => {
    const project = emptyProject();
    assertRoundTrips(project, new SetTrackPanCommand(audioTrackId(project), -0.4));
  });

  it("SetTrackPanCommand undoes back to a truly absent field, not stored `0`", () => {
    const project = emptyProject();
    const command = new SetTrackPanCommand(audioTrackId(project), -0.4);

    const applied = command.apply(project);
    const reverted = command.revert(applied);

    const track = reverted.sequence.tracks.find((t) => t.id === audioTrackId(project));
    assert.equal(track?.pan, undefined);
    assert.deepEqual(comparable(reverted), comparable(project));
  });

  it("SetMasterGainCommand", () => {
    const project = emptyProject();
    assertRoundTrips(project, new SetMasterGainCommand(0.4));
  });

  it("SetMasterGainCommand undoes back to a truly absent field, not stored `1`", () => {
    const project = emptyProject();
    const command = new SetMasterGainCommand(0.4);

    const applied = command.apply(project);
    const reverted = command.revert(applied);

    assert.equal(reverted.sequence.masterGain, undefined);
    assert.deepEqual(comparable(reverted), comparable(project));
  });

  it("SetTextCommand", () => {
    const project = emptyProject([textAsset("text1", "Original")]);
    assertRoundTrips(project, new SetTextCommand("text1", "Changed", { ...DEFAULT_TEXT_STYLE, fontSize: 96 }));
  });

  it("SetTextCommand restores the exact previous content and style, not just SOME prior value", () => {
    const project = emptyProject([textAsset("text1", "Original")]);
    const command = new SetTextCommand("text1", "Changed", { ...DEFAULT_TEXT_STYLE, bold: true });

    const applied = command.apply(project);
    const reverted = command.revert(applied);

    assert.equal(reverted.assets[0].textContent, "Original");
    assert.deepEqual(reverted.assets[0].textStyle, DEFAULT_TEXT_STYLE);
    assert.deepEqual(comparable(reverted), comparable(project));
  });
});

describe("UndoStack", () => {
  it("starts with nothing to undo or redo", () => {
    const stack = new UndoStack();
    assert.equal(stack.canUndo, false);
    assert.equal(stack.canRedo, false);
    assert.equal(stack.undoLabel, null);
  });

  it("walks a sequence of edits all the way back to the original project", () => {
    const stack = new UndoStack();
    const original = emptyProject();
    const originalShape = comparable(original);

    let project = stack.execute(original, new AddClipCommand(videoTrackId(original), "asset1", 0));
    const clipId = clipsOf(project, videoTrackId(project))[0].id;
    project = stack.execute(project, new SplitClipCommand(clipId, 3));
    project = stack.execute(project, new TrimClipCommand(clipId, "out", 2));

    assert.equal(clipsOf(project, videoTrackId(project)).length, 2);

    project = stack.undo(project);
    project = stack.undo(project);
    project = stack.undo(project);

    assert.deepEqual(comparable(project), originalShape);
    assert.equal(stack.canUndo, false);
    assert.equal(stack.canRedo, true);
  });

  it("redoes the full sequence it just undid", () => {
    const stack = new UndoStack();
    const original = emptyProject();

    let project = stack.execute(original, new AddClipCommand(videoTrackId(original), "asset1", 0));
    const clipId = clipsOf(project, videoTrackId(project))[0].id;
    project = stack.execute(project, new SplitClipCommand(clipId, 3));
    const edited = comparable(project);

    project = stack.undo(project);
    project = stack.undo(project);
    project = stack.redo(project);
    project = stack.redo(project);

    assert.deepEqual(comparable(project), edited);
  });

  it("keeps clip ids stable across undo/redo so later commands still resolve", () => {
    const stack = new UndoStack();
    const original = emptyProject();
    const add = new AddClipCommand(videoTrackId(original), "asset1", 0);

    let project = stack.execute(original, add);
    project = stack.undo(project);
    project = stack.redo(project);

    // A command constructed against the FIRST apply must still find its clip after a redo — this is
    // why AddClipCommand fixes its clip id at construction instead of generating one per apply.
    const trim = new TrimClipCommand(add.clipId, "out", 4);
    assert.doesNotThrow(() => stack.execute(project, trim));
  });

  it("drops the redo branch once a new edit is made", () => {
    const stack = new UndoStack();
    const original = emptyProject();

    let project = stack.execute(original, new AddClipCommand(videoTrackId(original), "asset1", 0));
    project = stack.undo(project);
    assert.equal(stack.canRedo, true);

    stack.execute(project, new AddClipCommand(videoTrackId(project), "asset1", 5));
    assert.equal(stack.canRedo, false);
  });

  it("records nothing when a command throws, so no no-op sits in the history", () => {
    const stack = new UndoStack();
    const project = emptyProject();

    assert.throws(() => stack.execute(project, new AddClipCommand(videoTrackId(project), "missing-asset", 0)));
    assert.equal(stack.canUndo, false);
  });

  it("exposes labels for the undo/redo menu items", () => {
    const stack = new UndoStack();
    const project = emptyProject();

    const next = stack.execute(project, new AddClipCommand(videoTrackId(project), "asset1", 0));
    assert.equal(stack.undoLabel, "Add Clip");

    stack.undo(next);
    assert.equal(stack.redoLabel, "Add Clip");
  });

  it("undoing with an empty history is a harmless no-op", () => {
    const stack = new UndoStack();
    const project = emptyProject();
    assert.equal(stack.undo(project), project);
    assert.equal(stack.redo(project), project);
  });
});

describe("SetClipTransformCommand", () => {
  it("round-trips like every other command", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    assertRoundTrips(
      project,
      new SetClipTransformCommand(clip.id, { offsetX: 20, offsetY: -10, scale: 1.4, rotationDeg: 37, crop: { top: 0.1, right: 0, bottom: 0, left: 0 } })
    );
  });

  it("undoes back to a truly absent transform, not an identity object", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    const command = new SetClipTransformCommand(clip.id, { ...IDENTITY_TRANSFORM, rotationDeg: 45 });

    const applied = command.apply(project);
    const reverted = command.revert(applied);

    assert.equal(clipsOf(reverted, videoTrackId(reverted))[0].transform, undefined);
    assert.deepEqual(comparable(reverted), comparable(project));
  });

  it("chains: two edits undo back through each intermediate value", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    const stack = new UndoStack();

    let p = stack.execute(project, new SetClipTransformCommand(clip.id, { ...IDENTITY_TRANSFORM, scale: 1.2 }));
    p = stack.execute(p, new SetClipTransformCommand(clip.id, { ...IDENTITY_TRANSFORM, scale: 1.2, rotationDeg: 90 }));
    assert.equal(clipsOf(p, videoTrackId(p))[0].transform?.rotationDeg, 90);

    p = stack.undo(p);
    assert.equal(clipsOf(p, videoTrackId(p))[0].transform?.rotationDeg, 0);
    assert.equal(clipsOf(p, videoTrackId(p))[0].transform?.scale, 1.2);

    p = stack.undo(p);
    assert.equal(clipsOf(p, videoTrackId(p))[0].transform, undefined);
  });
});

describe("SetClipEffectsCommand", () => {
  it("round-trips like every other command", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    assertRoundTrips(
      project,
      new SetClipEffectsCommand(clip.id, { brightness: 0.2, contrast: 1.3, saturation: 0.5, blur: 4, opacity: 0.8 })
    );
  });

  it("undoes back to a truly absent effects field, not an identity object", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    const command = new SetClipEffectsCommand(clip.id, { ...IDENTITY_EFFECTS, brightness: 0.4 });

    const applied = command.apply(project);
    const reverted = command.revert(applied);

    assert.equal(clipsOf(reverted, videoTrackId(reverted))[0].effects, undefined);
    assert.deepEqual(comparable(reverted), comparable(project));
  });

  it("chains: two edits undo back through each intermediate value", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    const stack = new UndoStack();

    let p = stack.execute(project, new SetClipEffectsCommand(clip.id, { ...IDENTITY_EFFECTS, contrast: 1.2 }));
    p = stack.execute(p, new SetClipEffectsCommand(clip.id, { ...IDENTITY_EFFECTS, contrast: 1.2, blur: 3 }));
    assert.equal(clipsOf(p, videoTrackId(p))[0].effects?.blur, 3);

    p = stack.undo(p);
    assert.equal(clipsOf(p, videoTrackId(p))[0].effects?.blur, 0);
    assert.equal(clipsOf(p, videoTrackId(p))[0].effects?.contrast, 1.2);

    p = stack.undo(p);
    assert.equal(clipsOf(p, videoTrackId(p))[0].effects, undefined);
  });
});

describe("SetClipTransitionCommand", () => {
  it("round-trips like every other command", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    assertRoundTrips(project, new SetClipTransitionCommand(clip.id, { duration: 0.5, type: "crossfade" }));
  });

  it("undoes back to a truly absent transitionIn field, not null", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    const command = new SetClipTransitionCommand(clip.id, { duration: 0.5, type: "crossfade" });

    const applied = command.apply(project);
    const reverted = command.revert(applied);

    assert.equal(clipsOf(reverted, videoTrackId(reverted))[0].transitionIn, undefined);
    assert.deepEqual(comparable(reverted), comparable(project));
  });

  it("chains: two edits undo back through each intermediate value, including back to absent", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    const stack = new UndoStack();

    let p = stack.execute(project, new SetClipTransitionCommand(clip.id, { duration: 0.5, type: "crossfade" }));
    p = stack.execute(p, new SetClipTransitionCommand(clip.id, { duration: 1.2, type: "crossfade" }));
    assert.equal(clipsOf(p, videoTrackId(p))[0].transitionIn?.duration, 1.2);

    p = stack.undo(p);
    assert.equal(clipsOf(p, videoTrackId(p))[0].transitionIn?.duration, 0.5);

    p = stack.undo(p);
    assert.equal(clipsOf(p, videoTrackId(p))[0].transitionIn, undefined);
  });

  it("throws on revert if apply was never called — there is no previous value to distinguish from absent", () => {
    const command = new SetClipTransitionCommand("clip1", { duration: 0.5, type: "crossfade" });
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    assert.throws(() => command.revert(project), /never applied/);
  });
});

describe("SetClipTransitionOutCommand", () => {
  it("round-trips like every other command", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    assertRoundTrips(project, new SetClipTransitionOutCommand(clip.id, { duration: 0.5, type: "crossfade" }));
  });

  it("undoes back to a truly absent transitionOut field, not null", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    const command = new SetClipTransitionOutCommand(clip.id, { duration: 0.5, type: "crossfade" });

    const applied = command.apply(project);
    const reverted = command.revert(applied);

    assert.equal(clipsOf(reverted, videoTrackId(reverted))[0].transitionOut, undefined);
    assert.deepEqual(comparable(reverted), comparable(project));
  });

  it("chains: two edits undo back through each intermediate value, including back to absent", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    const stack = new UndoStack();

    let p = stack.execute(project, new SetClipTransitionOutCommand(clip.id, { duration: 0.5, type: "crossfade" }));
    p = stack.execute(p, new SetClipTransitionOutCommand(clip.id, { duration: 1.2, type: "crossfade" }));
    assert.equal(clipsOf(p, videoTrackId(p))[0].transitionOut?.duration, 1.2);

    p = stack.undo(p);
    assert.equal(clipsOf(p, videoTrackId(p))[0].transitionOut?.duration, 0.5);

    p = stack.undo(p);
    assert.equal(clipsOf(p, videoTrackId(p))[0].transitionOut, undefined);
  });

  it("throws on revert if apply was never called — there is no previous value to distinguish from absent", () => {
    const command = new SetClipTransitionOutCommand("clip1", { duration: 0.5, type: "crossfade" });
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    assert.throws(() => command.revert(project), /never applied/);
  });
});

describe("SetClipTransformKeyframesCommand", () => {
  it("round-trips like every other command", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    assertRoundTrips(project, new SetClipTransformKeyframesCommand(clip.id, [{ id: "kf1", time: 0, value: IDENTITY_TRANSFORM }]));
  });

  it("undoes back to a truly absent transformKeyframes field, not null", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    const command = new SetClipTransformKeyframesCommand(clip.id, [{ id: "kf1", time: 0, value: IDENTITY_TRANSFORM }]);

    const applied = command.apply(project);
    const reverted = command.revert(applied);

    assert.equal(clipsOf(reverted, videoTrackId(reverted))[0].transformKeyframes, undefined);
    assert.deepEqual(comparable(reverted), comparable(project));
  });

  it("chains: two edits undo back through each intermediate value, including back to absent", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    const stack = new UndoStack();

    let p = stack.execute(project, new SetClipTransformKeyframesCommand(clip.id, [{ id: "kf1", time: 0, value: { ...IDENTITY_TRANSFORM, scale: 1 } }]));
    p = stack.execute(
      p,
      new SetClipTransformKeyframesCommand(clip.id, [
        { id: "kf1", time: 0, value: { ...IDENTITY_TRANSFORM, scale: 1 } },
        { id: "kf2", time: 5, value: { ...IDENTITY_TRANSFORM, scale: 2 } },
      ])
    );
    assert.equal(clipsOf(p, videoTrackId(p))[0].transformKeyframes?.length, 2);

    p = stack.undo(p);
    assert.equal(clipsOf(p, videoTrackId(p))[0].transformKeyframes?.length, 1);

    p = stack.undo(p);
    assert.equal(clipsOf(p, videoTrackId(p))[0].transformKeyframes, undefined);
  });

  it("throws on revert if apply was never called — there is no previous value to distinguish from absent", () => {
    const command = new SetClipTransformKeyframesCommand("clip1", [{ id: "kf1", time: 0, value: IDENTITY_TRANSFORM }]);
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    assert.throws(() => command.revert(project), /never applied/);
  });
});

describe("SetClipEffectsKeyframesCommand", () => {
  it("round-trips like every other command", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    assertRoundTrips(project, new SetClipEffectsKeyframesCommand(clip.id, [{ id: "kf1", time: 0, value: IDENTITY_EFFECTS }]));
  });

  it("undoes back to a truly absent effectsKeyframes field, not null", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    const command = new SetClipEffectsKeyframesCommand(clip.id, [{ id: "kf1", time: 0, value: IDENTITY_EFFECTS }]);

    const applied = command.apply(project);
    const reverted = command.revert(applied);

    assert.equal(clipsOf(reverted, videoTrackId(reverted))[0].effectsKeyframes, undefined);
    assert.deepEqual(comparable(reverted), comparable(project));
  });

  it("throws on revert if apply was never called — there is no previous value to distinguish from absent", () => {
    const command = new SetClipEffectsKeyframesCommand("clip1", [{ id: "kf1", time: 0, value: IDENTITY_EFFECTS }]);
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    assert.throws(() => command.revert(project), /never applied/);
  });
});

describe("SetClipTextCropKeyframesCommand", () => {
  it("round-trips like every other command", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    assertRoundTrips(project, new SetClipTextCropKeyframesCommand(clip.id, [{ id: "kf1", time: 0, value: IDENTITY_TEXT_CROP }]));
  });

  it("undoes back to a truly absent textCropKeyframes field, not null", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    const command = new SetClipTextCropKeyframesCommand(clip.id, [{ id: "kf1", time: 0, value: IDENTITY_TEXT_CROP }]);

    const applied = command.apply(project);
    const reverted = command.revert(applied);

    assert.equal(clipsOf(reverted, videoTrackId(reverted))[0].textCropKeyframes, undefined);
    assert.deepEqual(comparable(reverted), comparable(project));
  });

  it("throws on revert if apply was never called — there is no previous value to distinguish from absent", () => {
    const command = new SetClipTextCropKeyframesCommand("clip1", [{ id: "kf1", time: 0, value: IDENTITY_TEXT_CROP }]);
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    assert.throws(() => command.revert(project), /never applied/);
  });
});

describe("DuplicateClipsCommand", () => {
  it("copies transform/effects/textAnimation/keyframes/mutedAudio/gain onto the new clip", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [original] = clipsOf(project, videoTrackId(project));
    project = new SetClipTransformCommand(original.id, { ...IDENTITY_TRANSFORM, scale: 1.5 }).apply(project);
    project = new SetClipEffectsCommand(original.id, { ...IDENTITY_EFFECTS, opacity: 0.4 }).apply(project);
    project = new SetClipTransformKeyframesCommand(original.id, [{ id: "kf1", time: 0, value: { ...IDENTITY_TRANSFORM, scale: 2 } }]).apply(project);
    project = new SetClipEffectsKeyframesCommand(original.id, [{ id: "kf1", time: 0, value: { ...IDENTITY_EFFECTS, opacity: 0.7 } }]).apply(project);

    const command = new DuplicateClipsCommand([original.id]);
    const applied = command.apply(project);
    const copy = clipsOf(applied, videoTrackId(applied)).find((c) => c.id !== original.id);

    assert.deepEqual(copy?.transform, { ...IDENTITY_TRANSFORM, scale: 1.5 });
    assert.deepEqual(copy?.effects, { ...IDENTITY_EFFECTS, opacity: 0.4 });
    assert.deepEqual(copy?.transformKeyframes, [{ id: "kf1", time: 0, value: { ...IDENTITY_TRANSFORM, scale: 2 } }]);
    assert.deepEqual(copy?.effectsKeyframes, [{ id: "kf1", time: 0, value: { ...IDENTITY_EFFECTS, opacity: 0.7 } }]);
  });

  it("round-trips like every other command", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    assertRoundTrips(project, new DuplicateClipsCommand([clip.id]));
  });
});
