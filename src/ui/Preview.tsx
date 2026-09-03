"use client";

import React, { useEffect, useRef, useState } from "react";
import { Maximize, Pause, Play, Redo, SkipBack, SkipForward, StepBack, StepForward, Undo } from "@veasnawt/vicons";
import { mediaUrl } from "../api/client.ts";
import { sequenceDuration } from "../project/createProject.ts";
import { PlaybackEngine } from "../playback/PlaybackEngine.ts";
import { computeVisibleClipBoxes, hitTestClip } from "../playback/visibleClips.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { TransformHandles } from "./TransformHandles.tsx";
import { TextTransformHandles } from "./TextTransformHandles.tsx";
import { RemoveObjectOverlay } from "./RemoveObjectOverlay.tsx";

function ControlButton({
  onClick,
  label,
  children,
  disabled,
  primary,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
  disabled?: boolean;
  // Play/Pause specifically — the one action in this cluster someone reaches for constantly, so it
  // gets a bigger hit target and a filled background to read as the primary control at a glance,
  // the same way every real video player treats play/pause as visually distinct from skip/step.
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`text-white/70 transition hover:text-white disabled:cursor-default disabled:opacity-30 ${
        primary ? "rounded-full bg-white/10 p-2.5 hover:bg-white/20" : "rounded-md p-1.5 hover:bg-white/10"
      }`}
    >
      {children}
    </button>
  );
}

