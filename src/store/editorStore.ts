import { create } from "zustand";
import * as api from "../api/client.ts";
import type { CaptionSegment, SourceRect } from "../api/client.ts";
import type { Command } from "../commands/index.ts";
import { AddCaptionsCommand, AddClipCommand, AddTrackCommand, DuplicateClipsCommand } from "../commands/index.ts";
import type { Language } from "../i18n/translations.ts";
import { translateText } from "../i18n/translations.ts";
import type { PlaybackEngine } from "../playback/PlaybackEngine.ts";
import { createTextAsset, sequenceDuration } from "../project/createProject.ts";
import type { Asset, Project } from "../project/types.ts";
import type { ClipOverride } from "../timeline/groupMove.ts";
import { defaultClipDuration, EditError, trackKindForAsset } from "../timeline/operations.ts";
import { nonOverlappingPointStart, nonOverlappingStart } from "../timeline/queries.ts";
import { snapToFrame } from "../timeline/time.ts";
import { UndoStack } from "../undo/UndoStack.ts";

const LANGUAGE_STORAGE_KEY = "vcut-language";

/** SSR-safe: this module's very first render (server, or the first client tick before hydration) has
 *  no `window` — same guard pattern `VCutApp.tsx`'s own `timelineHeight` initializer already uses
 *  for the same reason. Falls back to English on any unexpected read error (a disabled/private-mode
 *  localStorage throwing is a real possibility, not just theoretical) rather than crashing the app
 *  over a UI-language preference. */
