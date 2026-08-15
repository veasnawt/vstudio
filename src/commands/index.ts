import { findClip, findTrack } from "../project/createProject.ts";
import type { Clip, ClipEffects, ClipTransform, Project, TextStyle, Track, TrackKind } from "../project/types.ts";
import { IDENTITY_EFFECTS, IDENTITY_TRANSFORM } from "../project/types.ts";
import {
  addClip,
  addTrack,
  deleteClips,
  EditError,
  moveClip,
  removeTrack,
  reorderTrack,
  setClipEffects,
  setClipGain,
  setClipMuted,
  setClipTransform,
  setClipTransitionIn,
  setTextAsset,
  setTrackFlag,
  splitClip,
  trimClip,
} from "../timeline/operations.ts";
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
  readonly clipId = `c_${crypto.randomUUID().slice(0, 8)}`;
  /** Same reasoning for the clip that overwrite can split off (see `carveRange`) — without a fixed
   *  id, redoing this edit would produce a differently-identified clip than the original apply did. */
  private readonly carveTailId = `c_${crypto.randomUUID().slice(0, 8)}`;

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
  readonly newClipId = `c_${crypto.randomUUID().slice(0, 8)}`;

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
  private readonly carveTailId = `c_${crypto.randomUUID().slice(0, 8)}`;

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

export class AddTrackCommand implements Command {
  label = "Add Track";
  /** Fixed at construction for the same reason clip ids are (see `AddClipCommand.clipId`): a redo
   *  must restore the track any later command's clips were placed on, not a fresh one. */
  readonly trackId: string;
  private kind: TrackKind;

  constructor(kind: TrackKind) {
    this.kind = kind;
    const prefix = kind === "video" ? "v" : kind === "audio" ? "a" : "t";
    this.trackId = `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
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
