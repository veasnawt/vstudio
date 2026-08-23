/** Pure, DOM-free helpers for `AudioMixEngine` — split out specifically so they get real coverage
 *  under this repo's `node --test` runner, which has no `AudioContext`/DOM available (same reason
 *  `timeline/transitions.ts` keeps its own math pure and standalone). Nothing here touches a real
 *  Web Audio node; `AudioMixEngine` is the one place that does, and is verified by running the app.
 *
 *  Deliberately does NOT include a "precompute the whole transition gain curve up front" helper —
 *  that was the original plan, but `findTransitionOut` returns `null` whenever a genuine successor
 *  clip exists (that boundary belongs to the SUCCESSOR's own `transitionIn`, resolved via its
 *  `partner` field — see `resolveAudioTransitionGain`'s own doc comment), so an outgoing clip's own
 *  fields can never describe a real crossfade's fade-out on their own. `PlaybackEngine.activeAudioClips`
 *  already resolves this correctly, per frame, for BOTH sides of a blend (it's what hands back a
 *  `partner` entry at all) — `AudioMixEngine` reuses that per-frame value directly (a plain
 *  `GainNode.gain` smoothing call, see its own comment) instead of trying to re-derive a static curve
 *  from a single clip's own transition fields, which would silently drop the crossfade's outgoing half. */

/** Whether the difference between where an already-scheduled `AudioBufferSourceNode` SHOULD be (per
 *  the timeline's own clock) and where it actually is (derived from its own `AudioContext.currentTime`
 *  start anchor) is large enough to mean a genuine discontinuity — a scrub, a clip-boundary jump, or
 *  (rare, slow) accumulated drift between the `performance.now()`-based master clock `tick()` still
 *  uses and `AudioContext.currentTime` itself, two independently-precise but not necessarily
 *  perfectly-locked clock sources over a very long session. Unlike the old element-based `syncMedia`,
 *  an `AudioBufferSourceNode` has no per-frame polling loop to misfire — this is only ever consulted
 *  once per tick, and only ever produces a hard restart for a genuinely large gap, never a recurring
 *  self-inflicted correction. */
export function detectRealSeek(expectedSourceTime: number, actualSourceTime: number, tolerance: number): boolean {
  return Math.abs(expectedSourceTime - actualSourceTime) > tolerance;
}

/** Generic LRU eviction — which `key`s to drop, oldest-`lastUsed`-first, once `entries.length` exceeds
 *  `limit`. Extracted from `PlaybackEngine.evictStale()`'s own inline version (that one stays as-is,
 *  operating on its own pool shape) so the new asset-buffer cache can share the identical policy
 *  without a second, near-duplicate implementation. Returns keys to evict, not indices — the caller
 *  owns whatever cleanup (disconnecting nodes, releasing elements) each entry actually needs. */
export function lruEvict(entries: { key: string; lastUsed: number }[], limit: number): string[] {
  if (entries.length <= limit) return [];
  return [...entries]
    .sort((a, b) => a.lastUsed - b.lastUsed)
    .slice(0, entries.length - limit)
    .map((e) => e.key);
}
