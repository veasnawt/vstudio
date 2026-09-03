"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Close } from "@veasnawt/vicons";
import { useTranslation } from "../i18n/useTranslation.ts";
import type { TransitionType } from "../project/types.ts";
import { TRANSITION_TYPE_LABEL, TRANSITION_TYPE_OPTIONS } from "../timeline/transitions.ts";
import { TransitionPreviewTile } from "./TransitionPreviewTile.tsx";

const MENU_WIDTH = 320;

/** Opens ABOVE its anchor, not below like `ImportSourceMenu` — the Transition button lives in the
 *  bottom toolbar, so a below-anchored popup would run straight off the bottom of the viewport. */
function popupPosition(anchor: DOMRect): { bottom: number; left: number } {
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8));
  return { bottom: window.innerHeight - anchor.top + 8, left };
}

/** The Transition toolbar button's grid of every `TransitionType`, each tile a live animated preview
 *  (`TransitionPreviewTile`) rather than a plain text label — picking a transition style is a visual
 *  choice (which edge does the wipe sweep from, which way does the slide push), and a dropdown of
 *  option names can't show that the way a small looping demo can. The Inspector's own "Style" dropdowns
 *  (`Inspector.tsx`'s Transition In/Out sections) still exist for fine-tuning duration afterward — this
 *  is the fast, visual path to PICK a style in the first place, for EITHER direction: an In/Out tab
 *  switch at the top edits `clip.transitionIn`/`transitionOut` independently, so both can be set from
 *  this one popup without reopening it. `type: null` (the "None" tile) clears whichever direction is
 *  currently selected. */
export function TransitionPickerMenu({
  anchorRef,
  isAudioTrack,
  isTextTrack,
  activeIn,
  activeOut,
  onChangeIn,
  onChangeOut,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  /** An audio clip's transition is always a crossfade — see `buildAudioTrackStream`'s own comment on
   *  why every `TransitionType` renders identically for audio. Narrows the grid to just the Crossfade
   *  tile (plus None) instead of showing 11 video-only styles that would all silently apply as a plain
   *  crossfade anyway — the same "duration only, no style choice" treatment the Inspector's own
   *  Transitions tab already gives an audio clip. */
  isAudioTrack: boolean;
  /** Glitch/water-ripple are video/image-only — see `TransitionType`'s own doc comment on why (export
   *  has no equivalent corruption pre-pass for the `drawtext`-based text-blend filter graph, so
   *  offering them here would let the canvas preview show something export can't reproduce). Narrows
   *  the grid to exclude just those two, unlike `isAudioTrack` above which narrows to one tile total. */
  isTextTrack: boolean;
  activeIn: TransitionType | null;
  activeOut: TransitionType | null;
  onChangeIn: (type: TransitionType | null) => void;
  onChangeOut: (type: TransitionType | null) => void;
  onClose: () => void;
}) {
  const t = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const anchor = anchorRef.current?.getBoundingClientRect();
  const [mode, setMode] = useState<"in" | "out">("in");

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [anchorRef, onClose]);

  if (!anchor) return null;
  const { bottom, left } = popupPosition(anchor);
  const activeType = mode === "in" ? activeIn : activeOut;
  const onChange = mode === "in" ? onChangeIn : onChangeOut;
  const gridOptions = isAudioTrack
    ? (["crossfade"] as TransitionType[])
    : isTextTrack
      ? TRANSITION_TYPE_OPTIONS.filter((option) => option !== "glitchCut" && option !== "waterRippleCut")
      : TRANSITION_TYPE_OPTIONS;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("Transition style")}
      style={{ position: "fixed", bottom, left, width: MENU_WIDTH }}
      className="z-50 max-h-[70vh] overflow-y-auto rounded-lg border border-white/10 bg-[#181b22] p-2 shadow-2xl"
    >
      <div className="mb-2 flex gap-1 rounded-md bg-white/5 p-0.5">
        {(["in", "out"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 rounded px-2 py-1 text-[11px] font-medium transition ${
              mode === m ? "bg-sky-500/25 text-white" : "text-white/50 hover:text-white/80"
            }`}
          >
            {m === "in" ? t("In") : t("Out")}
            {(m === "in" ? activeIn : activeOut) && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-sky-400" />}
          </button>
        ))}
      </div>
      {isAudioTrack && (
        <p className="mb-2 px-1 text-[10px] leading-snug text-white/40">
          {t("Audio transitions are always a crossfade — there's no separate visual style to pick.")}
        </p>
      )}
      <div className="grid grid-cols-3 gap-1.5">
        <button
          role="menuitem"
          onClick={() => {
            onClose();
            onChange(null);
          }}
          className={`flex flex-col items-center gap-1 rounded p-1 transition hover:bg-white/10 ${
            !activeType ? "bg-sky-500/20" : ""
          }`}
        >
          <div className="flex items-center justify-center rounded border border-white/10 bg-black/40 text-white/30" style={{ width: 96, height: 54 }}>
            <Close size={16} />
          </div>
          <span className="text-[10px] text-white/70">{t("None")}</span>
        </button>
        {gridOptions.map((type) => (
          <button
            key={type}
            role="menuitem"
            onClick={() => {
              onClose();
              onChange(type);
            }}
            className={`flex flex-col items-center gap-1 rounded p-1 transition hover:bg-white/10 ${
              activeType === type ? "bg-sky-500/20" : ""
            }`}
          >
            <TransitionPreviewTile type={type} />
            <span className="text-[10px] text-white/70">{t(TRANSITION_TYPE_LABEL[type])}</span>
          </button>
        ))}
      </div>
    </div>,
    document.body
  );
}
