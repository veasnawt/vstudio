"use client";

import { useRef, useState } from "react";
import { addDragListeners, clientPoint, preventDefaultIfMouse } from "./pointerEvents.ts";

interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Value that reads as visually "center" — the indicator points straight up here, and double-click
   *  resets to it. For a pan knob this is `0`; exposed generally in case a future knob wants an
   *  off-center default. */
  center?: number;
  onCommit: (value: number) => void;
  /** Fires continuously during a drag, same "live preview, no undo entry" contract `NumberField.onPreview`
   *  already establishes elsewhere in this app. */
  onPreview?: (value: number) => void;
  /** Formats the readout under the knob — e.g. "L50"/"C"/"R50" for pan. Defaults to a plain rounded
   *  number. */
  formatValue?: (value: number) => string;
}

/** Dragging this many vertical pixels covers the knob's whole min..max range — tuned for a comfortable,
 *  not twitchy, feel on a compact (~32px) knob. */
const DRAG_PX_FOR_FULL_RANGE = 150;
/** -135deg..+135deg — matches most hardware pan/gain knobs' own visual sweep, leaving a visible gap at
 *  the bottom so the knob doesn't read as a full dial. */
const SWEEP_DEG = 270;

/** A compact rotary control — built for the Mixer's per-track Pan knob, but generic (min/max/center)
 *  in case a future control wants the same look. Drag mechanics are VERTICAL-distance-to-value, not
 *  true circular angle-tracking: at this knob's small size, angle-from-center math would make a few
 *  pixels of pointer jitter swing the value across its whole range, and dragging outside the knob's own
 *  small hit-radius (trivial to do by accident) would produce discontinuous jumps. Vertical-drag is how
 *  most software knobs actually work, and matches this app's own drag-scrub `NumberField` label
 *  convention already. */
export function RotaryKnob({ label, value, min, max, center = 0, onCommit, onPreview, formatValue }: Props) {
  const [dragValue, setDragValue] = useState<number | null>(null);
  // Mirrors `dragValue` for `onMove`/`onUp` to read imperatively — those closures are created once per
  // drag gesture and would otherwise only ever see the STALE value from the moment the drag started,
  // not the latest one a fast series of `onMove` calls has since produced. Same "ref for handlers that
  // need the current value, state for what actually re-renders" split `TimelineClip.tsx`'s own
  // `preview`/`previewRef` pair uses.
  const dragValueRef = useRef<number | null>(null);
  const dragOriginRef = useRef<{ startY: number; startValue: number } | null>(null);

  const display = dragValue ?? value;

  function clamp(v: number): number {
    return Math.min(max, Math.max(min, v));
  }

  function angleFor(v: number): number {
    return ((v - center) / (max - min)) * SWEEP_DEG;
  }

  function beginDrag(event: React.MouseEvent | React.TouchEvent): void {
    const isTouch = "touches" in event;
    if (!isTouch && (event as React.MouseEvent).button !== 0) return;
    preventDefaultIfMouse(event);
    const start = clientPoint(event);
    dragOriginRef.current = { startY: start.y, startValue: value };

    function onMove(moveEvent: MouseEvent | TouchEvent): void {
      const origin = dragOriginRef.current;
      if (!origin) return;
      const point = clientPoint(moveEvent);
      const dy = origin.startY - point.y; // up = increase, matching every other drag-scrub in this app
      const next = clamp(origin.startValue + (dy / DRAG_PX_FOR_FULL_RANGE) * (max - min));
      dragValueRef.current = next;
      setDragValue(next);
      onPreview?.(next);
    }

    function onUp(): void {
      removeListeners();
      dragOriginRef.current = null;
      const finalValue = dragValueRef.current;
      dragValueRef.current = null;
      setDragValue(null);
      if (finalValue !== null) onCommit(finalValue);
    }

    const removeListeners = addDragListeners(onMove, onUp);
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    const step = (max - min) / 100;
    if (event.key === "ArrowUp" || event.key === "ArrowRight") {
      event.preventDefault();
      const next = clamp(value + step);
      onPreview?.(next);
      onCommit(next);
    } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
      event.preventDefault();
      const next = clamp(value - step);
      onPreview?.(next);
      onCommit(next);
    } else if (event.key === "Home") {
      event.preventDefault();
      onCommit(center);
    }
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <div
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={display}
        tabIndex={0}
        onMouseDown={beginDrag}
        onTouchStart={beginDrag}
        onDoubleClick={() => onCommit(center)}
        onKeyDown={onKeyDown}
        className="relative h-8 w-8 shrink-0 cursor-ns-resize touch-none select-none rounded-full bg-white/10 ring-1 ring-white/15 hover:ring-white/25 focus:outline-none focus:ring-2 focus:ring-sky-400/70"
      >
        <div
          aria-hidden
          className="absolute bottom-1/2 left-1/2 h-3 w-0.5 origin-bottom rounded-full bg-sky-300"
          style={{ transform: `translateX(-50%) rotate(${angleFor(display)}deg)` }}
        />
      </div>
      <span className="text-[10px] tabular-nums text-white/50">{formatValue ? formatValue(display) : Math.round(display)}</span>
    </div>
  );
}
