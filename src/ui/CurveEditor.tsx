"use client";

import { Fragment, useRef, useState } from "react";
import type { ColorCurve, ColorGrading } from "../project/types.ts";
import { sampleCurve } from "../timeline/colorCurves.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { addDragListeners, clientPoint, preventDefaultIfMouse } from "./pointerEvents.ts";

type Channel = "master" | "red" | "green" | "blue";

interface Props {
  grading: ColorGrading;
  /** Fires continuously during a point drag — same "live preview, no undo entry" contract
   *  `NumberField.onPreview`/`RotaryKnob.onPreview` already establish elsewhere in this app. */
  onPreview: (grading: ColorGrading) => void;
  /** Fires on drag-end, click-to-add, or delete — always the FULL next `ColorGrading` (a curve edit
   *  always replaces one channel's whole point list), matching this codebase's "whole value back, never
   *  a patch" convention for keyframe-array-shaped data. */
  onCommit: (grading: ColorGrading) => void;
}

/** SVG viewBox units, both axes — an arbitrary but convenient round number, not pixels. */
const GRAPH_SIZE = 100;
const CURVE_SAMPLE_STEPS = 64;
/** Minimum x-gap enforced between adjacent control points (curve-space, 0..1) — keeps a drag from ever
 *  collapsing two points onto the same x (which `colorCurves.ts`'s spline solve divides by the gap
 *  between adjacent x's) and keeps a click-to-add from creating a degenerate near-duplicate point. */
const MIN_POINT_GAP = 0.02;

const CHANNEL_COLORS: Record<Channel, string> = {
  master: "#e5e7eb",
  red: "#f87171",
  green: "#4ade80",
  blue: "#60a5fa",
};

function toSvgX(x: number): number {
  return x * GRAPH_SIZE;
}
/** Curve-space is Y-UP (brighter = higher, the universal curve-tool convention) but SVG/screen space is
 *  Y-DOWN — every coordinate crossing this boundary flips through here or `clientToCurveSpace` below. */
function toSvgY(y: number): number {
  return (1 - y) * GRAPH_SIZE;
}

/** The first 2D-draggable-point component in this codebase (every other custom drag control —
 *  `RotaryKnob`, `VerticalFader`, `KeyframeTrack`'s own diamonds — is single-axis). Built on the same
 *  `addDragListeners`/`clientPoint` toolkit those use, plus `RemoveObjectOverlay`'s own
 *  `getBoundingClientRect()`-based client→local coordinate conversion. A per-channel tone curve
 *  (RGB/Red/Green/Blue tab), drawn as a natural cubic spline via `colorCurves.ts`'s `sampleCurve` — the
 *  SAME sampler `buildCurveLut` itself uses for the actual pixel LUT, so the line drawn here is
 *  guaranteed to match what gets applied to pixels, not just a visually-similar approximation of it. */
