"use client";

import { useEffect, useState } from "react";

interface Props {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  step?: number;
  suffix?: string;
  /** Converts the stored value to what the field displays (e.g. a 0..1 fraction shown as 0..100). */
  toDisplay?: (value: number) => number;
  /** Inverse of `toDisplay` — converts what the user typed back to the stored unit. */
  fromDisplay?: (value: number) => number;
  /** In DISPLAY units (post `toDisplay`). Both must be set to also render a slider — reserved for
   *  genuinely bounded, perceptually-linear ranges (Effects, Crop, Opacity) where dragging a handle
   *  is a natural way to feel out a value. Deliberately omitted for open-ended fields (Position,
   *  Rotation, Scale) where a fixed-range slider would be mostly dead space. */
  min?: number;
  max?: number;
  /** Narrower number input, for two fields sharing one row (e.g. Position X/Y) — the panel is too
   *  narrow for two full-width fields side by side otherwise. */
  compact?: boolean;
}

/** A number input — with an optional slider alongside it — that commits on blur/Enter/drag-release,
 *  not on every keystroke or every pixel of drag.
 *
 *  Committing continuously would push a new `SetClipTransformCommand` — and a new undo-stack entry —
 *  for every digit typed or every mouse-move while dragging, so undoing "rotate to 180°" or "dragged
 *  the opacity slider" would take dozens of steps instead of one. Local state mirrors the real value
 *  only while the field ISN'T being interacted with, so external changes (selecting a different clip,
 *  an undo elsewhere) still show up immediately without fighting whatever the user is mid-edit on. */
export function NumberField({ label, value, onCommit, step = 1, suffix, toDisplay, fromDisplay, min, max, compact }: Props) {
  const display = toDisplay ? toDisplay(value) : value;
  const [text, setText] = useState(() => formatValue(display));
  const [interacting, setInteracting] = useState(false);

  useEffect(() => {
    if (!interacting) setText(formatValue(display));
    // Only the real value (and unit conversion) should resync the field — `interacting` itself must
    // NOT be a dependency, or the effect would immediately overwrite the user's in-progress typing/
    // dragging the instant the field is touched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display]);

  function commit(raw: string) {
    const parsed = Number(raw);
    const next = Number.isFinite(parsed) ? parsed : display;
    const stored = fromDisplay ? fromDisplay(next) : next;
    setText(formatValue(next));
    if (stored !== value) onCommit(stored);
  }

  const hasSlider = min !== undefined && max !== undefined;
  const sliderValue = Math.min(max ?? 0, Math.max(min ?? 0, Number(text) || 0));

  return (
    <div className="py-1.5">
      <label className="flex items-center justify-between gap-2">
        <span className="text-[12px] text-white/50">{label}</span>
        <span className="flex items-center gap-1.5">
          <input
            type="number"
            inputMode="decimal"
            step={step}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setInteracting(true)}
            onBlur={() => {
              setInteracting(false);
              commit(text);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setText(formatValue(display));
                e.currentTarget.blur();
              }
            }}
            // 16px below `lg`: iOS Safari auto-zooms the whole page on focusing a text input under
            // 16px, which would fire every time this field is tapped on a phone or tablet.
            className={`rounded bg-white/5 px-2 py-1 text-right font-mono text-[16px] tabular-nums text-white/90 focus:outline-none focus:ring-1 focus:ring-sky-400/60 lg:text-[12px] ${
              compact ? "w-14" : "w-20"
            }`}
          />
          {suffix && <span className="w-4 text-[11px] text-white/35">{suffix}</span>}
        </span>
      </label>
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
          }}
          onMouseUp={(e) => {
            setInteracting(false);
            commit(e.currentTarget.value);
          }}
          onTouchEnd={(e) => {
            setInteracting(false);
            commit(e.currentTarget.value);
          }}
          onKeyUp={(e) => {
            setInteracting(false);
            commit(e.currentTarget.value);
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
