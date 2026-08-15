import { create } from "zustand";
import * as api from "../api/client.ts";
import type { Command } from "../commands/index.ts";
import { AddClipCommand, AddTrackCommand } from "../commands/index.ts";
import { createTextAsset, sequenceDuration } from "../project/createProject.ts";
import type { Asset, Project } from "../project/types.ts";
import type { ClipOverride } from "../timeline/groupMove.ts";
import { defaultClipDuration, EditError, trackKindForAsset } from "../timeline/operations.ts";
import { nonOverlappingPointStart, nonOverlappingStart } from "../timeline/queries.ts";
import { snapToFrame } from "../timeline/time.ts";
import { UndoStack } from "../undo/UndoStack.ts";

/** How long after the last edit an autosave fires. Long enough that a burst of edits (dragging a
 *  clip produces many) collapses into one write, short enough that little is at risk if the app
 *  closes unexpectedly. */
const AUTOSAVE_DELAY_MS = 1500;

/** The timeline's starting zoom level, and what Ctrl/⌘+0 resets it back to. */
const DEFAULT_PIXELS_PER_SECOND = 60;

export type StatusTone = "info" | "error";

export interface EditorState {
  projectId: string | null;
  project: Project | null;
  loading: boolean;
  loadError: string | null;

  /** Timeline position in seconds — the single source of truth for both the preview and the
   *  playhead, so they can never disagree. */
  playhead: number;
  playing: boolean;
  /** The export range — `null` on either end means "the full timeline" (from 0 / to
   *  `sequenceDuration`), matching this app's general "absent means the default" convention. Session-
   *  only: NOT part of `project`, never saved to `project.json`, and never pushed to the undo stack —
   *  like `pixelsPerSecond`/`activeTrackId`, this is working-session UI state (which slice of the
   *  timeline you're currently choosing to render out), not a property of the edit itself. Order isn't
   *  enforced at write time (setting a start past the current end is allowed) — every consumer reads
   *  through `exportRange()` below, which sorts and clamps, so a momentarily "backwards" pair here can
   *  never reach the UI or the export pipeline as an invalid range. */
  exportRangeStart: number | null;
  exportRangeEnd: number | null;
  /** Horizontal timeline scale, in pixels per second. */
  pixelsPerSecond: number;
  selectedClipIds: string[];
  /** Which track a newly-dropped clip lands on when the user doesn't pick one explicitly. */
  activeTrackId: string | null;
  /** While `TransformHandles`/`TextTransformHandles` are mid-drag, every clip's transform/style they'd
   *  commit if released RIGHT NOW — the actively-dragged clip PLUS every other clip in a multi-select
   *  group move (see `timeline/groupMove.ts`). Read by `PlaybackEngine` (via
   *  `PlaybackHost.getLiveOverrides`) so the canvas itself tracks the drag — the whole group, not just
   *  the one clip under the pointer — instead of only the handle box(es) overlaid on top of it.
   *  Deliberately NOT part of `project` (so dragging never touches the undo stack until release, same
   *  as the local-preview-then-single-commit pattern those components already use) and not persisted
   *  — purely a live rendering hint, cleared the instant the drag ends. */
  livePreviewOverrides: ClipOverride[];

  dirty: boolean;
  saving: boolean;
  lastSavedAt: number | null;

  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;

  status: { message: string; tone: StatusTone } | null;
  importing: boolean;

  load: (projectId: string, projectName?: string) => Promise<void>;
  run: (command: Command) => void;
  undo: () => void;
  redo: () => void;
  save: () => Promise<void>;

