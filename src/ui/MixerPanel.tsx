"use client";

import { useEffect } from "react";
import { SetMasterGainCommand, SetTrackFlagCommand, SetTrackGainCommand, SetTrackPanCommand } from "../commands/index.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import type { Track } from "../project/types.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { LevelMeter } from "./LevelMeter.tsx";
import { RotaryKnob } from "./RotaryKnob.tsx";
import { VerticalFader } from "./VerticalFader.tsx";

/** How tall a channel strip's own fader+meter get — a fixed value rather than measuring the panel's
 *  actual row height (which the user can resize via the existing Timeline/Mixer divider): a real
 *  ResizeObserver-driven dynamic height would be the more polished answer, but is real extra machinery
 *  this v1 defers — a modest fixed height that fits comfortably within the row's own default bounds is
 *  enough to be usable today, at the cost of some unused space on a much taller row and vertical
 *  scrolling on a much shorter one (`overflow-y-auto` on the panel root below handles that case). */
const STRIP_FADER_HEIGHT_PX = 140;

/** The Pan knob's own full rendered footprint (the 32px circle, its gap, and the "L50/C/R50" readout
 *  line below it — measured directly against the real running control, not guessed from its Tailwind
 *  classes). The Master strip has no Pan knob (see its own comment on why), but reserves this exact
 *  amount of space in its place so its fader/meter start at the SAME height as every track strip's own
 *  — without this, Master's fader/meter would float lower than the tracks' (the gap a real pan knob
 *  would have occupied collapsing to nothing), which is what made the two look inconsistent before this
 *  fix rather than a deliberate "Master looks different" choice. */
const PAN_KNOB_FOOTPRINT_PX = 51;

/** The Mute/Solo button row's own rendered height (`MixerFlagButton`'s `min-h-[26px]`) — reserved as a
 *  bottom spacer on the Master strip for the same reason `PAN_KNOB_FOOTPRINT_PX` is reserved at the
 *  top: Master has no Mute/Solo (there's nothing to mute/solo about the whole mix), but every card in
 *  the row should still end at the SAME height, matching every real mixer's own uniform-strip
 *  convention, rather than Master's card visibly running shorter than the tracks next to it. */
const MUTE_SOLO_ROW_HEIGHT_PX = 26;

/** Same fixed-min-size toggle `TrackHeader.tsx`'s own `FlagButton` uses for Lock/Mute/Solo — kept as a
 *  separate copy rather than imported/shared, since that one is scoped to `TrackHeader`'s own cramped
 *  header-column width constraints (see its own comment on the "3 buttons in one row" budget) that
 *  don't apply here — each channel strip has a whole column's width to work with. */
function MixerFlagButton({
  active,
  onClick,
  label,
  children,
  activeClass,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
  activeClass: string;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`inline-flex min-h-[26px] min-w-[26px] items-center justify-center rounded text-[11px] font-semibold transition ${
        active ? activeClass : "text-white/35 hover:bg-white/10 hover:text-white/70"
      }`}
    >
      {children}
    </button>
  );
}

/** `formatValue` for the Pan knob — the standard pro-audio "L50/C/R50" readout, rather than a raw
 *  -1..1/percentage number nobody reads a mixer that way. */
function formatPan(pan: number): string {
  if (pan === 0) return "C";
  const percent = Math.round(Math.abs(pan) * 100);
  return pan < 0 ? `L${percent}` : `R${percent}`;
}

/** One audio track's vertical channel strip: name, Pan knob (`SetTrackPanCommand`), a dB-scaled fader
 *  paired with its own live level meter, and Mute/Solo at the bottom (`SetTrackFlagCommand` — the exact
 *  same command `TrackHeader.tsx` dispatches, so toggling here and there can never disagree). Gain and
 *  pan are both live-previewed while dragging via the matching `livePreview*` store fields — see their
 *  own doc comments for why: `PlaybackEngine.tick()` reads them every frame so the audio actually
 *  changes while you drag, not just once you release. */
function MixerChannelStrip({ track }: { track: Track }) {
  const t = useTranslation();
  const run = useEditorStore((s) => s.run);
  const setLivePreviewTrackGain = useEditorStore((s) => s.setLivePreviewTrackGain);
  const setLivePreviewTrackPan = useEditorStore((s) => s.setLivePreviewTrackPan);

  return (
    <div className="flex shrink-0 flex-col items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.025] px-4 py-3 shadow-sm shadow-black/20">
      <span className="max-w-[6.5rem] truncate text-xs font-medium text-white/80" title={track.name}>
        {track.name}
      </span>
      <RotaryKnob
        label={t("Pan")}
        value={track.pan ?? 0}
        min={-1}
        max={1}
        center={0}
        formatValue={formatPan}
        onPreview={(v) => setLivePreviewTrackPan({ trackId: track.id, pan: v })}
        onCommit={(v) => {
          setLivePreviewTrackPan(null);
          run(new SetTrackPanCommand(track.id, v));
        }}
      />
      <div className="flex items-end gap-1.5">
        <VerticalFader
          label={t("Volume")}
          gain={track.gain ?? 1}
          heightPx={STRIP_FADER_HEIGHT_PX}
          onPreview={(v) => setLivePreviewTrackGain({ trackId: track.id, gain: v })}
          onCommit={(v) => {
            setLivePreviewTrackGain(null);
            run(new SetTrackGainCommand(track.id, v));
          }}
        />
        <LevelMeter heightPx={STRIP_FADER_HEIGHT_PX} getLevelDb={() => useEditorStore.getState().playbackEngine?.getTrackLevelDb(track.id) ?? null} />
      </div>
      <div className="flex items-center gap-0.5">
        <MixerFlagButton
          active={track.muted}
          onClick={() => run(new SetTrackFlagCommand(track.id, "muted", !track.muted))}
          label={track.muted ? t("Unmute track") : t("Mute track")}
          activeClass="bg-rose-500/25 text-rose-300"
        >
          M
        </MixerFlagButton>
        <MixerFlagButton
          active={track.solo}
          onClick={() => run(new SetTrackFlagCommand(track.id, "solo", !track.solo))}
          label={track.solo ? t("Unsolo track") : t("Solo track")}
          activeClass="bg-emerald-500/25 text-emerald-300"
        >
          S
        </MixerFlagButton>
      </div>
    </div>
  );
}

