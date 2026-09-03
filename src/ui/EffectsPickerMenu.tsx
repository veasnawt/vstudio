"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { thumbnailUrl } from "../api/client.ts";
import { SetClipEffectsCommand } from "../commands/index.ts";
import type { Asset, Clip, ClipEffects } from "../project/types.ts";
import { IDENTITY_EFFECTS } from "../project/types.ts";
import { buildClipEffectsCommand, previewClipEffectsOverride } from "../timeline/effectsEdit.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { EffectPresetGrid } from "./EffectPresetGrid.tsx";

const MENU_WIDTH = 280;

/** Same "opens above its anchor" reasoning as `TransitionPickerMenu`/`ColorPickerMenu` — this button
 *  lives in the same bottom toolbar. */
function popupPosition(anchor: DOMRect): { bottom: number; left: number } {
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8));
  return { bottom: window.innerHeight - anchor.top + 8, left };
}

/** The toolbar Effects button's popover — the same quick-pick scope `ColorPickerMenu`'s swatch grid
 *  has (a fast, self-contained choice, not a full editor): the preset grid plus a Reset, deliberately
 *  WITHOUT the five Brightness/Contrast/Saturation/Blur/Opacity sliders Inspector's own Effects
 *  section has for fine-tuning afterward — those stay Inspector-only by design, so this popover
 *  doesn't grow into a second, redundant copy of that panel.
 *
 *  Shares its actual editing logic with Inspector's Effects section via `timeline/effectsEdit.ts`
 *  (`buildClipEffectsCommand`/`previewClipEffectsOverride`) and its preset-swatch grid via
 *  `EffectPresetGrid.tsx` — the same clip, the same commands, the same thumbnail-backed previews,
 *  edited from either surface with zero behavioral drift between them. */
export function EffectsPickerMenu({
  anchorRef,
  clip,
  asset,
  projectId,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  clip: Clip;
  /** The clip's own source asset, for its thumbnail — `undefined` for a color-matte clip, which has
   *  none; the preset grid falls back to its own neutral gradient in that case. */
  asset: Asset | undefined;
  projectId: string | null;
  onClose: () => void;
}) {
  const t = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const anchor = anchorRef.current?.getBoundingClientRect();
  const run = useEditorStore((s) => s.run);
  const playhead = useEditorStore((s) => s.playhead);
  const fps = useEditorStore((s) => s.project?.sequence.fps ?? 30);
  const setLivePreviewOverrides = useEditorStore((s) => s.setLivePreviewOverrides);

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

  function clearPreview() {
    setLivePreviewOverrides([]);
  }
  function patch(values: Partial<ClipEffects>) {
    run(buildClipEffectsCommand(clip, values, playhead, fps));
    clearPreview();
  }
  function preview(values: Partial<ClipEffects>) {
    setLivePreviewOverrides([previewClipEffectsOverride(clip, values, playhead)]);
  }

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("Effects")}
      style={{ position: "fixed", bottom, left, width: MENU_WIDTH }}
      className="z-50 rounded-lg border border-white/10 bg-[#181b22] p-2.5 shadow-2xl"
    >
      <EffectPresetGrid thumbnailUrl={thumb} onPick={patch} onPreview={preview} onClearPreview={clearPreview} swatchHeight={44} />
      {clip.effects && (
        <button
          onClick={() => run(new SetClipEffectsCommand(clip.id, IDENTITY_EFFECTS))}
          className="mt-2.5 w-full rounded bg-white/5 py-1.5 text-[12px] text-white/60 transition hover:bg-white/10 hover:text-white"
        >
          {t("Reset effects")}
        </button>
      )}
    </div>,
    document.body
  );
}
