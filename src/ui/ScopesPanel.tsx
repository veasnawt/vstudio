"use client";

import { useEffect, useRef, useState } from "react";
import { Maximize } from "@veasnawt/vicons";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { computeHistogram, computeVectorscope, computeWaveform } from "../timeline/scopes.ts";

/** Sampling canvas width — real waveform/vectorscope monitors read a downscaled proxy of the frame,
 *  not every native pixel (see `timeline/scopes.ts`'s own `PIXEL_STRIDE` comment for the matching
 *  per-pixel-loop tradeoff on the READ side; this is the matching tradeoff on the DRAW side — a 320-wide
 *  sample is plenty of resolution for a density readout meant to be glanced at, not pixel-peeped).
 *  Sample canvas HEIGHT is derived every frame from the live preview's own aspect ratio instead of a
 *  second constant, so a 9:16 vertical sequence and a 16:9 horizontal one both sample proportionally.
 *
 *  This is a SAMPLING resolution, independent of DISPLAY size — same relationship a real scope's
 *  underlying sample rate has to its screen size. `sizes` state below (driven by a `ResizeObserver`) is
 *  what the three canvases actually DRAW at; this stays fixed regardless of how big the panel is
 *  docked, resized, or floated. */
const SAMPLE_WIDTH = 320;
/** Vectorscope lattice resolution — deliberately coarser than the waveform/histogram's own native 256
 *  levels: this grid is walked and re-painted with a `fillRect` per non-empty cell every frame (see
 *  `drawVectorscope`), so its cost is O(gridSize²) regardless of how sparse the actual chroma
 *  distribution is. 45 keeps that under ~2000 cells — comfortably cheap at 60fps — while still reading
 *  as a smooth density cloud rather than a blocky grid at typical display sizes. */
const VECTOR_GRID = 45;

/** Seeds for `sizes` state before the first `ResizeObserver` callback ever fires (so the very first
 *  paint isn't zero-sized) — the same values this panel used as fixed, unchangeable constants before
 *  it became responsive. */
const DEFAULT_WAVEFORM_SIZE = { w: 320, h: 130 };
const DEFAULT_VECTOR_SIZE = { w: 160, h: 160 };
const DEFAULT_HISTOGRAM_SIZE = { w: 256, h: 130 };
/** However tall the row itself measures, no single scope draws taller than this — a waveform stretched
 *  across a very tall floated window reads worse, not better, past a certain point; real hardware scope
 *  displays are a fixed aspect for the same reason. */
const MAX_SCOPE_HEIGHT = 340;
const SCOPE_GAP_PX = 16;
/** The row's own `p-4` (1rem = 16px) on every side — `clientWidth`/`clientHeight` on the row itself
 *  INCLUDE that padding (it's inside the element's own content+padding box), but the children need to
 *  fit within the space padding leaves behind, not the padded box itself. Without subtracting this, the
 *  three scopes' computed widths summed back up to the row's full padded width, overflowing the actual
 *  available content area by exactly this much and wrapping the last one onto a second, scrolled-away
 *  row — a real bug caught live, not a hypothetical. */
const ROW_PADDING_PX = 16;
/** `ScopeSection`'s own label line (`text-[10px]` + `gap-1`) sits ABOVE each canvas, inside the same
 *  flex column — leaves this much less room for the canvas itself than the row's raw available height
 *  would suggest. */
const SECTION_LABEL_ALLOWANCE_PX = 18;
const MIN_SCOPE_WIDTH = 140;

type ScopeKey = "waveform" | "vectorscope" | "histogram";

function ScopeSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wide text-white/40">{title}</span>
      {children}
    </div>
  );
}

/** Faint reference-line style shared by every scope's own gridlines/labels below — one constant rather
 *  than repeating the same rgba string and font size at each call site. */
const GRID_STROKE = "rgba(255,255,255,0.15)";
const LABEL_FILL = "rgba(255,255,255,0.35)";
const LABEL_FONT = "9px sans-serif";

