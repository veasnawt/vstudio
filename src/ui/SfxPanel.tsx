"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Delete, Pause, Play, Search, Upload } from "@veasnawt/vicons";
import { customSfxUrl, sfxAssetUrl } from "../api/client.ts";
import { AddTrackCommand } from "../commands/index.ts";
import { clipEnd } from "../project/createProject.ts";
import { SFX_REGISTRY, type SfxDefinition } from "../project/sfx.ts";
import type { CustomSfxAsset, Track } from "../project/types.ts";
import { defaultClipDuration } from "../timeline/operations.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";

/** Category display order — a fixed sequence rather than whatever order `Object.groupBy`/first-seen
 *  happens to produce, so the panel's sections read top-to-bottom the same way every time regardless
 *  of what order `SFX_REGISTRY` itself lists entries in. */
const CATEGORY_ORDER: SfxDefinition["category"][] = ["UI", "Whoosh", "Impact", "Riser", "Chime", "Ambience", "Meme"];

/** Browsable bundled sound-effects library — a toolbar-triggered modal, same portal/overlay shape as
 *  `AutoCaptionsDialog`. Lists every `SFX_REGISTRY` entry grouped by category; each row previews via a
 *  single SHARED `<audio>` element (so starting one preview always stops whichever was already
 *  playing, rather than several overlapping) and can be dropped onto the timeline with "Add".
 *
 *  Deliberately its own component rather than a tab bolted onto `MediaLibrary` — an SFX pick isn't an
 *  imported asset browsed by name/date/kind the way `MediaLibrary`'s own list is; it's a fixed,
 *  bundled catalog browsed by category, closer in spirit to the Inspector's font picker than to the
 *  Media panel. */
