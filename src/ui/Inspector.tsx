"use client";

import React, { useEffect, useState } from "react";
import {
  SetClipEffectsCommand,
  SetClipGainCommand,
  SetClipMutedCommand,
  SetClipTransformCommand,
  SetClipTransitionCommand,
  SetTextCommand,
} from "../commands/index.ts";
import { clipDuration, findAsset, findClip } from "../project/createProject.ts";
import { FONT_REGISTRY, fontById } from "../project/fonts.ts";
import type { ClipEffects, ClipTransform, TextStyle } from "../project/types.ts";
import { DEFAULT_TEXT_STYLE, IDENTITY_EFFECTS, IDENTITY_TRANSFORM } from "../project/types.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { formatTimecode } from "../timeline/time.ts";
import { DEFAULT_TRANSITION, findTransitionCandidate } from "../timeline/transitions.ts";
import { Dropdown } from "./Dropdown.tsx";
import { NumberField } from "./NumberField.tsx";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-1.5">
      <span className="text-[12px] text-white/50">{label}</span>
      <span className="font-mono text-[12px] tabular-nums text-white/85">{value}</span>
    </div>
  );
}

/** A section header — a small colored dot as a scannable per-section accent (Transform/Effects/etc.
 *  each get a distinct hue) plus the label, at a size that actually reads as a heading rather than
 *  blending into the field labels beneath it. */
function SectionHeader({ children, accent = "bg-sky-400" }: { children: React.ReactNode; accent?: string }) {
  return (
    <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-white/45">
      <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${accent}`} />
      {children}
    </h3>
  );
}

/** A multi-line text field that commits on blur, not per-keystroke — same reasoning as `NumberField`:
 *  committing every keystroke would push a new `SetTextCommand` (and undo-stack entry) per character,
 *  so undoing "typed a caption" would take one step per letter instead of one. */
function TextContentField({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(value);
    // Only the real value should resync the field — see NumberField's identical note on why
    // `focused` itself must not be a dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <textarea
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        if (text !== value) onCommit(text);
      }}
      rows={3}
      placeholder="Text"
      // 16px below `lg` to avoid iOS Safari's focus-zoom — same reasoning as every other text input
      // in this app (see MediaLibrary's search box).
      className="w-full resize-none rounded bg-white/5 px-2.5 py-2 text-[16px] text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-sky-400/60 lg:text-[13px]"
    />
  );
}

function AlignButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded px-2 py-1.5 text-[12px] capitalize transition ${
        active ? "bg-sky-500/30 text-white" : "bg-white/5 text-white/60 hover:bg-white/10"
      }`}
    >
      {children}
    </button>
  );
}

