"use client";

import React from "react";
import { SetClipMutedCommand, SetClipTransformCommand } from "../commands/index.ts";
import { clipDuration, findAsset, findClip } from "../project/createProject.ts";
import type { ClipTransform } from "../project/types.ts";
import { IDENTITY_TRANSFORM } from "../project/types.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { formatTimecode } from "../timeline/time.ts";
import { NumberField } from "./NumberField.tsx";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-1">
      <span className="text-[11px] text-white/45">{label}</span>
      <span className="font-mono text-[11px] tabular-nums text-white/85">{value}</span>
    </div>
  );
}

/** Properties for the current selection — timeline/source facts are read-only (renaming a clip's
 *  position happens by dragging it, not typing here), while Position/Scale/Rotation/Crop are real,
 *  wired-up, undo-able controls. Keyframes and effects are still out of scope: this transform is a
 *  single static value per clip, not something that can animate over the clip's duration. */
export function Inspector() {
  const project = useEditorStore((s) => s.project);
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds);
  const run = useEditorStore((s) => s.run);

  const selectedId = selectedClipIds[0];
  const found = project && selectedId ? findClip(project, selectedId) : undefined;
  const fps = project?.sequence.fps ?? 30;

  /** Reads the clip's current transform (defaulting to identity), patches ONE field, and dispatches
   *  it as a single command — this is the one place every transform field commits through, so
   *  clamping (in `setClipTransform`) and undo grouping stay consistent regardless of which field the
   *  user touched. */
  function patchTransform(clipId: string, patch: Partial<ClipTransform>) {
    const current = found?.clip.transform ?? IDENTITY_TRANSFORM;
    run(new SetClipTransformCommand(clipId, { ...current, ...patch }));
  }

  function patchCrop(clipId: string, patch: Partial<ClipTransform["crop"]>) {
    const current = found?.clip.transform ?? IDENTITY_TRANSFORM;
    run(new SetClipTransformCommand(clipId, { ...current, crop: { ...current.crop, ...patch } }));
  }

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-white/10 bg-[#0d0f14]">
      <header className="border-b border-white/10 px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-white/60">Properties</h2>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!found ? (
          <p className="text-center text-[11px] leading-relaxed text-white/35">
            {selectedClipIds.length > 1
              ? `${selectedClipIds.length} clips selected`
              : "Select a clip to see its properties"}
          </p>
        ) : (
          (() => {
            const { clip, track } = found;
            const asset = findAsset(project!, clip.assetId);
            return (
              <div className="space-y-4">
                <div>
                  <p className="truncate text-xs font-medium text-white/90">{asset?.name ?? "Missing media"}</p>
                  <p className="text-[11px] text-white/40">{track.name}</p>
                </div>

                {/* Audio has nothing visual to position/scale/rotate/crop — the section simply isn't
                    shown for a clip on an audio track, rather than showing controls with no effect. */}
                {track.kind === "video" && (
                  <div className="border-t border-white/10 pt-2">
                    <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-white/35">
                      Transform
                    </h3>
                    {(() => {
                      const transform = clip.transform ?? IDENTITY_TRANSFORM;
                      return (
                        <>
                          <NumberField
                            label="Position X"
                            value={transform.offsetX}
                            suffix="px"
                            step={5}
                            onCommit={(v) => patchTransform(clip.id, { offsetX: v })}
                          />
                          <NumberField
                            label="Position Y"
                            value={transform.offsetY}
                            suffix="px"
                            step={5}
                            onCommit={(v) => patchTransform(clip.id, { offsetY: v })}
                          />
                          <NumberField
                            label="Scale"
                            value={transform.scale}
                            suffix="%"
                            step={5}
                            toDisplay={(v) => v * 100}
                            fromDisplay={(v) => v / 100}
                            onCommit={(v) => patchTransform(clip.id, { scale: v })}
                          />
                          <NumberField
                            label="Rotation"
                            value={transform.rotationDeg}
                            suffix="°"
                            step={1}
                            onCommit={(v) => patchTransform(clip.id, { rotationDeg: v })}
                          />
                          <p className="mb-1 mt-2 text-[10px] font-semibold uppercase tracking-wide text-white/25">
                            Crop
                          </p>
                          <NumberField
                            label="Top"
                            value={transform.crop.top}
                            suffix="%"
                            step={1}
                            toDisplay={(v) => v * 100}
                            fromDisplay={(v) => v / 100}
                            onCommit={(v) => patchCrop(clip.id, { top: v })}
                          />
                          <NumberField
                            label="Right"
                            value={transform.crop.right}
                            suffix="%"
                            step={1}
                            toDisplay={(v) => v * 100}
                            fromDisplay={(v) => v / 100}
                            onCommit={(v) => patchCrop(clip.id, { right: v })}
                          />
                          <NumberField
                            label="Bottom"
                            value={transform.crop.bottom}
                            suffix="%"
                            step={1}
                            toDisplay={(v) => v * 100}
                            fromDisplay={(v) => v / 100}
                            onCommit={(v) => patchCrop(clip.id, { bottom: v })}
                          />
                          <NumberField
                            label="Left"
                            value={transform.crop.left}
                            suffix="%"
                            step={1}
                            toDisplay={(v) => v * 100}
                            fromDisplay={(v) => v / 100}
                            onCommit={(v) => patchCrop(clip.id, { left: v })}
                          />
                          {clip.transform && (
                            <button
                              onClick={() => run(new SetClipTransformCommand(clip.id, IDENTITY_TRANSFORM))}
                              className="mt-2 w-full rounded bg-white/5 py-1 text-[11px] text-white/60 transition hover:bg-white/10 hover:text-white"
                            >
                              Reset transform
                            </button>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}

                {/* Shown for any clip whose asset actually has audio to mute, on either a video or an
                    audio track — a video clip's own embedded sound and a music/voiceover clip are the
                    same kind of toggle, just living on different track kinds. */}
                {asset?.hasAudio && (
                  <div className="border-t border-white/10 pt-2">
                    <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-white/35">Audio</h3>
                    <label className="flex items-center justify-between gap-2 py-1 text-[11px] text-white/70">
                      <span>Mute clip</span>
                      <input
                        type="checkbox"
                        checked={clip.mutedAudio ?? false}
                        onChange={(e) => run(new SetClipMutedCommand(clip.id, e.target.checked))}
                      />
                    </label>
                  </div>
                )}

                <div className="border-t border-white/10 pt-2">
                  <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-white/35">Timeline</h3>
                  <Row label="Start" value={formatTimecode(clip.timelineStart, fps)} />
                  <Row label="End" value={formatTimecode(clip.timelineStart + clipDuration(clip), fps)} />
                  <Row label="Duration" value={formatTimecode(clipDuration(clip), fps)} />
                </div>

                <div className="border-t border-white/10 pt-2">
                  <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-white/35">Source</h3>
                  <Row label="In" value={formatTimecode(clip.sourceIn, fps)} />
                  <Row label="Out" value={formatTimecode(clip.sourceOut, fps)} />
                  {asset && <Row label="Full length" value={formatTimecode(asset.duration, fps)} />}
                </div>

                {asset && (asset.width || asset.fps) && (
                  <div className="border-t border-white/10 pt-2">
                    <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-white/35">Media</h3>
                    {asset.width && asset.height && <Row label="Size" value={`${asset.width}×${asset.height}`} />}
                    {asset.fps && <Row label="Rate" value={`${Math.round(asset.fps)} fps`} />}
                    <Row label="Audio" value={asset.hasAudio ? "Yes" : "No"} />
                  </div>
                )}
              </div>
            );
          })()
        )}
      </div>
    </aside>
  );
}