/** Draws the `256 * sampleColumns` waveform density grid (see `computeWaveform`'s own doc comment for
 *  its exact index layout) as one `fillRect` per non-empty cell, opacity scaled by that cell's count
 *  relative to the grid's own observed peak — a column with every sampled pixel piled into one luma
 *  level reads as a single bright line, a spread-out column reads as a soft vertical smear, the same
 *  look a real waveform monitor has. Luma 0 draws at the BOTTOM, luma 255 at the TOP (canvas y grows
 *  downward; "brighter = higher on screen" is the universal waveform-monitor convention). Normalizing
 *  against the grid's own max (not a fixed sample-count constant) keeps the brightest cell fully opaque
 *  regardless of `SAMPLE_WIDTH`/the source's height, so this stays correct if either ever changes.
 *
 *  Finishes with three horizontal reference lines at luma 0/50%/100% (IRE-style, the same three levels
 *  a real waveform monitor's own graticule marks) — pure labeling, drawn last so they sit on top of the
 *  density fill rather than being covered by it. */
function drawWaveform(canvas: HTMLCanvasElement | null, grid: Uint32Array, sampleColumns: number): void {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx || sampleColumns === 0) return;
  const { width, height } = canvas;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);

  let max = 1;
  for (const v of grid) if (v > max) max = v;

  const colWidth = Math.max(1, width / sampleColumns);
  const rowHeight = Math.max(1, height / 256);
  ctx.fillStyle = "#4ade80"; // same accent green CurveEditor's own spline uses, for a consistent "scope-y" palette
  for (let col = 0; col < sampleColumns; col++) {
    for (let level = 0; level < 256; level++) {
      const count = grid[col * 256 + level];
      if (count === 0) continue;
      ctx.globalAlpha = Math.min(1, count / max);
      ctx.fillRect(col * (width / sampleColumns), height - (level + 1) * (height / 256), colWidth, rowHeight);
    }
  }
  ctx.globalAlpha = 1;

  ctx.strokeStyle = GRID_STROKE;
  ctx.lineWidth = 1;
  ctx.fillStyle = LABEL_FILL;
  ctx.font = LABEL_FONT;
  ctx.textBaseline = "bottom";
  for (const [luma, label] of [
    [0, "0%"],
    [128, "50%"],
    [255, "100%"],
  ] as const) {
    const y = height - ((luma + 1) * height) / 256;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    ctx.fillText(label, 2, y - 1);
  }
}

/** Six standard vectorscope target points (R/Mg/B/Cy/G/Yl) — the idealized 100%-saturation
 *  primary/secondary Cb/Cr position for each, computed directly from `computeVectorscope`'s OWN BT.601
 *  formula (`cb = 0.564*(b-y)`, `cr = 0.713*(r-y)`, `y = 0.299r + 0.587g + 0.114b`) so the drawn targets
 *  are provably consistent with what's actually plotted rather than borrowed from a different colorspace
 *  convention. These mark idealized 100%-saturation primaries as a labeling aid for a density readout —
 *  not the 75%-color-bars convention broadcast hardware calibrates against, so treat them as "here's
 *  where pure red/cyan/etc. would land," not a calibration reference. */
const VECTORSCOPE_TARGETS: { label: string; cb: number; cr: number; color: string }[] = [
  { label: "R", cb: -0.169, cr: 0.5, color: "#f87171" },
  { label: "Mg", cb: 0.331, cr: 0.419, color: "#f472b6" },
  { label: "B", cb: 0.5, cr: -0.081, color: "#60a5fa" },
  { label: "Cy", cb: 0.169, cr: -0.5, color: "#22d3ee" },
  { label: "G", cb: -0.331, cr: -0.419, color: "#4ade80" },
  { label: "Yl", cb: -0.5, cr: 0.081, color: "#facc15" },
];

/** Draws the `gridSize * gridSize` vectorscope density grid (see `computeVectorscope`'s own doc
 *  comment) the same "one fillRect per non-empty cell, opacity by relative density" way `drawWaveform`
 *  does, plus a faint crosshair marking the zero-chroma center — the reference point every real
 *  vectorscope marks, so a viewer can tell at a glance whether the plotted density is pulled warm/cool/
 *  saturated without having to infer the center from the dot cloud alone — and the six standard
 *  R/Mg/B/Cy/G/Yl target points (`VECTORSCOPE_TARGETS`), run through the identical `(cb,cr) -> (u,v)`
 *  remap `computeVectorscope` itself uses so a real fully-saturated patch of that color lands exactly
 *  on its own labeled target. */
