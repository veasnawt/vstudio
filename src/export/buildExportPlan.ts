import { TEXT_BOX_PADDING, TEXT_MARGIN_PX } from "../playback/textLayout.ts";
import { clipDuration, clipEnd, findAsset, sequenceDuration } from "../project/createProject.ts";
import { fontById, fontFileFor } from "../project/fonts.ts";
import type { Clip, ClipEffects, ClipTransform, Project, TextStyle, Track } from "../project/types.ts";
import { IDENTITY_EFFECTS, IDENTITY_TRANSFORM, isIdentityEffects, isIdentityTransform } from "../project/types.ts";
import { audibleClips } from "../timeline/queries.ts";
import { findTransitionPartner } from "../timeline/transitions.ts";

/** Builds the FFmpeg invocation that renders a project to a finished file.
 *
 *  Kept as a pure function — project in, argument list out — specifically so the hardest part of
 *  export (getting the filter graph right) can be unit-tested without spawning anything or touching
 *  a disk. The route layer only resolves paths and runs what this returns.
 *
 *  ## Why one input per clip, with `-ss`/`-t`
 *
 *  Each clip becomes its own `-i` with `-ss <in> -t <duration>` in front of it, rather than one
 *  input per file with `trim` filters. Two reasons: placing `-ss` BEFORE `-i` makes FFmpeg seek and
 *  decode only the range actually needed (dramatically faster on long sources — the exact case
 *  non-destructive editing creates), and it sidesteps having to `split` a reused input pad when the
 *  same file appears in several clips.
 *
 *  ## Why gaps become real black segments
 *
 *  A timeline with a hole in it has to export with that hole intact, or the exported video would be
 *  shorter than the edit and every clip after the gap would land at the wrong time. Gaps are filled
 *  with generated black video and silence so the output matches the timeline exactly. */

export interface ExportPlanOptions {
  /** Absolute path to the media file backing an asset. Injected rather than computed here so this
   *  module stays free of any filesystem or path knowledge. */
  inputPathFor: (assetId: string) => string;
  outputPath: string;
  /** Absolute path to a bundled font FILE, given its filename (e.g. "Battambang-Bold.ttf" — see the
   *  registry in `project/fonts.ts`, which is what this module uses to turn a clip's `fontFamily`/
   *  `bold`/`italic` into that filename before calling this). Only called when the project actually
   *  has a text clip — a project with none never needs to know fonts exist. */
  fontPathFor: (fileName: string) => string;
  /** Writes `content` to a text file FFmpeg's `drawtext` can read via `textfile=`, and returns its
   *  absolute path. A real (if small) side effect behind an injected function, same as `inputPathFor`
   *  implicitly assumes its files already exist on disk — kept out of this module directly so a unit
   *  test can inject a fake resolver that never touches disk. `textfile=` rather than escaping
   *  `content` into `text=` directly: user-authored text can contain `:`, `'`, `\`, or `%`, every one
   *  of them meaningful to FFmpeg's OWN filter-string grammar, and a text FILE sidesteps that whole
   *  class of injection/escaping bugs by never putting the content in the filter string at all. */
  textFilePathFor: (clip: Clip, content: string) => string;
}

export interface ExportPlan {
  args: string[];
  /** Total output length in seconds — what progress is measured against. */
  duration: number;
}

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportError";
  }
}

/** One side of a transition segment — the clip it's drawn from, plus everything needed to build its
 *  own filter chain, mirroring the fields a plain "clip" segment already carries. */
interface TransitionSide {
  clip: Clip;
  hasAudio: boolean;
  isImage: boolean;
  path: string;
}

type Segment =
  | { kind: "clip"; clip: Clip; hasAudio: boolean; isImage: boolean; path: string; sourceIn: number; duration: number }
  | { kind: "gap"; duration: number }
  | { kind: "transition"; duration: number; from: TransitionSide; to: TransitionSide };

/** Walks the track start-to-end, emitting a segment per clip and a gap wherever the timeline is
 *  empty between them — plus, wherever `findTransitionPartner` confirms a real crossfade into a
 *  clip, a `"transition"` segment spliced in front of that clip's own (now head-shortened) one.
 *  Finally, a trailing gap fills any remaining space between this track's own last clip and
 *  `targetDuration` (the FULL project duration, not just this track's own content) — without it, a
 *  track whose own content ends early would produce a SHORTER stream than a track that runs the
 *  whole timeline. That's harmless for a single video track (nothing to compare it against), but
 *  fatal once multiple video tracks are layered with `overlay`: FFmpeg's `overlay` filter defaults to
 *  `eof_action=repeat`, freezing on the shorter stream's OWN last frame for the rest of the export
 *  the moment it runs out — so a short overlay clip (a watermark, a PIP insert) would otherwise stay
 *  frozen on-screen long after its own clip actually ended. Always padding every track's stream out
 *  to the same `targetDuration` is what keeps every layer's own EOF landing at the same instant.
 *
 *  The split is deliberately ASYMMETRIC, to exactly match `PlaybackEngine.drawVideoLayer`'s own
 *  preview behavior (see its comment): the transition's `duration` seconds live entirely within the
 *  INCOMING clip's own nominal timeline window (`[clip.timelineStart, clip.timelineStart+duration)`),
 *  never inside the OUTGOING clip's. So the outgoing clip's segment is emitted in full, unshortened
 *  — the same tail frames it ends on play twice (once plainly, once blended into the transition),
 *  same as preview replays them — while only the incoming clip's own segment is shortened, at its
 *  HEAD, by however much the transition already covers. This keeps the total exported duration
 *  exactly equal to the sum of every clip's own nominal length, matching `sequenceDuration` with no
 *  separate accounting needed. */