/** Properties for the current selection — timeline/source facts are read-only (renaming a clip's
 *  position happens by dragging it, not typing here), while Position/Scale/Rotation/Crop and
 *  Brightness/Contrast/Saturation/Blur/Opacity are real, wired-up, undo-able controls. Keyframes are
 *  still out of scope: transform and effects are each a single static value per clip, not something
 *  that can animate over the clip's duration. */
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

  /** Same pattern as `patchTransform`, for `ClipEffects` instead. */
  function patchEffects(clipId: string, patch: Partial<ClipEffects>) {
    const current = found?.clip.effects ?? IDENTITY_EFFECTS;
    run(new SetClipEffectsCommand(clipId, { ...current, ...patch }));
  }

  /** Reads the asset's current content+style, patches ONE field, and dispatches it as a single
   *  command — same pattern as `patchTransform`, except addressed by ASSET id: content/style live on
   *  the text asset itself, not the clip (see `Asset.textContent`'s own doc comment). */
  function patchTextStyle(assetId: string, content: string, patch: Partial<TextStyle>) {
    const current = project?.assets.find((a) => a.id === assetId)?.textStyle ?? DEFAULT_TEXT_STYLE;
    run(new SetTextCommand(assetId, content, { ...current, ...patch }));
  }

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-white/10 bg-[#0d0f14]">
      <header className="border-b border-white/10 px-3 py-2.5">
        <h2 className="text-[13px] font-semibold uppercase tracking-wider text-white/70">Properties</h2>
      </header>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-3.5">
        {!found ? (
          <p className="text-center text-[12px] leading-relaxed text-white/35">
            {selectedClipIds.length > 1
              ? `${selectedClipIds.length} clips selected`
              : "Select a clip to see its properties"}
          </p>
        ) : (
          (() => {
            const { clip, track } = found;
            const asset = findAsset(project!, clip.assetId);
            return (
              <div className="space-y-5">
                <div>
                  <p className="truncate text-[13px] font-semibold text-white/90">{asset?.name ?? "Missing media"}</p>
                  <p className="text-[12px] text-white/40">{track.name}</p>
                </div>

                {/* Text has no video content to Transform (no scale/rotation/crop — font size already
                    covers "how big", and the position it DOES have is a simpler offsetX/offsetY pair
                    living on the asset's own style, not the video/image ClipTransform system — see
                    TextStyle's own doc comment for why). */}
                {asset?.kind === "text" && (
                  <div className="border-t border-white/10 pt-2">
                    <SectionHeader accent="bg-violet-400">Text</SectionHeader>
                    <TextContentField
                      value={asset.textContent ?? ""}
                      onCommit={(content) => run(new SetTextCommand(asset.id, content, asset.textStyle ?? DEFAULT_TEXT_STYLE))}
                    />
                    {(() => {
                      const style = asset.textStyle ?? DEFAULT_TEXT_STYLE;
                      const content = asset.textContent ?? "";
                      const font = fontById(style.fontFamily);
                      return (
                        <>
                          {/* A plain `<div>`, not `<label>` — a `<label>` wrapping a `<button>` (the
                              Dropdown's own toggle) makes the BROWSER forward any click landing
                              anywhere inside it to that button natively, per HTML's label-forwarding
                              behavior. That includes clicks on the popup's OWN options once it's open
                              (still a DOM descendant of this wrapper), which re-toggled the button
                              immediately after a selection closed it — confirmed the hard way: the
                              dropdown reopened itself right after picking an option. The Dropdown's own
                              `ariaLabel` prop already gives the button its accessible name, so the
                              `<label>` wasn't buying anything a `<span>` here doesn't already provide. */}
                          <div className="flex items-center justify-between gap-2 py-1.5">
                            <span className="text-[12px] text-white/50">Font</span>
                            <Dropdown
                              value={style.fontFamily}
                              onChange={(v) => patchTextStyle(asset.id, content, { fontFamily: v })}
                              ariaLabel="Font"
                              className="min-w-0 flex-1 text-[13px]"
                              options={FONT_REGISTRY.map((f) => ({
                                value: f.id,
                                label: f.label,
                                style: { fontFamily: `"${f.cssFamily}"` },
                              }))}
                            />
                          </div>
                          <NumberField
                            label="Size"
                            value={style.fontSize}
                            suffix="px"
                            step={2}
                            onCommit={(v) => patchTextStyle(asset.id, content, { fontSize: v })}
                          />
                          <label className="flex items-center justify-between gap-2 py-1.5">
                            <span className="text-[12px] text-white/50">Color</span>
                            <input
                              type="color"
                              value={style.color}
                              onChange={(e) => patchTextStyle(asset.id, content, { color: e.target.value })}
                              className="h-7 w-11 cursor-pointer rounded border border-white/10 bg-transparent"
                            />
                          </label>
                          <div className="flex items-center gap-1 py-1.5">
                            <button
                              onClick={() => patchTextStyle(asset.id, content, { bold: !style.bold })}
                              aria-pressed={style.bold}
                              // No bundled file to show it with (`font.files.bold` is missing — Moul,
                              // for instance) isn't reason to hide the toggle: the intent still saves,
                              // and applies the moment the user switches to a font that DOES have one.
                              // Dimmed, not disabled, to say "saved but has no effect right now".
                              title={font.files.bold ? undefined : `${font.label} has no bold face — this won't change how it looks`}
                              className={`flex-1 rounded px-2 py-1.5 text-[12px] font-bold transition ${
                                style.bold ? "bg-sky-500/30 text-white" : "bg-white/5 text-white/60 hover:bg-white/10"
                              } ${font.files.bold ? "" : "opacity-40"}`}
                            >
                              B
                            </button>
                            <button
                              onClick={() => patchTextStyle(asset.id, content, { italic: !style.italic })}
                              aria-pressed={style.italic}
                              title={font.files.italic ? undefined : `${font.label} has no italic face — this won't change how it looks`}
                              className={`flex-1 rounded px-2 py-1.5 text-[12px] italic transition ${
                                style.italic ? "bg-sky-500/30 text-white" : "bg-white/5 text-white/60 hover:bg-white/10"
                              } ${font.files.italic ? "" : "opacity-40"}`}
                            >
                              I
                            </button>
                          </div>
                          <div className="flex items-center gap-1 py-1.5">
                            {(["left", "center", "right"] as const).map((align) => (
                              <AlignButton
                                key={align}
                                active={style.align === align}
                                onClick={() => patchTextStyle(asset.id, content, { align })}
                              >
                                {align}
                              </AlignButton>
                            ))}
                          </div>
                          <label className="flex items-center justify-between gap-2 py-1.5 text-[12px] text-white/70">
                            <span>Background</span>
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5 accent-sky-400"
                              checked={Boolean(style.backgroundColor)}
                              onChange={(e) =>
                                patchTextStyle(asset.id, content, {
                                  backgroundColor: e.target.checked ? "#000000" : undefined,
                                })
                              }
                            />
                          </label>
                          {style.backgroundColor && (
                            <label className="flex items-center justify-between gap-2 py-1.5">
                              <span className="text-[12px] text-white/50">Background color</span>
                              <input
                                type="color"
                                value={style.backgroundColor}
                                onChange={(e) => patchTextStyle(asset.id, content, { backgroundColor: e.target.value })}
                                className="h-7 w-11 cursor-pointer rounded border border-white/10 bg-transparent"
                              />
                            </label>
                          )}
                          <label className="flex items-center justify-between gap-2 py-1.5 text-[12px] text-white/70">
                            <span>Outline</span>
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5 accent-sky-400"
                              checked={Boolean(style.strokeColor)}
                              onChange={(e) =>
                                patchTextStyle(asset.id, content, {
                                  strokeColor: e.target.checked ? "#000000" : undefined,
                                })
                              }
                            />
                          </label>
                          {style.strokeColor && (
                            <>
                              <label className="flex items-center justify-between gap-2 py-1.5">
                                <span className="text-[12px] text-white/50">Outline color</span>
                                <input
                                  type="color"
                                  value={style.strokeColor}
                                  onChange={(e) => patchTextStyle(asset.id, content, { strokeColor: e.target.value })}
                                  className="h-7 w-11 cursor-pointer rounded border border-white/10 bg-transparent"
                                />
                              </label>
                              <NumberField
                                label="Outline width"
                                value={style.strokeWidth}
                                suffix="px"
                                step={1}
                                onCommit={(v) => patchTextStyle(asset.id, content, { strokeWidth: v })}
                              />
                            </>
                          )}
                          <label className="flex items-center justify-between gap-2 py-1.5 text-[12px] text-white/70">
                            <span>Shadow</span>
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5 accent-sky-400"
                              checked={Boolean(style.shadowColor)}
                              onChange={(e) =>
                                patchTextStyle(asset.id, content, {
                                  shadowColor: e.target.checked ? "#000000" : undefined,
                                })
                              }
                            />
                          </label>
                          {style.shadowColor && (
                            <>
                              <label className="flex items-center justify-between gap-2 py-1.5">
                                <span className="text-[12px] text-white/50">Shadow color</span>
                                <input
                                  type="color"
                                  value={style.shadowColor}
                                  onChange={(e) => patchTextStyle(asset.id, content, { shadowColor: e.target.value })}
                                  className="h-7 w-11 cursor-pointer rounded border border-white/10 bg-transparent"
                                />
                              </label>
                              <NumberField
                                label="Shadow X"
                                value={style.shadowOffsetX}
                                suffix="px"
                                step={1}
                                onCommit={(v) => patchTextStyle(asset.id, content, { shadowOffsetX: v })}
                              />
                              <NumberField
                                label="Shadow Y"
                                value={style.shadowOffsetY}
                                suffix="px"
                                step={1}
                                onCommit={(v) => patchTextStyle(asset.id, content, { shadowOffsetY: v })}
                              />
                            </>
                          )}
                          <NumberField
                            label="Line spacing"
                            value={style.lineHeightMultiplier}
                            step={0.1}
                            onCommit={(v) => patchTextStyle(asset.id, content, { lineHeightMultiplier: v })}
                          />
                          <p className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-white/30">
                            Position
                          </p>
                          <NumberField
                            label="Offset X"
                            value={style.offsetX}
                            suffix="px"
                            step={5}
                            onCommit={(v) => patchTextStyle(asset.id, content, { offsetX: v })}
                          />
                          <NumberField
                            label="Offset Y"
                            value={style.offsetY}
                            suffix="px"
                            step={5}
                            onCommit={(v) => patchTextStyle(asset.id, content, { offsetY: v })}
                          />
                          <NumberField
                            label="Rotation"
                            value={style.rotationDeg}
                            suffix="°"
                            step={1}
                            onCommit={(v) => patchTextStyle(asset.id, content, { rotationDeg: v })}
                          />
                        </>
                      );
                    })()}
                  </div>
                )}

                {/* Audio has nothing visual to position/scale/rotate/crop — the section simply isn't
                    shown for a clip on an audio track, rather than showing controls with no effect. */}
                {track.kind === "video" && (
                  <div className="border-t border-white/10 pt-3">
                    <SectionHeader accent="bg-sky-400">Transform</SectionHeader>
                    {(() => {
                      const transform = clip.transform ?? IDENTITY_TRANSFORM;
                      return (
                        <>
                          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-white/30">
                            Position
                          </p>
                          {/* X/Y paired on one row, like Figma/Photoshop's coordinate fields — reads as
                              one "where" concept instead of two unrelated-looking stacked rows, and
                              saves vertical space now that Rotation below has its own quick-angle row. */}
                          <div className="flex gap-3">
                            <div className="flex-1">
                              <NumberField
                                label="X"
                                value={transform.offsetX}
                                suffix="px"
                                step={5}
                                compact
                                onCommit={(v) => patchTransform(clip.id, { offsetX: v })}
                              />
                            </div>
                            <div className="flex-1">
                              <NumberField
                                label="Y"
                                value={transform.offsetY}
                                suffix="px"
                                step={5}
                                compact
                                onCommit={(v) => patchTransform(clip.id, { offsetY: v })}
                              />
                            </div>
                          </div>

                          <p className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-white/30">
                            Scale
                          </p>
                          <NumberField
                            label="Scale"
                            value={transform.scale}
                            suffix="%"
                            step={5}
                            onCommit={(v) => patchTransform(clip.id, { scale: v })}
                            toDisplay={(v) => v * 100}
                            fromDisplay={(v) => v / 100}
                          />
                          {transform.scale !== 1 && (
                            <button
                              onClick={() => patchTransform(clip.id, { scale: 1 })}
                              className="mt-1 rounded bg-white/5 px-2.5 py-1 text-[11px] text-white/60 transition hover:bg-white/10 hover:text-white"
                            >
                              Reset to 100%
                            </button>
                          )}

                          <p className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-white/30">
                            Rotation
                          </p>
                          <NumberField
                            label="Angle"
                            value={transform.rotationDeg}
                            suffix="°"
                            step={1}
                            onCommit={(v) => patchTransform(clip.id, { rotationDeg: v })}
                          />
                          {/* Quick rotate-by-90° and reset-to-0° — the common case (a portrait clip on a
                              landscape sequence, or vice versa) needs exactly one of these, not typing
                              "90" by hand every time. Rotation is intentionally unclamped (see
                              ClipTransform's own doc comment on why it isn't limited to -180..180 the
                              way a slider would need), so ±90 just keeps adding/subtracting rather than
                              wrapping — a clip already at 350° and rotated +90 lands at 440°, which
                              renders identically to 80° but preserves "how many turns" if that mattered
                              to the user. */}
                          <div className="mt-1.5 flex gap-1.5">
                            <button
                              onClick={() => patchTransform(clip.id, { rotationDeg: transform.rotationDeg - 90 })}
                              title="Rotate 90° counter-clockwise"
                              className="flex-1 rounded bg-white/5 py-1 text-[12px] text-white/70 transition hover:bg-white/10 hover:text-white"
                            >
                              −90°
                            </button>
                            <button
                              onClick={() => patchTransform(clip.id, { rotationDeg: 0 })}
                              title="Reset rotation to 0°"
                              disabled={transform.rotationDeg === 0}
                              className="flex-1 rounded bg-white/5 py-1 text-[12px] text-white/70 transition hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-30 disabled:hover:bg-white/5"
                            >
                              0°
                            </button>
                            <button
                              onClick={() => patchTransform(clip.id, { rotationDeg: transform.rotationDeg + 90 })}
                              title="Rotate 90° clockwise"
                              className="flex-1 rounded bg-white/5 py-1 text-[12px] text-white/70 transition hover:bg-white/10 hover:text-white"
                            >
                              +90°
                            </button>
                          </div>
                          <p className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-white/30">
                            Crop
                          </p>
                          <NumberField
                            label="Top"
                            value={transform.crop.top}
                            suffix="%"
                            step={1}
                            min={0}
                            max={100}
                            toDisplay={(v) => v * 100}
                            fromDisplay={(v) => v / 100}
                            onCommit={(v) => patchCrop(clip.id, { top: v })}
                          />
                          <NumberField
                            label="Right"
                            value={transform.crop.right}
                            suffix="%"
                            step={1}
                            min={0}
                            max={100}
                            toDisplay={(v) => v * 100}
                            fromDisplay={(v) => v / 100}
                            onCommit={(v) => patchCrop(clip.id, { right: v })}
                          />
                          <NumberField
                            label="Bottom"
                            value={transform.crop.bottom}
                            suffix="%"
                            step={1}
                            min={0}
                            max={100}
                            toDisplay={(v) => v * 100}
                            fromDisplay={(v) => v / 100}
                            onCommit={(v) => patchCrop(clip.id, { bottom: v })}
                          />
                          <NumberField
                            label="Left"
                            value={transform.crop.left}
                            suffix="%"
                            step={1}
                            min={0}
                            max={100}
                            toDisplay={(v) => v * 100}
                            fromDisplay={(v) => v / 100}
                            onCommit={(v) => patchCrop(clip.id, { left: v })}
                          />
                          {clip.transform && (
                            <button
                              onClick={() => run(new SetClipTransformCommand(clip.id, IDENTITY_TRANSFORM))}
                              className="mt-2.5 w-full rounded bg-white/5 py-1.5 text-[12px] text-white/60 transition hover:bg-white/10 hover:text-white"
                            >
                              Reset transform
                            </button>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}

                {/* Same video/image-only scope as Transform above (audio has nothing to color-adjust,
                    text has its own separate TextStyle system) — static per-clip values, not yet
                    animatable over the clip's duration (see ClipEffects's own doc comment for the
                    preview/export approximation notes on brightness/blur specifically). */}
                {track.kind === "video" && (
                  <div className="border-t border-white/10 pt-3">
                    <SectionHeader accent="bg-amber-400">Effects</SectionHeader>
                    {(() => {
                      const effects = clip.effects ?? IDENTITY_EFFECTS;
                      return (
                        <>
                          <NumberField
                            label="Brightness"
                            value={effects.brightness}
                            suffix="%"
                            step={5}
                            min={-100}
                            max={100}
                            toDisplay={(v) => v * 100}
                            fromDisplay={(v) => v / 100}
                            onCommit={(v) => patchEffects(clip.id, { brightness: v })}
                          />
                          <NumberField
                            label="Contrast"
                            value={effects.contrast}
                            suffix="%"
                            step={5}
                            min={0}
                            max={200}
                            toDisplay={(v) => v * 100}
                            fromDisplay={(v) => v / 100}
                            onCommit={(v) => patchEffects(clip.id, { contrast: v })}
                          />
                          <NumberField
                            label="Saturation"
                            value={effects.saturation}
                            suffix="%"
                            step={5}
                            min={0}
                            max={200}
                            toDisplay={(v) => v * 100}
                            fromDisplay={(v) => v / 100}
                            onCommit={(v) => patchEffects(clip.id, { saturation: v })}
                          />
                          <NumberField
                            label="Blur"
                            value={effects.blur}
                            suffix="px"
                            step={1}
                            min={0}
                            max={20}
                            onCommit={(v) => patchEffects(clip.id, { blur: v })}
                          />
                          <NumberField
                            label="Opacity"
                            value={effects.opacity}
                            suffix="%"
                            step={5}
                            min={0}
                            max={100}
                            toDisplay={(v) => v * 100}
                            fromDisplay={(v) => v / 100}
                            onCommit={(v) => patchEffects(clip.id, { opacity: v })}
                          />
                          {clip.effects && (
                            <button
                              onClick={() => run(new SetClipEffectsCommand(clip.id, IDENTITY_EFFECTS))}
                              className="mt-2.5 w-full rounded bg-white/5 py-1.5 text-[12px] text-white/60 transition hover:bg-white/10 hover:text-white"
                            >
                              Reset effects
                            </button>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}

                {/* Shown only when there's genuinely a preceding, zero-gap clip on this track to
                    crossfade FROM — `findTransitionCandidate` is the adjacency-only half of
                    `findTransitionPartner` (see its own doc comment), used here instead since a
                    disabled transition has no `transitionIn` yet for the full check to key off. */}
                {track.kind === "video" &&
                  (() => {
                    const candidate = findTransitionCandidate(track, clip);
                    if (!candidate) return null;
                    const transitionIn = clip.transitionIn;
                    return (
                      <div className="border-t border-white/10 pt-3">
                        <SectionHeader accent="bg-fuchsia-400">Transition In</SectionHeader>
                        <label className="flex items-center justify-between gap-2 py-1.5 text-[12px] text-white/70">
                          <span>Crossfade from previous clip</span>
                          <input
                            type="checkbox"
                              className="h-3.5 w-3.5 accent-sky-400"
                            checked={!!transitionIn}
                            onChange={(e) =>
                              run(new SetClipTransitionCommand(clip.id, e.target.checked ? DEFAULT_TRANSITION : null))
                            }
                          />
                        </label>
                        {transitionIn && (
                          <NumberField
                            label="Duration"
                            value={transitionIn.duration}
                            suffix="s"
                            step={0.1}
                            onCommit={(v) => run(new SetClipTransitionCommand(clip.id, { ...transitionIn, duration: v }))}
                          />
                        )}
                      </div>
                    );
                  })()}

                {/* Shown for any clip whose asset actually has audio to mute, on either a video or an
                    audio track — a video clip's own embedded sound and a music/voiceover clip are the
                    same kind of toggle, just living on different track kinds. */}
                {asset?.hasAudio && (
                  <div className="border-t border-white/10 pt-3">
                    <SectionHeader accent="bg-rose-400">Audio</SectionHeader>
                    <label className="flex items-center justify-between gap-2 py-1.5 text-[12px] text-white/70">
                      <span>Mute clip</span>
                      <input
                        type="checkbox"
                              className="h-3.5 w-3.5 accent-sky-400"
                        checked={clip.mutedAudio ?? false}
                        onChange={(e) => run(new SetClipMutedCommand(clip.id, e.target.checked))}
                      />
                    </label>
                    {/* Independent of Mute above — see `Clip.gain`'s own doc comment on why the two
                        compose rather than one replacing the other. Capped at 100%, not a wider
                        amplification range: the preview plays back through a plain element's native
                        `.volume`, which the browser itself caps at 1. */}
                    <NumberField
                      label="Volume"
                      value={clip.gain ?? 1}
                      suffix="%"
                      step={5}
                      min={0}
                      max={100}
                      toDisplay={(v) => v * 100}
                      fromDisplay={(v) => v / 100}
                      onCommit={(v) => run(new SetClipGainCommand(clip.id, v))}
                    />
                  </div>
                )}

                <div className="border-t border-white/10 pt-3">
                  <SectionHeader accent="bg-white/30">Timeline</SectionHeader>
                  <Row label="Start" value={formatTimecode(clip.timelineStart, fps)} />
                  <Row label="End" value={formatTimecode(clip.timelineStart + clipDuration(clip), fps)} />
                  <Row label="Duration" value={formatTimecode(clipDuration(clip), fps)} />
                </div>

                <div className="border-t border-white/10 pt-3">
                  <SectionHeader accent="bg-white/30">Source</SectionHeader>
                  <Row label="In" value={formatTimecode(clip.sourceIn, fps)} />
                  <Row label="Out" value={formatTimecode(clip.sourceOut, fps)} />
                  {asset && <Row label="Full length" value={formatTimecode(asset.duration, fps)} />}
                </div>

                {asset && (asset.width || asset.fps) && (
                  <div className="border-t border-white/10 pt-3">
                    <SectionHeader accent="bg-white/30">Media</SectionHeader>
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
