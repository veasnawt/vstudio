"use client";

import React, { useRef, useState } from "react";
import { Delete, Lock, Music, Text as TextIcon, Unlock, Video, Visibility, VisibilityOff } from "@veasnawt/vicons";
import { RemoveTrackCommand, SetTrackFlagCommand } from "../commands/index.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import type { Track } from "../project/types.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** Icon + accent color standing in for the track's own name/controls when collapsed (mobile,
 *  inactive — see `iconOnly` below) — same color convention `TimelineClip.tsx` already uses to tell
 *  video/audio clips apart at a glance (sky/emerald), extended to text tracks with amber so all three
 *  kinds read distinctly even reduced to a single glyph. */
const KIND_ICON: Record<Track["kind"], { Icon: typeof Video; className: string }> = {
  video: { Icon: Video, className: "text-sky-300" },
  audio: { Icon: Music, className: "text-emerald-300" },
  text: { Icon: TextIcon, className: "text-amber-300" },
};

/** Per-kind subset of MediaLibrary.tsx's own `ACCEPTED_EXTENSIONS` — a video track takes video OR
 *  image files (images live on a video track alongside real video, see `trackKindForAsset`'s own
 *  comment in timeline/operations.ts), an audio track takes only audio. Not imported from
 *  MediaLibrary.tsx since that file keeps one flat unsplit list; duplicated here rather than
 *  restructuring that file just for this. Text tracks get no import button at all — a text track's
 *  content is typed, not a file. */
const ACCEPTED_EXTENSIONS_BY_KIND: Record<"video" | "audio", string> = {
  video: ".mp4,.mov,.webm,.mkv,.avi,.m4v,.png,.jpg,.jpeg,.webp,.gif",
  audio: ".wav,.mp3,.aac,.flac,.m4a,.ogg",
};

/** Carries the dragged track's id, readable only at drop time (browsers restrict `getData` during
 *  `dragover` for security). A SECOND, per-kind type — `${TRACK_DRAG_MIME}-kind-${kind}` — carries no
 *  data at all and exists purely so `dragover`/`drop` can check `types.includes(...)`, which IS
 *  readable mid-drag, to confirm the dragged track is the same kind as the row being hovered. That's
 *  what keeps a video track from being reordered into the audio group (or vice versa) — the same
 *  video-above-audio invariant `addTrack`/`reorderTrack` both maintain. */