export function Preview({ onResizeStart }: { onResizeStart: (e: React.MouseEvent | React.TouchEvent) => void }) {
  // A ref alone can't tell TransformHandles when the canvas becomes available (setting `.current`
  // doesn't trigger a re-render), so the canvas element lives in state — read directly by both the
  // engine-attach effect below and passed straight through as a prop.
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const engineRef = useRef<PlaybackEngine | null>(null);
  const previewBoxRef = useRef<HTMLDivElement | null>(null);
  // The whole Preview panel (canvas + transport bar), not just the canvas — fullscreen should keep the
  // play/pause/skip controls and timecode reachable, the same way a real player's fullscreen mode
  // still shows its own chrome rather than becoming a bare, controls-less video.
  const panelRef = useRef<HTMLElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // iPhone Safari has no Fullscreen API for arbitrary elements at all (only a `<video>` element can
  // go fullscreen there, via a separate WebKit-only API) — `requestFullscreen` is simply undefined on
  // the panel element. Confirmed live: calling it unconditionally threw "requestFullscreen is not a
  // function" the instant the button was tapped. iPad Safari DOES support it (since iPadOS 13), so
  // this is checked per-device rather than blanket-disabled for iOS — computed after mount since
  // `document`/`Element` don't exist during SSR.
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  useEffect(() => {
    setFullscreenSupported(typeof document.documentElement.requestFullscreen === "function");
  }, []);
  // Synced from the browser's own event rather than only toggled by the button click: fullscreen can
  // also be exited via Esc or the browser's native "exit fullscreen" UI, neither of which goes through
  // `toggleFullscreen` below — without this listener the icon/tooltip would silently go stale.
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === panelRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  function toggleFullscreen() {
    if (!fullscreenSupported) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void panelRef.current?.requestFullscreen();
  }
  // The canvas's own CSS display size, computed in JS (see the effect below) rather than left to CSS
  // aspect-ratio/max-width/max-height. Explicit pixels because a plain `<canvas>` doesn't have a
  // request to trigger it, and the browser gives it none — its layout size falls back to its OWN
  // width/height ATTRIBUTE, which is now the JS-managed, GPU-saving backing-store size (see
  // `PlaybackEngine.setDisplaySize`'s comment). Once that attribute shrinks with the panel, `max-h-full`
  // /`max-w-full` alone can only ever shrink further, never grow back — so after any resize the
  // preview got stuck rendering as a near-solid stretched pixel (looking blank/black) even once the
  // window grew back. Computing the exact letterbox-fit size fresh from the STABLE outer panel's own
  // box (which the canvas's size can never feed back into) sidesteps that feedback loop entirely.
  const [displaySize, setDisplaySizeState] = useState<{ width: number; height: number } | null>(null);
  // How far the canvas is deliberately under-filling `previewBoxRef`, `1` = "Fit" (today's default,
  // unchanged behavior). Zoom-OUT only (never above 1) — the point is opening up reachable space
  // around an oversized (large Transform scale/fontSize) clip's own on-canvas handles, which shrinking
  // the canvas alone can't do (see `TransformHandles`' own `stageEl` prop comment for why): the canvas
  // shrinks but `previewBoxRef` stays the same size, so the slack between them is what a clamped
  // corner/rotate handle actually has room to move into. Local state, not the Zustand store — same
  // "ephemeral view state" precedent `displaySize` above already sets; nothing outside this component
  // needs the NUMBER, only `previewBoxRef`'s own (already-DOM) rect, threaded to the handle components
  // below as `stageEl`.
  const [previewZoom, setPreviewZoom] = useState(1);
  const t = useTranslation();

  const project = useEditorStore((s) => s.project);
  const playing = useEditorStore((s) => s.playing);
  const togglePlay = useEditorStore((s) => s.togglePlay);
  const stepFrames = useEditorStore((s) => s.stepFrames);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const canUndo = useEditorStore((s) => s.canUndo);
  const canRedo = useEditorStore((s) => s.canRedo);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  // Stable action references (never change identity — see editorStore's own creator), so subscribing
  // to them costs no extra re-renders; `playhead` itself is read IMPERATIVELY inside the click handler
  // below instead of via a reactive `useEditorStore((s) => s.playhead)` subscription, which would
  // otherwise re-render this whole component on every playhead tick during playback for a value only
  // ever needed at the instant of a click.
  const select = useEditorStore((s) => s.select);
  const toggleSelect = useEditorStore((s) => s.toggleSelect);

  // The engine is created once and reads live state through getters rather than taking props. If it
  // were re-created whenever the project changed, every edit would tear down and rebuild the media
  // pool — losing all buffering and making playback stutter after each keystroke.
  useEffect(() => {
    const engine = new PlaybackEngine({
      getProject: () => useEditorStore.getState().project,
      getPlayhead: () => useEditorStore.getState().playhead,
      isPlaying: () => useEditorStore.getState().playing,
      getLiveOverrides: () => useEditorStore.getState().livePreviewOverrides,
      getLiveTrackGainPreview: () => useEditorStore.getState().livePreviewTrackGain,
      getLiveTrackPanPreview: () => useEditorStore.getState().livePreviewTrackPan,
      getLiveMasterGainPreview: () => useEditorStore.getState().livePreviewMasterGain,
      onTimeUpdate: (seconds) => useEditorStore.getState().setPlayhead(seconds),
      onEnded: () => useEditorStore.getState().setPlaying(false),
      mediaUrlFor: (assetId) => {
        const state = useEditorStore.getState();
        const asset = state.project?.assets.find((a) => a.id === assetId);
        if (!asset || !state.projectId) return null;
        return mediaUrl(state.projectId, asset.relPath);
      },
      lutUrlFor: (lutId) => {
        const state = useEditorStore.getState();
        const lut = state.project?.luts.find((l) => l.id === lutId);
        if (!lut || !state.projectId) return null;
        return mediaUrl(state.projectId, lut.relPath);
      },
    });
    engineRef.current = engine;
    useEditorStore.getState().setPlaybackEngine(engine);
    return () => {
      // Cleared before `detach()` so `LevelMeter`'s own rAF loop (reading `playbackEngine` via
      // `getState()`, not a subscription) sees `null` and stops polling before the graph itself tears
      // down, instead of racing a call into a half-disposed engine.
      useEditorStore.getState().setPlaybackEngine(null);
      engine.detach();
    };
  }, []);

  // Separate from engine creation above: this fires once the canvas ref callback has actually run
  // (guaranteed to be after the effect above, since React runs effects in declaration order within a
  // commit — `engineRef.current` is already set by the time this reads it).
  useEffect(() => {
    if (canvas) engineRef.current?.attach(canvas);
  }, [canvas]);

  // Publishes the live canvas element to the store — see `EditorState.previewCanvas`'s own doc comment
  // for why (`ScopesPanel`'s waveform/vectorscope/histogram readout is the one consumer, sampling this
  // canvas's real pixels on its own independent rAF loop). Mirrors `setPlaybackEngine`'s own set/clear
  // lifecycle in the effect above exactly, just for the canvas instead of the engine.
  useEffect(() => {
    useEditorStore.getState().setPreviewCanvas(canvas);
    return () => useEditorStore.getState().setPreviewCanvas(null);
  }, [canvas]);

  // Letterbox-fits the sequence's aspect ratio inside the STABLE outer panel (sized purely by the
  // surrounding app layout — grid rows, sidebar widths — never by the canvas itself), recomputed on
  // every panel resize. Feeds the result to both the canvas's own CSS size (`displaySize` above, in
  // pixels) and `PlaybackEngine.setDisplaySize` (which caps the backing-store RESOLUTION to match, for
  // the GPU/compositing win this whole mechanism exists for — see its own comment).
  useEffect(() => {
    const box = previewBoxRef.current;
    if (!box) return;
    const seqW = project?.sequence.width ?? 1080;
    const seqH = project?.sequence.height ?? 1920;
    const recompute = () => {
      const availW = box.clientWidth;
      const availH = box.clientHeight;
      if (availW <= 0 || availH <= 0) return;
      // `previewZoom` under-fills the SAME stable `box` rather than shrinking it — `box` itself never
      // changes size, so the slack this opens up between the (now smaller) canvas and `box`'s own
      // edges is exactly what `TransformHandles`/`TextTransformHandles` clamp their handles into via
      // the `stageEl` prop below. At the default `previewZoom = 1` this is identical to before.
      const scale = Math.min(availW / seqW, availH / seqH) * previewZoom;
      const width = Math.max(1, Math.round(seqW * scale));
      const height = Math.max(1, Math.round(seqH * scale));
      setDisplaySizeState({ width, height });
      engineRef.current?.setDisplaySize(width, height);
    };
    const observer = new ResizeObserver(recompute);
    observer.observe(box);
    recompute();
    return () => observer.disconnect();
  }, [project?.sequence.width, project?.sequence.height, previewZoom]);

  const total = project ? sequenceDuration(project) : 0;
  const empty = total <= 0;

  // Click-to-select directly in the preview — the on-canvas counterpart to clicking a clip on the
  // Timeline. Deliberately just a plain `onClick` on the canvas itself, not a separate overlay div:
  // `TransformHandles`/`TextTransformHandles`' own move-handle already covers the CURRENTLY selected
  // clip's whole box with its own `pointer-events-auto` element (and `stopPropagation`s its mousedown),
  // and those handles are separate, `position: fixed` siblings rather than DOM descendants of the
  // canvas — so a click that lands on a handle is never even a candidate to bubble through here, no
  // coordination needed between the two. This only ever fires for a click whose real target IS the
  // canvas: empty frame area, or a clip with no handle currently drawn over that exact point.
  function handleCanvasClick(event: React.MouseEvent<HTMLCanvasElement>) {
    if (!project || !canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const rect = canvas.getBoundingClientRect();
    const seqWidth = project.sequence.width;
    const seqHeight = project.sequence.height;
    const cssScale = seqWidth > 0 ? rect.width / seqWidth : 0;
    if (cssScale <= 0) return;

    const point = { x: (event.clientX - rect.left) / cssScale, y: (event.clientY - rect.top) / cssScale };
    const playhead = useEditorStore.getState().playhead;
    const boxes = computeVisibleClipBoxes(project, playhead, context, seqWidth, seqHeight);
    const clipId = hitTestClip(boxes, point);
    const additive = event.ctrlKey || event.metaKey;

    if (clipId) {
      if (additive) toggleSelect(clipId);
      else select([clipId]);
    } else if (!additive) {
      // Matches Timeline's own "click empty lane space to deselect" convention (Timeline.tsx's
      // `lanesRef` onClick) — clicking empty frame area is the canvas equivalent of that.
      select([]);
    }
  }

  return (
    <section ref={panelRef} className="flex h-full min-h-0 flex-col bg-[#0a0c10]">
      <div
        onClick={(e) => {
          // The thin outer margin (this div's own `p-4`) outside `previewBoxRef` — same direct-click-
          // only guard, same reasoning, just one layer further out; see that div's own onClick comment.
          if (e.target === e.currentTarget && !(e.ctrlKey || e.metaKey)) select([]);
        }}
        className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4"
      >
        <div
          ref={previewBoxRef}
          onClick={(e) => {
            // The letterbox/pillarbox padding around the canvas when the sequence's own aspect ratio
            // doesn't fill this box — a SEPARATE element from the canvas itself (see the sizing
            // comment below: this div is `h-full w-full`, the canvas is only ever as big as the
            // sequence's own proportions allow within it), so `handleCanvasClick`'s own hit-test never
            // sees a click that lands out here at all. `e.target === e.currentTarget` is what limits
            // this to a DIRECT click on the padding itself — any click that bubbles up from a real
            // descendant (the canvas, a transform handle, the empty-state text) is ignored here
            // regardless of whether that descendant stops propagation on its own, so this can't
            // double-fire alongside `handleCanvasClick`'s own selection logic.
            if (e.target === e.currentTarget && !(e.ctrlKey || e.metaKey)) select([]);
          }}
          className="relative flex h-full w-full items-center justify-center"
        >
          {/* Explicit pixel width/height, computed in JS from the STABLE outer box above (see the
              effect) — not CSS `aspect-ratio` + `max-h-full`/`max-w-full` against the canvas's OWN
              attribute. That combination let the canvas's backing-store attribute (now shrunk for
              performance — see `PlaybackEngine.setDisplaySize`) double as its CSS layout size too: once
              it shrank once, `max-h-full`/`max-w-full` could only ever shrink it FURTHER, never grow it
              back, so the preview got stuck tiny after any resize (looking blank/black). Setting BOTH
              dimensions as independent fixed pixels has its own failure mode — each axis then gets
              clamped separately with nothing tying them to the sequence's real ratio, visibly
              stretching the frame — which `recompute`'s own `Math.min(availW/seqW, availH/seqH)` scale
              exists to prevent: one shared scale factor applied to both axes, so the box is always
              exactly the sequence's own proportions, just smaller. A crisp `ring` gives the frame a
              visible edge against the studio's own near-identical near-black background — the two were
              easy to mistake for each other with only `bg-black` against `bg-[#0a0c10]` before. */}
          <canvas
            ref={setCanvas}
            onClick={handleCanvasClick}
            className="bg-black shadow-2xl ring-1 ring-white/15"
            style={{ width: `${displaySize?.width ?? 1}px`, height: `${displaySize?.height ?? 1}px` }}
          />
          <TransformHandles canvas={canvas} stageEl={previewBoxRef.current} />
          <TextTransformHandles canvas={canvas} stageEl={previewBoxRef.current} />
          <RemoveObjectOverlay canvas={canvas} />
          {empty && (
            <p className="pointer-events-none absolute text-xs text-white/35">
              {t("Add a clip to the timeline to see it here")}
            </p>
          )}
        </div>
      </div>

      {/* Resize handle — sits in its own thin row between the canvas and the transport bar, centered
          on the Play button directly below it (same X). Drags the shared Preview/Timeline boundary
          (`VCutApp.tsx`'s own `timelineHeight`/`beginTimelineResize`, passed down as `onResizeStart`).
          Earlier this lived as an absolutely-positioned strip sitting ASTRIDE that boundary instead —
          centering a handle there landed it right under this same transport bar's own Play button
          (z-30, real buttons win a hit-test the strip's z-20 never could there), so it was only ever
          grabbable off to the side, with no visual cue showing where. Living here, in normal flow,
          between the canvas and the controls, sidesteps that entirely — nothing else is ever laid out
          in this row, so there's no z-index fight left to have, and centering is simply safe. */}
      <div className="flex shrink-0 justify-center py-1">
        <button
          type="button"
          onMouseDown={onResizeStart}
          onTouchStart={onResizeStart}
          aria-label={t("Resize timeline")}
          title={t("Drag to resize")}
          className="group flex cursor-row-resize touch-none items-center rounded-full p-2 transition-colors hover:bg-white/5"
        >
          <span className="block h-1 w-10 rounded-full bg-white/25 transition-colors group-hover:bg-white/50 group-active:bg-sky-400/90" />
        </button>
      </div>

      {/* A real 3-column grid (`1fr auto 1fr`), not absolute-positioned centering — the CENTER column's
          `auto` track always gets exactly the room its own content needs, and the two `1fr` side
          columns split whatever's left EQUALLY, so neither one's content can ever be laid out on top of
          the center cluster. The old approach (center absolutely positioned at the bar's own literal
          midpoint, undo/redo pinned left, zoom/fullscreen pushed right via `ml-auto`) looked identical
          at desktop widths — plenty of slack on both sides — but had no mechanism keeping any group
          out of another's way once the bar got narrow: confirmed live at 360–375px (an ordinary phone
          width, not an edge case) the zoom-out button and the "Go to end" button ended up rendering on
          top of each other, un-tappable as separate targets. Grid tracks reserve real, non-overlapping
          space for each column instead, so the worst a too-narrow bar can do now is overflow at the
          edges (mitigated below by shedding the zoom stepper buttons there), never silently merge two
          controls into one. */}
      <div className="pointer-events-none grid grid-cols-[1fr_auto_1fr] items-center border-t border-white/10 px-3 py-2">
        {/* Undo/redo sit together at the row's left edge — moved here from the bottom toolbar so they
            sit directly next to the controls they most often follow (undo a trim, immediately hit
            play to check it), and so that already-crowded icon-only row (see its own comment on
            running out of phone width) has two fewer buttons. Kept as a PAIR (not split to bookend
            the row) — undo/redo are one conceptual control, and reaching for one right after the
            other is the whole point of the shortcut; splitting them across the bar just made that a
            wider mouse trip for no benefit. */}
        <div className="pointer-events-auto z-30 flex items-center gap-1 justify-self-start">
          <ControlButton onClick={undo} label={t("Undo (Ctrl+Z)")} disabled={!canUndo}>
            <Undo size={16} />
          </ControlButton>
          <ControlButton onClick={redo} label={t("Redo (Ctrl+Shift+Z)")} disabled={!canRedo}>
            <Redo size={16} />
          </ControlButton>
        </div>

        {/* The grid's own CENTER column — genuinely centered by construction (it's the `auto` track
            between two equal `1fr` tracks), not by measuring the bar's own width against this group's. */}
        <div className="pointer-events-auto z-30 flex items-center gap-1.5 justify-self-center">
          <ControlButton onClick={() => setPlayhead(0)} label={t("Go to start")} disabled={empty}>
            <SkipBack size={16} />
          </ControlButton>
          <ControlButton onClick={() => stepFrames(-1)} label={t("Previous frame")} disabled={empty}>
            <StepBack size={16} />
          </ControlButton>
          <ControlButton onClick={togglePlay} label={playing ? t("Pause (Space)") : t("Play (Space)")} disabled={empty} primary>
            {playing ? <Pause size={22} /> : <Play size={22} />}
          </ControlButton>
          <ControlButton onClick={() => stepFrames(1)} label={t("Next frame")} disabled={empty}>
            <StepForward size={16} />
          </ControlButton>
          <ControlButton onClick={() => setPlayhead(total)} label={t("Go to end")} disabled={empty}>
            <SkipForward size={16} />
          </ControlButton>
        </div>

        <div className="pointer-events-auto z-30 flex items-center justify-end gap-2 justify-self-end">
          {/* Preview canvas zoom — OUT only (never past "Fit"), independent of any clip's own
              Transform scale/fontSize. Same button style/convention as Timeline's own zoom cluster
              (`Timeline.tsx`), including the "click the readout to reset" affordance — deliberately
              NOT the same Ctrl/Cmd +/- shortcut, which is already globally bound to Timeline zoom.
              The step buttons (−/+) are `sm:flex hidden` — below `sm` (640px) there isn't room for a
              full 3-button zoom cluster AND undo/redo AND all five playback buttons without overflowing
              (measured: ~380px of minimum content width against a 360–375px real phone viewport), so
              the least essential two (tapping "Fit" itself already resets zoom, which covers the
              overwhelmingly common case) drop first — the readout stays so zoom is still visible, just
              not steppable a tap at a time, below that width. */}
          <div className="hidden items-center gap-0.5 sm:flex">
            <button
              onClick={() => setPreviewZoom((z) => Math.max(0.25, z / 1.25))}
              aria-label={t("Zoom preview out")}
              title={t("Zoom preview out")}
              className="flex min-h-[26px] min-w-[26px] items-center justify-center rounded text-white/60 transition hover:bg-white/10 hover:text-white"
            >
              −
            </button>
            <button
              onClick={() => setPreviewZoom(1)}
              aria-label={t("Reset preview zoom")}
              title={t("Reset preview zoom")}
              className="min-h-[26px] min-w-[3.5ch] rounded px-1 text-center font-mono text-[11px] tabular-nums text-white/45 transition hover:bg-white/10 hover:text-white"
            >
              {previewZoom === 1 ? t("Fit") : `${Math.round(previewZoom * 100)}%`}
            </button>
            <button
              onClick={() => setPreviewZoom((z) => Math.min(1, z * 1.25))}
              disabled={previewZoom >= 1}
              aria-label={t("Zoom preview in")}
              title={t("Zoom preview in")}
              className="flex min-h-[26px] min-w-[26px] items-center justify-center rounded text-white/60 transition hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-30"
            >
              +
            </button>
          </div>
          <button
            onClick={() => setPreviewZoom(1)}
            aria-label={t("Reset preview zoom")}
            title={t("Reset preview zoom")}
            className="min-h-[26px] min-w-[3.5ch] rounded px-1 text-center font-mono text-[11px] tabular-nums text-white/45 transition hover:bg-white/10 hover:text-white sm:hidden"
          >
            {previewZoom === 1 ? t("Fit") : `${Math.round(previewZoom * 100)}%`}
          </button>
          {/* Hidden below `xl`, not `lg` — this bar is the PREVIEW column's own width, not the whole
              viewport, and at `lg` (1024px) that column is only ~1024 − 240 − 260 ≈ 520px after Media
              and Inspector take their fixed share: not enough room next to the centered playback
              cluster, so the two visibly collided there. `xl` (1280px) leaves that column comfortably
              wider. Below it this is simply hidden — the least essential thing in the bar (redundant
              with what the frame itself already shows), not worth fighting for space over. */}
          {project && (
            <span className="hidden text-[11px] text-white/35 xl:inline">
              {project.sequence.width}×{project.sequence.height} · {project.sequence.fps} fps
            </span>
          )}
          {/* `Maximize` stands in for BOTH directions (no dedicated "exit fullscreen"/compress icon
              exists yet — see MISSING_ICONS.md) — the tooltip/aria-label is what actually communicates
              which action a click performs. Hidden entirely (not just disabled) when unsupported —
              iPhone Safari has no Fullscreen API for arbitrary elements at all, so a dead button here
              would be actively misleading rather than just inert. */}
          {fullscreenSupported && (
            <ControlButton onClick={toggleFullscreen} label={isFullscreen ? t("Exit fullscreen") : t("Fullscreen")}>
              <Maximize size={16} />
            </ControlButton>
          )}
        </div>
      </div>
    </section>
  );
}
