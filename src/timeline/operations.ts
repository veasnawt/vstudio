import { clipDuration, clipEnd, createClip, findAsset, findClip, findTrack } from "../project/createProject.ts";
import type { Asset, Clip, ClipTransform, Project, Track, TrackKind } from "../project/types.ts";
import { IMAGE_DEFAULT_DURATION, isIdentityTransform } from "../project/types.ts";
import { frameDuration, snapToFrame } from "./time.ts";

/** Every operation here is PURE: it takes a project and returns a NEW project, never mutating the
 *  input. That's what lets the undo stack keep a previous project value and restore it exactly, and
 *  what lets React see a changed reference and re-render.
 *
 *  Implemented as "structuredClone, then mutate the clone" rather than nested spread objects. The
 *  model is plain serializable data (see project/types.ts), so the clone is both correct and cheap at
 *  project scale, and the resulting code reads like the edit it performs instead of like a pile of
 *  object-spread plumbing. */
function edit(project: Project, mutate: (draft: Project) => void): Project {
  const draft = structuredClone(project);
  mutate(draft);
  draft.updatedAt = Date.now();
  return draft;
}

/** Thrown when an operation can't be performed as asked (clip not found, split outside the clip,
 *  trim that would leave nothing). Callers turn this into a status message; nothing is mutated. */
export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditError";
  }
}

function sortClips(track: Track): void {
  track.clips.sort((a, b) => a.timelineStart - b.timelineStart);
}

/** Carves `[start, end)` out of every clip on `track` except `exceptClipId`. A clip fully covered is
 *  removed; one overlapped at an edge is trimmed; one straddling the range is split in two.
 *
 *  This is "overwrite" behavior — the incoming clip wins. Chosen over rippling everything sideways
 *  because it's what the creator sees themselves doing when they drag a clip somewhere: the thing
 *  they dragged ends up exactly where they dropped it, and nothing else silently moves.
 *
 *  `tailId` names the one clip this can create (the far side of a straddled clip). Callers that need
 *  redo to be reproducible pass a fixed id — see the note on `AddClipCommand.clipId`. Only ONE clip
 *  can ever straddle the range, because clips on a track never overlap each other, so a single id is
 *  always enough. */
function carveRange(
  track: Track,
  start: number,
  end: number,
  exceptClipId: string,
  fps: number,
  tailId?: string
): void {
  const result: Clip[] = [];
  for (const clip of track.clips) {
    if (clip.id === exceptClipId) {
      result.push(clip);
      continue;
    }
    const cStart = clip.timelineStart;
    const cEnd = clipEnd(clip);

    // No overlap at all.
    if (cEnd <= start || cStart >= end) {
      result.push(clip);
      continue;
    }
    // Fully covered — drop it.
    if (cStart >= start && cEnd <= end) continue;

    const min = frameDuration(fps);

    // Straddles the whole range: keep a head and a tail, which means splitting it in two.
    if (cStart < start && cEnd > end) {
      const headDur = start - cStart;
      const tailDur = cEnd - end;
      if (headDur >= min) {
        result.push({ ...clip, sourceOut: snapToFrame(clip.sourceIn + headDur, fps) });
      }
      if (tailDur >= min) {
        const tail = createClip({
          assetId: clip.assetId,
          sourceIn: snapToFrame(clip.sourceIn + (end - cStart), fps),
          sourceOut: clip.sourceOut,
          timelineStart: end,
        });
        if (tailId) tail.id = tailId;
        result.push(tail);
      }
      continue;
    }
    // Overlapped on its tail — keep the head.
    if (cStart < start) {
      const headDur = start - cStart;
      if (headDur >= min) result.push({ ...clip, sourceOut: snapToFrame(clip.sourceIn + headDur, fps) });
      continue;
    }
    // Overlapped on its head — keep the tail, which shifts its in-point into the source.
    const trimmed = end - cStart;
    if (cEnd - end >= min) {
      result.push({
        ...clip,
        sourceIn: snapToFrame(clip.sourceIn + trimmed, fps),
        timelineStart: end,
      });
    }
  }
  track.clips = result;
  sortClips(track);
}

