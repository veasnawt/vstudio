import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildExportPlan, ExportError } from "../src/export/buildExportPlan.ts";
import { clipEnd } from "../src/project/createProject.ts";
import {
  addClip,
  addTrack,
  moveClip,
  setClipColorGrading,
  setClipColorGradingKeyframes,
  setClipEffects,
  setClipEffectsKeyframes,
  setClipGain,
  setClipMuted,
  setClipTextAnimation,
  setClipTextCrop,
  setClipTextStyleKeyframes,
  setClipTransform,
  setClipTransformKeyframes,
  setClipTransitionIn,
  setClipTransitionOut,
  setMasterGain,
  setTextAsset,
  setTrackFlag,
  setTrackGain,
  splitClip,
  trimClip,
} from "../src/timeline/operations.ts";
import { audioAsset, audioTrackId, clipsOf, closeTo, emptyProject, imageAsset, textAsset, textTrackId, videoAsset, videoTrackId } from "./fixture.ts";
import { DEFAULT_TEXT_STYLE, IDENTITY_COLOR_GRADING, IDENTITY_EFFECTS, IDENTITY_TRANSFORM } from "../src/project/types.ts";
import { DEFAULT_WORD_HIGHLIGHT_COLOR } from "../src/timeline/textAnimation.ts";

/** "#rrggbb" → the same `&H00bbggrr` form `buildExportPlan.ts`'s own (unexported) `assColor` produces —
 *  duplicated here deliberately rather than exported from production code purely for a test to import,
 *  matching this test file's existing style of asserting against literal expected strings elsewhere. */
function assColorForTest(hex: string): string {
  return `&H00${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`;
}

const options = {
  inputPathFor: (assetId: string) => `/media/${assetId}.mp4`,
  outputPath: "/out/export.mp4",
  fontPathFor: (fileName: string) => `/fonts/${fileName}`,
  textFilePathFor: (clip: { id: string }, _content: string, variant?: string) => `/tmp/${clip.id}${variant ? `-${variant}` : ""}.txt`,
};

function plan(project: Parameters<typeof buildExportPlan>[0]) {
  return buildExportPlan(project, options);
}

/** The filter graph is one long argument; pulling it out by name keeps assertions readable. */
function filterGraph(args: string[]): string {
  const index = args.indexOf("-filter_complex");
  assert.ok(index >= 0, "plan should contain a filter_complex");
  return args[index + 1];
}

describe("buildExportPlan", () => {
  it("refuses to export an empty timeline", () => {
    assert.throws(() => plan(emptyProject()), ExportError);
  });

  it("refuses to export when every video track is hidden", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = setTrackFlag(project, videoTrackId(project), "visible", false);

    assert.throws(() => plan(project), ExportError);
  });

  it("seeks with -ss/-t before -i so only the trimmed range is decoded", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    // Trim 2s off the front, then pull the clip back to the start of the timeline. Without the move
    // the trim would leave a 0–2s gap, and the first input would be that gap's black filler rather
    // than the clip under test.
    project = trimClip(project, clip.id, "in", 2);
    project = moveClip(project, clip.id, videoTrackId(project), 0);

    const { args } = plan(project);
    const inputIndex = args.indexOf("-i");

    // -ss and -t must PRECEDE the -i they apply to; after it they would mean something else entirely.
    assert.equal(args[inputIndex - 4], "-ss");
    assert.ok(closeTo(Number(args[inputIndex - 3]), 2), `expected seek to 2s, got ${args[inputIndex - 3]}`);
    assert.equal(args[inputIndex - 2], "-t");
    assert.ok(closeTo(Number(args[inputIndex - 1]), 8), `expected 8s duration, got ${args[inputIndex - 1]}`);
  });

  it("reports the sequence duration so progress can be measured against it", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = trimClip(project, clip.id, "out", 4);

    assert.ok(closeTo(plan(project).duration, 4));
  });

  it("concatenates every clip of a split-and-trimmed timeline in order", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [original] = clipsOf(project, videoTrackId(project));
    project = splitClip(project, original.id, 4);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /concat=n=2:v=1:a=1\[cv0\]\[ca0\]/);
  });

  it("fills a gap in the timeline with generated black and silence", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [first] = clipsOf(project, videoTrackId(project));
    project = trimClip(project, first.id, "out", 3);
    // Leaves 3s–8s empty before the next clip.
    project = addClip(project, videoTrackId(project), "asset1", 8);

    const { args, duration } = plan(project);
    const graph = filterGraph(args);

    assert.ok(args.some((a) => a.startsWith("color=c=black")), "a gap should produce a black source");
    assert.ok(args.some((a) => a.startsWith("anullsrc")), "a gap should produce a silent source");
    // Three segments: clip, gap, clip — the exported length must match the timeline exactly.
    assert.match(graph, /concat=n=3:v=1:a=1/);
    assert.ok(closeTo(duration, 18), `expected 18s total, got ${duration}`);
  });

  it("substitutes silence for a clip that has no audio, so concat still pairs up", () => {
    const silentAsset = { ...videoAsset("silent"), hasAudio: false };
    const base = emptyProject([silentAsset]);
    const project = addClip(base, videoTrackId(base), "silent", 0);

    const args = plan(project).args;

    assert.ok(args.some((a) => a.startsWith("anullsrc")), "a silent clip needs a generated audio pad");
    assert.match(filterGraph(args), /concat=n=1:v=1:a=1/);
  });

  it("letterboxes into the export frame rather than stretching", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /force_original_aspect_ratio=decrease/);
    assert.match(graph, /pad=1080:1920/);
    assert.match(graph, /setsar=1/);
  });

  it("positions an audio-track clip with a leading silent gap segment, then mixes the track in", () => {
    const base = emptyProject([videoAsset("asset1", 10), audioAsset()]);
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, audioTrackId(project), "music", 2);

    const { args } = plan(project);
    const graph = filterGraph(args);

    // Positioned via a 2s silent gap segment ahead of the clip's own audio, concatenated into one
    // per-track stream — the same "pad with silence, then concat" mechanism a video track's own audio
    // already uses, not `adelay` (replaced so this track can also support real `acrossfade`
    // transitions between its own clips — see `buildAudioTrackStream`'s own comment). The gap's own
    // silence source is an `-i` input argument, not part of the filter graph string itself — same
    // place every other generated-silence input in this suite gets checked (e.g. the image tests'
    // "gives a silent still a generated audio pad" above).
    assert.ok(args.some((a) => a.startsWith("anullsrc")), "the leading gap needs a generated silent pad");
    assert.match(graph, /concat=n=2:v=0:a=1\[at0\]/);
    assert.match(graph, /\[ca0\]\[at0\]amix=inputs=2:normalize=0/);
  });

  it("omits the mix stage entirely when there are no audio-track clips", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);

    const { args } = plan(project);

    assert.ok(!filterGraph(args).includes("amix"));
    assert.equal(args[args.indexOf("-map") + 1], "[cv0]");
    assert.equal(args.lastIndexOf("-map") >= 0 && args[args.lastIndexOf("-map") + 1], "[ca0]");
  });

  it("skips a muted audio track", () => {
    const base = emptyProject([videoAsset("asset1", 10), audioAsset()]);
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, audioTrackId(project), "music", 2);
    project = setTrackFlag(project, audioTrackId(project), "muted", true);

    assert.ok(!filterGraph(plan(project).args).includes("amix"));
  });

  it("encodes H.264/AAC MP4 with a faststart index and an explicit duration cap", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);

    const { args } = plan(project);

    assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
    assert.equal(args[args.indexOf("-c:a") + 1], "aac");
    assert.equal(args[args.indexOf("-pix_fmt") + 1], "yuv420p");
    assert.equal(args[args.indexOf("-movflags") + 1], "+faststart");
    assert.equal(args[args.length - 1], "/out/export.mp4");
    assert.ok(args.includes("-t"), "output duration should be capped to the timeline length");
  });

  it("refuses to export while media is offline rather than rendering a broken video", () => {
    const offline = { ...videoAsset("asset1"), offline: true };
    const base = emptyProject([offline]);
    const project = addClip(base, videoTrackId(base), "asset1", 0);

    assert.throws(() => plan(project), ExportError);
  });
});

describe("buildExportPlan when exportSettings' own resolution differs from the sequence's", () => {
  it("uses the SEQUENCE's own width/height for every internal filter, not exportSettings' — regression for a real position-shift bug", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    // The sequence itself stays at its default 1080x1920 (every position/crop/offset in the whole app
    // is authored against THIS canvas, via the live preview) — only the export dialog's own,
    // independently-editable resolution differs, exactly like a user picking a smaller/different preset
    // there. Confirmed live against the real FFmpeg binary: before this fix, a `TextStyle.offsetX: 100`
    // landed at 20.4% from the left edge at a mismatched 720x1280 export instead of the correct 13.6% —
    // this test guards the mechanism (internal canvas size), not the specific pixel math (covered by
    // the text-position tests elsewhere).
    project = { ...project, exportSettings: { ...project.exportSettings, width: 720, height: 1280 } };

    const graph = filterGraph(plan(project).args);

    // The plain scale+pad chain (see "letterboxes into the export frame rather than stretching" above)
    // must still target the SEQUENCE's own 1080x1920 — proving every clip's own geometry is computed
    // against the canvas preview actually shows, unaffected by the mismatched export size.
    assert.match(graph, /pad=1080:1920/);
  });

  it("conforms the fully-composited result to the REQUESTED export size in one closing scale/pad stage", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = { ...project, exportSettings: { ...project.exportSettings, width: 720, height: 1280 } };

    const { args } = plan(project);
    const graph = filterGraph(args);

    // Exactly one additional conform stage, targeting the requested 720x1280 — distinct from the
    // per-clip 1080x1920 pad already asserted above.
    assert.match(graph, /\[cv0\]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:\(ow-iw\)\/2:\(oh-ih\)\/2,setsar=1\[conformed\]/);
    assert.equal(args[args.indexOf("-map") + 1], "[conformed]", "the map target must be the conformed output, not the raw sequence-sized composite");
  });

  it("skips the conform stage entirely — byte-for-byte identical graph — when the sizes already match (the common case)", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);

    const graph = filterGraph(plan(project).args);

    assert.ok(!graph.includes("[conformed]"), "no project ever pays for this stage unless it actually asked for a different export size");
  });
});

describe("buildExportPlan with images", () => {
  it("loops a still for the clip's duration instead of seeking into it", () => {
    const base = emptyProject([imageAsset()]);
    const project = addClip(base, videoTrackId(base), "img1", 0);

    const { args, duration } = plan(project);
    const inputIndex = args.indexOf("-i");

    // A still has no timeline to seek into: -loop 1 repeats it, and -ss would be meaningless.
    assert.equal(args[0], "-loop");
    assert.equal(args[1], "1");
    assert.ok(!args.slice(0, inputIndex).includes("-ss"), "an image input must not be given -ss");
    assert.ok(args.slice(0, inputIndex).includes("-t"), "an image input needs an explicit duration");
    // IMAGE_DEFAULT_DURATION — a still gets a sensible default length when placed.
    assert.ok(closeTo(duration, 5), `expected the default 5s image duration, got ${duration}`);
  });

  it("gives a silent still a generated audio pad so concat still pairs up", () => {
    const base = emptyProject([imageAsset()]);
    const project = addClip(base, videoTrackId(base), "img1", 0);

    const { args } = plan(project);

    assert.ok(args.some((a) => a.startsWith("anullsrc")), "an image has no audio stream of its own");
    assert.match(filterGraph(args), /concat=n=1:v=1:a=1/);
  });

  it("mixes stills and video in one timeline", () => {
    const base = emptyProject([videoAsset("asset1", 10), imageAsset()]);
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, videoTrackId(project), "img1", 10);

    const { args } = plan(project);

    assert.match(filterGraph(args), /concat=n=2:v=1:a=1/);
    assert.ok(args.includes("-loop"), "the still still needs looping alongside the video clip");
    assert.ok(closeTo(plan(project).duration, 15));
  });
});

