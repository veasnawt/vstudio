"use client";

import React, { useEffect, useRef, useState } from "react";
import { Maximize, Pause, Play, Redo, SkipBack, SkipForward, StepBack, StepForward, Undo } from "@veasnawt/vicons";
import { mediaUrl } from "../api/client.ts";
import { sequenceDuration } from "../project/createProject.ts";
import { PlaybackEngine } from "../playback/PlaybackEngine.ts";
import { useEditorStore } from "../store/editorStore.ts";
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

export function Preview() {
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

  const project = useEditorStore((s) => s.project);
  const playing = useEditorStore((s) => s.playing);
  const togglePlay = useEditorStore((s) => s.togglePlay);
  const stepFrames = useEditorStore((s) => s.stepFrames);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const canUndo = useEditorStore((s) => s.canUndo);
  const canRedo = useEditorStore((s) => s.canRedo);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);

  // The engine is created once and reads live state through getters rather than taking props. If it
  // were re-created whenever the project changed, every edit would tear down and rebuild the media
  // pool — losing all buffering and making playback stutter after each keystroke.
  useEffect(() => {
    const engine = new PlaybackEngine({
      getProject: () => useEditorStore.getState().project,
      getPlayhead: () => useEditorStore.getState().playhead,
      isPlaying: () => useEditorStore.getState().playing,
      getLiveOverrides: () => useEditorStore.getState().livePreviewOverrides,
      onTimeUpdate: (seconds) => useEditorStore.getState().setPlayhead(seconds),
      onEnded: () => useEditorStore.getState().setPlaying(false),
      mediaUrlFor: (assetId) => {
        const state = useEditorStore.getState();
        const asset = state.project?.assets.find((a) => a.id === assetId);
        if (!asset || !state.projectId) return null;
        return mediaUrl(state.projectId, asset.relPath);
      },
    });
    engineRef.current = engine;
    return () => engine.detach();
  }, []);

  // Separate from engine creation above: this fires once the canvas ref callback has actually run
  // (guaranteed to be after the effect above, since React runs effects in declaration order within a
  // commit — `engineRef.current` is already set by the time this reads it).
  useEffect(() => {
    if (canvas) engineRef.current?.attach(canvas);
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
      const scale = Math.min(availW / seqW, availH / seqH);
      const width = Math.max(1, Math.round(seqW * scale));
      const height = Math.max(1, Math.round(seqH * scale));
      setDisplaySizeState({ width, height });
      engineRef.current?.setDisplaySize(width, height);
    };
    const observer = new ResizeObserver(recompute);
    observer.observe(box);
    recompute();
    return () => observer.disconnect();
  }, [project?.sequence.width, project?.sequence.height]);

  const total = project ? sequenceDuration(project) : 0;
  const empty = total <= 0;

  return (
    <section ref={panelRef} className="flex h-full min-h-0 flex-col bg-[#0a0c10]">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
        <div ref={previewBoxRef} className="relative flex h-full w-full items-center justify-center">
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
            className="bg-black shadow-2xl ring-1 ring-white/15"
            style={{ width: `${displaySize?.width ?? 1}px`, height: `${displaySize?.height ?? 1}px` }}
          />
          <TransformHandles canvas={canvas} />
          <TextTransformHandles canvas={canvas} />
          <RemoveObjectOverlay canvas={canvas} />
          {empty && (
            <p className="pointer-events-none absolute text-xs text-white/35">
              Add a clip to the timeline to see it here
            </p>
          )}
        </div>
      </div>

      {/* This bar sits flush against the row's bottom edge, the exact same spot the Preview/Timeline
          resize divider (VStudioApp.tsx, z-20) is positioned to be grabbable from. `pointer-events-none`
          on the bar itself, re-enabled (`pointer-events-auto` + `z-30` to actually win the stacking
          fight, `pointer-events-auto` alone isn't enough — it only makes an element ELIGIBLE to
          receive events, the topmost-at-that-point element still wins the hit-test) on just the button
          cluster below — NOT a z-index promotion on this WHOLE bar, which would win against the
          divider across its full width, including all the empty space on either side of the centered
          buttons (most of it, at typical widths), leaving the divider ungrabbable anywhere under the
          middle (Preview) column and reachable only under Media/Inspector where nothing else overlaps
          it — exactly the bug this replaced. */}
      <div className="pointer-events-none relative flex items-center border-t border-white/10 px-3 py-2">
        {/* Undo/redo bookend this row (far left/right) around the centered playback cluster — moved
            here from the bottom toolbar so they sit directly next to the controls they most often
            follow (undo a trim, immediately hit play to check it), and so that already-crowded
            icon-only row (see its own comment on running out of phone width) has two fewer buttons. */}
        <div className="pointer-events-auto z-30 flex items-center">
          <ControlButton onClick={undo} label="Undo (Ctrl+Z)" disabled={!canUndo}>
            <Undo size={16} />
          </ControlButton>
        </div>

        {/* Absolutely positioned and centered on the BAR, not just on the leftover space between the
            undo/redo buttons — a plain flex row would only visually center if both sides happened to
            be the same width, which is the left/right-hugging look this fixes. */}
        <div className="pointer-events-auto absolute left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5">
          <ControlButton onClick={() => setPlayhead(0)} label="Go to start" disabled={empty}>
            <SkipBack size={16} />
          </ControlButton>
          <ControlButton onClick={() => stepFrames(-1)} label="Previous frame" disabled={empty}>
            <StepBack size={16} />
          </ControlButton>
          <ControlButton onClick={togglePlay} label={playing ? "Pause (Space)" : "Play (Space)"} disabled={empty} primary>
            {playing ? <Pause size={22} /> : <Play size={22} />}
          </ControlButton>
          <ControlButton onClick={() => stepFrames(1)} label="Next frame" disabled={empty}>
            <StepForward size={16} />
          </ControlButton>
          <ControlButton onClick={() => setPlayhead(total)} label="Go to end" disabled={empty}>
            <SkipForward size={16} />
          </ControlButton>
        </div>

        {/* `ml-auto` on this WRAPPER (not the resolution readout itself) so the fullscreen/redo stay
            pushed to the right and reachable at every width, even below `xl` where the readout goes
            `hidden` — see that span's own comment for why it specifically is hidden there. */}
        <div className="pointer-events-auto z-30 ml-auto flex items-center gap-2">
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
            <ControlButton onClick={toggleFullscreen} label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}>
              <Maximize size={16} />
            </ControlButton>
          )}
          <ControlButton onClick={redo} label="Redo (Ctrl+Shift+Z)" disabled={!canRedo}>
            <Redo size={16} />
          </ControlButton>
        </div>
      </div>
    </section>
  );
}
