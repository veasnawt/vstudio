import { newId } from "../project/createProject.ts";
import type { Clip, ClipEffects, ClipTransform, ColorGrading, ColorGradingKeyframe, EffectsKeyframe, Keyframe, TextCrop, TextCropKeyframe, TextStyle, TransformKeyframe } from "../project/types.ts";
import { IDENTITY_COLOR_GRADING, IDENTITY_EFFECTS, IDENTITY_TEXT_CROP, IDENTITY_TRANSFORM } from "../project/types.ts";
import { frameDuration, snapToFrame } from "./time.ts";

export function hasTransformKeyframes(clip: Clip): boolean {
  return (clip.transformKeyframes?.length ?? 0) > 0;
}

export function hasEffectsKeyframes(clip: Clip): boolean {
  return (clip.effectsKeyframes?.length ?? 0) > 0;
}

export function hasColorGradingKeyframes(clip: Clip): boolean {
  return (clip.colorGradingKeyframes?.length ?? 0) > 0;
}

export function hasTextStyleKeyframes(clip: Clip): boolean {
  return (clip.textStyleKeyframes?.length ?? 0) > 0;
}

export function hasTextCropKeyframes(clip: Clip): boolean {
  return (clip.textCropKeyframes?.length ?? 0) > 0;
}

function lerp(a: number, b: number, p: number): number {
  return a + (b - a) * p;
}

function lerpTransform(a: ClipTransform, b: ClipTransform, p: number): ClipTransform {
  return {
    offsetX: lerp(a.offsetX, b.offsetX, p),
    offsetY: lerp(a.offsetY, b.offsetY, p),
    scale: lerp(a.scale, b.scale, p),
    // Plain numeric lerp, deliberately NOT shortest-arc-wrapped — matches `ClipTransform.rotationDeg`'s
    // own "never clamped/wrapped, a multi-turn drag can exceed 360" convention: a keyframe pair
    // 0deg -> 450deg animates as a genuine 1.25-turn spin, not a wrapped -90deg turn.
    rotationDeg: lerp(a.rotationDeg, b.rotationDeg, p),
    crop: {
      top: lerp(a.crop.top, b.crop.top, p),
      right: lerp(a.crop.right, b.crop.right, p),
      bottom: lerp(a.crop.bottom, b.crop.bottom, p),
      left: lerp(a.crop.left, b.crop.left, p),
    },
  };
}

function lerpEffects(a: ClipEffects, b: ClipEffects, p: number): ClipEffects {
  return {
    brightness: lerp(a.brightness, b.brightness, p),
    contrast: lerp(a.contrast, b.contrast, p),
    saturation: lerp(a.saturation, b.saturation, p),
    blur: lerp(a.blur, b.blur, p),
    opacity: lerp(a.opacity, b.opacity, p),
  };
}

function lerpTextCrop(a: TextCrop, b: TextCrop, p: number): TextCrop {
  return {
    top: lerp(a.top, b.top, p),
    right: lerp(a.right, b.right, p),
    bottom: lerp(a.bottom, b.bottom, p),
    left: lerp(a.left, b.left, p),
  };
}

/** `lerpTransform`'s own counterpart for `TextStyle` — but unlike Transform/Effects (every field
 *  numeric), TextStyle mixes numeric fields (position/size/rotation, the same on-canvas-draggable
 *  properties `TextTransformHandles` already exposes, plus the remaining numeric styling fields) with
 *  genuinely non-numeric ones (font, color, bold/italic, alignment, background/stroke/shadow color) —
 *  a hex color or a boolean has no sensible continuous animation. Numeric fields interpolate; every
 *  other field HOLDS `a`'s value (the earlier keyframe) for the whole span up to `b`, the same
 *  "held, not extrapolated" outside-the-range convention `resolveClipTransform` already uses, just
 *  applied per-field instead of per-whole-keyframe. */