  setPlayhead: (seconds: number) => void;
  setPlaying: (playing: boolean) => void;
  togglePlay: () => void;
  stepFrames: (frames: number) => void;
  /** `exportRangeStart`/`End` resolved against the CURRENT project — clamped to `[0, sequenceDuration]`
   *  and sorted (the smaller of the two is always `start`) — so every consumer (the Timeline's own
   *  markers/shading, `ExportDialog`) reads one always-valid range regardless of what order the two
   *  points were set in, or whether the timeline has since gotten shorter than a previously-set point. */
  exportRange: () => { start: number; end: number };
  setExportRangeStart: (seconds: number | null) => void;
  setExportRangeEnd: (seconds: number | null) => void;
  /** Back to "the full timeline" — both ends absent. */
  clearExportRange: () => void;
  setPixelsPerSecond: (value: number) => void;
  zoomBy: (factor: number) => void;
  resetZoom: () => void;
  select: (clipIds: string[]) => void;
  /** Adds `clipId` to the selection if it isn't already selected, or removes it if it is — the
   *  Ctrl/Cmd+click gesture, working identically regardless of which track or clip kind the clip is
   *  on, which is what makes selecting across video/text/audio clips together possible. */
  toggleSelect: (clipId: string) => void;
  setActiveTrack: (trackId: string) => void;
  setLivePreviewOverrides: (overrides: ClipOverride[]) => void;

  /** Live "recording in progress" indicator for `VoiceoverRecorder` — a growing placeholder in the
   *  target track's lane while capturing, since there's no real `Clip`/asset to render yet (the asset
   *  only comes into being once the recording is imported after stop). Session-only: not part of
   *  `project`, never saved, never undo-tracked — a pure rendering hint, same category as
   *  `livePreviewOverrides`. `phase: "recording"` grows live with `elapsedSeconds`; `"finalizing"`
   *  freezes at the last length while the stopped take is being imported and placed, so the indicator
   *  doesn't just vanish and pop back in a moment later as a real clip. */
  recording: { trackId: string; start: number; elapsedSeconds: number; phase: "recording" | "finalizing" } | null;
  beginRecordingIndicator: (trackId: string, start: number) => void;
  updateRecordingElapsed: (elapsedSeconds: number) => void;
  finalizeRecordingIndicator: () => void;
  clearRecordingIndicator: () => void;
  /** Picks where a new voiceover recording should land, without creating anything: an empty unlocked
   *  audio track first (so a fresh take never overlaps existing content), else an unlocked audio track
   *  that already holds a prior recording (grouping takes together rather than mixing into a music/SFX
   *  track), else the first unlocked audio track at all, else null — meaning the caller should create
   *  a new one. */
  pickVoiceoverTrack: () => string | null;
  /** Combines `pickVoiceoverTrack` (creating a new audio track if none qualifies) with marking the
   *  live recording indicator there — called once capture actually begins (mic permission granted).
   *  Returns the target track/start so the caller can place the REAL clip at the exact same spot once
   *  the take finishes, keeping the live indicator and the final clip in perfect agreement (no jump
   *  to a different position once the true duration is known). Null only if no project is loaded. */
  beginVoiceoverRecording: () => { trackId: string; start: number } | null;

  /** Live position of an in-progress touch-driven asset drag from the Media Library — native HTML5
   *  drag-and-drop never fires from touch input at all (confirmed dead on iOS Safari in particular),
   *  so `MediaLibrary`'s own pointer-based drag writes here on every move, and `Timeline` reads it to
   *  draw the same drop-target track highlight a mouse drag already gets for free from the browser's
   *  native dragover/drop. Null when nothing is being dragged. */
  assetDrag: { assetId: string; clientX: number; clientY: number } | null;
  setAssetDrag: (drag: EditorState["assetDrag"]) => void;
  /** Registered imperatively by `Timeline` (the only component that knows its own scroll offset and
   *  track-row geometry) so `MediaLibrary`'s pointer drag can hit-test an arbitrary screen point
   *  against timeline tracks on release, without either component reaching into the other's DOM
   *  internals. Returns the track and time a drop at that point would land on, or null if the point
   *  isn't over a track row at all. Null until `Timeline` mounts. */
  resolveTimelineDropTarget: ((clientX: number, clientY: number) => { trackId: string; time: number } | null) | null;
  setResolveTimelineDropTarget: (resolver: EditorState["resolveTimelineDropTarget"]) => void;

