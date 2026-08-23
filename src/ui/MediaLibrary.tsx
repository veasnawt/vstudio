"use client";

import React, { useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Close, Image as ImageIcon, Music, Text as TextIcon, Video } from "@veasnawt/vicons";
import { thumbnailUrl } from "../api/client.ts";
import { AddClipCommand } from "../commands/index.ts";
import { translateText } from "../i18n/translations.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { fontById } from "../project/fonts.ts";
import type { Asset } from "../project/types.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { formatDuration } from "../timeline/time.ts";
import { Dropdown } from "./Dropdown.tsx";
import { ImportSourceMenu } from "./ImportSourceMenu.tsx";
import { addDragListeners, clientPoint, preventDefaultIfMouse } from "./pointerEvents.ts";

/** True once, at module load — which platform this bundle is running on never changes mid-session, so
 *  there's no need to re-check it on every render the way `Capacitor.isNativePlatform()` calls
 *  elsewhere (`client.ts`, `ExportDialog.tsx`) already don't bother to either. */
const IS_NATIVE = Capacitor.isNativePlatform();

/** Converts one photo/video the OS picker handed back (a `webPath` blob-like URL, per
 *  `@capacitor/camera`'s own docs) into a plain `File` — the same shape `importFiles`/
 *  `nativeImportMedia` already accept from the "Files" path, so the whole rest of the import pipeline
 *  (format sniffing, probing, thumbnailing) needs no native-picker-specific branch at all. */
async function photoResultToFile(webPath: string, format: string | undefined, fallbackName: string): Promise<File> {
  const response = await fetch(webPath);
  const blob = await response.blob();
  const ext = format ? `.${format}` : "";
  const name = fallbackName.includes(".") ? fallbackName : `${fallbackName}${ext}`;
  return new File([blob], name, { type: blob.type });
}

/** Small kind badge shown on every tile in the mobile grid (see the grid's own comment) — the desktop
 *  list already has room for a text label (`describe()` below) to say "Audio"/"Image"/etc., but a
 *  compact grid tile doesn't, so a color-coded icon carries that same "what kind of thing is this" cue
 *  at a glance. Same color convention `TrackHeader.tsx` already uses for track kinds, extended with
 *  violet for images (which have no TRACK kind of their own — they live on video tracks — but very much
 *  need their own distinct color here, where video/image are two different asset kinds side by side). */
const KIND_BADGE: Record<Asset["kind"], { Icon: typeof Video; className: string }> = {
  video: { Icon: Video, className: "text-sky-300" },
  audio: { Icon: Music, className: "text-emerald-300" },
  image: { Icon: ImageIcon, className: "text-violet-300" },
  text: { Icon: TextIcon, className: "text-amber-300" },
};

type SortKey = "name" | "duration" | "imported";

/** Matches `studios/vstudio/app/api/vstudio/_lib/mediaFormats.ts`'s own list exactly — that file is
 *  the real authority (it's what actually decides whether an uploaded file gets accepted), this is
 *  just what the OS file picker is told to show. Extensions, not MIME-wildcard patterns
 *  (`accept="audio/*"` etc.) — a wildcard's OS-level filter is built from the browser's own
 *  extension-to-MIME-type table, which is inconsistent across OS/browser combos for AUDIO
 *  specifically (`.m4a`/`.aac` in particular can end up silently excluded from "Custom Files" in the
 *  picker, even though the server would happily accept them if selected via "All Files"). Literal
 *  extensions are matched against the filename directly, with no MIME-database guessing involved. */
const ACCEPTED_EXTENSIONS =
  ".mp4,.mov,.webm,.mkv,.avi,.m4v,.wav,.mp3,.aac,.flac,.m4a,.ogg,.png,.jpg,.jpeg,.webp,.gif";

/** Pixels (mouse) the pointer must travel before a press becomes a drag — matches `TimelineClip`'s
 *  own threshold, so a shaky press doesn't register as an accidental drag. */
const DRAG_THRESHOLD = 4;
/** How long a touch has to stay still before it "picks up" an asset for dragging. Below this, a
 *  touch-drag is just scrolling the list — there's no Ctrl/Cmd-drag distinction touch can make the
 *  way a mouse can, so a deliberate hold is what signals "I mean to drag this," the same convention
 *  iOS's own Files/Photos apps use. Mouse skips this entirely (armed immediately, matching the native
 *  drag-and-drop this replaces) since a mouse-drag was never ambiguous with scrolling to begin with. */
