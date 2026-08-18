import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildExtractClipArgs,
  buildFilmstripArgs,
  buildMaskImageArgs,
  buildMaskVideoArgs,
  buildThumbnailArgs,
  buildWaveformArgs,
  FILMSTRIP_FRAME_COUNT,
} from "../src/export/ffmpegCommands.ts";

describe("buildThumbnailArgs", () => {
  it("includes the input, output, and seek time", () => {
    const args = buildThumbnailArgs("/in.mp4", "/out.jpg", 2.5);
    assert.ok(args.includes("/in.mp4"));
    assert.ok(args.includes("/out.jpg"));
    assert.ok(args.includes("2.5"));
  });

  it("clamps a negative seek time to 0 rather than passing it through", () => {
    const args = buildThumbnailArgs("/in.mp4", "/out.jpg", -3);
    const seekIndex = args.indexOf("-ss");
    assert.equal(args[seekIndex + 1], "0");
  });

  it("always grabs exactly one frame", () => {
    const args = buildThumbnailArgs("/in.mp4", "/out.jpg", 0);
    assert.ok(args.includes("-frames:v"));
    assert.equal(args[args.indexOf("-frames:v") + 1], "1");
  });
});

describe("buildFilmstripArgs", () => {
  it("includes the input and output paths", () => {
    const args = buildFilmstripArgs("/in.mp4", "/out.jpg", 10);
    assert.ok(args.includes("/in.mp4"));
    assert.ok(args.includes("/out.jpg"));
  });

  it("samples FILMSTRIP_FRAME_COUNT frames spaced across the real duration", () => {
    const args = buildFilmstripArgs("/in.mp4", "/out.jpg", 10);
    const vf = args[args.indexOf("-vf") + 1];
    assert.ok(vf.includes(`fps=${FILMSTRIP_FRAME_COUNT}/10`));
    assert.ok(vf.includes(`tile=${FILMSTRIP_FRAME_COUNT}x1`));
  });

  it("floors a zero/negative duration to a small positive value instead of dividing by zero", () => {
    const args = buildFilmstripArgs("/in.mp4", "/out.jpg", 0);
    const vf = args[args.indexOf("-vf") + 1];
    assert.ok(!vf.includes("/0,"), `filter graph should not contain a literal /0,: ${vf}`);
  });
});

describe("buildWaveformArgs", () => {
  it("includes the input and output paths", () => {
    const args = buildWaveformArgs("/in.mp3", "/out.png");
    assert.ok(args.includes("/in.mp3"));
    assert.ok(args.includes("/out.png"));
  });

  it("renders on a transparent background, not opaque black", () => {
    const args = buildWaveformArgs("/in.mp3", "/out.png");
    assert.ok(args.some((a) => a.includes("black@0")));
  });

  it("collapses to mono and normalizes loudness before drawing the waveform", () => {
    const args = buildWaveformArgs("/in.mp3", "/out.png");
    const filterComplex = args[args.indexOf("-filter_complex") + 1];
    assert.ok(filterComplex.includes("channel_layouts=mono"));
    assert.ok(filterComplex.includes("dynaudnorm"));
  });
});

describe("buildExtractClipArgs", () => {
  it("seeks before the input (fast, input-side seeking) and includes the trim range", () => {
    const args = buildExtractClipArgs("/in.mp4", "/out.mp4", 2.5, 7.5);
    const ssIndex = args.indexOf("-ss");
    const iIndex = args.indexOf("-i");
    assert.ok(ssIndex < iIndex, "-ss must come before -i for fast input-side seeking");
    assert.equal(args[ssIndex + 1], "2.5");
    assert.equal(args[args.indexOf("-to") + 1], "7.5");
  });

  it("re-encodes video rather than stream-copying, since trim points aren't keyframe-aligned", () => {
    const args = buildExtractClipArgs("/in.mp4", "/out.mp4", 0, 5);
    assert.ok(args.includes("-c:v"));
    assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
    assert.ok(!args.includes("copy"));
  });

  it("drops audio", () => {
    const args = buildExtractClipArgs("/in.mp4", "/out.mp4", 0, 5);
    assert.ok(args.includes("-an"));
  });

  it("clamps a negative start to 0 and never lets the end land before the (clamped) start", () => {
    const args = buildExtractClipArgs("/in.mp4", "/out.mp4", -3, -1);
    assert.equal(args[args.indexOf("-ss") + 1], "0");
    assert.equal(args[args.indexOf("-to") + 1], "0");
  });
});

