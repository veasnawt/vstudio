"use client";

import { useEffect, useRef } from "react";
import {
  activeWordIndex,
  computeTextAnimationTransform,
  splitWords,
  typewriterVisibleContent,
} from "../timeline/textAnimation.ts";
import type { TextAnimationType } from "../project/types.ts";

const TILE_WIDTH = 84;
const TILE_HEIGHT = 48;
const SAMPLE_TEXT = "Text";
/** `wordHighlight` specifically needs more than one word to demonstrate anything — a single word just
 *  sits highlighted (or not) for the whole loop, never visibly "jumping". */
const SAMPLE_WORDS_TEXT = "One Two Three";
/** How long one preview loop takes, in seconds — long enough for `typewriter` to fully type out
 *  `SAMPLE_TEXT` and hold briefly before the tile restarts (a real clip's own `typewriter` doesn't
 *  loop at all — see `TextAnimationType`'s own doc comment — but a picker tile has to keep
 *  demonstrating the effect for as long as it's on screen, so it repeats where a real clip wouldn't). */
const LOOP_SECONDS = 2.4;
const HIGHLIGHT_COLOR = "#ffe600";
const BASE_COLOR = "#38bdf8";
/** Horizontal margin `wordHighlight`'s own fit-to-width shrink keeps clear of the tile's edges. */
const WORD_TILE_PADDING = 6;

/** One always-animating thumbnail in the Inspector's Animation grid — draws a small sample through the
 *  exact same pure timing functions a real text clip's canvas preview uses (see
 *  `PlaybackEngine.drawAnimatedText`), just fed a fixed sample string instead of the clip's own
 *  content. `wordHighlight` reimplements its own small word-by-word fill loop rather than sharing
 *  `PlaybackEngine.drawText`'s (a private instance method, not something a standalone component can
 *  call) — the same `activeWordIndex` timing, just simpler drawing since there's no stroke/shadow/
 *  background/multi-line layout to reproduce for a demo tile. Unlike `TransitionPreviewTile` (13
 *  tiles, hover-gated to avoid 13 concurrent rAF loops), there are only 6 animation options total —
 *  cheap enough to animate all of them continuously without hover-gating. */
export function TextAnimationPreviewTile({ type }: { type: TextAnimationType }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = TILE_WIDTH * dpr;
    canvas.height = TILE_HEIGHT * dpr;
    ctx.scale(dpr, dpr);

    let frameId: number;
    function draw(now: number) {
      const elapsed = (now / 1000) % LOOP_SECONDS;
      ctx!.clearRect(0, 0, TILE_WIDTH, TILE_HEIGHT);
      ctx!.font = "700 15px sans-serif";

      if (type === "typewriter") {
        ctx!.textAlign = "center";
        ctx!.textBaseline = "middle";
        ctx!.fillStyle = BASE_COLOR;
        ctx!.fillText(typewriterVisibleContent(SAMPLE_TEXT, elapsed), TILE_WIDTH / 2, TILE_HEIGHT / 2);
      } else if (type === "wordHighlight") {
        // Spreads across the whole `LOOP_SECONDS` loop, same "even split across the clip's own
        // duration" idea `activeWordIndex` uses for a real clip — the loop itself stands in for "the
        // clip's duration" here.
        const words = splitWords(SAMPLE_WORDS_TEXT);
        const active = activeWordIndex(words.length, elapsed, LOOP_SECONDS);
        ctx!.textAlign = "left";
        ctx!.textBaseline = "middle";
        // Three words at the base 15px size don't reliably fit an 84px-wide tile (confirmed live: "One
        // Two Three" clipped to "ne Two Thre", both ends spilling past the canvas edge) — shrink the
        // font just enough to fit `maxWidth` instead of assuming the sample string is always short
        // enough, so this stays correct even if `SAMPLE_WORDS_TEXT` or `TILE_WIDTH` ever change.
        const maxWidth = TILE_WIDTH - WORD_TILE_PADDING * 2;
        let totalWidth = ctx!.measureText(words.join(" ")).width;
        if (totalWidth > maxWidth) {
          const fitSize = Math.max(9, Math.floor(15 * (maxWidth / totalWidth)));
          ctx!.font = `700 ${fitSize}px sans-serif`;
          totalWidth = ctx!.measureText(words.join(" ")).width;
        }
        let x = TILE_WIDTH / 2 - totalWidth / 2;
        words.forEach((word, i) => {
          ctx!.fillStyle = i === active ? HIGHLIGHT_COLOR : BASE_COLOR;
          ctx!.fillText(word, x, TILE_HEIGHT / 2);
          x += ctx!.measureText(`${word} `).width;
        });
      } else {
        const { dx, dy, scale, rotationDeg } = computeTextAnimationTransform(type, elapsed);
        ctx!.textAlign = "center";
        ctx!.textBaseline = "middle";
        ctx!.fillStyle = BASE_COLOR;
        ctx!.save();
        ctx!.translate(TILE_WIDTH / 2 + dx, TILE_HEIGHT / 2 + dy);
        ctx!.rotate((rotationDeg * Math.PI) / 180);
        ctx!.scale(scale, scale);
        ctx!.fillText(SAMPLE_TEXT, 0, 0);
        ctx!.restore();
      }

      frameId = requestAnimationFrame(draw);
    }
    frameId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameId);
  }, [type]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: TILE_WIDTH, height: TILE_HEIGHT }}
      className="rounded border border-white/10 bg-black/40"
    />
  );
}
