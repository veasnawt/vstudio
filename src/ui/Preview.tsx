"use client";

import React, { useEffect, useRef, useState } from "react";
import { mediaUrl } from "../api/client.ts";
import { sequenceDuration } from "../project/createProject.ts";
import { PlaybackEngine } from "../playback/PlaybackEngine.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { formatTimecode } from "../timeline/time.ts";
import { TransformHandles } from "./TransformHandles.tsx";

/** Isolated so ONLY this readout re-renders as the playhead advances during playback — not the whole
 *  toolbar and canvas wrapper around it. `PlaybackEngine` updates the store's `playhead` on every
 *  animation frame while playing; subscribing to it any higher up the tree than necessary means
 *  React reconciles that entire subtree 30-60 times a second, competing with the canvas draw for
 *  main-thread time and being the actual cause of a choppy-looking preview. */
function CurrentTime({ fps }: { fps: number }) {
  const playhead = useEditorStore((s) => s.playhead);
  return (
    <span role="timer" aria-live="off" aria-label="Current time" className="text-white/90">
      {formatTimecode(playhead, fps)}
    </span>
  );
}

function ControlButton({
  onClick,
  label,
  children,
  disabled,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="rounded-md px-2.5 py-1.5 text-white/70 transition hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-30"
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

  const project = useEditorStore((s) => s.project);
  const projectId = useEditorStore((s) => s.projectId);
  const playing = useEditorStore((s) => s.playing);
  const togglePlay = useEditorStore((s) => s.togglePlay);
  const stepFrames = useEditorStore((s) => s.stepFrames);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);

  // The engine is created once and reads live state through getters rather than taking props. If it
  // were re-created whenever the project changed, every edit would tear down and rebuild the media
  // pool — losing all buffering and making playback stutter after each keystroke.
  useEffect(() => {
    const engine = new PlaybackEngine({
      getProject: () => useEditorStore.getState().project,
      getPlayhead: () => useEditorStore.getState().playhead,
      isPlaying: () => useEditorStore.getState().playing,
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

  const total = project ? sequenceDuration(project) : 0;
  const fps = project?.sequence.fps ?? 30;
  const empty = total <= 0;

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#0a0c10]">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
        <div className="relative flex h-full w-full items-center justify-center">
          <canvas
            ref={setCanvas}
            // Sized by CSS to fit the panel while the backing store stays at the sequence's real
            // resolution, so the preview is a true representation of the output frame.
            className="max-h-full max-w-full rounded-lg bg-black shadow-2xl"
            style={{ aspectRatio: project ? `${project.sequence.width} / ${project.sequence.height}` : "9 / 16" }}
          />
          <TransformHandles canvas={canvas} />
          {empty && (
            <p className="pointer-events-none absolute text-xs text-white/35">
              Add a clip to the timeline to see it here
            </p>
          )}
        </div>
      </div>

      <div className="relative flex items-center border-t border-white/10 px-3 py-2">
        {/* Absolutely positioned and centered on the BAR, not just on the leftover space next to the
            resolution readout — a plain flex row with `ml-auto` on that readout leaves this cluster
            sitting wherever its own width happens to land, which is the left-hugging look this fixes. */}
        <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1">
          <ControlButton onClick={() => setPlayhead(0)} label="Go to start" disabled={empty}>
            ⏮
          </ControlButton>
          <ControlButton onClick={() => stepFrames(-1)} label="Previous frame" disabled={empty}>
            ◀
          </ControlButton>
          <ControlButton onClick={togglePlay} label={playing ? "Pause (Space)" : "Play (Space)"} disabled={empty}>
            {playing ? "⏸" : "▶"}
          </ControlButton>
          <ControlButton onClick={() => stepFrames(1)} label="Next frame" disabled={empty}>
            ▶
          </ControlButton>
          <ControlButton onClick={() => setPlayhead(total)} label="Go to end" disabled={empty}>
            ⏭
          </ControlButton>

          <div className="ml-3 flex items-baseline gap-1.5 font-mono text-xs tabular-nums">
            {/* role="timer" + aria-live announces the position to a screen reader as it changes,
                rather than leaving the most important readout in the app silent. */}
            <CurrentTime fps={fps} />
            <span className="text-white/30">/</span>
            <span aria-label="Total duration" className="text-white/45">
              {formatTimecode(total, fps)}
            </span>
          </div>
        </div>

        {/* Hidden below `xl`, not `lg` — this bar is the PREVIEW column's own width, not the whole
            viewport, and at `lg` (1024px) that column is only ~1024 − 240 − 260 ≈ 520px after Media
            and Inspector take their fixed share: not enough room next to the centered playback
            cluster, so the two visibly collided there. `xl` (1280px) leaves that column comfortably
            wider. Below it this is simply hidden — the least essential thing in the bar (redundant
            with what the frame itself already shows), not worth fighting for space over. */}
        {project && (
          <span className="ml-auto hidden text-[11px] text-white/35 xl:inline">
            {project.sequence.width}×{project.sequence.height} · {project.sequence.fps} fps
          </span>
        )}
      </div>
    </section>
  );
}