describe("buildExportPlan with a real transform", () => {
  it("keeps the untransformed scale+pad chain byte-for-byte identical (regression)", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /scale=1080:1920:force_original_aspect_ratio=decrease/);
    assert.match(graph, /pad=1080:1920:\(ow-iw\)\/2:\(oh-ih\)\/2/);
    assert.ok(!graph.includes("rotate="), "an untransformed clip must not go through the rotate chain");
    assert.ok(!graph.includes("overlay="), "an untransformed clip must not go through the overlay chain");
  });

  it("an explicit identity transform takes the same untransformed path as no transform at all", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setClipTransform(project, clip.id, {
      offsetX: 0, offsetY: 0, scale: 1, rotationDeg: 0, crop: { top: 0, right: 0, bottom: 0, left: 0 },
    });

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /scale=1080:1920:force_original_aspect_ratio=decrease/);
    assert.ok(!graph.includes("rotate="));
  });

  it("emits crop/scale/rotate/overlay with the exact requested values", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setClipTransform(project, clip.id, {
      offsetX: 25, offsetY: -15, scale: 1.5, rotationDeg: 42,
      crop: { top: 0.1, right: 0.05, bottom: 0.2, left: 0.15 },
    });

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /crop=w=iw\*\(1-0\.150000-0\.050000\):h=ih\*\(1-0\.100000-0\.200000\):x=iw\*0\.150000:y=ih\*0\.100000/);
    assert.match(graph, /format=rgba/);
    assert.match(graph, /scale=w='iw\*min\(1080\/iw,1920\/ih\)\*1\.500000'/);
    assert.match(graph, /rotate=a=42\.000000\*PI\/180:ow=rotw\(42\.000000\*PI\/180\):oh=roth\(42\.000000\*PI\/180\):c=black@0/);
    assert.match(graph, /overlay=x='\(W-w\)\/2\+25\.000000':y='\(H-h\)\/2\+-15\.000000':format=auto/);
  });

  it("gives the transform chain its own black background input, distinct from the source", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setClipTransform(project, clip.id, { ...IDENTITY_TRANSFORM, rotationDeg: 10 });

    const { args } = plan(project);

    assert.ok(args.some((a) => a.startsWith("color=c=black:s=1080x1920")), "expected a background color source");
  });

  it("a rotated clip's audio is unaffected — audio handling is independent of the video transform", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setClipTransform(project, clip.id, { ...IDENTITY_TRANSFORM, rotationDeg: 90 });

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /aresample=48000,aformat=channel_layouts=stereo/);
  });

  it("a transformed clip still concatenates correctly alongside an untransformed one", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [original] = clipsOf(project, videoTrackId(project));
    project = splitClip(project, original.id, 4);
    const [, second] = clipsOf(project, videoTrackId(project));
    project = setClipTransform(project, second.id, { ...IDENTITY_TRANSFORM, scale: 2 });

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /concat=n=2:v=1:a=1\[cv0\]\[ca0\]/);
  });
});

describe("buildExportPlan with keyframed transform/effects", () => {
  it("a plain clip's filter graph never mentions the slicing machinery (regression)", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);

    const graph = filterGraph(plan(project).args);

    assert.ok(!graph.includes("_kf"), "an unkeyframed clip must not go through per-slice labels");
    assert.ok(!graph.includes("v=1:a=0"), "the keyframe inner concat pattern must not appear for a plain clip");
  });

  it("slices a keyframed Transform clip into the expected number of static sub-segments, concatenated video-only", () => {
    const base = emptyProject([videoAsset("asset1", 0.5)]);
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setClipTransformKeyframes(project, clip.id, [
      { id: "a", time: 0, value: IDENTITY_TRANSFORM },
      { id: "b", time: 0.5, value: { ...IDENTITY_TRANSFORM, scale: 2 } },
    ]);

    const graph = filterGraph(plan(project).args);

    // A single 0.5s gap subdivided at the 0.15s base interval: ceil(0.5 / 0.15) = 4 slices.
    assert.match(graph, /concat=n=4:v=1:a=0\[/);
    // Each slice goes through the exact same buildTransformFilters chain a static transformed clip
    // uses (crop/eq/scale/rotate/overlay) — 4 full occurrences, one per slice.
    assert.equal((graph.match(/overlay=x=/g) ?? []).length, 4);
  });

  it("slices a keyframed Effects clip the same way", () => {
    const base = emptyProject([videoAsset("asset1", 0.5)]);
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setClipEffectsKeyframes(project, clip.id, [
      { id: "a", time: 0, value: { ...IDENTITY_EFFECTS, opacity: 1 } },
      { id: "b", time: 0.5, value: { ...IDENTITY_EFFECTS, opacity: 0 } },
    ]);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /concat=n=4:v=1:a=0\[/);
    assert.equal((graph.match(/lutyuv=/g) ?? []).length, 4);
  });

  it("slices a clip keyframed ONLY on ColorGrading (no transform/effects keyframes) the same way", () => {
    const base = emptyProject([videoAsset("asset1", 0.5)]);
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    // The boundary at 0.25 sits STRICTLY inside the 0.5s clip (unlike the transform/effects tests
    // above, whose second keyframe sits at the clip's own end and never actually becomes a mid-clip
    // boundary) — this is what actually exercises the HOLD-not-lerp behavior: every slice before 0.25
    // must resolve to the identity keyframe, every slice from 0.25 onward to the non-identity one.
    project = setClipColorGradingKeyframes(project, clip.id, [
      { id: "a", time: 0, value: IDENTITY_COLOR_GRADING },
      { id: "b", time: 0.25, value: { ...IDENTITY_COLOR_GRADING, master: [{ x: 0, y: 0.2 }, { x: 1, y: 1 }] } },
    ]);

    const graph = filterGraph(plan(project).args);

    // Confirms the `hasColorGradingKeyframes` gate: a color-grading-only keyframed clip must still
    // route through the keyframed slicing path, not the plain one.
    assert.match(graph, /concat=n=4:v=1:a=0\[/);
    assert.equal((graph.match(/overlay=x=/g) ?? []).length, 4);
    // Only the 2 post-boundary slices carry a `curves=` fragment — the 2 pre-boundary slices hold the
    // identity curve, which emits no fragment at all (see `buildCurvesFilterFragment`'s own `null`
    // shape).
    assert.equal((graph.match(/curves=interp=natural:/g) ?? []).length, 2);
  });

  it("never slices audio — exactly one audio chain for a keyframed clip, not one per slice", () => {
    const base = emptyProject([videoAsset("asset1", 0.5)]);
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setClipTransformKeyframes(project, clip.id, [
      { id: "a", time: 0, value: IDENTITY_TRANSFORM },
      { id: "b", time: 0.5, value: { ...IDENTITY_TRANSFORM, scale: 2 } },
    ]);

    const graph = filterGraph(plan(project).args);

    assert.equal((graph.match(/aresample=48000/g) ?? []).length, 1);
  });

  it("a keyframed clip with no real audio produces no wasted audio-only source input", () => {
    const base = emptyProject([{ ...videoAsset("asset1", 0.5), hasAudio: false }]);
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setClipTransformKeyframes(project, clip.id, [
      { id: "a", time: 0, value: IDENTITY_TRANSFORM },
      { id: "b", time: 0.5, value: { ...IDENTITY_TRANSFORM, scale: 2 } },
    ]);

    const { args } = plan(project);
    const graph = filterGraph(args);

    assert.ok(!graph.includes("aresample=48000"), "no real audio to extract — must fall back to anullsrc");
    assert.ok(args.some((a) => a.startsWith("anullsrc")), "a keyframed clip with no audio still needs a generated silent pad");
  });

  it("opens the real source and the background color exactly once per segment, not once per slice (ENAMETOOLONG regression)", () => {
    const base = emptyProject([videoAsset("asset1", 0.5)]);
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setClipTransformKeyframes(project, clip.id, [
      { id: "a", time: 0, value: IDENTITY_TRANSFORM },
      { id: "b", time: 0.5, value: { ...IDENTITY_TRANSFORM, scale: 2 } },
    ]);

    const { args } = plan(project);
    const graph = filterGraph(args);
    const inputValuesAfter = (flag: string) => args.filter((a, i) => args[i - 1] === flag);

    // 4 slices (see the earlier "slices a keyframed Transform clip..." test), but the real source path
    // must be opened only twice — once for `pushKeyframedClipVideoFilters`'s own segment-wide source,
    // once for `pushKeyframedAudio`'s own separate (and always segment-wide, never per-slice) audio
    // source — never once per slice. Before this fix it was opened 5 times here (4 video + 1 audio),
    // and grew unboundedly with slice count on a longer clip (see the regression test below).
    assert.equal(inputValuesAfter("-i").filter((v) => v === "/media/asset1.mp4").length, 2);
    // The synthetic background color source has no audio counterpart, so it must be opened exactly once.
    assert.equal(inputValuesAfter("-i").filter((v) => v.startsWith("color=")).length, 1);

    // In-graph fan-out replaces the old per-slice re-opens: one `split=4` for the source pad, one for
    // the background pad.
    assert.equal((graph.match(/split=4\[/g) ?? []).length, 2);
  });

  it("trims each fanned-out slice pad to its own telescoping, zero-based sub-range", () => {
    const base = emptyProject([videoAsset("asset1", 0.5)]);
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setClipTransformKeyframes(project, clip.id, [
      { id: "a", time: 0, value: IDENTITY_TRANSFORM },
      { id: "b", time: 0.5, value: { ...IDENTITY_TRANSFORM, scale: 2 } },
    ]);

    const graph = filterGraph(plan(project).args);

    const srcTrims = [...graph.matchAll(/_kfsrcsplit\d+\]trim=start=([\d.]+):end=([\d.]+),setpts=PTS-STARTPTS/g)].map(
      (m) => [Number(m[1]), Number(m[2])] as const
    );
    assert.equal(srcTrims.length, 4, "one trim= per slice, reading from its own split-fanned pad");
    assert.equal(srcTrims[0][0], 0, "the first slice's trim starts at the segment's own zero");
    assert.equal(srcTrims[srcTrims.length - 1][1], 0.5, "the last slice's trim ends at the segment's own end");
    for (let i = 1; i < srcTrims.length; i++) {
      assert.equal(srcTrims[i][0], srcTrims[i - 1][1], "slices telescope with no gap or overlap");
    }
  });

  it("keeps the input count constant, not proportional to slice count, on a long clip driven to the adaptive slice ceiling (ENAMETOOLONG regression)", () => {
    // A 220s clip with keyframes spanning its whole duration forces `computeSliceBoundaries`'s own
    // adaptive recompute (see its doc comment), landing on exactly `MAX_KEYFRAME_SLICES_PER_CLIP` = 240
    // slices — the shape of the user's real, reported crash (a long, richly keyframed clip).
    const base = emptyProject([videoAsset("asset1", 220)]);
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setClipTransformKeyframes(project, clip.id, [
      { id: "a", time: 0, value: IDENTITY_TRANSFORM },
      { id: "b", time: 220, value: { ...IDENTITY_TRANSFORM, scale: 2 } },
    ]);

    const { args } = plan(project);
    const graph = filterGraph(args);

    assert.match(graph, /concat=n=240:v=1:a=0\[/);
    // The bug this fix targets: the old per-slice-input version pushed 2 fresh `-i` per slice (source +
    // bg), i.e. 480 for this fixture alone, plus 1 more for audio — 481 total. The fix keeps this fixed
    // at 3 (source + bg + audio) regardless of slice count.
    const totalInputCount = args.filter((a) => a === "-i").length;
    assert.equal(totalInputCount, 3);
  });
});

describe("buildExportPlan with clip effects", () => {
  it("keeps the untransformed scale+pad chain byte-for-byte identical when effects are absent too (regression)", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /scale=1080:1920:force_original_aspect_ratio=decrease/);
    assert.ok(!graph.includes("eq="), "an effects-less clip must not go through the eq chain");
    assert.ok(!graph.includes("rotate="), "an effects-less clip must not go through the full transform chain");
  });

  it("an explicit identity effects object takes the same untransformed path as no effects at all", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setClipEffects(project, clip.id, IDENTITY_EFFECTS);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /scale=1080:1920:force_original_aspect_ratio=decrease/);
    assert.ok(!graph.includes("eq="));
  });

  it("an effects-only clip (no real transform) still routes through the full chain, with neutral geometry", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setClipEffects(project, clip.id, { brightness: 0.2, contrast: 1.3, saturation: 0.5, blur: 0, opacity: 1 });

    const graph = filterGraph(plan(project).args);

    // Not a literal `eq=brightness=...` — `eq` is GPL-only, so brightness/contrast/saturation are
    // reproduced via `lutyuv` instead (see `buildTransformFilters`'s own comment on the exact
    // per-plane formula this mirrors). contrast=1.3 is the `y=` multiplier, brightness=0.2*255=51 is
    // its additive offset, saturation=0.5 is the `u=`/`v=` multiplier.
    assert.match(
      graph,
      /lutyuv=y='clip\(\(val-127\.5\)\*1\.300000\+127\.5\+51\.000000,0,255\)':u='clip\(\(val-127\.5\)\*0\.500000\+127\.5,0,255\)':v='clip\(\(val-127\.5\)\*0\.500000\+127\.5,0,255\)'/
    );
    // Neutral (untouched) geometry — scale multiplier of 1, offset of 0 — since only effects were set.
    assert.match(graph, /scale=w='iw\*min\(1080\/iw,1920\/ih\)\*1\.000000'/);
    assert.match(graph, /overlay=x='\(W-w\)\/2\+0\.000000':y='\(H-h\)\/2\+0\.000000':format=auto/);
  });

  it("omits gblur when blur is 0, includes it with the right sigma when it isn't", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    const withoutBlur = setClipEffects(project, clip.id, { ...IDENTITY_EFFECTS, opacity: 0.9 });
    const graphWithoutBlur = filterGraph(plan(withoutBlur).args);
    assert.ok(!graphWithoutBlur.includes("gblur="), "blur=0 should not emit a gblur filter");

    const withBlur = setClipEffects(project, clip.id, { ...IDENTITY_EFFECTS, blur: 6 });
    const graphWithBlur = filterGraph(plan(withBlur).args);
    assert.match(graphWithBlur, /gblur=sigma=6\.000000/);
  });

  it("omits colorchannelmixer when opacity is 1, includes it with the right alpha when it isn't", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));

    const opaque = setClipEffects(project, clip.id, { ...IDENTITY_EFFECTS, blur: 2 });
    const graphOpaque = filterGraph(plan(opaque).args);
    assert.ok(!graphOpaque.includes("colorchannelmixer="), "opacity=1 should not emit a colorchannelmixer filter");

    const translucent = setClipEffects(project, clip.id, { ...IDENTITY_EFFECTS, opacity: 0.4 });
    const graphTranslucent = filterGraph(plan(translucent).args);
    assert.match(graphTranslucent, /colorchannelmixer=aa=0\.400000/);
  });

  it("combines with a real transform in one chain", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setClipTransform(project, clip.id, { ...IDENTITY_TRANSFORM, rotationDeg: 20 });
    project = setClipEffects(project, clip.id, { ...IDENTITY_EFFECTS, saturation: 0 });

    const graph = filterGraph(plan(project).args);

    // See the earlier "effects-only clip" test for why this is `lutyuv`, not `eq`. Identity
    // brightness/contrast (0/1) with saturation zeroed out.
    assert.match(
      graph,
      /lutyuv=y='clip\(\(val-127\.5\)\*1\.000000\+127\.5\+0\.000000,0,255\)':u='clip\(\(val-127\.5\)\*0\.000000\+127\.5,0,255\)':v='clip\(\(val-127\.5\)\*0\.000000\+127\.5,0,255\)'/
    );
    assert.match(graph, /rotate=a=20\.000000\*PI\/180/);
  });
});