const TRACK_DRAG_MIME = "application/x-vcut-track";

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
      // Fixed min HEIGHT rather than padding-driven sizing: the previous padding-only sizing
      // (px-1.5 py-0.5 around a 13px icon or single letter) measured as small as ~17×19px on a real
      // mobile viewport — too small to reliably tap for a control used mid-playback (mute/solo while
      // previewing). Width is tighter (22px, not 26) — now that the whole header is ONE row (name,
      // drag handle, and up to 3 of these sharing it with Import/Delete), vertical accuracy matters
      // far more than horizontal for a row of adjacent icons: a thumb still lands on the right button
      // reliably as long as it's tall enough, even if slightly narrower.
      className={`inline-flex min-h-[26px] min-w-[22px] items-center justify-center rounded text-[11px] font-semibold transition ${
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
  compact,
  isMobile,
  dropIndicator,
  onDragOverRow,
  onDropRow,
  onDragEndRow,
}: {
  track: Track;
  height: number;
  /** True for an empty track on mobile (see Timeline.tsx's own `isTrackCompact`) — drops the
   *  lock/visibility/mute/solo row entirely rather than trying to squeeze it into a shorter row.
   *  Those controls govern EXISTING content, which a compact row by definition doesn't have yet; they
   *  reappear automatically the moment a clip lands (the row grows back to full height at the same
   *  time, in Timeline.tsx). */
  compact: boolean;
  /** Drives `iconOnly` below (mobile + not the active track) — same `lg` breakpoint every other
   *  mobile/desktop split in this app uses, passed down rather than each header running its own
   *  `matchMedia` listener (cheap, but no reason for N redundant listeners over one shared value). */
  isMobile: boolean;
  /** "before"/"after" if THIS row is the current drag target, else null — Timeline owns the single
   *  shared piece of state this derives from, since only one row can be a drop target at a time. */
  dropIndicator: "before" | "after" | null;
  onDragOverRow: (trackId: string, position: "before" | "after") => void;
  onDropRow: (sourceTrackId: string, targetTrackId: string, position: "before" | "after") => void;
  onDragEndRow: () => void;
}) {
  const t = useTranslation();
  const run = useEditorStore((s) => s.run);
  const activeTrackId = useEditorStore((s) => s.activeTrackId);
  const setActiveTrack = useEditorStore((s) => s.setActiveTrack);
  const importFiles = useEditorStore((s) => s.importFiles);
  const addAssetAtPlayhead = useEditorStore((s) => s.addAssetAtPlayhead);
  const importing = useEditorStore((s) => s.importing);

  const isActive = activeTrackId === track.id;
  // Collapsed to a single color-coded kind icon until tapped — a narrow phone doesn't have room to
  // show every track's full name/controls at once, and most of the time you only need to see/act on
  // ONE track anyway (whichever you just tapped, which `isActive` already tracks — no new state).
  // Desktop keeps the full header always, at every breakpoint it's always had room for.
  const iconOnly = isMobile && !isActive;
  // Confirmation state lives here rather than lifted up to Timeline — each header is independent and
  // only ever removes ITSELF, so there's nothing to coordinate across tracks.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  /** Top half of the row means "drop before me", bottom half means "drop after me" — the standard
   *  reorder-list convention, and simple arithmetic since rows are a uniform height. */
  function positionInRow(e: React.DragEvent): "before" | "after" {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY - rect.top < rect.height / 2 ? "before" : "after";
  }

  if (iconOnly) {
    const { Icon, className } = KIND_ICON[track.kind];
    return (
      <div
        style={{ height }}
        onClick={() => setActiveTrack(track.id)}
        title={t("{name} — tap to expand", { name: track.name })}
        aria-label={t("{name} track, collapsed — tap to expand", { name: track.name })}
        // Drag-TO-reorder-onto still works (another track's own expanded drag handle can target this
        // row) — only the reorder-FROM affordance (the "⋮⋮" handle) is dropped, along with everything
        // else, in favor of a single glanceable icon.
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
        className="relative flex shrink-0 cursor-pointer items-center justify-center border-b border-r border-white/10 bg-[#0d0f14] transition hover:bg-white/[0.04]"
      >
        {dropIndicator && (
          <div
            className={`pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-sky-400 ${
              dropIndicator === "before" ? "top-0" : "bottom-0"
            }`}
          />
        )}
        <Icon size={16} className={className} />
      </div>
    );
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
      className={`group relative flex shrink-0 cursor-pointer items-center gap-1 border-b border-r border-white/10 px-1.5 ${
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

      {/* ONE row, not the two stacked rows this used to be — `TRACK_HEIGHT` shrank (a real, deliberate
          "shorter clips" request), and two rows of genuinely-tappable 26px controls simply no longer
          fit the vertical space at all, not just look cramped: 26px + a gap + 26px alone already
          exceeds the new row height before the name/drag-handle/anything else even enters the count.
          Putting name, flags, import, and delete all in one horizontally-centered row needs no more
          VERTICAL room than a single 26px control ever did — `items-center` on the row centers
          everything in whatever `height` this instance got, unchanged from before. */}
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
        title={t("Drag to reorder")}
        aria-label={t("Reorder {name}", { name: track.name })}
        className="shrink-0 cursor-grab select-none text-[10px] leading-none text-white/25 transition hover:text-white/60 active:cursor-grabbing"
      >
        ⋮⋮
      </span>
      {/* The active track is where a double-clicked library asset lands, so it needs to be
          visible at a glance rather than something the user has to remember. */}
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${isActive ? "bg-sky-400" : "bg-transparent"}`} />
      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-white/80">{track.name}</span>

      {!compact && (
        <div className="flex shrink-0 items-center gap-0.5">
          <FlagButton
            active={track.locked}
            onClick={() => run(new SetTrackFlagCommand(track.id, "locked", !track.locked))}
            label={track.locked ? t("Unlock track") : t("Lock track")}
            activeClass="bg-amber-500/25 text-amber-300"
          >
            {track.locked ? <Lock size={13} /> : <Unlock size={13} />}
          </FlagButton>

          {track.kind !== "audio" && (
            // Video and text tracks both have a visible on-canvas result, so both get the same
            // show/hide toggle; a dedicated audio track has nothing to show and gets mute/solo
            // instead, below.
            <FlagButton
              active={!track.visible}
              onClick={() => run(new SetTrackFlagCommand(track.id, "visible", !track.visible))}
              label={track.visible ? t("Hide track") : t("Show track")}
              activeClass="bg-white/15 text-white/80"
            >
              {track.visible ? <Visibility size={13} /> : <VisibilityOff size={13} />}
            </FlagButton>
          )}
          {track.kind === "video" && (
            // A video clip's own embedded audio is a genuinely separate thing from its PICTURE —
            // muting it must not require hiding the track too (see `Clip.mutedAudio`'s own doc
            // comment on why "hidden implies silent" isn't the same ask as "silent but still visible").
            // `PlaybackEngine.syncVideoClipAudio` and `buildExportPlan.ts`'s own `buildTrackStreams`
            // already fold `track.muted` into a video track's embedded-audio check — this button was
            // simply the missing way to ever SET it for a video track; no Solo here, since solo only
            // ever applies to dedicated audio tracks (`anySoloAudioTrack`), not a video track's
            // incidental embedded sound.
            <FlagButton
              active={track.muted}
              onClick={() => run(new SetTrackFlagCommand(track.id, "muted", !track.muted))}
              label={track.muted ? t("Unmute track") : t("Mute track")}
              activeClass="bg-rose-500/25 text-rose-300"
            >
              M
            </FlagButton>
          )}
          {track.kind === "audio" && (
            <>
              <FlagButton
                active={track.muted}
                onClick={() => run(new SetTrackFlagCommand(track.id, "muted", !track.muted))}
                label={track.muted ? t("Unmute track") : t("Mute track")}
                activeClass="bg-rose-500/25 text-rose-300"
              >
                M
              </FlagButton>
              <FlagButton
                active={track.solo}
                onClick={() => run(new SetTrackFlagCommand(track.id, "solo", !track.solo))}
                label={track.solo ? t("Unsolo track") : t("Solo track")}
                activeClass="bg-emerald-500/25 text-emerald-300"
              >
                S
              </FlagButton>
            </>
          )}
        </div>
      )}

      {/* Imports a file straight onto THIS track, at the playhead — the direct alternative to
          dragging an asset in from the Media Library, which is a fiddly gesture on a touchscreen
          (long-press to arm the drag, then hit a specific track row) compared to a plain tap here.
          Text tracks get neither an import button nor anything to import (their content is typed).
          `lg:w-0 lg:overflow-hidden` (not just a faded color, the way Delete alone used to fade in
          below) is what makes room for the flag buttons above at the new, tighter row width: below
          `lg` it stays a normal, always-visible 26px control (there's no `:hover` on touch to reveal
          it FROM, same reasoning `Delete`'s own comment already gives), but at `lg`+ it collapses to
          zero width — not just invisible, genuinely out of the way — until the row is hovered, the
          same "occasional action doesn't need to cost permanent space" tradeoff Delete already made,
          just extended to actually reclaim the width instead of only the visual weight. */}
      {track.kind !== "text" && (
        <>
          <button
            onClick={(e) => {
              e.stopPropagation();
              importInputRef.current?.click();
            }}
            disabled={importing}
            title={t("Import {kind} onto {name}", { kind: t(track.kind), name: track.name })}
            aria-label={t("Import {kind} onto {name}", { kind: t(track.kind), name: track.name })}
            className="inline-flex min-h-[26px] min-w-[22px] shrink-0 items-center justify-center overflow-hidden rounded text-[15px] font-semibold leading-none text-white/35 transition hover:bg-white/10 hover:text-white/70 disabled:cursor-default disabled:opacity-40 lg:min-w-0 lg:w-0 lg:group-hover:w-[22px] lg:group-hover:min-w-[22px]"
          >
            +
          </button>
          <input
            ref={importInputRef}
            type="file"
            multiple
            accept={ACCEPTED_EXTENSIONS_BY_KIND[track.kind]}
            className="hidden"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              // Cleared so re-picking the same file still fires a change event.
              e.target.value = "";
              if (files.length === 0) return;
              void importFiles(files).then((assets) => {
                // Sequential, non-overlapping placement — same option addAssetAtPlayhead already
                // supports for exactly this "landed several at once" case, so importing 3 clips here
                // doesn't stack them all on top of each other at the playhead.
                for (const asset of assets) addAssetAtPlayhead(asset.id, track.id, { avoidOverlap: true });
              });
            }}
          />
        </>
      )}
      {/* Same space-collapsing treatment as Import above, for the same reason — see its own comment. */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          setConfirmOpen(true);
        }}
        title={t("Remove track")}
        aria-label={t("Remove {name}", { name: track.name })}
        className="flex min-h-[26px] min-w-[20px] shrink-0 items-center justify-center overflow-hidden rounded text-white/35 transition hover:bg-rose-500/20 hover:text-rose-300 lg:min-w-0 lg:w-0 lg:group-hover:w-[20px] lg:group-hover:min-w-[20px] lg:focus-visible:w-[20px] lg:focus-visible:min-w-[20px]"
      >
        <Delete size={14} />
      </button>

      {confirmOpen && (
        <ConfirmDialog
          title={t("Remove {name}?", { name: track.name })}
          message={
            track.clips.length > 0
              ? t("This deletes {n} clip(s) on this track. You can undo it with Ctrl/⌘+Z.", { n: track.clips.length })
              : t("This track is empty. You can undo it with Ctrl/⌘+Z.")
          }
          confirmLabel={t("Remove track")}
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
