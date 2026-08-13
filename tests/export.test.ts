import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildExportPlan, ExportError } from "../src/export/buildExportPlan.ts";
import { addClip, moveClip, setClipMuted, setClipTransform, setTrackFlag, splitClip, trimClip } from "../src/timeline/operations.ts";
import { audioAsset, audioTrackId, clipsOf, closeTo, emptyProject, imageAsset, videoAsset, videoTrackId } from "./fixture.ts";
import { IDENTITY_TRANSFORM } from "../src/project/types.ts";

const options = {
  inputPathFor: (assetId: string) => `/media/${assetId}.mp4`,
  outputPath: "/out/export.mp4",
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

    assert.match(graph, /concat=n=2:v=1:a=1\[cv\]\[ca\]/);
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

  it("positions an audio-track clip with adelay and mixes it without attenuation", () => {
    const base = emptyProject([videoAsset("asset1", 10), audioAsset()]);
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, audioTrackId(project), "music", 2);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /adelay=2000\|2000/);
    assert.match(graph, /amix=inputs=2:normalize=0/);
  });

  it("omits the mix stage entirely when there are no audio-track clips", () => {
    const base = emptyProject();
    const project = addClip(base, videoTrackId(base), "asset1", 0);

    const { args } = plan(project);

    assert.ok(!filterGraph(args).includes("amix"));
    assert.equal(args[args.indexOf("-map") + 1], "[cv]");
    assert.equal(args.lastIndexOf("-map") >= 0 && args[args.lastIndexOf("-map") + 1], "[ca]");
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

    assert.match(graph, /concat=n=2:v=1:a=1\[cv\]\[ca\]/);
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