function buildSegments(project: Project, track: Track, clips: Clip[], options: ExportPlanOptions, targetDuration: number): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;

  for (const clip of clips) {
    if (clip.timelineStart > cursor + 1e-6) {
      segments.push({ kind: "gap", duration: clip.timelineStart - cursor });
    }
    const asset = findAsset(project, clip.assetId);
    if (!asset) throw new ExportError(`A clip references media that is no longer in the project`);
    if (asset.offline) throw new ExportError(`"${asset.name}" is offline. Relink it before exporting.`);

    const isImage = asset.kind === "image";
    const path = options.inputPathFor(clip.assetId);
    const fullDuration = clipDuration(clip);
    const transition = findTransitionPartner(track, clip);

    if (transition) {
      const partner = transition.partner;
      const partnerAsset = findAsset(project, partner.assetId);
      if (!partnerAsset) throw new ExportError(`A clip references media that is no longer in the project`);
      if (partnerAsset.offline) throw new ExportError(`"${partnerAsset.name}" is offline. Relink it before exporting.`);

      segments.push({
        kind: "transition",
        duration: transition.duration,
        from: {
          clip: partner,
          hasAudio: partnerAsset.hasAudio,
          isImage: partnerAsset.kind === "image",
          path: options.inputPathFor(partner.assetId),
        },
        to: { clip, hasAudio: asset.hasAudio, isImage, path },
      });

      const remaining = fullDuration - transition.duration;
      if (remaining > 1e-6) {
        segments.push({
          kind: "clip",
          clip,
          hasAudio: asset.hasAudio,
          isImage,
          path,
          sourceIn: clip.sourceIn + transition.duration,
          duration: remaining,
        });
      }
    } else {
      segments.push({ kind: "clip", clip, hasAudio: asset.hasAudio, isImage, path, sourceIn: clip.sourceIn, duration: fullDuration });
    }

    cursor = clipEnd(clip);
  }

  if (targetDuration > cursor + 1e-6) {
    segments.push({ kind: "gap", duration: targetDuration - cursor });
  }

  return segments;
}

/** Rounds to millisecond precision. FFmpeg parses these as decimal seconds, and full float precision
 *  produces unreadable argument lists without improving accuracy at frame granularity. */
function t(seconds: number): string {
  return seconds.toFixed(6);
}

/** Same rounding for a plain numeric expression fragment (crop fractions, scale, degrees, pixel
 *  offsets) — not a time value, but the same "readable, frame/pixel-accurate precision" reasoning. */
function n(value: number): string {
  return value.toFixed(6);
}

/** Filter chain for a clip with a REAL transform and/or REAL effects (see `isIdentityTransform`/
 *  `isIdentityEffects` — the plain scale+pad chain below handles the fully-untouched case and is
 *  untouched by this). Empirically verified against the actual bundled FFmpeg binary before being
 *  wired in here — see the "any degree" verification in this feature's development notes for a
 *  rendered example.
 *
 *  Two FFmpeg mechanisms are what make the geometry tractable without any JS-side trigonometry:
 *  `rotate`'s `ow=rotw(a):oh=roth(a)` macros let FFmpeg itself compute the exact bounding box that
 *  fits the rotated content losslessly (no precomputed sizes needed here), and `overlay`'s
 *  `W`/`H`/`w`/`h` expression variables let the composite position reference both the background and
 *  overlay's actual sizes symbolically. `format=rgba` right after `crop` is what makes `rotate`'s
 *  `black@0` fill genuinely transparent PADDING rather than a visible black box — without an alpha
 *  channel there, `overlay` has nothing to composite through and the rotated corners show as solid
 *  black; it's also what `colorchannelmixer=aa=` (opacity) needs an alpha channel to modulate. */
