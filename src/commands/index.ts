import { clipEnd, createClip, createTextAsset, findAsset, findClip, findTrack, newId } from "../project/createProject.ts";
import type { ChromaKeySettings, Asset, Clip, ClipEffects, ClipTransform, ColorGrading, Project, TextCrop, TextStyle, Track, TrackKind } from "../project/types.ts";
import { DEFAULT_TEXT_STYLE, IDENTITY_COLOR_GRADING, IDENTITY_EFFECTS, IDENTITY_TEXT_CROP, IDENTITY_TRANSFORM } from "../project/types.ts";
import {
  addClip,
  addTrack,
  deleteClips,
  EditError,
  moveClip,
  removeTrack,
  reorderTrack,
  setClipChromaKey,
  setClipColorGrading,
  setClipColorGradingKeyframes,
  setClipEffects,
  setClipEffectsKeyframes,
  setClipGain,
  setClipMuted,
  setClipTextCrop,
  setClipTransform,
  setClipTransformKeyframes,
  setClipTextStyleKeyframes,
  setClipTextAnimation,
  setClipTransitionIn,
  setClipTransitionOut,
  setMasterGain,
  setTextAsset,
  setTrackFlag,
  setTrackGain,
  setTrackPan,
  splitClip,
  trimClip,
} from "../timeline/operations.ts";
import { nonOverlappingStart } from "../timeline/queries.ts";
import { snapToFrame } from "../timeline/time.ts";
import type { Command } from "./types.ts";

export type { Command } from "./types.ts";
export { EditError } from "../timeline/operations.ts";

/** Groups several commands into ONE undo-stack entry — used wherever one user gesture (drag several
 *  selected clips together, reposition a multi-selection on the canvas) needs to dispatch several
 *  underlying per-clip commands but should only take one Ctrl+Z to fully undo. Sub-commands can be
 *  any mix of command types (a `TrackScopedCommand` like `MoveClipCommand` alongside a trivial-inverse
 *  one like `SetClipTransformCommand`) — this only relies on the shared `Command` interface, not any
 *  particular implementation. Reverts in REVERSE order, mirroring how unwinding a sequence of
 *  operations normally works (undo the last-applied change first). */
export class BatchCommand implements Command {
  label: string;
  private commands: Command[];

  constructor(label: string, commands: Command[]) {
    this.label = label;
    this.commands = commands;
  }

  apply(project: Project): Project {
    return this.commands.reduce((p, c) => c.apply(p), project);
  }

  revert(project: Project): Project {
    return [...this.commands].reverse().reduce((p, c) => c.revert(p), project);
  }
}

/** Base for every clip-editing command.
 *
 *  Each command captures the clip arrays of ONLY the tracks it touches, immediately before applying,
 *  and restores exactly those on revert. This is a scoped memento, not an app-state snapshot: it
 *  records nothing about selection, playhead, zoom, panel sizes, or any other UI state, so undo can
 *  never "rewind the interface" the way a naive snapshot approach does.
 *
 *  A per-track memento is used rather than hand-written inverse math because edits use overwrite
 *  semantics (see `carveRange`) — dropping a clip can trim, split, or delete an arbitrary number of
 *  neighbours, and reconstructing all of that by inversion would be both intricate and easy to get
 *  subtly wrong. Restoring the affected tracks is exact by construction. */
abstract class TrackScopedCommand implements Command {
  abstract label: string;
  private before: { trackId: string; clips: Clip[] }[] | null = null;

  /** Tracks whose clip arrays this command may change, resolved against the pre-edit project. */
  protected abstract affectedTrackIds(project: Project): string[];
  protected abstract run(project: Project): Project;

  apply(project: Project): Project {
    this.before = this.affectedTrackIds(project).map((trackId) => ({
      trackId,
      clips: structuredClone(findTrack(project, trackId)?.clips ?? []),
    }));
    return this.run(project);
  }

  revert(project: Project): Project {
    if (!this.before) throw new Error(`Cannot undo "${this.label}" — it was never applied`);
    const draft = structuredClone(project);
    for (const { trackId, clips } of this.before) {
      const track = findTrack(draft, trackId);
      if (track) track.clips = structuredClone(clips);
    }
    draft.updatedAt = Date.now();
    return draft;
  }
}

/** Note on style: these classes declare their fields explicitly and assign them in the constructor
 *  body, rather than using TypeScript's `constructor(private x: T)` parameter-property shorthand.
 *  Parameter properties are one of the few TypeScript features that can't be erased by simply
 *  stripping types — they generate real assignments — so Node's built-in type stripping rejects
 *  them. Writing the fields out is what lets `node --test` run this package's source directly with
 *  no build step or test framework in between. */
export class AddClipCommand extends TrackScopedCommand {
  label = "Add Clip";
  /** Generated once at construction, not per-apply, so redo recreates the SAME clip id. Any later
   *  command in the stack that referenced this clip would fail to resolve against a fresh id. */
  readonly clipId = newId("c");
  /** Same reasoning for the clip that overwrite can split off (see `carveRange`) — without a fixed
   *  id, redoing this edit would produce a differently-identified clip than the original apply did. */
  private readonly carveTailId = newId("c");

  private trackId: string;
  private assetId: string;
  private timelineStart: number;

