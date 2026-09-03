import { newId } from "./createProject.ts";
import type {
  Asset,
  ChromaKeySettings,
  Clip,
  ClipEffects,
  ClipTransform,
  ColorCurve,
  ColorGrading,
  CustomFontAsset,
  CustomSfxAsset,
  LutAsset,
  Project,
  Sequence,
  TextCrop,
  TextStyle,
  Track,
} from "./types.ts";
import { DEFAULT_TEXT_STYLE, IDENTITY_CURVE, PROJECT_SCHEMA_VERSION } from "./types.ts";
import { FONT_REGISTRY } from "./fonts.ts";
import { TRANSITION_TYPE_OPTIONS } from "../timeline/transitions.ts";
import { TEXT_ANIMATION_TYPE_OPTIONS } from "../timeline/textAnimation.ts";

/** Thrown when a project file can't be trusted. Callers surface the message to the user rather than
 *  loading a half-understood project and letting the damage show up later as a corrupted edit. */
export class ProjectFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectFormatError";
  }
}

export function serializeProject(project: Project): string {
  // Pretty-printed deliberately: a project file a human can read and diff in git is worth far more
  // than the handful of bytes minifying would save on a file this size.
  return JSON.stringify({ ...project, schemaVersion: PROJECT_SCHEMA_VERSION }, null, 2);
}

function req<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new ProjectFormatError(`Project file is missing ${what}`);
  return value;
}

function num(value: unknown, what: string, fallback?: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (fallback !== undefined) return fallback;
  throw new ProjectFormatError(`Project file has an invalid ${what}`);
}

function str(value: unknown, what: string, fallback?: string): string {
  if (typeof value === "string") return value;
  if (fallback !== undefined) return fallback;
  throw new ProjectFormatError(`Project file has an invalid ${what}`);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Same leniency as `parseClipTransform` below, and for the same reason: a text asset's style is
 *  additive presentation data, not something that defines what the asset fundamentally IS the way
 *  `textContent` does. Missing/malformed fields fall back field-by-field to `DEFAULT_TEXT_STYLE`
 *  rather than losing the asset. */
function parseTextStyle(raw: unknown): TextStyle {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const align = r.align === "left" || r.align === "right" ? r.align : "center";
  // Validated against the actual registry, not just "is this a string" — a font id from a NEWER
  // VCut build (or a hand-edited file) that this build doesn't bundle a file for falls back to the
  // default rather than pointing `computeTextBlock`/export at a font that doesn't exist.
  const fontFamily =
    typeof r.fontFamily === "string" && FONT_REGISTRY.some((f) => f.id === r.fontFamily)
      ? r.fontFamily
      : DEFAULT_TEXT_STYLE.fontFamily;
  return {
    fontFamily,
    fontSize: num(r.fontSize, "text font size", DEFAULT_TEXT_STYLE.fontSize),
    color: str(r.color, "text color", DEFAULT_TEXT_STYLE.color),
    bold: bool(r.bold, DEFAULT_TEXT_STYLE.bold),
    italic: bool(r.italic, DEFAULT_TEXT_STYLE.italic),
    align,
    ...(typeof r.backgroundColor === "string" ? { backgroundColor: r.backgroundColor } : null),
    ...(typeof r.strokeColor === "string" ? { strokeColor: r.strokeColor } : null),
    strokeWidth: num(r.strokeWidth, "text stroke width", DEFAULT_TEXT_STYLE.strokeWidth),
    ...(typeof r.shadowColor === "string" ? { shadowColor: r.shadowColor } : null),
    shadowOffsetX: num(r.shadowOffsetX, "text shadow offset", DEFAULT_TEXT_STYLE.shadowOffsetX),
    shadowOffsetY: num(r.shadowOffsetY, "text shadow offset", DEFAULT_TEXT_STYLE.shadowOffsetY),
    lineHeightMultiplier: num(r.lineHeightMultiplier, "text line height", DEFAULT_TEXT_STYLE.lineHeightMultiplier),
    offsetX: num(r.offsetX, "text offset", DEFAULT_TEXT_STYLE.offsetX),
    offsetY: num(r.offsetY, "text offset", DEFAULT_TEXT_STYLE.offsetY),
    rotationDeg: num(r.rotationDeg, "text rotation", DEFAULT_TEXT_STYLE.rotationDeg),
  };
}

function parseAsset(raw: Record<string, unknown>): Asset {
  const kind = str(raw.kind, "asset kind");
  if (kind !== "video" && kind !== "audio" && kind !== "image" && kind !== "text" && kind !== "color") {
    throw new ProjectFormatError(`Project file has an unknown asset kind: ${kind}`);
  }
  // Optional fields are spread in only when actually present, never written as an explicit
  // `undefined`. `JSON.stringify` omits undefined values entirely, so setting them unconditionally
  // would make a restored project structurally differ from the one that was saved — the round trip
  // would no longer be lossless, and equality checks built on it (dirty-tracking, undo comparisons)
  // would report phantom differences.
  return {
    id: str(raw.id, "asset id"),
    kind,
    name: str(raw.name, "asset name"),
    relPath: str(raw.relPath, "asset path"),
    ...(typeof raw.thumbnailRelPath === "string" ? { thumbnailRelPath: raw.thumbnailRelPath } : null),
    ...(typeof raw.filmstripRelPath === "string" ? { filmstripRelPath: raw.filmstripRelPath } : null),
    ...(typeof raw.waveformRelPath === "string" ? { waveformRelPath: raw.waveformRelPath } : null),
    duration: num(raw.duration, "asset duration", 0),
    ...(typeof raw.width === "number" ? { width: raw.width } : null),
    ...(typeof raw.height === "number" ? { height: raw.height } : null),
    ...(typeof raw.fps === "number" ? { fps: raw.fps } : null),
    hasAudio: bool(raw.hasAudio, false),
    sizeBytes: num(raw.sizeBytes, "asset size", 0),
    importedAt: num(raw.importedAt, "asset import time", 0),
    ...(typeof raw.offline === "boolean" ? { offline: raw.offline } : null),
    ...(typeof raw.hiddenFromLibrary === "boolean" ? { hiddenFromLibrary: raw.hiddenFromLibrary } : null),
    ...(kind === "text" ? { textContent: str(raw.textContent, "text content", ""), textStyle: parseTextStyle(raw.textStyle) } : null),
    // Same "additive presentation data, not something that defines what the asset fundamentally IS"
    // spirit as `textContent`/`textStyle` above — a missing/malformed color falls back to black rather
    // than losing the whole asset, matching `parseChromaKey`'s own hex-validation fallback.
    ...(kind === "color"
      ? { color: typeof raw.color === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.color) ? raw.color : "#000000" }
      : null),
  };
}