function buildTransformFilters(params: {
  sourceIndex: number;
  bgIndex: number;
  outputLabel: string;
  transform: ClipTransform;
  effects: ClipEffects;
  width: number;
  height: number;
  fps: number;
}): string[] {
  const { sourceIndex, bgIndex, outputLabel, transform, effects, width, height, fps } = params;
  const { crop } = transform;
  const clipLabel = `${outputLabel}_src`;
  const bgLabel = `${outputLabel}_bg`;
  const angle = `${n(transform.rotationDeg)}*PI/180`;

  const cropFilter =
    `crop=w=iw*(1-${n(crop.left)}-${n(crop.right)}):h=ih*(1-${n(crop.top)}-${n(crop.bottom)})` +
    `:x=iw*${n(crop.left)}:y=ih*${n(crop.top)}`;
  // min(iw,ih) here is the CROPPED source's own dimensions — crop runs first in this chain, so
  // every filter after it sees the already-cropped size as its "iw"/"ih", exactly like the plain
  // scale+pad chain below sees the FULL source's iw/ih (there is no crop to have already applied).
  const scaleFilter =
    `scale=w='iw*min(${width}/iw,${height}/ih)*${n(transform.scale)}'` +
    `:h='ih*min(${width}/iw,${height}/ih)*${n(transform.scale)}'`;
  const rotateFilter = `rotate=a=${angle}:ow=rotw(${angle}):oh=roth(${angle}):c=black@0`;
  // eq's own defaults (brightness=0, contrast=1, saturation=1) are genuine no-ops, so — unlike
  // gblur/colorchannelmixer below — it's always safe to include unconditionally, no identity check
  // needed for this one fragment.
  const eqFilter = `eq=brightness=${n(effects.brightness)}:contrast=${n(effects.contrast)}:saturation=${n(effects.saturation)}`;
  // Applied AFTER scale, not before — so `blur`'s sigma corresponds to the clip's FINAL on-screen
  // pixel size, matching both the "pixels" unit the Inspector's slider promises and how Canvas2D's
  // own `context.filter` blurs the already-scaled draw, not the source's native resolution. Only
  // appended when actually blurring — an unconditional `gblur=sigma=0` is real filter-graph work
  // (unlike `eq` at its defaults) for the common no-blur case.
  const blurFilter = effects.blur > 0 ? `,gblur=sigma=${n(effects.blur)}` : "";
  // Alpha applied right before compositing onto the background, not earlier — the geometric filters
  // upstream (scale/rotate) don't need to see a partially-transparent source, only the final overlay
  // blend does.
  const opacityFilter = effects.opacity < 1 ? `,colorchannelmixer=aa=${n(effects.opacity)}` : "";

  return [
    `[${sourceIndex}:v]${cropFilter},format=rgba,${eqFilter},${scaleFilter}${blurFilter},${rotateFilter}${opacityFilter},` +
      `setsar=1,fps=${fps},setpts=PTS-STARTPTS[${clipLabel}]`,
    // The background is its own lavfi input (pushed alongside this), not an inline `color=` source
    // filter — matching the pattern gap segments already use elsewhere in this function, so there's
    // only one way black/silence sources get created in this file, not two.
    `[${bgIndex}:v]setpts=PTS-STARTPTS[${bgLabel}]`,
    `[${bgLabel}][${clipLabel}]overlay=x='(W-w)/2+${n(transform.offsetX)}':y='(H-h)/2+${n(transform.offsetY)}':format=auto[${outputLabel}]`,
  ];
}

/** Windows paths carry a drive-letter colon and, in this repo, spaces (`.../App Development/...`) —
 *  both fatal to FFmpeg's OWN filter-graph string parser unless the whole value is wrapped in single
 *  quotes AND the colon is still separately backslash-escaped even inside them. Empirically verified
 *  against the real bundled binary (not from documentation alone — the colon-inside-quotes requirement
 *  in particular is not obvious and easy to get wrong) before being wired in here.
 *
 *  Backslashes (the path separator `path.join`/`path.resolve`/`os.tmpdir()` actually produce on
 *  Windows) get normalized to forward slashes FIRST, before the colon escape — a raw backslash is
 *  FFmpeg's OWN filtergraph escape character, so an un-normalized Windows path silently eats its own
 *  separators (confirmed live: `C:\Users\...\vstudio-text-xyz\clip.txt` arrived at FFmpeg as
 *  `C:Users...vstudio-text-xyzclip.txt`, "no such file"). Forward slashes work as path separators on
 *  Windows regardless of what produced the string, so this is a safe normalization either way. */
function ffmpegPath(absolutePath: string): string {
  return `'${absolutePath.replace(/\\/g, "/").replace(/:/g, "\\:")}'`;
}

/** "#rrggbb" → "0xrrggbb", FFmpeg's own hex color syntax; passes anything else (a named color, or an
 *  already-`0x`-prefixed value) through untouched. */
function ffmpegColor(hex: string): string {
  return hex.startsWith("#") ? `0x${hex.slice(1)}` : hex;
}