function drawVectorscope(canvas: HTMLCanvasElement | null, grid: Uint32Array, gridSize: number): void {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx || gridSize === 0) return;
  const { width, height } = canvas;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);

  let max = 1;
  for (const v of grid) if (v > max) max = v;

  const cellW = Math.max(1, width / gridSize);
  const cellH = Math.max(1, height / gridSize);
  ctx.fillStyle = "#4ade80";
  for (let v = 0; v < gridSize; v++) {
    for (let u = 0; u < gridSize; u++) {
      const count = grid[v * gridSize + u];
      if (count === 0) continue;
      ctx.globalAlpha = Math.min(1, count / max);
      ctx.fillRect(u * (width / gridSize), v * (height / gridSize), cellW, cellH);
    }
  }
  ctx.globalAlpha = 1;

  ctx.strokeStyle = GRID_STROKE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(width / 2, 0);
  ctx.lineTo(width / 2, height);
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();

  ctx.font = LABEL_FONT;
  ctx.textBaseline = "middle";
  for (const target of VECTORSCOPE_TARGETS) {
    const u = ((target.cb + 0.5) * (gridSize - 1)) / gridSize;
    const v = ((target.cr + 0.5) * (gridSize - 1)) / gridSize;
    const x = u * width;
    const y = v * height;
    ctx.strokeStyle = target.color;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(x - 4, y);
    ctx.lineTo(x + 4, y);
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, y + 4);
    ctx.stroke();
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = target.color;
    ctx.fillText(target.label, x + 5, y);
  }
  ctx.globalAlpha = 1;
}

/** Draws the three independent R/G/B histograms (see `computeHistogram`'s own doc comment) as one thin
 *  bar per level, `globalCompositeOperation: "lighten"` so overlapping channels blend ADDITIVELY toward
 *  white where they overlap (a near-neutral image's three histograms roughly stack into a pale
 *  silhouette) rather than the last-drawn channel simply painting over the other two — the standard
 *  look every real histogram overlay uses. Finishes with vertical reference lines at level 0/64/128/
 *  192/255, the standard quarter-tone gridlines a real histogram scope draws. */
function drawHistogram(canvas: HTMLCanvasElement | null, histogram: { r: Uint32Array; g: Uint32Array; b: Uint32Array }): void {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);

  let max = 1;
  for (const channel of [histogram.r, histogram.g, histogram.b]) {
    for (const v of channel) if (v > max) max = v;
  }

  const barWidth = Math.max(1, width / 256);
  ctx.globalCompositeOperation = "lighten";
  for (const [channel, color] of [
    [histogram.r, "#f87171"],
    [histogram.g, "#4ade80"],
    [histogram.b, "#60a5fa"],
  ] as const) {
    ctx.fillStyle = color;
    for (let level = 0; level < 256; level++) {
      const count = channel[level];
      if (count === 0) continue;
      const barHeight = Math.max(1, (count / max) * height);
      ctx.fillRect(level * (width / 256), height - barHeight, barWidth, barHeight);
    }
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;

  ctx.strokeStyle = GRID_STROKE;
  ctx.lineWidth = 1;
  ctx.fillStyle = LABEL_FILL;
  ctx.font = LABEL_FONT;
  ctx.textBaseline = "bottom";
  for (const level of [0, 64, 128, 192, 255]) {
    const x = (level * width) / 256;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.fillText(String(level), Math.min(x + 2, width - 16), height - 2);
  }
}

/** Live waveform/vectorscope/histogram readout of whatever's currently on the preview canvas.
 *
 *  Deliberately fully independent of `PlaybackEngine.tick()` — owns its own `requestAnimationFrame`
 *  loop, started on mount and cancelled on unmount, that reads `previewCanvas` from the store (set by
 *  `Preview.tsx` — see that field's own doc comment) fresh every frame. This is what makes the scopes
 *  keep updating while SCRUBBING (dragging the playhead with playback paused), not just during real
 *  playback — `PlaybackEngine` already redraws the preview canvas on a scrub, this panel just needs to
 *  notice the pixels changed, which polling via its own rAF loop does for free with no coupling to
 *  how/why the source canvas last redrew.
 *
 *  Samples the preview canvas onto its OWN small offscreen canvas (`willReadFrequently: true`) rather
 *  than reading `PlaybackEngine`'s main canvas directly — seeing the spec's own reasoning: adding that
 *  hint to the shared compositor canvas could regress playback performance for every user, not just
 *  when this panel happens to be open. This canvas exists ONLY while `ScopesPanel` is mounted, so the
 *  cost of the hint is scoped to exactly when it's needed.
 *
 *  `onFloat` mirrors `MixerPanel`'s own prop of the same name — see `VCutApp.tsx`'s `floatState`/
 *  `beginFloat` for the docked/floating mechanism this panel doesn't otherwise need to know about. */