  /** Resolves to the successfully-imported assets (empty on total failure) — callers that need to do
   *  something with the result (VoiceoverRecorder placing its recording straight on the timeline)
   *  can, while every other caller (plain drag-drop/file-picker import) is free to still ignore it.
   *  `hiddenFromLibrary`: stamped onto every asset from this call (see `Asset.hiddenFromLibrary`'s own
   *  comment) — used by `VoiceoverRecorder` so a quick take doesn't clutter the Media Library. */
  importFiles: (files: File[], options?: { hiddenFromLibrary?: boolean }) => Promise<Asset[]>;
  removeAsset: (asset: Asset) => Promise<void>;
  /** `avoidOverlap`: place at the playhead only if that spot is actually free, otherwise append after
   *  the track's own last clip instead of carving into whatever's already there — see
   *  `nonOverlappingStart`'s own comment for why a "quick add" caller (Text/Record) needs this and a
   *  deliberate manual placement (double-click a library asset) doesn't. Defaults to false, preserving
   *  today's exact-playhead placement for that manual path. */
  addAssetAtPlayhead: (assetId: string, trackId?: string, options?: { avoidOverlap?: boolean }) => void;
  /** Creates a text asset AND immediately places it as a clip at the playhead — auto-creating a text
   *  track first if the project doesn't have an unlocked one yet, so "Text" in the toolbar always
   *  lands the result somewhere visible (timeline + preview) in one action, never just adding a
   *  library-only asset the way the Media panel's own asset creation still does. */
  addTextAtPlayhead: () => void;
  /** Creates a new text asset (default content + style, see `DEFAULT_TEXT_STYLE`) and adds it to the
   *  library — same "not undo-able, an asset creation is more like an import than an edit" reasoning
   *  as `importFiles`. Returns its id so a caller can immediately place it (see `addAssetAtPlayhead`)
   *  or open it for editing, rather than requiring a second lookup right after creating it. */
  addTextAsset: () => string | null;
  /** Renames the project itself (`project.name` — what VStudio's own home page lists it by), not any
   *  individual clip/asset. Same "not undo-able, a metadata edit rather than a timeline edit" category
   *  as `addTextAsset` — Ctrl+Z undoing a rename in the middle of unrelated clip edits would be a
   *  surprising thing for the undo stack to track. Falls back to "Untitled" for an empty/whitespace-
   *  only name, matching `createProject`'s own default. */
  renameProject: (name: string) => void;

  setStatus: (message: string | null, tone?: StatusTone) => void;
  duration: () => number;
}

/** The undo stack is intentionally NOT part of reactive state: it holds command objects with
 *  closures, it isn't serializable, and re-rendering on every push would be pointless. Only its
 *  derived booleans and labels are mirrored into the store for the UI to read. */
const undoStack = new UndoStack();

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

