import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clipEnd } from "../src/project/createProject.ts";
import type { Track } from "../src/project/types.ts";
import { addClip, setClipTransitionIn, setClipTransitionOut } from "../src/timeline/operations.ts";
import { findTransitionCandidate, findTransitionOut, findTransitionPartner, resolveAudioTransitionGain } from "../src/timeline/transitions.ts";
import { audioAsset, audioTrackId, clipsOf, closeTo, emptyProject, videoAsset, videoTrackId } from "./fixture.ts";

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
    assert.equal(result!.partner?.id, clipA.id);
    assert.ok(closeTo(result!.duration, 1));
  });

  it("resolves to a solo fade (null partner) when a gap separates the requesting clip from what would be its partner", () => {
    const base = emptyProject([videoAsset("a", 10), videoAsset("b", 10)]);
    let project = addClip(base, videoTrackId(base), "a", 0);
    const [clipA] = clipsOf(project, videoTrackId(project));
    project = addClip(project, videoTrackId(project), "b", clipEnd(clipA) + 1);
    const [, clipB] = clipsOf(project, videoTrackId(project));
    const track = project.sequence.tracks.find((t) => t.id === videoTrackId(project)) as Track;
    const requested = { ...clipB, transitionIn: { duration: 1, type: "crossfade" as const } };

    const result = findTransitionPartner(track, requested);

    assert.ok(result);
    assert.equal(result!.partner, null);
    assert.ok(closeTo(result!.duration, 1));
  });

  it("resolves to a solo fade for the very first clip on a track (nothing precedes it at all)", () => {
    const { track, clipA } = twoAdjacentClips();
    const requested = { ...clipA, transitionIn: { duration: 1, type: "crossfade" as const } };

    const result = findTransitionPartner(track, requested);

    assert.ok(result);
    assert.equal(result!.partner, null);
    assert.ok(closeTo(result!.duration, 1));
  });

  it("a solo fade's duration is still clamped to the requesting clip's own length", () => {
    const { track, clipA } = twoAdjacentClips(2, 10);
    const requested = { ...clipA, transitionIn: { duration: 5, type: "crossfade" as const } };

    const result = findTransitionPartner(track, requested);

    assert.ok(result);
    assert.equal(result!.partner, null);
    assert.ok(closeTo(result!.duration, 2));
  });

  it("clamps the effective duration to the shorter of the two clips' own lengths", () => {
    const { track, clipB } = twoAdjacentClips(2, 10);
    const requested = { ...clipB, transitionIn: { duration: 5, type: "crossfade" as const } };

    const result = findTransitionPartner(track, requested);

    assert.ok(result);
    assert.ok(closeTo(result!.duration, 2));
  });
});