describe("buildExportPlan with clip color grading", () => {
  it("keeps the untransformed scale+pad chain byte-for-byte identical when color grading is absent too (regression)", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);

    const graph = filterGraph(plan(project).args);

    assert.ok(!graph.includes("curves="), "a color-grading-less clip must not go through the curves chain");
    assert.ok(!graph.includes("rotate="), "a color-grading-less clip must not go through the full transform chain");
  });

  it("an explicit identity color grading object takes the same untransformed path as none at all", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setClipColorGrading(project, clip.id, IDENTITY_COLOR_GRADING);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /scale=1080:1920:force_original_aspect_ratio=decrease/);
    assert.ok(!graph.includes("curves="));
  });

  it("a color-grading-only clip (no real transform/effects) still routes through the full chain", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setClipColorGrading(project, clip.id, {
      ...IDENTITY_COLOR_GRADING,
      master: [{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }],
    });

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /curves=interp=natural:master='0\.000000\/0\.000000 0\.500000\/0\.600000 1\.000000\/1\.000000'/);
    // Positioned right after the (unconditional) eq/lutyuv fragment, before scale — mirrors
    // `PlaybackEngine.ts`'s own post-chroma-key/pre-geometry placement of its curves LUT pass.
    const eqIndex = graph.indexOf("lutyuv=");
    const curvesIndex = graph.indexOf("curves=");
    const scaleIndex = graph.indexOf("scale=w=");
    assert.ok(eqIndex >= 0 && curvesIndex > eqIndex && scaleIndex > curvesIndex);
  });

  it("only emits master=, never all=", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setClipColorGrading(project, clip.id, { ...IDENTITY_COLOR_GRADING, master: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }] });

    const graph = filterGraph(plan(project).args);

    assert.ok(graph.includes("master="));
    assert.ok(!graph.includes("all="));
  });
});

describe("buildExportPlan with a muted clip", () => {
  it("substitutes silence for a muted main-track clip even though the asset has audio", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setClipMuted(project, clip.id, true);

    const { args } = plan(project);

    assert.ok(args.some((a) => a.startsWith("anullsrc")), "a muted clip needs a generated silent pad");
    assert.ok(!filterGraph(args).includes("aresample=48000"), "the real audio stream must not be pulled in");
  });

  it("excludes a muted audio-track clip from the overlay mix", () => {
    const base = emptyProject([videoAsset("asset1", 10), audioAsset()]);
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, audioTrackId(project), "music", 2);
    const [musicClip] = clipsOf(project, audioTrackId(project));
    project = setClipMuted(project, musicClip.id, true);

    assert.ok(!filterGraph(plan(project).args).includes("amix"), "a muted overlay clip should not be mixed in");
  });

  it("a muted clip's video transform is unaffected — muting only touches audio", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setClipMuted(project, clip.id, true);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /scale=1080:1920:force_original_aspect_ratio=decrease/);
  });
});

describe("buildExportPlan with clip gain", () => {
  it("an untouched clip's audio chain has no volume filter at all", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);

    const graph = filterGraph(plan(project).args);

    assert.ok(!graph.includes("volume="), "an unadjusted clip should generate byte-identical output to before this feature");
  });

  it("a main-track clip's real gain value appears in its own audio filter chain", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setClipGain(project, clip.id, 0.5);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,volume=0\.500000/);
  });

  it("an audio-track overlay clip's gain appears in its own filter chain", () => {
    const base = emptyProject([videoAsset("asset1", 10), audioAsset()]);
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, audioTrackId(project), "music", 2);
    const [musicClip] = clipsOf(project, audioTrackId(project));
    project = setClipGain(project, musicClip.id, 0.25);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,volume=0\.250000/);
  });

  it("muting still wins over gain — a muted-and-gained clip still gets silence, not a scaled real stream", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    const [clip] = clipsOf(project, videoTrackId(project));
    project = setClipGain(project, clip.id, 0.8);
    project = setClipMuted(project, clip.id, true);

    const { args } = plan(project);

    assert.ok(args.some((a) => a.startsWith("anullsrc")), "muted still substitutes silence regardless of gain");
    assert.ok(!filterGraph(args).includes("volume="), "no volume filter is meaningful against a silent pad");
  });
});

describe("buildExportPlan with track/master gain", () => {
  it("multiplies an audio-track clip's own gain by its track's gain", () => {
    const base = emptyProject([videoAsset("asset1", 10), audioAsset()]);
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, audioTrackId(project), "music", 2);
    const [musicClip] = clipsOf(project, audioTrackId(project));
    project = setClipGain(project, musicClip.id, 2);
    project = setTrackGain(project, audioTrackId(project), 1.5);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /volume=3\.000000/);
  });

  it("an audio track with no gain set contributes no extra multiplier — a bare clip gain passes through unchanged", () => {
    const base = emptyProject([videoAsset("asset1", 10), audioAsset()]);
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, audioTrackId(project), "music", 2);
    const [musicClip] = clipsOf(project, audioTrackId(project));
    project = setClipGain(project, musicClip.id, 0.25);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /volume=0\.250000/);
  });

  it("applies a final master volume= stage after the last amix, only when masterGain isn't 1", () => {
    const base = emptyProject([videoAsset("asset1", 10), audioAsset()]);
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, audioTrackId(project), "music", 2);
    project = setMasterGain(project, 1.5);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /amix=inputs=\d+:normalize=0:dropout_transition=0\[mixa\];\[mixa\]volume=1\.500000\[mastered\]/);
    assert.ok(plan(project).args.includes("[mastered]"), "the final -map should point at the mastered output");
  });

  it("omits the master volume= stage entirely when masterGain is left at 1", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);

    const graph = filterGraph(plan(project).args);

    assert.ok(!graph.includes("[mastered]"), "an unadjusted master level should generate byte-identical output to before this feature");
  });
});

