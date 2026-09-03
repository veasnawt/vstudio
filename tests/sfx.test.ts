import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { SFX_REGISTRY, sfxById } from "../src/project/sfx.ts";

const SFX_DIR = path.resolve(import.meta.dirname, "..", "assets", "sfx");

describe("SFX_REGISTRY", () => {
  it("every entry has a unique id", () => {
    const ids = new Set<string>();
    for (const sfx of SFX_REGISTRY) {
      assert.ok(!ids.has(sfx.id), `duplicate sfx id: ${sfx.id}`);
      ids.add(sfx.id);
    }
  });

  it("every entry's file genuinely exists on disk — the registry never lies about what it ships", () => {
    for (const sfx of SFX_REGISTRY) {
      const filePath = path.join(SFX_DIR, sfx.file);
      assert.ok(fs.existsSync(filePath), `${sfx.id} points at a missing file: ${filePath}`);
    }
  });

  it("covers every category the panel groups by", () => {
    const categories = new Set(SFX_REGISTRY.map((s) => s.category));
    for (const category of ["UI", "Whoosh", "Impact", "Riser", "Chime", "Ambience", "Meme"] as const) {
      assert.ok(categories.has(category), `no registry entry uses category "${category}"`);
    }
  });
});

describe("sfxById", () => {
  it("finds an entry by its id", () => {
    assert.equal(sfxById("click-soft")?.label, "Click (Soft)");
  });

  it("returns undefined for an unknown id — no lenient fallback, unlike fontById", () => {
    assert.equal(sfxById("does-not-exist"), undefined);
    assert.equal(sfxById(""), undefined);
  });
});