export const useEditorStore = create<EditorState>((set, get) => {
  /** Copies the undo stack's derived state into the store after any change to it. */
  function syncUndoState() {
    set({
      canUndo: undoStack.canUndo,
      canRedo: undoStack.canRedo,
      undoLabel: undoStack.undoLabel,
      redoLabel: undoStack.redoLabel,
    });
  }

  function markDirtyAndScheduleSave() {
    set({ dirty: true });
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      void get().save();
    }, AUTOSAVE_DELAY_MS);
  }

  /** Applies a project change from an edit, keeping the playhead inside the (possibly shortened)
   *  timeline and dropping selections for clips the edit removed. */
  function applyProject(project: Project) {
    const total = sequenceDuration(project);
    const alive = new Set(project.sequence.tracks.flatMap((t) => t.clips.map((c) => c.id)));
    set((state) => ({
      project,
      playhead: Math.min(state.playhead, Math.max(0, total)),
      selectedClipIds: state.selectedClipIds.filter((id) => alive.has(id)),
    }));
    markDirtyAndScheduleSave();
  }

  return {
    projectId: null,
    project: null,
    loading: true,
    loadError: null,

    playhead: 0,
    playing: false,
    exportRangeStart: null,
    exportRangeEnd: null,
    pixelsPerSecond: DEFAULT_PIXELS_PER_SECOND,
    selectedClipIds: [],
    activeTrackId: null,
    livePreviewOverrides: [],
    recording: null,
    assetDrag: null,
    resolveTimelineDropTarget: null,

    dirty: false,
    saving: false,
    lastSavedAt: null,

    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,

    status: null,
    importing: false,

    async load(projectId, projectName) {
      set({ loading: true, loadError: null, projectId });
      try {
        const project = await api.loadProject(projectId, projectName);
        // History from a previously-open project references clip ids that don't exist in this one.
        undoStack.clear();
        set({
          project,
          loading: false,
          dirty: false,
          playhead: 0,
          playing: false,
          exportRangeStart: null,
          exportRangeEnd: null,
          selectedClipIds: [],
          activeTrackId: project.sequence.tracks.find((t) => t.kind === "video")?.id ?? null,
          recording: null,
        });
        syncUndoState();
      } catch (err) {
        set({ loading: false, loadError: err instanceof Error ? err.message : String(err) });
      }
    },

    run(command) {
      const project = get().project;
      if (!project) return;
      try {
        applyProject(undoStack.execute(project, command));
        syncUndoState();
      } catch (err) {
        // An invalid edit (split outside a clip, locked track) is normal user error, not a crash —
        // it becomes a status message and nothing changes.
        if (err instanceof EditError) return get().setStatus(err.message, "error");
        throw err;
      }
    },

    undo() {
      const project = get().project;
      if (!project || !undoStack.canUndo) return;
      const label = undoStack.undoLabel;
      applyProject(undoStack.undo(project));
      syncUndoState();
      get().setStatus(label ? `Undid ${label}` : "Undone");
    },

    redo() {
      const project = get().project;
      if (!project || !undoStack.canRedo) return;
      const label = undoStack.redoLabel;
      applyProject(undoStack.redo(project));
      syncUndoState();
      get().setStatus(label ? `Redid ${label}` : "Redone");
    },

    async save() {
      const { project, projectId, saving } = get();
      if (!project || !projectId || saving) return;
      set({ saving: true });
      try {
        await api.saveProject(projectId, project);
        // Only clears `dirty` if nothing changed while the save was in flight — otherwise an edit
        // made mid-save would be silently marked as saved when it wasn't.
        set((state) => ({
          saving: false,
          lastSavedAt: Date.now(),
          dirty: state.project !== project,
        }));
      } catch (err) {
        set({ saving: false });
        get().setStatus(err instanceof Error ? err.message : "Could not save the project", "error");
      }
    },

    setPlayhead(seconds) {
      const { project, recording } = get();
      const fps = project?.sequence.fps ?? 30;
      // A recording still in progress isn't a real clip yet (see `recording`'s own comment), so
      // `sequenceDuration` doesn't know about it — without this, `VoiceoverRecorder` driving the
      // playhead forward while capturing would get clamped right back to 0 on a still-empty project
      // (or to whatever content already ends before the take does).
      const committedTotal = project ? sequenceDuration(project) : 0;
      const liveRecordingTotal = recording ? recording.start + recording.elapsedSeconds : 0;
      const total = Math.max(committedTotal, liveRecordingTotal);
      set({ playhead: snapToFrame(Math.min(Math.max(0, seconds), Math.max(0, total)), fps) });
    },

    setPlaying(playing) {
      set({ playing });
    },

    exportRange() {
      const { exportRangeStart, exportRangeEnd, project } = get();
      const total = project ? sequenceDuration(project) : 0;
      const clamp = (v: number) => Math.min(Math.max(0, v), Math.max(0, total));
      const a = clamp(exportRangeStart ?? 0);
      const b = clamp(exportRangeEnd ?? total);
      return a <= b ? { start: a, end: b } : { start: b, end: a };
    },

    setExportRangeStart(seconds) {
      const project = get().project;
      const fps = project?.sequence.fps ?? 30;
      set({ exportRangeStart: seconds === null ? null : snapToFrame(seconds, fps) });
    },

    setExportRangeEnd(seconds) {
      const project = get().project;
      const fps = project?.sequence.fps ?? 30;
      set({ exportRangeEnd: seconds === null ? null : snapToFrame(seconds, fps) });
    },

    clearExportRange() {
      set({ exportRangeStart: null, exportRangeEnd: null });
    },

    togglePlay() {
      const { playing, playhead, project } = get();
      if (!project) return;
      // Starting playback from the very end would look like nothing happened — rewind instead.
      if (!playing && playhead >= sequenceDuration(project) - 1e-6) set({ playhead: 0 });
      set({ playing: !playing });
    },

    stepFrames(frames) {
      const { playhead, project } = get();
      if (!project) return;
      get().setPlayhead(playhead + frames / project.sequence.fps);
    },

    setPixelsPerSecond(value) {
      set({ pixelsPerSecond: Math.min(400, Math.max(4, value)) });
    },

    zoomBy(factor) {
      get().setPixelsPerSecond(get().pixelsPerSecond * factor);
    },

    resetZoom() {
      set({ pixelsPerSecond: DEFAULT_PIXELS_PER_SECOND });
    },

    select(clipIds) {
      set({ selectedClipIds: clipIds });
    },

    toggleSelect(clipId) {
      set((state) => ({
        selectedClipIds: state.selectedClipIds.includes(clipId)
          ? state.selectedClipIds.filter((id) => id !== clipId)
          : [...state.selectedClipIds, clipId],
      }));
    },

    setLivePreviewOverrides(overrides) {
      set({ livePreviewOverrides: overrides });
    },

    setActiveTrack(trackId) {
      set({ activeTrackId: trackId });
    },

    setAssetDrag(drag) {
      set({ assetDrag: drag });
    },

    setResolveTimelineDropTarget(resolver) {
      set({ resolveTimelineDropTarget: resolver });
    },

    async importFiles(files, options) {
      const { projectId, project } = get();
      if (!projectId || !project || files.length === 0) return [];

      set({ importing: true });
      const imported: Asset[] = [];
      const failures: string[] = [];

      // Sequential rather than parallel: each import copies a file and runs ffprobe/ffmpeg, and
      // firing a dozen of those at once would thrash the disk and spawn a dozen processes.
      for (const file of files) {
        try {
          const asset = await api.importMedia(projectId, file);
          imported.push(options?.hiddenFromLibrary ? { ...asset, hiddenFromLibrary: true } : asset);
        } catch (err) {
          failures.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (imported.length > 0) {
        const current = get().project;
        if (current) {
          applyProject({ ...current, assets: [...current.assets, ...imported] });
        }
      }

      set({ importing: false });
      if (failures.length > 0) {
        get().setStatus(failures.length === 1 ? failures[0] : `${failures.length} files could not be imported`, "error");
      } else if (imported.length > 0) {
        get().setStatus(`Imported ${imported.length} file${imported.length === 1 ? "" : "s"}`);
      }
      return imported;
    },

    addTextAsset() {
      const current = get().project;
      if (!current) return null;
      const asset = createTextAsset();
      applyProject({ ...current, assets: [...current.assets, asset] });
      get().setStatus("Added text");
      return asset.id;
    },

    renameProject(name) {
      const current = get().project;
      if (!current) return;
      const trimmed = name.trim().slice(0, 120);
      const next = trimmed || "Untitled";
      if (next === current.name) return;
      applyProject({ ...current, name: next });
      get().setStatus("Renamed project");
    },

    async removeAsset(asset) {
      const { projectId, project } = get();
      if (!projectId || !project) return;

      const inUse = project.sequence.tracks.some((t) => t.clips.some((c) => c.assetId === asset.id));
      if (inUse) {
        return get().setStatus("Remove that clip from the timeline before removing its media", "error");
      }

      try {
        await api.deleteMedia(projectId, asset);
        const current = get().project;
        if (current) applyProject({ ...current, assets: current.assets.filter((a) => a.id !== asset.id) });
        get().setStatus(`Removed ${asset.name}`);
      } catch (err) {
        get().setStatus(err instanceof Error ? err.message : "Could not remove that media", "error");
      }
    },

    addAssetAtPlayhead(assetId, trackId, options) {
      const { project, playhead, activeTrackId } = get();
      if (!project) return;
      const asset = project.assets.find((a) => a.id === assetId);
      if (!asset) return;

      // `trackKindForAsset` is the SAME mapping `addClip` itself enforces — reusing it here (rather
      // than re-deriving "audio/text/video" locally) is what makes double-clicking a text asset land
      // on a text track automatically, the same way it already worked for audio and video.
      const wantedKind = trackKindForAsset(asset);
      const target =
        trackId ??
        (activeTrackId && project.sequence.tracks.find((t) => t.id === activeTrackId)?.kind === wantedKind
          ? activeTrackId
          : project.sequence.tracks.find((t) => t.kind === wantedKind && !t.locked)?.id);

      if (!target) return get().setStatus(`There is no unlocked ${wantedKind} track to add this to`, "error");

      const start = options?.avoidOverlap
        ? nonOverlappingStart(
            project.sequence.tracks.find((t) => t.id === target)!,
            playhead,
            defaultClipDuration(asset)
          )
        : playhead;
      get().run(new AddClipCommand(target, assetId, start));
    },

    beginRecordingIndicator(trackId, start) {
      set({ recording: { trackId, start, elapsedSeconds: 0, phase: "recording" } });
    },
    updateRecordingElapsed(elapsedSeconds) {
      set((state) => (state.recording ? { recording: { ...state.recording, elapsedSeconds } } : {}));
    },
    finalizeRecordingIndicator() {
      set((state) => (state.recording ? { recording: { ...state.recording, phase: "finalizing" } } : {}));
    },
    clearRecordingIndicator() {
      set({ recording: null });
    },
    pickVoiceoverTrack() {
      const project = get().project;
      if (!project) return null;
      const audioTracks = project.sequence.tracks.filter((t) => t.kind === "audio" && !t.locked);
      const empty = audioTracks.find((t) => t.clips.length === 0);
      if (empty) return empty.id;
      // "Already holds a prior recording" — grouping takes together rather than landing a voiceover in
      // whatever unlocked audio track happens to be first (which might be a music/SFX track instead).
      // `hiddenFromLibrary` is the same marker `VoiceoverRecorder` stamps on a take's asset to keep it
      // out of the Media Library — reused here as a reliable "this clip came from a recording" signal,
      // rather than pattern-matching the asset's (user-renamable) display name.
      const hasVoiceover = audioTracks.find((t) =>
        t.clips.some((c) => project.assets.find((a) => a.id === c.assetId)?.hiddenFromLibrary)
      );
      if (hasVoiceover) return hasVoiceover.id;
      return audioTracks[0]?.id ?? null;
    },
    beginVoiceoverRecording() {
      if (!get().project) return null;
      let trackId = get().pickVoiceoverTrack();
      if (!trackId) {
        const addTrack = new AddTrackCommand("audio");
        get().run(addTrack);
        trackId = addTrack.trackId;
      }
      const track = get().project?.sequence.tracks.find((t) => t.id === trackId);
      if (!track) return null;
      const start = nonOverlappingPointStart(track, get().playhead);
      get().beginRecordingIndicator(trackId, start);
      return { trackId, start };
    },

    addTextAtPlayhead() {
      const current = get().project;
      if (!current) return;
      const assetId = get().addTextAsset();
      if (!assetId) return;

      const existingTrack = current.sequence.tracks.find((t) => t.kind === "text" && !t.locked);
      if (existingTrack) {
        get().addAssetAtPlayhead(assetId, existingTrack.id, { avoidOverlap: true });
      } else {
        // AddTrackCommand exposes its trackId synchronously at construction, before it's even run —
        // so the new clip can target it directly rather than re-querying the (now-updated) project
        // for a track that was just added.
        const addTrack = new AddTrackCommand("text");
        get().run(addTrack);
        get().addAssetAtPlayhead(assetId, addTrack.trackId, { avoidOverlap: true });
      }
    },

    setStatus(message, tone = "info") {
      set({ status: message ? { message, tone } : null });
    },

    duration() {
      const project = get().project;
      return project ? sequenceDuration(project) : 0;
    },
  };
});

/** Flushes any pending autosave immediately — used when the editor unmounts or the window is about
 *  to close, so the debounce window can't swallow the last edit. */
export async function flushPendingSave(): Promise<void> {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  const state = useEditorStore.getState();
  if (state.dirty) await state.save();
}