describe("findTransitionOut", () => {
  it("returns null when the clip has no transitionOut set at all", () => {
    const { track, clipB } = twoAdjacentClips();
    assert.equal(findTransitionOut(track, clipB), null);
  });

  it("returns null when transitionOut's duration is non-positive", () => {
    const { track, clipB } = twoAdjacentClips();
    const requested = { ...clipB, transitionOut: { duration: 0, type: "crossfade" as const } };
    assert.equal(findTransitionOut(track, requested), null);
  });

  it("resolves to a solo fade for the last clip on a track (nothing follows it)", () => {
    const { track, clipB } = twoAdjacentClips();
    const requested = { ...clipB, transitionOut: { duration: 1, type: "crossfade" as const } };

    const result = findTransitionOut(track, requested);

    assert.ok(result);
    assert.ok(closeTo(result!.duration, 1));
  });

  it("returns null when a genuine successor exists, regardless of whether IT has a transitionIn", () => {
    const { track, clipA } = twoAdjacentClips();
    const requested = { ...clipA, transitionOut: { duration: 1, type: "crossfade" as const } };

    assert.equal(findTransitionOut(track, requested), null);
  });

  it("resolves to a solo fade when a gap separates this clip from what would be its successor", () => {
    const base = emptyProject([videoAsset("a", 10), videoAsset("b", 10)]);
    let project = addClip(base, videoTrackId(base), "a", 0);
    const [clipA] = clipsOf(project, videoTrackId(project));
    project = addClip(project, videoTrackId(project), "b", clipEnd(clipA) + 1);
    const [firstClip] = clipsOf(project, videoTrackId(project));
    const track = project.sequence.tracks.find((t) => t.id === videoTrackId(project)) as Track;
    const requested = { ...firstClip, transitionOut: { duration: 1, type: "crossfade" as const } };

    const result = findTransitionOut(track, requested);

    assert.ok(result);
    assert.ok(closeTo(result!.duration, 1));
  });

  it("clamps the effective duration to the clip's own length", () => {
    const base = emptyProject([videoAsset("a", 2)]);
    const project = addClip(base, videoTrackId(base), "a", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    const track = project.sequence.tracks.find((t) => t.id === videoTrackId(project)) as Track;
    const requested = { ...clip, transitionOut: { duration: 5, type: "crossfade" as const } };

    const result = findTransitionOut(track, requested);

    assert.ok(result);
    assert.ok(closeTo(result!.duration, 2));
  });
});

/** All three query functions above are documented as track-kind-agnostic (see `Clip.transitionIn`'s
 *  own doc comment in `project/types.ts`) — every test above only ever exercises them against a video
 *  track, so this confirms that claim actually holds for an AUDIO track too, rather than trusting the
 *  doc comment on faith. Deliberately thin (one representative case per function, not a full re-run of
 *  every scenario above) — the underlying logic is IDENTICAL code, not a parallel implementation, so
 *  this is a regression guard against a future change accidentally introducing a `track.kind` check,
 *  not a search for track-kind-specific bugs that couldn't exist here in the first place. */
describe("transition queries against an audio track", () => {
  function twoAdjacentAudioClips(durationA = 10, durationB = 10) {
    const base = emptyProject([audioAsset("a", durationA), audioAsset("b", durationB)]);
    let project = addClip(base, audioTrackId(base), "a", 0);
    const [clipA] = clipsOf(project, audioTrackId(project));
    project = addClip(project, audioTrackId(project), "b", clipEnd(clipA));
    const [first, second] = clipsOf(project, audioTrackId(project));
    const track = project.sequence.tracks.find((t) => t.id === audioTrackId(project)) as Track;
    return { project, track, clipA: first, clipB: second };
  }

  it("findTransitionCandidate finds the adjacent predecessor on an audio track", () => {
    const { track, clipA, clipB } = twoAdjacentAudioClips();
    assert.equal(findTransitionCandidate(track, clipB)?.id, clipA.id);
  });

  it("findTransitionPartner resolves a real blend partner on an audio track", () => {
    const { track, clipA, clipB } = twoAdjacentAudioClips();
    const requested = { ...clipB, transitionIn: { duration: 1, type: "crossfade" as const } };

    const result = findTransitionPartner(track, requested);

    assert.equal(result?.partner?.id, clipA.id);
    assert.ok(closeTo(result!.duration, 1));
  });

  it("findTransitionOut resolves a solo fade at the end of an audio track", () => {
    const base = emptyProject([audioAsset("a", 5)]);
    const project = addClip(base, audioTrackId(base), "a", 0);
    const [clip] = clipsOf(project, audioTrackId(project));
    const track = project.sequence.tracks.find((t) => t.id === audioTrackId(project)) as Track;
    const requested = { ...clip, transitionOut: { duration: 1, type: "crossfade" as const } };

    const result = findTransitionOut(track, requested);

    assert.ok(result);
    assert.ok(closeTo(result!.duration, 1));
  });
});

/** `resolveAudioTransitionGain` is `PlaybackEngine`'s live-preview counterpart to
 *  `buildAudioTrackStream`'s export-time `acrossfade`/`afade` — this is where that math actually gets
 *  verified, since `PlaybackEngine` itself needs a real DOM/canvas to run at all and can't be unit
 *  tested directly. Built as a pure function specifically so this coverage could exist. */
describe("resolveAudioTransitionGain", () => {
  it("returns gain 1 and no partner outside any transition window", () => {
    const base = emptyProject([audioAsset("a", 10)]);
    const project = addClip(base, audioTrackId(base), "a", 0);
    const [clip] = clipsOf(project, audioTrackId(project));
    const track = project.sequence.tracks.find((t) => t.id === audioTrackId(project)) as Track;

    const result = resolveAudioTransitionGain(track, clip, 5);

    assert.equal(result.gain, 1);
    assert.equal(result.partner, null);
  });

  it("ramps both clips in opposite directions through a real crossfade blend, in the incoming clip's own timeline window", () => {
    const base = emptyProject([audioAsset("a", 5), audioAsset("b", 5)]);
    let project = addClip(base, audioTrackId(base), "a", 0);
    let [clipA] = clipsOf(project, audioTrackId(project));
    project = addClip(project, audioTrackId(project), "b", clipEnd(clipA));
    let [, clipB] = clipsOf(project, audioTrackId(project));
    project = setClipTransitionIn(project, clipB.id, { duration: 1, type: "crossfade" });
    const track = project.sequence.tracks.find((t) => t.id === audioTrackId(project)) as Track;
    [clipA, clipB] = clipsOf(project, audioTrackId(project));

    // clipB.timelineStart === 5 (clipA is 5s long) — the 1s blend window is [5, 6).
    const atStart = resolveAudioTransitionGain(track, clipB, 5);
    assert.ok(closeTo(atStart.gain, 0), "incoming clip starts silent");
    assert.ok(atStart.partner);
    assert.equal(atStart.partner!.clip.id, clipA.id);
    assert.ok(closeTo(atStart.partner!.gain, 1), "outgoing clip starts at full volume");
    assert.ok(closeTo(atStart.partner!.sourceTime, clipA.sourceOut - 1), "outgoing clip continues from its own last 1s");

    const atMid = resolveAudioTransitionGain(track, clipB, 5.5);
    assert.ok(closeTo(atMid.gain, 0.5));
    assert.ok(closeTo(atMid.partner!.gain, 0.5));
    assert.ok(closeTo(atMid.partner!.sourceTime, clipA.sourceOut - 0.5), "outgoing clip's own sourceTime keeps advancing with the blend");

    const nearEnd = resolveAudioTransitionGain(track, clipB, 5.9);
    assert.ok(closeTo(nearEnd.gain, 0.9));
    assert.ok(closeTo(nearEnd.partner!.gain, 0.1));

    // Past the blend window (still within clipB's own overall duration) — a plain, untouched clip.
    const afterBlend = resolveAudioTransitionGain(track, clipB, 7);
    assert.equal(afterBlend.gain, 1);
    assert.equal(afterBlend.partner, null);
  });

  it("ramps up from silence for a solo fade-in (no adjacent predecessor to blend from)", () => {
    const base = emptyProject([audioAsset("a", 10)]);
    let project = addClip(base, audioTrackId(base), "a", 0);
    const [original] = clipsOf(project, audioTrackId(project));
    project = setClipTransitionIn(project, original.id, { duration: 2, type: "crossfade" });
    const track = project.sequence.tracks.find((t) => t.id === audioTrackId(project)) as Track;
    const [clip] = clipsOf(project, audioTrackId(project));

    const atStart = resolveAudioTransitionGain(track, clip, 0);
    assert.ok(closeTo(atStart.gain, 0));
    assert.equal(atStart.partner, null);

    const atMid = resolveAudioTransitionGain(track, clip, 1);
    assert.ok(closeTo(atMid.gain, 0.5));
    assert.equal(atMid.partner, null);

    const afterFade = resolveAudioTransitionGain(track, clip, 3);
    assert.equal(afterFade.gain, 1);
  });

  it("ramps down toward silence for a solo fade-out (nothing follows this clip)", () => {
    const base = emptyProject([audioAsset("a", 10)]);
    let project = addClip(base, audioTrackId(base), "a", 0);
    const [original] = clipsOf(project, audioTrackId(project));
    project = setClipTransitionOut(project, original.id, { duration: 2, type: "crossfade" });
    const track = project.sequence.tracks.find((t) => t.id === audioTrackId(project)) as Track;
    const [clip] = clipsOf(project, audioTrackId(project));

    // Before the fade-out window (starts at duration - 2 = 8).
    const beforeFade = resolveAudioTransitionGain(track, clip, 5);
    assert.equal(beforeFade.gain, 1);

    const atStart = resolveAudioTransitionGain(track, clip, 8);
    assert.ok(closeTo(atStart.gain, 1));

    const atMid = resolveAudioTransitionGain(track, clip, 9);
    assert.ok(closeTo(atMid.gain, 0.5));

    // t=9.9 is 1.9s into the 2s fade-out window starting at t=8: progress 0.95, gain 0.05.
    const nearEnd = resolveAudioTransitionGain(track, clip, 9.9);
    assert.ok(closeTo(nearEnd.gain, 0.05));
  });

  it("a broken adjacency (a dragged-open gap) makes the blend fall back to a solo fade-in, matching export's own fallback", () => {
    const base = emptyProject([audioAsset("a", 5), audioAsset("b", 5)]);
    let project = addClip(base, audioTrackId(base), "a", 0);
    const [clipA] = clipsOf(project, audioTrackId(project));
    project = addClip(project, audioTrackId(project), "b", clipEnd(clipA) + 1);
    const [, originalB] = clipsOf(project, audioTrackId(project));
    project = setClipTransitionIn(project, originalB.id, { duration: 1, type: "crossfade" });
    const track = project.sequence.tracks.find((t) => t.id === audioTrackId(project)) as Track;
    const [, clipB] = clipsOf(project, audioTrackId(project));

    const result = resolveAudioTransitionGain(track, clipB, clipB.timelineStart);

    assert.ok(closeTo(result.gain, 0), "still ramps up from silence — just nothing to blend FROM");
    assert.equal(result.partner, null);
  });
});