  constructor(trackId: string, assetId: string, timelineStart: number) {
    super();
    this.trackId = trackId;
    this.assetId = assetId;
    this.timelineStart = timelineStart;
  }

  protected affectedTrackIds(): string[] {
    return [this.trackId];
  }

  protected run(project: Project): Project {
    return addClip(project, this.trackId, this.assetId, this.timelineStart, this.clipId, this.carveTailId);
  }
}

export class SplitClipCommand extends TrackScopedCommand {
  label = "Split Clip";
  readonly newClipId = newId("c");

  private clipId: string;
  private atTime: number;

  constructor(clipId: string, atTime: number) {
    super();
    this.clipId = clipId;
    this.atTime = atTime;
  }

  protected affectedTrackIds(project: Project): string[] {
    const found = findClip(project, this.clipId);
    if (!found) throw new EditError("That clip no longer exists");
    return [found.track.id];
  }

  protected run(project: Project): Project {
    return splitClip(project, this.clipId, this.atTime, this.newClipId);
  }
}

export class TrimClipCommand extends TrackScopedCommand {
  label = "Trim Clip";

  private clipId: string;
  private edge: "in" | "out";
  private toTime: number;

  constructor(clipId: string, edge: "in" | "out", toTime: number) {
    super();
    this.clipId = clipId;
    this.edge = edge;
    this.toTime = toTime;
  }

  protected affectedTrackIds(project: Project): string[] {
    const found = findClip(project, this.clipId);
    if (!found) throw new EditError("That clip no longer exists");
    return [found.track.id];
  }

  protected run(project: Project): Project {
    return trimClip(project, this.clipId, this.edge, this.toTime);
  }
}

export class MoveClipCommand extends TrackScopedCommand {
  label = "Move Clip";
  /** Fixed at construction so redo reproduces the same clip ids — see `AddClipCommand.clipId`. */
  private readonly carveTailId = newId("c");

  private clipId: string;
  private toTrackId: string;
  private toStart: number;

  constructor(clipId: string, toTrackId: string, toStart: number) {
    super();
    this.clipId = clipId;
    this.toTrackId = toTrackId;
    this.toStart = toStart;
  }

  /** Both the source and destination track change when a clip moves between tracks; when it moves
   *  within one track these collapse to the same id, deduped so the memento isn't captured twice.
   */
  protected affectedTrackIds(project: Project): string[] {
    const found = findClip(project, this.clipId);
    if (!found) throw new EditError("That clip no longer exists");
    return [...new Set([found.track.id, this.toTrackId])];
  }

  protected run(project: Project): Project {
    return moveClip(project, this.clipId, this.toTrackId, this.toStart, this.carveTailId);
  }
}

export class DeleteClipsCommand extends TrackScopedCommand {
  label = "Delete";

  private clipIds: string[];

  constructor(clipIds: string[]) {
    super();
    this.clipIds = clipIds;
  }

  protected affectedTrackIds(project: Project): string[] {
    const ids = new Set<string>();
    for (const clipId of this.clipIds) {
      const found = findClip(project, clipId);
      if (found) ids.add(found.track.id);
    }
    return [...ids];
  }

  protected run(project: Project): Project {
    return deleteClips(project, this.clipIds);
  }
}

/** Duplicates one or more clips — each new copy lands on the SAME track as its original, right after
 *  it if that spot is free (`nonOverlappingStart`, the same "never silently overwrite" placement
 *  `addAssetAtPlayhead`'s own quick-add path already uses), otherwise appended after the track's own
 *  last clip. Duplicating several clips at once processes them in order and mutates the SAME draft
 *  tracks as it goes, so two adjacent originals both land correctly spaced rather than on top of each
 *  other.
 *
 *  Not a `TrackScopedCommand`: a video/image/audio clip's duplicate can safely reuse the SAME
 *  `assetId` (multiple clips already commonly reference one shared source file — transform/effects/
 *  trim all live on the CLIP, not the asset), but a TEXT clip's content+style live on the ASSET
 *  instead (see `Asset.textContent`'s own doc comment) — sharing that asset would make the "duplicate"
 *  silently non-independent: editing one copy's caption would edit the other's too. So a text clip's
 *  duplicate gets a genuinely NEW asset (a clone of the original's content+style), which means this
 *  command touches `project.assets` as well as clip arrays, one level beyond what `TrackScopedCommand`'s
 *  memento covers — same reasoning, and the same reference-stored-arrays memento, `AddCaptionsCommand`
 *  already uses for an identical reason.
 *
 *  `transitionIn` is deliberately NOT copied — a crossfade is a relationship with whichever clip sits
 *  immediately before it, and the duplicate's own "before" is a different clip (or nothing), so
 *  carrying the original's transition over would silently attach a crossfade to the wrong adjacency
 *  (or one that doesn't exist at all yet). Every other per-clip look (transform/effects/mute/gain) IS
 *  copied — those are intrinsic to the clip regardless of where it sits. */
export class DuplicateClipsCommand implements Command {
  label = "Duplicate";
  /** One id reserved per requested clip, fixed at construction so redo recreates the SAME ids —
   *  same reasoning as `AddClipCommand.clipId`. Not every reserved id necessarily gets used on a
   *  given `apply` (see `createdClipIds` below) — a locked track or an since-deleted original is
   *  skipped, tolerantly, the same way `deleteClips` itself tolerates a missing id. */
  private readonly newClipIds: string[];
  /** Which of `newClipIds` actually got created on the MOST RECENT `apply` — recomputed every call
   *  (unlike `newClipIds` itself) since whether a track is locked can change between an apply and a
   *  later redo. The store reads this (not `newClipIds`) to select the fresh copies afterward. */
  createdClipIds: string[] = [];

