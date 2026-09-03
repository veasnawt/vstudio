"use client";

import { buildCanvasFilterString } from "../playback/PlaybackEngine.ts";
import { EFFECT_PRESETS } from "../project/effectPresets.ts";
import type { ClipEffects } from "../project/types.ts";
import { IDENTITY_EFFECTS } from "../project/types.ts";
import { useTranslation } from "../i18n/useTranslation.ts";

/** The preset-swatch grid shared by the Inspector's own Effects section and the toolbar's Effects
 *  button popover (`EffectsPickerMenu.tsx`) — one place this UI is written so the two stay identical
 *  rather than drifting into two almost-the-same grids.
 *
 *  Each swatch previews its preset directly on top of the SELECTED CLIP's own thumbnail (via CSS
 *  `filter`, the exact same `buildCanvasFilterString` the real preview canvas uses) instead of a
 *  generic gradient — "what does Vivid look like" is a much more useful question answered against this
 *  footage than against an abstract color wheel. Falls back to the neutral gradient only when there's
 *  genuinely no thumbnail to show (a color-matte clip, or a video whose thumbnail hasn't generated
 *  yet) — a blank/broken-image swatch would read as an error, not as "no preview available". */
export function EffectPresetGrid({
  thumbnailUrl,
  onPick,
  onPreview,
  onClearPreview,
  swatchHeight = 28,
}: {
  thumbnailUrl: string | null;
  onPick: (values: Partial<ClipEffects>) => void;
  onPreview: (values: Partial<ClipEffects>) => void;
  onClearPreview: () => void;
  /** Inspector's own narrow sidebar and the toolbar's wider popover both use this grid at different
   *  natural widths — a taller swatch reads as a genuinely useful thumbnail-preview in the popover,
   *  while the Inspector's default stays exactly what it already was (no visual change there). */
  swatchHeight?: number;
}) {
  const t = useTranslation();
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {EFFECT_PRESETS.map((preset) => (
        <button
          key={preset.id}
          onClick={() => onPick(preset.values)}
          onMouseEnter={() => onPreview(preset.values)}
          onMouseLeave={onClearPreview}
          className="flex flex-col items-center gap-1 rounded p-1 transition hover:bg-white/10"
        >
          <span
            aria-hidden
            style={{
              height: swatchHeight,
              background: thumbnailUrl ? `center / cover no-repeat url(${thumbnailUrl})` : "linear-gradient(135deg, #f59e0b, #6366f1, #10b981)",
              filter: buildCanvasFilterString({ ...IDENTITY_EFFECTS, ...preset.values }),
            }}
            className="w-full rounded border border-white/10"
          />
          <span className="text-[10px] text-white/60">{t(preset.label)}</span>
        </button>
      ))}
    </div>
  );
}
