import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FONT_REGISTRY, fontById, fontFileFor, resolveFontVariant } from "../src/project/fonts.ts";

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
