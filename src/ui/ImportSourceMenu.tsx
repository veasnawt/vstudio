"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Folder, Image as ImageIcon } from "@veasnawt/vicons";
import { useTranslation } from "../i18n/useTranslation.ts";

/** Anchors the popup under the Import button, then keeps it inside the viewport — the same
 *  "compute from a rect, clamp to viewport" shape this codebase doesn't have a shared helper for yet
 *  (nothing else opens a floating popup anchored to an arbitrary trigger; `Dropdown` positions itself
 *  via normal document flow instead), so it's inlined here rather than invented as a premature
 *  abstraction for a single caller. */
function popupPosition(anchor: DOMRect): { top: number; left: number } {
  const width = 220;
  const left = Math.min(anchor.left, window.innerWidth - width - 8);
  return { top: anchor.bottom + 6, left: Math.max(8, left) };
}

/** Native-only (see `MediaLibrary`'s gate on `Capacitor.isNativePlatform()`) 2-choice popup offered by
 *  the Import button on iOS/iPad/Android: "Photos" (the device's own photo/video library, via
 *  `@capacitor/camera`'s picker) or "Files" (the existing universal file browser, unchanged from web/
 *  desktop). Web/desktop never render this — the Import button there goes straight to the file input,
 *  exactly as before. */
export function ImportSourceMenu({
  anchorRef,
  onPickPhotos,
  onPickFiles,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  onPickPhotos: () => void;
  onPickFiles: () => void;
  onClose: () => void;
}) {
  const t = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const anchor = anchorRef.current?.getBoundingClientRect();

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
  const { top, left } = popupPosition(anchor);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("Import from")}
      style={{ position: "fixed", top, left, width: 220 }}
      className="z-50 overflow-hidden rounded-lg border border-white/10 bg-[#181b22] py-1 shadow-2xl"
    >
      <button
        role="menuitem"
        onClick={() => {
          onClose();
          onPickPhotos();
        }}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs text-white/85 transition hover:bg-white/10"
      >
        <ImageIcon size={16} className="shrink-0 text-white/50" />
        <span>
          <span className="block font-medium text-white">{t("Photos")}</span>
          <span className="block text-[10px] text-white/40">{t("Your device's photo library")}</span>
        </span>
      </button>
      <button
        role="menuitem"
        onClick={() => {
          onClose();
          onPickFiles();
        }}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs text-white/85 transition hover:bg-white/10"
      >
        <Folder size={16} className="shrink-0 text-white/50" />
        <span>
          <span className="block font-medium text-white">{t("Files")}</span>
          <span className="block text-[10px] text-white/40">{t("Browse all files")}</span>
        </span>
      </button>
    </div>,
    document.body
  );
}
