import type { Command } from "../commands/index.ts";
import { SetClipEffectsCommand, SetClipEffectsKeyframesCommand } from "../commands/index.ts";
import type { Clip, ClipEffects } from "../project/types.ts";
import { IDENTITY_EFFECTS } from "../project/types.ts";
import { hasEffectsKeyframes, resolveClipEffects, upsertKeyframe } from "./keyframes.ts";
import type { ClipOverride } from "./groupMove.ts";

/** Builds the ONE command a clip's effects edit should dispatch — shared by `Inspector.tsx`'s own
 *  `patchEffects` (an existing NumberField/preset click) and `EffectsPickerMenu.tsx` (the toolbar
 *  Effects button's popover), so both surfaces make the exact same insert-vs-update keyframe decision
 *  for the exact same edit rather than each re-deriving it. Same auto-key rule `patchTransform`'s own
 *  doc comment describes: editing at a time within half a frame of an existing keyframe updates it in
 *  place; editing anywhere else inserts a new one, leaving every other keyframe untouched. */
export function buildClipEffectsCommand(clip: Clip, patch: Partial<ClipEffects>, playhead: number, fps: number): Command {
  if (hasEffectsKeyframes(clip)) {
    const elapsed = playhead - clip.timelineStart;
    const next = { ...resolveClipEffects(clip, elapsed), ...patch };
    return new SetClipEffectsKeyframesCommand(clip.id, upsertKeyframe(clip.effectsKeyframes!, elapsed, next, fps));
  }
  return new SetClipEffectsCommand(clip.id, { ...(clip.effects ?? IDENTITY_EFFECTS), ...patch });
}

/** The live (uncommitted) counterpart — a `ClipOverride` ready to hand to `setLivePreviewOverrides`,
 *  same merge-onto-the-clip's-CURRENT-effective-value shape `buildClipEffectsCommand` uses, just
 *  without a command/undo entry. Shared for the same reason as `buildClipEffectsCommand` above. */
export function previewClipEffectsOverride(clip: Clip, patch: Partial<ClipEffects>, playhead: number): ClipOverride {
  const current = resolveClipEffects(clip, playhead - clip.timelineStart);
  return { clipId: clip.id, effects: { ...current, ...patch } };
}
