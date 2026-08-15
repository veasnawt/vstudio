import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildExportPlan, ExportError } from "../src/export/buildExportPlan.ts";
import { clipEnd } from "../src/project/createProject.ts";
import {
  addClip,
  addTrack,
  moveClip,
  setClipEffects,
  setClipGain,
  setClipMuted,
  setClipTransform,
  setClipTransitionIn,
  setTextAsset,
  setTrackFlag,
  splitClip,
  trimClip,
} from "../src/timeline/operations.ts";
import { audioAsset, audioTrackId, clipsOf, closeTo, emptyProject, imageAsset, textAsset, textTrackId, videoAsset, videoTrackId } from "./fixture.ts";
import { DEFAULT_TEXT_STYLE, IDENTITY_EFFECTS, IDENTITY_TRANSFORM } from "../src/project/types.ts";

const options = {
  inputPathFor: (assetId: string) => `/media/${assetId}.mp4`,
  outputPath: "/out/export.mp4",
  fontPathFor: (fileName: string) => `/fonts/${fileName}`,
  textFilePathFor: (clip: { id: string }) => `/tmp/${clip.id}.txt`,
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

    assert.match(graph, /eq=brightness=0\.200000:contrast=1\.300000:saturation=0\.500000/);
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

    assert.match(graph, /eq=brightness=0\.000000:contrast=1\.000000:saturation=0\.000000/);
    assert.match(graph, /rotate=a=20\.000000\*PI\/180/);
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

  it("an audio-track overlay clip's gain appears in its own filter chain, alongside its adelay", () => {
    const base = emptyProject([videoAsset("asset1", 10), audioAsset()]);
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, audioTrackId(project), "music", 2);
    const [musicClip] = clipsOf(project, audioTrackId(project));
    project = setClipGain(project, musicClip.id, 0.25);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /adelay=2000\|2000,volume=0\.250000/);
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

    // A fresh full-sequence-duration transparent lavfi input to draw and rotate the text onto.
    assert.ok(args.includes("color=c=black@0:s=1080x1920:r=30"));
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

    assert.match(graph, /eq=brightness=0\.000000:contrast=1\.000000:saturation=0\.000000/);
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
    assert.ok(args.some((a) => a === "color=c=black@0:s=1080x1920:r=30"), "the upper track's own gap is transparent");
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
      args.some((a) => a === "color=c=black@0:s=1080x1920:r=30"),
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

    assert.ok(args.some((a) => a === "color=c=black@0:s=1080x1920:r=30"), "the rotated clip's own bg input should be transparent");
    assert.match(graph, /rotate=a=15\.000000\*PI\/180/);
  });
});
