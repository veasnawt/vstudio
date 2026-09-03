/** Layout constants shared by BOTH text renderers — `PlaybackEngine`'s canvas compositor and
 *  `buildExportPlan`'s FFmpeg `drawtext` chain — so the numbers themselves can't drift apart even
 *  though the two sites can't share the actual positioning FORMULA (FFmpeg's `x`/`y` are expression
 *  strings evaluated by FFmpeg itself against `text_w`/`text_h`, which only exist once FreeType has
 *  actually shaped the glyphs — there's no number for a JS function here to compute up front).
 *
 *  ## Alignment for multi-line text
 *
 *  `style.align` does TWO jobs, both needed for true per-line alignment: it anchors the overall block
 *  to the frame's left/center/right edge (the `anchorX`/`blockLeft` math below — unchanged, and the
 *  only part single-line text ever needed), and it decides how each individual line sits WITHIN that
 *  block when lines differ in width. `lineWidths` below exists for the second job: `PlaybackEngine
 *  .drawText` uses it to offset each line by `(blockWidth - lineWidths[i])` scaled by `align`, so a
 *  3-line "center" clip centers each line on its own, not just the block as a whole. FFmpeg's
 *  `drawtext` gets the equivalent behavior for free via its own `text_align` option (confirmed live
 *  against this repo's bundled ffmpeg via a real multi-line render — `left`/`center`/`right` map 1:1
 *  onto `TextStyle.align`), which needs no extra geometry from here at all; see
 *  `buildDrawTextStyleParams` in `buildExportPlan.ts`. */

import type { Clip, CustomFontAsset, TextStyle } from "../project/types.ts";
import { resolveFont, resolveFontVariant } from "../project/fonts.ts";
import {
  activeWordIndex,
  computeTextAnimationTransform,
  DEFAULT_WORD_HIGHLIGHT_COLOR,
  segmentLine,
  splitWords,
  typewriterVisibleContent,
} from "../timeline/textAnimation.ts";

/** Sequence pixels from the frame edge that `align: "left"`/`"right"` anchor to. */
export const TEXT_MARGIN_PX = 40;

/** Padding around the text block, in sequence pixels, when `TextStyle.backgroundColor` is set. */
export const TEXT_BOX_PADDING = 12;

export interface TextBlockLayout {
  lines: string[];
  lineHeight: number;
  /** Vertical distance from the block's own top edge down to the FIRST line's baseline — derived from
   *  the browser's own real font metrics, not a fontSize-based guess (see `computeTextBlock`'s own
   *  comment on why: Khmer's tall vowel signs and deep subscript consonant stacks give it a much
   *  larger, far-from-symmetric ascent/descent than Latin has, so a Latin-tuned approximation visibly
   *  crowds one edge of the text's own background box instead of centering within it). */
  baselineOffset: number;
  /** Top-left corner and size of the (unrotated) text block, in canvas backing-store (sequence)
   *  pixels — `offsetX`/`offsetY` and the align anchor are already baked in. Rotation, when
   *  `style.rotationDeg` is nonzero, happens AROUND this box's own center — see `PlaybackEngine
   *  .drawText` and `buildExportPlan`'s `buildRotatedDrawTextFilter` for the two (necessarily
   *  different — a `CanvasRenderingContext2D` can rotate around any point directly, FFmpeg's `rotate`
   *  filter can only rotate a buffer around ITS OWN center) ways each renderer achieves the same
   *  visual result. */
  blockLeft: number;
  blockTop: number;
  blockWidth: number;
  blockHeight: number;
  /** Each line's own measured width, same order/index as `lines` — what `PlaybackEngine.drawText`
   *  uses to offset an individual line within `blockWidth` for true per-line center/right alignment
   *  (see this file's own top-of-file comment). `blockWidth` alone (the max) isn't enough for that: it
   *  tells you how WIDE the block is, not how far short of that width any single shorter line falls. */
  lineWidths: number[];
}

/** Measures and positions a text block — the ONE place this math is written, shared by
 *  `PlaybackEngine.drawText` (which then draws it) and `TextTransformHandles` (which needs the same
 *  box, unrotated, to position on-canvas drag/resize/rotate handles). Mutates `context.font`/
 *  `textAlign`/`textBaseline` as a side effect (needed for `measureText` below to measure the right
 *  font) — callers that go on to actually draw rely on this, so they must NOT reset those between
 *  calling this and calling `fillText`.
 *
 *  Resolves `style.fontFamily` via the registry (`fonts.ts`) and clamps `bold`/`italic` to whichever
 *  face that font actually has a file for (`resolveFontVariant`) — so a family missing italic (every
 *  bundled Khmer font) never shows a browser-faked slant here that FFmpeg's export could never
 *  reproduce (it has no file to fake one from). */
