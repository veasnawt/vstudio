/** Computes the set of per-window renders a Khmer-script text clip needs for export, and drives an
 *  injected `renderFrame` callback to produce one transparent PNG per window — the Node-side half of
 *  the browser-rendered Khmer text overlay (see `buildExportPlan.ts`'s `pushKhmerTextOverlay` for how
 *  the resulting images get composited into the export, via `overlay=`).
 *
 *  Exists because every FFmpeg-side Khmer text path (`drawtext`, and the libass `subtitles=` filter
 *  this app's Khmer text used to route through) fails to correctly stack certain subscript-consonant
 *  clusters (coeng+ន, coeng+រ — extremely common, e.g. អ្នក) — confirmed empirically this session
 *  against the bundled FFmpeg build AND the newest available alternative build, with multiple different
 *  fonts including a fresh official download, so it's a genuine HarfBuzz Khmer-shaping limitation, not a
 *  font or build-staleness problem. The browser (Chromium) is the one thing confirmed to shape it
 *  correctly — this module renders text through a headless instance of it instead of asking FFmpeg to
 *  shape the text itself.
 *
 *  Deliberately stays Puppeteer-free itself (matching `buildExportPlan.ts`'s own "take injected
 *  resolvers, don't touch the browser/filesystem directly" convention) — `renderFrame` is supplied by
 *  the caller (`studios/vcut`'s export route, via `_lib/khmerTextHarness.ts`), so the WINDOW
 *  COMPUTATION here (pure and deterministic) can be unit-tested with a fake `renderFrame` that never
 *  touches a real browser (`tests/khmerTextRenderer.test.ts`).
 *
 *  Does NOT re-derive `bounce`/`pulse`/`wiggle`/`typewriter`/`wordHighlight` transform math itself —
 *  each window's `renderFrame` call passes the clip's own `animation` plus an `elapsedSeconds`/
 *  `clipDurationSeconds` pair, the SAME inputs `PlaybackEngine.drawAnimatedText` (now a wrapper over
 *  the extracted, standalone `drawAnimatedTextFrame` in `playback/textLayout.ts`) already takes — the
 *  render harness calls that exact function, so the animation state a window shows is guaranteed to
 *  match the live preview at that same elapsed time, not a second implementation that could drift.
 *  Every window returned here MUST cover a CONTIGUOUS span with no internal gaps (each one's own
 *  `startOffset` equal to the previous one's `endOffset`, the first at `0`, the last at the clip's own
 *  full duration) — `pushKhmerTextOverlay` concatenates them back-to-back with no gap-filling of its
 *  own, so a real gap here would show the WRONG window's content starting too early. */
import { clipDuration } from "../project/createProject.ts";
import type { Clip, CustomFontAsset, TextStyle } from "../project/types.ts";
import { computeSliceBoundaries } from "./buildExportPlan.ts";
import { splitWords } from "../timeline/textAnimation.ts";

export interface KhmerTextWindow {
  /** Seconds from the CLIP's own start (not the timeline) — matches how `buildExportPlan.ts`'s own
   *  per-segment filter chains already address time, so the caller compositing these windows doesn't
   *  need to re-derive an offset. */
  startOffset: number;
  endOffset: number;
  imagePath: string;
}

export interface RenderKhmerTextParams {
  frameWidth: number;
  frameHeight: number;
  content: string;
  style: TextStyle;
  /** Passed straight to `drawAnimatedTextFrame` — `undefined` for a plain (non-animated) window, same
   *  meaning as `Clip.textAnimation` everywhere else in this codebase. */
  animation: Clip["textAnimation"];
  /** Clip-relative, UNSCALED by `animation.speed` — `drawAnimatedTextFrame` applies that scaling
   *  itself, same as every other caller of it. */
  elapsedSeconds: number;
  clipDurationSeconds: number;
  customFonts: CustomFontAsset[];
}

/** Renders one window's exact visible state to a transparent PNG and returns its path — supplied by
 *  the caller, implemented (in `studios/vcut`) by driving a headless Chromium page that calls the
 *  same `drawAnimatedTextFrame` (`playback/textLayout.ts`) the live canvas preview uses. */
export type RenderKhmerTextFrame = (params: RenderKhmerTextParams) => Promise<string>;

