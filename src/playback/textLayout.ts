/** Layout constants shared by BOTH text renderers — `PlaybackEngine`'s canvas compositor and
 *  `buildExportPlan`'s FFmpeg `drawtext` chain — so the numbers themselves can't drift apart even
 *  though the two sites can't share the actual positioning FORMULA (FFmpeg's `x`/`y` are expression
 *  strings evaluated by FFmpeg itself against `text_w`/`text_h`, which only exist once FreeType has
 *  actually shaped the glyphs — there's no number for a JS function here to compute up front).
 *
 *  ## Why alignment isn't (quite) what it sounds like for multi-line text
 *
 *  FFmpeg's `drawtext` always draws every line growing RIGHTWARD from one shared `x`, evaluated once
 *  per call — there's no native "center this line" or "right-align this line" mode. That makes
 *  `align: "left"` exact for any number of lines (every line naturally starts flush at the same `x`),
 *  but `"center"`/`"right"` only exact for a SINGLE line — with multiple lines of differing width, the
 *  export approximates them relative to the WIDEST line's own box rather than centering/right-aligning
 *  each line independently. The canvas preview deliberately reproduces the same approximation (even
 *  though Canvas2D's `textAlign` COULD do true per-line alignment) specifically so preview and export
 *  agree — matching each other is worth more here than either one being independently fancier. */

import type { TextStyle } from "../project/types.ts";
import { fontById, resolveFontVariant } from "../project/fonts.ts";

/** Sequence pixels from the frame edge that `align: "left"`/`"right"` anchor to. */
export const TEXT_MARGIN_PX = 40;

/** Padding around the text block, in sequence pixels, when `TextStyle.backgroundColor` is set. */
export const TEXT_BOX_PADDING = 12;

export interface TextBlockLayout {
  lines: string[];
  lineHeight: number;
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
  style: TextStyle
): TextBlockLayout {
  const lines = content.length > 0 ? content.split("\n") : [""];
  const font = fontById(style.fontFamily);
  const variant = resolveFontVariant(font, style.bold, style.italic);
  const weight = variant.bold ? "bold" : "normal";
  const slant = variant.italic ? "italic" : "normal";
  context.font = `${slant} ${weight} ${style.fontSize}px "${font.cssFamily}", sans-serif`;
  context.textBaseline = "alphabetic";
  context.textAlign = "left"; // always left — `blockLeft` below already encodes the align setting.

  const lineHeight = style.fontSize * style.lineHeightMultiplier;
  const blockWidth = Math.max(...lines.map((line) => context.measureText(line).width));
  const blockHeight = lineHeight * lines.length;

  // The align anchor: left/right hug their frame edge (inset by the shared margin), center sits on
  // the frame's own center — `offsetX`/`offsetY` then nudge from THAT point, in every case.
  const anchorX =
    style.align === "left"
      ? TEXT_MARGIN_PX + style.offsetX
      : style.align === "right"
        ? canvasWidth - TEXT_MARGIN_PX + style.offsetX
        : canvasWidth / 2 + style.offsetX;
  const blockLeft = style.align === "left" ? anchorX : style.align === "right" ? anchorX - blockWidth : anchorX - blockWidth / 2;
  const blockTop = canvasHeight / 2 + style.offsetY - blockHeight / 2;

  return { lines, lineHeight, blockLeft, blockTop, blockWidth, blockHeight };
}
