/** dB↔linear-gain conversions shared by `VerticalFader` (the Mixer's dB-scaled fader) and `LevelMeter`
 *  (which needs the same range to map a dBFS reading onto a 0..1 fill fraction). Pure/DOM-free so both
 *  are directly unit-testable without a canvas or an `AudioContext` — same reasoning `audioScheduling.ts`
 *  and `panFilter.ts` were pulled out for. */

export const FADER_MIN_DB = -60;
/** `20*log10(4) ≈ +12.04dB`, rounded to a clean `+12` — matches `setTrackGain`'s existing `[0,4]`
 *  linear ceiling, so the fader's own top-of-travel and the stored gain's own hard cap agree. */
export const FADER_MAX_DB = 12;

export function gainToDb(gain: number): number {
  return gain > 0 ? 20 * Math.log10(gain) : FADER_MIN_DB;
}

export function dbToGain(db: number): number {
  // The fader's own bottom-of-travel is treated as exact digital silence (gain `0`), not merely a very
  // quiet but nonzero value at FADER_MIN_DB's own linear equivalent (~0.001) — a fader dragged all the
  // way down should mean truly silent, matching every hardware/DAW fader's own bottom-stop convention,
  // not "extremely quiet but technically still audible."
  if (db <= FADER_MIN_DB) return 0;
  return Math.pow(10, db / 20);
}
