"use client";

import React from "react";
import type { AlignmentGuide } from "../playback/alignmentGuides.ts";

/** Renders the smart-guide lines `computeAlignmentGuides` found — shared by `TransformHandles` and
 *  `TextTransformHandles` so a guide looks identical regardless of which kind of clip is being
 *  dragged (or which kind of OTHER clip it's aligning against). Positions are in canvas backing-store
 *  pixels; `canvasRect`/`cssScale` convert to fixed on-screen CSS pixels, the same conversion every
 *  other on-canvas overlay in this app already does. Purely decorative (`aria-hidden`) — the guide is
 *  a visual aid confirming what the drag already snapped to, not new information a screen reader
 *  needs to announce. */
export function AlignmentGuideOverlay({
  guides,
  canvasRect,
  cssScale,
}: {
  guides: AlignmentGuide[];
  canvasRect: DOMRect;
  cssScale: number;
}) {
  if (guides.length === 0) return null;

  return (
    <>
      {guides.map((guide, i) =>
        guide.axis === "x" ? (
          <div
            key={`x-${i}`}
            aria-hidden
            style={{
              position: "fixed",
              left: canvasRect.left + guide.position * cssScale,
              top: canvasRect.top,
              height: canvasRect.height,
              width: 1,
              zIndex: 45,
            }}
            className="pointer-events-none bg-pink-400/90"
          />
        ) : (
          <div
            key={`y-${i}`}
            aria-hidden
            style={{
              position: "fixed",
              left: canvasRect.left,
              top: canvasRect.top + guide.position * cssScale,
              width: canvasRect.width,
              height: 1,
              zIndex: 45,
            }}
            className="pointer-events-none bg-pink-400/90"
          />
        )
      )}
    </>
  );
}