/** How long a newly-placed clip of this asset should be. Video/audio use their full length; a still
 *  image has no intrinsic duration and gets a sensible default the user can then trim. */
export function defaultClipDuration(asset: Asset): number {
  return asset.kind === "image" ? IMAGE_DEFAULT_DURATION : asset.duration;
}

/** Which kind of track this asset belongs on. Images are visual, so they live on a video track
 *  alongside actual video — only audio-only media goes on an audio track. */
export function trackKindForAsset(asset: Asset): TrackKind {
  return asset.kind === "audio" ? "audio" : "video";
}

export function addClip(
  project: Project,
  trackId: string,
  assetId: string,
  timelineStart: number,
  clipId?: string,
  carveTailId?: string
): Project {
  const asset = findAsset(project, assetId);
  if (!asset) throw new EditError("That media is no longer in the project");

  return edit(project, (draft) => {
    const track = findTrack(draft, trackId);
    if (!track) throw new EditError("That track no longer exists");
    if (track.locked) throw new EditError(`${track.name} is locked`);
    // Enforced here rather than only in the UI so every path into the model is covered — dropping
    // from the library, double-clicking an asset, and any future scripted edit all go through this.
    // `moveClip` has always had the equivalent check; without it here, an image could be dropped onto
    // an audio track and then simply never render.
    const wantedKind = trackKindForAsset(asset);
    if (track.kind !== wantedKind) {
      throw new EditError(
        `"${asset.name}" is ${wantedKind === "audio" ? "audio" : "visual"} media — it belongs on a ${wantedKind} track, not ${track.name}`
      );
    }

    const fps = draft.sequence.fps;
    const start = snapToFrame(Math.max(0, timelineStart), fps);
    const duration = snapToFrame(defaultClipDuration(asset), fps);
    const clip = createClip({ assetId, sourceIn: 0, sourceOut: duration, timelineStart: start });
    // Preserving the id matters for undo/redo: redoing an add must recreate the SAME clip id, or any
    // later command that referenced it (a move, a trim) would no longer resolve.
    if (clipId) clip.id = clipId;

    carveRange(track, start, start + duration, clip.id, fps, carveTailId);
    track.clips.push(clip);
    sortClips(track);
  });
}

/** Splits the clip under `atTime` into two adjacent clips. The split must land strictly INSIDE the
 *  clip — splitting exactly on an edge would produce a zero-length clip, so it's rejected. */
export function splitClip(project: Project, clipId: string, atTime: number, newClipId?: string): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    const { track, clip } = found;
    if (track.locked) throw new EditError(`${track.name} is locked`);

    const fps = draft.sequence.fps;
    const at = snapToFrame(atTime, fps);
    const min = frameDuration(fps);

    if (at <= clip.timelineStart + min / 2 || at >= clipEnd(clip) - min / 2) {
      throw new EditError("Move the playhead inside the clip to split it");
    }

    const offsetIntoSource = at - clip.timelineStart;
    const splitSourceTime = snapToFrame(clip.sourceIn + offsetIntoSource, fps);

    const tail = createClip({
      assetId: clip.assetId,
      sourceIn: splitSourceTime,
      sourceOut: clip.sourceOut,
      timelineStart: at,
    });
    if (newClipId) tail.id = newClipId;

    clip.sourceOut = splitSourceTime;
    track.clips.push(tail);
    sortClips(track);
  });
}

/** Trims one edge of a clip to a new TIMELINE time.
 *
 *  Trimming the in-point moves both `timelineStart` and `sourceIn` together, so the visible frames
 *  stay locked to the media rather than sliding — that's the behavior every editor has and the one
 *  users expect. Trimming the out-point only moves `sourceOut`.
 *
 *  Both edges are clamped to the source's real extent and to a one-frame minimum, so a trim can
 *  never invent frames that don't exist or collapse a clip to nothing. */
