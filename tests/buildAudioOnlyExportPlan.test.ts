import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAudioOnlyExportPlan } from "../src/export/buildAudioOnlyExportPlan.ts";
import { addClip, setClipGain, setMasterGain, setTrackGain } from "../src/timeline/operations.ts";
import { audioAsset, audioTrackId, clipsOf, emptyProject, videoAsset, videoTrackId } from "./fixture.ts";

/** Mirrors `export.test.ts`'s own `options`/`plan`/`filterGraph` helpers, scoped to this file's
 *  narrower `AudioOnlyPlanOptions` (no `fontPathFor`/`textFilePathFor` — there's no text/video output
 *  here to need them). */
const options = {
  inputPathFor: (assetId: string) => `/media/${assetId}.mp4`,
  outputPath: "/out/transcribe.mp3",
};

function plan(project: Parameters<typeof buildAudioOnlyExportPlan>[0]) {
  return buildAudioOnlyExportPlan(project, options);
}

function filterGraph(args: string[]): string {
  const index = args.indexOf("-filter_complex");
  assert.ok(index >= 0, "plan should contain a filter_complex");
  return args[index + 1];
}

describe("buildAudioOnlyExportPlan with track/master gain", () => {
  it("multiplies an overlay audio-track clip's own gain by its track's gain", () => {
    const base = emptyProject([videoAsset("asset1", 10), audioAsset()]);
    let project = addClip(base, videoTrackId(base), "asset1", 0);
    project = addClip(project, audioTrackId(project), "music", 2);
    const [musicClip] = clipsOf(project, audioTrackId(project));
    project = setClipGain(project, musicClip.id, 2);
    project = setTrackGain(project, audioTrackId(project), 1.5);

    const graph = filterGraph(plan(project).args);

    assert.match(graph, /volume=3\.000000/);
  });

  it("an audio track with no gain set contributes no extra multiplier", () => {
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

    const { args } = plan(project);
    const graph = filterGraph(args);

    assert.match(graph, /amix=inputs=\d+:normalize=0:dropout_transition=0\[mixa\];\[mixa\]volume=1\.500000\[mastered\]/);
    assert.ok(args.includes("[mastered]"), "the final -map should point at the mastered output");
  });

  it("omits the master volume= stage entirely when masterGain is left at 1", () => {
    const base = emptyProject([videoAsset("asset1", 10)]);
    const project = addClip(base, videoTrackId(base), "asset1", 0);

    const graph = filterGraph(plan(project).args);

    assert.ok(!graph.includes("[mastered]"));
  });
});
