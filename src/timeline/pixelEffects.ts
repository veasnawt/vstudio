import type { PixelEffectType } from "../project/types.ts";

/** Every `PixelEffectType`, in the order shown in the picker — mirrors `TEXT_ANIMATION_TYPE_OPTIONS`'s
 *  own role as the one shared source of truth a UI iterates rather than hardcoding its own copy of the
 *  union's values. */
export const PIXEL_EFFECT_TYPE_OPTIONS: PixelEffectType[] = ["glitch", "waterRipple"];

export const PIXEL_EFFECT_TYPE_LABEL: Record<PixelEffectType, string> = {
  glitch: "Glitch",
  waterRipple: "Water Ripple",
};

// Exported (not just used locally) so `buildExportPlan.ts` can build the exact same expressions as
// FFmpeg-level `geq=`/`rgbashift=`/`noise=` parameters — export and preview sharing these numbers
// directly rules out the two ever silently drifting apart, same reasoning `BOUNCE_AMPLITUDE_PX` et al.
// (`timeline/textAnimation.ts`) already document.
export const WATER_RIPPLE_AMPLITUDE_PX = 10;
export const WATER_RIPPLE_WAVELENGTH_PX = 180;
export const WATER_RIPPLE_PERIOD_SECONDS = 2.5;

export const GLITCH_BURST_PERIOD_SECONDS = 0.4;
export const GLITCH_SHIFT_PX = 8;
export const GLITCH_NOISE_AMOUNT = 24;
export const GLITCH_NOISE_DENSITY = 0.06;
export const GLITCH_SLICE_COUNT = 2;
export const GLITCH_SLICE_BAND_HEIGHT_FRACTION = 0.08;

/** A deterministic, seedable pseudo-random value in `[0, 1)` — the classic GLSL-shader hash trick
 *  (`sin(seed * big-irrational) * big-number`, fractional part). NOT `Math.random()`: a pixel effect
 *  must be a pure function of `elapsedSeconds` alone (same "scrubbing backward looks identical to
 *  having played forward to the same instant" determinism `computeTextAnimationTransform`'s own doc
 *  comment establishes for text animations) — a real RNG would make the glitch look different every
 *  single frame redraw, including two redraws of the exact same paused instant. */
function pseudoRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** Mutates `imageData` in place with a sine-wave horizontal displacement that varies by row AND by
 *  time — a wavy, underwater-reflection look. Direct port of the `geq` recipe empirically verified
 *  against this repo's bundled ffmpeg: `p(X + amplitude*sin(Y/wavelength + T*rate), Y)`. Reads from a
 *  snapshot copy of the original pixels (not `imageData` itself) since this is a genuine spatial
 *  REMAP — unlike `applyChromaKey`/`applyColorGrading`/`applyLut3D`, which are per-pixel-independent
 *  and can safely read-then-write the same buffer, a row here reads from a DIFFERENT x than it writes,
 *  so an in-place walk would read pixels this same call already overwrote.
 *
 *  `intensity` scales the amplitude ON TOP OF the per-clip `speed`-driven phase — `1` (the default)
 *  is the ordinary per-clip "Pixel FX" strength, every existing call site's behavior unchanged;
 *  `0` is an exact no-op (every sample lands back on its own `x`); used by the water-ripple TRANSITION
 *  style (`PlaybackEngine.compositeTransitionFrame`) to ramp the distortion up then back down across
 *  the blend window instead of a flat full-strength wobble for the whole cut. */
export function applyWaterRipple(imageData: ImageData, elapsedSeconds: number, speed = 1, intensity = 1): void {
  const { width, height, data } = imageData;
  const source = data.slice();
  const rate = (2 * Math.PI) / WATER_RIPPLE_PERIOD_SECONDS;
  const phase = elapsedSeconds * speed * rate;
  for (let y = 0; y < height; y++) {
    const offset = WATER_RIPPLE_AMPLITUDE_PX * intensity * Math.sin(y / WATER_RIPPLE_WAVELENGTH_PX + phase);
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x++) {
      // Clamped, not wrapped, at the left/right edges — a wrapped sample would smear the OPPOSITE
      // edge's color in, visibly wrong; a clamped one just stretches the nearest real edge pixel,
      // the same "reasonable, not exact" tradeoff FFmpeg's own default `geq` boundary handling makes.
      let sampleX = Math.round(x + offset);
      if (sampleX < 0) sampleX = 0;
      else if (sampleX >= width) sampleX = width - 1;
      const from = rowStart + sampleX * 4;
      const to = rowStart + x * 4;
      data[to] = source[from];
      data[to + 1] = source[from + 1];
      data[to + 2] = source[from + 2];
      data[to + 3] = source[from + 3];
    }
  }
}