  private clipIds: string[];
  private previousAssets: Asset[] | null = null;
  private previousTracks: Track[] | null = null;

  constructor(clipIds: string[]) {
    this.clipIds = clipIds;
    this.newClipIds = clipIds.map(() => newId("c"));
    this.label = clipIds.length === 1 ? "Duplicate Clip" : "Duplicate Clips";
  }

  apply(project: Project): Project {
    this.previousAssets = project.assets;
    this.previousTracks = project.sequence.tracks;
    this.createdClipIds = [];

    const draft = structuredClone(project);
    const newAssets: Asset[] = [];
    const fps = draft.sequence.fps;

    this.clipIds.forEach((clipId, i) => {
      // Looked up against the ORIGINAL project (not the in-progress draft) for sourceIn/sourceOut/
      // transform/effects — those never change mid-loop — but placed onto the DRAFT's own track so
      // each new clip sees any earlier ones this same loop already added.
      const found = findClip(project, clipId);
      if (!found) return;
      const draftTrack = findTrack(draft, found.track.id);
      if (!draftTrack || draftTrack.locked) return;

      const original = found.clip;
      const asset = findAsset(project, original.assetId);
      let assetId = original.assetId;
      if (asset?.kind === "text") {
        const clonedAsset = createTextAsset(asset.textContent ?? "", asset.textStyle ?? DEFAULT_TEXT_STYLE);
        newAssets.push(clonedAsset);
        assetId = clonedAsset.id;
      }

      const duration = original.sourceOut - original.sourceIn;
      const start = snapToFrame(nonOverlappingStart(draftTrack, clipEnd(original), duration), fps);

      const clip = createClip({ assetId, sourceIn: original.sourceIn, sourceOut: original.sourceOut, timelineStart: start });
      clip.id = this.newClipIds[i];
      // A duplicate is a full copy of the original's own CONTENT settings — everything here describes
      // what the clip looks/sounds like, not where it sits on the timeline, so it all carries over
      // unchanged (unlike `transitionIn`/`transitionOut`, deliberately excluded: those describe a
      // blend with whatever clip is ADJACENT, which the duplicate — placed at a new, typically
      // non-adjacent position via `nonOverlappingStart` above — usually isn't). Keyframe times need no
      // re-basing here (unlike `splitClip`'s own copy): the duplicate keeps the exact same
      // `sourceIn`/`sourceOut` span as the original, so its own clip-window-relative keyframe times
      // stay valid completely as-is.
      if (original.transform) clip.transform = original.transform;
      if (original.effects) clip.effects = original.effects;
      if (original.textAnimation) clip.textAnimation = original.textAnimation;
      if (original.transformKeyframes) clip.transformKeyframes = original.transformKeyframes;
      if (original.effectsKeyframes) clip.effectsKeyframes = original.effectsKeyframes;
      if (original.mutedAudio !== undefined) clip.mutedAudio = original.mutedAudio;
      if (original.gain !== undefined) clip.gain = original.gain;

      draftTrack.clips.push(clip);
      draftTrack.clips.sort((a, b) => a.timelineStart - b.timelineStart);
      this.createdClipIds.push(clip.id);
    });

    draft.assets = [...draft.assets, ...newAssets];
    draft.updatedAt = Date.now();
    return draft;
  }

  revert(project: Project): Project {
    if (!this.previousAssets || !this.previousTracks) throw new Error(`Cannot undo "${this.label}" — it was never applied`);
    return { ...project, assets: this.previousAssets, sequence: { ...project.sequence, tracks: this.previousTracks } };
  }
}

/** Track flags (lock / visibility / mute / solo) have an exact, trivial inverse — the previous
 *  boolean — so they skip the memento machinery entirely. */
export class SetTrackFlagCommand implements Command {
  label: string;
  private previous: boolean | null = null;

  private trackId: string;
  private flag: "locked" | "visible" | "muted" | "solo";
  private value: boolean;

  constructor(trackId: string, flag: "locked" | "visible" | "muted" | "solo", value: boolean) {
    this.trackId = trackId;
    this.flag = flag;
    this.value = value;
    this.label = `Toggle ${flag}`;
  }

  apply(project: Project): Project {
    const track = findTrack(project, this.trackId);
    if (!track) throw new EditError("That track no longer exists");
    this.previous = track[this.flag];
    return setTrackFlag(project, this.trackId, this.flag, this.value);
  }

  revert(project: Project): Project {
    if (this.previous === null) throw new Error(`Cannot undo "${this.label}" — it was never applied`);
    return setTrackFlag(project, this.trackId, this.flag, this.previous);
  }
}

/** Position/scale/rotation/crop has a trivial exact inverse — the previous transform value — so like
 *  `SetTrackFlagCommand` this skips the `TrackScopedCommand` memento machinery: it's a value change on
 *  one clip, not a track-topology change that can ripple into neighbours. */
