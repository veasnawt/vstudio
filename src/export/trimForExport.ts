import { clipDuration } from "../project/createProject.ts";
import type { Clip, Project } from "../project/types.ts";
import { snapToFrame } from "../timeline/time.ts";

/** Rewrites a project's clips to keep only what falls within `[start, end)`, shifting everything back
 *  so `start` becomes the new timeline zero — this is the ENTIRE mechanism behind exporting a
 *  sub-range of the timeline. `buildExportPlan` itself needs no changes at all: it only ever reads
 *  `Clip.timelineStart`/`sourceIn`/`sourceOut` and derives its own duration from
 *  `sequenceDuration(project)`, so handing it an already-trimmed, already-shifted CLONE produces
 *  exactly the sub-range export, with every existing mechanism (gaps, transitions, per-track
 *  compositing, text `enable=` windows) working unmodified because none of them know or care that
 *  the project was trimmed at all.
 *
 *  A clip straddling either boundary is trimmed exactly like a manual in/out-point drag already does
 *  elsewhere in this app (see `timeline/operations.ts`'s `carveRange`): its `sourceIn`/`sourceOut`
 *  narrow to match the surviving portion, never its OTHER edge. A clip entirely outside the range is
 *  dropped. A transition's own adjacency (`findTransitionPartner`'s `clipEnd(prev) === clip.timelineStart`
 *  check) needs no special-casing here — clips that remain adjacent after a uniform shift are STILL
 *  adjacent, and a clip whose transition partner got dropped or shifted out of adjacency simply stops
 *  finding one, the same graceful "falls back to a plain cut" behavior that already exists for a
 *  manually-opened gap.
 *
 *  Deliberately never called on the REAL project — only on a throwaway clone built specifically to
 *  hand to the export API, matching this file's sibling `buildExportPlan.ts`'s own "plain function,
 *  project in, project out" style. Not part of `timeline/operations.ts`: every function there is a
 *  genuine, undo-tracked EDIT to the user's project; this is an export-only view transform that never
 *  touches the real project state or the undo stack at all. */
export function trimProjectToRange(project: Project, start: number, end: number): Project {
  const fps = project.sequence.fps;
  const rangeStart = Math.max(0, snapToFrame(start, fps));
  const rangeEnd = Math.max(rangeStart, snapToFrame(end, fps));

  const trimmed = structuredClone(project);
  for (const track of trimmed.sequence.tracks) {
    const kept: Clip[] = [];
    for (const clip of track.clips) {
      const clipStart = clip.timelineStart;
      const clipEnd = clip.timelineStart + clipDuration(clip);
      // Entirely before or after the range — drop it.
      if (clipEnd <= rangeStart || clipStart >= rangeEnd) continue;

      const next: Clip = { ...clip };
      // Overlaps the START boundary — trim the head, consuming that much more of the source.
      if (clipStart < rangeStart) {
        next.sourceIn = clip.sourceIn + (rangeStart - clipStart);
        next.timelineStart = rangeStart;
      }
      // Overlaps the END boundary — trim the tail.
      if (clipEnd > rangeEnd) {
        next.sourceOut = clip.sourceOut - (clipEnd - rangeEnd);
      }
      // Shift so the range's own start becomes the new timeline zero.
      next.timelineStart -= rangeStart;
      kept.push(next);
    }
    track.clips = kept;
  }
  return trimmed;
}