function readStoredLanguage(): Language {
  if (typeof window === "undefined") return "en";
  try {
    return window.localStorage.getItem(LANGUAGE_STORAGE_KEY) === "km" ? "km" : "en";
  } catch {
    return "en";
  }
}

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

  /** Seconds every OTHER selected clip should shift by, live, while ONE of them is being dragged along
   *  the Timeline's own time axis — `null` when no such drag is in progress. `TimelineClip`'s own
   *  local-preview-then-single-commit pattern already moves the clip actually under the pointer (its
   *  own component-local `preview` state), but every OTHER selected clip is a SEPARATE component
   *  instance with no way to know a group drag is happening at all — without this, only the one clip
   *  under the pointer visibly moved during the drag itself, with the rest snapping into place all at
   *  once only once the mouse was released, which reads as "only one clip can be moved" even though the
   *  committed result (via the `BatchCommand` `TimelineClip`'s own `onUp` already builds) was always
   *  correct. Same "ephemeral view state, not part of `project`, not persisted" precedent as
   *  `livePreviewOverrides` above — this is its Timeline-space (1D, seconds) counterpart to that one's
   *  canvas-space (2D, pixels) `ClipOverride[]`; kept as a separate, simpler field rather than folding
   *  into `livePreviewOverrides` since every group member shifts by the exact same delta (no per-clip
   *  position to track), and `TimelineClip` needs to read it independent of whether `PlaybackEngine`
   *  is even attached. */
  groupMoveDelta: number | null;

  /** Live value of an in-progress Mixer track-fader drag — `null` when no track fader is being
   *  dragged. Same "ephemeral view state, not part of `project`, not persisted, cleared on commit"
   *  precedent as `livePreviewOverrides`, just scoped to gain rather than transform: `MixerDialog`
   *  wires a `NumberField`'s `onPreview` to this (continuous, no undo entry) and `onCommit` to
   *  `run(new SetTrackGainCommand(...))` (once, on release) — `PlaybackEngine`'s
   *  `getLiveTrackGainPreview` host getter reads it once per tick so the audio actually changes while
   *  you drag, not just once you let go. Kept as its own field rather than folding into
   *  `livePreviewOverrides` (which is clip-keyed, for the canvas) since only one fader can ever be
   *  dragged at a time — no array needed. */
  livePreviewTrackGain: { trackId: string; gain: number } | null;
  /** Same relationship as `livePreviewTrackGain`, for the Mixer's master fader. */
  livePreviewMasterGain: number | null;
  /** Same relationship as `livePreviewTrackGain`, for an in-progress Mixer pan-knob drag. */
  livePreviewTrackPan: { trackId: string; pan: number } | null;

  /** The live `PlaybackEngine` instance itself — set once by `Preview.tsx`'s engine-creation effect,
   *  cleared back to `null` in that same effect's cleanup (alongside its existing `engine.detach()`
   *  call). This is the first time anything outside `Preview.tsx` has ever needed to read FROM the
   *  engine rather than only write to it via `livePreviewTrackGain`-style fields — the Mixer's level
   *  meters need a live per-track/master dB reading every animation frame, which has no sensible
   *  "store field the engine polls and writes into" shape the way a preview override does (that would
   *  mean writing to Zustand state 60 times a second, forcing a re-render on every meter tick).
   *  Instead, `LevelMeter` reads THIS field once (cheap — it only changes once per mount, not every
   *  frame) to get a reference to the engine, then calls `engine.getTrackLevelDb`/`getMasterLevelDb`
   *  directly from its own self-contained `requestAnimationFrame` loop, writing straight to a DOM ref —
   *  completely outside React's render cycle, the same way `PlaybackEngine`/`AudioMixEngine` themselves
   *  already operate. */
  playbackEngine: PlaybackEngine | null;

  dirty: boolean;
  saving: boolean;
  lastSavedAt: number | null;

  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;

  status: { message: string; tone: StatusTone } | null;
  importing: boolean;
  /** Which "My Sounds" import is currently in flight — disables `SfxPanel`'s own import button so a
   *  second click can't fire a second upload while the first is still running. Session-only, same
   *  category as `importing` (this project's own separate flag, not shared with it, since a plain
   *  media import and a sound-effect-library import are two independent operations a user could
   *  plausibly trigger at the same time). */
  importingSfx: boolean;

  /** Which mobile-only bottom-row "sheet" is currently showing in place of Timeline — `null` means
   *  Timeline itself (the default, and the only state that ever applies at `lg`+, where these two
   *  toolbar buttons don't even render — see `VCutApp.tsx`'s own comment on why Media/Properties have
   *  no permanent side column below that breakpoint). Session-only, same category as `activeTrackId`:
   *  a working-session UI choice, never part of `project`, never undo-tracked. Lives in the STORE
   *  (not local `VCutApp` state, which is where this started) because `TimelineClip`'s own double-
   *  tap-to-edit gesture needs to open Properties from deep inside the Timeline tree, with no prop-
   *  drilling path back up to `VCutApp` — the same "needs to be reachable from somewhere with no direct
   *  component relationship to the owner" reasoning `playbackEngine`'s own doc comment gives for living
   *  here instead of as a plain prop. */
  mobileSheet: "media" | "inspector" | null;
  setMobileSheet: (next: "media" | "inspector" | null) => void;

  /** The live `<canvas>` `Preview.tsx` currently has attached to its `PlaybackEngine` — set by that
   *  same effect that calls `engine.attach(canvas)`, cleared back to `null` on unmount, mirroring
   *  `playbackEngine`'s own set/clear lifecycle exactly (both exist for the identical reason: giving a
   *  component OUTSIDE `Preview.tsx` a way to reach something `Preview.tsx` owns, with no sensible
   *  prop-drilling path). `ScopesPanel`'s own waveform/vectorscope/histogram readout is the one
   *  consumer — it samples this canvas's own live pixels on its own independent `requestAnimationFrame`
   *  loop rather than being pushed frames, which is what lets it keep updating while scrubbing (not
   *  just during real playback) with zero coupling to `PlaybackEngine`'s own render loop. */
  previewCanvas: HTMLCanvasElement | null;
  setPreviewCanvas: (canvas: HTMLCanvasElement | null) => void;

  /** UI chrome language — the first persisted (localStorage) preference in this store; everything
   *  else here is explicitly session-only. Never affects `project` (a text clip's own font/content is
   *  unrelated project data, not UI chrome), matching how a theme choice would be scoped. */
  language: Language;
  setLanguage: (language: Language) => void;

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
  setGroupMoveDelta: (delta: number | null) => void;
  setLivePreviewTrackGain: (value: { trackId: string; gain: number } | null) => void;
  setLivePreviewMasterGain: (value: number | null) => void;
  setLivePreviewTrackPan: (value: { trackId: string; pan: number } | null) => void;
  setPlaybackEngine: (engine: PlaybackEngine | null) => void;

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

  /** "Remove Object" tool state — session-only, never part of `project`, same category as
   *  `livePreviewOverrides`/`assetDrag` above. `removeObjectArmedClipId` is set by the Inspector's
   *  "Draw region" button and read by `RemoveObjectOverlay` to know it should start accepting a
   *  drag-to-draw gesture on the Preview canvas for that specific clip; it's cleared the moment a
   *  rect is committed (or the drawing gesture is abandoned). `removeObjectRect` is the committed
   *  rectangle (in the SOURCE asset's own pixel space, not screen space — see `maskGeometry.ts`),
   *  kept per-clip so switching selection away and back doesn't lose it. */
  removeObjectArmedClipId: string | null;
  removeObjectRect: (SourceRect & { clipId: string }) | null;
  armRemoveObject: (clipId: string) => void;
  setRemoveObjectRect: (clipId: string, rect: SourceRect) => void;
  clearRemoveObject: () => void;
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
  /** Imports one file into the project's own reusable "My Sounds" library (`project.customSfx`) —
   *  same "not undo-able, an import is more like an asset creation than a timeline edit" reasoning
   *  `importFiles` itself already follows, just against a separate library array instead of
   *  `project.assets` (see `CustomSfxAsset`'s own doc comment for why the two are kept apart). Errors
   *  surface via `setStatus`, matching `importFiles`'s own failure handling. */
  importSfx: (file: File) => Promise<void>;
  /** Removes one "My Sounds" entry — same "not undo-able" reasoning as `importSfx`/`removeAsset`. Does
   *  NOT touch any clip already placed from it (that clip references a real, separate `Asset` the
   *  import already copied — see `CustomSfxAsset`'s own doc comment), only the reusable library entry
   *  itself. */
  removeSfx: (id: string) => Promise<void>;
  /** `avoidOverlap`: place at the playhead only if that spot is actually free, otherwise append after
   *  the track's own last clip instead of carving into whatever's already there — see
   *  `nonOverlappingStart`'s own comment for why a "quick add" caller (Text/Record) needs this and a
   *  deliberate manual placement (double-click a library asset) doesn't. Defaults to false, preserving
   *  today's exact-playhead placement for that manual path. */
  addAssetAtPlayhead: (assetId: string, trackId?: string, options?: { avoidOverlap?: boolean }) => void;
  /** Duplicates every currently-selected clip (see `DuplicateClipsCommand`'s own doc comment for
   *  exactly where each copy lands and why) as one undo-able step, then selects the fresh copies —
   *  the same "the thing you just created is what's now selected" behavior `addTextAtPlayhead` and a
   *  freshly-imported/dropped asset both already give. */
  duplicateSelectedClips: () => void;
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
  /** Renames the project itself (`project.name` — what VCut's own home page lists it by), not any
   *  individual clip/asset. Same "not undo-able, a metadata edit rather than a timeline edit" category
   *  as `addTextAsset` — Ctrl+Z undoing a rename in the middle of unrelated clip edits would be a
   *  surprising thing for the undo stack to track. Falls back to "Untitled" for an empty/whitespace-
   *  only name, matching `createProject`'s own default. */
  renameProject: (name: string) => void;
  /** Lands a "Remove Object" job's finished result into the Media Library — same "not undo-able, an
   *  asset creation is more like an import than an edit" reasoning as `importFiles`/`addTextAsset`,
   *  and the same `applyProject` call they both use. Does NOT place it on the timeline; the user
   *  drags it in themselves, same as any freshly-imported asset (a deliberate v1 scope cut — there's
   *  no single obviously-correct "replace this clip" behavior to automate yet). */
  landInpaintedAsset: (asset: Asset) => void;
  /** Lands an Auto Captions job's finished segments as real text assets + clips on a new text track —
   *  unlike `landInpaintedAsset`, this genuinely goes through `run()` (see `AddCaptionsCommand`'s own
   *  doc comment for why): a caption pass creates its assets AND places them in one user-facing
   *  action, so it undoes as one step too, rather than the asset-creation-is-permanent convention
   *  every other asset-adding action here follows. */
  landCaptions: (captions: CaptionSegment[]) => void;

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
      // Same reasoning as selections above: a "Remove Object" rect drawn on a clip that's since been
      // deleted has nothing left to apply to — drop it rather than leave it pointing at a dead id.
      removeObjectRect: state.removeObjectRect && !alive.has(state.removeObjectRect.clipId) ? null : state.removeObjectRect,
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
    groupMoveDelta: null,
    livePreviewTrackGain: null,
    livePreviewMasterGain: null,
    livePreviewTrackPan: null,
    playbackEngine: null,
    recording: null,
    assetDrag: null,
    resolveTimelineDropTarget: null,
    removeObjectArmedClipId: null,
    removeObjectRect: null,

    dirty: false,
    saving: false,
    lastSavedAt: null,

    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,

    status: null,
    language: readStoredLanguage(),
    importing: false,
    importingSfx: false,
    mobileSheet: null,
    previewCanvas: null,

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
        // `err.message` is translated here (not at the `EditError`/`Error` throw sites themselves) —
        // `translateText` is a plain dictionary lookup keyed by the literal English text, so a KM
        // entry for the exact message string translates it without needing to touch every file that
        // constructs one.
        if (err instanceof EditError) return get().setStatus(translateText(get().language, err.message), "error");
        throw err;
      }
    },

    undo() {
      const project = get().project;
      if (!project || !undoStack.canUndo) return;
      const label = undoStack.undoLabel;
      applyProject(undoStack.undo(project));
      syncUndoState();
      const language = get().language;
      const translatedLabel = label ? translateText(language, label) : null;
      get().setStatus(translatedLabel ? translateText(language, "Undid {label}", { label: translatedLabel }) : translateText(language, "Undone"));
    },

    redo() {
      const project = get().project;
      if (!project || !undoStack.canRedo) return;
      const label = undoStack.redoLabel;
      applyProject(undoStack.redo(project));
      syncUndoState();
      const language = get().language;
      const translatedLabel = label ? translateText(language, label) : null;
      get().setStatus(translatedLabel ? translateText(language, "Redid {label}", { label: translatedLabel }) : translateText(language, "Redone"));
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
        const message = err instanceof Error ? err.message : "Could not save the project";
        get().setStatus(translateText(get().language, message), "error");
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
    setGroupMoveDelta(delta) {
      set({ groupMoveDelta: delta });
    },
    setLivePreviewTrackGain(value) {
      set({ livePreviewTrackGain: value });
    },
    setLivePreviewMasterGain(value) {
      set({ livePreviewMasterGain: value });
    },
    setLivePreviewTrackPan(value) {
      set({ livePreviewTrackPan: value });
    },
    setPlaybackEngine(engine) {
      set({ playbackEngine: engine });
    },
    setMobileSheet(next) {
      set({ mobileSheet: next });
    },
    setPreviewCanvas(canvas) {
      set({ previewCanvas: canvas });
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

    armRemoveObject(clipId) {
      set({ removeObjectArmedClipId: clipId });
    },

    setRemoveObjectRect(clipId, rect) {
      set({ removeObjectArmedClipId: null, removeObjectRect: { clipId, ...rect } });
    },

    clearRemoveObject() {
      set({ removeObjectArmedClipId: null, removeObjectRect: null });
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
      const language = get().language;
      if (failures.length > 0) {
        get().setStatus(
          failures.length === 1
            ? failures[0]
            : translateText(language, "{n} files could not be imported", { n: failures.length }),
          "error"
        );
      } else if (imported.length > 0) {
        get().setStatus(translateText(language, "Imported {n} file(s)", { n: imported.length }));
      }
      return imported;
    },

    addTextAsset() {
      const current = get().project;
      if (!current) return null;
      const asset = createTextAsset();
      applyProject({ ...current, assets: [...current.assets, asset] });
      get().setStatus(translateText(get().language, "Added text"));
      return asset.id;
    },

    renameProject(name) {
      const current = get().project;
      if (!current) return;
      const trimmed = name.trim().slice(0, 120);
      const next = trimmed || "Untitled";
      if (next === current.name) return;
      applyProject({ ...current, name: next });
      get().setStatus(translateText(get().language, "Renamed project"));
    },

    landInpaintedAsset(asset) {
      const current = get().project;
      if (!current) return;
      applyProject({ ...current, assets: [...current.assets, asset] });
      get().clearRemoveObject();
      get().setStatus(translateText(get().language, 'Added "{name}" to the Media Library', { name: asset.name }));
    },

    landCaptions(captions) {
      const current = get().project;
      if (!current || captions.length === 0) return;
      get().run(new AddCaptionsCommand(captions, current.sequence.height));
      get().setStatus(translateText(get().language, "Added {n} captions", { n: captions.length }));
    },

    async removeAsset(asset) {
      const { projectId, project } = get();
      if (!projectId || !project) return;

      const inUse = project.sequence.tracks.some((t) => t.clips.some((c) => c.assetId === asset.id));
      if (inUse) {
        return get().setStatus(
          translateText(get().language, "Remove that clip from the timeline before removing its media"),
          "error"
        );
      }

      try {
        await api.deleteMedia(projectId, asset);
        const current = get().project;
        if (current) applyProject({ ...current, assets: current.assets.filter((a) => a.id !== asset.id) });
        get().setStatus(translateText(get().language, "Removed {name}", { name: asset.name }));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not remove that media";
        get().setStatus(translateText(get().language, message), "error");
      }
    },

    async importSfx(file) {
      const { projectId, project, importingSfx } = get();
      if (!projectId || !project || importingSfx) return;
      set({ importingSfx: true });
      try {
        const sfx = await api.importCustomSfx(projectId, file);
        const current = get().project;
        if (current) applyProject({ ...current, customSfx: [...current.customSfx, sfx] });
        get().setStatus(translateText(get().language, 'Added "{name}" to My Sounds', { name: sfx.label }));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not import that sound effect";
        get().setStatus(translateText(get().language, message), "error");
      } finally {
        set({ importingSfx: false });
      }
    },

    async removeSfx(id) {
      const { projectId, project } = get();
      if (!projectId || !project) return;
      const sfx = project.customSfx.find((s) => s.id === id);
      if (!sfx) return;
      try {
        await api.deleteCustomSfx(projectId, sfx);
        const current = get().project;
        if (current) applyProject({ ...current, customSfx: current.customSfx.filter((s) => s.id !== id) });
        get().setStatus(translateText(get().language, "Removed {name}", { name: sfx.label }));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not remove that sound effect";
        get().setStatus(translateText(get().language, message), "error");
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

      if (!target) {
        const language = get().language;
        return get().setStatus(
          translateText(language, "There is no unlocked {kind} track to add this to", {
            kind: translateText(language, wantedKind),
          }),
          "error"
        );
      }

      const start = options?.avoidOverlap
        ? nonOverlappingStart(
            project.sequence.tracks.find((t) => t.id === target)!,
            playhead,
            defaultClipDuration(asset)
          )
        : playhead;
      get().run(new AddClipCommand(target, assetId, start));
    },

    duplicateSelectedClips() {
      const { selectedClipIds, language } = get();
      if (selectedClipIds.length === 0) return;
      const command = new DuplicateClipsCommand(selectedClipIds);
      get().run(command);
      const created = command.createdClipIds.length;
      if (created === 0) {
        // Every selected clip was on a locked track (or otherwise skipped) — nothing actually got
        // duplicated; say so rather than claiming success. `run` still pushed a real (no-op) undo
        // entry either way — every command does, this one included, matching e.g. deleting an
        // already-gone clip id — so there's nothing extra to clean up here.
        return get().setStatus(translateText(language, "Nothing to duplicate — every selected clip is on a locked track"), "error");
      }
      set({ selectedClipIds: command.createdClipIds });
      get().setStatus(created === 1 ? translateText(language, "Duplicated clip") : translateText(language, "Duplicated {n} clips", { n: created }));
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

    setLanguage(language) {
      set({ language });
      try {
        window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
      } catch {
        // Private-mode/disabled storage — the toggle still works for this session, it just won't
        // survive a reload. Not worth surfacing as an error over a UI preference.
      }
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
