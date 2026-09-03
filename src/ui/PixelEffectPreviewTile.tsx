"use client";

import type { PixelEffectType } from "../project/types.ts";

/** A distinct accent color per type — the same real clip thumbnail sits behind every tile (there's
 *  only one clip, one thumbnail), so a plain color dot is what actually tells them apart at a glance,
 *  same "small colored accent" convention `CollapsibleSection`'s own `accent` prop and `KIND_BADGE`
 *  (`MediaLibrary.tsx`) already use elsewhere in this app. */
const ACCENT_CLASS: Record<PixelEffectType, string> = {
  glitch: "bg-rose-400",
  waterRipple: "bg-sky-400",
};

/** One tile in a `PixelEffectType` picker — shared by the toolbar's `PixelEffectPickerMenu` and
 *  Inspector's own Pixel Effects section, so the two stay visually identical. Deliberately a STATIC
 *  thumbnail, not a live per-tile animation the way `TextAnimationPreviewTile` is for text — glitch/
 *  water-ripple are real pixel-displacement passes (see `timeline/pixelEffects.ts`), not cheap enough
 *  to run continuously on N small preview tiles at once the way five sine-based text transforms are. */
export function PixelEffectPreviewTile({ type, thumbnailUrl }: { type: PixelEffectType; thumbnailUrl: string | null }) {
  return (
    <span
      aria-hidden
      className="relative block h-11 w-full overflow-hidden rounded border border-white/10 bg-cover bg-center"
      style={{ background: thumbnailUrl ? `center / cover no-repeat url(${thumbnailUrl})` : "#1a1d24" }}
    >
      <span aria-hidden className={`absolute right-1 top-1 h-1.5 w-1.5 rounded-full ${ACCENT_CLASS[type]}`} />
    </span>
  );
}