/** Same field-by-field-lenient, drop-the-malformed-entry spirit `parseTransformKeyframes` uses for a
 *  keyframe array — a project's LUT/font/SFX libraries are additive reusable-asset lists, not something
 *  that defines what the project fundamentally IS, so one corrupted entry loses only itself, not the
 *  whole project. Requires a real `id`+`relPath` (the two fields every consumer actually keys off of —
 *  `Clip.lutId`, `customSfxUrl`); anything else falls back to a sensible default rather than dropping
 *  the entry. */
function parseLutAsset(raw: unknown): LutAsset | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.relPath !== "string") return undefined;
  return {
    id: r.id,
    name: str(r.name, "LUT name", r.id),
    relPath: r.relPath,
    size: num(r.size, "LUT size", 0),
    importedAt: num(r.importedAt, "LUT import time", 0),
  };
}

function parseLuts(raw: unknown): LutAsset[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseLutAsset).filter((l): l is LutAsset => l !== undefined);
}

/** Mirrors `parseLutAsset`, for a `CustomFontAsset`. */
function parseCustomFontAsset(raw: unknown): CustomFontAsset | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.relPath !== "string") return undefined;
  return {
    id: r.id,
    name: str(r.name, "custom font name", r.id),
    relPath: r.relPath,
    cssFamily: str(r.cssFamily, "custom font family", `VCutCustom${r.id}`),
    importedAt: num(r.importedAt, "custom font import time", 0),
  };
}

function parseCustomFonts(raw: unknown): CustomFontAsset[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseCustomFontAsset).filter((f): f is CustomFontAsset => f !== undefined);
}

/** Mirrors `parseLutAsset`, for a `CustomSfxAsset`. */
function parseCustomSfxAsset(raw: unknown): CustomSfxAsset | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.relPath !== "string") return undefined;
  return {
    id: r.id,
    label: str(r.label, "custom sfx label", r.id),
    relPath: r.relPath,
    importedAt: num(r.importedAt, "custom sfx import time", 0),
  };
}

