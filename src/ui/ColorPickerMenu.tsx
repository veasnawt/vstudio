"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../i18n/useTranslation.ts";
import { BACKGROUND_COLOR_SWATCHES } from "../project/colorSwatches.ts";

const MENU_WIDTH = 220;

/** Same "opens above its anchor" reasoning as `TransitionPickerMenu`'s own `popupPosition` — this
 *  button lives in the same bottom toolbar. */
function popupPosition(anchor: DOMRect): { bottom: number; left: number } {
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8));
  return { bottom: window.innerHeight - anchor.top + 8, left };
}

/** The "Add Background" toolbar button's popover — a row of curated swatches plus a native `<input
 *  type="color">` for anything else, same portal/outside-click/Escape shape as `TransitionPickerMenu`.
 *  Picking a swatch calls `onPick` and closes immediately (a swatch tap is a complete choice).
 *
 *  The native picker's own `onChange` fires CONTINUOUSLY while dragging its hue/saturation area —
 *  every intermediate value, not just the final release. `onPick` here is `addColorAtPlayhead`
 *  (`VCutApp.tsx`), which creates a brand-new asset AND a brand-new timeline clip on every single
 *  call — it has no notion of "just previewing," unlike a NumberField's `onPreview`/`onCommit` split
 *  elsewhere in this app. Calling it from `onChange` (a real, confirmed bug: dragging across the color
 *  area created a new clip per pixel of drag, littering the timeline with dozens of them) is why
 *  `onChange` below ONLY updates local `custom` state now — purely for the swatch preview next to it —
 *  and the actual commit happens exactly once, from `onBlur`, using whatever color the picker was left
 *  on when the drag/interaction ended. */
export function ColorPickerMenu({
  anchorRef,
  onPick,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  onPick: (color: string) => void;
  onClose: () => void;
}) {
  const t = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const anchor = anchorRef.current?.getBoundingClientRect();
  const [custom, setCustom] = useState("#7f7f7f");

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

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("Background color")}
      style={{ position: "fixed", bottom, left, width: MENU_WIDTH }}
      className="z-50 rounded-lg border border-white/10 bg-[#181b22] p-2 shadow-2xl"
    >
      <div className="grid grid-cols-4 gap-1.5">
        {BACKGROUND_COLOR_SWATCHES.map((color) => (
          <button
            key={color}
            role="menuitem"
            aria-label={color}
            onClick={() => {
              onPick(color);
              onClose();
            }}
            style={{ backgroundColor: color }}
            className="aspect-square rounded border border-white/20 shadow transition hover:scale-105"
          />
        ))}
      </div>
      <label className="mt-2 flex items-center gap-2 rounded px-1 py-1 text-[11px] text-white/60 hover:bg-white/5">
        <input
          type="color"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onBlur={(e) => {
            onPick(e.target.value);
            onClose();
          }}
          className="h-6 w-8 shrink-0 cursor-pointer border-0 bg-transparent p-0"
        />
        {t("Custom")}
      </label>
    </div>,
    document.body
  );
}
