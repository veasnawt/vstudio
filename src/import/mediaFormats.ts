import type { AssetKind } from "../project/types.ts";

/** Formats the importer accepts. Anything else is rejected up front with a clear message rather than
 *  handed to FFmpeg (server import) or the browser's own media decoder (native import) to fail on in
 *  a less obvious way. Shared by both import paths so "what VStudio can import" is defined once. */
const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"]);
const AUDIO_EXTS = new Set([".wav", ".mp3", ".aac", ".flac", ".m4a", ".ogg"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export const SUPPORTED_EXTENSIONS = [...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS];

export function kindForExtension(ext: string): AssetKind | null {
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (IMAGE_EXTS.has(ext)) return "image";
  return null;
}
