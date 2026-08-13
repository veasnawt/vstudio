import { create } from "zustand";
import * as api from "../api/client.ts";
import type { Command } from "../commands/index.ts";
import { AddClipCommand } from "../commands/index.ts";
import { sequenceDuration } from "../project/createProject.ts";
import type { Asset, Project } from "../project/types.ts";
import { EditError } from "../timeline/operations.ts";
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
  /** Horizontal timeline scale, in pixels per second. */
  pixelsPerSecond: number;
  selectedClipIds: string[];
  /** Which track a newly-dropped clip lands on when the user doesn't pick one explicitly. */
  activeTrackId: string | null;

  dirty: boolean;
  saving: boolean;
  lastSavedAt: number | null;

  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;

  status: { message: string; tone: StatusTone } | null;
  importing: boolean;

  load: (projectId: string) => Promise<void>;
  run: (command: Command) => void;
  undo: () => void;
  redo: () => void;
  save: () => Promise<void>;

  setPlayhead: (seconds: number) => void;
  setPlaying: (playing: boolean) => void;
  togglePlay: () => void;
  stepFrames: (frames: number) => void;
  setPixelsPerSecond: (value: number) => void;
  zoomBy: (factor: number) => void;
  resetZoom: () => void;
  select: (clipIds: string[]) => void;
  setActiveTrack: (trackId: string) => void;

  importFiles: (files: File[]) => Promise<void>;
  removeAsset: (asset: Asset) => Promise<void>;
  addAssetAtPlayhead: (assetId: string, trackId?: string) => void;

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
    pixelsPerSecond: DEFAULT_PIXELS_PER_SECOND,
    selectedClipIds: [],
    activeTrackId: null,

    dirty: false,
    saving: false,
    lastSavedAt: null,

    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,

    status: null,
    importing: false,

    async load(projectId) {
      set({ loading: true, loadError: null, projectId });
      try {
        const project = await api.loadProject(projectId);
        // History from a previously-open project references clip ids that don't exist in this one.
        undoStack.clear();
        set({
          project,
          loading: false,
          dirty: false,
          playhead: 0,
          playing: false,
          selectedClipIds: [],
          activeTrackId: project.sequence.tracks.find((t) => t.kind === "video")?.id ?? null,
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
      const project = get().project;
      const fps = project?.sequence.fps ?? 30;
      const total = project ? sequenceDuration(project) : 0;
      set({ playhead: snapToFrame(Math.min(Math.max(0, seconds), Math.max(0, total)), fps) });
    },

    setPlaying(playing) {
      set({ playing });
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

    setActiveTrack(trackId) {
      set({ activeTrackId: trackId });
    },

    async importFiles(files) {
      const { projectId, project } = get();
      if (!projectId || !project || files.length === 0) return;

      set({ importing: true });
      const imported: Asset[] = [];
      const failures: string[] = [];

      // Sequential rather than parallel: each import copies a file and runs ffprobe/ffmpeg, and
      // firing a dozen of those at once would thrash the disk and spawn a dozen processes.
      for (const file of files) {
        try {
          imported.push(await api.importMedia(projectId, file));
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

    addAssetAtPlayhead(assetId, trackId) {
      const { project, playhead, activeTrackId } = get();
      if (!project) return;
      const asset = project.assets.find((a) => a.id === assetId);
      if (!asset) return;

      // Audio-only media belongs on an audio track; anything visual goes to a video track. Picking
      // the right one automatically is what makes double-clicking an asset in the library work.
      const wantedKind = asset.kind === "audio" ? "audio" : "video";
      const target =
        trackId ??
        (activeTrackId && project.sequence.tracks.find((t) => t.id === activeTrackId)?.kind === wantedKind
          ? activeTrackId
          : project.sequence.tracks.find((t) => t.kind === wantedKind && !t.locked)?.id);

      if (!target) return get().setStatus(`There is no unlocked ${wantedKind} track to add this to`, "error");
      get().run(new AddClipCommand(target, assetId, playhead));
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