export class SetClipTransformCommand implements Command {
  label = "Transform Clip";
  /** `null` means "never applied yet" (guards `revert` before `apply`); once applied, this always
   *  holds a real `ClipTransform` — an untouched clip's previous value is normalized to
   *  `IDENTITY_TRANSFORM` in `apply` below rather than staying `undefined`. */
  private previous: ClipTransform | null = null;

  private clipId: string;
  private transform: ClipTransform;

  constructor(clipId: string, transform: ClipTransform) {
    this.clipId = clipId;
    this.transform = transform;
  }

  apply(project: Project): Project {
    const found = findClip(project, this.clipId);
    if (!found) throw new EditError("That clip no longer exists");
    // `undefined` (never touched) is itself a meaningful previous value to restore on undo — distinct
    // from `null`, which this field uses as "not yet applied" so `revert` can tell the two apart.
    this.previous = found.clip.transform ?? IDENTITY_TRANSFORM;
    return setClipTransform(project, this.clipId, this.transform);
  }

  revert(project: Project): Project {
    if (this.previous === null) throw new Error(`Cannot undo "${this.label}" — it was never applied`);
    return setClipTransform(project, this.clipId, this.previous);
  }
}

/** Trivial-inverse command for `TextCrop`, structurally identical to `SetClipTransformCommand` — see
 *  that class's own comments for the reasoning. */
export class SetClipTextCropCommand implements Command {
  label = "Crop Text";
  private previous: TextCrop | null = null;

  private clipId: string;
  private crop: TextCrop;

  constructor(clipId: string, crop: TextCrop) {
    this.clipId = clipId;
    this.crop = crop;
  }

  apply(project: Project): Project {
    const found = findClip(project, this.clipId);
    if (!found) throw new EditError("That clip no longer exists");
    this.previous = found.clip.textCrop ?? IDENTITY_TEXT_CROP;
    return setClipTextCrop(project, this.clipId, this.crop);
  }

  revert(project: Project): Project {
    if (this.previous === null) throw new Error(`Cannot undo "${this.label}" — it was never applied`);
    return setClipTextCrop(project, this.clipId, this.previous);
  }
}

/** Trivial-inverse command for `ClipEffects`, structurally identical to `SetClipTransformCommand` —
 *  see that class's own comments for the reasoning (applies unchanged: effects don't carve/split
 *  neighboring clips, so a full `TrackScopedCommand` memento isn't needed here either). */
export class SetClipEffectsCommand implements Command {
  label = "Adjust Effects";
  private previous: ClipEffects | null = null;

  private clipId: string;
  private effects: ClipEffects;

  constructor(clipId: string, effects: ClipEffects) {
    this.clipId = clipId;
    this.effects = effects;
  }

  apply(project: Project): Project {
    const found = findClip(project, this.clipId);
    if (!found) throw new EditError("That clip no longer exists");
    this.previous = found.clip.effects ?? IDENTITY_EFFECTS;
    return setClipEffects(project, this.clipId, this.effects);
  }

  revert(project: Project): Project {
    if (this.previous === null) throw new Error(`Cannot undo "${this.label}" — it was never applied`);
    return setClipEffects(project, this.clipId, this.previous);
  }
}

/** Trivial-inverse command for `ColorGrading` — structurally identical to `SetClipEffectsCommand`. */
export class SetClipColorGradingCommand implements Command {
  label = "Adjust Color Grading";
  private previous: ColorGrading | null = null;

  private clipId: string;
  private grading: ColorGrading;

  constructor(clipId: string, grading: ColorGrading) {
    this.clipId = clipId;
    this.grading = grading;
  }

  apply(project: Project): Project {
    const found = findClip(project, this.clipId);
    if (!found) throw new EditError("That clip no longer exists");
    this.previous = found.clip.colorGrading ?? IDENTITY_COLOR_GRADING;
    return setClipColorGrading(project, this.clipId, this.grading);
  }

  revert(project: Project): Project {
    if (this.previous === null) throw new Error(`Cannot undo "${this.label}" — it was never applied`);
    return setClipColorGrading(project, this.clipId, this.previous);
  }
}

/** Sets or clears a clip's chroma key wholesale — an applied-flag pattern (like
 *  `SetClipTransformKeyframesCommand`'s own) rather than a nullable-`previous`-means-"never applied"
 *  one, since `null` is itself a legitimate PREVIOUS value here (no chroma key before this command
 *  ran), not just the command's own not-yet-applied sentinel. */
export class SetClipChromaKeyCommand implements Command {
  label = "Set Chroma Key";
  private applied = false;
  private previous: ChromaKeySettings | null = null;

  private clipId: string;
  private settings: ChromaKeySettings | null;

  constructor(clipId: string, settings: ChromaKeySettings | null) {
    this.clipId = clipId;
    this.settings = settings;
  }

  apply(project: Project): Project {
    const found = findClip(project, this.clipId);
    if (!found) throw new EditError("That clip no longer exists");
    this.previous = found.clip.chromaKey ?? null;
    this.applied = true;
    return setClipChromaKey(project, this.clipId, this.settings);
  }

  revert(project: Project): Project {
    if (!this.applied) throw new Error(`Cannot undo "${this.label}" — it was never applied`);
    return setClipChromaKey(project, this.clipId, this.previous);
  }
}

