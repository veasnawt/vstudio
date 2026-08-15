import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clipEnd } from "../src/project/createProject.ts";
import type { Track } from "../src/project/types.ts";
import { addClip } from "../src/timeline/operations.ts";
import { findTransitionCandidate, findTransitionPartner } from "../src/timeline/transitions.ts";
import { clipsOf, closeTo, emptyProject, videoAsset, videoTrackId } from "./fixture.ts";

/** Two clips placed back-to-back on the same video track, with zero gap between them — the baseline
 *  every test here starts from, since a transition only ever applies across a genuinely adjacent
 *  boundary. */
function twoAdjacentClips(durationA = 10, durationB = 10) {
  const base = emptyProject([videoAsset("a", durationA), videoAsset("b", durationB)]);
  let project = addClip(base, videoTrackId(base), "a", 0);
  const [clipA] = clipsOf(project, videoTrackId(project));
  project = addClip(project, videoTrackId(project), "b", clipEnd(clipA));
  const [first, second] = clipsOf(project, videoTrackId(project));
  const track = project.sequence.tracks.find((t) => t.id === videoTrackId(project)) as Track;
  return { project, track, clipA: first, clipB: second };
}

describe("findTransitionCandidate", () => {
  it("finds the immediately preceding, zero-gap clip regardless of whether transitionIn is set", () => {
    const { track, clipA, clipB } = twoAdjacentClips();
    const candidate = findTransitionCandidate(track, clipB);
    assert.equal(candidate?.id, clipA.id);
  });

  it("returns undefined for the very first clip on a track", () => {
    const { track, clipA } = twoAdjacentClips();
    assert.equal(findTransitionCandidate(track, clipA), undefined);
  });

  it("returns undefined when a gap separates the two clips", () => {
    const base = emptyProject([videoAsset("a", 10), videoAsset("b", 10)]);
    let project = addClip(base, videoTrackId(base), "a", 0);
    const [clipA] = clipsOf(project, videoTrackId(project));
    project = addClip(project, videoTrackId(project), "b", clipEnd(clipA) + 1);
    const [, clipB] = clipsOf(project, videoTrackId(project));
    const track = project.sequence.tracks.find((t) => t.id === videoTrackId(project)) as Track;

    assert.equal(findTransitionCandidate(track, clipB), undefined);
  });
});

describe("findTransitionPartner", () => {
  it("returns null when the clip has no transitionIn set at all", () => {
    const { track, clipB } = twoAdjacentClips();
    assert.equal(findTransitionPartner(track, clipB), null);
  });

  it("returns null when transitionIn's duration is non-positive", () => {
    const { track, clipB } = twoAdjacentClips();
    const requested = { ...clipB, transitionIn: { duration: 0, type: "crossfade" as const } };
    assert.equal(findTransitionPartner(track, requested), null);
  });

  it("finds the partner and the requested duration when genuinely adjacent", () => {
    const { track, clipA, clipB } = twoAdjacentClips();
    const requested = { ...clipB, transitionIn: { duration: 1, type: "crossfade" as const } };

    const result = findTransitionPartner(track, requested);

    assert.ok(result);
    assert.equal(result!.partner.id, clipA.id);
    assert.ok(closeTo(result!.duration, 1));
  });

  it("returns null when a gap separates the requesting clip from what would be its partner", () => {
    const base = emptyProject([videoAsset("a", 10), videoAsset("b", 10)]);
    let project = addClip(base, videoTrackId(base), "a", 0);
    const [clipA] = clipsOf(project, videoTrackId(project));
    project = addClip(project, videoTrackId(project), "b", clipEnd(clipA) + 1);
    const [, clipB] = clipsOf(project, videoTrackId(project));
    const track = project.sequence.tracks.find((t) => t.id === videoTrackId(project)) as Track;
    const requested = { ...clipB, transitionIn: { duration: 1, type: "crossfade" as const } };

    assert.equal(findTransitionPartner(track, requested), null);
  });

  it("clamps the effective duration to the shorter of the two clips' own lengths", () => {
    const { track, clipB } = twoAdjacentClips(2, 10);
    const requested = { ...clipB, transitionIn: { duration: 5, type: "crossfade" as const } };

    const result = findTransitionPartner(track, requested);

    assert.ok(result);
    assert.ok(closeTo(result!.duration, 2));
  });
});
