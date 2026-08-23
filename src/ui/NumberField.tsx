"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n/useTranslation.ts";

interface Props {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  /** Fires continuously while the value is being interacted with — every keystroke, every pixel of a
   *  slider/scrub drag — in the same STORED units `onCommit` receives. Lets a caller mirror the
   *  in-progress value somewhere live (the canvas preview, via `livePreviewOverrides`) without that
   *  needing to become a real, undo-stack-entry commit on every keystroke/pixel — see `onCommit`'s own
   *  comment below for why those two stay separate. Optional: a field with nothing visual to preview
   *  (Volume, Transition duration) just omits it. */
  onPreview?: (value: number) => void;
  step?: number;
  suffix?: string;
  /** Converts the stored value to what the field displays (e.g. a 0..1 fraction shown as 0..100). */
  toDisplay?: (value: number) => number;
  /** Inverse of `toDisplay` — converts what the user typed back to the stored unit. */
  fromDisplay?: (value: number) => number;
  /** In DISPLAY units (post `toDisplay`). Both must be set to also render a slider — reserved for
   *  bounded ranges (Effects, Crop, Scale) where dragging a handle is a natural way to feel out a
   *  value. Deliberately omitted for genuinely open-ended fields (Position, Rotation) where a
   *  fixed-range slider would be mostly dead space or would clip off values people actually type. */
  min?: number;
  max?: number;
  /** Narrower number input, for two fields sharing one row (e.g. Position X/Y) — the panel is too
   *  narrow for two full-width fields side by side otherwise. Also drops the ± stepper buttons, which
   *  don't fit in that width — the drag-scrub label and typing still work exactly the same. */
  compact?: boolean;
}

/** Horizontal pixels of drag == one `step` of value change, for the drag-scrub label below. Small
 *  enough that a field with a fine `step` (Rotation: 1°) still covers its whole practical range in a
 *  normal-length drag, without feeling twitchy for a coarse one (Scale: 5%). */
const SCRUB_PX_PER_STEP = 4;

/** A number input — with an optional slider alongside it, ± stepper buttons, and a drag-to-scrub
 *  label — that commits on blur/Enter/drag-release, not on every keystroke or every pixel of drag.
 *
 *  Committing continuously would push a new `SetClipTransformCommand` — and a new undo-stack entry —
 *  for every digit typed or every mouse-move while dragging, so undoing "rotate to 180°" or "dragged
 *  the opacity slider" would take dozens of steps instead of one. Local state mirrors the real value
 *  only while the field ISN'T being interacted with, so external changes (selecting a different clip,
 *  an undo elsewhere) still show up immediately without fighting whatever the user is mid-edit on.
 *  `onPreview` (see its own doc comment) is the escape hatch that still lets the CANVAS reflect the
 *  in-progress value live, without that meaning a real commit.
 *
 *  Deliberately a plain `<div>`, not a wrapping `<label>`, around the label span and the input — same
 *  reasoning `Dropdown.tsx`'s own comment gives: a `<label>` forwards any click on itself (including
 *  the drag-scrub gesture below) to its labelable descendant, which would yank focus into the text
 *  input mid-drag. The input gets its accessible name via `aria-label` instead. */