function lerpTextStyle(a: TextStyle, b: TextStyle, p: number): TextStyle {
  return {
    ...a,
    fontSize: lerp(a.fontSize, b.fontSize, p),
    strokeWidth: lerp(a.strokeWidth, b.strokeWidth, p),
    shadowOffsetX: lerp(a.shadowOffsetX, b.shadowOffsetX, p),
    shadowOffsetY: lerp(a.shadowOffsetY, b.shadowOffsetY, p),
    lineHeightMultiplier: lerp(a.lineHeightMultiplier, b.lineHeightMultiplier, p),
    offsetX: lerp(a.offsetX, b.offsetX, p),
    offsetY: lerp(a.offsetY, b.offsetY, p),
    // Same "never wrapped, a multi-turn drag can exceed 360" convention as `lerpTransform`'s own
    // `rotationDeg` — see its comment.
    rotationDeg: lerp(a.rotationDeg, b.rotationDeg, p),
  };
}

/** Finds the two keyframes bracketing `elapsedSeconds` and returns how far between them it falls
 *  (0..1), or `null` when `elapsedSeconds` falls outside the keyframed range entirely — in which case
 *  the caller should hold the nearest end value rather than extrapolate. Shared by both resolvers below
 *  so the "which side, how far across" logic can't drift apart between Transform and Effects. */
function bracket<T>(keyframes: Keyframe<T>[], elapsedSeconds: number): { a: Keyframe<T>; b: Keyframe<T>; progress: number } | Keyframe<T> {
  if (keyframes.length === 1 || elapsedSeconds <= keyframes[0].time) return keyframes[0];
  const last = keyframes[keyframes.length - 1];
  if (elapsedSeconds >= last.time) return last;
  const i = keyframes.findIndex((k) => k.time > elapsedSeconds);
  const a = keyframes[i - 1];
  const b = keyframes[i];
  return { a, b, progress: (elapsedSeconds - a.time) / (b.time - a.time) };
}

/** `clip`'s effective Transform at `elapsedSeconds` (clip-window-relative, see `Keyframe.time`'s own
 *  doc comment) — piecewise-linear between the two keyframes bracketing it, held (not extrapolated)
 *  outside the first/last keyframe's own time. Falls back to `clip.transform ?? IDENTITY_TRANSFORM`
 *  when `transformKeyframes` is absent/empty — a strict superset of the pre-keyframes expression every
 *  read site used to inline directly, so this is ZERO behavior change for every clip that never arms
 *  keyframing. Pure function, no internal clock — mirrors `textAnimation.ts`'s own
 *  `computeTextAnimationTransform` shape, so scrubbing backward is exactly as correct as playing
 *  forward. */
export function resolveClipTransform(clip: Clip, elapsedSeconds: number): ClipTransform {
  const kfs = clip.transformKeyframes;
  if (!kfs || kfs.length === 0) return clip.transform ?? IDENTITY_TRANSFORM;
  const result = bracket(kfs, elapsedSeconds);
  return "value" in result ? result.value : lerpTransform(result.a.value, result.b.value, result.progress);
}

/** `clip`'s effective Effects at `elapsedSeconds` — `resolveClipTransform`'s own counterpart. */
export function resolveClipEffects(clip: Clip, elapsedSeconds: number): ClipEffects {
  const kfs = clip.effectsKeyframes;
  if (!kfs || kfs.length === 0) return clip.effects ?? IDENTITY_EFFECTS;
  const result = bracket(kfs, elapsedSeconds);
  return "value" in result ? result.value : lerpEffects(result.a.value, result.b.value, result.progress);
}

/** `clip`'s effective ColorGrading at `elapsedSeconds` — unlike `resolveClipTransform`/`resolveClipEffects`,
 *  this does NOT interpolate between the bracketing pair: it HOLDS whichever keyframe is currently
 *  active (the earlier one of the pair, once `elapsedSeconds` is between them), same "held, not
 *  extrapolated" outside-range behavior `bracket` already gives everyone, just extended to the WITHIN-range
 *  case too. See `Clip.colorGradingKeyframes`'s own doc comment for why: curve control points have no
 *  natural pointwise correspondence between two differently-shaped curves. Falls back to
 *  `clip.colorGrading ?? IDENTITY_COLOR_GRADING` when `colorGradingKeyframes` is absent/empty, same as
 *  every other resolver here. */