/** Sets a clip's Transform keyframes wholesale — an applied-flag pattern (like `SetClipTransitionCommand`
 *  below), NOT `SetClipTransformCommand`'s identity-fallback pattern just above, since absent/empty
 *  keyframes is itself a meaningful state ("not keyframed"), not a placeholder to normalize toward an
 *  identity object. One command covers every gesture (arm/disarm, add/update/delete/reorder a keyframe)
 *  — the caller always computes the FULL next array (via `timeline/keyframes.ts`'s `upsertKeyframe`, a
 *  filter for delete, or `null` to disarm) and dispatches it wholesale, so every keyframe edit is
 *  naturally one undo step. */
export class SetClipTransformKeyframesCommand implements Command {
  label = "Set Transform Keyframes";
  private applied = false;
  private previous: Clip["transformKeyframes"] | null = null;

  private clipId: string;
  private keyframes: Clip["transformKeyframes"] | null;

  constructor(clipId: string, keyframes: Clip["transformKeyframes"] | null) {
    this.clipId = clipId;
    this.keyframes = keyframes;
  }

  apply(project: Project): Project {
    const found = findClip(project, this.clipId);
    if (!found) throw new EditError("That clip no longer exists");
    this.previous = found.clip.transformKeyframes ?? null;
    this.applied = true;
    return setClipTransformKeyframes(project, this.clipId, this.keyframes);
  }

  revert(project: Project): Project {
    if (!this.applied) throw new Error(`Cannot undo "${this.label}" — it was never applied`);
    return setClipTransformKeyframes(project, this.clipId, this.previous);
  }
}

/** `SetClipTransformKeyframesCommand`'s own counterpart for `ClipEffects` — identical shape. */
export class SetClipEffectsKeyframesCommand implements Command {
  label = "Set Effects Keyframes";
  private applied = false;
  private previous: Clip["effectsKeyframes"] | null = null;

  private clipId: string;
  private keyframes: Clip["effectsKeyframes"] | null;

  constructor(clipId: string, keyframes: Clip["effectsKeyframes"] | null) {
    this.clipId = clipId;
    this.keyframes = keyframes;
  }

  apply(project: Project): Project {
    const found = findClip(project, this.clipId);
    if (!found) throw new EditError("That clip no longer exists");
    this.previous = found.clip.effectsKeyframes ?? null;
    this.applied = true;
    return setClipEffectsKeyframes(project, this.clipId, this.keyframes);
  }

  revert(project: Project): Project {
    if (!this.applied) throw new Error(`Cannot undo "${this.label}" — it was never applied`);
    return setClipEffectsKeyframes(project, this.clipId, this.previous);
  }
}

/** `SetClipTransformKeyframesCommand`'s own counterpart for `ColorGrading` — identical shape. */
export class SetClipColorGradingKeyframesCommand implements Command {
  label = "Set Color Grading Keyframes";
  private applied = false;
  private previous: Clip["colorGradingKeyframes"] | null = null;

  private clipId: string;
  private keyframes: Clip["colorGradingKeyframes"] | null;

  constructor(clipId: string, keyframes: Clip["colorGradingKeyframes"] | null) {
    this.clipId = clipId;
    this.keyframes = keyframes;
  }

  apply(project: Project): Project {
    const found = findClip(project, this.clipId);
    if (!found) throw new EditError("That clip no longer exists");
    this.previous = found.clip.colorGradingKeyframes ?? null;
    this.applied = true;
    return setClipColorGradingKeyframes(project, this.clipId, this.keyframes);
  }

  revert(project: Project): Project {
    if (!this.applied) throw new Error(`Cannot undo "${this.label}" — it was never applied`);
    return setClipColorGradingKeyframes(project, this.clipId, this.previous);
  }
}

/** `SetClipTransformKeyframesCommand`'s own counterpart for a text clip's `TextStyle` — identical
 *  shape, see `Clip.textStyleKeyframes`'s own doc comment for why this is clip-scoped like the other
 *  two rather than living alongside `SetTextCommand`'s asset-scoped static path. */
export class SetClipTextStyleKeyframesCommand implements Command {
  label = "Set Text Keyframes";
  private applied = false;
  private previous: Clip["textStyleKeyframes"] | null = null;

  private clipId: string;
  private keyframes: Clip["textStyleKeyframes"] | null;

  constructor(clipId: string, keyframes: Clip["textStyleKeyframes"] | null) {
    this.clipId = clipId;
    this.keyframes = keyframes;
  }

  apply(project: Project): Project {
    const found = findClip(project, this.clipId);
    if (!found) throw new EditError("That clip no longer exists");
    this.previous = found.clip.textStyleKeyframes ?? null;
    this.applied = true;
    return setClipTextStyleKeyframes(project, this.clipId, this.keyframes);
  }

  revert(project: Project): Project {
    if (!this.applied) throw new Error(`Cannot undo "${this.label}" — it was never applied`);
    return setClipTextStyleKeyframes(project, this.clipId, this.previous);
  }
}

/** Trivial exact inverse — but unlike `SetClipTransformCommand`/`SetClipEffectsCommand`, `transitionIn`
 *  has no identity-value sentinel to lean on (`undefined` IS the meaningful "no transition" state, not
 *  a placeholder for "not yet applied"), so an explicit `applied` flag distinguishes the two. */
export class SetClipTransitionCommand implements Command {
  label = "Set Transition";
  private applied = false;
  private previous: Clip["transitionIn"] | null = null;

  private clipId: string;
  private transitionIn: Clip["transitionIn"] | null;

