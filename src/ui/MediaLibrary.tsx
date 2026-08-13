"use client";

import React, { useMemo, useRef, useState } from "react";
import { thumbnailUrl } from "../api/client.ts";
import type { Asset } from "../project/types.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { formatDuration } from "../timeline/time.ts";

type SortKey = "name" | "duration" | "imported";

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
  const dimensions = asset.width && asset.height ? `${asset.width}×${asset.height}` : "";
  if (asset.kind === "image") return dimensions || "Image";
  const fps = asset.fps ? `${Math.round(asset.fps)} fps` : "";
  return [dimensions, fps].filter(Boolean).join(" · ") || "Video";
}

function AssetThumbnail({ asset, projectId }: { asset: Asset; projectId: string }) {
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

  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("imported");
  const [dragOver, setDragOver] = useState(false);

  const assets = useMemo(() => {
    const list = (project?.assets ?? []).filter((a) => a.name.toLowerCase().includes(query.trim().toLowerCase()));
    return list.sort((a, b) => {
      if (sortKey === "name") return a.name.localeCompare(b.name);
      if (sortKey === "duration") return b.duration - a.duration;
      return b.importedAt - a.importedAt;
    });
  }, [project?.assets, query, sortKey]);

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
        <button
          onClick={() => inputRef.current?.click()}
          disabled={importing}
          className="rounded-md bg-white/10 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-white/20 disabled:cursor-default disabled:opacity-50"
        >
          {importing ? "Importing…" : "Import"}
        </button>
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
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="rounded-md bg-white/5 px-1.5 py-1 text-xs text-white/70 focus:outline-none"
          aria-label="Sort media"
        >
          <option value="imported">Recent</option>
          <option value="name">Name</option>
          <option value="duration">Length</option>
        </select>
      </div>

      <div className={`min-h-0 flex-1 overflow-y-auto p-2 ${dragOver ? "bg-sky-500/10 outline outline-2 -outline-offset-2 outline-dashed outline-sky-400/60" : ""}`}>
        {assets.length === 0 ? (
          <p className="px-2 py-8 text-center text-xs leading-relaxed text-white/40">
            {project?.assets.length ? "Nothing matches that search." : "Drop video, audio, or images here — or use Import."}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {assets.map((asset) => (
              <li key={asset.id}>
                <div
                  role="button"
                  tabIndex={0}
                  draggable
                  onDragStart={(e) => {
                    // The timeline reads this to know what's being dropped and where.
                    e.dataTransfer.setData("application/x-vstudio-asset", asset.id);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  onDoubleClick={() => addAssetAtPlayhead(asset.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addAssetAtPlayhead(asset.id);
                  }}
                  title={`${asset.name}\n${formatSize(asset.sizeBytes)}\nDouble-click to add at the playhead`}
                  className="group flex w-full cursor-grab items-center gap-2.5 rounded-lg p-1.5 text-left transition hover:bg-white/10 focus:bg-white/10 focus:outline-none active:cursor-grabbing"
                >
                  <div className="relative h-11 w-16 shrink-0 overflow-hidden rounded bg-black">
                    <AssetThumbnail asset={asset} projectId={projectId} />
                    {asset.kind !== "image" && (
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
                    className="shrink-0 rounded px-1.5 py-1 text-xs text-white/30 opacity-100 transition hover:bg-white/10 hover:text-white/80 lg:opacity-0 lg:focus:opacity-100 lg:group-hover:opacity-100"
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
