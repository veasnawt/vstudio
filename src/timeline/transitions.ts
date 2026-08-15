import { clipDuration, clipEnd } from "../project/createProject.ts";
import type { Clip, Track } from "../project/types.ts";

/** What a freshly-enabled transition starts at — half a second is a reasonable default crossfade
 *  length. Shared by the Inspector's checkbox and the toolbar's toggle button, so enabling a
 *  transition from either place produces the identical starting value (editable afterward via the
 *  Inspector's own Duration field either way). */
export const DEFAULT_TRANSITION: NonNullable<Clip["transitionIn"]> = { duration: 0.5, type: "crossfade" };

/** How close two clips' edges have to be to count as "genuinely adjacent" — a plain equality check
 *  would reject a pair that's off by float noise from repeated edits, the same reasoning `carveRange`
 *  already applies via `frameDuration`-scale tolerances elsewhere in this file's sibling module. */
const ADJACENCY_TOLERANCE = 1e-6;

/** Resolves a clip's `transitionIn` (see `Clip.transitionIn`'s own doc comment for why this is
 *  checked fresh here rather than maintained through edits) into the clip it would actually blend
 *  FROM, plus the effective duration once clamped against both clips' real current lengths.
 *
 *  Returns `null` — meaning "render this clip as a plain cut" — when any of: `transitionIn` is
 *  absent, no clip on the same track ends exactly where this one starts (a gap, or nothing before
 *  it), or the stored duration is non-positive. The duration IS still clamped (not rejected) when it
 *  merely exceeds one clip's own length — a trim that shrinks a clip out from under its own
 *  transition should shrink the transition to match, not silently drop it entirely, which would be a
 *  more jarring surprise than a shorter blend.
 *
 *  The ONE place both `PlaybackEngine` and `buildExportPlan` decide "is there a real transition
 *  here, and how long is it" — kept as pure data lookup (no rendering) so `Inspector` can reuse it
 *  to decide whether to even show a "Transition In" section at all. */
export function findTransitionPartner(track: Track, clip: Clip): { partner: Clip; duration: number } | null {
  const requested = clip.transitionIn;
  if (!requested || requested.duration <= 0) return null;

  const partner = findAdjacentPredecessor(track, clip);
  if (!partner) return null;

  const duration = Math.min(requested.duration, clipDuration(partner), clipDuration(clip));
  if (duration <= 0) return null;

  return { partner, duration };
}

function findAdjacentPredecessor(track: Track, clip: Clip): Clip | undefined {
  return track.clips.find((c) => Math.abs(clipEnd(c) - clip.timelineStart) < ADJACENCY_TOLERANCE);
}

/** Whether `clip` has an eligible preceding neighbor to transition FROM at all, independent of
 *  whether `transitionIn` is actually set yet. `findTransitionPartner` alone can't answer this — by
 *  design it requires `transitionIn` to already be set (see its own doc comment) — so this is what
 *  the Inspector uses to decide whether to even show the "enable a transition" checkbox. */
export function findTransitionCandidate(track: Track, clip: Clip): Clip | undefined {
  return findAdjacentPredecessor(track, clip);
}