function parseCustomSfx(raw: unknown): CustomSfxAsset[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseCustomSfxAsset).filter((s): s is CustomSfxAsset => s !== undefined);
}

/** Lenient by design, unlike the rest of this file: `transform` is purely additive enhancement data
 *  (see `Clip.transform`'s own doc comment), not something that defines what a clip fundamentally
 *  IS the way `sourceIn`/`sourceOut`/`assetId` do. A missing or partially-malformed transform falls
 *  back to identity values field-by-field rather than throwing and losing the whole clip — the same
 *  "drop what's broken, keep the rest openable" spirit as the missing-asset clip filter below. */
function parseClipTransform(raw: unknown): ClipTransform | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const crop = (r.crop && typeof r.crop === "object" ? r.crop : {}) as Record<string, unknown>;
  return {
    offsetX: num(r.offsetX, "clip transform offset", 0),
    offsetY: num(r.offsetY, "clip transform offset", 0),
    scale: num(r.scale, "clip transform scale", 1),
    rotationDeg: num(r.rotationDeg, "clip transform rotation", 0),
    crop: {
      top: num(crop.top, "clip crop", 0),
      right: num(crop.right, "clip crop", 0),
      bottom: num(crop.bottom, "clip crop", 0),
      left: num(crop.left, "clip crop", 0),
    },
  };
}

/** Same leniency as `parseClipTransform` above, and for the same reason: a text clip's crop is purely
 *  additive enhancement data. */
function parseTextCrop(raw: unknown): TextCrop | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  return {
    top: num(r.top, "text crop", 0),
    right: num(r.right, "text crop", 0),
    bottom: num(r.bottom, "text crop", 0),
    left: num(r.left, "text crop", 0),
  };
}

/** Same leniency as `parseClipTransform` above, and for the same reason: `effects` is purely
 *  additive enhancement data, not something that defines what a clip fundamentally IS. */
function parseClipEffects(raw: unknown): ClipEffects | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  return {
    brightness: num(r.brightness, "clip effects brightness", 0),
    contrast: num(r.contrast, "clip effects contrast", 1),
    saturation: num(r.saturation, "clip effects saturation", 1),
    blur: num(r.blur, "clip effects blur", 0),
    opacity: num(r.opacity, "clip effects opacity", 1),
  };
}

/** Same leniency as `parseClipEffects` above, and for the same reason: `transitionIn`/`transitionOut`
 *  are purely additive relationship data, not something that defines what a clip fundamentally IS —
 *  see `Clip.transitionIn`'s own doc comment. A non-positive/malformed duration drops the field
 *  entirely rather than storing a transition that would never render anything (`findTransitionPartner`/
 *  `findTransitionOut` already treat `duration <= 0` as "no transition"). `type` falls back to
 *  `"crossfade"` when missing or not one of `TRANSITION_TYPE_OPTIONS`'s real values — a project file
 *  from a newer build (or hand-edited) naming a type this build doesn't know falls back rather than
 *  storing a value nothing here can render. */
function parseClipTransitionSpec(raw: unknown): { duration: number; type: (typeof TRANSITION_TYPE_OPTIONS)[number] } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const duration = num(r.duration, "clip transition duration", 0);
  if (duration <= 0) return undefined;
  const type = TRANSITION_TYPE_OPTIONS.find((t) => t === r.type) ?? "crossfade";
  return { duration, type };
}

/** Same leniency as `parseClipTransform`/`parseClipEffects` above, for a clip's Transform keyframe
 *  list — additive animation data, not something that defines what a clip fundamentally IS. A
 *  malformed individual keyframe (a non-finite `time`, or a `value` that isn't even an object) is
 *  dropped rather than failing the whole array — `parseClipTransform` itself already falls back
 *  field-by-field for a partially-malformed value object, so only a genuinely absent/non-object
 *  `value` drops the entry here. An array that ends up empty after dropping bad entries is treated as
 *  absent, matching `setClipTransformKeyframes`'s own "empty means not keyframed" convention, rather
 *  than storing a pointless zero-length array. Sorted by time, same invariant `setClipTransformKeyframes`
 *  itself maintains. A missing/non-string `id` is regenerated rather than dropping the whole keyframe —
 *  the id only needs to be a stable, unique handle for the UI, not meaningful data worth losing the
 *  keyframe over. */