export function NumberField({
  label,
  value,
  onCommit,
  onPreview,
  step = 1,
  suffix,
  toDisplay,
  fromDisplay,
  min,
  max,
  compact,
}: Props) {
  const t = useTranslation();
  const display = toDisplay ? toDisplay(value) : value;
  const [text, setText] = useState(() => formatValue(display));
  const [interacting, setInteracting] = useState(false);
  const scrubRef = useRef<{ startX: number; startDisplay: number; pointerId: number } | null>(null);

  useEffect(() => {
    if (!interacting) setText(formatValue(display));
    // Only the real value (and unit conversion) should resync the field — `interacting` itself must
    // NOT be a dependency, or the effect would immediately overwrite the user's in-progress typing/
    // dragging the instant the field is touched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display]);

  function clampDisplay(v: number): number {
    let out = v;
    if (min !== undefined) out = Math.max(min, out);
    if (max !== undefined) out = Math.min(max, out);
    return out;
  }

  function preview(nextDisplay: number) {
    if (!onPreview) return;
    onPreview(fromDisplay ? fromDisplay(nextDisplay) : nextDisplay);
  }

  function commit(nextDisplay: number) {
    const clamped = clampDisplay(nextDisplay);
    const stored = fromDisplay ? fromDisplay(clamped) : clamped;
    setText(formatValue(clamped));
    if (stored !== value) onCommit(stored);
  }

  function commitRaw(raw: string) {
    const parsed = Number(raw);
    commit(Number.isFinite(parsed) ? parsed : display);
  }

  function nudge(delta: number) {
    const current = Number(text);
    commit((Number.isFinite(current) ? current : display) + delta);
  }

  function onScrubPointerDown(e: React.PointerEvent<HTMLSpanElement>) {
    // Only the primary button/touch starts a scrub — a right-click on the label shouldn't hijack it.
    if (e.button !== 0) return;
    const current = Number(text);
    scrubRef.current = { startX: e.clientX, startDisplay: Number.isFinite(current) ? current : display, pointerId: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
    setInteracting(true);
  }

  function onScrubPointerMove(e: React.PointerEvent<HTMLSpanElement>) {
    const drag = scrubRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const next = drag.startDisplay + ((e.clientX - drag.startX) / SCRUB_PX_PER_STEP) * step;
    const clamped = clampDisplay(next);
    setText(formatValue(clamped));
    preview(clamped);
  }

  function onScrubPointerUp(e: React.PointerEvent<HTMLSpanElement>) {
    const drag = scrubRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const next = drag.startDisplay + ((e.clientX - drag.startX) / SCRUB_PX_PER_STEP) * step;
    scrubRef.current = null;
    setInteracting(false);
    commit(next);
  }

  const hasSlider = min !== undefined && max !== undefined;
  const sliderValue = Math.min(max ?? 0, Math.max(min ?? 0, Number(text) || 0));

  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span
          onPointerDown={onScrubPointerDown}
          onPointerMove={onScrubPointerMove}
          onPointerUp={onScrubPointerUp}
          onPointerCancel={onScrubPointerUp}
          title={t("Drag left/right to adjust")}
          className="cursor-ew-resize select-none text-[12px] text-white/50 transition hover:text-white/80"
        >
          {label}
        </span>
        <span className="flex items-center gap-1">
          {!compact && (
            <button
              type="button"
              onClick={() => nudge(-step)}
              aria-label={t("Decrease")}
              tabIndex={-1}
              className="flex h-6 w-5 shrink-0 items-center justify-center rounded bg-white/5 text-white/50 transition hover:bg-white/10 hover:text-white"
            >
              −
            </button>
          )}
          <input
            type="number"
            inputMode="decimal"
            aria-label={label}
            step={step}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              const parsed = Number(e.target.value);
              if (Number.isFinite(parsed)) preview(clampDisplay(parsed));
            }}
            onFocus={() => setInteracting(true)}
            onBlur={() => {
              setInteracting(false);
              commitRaw(text);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setText(formatValue(display));
                e.currentTarget.blur();
              }
            }}
            // No native spinner: replaced by the ± buttons (horizontal, not the browser's tiny
            // vertical up/down arrows) and the drag-scrub label above.
            // 16px below `lg`: iOS Safari auto-zooms the whole page on focusing a text input under
            // 16px, which would fire every time this field is tapped on a phone or tablet.
            className={`rounded bg-white/5 px-2 py-1 text-right font-mono text-[16px] tabular-nums text-white/90 [appearance:textfield] focus:outline-none focus:ring-1 focus:ring-sky-400/60 lg:text-[12px] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${
              compact ? "w-14" : "w-16"
            }`}
          />
          {!compact && (
            <button
              type="button"
              onClick={() => nudge(step)}
              aria-label={t("Increase")}
              tabIndex={-1}
              className="flex h-6 w-5 shrink-0 items-center justify-center rounded bg-white/5 text-white/50 transition hover:bg-white/10 hover:text-white"
            >
              +
            </button>
          )}
          {suffix && <span className="w-4 text-[11px] text-white/35">{suffix}</span>}
        </span>
      </div>
      {hasSlider && (
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={sliderValue}
          onChange={(e) => {
            setInteracting(true);
            setText(e.target.value);
            preview(Number(e.target.value));
          }}
          onMouseUp={(e) => {
            setInteracting(false);
            commitRaw(e.currentTarget.value);
          }}
          onTouchEnd={(e) => {
            setInteracting(false);
            commitRaw(e.currentTarget.value);
          }}
          onKeyUp={(e) => {
            setInteracting(false);
            commitRaw(e.currentTarget.value);
          }}
          aria-label={label}
          className="mt-1.5 w-full accent-sky-400"
        />
      )}
    </div>
  );
}

function formatValue(value: number): string {
  // Two decimals is enough precision for pixels/percent/degrees to feel exact without the field
  // showing floating-point noise like "24.000000001".
  return (Math.round(value * 100) / 100).toString();
}