export function trimClip(project: Project, clipId: string, edge: "in" | "out", toTime: number): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    const { track, clip } = found;
    if (track.locked) throw new EditError(`${track.name} is locked`);

    const fps = draft.sequence.fps;
    const min = frameDuration(fps);
    const asset = findAsset(draft, clip.assetId);
    // Images have no fixed source length, so their out-point can extend freely; media is capped at
    // its real duration.
    const sourceLimit = asset && asset.kind !== "image" ? asset.duration : Number.POSITIVE_INFINITY;
    const target = snapToFrame(toTime, fps);

    if (edge === "in") {
      const delta = target - clip.timelineStart;
      // Can't pull the in-point earlier than the start of the source media, nor later than one frame
      // before the out-point.
      const minDelta = -clip.sourceIn;
      const maxDelta = clipDuration(clip) - min;
      const applied = Math.min(Math.max(delta, minDelta), maxDelta);
      const newStart = clip.timelineStart + applied;
      if (newStart < 0) {
        // Dragging the in-point past time zero would push the clip off the front of the timeline.
        const corrected = applied - newStart;
        clip.sourceIn = snapToFrame(clip.sourceIn + corrected, fps);
        clip.timelineStart = 0;
        return;
      }
      clip.sourceIn = snapToFrame(clip.sourceIn + applied, fps);
      clip.timelineStart = snapToFrame(newStart, fps);
    } else {
      const desiredDuration = target - clip.timelineStart;
      const maxDuration = sourceLimit - clip.sourceIn;
      const duration = Math.min(Math.max(desiredDuration, min), maxDuration);
      clip.sourceOut = snapToFrame(clip.sourceIn + duration, fps);
    }
    sortClips(track);
  });
}

/** Moves a clip to a new position, optionally onto a different track of the same kind. Anything the
 *  clip lands on is overwritten (see `carveRange`). */
export function moveClip(
  project: Project,
  clipId: string,
  toTrackId: string,
  toStart: number,
  carveTailId?: string
): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    const { track: fromTrack, clip } = found;
    const toTrack = findTrack(draft, toTrackId);
    if (!toTrack) throw new EditError("That track no longer exists");
    if (fromTrack.locked) throw new EditError(`${fromTrack.name} is locked`);
    if (toTrack.locked) throw new EditError(`${toTrack.name} is locked`);
    if (fromTrack.kind !== toTrack.kind) {
      throw new EditError(`A ${fromTrack.kind} clip can't be moved to an ${toTrack.kind} track`);
    }

    const fps = draft.sequence.fps;
    const start = snapToFrame(Math.max(0, toStart), fps);
    const duration = clipDuration(clip);

    fromTrack.clips = fromTrack.clips.filter((c) => c.id !== clipId);
    carveRange(toTrack, start, start + duration, clip.id, fps, carveTailId);
    clip.timelineStart = start;
    toTrack.clips.push(clip);
    sortClips(fromTrack);
    sortClips(toTrack);
  });
}

export function deleteClips(project: Project, clipIds: string[]): Project {
  const ids = new Set(clipIds);
  return edit(project, (draft) => {
    for (const track of draft.sequence.tracks) {
      if (track.locked) continue;
      track.clips = track.clips.filter((c) => !ids.has(c.id));
    }
  });
}

/** Re-inserts previously-removed clips exactly where they were — how `DeleteClipsCommand` undoes
 *  itself, and why delete is safe to offer without a confirmation prompt. */
export function restoreClips(project: Project, entries: { trackId: string; clip: Clip }[]): Project {
  return edit(project, (draft) => {
    for (const { trackId, clip } of entries) {
      const track = findTrack(draft, trackId);
      if (!track) continue;
      track.clips.push(structuredClone(clip));
      sortClips(track);
    }
  });
}

