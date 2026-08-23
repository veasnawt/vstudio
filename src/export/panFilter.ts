/** Pure, DOM-free pan math — split out specifically so it's unit-testable under this repo's
 *  `node --test` runner without spinning up FFmpeg or diffing a whole filter-graph string, the same
 *  reasoning `timeline/audioScheduling.ts` was pulled out of `AudioMixEngine.ts` for. */

/** Equal-power pan gains for a stereo signal — the exact W3C Web Audio API `StereoPannerNode`
 *  algorithm for stereo input (boundary-verified: at `pan=0`, `gainL=cos(90°)=0`/`gainR=sin(90°)=1`
 *  reduces to a pure passthrough below; at `pan=-1`, `gainL=1`/`gainR=0` sums both input channels into
 *  the left output and silences the right — a correct "hard left", not a simple channel swap). This is
 *  exactly what `AudioMixEngine`'s per-track `StereoPannerNode` already computes natively for the live
 *  preview; `buildPanFilterStage` below replicates it in FFmpeg for export so the two stay in sync. */
export function equalPowerPanGains(pan: number): { gainL: number; gainR: number } {
  const x = Math.min(1, Math.max(-1, pan));
  const p = x <= 0 ? x + 1 : x;
  return { gainL: Math.cos((p * Math.PI) / 2), gainR: Math.sin((p * Math.PI) / 2) };
}

/** One FFmpeg `pan=` filter stage applying `equalPowerPanGains` to a stereo input, with the
 *  coefficients precomputed and embedded as literal numbers (pan is a static per-track value at
 *  export-plan-build time, not something that varies per-sample, exactly like `volume=${n(gain)}`
 *  already embeds a precomputed gain elsewhere in this file). `null` when `pan` is `0` — matches this
 *  codebase's "only emit a filter stage when it would do something" convention (see
 *  `pushClipAudioFilters`'s own `volumeStage` comment). `n` is the same 6-decimal numeric formatter
 *  `buildExportPlan.ts` already uses everywhere else. */
export function buildPanFilterStage(pan: number, n: (value: number) => string): string | null {
  if (pan === 0) return null;
  const { gainL, gainR } = equalPowerPanGains(pan);
  return pan < 0
    ? `pan=stereo|c0=c0+${n(gainL)}*c1|c1=${n(gainR)}*c1`
    : `pan=stereo|c0=${n(gainL)}*c0|c1=${n(gainR)}*c0+c1`;
}
