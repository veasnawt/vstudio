/** Public surface of @veasna/vstudio.
 *
 *  Host applications should only need `VStudioApp` — everything else is exported because it's useful
 *  for tests, tooling, and the server routes that share the project model, not because a host is
 *  expected to reach for it. */

export { VStudioApp } from "./ui/VStudioApp.tsx";

export type { Asset, AssetKind, Clip, ClipTransform, ExportSettings, Project, Sequence, Track, TrackKind } from "./project/types.ts";
export {
  FPS_PRESETS,
  IDENTITY_TRANSFORM,
  IMAGE_DEFAULT_DURATION,
  isIdentityTransform,
  PROJECT_SCHEMA_VERSION,
  RESOLUTION_PRESETS,
  SHORT_PRESET,
} from "./project/types.ts";

export {
  clipDuration,
  clipEnd,
  createProject,
  findAsset,
  findClip,
  findTrack,
  sequenceDuration,
} from "./project/createProject.ts";
export { deserializeProject, ProjectFormatError, serializeProject } from "./project/serialize.ts";

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
  SetTrackFlagCommand,
  SplitClipCommand,
  TrimClipCommand,
} from "./commands/index.ts";
export type { Command } from "./commands/index.ts";
export { UndoStack } from "./undo/UndoStack.ts";

export { buildExportPlan, ExportError } from "./export/buildExportPlan.ts";
export type { ExportPlan, ExportPlanOptions } from "./export/buildExportPlan.ts";

export { flushPendingSave, useEditorStore } from "./store/editorStore.ts";
export { PlaybackEngine } from "./playback/PlaybackEngine.ts";
export { computeTransformedBox } from "./playback/transformGeometry.ts";
export type { TransformedBox } from "./playback/transformGeometry.ts";