  constructor(clipId: string, transitionIn: Clip["transitionIn"] | null) {
    this.clipId = clipId;
    this.transitionIn = transitionIn;
  }

  apply(project: Project): Project {
    const found = findClip(project, this.clipId);
    if (!found) throw new EditError("That clip no longer exists");
    this.previous = found.clip.transitionIn ?? null;
    this.applied = true;
    return setClipTransitionIn(project, this.clipId, this.transitionIn);
  }

  revert(project: Project): Project {
    if (!this.applied) throw new Error(`Cannot undo "${this.label}" — it was never applied`);
    return setClipTransitionIn(project, this.clipId, this.previous);
  }
}

/** `transitionOut`'s own counterpart to `SetClipTransitionCommand` immediately above — identical
 *  shape, just the tail-fade field instead of the head-blend one. */
export class SetClipTransitionOutCommand implements Command {
  label = "Set Transition Out";
  private applied = false;
  private previous: Clip["transitionOut"] | null = null;

  private clipId: string;
  private transitionOut: Clip["transitionOut"] | null;

  constructor(clipId: string, transitionOut: Clip["transitionOut"] | null) {
    this.clipId = clipId;
    this.transitionOut = transitionOut;
  }

  apply(project: Project): Project {
    const found = findClip(project, this.clipId);
    if (!found) throw new EditError("That clip no longer exists");
    this.previous = found.clip.transitionOut ?? null;
    this.applied = true;
    return setClipTransitionOut(project, this.clipId, this.transitionOut);
  }

  revert(project: Project): Project {
    if (!this.applied) throw new Error(`Cannot undo "${this.label}" — it was never applied`);
    return setClipTransitionOut(project, this.clipId, this.previous);
  }
}

/** `textAnimation`'s own counterpart to `SetClipTransitionCommand`/`SetClipTransitionOutCommand` —
 *  identical shape, just the continuous-motion field instead of either transition. */
export class SetClipTextAnimationCommand implements Command {
  label = "Set Text Animation";
  private applied = false;
  private previous: Clip["textAnimation"] | null = null;

  private clipId: string;
  private textAnimation: Clip["textAnimation"] | null;

  constructor(clipId: string, textAnimation: Clip["textAnimation"] | null) {
    this.clipId = clipId;
    this.textAnimation = textAnimation;
  }

  apply(project: Project): Project {
    const found = findClip(project, this.clipId);
    if (!found) throw new EditError("That clip no longer exists");
    this.previous = found.clip.textAnimation ?? null;
    this.applied = true;
    return setClipTextAnimation(project, this.clipId, this.textAnimation);
  }

  revert(project: Project): Project {
    if (!this.applied) throw new Error(`Cannot undo "${this.label}" — it was never applied`);
    return setClipTextAnimation(project, this.clipId, this.previous);
  }
}

/** Trivial exact inverse (the previous boolean), same shape as `SetTrackFlagCommand` — a mute toggle
 *  is a value change on one clip, not a track-topology change. */
export class SetClipMutedCommand implements Command {
  label = "Mute Clip Audio";
  private previous: boolean | null = null;

  private clipId: string;
  private muted: boolean;

  constructor(clipId: string, muted: boolean) {
    this.clipId = clipId;
    this.muted = muted;
    this.label = muted ? "Mute Clip Audio" : "Unmute Clip Audio";
  }

  apply(project: Project): Project {
    const found = findClip(project, this.clipId);
    if (!found) throw new EditError("That clip no longer exists");
    this.previous = found.clip.mutedAudio ?? false;
    return setClipMuted(project, this.clipId, this.muted);
  }

  revert(project: Project): Project {
    if (this.previous === null) throw new Error(`Cannot undo "${this.label}" — it was never applied`);
    return setClipMuted(project, this.clipId, this.previous);
  }
}

/** Trivial exact inverse, same shape as `SetClipMutedCommand` — a gain change is a value change on
 *  one clip, not a track-topology change. `previous` defaults to `1` (absent field = unchanged) when
 *  captured, the same normalize-to-identity move `SetClipEffectsCommand` makes for `IDENTITY_EFFECTS`. */
export class SetClipGainCommand implements Command {
  label = "Adjust Clip Volume";
  private previous: number | null = null;

  private clipId: string;
  private gain: number;

  constructor(clipId: string, gain: number) {
    this.clipId = clipId;
    this.gain = gain;
  }

  apply(project: Project): Project {
    const found = findClip(project, this.clipId);
    if (!found) throw new EditError("That clip no longer exists");
    this.previous = found.clip.gain ?? 1;
    return setClipGain(project, this.clipId, this.gain);
  }

  revert(project: Project): Project {
    if (this.previous === null) throw new Error(`Cannot undo "${this.label}" — it was never applied`);
    return setClipGain(project, this.clipId, this.previous);
  }
}

/** Track-level sibling of `SetClipGainCommand` — same trivial exact inverse (the previous number,
 *  defaulting to `1` when captured), just addressed by `trackId`/`findTrack` instead of `clipId`/
 *  `findClip`. */
export class SetTrackGainCommand implements Command {
  label = "Adjust Track Volume";
  private previous: number | null = null;

  private trackId: string;
  private gain: number;

  constructor(trackId: string, gain: number) {
    this.trackId = trackId;
    this.gain = gain;
  }

