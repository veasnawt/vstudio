"use client";

import React, { useRef, useState } from "react";
import { filmstripUrl, thumbnailUrl, waveformUrl } from "../api/client.ts";
import { BatchCommand, MoveClipCommand, TrimClipCommand } from "../commands/index.ts";
import { clipDuration, findClip } from "../project/createProject.ts";
import type { Clip, Project, Track } from "../project/types.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { snapPoints, snapTime } from "../timeline/queries.ts";
import { formatDuration } from "../timeline/time.ts";
import { addDragListeners, clientPoint, preventDefaultIfMouse } from "./pointerEvents.ts";

/** Pixels the pointer must travel before a press turns into a drag. Without it, a slightly-shaky
 *  click to select a clip would register as a one-pixel move and push a pointless undo entry. */
const DRAG_THRESHOLD = 3;
/** Same idea as `DRAG_THRESHOLD`, but for touch specifically — a finger is never as still as a mouse
 *  cursor, so 3px of natural tremor during an intended tap would otherwise misfire as movement. Sized
 *  to match `SNAP_PIXELS`'s own already-tuned "feels right" scale rather than inventing a new one. */
const TOUCH_DRAG_THRESHOLD = 8;
/** How close (in pixels, so it feels the same at any zoom) an edge must come to a snap point. */
const SNAP_PIXELS = 8;
/** Wider snap window for touch specifically — a fingertip is nowhere near as precise as a mouse
 *  cursor, so the same 8px window that feels reliable with a mouse is easy to miss entirely with a
 *  finger. Requested directly: dragging felt "imprecise" on touch. */
const TOUCH_SNAP_PIXELS = 16;
/** How long a touch has to hold still on a clip before it counts as "add/remove this from the
 *  selection" — touch has no Ctrl/Cmd key to hold for an additive click, so a deliberate long-press
 *  is what stands in for it, matching the same convention (and duration) `MediaLibrary`'s own
 *  touch-drag pickup uses. */
const LONG_PRESS_MS = 450;
/** How long after a real touch event the browser's own synthetic compatibility mouse event (fired
 *  shortly after most touch interactions, for mouse-only sites) still counts as "the ghost of that
 *  same touch" rather than a genuine separate mouse press — see `lastTouchAtRef`'s own comment. Wide
 *  enough to comfortably cover the browser's own dispatch delay (typically under 300ms) without
 *  being so wide it could ever swallow a real, deliberate mouse click on a hybrid touch+mouse device. */
const SYNTHETIC_MOUSE_GRACE_MS = 600;

type DragMode = "move" | "trim-in" | "trim-out";

interface Props {
  clip: Clip;
  track: Track;
  project: Project;
  /** For `thumbnailUrl` below — the BP project id thumbnail URLs are scoped to, not `project.id`. */
  projectId: string | null;
  pixelsPerSecond: number;
  selected: boolean;
  assetName: string;
  /** Which track row a vertical pointer position falls on — supplied by the Timeline, which owns the
   *  row geometry. This is what makes dragging a clip from one track to another possible. */
  resolveTrackAt: (clientY: number) => string | null;
  /** Reports the track a drag is currently over (null when it's the clip's own track) so the Timeline
   *  can highlight the destination. */
  onTargetTrackChange: (trackId: string | null) => void;
}

/** Memoized below as `TimelineClip` — with every prop here either a primitive, a `useCallback`/
 *  `setState` function (both reference-stable across renders), or a piece of `project` that only
 *  gets a new reference when `project` itself actually changes, a pure scroll-driven re-render of the
 *  parent `Timeline` (see its own `scrollLeft` state) leaves every one of this component's props
 *  reference-identical — so the default shallow-prop comparison `React.memo` does is exactly the
 *  right equality check, no custom comparator needed. Confirmed to matter on a real Android device:
 *  without this, EVERY clip in the project re-rendered on every scroll frame regardless of whether
 *  its own props changed, competing with the scroll itself for main-thread time on hardware slower
 *  than the desktop browser this was originally built/tested against. */