export function SfxPanel({ onClose }: { onClose: () => void }) {
  const t = useTranslation();
  const projectId = useEditorStore((s) => s.projectId);
  const project = useEditorStore((s) => s.project);
  const activeTrackId = useEditorStore((s) => s.activeTrackId);
  const playhead = useEditorStore((s) => s.playhead);
  const importFiles = useEditorStore((s) => s.importFiles);
  const importSfx = useEditorStore((s) => s.importSfx);
  const removeSfx = useEditorStore((s) => s.removeSfx);
  const importingSfx = useEditorStore((s) => s.importingSfx);
  const addAssetAtPlayhead = useEditorStore((s) => s.addAssetAtPlayhead);
  const run = useEditorStore((s) => s.run);
  const setStatus = useEditorStore((s) => s.setStatus);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  /** Filters BOTH "My Sounds" and the bundled catalog by label, case-insensitively — the catalog grew
   *  past ~160 entries once a bulk meme/reaction-clip import landed (see `sfx.ts`'s own "Meme" category
   *  doc comment), past the point where scrolling six-to-seven category sections is a reasonable way to
   *  find one specific sound; search is the primary way to find one now, browsing by category a
   *  secondary fallback. */
  const [query, setQuery] = useState("");
  /** Which entry's "Add" is currently in flight — not a single panel-wide boolean, so clicking "Add"
   *  on one row doesn't visually disable every OTHER row while its own fetch/import is still running
   *  (each row's own button already guards against a second click on ITSELF via this same state). */
  const [addingId, setAddingId] = useState<string | null>(null);
  /** Which "My Sounds" entry's own Delete is in flight — same per-row (not panel-wide) reasoning as
   *  `addingId`. */
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // The shared preview element's own `ended` event is what clears the "now playing" highlight when a
  // short clip finishes on its own, not just when the user stops it by clicking elsewhere.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    function onEnded() {
      setPlayingId(null);
    }
    audio.addEventListener("ended", onEnded);
    return () => audio.removeEventListener("ended", onEnded);
  }, []);

  // Leaving the panel mid-preview must not leave a clip playing invisibly in the background.
  useEffect(() => () => audioRef.current?.pause(), []);

  /** Generalized over a plain `(id, url)` pair, not `SfxDefinition`, so the same preview mechanism
   *  serves both the bundled catalog (`sfxAssetUrl(def.file)`) and "My Sounds" entries
   *  (`customSfxUrl(projectId, sfx)`) — one shared `<audio>`/`playingId` state either way, matching
   *  this component's own doc comment on why a single shared element beats one per row. */
  function togglePreview(id: string, url: string) {
    const audio = audioRef.current;
    if (!audio) return;
    if (playingId === id) {
      audio.pause();
      setPlayingId(null);
      return;
    }
    audio.src = url;
    void audio.play();
    setPlayingId(id);
  }

  /** Whether `track` has genuinely nothing occupying `[playhead, playhead+duration)` — an SFX pick is
   *  almost always dropped on top of an ALREADY-full background-music/dialogue track (that's the whole
   *  point of a sound effect), so "just place it at the playhead" can't assume the spot is empty the
   *  way `addTextAtPlayhead`'s own fresh text track usually can. Same overlap check
   *  `nonOverlappingStart` (`timeline/queries.ts`) already makes, inlined here rather than imported
   *  since this only needs the boolean, not `nonOverlappingStart`'s own "then fall back to the track's
   *  end" behavior — that fallback is exactly what this function exists to AVOID (see
   *  `targetAudioTrackId`'s own doc comment for why "silently jumps to the end of an occupied track"
   *  was the reported bug). */
  function isFreeAt(track: Track, start: number, duration: number): boolean {
    const end = start + duration;
    return !track.clips.some((c) => c.timelineStart < end && clipEnd(c) > start);
  }

  /** Finds an unlocked audio track with genuinely free room at the playhead for this SFX's own
   *  duration, or creates a fresh one — never a track that's merely "audio and unlocked" the way this
   *  used to pick (see the note above): the OLD version paired with `addAssetAtPlayhead`'s own
   *  `avoidOverlap: true` and `nonOverlappingStart`'s "if it overlaps, jump to the END of the whole
   *  track" fallback, which is why picking a background-music track (almost always occupied at
   *  whatever moment the user is adding an SFX for) silently landed the new clip far down the timeline
   *  instead of at the playhead the user was actually looking at. Prefers the currently active track
   *  when it's audio AND free, matching `addAssetAtPlayhead`'s own "stay on the active track" instinct;
   *  otherwise the first unlocked audio track with room; a brand-new track (always empty, so always
   *  free) only as the last resort. */
  function targetAudioTrackId(duration: number): string {
    if (!project) throw new Error("No project loaded");
    const activeTrack = activeTrackId ? project.sequence.tracks.find((t) => t.id === activeTrackId) : undefined;
    if (activeTrack?.kind === "audio" && isFreeAt(activeTrack, playhead, duration)) {
      return activeTrack.id;
    }
    const existing = project.sequence.tracks.find((t) => t.kind === "audio" && !t.locked && isFreeAt(t, playhead, duration));
    if (existing) return existing.id;
    const addTrack = new AddTrackCommand("audio");
    run(addTrack);
    return addTrack.trackId;
  }

  /** Generalized the same way `togglePreview` is — `id`/`label`/`url` plus the FILENAME to hand
   *  `importFiles` (bundled and "My Sounds" both already have a real one of their own: `def.file` /
   *  `sfx.relPath`'s own basename — never invented here). A "My Sounds" pick goes through this exact
   *  same fetch-then-`importFiles` hand-off as a bundled one, not a direct reference to its
   *  `CustomSfxAsset` — clips need a real `Asset` id (`project.assets`), and `customSfx` is a separate,
   *  LUT/font-shaped LIBRARY of re-usable sources, not itself a placeable asset (see
   *  `CustomSfxAsset`'s own doc comment for why "Add to timeline" and a plain library entry are
   *  genuinely different operations). */
  async function addToTimeline(id: string, label: string, url: string, fileName: string) {
    if (!project || addingId) return;
    setAddingId(id);
    try {
      const blob = await fetch(url).then((r) => r.blob());
      const file = new File([blob], fileName, { type: blob.type || "audio/mpeg" });
      // `hiddenFromLibrary: true` — same choice as `VoiceoverRecorder`'s own take, now, not the
      // opposite: this bundled clip is already reachable from its own browsable panel (this one, a
      // click away any time), so a second copy of it sitting in the Media Library too was reported as
      // clutter rather than a convenience. Once it's on the timeline it's still a completely ordinary
      // clip — droppable/duplicable/trimmable exactly like any other — this flag only keeps it out of
      // the LIBRARY LISTING, never off the timeline itself.
      const [asset] = await importFiles([file], { hiddenFromLibrary: true });
      if (!asset) return;
      const trackId = targetAudioTrackId(defaultClipDuration(asset));
      // Not `avoidOverlap: true` — `targetAudioTrackId` above already guaranteed the playhead spot on
      // this specific track is free, so there's nothing left for that fallback to protect against, and
      // it's exactly what silently sent the clip to the end of the track instead of the playhead
      // before (see `targetAudioTrackId`'s own doc comment).
      addAssetAtPlayhead(asset.id, trackId);
      setStatus(t('Added "{name}" to the timeline', { name: label }));
      onClose();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : t("Could not add that sound effect"), "error");
    } finally {
      setAddingId(null);
    }
  }

  const normalizedQuery = query.trim().toLowerCase();
  const matchesQuery = (label: string) => normalizedQuery === "" || label.toLowerCase().includes(normalizedQuery);

  const filteredCustomSfx = project ? project.customSfx.filter((sfx) => matchesQuery(sfx.label)) : [];
  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    items: SFX_REGISTRY.filter((s) => s.category === category && matchesQuery(s.label)),
  })).filter((g) => g.items.length > 0);
  const hasNoResults = normalizedQuery !== "" && filteredCustomSfx.length === 0 && grouped.length === 0;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t("Sound Effects")}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-md flex-col rounded-xl border border-white/10 bg-[#12151c] shadow-2xl"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-5 py-3">
          <h2 className="text-sm font-semibold text-white">{t("Sound Effects")}</h2>
          <div className="flex items-center gap-1">
            {/* Imports into the project's OWN reusable `customSfx` library (see `CustomSfxAsset`'s own
                doc comment) — a permanent addition to "My Sounds" below, distinct from a bundled
                entry's one-shot "Add to timeline" (that just copies a bundled file onto the timeline on
                demand, nothing persists as a re-usable library entry from it). Same hidden-input pattern
                the Inspector's own "Import LUT…"/font-picker buttons use. */}
            <button
              onClick={() => importInputRef.current?.click()}
              disabled={importingSfx}
              title={t("Import a sound effect")}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white/50 transition hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-50"
            >
              <Upload size={14} />
            </button>
            <button
              onClick={onClose}
              aria-label={t("Close")}
              className="rounded p-1 text-white/40 transition hover:bg-white/10 hover:text-white"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Sticky, always visible while scrolling the (now potentially 160+ entry) list below —
            searching shouldn't require scrolling back up to the header first. */}
        <div className="shrink-0 border-b border-white/10 px-5 py-2.5">
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("Search sound effects…")}
              aria-label={t("Search sound effects")}
              className="w-full rounded-md border border-white/10 bg-white/5 py-1.5 pl-8 pr-2.5 text-xs text-white placeholder:text-white/30 focus:border-sky-400/50 focus:outline-none"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {/* "My Sounds" — the project's own imported library, listed FIRST: a user who just imported
              something almost always wants it right there, not buried below six bundled categories. */}
          {project && filteredCustomSfx.length > 0 && (
            <div className="mb-4">
              <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-white/35">
                {t("My Sounds")}
              </h3>
              <ul className="space-y-0.5">
                {filteredCustomSfx.map((sfx: CustomSfxAsset) => {
                  const url = projectId ? customSfxUrl(projectId, sfx) : null;
                  return (
                    <li key={sfx.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-white/5">
                      <button
                        onClick={() => url && togglePreview(sfx.id, url)}
                        disabled={!url}
                        aria-label={playingId === sfx.id ? t("Stop preview") : t("Preview")}
                        title={playingId === sfx.id ? t("Stop preview") : t("Preview")}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/70 transition hover:bg-white/20 hover:text-white disabled:cursor-default disabled:opacity-40"
                      >
                        {playingId === sfx.id ? <Pause size={13} /> : <Play size={13} />}
                      </button>
                      <span className="min-w-0 flex-1 truncate text-xs text-white/80">{sfx.label}</span>
                      <button
                        onClick={() => url && void addToTimeline(sfx.id, sfx.label, url, sfx.relPath)}
                        disabled={addingId === sfx.id || !url}
                        className="shrink-0 rounded bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-white/20 disabled:cursor-default disabled:opacity-50"
                      >
                        {addingId === sfx.id ? t("Adding…") : t("Add")}
                      </button>
                      <button
                        onClick={async () => {
                          setRemovingId(sfx.id);
                          await removeSfx(sfx.id);
                          setRemovingId(null);
                        }}
                        disabled={removingId === sfx.id}
                        aria-label={t("Remove")}
                        title={t("Remove")}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white/40 transition hover:bg-red-500/20 hover:text-red-300 disabled:cursor-default disabled:opacity-40"
                      >
                        <Delete size={13} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {hasNoResults && (
            <p className="px-1 py-6 text-center text-xs text-white/40">
              {t('No sound effects match "{query}"', { query })}
            </p>
          )}

          {grouped.map(({ category, items }) => (
            <div key={category} className="mb-4 last:mb-0">
              <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-white/35">
                {t(category)}
              </h3>
              <ul className="space-y-0.5">
                {items.map((def) => (
                  <li key={def.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-white/5">
                    <button
                      onClick={() => togglePreview(def.id, sfxAssetUrl(def.file))}
                      aria-label={playingId === def.id ? t("Stop preview") : t("Preview")}
                      title={playingId === def.id ? t("Stop preview") : t("Preview")}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/70 transition hover:bg-white/20 hover:text-white"
                    >
                      {playingId === def.id ? <Pause size={13} /> : <Play size={13} />}
                    </button>
                    <span className="min-w-0 flex-1 truncate text-xs text-white/80">{def.label}</span>
                    <button
                      onClick={() => void addToTimeline(def.id, def.label, sfxAssetUrl(def.file), def.file)}
                      disabled={addingId === def.id}
                      className="shrink-0 rounded bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-white/20 disabled:cursor-default disabled:opacity-50"
                    >
                      {addingId === def.id ? t("Adding…") : t("Add")}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Single shared preview element — see this component's own doc comment for why one element,
            swapped `src`, beats one `<audio>` per row. */}
        <audio ref={audioRef} className="hidden" />
        <input
          ref={importInputRef}
          type="file"
          accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            await importSfx(file);
          }}
        />
      </div>
    </div>,
    document.body
  );
}
