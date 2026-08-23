"use client";

import React, { useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Delete, Plus, Time } from "@veasnawt/vicons";
import type { Command } from "../commands/index.ts";
import {
  BatchCommand,
  SetClipColorGradingCommand,
  SetClipColorGradingKeyframesCommand,
  SetClipEffectsCommand,
  SetClipEffectsKeyframesCommand,
  SetClipTransformCommand,
  SetClipTransformKeyframesCommand,
  SetClipTextStyleKeyframesCommand,
  SetTextCommand,
} from "../commands/index.ts";
import { clipDuration, newId } from "../project/createProject.ts";
import type { Clip, TextStyle } from "../project/types.ts";
import { IDENTITY_COLOR_GRADING, IDENTITY_EFFECTS, IDENTITY_TRANSFORM } from "../project/types.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import {
  hasColorGradingKeyframes,
  hasEffectsKeyframes,
  hasTextStyleKeyframes,
  hasTransformKeyframes,
  resolveClipColorGrading,
  resolveClipEffects,
  resolveClipTransform,
  resolveTextStyle,
  upsertKeyframe,
} from "../timeline/keyframes.ts";
import { frameDuration, snapToFrame } from "../timeline/time.ts";

interface Props {
  clip: Clip;
  property: "transform" | "effects" | "colorGrading" | "textStyle";
  /** The CURRENT playhead position, in the SAME absolute-timeline seconds `clip.timelineStart` is —
   *  converted to clip-window-relative time internally, matching every other consumer of `Keyframe.time`. */
  playhead: number;
  fps: number;
  run: (command: Command) => void;
  /** Required when `property === "textStyle"` — TextStyle's static value lives on the ASSET (not the
   *  clip, where `transform`/`effects` live), so this component needs it passed in rather than reading
   *  it off `clip` the way the other two properties do. See `Clip.textStyleKeyframes`'s own doc comment
   *  for the full reasoning. */
  textAsset?: { id: string; content: string; style: TextStyle };
}

/** A small mini-timeline for arming/editing a clip's Transform or Effects keyframes — the on-timeline
 *  counterpart lives entirely here, in the Inspector, rather than as a Timeline lane (see this
 *  feature's own design notes): Transform/Effects have zero on-timeline representation today, and the
 *  Timeline is already dense, so keeping this Inspector-local (scoped to whichever ONE clip is
 *  selected) is the smaller, more consistent diff.
 *
 *  The stopwatch toggle arms/disarms keyframing for this property-group; once armed, every
 *  NumberField commit in the surrounding section (wired through `Inspector`'s own `patchTransform`/
 *  `patchEffects`) automatically inserts-or-updates a keyframe at the CURRENT playhead instead of
 *  overwriting the single static value — this component only needs to render the ruler/diamonds and
 *  the stopwatch/add/delete/prev/next controls, not duplicate that auto-key logic. */
