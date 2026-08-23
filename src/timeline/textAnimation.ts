import type { TextAnimationType } from "../project/types.ts";

/** Every `TextAnimationType`, in the order shown in the Inspector's Animation picker — mirrors
 *  `TRANSITION_TYPE_OPTIONS`'s own role in `timeline/transitions.ts` as the one shared source of truth
 *  a UI iterates rather than hardcoding its own copy of the union's values. */
export const TEXT_ANIMATION_TYPE_OPTIONS: TextAnimationType[] = ["bounce", "pulse", "wiggle", "typewriter", "wordHighlight"];

export const TEXT_ANIMATION_TYPE_LABEL: Record<TextAnimationType, string> = {
  bounce: "Bounce",
  pulse: "Pulse",
  wiggle: "Wiggle",
  typewriter: "Typewriter",
  wordHighlight: "Word Highlight",
};

/** `Clip.textAnimation.highlightColor`'s own fallback when a clip has `type: "wordHighlight"` but no
 *  color saved yet (a freshly-picked animation, or an older project) — matches the Karaoke text-style
 *  preset's color, since the two are the same visual idea (a bright accent color picking out the
 *  "current" word) and picking the same default keeps them from clashing if used together. */
export const DEFAULT_WORD_HIGHLIGHT_COLOR = "#ffe600";

/** What `computeTextAnimationTransform` adds on TOP of a text clip's own already-resolved position —
 *  a pure delta, not a replacement, so the caller composes it with `style.offsetX/offsetY`/
 *  `rotationDeg` the exact same way `PlaybackEngine.drawText` already composes THOSE onto the frame
 *  center (see its own comment). `scale`/`rotationDeg` pivot around the text's own anchor point, not
 *  the frame's — the caller is responsible for translating there first. */
export interface TextAnimationTransform {
  dx: number;
  dy: number;
  scale: number;
  rotationDeg: number;
}

const IDENTITY_TEXT_ANIMATION_TRANSFORM: TextAnimationTransform = { dx: 0, dy: 0, scale: 1, rotationDeg: 0 };

// Exported (not just used locally) so `buildExportPlan.ts` can build the exact same sine expressions
// as FFmpeg-level `y=`/`fontsize=`/`rotate a=` formulas — export and preview sharing these numbers
// directly rules out the two ever silently drifting apart the way two independently-typed copies could.
export const BOUNCE_AMPLITUDE_PX = 14;
export const BOUNCE_PERIOD_SECONDS = 0.9;
export const PULSE_AMPLITUDE = 0.08;
export const PULSE_PERIOD_SECONDS = 1.1;
export const WIGGLE_AMPLITUDE_DEG = 6;
export const WIGGLE_PERIOD_SECONDS = 1.3;

/** Resolves `type` + however many seconds this clip has been on screen into the transform delta to
 *  apply for THIS frame — a pure function of elapsed time (no internal clock/state), so scrubbing the
 *  playhead backward looks identical to having played forward to the same instant, the same
 *  determinism `compositeTransitionFrame`'s own `progress` parameter already guarantees for
 *  transitions. Amplitudes/periods are fixed constants, not user-tunable — same "the capability exists,
 *  fine-tuning it is a later ask" scope line `DEFAULT_TRANSITION`'s own fixed 0.5s duration draws.
 *
 *  `typewriter` returns the identity transform — it doesn't move/scale/rotate the text at all, it
 *  reveals a progressively longer PREFIX of the content instead (see `typewriterVisibleContent`), an
 *  orthogonal kind of change this shape can't express. */
export function computeTextAnimationTransform(type: TextAnimationType, elapsedSeconds: number): TextAnimationTransform {
  switch (type) {
    case "bounce": {
      // `abs(sin(...))` — always a hop UPWARD from rest and back, never below it, so this reads as a
      // repeated bounce rather than a smooth up-and-down sway (the feel `wiggle`'s rotation already
      // covers, via a different axis).
      const phase = (elapsedSeconds / BOUNCE_PERIOD_SECONDS) * Math.PI * 2;
      return { ...IDENTITY_TEXT_ANIMATION_TRANSFORM, dy: -Math.abs(Math.sin(phase)) * BOUNCE_AMPLITUDE_PX };
    }
    case "pulse": {
      const phase = (elapsedSeconds / PULSE_PERIOD_SECONDS) * Math.PI * 2;
      return { ...IDENTITY_TEXT_ANIMATION_TRANSFORM, scale: 1 + Math.sin(phase) * PULSE_AMPLITUDE };
    }
    case "wiggle": {
      const phase = (elapsedSeconds / WIGGLE_PERIOD_SECONDS) * Math.PI * 2;
      return { ...IDENTITY_TEXT_ANIMATION_TRANSFORM, rotationDeg: Math.sin(phase) * WIGGLE_AMPLITUDE_DEG };
    }
    case "typewriter":
    case "wordHighlight":
      // Neither moves/scales/rotates the text — `typewriter` changes which CHARACTERS are visible
      // (`typewriterVisibleContent`), `wordHighlight` changes which WORD is drawn in the highlight
      // color (`activeWordIndex`, below) — both orthogonal to this shape.
      return IDENTITY_TEXT_ANIMATION_TRANSFORM;
  }
}

