/** The registry of fonts VStudio text clips can use — the ONE place both renderers (`PlaybackEngine`'s
 *  canvas compositor, via `computeTextBlock`, and `buildExportPlan`'s FFmpeg `drawtext` chain) and the
 *  Inspector's font picker read from, so a font can never exist in one without the other.
 *
 *  Every entry needs REAL, separate static `.ttf` files per weight/style it claims to support — FFmpeg's
 *  `drawtext` selects a face by pointing at one exact file, it never synthesizes bold or italic the way
 *  a browser can, and a variable font's single file with a weight AXIS doesn't let `drawtext` pick a
 *  weight at all. That ruled out several otherwise-obvious choices when this was put together (Noto Sans
 *  Khmer and Hanuman, for instance, are Google-Fonts-variable-only) — every font here was confirmed to
 *  ship genuinely separate static files for the styles it lists before being added. */

export interface FontVariantFiles {
  /** Filename within `packages/vstudio/assets/fonts/` — never a path, so there's no ambiguity between
   *  the dev filesystem location and the packaged app's (see `ffmpeg.ts`'s `resolveFontsDir`). */
  regular: string;
  bold?: string;
  italic?: string;
  boldItalic?: string;
}

export interface FontDefinition {
  id: string;
  /** Shown in the Inspector's font picker. */
  label: string;
  /** The `@font-face` family name this font is registered under — in BOTH the browser (see
   *  studios/bp/app/globals.css) and `computeTextBlock`'s `context.font` string. Prefixed and distinct
   *  per font so two bundled families can never collide with each other or with a page's own fonts. */
  cssFamily: string;
  files: FontVariantFiles;
}

export const FONT_REGISTRY: FontDefinition[] = [
  {
    id: "lato",
    label: "Lato",
    cssFamily: "VStudioLato",
    files: {
      regular: "Lato-Regular.ttf",
      bold: "Lato-Bold.ttf",
      italic: "Lato-Italic.ttf",
      boldItalic: "Lato-BoldItalic.ttf",
    },
  },
  {
    id: "battambang",
    label: "Battambang (Khmer)",
    cssFamily: "VStudioBattambang",
    files: {
      // No italic — Khmer script has no italic convention, and Battambang (like every Khmer font
      // checked for this) ships none. `resolveFontVariant` below is what keeps this from becoming a
      // preview/export mismatch: a browser COULD fake a slant on the regular face where FFmpeg can't,
      // so both renderers are made to agree on falling back to upright instead.
      regular: "Battambang-Regular.ttf",
      bold: "Battambang-Bold.ttf",
    },
  },
  {
    id: "moul",
    label: "Moul (Khmer display)",
    cssFamily: "VStudioMoul",
    files: {
      // Single-weight display face (already heavy/bold by design, the way a headline typeface often
      // is) — bold/italic toggles simply have nothing to fall forward to, same reasoning as above.
      regular: "Moul-Regular.ttf",
    },
  },
];

export const DEFAULT_FONT_ID = FONT_REGISTRY[0].id;

/** Falls back to the first (default) font for an unknown id — the same "never let a bad value break
 *  rendering" leniency `parseTextStyle` already applies to `align`, so a project file referencing a font
 *  this build doesn't know about still opens instead of throwing. */
export function fontById(id: string): FontDefinition {
  return FONT_REGISTRY.find((f) => f.id === id) ?? FONT_REGISTRY[0];
}

/** Which bold/italic flags a font can ACTUALLY honor — clamped to whichever real file exists, preferring
 *  bold over italic when both are requested but only one is available (bold reads as "emphasis" more
 *  reliably across scripts than a synthetic-only italic would). Both `computeTextBlock` (preview) and
 *  `buildExportPlan` (export) call this BEFORE building their font string/path, so a family missing a
 *  face — every bundled Khmer font lacks italic, `moul` lacks bold entirely — never diverges between a
 *  browser that COULD fake the missing style and FFmpeg, which never can. */
export function resolveFontVariant(font: FontDefinition, bold: boolean, italic: boolean): { bold: boolean; italic: boolean } {
  if (bold && italic) {
    if (font.files.boldItalic) return { bold: true, italic: true };
    if (font.files.bold) return { bold: true, italic: false };
    if (font.files.italic) return { bold: false, italic: true };
    return { bold: false, italic: false };
  }
  if (bold) return { bold: Boolean(font.files.bold), italic: false };
  if (italic) return { bold: false, italic: Boolean(font.files.italic) };
  return { bold: false, italic: false };
}

/** The exact bundled filename for a (font, bold, italic) combination — always resolvable, since
 *  `resolveFontVariant` only ever reports a style flag as true when a matching file genuinely exists. */
export function fontFileFor(font: FontDefinition, bold: boolean, italic: boolean): string {
  const resolved = resolveFontVariant(font, bold, italic);
  if (resolved.bold && resolved.italic) return font.files.boldItalic!;
  if (resolved.bold) return font.files.bold!;
  if (resolved.italic) return font.files.italic!;
  return font.files.regular;
}
