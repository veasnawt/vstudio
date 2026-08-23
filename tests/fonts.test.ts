import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { FONT_REGISTRY, fontById, fontFileFor, readAssFontMetrics, resolveFontVariant } from "../src/project/fonts.ts";

const FONTS_DIR = path.resolve(import.meta.dirname, "..", "assets", "fonts");
function readFontBuffer(fileName: string): Buffer {
  return fs.readFileSync(path.join(FONTS_DIR, fileName));
}

describe("FONT_REGISTRY", () => {
  it("every entry has a real regular file and a unique id/cssFamily", () => {
    const ids = new Set<string>();
    const families = new Set<string>();
    for (const font of FONT_REGISTRY) {
      assert.ok(font.files.regular, `${font.id} must have a regular file`);
      assert.ok(!ids.has(font.id), `duplicate font id: ${font.id}`);
      assert.ok(!families.has(font.cssFamily), `duplicate cssFamily: ${font.cssFamily}`);
      ids.add(font.id);
      families.add(font.cssFamily);
    }
  });

  it("includes at least one Khmer font", () => {
    assert.ok(FONT_REGISTRY.some((f) => f.label.toLowerCase().includes("khmer")));
  });
});

describe("fontById", () => {
  it("finds a font by its id", () => {
    assert.equal(fontById("battambang").label, "Battambang (Khmer)");
  });

  it("falls back to the first (default) font for an unknown id", () => {
    assert.equal(fontById("does-not-exist").id, FONT_REGISTRY[0].id);
    assert.equal(fontById("").id, FONT_REGISTRY[0].id);
  });
});

describe("resolveFontVariant", () => {
  const lato = fontById("lato"); // has regular, bold, italic, boldItalic
  const battambang = fontById("battambang"); // has regular, bold — no italic
  const moul = fontById("moul"); // regular only

  it("resolves exactly what was asked for when every face exists (lato)", () => {
    assert.deepEqual(resolveFontVariant(lato, false, false), { bold: false, italic: false });
    assert.deepEqual(resolveFontVariant(lato, true, false), { bold: true, italic: false });
    assert.deepEqual(resolveFontVariant(lato, false, true), { bold: false, italic: true });
    assert.deepEqual(resolveFontVariant(lato, true, true), { bold: true, italic: true });
  });

  it("falls back to bold (not italic) when bold+italic is requested but only bold exists (battambang)", () => {
    assert.deepEqual(resolveFontVariant(battambang, true, true), { bold: true, italic: false });
  });

  it("drops a request for a missing italic face, keeping bold if that exists (battambang)", () => {
    assert.deepEqual(resolveFontVariant(battambang, false, true), { bold: false, italic: false });
    assert.deepEqual(resolveFontVariant(battambang, true, false), { bold: true, italic: false });
  });

  it("drops every style request for a single-weight font (moul)", () => {
    assert.deepEqual(resolveFontVariant(moul, true, false), { bold: false, italic: false });
    assert.deepEqual(resolveFontVariant(moul, false, true), { bold: false, italic: false });
    assert.deepEqual(resolveFontVariant(moul, true, true), { bold: false, italic: false });
  });
});

describe("fontFileFor", () => {
  const lato = fontById("lato");
  const battambang = fontById("battambang");
  const moul = fontById("moul");

  it("returns the exact file for every combination lato has", () => {
    assert.equal(fontFileFor(lato, false, false), "Lato-Regular.ttf");
    assert.equal(fontFileFor(lato, true, false), "Lato-Bold.ttf");
    assert.equal(fontFileFor(lato, false, true), "Lato-Italic.ttf");
    assert.equal(fontFileFor(lato, true, true), "Lato-BoldItalic.ttf");
  });

  it("always resolves to a file that actually exists in the font's own registry entry, even for missing faces", () => {
    for (const font of [lato, battambang, moul]) {
      for (const bold of [false, true]) {
        for (const italic of [false, true]) {
          const file = fontFileFor(font, bold, italic);
          assert.ok(Object.values(font.files).includes(file), `${font.id} bold=${bold} italic=${italic} -> ${file}`);
        }
      }
    }
  });

  it("moul (single weight) always resolves to its regular file", () => {
    assert.equal(fontFileFor(moul, true, true), "Moul-Regular.ttf");
  });
});

describe("readAssFontMetrics", () => {
  it("reads a font's real family name off its own name table (lato)", () => {
    const metrics = readAssFontMetrics(readFontBuffer("Lato-Regular.ttf"));
    assert.equal(metrics?.family, "Lato");
  });

  it("reads a Khmer font's family name correctly too (battambang)", () => {
    const metrics = readAssFontMetrics(readFontBuffer("Battambang-Regular.ttf"));
    assert.equal(metrics?.family, "Battambang");
  });

  it("every registered font's regular file parses to a non-empty family and a positive fontsize scale", () => {
    for (const font of FONT_REGISTRY) {
      const metrics = readAssFontMetrics(readFontBuffer(font.files.regular));
      assert.ok(metrics, `${font.id} should parse`);
      assert.ok(metrics!.family.length > 0, `${font.id} should have a non-empty family name`);
      assert.ok(metrics!.fontsizeScale > 0, `${font.id} should have a positive fontsize scale`);
    }
  });

  it("a font's own weight/style files all report the SAME family name (fontconfig groups them by it)", () => {
    // Only fonts with more than one file are meaningful here — a single-weight font has nothing to
    // compare against. Confirmed empirically for the whole registry before this feature was built; this
    // guards against a future font addition silently breaking that assumption.
    for (const font of FONT_REGISTRY) {
      const variants = Object.values(font.files).filter((f): f is string => Boolean(f));
      if (variants.length < 2) continue;
      const names = variants.map((file) => readAssFontMetrics(readFontBuffer(file))?.family);
      const unique = new Set(names);
      assert.equal(unique.size, 1, `${font.id}'s weight/style files should share one family name, got ${JSON.stringify(names)}`);
    }
  });

  it("returns null for bytes that aren't a well-formed font", () => {
    assert.equal(readAssFontMetrics(new Uint8Array([1, 2, 3, 4])), null);
  });
});