describe("buildExportPlan with text clips", () => {
  it("chains a drawtext filter onto the video output for an active text clip", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Hello")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 2);
    const [textClip] = clipsOf(project, textTrackId(project));

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /\[cv0\]drawtext=/, "drawtext should chain directly off the concatenated video output");
    assert.match(graph, /fontfile='\/fonts\/Lato-Regular\.ttf'/);
    // Path comes from `textFilePathFor`'s CLIP id, not the asset id — several clips could place the
    // same text asset at different points, each needing its own file.
    assert.ok(graph.includes(`textfile='/tmp/${textClip.id}.txt'`));
    assert.match(graph, /fontcolor=0xffffff/);
    assert.ok(graph.includes(`enable='between(t\\,${textClip.timelineStart.toFixed(6)}\\,`));
  });

  it("uses the bold+italic font file for bold+italic style", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Hello")]);
    base = addTrack(base, "text");
    base = setTextAsset(base, "text1", "Hello", { ...DEFAULT_TEXT_STYLE, bold: true, italic: true });
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /fontfile='\/fonts\/Lato-BoldItalic\.ttf'/);
  });

  it("uses the selected font's own file, not lato's, when fontFamily is set to a Khmer font", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "សួស្តី")]);
    base = addTrack(base, "text");
    base = setTextAsset(base, "text1", "សួស្តី", { ...DEFAULT_TEXT_STYLE, fontFamily: "battambang" });
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /fontfile='\/fonts\/Battambang-Regular\.ttf'/);
  });

  it("falls back to the regular file when bold+italic is requested but the font has no italic face", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Bold Khmer")]);
    base = addTrack(base, "text");
    base = setTextAsset(base, "text1", "Bold Khmer", { ...DEFAULT_TEXT_STYLE, fontFamily: "battambang", bold: true, italic: true });
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);

    const graph = filterGraph(plan(project).args);

    // battambang has no boldItalic file — resolveFontVariant prefers its bold file over faking italic.
    assert.match(graph, /fontfile='\/fonts\/Battambang-Bold\.ttf'/);
  });

  it("a single-weight display font (moul) always uses its one file regardless of bold/italic", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Display")]);
    base = addTrack(base, "text");
    base = setTextAsset(base, "text1", "Display", { ...DEFAULT_TEXT_STYLE, fontFamily: "moul", bold: true, italic: true });
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /fontfile='\/fonts\/Moul-Regular\.ttf'/);
  });

  it("a rotated clip also resolves its font file through the same registry", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Spin")]);
    base = addTrack(base, "text");
    base = setTextAsset(base, "text1", "Spin", { ...DEFAULT_TEXT_STYLE, fontFamily: "battambang", bold: true, rotationDeg: 30 });
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /fontfile='\/fonts\/Battambang-Bold\.ttf'/);
  });

  it("adds a background box only when backgroundColor is set", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Caption")]);
    base = addTrack(base, "text");
    base = setTextAsset(base, "text1", "Caption", { ...DEFAULT_TEXT_STYLE, backgroundColor: "#112233" });
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /box=1:boxcolor=0x112233:boxborderw=/);
  });

  it("adds an outline (bordercolor/borderw) only when strokeColor is set", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Caption")]);
    base = addTrack(base, "text");
    base = setTextAsset(base, "text1", "Caption", { ...DEFAULT_TEXT_STYLE, strokeColor: "#ff00ff", strokeWidth: 6 });
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /bordercolor=0xff00ff:borderw=6\.000000/);
  });

  it("adds a shadow (shadowcolor/shadowx/shadowy) only when shadowColor is set", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Caption")]);
    base = addTrack(base, "text");
    base = setTextAsset(base, "text1", "Caption", {
      ...DEFAULT_TEXT_STYLE,
      shadowColor: "#123456",
      shadowOffsetX: 4,
      shadowOffsetY: -2,
    });
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /shadowcolor=0x123456:shadowx=4\.000000:shadowy=-2\.000000/);
  });

  it("has no outline/shadow params when strokeColor/shadowColor are unset", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Caption")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);

    const graph = filterGraph(plan(project).args);

    assert.ok(!graph.includes("bordercolor="));
    assert.ok(!graph.includes("shadowcolor="));
  });

  it("converts lineHeightMultiplier to FFmpeg's extra-pixels line_spacing convention", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Two\nLines")]);
    base = addTrack(base, "text");
    base = setTextAsset(base, "text1", "Two\nLines", { ...DEFAULT_TEXT_STYLE, fontSize: 100, lineHeightMultiplier: 1.5 });
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);

    const graph = filterGraph(plan(project).args);

    // fontSize * (lineHeightMultiplier - 1) = 100 * 0.5 = 50
    assert.match(graph, /line_spacing=50\.000000/);
  });

  it("outline and shadow both work on a rotated text clip's filter chain too", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Spin")]);
    base = addTrack(base, "text");
    base = setTextAsset(base, "text1", "Spin", {
      ...DEFAULT_TEXT_STYLE,
      rotationDeg: 20,
      strokeColor: "#000000",
      strokeWidth: 4,
      shadowColor: "#ffffff",
      shadowOffsetX: 1,
      shadowOffsetY: 1,
    });
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /bordercolor=0x000000:borderw=4\.000000/);
    assert.match(graph, /shadowcolor=0xffffff:shadowx=1\.000000:shadowy=1\.000000/);
  });

  it("skips a hidden text track's clips entirely", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Hidden")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    project = setTrackFlag(project, textTrackId(project), "visible", false);

    const graph = filterGraph(plan(project).args);

    assert.ok(!graph.includes("drawtext="), "a hidden text track must not reach the filter graph at all");
    assert.equal(plan(project).args[plan(project).args.indexOf("-map") + 1], "[cv0]");
  });

  it("chains multiple text clips in track order, and maps the LAST one as the final video output", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "First"), textAsset("text2", "Second")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    project = addClip(project, textTrackId(project), "text2", 6);

    const { args } = plan(project);
    const graph = filterGraph(args);

    const drawtextCount = (graph.match(/drawtext=/g) ?? []).length;
    assert.equal(drawtextCount, 2);
    assert.match(graph, /\[cv0\]drawtext=.*\[txt0\]/);
    assert.match(graph, /\[txt0\]drawtext=.*\[txt1\]/);
    assert.equal(args[args.indexOf("-map") + 1], "[txt1]");
  });

  it("a project with no text clips maps [cv0] directly, unaffected by text support existing", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);

    const { args } = plan(project);

    assert.equal(args[args.indexOf("-map") + 1], "[cv0]");
    assert.ok(!filterGraph(args).includes("drawtext="));
  });

  it("an unrotated text clip (rotationDeg: 0) still uses the plain drawtext-onto-[cv0] chain", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Hello")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /\[cv0\]drawtext=/);
    assert.ok(!graph.includes("rotate="), "an unrotated clip should never reach the rotate pipeline");
  });

  it("a rotated text clip builds a background+drawtext+rotate+overlay chain instead of a plain drawtext", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Spin")]);
    base = addTrack(base, "text");
    base = setTextAsset(base, "text1", "Spin", { ...DEFAULT_TEXT_STYLE, rotationDeg: 45 });
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 2);
    const [textClip] = clipsOf(project, textTrackId(project));

    const { args } = plan(project);
    const graph = filterGraph(args);

    // A fresh full-sequence-duration transparent lavfi input to draw and rotate the text onto. The
    // trailing `,format=rgba` is load-bearing (see `buildExportPlan.ts`'s own comment on this input) —
    // without it FFmpeg's `color` lavfi source silently drops the `@0` alpha at the source.
    assert.ok(args.includes("color=c=black@0:s=1080x1920:r=30,format=rgba"));
    assert.match(graph, /drawtext=.*\[txt0_drawn\]/);
    assert.match(graph, /\[txt0_drawn\]format=rgba,rotate=a=45\.000000\*PI\/180:ow=rotw\(45\.000000\*PI\/180\):oh=roth\(45\.000000\*PI\/180\):c=black@0\[txt0_rot\]/);
    assert.match(graph, /\[cv0\]\[txt0_rot\]overlay=x='\(W-w\)\/2\+0\.000000':y='\(H-h\)\/2\+0\.000000':format=auto:enable='between\(t\\,/);
    assert.equal(args[args.indexOf("-map") + 1], "[txt0]");
    assert.ok(graph.includes(`enable='between(t\\,${textClip.timelineStart.toFixed(6)}\\,`));
  });

  it("a rotated text clip's overlay offset reflects offsetX/offsetY, applied AFTER rotation", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Spin")]);
    base = addTrack(base, "text");
    base = setTextAsset(base, "text1", "Spin", { ...DEFAULT_TEXT_STYLE, rotationDeg: 90, offsetX: 50, offsetY: -30 });
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /overlay=x='\(W-w\)\/2\+50\.000000':y='\(H-h\)\/2\+-30\.000000'/);
  });

  it("mixes a rotated and an unrotated text clip, chaining both onto the growing video output", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Plain"), textAsset("text2", "Spun")]);
    base = addTrack(base, "text");
    base = setTextAsset(base, "text2", "Spun", { ...DEFAULT_TEXT_STYLE, rotationDeg: 10 });
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    project = addClip(project, textTrackId(project), "text2", 6);

    const { args } = plan(project);
    const graph = filterGraph(args);

    assert.match(graph, /\[cv0\]drawtext=.*\[txt0\]/);
    assert.match(graph, /\[txt0\]\[txt1_rot\]overlay=/);
    assert.equal(args[args.indexOf("-map") + 1], "[txt1]");
  });
});

describe("buildExportPlan with text animations", () => {
  it("bounce adds a time-varying -abs(sin(...)) term onto the plain y expression", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Hop")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 2);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextAnimation(project, textClip.id, { type: "bounce" });

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /\[cv0\]drawtext=/, "bounce stays on the plain (non-rotated) drawtext path");
    assert.match(
      graph,
      /y=\(h\/2\)\+0\.000000-text_h\/2-abs\(sin\(2\*PI\*\(\(t-2\.000000\)\*1\.000000\)\/0\.900000\)\)\*14\.000000/
    );
  });

  it("bounce's speed multiplier scales the elapsed-time term, not the amplitude or period", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Hop")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextAnimation(project, textClip.id, { type: "bounce", speed: 2 });

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /\(\(t-0\.000000\)\*2\.000000\)\/0\.900000/);
  });

  it("pulse renders fontsize as a quoted sin(...)-modulated expression instead of a plain number", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Grow")]);
    base = addTrack(base, "text");
    base = setTextAsset(base, "text1", "Grow", { ...DEFAULT_TEXT_STYLE, fontSize: 64 });
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextAnimation(project, textClip.id, { type: "pulse" });

    const graph = filterGraph(plan(project).args);

    assert.match(
      graph,
      /fontsize='64\.000000\*\(1\+sin\(2\*PI\*\(\(t-0\.000000\)\*1\.000000\)\/1\.100000\)\*0\.080000\)'/
    );
    // x/y stay the plain, unmodified expressions — `text_w`/`text_h` already re-track the animated size
    // every frame on their own (see this feature's own empirical FFmpeg verification notes).
    assert.match(graph, /y=\(h\/2\)\+0\.000000-text_h\/2:/);
  });

  it("a static rotationDeg combined with bounce or pulse renders as plain static rotated text, animation ignored", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Spin")]);
    base = addTrack(base, "text");
    base = setTextAsset(base, "text1", "Spin", { ...DEFAULT_TEXT_STYLE, rotationDeg: 20 });
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextAnimation(project, textClip.id, { type: "pulse" });

    const graph = filterGraph(plan(project).args);

    assert.ok(!graph.includes("sin("), "a documented scope cut — the rotated path never adds a pulse/bounce term");
    assert.match(graph, /rotate=a=20\.000000\*PI\/180:ow=rotw\(20\.000000\*PI\/180\):oh=roth\(20\.000000\*PI\/180\)/);
  });

  it("wiggle routes even an UNrotated clip through the rotate pipeline, angle animating with a fixed buffer size", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Shake")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextAnimation(project, textClip.id, { type: "wiggle" });

    const graph = filterGraph(plan(project).args);

    assert.match(
      graph,
      /rotate=a=\(0\.000000\+sin\(2\*PI\*\(\(t-0\.000000\)\*1\.000000\)\/1\.300000\)\*6\.000000\)\*PI\/180:ow=rotw\(6\.000000\*PI\/180\):oh=roth\(6\.000000\*PI\/180\)/
    );
  });

  it("wiggle combined with a static rotationDeg offsets the animated angle and sizes the buffer for the worst case", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Shake")]);
    base = addTrack(base, "text");
    base = setTextAsset(base, "text1", "Shake", { ...DEFAULT_TEXT_STYLE, rotationDeg: 20 });
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextAnimation(project, textClip.id, { type: "wiggle" });

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /rotate=a=\(20\.000000\+sin\(/);
    // 20 (static) + 6 (wiggle's own amplitude) — the fixed worst-case bound `ow`/`oh` need up front.
    assert.match(graph, /ow=rotw\(26\.000000\*PI\/180\):oh=roth\(26\.000000\*PI\/180\)/);
  });

  it("typewriter chains one drawtext per revealed-prefix step, each with its own text file and enable window", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Hi!")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextAnimation(project, textClip.id, { type: "typewriter" });

    const { args } = plan(project);
    const graph = filterGraph(args);

    // "Hi!" is 3 characters — 3 chained drawtext calls, the first two writing into intermediate labels,
    // the last one writing into the SAME `txt0` label every other text clip's final call would use.
    const drawtextCount = (graph.match(/drawtext=/g) ?? []).length;
    assert.equal(drawtextCount, 3);
    assert.ok(graph.includes(`textfile='/tmp/${textClip.id}-tw1.txt'`));
    assert.ok(graph.includes(`textfile='/tmp/${textClip.id}-tw2.txt'`));
    assert.ok(graph.includes(`textfile='/tmp/${textClip.id}-tw3.txt'`));
    assert.match(graph, /\[cv0\]drawtext=.*\[txt0_tw1\]/);
    assert.match(graph, /\[txt0_tw1\]drawtext=.*\[txt0_tw2\]/);
    assert.match(graph, /\[txt0_tw2\]drawtext=.*\[txt0\]/);
    // Step k's own window is exactly one character-duration wide (1 / 18 chars-per-second here); the
    // FINAL step's window instead extends to the clip's own end, not just one more character-width.
    assert.ok(graph.includes(`enable='between(t\\,0.000000\\,0.055556)'`));
    assert.ok(graph.includes(`enable='between(t\\,0.055556\\,0.111111)'`));
    assert.equal(args[args.indexOf("-map") + 1], "[txt0]");
  });

  it("typewriter's speed multiplier shortens each character's reveal window", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Hi")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextAnimation(project, textClip.id, { type: "typewriter", speed: 2 });

    const graph = filterGraph(plan(project).args);

    // 18 chars/sec * 2 speed = 36 chars/sec → each step is 1/36s wide instead of 1/18s.
    assert.ok(graph.includes(`enable='between(t\\,0.000000\\,0.027778)'`));
  });

  it("a rotated clip with typewriter renders as plain static full text, animation ignored (same documented scope cut)", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Spin")]);
    base = addTrack(base, "text");
    base = setTextAsset(base, "text1", "Spin", { ...DEFAULT_TEXT_STYLE, rotationDeg: 15 });
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextAnimation(project, textClip.id, { type: "typewriter" });

    const { args } = plan(project);
    const graph = filterGraph(args);

    const drawtextCount = (graph.match(/drawtext=/g) ?? []).length;
    assert.equal(drawtextCount, 1, "no per-character chain — a single static drawtext, same as a plain rotated clip");
    assert.ok(graph.includes(`textfile='/tmp/${textClip.id}.txt'`));
  });

  it("wordHighlight without ASS capability options supplied falls back to plain static full text", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "One Two Three")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextAnimation(project, textClip.id, { type: "wordHighlight", highlightColor: "#ff00ff" });

    // The shared `options` fixture at the top of this file omits `assFilePathFor`/`fontMetricsFor`/
    // `fontsDirFor` — same as a caller (e.g. a not-yet-updated mobile export) that hasn't wired up ASS
    // support at all.
    const graph = filterGraph(plan(project).args);

    const drawtextCount = (graph.match(/drawtext=/g) ?? []).length;
    assert.equal(drawtextCount, 1);
    assert.ok(!graph.includes("#ff00ff".slice(1)), "the highlight color never reaches the filter graph");
  });
});