export function KeyframeTrack({ clip, property, playhead, fps, run, textAsset }: Props) {
  const t = useTranslation();
  const duration = clipDuration(clip);
  const keyframes =
    property === "transform"
      ? clip.transformKeyframes
      : property === "effects"
      ? clip.effectsKeyframes
      : property === "colorGrading"
      ? clip.colorGradingKeyframes
      : clip.textStyleKeyframes;
  const armed =
    property === "transform"
      ? hasTransformKeyframes(clip)
      : property === "effects"
      ? hasEffectsKeyframes(clip)
      : property === "colorGrading"
      ? hasColorGradingKeyframes(clip)
      : hasTextStyleKeyframes(clip);
  const elapsed = playhead - clip.timelineStart;
  const playheadInRange = elapsed >= -1e-6 && elapsed <= duration + 1e-6;
  const clampedElapsed = Math.min(duration, Math.max(0, elapsed));

  const trackRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  function dispatchKeyframes(next: { id: string; time: number; value: unknown }[] | null) {
    if (property === "transform") {
      run(new SetClipTransformKeyframesCommand(clip.id, next as Clip["transformKeyframes"]));
    } else if (property === "effects") {
      run(new SetClipEffectsKeyframesCommand(clip.id, next as Clip["effectsKeyframes"]));
    } else if (property === "colorGrading") {
      run(new SetClipColorGradingKeyframesCommand(clip.id, next as Clip["colorGradingKeyframes"]));
    } else {
      run(new SetClipTextStyleKeyframesCommand(clip.id, next as Clip["textStyleKeyframes"]));
    }
  }

  function toggleArmed() {
    if (armed) {
      // Disarm: BAKE the currently-visible frame as the new static value, in the SAME undo step as
      // clearing the keyframe array — turning the stopwatch off preserves exactly what's on screen
      // right now, not whatever the pre-keyframing static value happened to be.
      if (property === "transform") {
        const baked = resolveClipTransform(clip, clampedElapsed);
        run(new BatchCommand(t("Disable Transform Keyframes"), [new SetClipTransformKeyframesCommand(clip.id, null), new SetClipTransformCommand(clip.id, baked)]));
      } else if (property === "effects") {
        const baked = resolveClipEffects(clip, clampedElapsed);
        run(new BatchCommand(t("Disable Effects Keyframes"), [new SetClipEffectsKeyframesCommand(clip.id, null), new SetClipEffectsCommand(clip.id, baked)]));
      } else if (property === "colorGrading") {
        const baked = resolveClipColorGrading(clip, clampedElapsed);
        run(
          new BatchCommand(t("Disable Color Grading Keyframes"), [
            new SetClipColorGradingKeyframesCommand(clip.id, null),
            new SetClipColorGradingCommand(clip.id, baked),
          ])
        );
      } else if (textAsset) {
        const baked = resolveTextStyle(clip, clampedElapsed, textAsset.style);
        run(
          new BatchCommand(t("Disable Text Keyframes"), [
            new SetClipTextStyleKeyframesCommand(clip.id, null),
            new SetTextCommand(textAsset.id, textAsset.content, baked),
          ])
        );
      }
    } else {
      // Arm: a single keyframe at the current playhead holding the clip's current static value —
      // visually a no-op until a second keyframe exists.
      const id = newId("kf");
      const time = snapToFrame(clampedElapsed, fps);
      if (property === "transform") {
        dispatchKeyframes([{ id, time, value: clip.transform ?? IDENTITY_TRANSFORM }]);
      } else if (property === "effects") {
        dispatchKeyframes([{ id, time, value: clip.effects ?? IDENTITY_EFFECTS }]);
      } else if (property === "colorGrading") {
        dispatchKeyframes([{ id, time, value: clip.colorGrading ?? IDENTITY_COLOR_GRADING }]);
      } else if (textAsset) {
        dispatchKeyframes([{ id, time, value: textAsset.style }]);
      }
    }
  }

  function addHere() {
    // `textAsset` is guaranteed present here for `property === "textStyle"`: `keyframes` (and so
    // `armed`, the only path that reaches `addHere` at all) is non-empty only after `toggleArmed`'s
    // arm branch ran, which itself requires `textAsset` to do anything.
    if (!keyframes || (property === "textStyle" && !textAsset)) return;
    const current =
      property === "transform"
        ? resolveClipTransform(clip, clampedElapsed)
        : property === "effects"
        ? resolveClipEffects(clip, clampedElapsed)
        : property === "colorGrading"
        ? resolveClipColorGrading(clip, clampedElapsed)
        : resolveTextStyle(clip, clampedElapsed, textAsset!.style);
    dispatchKeyframes(upsertKeyframe(keyframes as { id: string; time: number; value: unknown }[], clampedElapsed, current, fps));
  }

  const nearestIndex = keyframes?.findIndex((k) => Math.abs(k.time - clampedElapsed) <= frameDuration(fps) / 2) ?? -1;

  function deleteNearest() {
    if (!keyframes || nearestIndex < 0) return;
    const next = keyframes.filter((_, i) => i !== nearestIndex);
    dispatchKeyframes(next.length > 0 ? next : null);
  }

  function stepTo(direction: -1 | 1) {
    if (!keyframes || keyframes.length === 0) return;
    const candidates = direction < 0 ? keyframes.filter((k) => k.time < clampedElapsed - 1e-6) : keyframes.filter((k) => k.time > clampedElapsed + 1e-6);
    if (candidates.length === 0) return;
    const target = direction < 0 ? candidates[candidates.length - 1] : candidates[0];
    useEditorStore.getState().setPlayhead(target.time + clip.timelineStart);
  }

  function timeFromClientX(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || duration <= 0) return 0;
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return snapToFrame(fraction * duration, fps);
  }

  function beginDragKeyframe(e: React.PointerEvent, id: string) {
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDragId(id);
  }

  function onTrackPointerMove(e: React.PointerEvent) {
    if (!dragId || !keyframes) return;
    const index = keyframes.findIndex((k) => k.id === dragId);
    if (index < 0) return;
    const prevTime = keyframes[index - 1]?.time ?? 0;
    const nextTime = keyframes[index + 1]?.time ?? duration;
    const time = Math.min(nextTime, Math.max(prevTime, timeFromClientX(e.clientX)));
    const updated = keyframes.map((k, i) => (i === index ? { ...k, time } : k));
    dispatchKeyframes(updated as { id: string; time: number; value: unknown }[]);
  }

  function onTrackPointerUp() {
    setDragId(null);
  }

  return (
    <div className="mb-2 rounded bg-black/20 p-1.5">
      <div className="flex items-center gap-1">
        <button
          type="button"
          title={armed ? t("Disable keyframes — bakes the current frame as a static value") : t("Enable keyframes for this property")}
          aria-label={t("Toggle keyframes")}
          aria-pressed={armed}
          onClick={toggleArmed}
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded transition ${
            armed ? "bg-sky-500/80 text-white" : "bg-white/5 text-white/50 hover:bg-white/10 hover:text-white"
          }`}
        >
          <Time size={14} />
        </button>
        {armed && (
          <>
            <button
              type="button"
              title={t("Previous keyframe")}
              aria-label={t("Previous keyframe")}
              onClick={() => stepTo(-1)}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-white/5 text-white/60 transition hover:bg-white/10 hover:text-white"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              type="button"
              title={t("Next keyframe")}
              aria-label={t("Next keyframe")}
              onClick={() => stepTo(1)}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-white/5 text-white/60 transition hover:bg-white/10 hover:text-white"
            >
              <ChevronRight size={14} />
            </button>
            <button
              type="button"
              title={t("Add a keyframe at the playhead")}
              aria-label={t("Add keyframe here")}
              onClick={addHere}
              disabled={!playheadInRange}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-white/5 text-white/60 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
            >
              <Plus size={14} />
            </button>
            <button
              type="button"
              title={t("Delete the keyframe at the playhead")}
              aria-label={t("Delete keyframe")}
              onClick={deleteNearest}
              disabled={nearestIndex < 0}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-white/5 text-white/60 transition hover:bg-red-500/30 hover:text-red-200 disabled:opacity-30"
            >
              <Delete size={14} />
            </button>
          </>
        )}
      </div>
      {armed && duration > 0 && (
        <div
          ref={trackRef}
          role="presentation"
          onPointerMove={onTrackPointerMove}
          onPointerUp={onTrackPointerUp}
          className="relative mt-1.5 h-4 w-full rounded bg-white/5"
        >
          {playheadInRange && (
            <div aria-hidden className="pointer-events-none absolute top-0 h-full w-px bg-sky-300" style={{ left: `${(clampedElapsed / duration) * 100}%` }} />
          )}
          {keyframes?.map((k) => (
            <div
              key={k.id}
              role="slider"
              tabIndex={0}
              aria-label={t("Keyframe at {time}s", { time: k.time.toFixed(2) })}
              aria-valuenow={k.time}
              onPointerDown={(e) => beginDragKeyframe(e, k.id)}
              style={{ left: `${(k.time / duration) * 100}%` }}
              className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-ew-resize touch-none border border-amber-100 bg-amber-300 shadow-sm transition hover:scale-125"
            />
          ))}
        </div>
      )}
    </div>
  );
}