  apply(project: Project): Project {
    const track = findTrack(project, this.trackId);
    if (!track) throw new EditError("That track no longer exists");
    this.previous = track.gain ?? 1;
    return setTrackGain(project, this.trackId, this.gain);
  }

  revert(project: Project): Project {
    if (this.previous === null) throw new Error(`Cannot undo "${this.label}" — it was never applied`);
    return setTrackGain(project, this.trackId, this.previous);
  }
}

/** Track-level pan sibling of `SetTrackGainCommand` — same trivial exact inverse (the previous number,
 *  defaulting to `0`/center when captured). */
export class SetTrackPanCommand implements Command {
  label = "Adjust Track Pan";
  private previous: number | null = null;

  private trackId: string;
  private pan: number;

  constructor(trackId: string, pan: number) {
    this.trackId = trackId;
    this.pan = pan;
  }

  apply(project: Project): Project {
    const track = findTrack(project, this.trackId);
    if (!track) throw new EditError("That track no longer exists");
    this.previous = track.pan ?? 0;
    return setTrackPan(project, this.trackId, this.pan);
  }

  revert(project: Project): Project {
    if (this.previous === null) throw new Error(`Cannot undo "${this.label}" — it was never applied`);
    return setTrackPan(project, this.trackId, this.previous);
  }
}

/** Sequence-level sibling of `SetTrackGainCommand` — same trivial exact inverse, addressed by nothing
 *  at all (there's exactly one sequence per project) rather than an id. */
export class SetMasterGainCommand implements Command {
  label = "Adjust Master Volume";
  private previous: number | null = null;

  private gain: number;

  constructor(gain: number) {
    this.gain = gain;
  }

  apply(project: Project): Project {
    this.previous = project.sequence.masterGain ?? 1;
    return setMasterGain(project, this.gain);
  }

  revert(project: Project): Project {
    if (this.previous === null) throw new Error(`Cannot undo "${this.label}" — it was never applied`);
    return setMasterGain(project, this.previous);
  }
}

export class AddTrackCommand implements Command {
  label = "Add Track";
  /** Fixed at construction for the same reason clip ids are (see `AddClipCommand.clipId`): a redo
   *  must restore the track any later command's clips were placed on, not a fresh one. */
  readonly trackId: string;
  private kind: TrackKind;

  constructor(kind: TrackKind) {
    this.kind = kind;
    const prefix = kind === "video" ? "v" : kind === "audio" ? "a" : "t";
    this.trackId = newId(prefix);
  }

  apply(project: Project): Project {
    return addTrack(project, this.kind, this.trackId);
  }

  revert(project: Project): Project {
    const draft = structuredClone(project);
    draft.sequence.tracks = draft.sequence.tracks.filter((t) => t.id !== this.trackId);
    draft.updatedAt = Date.now();
    return draft;
  }
}

/** Removes a track and every clip on it. Not a `TrackScopedCommand`: that base class's memento
 *  restores a TRACK'S CLIPS, but here the track itself is what's coming and going, so `apply` captures
 *  the whole track object (deep-cloned) plus its original index, and `revert` splices it back in
 *  exactly where it was — landing it back between the same neighbours rather than at the end, which
 *  matters because `addTrack`'s video-above-audio grouping means "the end" isn't always "where it
 *  was". This is what a confirmation prompt before removing a track is trusting: the action is fully
 *  undoable, clips included, not just "add an empty track back". */
export class RemoveTrackCommand implements Command {
  label = "Remove Track";
  private removed: { track: Track; index: number } | null = null;

  private trackId: string;

  constructor(trackId: string) {
    this.trackId = trackId;
  }

  apply(project: Project): Project {
    const index = project.sequence.tracks.findIndex((t) => t.id === this.trackId);
    const track = index >= 0 ? project.sequence.tracks[index] : undefined;
    if (!track) throw new EditError("That track no longer exists");
    this.removed = { track: structuredClone(track), index };
    this.label = `Remove ${track.name}`;
    return removeTrack(project, this.trackId);
  }

  revert(project: Project): Project {
    if (!this.removed) throw new Error(`Cannot undo "${this.label}" — it was never applied`);
    const draft = structuredClone(project);
    draft.sequence.tracks.splice(this.removed.index, 0, structuredClone(this.removed.track));
    draft.updatedAt = Date.now();
    return draft;
  }
}

/** Reordering doesn't touch any clip, so its exact inverse is trivially "the full track id order
 *  before the move" rather than needing `TrackScopedCommand`'s per-track clip memento. Capturing the
 *  WHOLE order (not just where `trackId` came from) is what keeps this correct if some other command
 *  also reordered tracks in between an apply and its eventual undo — reapplying the FULL prior order
 *  can't drift out of sync with intervening changes the way "move it back N places" could. */
export class ReorderTrackCommand implements Command {
  label = "Reorder Tracks";
  private previousOrder: string[] | null = null;

  private trackId: string;
  private beforeTrackId: string | null;

  constructor(trackId: string, beforeTrackId: string | null) {
    this.trackId = trackId;
    this.beforeTrackId = beforeTrackId;
  }

  apply(project: Project): Project {
    this.previousOrder = project.sequence.tracks.map((t) => t.id);
    return reorderTrack(project, this.trackId, this.beforeTrackId);
  }