/** The `box=`/`bordercolor=`/`shadowcolor=` fragments — background box, stroke outline, and drop
 *  shadow — shared VERBATIM by both `drawtext` builders below, since all three are purely additive
 *  style knobs that don't interact with either builder's own positioning math. FFmpeg's `drawtext`
 *  composites these in a fixed order (shadow, then outline, then fill) regardless of the order their
 *  key=value pairs appear in the filter string — `PlaybackEngine.drawText` draws in that same order
 *  for the same visual result. */
function buildDrawTextStyleParams(style: TextStyle): string {
  const box = style.backgroundColor
    ? `:box=1:boxcolor=${ffmpegColor(style.backgroundColor)}:boxborderw=${TEXT_BOX_PADDING}`
    : "";
  const border = style.strokeColor ? `:bordercolor=${ffmpegColor(style.strokeColor)}:borderw=${n(style.strokeWidth)}` : "";
  const shadow = style.shadowColor
    ? `:shadowcolor=${ffmpegColor(style.shadowColor)}:shadowx=${n(style.shadowOffsetX)}:shadowy=${n(style.shadowOffsetY)}`
    : "";
  return `${box}${border}${shadow}`;
}

/** One text clip's `drawtext`, chained onto whatever the video layer built (`inputLabel`) — see
 *  `trackKindForAsset`'s own comment on why this, not a true overlay-based multi-layer composite, is
 *  what makes "text over video" tractable at all given a single-video-track export. `drawtext` draws
 *  directly onto its input stream, so stacking N of these in sequence (one per active text clip) is
 *  all "compositing" text over video actually requires here — no alpha blending step needed.
 *
 *  `enable='between(t,start,end)'` is what confines the text to its own clip's timeline window on the
 *  SAME absolute clock the concatenated `[cv]` stream already runs on (concat's own `setpts=PTS-
 *  STARTPTS` per segment is what keeps that clock starting at 0 and matching the sequence exactly).
 *
 *  Positioning mirrors `PlaybackEngine.drawText` exactly (same margin/anchor logic, see
 *  `textLayout.ts`'s own doc comment on the one approximation both renderers deliberately share for
 *  multi-line center/right alignment) — just expressed as an FFmpeg formula instead of a JS number,
 *  since `text_w`/`text_h` only exist once FreeType has actually shaped these exact glyphs. */
function buildDrawTextFilter(params: {
  inputLabel: string;
  outputLabel: string;
  content: string;
  style: TextStyle;
  clip: Clip;
  fontPathFor: ExportPlanOptions["fontPathFor"];
  textFilePathFor: ExportPlanOptions["textFilePathFor"];
}): string {
  const { inputLabel, outputLabel, content, style, clip, fontPathFor, textFilePathFor } = params;
  const font = fontById(style.fontFamily);
  const fontFile = ffmpegPath(fontPathFor(fontFileFor(font, style.bold, style.italic)));
  const textFile = ffmpegPath(textFilePathFor(clip, content));

  const anchorX =
    style.align === "left"
      ? `${TEXT_MARGIN_PX}+${n(style.offsetX)}`
      : style.align === "right"
        ? `(w-${TEXT_MARGIN_PX})+${n(style.offsetX)}`
        : `(w/2)+${n(style.offsetX)}`;
  const x = style.align === "left" ? anchorX : style.align === "right" ? `(${anchorX})-text_w` : `(${anchorX})-text_w/2`;
  const y = `(h/2)+${n(style.offsetY)}-text_h/2`;

  const styleParams = buildDrawTextStyleParams(style);
  // FFmpeg's `line_spacing` is EXTRA pixels added between lines on top of the font's own natural line
  // height, unlike the multiplier `style.lineHeightMultiplier` applies wholesale in the canvas preview
  // — this converts one convention to the other; see `textLayout.ts` for why exact agreement isn't the
  // bar for text the way it is for video.
  const lineSpacing = n(style.fontSize * (style.lineHeightMultiplier - 1));

  return (
    `${inputLabel}drawtext=fontfile=${fontFile}:textfile=${textFile}:fontsize=${n(style.fontSize)}:` +
    `fontcolor=${ffmpegColor(style.color)}${styleParams}:line_spacing=${lineSpacing}:x=${x}:y=${y}:` +
    `enable='between(t\\,${t(clip.timelineStart)}\\,${t(clipEnd(clip))})'[${outputLabel}]`
  );
}