export function CurveEditor({ grading, onPreview, onCommit }: Props) {
  const t = useTranslation();
  const [activeChannel, setActiveChannel] = useState<Channel>("master");
  const svgRef = useRef<SVGSVGElement>(null);

  const points = grading[activeChannel];
  // The currently-dragged point array, overriding `points` for DISPLAY only, while a drag is in
  // progress — `onPreview` below writes to a live-preview override the CANVAS reads, but `Inspector`'s
  // own `resolveClipColorGrading` (what feeds this component's `grading` prop) reads off the
  // COMMITTED clip data, never that override, so `points` itself never changes mid-drag. Without this,
  // the canvas would update live but the curve LINE in this editor would stay frozen until release —
  // exactly the "line doesn't move until release" bug this state fixes. Same `dragValue`/`dragValueRef`
  // split `RotaryKnob`/`VerticalFader` already use for the identical reason.
  const [dragPoints, setDragPoints] = useState<ColorCurve | null>(null);
  const dragPointsRef = useRef<ColorCurve | null>(null);
  const displayPoints = dragPoints ?? points;

  function withChannel(nextPoints: ColorCurve): ColorGrading {
    return { ...grading, [activeChannel]: nextPoints };
  }

  function clientToCurveSpace(clientX: number, clientY: number): { x: number; y: number } {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    const fx = (clientX - rect.left) / rect.width;
    const fy = (clientY - rect.top) / rect.height;
    return { x: Math.min(1, Math.max(0, fx)), y: Math.min(1, Math.max(0, 1 - fy)) };
  }

  function beginDragPoint(event: React.MouseEvent | React.TouchEvent, index: number): void {
    event.stopPropagation();
    const isTouch = "touches" in event;
    if (!isTouch && (event as React.MouseEvent).button !== 0) return;
    preventDefaultIfMouse(event);
    // Snapshotted once, at drag start — the array structure (point count/order) stays fixed for the
    // whole gesture regardless of what `points` (the prop) does in the meantime, so `index` stays a
    // valid, stable reference into it throughout.
    const basePoints = points;
    const isEndpoint = index === 0 || index === basePoints.length - 1;

    function onMove(moveEvent: MouseEvent | TouchEvent): void {
      const point = clientPoint(moveEvent);
      const curvePoint = clientToCurveSpace(point.x, point.y);
      const current = dragPointsRef.current ?? basePoints;
      // Interior points can't cross their neighbors — keeps point order (and so array index) stable
      // for the whole drag, so there's no reordering/re-sorting mid-gesture to reconcile against this
      // closure's own fixed `index`. Endpoints never move in x at all, only y.
      const prevX = index > 0 ? current[index - 1].x + MIN_POINT_GAP : 0;
      const nextX = index < current.length - 1 ? current[index + 1].x - MIN_POINT_GAP : 1;
      const nextPoints = current.map((p, i) =>
        i === index ? { x: isEndpoint ? p.x : Math.min(nextX, Math.max(prevX, curvePoint.x)), y: curvePoint.y } : p
      );
      dragPointsRef.current = nextPoints;
      setDragPoints(nextPoints);
      onPreview(withChannel(nextPoints));
    }

    function onUp(): void {
      removeListeners();
      const final = dragPointsRef.current;
      dragPointsRef.current = null;
      setDragPoints(null);
      if (final) onCommit(withChannel(final));
    }

    const removeListeners = addDragListeners(onMove, onUp);
  }

  function addPointAt(clientX: number, clientY: number): void {
    const curvePoint = clientToCurveSpace(clientX, clientY);
    // Too close to an existing point in x — treat as a miss-click near that point rather than creating
    // a degenerate near-duplicate control point right next to it.
    if (points.some((p) => Math.abs(p.x - curvePoint.x) < MIN_POINT_GAP)) return;
    const next = [...points, curvePoint].sort((a, b) => a.x - b.x);
    onCommit(withChannel(next));
  }

  function removePoint(index: number): void {
    if (index === 0 || index === points.length - 1) return; // endpoints are permanent
    onCommit(withChannel(points.filter((_, i) => i !== index)));
  }

  const sampled = sampleCurve(displayPoints, CURVE_SAMPLE_STEPS);
  const pathD = sampled.map((p, i) => `${i === 0 ? "M" : "L"} ${toSvgX(p.x).toFixed(2)} ${toSvgY(p.y).toFixed(2)}`).join(" ");

  const channels: { id: Channel; label: string }[] = [
    { id: "master", label: t("RGB") },
    { id: "red", label: t("Red") },
    { id: "green", label: t("Green") },
    { id: "blue", label: t("Blue") },
  ];

  return (
    <div className="mb-2.5">
      <div role="tablist" className="mb-2 flex gap-1">
        {channels.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={activeChannel === c.id}
            onClick={() => setActiveChannel(c.id)}
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition ${
              activeChannel === c.id ? "bg-sky-500/25 text-sky-200" : "text-white/50 hover:bg-white/5 hover:text-white/80"
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>
      {/* `max-w-[260px]` caps how big the graph grows — without it, `w-full` + `aspect-square` scales
          the SVG (and so its HEIGHT too) directly with whatever width the Properties column happens to
          have, which on a widened column pushed the graph tall enough to overflow the panel's own
          visible height entirely (confirmed live: dragging the column wider grew the square well past
          the bottom of the screen, nothing below it — LUT, Chroma Key, Details — reachable without first
          narrowing the column back down). `mx-auto` centers it once the cap kicks in and the column is
          wider than it, instead of leaving it stuck against the left edge. 260px matches the column's
          own DEFAULT width (`VCutApp.tsx`'s `propertiesWidth` seed) — the size this graph already read
          comfortably at before resizing existed, still the natural ceiling now that it can. */}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${GRAPH_SIZE} ${GRAPH_SIZE}`}
        className="mx-auto aspect-square w-full max-w-[260px] touch-none select-none overflow-visible rounded bg-black/30"
      >
        {/* Full-area click target for "add a point here" — `pointerEvents: all` makes even the fully
            transparent fill hit-testable, since the default SVG hit-testing rule only responds to
            actually-painted (non-transparent) areas. Placed FIRST so points/curve draw visually on top;
            a click precisely on the curve line or grid still reaches this because those are all given
            `pointerEvents: none` below — only this rect and the point circles are ever interactive. */}
        <rect
          x={0}
          y={0}
          width={GRAPH_SIZE}
          height={GRAPH_SIZE}
          fill="transparent"
          style={{ pointerEvents: "all" }}
          onClick={(e) => addPointAt(e.clientX, e.clientY)}
        />
        {[0.25, 0.5, 0.75].map((f) => (
          <Fragment key={f}>
            <line x1={toSvgX(f)} y1={0} x2={toSvgX(f)} y2={GRAPH_SIZE} stroke="white" strokeOpacity={0.06} style={{ pointerEvents: "none" }} />
            <line x1={0} y1={toSvgY(f)} x2={GRAPH_SIZE} y2={toSvgY(f)} stroke="white" strokeOpacity={0.06} style={{ pointerEvents: "none" }} />
          </Fragment>
        ))}
        <line x1={0} y1={GRAPH_SIZE} x2={GRAPH_SIZE} y2={0} stroke="white" strokeOpacity={0.15} strokeDasharray="2 2" style={{ pointerEvents: "none" }} />
        <path d={pathD} fill="none" stroke={CHANNEL_COLORS[activeChannel]} strokeWidth={1.5} style={{ pointerEvents: "none" }} />
        {displayPoints.map((p, i) => {
          const isEndpoint = i === 0 || i === displayPoints.length - 1;
          return (
            <circle
              key={i}
              cx={toSvgX(p.x)}
              cy={toSvgY(p.y)}
              r={2.75}
              tabIndex={0}
              role="slider"
              aria-label={t("Curve point")}
              aria-valuenow={p.y}
              fill={CHANNEL_COLORS[activeChannel]}
              stroke="black"
              strokeWidth={0.5}
              className="cursor-pointer outline-none focus:stroke-sky-300"
              onMouseDown={(e) => beginDragPoint(e, i)}
              onTouchStart={(e) => beginDragPoint(e, i)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                removePoint(i);
              }}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (!isEndpoint && (e.key === "Delete" || e.key === "Backspace")) {
                  e.preventDefault();
                  removePoint(i);
                }
              }}
            />
          );
        })}
      </svg>
    </div>
  );
}