export function ScopesPanel({ onFloat }: { onFloat?: () => void } = {}) {
  const t = useTranslation();
  const previewCanvas = useEditorStore((s) => s.previewCanvas);

  const [visible, setVisible] = useState<Record<ScopeKey, boolean>>({ waveform: true, vectorscope: true, histogram: true });
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const [sizes, setSizes] = useState<{ waveform: { w: number; h: number }; vectorscope: { w: number; h: number }; histogram: { w: number; h: number } }>({
    waveform: DEFAULT_WAVEFORM_SIZE,
    vectorscope: DEFAULT_VECTOR_SIZE,
    histogram: DEFAULT_HISTOGRAM_SIZE,
  });

  const rowRef = useRef<HTMLDivElement | null>(null);
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const vectorscopeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const histogramCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Container-driven sizing, mirroring `Preview.tsx`'s own `ResizeObserver` pattern for a canvas that
  // must track its parent's real size (observe a wrapper box, read its client dimensions, `setState`).
  // Divides the row's own available width equally among whichever scopes are currently VISIBLE
  // (`visible`, read fresh via `visibleRef` so this effect doesn't need to re-subscribe on every
  // toggle), capped at `MAX_SCOPE_HEIGHT` so a tall floated window doesn't stretch a waveform past the
  // point it's still readable. Vectorscope stays square — the smaller of its own width share and the
  // capped height.
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;

    function recompute() {
      const v = visibleRef.current;
      const keys: ScopeKey[] = (["waveform", "vectorscope", "histogram"] as const).filter((k) => v[k]);
      if (keys.length === 0 || !row) return;

      const availableWidth = row.clientWidth - ROW_PADDING_PX * 2;
      const availableHeight = Math.min(row.clientHeight - ROW_PADDING_PX * 2 - SECTION_LABEL_ALLOWANCE_PX, MAX_SCOPE_HEIGHT);
      const perItemWidth = Math.max(MIN_SCOPE_WIDTH, (availableWidth - SCOPE_GAP_PX * (keys.length - 1)) / keys.length);

      setSizes((prev) => {
        const next = { ...prev };
        for (const key of keys) {
          if (key === "vectorscope") {
            const side = Math.max(MIN_SCOPE_WIDTH, Math.min(perItemWidth, availableHeight));
            next.vectorscope = { w: Math.round(side), h: Math.round(side) };
          } else {
            next[key] = { w: Math.round(perItemWidth), h: Math.round(Math.max(60, availableHeight)) };
          }
        }
        return next;
      });
    }

    const observer = new ResizeObserver(recompute);
    observer.observe(row);
    recompute();
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- visible is read via visibleRef so toggling
    // it doesn't need to tear down/recreate the observer; only re-run when which scopes exist can change.
  }, [visible.waveform, visible.vectorscope, visible.histogram]);

  useEffect(() => {
    if (!sampleCanvasRef.current) sampleCanvasRef.current = document.createElement("canvas");
    const sampleCanvas = sampleCanvasRef.current;
    const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
    if (!sampleCtx) return;

    let rafId: number;
    const tick = () => {
      rafId = requestAnimationFrame(tick);

      // Read live from the store rather than closing over the `previewCanvas` render value — the
      // effect's own dependency array below re-subscribes whenever that reference changes anyway, but
      // reading fresh here means a resize (which mutates the SAME canvas element's width/height, not
      // its identity) is picked up on the very next frame instead of only after the identity changes.
      const source = useEditorStore.getState().previewCanvas;
      if (!source || source.width === 0 || source.height === 0) return;

      const sampleHeight = Math.max(1, Math.round((SAMPLE_WIDTH * source.height) / source.width));
      if (sampleCanvas.width !== SAMPLE_WIDTH || sampleCanvas.height !== sampleHeight) {
        sampleCanvas.width = SAMPLE_WIDTH;
        sampleCanvas.height = sampleHeight;
      }
      sampleCtx.drawImage(source, 0, 0, SAMPLE_WIDTH, sampleHeight);
      const imageData = sampleCtx.getImageData(0, 0, SAMPLE_WIDTH, sampleHeight);

      const v = visibleRef.current;
      if (v.waveform) drawWaveform(waveformCanvasRef.current, computeWaveform(imageData, SAMPLE_WIDTH), SAMPLE_WIDTH);
      if (v.vectorscope) drawVectorscope(vectorscopeCanvasRef.current, computeVectorscope(imageData, VECTOR_GRID), VECTOR_GRID);
      if (v.histogram) drawHistogram(histogramCanvasRef.current, computeHistogram(imageData));
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [previewCanvas]);

  function toggle(key: ScopeKey) {
    setVisible((s) => ({ ...s, [key]: !s[key] }));
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0d0f14]">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/5 px-4 py-2">
        {/* Hidden while floating — `FloatablePanel`'s own title bar already shows "Scopes", so this
            would otherwise be a second, redundant title. `onFloat` is only passed for the docked
            render, so its presence doubles as the "am I docked" signal. Unlike Mixer's header, the
            row itself stays (the visibility-toggle buttons below are meaningful in both states). */}
        {onFloat && <h2 className="text-[11px] font-semibold uppercase tracking-wider text-white/40">{t("Scopes")}</h2>}
        <div className="flex items-center gap-1">
          {(
            [
              ["waveform", t("Waveform")],
              ["vectorscope", t("Vectorscope")],
              ["histogram", t("Histogram")],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => toggle(key)}
              aria-pressed={visible[key]}
              title={visible[key] ? t("Hide {label}", { label }) : t("Show {label}", { label })}
              className={`rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide transition ${
                visible[key] ? "bg-white/10 text-white/70" : "text-white/30 hover:text-white/50"
              }`}
            >
              {label}
            </button>
          ))}
          {onFloat && (
            <button
              onClick={onFloat}
              title={t("Float as a window")}
              aria-label={t("Float Scopes as a window")}
              className="ml-1 flex items-center justify-center rounded p-1 text-white/40 transition hover:bg-white/10 hover:text-white"
            >
              <Maximize size={13} />
            </button>
          )}
        </div>
      </div>

      {!previewCanvas ? (
        <p className="px-4 py-3 text-xs text-white/50">{t("Nothing to read yet — add a clip to the timeline.")}</p>
      ) : (
        <div ref={rowRef} className="scrollbar-none flex min-h-0 flex-1 flex-wrap items-start gap-4 overflow-x-auto overflow-y-auto p-4">
          {visible.waveform && (
            <ScopeSection title={t("Waveform")}>
              <canvas
                ref={waveformCanvasRef}
                width={sizes.waveform.w}
                height={sizes.waveform.h}
                aria-label={t("Waveform")}
                className="rounded border border-white/10 bg-black"
                style={{ width: sizes.waveform.w, height: sizes.waveform.h }}
              />
            </ScopeSection>
          )}
          {visible.vectorscope && (
            <ScopeSection title={t("Vectorscope")}>
              <canvas
                ref={vectorscopeCanvasRef}
                width={sizes.vectorscope.w}
                height={sizes.vectorscope.h}
                aria-label={t("Vectorscope")}
                className="rounded border border-white/10 bg-black"
                style={{ width: sizes.vectorscope.w, height: sizes.vectorscope.h }}
              />
            </ScopeSection>
          )}
          {visible.histogram && (
            <ScopeSection title={t("Histogram")}>
              <canvas
                ref={histogramCanvasRef}
                width={sizes.histogram.w}
                height={sizes.histogram.h}
                aria-label={t("Histogram")}
                className="rounded border border-white/10 bg-black"
                style={{ width: sizes.histogram.w, height: sizes.histogram.h }}
              />
            </ScopeSection>
          )}
        </div>
      )}
    </div>
  );
}