/** The rotated-text equivalent of `buildDrawTextFilter` above, used only when `style.rotationDeg` is
 *  nonzero (see `isIdentityTransform`'s sibling reasoning: the plain, already-tested `drawtext`-onto-
 *  `[cv]` chain handles the unrotated case and stays untouched by this).
 *
 *  FFmpeg's `rotate` filter can only spin a buffer around ITS OWN geometric center — there's no
 *  parameter for an arbitrary pivot, and (the actual constraint that shapes everything below) no
 *  sibling filter can see `text_w`/`text_h` — those only exist inside the ONE `drawtext` call that
 *  computed them from the actual shaped glyphs. So the text's true visual center for `align: "left"`/
 *  `"right"` is fundamentally unknowable outside that one filter, and the pivot this uses is the
 *  SEQUENCE FRAME's own center instead — see `PlaybackEngine.drawText`'s matching comment for why that
 *  (not the text's own center) is the one pivot both renderers can compute identically. For
 *  `align: "center"` (the default) the two coincide exactly, so nothing is actually approximated there.
 *
 *  The construction:
 *   1. Draw the text at its NATURAL align-anchored position (same `x`/`y` formula `buildDrawTextFilter`
 *      uses, just with `offsetX`/`offsetY` left OUT) within a background buffer the size of the whole
 *      sequence frame — so the buffer's own center is the FRAME's center, not the text's.
 *   2. `rotate` that whole buffer around ITS OWN (= the frame's) center. `ow=rotw(a):oh=roth(a)` has
 *      FFmpeg itself compute the exact bounding box a WxH buffer needs once rotated by angle `a` — the
 *      same macro `buildTransformFilters` already relies on for clip rotation.
 *   3. `overlay` the rotated buffer onto the video built so far, offset by `offsetX/offsetY` — applying
 *      the offset AFTER rotation, never before (baking it into step 1's position instead would rotate
 *      the text around a point that itself moves with the offset, making it orbit rather than spin in
 *      place — see `PlaybackEngine.drawText` for the identical two-stage `translate`+`rotate`+
 *      `translate` this mirrors).
 *
 *  `format=rgba` before `rotate` is what makes its `black@0` fill genuinely transparent padding — same
 *  reasoning as `buildTransformFilters`'s identical comment. The background buffer spans the FULL
 *  sequence duration (not just the clip's own) so its PTS stays trivially aligned with `[cv]`'s from
 *  frame 0 with no explicit sync step needed; `enable=` on both `drawtext` and the final `overlay`
 *  confines the actual visible window to the clip's own, same as the unrotated path. Empirically
 *  verified against the real bundled FFmpeg binary before being wired in here (see this feature's own
 *  development notes). */
function buildRotatedDrawTextFilter(params: {
  inputLabel: string;
  bgIndex: number;
  outputLabel: string;
  content: string;
  style: TextStyle;
  clip: Clip;
  fontPathFor: ExportPlanOptions["fontPathFor"];
  textFilePathFor: ExportPlanOptions["textFilePathFor"];
}): string[] {
  const { inputLabel, bgIndex, outputLabel, content, style, clip, fontPathFor, textFilePathFor } = params;
  const font = fontById(style.fontFamily);
  const fontFile = ffmpegPath(fontPathFor(fontFileFor(font, style.bold, style.italic)));
  const textFile = ffmpegPath(textFilePathFor(clip, content));

  // Centered within the background buffer's OWN w/h (== the full sequence frame), not the final
  // on-screen position — offset is applied later, at the overlay step, after rotation.
  const anchorX = style.align === "left" ? `${TEXT_MARGIN_PX}` : style.align === "right" ? `(w-${TEXT_MARGIN_PX})` : `(w/2)`;
  const x = style.align === "left" ? anchorX : style.align === "right" ? `(${anchorX})-text_w` : `(${anchorX})-text_w/2`;
  const y = `(h/2)-text_h/2`;

  const styleParams = buildDrawTextStyleParams(style);
  const lineSpacing = n(style.fontSize * (style.lineHeightMultiplier - 1));
  const enable = `enable='between(t\\,${t(clip.timelineStart)}\\,${t(clipEnd(clip))})'`;
  const angle = `${n(style.rotationDeg)}*PI/180`;

  const drawnLabel = `${outputLabel}_drawn`;
  const rotLabel = `${outputLabel}_rot`;

  return [
    `[${bgIndex}:v]drawtext=fontfile=${fontFile}:textfile=${textFile}:fontsize=${n(style.fontSize)}:` +
      `fontcolor=${ffmpegColor(style.color)}${styleParams}:line_spacing=${lineSpacing}:x=${x}:y=${y}:${enable}[${drawnLabel}]`,
    `[${drawnLabel}]format=rgba,rotate=a=${angle}:ow=rotw(${angle}):oh=roth(${angle}):c=black@0[${rotLabel}]`,
    `${inputLabel}[${rotLabel}]overlay=x='(W-w)/2+${n(style.offsetX)}':y='(H-h)/2+${n(style.offsetY)}':` +
      `format=auto:${enable}[${outputLabel}]`,
  ];
}