function parseTransformKeyframes(raw: unknown): Clip["transformKeyframes"] {
  if (!Array.isArray(raw)) return undefined;
  const parsed = raw
    .map((entry): NonNullable<Clip["transformKeyframes"]>[number] | undefined => {
      if (!entry || typeof entry !== "object") return undefined;
      const r = entry as Record<string, unknown>;
      if (typeof r.time !== "number" || !Number.isFinite(r.time)) return undefined;
      if (!r.value || typeof r.value !== "object") return undefined;
      return { id: str(r.id, "keyframe id", newId("kf")), time: r.time, value: parseClipTransform(r.value)! };
    })
    .filter((k): k is NonNullable<Clip["transformKeyframes"]>[number] => k !== undefined)
    .sort((a, b) => a.time - b.time);
  return parsed.length > 0 ? parsed : undefined;
}

/** Mirrors `parseTransformKeyframes`, for a clip's Effects keyframe list. */
function parseEffectsKeyframes(raw: unknown): Clip["effectsKeyframes"] {
  if (!Array.isArray(raw)) return undefined;
  const parsed = raw
    .map((entry): NonNullable<Clip["effectsKeyframes"]>[number] | undefined => {
      if (!entry || typeof entry !== "object") return undefined;
      const r = entry as Record<string, unknown>;
      if (typeof r.time !== "number" || !Number.isFinite(r.time)) return undefined;
      if (!r.value || typeof r.value !== "object") return undefined;
      return { id: str(r.id, "keyframe id", newId("kf")), time: r.time, value: parseClipEffects(r.value)! };
    })
    .filter((k): k is NonNullable<Clip["effectsKeyframes"]>[number] => k !== undefined)
    .sort((a, b) => a.time - b.time);
  return parsed.length > 0 ? parsed : undefined;
}

/** Same field-by-field fallback spirit as `parseTextStyle`, applied to one `ColorCurve`: a malformed
 *  individual point is dropped (never drops the whole curve for one bad point), and the whole curve
 *  falls back to `IDENTITY_CURVE` only if fewer than 2 valid points survive — a curve needs at least its
 *  two endpoints to mean anything. */
function parseColorCurve(raw: unknown): ColorCurve {
  if (!Array.isArray(raw) || raw.length < 2) return IDENTITY_CURVE;
  const points = raw
    .map((p): { x: number; y: number } | undefined => {
      if (!p || typeof p !== "object") return undefined;
      const r = p as Record<string, unknown>;
      if (typeof r.x !== "number" || !Number.isFinite(r.x)) return undefined;
      if (typeof r.y !== "number" || !Number.isFinite(r.y)) return undefined;
      return { x: Math.min(1, Math.max(0, r.x)), y: Math.min(1, Math.max(0, r.y)) };
    })
    .filter((p): p is { x: number; y: number } => p !== undefined)
    .sort((a, b) => a.x - b.x);
  return points.length >= 2 ? points : IDENTITY_CURVE;
}

/** Same leniency as `parseClipEffects` above, and for the same reason: color grading is purely
 *  additive enhancement data. Each of the four curves falls back independently via `parseColorCurve` —
 *  a malformed `red` curve doesn't lose an otherwise-valid `master` curve. */
function parseColorGrading(raw: unknown): ColorGrading | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  return {
    master: parseColorCurve(r.master),
    red: parseColorCurve(r.red),
    green: parseColorCurve(r.green),
    blue: parseColorCurve(r.blue),
  };
}

/** Mirrors `parseTransformKeyframes`, for a clip's ColorGrading keyframe list. `parseColorGrading`
 *  itself never fails (field-by-field fallback), so — like `parseTextStyleKeyframes` — only a genuinely
 *  absent/non-object `value` drops the entry here. */
