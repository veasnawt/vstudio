import type { TextStyle } from "./types.ts";

/** A quick-apply "look" for a text clip — color plus whichever of background/outline/shadow it wants,
 *  deliberately NOT touching `fontFamily`/`fontSize`/`align`/position: those are independent choices
 *  (which font, how big, where) a preset shouldn't silently override just because the user liked its
 *  color scheme. `bold` IS included — it reads as part of a look ("Bold Caption" vs "Clean White") the
 *  same way CapCut/TikTok-style caption presets treat it, not a separate structural choice the way font
 *  itself is. */
export interface TextStylePreset {
  id: string;
  label: string;
  color: string;
  bold: boolean;
  backgroundColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  shadowColor?: string;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
}

export const TEXT_STYLE_PRESETS: TextStylePreset[] = [
  { id: "clean-white", label: "Clean White", color: "#ffffff", bold: false },
  { id: "minimal-black", label: "Minimal Black", color: "#000000", bold: false },
  { id: "bold-caption", label: "Bold Caption", color: "#ffffff", bold: true, strokeColor: "#000000", strokeWidth: 4 },
  { id: "comic-bold", label: "Comic Bold", color: "#ffffff", bold: true, strokeColor: "#000000", strokeWidth: 6 },
  { id: "karaoke", label: "Karaoke", color: "#ffe600", bold: false, strokeColor: "#000000", strokeWidth: 3 },
  { id: "subtitle-box", label: "Subtitle Box", color: "#ffffff", bold: false, backgroundColor: "#141414" },
  { id: "yellow-highlight", label: "Yellow Highlight", color: "#000000", bold: true, backgroundColor: "#ffe600" },
  { id: "soft-shadow", label: "Soft Shadow", color: "#ffffff", bold: false, shadowColor: "#000000", shadowOffsetX: 3, shadowOffsetY: 3 },
  { id: "neon-pink", label: "Neon Pink", color: "#ff2fb0", bold: true, shadowColor: "#ff2fb0", shadowOffsetX: 0, shadowOffsetY: 0 },
  { id: "ocean-blue", label: "Ocean Blue", color: "#00d4ff", bold: false, strokeColor: "#003347", strokeWidth: 2 },
  { id: "red-alert", label: "Red Alert", color: "#ff3b30", bold: true, strokeColor: "#000000", strokeWidth: 3 },
  { id: "gold-elegant", label: "Gold Elegant", color: "#ffd700", bold: false, strokeColor: "#3a2a00", strokeWidth: 2 },
];

/** Applies `preset` onto `current`, producing a new `TextStyle` — the one place a preset's optional
 *  fields (`backgroundColor`/`strokeColor`/`shadowColor`) get turned into real presence/absence on the
 *  result: a preset that DOESN'T set one of them explicitly CLEARS it from `current` (deletes the key,
 *  never leaves a stale `undefined` sitting there — matching this codebase's own "absent, not
 *  undefined" convention for every other optional field), rather than a plain object spread leaving
 *  whatever the clip already had untouched. Picking a preset is meant to fully replace the look, not
 *  layer on top of one already there. */
export function applyTextStylePreset(current: TextStyle, preset: TextStylePreset): TextStyle {
  const next: TextStyle = { ...current, color: preset.color, bold: preset.bold };

  if (preset.backgroundColor) next.backgroundColor = preset.backgroundColor;
  else delete next.backgroundColor;

  if (preset.strokeColor) {
    next.strokeColor = preset.strokeColor;
    next.strokeWidth = preset.strokeWidth ?? next.strokeWidth;
  } else {
    delete next.strokeColor;
  }

  if (preset.shadowColor) {
    next.shadowColor = preset.shadowColor;
    next.shadowOffsetX = preset.shadowOffsetX ?? next.shadowOffsetX;
    next.shadowOffsetY = preset.shadowOffsetY ?? next.shadowOffsetY;
  } else {
    delete next.shadowColor;
  }

  return next;
}