export function computeTextBlock(
  context: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  content: string,
  style: TextStyle,
  customFonts: CustomFontAsset[] = []
): TextBlockLayout {
  const lines = content.length > 0 ? content.split("\n") : [""];
  const font = resolveFont(style.fontFamily, customFonts);
  const variant = resolveFontVariant(font, style.bold, style.italic);
  const weight = variant.bold ? "bold" : "normal";
  const slant = variant.italic ? "italic" : "normal";
  context.font = `${slant} ${weight} ${style.fontSize}px "${font.cssFamily}", sans-serif`;
  context.textBaseline = "alphabetic";
  context.textAlign = "left"; // always left — `blockLeft` below already encodes the align setting.

  const lineHeight = style.fontSize * style.lineHeightMultiplier;
  const blockHeight = lineHeight * lines.length;

  // Real ink metrics of the ACTUAL rendered glyphs (not a fontSize-based guess) for where the
  // baseline sits within its own line. Deliberately `actualBoundingBox*`, not `fontBoundingBox*`: the
  // latter reports the FONT's own worst-case design metrics — generous enough to fit any character the
  // face could ever render, descenders included, whether or not this string has any — so an all-caps,
  // no-descender line like "BEYOND PERSPECTIVE" still got padded as if it had one, visibly shoving the
  // text toward the bottom of its own background box (confirmed live, not just from spec: a red-boxed
  // logo wordmark with zero descenders showed a large gap above the text and almost none below).
  // `actualBoundingBox*` measures the tight ink extent of THIS specific text instead, which is what
  // "equal padding around what I can actually see" means. Taken as the max across every line (not
  // just the first) so a multi-line block with, say, one all-caps line and one with a Khmer subscript
  // stack centers on whichever line is genuinely tallest/deepest, not whichever happens to be first.
  // Any EXTRA leading `lineHeightMultiplier` adds beyond that real ink height is split evenly
  // above/below, the same way CSS `line-height` distributes leading around a font's own box.
  // Measured once per line and reused for `blockWidth` below too — no reason to call `measureText`
  // twice per line for two different pieces of the same result.
  const lineMetrics = lines.map((line) => context.measureText(line || " "));
  const lineWidths = lineMetrics.map((m) => m.width);
  const blockWidth = Math.max(...lineWidths);
  const ascent = Math.max(...lineMetrics.map((m) => m.actualBoundingBoxAscent ?? 0)) || style.fontSize * 0.8;
  const descent = Math.max(...lineMetrics.map((m) => m.actualBoundingBoxDescent ?? 0)) || style.fontSize * 0.2;
  const baselineOffset = ascent + (lineHeight - (ascent + descent)) / 2;

  // The block's own on-screen position depends ONLY on `offsetX`/`offsetY` — the frame's center,
  // nudged by the user's own drag/offset — never on `align`. `align` used to also pick WHICH edge the
  // block anchors to (left hugging the left margin, right hugging the right margin), so clicking
  // through Left/Center/Right visibly teleported the whole text box across the frame instead of just
  // re-justifying its lines — confirmed as a real, reported bug, not a deliberate design: a text box
  // you've dragged to a specific spot should stay there when you change how its lines justify, exactly
  // like every word processor/design tool. `blockLeft`'s own align branch (now the only place `align`
  // still matters, alongside the per-LINE `lineX` offset `PlaybackEngine.drawText` computes from
  // `lineWidths`) is gone for the same reason: the box's own left edge is now always `blockWidth/2`
  // left of center, regardless of which way its lines justify.
  const anchorX = canvasWidth / 2 + style.offsetX;
  const blockLeft = anchorX - blockWidth / 2;
  const blockTop = canvasHeight / 2 + style.offsetY - blockHeight / 2;

  return { lines, lineHeight, baselineOffset, blockLeft, blockTop, blockWidth, blockHeight, lineWidths };
}

/** Draws a text block onto `context` exactly as `PlaybackEngine`'s canvas preview does — extracted out
 *  of `PlaybackEngine.drawText` (which is now a one-line wrapper calling this) so a Khmer-script text
 *  clip's export-time render harness (a headless-browser page, see `khmerTextRenderer.ts`) can call the
 *  IDENTICAL function the live preview uses instead of reimplementing it, guaranteeing byte-for-byte
 *  parity rather than a "should match" approximation. Has no dependency on `PlaybackEngine` itself —
 *  only ever touches its own parameters and `computeTextBlock`, which is why the extraction was a pure
 *  mechanical move with no behavior change. */
