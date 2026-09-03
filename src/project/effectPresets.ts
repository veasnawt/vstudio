import type { ClipEffects } from "./types.ts";

/** A quick-apply combination of `ClipEffects`' own existing sliders (brightness/contrast/saturation/
 *  blur) — deliberately NOT a new pixel-level filter type: this app's `ClipEffects` has no notion of
 *  color temperature/tint, grayscale, or sepia, so preset names describe what brightness/contrast/
 *  saturation/blur can actually produce rather than promising a look they can't deliver. `opacity` is
 *  left untouched by every preset — same "independent choice a preset shouldn't silently override"
 *  reasoning `TextStylePreset`'s own doc comment gives for `fontFamily`/`fontSize`/`align`. Applying one
 *  goes through the exact same `SetClipEffectsCommand`/`patchEffects` path a manual slider drag already
 *  does, so the sliders stay fully adjustable afterward — a preset is just a fast starting point, not a
 *  separate mechanism. */
export interface EffectPreset {
  id: string;
  label: string;
  values: Partial<ClipEffects>;
}

export const EFFECT_PRESETS: EffectPreset[] = [
  { id: "vivid", label: "Vivid", values: { brightness: 0.03, contrast: 1.15, saturation: 1.4 } },
  { id: "punchy", label: "Punchy", values: { contrast: 1.3, saturation: 1.3 } },
  { id: "high-contrast", label: "High Contrast", values: { contrast: 1.5, saturation: 1.1 } },
  { id: "muted", label: "Muted", values: { contrast: 0.95, saturation: 0.55 } },
  { id: "faded", label: "Faded", values: { brightness: 0.08, contrast: 0.75, saturation: 0.7 } },
  { id: "moody", label: "Moody", values: { brightness: -0.08, contrast: 1.2, saturation: 0.65 } },
  { id: "bright-airy", label: "Bright & Airy", values: { brightness: 0.15, contrast: 0.95, saturation: 0.9 } },
  { id: "soft-focus", label: "Soft Focus", values: { brightness: 0.05, blur: 3 } },
  // Four more, each covering a combination none of the eight above actually reaches: Noir goes far
  // more desaturated than anything else here (the lowest existing saturation, Muted's, is still 0.55);
  // Crisp is the only preset that leaves saturation completely untouched — a pure contrast/brightness
  // lift for footage whose color is already right; Flat is a deliberately gentle contrast pull for a
  // log-like starting point, distinct from Faded's stronger, warmer-reading fade; Dreamy is the only
  // preset combining a soft/bright look WITH blur (Soft Focus has blur but no contrast/brightness
  // pairing, Bright & Airy has the brightness/contrast pairing but no blur).
  { id: "noir", label: "Noir", values: { contrast: 1.3, saturation: 0.15 } },
  { id: "crisp", label: "Crisp", values: { contrast: 1.2, brightness: 0.02 } },
  { id: "flat", label: "Flat", values: { contrast: 0.65, saturation: 0.85 } },
  { id: "dreamy", label: "Dreamy", values: { brightness: 0.12, contrast: 0.85, blur: 2 } },
];