export function resolveClipColorGrading(clip: Clip, elapsedSeconds: number): ColorGrading {
  const kfs = clip.colorGradingKeyframes;
  if (!kfs || kfs.length === 0) return clip.colorGrading ?? IDENTITY_COLOR_GRADING;
  const result = bracket(kfs, elapsedSeconds);
  return "value" in result ? result.value : result.a.value;
}

/** `clip`'s effective TextCrop at `elapsedSeconds` — `resolveClipTransform`'s own counterpart. Falls
 *  back to `clip.textCrop ?? IDENTITY_TEXT_CROP` when `textCropKeyframes` is absent/empty, same as
 *  every other resolver here — zero behavior change for a never-keyframed text clip. */
export function resolveTextCrop(clip: Clip, elapsedSeconds: number): TextCrop {
  const kfs = clip.textCropKeyframes;
  if (!kfs || kfs.length === 0) return clip.textCrop ?? IDENTITY_TEXT_CROP;
  const result = bracket(kfs, elapsedSeconds);
  return "value" in result ? result.value : lerpTextCrop(result.a.value, result.b.value, result.progress);
}

/** `clip`'s effective TextStyle at `elapsedSeconds` — `resolveClipTransform`'s own counterpart, with
 *  one structural difference: TextStyle has no `clip.textStyle` fallback field the way `transform`/
 *  `effects` do (the style lives on the ASSET, not the clip — see `Clip.textStyleKeyframes`'s own doc
 *  comment), so the caller passes the asset's CURRENT style in as `baseStyle` instead. Zero behavior
 *  change for a never-keyframed clip: this returns `baseStyle` right back, the same "whole-object,
 *  never partially resolved" contract every other read site already assumed. */
export function resolveTextStyle(clip: Clip, elapsedSeconds: number, baseStyle: TextStyle): TextStyle {
  const kfs = clip.textStyleKeyframes;
  if (!kfs || kfs.length === 0) return baseStyle;
  const result = bracket(kfs, elapsedSeconds);
  return "value" in result ? result.value : lerpTextStyle(result.a.value, result.b.value, result.progress);
}

/** The one rule for "editing a value while keyframing is armed, at clip-window time `atSeconds`": if
 *  an existing keyframe lands within half a frame (`frameDuration(fps) / 2` — a symmetric snap window,
 *  matching `splitClip`'s own `min / 2` boundary-tolerance convention) of `atSeconds`, its value is
 *  REPLACED with `nextValue`; otherwise a NEW keyframe is inserted at `atSeconds` (snapped to the frame
 *  grid via `snapToFrame`) holding `nextValue`. Returns the new full, time-sorted array — callers
 *  dispatch it wholesale through `SetClipTransformKeyframesCommand`/`SetClipEffectsKeyframesCommand`,
 *  matching this codebase's "whole value back, never a patch" convention. Shared by BOTH the
 *  Inspector's NumberFields and `TransformHandles`' drag commit, so the two editing surfaces can never
 *  implement "update nearest vs. insert new" differently. */
export function upsertKeyframe<T>(keyframes: Keyframe<T>[], atSeconds: number, nextValue: T, fps: number): Keyframe<T>[] {
  const tolerance = frameDuration(fps) / 2;
  let nearestIndex = -1;
  let nearestDistance = Infinity;
  for (let i = 0; i < keyframes.length; i++) {
    const distance = Math.abs(keyframes[i].time - atSeconds);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = i;
    }
  }
  if (nearestIndex >= 0 && nearestDistance <= tolerance) {
    const next = keyframes.slice();
    next[nearestIndex] = { ...next[nearestIndex], value: nextValue };
    return next;
  }
  const inserted: Keyframe<T> = { id: newId("kf"), time: snapToFrame(atSeconds, fps), value: nextValue };
  return [...keyframes, inserted].sort((a, b) => a.time - b.time);
}

export type { ColorGradingKeyframe, EffectsKeyframe, Keyframe, TextCropKeyframe, TransformKeyframe };