/** Mutates `imageData` in place with a digital-corruption look: a per-frame RGB channel split (jumps
 *  between bursts, doesn't smoothly oscillate — a sudden jump reads as "glitchy", a smooth sine reads
 *  as the organic wave `applyWaterRipple` already owns), a couple of randomly-placed horizontal slice
 *  bands shifted sideways, and sparse per-pixel noise. Port of the `rgbashift`+`noise` recipe
 *  empirically verified against this repo's bundled ffmpeg. `elapsedSeconds` is quantized into
 *  discrete "burst" steps (`GLITCH_BURST_PERIOD_SECONDS`) — everything within one burst is static,
 *  matching how a real signal glitch holds for a beat rather than continuously drifting.
 *
 *  `intensity` scales every shift/jitter amount (channel split, slice displacement, noise strength) —
 *  same "1 is the ordinary per-clip default, 0 is an exact no-op" contract `applyWaterRipple`'s own
 *  `intensity` documents, for the identical reason (the glitch-cut TRANSITION style ramping the
 *  corruption across its blend window). */
export function applyGlitch(imageData: ImageData, elapsedSeconds: number, speed = 1, intensity = 1): void {
  const { width, height, data } = imageData;
  const source = data.slice();
  const burst = Math.floor((elapsedSeconds * speed) / GLITCH_BURST_PERIOD_SECONDS);

  // Channel split: R shifts one way, B shifts the other, by an amount that jumps every burst.
  const shiftR = Math.round((pseudoRandom(burst * 2) * 2 - 1) * GLITCH_SHIFT_PX * intensity);
  const shiftB = -Math.round((pseudoRandom(burst * 2 + 1) * 2 - 1) * GLITCH_SHIFT_PX * intensity);

  // Slice bands: a few short horizontal strips, each shifted sideways by its own random offset.
  const sliceBandHeight = Math.max(1, Math.round(height * GLITCH_SLICE_BAND_HEIGHT_FRACTION));
  const slices: { top: number; shift: number }[] = [];
  for (let i = 0; i < GLITCH_SLICE_COUNT; i++) {
    const top = Math.floor(pseudoRandom(burst * 7 + i * 3) * Math.max(1, height - sliceBandHeight));
    const shift = Math.round((pseudoRandom(burst * 7 + i * 3 + 1) * 2 - 1) * GLITCH_SHIFT_PX * 3 * intensity);
    slices.push({ top, shift });
  }

  function sliceShiftAt(y: number): number {
    for (const slice of slices) {
      if (y >= slice.top && y < slice.top + sliceBandHeight) return slice.shift;
    }
    return 0;
  }

  for (let y = 0; y < height; y++) {
    const rowShift = sliceShiftAt(y);
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x++) {
      const to = rowStart + x * 4;
      const clampX = (sampleX: number) => Math.min(width - 1, Math.max(0, sampleX));
      const rFrom = rowStart + clampX(x - shiftR + rowShift) * 4;
      const gFrom = rowStart + clampX(x + rowShift) * 4;
      const bFrom = rowStart + clampX(x - shiftB + rowShift) * 4;
      data[to] = source[rFrom];
      data[to + 1] = source[gFrom + 1];
      data[to + 2] = source[bFrom + 2];
      data[to + 3] = source[gFrom + 3];
      // Sparse noise — a deterministic per-pixel-per-burst hash decides both WHETHER this pixel gets
      // jittered (kept rare via `GLITCH_NOISE_DENSITY`) and by how much.
      const noiseSeed = burst * 104729 + y * width + x;
      if (pseudoRandom(noiseSeed) < GLITCH_NOISE_DENSITY) {
        const jitter = Math.round((pseudoRandom(noiseSeed + 0.5) * 2 - 1) * GLITCH_NOISE_AMOUNT * intensity);
        data[to] = Math.min(255, Math.max(0, data[to] + jitter));
        data[to + 1] = Math.min(255, Math.max(0, data[to + 1] + jitter));
        data[to + 2] = Math.min(255, Math.max(0, data[to + 2] + jitter));
      }
    }
  }
}