export function buildExportPlan(project: Project, options: ExportPlanOptions): ExportPlan {
  const { width, height, fps, crf, audioBitrateKbps } = project.exportSettings;
  const duration = sequenceDuration(project);
  if (duration <= 0) throw new ExportError("There is nothing on the timeline to export");

  // Every visible video track with clips composites, in array order — later tracks drawn ON TOP of
  // earlier ones, the identical rule `PlaybackEngine.drawVideoLayer` uses for the canvas preview (see
  // its own comment for why that side needs no equivalent transparency plumbing: `drawImage` only
  // ever touches its own destination rect, so a gap there naturally shows whatever's underneath for
  // free). FFmpeg has no such "just don't touch those pixels" primitive, so this function has to
  // build that transparency explicitly — see `transparent` below.
  const videoTracks = project.sequence.tracks.filter(
    (track) => track.kind === "video" && track.visible && track.clips.length > 0
  );
  if (videoTracks.length === 0) throw new ExportError("There is no visible video track with clips to export");

  const inputs: string[] = [];
  const filters: string[] = [];
  let inputIndex = 0;

  // Pushes one source's own video filter chain — the plain scale+pad path for an untouched clip, or
  // the full crop/eq/scale/blur/rotate/opacity chain for a real transform/effects — shared by a
  // normal "clip" segment AND each half of a "transition" segment's crossfade below, so a
  // transitioning clip's own transform/effects still apply to its share of the blend exactly like
  // they would to a plain cut, not just the two branches independently reimplementing the same logic.
  //
  // `transparent` is true for every track EXCEPT the bottom (base) one — false there keeps the
  // single-track case byte-for-byte identical to before multi-track compositing existed (an opaque
  // `pad=`/background, exactly as today). true swaps in `format=rgba` + a `black@0` fill so a clip's
  // own letterbox bars (or a real transform's rotation-corner/opacity blend) stay genuinely
  // transparent instead of being irreversibly pre-blended against black here — letting whatever's on
  // the track(s) below show through once this track's own stream is later composited over them.
  function pushClipVideoFilters(clip: Clip, videoIndex: number, outputLabel: string, sliceDuration: number, transparent: boolean): void {
    const transform = clip.transform;
    const effects = clip.effects;
    const isPlain = (!transform || isIdentityTransform(transform)) && (!effects || isIdentityEffects(effects));

    if (isPlain) {
      filters.push(
        transparent
          ? `[${videoIndex}:v]format=rgba,scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
              `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1,fps=${fps},setpts=PTS-STARTPTS[${outputLabel}]`
          : `[${videoIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
              `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},setpts=PTS-STARTPTS[${outputLabel}]`
      );
    } else {
      const bgIndex = inputIndex++;
      const bgColor = transparent ? "black@0" : "black";
      inputs.push("-f", "lavfi", "-t", t(sliceDuration), "-i", `color=c=${bgColor}:s=${width}x${height}:r=${fps}`);
      filters.push(
        ...buildTransformFilters({
          sourceIndex: videoIndex,
          bgIndex,
          outputLabel,
          transform: transform ?? IDENTITY_TRANSFORM,
          effects: effects ?? IDENTITY_EFFECTS,
          width,
          height,
          fps,
        })
      );
    }
  }

  // Pushes one source's own audio — resampled straight through (with an optional `volume=` stage —
  // see `Clip.gain`'s own doc comment) when it has real audio, else a matching-length silent source —
  // shared the same way `pushClipVideoFilters` is above. `gain` is meaningless for the silent-source
  // branch (nothing to scale), so it's simply ignored there rather than needing its own identity check.
  function pushClipAudioFilters(hasAudio: boolean, videoIndex: number, outputLabel: string, sliceDuration: number, gain = 1): void {
    if (hasAudio) {
      // Every segment is resampled to one common rate/layout; concat/acrossfade both refuse to join
      // audio streams whose formats don't match, which is easy to hit when mixing a phone clip with
      // a WAV. `volume=` only appended when it would actually change anything — an unconditional
      // `volume=1.000000` is a harmless no-op filter-graph-wise, but skipping it keeps the untouched
      // (overwhelmingly common) case's generated args byte-for-byte identical to before this feature.
      const volumeStage = gain !== 1 ? `,volume=${n(gain)}` : "";
      filters.push(`[${videoIndex}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS${volumeStage}[${outputLabel}]`);
    } else {
      inputs.push("-f", "lavfi", "-t", t(sliceDuration), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
      filters.push(`[${inputIndex++}:a]asetpts=PTS-STARTPTS[${outputLabel}]`);
    }
  }

  // Builds ONE video track's own segment-based concat chain — everything the single-track version of
  // this function used to do in its own top-level loop, now run once per visible video track and
  // producing that track's own `[cvT]`/`[caT]` pair instead of the fixed `[cv]`/`[ca]`. `trackIndex`
  // 0 is the base/bottom layer (opaque, unchanged from today); every other index is a layer that
  // composites ON TOP of it later, so its own gaps and letterbox padding need to stay transparent.
  function buildTrackStreams(track: Track, trackIndex: number): void {
    const transparent = trackIndex > 0;
    const segments = buildSegments(project, track, [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart), options, duration);
    const concatLabels: string[] = [];

    for (const [i, segment] of segments.entries()) {
      const videoLabel = `v${trackIndex}_${i}`;
      const audioLabel = `a${trackIndex}_${i}`;

      if (segment.kind === "clip") {
        if (segment.isImage) {
          // A still has no timeline to seek into — `-ss` would be meaningless and `-t` alone would
          // yield a single frame. `-loop 1` repeats the decoded image for the clip's duration, which
          // is what makes an image occupy real time on the timeline.
          inputs.push("-loop", "1", "-framerate", String(fps), "-t", t(segment.duration), "-i", segment.path);
        } else {
          // -ss and -t BEFORE -i: seek-then-decode, so only the needed range is read. `sourceIn` (not
          // `segment.clip.sourceIn`) is what accounts for a transition-shortened clip starting partway
          // into its own footage — see `buildSegments`'s own comment for why.
          inputs.push("-ss", t(segment.sourceIn), "-t", t(segment.duration), "-i", segment.path);
        }
        const videoIndex = inputIndex++;
        pushClipVideoFilters(segment.clip, videoIndex, videoLabel, segment.duration, transparent);
        pushClipAudioFilters(segment.hasAudio && !segment.clip.mutedAudio, videoIndex, audioLabel, segment.duration, segment.clip.gain ?? 1);
      } else if (segment.kind === "transition") {
        // Two small `-ss/-t` slices — the outgoing clip's own tail `D` seconds, the incoming clip's own
        // head `D` seconds — each normalized through the exact same per-clip filter chain a plain
        // segment uses, THEN blended with `xfade`/`acrossfade`. Both slices are already exactly `D`
        // seconds long and start together once prepared, so `offset=0` makes the entire prepared pair
        // the blend window rather than xfade waiting partway into a longer stream first. Empirically
        // verified against the real bundled FFmpeg binary (frame extraction + pixel sampling through
        // the blend) before being trusted, per this feature's own development notes.
        const D = segment.duration;
        const fromVideoLabel = `${videoLabel}_from`;
        const toVideoLabel = `${videoLabel}_to`;
        const fromAudioLabel = `${audioLabel}_from`;
        const toAudioLabel = `${audioLabel}_to`;

        if (segment.from.isImage) {
          inputs.push("-loop", "1", "-framerate", String(fps), "-t", t(D), "-i", segment.from.path);
        } else {
          inputs.push("-ss", t(segment.from.clip.sourceOut - D), "-t", t(D), "-i", segment.from.path);
        }
        const fromIndex = inputIndex++;
        pushClipVideoFilters(segment.from.clip, fromIndex, fromVideoLabel, D, transparent);
        pushClipAudioFilters(segment.from.hasAudio && !segment.from.clip.mutedAudio, fromIndex, fromAudioLabel, D, segment.from.clip.gain ?? 1);

        if (segment.to.isImage) {
          inputs.push("-loop", "1", "-framerate", String(fps), "-t", t(D), "-i", segment.to.path);
        } else {
          inputs.push("-ss", t(segment.to.clip.sourceIn), "-t", t(D), "-i", segment.to.path);
        }
        const toIndex = inputIndex++;
        pushClipVideoFilters(segment.to.clip, toIndex, toVideoLabel, D, transparent);
        pushClipAudioFilters(segment.to.hasAudio && !segment.to.clip.mutedAudio, toIndex, toAudioLabel, D, segment.to.clip.gain ?? 1);

        filters.push(
          `[${fromVideoLabel}][${toVideoLabel}]xfade=transition=fade:duration=${t(D)}:offset=0,setpts=PTS-STARTPTS[${videoLabel}]`
        );
        filters.push(`[${fromAudioLabel}][${toAudioLabel}]acrossfade=d=${t(D)}[${audioLabel}]`);
      } else {
        const gapColor = transparent ? "black@0" : "black";
        inputs.push("-f", "lavfi", "-t", t(segment.duration), "-i", `color=c=${gapColor}:s=${width}x${height}:r=${fps}`);
        filters.push(`[${inputIndex++}:v]setsar=1,setpts=PTS-STARTPTS[${videoLabel}]`);
        inputs.push("-f", "lavfi", "-t", t(segment.duration), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
        filters.push(`[${inputIndex++}:a]asetpts=PTS-STARTPTS[${audioLabel}]`);
      }

      concatLabels.push(`[${videoLabel}][${audioLabel}]`);
    }

    filters.push(`${concatLabels.join("")}concat=n=${segments.length}:v=1:a=1[cv${trackIndex}][ca${trackIndex}]`);
  }

  videoTracks.forEach((track, trackIndex) => buildTrackStreams(track, trackIndex));

  // Layers each track's own composited stream over the ones before it — base first, so the result is
  // guaranteed fully opaque everywhere (required for the `yuv420p` output, which has no alpha channel
  // at all): the base track's own gaps/padding are opaque by construction above, and compositing
  // anything on top of a fully opaque frame always yields a fully opaque result regardless of the
  // top layer's own alpha. A single video track skips this chain entirely — `videoOut` is just
  // `[cv0]`, byte-for-byte the same seed the old literal `[cv]` used to be.
  let videoOut = "[cv0]";
  const videoTrackAudioLabels: string[] = [];
  for (let i = 1; i < videoTracks.length; i++) {
    const label = `layer${i}`;
    filters.push(`${videoOut}[cv${i}]overlay=format=auto[${label}]`);
    videoOut = `[${label}]`;
    videoTrackAudioLabels.push(`[ca${i}]`);
  }

  // Text tracks composite ON TOP of the (possibly multi-layer) video, one `drawtext` per active clip
  // chained onto the growing stream — see `buildDrawTextFilter`'s own comment for why this (not a
  // true overlay-based multi-layer composite) is what makes text-over-video tractable at all. Tracks
  // are walked in their own top-to-bottom order (matching the header list and `PlaybackEngine`'s
  // own `drawTextLayer`), so a lower text track sits behind a higher one wherever they'd overlap.
  let textIndex = 0;
  for (const track of project.sequence.tracks) {
    if (track.kind !== "text" || !track.visible) continue;
    for (const clip of track.clips) {
      const asset = findAsset(project, clip.assetId);
      if (!asset || asset.kind !== "text" || !asset.textStyle) continue;
      const outputLabel = `txt${textIndex++}`;
      if (!asset.textStyle.rotationDeg) {
        filters.push(
          buildDrawTextFilter({
            inputLabel: videoOut,
            outputLabel,
            content: asset.textContent ?? "",
            style: asset.textStyle,
            clip,
            fontPathFor: options.fontPathFor,
            textFilePathFor: options.textFilePathFor,
          })
        );
      } else {
        // A rotated text clip needs its own full-sequence-duration transparent background input to
        // draw and rotate onto — see `buildRotatedDrawTextFilter`'s own comment for why. Duration
        // matches `[cv]`'s (not just this clip's own) so the two stay trivially PTS-aligned.
        const bgIndex = inputIndex++;
        inputs.push("-f", "lavfi", "-t", t(duration), "-i", `color=c=black@0:s=${width}x${height}:r=${fps}`);
        filters.push(
          ...buildRotatedDrawTextFilter({
            inputLabel: videoOut,
            bgIndex,
            outputLabel,
            content: asset.textContent ?? "",
            style: asset.textStyle,
            clip,
            fontPathFor: options.fontPathFor,
            textFilePathFor: options.textFilePathFor,
          })
        );
      }
      videoOut = `[${outputLabel}]`;
    }
  }

  // Audio-track clips (voiceover, music) are positioned with adelay and mixed over the video track's
  // own audio.
  const overlayAudio: string[] = [];
  for (const [j, { clip }] of audibleClips(project).entries()) {
    const asset = findAsset(project, clip.assetId);
    if (!asset || asset.offline || !asset.hasAudio || clip.mutedAudio) continue;

    inputs.push("-ss", t(clip.sourceIn), "-t", t(clipDuration(clip)), "-i", options.inputPathFor(clip.assetId));
    const label = `ov${j}`;
    const delayMs = Math.round(clip.timelineStart * 1000);
    const gain = clip.gain ?? 1;
    // Same "only add the stage when it would actually change anything" reasoning as
    // `pushClipAudioFilters`'s own `volumeStage`.
    const volumeStage = gain !== 1 ? `,volume=${n(gain)}` : "";
    filters.push(
      `[${inputIndex++}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,` +
        `adelay=${delayMs}|${delayMs}${volumeStage}[${label}]`
    );
    overlayAudio.push(`[${label}]`);
  }

  // Every additional video track's own audio (already a full-timeline-duration stream, silent in its
  // own gaps, exactly like the base track's `[ca0]`) mixes in through the SAME mechanism as an
  // audio-track overlay clip — no separate mixing stage needed for "a second video track's sound".
  let audioOut = "[ca0]";
  const allExtraAudio = [...videoTrackAudioLabels, ...overlayAudio];
  if (allExtraAudio.length > 0) {
    // normalize=0 keeps amix from quietly attenuating every input as more are added, which would
    // make adding a music track mysteriously duck the narration.
    filters.push(
      `${audioOut}${allExtraAudio.join("")}amix=inputs=${allExtraAudio.length + 1}:normalize=0:dropout_transition=0[mixa]`
    );
    audioOut = "[mixa]";
  }

  return {
    duration,
    args: [
      ...inputs,
      "-filter_complex",
      filters.join(";"),
      "-map",
      videoOut,
      "-map",
      audioOut,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      String(crf),
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      `${audioBitrateKbps}k`,
      // Puts the MP4 index at the front so the file can start playing before it's fully downloaded —
      // what every social platform expects of an upload.
      "-movflags",
      "+faststart",
      // Guards against a filter-graph rounding difference making the output a few frames longer than
      // the timeline.
      "-t",
      t(duration),
      "-y",
      options.outputPath,
    ],
  };
}