const LONG_PRESS_MS = 450;

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The one-line technical summary under each asset — resolution and frame rate for video, a plain
 *  label otherwise. Frame rates are rounded for display because sources routinely report 29.97 as
 *  30000/1001, and "29.97 fps" in a library row is noise rather than information. */
function describe(asset: Asset): string {
  const language = useEditorStore.getState().language;
  if (asset.kind === "audio") return translateText(language, "Audio");
  if (asset.kind === "text") return translateText(language, "Text");
  const dimensions = asset.width && asset.height ? `${asset.width}×${asset.height}` : "";
  if (asset.kind === "image") return dimensions || translateText(language, "Image");
  const fps = asset.fps ? translateText(language, "{fps} fps", { fps: Math.round(asset.fps) }) : "";
  return [dimensions, fps].filter(Boolean).join(" · ") || translateText(language, "Video");
}

function AssetThumbnail({ asset, projectId }: { asset: Asset; projectId: string }) {
  const t = useTranslation();
  // A text asset has no file to generate a thumbnail from — its own content, in its own color, is a
  // more useful preview than a generic placeholder icon would be.
  if (asset.kind === "text") {
    return (
      <div
        className="flex h-full w-full items-center justify-center overflow-hidden bg-[#1a1a2e] p-1 text-center text-[10px] font-semibold leading-tight"
        style={{ color: asset.textStyle?.color ?? "#ffffff", fontFamily: `"${fontById(asset.textStyle?.fontFamily ?? "").cssFamily}"` }}
      >
        <span className="line-clamp-2 break-words">{asset.textContent || t("Text")}</span>
      </div>
    );
  }

  const url = thumbnailUrl(projectId, asset);
  if (!url) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-white/5 text-[10px] uppercase tracking-wide text-white/40">
        {t(asset.kind)}
      </div>
    );
  }
  return <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />;
}