/** One piece of a line, in reading order — either a real word or the whitespace/punctuation between
 *  two words. Concatenating every segment's own `text` in order reproduces the original line exactly,
 *  so a caller drawing/positioning each piece in sequence never has to re-derive spacing separately —
 *  it just skips coloring/counting the non-word ones. */
export interface TextSegment {
  text: string;
  isWord: boolean;
}

/** Splits ONE line into its ordered words-and-separators via `Intl.Segmenter`'s dictionary-based word
 *  boundary detection — the ONE place `wordHighlight` decides what counts as "a word", shared by
 *  `splitWords`/`activeWordIndex` below (which word is CURRENTLY highlighted), `PlaybackEngine.drawText`'s
 *  own fill loop (which pixels actually get drawn in the highlight color), and `buildExportPlan.ts`'s
 *  `buildWordHighlightAss` (the export equivalent, via libass instead of canvas) — all three MUST agree
 *  on the exact same word boundaries and ordering, or the index computed here would highlight a
 *  DIFFERENT word than whichever one those two actually color.
 *
 *  This exists at all — instead of every caller doing its own `line.split(/\s+/)` — because a plain
 *  whitespace split is flatly WRONG for Khmer (and Thai, Lao, Myanmar, Chinese, Japanese): those
 *  scripts don't put spaces between words at all, so `"សួស្តីអ្នករាល់គ្នា".split(/\s+/)` returns the
 *  ENTIRE sentence as one "word", and `wordHighlight` would only ever be able to highlight the whole
 *  line at once. `Intl.Segmenter` (the ECMAScript Internationalization API, backed by ICU) does real
 *  dictionary-based word segmentation for exactly these scripts — confirmed empirically (not assumed
 *  from spec text) that it correctly splits real Khmer sentences into their actual words, and that
 *  this holds regardless of which `locale` argument is passed, since ICU's break iterator selects its
 *  rule set from the SCRIPT of the text being segmented, not the caller's requested locale — so this
 *  passes `undefined` (the runtime's default) rather than hardcoding a locale this app has no reliable
 *  way to know for arbitrary caption content anyway. Ordinary space-delimited text (English and
 *  friends) segments correctly through the exact same call, no branching needed for "which kind of
 *  text is this". Available in both the browser (preview) and Node 22 (export) without any polyfill —
 *  confirmed against this project's own bundled Node version, which ships full ICU data by default. */
export function segmentLine(line: string): TextSegment[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  const segments: TextSegment[] = [];
  for (const { segment, isWordLike } of segmenter.segment(line)) {
    segments.push({ text: segment, isWord: Boolean(isWordLike) });
  }
  return segments;
}

/** Splits `content` into its individual words, in reading order across every line (line breaks
 *  themselves never count as part of a word, same as whitespace within a line) — the SAME order
 *  `PlaybackEngine.drawText`'s own word-by-word fill loop walks when `wordHighlight` is active, so an
 *  index from this function always means the same word there. Whitespace-only content yields an empty
 *  array (0 words), not an array containing an empty string. Built from `segmentLine`, one line at a
 *  time, so this can never disagree with a renderer that's ALSO walking `segmentLine` per line (see
 *  its own comment) — a single `Intl.Segmenter` pass over the whole multi-line string would very
 *  likely agree too, but there's no reason to rely on that when going line-by-line costs nothing and
 *  removes the question entirely. */
export function splitWords(content: string): string[] {
  const words: string[] = [];
  for (const line of content.split("\n")) {
    for (const segment of segmentLine(line)) {
      if (segment.isWord) words.push(segment.text);
    }
  }
  return words;
}

/** Which word (a 0-based index into `splitWords(content)`) should be drawn in the highlight color
 *  `elapsedSeconds` into a `wordHighlight`-animated clip whose own nominal duration is
 *  `clipDurationSeconds` — spread EVENLY across the clip's own length, not a fixed words-per-second
 *  rate the way `typewriterVisibleContent` uses for characters, so a caption's last word finishes
 *  highlighting right as the clip itself ends regardless of how many words it has or how long the clip
 *  is. Returns `-1` (nothing highlighted) for empty content or a non-positive duration — both mean
 *  there's no meaningful "current word" to compute. */
export function activeWordIndex(wordCount: number, elapsedSeconds: number, clipDurationSeconds: number): number {
  if (wordCount <= 0 || clipDurationSeconds <= 0) return -1;
  const secondsPerWord = clipDurationSeconds / wordCount;
  return Math.min(wordCount - 1, Math.max(0, Math.floor(elapsedSeconds / secondsPerWord)));
}

/** Characters per second the `typewriter` animation reveals content at — fast enough to finish a short
 *  caption line well within a normal clip's duration, slow enough to actually read as a typing effect
 *  rather than a near-instant cut. */
export const TYPEWRITER_CHARS_PER_SECOND = 18;

/** The prefix of `content` that should be visible `elapsedSeconds` into a `typewriter`-animated clip —
 *  clamped to the full string once enough time has passed, so the clip settles on showing everything
 *  for its remaining duration rather than looping or vanishing. */
export function typewriterVisibleContent(content: string, elapsedSeconds: number): string {
  const visibleCount = Math.max(0, Math.floor(elapsedSeconds * TYPEWRITER_CHARS_PER_SECOND));
  return content.slice(0, visibleCount);
}