export function setTrackFlag(
  project: Project,
  trackId: string,
  flag: "locked" | "visible" | "muted" | "solo",
  value: boolean
): Project {
  return edit(project, (draft) => {
    const track = findTrack(draft, trackId);
    if (!track) throw new EditError("That track no longer exists");
    track[flag] = value;
  });
}

/** Adds a track, keeping video tracks grouped above audio tracks.
 *
 *  Appending to the end would interleave them (V1, A1, V2), which is both visually confusing and
 *  actively harmful: dragging a clip "one track down" would land it on an audio track, get refused,
 *  and look like the drag simply failed. Every editor groups by kind for this reason. */
export function addTrack(project: Project, kind: "video" | "audio", trackId?: string): Project {
  return edit(project, (draft) => {
    const count = draft.sequence.tracks.filter((t) => t.kind === kind).length;
    const name = `${kind === "video" ? "V" : "A"}${count + 1}`;
    // A new video track goes after the last existing video track; a new audio track goes at the end.
    const insertAt =
      kind === "video"
        ? draft.sequence.tracks.findLastIndex((t) => t.kind === "video") + 1
        : draft.sequence.tracks.length;
    draft.sequence.tracks.splice(insertAt, 0, {
      id: trackId ?? `${kind === "video" ? "v" : "a"}_${crypto.randomUUID().slice(0, 8)}`,
      kind,
      name,
      clips: [],
      locked: false,
      visible: true,
      muted: false,
      solo: false,
    });
  });
}

/** Moves `trackId` to just before `beforeTrackId` within its own track list. `beforeTrackId: null`
 *  means "move to the end of its kind-group" (dropped past the last track, or past the last track of
 *  its own kind).
 *
 *  Reordering is deliberately confined to same-kind tracks — video tracks stay grouped above audio
 *  tracks, the same invariant `addTrack` maintains when inserting a new one (see its own doc comment:
 *  interleaving them would make "drag a clip one track down" land on a mismatched track kind and look
 *  like the drag simply failed). Locked doesn't block this: a lock protects a track's CONTENT from
 *  edits, not where the track sits in the stack. */
export function reorderTrack(project: Project, trackId: string, beforeTrackId: string | null): Project {
  return edit(project, (draft) => {
    const tracks = draft.sequence.tracks;
    const from = tracks.find((t) => t.id === trackId);
    if (!from) throw new EditError("That track no longer exists");

    const target = beforeTrackId ? tracks.find((t) => t.id === beforeTrackId) : undefined;
    if (beforeTrackId && !target) throw new EditError("That track no longer exists");
    if (target && target.kind !== from.kind) {
      throw new EditError("Video and audio tracks can't be mixed together");
    }

    const without = tracks.filter((t) => t.id !== trackId);
    // No explicit target: append to the end of `from`'s own kind-group, mirroring `addTrack`'s own
    // placement rule exactly (video goes after the last video track, audio goes at the very end) —
    // needed so this stays correct even in the edge case where `from` was the ONLY track of its kind,
    // where "the last same-kind track's position" doesn't exist to anchor off of.
    const insertAt = target
      ? without.findIndex((t) => t.id === beforeTrackId)
      : from.kind === "video"
        ? without.findLastIndex((t) => t.kind === "video") + 1
        : without.length;
    without.splice(insertAt, 0, from);
    draft.sequence.tracks = without;
  });
}

/** Removes a track and everything on it. Locked is a deliberate refusal, not a silent skip like
 *  `deleteClips`' locked-track handling — that function is a bulk op over a selection where silently
 *  protecting a locked track's clips and continuing is the right behavior, but this has exactly one
 *  target, so a clear refusal ("unlock it first") is more honest than pretending the click did
 *  nothing. The caller (`RemoveTrackCommand`) is what makes this safe to offer at all: it captures the
 *  removed track's full clip list before calling this, so undo restores every clip exactly. */