function parseColorGradingKeyframes(raw: unknown): Clip["colorGradingKeyframes"] {
  if (!Array.isArray(raw)) return undefined;
  const parsed = raw
    .map((entry): NonNullable<Clip["colorGradingKeyframes"]>[number] | undefined => {
      if (!entry || typeof entry !== "object") return undefined;
      const r = entry as Record<string, unknown>;
      if (typeof r.time !== "number" || !Number.isFinite(r.time)) return undefined;
      if (!r.value || typeof r.value !== "object") return undefined;
      return { id: str(r.id, "keyframe id", newId("kf")), time: r.time, value: parseColorGrading(r.value)! };
    })
    .filter((k): k is NonNullable<Clip["colorGradingKeyframes"]>[number] => k !== undefined)
    .sort((a, b) => a.time - b.time);
  return parsed.length > 0 ? parsed : undefined;
}

/** Mirrors `parseTransformKeyframes`, for a TEXT clip's TextStyle keyframe list — see
 *  `Clip.textStyleKeyframes`'s own doc comment for why this is a third, clip-scoped keyframe track
 *  rather than living alongside `parseTextStyle`'s own asset-scoped static path. `parseTextStyle`
 *  itself never fails (missing/malformed fields fall back field-by-field to `DEFAULT_TEXT_STYLE`), so
 *  unlike `parseTransformKeyframes`/`parseEffectsKeyframes` there's no non-null assertion needed on
 *  its result — only a genuinely absent/non-object `value` drops the entry here. */
function parseTextStyleKeyframes(raw: unknown): Clip["textStyleKeyframes"] {
  if (!Array.isArray(raw)) return undefined;
  const parsed = raw
    .map((entry): NonNullable<Clip["textStyleKeyframes"]>[number] | undefined => {
      if (!entry || typeof entry !== "object") return undefined;
      const r = entry as Record<string, unknown>;
      if (typeof r.time !== "number" || !Number.isFinite(r.time)) return undefined;
      if (!r.value || typeof r.value !== "object") return undefined;
      return { id: str(r.id, "keyframe id", newId("kf")), time: r.time, value: parseTextStyle(r.value) };
    })
    .filter((k): k is NonNullable<Clip["textStyleKeyframes"]>[number] => k !== undefined)
    .sort((a, b) => a.time - b.time);
  return parsed.length > 0 ? parsed : undefined;
}

/** Mirrors `parseTransformKeyframes`, for a TEXT clip's TextCrop keyframe list. `r.value` is checked
 *  truthy+object before calling `parseTextCrop`, which only ever returns `undefined` for exactly that
 *  case, so the `!` assertion below is safe, same reasoning `parseTransformKeyframes`'s own uses. */
function parseTextCropKeyframes(raw: unknown): Clip["textCropKeyframes"] {
  if (!Array.isArray(raw)) return undefined;
  const parsed = raw
    .map((entry): NonNullable<Clip["textCropKeyframes"]>[number] | undefined => {
      if (!entry || typeof entry !== "object") return undefined;
      const r = entry as Record<string, unknown>;
      if (typeof r.time !== "number" || !Number.isFinite(r.time)) return undefined;
      if (!r.value || typeof r.value !== "object") return undefined;
      return { id: str(r.id, "keyframe id", newId("kf")), time: r.time, value: parseTextCrop(r.value)! };
    })
    .filter((k): k is NonNullable<Clip["textCropKeyframes"]>[number] => k !== undefined)
    .sort((a, b) => a.time - b.time);
  return parsed.length > 0 ? parsed : undefined;
}

/** Same leniency as `parseClipTransform`/`parseClipEffects` above: chroma key is purely additive
 *  enhancement data. A malformed/missing `color` falls back to `DEFAULT_CHROMA_KEY`'s green rather than
 *  dropping the whole setting — same field-by-field fallback `parseTextStyle` already uses. */
function parseChromaKey(raw: unknown): ChromaKeySettings | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const color = typeof r.color === "string" && /^#[0-9a-fA-F]{6}$/.test(r.color) ? r.color : "#00ff00";
  return {
    color,
    similarity: num(r.similarity, "chroma key similarity", 0.4),
    smoothness: num(r.smoothness, "chroma key smoothness", 0.1),
  };
}

/** Same leniency as `parseClipTransitionSpec` above, for `textAnimation` — an unknown/malformed `type`
 *  drops the field entirely (unlike a transition, there's no sensible "fall back to a default type"
 *  here — an animation with the wrong TYPE is just a different, still-fine-looking motion, but there's
 *  no single "safe default" motion the way `crossfade` is for transitions, so absent is the honest
 *  fallback instead of silently picking one). */