export function drawTextFrame(
  context: CanvasRenderingContext2D,
  frameWidth: number,
  frameHeight: number,
  content: string,
  style: TextStyle,
  wordHighlight?: { activeWordIndex: number; highlightColor: string },
  customFonts: CustomFontAsset[] = []
): void {
  const block = computeTextBlock(context, frameWidth, frameHeight, content, style, customFonts);
  // The block's NATURAL (align-anchored, offset-EXCLUDED) position — offsetX/Y are additive terms in
  // `computeTextBlock`'s own anchor formula, so subtracting them back out recovers this without a
  // second measurement pass. This is what gets rotated; the offset then applies as a translate
  // OUTSIDE the rotation, exactly mirroring `buildRotatedDrawTextFilter`'s draw-then-rotate-then-
  // overlay order.
  const drawLeft = style.rotationDeg !== 0 ? block.blockLeft - style.offsetX : block.blockLeft;
  const drawTop = style.rotationDeg !== 0 ? block.blockTop - style.offsetY : block.blockTop;
  const frameCenterX = frameWidth / 2;
  const frameCenterY = frameHeight / 2;

  context.save();
  if (style.rotationDeg !== 0) {
    context.translate(style.offsetX, style.offsetY);
    context.translate(frameCenterX, frameCenterY);
    context.rotate((style.rotationDeg * Math.PI) / 180);
    context.translate(-frameCenterX, -frameCenterY);
  }

  if (style.backgroundColor) {
    context.fillStyle = style.backgroundColor;
    context.fillRect(
      drawLeft - TEXT_BOX_PADDING,
      drawTop - TEXT_BOX_PADDING,
      block.blockWidth + TEXT_BOX_PADDING * 2,
      block.blockHeight + TEXT_BOX_PADDING * 2
    );
  }

  // `baselineOffset` is derived from the browser's own real font metrics (see `computeTextBlock`'s
  // own comment) — not a fontSize-based guess, so the glyphs actually center within their own
  // padded background box regardless of how a script's ascent/descent proportions compare to Latin.
  const firstBaseline = drawTop + block.baselineOffset;
  // Per-LINE horizontal offset within the block — `drawLeft` alone is only correct for `align:
  // "left"` (every line already starts flush there); a shorter line under "center"/"right" needs to
  // sit `(blockWidth - thisLine'sWidth)` further right (all the way, for right; split in half, for
  // center) so multi-line text visually centers/right-aligns line-by-line, not just as one flush-left
  // block that happens to sit in a centered/right-anchored box. Matches FFmpeg's own `text_align`
  // option in the export path exactly — see `buildDrawTextStyleParams`'s own comment.
  const lineX = (i: number) => {
    if (style.align === "left") return drawLeft;
    const gap = block.blockWidth - block.lineWidths[i];
    return style.align === "right" ? drawLeft + gap : drawLeft + gap / 2;
  };
  const drawLines = (draw: (line: string, x: number, y: number) => void) =>
    block.lines.forEach((line, i) => draw(line, lineX(i), firstBaseline + block.lineHeight * i));

  // Set AFTER the background box (which shouldn't get a shadow of its own) and left active through
  // both the stroke and fill draws below — canvas naturally draws a shadow under EACH, but since both
  // land on the identical glyph shapes, the two shadow instances just overlap into one, matching
  // FFmpeg's own fixed draw order for `drawtext`: shadow, then outline, then fill (see
  // `buildDrawTextStyleParams`'s comment). `shadowBlur` stays 0 — FFmpeg's shadow is a hard-edged
  // offset duplicate, not a blurred one, and there's no blur radius to match if there were.
  if (style.shadowColor) {
    context.shadowColor = style.shadowColor;
    context.shadowOffsetX = style.shadowOffsetX;
    context.shadowOffsetY = style.shadowOffsetY;
    context.shadowBlur = 0;
  }

  if (style.strokeColor) {
    context.strokeStyle = style.strokeColor;
    // `strokeText` centers the stroke ON the glyph's own outline — half the width lands INSIDE the
    // glyph (invisible, covered by the fill drawn next) and half OUTSIDE (the only part actually
    // visible). Doubling here makes the VISIBLE thickness equal `strokeWidth`, matching FFmpeg's
    // `borderw`, which specifies the outer border thickness directly rather than a centered stroke.
    context.lineWidth = style.strokeWidth * 2;
    context.lineJoin = "round"; // avoids spiky miters at sharp glyph corners, closer to FFmpeg's own border rendering
    drawLines((line, x, y) => context.strokeText(line, x, y));
  }

  if (wordHighlight) {
    // Per-word fill only — shadow/stroke/background above stay whole-line, matching how a caption's
    // outline/box reads as one continuous shape rather than N separate word-sized ones. Walks EVERY
    // `segmentLine` token (not just the word-like ones) so whitespace/punctuation between words
    // still advances `x` by its own measured width rather than an assumed space size — matters for
    // tab-indented or multiple-space-separated captions, where a guessed width would visibly drift
    // the line. `segmentLine` (not a plain `.split(/\s+/)`) is what makes this correct for Khmer and
    // the other scripts that don't space words at all — see its own comment in
    // `timeline/textAnimation.ts`. `globalWordIndex` only advances on WORD segments, matching
    // `splitWords`'s own counting exactly, so `wordHighlight.activeWordIndex` always lands on the
    // same word this loop actually colors.
    let globalWordIndex = 0;
    block.lines.forEach((line, i) => {
      const y = firstBaseline + block.lineHeight * i;
      let x = lineX(i);
      for (const token of segmentLine(line)) {
        if (token.text.length === 0) continue;
        if (!token.isWord) {
          x += context.measureText(token.text).width;
          continue;
        }
        context.fillStyle = globalWordIndex === wordHighlight.activeWordIndex ? wordHighlight.highlightColor : style.color;
        context.fillText(token.text, x, y);
        x += context.measureText(token.text).width;
        globalWordIndex++;
      }
    });
  } else {
    context.fillStyle = style.color;
    drawLines((line, x, y) => context.fillText(line, x, y));
  }
  context.restore();
}

