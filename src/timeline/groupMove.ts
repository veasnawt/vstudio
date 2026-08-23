import { findAsset, findClip } from "../project/createProject.ts";
import type { ClipEffects, ClipTransform, ColorGrading, Project, TextCrop, TextStyle } from "../project/types.ts";
import { DEFAULT_TEXT_STYLE, IDENTITY_TRANSFORM } from "../project/types.ts";

/** One clip's live-drag (not-yet-committed) position — `transform` for a video/image clip, `textStyle`/
 *  `textCrop` for a text one, `effects`/`colorGrading` for an in-progress Effects/Color-Grading panel
 *  edit (never produced by a group move, only by `Inspector`'s own NumberFields/`CurveEditor`, but they
 *  live in this same shape since `PlaybackEngine` reads all of them off the one override slot per clip).
 *  Shared shape between `EditorState.livePreviewOverrides` (what `PlaybackEngine` actually draws) and
 *  this module's own return value (what a multi-select group move computes), so the two can never drift
 *  apart. */
export interface ClipOverride {
  clipId: string;
  transform?: ClipTransform;
  textStyle?: TextStyle;
  effects?: ClipEffects;
  colorGrading?: ColorGrading;
  textCrop?: TextCrop;
}

/** For every OTHER selected clip (excluding `primaryClipId`, the one actually under the pointer),
 *  computes what it would look like shifted by the SAME `(deltaX, deltaY)` the primary clip just
 *  moved by — the single source of truth for a multi-select group move, used identically to LIVE-
 *  preview the whole group during the drag (`TransformHandles`/`TextTransformHandles`' own `onMove`)
 *  and to build the final batch of commands on release (their `onUp`), so the two can never disagree
 *  on which clips move or by how much.
 *
 *  Only video/image and text clips participate — audio has no on-screen position to shift. A clip
 *  whose track no longer exists (deleted mid-drag) or whose kind doesn't match its track's is skipped
 *  rather than thrown on, the same "drag can't destroy work" leniency `nonOverlappingStart` favors. */
export function computeGroupMoveOverrides(
  project: Project,
  selectedClipIds: string[],
  primaryClipId: string,
  deltaX: number,
  deltaY: number
): ClipOverride[] {
  const overrides: ClipOverride[] = [];
  for (const id of selectedClipIds) {
    if (id === primaryClipId) continue;
    const found = findClip(project, id);
    if (!found) continue;
    const asset = findAsset(project, found.clip.assetId);
    if (found.track.kind === "video" && (asset?.kind === "video" || asset?.kind === "image")) {
      const t = found.clip.transform ?? IDENTITY_TRANSFORM;
      overrides.push({ clipId: id, transform: { ...t, offsetX: t.offsetX + deltaX, offsetY: t.offsetY + deltaY } });
    } else if (found.track.kind === "text" && asset?.kind === "text") {
      const style = asset.textStyle ?? DEFAULT_TEXT_STYLE;
      overrides.push({ clipId: id, textStyle: { ...style, offsetX: style.offsetX + deltaX, offsetY: style.offsetY + deltaY } });
    }
  }
  return overrides;
}