  revert(project: Project): Project {
    if (!this.previousOrder) throw new Error(`Cannot undo "${this.label}" — it was never applied`);
    const draft = structuredClone(project);
    const byId = new Map(draft.sequence.tracks.map((t) => [t.id, t]));
    draft.sequence.tracks = this.previousOrder.map((id) => byId.get(id)).filter((t) => t !== undefined);
    draft.updatedAt = Date.now();
    return draft;
  }
}

/** A text asset's content+style has a trivial exact inverse — the previous values — addressed by
 *  asset id rather than clip id since that's where this data actually lives (see
 *  `Asset.textContent`'s own doc comment). Same shape as `SetClipTransformCommand`. */
export class SetTextCommand implements Command {
  label = "Edit Text";
  private previous: { content: string; style: TextStyle } | null = null;

  private assetId: string;
  private content: string;
  private style: TextStyle;

  constructor(assetId: string, content: string, style: TextStyle) {
    this.assetId = assetId;
    this.content = content;
    this.style = style;
  }

  apply(project: Project): Project {
    const asset = project.assets.find((a) => a.id === this.assetId);
    if (!asset || asset.kind !== "text") throw new EditError("That text no longer exists");
    this.previous = { content: asset.textContent ?? "", style: asset.textStyle ?? this.style };
    return setTextAsset(project, this.assetId, this.content, this.style);
  }

  revert(project: Project): Project {
    if (!this.previous) throw new Error(`Cannot undo "${this.label}" — it was never applied`);
    return setTextAsset(project, this.assetId, this.previous.content, this.previous.style);
  }
}

/** Lands an Auto Captions job's finished segments on the timeline — a fresh text ASSET plus a CLIP
 *  for every caption, all on one new text track, in ONE undo-able step.
 *
 *  Unlike `landInpaintedAsset`/`addTextAsset` in `editorStore.ts` (which append an asset directly,
 *  outside the undo system, since placing it on the timeline is a separate LATER action a user takes
 *  by hand), a caption pass creates its assets AND places its clips as a single user-facing action —
 *  so, unusually for asset creation in this codebase, it goes through `run()` like any other edit.
 *
 *  Not a `TrackScopedCommand`: that base class's memento restores a TRACK's CLIPS, but this command
 *  also adds a whole new track and new assets — a level up from what it covers. Instead this stores
 *  the prior `assets`/`tracks` ARRAYS by reference (cheap, safe — arrays are never mutated in place
 *  anywhere in this codebase, only replaced, the same assumption `RemoveTrackCommand`'s own full-track
 *  memento already relies on) and restores them verbatim on revert. */
export class AddCaptionsCommand implements Command {
  label = "Add Captions";
  /** Fixed at construction, not per-apply, so redo recreates the SAME track — see
   *  `AddTrackCommand.trackId`'s identical reasoning. */
  private readonly trackId = newId("t");
  /** Built once at construction (stable ids across redo, same as `trackId`) rather than in `apply` —
   *  the segments themselves never change between an apply and a later redo. */
  private readonly assets: Asset[];
  private readonly clips: Clip[];
  private previousAssets: Asset[] | null = null;
  private previousTracks: Track[] | null = null;

  constructor(segments: { content: string; start: number; end: number }[], sequenceHeight: number) {
    // Solid background box (the "caption," not "title," look — see DEFAULT_TEXT_STYLE's own comment
    // on why a background box isn't the default there) and a bottom-third vertical position, computed
    // proportionally to the sequence's own height so it lands somewhere sensible whether the project
    // is portrait, landscape, or square, rather than a fixed pixel offset tuned for only one shape.
    // `offsetY` is relative to the frame's own vertical CENTER (see `textLayout.ts`'s block-position
    // math), so a positive value here moves the block DOWN.
    const style: TextStyle = { ...DEFAULT_TEXT_STYLE, fontSize: 48, backgroundColor: "#000000", offsetY: Math.round(sequenceHeight * 0.32) };
    this.assets = segments.map((s) => createTextAsset(s.content, style));
    this.clips = segments.map((s, i) =>
      createClip({ assetId: this.assets[i].id, sourceIn: 0, sourceOut: s.end - s.start, timelineStart: s.start })
    );
  }

  apply(project: Project): Project {
    this.previousAssets = project.assets;
    this.previousTracks = project.sequence.tracks;

    // Reuses addTrack for correct grouping/ordering/auto-naming, then renames it and fills in the
    // clips this command actually placed — see this class's own doc comment for why a hand-built
    // Track object isn't used instead.
    const withTrack = addTrack(project, "text", this.trackId);
    const existingNames = new Set(project.sequence.tracks.filter((t) => t.kind === "text").map((t) => t.name));
    let trackName = "Captions";
    for (let i = 2; existingNames.has(trackName); i++) trackName = `Captions ${i}`;

    const tracks = withTrack.sequence.tracks.map((t) => (t.id === this.trackId ? { ...t, name: trackName, clips: this.clips } : t));
    return { ...withTrack, assets: [...withTrack.assets, ...this.assets], sequence: { ...withTrack.sequence, tracks } };
  }

  revert(project: Project): Project {
    if (!this.previousAssets || !this.previousTracks) throw new Error(`Cannot undo "${this.label}" — it was never applied`);
    return { ...project, assets: this.previousAssets, sequence: { ...project.sequence, tracks: this.previousTracks } };
  }
}
