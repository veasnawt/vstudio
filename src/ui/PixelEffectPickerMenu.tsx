"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { thumbnailUrl } from "../api/client.ts";
import { SetClipPixelEffectCommand } from "../commands/index.ts";
import type { Asset, Clip } from "../project/types.ts";
import { PIXEL_EFFECT_TYPE_LABEL, PIXEL_EFFECT_TYPE_OPTIONS } from "../timeline/pixelEffects.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { PixelEffectPreviewTile } from "./PixelEffectPreviewTile.tsx";

const MENU_WIDTH = 220;

/** Same "opens above its anchor" reasoning as `EffectsPickerMenu`/`ColorPickerMenu` — this button
 *  lives in the same bottom toolbar. */
function popupPosition(anchor: DOMRect): { bottom: number; left: number } {
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8));
  return { bottom: window.innerHeight - anchor.top + 8, left };
}

/** The toolbar Pixel Effects button's popover — a plain 2-tile grid (only `glitch`/`waterRipple`
 *  exist, see `PixelEffectType`'s own doc comment for why a third, "broken glass", was deferred), plus
 *  a "None" tile when the clip already has one set. Deliberately NOT built on `EffectPresetGrid.tsx`
 *  (`EffectsPickerMenu`'s own preset grid) — that grid previews each preset via a CSS `filter()`
 *  string over the clip's thumbnail, which glitch/water-ripple (real pixel displacement, not a CSS
 *  filter) can't express; each tile here just shows the plain thumbnail with a colored accent dot
 *  instead of a live per-tile preview. No hover-preview either (unlike `EffectsPickerMenu`'s
 *  preset grid) — a click is a complete, immediate choice, same as `ColorPickerMenu`'s swatches. */
export function PixelEffectPickerMenu({
  anchorRef,
  clip,
  asset,
  projectId,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  clip: Clip;
  /** The clip's own source asset, for its thumbnail — `undefined` for a color-matte clip, which has
   *  none; each tile falls back to a plain dark tile in that case. */
  asset: Asset | undefined;
  projectId: string | null;
  onClose: () => void;
}) {
  const t = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const anchor = anchorRef.current?.getBoundingClientRect();
  const run = useEditorStore((s) => s.run);

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

  const thumb = projectId && asset ? thumbnailUrl(projectId, asset) : null;

  function pick(type: (typeof PIXEL_EFFECT_TYPE_OPTIONS)[number] | null) {
    run(new SetClipPixelEffectCommand(clip.id, type ? { type } : null));
    onClose();
  }

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("Pixel Effects")}
      style={{ position: "fixed", bottom, left, width: MENU_WIDTH }}
      className="z-50 rounded-lg border border-white/10 bg-[#181b22] p-2.5 shadow-2xl"
    >
      <div className="grid grid-cols-2 gap-1.5">
        {PIXEL_EFFECT_TYPE_OPTIONS.map((type) => (
          <button
            key={type}
            onClick={() => pick(type)}
            className={`flex flex-col items-center gap-1 rounded p-1 transition hover:bg-white/10 ${
              clip.pixelEffect?.type === type ? "bg-white/10" : ""
            }`}
          >
            <PixelEffectPreviewTile type={type} thumbnailUrl={thumb} />
            <span className="text-[10px] text-white/60">{t(PIXEL_EFFECT_TYPE_LABEL[type])}</span>
          </button>
        ))}
      </div>
      {clip.pixelEffect && (
        <button
          onClick={() => pick(null)}
          className="mt-2.5 w-full rounded bg-white/5 py-1.5 text-[12px] text-white/60 transition hover:bg-white/10 hover:text-white"
        >
          {t("None")}
        </button>
      )}
    </div>,
    document.body
  );
}