function parseClipTextAnimation(raw: unknown): Clip["textAnimation"] {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const type = TEXT_ANIMATION_TYPE_OPTIONS.find((t) => t === r.type);
  if (!type) return undefined;
  return {
    type,
    ...(typeof r.highlightColor === "string" ? { highlightColor: r.highlightColor } : null),
    // Non-positive/absurd speeds would make the animation appear frozen or flash unusably fast —
    // clamped to a sane range rather than trusted verbatim from a hand-edited file.
    ...(typeof r.speed === "number" && Number.isFinite(r.speed) && r.speed > 0
      ? { speed: Math.min(10, Math.max(0.1, r.speed)) }
      : null),
  };
}

function parseClip(raw: Record<string, unknown>): Clip {
  const sourceIn = num(raw.sourceIn, "clip in-point");
  const sourceOut = num(raw.sourceOut, "clip out-point");
  if (sourceOut <= sourceIn) {
    throw new ProjectFormatError("Project file has a clip whose out-point is not after its in-point");
  }
  const transform = parseClipTransform(raw.transform);
  const effects = parseClipEffects(raw.effects);
  const colorGrading = parseColorGrading(raw.colorGrading);
  const chromaKey = parseChromaKey(raw.chromaKey);
  const transitionIn = parseClipTransitionSpec(raw.transitionIn);
  const transitionOut = parseClipTransitionSpec(raw.transitionOut);
  const textAnimation = parseClipTextAnimation(raw.textAnimation);
  const textCrop = parseTextCrop(raw.textCrop);
  const transformKeyframes = parseTransformKeyframes(raw.transformKeyframes);
  const effectsKeyframes = parseEffectsKeyframes(raw.effectsKeyframes);
  const colorGradingKeyframes = parseColorGradingKeyframes(raw.colorGradingKeyframes);
  const textStyleKeyframes = parseTextStyleKeyframes(raw.textStyleKeyframes);
  const textCropKeyframes = parseTextCropKeyframes(raw.textCropKeyframes);
  return {
    id: str(raw.id, "clip id"),
    assetId: str(raw.assetId, "clip asset reference"),
    sourceIn,
    sourceOut,
    timelineStart: Math.max(0, num(raw.timelineStart, "clip position")),
    ...(transform ? { transform } : null),
    ...(effects ? { effects } : null),
    ...(colorGrading ? { colorGrading } : null),
    ...(chromaKey ? { chromaKey } : null),
    ...(transformKeyframes ? { transformKeyframes } : null),
    ...(effectsKeyframes ? { effectsKeyframes } : null),
    ...(colorGradingKeyframes ? { colorGradingKeyframes } : null),
    ...(textStyleKeyframes ? { textStyleKeyframes } : null),
    ...(transitionIn ? { transitionIn } : null),
    ...(transitionOut ? { transitionOut } : null),
    ...(textAnimation ? { textAnimation } : null),
    ...(textCrop ? { textCrop } : null),
    ...(textCropKeyframes ? { textCropKeyframes } : null),
    ...(raw.mutedAudio === true ? { mutedAudio: true } : null),
    ...(typeof raw.gain === "number" && Number.isFinite(raw.gain) && raw.gain !== 1
      ? { gain: Math.min(1, Math.max(0, raw.gain)) }
      : null),
  };
}

const TRACK_NAME_FALLBACK: Record<string, string> = { video: "V", audio: "A", text: "T" };

function parseTrack(raw: Record<string, unknown>): Track {
  const kind = str(raw.kind, "track kind");
  if (kind !== "video" && kind !== "audio" && kind !== "text") {
    throw new ProjectFormatError(`Project file has an unknown track kind: ${kind}`);
  }
  const clips = Array.isArray(raw.clips) ? raw.clips.map((c) => parseClip(c as Record<string, unknown>)) : [];
  return {
    id: str(raw.id, "track id"),
    kind,
    name: str(raw.name, "track name", TRACK_NAME_FALLBACK[kind]),
    // Sorted on load so every consumer can rely on clip order matching timeline order without
    // re-sorting; edit operations maintain this same invariant.
    clips: clips.sort((a, b) => a.timelineStart - b.timelineStart),
    locked: bool(raw.locked, false),
    visible: bool(raw.visible, true),
    muted: bool(raw.muted, false),
    solo: bool(raw.solo, false),
    // Same [0,4] clamp `setTrackGain` uses at write time — unlike `Clip.gain` just above, this field
    // is deliberately kept consistent between parse-time and write-time bounds.
    ...(typeof raw.gain === "number" && Number.isFinite(raw.gain) && raw.gain !== 1
      ? { gain: Math.min(4, Math.max(0, raw.gain)) }
      : null),
    // Same [-1,1] clamp `setTrackPan` uses at write time — consistent parse/write bounds, same as `gain`.
    ...(typeof raw.pan === "number" && Number.isFinite(raw.pan) && raw.pan !== 0
      ? { pan: Math.min(1, Math.max(-1, raw.pan)) }
      : null),
  };
}

