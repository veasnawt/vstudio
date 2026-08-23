"use client";

import { useEffect, useRef } from "react";
import { FADER_MAX_DB, FADER_MIN_DB } from "./faderScale.ts";

interface Props {
  /** Read fresh every animation frame — NOT a reactive prop. Typically
   *  `() => useEditorStore.getState().playbackEngine?.getTrackLevelDb(trackId) ?? null` (a plain
   *  imperative `getState()` read, not a subscribed selector), so only `getLevelDb`'s own identity
   *  changing (rare — once per engine mount) ever re-triggers this component's polling effect. */
  getLevelDb: () => number | null;
  heightPx: number;
}

/** How long a peak stays pinned before it starts decaying back down, in ms — long enough to actually
 *  read at a glance, short enough that the meter doesn't feel stuck. */
const PEAK_HOLD_MS = 1000;
/** dB/second the peak marker falls once its hold expires — a real console meter's own ballistic decay,
 *  not an instant snap back to the live level. */
const PEAK_DECAY_DB_PER_SECOND = 20;

function dbToFraction(db: number): number {
  return Math.min(1, Math.max(0, (db - FADER_MIN_DB) / (FADER_MAX_DB - FADER_MIN_DB)));
}

/** A live, self-contained peak-hold level meter. Runs its OWN `requestAnimationFrame` loop for as long
 *  as it's mounted, reading `getLevelDb()` and writing straight to two DOM refs' inline styles every
 *  frame — deliberately no React state anywhere in that per-frame path, matching how
 *  `PlaybackEngine`/`AudioMixEngine` themselves already operate entirely outside React's render cycle.
 *  A `setState` here would mean a full component re-render 60 times a second per meter, for a value
 *  that only ever drives two inline styles — pure waste this sidesteps entirely. */
export function LevelMeter({ getLevelDb, heightPx }: Props) {
  // Anchored to the TOP, covers the color-zone gradient down to the current level — as the level
  // rises, this shrinks, revealing more of the gradient from the BOTTOM up (matching how a real meter
  // fills). Simpler than animating a bottom-anchored fill bar's own color per zone: the gradient
  // itself is static, only this cover's height ever changes.
  const coverRef = useRef<HTMLDivElement>(null);
  const peakRef = useRef<HTMLDivElement>(null);
  const peakState = useRef({ peakDb: FADER_MIN_DB, heldAt: 0 });

  useEffect(() => {
    let rafId: number;
    const loop = () => {
      const db = getLevelDb() ?? FADER_MIN_DB;
      const now = performance.now();
      const state = peakState.current;
      if (db >= state.peakDb) {
        state.peakDb = db;
        state.heldAt = now;
      } else if (now - state.heldAt > PEAK_HOLD_MS) {
        const decayed = state.peakDb - (PEAK_DECAY_DB_PER_SECOND * (now - state.heldAt - PEAK_HOLD_MS)) / 1000;
        state.peakDb = Math.max(db, decayed);
      }

      const fillFraction = dbToFraction(db);
      const peakFraction = dbToFraction(state.peakDb);
      if (coverRef.current) coverRef.current.style.height = `${(1 - fillFraction) * 100}%`;
      if (peakRef.current) peakRef.current.style.bottom = `${peakFraction * 100}%`;

      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [getLevelDb]);

  return (
    <div className="relative w-2 shrink-0 overflow-hidden rounded-full bg-white/5 ring-1 ring-inset ring-white/10" style={{ height: heightPx }}>
      {/* Static color-zone gradient spanning the whole track — green below ~-12dB, yellow -12..-3dB,
          red -3dB and above. Standard broadcast-meter zone convention. */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background: `linear-gradient(to top,
            #34d399 0%, #34d399 ${dbToFraction(-12) * 100}%,
            #facc15 ${dbToFraction(-12) * 100}%, #facc15 ${dbToFraction(-3) * 100}%,
            #f87171 ${dbToFraction(-3) * 100}%, #f87171 100%)`,
        }}
      />
      <div aria-hidden ref={coverRef} className="absolute inset-x-0 top-0 bg-[#0d0f14]" style={{ height: "100%" }} />
      <div aria-hidden ref={peakRef} className="absolute inset-x-0 h-0.5 bg-white/90" style={{ bottom: 0 }} />
    </div>
  );
}