describe("buildExportPlan with text crop", () => {
  it("a crop-less clip's filter graph is byte-for-byte identical to before this feature (regression)", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Hello")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 2);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /\[cv0\]drawtext=/, "still the plain onto-[cv0] chain, no isolate/crop/pad stage");
    assert.ok(!graph.includes("_iso"), "no isolated buffer for a crop-less clip");
    assert.ok(!graph.includes("crop="));
    assert.ok(!graph.includes("_padded"));
  });

  it("an explicit identity crop takes the same untransformed path as no crop at all", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Hello")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextCrop(project, textClip.id, { top: 0, right: 0, bottom: 0, left: 0 });

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /\[cv0\]drawtext=/);
    assert.ok(!graph.includes("crop="));
  });

  it("a cropped plain-text clip gets an isolated buffer, crop/pad fragment, and overlay onto [cv0]", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Hello")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextCrop(project, textClip.id, { top: 0.1, right: 0.2, bottom: 0.3, left: 0.4 });

    const { args } = plan(project);
    const graph = filterGraph(args);

    // The isolated full-frame transparent buffer text draws onto instead of [cv0].
    assert.ok(args.includes("color=c=black@0:s=1080x1920:r=30,format=rgba"));
    assert.match(graph, /drawtext=.*\[txt0_iso\]/, "drawtext should chain onto the isolated buffer, not [cv0]");
    assert.ok(!graph.includes("[cv0]drawtext="), "must NOT draw directly onto the shared video stream when cropped");

    // 1080 * 0.4 = 432 (left), 1920 * 0.1 = 192 (top), 1080 * (1-0.4-0.2) = 432 (w), 1920 * (1-0.1-0.3) = 1152 (h).
    assert.match(
      graph,
      /\[txt0_iso\]crop=w=432\.000000:h=1152\.000000:x=432\.000000:y=192\.000000,format=rgba,pad=w=1080\.000000:h=1920\.000000:x=432\.000000:y=192\.000000:color=black@0\[txt0_padded\]/
    );
    assert.match(graph, /\[cv0\]\[txt0_padded\]overlay=format=auto:enable='between\(t\\,0\.000000\\,/);
    assert.equal(args[args.indexOf("-map") + 1], "[txt0]");
  });

  it("a cropped bounce clip keeps its own expression term unchanged, redirected onto the isolated input", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Hop")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 2);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextAnimation(project, textClip.id, { type: "bounce" });
    project = setClipTextCrop(project, textClip.id, { top: 0, right: 0, bottom: 0.5, left: 0 });

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /drawtext=.*\[txt0_iso\]/, "bounce redirected onto the isolated input");
    assert.ok(!graph.includes("[cv0]drawtext="));
    // Same expression this exact case already asserts in the "bounce adds a time-varying..." test above
    // — confirms the animation math itself is untouched by the crop redirect.
    assert.match(
      graph,
      /y=\(h\/2\)\+0\.000000-text_h\/2-abs\(sin\(2\*PI\*\(\(t-2\.000000\)\*1\.000000\)\/0\.900000\)\)\*14\.000000/
    );
    assert.match(graph, /crop=w=.*\[txt0_padded\]/);
  });

  it("a cropped rotated clip keeps its own pre-rotation bgIndex input, plus a SEPARATE isolated input for the crop redirect", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Spin")]);
    base = addTrack(base, "text");
    base = setTextAsset(base, "text1", "Spin", { ...DEFAULT_TEXT_STYLE, rotationDeg: 45 });
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextCrop(project, textClip.id, { top: 0.2, right: 0, bottom: 0, left: 0 });

    const { args } = plan(project);
    const graph = filterGraph(args);

    // Two SEPARATE full-frame transparent lavfi inputs — one for the rotation path's own pre-rotation
    // canvas (unchanged), one for the crop-isolation redirect.
    const isolatedInputCount = args.filter((a) => a === "color=c=black@0:s=1080x1920:r=30,format=rgba").length;
    assert.equal(isolatedInputCount, 2);
    assert.match(graph, /drawtext=.*\[txt0_iso_drawn\]/);
    assert.match(graph, /rotate=a=45\.000000\*PI\/180.*\[txt0_iso\]/, "the rotated path's own final overlay targets the isolated buffer, not [cv0]");
    assert.match(graph, /\[txt0_iso\]crop=/, "crop/pad picks up the ALREADY frame-sized rotated-path result");
    assert.match(graph, /\[cv0\]\[txt0_padded\]overlay=format=auto:enable=/);
  });

  it("fade in/out still applies inside the isolate stage when combined with crop", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Fading")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTransitionIn(project, textClip.id, { duration: 0.5, type: "crossfade" });
    project = setClipTextCrop(project, textClip.id, { top: 0.1, right: 0, bottom: 0, left: 0 });

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /drawtext=.*alpha='min\(1\\,\(t-0\.000000\)\/0\.500000\)'.*\[txt0_iso\]/);
    assert.match(graph, /\[cv0\]\[txt0_padded\]overlay=format=auto:enable='between\(t\\,0\.000000\\,/);
  });
});

describe("buildExportPlan with keyframed text style", () => {
  it("a non-keyframed clip's filter graph is byte-for-byte unchanged, no _kf labels or concat= at all (regression)", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Hello")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /\[cv0\]drawtext=/);
    assert.ok(!graph.includes("_kf"), "no per-slice labels for a non-keyframed clip");
  });

  it("slices into the expected number of chained drawtext calls for a known keyframe gap", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Hello")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    let [textClip] = clipsOf(project, textTrackId(project));
    // Trim to exactly 1 second so the keyframe pair spans the clip's ENTIRE duration (no extra tail
    // segment past the last keyframe to also subdivide) -- one 1s gap -> ceil(1/0.15) = 7 slices.
    project = trimClip(project, textClip.id, "out", 1);
    [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextStyleKeyframes(project, textClip.id, [
      { id: "kf1", time: 0, value: { ...DEFAULT_TEXT_STYLE, offsetX: -100 } },
      { id: "kf2", time: 1, value: { ...DEFAULT_TEXT_STYLE, offsetX: 100 } },
    ]);

    const graph = filterGraph(plan(project).args);

    assert.equal((graph.match(/drawtext=/g) ?? []).length, 7);
  });

  it("two slices produce genuinely different x= literals, proving real interpolation reached the filter string", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Hello")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextStyleKeyframes(project, textClip.id, [
      { id: "kf1", time: 0, value: { ...DEFAULT_TEXT_STYLE, offsetX: -100 } },
      { id: "kf2", time: 1, value: { ...DEFAULT_TEXT_STYLE, offsetX: 100 } },
    ]);

    const graph = filterGraph(plan(project).args);
    const xLiterals = [...graph.matchAll(/x=\(\(w\/2\)\+(-?\d+\.\d+)\)-text_w\/2/g)].map((m) => m[1]);

    assert.ok(xLiterals.length >= 2, "expected multiple slices, each with their own x= literal");
    assert.notEqual(xLiterals[0], xLiterals[xLiterals.length - 1], "first and last slice must resolve to different offsetX values");
    // First slice should be close to the start keyframe's value, last close to the end keyframe's.
    assert.ok(Number(xLiterals[0]) < 0, `first slice's offsetX should still be negative, got ${xLiterals[0]}`);
    assert.ok(Number(xLiterals[xLiterals.length - 1]) > 0, `last slice's offsetX should be positive, got ${xLiterals[xLiterals.length - 1]}`);
  });

  it("bounce's own expression term is unchanged and present in every slice", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Hop")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 2);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextAnimation(project, textClip.id, { type: "bounce" });
    project = setClipTextStyleKeyframes(project, textClip.id, [
      { id: "kf1", time: 0, value: { ...DEFAULT_TEXT_STYLE, offsetX: -50 } },
      { id: "kf2", time: 1, value: { ...DEFAULT_TEXT_STYLE, offsetX: 50 } },
    ]);

    const graph = filterGraph(plan(project).args);
    const drawtextCount = (graph.match(/drawtext=/g) ?? []).length;
    const bounceCount = (graph.match(/-abs\(sin\(2\*PI\*\(\(t-2\.000000\)\*1\.000000\)\/0\.900000\)\)\*14\.000000/g) ?? []).length;

    assert.ok(drawtextCount > 1, "should be sliced into multiple chained calls");
    assert.equal(bounceCount, drawtextCount, "the bounce term must appear in every single slice, unchanged");
  });

  it("composes with textCrop: crop/pad/overlay wraps the whole chained result once, not per slice", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Hello")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextStyleKeyframes(project, textClip.id, [
      { id: "kf1", time: 0, value: { ...DEFAULT_TEXT_STYLE, offsetX: -100 } },
      { id: "kf2", time: 1, value: { ...DEFAULT_TEXT_STYLE, offsetX: 100 } },
    ]);
    project = setClipTextCrop(project, textClip.id, { top: 0, right: 0, bottom: 0.5, left: 0 });

    const graph = filterGraph(plan(project).args);

    assert.ok((graph.match(/drawtext=/g) ?? []).length > 1, "still sliced");
    assert.match(graph, /\[txt0_iso\]drawtext=|drawtext=.*\[txt0_iso\]/, "first slice targets the isolated buffer");
    assert.equal((graph.match(/crop=w=/g) ?? []).length, 1, "crop applied exactly ONCE, around the whole chained result");
    assert.equal((graph.match(/\[cv0\]\[txt0_padded\]overlay=/g) ?? []).length, 1);
  });

  it("wordHighlight wins over textStyleKeyframes when both are set on the same clip", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "One Two Three")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextAnimation(project, textClip.id, { type: "wordHighlight" });
    project = setClipTextStyleKeyframes(project, textClip.id, [
      { id: "kf1", time: 0, value: { ...DEFAULT_TEXT_STYLE, offsetX: -100 } },
      { id: "kf2", time: 1, value: { ...DEFAULT_TEXT_STYLE, offsetX: 100 } },
    ]);

    // Supply the full ASS capability (same fixture shape as the "wordHighlight with ASS/libass
    // capability" describe block below) so `wordHighlightFilter` genuinely resolves to a real
    // `subtitles=` filter, not the plain-text fallback — this is what actually exercises the priority
    // decision, not just the absence of both mechanisms.
    const { args } = buildExportPlan(project, {
      ...options,
      assFilePathFor: (clip, assContent) => {
        void assContent;
        return `/tmp/${clip.id}.ass`;
      },
      fontMetricsFor: () => ({ family: "TestFamily", fontsizeScale: 1.5 }),
      fontsDirFor: () => "/fonts",
    });
    const graph = filterGraph(args);

    assert.ok(!graph.includes("_kf"), "textStyleKeyframes must not be reachable when wordHighlight is set");
    assert.ok(!graph.includes("drawtext="), "must route through subtitles=, never drawtext=");
    assert.match(graph, /subtitles=/);
  });

  it("textStyleKeyframes wins over typewriter when both are set on the same clip", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Hi")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextAnimation(project, textClip.id, { type: "typewriter" });
    project = setClipTextStyleKeyframes(project, textClip.id, [
      { id: "kf1", time: 0, value: { ...DEFAULT_TEXT_STYLE, offsetX: -100 } },
      { id: "kf2", time: 1, value: { ...DEFAULT_TEXT_STYLE, offsetX: 100 } },
    ]);

    const graph = filterGraph(plan(project).args);

    assert.ok(!graph.includes("_tw"), "typewriter's own per-character labels must not appear");
    assert.ok(graph.includes("_kf"), "keyframe-slicing must have taken over instead");
  });

  it("fade in/out applies once, shared across every chained slice, not repeated per boundary", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Fading")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTransitionIn(project, textClip.id, { duration: 0.5, type: "crossfade" });
    project = setClipTextStyleKeyframes(project, textClip.id, [
      { id: "kf1", time: 0, value: { ...DEFAULT_TEXT_STYLE, offsetX: -100 } },
      { id: "kf2", time: 1, value: { ...DEFAULT_TEXT_STYLE, offsetX: 100 } },
    ]);

    const graph = filterGraph(plan(project).args);
    const drawtextCount = (graph.match(/drawtext=/g) ?? []).length;
    const alphaCount = (graph.match(/alpha='min\(1\\,\(t-0\.000000\)\/0\.500000\)'/g) ?? []).length;

    assert.ok(drawtextCount > 1);
    assert.equal(alphaCount, drawtextCount, "the SAME shared alpha ramp is reused verbatim by every slice");
  });

  it("a keyframe pair crossing zero rotation routes the whole clip through the rotated per-slice chain", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Spin")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextStyleKeyframes(project, textClip.id, [
      { id: "kf1", time: 0, value: { ...DEFAULT_TEXT_STYLE, rotationDeg: 0 } },
      { id: "kf2", time: 1, value: { ...DEFAULT_TEXT_STYLE, rotationDeg: 45 } },
    ]);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /rotate=a=/);
    assert.ok(!graph.includes("[cv0]drawtext="), "must never mix the plain and rotated chains within one clip");
    // Every slice's own drawtext->rotate->overlay triple.
    const rotateCount = (graph.match(/rotate=a=/g) ?? []).length;
    const drawtextCount = (graph.match(/drawtext=/g) ?? []).length;
    assert.equal(rotateCount, drawtextCount, "one rotate= per slice, matching the per-slice drawtext count");
  });
});