function parseSequence(raw: Record<string, unknown>): Sequence {
  return {
    id: str(raw.id, "sequence id"),
    name: str(raw.name, "sequence name", "Main Sequence"),
    width: num(raw.width, "sequence width", 1080),
    height: num(raw.height, "sequence height", 1920),
    fps: num(raw.fps, "sequence frame rate", 30),
    tracks: Array.isArray(raw.tracks) ? raw.tracks.map((t) => parseTrack(t as Record<string, unknown>)) : [],
    ...(typeof raw.masterGain === "number" && Number.isFinite(raw.masterGain) && raw.masterGain !== 1
      ? { masterGain: Math.min(4, Math.max(0, raw.masterGain)) }
      : null),
  };
}

/** Parses and validates a project file. Deliberately strict: a project that can't be read correctly
 *  raises `ProjectFormatError` instead of loading partially, because a silently-wrong timeline is far
 *  worse for a creator than a clear "this file can't be opened". */
export function deserializeProject(json: string): Project {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new ProjectFormatError("Project file is not valid JSON");
  }
  if (!raw || typeof raw !== "object") throw new ProjectFormatError("Project file is empty");

  const version = num(raw.schemaVersion, "schema version", 0);
  // A file written by a NEWER VCut may use fields this build would drop on the next save,
  // quietly destroying work. Refuse rather than round-trip it lossily.
  if (version > PROJECT_SCHEMA_VERSION) {
    throw new ProjectFormatError(
      `This project was created by a newer version of VCut (format ${version}, this build reads ${PROJECT_SCHEMA_VERSION}). Update VCut to open it.`
    );
  }

  const project: Project = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: str(raw.id, "project id"),
    bpProjectId: str(raw.bpProjectId, "project reference"),
    name: str(raw.name, "project name", "Untitled"),
    createdAt: num(raw.createdAt, "creation time", Date.now()),
    updatedAt: num(raw.updatedAt, "update time", Date.now()),
    assets: Array.isArray(raw.assets) ? raw.assets.map((a) => parseAsset(a as Record<string, unknown>)) : [],
    sequence: parseSequence(req(raw.sequence as Record<string, unknown>, "its sequence")),
    exportSettings: {
      width: num((raw.exportSettings as Record<string, unknown>)?.width, "export width", 1080),
      height: num((raw.exportSettings as Record<string, unknown>)?.height, "export height", 1920),
      fps: num((raw.exportSettings as Record<string, unknown>)?.fps, "export frame rate", 30),
      crf: num((raw.exportSettings as Record<string, unknown>)?.crf, "export quality", 20),
      audioBitrateKbps: num(
        (raw.exportSettings as Record<string, unknown>)?.audioBitrateKbps,
        "export audio bitrate",
        192
      ),
    },
    // `[]` for a project file saved before these libraries existed — same backward-compatible default
    // every other field added after `PROJECT_SCHEMA_VERSION`'s last bump uses (e.g. `Track.gain`/`.pan`
    // above), rather than bumping the schema version for what's purely an additive, empty-by-default
    // list.
    luts: parseLuts(raw.luts),
    customFonts: parseCustomFonts(raw.customFonts),
    customSfx: parseCustomSfx(raw.customSfx),
  };

  // A clip pointing at an asset that isn't in the file would crash the compositor on first render.
  // Dropping them keeps the rest of the edit openable, which is the recoverable outcome.
  const assetIds = new Set(project.assets.map((a) => a.id));
  for (const track of project.sequence.tracks) {
    track.clips = track.clips.filter((c) => assetIds.has(c.assetId));
  }

  return project;
}