export function MediaLibrary({ onAssetAdded }: { onAssetAdded?: () => void } = {}) {
  const t = useTranslation();
  const projectId = useEditorStore((s) => s.projectId);
  const project = useEditorStore((s) => s.project);
  const importing = useEditorStore((s) => s.importing);
  const importFiles = useEditorStore((s) => s.importFiles);
  const removeAsset = useEditorStore((s) => s.removeAsset);
  const addAssetAtPlayhead = useEditorStore((s) => s.addAssetAtPlayhead);
  const run = useEditorStore((s) => s.run);
  const setAssetDrag = useEditorStore((s) => s.setAssetDrag);

  const inputRef = useRef<HTMLInputElement>(null);
  const importButtonRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("imported");
  const [dragOver, setDragOver] = useState(false);
  const [showImportMenu, setShowImportMenu] = useState(false);

  /** "Photos" side of the native Import menu — the OS's own photo/video library, via
   *  `@capacitor/camera`'s multi-picker. Historically an IMAGE-first API (its `pickImages` name is
   *  literal); videos come back best-effort where the OS picker itself allows mixed selection, so
   *  "Files" remains the fully-reliable path for video on any device where this falls short. Loaded
   *  dynamically so web/desktop bundles never pull in a Capacitor plugin they'll never call. */
  async function pickFromPhotos() {
    try {
      const { Camera } = await import("@capacitor/camera");
      const result = await Camera.pickImages({ quality: 90 });
      if (result.photos.length === 0) return;
      const files = await Promise.all(
        result.photos.map((photo, i) => photoResultToFile(photo.webPath!, photo.format, `photo-${Date.now()}-${i}`))
      );
      void importFiles(files);
    } catch (err) {
      // A cancelled picker rejects too (no distinct "user cancelled" result) — only surface it as an
      // error if it doesn't look like a plain dismissal.
      const message = err instanceof Error ? err.message : String(err);
      if (/cancel/i.test(message)) return;
      useEditorStore.getState().setStatus(message, "error");
    }
  }
  /** Local mirror of the in-progress drag, purely for this component's own floating label — the
   *  store's `assetDrag` (same values) is what `Timeline` reads to hit-test/highlight; this one just
   *  saves every OTHER subscriber of `assetDrag` from re-rendering on each pointer move. */
  const [dragGhost, setDragGhost] = useState<{ name: string; x: number; y: number } | null>(null);

  const assets = useMemo(() => {
    const list = (project?.assets ?? [])
      .filter((a) => !a.hiddenFromLibrary)
      // Text assets never belong here, unconditionally — unlike every other kind, one was never
      // IMPORTED media to begin with (`relPath` is always `""`, there's no file to preview/re-add),
      // it's authored directly on the timeline (`addTextAtPlayhead`, Auto Captions, a duplicated text
      // clip) and stays a purely timeline-scoped thing from then on. A structural exclusion by `kind`,
      // not another `hiddenFromLibrary: true` at each creation site (`createTextAsset` et al.) —
      // that flag is for content that's INCIDENTALLY not library-worthy (a quick voiceover take);
      // "this is text" is a permanent fact about the asset itself, so it can't quietly regress if some
      // future text-creating path forgets to set the flag.
      .filter((a) => a.kind !== "text")
      .filter((a) => a.name.toLowerCase().includes(query.trim().toLowerCase()));
    return list.sort((a, b) => {
      if (sortKey === "name") return a.name.localeCompare(b.name);
      if (sortKey === "duration") return b.duration - a.duration;
      return b.importedAt - a.importedAt;
    });
  }, [project?.assets, query, sortKey]);

  /** Replaces native HTML5 drag-and-drop for BOTH mouse and touch — not touch-only — because the two
   *  can't coexist on the same element: `draggable`+`dragstart` and a parallel `onMouseDown`-driven
   *  drag would both react to the same mouse gesture, racing each other. Mouse arms immediately
   *  (matching how native drag-and-drop felt); touch requires a `LONG_PRESS_MS` hold first, so a
   *  normal touch-scroll of the list (the far more common gesture) is never mistaken for "pick this
   *  up" — see `LONG_PRESS_MS`'s own comment. Mirrors `TimelineClip.beginDrag`'s own
   *  press-then-`addDragListeners` shape, just tracking an asset id instead of a clip transform. */
  function beginAssetDrag(event: React.MouseEvent | React.TouchEvent, asset: Asset) {
    const isTouch = "touches" in event;
    const start = clientPoint(event);
    let moved = false;
    let armed = !isTouch;
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;

    function arm(point: { x: number; y: number }) {
      armed = true;
      setDragGhost({ name: asset.name, x: point.x, y: point.y });
      setAssetDrag({ assetId: asset.id, clientX: point.x, clientY: point.y });
    }

    if (isTouch) {
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        arm(start);
      }, LONG_PRESS_MS);
    } else {
      preventDefaultIfMouse(event);
    }

    function onMove(moveEvent: MouseEvent | TouchEvent) {
      const point = clientPoint(moveEvent);
      if (!armed) {
        // Real movement before the long-press fires means this is a normal list scroll, not a pickup
        // attempt — bail out entirely and let the browser's own native touch-scroll handle it (this
        // row is deliberately NOT `touch-none`, unlike an armed drag's target elsewhere).
        if (longPressTimer && Math.hypot(point.x - start.x, point.y - start.y) > DRAG_THRESHOLD) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
          removeListeners();
        }
        return;
      }
      // Once armed, this IS the drag — stop the page from also scrolling underneath it (touch only;
      // `addDragListeners`' touchmove listener is `{ passive: false }`, so this is allowed here even
      // though it wouldn't be from a plain JSX onTouchMove prop).
      if ("touches" in moveEvent) moveEvent.preventDefault();
      moved = true;
      setDragGhost({ name: asset.name, x: point.x, y: point.y });
      setAssetDrag({ assetId: asset.id, clientX: point.x, clientY: point.y });
    }

    function onUp(upEvent: MouseEvent | TouchEvent) {
      removeListeners();
      if (longPressTimer) clearTimeout(longPressTimer);
      setDragGhost(null);
      setAssetDrag(null);
      if (!armed || !moved) return;
      const point = clientPoint(upEvent);
      const target = useEditorStore.getState().resolveTimelineDropTarget?.(point.x, point.y);
      if (target) run(new AddClipCommand(target.trackId, asset.id, target.time));
    }

    const removeListeners = addDragListeners(onMove, onUp);
  }

  if (!projectId) return null;

  return (
    <section
      className="flex h-full min-h-0 flex-col border-r border-white/10 bg-[#0d0f14]"
      onDragOver={(e) => {
        // Only claim the drag if it actually carries files — otherwise dragging a clip around the
        // timeline would light up the library as a drop target.
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragOver(false);
        void importFiles([...e.dataTransfer.files]);
      }}
    >
      <header className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-white/60">{t("Media")}</h2>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            ref={importButtonRef}
            // Native platforms get a choice (Photos vs Files) since there's a real device photo/video
            // library to offer alongside the file browser; web/desktop only ever had "Files" to begin
            // with, so the button there keeps going straight to the file input, unchanged.
            onClick={() => (IS_NATIVE ? setShowImportMenu((v) => !v) : inputRef.current?.click())}
            disabled={importing}
            className="rounded-md bg-white/10 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-white/20 disabled:cursor-default disabled:opacity-50"
          >
            {importing ? t("Importing…") : t("Import")}
          </button>
          {showImportMenu && (
            <ImportSourceMenu
              anchorRef={importButtonRef}
              onClose={() => setShowImportMenu(false)}
              onPickPhotos={() => void pickFromPhotos()}
              onPickFiles={() => inputRef.current?.click()}
            />
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED_EXTENSIONS}
          className="hidden"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            // Cleared so re-picking the same file still fires a change event.
            e.target.value = "";
            void importFiles(files);
          }}
        />
      </header>

      <div className="flex gap-2 border-b border-white/10 px-3 py-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("Search")}
          // 16px below `lg`, not the desktop 12px (`text-xs`) — iOS Safari auto-zooms the whole page
          // on focusing any text input under 16px, which on a phone means tapping Search yanks the
          // viewport in every time. text-xs only kicks in at `lg`, where that browser behavior doesn't
          // apply anyway.
          className="min-w-0 flex-1 rounded-md bg-white/5 px-2 py-1 text-[16px] text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-sky-400/60 lg:text-xs"
        />
        <Dropdown
          value={sortKey}
          onChange={(v) => setSortKey(v)}
          ariaLabel={t("Sort media")}
          className="w-24 shrink-0 text-xs"
          options={[
            { value: "imported", label: t("Recent") },
            { value: "name", label: t("Name") },
            { value: "duration", label: t("Length") },
          ]}
        />
      </div>

      <div className={`scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2 ${dragOver ? "bg-sky-500/10 outline outline-2 -outline-offset-2 outline-dashed outline-sky-400/60" : ""}`}>
        {assets.length === 0 ? (
          <p className="px-2 py-8 text-center text-xs leading-relaxed text-white/40">
            {/* Checked against VISIBLE assets (query aside), not `project.assets.length` directly —
                otherwise a project holding only hidden voiceover takes or text clips (see the `assets`
                memo's own filter above) would misreport "Nothing matches that search" with no search
                query even active. */}
            {project?.assets.some((a) => !a.hiddenFromLibrary && a.kind !== "text")
              ? t("Nothing matches that search.")
              : t("Drop video, audio, or images here — or use Import.")}
          </p>
        ) : (
          // Grid on mobile (2 columns, bigger tiles), the existing single-column list back at `lg`+ —
          // a compact 44×64px thumbnail in a narrow row was hard to tell apart at a glance and left a
          // lot of the touch target as bare text; a proper grid gives thumbnails room to actually be
          // useful for recognizing a clip on a phone, matching how every mobile photo/video picker
          // presents a media library. Desktop's list stays exactly as it was — that column is narrow
          // enough that a 2-up grid there would make the thumbnails smaller, not bigger.
          <ul className="grid grid-cols-2 gap-2 lg:flex lg:flex-col lg:gap-1">
            {assets.map((asset) => (
              <li key={asset.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onMouseDown={(e) => beginAssetDrag(e, asset)}
                  onTouchStart={(e) => beginAssetDrag(e, asset)}
                  onDoubleClick={() => addAssetAtPlayhead(asset.id)}
                  // Only wired when `onAssetAdded` is passed — i.e. only in the mobile bottom-sheet
                  // usage (see VStudioApp.tsx), where a plain tap is the ONLY practical way to place a
                  // clip (the sheet replaces the Timeline entirely while open, so there's nothing to
                  // drag onto, and touch has no double-tap equivalent to `onDoubleClick` above). Left
                  // unwired for the desktop persistent column, where a bare click choosing to do
                  // nothing (only double-click/drag add) is the established, unchanged behavior.
                  onClick={
                    onAssetAdded
                      ? () => {
                          addAssetAtPlayhead(asset.id);
                          onAssetAdded();
                        }
                      : undefined
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addAssetAtPlayhead(asset.id);
                  }}
                  title={`${asset.name}\n${formatSize(asset.sizeBytes)}\n${t("Double-click to add at the playhead, or drag onto the timeline (press and hold, then drag, on touch)")}`}
                  className="group flex w-full cursor-grab flex-col gap-1.5 rounded-lg p-1.5 text-left transition hover:bg-white/10 focus:bg-white/10 focus:outline-none active:cursor-grabbing lg:flex-row lg:items-center lg:gap-2.5"
                >
                  <div className="relative aspect-video w-full shrink-0 overflow-hidden rounded bg-black lg:h-11 lg:w-16">
                    <AssetThumbnail asset={asset} projectId={projectId} />
                    {/* Kind badge — mobile-grid only. Desktop's thumbnail is too small (44×64) for this
                        to read cleanly there, and its row already spells the kind out via `describe()`
                        next to the name; the grid has no equivalent text label at a glance, so the icon
                        carries that job instead. */}
                    <span className="absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded bg-black/70 lg:hidden">
                      {(() => {
                        const { Icon, className } = KIND_BADGE[asset.kind];
                        return <Icon size={12} className={className} />;
                      })()}
                    </span>
                    {asset.kind !== "image" && asset.kind !== "text" && (
                      <span className="absolute bottom-0 right-0 bg-black/75 px-1 text-[10px] tabular-nums text-white/90">
                        {formatDuration(asset.duration)}
                      </span>
                    )}
                    {/* Mobile-grid remove button — overlaid on the thumbnail (top-right) since a grid
                        tile has no separate inline slot for it the way the desktop row does. Always
                        visible (not hover-revealed) for the same reason the desktop button already
                        makes an exception below `lg`: touch has no `:hover` to reveal it from. */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeAsset(asset);
                      }}
                      title={t("Remove from project")}
                      aria-label={t("Remove {name} from project", { name: asset.name })}
                      className="absolute right-1 top-1 flex items-center rounded bg-black/70 p-1 text-white/70 transition hover:bg-black/90 hover:text-white lg:hidden"
                    >
                      <Close size={12} />
                    </button>
                  </div>
                  <div className="min-w-0 w-full lg:flex-1">
                    <p className="truncate text-xs font-medium text-white/90">{asset.name}</p>
                    <p className="truncate text-[11px] text-white/45">{describe(asset)}</p>
                    {asset.offline && <p className="text-[11px] font-medium text-amber-400">{t("Media Offline")}</p>}
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeAsset(asset);
                    }}
                    title={t("Remove from project")}
                    aria-label={t("Remove {name} from project", { name: asset.name })}
                    // Desktop-row-only (see the mobile-grid overlay button above) — hover-reveal only
                    // makes sense where a mouse actually exists.
                    className="hidden shrink-0 items-center rounded px-1.5 py-1 text-white/30 transition hover:bg-white/10 hover:text-white/80 lg:flex lg:opacity-0 lg:focus:opacity-100 lg:group-hover:opacity-100"
                  >
                    <Close size={12} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Follows the pointer during an in-progress asset drag — the visual feedback native drag-and-
          drop gave mouse users for free (its own OS-drawn drag image), which a pointer-based drag has
          to draw itself. `position: fixed` so it's never clipped by this panel's own `overflow-y-auto`
          and can visually cross into the Timeline while dragging. */}
      {dragGhost && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 rounded-md border border-sky-300/50 bg-sky-500/90 px-2.5 py-1 text-xs font-medium text-white shadow-lg"
          style={{ left: dragGhost.x, top: dragGhost.y }}
        >
          {dragGhost.name}
        </div>
      )}
    </section>
  );
}
