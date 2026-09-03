/** The registry of fonts VCut text clips can use — the ONE place both renderers (`PlaybackEngine`'s
 *  canvas compositor, via `computeTextBlock`, and `buildExportPlan`'s FFmpeg `drawtext` chain) and the
 *  Inspector's font picker read from, so a font can never exist in one without the other.
 *
 *  Every entry needs REAL, separate static `.ttf` files per weight/style it claims to support — FFmpeg's
 *  `drawtext` selects a face by pointing at one exact file, it never synthesizes bold or italic the way
 *  a browser can, and a variable font's single file with a weight AXIS doesn't let `drawtext` pick a
 *  weight at all. That ruled out several otherwise-obvious choices when this was put together (Noto Sans
 *  Khmer and Hanuman, for instance, are Google-Fonts-variable-only) — every font here was confirmed to
 *  ship genuinely separate static files for the styles it lists before being added. */

import type { CustomFontAsset } from "./types.ts";

export interface FontVariantFiles {
  /** Filename within `packages/vcut/assets/fonts/` — never a path, so there's no ambiguity between
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

/** Resolves a `TextStyle.fontFamily` id to the `FontDefinition`-shaped record both text renderers
 *  (`playback/textLayout.ts`'s `computeTextBlock`, and export's own drawtext font selection) actually
 *  need — the ONE place that decides whether a given id names a BUNDLED font (this registry) or one of
 *  the project's own uploaded `CustomFontAsset` entries, so neither renderer has to know that
 *  distinction exists.
 *
 *  `customFonts` is checked FIRST, not `fontById` — an id could otherwise collide only in theory (a
 *  custom font's id is a fresh `newId(...)`, never a bundled font's short slug), but checking the
 *  project's own library first is also simply the more useful precedence: a user who uploads a font
 *  almost always means to use THEIR font over a same-named bundled one, if that ever happened. A custom
 *  font is single-weight only (see `CustomFontAsset`'s own doc comment) — its `files` always reports
 *  just `regular`, so `resolveFontVariant`/`fontFileFor` naturally clamp any requested bold/italic back
 *  to the one real face it has, the exact same "clamped to whichever real file exists" leniency they
 *  already give a bundled single-weight font like `moul`.
 *
 *  Falls back to `fontById` (bundled-only, itself falling back to the default font for an unknown id)
 *  when no custom font matches — so an id belonging to neither library (an older project, a hand-edited
 *  file, or a custom font that's since been removed from `customFonts`) still resolves to SOMETHING
 *  renderable rather than throwing, matching `fontById`'s own "never let a bad value break rendering"
 *  contract. */
export function resolveFont(fontFamily: string, customFonts: CustomFontAsset[]): FontDefinition {
  const custom = customFonts.find((f) => f.id === fontFamily);
  if (custom) {
    return {
      id: custom.id,
      label: custom.name,
      cssFamily: custom.cssFamily,
      files: { regular: custom.relPath },
    };
  }
  return fontById(fontFamily);
}

export const FONT_REGISTRY: FontDefinition[] = [
  {
    id: "lato",
    label: "Lato",
    cssFamily: "VCutLato",
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
    cssFamily: "VCutBattambang",
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
    cssFamily: "VCutMoul",
    files: {
      // Single-weight display face (already heavy/bold by design, the way a headline typeface often
      // is) — bold/italic toggles simply have nothing to fall forward to, same reasoning as above.
      regular: "Moul-Regular.ttf",
    },
  },
  // Everything below was sourced from Google Fonts' own static per-weight builds (served from
  // fonts.gstatic.com, the same real files a browser's `@import` of a Google Fonts CSS URL resolves
  // to) rather than the google/fonts GitHub repo directly — most mainstream families there have
  // migrated to variable-only sources, which this registry's own top-of-file comment already
  // explains can't work here (no discrete weight file for `drawtext` to point at). Every entry below
  // was individually confirmed to have a real, separate static file for each style it lists.
  {
    id: "roboto",
    label: "Roboto",
    cssFamily: "VCutRoboto",
    files: {
      regular: "Roboto-Regular.ttf",
      bold: "Roboto-Bold.ttf",
      italic: "Roboto-Italic.ttf",
      boldItalic: "Roboto-BoldItalic.ttf",
    },
  },
  {
    id: "opensans",
    label: "Open Sans",
    cssFamily: "VCutOpenSans",
    files: {
      regular: "OpenSans-Regular.ttf",
      bold: "OpenSans-Bold.ttf",
      italic: "OpenSans-Italic.ttf",
      boldItalic: "OpenSans-BoldItalic.ttf",
    },
  },
  {
    id: "inter",
    label: "Inter",
    cssFamily: "VCutInter",
    files: {
      regular: "Inter-Regular.ttf",
      bold: "Inter-Bold.ttf",
      italic: "Inter-Italic.ttf",
      boldItalic: "Inter-BoldItalic.ttf",
    },
  },
  {
    id: "montserrat",
    label: "Montserrat",
    cssFamily: "VCutMontserrat",
    files: {
      regular: "Montserrat-Regular.ttf",
      bold: "Montserrat-Bold.ttf",
      italic: "Montserrat-Italic.ttf",
      boldItalic: "Montserrat-BoldItalic.ttf",
    },
  },
  {
    id: "poppins",
    label: "Poppins",
    cssFamily: "VCutPoppins",
    files: {
      regular: "Poppins-Regular.ttf",
      bold: "Poppins-Bold.ttf",
      italic: "Poppins-Italic.ttf",
      boldItalic: "Poppins-BoldItalic.ttf",
    },
  },
  {
    id: "nunito",
    label: "Nunito",
    cssFamily: "VCutNunito",
    files: {
      regular: "Nunito-Regular.ttf",
      bold: "Nunito-Bold.ttf",
      italic: "Nunito-Italic.ttf",
      boldItalic: "Nunito-BoldItalic.ttf",
    },
  },
  {
    id: "raleway",
    label: "Raleway",
    cssFamily: "VCutRaleway",
    files: {
      regular: "Raleway-Regular.ttf",
      bold: "Raleway-Bold.ttf",
      italic: "Raleway-Italic.ttf",
      boldItalic: "Raleway-BoldItalic.ttf",
    },
  },
  {
    id: "worksans",
    label: "Work Sans",
    cssFamily: "VCutWorkSans",
    files: {
      regular: "WorkSans-Regular.ttf",
      bold: "WorkSans-Bold.ttf",
      italic: "WorkSans-Italic.ttf",
      boldItalic: "WorkSans-BoldItalic.ttf",
    },
  },
  {
    id: "merriweather",
    label: "Merriweather",
    cssFamily: "VCutMerriweather",
    files: {
      regular: "Merriweather-Regular.ttf",
      bold: "Merriweather-Bold.ttf",
      italic: "Merriweather-Italic.ttf",
      boldItalic: "Merriweather-BoldItalic.ttf",
    },
  },
  {
    id: "playfairdisplay",
    label: "Playfair Display",
    cssFamily: "VCutPlayfairDisplay",
    files: {
      regular: "PlayfairDisplay-Regular.ttf",
      bold: "PlayfairDisplay-Bold.ttf",
      italic: "PlayfairDisplay-Italic.ttf",
      boldItalic: "PlayfairDisplay-BoldItalic.ttf",
    },
  },
  {
    id: "lora",
    label: "Lora",
    cssFamily: "VCutLora",
    files: {
      regular: "Lora-Regular.ttf",
      bold: "Lora-Bold.ttf",
      italic: "Lora-Italic.ttf",
      boldItalic: "Lora-BoldItalic.ttf",
    },
  },
  {
    id: "oswald",
    label: "Oswald",
    cssFamily: "VCutOswald",
    files: {
      regular: "Oswald-Regular.ttf",
      bold: "Oswald-Bold.ttf",
    },
  },
  {
    id: "bebasneue",
    label: "Bebas Neue",
    cssFamily: "VCutBebasNeue",
    files: {
      regular: "BebasNeue-Regular.ttf",
    },
  },
  {
    id: "anton",
    label: "Anton",
    cssFamily: "VCutAnton",
    files: {
      regular: "Anton-Regular.ttf",
    },
  },
  {
    id: "pacifico",
    label: "Pacifico (script)",
    cssFamily: "VCutPacifico",
    files: {
      regular: "Pacifico-Regular.ttf",
    },
  },
  {
    id: "caveat",
    label: "Caveat (handwriting)",
    cssFamily: "VCutCaveat",
    files: {
      regular: "Caveat-Regular.ttf",
      bold: "Caveat-Bold.ttf",
    },
  },
  {
    id: "hanuman",
    label: "Hanuman (Khmer)",
    cssFamily: "VCutHanuman",
    files: {
      regular: "Hanuman-Regular.ttf",
      bold: "Hanuman-Bold.ttf",
    },
  },
  {
    id: "kantumruypro",
    label: "Kantumruy Pro (Khmer)",
    cssFamily: "VCutKantumruyPro",
    files: {
      regular: "KantumruyPro-Regular.ttf",
      bold: "KantumruyPro-Bold.ttf",
      italic: "KantumruyPro-Italic.ttf",
      boldItalic: "KantumruyPro-BoldItalic.ttf",
    },
  },
  {
    id: "koulen",
    label: "Koulen (Khmer display)",
    cssFamily: "VCutKoulen",
    files: {
      regular: "Koulen-Regular.ttf",
    },
  },
  {
    id: "bokor",
    label: "Bokor (Khmer display)",
    cssFamily: "VCutBokor",
    files: {
      regular: "Bokor-Regular.ttf",
    },
  },
  {
    id: "angkor",
    label: "Angkor (Khmer display)",
    cssFamily: "VCutAngkor",
    files: {
      regular: "Angkor-Regular.ttf",
    },
  },
  {
    id: "dangrek",
    label: "Dangrek (Khmer display)",
    cssFamily: "VCutDangrek",
    files: {
      regular: "Dangrek-Regular.ttf",
    },
  },
  {
    id: "siemreap",
    label: "Siemreap (Khmer)",
    cssFamily: "VCutSiemreap",
    files: {
      regular: "Siemreap-Regular.ttf",
    },
  },
  {
    id: "suwannaphum",
    label: "Suwannaphum (Khmer)",
    cssFamily: "VCutSuwannaphum",
    files: {
      regular: "Suwannaphum-Regular.ttf",
      bold: "Suwannaphum-Bold.ttf",
    },
  },
  {
    id: "moulpali",
    label: "Moulpali (Khmer display)",
    cssFamily: "VCutMoulpali",
    files: {
      regular: "Moulpali-Regular.ttf",
    },
  },
  {
    id: "nokora",
    label: "Nokora (Khmer)",
    cssFamily: "VCutNokora",
    files: {
      regular: "Nokora-Regular.ttf",
      bold: "Nokora-Bold.ttf",
    },
  },
  {
    id: "content",
    label: "Content (Khmer)",
    cssFamily: "VCutContent",
    files: {
      regular: "Content-Regular.ttf",
      bold: "Content-Bold.ttf",
    },
  },
  {
    id: "fasthand",
    label: "Fasthand (Khmer script)",
    cssFamily: "VCutFasthand",
    files: {
      regular: "Fasthand-Regular.ttf",
    },
  },
  {
    id: "chenla",
    label: "Chenla (Khmer display)",
    cssFamily: "VCutChenla",
    files: {
      regular: "Chenla-Regular.ttf",
    },
  },
  {
    id: "metal",
    label: "Metal (Khmer display)",
    cssFamily: "VCutMetal",
    files: {
      regular: "Metal-Regular.ttf",
    },
  },
  {
    id: "preahvihear",
    label: "Preahvihear (Khmer display)",
    cssFamily: "VCutPreahvihear",
    files: {
      regular: "Preahvihear-Regular.ttf",
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

/** Tracks which fonts `preloadFont` has already kicked off a load for, so hovering the same option
 *  repeatedly (or the app-wide warm-up below re-running per component mount) doesn't re-request an
 *  already-loading/loaded face over and over. Module-scope, not per-component state — the browser's
 *  own font cache is also global, so there's nothing to gain from tracking this any more narrowly. */
const preloadedFontIds = new Set<string>();

/** Explicitly loads every face a font actually ships, via the CSS Font Loading API
 *  (`document.fonts.load`) — needed because `@font-face` + `font-display: swap` alone does NOT
 *  reliably trigger a fetch for a family that's only ever consumed through `<canvas>` `fillText`
 *  (`PlaybackEngine`'s `computeTextBlock`/`drawText`, the ONLY place any of these fonts are actually
 *  used — none of them are applied to a real DOM element anywhere in this app). A DOM element with
 *  `font-family` set forces the browser to resolve and fetch the face as part of layout; a bare
 *  `context.font = ...` assignment does not carry the same guarantee across engines — confirmed as the
 *  actual cause of "some fonts don't render" (silently falling back to the browser default font,
 *  forever, for a family Canvas never bothered to fetch) rather than a broken/missing font file.
 *  `document.fonts.load` resolves once the browser has genuinely fetched and parsed the face, after
 *  which `PlaybackEngine`'s own continuous per-frame redraw picks it up on the very next frame with no
 *  further action needed here — this function only needs to kick the fetch off, not orchestrate a
 *  repaint. Safe to call from anywhere (a no-op on the server, where `document` doesn't exist) and
 *  safe to call repeatedly (the module-scope `preloadedFontIds` set below short-circuits repeats, and
 *  `document.fonts.load` itself is idempotent regardless). */
export function preloadFont(font: FontDefinition): void {
  if (typeof document === "undefined" || !document.fonts) return;
  if (preloadedFontIds.has(font.id)) return;
  preloadedFontIds.add(font.id);

  const specs: string[] = [`400 16px "${font.cssFamily}"`];
  if (font.files.bold) specs.push(`700 16px "${font.cssFamily}"`);
  if (font.files.italic) specs.push(`italic 400 16px "${font.cssFamily}"`);
  if (font.files.boldItalic) specs.push(`italic 700 16px "${font.cssFamily}"`);

  for (const spec of specs) {
    document.fonts.load(spec).catch(() => {
      // A failed fetch (offline, a server hiccup) just leaves the fallback font showing — not worth
      // surfacing as an error for what's a cosmetic-only concern, and retrying eagerly here would just
      // hammer a server that's already failing. `preloadedFontIds` is deliberately NOT rolled back on
      // failure, matching that "don't retry aggressively" choice.
    });
  }
}

/** Kicks off `preloadFont` for every registered font — called once, app-wide, so by the time a user
 *  opens the font picker every option is already loading (or loaded) rather than starting cold on
 *  first hover/selection. Hovering/selecting a font still calls `preloadFont` too (belt-and-suspenders
 *  for a picker opened before this had a chance to run, e.g. immediately on a slow connection). */
export function preloadAllFonts(): void {
  for (const font of FONT_REGISTRY) preloadFont(font);
}

export interface AssFontMetrics {
  /** The font's real internal family name (`name` table, nameID 1, Windows/en-US preferred) — what an
   *  ASS subtitle's `Style: Fontname` field must contain for libass/fontconfig to resolve this exact
   *  bundled file via `subtitles=...:fontsdir=...` (see `buildExportPlan.ts`'s `wordHighlight` export
   *  path, the one place this app renders text through libass instead of `drawtext`). `FontDefinition
   *  .cssFamily` is an app-invented alias that only exists inside this app's own `@font-face` rules —
   *  it has no relationship to what's actually stored in the file, so it can't be reused here. Verified
   *  empirically that every bundled font's own weight/style files (regular/bold/italic/boldItalic) all
   *  share this SAME family string (only the `name` table's separate subfamily field differs) — so one
   *  read against any one file speaks for the whole family, and fontconfig's own directory scan (via
   *  `fontsdir=`) is what picks the right FILE for a requested Bold/Italic combination from there. */
  family: string;
  /** Multiply `TextStyle.fontSize` by this before using it as an ASS `Fontsize` value. libass does NOT
   *  treat `Fontsize` as a literal em-square pixel size the way `drawtext`'s own `fontsize=` is (a
   *  direct `FT_Set_Pixel_Sizes` call) — it scales against the font's OWN OS/2 Windows ascent+descent
   *  instead, so the identical nominal number renders at a very different visual size depending on the
   *  font. Reverse-engineered by rendering the same sample text through both `drawtext` and libass at a
   *  reference size and comparing pixel heights (Lato needed ~1.42x, Battambang ~1.59x, Metal ~2.33x to
   *  visually match `drawtext`), then confirmed as `(OS/2.usWinAscent + OS/2.usWinDescent) /
   *  head.unitsPerEm` by checking that formula reproduces the measured ratio (within ~1%) for every
   *  font tested — computed here directly from the font's own tables rather than hand-calibrated per
   *  font, so it stays correct for any font this registry ever adds without needing a matching accuracy
   *  pass. Without this correction, `wordHighlight` export text would render at an inconsistent, usually
   *  much SMALLER size than the same `TextStyle.fontSize` produces everywhere else in this app. */
  fontsizeScale: number;
}

/** Reads a TTF/OTF's `name`/`head`/`OS/2` tables directly from its raw bytes — pure binary parsing, no
 *  filesystem access, so this works identically whether the caller got `buffer` via `fs.readFileSync`
 *  (server export) or a Capacitor `Filesystem` read decoded to bytes (native export). Deliberately NOT
 *  a filesystem-touching function itself (unlike `fontFileFor`'s siblings) — `buildExportPlan.ts` stays
 *  fs-free by design (see its own `ExportPlanOptions` comment), so this is called by whichever caller
 *  already has the bytes and handed the RESULT in via `ExportPlanOptions.fontMetricsFor`, not called
 *  from within `buildExportPlan.ts` itself. Returns `null` for anything that doesn't parse as a
 *  well-formed sfnt font (missing `name`/`head`/`OS/2` tables) rather than throwing — a font this
 *  registry already validated as real should never hit that path, but a corrupted read shouldn't crash
 *  export over what's ultimately a cosmetic sizing detail. */
export function readAssFontMetrics(buffer: Uint8Array): AssFontMetrics | null {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (buffer.length < 12) return null;
  const numTables = view.getUint16(4);

  function findTable(tag: string): { offset: number; length: number } | null {
    for (let i = 0; i < numTables; i++) {
      const recOffset = 12 + i * 16;
      if (recOffset + 16 > buffer.length) return null;
      let recTag = "";
      for (let j = 0; j < 4; j++) recTag += String.fromCharCode(buffer[recOffset + j]);
      if (recTag === tag) return { offset: view.getUint32(recOffset + 8), length: view.getUint32(recOffset + 12) };
    }
    return null;
  }

  const nameTable = findTable("name");
  const headTable = findTable("head");
  const os2Table = findTable("OS/2");
  if (!nameTable || !headTable || !os2Table) return null;

  // `name` table: a flat array of (platform, encoding, language, nameID, string) records sharing one
  // trailing string-data block — nameID 1 is "Font Family Name". Windows-platform (3), US-English
  // (0x409) records store their strings as big-endian UTF-16, which is what needs decoding here;
  // anything else (rare in practice for these bundled files) falls back to a byte-per-character read,
  // matching this same registry's dev-time extraction tooling.
  const nameCount = view.getUint16(nameTable.offset + 2);
  const stringAreaOffset = nameTable.offset + view.getUint16(nameTable.offset + 4);
  let family: string | null = null;
  let fallbackFamily: string | null = null;
  for (let i = 0; i < nameCount; i++) {
    const recOffset = nameTable.offset + 6 + i * 12;
    const platformID = view.getUint16(recOffset);
    const languageID = view.getUint16(recOffset + 4);
    const nameID = view.getUint16(recOffset + 6);
    if (nameID !== 1) continue;
    const length = view.getUint16(recOffset + 8);
    const strOffset = stringAreaOffset + view.getUint16(recOffset + 10);
    let str: string;
    if (platformID === 3 || platformID === 0) {
      const chars: string[] = [];
      for (let b = 0; b + 1 < length; b += 2) chars.push(String.fromCharCode(view.getUint16(strOffset + b)));
      str = chars.join("");
    } else {
      let s = "";
      for (let b = 0; b < length; b++) s += String.fromCharCode(buffer[strOffset + b]);
      str = s;
    }
    if (platformID === 3 && languageID === 0x409) family = str;
    else fallbackFamily ??= str;
  }
  const resolvedFamily = family ?? fallbackFamily;
  if (!resolvedFamily) return null;

  const unitsPerEm = view.getUint16(headTable.offset + 18);
  const winAscent = view.getUint16(os2Table.offset + 74);
  const winDescent = view.getUint16(os2Table.offset + 76);
  if (unitsPerEm <= 0) return null;

  return { family: resolvedFamily, fontsizeScale: (winAscent + winDescent) / unitsPerEm };
}