describe("buildMaskVideoArgs", () => {
  it("synthesizes a lavfi color source matching the given dimensions/fps/duration, no real input file", () => {
    const args = buildMaskVideoArgs("/mask.mp4", 1920, 1080, 30, 5, { x: 0, y: 0, width: 100, height: 100 });
    assert.ok(args.includes("-f"));
    assert.equal(args[args.indexOf("-f") + 1], "lavfi");
    const lavfiInput = args[args.indexOf("-i") + 1];
    assert.ok(lavfiInput.includes("color=c=black"));
    assert.ok(lavfiInput.includes("s=1920x1080"));
    assert.ok(lavfiInput.includes("r=30"));
    assert.ok(lavfiInput.includes("d=5"));
  });

  it("draws a filled white rectangle at the given position/size", () => {
    const args = buildMaskVideoArgs("/mask.mp4", 1920, 1080, 30, 5, { x: 100, y: 200, width: 300, height: 400 });
    const vf = args[args.indexOf("-vf") + 1];
    assert.ok(vf.includes("drawbox="));
    assert.ok(vf.includes("x=100"));
    assert.ok(vf.includes("y=200"));
    assert.ok(vf.includes("w=300"));
    assert.ok(vf.includes("h=400"));
    assert.ok(vf.includes("color=white"));
    assert.ok(vf.includes("t=fill"));
  });

  it("rounds fractional rect coordinates rather than passing them through raw", () => {
    const args = buildMaskVideoArgs("/mask.mp4", 1920, 1080, 30, 5, { x: 10.6, y: 20.4, width: 30.5, height: 40.5 });
    const vf = args[args.indexOf("-vf") + 1];
    assert.ok(vf.includes("x=11"));
    assert.ok(vf.includes("y=20"));
  });

  it("clamps a negative rect position to 0 and a non-positive size to at least 1px", () => {
    const args = buildMaskVideoArgs("/mask.mp4", 1920, 1080, 30, 5, { x: -10, y: -5, width: 0, height: -20 });
    const vf = args[args.indexOf("-vf") + 1];
    assert.ok(vf.includes("x=0"));
    assert.ok(vf.includes("y=0"));
    assert.ok(vf.includes("w=1"));
    assert.ok(vf.includes("h=1"));
  });

  it("floors a zero/negative duration to a small positive value instead of an invalid lavfi source", () => {
    const args = buildMaskVideoArgs("/mask.mp4", 1920, 1080, 30, 0, { x: 0, y: 0, width: 100, height: 100 });
    const lavfiInput = args[args.indexOf("-i") + 1];
    assert.ok(lavfiInput.includes("d=0.1"), `expected the duration floored to 0.1, got: ${lavfiInput}`);
  });

  it("pins yuv420p pixel format so the output reads as a clean binary mask", () => {
    const args = buildMaskVideoArgs("/mask.mp4", 1920, 1080, 30, 5, { x: 0, y: 0, width: 100, height: 100 });
    assert.ok(args.includes("-pix_fmt"));
    assert.equal(args[args.indexOf("-pix_fmt") + 1], "yuv420p");
  });
});

describe("buildMaskImageArgs", () => {
  it("synthesizes a lavfi color source matching the given dimensions, no real input file", () => {
    const args = buildMaskImageArgs("/mask.png", 1920, 1080, { x: 0, y: 0, width: 100, height: 100 });
    assert.ok(args.includes("-f"));
    assert.equal(args[args.indexOf("-f") + 1], "lavfi");
    const lavfiInput = args[args.indexOf("-i") + 1];
    assert.ok(lavfiInput.includes("color=c=black"));
    assert.ok(lavfiInput.includes("s=1920x1080"));
  });

  it("draws a filled white rectangle at the given position/size", () => {
    const args = buildMaskImageArgs("/mask.png", 1920, 1080, { x: 100, y: 200, width: 300, height: 400 });
    const vf = args[args.indexOf("-vf") + 1];
    assert.ok(vf.includes("drawbox="));
    assert.ok(vf.includes("x=100"));
    assert.ok(vf.includes("y=200"));
    assert.ok(vf.includes("w=300"));
    assert.ok(vf.includes("h=400"));
    assert.ok(vf.includes("color=white"));
    assert.ok(vf.includes("t=fill"));
  });

  it("rounds fractional rect coordinates rather than passing them through raw", () => {
    const args = buildMaskImageArgs("/mask.png", 1920, 1080, { x: 10.6, y: 20.4, width: 30.5, height: 40.5 });
    const vf = args[args.indexOf("-vf") + 1];
    assert.ok(vf.includes("x=11"));
    assert.ok(vf.includes("y=20"));
  });

  it("clamps a negative rect position to 0 and a non-positive size to at least 1px", () => {
    const args = buildMaskImageArgs("/mask.png", 1920, 1080, { x: -10, y: -5, width: 0, height: -20 });
    const vf = args[args.indexOf("-vf") + 1];
    assert.ok(vf.includes("x=0"));
    assert.ok(vf.includes("y=0"));
    assert.ok(vf.includes("w=1"));
    assert.ok(vf.includes("h=1"));
  });

  it("grabs exactly one frame, unlike the video variant", () => {
    const args = buildMaskImageArgs("/mask.png", 1920, 1080, { x: 0, y: 0, width: 100, height: 100 });
    assert.ok(args.includes("-frames:v"));
    assert.equal(args[args.indexOf("-frames:v") + 1], "1");
  });
});