function TimelineClipComponent({
  clip,
  track,
  project,
  projectId,
  pixelsPerSecond,
  selected,
  assetName,
  resolveTrackAt,
  onTargetTrackChange,
}: Props) {
  const run = useEditorStore((s) => s.run);
  const select = useEditorStore((s) => s.select);
  const toggleSelect = useEditorStore((s) => s.toggleSelect);
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds);

  // A filmstrip backdrop for video/image clips, tiled across the clip's width via CSS rather than JS
  // — cheap, since it costs nothing beyond what the browser already does for any repeating background
  // image. `filmstripUrl` (several evenly-spaced frames in one sprite) is preferred when the asset has
  // one; `thumbnailUrl` (a single frame) is the fallback for images (which have no separate filmstrip
  // — the image already IS one frame) and for videos imported before filmstrips existed. Either way
  // the SAME tiling CSS below works unchanged: a wider (multi-frame) image just repeats a longer
  // sequence before looping, not a special case the frontend needs to know about. `null` for
  // audio/text (nothing to show) or an asset that's missing/offline.
  const asset = project.assets.find((a) => a.id === clip.assetId);
  const thumbnail =
    projectId && asset && (asset.kind === "video" || asset.kind === "image")
      ? (filmstripUrl(projectId, asset) ?? thumbnailUrl(projectId, asset))
      : null;

  // Live drag feedback is local state, so dragging repaints this clip without touching the project
  // or the undo stack. Exactly one command is dispatched, on release. `sourceIn`/`sourceOut` mirror
  // what the eventual `trimClip` call will land on — carried here purely so the waveform background
  // (below) can track a live trim instead of only the last-committed cut.
  const [preview, setPreview] = useState<{
    start: number;
    duration: number;
    sourceIn: number;
    sourceOut: number;
    /** True the instant a drag has actually snapped to an edge/the playhead, not just "some drag is in
     *  progress" — drives a distinct highlight color (see the root element's own className) so hitting
     *  a snap point is something you can SEE, not just trust happened. Requested directly: dragging
     *  felt "imprecise" with only the plain dim-while-dragging feedback this had before. */
    snapped: boolean;
  } | null>(null);

  // A waveform backdrop for audio clips — one PNG spanning the asset's FULL duration (see
  // `waveformUrl`'s own comment), rendered at a fixed PIXEL size/position (not a percentage of the
  // clip's own box) so the visible slice always matches this CLIP's own trim, not just the whole
  // asset. Unlike the filmstrip above (which tiles the same sprite regardless of trim), this is worth
  // the extra per-clip math: a waveform's whole point is showing WHERE the audio content actually
  // falls, so a trimmed clip showing the wrong slice of peaks would be actively misleading, not just
  // approximate.
  //
  // Pixels, deliberately not percentages: CSS `background-position` percentages are resolved against
  // (container size − image size), so for an oversized background image (which this always is, once
  // trimmed to show less than the whole asset) the SAME percentage value maps to a DIFFERENT absolute
  // offset depending on how wide the container currently is. That made the image visibly pan sideways
  // while trimming just the OUT edge — which only changes the container's width, not `sourceIn` —
  // even though nothing about which part of the audio is anchored at the clip's start should move.
  // Sizing and positioning in px instead, at the SAME px-per-second scale the rest of the timeline
  // uses, makes the image's absolute position depend on `sourceIn` alone — trimming the out edge only
  // shrinks the (overflow-hidden) box and crops the image's right side, with zero visual shift.
  //
  // During a live trim drag, `preview` carries the in-flight sourceIn (see `updatePreview` calls
  // below) — reading THAT here, not the still-committed `clip` value, is what keeps the waveform
  // showing the actual audio being cut in real time instead of only updating once the drag releases.
  const previewSourceIn = preview?.sourceIn ?? clip.sourceIn;
  const previewSourceOut = preview?.sourceOut ?? clip.sourceOut;
  const waveform =
    projectId && asset && asset.kind === "audio" && asset.duration > 0 && previewSourceOut > previewSourceIn
      ? waveformUrl(projectId, asset)
      : null;
  const waveformSizePx = waveform ? asset!.duration * pixelsPerSecond : 0;
  const waveformOffsetPx = waveform ? previewSourceIn * pixelsPerSecond : 0;
  // The same value mirrored into a ref. The mouse handlers below run outside React, so they can't
  // read `preview` (they'd see the value captured when the drag started) — and reading it inside a
  // `setPreview(current => …)` updater is worse: that updater runs during render, and dispatching a
  // command from there triggers "Cannot update a component while rendering a different component".
  // A ref is the correct place for a value that mouse handlers need to read imperatively.
  const previewRef = useRef<{ start: number; duration: number; sourceIn: number; sourceOut: number; snapped: boolean } | null>(null);
  const dragRef = useRef<{ mode: DragMode; startX: number; origin: Clip; moved: boolean } | null>(null);
  /** The clip's own root element — see `beginDrag`'s long-press gate for why this needs direct,
   *  synchronous DOM access rather than going through React state/className (a React re-render is one
   *  tick too late to matter here, the same reasoning `VStudioApp`'s drag-block overlay uses elsewhere
   *  in this codebase for an identical timing-sensitive toggle). */
  const rootRef = useRef<HTMLDivElement>(null);
  /** Destination track for an in-flight move. Starts as the clip's own track, so a purely horizontal
   *  drag behaves exactly as before. */
  const targetTrackRef = useRef<string>(track.id);
  /** Timestamp of the last real touch event `beginDrag` handled — what tells a GENUINE mouse press
   *  apart from the browser's own synthetic compatibility mousedown/mouseup/click it fires shortly
   *  after almost any touch interaction (standard behavior, for sites that only listen for mouse
   *  events — not a testing artifact, confirmed on a real touch flow). Without this, that synthetic
   *  mousedown re-ran this SAME clip's tap-selection logic immediately after a long-press had already
   *  decided the outcome, silently undoing (or doubling) it — a plain toggle looked like it "didn't
   *  work" every other press. */
  const lastTouchAtRef = useRef(0);

  function updatePreview(next: { start: number; duration: number; sourceIn: number; sourceOut: number; snapped: boolean } | null) {
    previewRef.current = next;
    setPreview(next);
  }

  const duration = preview?.duration ?? clipDuration(clip);
  const start = preview?.start ?? clip.timelineStart;

  function beginDrag(event: React.MouseEvent | React.TouchEvent, mode: DragMode) {
    if (track.locked) return;
    const isTouchEvent = "touches" in event;
    if (isTouchEvent) {
      lastTouchAtRef.current = Date.now();
    } else if (Date.now() - lastTouchAtRef.current < SYNTHETIC_MOUSE_GRACE_MS) {
      // The browser's own ghost mousedown following the touch this clip JUST handled — see
      // `lastTouchAtRef`'s own comment. Bail out completely: no selection change, no drag.
      return;
    }
    event.stopPropagation();
    preventDefaultIfMouse(event);

    const additive = "ctrlKey" in event && (event.ctrlKey || event.metaKey);
    function applyTapSelection() {
      if (additive) {
        toggleSelect(clip.id);
      } else if (mode !== "move" || !selectedClipIds.includes(clip.id)) {
        // Replaces the selection UNLESS this is the start of a MOVE drag on a clip that's already
        // part of a bigger selection — starting to drag one member of a multi-selection should carry
        // the whole group along, not collapse it down to just the clip the pointer happens to be on.
        // Trimming stays single-clip always (there's no meaningful "trim several clips together").
        select([clip.id]);
      }
    }

    // Touch has no Ctrl/Cmd key, so a plain tap can never be "additive" — a quick tap on the clip
    // BODY (not the trim handles) is deferred behind a long-press instead: hold still past
    // `LONG_PRESS_MS` and it toggles into/out of the selection (the touch equivalent of Ctrl+click),
    // move or release before then and it falls back to a normal tap-to-select. Trim handles skip this
    // entirely — a delayed grab there would make trimming feel laggy for no benefit, since there's no
    // meaningful "multi-select a trim handle" gesture to defer for.
    const isTouch = "touches" in event;
    // The SAME long-press gate also decides whether a touch-drag is even allowed to begin at all —
    // see the root element's own comment on why `touch-action` starts permissive and only becomes
    // `none` once this fires. Without gating, ANY touch movement on a clip (which covers most of the
    // visible track area) immediately became a move-drag, so there was no way to pan the timeline by
    // swiping across a clip — worse, a swipe that only meant to scroll could silently nudge the clip a
    // few pixels first. Confirmed as the actual cause of "touch/scroll doesn't work" on a real
    // Capacitor Android build, not just a theoretical concern.
    const gateBehindLongPress = isTouch && mode === "move" && !additive;
    let longPressFired = false;
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    if (gateBehindLongPress) {
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        longPressFired = true;
        toggleSelect(clip.id);
        // Only NOW does this touch sequence start capturing movement as a drag — see the root
        // element's own comment on why this is a direct DOM mutation, not React state.
        if (rootRef.current) rootRef.current.style.touchAction = "none";
      }, LONG_PRESS_MS);
    } else {
      applyTapSelection();
    }

    const start = clientPoint(event);
    dragRef.current = { mode, startX: start.x, origin: { ...clip }, moved: false };
    targetTrackRef.current = track.id;
    // Read imperatively rather than via a reactive subscription — this only needs the CURRENT
    // playhead at the instant a drag starts, not a value that re-renders every clip on the timeline
    // 30-60 times a second during playback (which is exactly what a `useEditorStore((s) => s.playhead)`
    // subscription here used to do, for every clip, the whole time the preview was playing).
    const points = snapPoints(project, clip.id, useEditorStore.getState().playhead);

    function onMove(moveEvent: MouseEvent | TouchEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const point = clientPoint(moveEvent);
      const dx = point.x - drag.startX;
      const threshold = isTouch ? TOUCH_DRAG_THRESHOLD : DRAG_THRESHOLD;
      if (!drag.moved && Math.abs(dx) < threshold) return;
      if (!drag.moved && gateBehindLongPress && longPressTimer !== null) {
        // Real movement arrived before the long-press armed the drag — this is a pan/scroll attempt,
        // not a deliberate pick-up-and-move. Abandon the clip interaction entirely: clear the pending
        // timer, drop out of drag tracking, and remove our own listeners WITHOUT ever calling
        // `preventDefault` or flipping `touch-action` to `none` — `touch-action` stayed permissive
        // this whole time (see the root element's className), so the browser is free to pick this
        // touch up as a native pan the instant it decides to, exactly as if it had started over empty
        // timeline space. No selection change either: an aborted-to-scroll gesture isn't a tap.
        clearTimeout(longPressTimer);
        longPressTimer = null;
        dragRef.current = null;
        removeListeners();
        return;
      }
      if (!drag.moved && longPressTimer !== null) {
        // Real movement arrived before the long-press fired — this is a drag, not a hold, so behave
        // exactly like a mouse press-and-drag would: establish the selection right now instead of
        // waiting for a hold that's no longer going to happen. Only reachable for a non-gated drag
        // (mouse, or the vanishingly rare additive-touch case) — the gated touch path above already
        // returned before reaching here.
        clearTimeout(longPressTimer);
        longPressTimer = null;
        applyTapSelection();
      }
      drag.moved = true;

      const deltaSeconds = dx / pixelsPerSecond;
      const snapWindow = (isTouch ? TOUCH_SNAP_PIXELS : SNAP_PIXELS) / pixelsPerSecond;
      const origin = drag.origin;
      const originDuration = origin.sourceOut - origin.sourceIn;

      if (drag.mode === "move") {
        // Vertical position picks the destination track. Only trimming is locked to one track — an
        // edge being dragged sideways has no meaningful "other track" to land on.
        const overTrackId = resolveTrackAt(point.y) ?? track.id;
        if (overTrackId !== targetTrackRef.current) {
          targetTrackRef.current = overTrackId;
          onTargetTrackChange(overTrackId === track.id ? null : overTrackId);
        }

        const rawStart = Math.max(0, origin.timelineStart + deltaSeconds);
        // Both edges are candidates for snapping; whichever lands closer wins, which is what makes
        // butting one clip up against another feel reliable.
        const snappedStart = snapTime(rawStart, points, snapWindow);
        const snappedEnd = snapTime(rawStart + originDuration, points, snapWindow) - originDuration;
        const best =
          Math.abs(snappedStart - rawStart) <= Math.abs(snappedEnd - rawStart) ? snappedStart : snappedEnd;
        // A move doesn't touch sourceIn/sourceOut at all — the whole clip just slides, so the
        // waveform's own window into the source stays exactly what it already was. `best !== rawStart`
        // is a cheap, exact way to tell "did this land on a snap point" apart from "just where the
        // finger happens to be" — see `preview.snapped`'s own comment on why that distinction matters.
        updatePreview({
          start: Math.max(0, best),
          duration: originDuration,
          sourceIn: origin.sourceIn,
          sourceOut: origin.sourceOut,
          snapped: best !== rawStart,
        });
      } else if (drag.mode === "trim-in") {
        const unsnappedEdge = origin.timelineStart + deltaSeconds;
        const snappedEdge = snapTime(unsnappedEdge, points, snapWindow);
        // Clamped here only for the visual preview; the authoritative clamping (against the source's
        // real extent and the one-frame minimum) happens in trimClip when the command runs.
        const edge = Math.min(Math.max(0, snappedEdge), origin.timelineStart + originDuration - 1 / project.sequence.fps);
        // Mirrors trimClip's own in-edge math: sourceIn shifts by exactly how far timelineStart moved.
        const newSourceIn = origin.sourceIn + (edge - origin.timelineStart);
        updatePreview({
          start: edge,
          duration: origin.timelineStart + originDuration - edge,
          sourceIn: newSourceIn,
          sourceOut: origin.sourceOut,
          snapped: snappedEdge !== unsnappedEdge,
        });
      } else {
        const unsnappedEdge = origin.timelineStart + originDuration + deltaSeconds;
        const snappedEdge = snapTime(unsnappedEdge, points, snapWindow);
        const edge = Math.max(snappedEdge, origin.timelineStart + 1 / project.sequence.fps);
        const newDuration = edge - origin.timelineStart;
        updatePreview({
          start: origin.timelineStart,
          duration: newDuration,
          sourceIn: origin.sourceIn,
          sourceOut: origin.sourceIn + newDuration,
          snapped: snappedEdge !== unsnappedEdge,
        });
      }
    }

    function onUp(upEvent: MouseEvent | TouchEvent) {
      removeListeners();
      // Reset back to permissive for the NEXT gesture — only ever needed if the long press actually
      // armed it (see the timer callback above); harmless to call unconditionally otherwise, since
      // clearing an inline style that was never set is a no-op.
      if (gateBehindLongPress && rootRef.current) rootRef.current.style.touchAction = "";
      // Refreshed here too, not just at touchSTART — a long hold (this whole gesture, easily past
      // `LONG_PRESS_MS`) means the ghost mouse event fires well after `beginDrag` originally ran, so
      // anchoring the grace window to release time (closer to when that ghost actually arrives) is
      // what keeps `SYNTHETIC_MOUSE_GRACE_MS` short without risking a stale, expired window.
      if ("touches" in upEvent) lastTouchAtRef.current = Date.now();
      if (longPressTimer !== null) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
        // Never fired and never turned into a drag (that path already applied its own selection via
        // `onMove` above) — a genuine quick tap, so it selects exactly like a mouse click would.
        if (!longPressFired) applyTapSelection();
      }
      const drag = dragRef.current;
      dragRef.current = null;

      const final = previewRef.current;
      const targetTrackId = targetTrackRef.current;
      updatePreview(null);
      onTargetTrackChange(null);
      targetTrackRef.current = track.id;

      if (drag?.moved && final) {
        // moveClip rejects a video↔audio track mismatch itself, surfacing a status message rather
        // than silently dropping the clip somewhere it can never render.
        if (drag.mode === "move") {
          const deltaSeconds = final.start - drag.origin.timelineStart;
          const groupIds = selectedClipIds.includes(clip.id) ? selectedClipIds : [clip.id];
          if (groupIds.length > 1 && deltaSeconds !== 0) {
            // Every OTHER selected clip moves by the SAME time delta and stays on its OWN track —
            // only the clip actually under the pointer can change tracks; there's no single
            // meaningful "destination track" for clips that started on different ones. A clip on a
            // locked track is left out entirely rather than failing the whole group move.
            const moves = [new MoveClipCommand(clip.id, targetTrackId, final.start)];
            for (const id of groupIds) {
              if (id === clip.id) continue;
              const found = findClip(project, id);
              if (!found || found.track.locked) continue;
              moves.push(new MoveClipCommand(id, found.track.id, found.clip.timelineStart + deltaSeconds));
            }
            run(new BatchCommand("Move Clips", moves));
          } else {
            run(new MoveClipCommand(clip.id, targetTrackId, final.start));
          }
        } else if (drag.mode === "trim-in") run(new TrimClipCommand(clip.id, "in", final.start));
        else run(new TrimClipCommand(clip.id, "out", final.start + final.duration));
      }
    }

    const removeListeners = addDragListeners(onMove, onUp);
  }

  const isAudio = track.kind === "audio";

  return (
    <div
      ref={rootRef}
      role="button"
      tabIndex={0}
      aria-label={`${assetName}, ${formatDuration(duration)}`}
      onMouseDown={(e) => beginDrag(e, "move")}
      onTouchStart={(e) => beginDrag(e, "move")}
      onClick={(e) => {
        e.stopPropagation();
        // Only a KEYBOARD-activated click (Enter/Space on the focused button) needs to select here
        // — a real mouse click already went through beginDrag's own (possibly additive) selection
        // logic on mousedown, and unconditionally re-selecting here would stomp a Ctrl/Cmd+click
        // toggle the instant the matching mouseup's click event fires. `detail === 0` is the
        // standard way to tell a keyboard-triggered click apart from a real mouse one.
        if (e.detail === 0) select([clip.id]);
      }}
      style={{
        left: start * pixelsPerSecond,
        width: Math.max(2, duration * pixelsPerSecond),
      }}
      // Deliberately NOT `touch-none` here (unlike the trim handles below, and unlike the ruler's own
      // touch-none in Timeline.tsx) — `touch-action` starts at its default `auto`, so a touch starting
      // on a clip is free to become a native pan/scroll of the timeline underneath it, exactly like
      // touching empty track space would. `beginDrag`'s long-press gate is what flips this to `none`
      // (via a direct style mutation on `rootRef`, not this className) the moment a touch-drag is
      // actually armed — see its own comment for why a whole-scroll-vs-move-this-clip ambiguity needs
      // a deliberate hold to resolve, the same way this app already resolves touch's lack of a Ctrl
      // key for multi-select. select-none + [-webkit-touch-callout:none] are a SEPARATE fix for a
      // separate browser behavior: they stop the label text (and, for a text clip, its own content
      // name) from being eligible for the browser's own long-press-to-select-text gesture, which used
      // to fire at the same time as the long-press-to-multi-select gesture above, popping up the
      // native selection handles/copy menu on top of (and fighting) the app's own selection. Confirmed
      // live on a touch device, not just from the CSS spec.
      className={`group absolute top-1 bottom-1 select-none [-webkit-touch-callout:none] overflow-hidden rounded-md border text-left transition-colors ${
        track.locked ? "cursor-default" : "cursor-grab active:cursor-grabbing"
      } ${
        preview?.snapped
          // Distinct, unmissable highlight the instant a drag actually snaps to an edge/the
          // playhead — overrides the normal selected/kind coloring for as long as it's engaged, so
          // hitting a snap point is something you SEE happen, not just trust did. Requested directly:
          // dragging felt "imprecise" with only the plain dim-while-dragging feedback this had before.
          ? "border-amber-300 bg-amber-500/30 ring-2 ring-amber-300"
          : selected
            ? "border-sky-300 bg-sky-500/35 ring-1 ring-sky-300/70"
            : isAudio
              ? "border-emerald-400/40 bg-emerald-500/20 hover:bg-emerald-500/30"
              : "border-sky-400/40 bg-sky-500/20 hover:bg-sky-500/30"
      } ${
        // A stronger "picked up" look while any drag is active — a shadow + slight scale + raised
        // z-index instead of the old plain `opacity-80`, so the clip being moved reads as elevated/
        // grabbed rather than just faded. `z-20`: above sibling clips and the drop-target highlight
        // (z-10), below the playhead/export markers (z-30) — never fights either.
        preview ? "z-20 scale-[1.02] opacity-90 shadow-lg shadow-black/60" : ""
      }`}
    >
      {thumbnail && (
        // `z-0`: an explicit value (not left `auto`) so it's unambiguously BELOW the label/handles
        // below, which are bumped to `z-10` for the same reason — the label is otherwise a plain
        // `position: static` element, which paints BENEATH any positioned sibling regardless of DOM
        // order, so without this it would end up hidden under the thumbnail rather than in front of it.
        <div
          aria-hidden
          className="absolute inset-0 z-0 opacity-70"
          style={{ backgroundImage: `url(${thumbnail})`, backgroundRepeat: "repeat-x", backgroundSize: "auto 100%" }}
        />
      )}
      {waveform && (
        // Same `z-0`-below-the-label reasoning as the thumbnail above. `backgroundRepeat: "no-repeat"`
        // (unlike the filmstrip's `repeat-x`): this is one continuous image, not a tiled sprite —
        // repeating it would double-draw the tail end. Pixel-based size/position (see `waveformSizePx`/
        // `waveformOffsetPx` above), not percentages — the box's own `overflow-hidden` (from this
        // element's `absolute inset-0` inside the clip's `overflow-hidden` container) does the actual
        // cropping, so the image itself never needs to know how wide the box is.
        <div
          aria-hidden
          className="absolute inset-0 z-0 opacity-70"
          style={{
            backgroundImage: `url(${waveform})`,
            backgroundRepeat: "no-repeat",
            backgroundSize: `${waveformSizePx}px 100%`,
            backgroundPosition: `${-waveformOffsetPx}px 0`,
          }}
        />
      )}
      {clip.transitionIn && (
        // A static corner mark — the only on-timeline sign a transition exists at all, since there's
        // no drag-to-create gesture yet (Inspector-only for this pass, same as how Effects shipped
        // before Transform's on-canvas handles arrived later). Pure CSS triangle via border trick,
        // not an icon, so it never depends on a font/asset load finishing first.
        <div
          aria-hidden
          title="Crossfades from the previous clip"
          className="pointer-events-none absolute left-0 top-0 z-10 h-0 w-0 border-t-[14px] border-r-[14px] border-t-amber-300/90 border-r-transparent"
        />
      )}
      <span className="pointer-events-none relative z-10 block truncate bg-gradient-to-b from-black/40 to-transparent px-2 py-1 text-[11px] font-medium text-white/90">
        {assetName}
      </span>

      {!track.locked && (
        <>
          {/* Trim handles. Wider below `lg` (12px vs 8px) since a fingertip needs a bigger target
              than a mouse cursor does — an edge that's hard to grab is the single most common source
              of frustration in a timeline, and on touch an 8px hit area is close to ungrabbable. */}
          <div
            role="separator"
            aria-label="Trim clip start"
            onMouseDown={(e) => beginDrag(e, "trim-in")}
            onTouchStart={(e) => beginDrag(e, "trim-in")}
            className="absolute inset-y-0 left-0 z-10 w-3 touch-none cursor-ew-resize bg-white/0 transition group-hover:bg-white/25 lg:w-2"
          />
          <div
            role="separator"
            aria-label="Trim clip end"
            onMouseDown={(e) => beginDrag(e, "trim-out")}
            onTouchStart={(e) => beginDrag(e, "trim-out")}
            className="absolute inset-y-0 right-0 z-10 w-3 touch-none cursor-ew-resize bg-white/0 transition group-hover:bg-white/25 lg:w-2"
          />
        </>
      )}
    </div>
  );
}

export const TimelineClip = React.memo(TimelineClipComponent);
