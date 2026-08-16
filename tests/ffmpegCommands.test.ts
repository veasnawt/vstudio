import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFilmstripArgs, buildThumbnailArgs, buildWaveformArgs, FILMSTRIP_FRAME_COUNT } from "../src/export/ffmpegCommands.ts";

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
