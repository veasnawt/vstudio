"use client";

import React, { useEffect, useState } from "react";

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
}

/** A number input that commits on blur/Enter, not on every keystroke.
 *
 *  Committing per-keystroke would push a new `SetClipTransformCommand` — and a new undo-stack entry —
 *  for every digit typed, so undoing "rotate to 180°" would take three steps instead of one. Local
 *  state mirrors the real value only while the field ISN'T focused, so external changes (selecting a
 *  different clip, an undo elsewhere) still show up immediately without fighting whatever the user is
 *  mid-edit on. */
export function NumberField({ label, value, onCommit, step = 1, suffix, toDisplay, fromDisplay }: Props) {
  const display = toDisplay ? toDisplay(value) : value;
  const [text, setText] = useState(() => formatValue(display));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(formatValue(display));
    // Only the real value (and unit conversion) should resync the field — `focused` itself must NOT
    // be a dependency, or the effect would immediately overwrite the user's in-progress typing the
    // instant the field gains focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display]);

  function commit() {
    const parsed = Number(text);
    const next = Number.isFinite(parsed) ? parsed : display;
    const stored = fromDisplay ? fromDisplay(next) : next;
    setText(formatValue(next));
    if (stored !== value) onCommit(stored);
  }

  return (
    <label className="flex items-center justify-between gap-2 py-1">
      <span className="text-[11px] text-white/45">{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          inputMode="decimal"
          step={step}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            commit();
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
          className="w-16 rounded bg-white/5 px-1.5 py-0.5 text-right font-mono text-[16px] tabular-nums text-white/90 focus:outline-none focus:ring-1 focus:ring-sky-400/60 lg:text-[11px]"
        />
        {suffix && <span className="w-3 text-[10px] text-white/35">{suffix}</span>}
      </span>
    </label>
  );
}

function formatValue(value: number): string {
  // Two decimals is enough precision for pixels/percent/degrees to feel exact without the field
  // showing floating-point noise like "24.000000001".
  return (Math.round(value * 100) / 100).toString();
}