export interface RenderKhmerClipOptions {
  frameWidth: number;
  frameHeight: number;
  /** Only needed for the bounce/pulse/typewriter per-slice path — `computeSliceBoundaries`'s own
   *  frame-snapping, harmlessly unused for static text and `wordHighlight`. */
  fps: number;
  customFonts: CustomFontAsset[];
  renderFrame: RenderKhmerTextFrame;
}

/** A Khmer-script text clip's own render windows — one call covers every `textAnimation` shape
 *  (`undefined`/plain, `bounce`/`pulse`, `typewriter`, `wordHighlight`), mirroring how
 *  `buildStaticTextAss`/`buildWordHighlightAss` together used to split the same cases. Returns `[]` for
 *  empty content or non-positive duration — the same "nothing to render" cases those two functions
 *  already treated as `null`. */
export async function renderKhmerClipWindows(clip: Clip, content: string, style: TextStyle, options: RenderKhmerClipOptions): Promise<KhmerTextWindow[]> {
  if (content.length === 0) return [];
  const duration = clipDuration(clip);
  if (duration <= 0) return [];

  const animation = clip.textAnimation;

  if (animation?.type === "wordHighlight") {
    const words = splitWords(content);
    if (words.length === 0) return [];
    // Real (unscaled) seconds each word occupies — `drawAnimatedTextFrame` scales `elapsedSeconds` by
    // `animation.speed` itself before resolving the active word, so the window WIDTH here has to
    // account for speed up front to land each window's own midpoint on the word it's meant to render
    // (same derivation `buildWordHighlightAss`'s own `secondsPerWord` uses).
    const speed = animation.speed ?? 1;
    const secondsPerWord = duration / words.length / speed;
    const windows: KhmerTextWindow[] = [];
    for (let k = 0; k < words.length; k++) {
      const startOffset = k * secondsPerWord;
      const endOffset = k === words.length - 1 ? duration : (k + 1) * secondsPerWord;
      const imagePath = await options.renderFrame({
        frameWidth: options.frameWidth,
        frameHeight: options.frameHeight,
        content,
        style,
        animation,
        elapsedSeconds: startOffset + (endOffset - startOffset) / 2,
        clipDurationSeconds: duration,
        customFonts: options.customFonts,
      });
      windows.push({ startOffset, endOffset, imagePath });
    }
    return windows;
  }

  // `wiggle` (continuous rotation) needs the same per-frame slicing `bounce`/`pulse` (continuous
  // position/scale) do — all three drive `computeTextAnimationTransform` on every frame, unlike
  // `typewriter` (a discrete revealed-prefix state) or no animation at all (one static frame for the
  // clip's whole duration).
  const isMotion = animation?.type === "bounce" || animation?.type === "pulse" || animation?.type === "wiggle";
  const isTypewriter = animation?.type === "typewriter";

  if (!isMotion && !isTypewriter) {
    const imagePath = await options.renderFrame({
      frameWidth: options.frameWidth,
      frameHeight: options.frameHeight,
      content,
      style,
      animation,
      elapsedSeconds: duration / 2,
      clipDurationSeconds: duration,
      customFonts: options.customFonts,
    });
    return [{ startOffset: 0, endOffset: duration, imagePath }];
  }

  // Same "flipbook" slicing a keyframed video clip's own transform uses, sampled at each slice's own
  // MIDPOINT — mirrors `buildStaticTextAss`'s own per-slice branch exactly. `elapsedSeconds` below is
  // passed UNSCALED (the harness's own `drawAnimatedTextFrame` call applies `animation.speed` itself),
  // so no local `speed` derivation is needed here at all — every window covers a fixed, EQUAL span of
  // real clip time regardless of speed, which is exactly what a uniform flipbook interval should do.
  const slices = computeSliceBoundaries([], 0, duration, options.fps);
  const windows: KhmerTextWindow[] = [];
  for (let i = 1; i < slices.length; i++) {
    const startOffset = slices[i - 1];
    const endOffset = slices[i];
    if (endOffset - startOffset <= 1e-9) continue; // two boundaries snapped onto the same frame — zero-width, no coverage lost
    const midpoint = startOffset + (endOffset - startOffset) / 2;

    const imagePath = await options.renderFrame({
      frameWidth: options.frameWidth,
      frameHeight: options.frameHeight,
      content,
      style,
      animation,
      elapsedSeconds: midpoint,
      clipDurationSeconds: duration,
      customFonts: options.customFonts,
    });
    windows.push({ startOffset, endOffset, imagePath });
  }
  return windows;
}
