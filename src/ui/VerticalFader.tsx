"use client";

import { useRef, useState } from "react";
import { dbToGain, FADER_MAX_DB, FADER_MIN_DB, gainToDb } from "./faderScale.ts";
import { addDragListeners, clientPoint, preventDefaultIfMouse } from "./pointerEvents.ts";

interface Props {
  label: string;
  /** Stored linear gain — same unit `setTrackGain`/`SetTrackGainCommand`/`SetMasterGainCommand` already
   *  use. This component works in dB internally (`faderScale.ts`) purely for its own display/drag
   *  math; `onPreview`/`onCommit` always fire with the linear value so wiring this up is a drop-in
   *  replacement for the horizontal `NumberField` the Mixer used to use. */
  gain: number;
  onCommit: (gain: number) => void;
  onPreview?: (gain: number) => void;
  heightPx?: number;
}

const DEFAULT_HEIGHT_PX = 160;
/** Tick marks alongside the track, top to bottom — matches `FADER_MAX_DB`/`FADER_MIN_DB`'s own range.
 *  The bottom-most stop reads "-∞" separately (see the render below) even though the actual stored
 *  value there is an exact `0`, matching every real fader's own bottom-label convention. */
const DB_TICKS = [12, 0, -12, -24, -48];

function formatDb(db: number): string {
  if (db <= FADER_MIN_DB) return "-∞";
  return `${db >= 0 ? "+" : ""}${db.toFixed(1)}`;
}

/** A dB-scaled vertical fader — the Mixer's per-track/master gain control. Standalone rather than an
 *  extension of `NumberField`: a tall drag-anywhere vertical control with its own dB tick scale shares
 *  almost nothing implementation-wise with `NumberField`'s horizontal range-input-plus-scrub-label
 *  design, only the `onPreview`/`onCommit` CONTRACT needs to match, not the code. */
export function VerticalFader({ label, gain, onCommit, onPreview, heightPx = DEFAULT_HEIGHT_PX }: Props) {
  const [dragGain, setDragGain] = useState<number | null>(null);
  // Same ref-mirrors-state reasoning as `RotaryKnob`'s own `dragValueRef` — `onUp` needs the LATEST
  // value, not the one captured when the drag started.
  const dragGainRef = useRef<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const display = dragGain ?? gain;
  const db = gainToDb(display);
  const fillFraction = Math.min(1, Math.max(0, (db - FADER_MIN_DB) / (FADER_MAX_DB - FADER_MIN_DB)));

  function dbFromClientY(clientY: number): number {
    const track = trackRef.current;
    if (!track) return db;
    const rect = track.getBoundingClientRect();
    const fractionFromTop = rect.height > 0 ? Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)) : 0;
    const fractionFromBottom = 1 - fractionFromTop;
    return FADER_MIN_DB + fractionFromBottom * (FADER_MAX_DB - FADER_MIN_DB);
  }

  function applyFromClientY(clientY: number): void {
    const nextGain = dbToGain(dbFromClientY(clientY));
    dragGainRef.current = nextGain;
    setDragGain(nextGain);
    onPreview?.(nextGain);
  }

  function beginDrag(event: React.MouseEvent | React.TouchEvent): void {
    const isTouch = "touches" in event;
    if (!isTouch && (event as React.MouseEvent).button !== 0) return;
    preventDefaultIfMouse(event);
    // Jump-to-click on press (not just on subsequent drag) — the conventional fader interaction: click
    // anywhere on the track and the thumb jumps straight there, then follows the drag from there.
    applyFromClientY(clientPoint(event).y);

    function onMove(moveEvent: MouseEvent | TouchEvent): void {
      applyFromClientY(clientPoint(moveEvent).y);
    }

    function onUp(): void {
      removeListeners();
      const finalGain = dragGainRef.current;
      dragGainRef.current = null;
      setDragGain(null);
      if (finalGain !== null) onCommit(finalGain);
    }

    const removeListeners = addDragListeners(onMove, onUp);
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    const stepDb = 1;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const next = dbToGain(Math.min(FADER_MAX_DB, db + stepDb));
      onPreview?.(next);
      onCommit(next);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = dbToGain(Math.max(FADER_MIN_DB, db - stepDb));
      onPreview?.(next);
      onCommit(next);
    } else if (event.key === "Home") {
      event.preventDefault();
      onCommit(1);
    }
  }

  return (
    <div className="flex items-stretch gap-1">
      <div className="relative flex flex-col justify-between py-1 text-right text-[8px] leading-none text-white/30" style={{ height: heightPx }}>
        {DB_TICKS.map((tick) => (
          <span key={tick}>{tick > 0 ? `+${tick}` : tick}</span>
        ))}
      </div>
      <div
        ref={trackRef}
        role="slider"
        aria-label={label}
        aria-valuemin={FADER_MIN_DB}
        aria-valuemax={FADER_MAX_DB}
        aria-valuenow={Math.round(db)}
        tabIndex={0}
        onMouseDown={beginDrag}
        onTouchStart={beginDrag}
        onDoubleClick={() => onCommit(1)}
        onKeyDown={onKeyDown}
        className="relative w-3 shrink-0 touch-none select-none rounded-full bg-white/10 ring-1 ring-white/15 hover:ring-white/25 cursor-ns-resize focus:outline-none focus:ring-2 focus:ring-sky-400/70"
        style={{ height: heightPx }}
      >
        <div aria-hidden className="absolute inset-x-0 bottom-0 rounded-full bg-sky-400/70" style={{ height: `${fillFraction * 100}%` }} />
        <div
          aria-hidden
          className="absolute left-1/2 h-2.5 w-6 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-white shadow"
          style={{ top: `${(1 - fillFraction) * 100}%` }}
        />
      </div>
      <span className="w-9 self-end pb-0.5 text-[9px] tabular-nums text-white/50">{formatDb(db)}</span>
    </div>
  );
}