/** The Audio Mixer — a non-modal panel that swaps into the Timeline's own row when toggled (see
 *  `VStudioApp.tsx`'s `bottomPanel` state), styled as a row of professional-NLE-style vertical channel
 *  strips: Pan knob, dB-scaled fader + live peak-hold meter, Mute/Solo, plus one Master strip (fader +
 *  meter only — panning the whole mix isn't a per-channel routing question the way it is for one
 *  track, see `Sequence.masterGain`'s own doc comment). Deliberately scoped to audio tracks only,
 *  matching every existing mute/solo/gain code path (`TrackHeader.tsx`, `audibleClips`, export) — a
 *  video track's own embedded audio isn't mixed from here. */
export function MixerPanel() {
  const t = useTranslation();
  const project = useEditorStore((s) => s.project);
  const run = useEditorStore((s) => s.run);
  const setLivePreviewTrackGain = useEditorStore((s) => s.setLivePreviewTrackGain);
  const setLivePreviewTrackPan = useEditorStore((s) => s.setLivePreviewTrackPan);
  const setLivePreviewMasterGain = useEditorStore((s) => s.setLivePreviewMasterGain);

  // A drag abandoned by switching back to Timeline mid-gesture shouldn't leave a stale live override
  // behind — the committed project value (whatever the last real `onCommit` landed, or nothing at all
  // if the drag never got that far) is what should keep driving the audio once this unmounts.
  useEffect(
    () => () => {
      setLivePreviewTrackGain(null);
      setLivePreviewTrackPan(null);
      setLivePreviewMasterGain(null);
    },
    [setLivePreviewTrackGain, setLivePreviewTrackPan, setLivePreviewMasterGain]
  );

  const audioTracks = project?.sequence.tracks.filter((track) => track.kind === "audio") ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0d0f14]">
      <div className="flex shrink-0 items-center border-b border-white/5 px-4 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-white/40">{t("Audio Mixer")}</h2>
      </div>

      {audioTracks.length === 0 ? (
        <p className="px-4 py-3 text-xs text-white/50">{t("No audio tracks yet — record a voiceover or add music to mix it here.")}</p>
      ) : (
        // The scrollable outer container stays full-width so tracks past the visible edge are still
        // reachable, but the actual strips live in an `mx-auto`'d inner wrapper — a flex ITEM with
        // auto margins centers itself in the leftover space without the "can't scroll back to the
        // start" bug plain `justify-content: center` has on an overflowing flex container. With few
        // tracks (the common case) this keeps the strips grouped in the middle of the row instead of
        // pinned to the left edge with a wall of empty space next to them. `items-start`, not
        // `items-stretch` — stretching Master's own (shorter, no Mute/Solo row) card to match a track
        // strip's height and then pushing its fader down to fill the leftover space is what caused
        // Master's fader/meter to visibly float lower than every track's own (a real inconsistency,
        // not a deliberate look) — see `PAN_KNOB_FOOTPRINT_PX`'s own comment for the actual fix.
        <div className="scrollbar-none flex min-h-0 flex-1 overflow-x-auto overflow-y-auto">
          <div className="mx-auto flex items-start gap-3 px-4 py-3">
            {audioTracks.map((track) => (
              <MixerChannelStrip key={track.id} track={track} />
            ))}

            {/* Visually separated from the per-track strips — the master fader always sits apart from
                the channel strips, the same convention a hardware mixing console uses. No Pan knob
                here: panning the summed mix isn't the same kind of per-channel control. A slightly
                brighter card + a divider ahead of it (rather than just the divider alone) is what
                actually reads as "the one that's different," not just "one more strip in the row." */}
            <div className="ml-1 flex shrink-0 pl-4" style={{ borderLeft: "1px solid rgba(255,255,255,0.08)" }}>
              <div className="flex flex-col items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-4 py-3 shadow-sm shadow-black/20">
                <span className="text-xs font-semibold text-white/80">{t("Master")}</span>
                {/* Invisible stand-in for the Pan knob every track strip has above its own fader — see
                    `PAN_KNOB_FOOTPRINT_PX`'s own comment for why this needs to exist at all. */}
                <div aria-hidden style={{ height: PAN_KNOB_FOOTPRINT_PX }} />
                <div className="flex items-end gap-1.5">
                  <VerticalFader
                    label={t("Volume")}
                    gain={project?.sequence.masterGain ?? 1}
                    heightPx={STRIP_FADER_HEIGHT_PX}
                    onPreview={(v) => setLivePreviewMasterGain(v)}
                    onCommit={(v) => {
                      setLivePreviewMasterGain(null);
                      run(new SetMasterGainCommand(v));
                    }}
                  />
                  <LevelMeter heightPx={STRIP_FADER_HEIGHT_PX} getLevelDb={() => useEditorStore.getState().playbackEngine?.getMasterLevelDb() ?? null} />
                </div>
                {/* Invisible stand-in for the Mute/Solo row every track strip ends with — see
                    `MUTE_SOLO_ROW_HEIGHT_PX`'s own comment for why this needs to exist at all. */}
                <div aria-hidden style={{ height: MUTE_SOLO_ROW_HEIGHT_PX }} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