describe("buildExportPlan wordHighlight with ASS/libass capability", () => {
  // A tiny fake `AssFontMetrics` resolver — real font-byte parsing is `readAssFontMetrics`'s own job
  // (see fonts.test.ts), tested separately; this only needs to exercise buildExportPlan's OWN wiring.
  const fontMetricsFor = () => ({ family: "TestFamily", fontsizeScale: 1.5 });

  function planWithAss(project: Parameters<typeof buildExportPlan>[0], writtenAss: { content?: string } = {}) {
    return buildExportPlan(project, {
      ...options,
      assFilePathFor: (clip, assContent) => {
        writtenAss.content = assContent;
        return `/tmp/${clip.id}.ass`;
      },
      fontMetricsFor,
      fontsDirFor: () => "/fonts",
    });
  }

  it("routes a wordHighlight clip through subtitles= instead of drawtext when all three options are supplied", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "One Two Three")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextAnimation(project, textClip.id, { type: "wordHighlight" });

    const { args } = planWithAss(project);
    const graph = filterGraph(args);

    assert.ok(!graph.includes("drawtext="), "a wordHighlight clip with ASS capability never reaches drawtext");
    assert.match(graph, /\[cv0\]subtitles='\/tmp\/[^']+\.ass':fontsdir='\/fonts'\[txt0\]/);
    assert.equal(args[args.indexOf("-map") + 1], "[txt0]");
  });

  it("generates one Dialogue event per word, timed evenly across the clip's own duration", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "One Two Three")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 2); // starts at t=2s
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextAnimation(project, textClip.id, { type: "wordHighlight" });
    // A freshly-added text clip gets `TEXT_DEFAULT_DURATION` (5s) — 3 words split it into three
    // 5/3-second windows, the last one extending to the clip's own end exactly like every other
    // animation type's final state (see `buildTypewriterDrawTextCalls`'s identical pattern).
    const clip = project.sequence.tracks.find((t) => t.kind === "text")!.clips[0];

    const written: { content?: string } = {};
    planWithAss(project, written);
    const dialogueLines = written.content!.split("\n").filter((l) => l.startsWith("Dialogue:"));
    assert.equal(dialogueLines.length, 3, "one event per word");

    function startEndOf(line: string): [string, string] {
      const parts = line.split(",");
      return [parts[1], parts[2]];
    }
    const [start0, end0] = startEndOf(dialogueLines[0]);
    const [start1, end1] = startEndOf(dialogueLines[1]);
    const [start2, end2] = startEndOf(dialogueLines[2]);

    assert.equal(start0, "0:00:02.00", "first event starts at the clip's own timelineStart");
    assert.equal(end0, start1, "each event's end is exactly the next one's start — no gap, no overlap");
    assert.equal(end1, start2);
    assert.equal(end2, "0:00:" + clipEnd(clip).toFixed(2).padStart(5, "0"), "the LAST event extends to the clip's own end, not just one more word-width");
  });

  it("wraps exactly the active word's run in the highlight color, leaving the others in the base color", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Alpha Beta Gamma")]);
    base = addTrack(base, "text");
    base = setTextAsset(base, "text1", "Alpha Beta Gamma", { ...DEFAULT_TEXT_STYLE, color: "#112233" });
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextAnimation(project, textClip.id, { type: "wordHighlight", highlightColor: "#ff00aa" });

    const written: { content?: string } = {};
    planWithAss(project, written);
    const ass = written.content!;

    const baseAss = "&H00332211"; // "#112233" -> BGR, no trailing "&" (Style-field form)
    const highlightAss = "&H00aa00ff"; // "#ff00aa" -> BGR
    const dialogueLines = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));

    assert.match(dialogueLines[0], new RegExp(`\\{\\\\c${highlightAss}&\\}Alpha \\{\\\\c${baseAss}&\\}Beta \\{\\\\c${baseAss}&\\}Gamma`));
    assert.match(dialogueLines[1], new RegExp(`\\{\\\\c${baseAss}&\\}Alpha \\{\\\\c${highlightAss}&\\}Beta \\{\\\\c${baseAss}&\\}Gamma`));
    assert.match(dialogueLines[2], new RegExp(`\\{\\\\c${baseAss}&\\}Alpha \\{\\\\c${baseAss}&\\}Beta \\{\\\\c${highlightAss}&\\}Gamma`));
    // No color value anywhere carries a doubled "&&" — a real bug caught during this feature's own
    // development (an earlier version of `assColor` baked its OWN trailing "&" into every use,
    // including the `Style:` line, which then got a SECOND "&" appended at the inline-override call
    // site specifically).
    assert.ok(!ass.includes("&&"), "no color value should ever double up its trailing '&'");
  });

  it("defaults to DEFAULT_WORD_HIGHLIGHT_COLOR when the clip has no highlightColor of its own", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Solo")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextAnimation(project, textClip.id, { type: "wordHighlight" });

    const written: { content?: string } = {};
    planWithAss(project, written);

    assert.ok(written.content!.includes(assColorForTest(DEFAULT_WORD_HIGHLIGHT_COLOR)));
  });

  it("falls back to plain drawtext when fontMetricsFor returns null for this clip's font", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "One Two")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextAnimation(project, textClip.id, { type: "wordHighlight" });

    const { args } = buildExportPlan(project, {
      ...options,
      assFilePathFor: (clip, content) => `/tmp/${clip.id}.ass`,
      fontMetricsFor: () => null,
      fontsDirFor: () => "/fonts",
    });
    const graph = filterGraph(args);

    assert.ok(!graph.includes("subtitles="));
    assert.match(graph, /drawtext=/);
  });

  it("skips wordHighlight entirely (falls back to plain text) for a clip with empty content", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextAnimation(project, textClip.id, { type: "wordHighlight" });

    const { args } = planWithAss(project);
    const graph = filterGraph(args);

    assert.ok(!graph.includes("subtitles="));
  });

  it("segments Khmer content into its real words instead of treating the whole line as one word", () => {
    // "សួស្តី" (hello) + "អ្នករាល់គ្នា" (everyone) — no space between them, exactly how Khmer is
    // actually written. A plain whitespace split would produce ONE Dialogue event covering the whole
    // phrase; `segmentLine` (see `timeline/textAnimation.ts`) correctly finds the real word boundary.
    let base = emptyProject([videoAsset(), textAsset("text1", "សួស្តីអ្នករាល់គ្នា")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextAnimation(project, textClip.id, { type: "wordHighlight" });

    const written: { content?: string } = {};
    planWithAss(project, written);
    const dialogueLines = written.content!.split("\n").filter((l) => l.startsWith("Dialogue:"));

    assert.equal(dialogueLines.length, 2, "two real Khmer words, so two Dialogue events");
    assert.match(
      dialogueLines[0],
      /\{\\c&H[0-9a-f]+&\}សួស្តី\{\\c&H[0-9a-f]+&\}អ្នករាល់គ្នា/,
      "word 1 highlighted, word 2 in base color, no space between them"
    );
    assert.match(
      dialogueLines[1],
      /\{\\c&H[0-9a-f]+&\}សួស្តី\{\\c&H[0-9a-f]+&\}អ្នករាល់គ្នា/,
      "word 2 highlighted, word 1 in base color"
    );
  });

  it("threads the clip's own transitionIn/transitionOut into \\fad() on the first/last Dialogue events only (regression: this used to be silently dropped)", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "One Two Three")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextAnimation(project, textClip.id, { type: "wordHighlight" });
    project = setClipTransitionIn(project, textClip.id, { duration: 0.5, type: "crossfade" });
    project = setClipTransitionOut(project, textClip.id, { duration: 0.25, type: "crossfade" });

    const written: { content?: string } = {};
    planWithAss(project, written);
    const dialogueLines = written.content!.split("\n").filter((l) => l.startsWith("Dialogue:"));
    assert.equal(dialogueLines.length, 3);

    assert.match(dialogueLines[0], /,\{\\fad\(500,0\)\}/, "first event fades IN over the transitionIn duration (ms), no fade-out term");
    assert.ok(!dialogueLines[1].includes("\\fad("), "a middle word's own event never fades — only the block's head/tail do");
    assert.match(dialogueLines[2], /,\{\\fad\(0,250\)\}/, "last event fades OUT over the transitionOut duration (ms), no fade-in term");
  });

  it("a single-word clip's one Dialogue event gets BOTH fade-in and fade-out in the same \\fad() tag", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Solo")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextAnimation(project, textClip.id, { type: "wordHighlight" });
    project = setClipTransitionIn(project, textClip.id, { duration: 0.5, type: "crossfade" });
    project = setClipTransitionOut(project, textClip.id, { duration: 0.25, type: "crossfade" });

    const written: { content?: string } = {};
    planWithAss(project, written);
    const dialogueLines = written.content!.split("\n").filter((l) => l.startsWith("Dialogue:"));
    assert.equal(dialogueLines.length, 1);
    assert.match(dialogueLines[0], /,\{\\fad\(500,250\)\}/);
  });

  it("a real crossfade between two wordHighlight clips: the outgoing clip's last event genuinely OVERLAPS the incoming clip's window, not just meets it at a hard cut", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "Alpha Beta"), textAsset("text2", "Gamma Delta")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [clipA] = clipsOf(project, textTrackId(project));
    project = addClip(project, textTrackId(project), "text2", clipEnd(clipA)); // adjacent, no gap
    const [, clipB] = clipsOf(project, textTrackId(project));
    project = setClipTextAnimation(project, clipA.id, { type: "wordHighlight" });
    project = setClipTextAnimation(project, clipB.id, { type: "wordHighlight" });
    project = setClipTransitionIn(project, clipB.id, { duration: 0.5, type: "crossfade" });

    const written: { content?: string } = {};
    // Two clips means two separate subtitles= filters/ASS files — capture the LAST one written (B's),
    // and re-derive A's own written content via a second pass keyed by clip id, since `planWithAss`'s
    // single-slot capture only keeps whichever clip was written last.
    const byClip: Record<string, string> = {};
    buildExportPlan(project, {
      ...options,
      assFilePathFor: (clip, assContent) => {
        byClip[clip.id] = assContent;
        return `/tmp/${clip.id}.ass`;
      },
      fontMetricsFor,
      fontsDirFor: () => "/fonts",
    });

    const aLines = byClip[clipA.id].split("\n").filter((l) => l.startsWith("Dialogue:"));
    const bLines = byClip[clipB.id].split("\n").filter((l) => l.startsWith("Dialogue:"));
    const aLastEnd = aLines[aLines.length - 1].split(",")[2];
    const bFirstStart = bLines[0].split(",")[1];

    // clipA is 5s (TEXT_DEFAULT_DURATION), so its own nominal end is 0:00:05.00 — the fade-out window
    // must reach 0.5s PAST that, to 0:00:05.50, landing on the SAME instant clipB's own fade-in
    // finishes (clipB starts at 0:00:05.00, ramps in for 0.5s).
    assert.equal(aLastEnd, "0:00:05.50", "outgoing clip's last event extends fadeOut seconds past its own nominal end");
    assert.equal(bFirstStart, "0:00:05.00", "incoming clip starts at its own normal timelineStart, unshifted");
    assert.match(aLines[aLines.length - 1], /,\{\\fad\(0,500\)\}/);
    assert.match(bLines[0], /,\{\\fad\(500,0\)\}/);
  });

  it("no transitionIn/transitionOut means no \\fad() tag at all — byte-for-byte the same as before this feature existed", () => {
    let base = emptyProject([videoAsset(), textAsset("text1", "One Two")]);
    base = addTrack(base, "text");
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, textTrackId(project), "text1", 0);
    const [textClip] = clipsOf(project, textTrackId(project));
    project = setClipTextAnimation(project, textClip.id, { type: "wordHighlight" });

    const written: { content?: string } = {};
    planWithAss(project, written);
    assert.ok(!written.content!.includes("\\fad("));
  });
});

