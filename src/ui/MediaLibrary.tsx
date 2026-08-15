"use client";

import React, { useMemo, useRef, useState } from "react";
import { Close } from "@veasnawt/vicons";
import { thumbnailUrl } from "../api/client.ts";
import { AddClipCommand } from "../commands/index.ts";
import { fontById } from "../project/fonts.ts";
import type { Asset } from "../project/types.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { formatDuration } from "../timeline/time.ts";
import { Dropdown } from "./Dropdown.tsx";
import { addDragListeners, clientPoint, preventDefaultIfMouse } from "./pointerEvents.ts";

type SortKey = "name" | "duration" | "imported";

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
  if (asset.kind === "audio") return "Audio";
  if (asset.kind === "text") return "Text";
  const dimensions = asset.width && asset.height ? `${asset.width}×${asset.height}` : "";
  if (asset.kind === "image") return dimensions || "Image";
  const fps = asset.fps ? `${Math.round(asset.fps)} fps` : "";
  return [dimensions, fps].filter(Boolean).join(" · ") || "Video";
}

function AssetThumbnail({ asset, projectId }: { asset: Asset; projectId: string }) {
  // A text asset has no file to generate a thumbnail from — its own content, in its own color, is a
  // more useful preview than a generic placeholder icon would be.
  if (asset.kind === "text") {
    return (
      <div
        className="flex h-full w-full items-center justify-center overflow-hidden bg-[#1a1a2e] p-1 text-center text-[10px] font-semibold leading-tight"
        style={{ color: asset.textStyle?.color ?? "#ffffff", fontFamily: `"${fontById(asset.textStyle?.fontFamily ?? "").cssFamily}"` }}
      >
        <span className="line-clamp-2 break-words">{asset.textContent || "Text"}</span>
      </div>
    );
  }

  const url = thumbnailUrl(projectId, asset);
  if (!url) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-white/5 text-[10px] uppercase tracking-wide text-white/40">
        {asset.kind}
      </div>
    );
  }
  return <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />;
}

export function MediaLibrary() {
  const projectId = useEditorStore((s) => s.projectId);
  const project = useEditorStore((s) => s.project);
  const importing = useEditorStore((s) => s.importing);
  const importFiles = useEditorStore((s) => s.importFiles);
  const removeAsset = useEditorStore((s) => s.removeAsset);
  const addAssetAtPlayhead = useEditorStore((s) => s.addAssetAtPlayhead);
  const run = useEditorStore((s) => s.run);
  const setAssetDrag = useEditorStore((s) => s.setAssetDrag);

  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("imported");
  const [dragOver, setDragOver] = useState(false);
  /** Local mirror of the in-progress drag, purely for this component's own floating label — the
   *  store's `assetDrag` (same values) is what `Timeline` reads to hit-test/highlight; this one just
   *  saves every OTHER subscriber of `assetDrag` from re-rendering on each pointer move. */
  const [dragGhost, setDragGhost] = useState<{ name: string; x: number; y: number } | null>(null);

  const assets = useMemo(() => {
    const list = (project?.assets ?? [])
      .filter((a) => !a.hiddenFromLibrary)
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
        <h2 className="text-xs font-semibold uppercase tracking-wider text-white/60">Media</h2>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => inputRef.current?.click()}
            disabled={importing}
            className="rounded-md bg-white/10 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-white/20 disabled:cursor-default disabled:opacity-50"
          >
            {importing ? "Importing…" : "Import"}
          </button>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="video/*,audio/*,image/*"
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
          placeholder="Search"
          // 16px below `lg`, not the desktop 12px (`text-xs`) — iOS Safari auto-zooms the whole page
          // on focusing any text input under 16px, which on a phone means tapping Search yanks the
          // viewport in every time. text-xs only kicks in at `lg`, where that browser behavior doesn't
          // apply anyway.
          className="min-w-0 flex-1 rounded-md bg-white/5 px-2 py-1 text-[16px] text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-sky-400/60 lg:text-xs"
        />
        <Dropdown
          value={sortKey}
          onChange={(v) => setSortKey(v)}
          ariaLabel="Sort media"
          className="w-24 shrink-0 text-xs"
          options={[
            { value: "imported", label: "Recent" },
            { value: "name", label: "Name" },
            { value: "duration", label: "Length" },
          ]}
        />
      </div>

      <div className={`scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2 ${dragOver ? "bg-sky-500/10 outline outline-2 -outline-offset-2 outline-dashed outline-sky-400/60" : ""}`}>
        {assets.length === 0 ? (
          <p className="px-2 py-8 text-center text-xs leading-relaxed text-white/40">
            {/* Checked against VISIBLE assets (query aside), not `project.assets.length` directly —
                otherwise a project holding only hidden voiceover takes (see `hiddenFromLibrary`) would
                misreport "Nothing matches that search" with no search query even active. */}
            {project?.assets.some((a) => !a.hiddenFromLibrary) ? "Nothing matches that search." : "Drop video, audio, or images here — or use Import."}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {assets.map((asset) => (
              <li key={asset.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onMouseDown={(e) => beginAssetDrag(e, asset)}
                  onTouchStart={(e) => beginAssetDrag(e, asset)}
                  onDoubleClick={() => addAssetAtPlayhead(asset.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addAssetAtPlayhead(asset.id);
                  }}
                  title={`${asset.name}\n${formatSize(asset.sizeBytes)}\nDouble-click to add at the playhead, or drag onto the timeline (press and hold, then drag, on touch)`}
                  className="group flex w-full cursor-grab items-center gap-2.5 rounded-lg p-1.5 text-left transition hover:bg-white/10 focus:bg-white/10 focus:outline-none active:cursor-grabbing"
                >
                  <div className="relative h-11 w-16 shrink-0 overflow-hidden rounded bg-black">
                    <AssetThumbnail asset={asset} projectId={projectId} />
                    {asset.kind !== "image" && asset.kind !== "text" && (
                      <span className="absolute bottom-0 right-0 bg-black/75 px-1 text-[10px] tabular-nums text-white/90">
                        {formatDuration(asset.duration)}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-white/90">{asset.name}</p>
                    <p className="truncate text-[11px] text-white/45">{describe(asset)}</p>
                    {asset.offline && <p className="text-[11px] font-medium text-amber-400">Media Offline</p>}
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeAsset(asset);
                    }}
                    title="Remove from project"
                    aria-label={`Remove ${asset.name} from project`}
                    // Hover-reveal only makes sense where a mouse actually exists — below `lg` (where
                    // touch is the primary input) it stays permanently visible, since `:hover` never
                    // fires on a touchscreen and a button that only appears on hover is a button that
                    // literally cannot be reached at all on a phone or tablet.
                    className="flex shrink-0 items-center rounded px-1.5 py-1 text-white/30 opacity-100 transition hover:bg-white/10 hover:text-white/80 lg:opacity-0 lg:focus:opacity-100 lg:group-hover:opacity-100"
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