/** `drawTextFrame`, plus whatever `animation` asks for — extracted out of `PlaybackEngine
 *  .drawAnimatedText` (now a one-line wrapper calling this) for the same reason `drawTextFrame` itself
 *  was extracted: a Khmer-script text clip's export-time render harness needs to reproduce EXACTLY what
 *  the live preview draws for a given elapsed time — including bounce/pulse/typewriter/wordHighlight
 *  state — not a second, potentially-drifting reimplementation of the same animation math.
 *  `elapsedSeconds` is simply `time - clip.timelineStart`, the same value every other per-clip timing
 *  calculation in this codebase already uses. `clipDurationSeconds` is only ever consulted for
 *  `wordHighlight` (see `activeWordIndex`'s own doc comment on why it needs the clip's own length,
 *  unlike every other animation type here). */
export function drawAnimatedTextFrame(
  context: CanvasRenderingContext2D,
  frameWidth: number,
  frameHeight: number,
  content: string,
  style: TextStyle,
  animation: Clip["textAnimation"],
  elapsedSeconds: number,
  clipDurationSeconds: number,
  customFonts: CustomFontAsset[]
): void {
  if (!animation) {
    drawTextFrame(context, frameWidth, frameHeight, content, style, undefined, customFonts);
    return;
  }
  // `speed` scales the effective elapsed time fed to EVERY animation type uniformly — applied once,
  // here, rather than threading a speed parameter through `computeTextAnimationTransform`/
  // `typewriterVisibleContent`/`activeWordIndex` individually. None of those functions need their own
  // notion of speed this way; they just see a bigger or smaller elapsed-time number than the clip's
  // real playhead position implies.
  const elapsed = elapsedSeconds * (animation.speed ?? 1);

  if (animation.type === "typewriter") {
    drawTextFrame(context, frameWidth, frameHeight, typewriterVisibleContent(content, elapsed), style, undefined, customFonts);
    return;
  }
  if (animation.type === "wordHighlight") {
    const words = splitWords(content);
    const active = activeWordIndex(words.length, elapsed, clipDurationSeconds);
    drawTextFrame(
      context,
      frameWidth,
      frameHeight,
      content,
      style,
      { activeWordIndex: active, highlightColor: animation.highlightColor ?? DEFAULT_WORD_HIGHLIGHT_COLOR },
      customFonts
    );
    return;
  }

  const { dx, dy, scale, rotationDeg } = computeTextAnimationTransform(animation.type, elapsed);
  // Pivots around the text BLOCK's own real center, from `computeTextBlock`'s `blockLeft`/`blockTop`
  // — which, since the block's own screen position no longer depends on `align` at all (see this
  // file's own top-of-file comment), is now always exactly `frameWidth/2 + style.offsetX` /
  // `frameHeight/2 + style.offsetY` regardless of `align`. Still going through `computeTextBlock`
  // rather than that simpler formula directly: it's the one place this math is written, and staying
  // consistent with it costs nothing (redundant with the measurement `drawTextFrame` below does again
  // via its own `computeTextBlock` call — real but cheap, `measureText` on a short string).
  const block = computeTextBlock(context, frameWidth, frameHeight, content, style, customFonts);
  const pivotX = block.blockLeft + block.blockWidth / 2;
  const pivotY = block.blockTop + block.blockHeight / 2;
  context.save();
  context.translate(dx, dy);
  context.translate(pivotX, pivotY);
  context.rotate((rotationDeg * Math.PI) / 180);
  context.scale(scale, scale);
  context.translate(-pivotX, -pivotY);
  drawTextFrame(context, frameWidth, frameHeight, content, style, undefined, customFonts);
  context.restore();
}
