"use client";

import React, { useState } from "react";
import { Delete, Lock, Unlock, Visibility, VisibilityOff } from "@veasnawt/vicons";
import { RemoveTrackCommand, SetTrackFlagCommand } from "../commands/index.ts";
import type { Track } from "../project/types.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** Carries the dragged track's id, readable only at drop time (browsers restrict `getData` during
 *  `dragover` for security). A SECOND, per-kind type — `${TRACK_DRAG_MIME}-kind-${kind}` — carries no
 *  data at all and exists purely so `dragover`/`drop` can check `types.includes(...)`, which IS
 *  readable mid-drag, to confirm the dragged track is the same kind as the row being hovered. That's
 *  what keeps a video track from being reordered into the audio group (or vice versa) — the same
 *  video-above-audio invariant `addTrack`/`reorderTrack` both maintain. */
const TRACK_DRAG_MIME = "application/x-vstudio-track";

function FlagButton({
  active,
  onClick,
  label,
  children,
  activeClass,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
  activeClass: string;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold transition ${
        active ? activeClass : "text-white/35 hover:bg-white/10 hover:text-white/70"
      }`}
    >
      {children}
    </button>
  );
}

export function TrackHeader({
  track,
  height,
  dropIndicator,
  onDragOverRow,
  onDropRow,
  onDragEndRow,
}: {
  track: Track;
  height: number;
  /** "before"/"after" if THIS row is the current drag target, else null — Timeline owns the single
   *  shared piece of state this derives from, since only one row can be a drop target at a time. */
  dropIndicator: "before" | "after" | null;
  onDragOverRow: (trackId: string, position: "before" | "after") => void;
  onDropRow: (sourceTrackId: string, targetTrackId: string, position: "before" | "after") => void;
  onDragEndRow: () => void;
}) {
  const run = useEditorStore((s) => s.run);
  const activeTrackId = useEditorStore((s) => s.activeTrackId);
  const setActiveTrack = useEditorStore((s) => s.setActiveTrack);

  const isActive = activeTrackId === track.id;
  // Confirmation state lives here rather than lifted up to Timeline — each header is independent and
  // only ever removes ITSELF, so there's nothing to coordinate across tracks.
  const [confirmOpen, setConfirmOpen] = useState(false);

  /** Top half of the row means "drop before me", bottom half means "drop after me" — the standard
   *  reorder-list convention, and simple arithmetic since rows are a uniform height. */
  function positionInRow(e: React.DragEvent): "before" | "after" {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY - rect.top < rect.height / 2 ? "before" : "after";
  }

  return (
    <div
      style={{ height }}
      onClick={() => setActiveTrack(track.id)}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(`${TRACK_DRAG_MIME}-kind-${track.kind}`)) return;
        e.preventDefault();
        onDragOverRow(track.id, positionInRow(e));
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes(`${TRACK_DRAG_MIME}-kind-${track.kind}`)) return;
        e.preventDefault();
        const sourceId = e.dataTransfer.getData(TRACK_DRAG_MIME);
        if (sourceId && sourceId !== track.id) onDropRow(sourceId, track.id, positionInRow(e));
      }}
      className={`group relative flex shrink-0 cursor-pointer flex-col justify-center gap-1 border-b border-r border-white/10 px-2 ${
        isActive ? "bg-white/[0.07]" : "bg-[#0d0f14] hover:bg-white/[0.04]"
      }`}
    >
      {/* A thin line on the edge the dragged track would land on — the same "before/after this row"
          model the drop position was computed from, made visible. */}
      {dropIndicator && (
        <div
          className={`pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-sky-400 ${
            dropIndicator === "before" ? "top-0" : "bottom-0"
          }`}
        />
      )}

      <div className="flex items-center gap-1.5">
        <span
          draggable
          onDragStart={(e) => {
            e.stopPropagation();
            e.dataTransfer.setData(TRACK_DRAG_MIME, track.id);
            e.dataTransfer.setData(`${TRACK_DRAG_MIME}-kind-${track.kind}`, "");
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={onDragEndRow}
          onClick={(e) => e.stopPropagation()}
          title="Drag to reorder"
          aria-label={`Reorder ${track.name}`}
          className="shrink-0 cursor-grab select-none text-[10px] leading-none text-white/25 transition hover:text-white/60 active:cursor-grabbing"
        >
          ⋮⋮
        </span>
        {/* The active track is where a double-clicked library asset lands, so it needs to be
            visible at a glance rather than something the user has to remember. */}
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${isActive ? "bg-sky-400" : "bg-transparent"}`} />
        <span className="truncate text-[11px] font-semibold text-white/80">{track.name}</span>
        {/* Faded in on hover/focus at `lg`+ rather than always visible — a permanent delete icon next
            to every track invites a stray click far more than the same control does when it only
            appears once you're already pointing at that row. Below `lg` there's no hover to fade it
            in FROM (touch has no `:hover`), so it stays visible there — same reasoning as the media
            library's remove button. */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setConfirmOpen(true);
          }}
          title="Remove track"
          aria-label={`Remove ${track.name}`}
          className="ml-auto flex shrink-0 items-center rounded px-1 py-0.5 text-white/35 transition hover:bg-rose-500/20 hover:text-rose-300 lg:text-white/0 lg:group-hover:text-white/35 lg:focus-visible:text-white/35"
        >
          <Delete size={14} />
        </button>
      </div>

      <div className="flex items-center gap-0.5">
        <FlagButton
          active={track.locked}
          onClick={() => run(new SetTrackFlagCommand(track.id, "locked", !track.locked))}
          label={track.locked ? "Unlock track" : "Lock track"}
          activeClass="bg-amber-500/25 text-amber-300"
        >
          {track.locked ? <Lock size={13} /> : <Unlock size={13} />}
        </FlagButton>

        {track.kind !== "audio" ? (
          // Video and text tracks both have a visible on-canvas result, so both get the same
          // show/hide toggle; only audio has nothing to show and gets mute/solo instead.
          <FlagButton
            active={!track.visible}
            onClick={() => run(new SetTrackFlagCommand(track.id, "visible", !track.visible))}
            label={track.visible ? "Hide track" : "Show track"}
            activeClass="bg-white/15 text-white/80"
          >
            {track.visible ? <Visibility size={13} /> : <VisibilityOff size={13} />}
          </FlagButton>
        ) : (
          <>
            <FlagButton
              active={track.muted}
              onClick={() => run(new SetTrackFlagCommand(track.id, "muted", !track.muted))}
              label={track.muted ? "Unmute track" : "Mute track"}
              activeClass="bg-rose-500/25 text-rose-300"
            >
              M
            </FlagButton>
            <FlagButton
              active={track.solo}
              onClick={() => run(new SetTrackFlagCommand(track.id, "solo", !track.solo))}
              label={track.solo ? "Unsolo track" : "Solo track"}
              activeClass="bg-emerald-500/25 text-emerald-300"
            >
              S
            </FlagButton>
          </>
        )}
      </div>

      {confirmOpen && (
        <ConfirmDialog
          title={`Remove ${track.name}?`}
          message={
            track.clips.length > 0
              ? `This deletes ${track.clips.length} clip${track.clips.length === 1 ? "" : "s"} on this track. You can undo it with Ctrl/⌘+Z.`
              : "This track is empty. You can undo it with Ctrl/⌘+Z."
          }
          confirmLabel="Remove track"
          onConfirm={() => {
            setConfirmOpen(false);
            run(new RemoveTrackCommand(track.id));
          }}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}