/** Pulls out the `-ss <n> -t <n>` pair immediately preceding each `-i <path>` occurrence for a given
 *  path — several inputs can reference the same media file (a plain segment, plus a transition's own
 *  slice of it), each needing its OWN seek/trim verified independently. Scanning back only as far as
 *  the previous `-i` (for any path) is what keeps one input's flags from being mistaken for another's. */
function inputsFor(args: string[], path: string): { ss: number; t: number }[] {
  const results: { ss: number; t: number }[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "-i" || args[i + 1] !== path) continue;
    const prevInputEnd = args.lastIndexOf("-i", i - 1);
    const ssIndex = args.lastIndexOf("-ss", i);
    const tIndex = args.lastIndexOf("-t", i);
    if (ssIndex > prevInputEnd && tIndex > prevInputEnd) {
      results.push({ ss: Number(args[ssIndex + 1]), t: Number(args[tIndex + 1]) });
    }
  }
  return results;
}

describe("buildExportPlan with transitions", () => {
  it("two adjacent clips with no transition produce the plain 2-segment concat (regression)", () => {
    const base = emptyProject([videoAsset("a", 5), videoAsset("b", 5)]);
    let project = addClip(base, videoTrackId(base), "a", 0);
    const [clipA] = clipsOf(project, videoTrackId(project));
    project = addClip(project, videoTrackId(project), "b", clipEnd(clipA));

    const { args, duration } = plan(project);
    const graph = filterGraph(args);

    assert.match(graph, /concat=n=2:v=1:a=1\[cv0\]\[ca0\]/);
    assert.ok(!graph.includes("xfade="));
    assert.ok(!graph.includes("acrossfade="));
    assert.ok(closeTo(duration, 10));
  });

  it("a valid transition splices a third segment in and blends with xfade/acrossfade at the right duration", () => {
    const base = emptyProject([videoAsset("a", 5), videoAsset("b", 5)]);
    let project = addClip(base, videoTrackId(base), "a", 0);
    const [clipA] = clipsOf(project, videoTrackId(project));
    project = addClip(project, videoTrackId(project), "b", clipEnd(clipA));
    const [, clipB] = clipsOf(project, videoTrackId(project));
    project = setClipTransitionIn(project, clipB.id, { duration: 1, type: "crossfade" });

    const { args, duration } = plan(project);
    const graph = filterGraph(args);

    assert.match(graph, /concat=n=3:v=1:a=1\[cv0\]\[ca0\]/);
    assert.match(graph, /xfade=transition=fade:duration=1\.000000:offset=0/);
    assert.match(graph, /acrossfade=d=1\.000000/);
    // A crossfade blends, it doesn't shorten the timeline — clips never overlap in storage, so the
    // total exported length must still equal the sum of both clips' own nominal lengths.
    assert.ok(closeTo(duration, 10));
  });

  it("the outgoing clip's own segment is emitted in full; only the incoming clip is shortened, at its head", () => {
    const base = emptyProject([videoAsset("a", 5), videoAsset("b", 5)]);
    let project = addClip(base, videoTrackId(base), "a", 0);
    const [clipA] = clipsOf(project, videoTrackId(project));
    project = addClip(project, videoTrackId(project), "b", clipEnd(clipA));
    const [, clipB] = clipsOf(project, videoTrackId(project));
    project = setClipTransitionIn(project, clipB.id, { duration: 1, type: "crossfade" });

    const { args } = plan(project);

    const aInputs = inputsFor(args, "/media/a.mp4");
    assert.equal(aInputs.length, 2, "clip A's own full segment, plus the transition's FROM slice of it");
    assert.ok(aInputs.some((x) => closeTo(x.ss, 0) && closeTo(x.t, 5)), "clip A's own segment must be unshortened");
    assert.ok(aInputs.some((x) => closeTo(x.ss, 4) && closeTo(x.t, 1)), "the transition's FROM slice is A's own last 1s");

    const bInputs = inputsFor(args, "/media/b.mp4");
    assert.equal(bInputs.length, 2, "the transition's TO slice, plus clip B's own head-shortened remainder");
    assert.ok(bInputs.some((x) => closeTo(x.ss, 0) && closeTo(x.t, 1)), "the transition's TO slice is B's own first 1s");
    assert.ok(bInputs.some((x) => closeTo(x.ss, 1) && closeTo(x.t, 4)), "clip B's own remaining segment starts 1s into its footage");
  });

  it("clamps the blend duration to the shorter clip's own length rather than the requested value", () => {
    const base = emptyProject([videoAsset("a", 2), videoAsset("b", 5)]);
    let project = addClip(base, videoTrackId(base), "a", 0);
    const [clipA] = clipsOf(project, videoTrackId(project));
    project = addClip(project, videoTrackId(project), "b", clipEnd(clipA));
    const [, clipB] = clipsOf(project, videoTrackId(project));
    project = setClipTransitionIn(project, clipB.id, { duration: 10, type: "crossfade" });

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /xfade=transition=fade:duration=2\.000000:offset=0/);
    assert.match(graph, /acrossfade=d=2\.000000/);
  });

  it("a broken adjacency (a dragged-open gap) makes the transition silently fall back to a plain cut", () => {
    const base = emptyProject([videoAsset("a", 5), videoAsset("b", 5)]);
    let project = addClip(base, videoTrackId(base), "a", 0);
    const [clipA] = clipsOf(project, videoTrackId(project));
    // A 1s gap — no longer genuinely adjacent, so `findTransitionPartner` should refuse to apply it.
    project = addClip(project, videoTrackId(project), "b", clipEnd(clipA) + 1);
    const [, clipB] = clipsOf(project, videoTrackId(project));
    project = setClipTransitionIn(project, clipB.id, { duration: 1, type: "crossfade" });

    const { args, duration } = plan(project);
    const graph = filterGraph(args);

    assert.ok(!graph.includes("xfade="));
    assert.ok(!graph.includes("acrossfade="));
    // Same 3-segment shape (clip, gap, clip) as any ordinary unbridged gap.
    assert.match(graph, /concat=n=3:v=1:a=1/);
    assert.ok(closeTo(duration, 11));
  });

  it("a transitioning clip's own transform/effects still apply to its half of the blend", () => {
    const base = emptyProject([videoAsset("a", 5), videoAsset("b", 5)]);
    let project = addClip(base, videoTrackId(base), "a", 0);
    const [clipA] = clipsOf(project, videoTrackId(project));
    project = addClip(project, videoTrackId(project), "b", clipEnd(clipA));
    const [, clipB] = clipsOf(project, videoTrackId(project));
    project = setClipTransitionIn(project, clipB.id, { duration: 1, type: "crossfade" });
    project = setClipEffects(project, clipB.id, { ...IDENTITY_EFFECTS, saturation: 0 });

    const graph = filterGraph(plan(project).args);

    // See "buildExportPlan with clip effects"'s own tests for why this is `lutyuv`, not `eq`.
    assert.match(
      graph,
      /lutyuv=y='clip\(\(val-127\.5\)\*1\.000000\+127\.5\+0\.000000,0,255\)':u='clip\(\(val-127\.5\)\*0\.000000\+127\.5,0,255\)':v='clip\(\(val-127\.5\)\*0\.000000\+127\.5,0,255\)'/
    );
  });
});

