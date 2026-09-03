/** Curated quick-pick hex values shared by every color picker in the app that isn't already backed by
 *  a specific existing convention (chroma key, text color, etc. each stay plain `<input type="color">`
 *  only, matching `Inspector.tsx`'s existing pattern — see that file's own color fields). A color-matte
 *  background clip is the first place a user picks a color with nothing already on screen to sample
 *  from, so a small swatch row (plus the same native picker for anything else) is worth the one shared
 *  constant. Not exhaustive — a deliberately small, broadly useful set (true black/white, primary
 *  broadcast-safe-ish colors, a couple of neutral grays) rather than a full palette. */
export const BACKGROUND_COLOR_SWATCHES: string[] = [
  "#000000",
  "#ffffff",
  "#7f7f7f",
  "#e53935",
  "#fb8c00",
  "#fdd835",
  "#43a047",
  "#00acc1",
  "#1e88e5",
  "#3949ab",
  "#8e24aa",
  "#d81b60",
];
