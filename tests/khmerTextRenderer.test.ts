import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderKhmerClipWindows } from "../src/export/khmerTextRenderer.ts";
import type { RenderKhmerTextFrame, RenderKhmerTextParams } from "../src/export/khmerTextRenderer.ts";
import { DEFAULT_TEXT_STYLE } from "../src/project/types.ts";
import type { Clip } from "../src/project/types.ts";

/** A minimal, directly-constructed `Clip` — `clipDuration`/`clipEnd` only ever read `sourceIn`/
 *  `sourceOut`/`timelineStart`, so a fixture this small is enough for `renderKhmerClipWindows`'s own
 *  pure window-computation logic without going through the full project/track machinery
 *  `export.test.ts` uses for filter-graph-level assertions. */
function clip(overrides: Partial<Clip> = {}): Clip {
  return { id: "c1", assetId: "a1", sourceIn: 0, sourceOut: 3, timelineStart: 0, ...overrides };
}

/** Records every `renderFrame` call it receives and returns a fake, deterministic path per call —
 *  never touches a real browser, matching `khmerTextRenderer.ts`'s own doc comment on why the window
 *  computation is unit-testable this way. */
function fakeRenderer(): { renderFrame: RenderKhmerTextFrame; calls: RenderKhmerTextParams[] } {
  const calls: RenderKhmerTextParams[] = [];
  const renderFrame: RenderKhmerTextFrame = async (params) => {
    calls.push(params);
    return `/tmp/khmer-${calls.length - 1}.png`;
  };
  return { renderFrame, calls };
}

const baseOptions = { frameWidth: 1080, frameHeight: 1920, fps: 30, customFonts: [] };

describe("renderKhmerClipWindows", () => {
  it("returns [] for empty content", async () => {
    const { renderFrame } = fakeRenderer();
    const windows = await renderKhmerClipWindows(clip(), "", DEFAULT_TEXT_STYLE, { ...baseOptions, renderFrame });
    assert.deepEqual(windows, []);
  });

  it("returns [] for a non-positive-duration clip", async () => {
    const { renderFrame } = fakeRenderer();
    const windows = await renderKhmerClipWindows(clip({ sourceIn: 2, sourceOut: 2 }), "អរគុណ", DEFAULT_TEXT_STYLE, { ...baseOptions, renderFrame });
    assert.deepEqual(windows, []);
  });

  it("a plain (no textAnimation) clip renders exactly one window spanning the whole clip duration", async () => {
    const { renderFrame, calls } = fakeRenderer();
    const windows = await renderKhmerClipWindows(clip({ sourceIn: 0, sourceOut: 5 }), "អរគុណ", DEFAULT_TEXT_STYLE, { ...baseOptions, renderFrame });

    assert.equal(windows.length, 1);
    assert.equal(windows[0].startOffset, 0);
    assert.equal(windows[0].endOffset, 5);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].animation, undefined);
    assert.equal(calls[0].clipDurationSeconds, 5);
    assert.equal(calls[0].elapsedSeconds, 2.5, "sampled at the clip's own midpoint");
  });

  it("bounce/pulse/wiggle render multiple back-to-back windows covering the whole clip with no gaps", async () => {
    for (const type of ["bounce", "pulse", "wiggle"] as const) {
      const { renderFrame, calls } = fakeRenderer();
      const clipWithAnimation = clip({ sourceIn: 0, sourceOut: 1, textAnimation: { type } });
      const windows = await renderKhmerClipWindows(clipWithAnimation, "អរគុណ", DEFAULT_TEXT_STYLE, { ...baseOptions, renderFrame });

      assert.ok(windows.length > 1, `${type}: expected multiple slices, got ${windows.length}`);
      assert.equal(windows[0].startOffset, 0, `${type}: first window starts at 0`);
      assert.equal(windows[windows.length - 1].endOffset, 1, `${type}: last window ends at the clip's own duration`);
      for (let i = 1; i < windows.length; i++) {
        assert.equal(windows[i].startOffset, windows[i - 1].endOffset, `${type}: windows telescope with no gap or overlap`);
      }
      assert.equal(calls.length, windows.length);
      for (const call of calls) assert.equal(call.animation?.type, type);
    }
  });

  it("typewriter renders EVERY slice, even ones revealing nothing yet — never skips a window and creates a gap", async () => {
    const { renderFrame, calls } = fakeRenderer();
    // A short single-character string against a longer clip: the earliest slices reveal nothing, but
    // must still get their own rendered (blank) window rather than being skipped — `pushKhmerTextOverlay`
    // concatenates windows back-to-back with no gap-filling of its own, so any skipped window would
    // shift every later window's content to start too early.
    const windows = await renderKhmerClipWindows(clip({ sourceIn: 0, sourceOut: 3, textAnimation: { type: "typewriter" } }), "អ", DEFAULT_TEXT_STYLE, {
      ...baseOptions,
      renderFrame,
    });
    assert.ok(windows.length > 1);
    assert.equal(windows[0].startOffset, 0);
    assert.equal(windows[windows.length - 1].endOffset, 3);
    for (let i = 1; i < windows.length; i++) {
      assert.equal(windows[i].startOffset, windows[i - 1].endOffset, "windows telescope with no gap or overlap");
    }
    assert.equal(calls.length, windows.length, "one renderFrame call per slice, none skipped");
    for (const call of calls) assert.equal(call.animation?.type, "typewriter");
  });

  it("wordHighlight renders exactly one window per word, spanning the clip's own duration with no gaps", async () => {
    const { renderFrame, calls } = fakeRenderer();
    const windows = await renderKhmerClipWindows(
      clip({ sourceIn: 0, sourceOut: 3, textAnimation: { type: "wordHighlight" } }),
      "អរគុណ ច្រើន សម្រាប់",
      DEFAULT_TEXT_STYLE,
      { ...baseOptions, renderFrame }
    );

    assert.equal(windows.length, 3, "3 words -> 3 windows");
    assert.equal(windows[0].startOffset, 0);
    assert.equal(windows[2].endOffset, 3);
    for (let i = 1; i < windows.length; i++) {
      assert.equal(windows[i].startOffset, windows[i - 1].endOffset, "windows telescope with no gap or overlap");
    }
    assert.equal(calls.length, 3);
    for (const call of calls) assert.equal(call.animation?.type, "wordHighlight");
  });

  it("wordHighlight returns [] when the content has no words", async () => {
    const { renderFrame } = fakeRenderer();
    const windows = await renderKhmerClipWindows(clip({ textAnimation: { type: "wordHighlight" } }), "   ", DEFAULT_TEXT_STYLE, { ...baseOptions, renderFrame });
    assert.deepEqual(windows, []);
  });

  it("every window's imagePath comes from the injected renderFrame, in order", async () => {
    const { renderFrame } = fakeRenderer();
    const windows = await renderKhmerClipWindows(
      clip({ sourceIn: 0, sourceOut: 3, textAnimation: { type: "wordHighlight" } }),
      "អរគុណ ច្រើន",
      DEFAULT_TEXT_STYLE,
      { ...baseOptions, renderFrame }
    );
    assert.deepEqual(
      windows.map((w) => w.imagePath),
      ["/tmp/khmer-0.png", "/tmp/khmer-1.png"]
    );
  });
});