describe("buildExportPlan with audio-track transitions", () => {
  // A base video track's own clip just gives the timeline SOME video content — every test below cares
  // only about the audio TRACK's own segment/concat/acrossfade shape, mirroring "buildExportPlan with
  // transitions" above but for `buildAudioTrackStream` instead of `buildTrackStreams`. `TransitionType`
  // never appears in any assertion here — only `"crossfade"` (or, for the type-agnostic test, an
  // exotic value) is set, since `acrossfade` has no "shape" concept at all (see
  // `buildAudioTrackStream`'s own comment on why audio transitions never read `.type`).
  // `videoDuration` sized to exactly match whatever the audio timeline in a given test needs, so the
  // trailing `buildSegments` gap-to-`targetDuration` padding (driven by the OVERALL project duration,
  // which the video track sets here) never adds an extra, test-irrelevant gap segment to the audio
  // track's own count.
  function baseWithVideo(videoDuration = 10) {
    const base = emptyProject([videoAsset("v", videoDuration), audioAsset("a", 5), audioAsset("b", 5)]);
    return addClip(base, videoTrackId(base), "v", 0);
  }

  it("two adjacent audio clips with no transition produce the plain 2-segment concat (regression)", () => {
    let project = baseWithVideo();
    project = addClip(project, audioTrackId(project), "a", 0);
    const [clipA] = clipsOf(project, audioTrackId(project));
    project = addClip(project, audioTrackId(project), "b", clipEnd(clipA));

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /concat=n=2:v=0:a=1\[at0\]/);
    assert.ok(!graph.includes("acrossfade="));
  });

  it("a valid transition splices a third segment in and blends with acrossfade at the right duration", () => {
    let project = baseWithVideo();
    project = addClip(project, audioTrackId(project), "a", 0);
    const [clipA] = clipsOf(project, audioTrackId(project));
    project = addClip(project, audioTrackId(project), "b", clipEnd(clipA));
    const [, clipB] = clipsOf(project, audioTrackId(project));
    project = setClipTransitionIn(project, clipB.id, { duration: 1, type: "crossfade" });

    const { args, duration } = plan(project);
    const graph = filterGraph(args);

    assert.match(graph, /concat=n=3:v=0:a=1\[at0\]/);
    assert.match(graph, /acrossfade=d=1\.000000/);
    assert.ok(!graph.includes("xfade="), "an audio-only track never reaches the video xfade filter");
    // A crossfade blends, it doesn't shorten the timeline — same guarantee the video suite checks.
    assert.ok(closeTo(duration, 10));
  });

  it("every TransitionType still renders as a plain acrossfade — audio has no per-style rendering", () => {
    let project = baseWithVideo();
    project = addClip(project, audioTrackId(project), "a", 0);
    const [clipA] = clipsOf(project, audioTrackId(project));
    project = addClip(project, audioTrackId(project), "b", clipEnd(clipA));
    const [, clipB] = clipsOf(project, audioTrackId(project));
    project = setClipTransitionIn(project, clipB.id, { duration: 1, type: "wipeLeft" });

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /acrossfade=d=1\.000000/);
    assert.ok(!graph.includes("wipeleft"), "the video-only xfade transition NAME never reaches an audio-only track");
  });

  it("the outgoing clip's own segment is emitted in full; only the incoming clip is shortened, at its head", () => {
    let project = baseWithVideo();
    project = addClip(project, audioTrackId(project), "a", 0);
    const [clipA] = clipsOf(project, audioTrackId(project));
    project = addClip(project, audioTrackId(project), "b", clipEnd(clipA));
    const [, clipB] = clipsOf(project, audioTrackId(project));
    project = setClipTransitionIn(project, clipB.id, { duration: 1, type: "crossfade" });

    const { args } = plan(project);

    const aInputs = inputsFor(args, "/media/a.mp4");
    assert.equal(aInputs.length, 2, "clip A's own full segment, plus the transition's FROM slice of it");
    assert.ok(aInputs.some((x) => closeTo(x.ss, 0) && closeTo(x.t, 5)), "clip A's own segment must be unshortened");
    assert.ok(aInputs.some((x) => closeTo(x.ss, 4) && closeTo(x.t, 1)), "the transition's FROM slice is A's own last 1s");

    const bInputs = inputsFor(args, "/media/b.mp4");
    assert.equal(bInputs.length, 2, "the transition's TO slice, plus clip B's own head-shortened remainder");
    assert.ok(bInputs.some((x) => closeTo(x.ss, 0) && closeTo(x.t, 1)), "the transition's TO slice is B's own first 1s");
    assert.ok(bInputs.some((x) => closeTo(x.ss, 1) && closeTo(x.t, 4)), "clip B's own remaining segment starts 1s into its footage");
  });

  it("clamps the blend duration to the shorter clip's own length rather than the requested value", () => {
    let base = emptyProject([videoAsset("v", 20), audioAsset("a", 2), audioAsset("b", 5)]);
    let project = addClip(base, videoTrackId(base), "v", 0);
    project = addClip(project, audioTrackId(project), "a", 0);
    const [clipA] = clipsOf(project, audioTrackId(project));
    project = addClip(project, audioTrackId(project), "b", clipEnd(clipA));
    const [, clipB] = clipsOf(project, audioTrackId(project));
    project = setClipTransitionIn(project, clipB.id, { duration: 10, type: "crossfade" });

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /acrossfade=d=2\.000000/);
  });

  it("a broken adjacency (a dragged-open gap) makes the transition silently fall back to a plain cut", () => {
    // 11s of video: 5+1+5 — the deliberate 1s gap below plus both clips, with nothing left over for
    // `buildSegments`'s own trailing-gap padding to add a fourth, test-irrelevant segment.
    let project = baseWithVideo(11);
    project = addClip(project, audioTrackId(project), "a", 0);
    const [clipA] = clipsOf(project, audioTrackId(project));
    project = addClip(project, audioTrackId(project), "b", clipEnd(clipA) + 1);
    const [, clipB] = clipsOf(project, audioTrackId(project));
    project = setClipTransitionIn(project, clipB.id, { duration: 1, type: "crossfade" });

    const graph = filterGraph(plan(project).args);

    assert.ok(!graph.includes("acrossfade="));
    // Same 3-segment shape (clip, gap, clip) the video suite's identical scenario produces.
    assert.match(graph, /concat=n=3:v=0:a=1\[at0\]/);
  });

  it("a transitioning clip's own gain still applies to its half of the blend", () => {
    let project = baseWithVideo();
    project = addClip(project, audioTrackId(project), "a", 0);
    const [clipA] = clipsOf(project, audioTrackId(project));
    project = addClip(project, audioTrackId(project), "b", clipEnd(clipA));
    const [, clipB] = clipsOf(project, audioTrackId(project));
    project = setClipTransitionIn(project, clipB.id, { duration: 1, type: "crossfade" });
    project = setClipGain(project, clipB.id, 0.5);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,volume=0\.500000.*\[at0_1_to\]/);
  });

  it("a solo transitionOut on the last clip of an audio track renders as a plain afade, not acrossfade", () => {
    let project = baseWithVideo();
    project = addClip(project, audioTrackId(project), "a", 0);
    const [clipA] = clipsOf(project, audioTrackId(project));
    project = setClipTransitionOut(project, clipA.id, { duration: 1, type: "crossfade" });

    const graph = filterGraph(plan(project).args);

    assert.ok(!graph.includes("acrossfade="), "a solo fade has no partner to blend with");
    assert.match(graph, /afade=t=out:st=4\.000000:d=1\.000000/);
  });
});

describe("buildExportPlan with multiple video tracks", () => {
  /** `videoTrackId` (fixture.ts) always returns the FIRST video track — this is what every test here
   *  uses to reach the second one instead, since `addTrack` always appends a new video track after
   *  any existing ones (see `insertionIndexForKind`'s own comment). */
  function secondVideoTrackId(project: Parameters<typeof buildExportPlan>[0]): string {
    return project.sequence.tracks.filter((t) => t.kind === "video")[1].id;
  }

  it("composites two visible video tracks: one concat chain each, a transparent gap on the upper one (opaque on the base), and a cross-track overlay", () => {
    const base = emptyProject([videoAsset("a", 8), videoAsset("b", 4)]);
    let project = addClip(base, videoTrackId(base), "a", 2); // 0–2s gap on the BASE track.
    project = addTrack(project, "video");
    const track2 = secondVideoTrackId(project);
    project = addClip(project, track2, "b", 5); // 0–5s gap on the UPPER track.

    const { args } = plan(project);
    const graph = filterGraph(args);

    const concatCount = (graph.match(/concat=n=\d+:v=1:a=1/g) ?? []).length;
    assert.equal(concatCount, 2, "one concat chain per video track");
    assert.match(graph, /\[cv0\]\[cv1\]overlay=format=auto\[layer1\]/);
    // The gap's color lives in an `-i` argument (a lavfi source), not inside `-filter_complex` — check
    // `args` directly, same as the existing single-track "gives the transform chain its own black
    // background input" test does.
    assert.ok(args.some((a) => a === "color=c=black:s=1080x1920:r=30"), "the base track's own gap stays opaque");
    assert.ok(
      args.some((a) => a === "color=c=black@0:s=1080x1920:r=30,format=rgba"),
      "the upper track's own gap is transparent"
    );
    assert.match(graph, /\[ca0\]\[ca1\]amix=inputs=2:normalize=0:dropout_transition=0\[mixa\]/);
  });

  it("skips a video track with no clips entirely, adding no empty concat/overlay stage", () => {
    const base = emptyProject();
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addTrack(project, "video"); // Left empty — no clip ever placed on it.

    const { args } = plan(project);
    const graph = filterGraph(args);

    assert.equal((graph.match(/concat=n=\d+:v=1:a=1/g) ?? []).length, 1);
    assert.ok(!graph.includes("overlay=format=auto"), "a single contributing track needs no cross-track overlay");
  });

  it("excludes a hidden second video track from compositing, same visibility rule as the base track", () => {
    const base = emptyProject([videoAsset("a", 10), videoAsset("b", 4)]);
    let project = addClip(base, videoTrackId(base), "a", 0);
    project = addTrack(project, "video");
    const track2 = secondVideoTrackId(project);
    project = addClip(project, track2, "b", 0);
    project = setTrackFlag(project, track2, "visible", false);

    const { args } = plan(project);
    const graph = filterGraph(args);

    assert.equal((graph.match(/concat=n=\d+:v=1:a=1/g) ?? []).length, 1);
    assert.ok(!graph.includes("overlay=format=auto"));
  });

  it("a non-base track's untransformed clip gets format=rgba and a transparent pad; the base track's stays byte-for-byte unchanged", () => {
    const base = emptyProject([videoAsset("a", 10), videoAsset("b", 4)]);
    let project = addClip(base, videoTrackId(base), "a", 0);
    project = addTrack(project, "video");
    const track2 = secondVideoTrackId(project);
    project = addClip(project, track2, "b", 0);

    const graph = filterGraph(plan(project).args);

    assert.match(
      graph,
      /\[1:v\]format=rgba,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:\(ow-iw\)\/2:\(oh-ih\)\/2:color=black@0,setsar=1/
    );
    assert.match(graph, /\[0:v\]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:\(ow-iw\)\/2:\(oh-ih\)\/2,setsar=1/);
  });

  it("respects each track's own array order across three layers, chaining two overlay stages", () => {
    const base = emptyProject([videoAsset("a", 5), videoAsset("b", 5), videoAsset("c", 5)]);
    let project = addClip(base, videoTrackId(base), "a", 0);
    project = addTrack(project, "video");
    const track2 = secondVideoTrackId(project);
    project = addClip(project, track2, "b", 0);
    project = addTrack(project, "video");
    const track3 = project.sequence.tracks.filter((t) => t.kind === "video")[2].id;
    project = addClip(project, track3, "c", 0);

    const graph = filterGraph(plan(project).args);

    assert.equal((graph.match(/concat=n=\d+:v=1:a=1/g) ?? []).length, 3);
    assert.match(graph, /\[cv0\]\[cv1\]overlay=format=auto\[layer1\]/);
    assert.match(graph, /\[layer1\]\[cv2\]overlay=format=auto\[layer2\]/);
    assert.equal(plan(project).args[plan(project).args.indexOf("-map") + 1], "[layer2]");
  });

  it("pads a track whose own content ends early with a trailing transparent gap, matching the full project duration", () => {
    // Track 2's own clip (4s) ends long before track 1's (10s) — without a trailing gap, track 2's
    // own `[cv1]` stream would be only 4s long. FFmpeg's `overlay` filter defaults to
    // `eof_action=repeat`, so a short upper-track stream would otherwise freeze on its own last frame
    // for the rest of the export instead of genuinely disappearing once its clip ends.
    const base = emptyProject([videoAsset("a", 10), videoAsset("b", 4)]);
    let project = addClip(base, videoTrackId(base), "a", 0);
    project = addTrack(project, "video");
    const track2 = secondVideoTrackId(project);
    project = addClip(project, track2, "b", 0);

    const { args, duration } = plan(project);
    const graph = filterGraph(args);

    assert.ok(closeTo(duration, 10), "overall duration is driven by the longer base track");
    // Track 2 (index 1) needs a SECOND "clip" input for its own trailing gap, on top of its one real
    // clip — two `-loop 1`/`-ss` video inputs feeding its own 2-segment concat.
    assert.match(graph, /concat=n=2:v=1:a=1\[cv1\]\[ca1\]/, "track 2's own stream gets a trailing gap segment");
    assert.ok(
      args.some((a) => a === "color=c=black@0:s=1080x1920:r=30,format=rgba"),
      "the trailing gap on the non-base track is transparent, not opaque"
    );
  });

  it("a real transform/effects clip on a non-base track uses a transparent micro-background", () => {
    const base = emptyProject([videoAsset("a", 10), videoAsset("b", 4)]);
    let project = addClip(base, videoTrackId(base), "a", 0);
    project = addTrack(project, "video");
    const track2 = secondVideoTrackId(project);
    project = addClip(project, track2, "b", 0);
    const [clipB] = clipsOf(project, track2);
    project = setClipTransform(project, clipB.id, { ...IDENTITY_TRANSFORM, rotationDeg: 15 });

    const { args } = plan(project);
    const graph = filterGraph(args);

    assert.ok(
      args.some((a) => a === "color=c=black@0:s=1080x1920:r=30,format=rgba"),
      "the rotated clip's own bg input should be transparent"
    );
    assert.match(graph, /rotate=a=15\.000000\*PI\/180/);
  });
});
