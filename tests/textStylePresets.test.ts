import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_TEXT_STYLE } from "../src/project/types.ts";
import { applyTextStylePreset, TEXT_STYLE_PRESETS } from "../src/project/textStylePresets.ts";

describe("applyTextStylePreset", () => {
  it("sets color and bold from the preset", () => {
    const preset = TEXT_STYLE_PRESETS.find((p) => p.id === "bold-caption")!;
    const result = applyTextStylePreset(DEFAULT_TEXT_STYLE, preset);
    assert.equal(result.color, "#ffffff");
    assert.equal(result.bold, true);
  });

  it("sets strokeColor/strokeWidth when the preset defines them", () => {
    const preset = TEXT_STYLE_PRESETS.find((p) => p.id === "bold-caption")!;
    const result = applyTextStylePreset(DEFAULT_TEXT_STYLE, preset);
    assert.equal(result.strokeColor, "#000000");
    assert.equal(result.strokeWidth, 4);
  });

  it("clears strokeColor when switching to a preset that doesn't define one", () => {
    const withStroke = applyTextStylePreset(DEFAULT_TEXT_STYLE, TEXT_STYLE_PRESETS.find((p) => p.id === "bold-caption")!);
    assert.ok(withStroke.strokeColor);

    const cleared = applyTextStylePreset(withStroke, TEXT_STYLE_PRESETS.find((p) => p.id === "clean-white")!);
    assert.equal(cleared.strokeColor, undefined);
    assert.ok(!("strokeColor" in cleared));
  });

  it("clears backgroundColor/shadowColor the same way when a preset doesn't define them", () => {
    const withBg = applyTextStylePreset(DEFAULT_TEXT_STYLE, TEXT_STYLE_PRESETS.find((p) => p.id === "subtitle-box")!);
    assert.ok(withBg.backgroundColor);
    const clearedBg = applyTextStylePreset(withBg, TEXT_STYLE_PRESETS.find((p) => p.id === "clean-white")!);
    assert.ok(!("backgroundColor" in clearedBg));

    const withShadow = applyTextStylePreset(DEFAULT_TEXT_STYLE, TEXT_STYLE_PRESETS.find((p) => p.id === "soft-shadow")!);
    assert.ok(withShadow.shadowColor);
    const clearedShadow = applyTextStylePreset(withShadow, TEXT_STYLE_PRESETS.find((p) => p.id === "clean-white")!);
    assert.ok(!("shadowColor" in clearedShadow));
  });

  it("never touches fontFamily, fontSize, align, or position", () => {
    const base = { ...DEFAULT_TEXT_STYLE, fontFamily: "moul", fontSize: 88, align: "left" as const, offsetX: 12, offsetY: -5 };
    const result = applyTextStylePreset(base, TEXT_STYLE_PRESETS.find((p) => p.id === "neon-pink")!);
    assert.equal(result.fontFamily, "moul");
    assert.equal(result.fontSize, 88);
    assert.equal(result.align, "left");
    assert.equal(result.offsetX, 12);
    assert.equal(result.offsetY, -5);
  });

  it("every preset id is unique", () => {
    const ids = TEXT_STYLE_PRESETS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});
