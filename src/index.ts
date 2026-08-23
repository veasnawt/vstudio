/** Public surface of @veasna/vstudio.
 *
 *  Host applications should only need `VStudioApp` — everything else is exported because it's useful
 *  for tests, tooling, and the server routes that share the project model, not because a host is
 *  expected to reach for it. */

export { VStudioApp } from "./ui/VStudioApp.tsx";
export { reportError } from "./api/crashLog.ts";

export type { Asset, AssetKind, Clip, ClipTransform, ExportSettings, Project, Sequence, TextStyle, Track, TrackKind } from "./project/types.ts";
export {
  DEFAULT_TEXT_STYLE,
  FPS_PRESETS,
  IDENTITY_TRANSFORM,
  IMAGE_DEFAULT_DURATION,
  isIdentityTransform,
  PROJECT_SCHEMA_VERSION,
  RESOLUTION_PRESETS,
  SHORT_PRESET,
  TEXT_DEFAULT_DURATION,
} from "./project/types.ts";

export {
  clipDuration,
  clipEnd,
  createProject,
  createTextAsset,
  findAsset,
  findClip,
  findTrack,
  sequenceDuration,
} from "./project/createProject.ts";
export { deserializeProject, ProjectFormatError, serializeProject } from "./project/serialize.ts";
export { DEFAULT_FONT_ID, FONT_REGISTRY, fontById, fontFileFor, resolveFontVariant } from "./project/fonts.ts";
export type { FontDefinition, FontVariantFiles } from "./project/fonts.ts";

export {
  addClip,
  addTrack,
  deleteClips,
  EditError,
  moveClip,
  removeTrack,
  reorderTrack,
  setClipMuted,
  setClipTransform,
  setTextAsset,
  setTrackFlag,
  splitClip,
  trimClip,
} from "./timeline/operations.ts";
export { audibleClips, clipAtTime, isEmpty, snapPoints, snapTime, visibleVideoClips } from "./timeline/queries.ts";
export { formatDuration, formatTimecode, frameDuration, snapToFrame } from "./timeline/time.ts";

export {
  AddClipCommand,
  AddTrackCommand,
  DeleteClipsCommand,
  MoveClipCommand,
  RemoveTrackCommand,
  ReorderTrackCommand,
  SetClipMutedCommand,
  SetClipTransformCommand,
  SetTextCommand,
  SetTrackFlagCommand,
  SplitClipCommand,
  TrimClipCommand,
} from "./commands/index.ts";
export type { Command } from "./commands/index.ts";
export { UndoStack } from "./undo/UndoStack.ts";

export { buildExportPlan, ExportError } from "./export/buildExportPlan.ts";
export type { ExportPlan, ExportPlanOptions } from "./export/buildExportPlan.ts";
export { buildFilmstripArgs, buildThumbnailArgs, buildWaveformArgs, FILMSTRIP_FRAME_COUNT } from "./export/ffmpegCommands.ts";

export { flushPendingSave, useEditorStore } from "./store/editorStore.ts";
export { PlaybackEngine } from "./playback/PlaybackEngine.ts";
export { computeTransformedBox } from "./playback/transformGeometry.ts";
export type { TransformedBox } from "./playback/transformGeometry.ts";