export function removeTrack(project: Project, trackId: string): Project {
  return edit(project, (draft) => {
    const track = findTrack(draft, trackId);
    if (!track) throw new EditError("That track no longer exists");
    if (track.locked) throw new EditError(`${track.name} is locked`);
    draft.sequence.tracks = draft.sequence.tracks.filter((t) => t.id !== trackId);
  });
}

/** Smallest fraction of the source that a crop must leave visible on each axis. Exists so a crop can
 *  never produce a zero or negative-size rect — `top: 0.9, bottom: 0.9` would otherwise be accepted
 *  and silently break the compositor and the export filter graph alike. */
const MIN_VISIBLE_FRACTION = 0.02;
const MIN_SCALE = 0.05;
const MAX_SCALE = 20;

/** Clamps a user-supplied transform to values both renderers can safely draw. Rotation is the one
 *  field left untouched — see `ClipTransform.rotationDeg`'s own comment for why. */
function clampTransform(transform: ClipTransform): ClipTransform {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, transform.scale));

  // Each crop value is clamped to 0..(1 - MIN_VISIBLE_FRACTION) first so neither side can alone
  // consume the whole source, then the PAIR is re-balanced if it still leaves too little — clamping
  // each side independently isn't enough on its own (0.9 top + 0.9 bottom both individually pass a
  // 0..0.98 clamp but together leave nothing visible).
  function clampPair(a: number, b: number): [number, number] {
    const cap = 1 - MIN_VISIBLE_FRACTION;
    let ca = Math.min(cap, Math.max(0, a));
    let cb = Math.min(cap, Math.max(0, b));
    const over = ca + cb - cap;
    if (over > 0) {
      // Scale both down proportionally rather than favoring whichever was clamped first, so the
      // crop's rough shape survives even when it has to shrink to become valid.
      const factor = cap / (ca + cb);
      ca *= factor;
      cb *= factor;
    }
    return [ca, cb];
  }

  const [top, bottom] = clampPair(transform.crop.top, transform.crop.bottom);
  const [left, right] = clampPair(transform.crop.left, transform.crop.right);

  return {
    offsetX: transform.offsetX,
    offsetY: transform.offsetY,
    scale,
    rotationDeg: transform.rotationDeg,
    crop: { top, right, bottom, left },
  };
}

/** Sets a clip's transform (position/scale/rotation/crop) wholesale — callers read the current value
 *  (`clip.transform ?? IDENTITY_TRANSFORM`), patch the one field the user changed, and pass the whole
 *  object back, rather than this taking a partial patch itself. That keeps clamping in exactly one
 *  place instead of needing to merge-then-clamp on every call site. */
export function setClipTransform(project: Project, clipId: string, transform: ClipTransform): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    const clamped = clampTransform(transform);
    // Storing an identity object instead of deleting the field would make undoing back to "never
    // transformed" leave a structurally different (if semantically equivalent) clip — the round-trip
    // exactness every other operation in this file preserves.
    if (isIdentityTransform(clamped)) {
      delete found.clip.transform;
    } else {
      found.clip.transform = clamped;
    }
  });
}

/** Mutes or unmutes a clip's own embedded audio. Like `transform`, `false` deletes the field rather
 *  than storing it explicitly — an unmuted clip's JSON stays exactly as small as it was before this
 *  feature existed, and undoing a mute toggle restores a truly absent field. */
export function setClipMuted(project: Project, clipId: string, muted: boolean): Project {
  return edit(project, (draft) => {
    const found = findClip(draft, clipId);
    if (!found) throw new EditError("That clip no longer exists");
    if (found.track.locked) throw new EditError(`${found.track.name} is locked`);
    if (muted) {
      found.clip.mutedAudio = true;
    } else {
      delete found.clip.mutedAudio;
    }
  });
}
