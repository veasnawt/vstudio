"use client";

import { useEffect, useRef, useState } from "react";
import { compositeTransitionFrame } from "../playback/PlaybackEngine.ts";
import type { TransitionType } from "../project/types.ts";

const TILE_WIDTH = 96;
const TILE_HEIGHT = 54;
/** One full 0 -> 1 sweep, in ms. Sweeps back down to 0 afterward rather than jump-cutting — a
 *  thumbnail that's supposed to demonstrate smooth motion shouldn't itself stutter on every loop. */
const LOOP_MS = 1400;

const OUTGOING_COLOR = "#f59e0b";
const INCOMING_COLOR = "#38bdf8";

/** Builds one flat placeholder panel — a solid color plus a small centered dot, so a `slide` (the
 *  whole panel translating) reads visibly differently from a `wipe` (the panel staying put while a
 *  boundary sweeps across it) even though both are, geometrically, just two colored rectangles. */
function solidPanel(color: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = TILE_WIDTH;
  canvas.height = TILE_HEIGHT;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, TILE_WIDTH, TILE_HEIGHT);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.beginPath();
  ctx.arc(TILE_WIDTH / 2, TILE_HEIGHT / 2, 5, 0, Math.PI * 2);
  ctx.fill();
  return canvas;
}

// Built once and reused by every tile — every instance draws the identical two placeholder panels,
// only `type` and the animated progress differ, so there's nothing tile-specific to regenerate.
let outgoingPanel: HTMLCanvasElement | null = null;
let incomingPanel: HTMLCanvasElement | null = null;
function panels(): [HTMLCanvasElement, HTMLCanvasElement] {
  outgoingPanel ??= solidPanel(OUTGOING_COLOR);
  incomingPanel ??= solidPanel(INCOMING_COLOR);
  return [outgoingPanel, incomingPanel];
}

/** How a resting (unhovered) tile is drawn: paused at the MIDPOINT of the sweep, not progress 0 — a
 *  flat color block at 0 looks identical across every type (nothing has moved yet), while the
 *  midpoint is where a wipe/slide/circle's actual geometry is most recognizable at a glance without
 *  needing to hover at all. */
const REST_PROGRESS = 0.5;

/** One thumbnail in the transition picker grid — renders `type` through the exact same
 *  `compositeTransitionFrame` a real clip's canvas preview uses, just fed two flat placeholder panels
 *  instead of a real outgoing/incoming clip frame. A faithful geometry preview (the real wipe edge,
 *  the real slide direction, the real circle center), not a decorative stand-in. Only animates on
 *  hover — sitting at `REST_PROGRESS` otherwise — so a 13-tile grid isn't running 13 concurrent rAF
 *  loops the instant it opens; a static frame per idle tile is plenty until the user actually points
 *  at one. */
export function TransitionPreviewTile({ type }: { type: TransitionType }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hovered, setHovered] = useState(false);

  // Sizing/DPR setup only — runs once per mount, independent of `hovered` toggling below, so hovering
  // on and off doesn't repeatedly reset the canvas's own backing store for no reason.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = TILE_WIDTH * dpr;
    canvas.height = TILE_HEIGHT * dpr;
    canvas.getContext("2d")?.scale(dpr, dpr);
  }, []);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const [outgoing, incoming] = panels();

    function paint(progress: number) {
      ctx!.clearRect(0, 0, TILE_WIDTH, TILE_HEIGHT);
      compositeTransitionFrame(ctx!, TILE_WIDTH, TILE_HEIGHT, type, progress, outgoing, incoming);
    }

    if (!hovered) {
      paint(REST_PROGRESS);
      return;
    }

    let frameId: number;
    function draw(now: number) {
      const t = (now % LOOP_MS) / LOOP_MS;
      const progress = t < 0.5 ? t * 2 : 2 - t * 2;
      paint(progress);
      frameId = requestAnimationFrame(draw);
    }
    frameId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameId);
  }, [type, hovered]);

  return (
    <canvas
      ref={canvasRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ width: TILE_WIDTH, height: TILE_HEIGHT }}
      className="rounded border border-white/10 bg-black/40"
    />
  );
}
