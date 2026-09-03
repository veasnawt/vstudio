import type { Clip } from "../project/types.ts";
import { detectRealSeek, lruEvict } from "./audioScheduling.ts";

/** Same shape `PlaybackEngine.activeAudioClips` already returns — declared here (not imported from
 *  there) to avoid a circular import; `PlaybackEngine` composes an `AudioMixEngine` instance, not the
 *  other way around. */
export interface ActiveAudioTrackClip {
  /** Which track this clip is playing on — needed to route its own `GainNode` through the right
   *  shared per-track node (see `trackGainNodes`), not folded into `gain` itself: track gain is
   *  applied downstream by that shared node, not baked into this per-clip scalar. */
  trackId: string;
  clip: Clip;
  sourceTime: number;
  gain: number;
}

/** How far an already-scheduled audio-track clip's expected position may drift from where it actually
 *  is before it's treated as a genuine scrub/jump and restarted — see `detectRealSeek`'s own doc
 *  comment. Deliberately generous: an `AudioBufferSourceNode` has no per-frame polling loop to misfire
 *  the way the old element-based sync did, so this only ever needs to catch a REAL discontinuity, not
 *  routine clock noise. */
const SEEK_DETECTION_TOLERANCE = 0.15;
/** Time constant for `AudioParam.setTargetAtTime`'s exponential approach — used everywhere a gain
 *  value is set from a freshly-computed per-tick target (video-clip gain, audio-track clip gain),
 *  instead of a bare `.value =` assignment, specifically to avoid "zipper noise": an abrupt sample-to-
 *  sample jump in a control signal is audible as a soft click/buzz on some hardware even when the
 *  underlying VALUE change is small and intentional (a gain slider being dragged, a transition ramp
 *  advancing frame to frame). ~15ms is fast enough that a real fade still tracks its target closely,
 *  slow enough to smooth out the graininess of only updating once per animation frame. */
const GAIN_SMOOTHING_TIME_CONSTANT = 0.015;
/** How long `duckAroundSeek`'s silence ramp takes — see its own doc comment for why this exists at
 *  all. Short enough to read as a quick dip, not a dropout of its own. */
const DUCK_RAMP_SECONDS = 0.015;
/** Decoded `AudioBuffer`s kept resident at once. A stereo 48kHz buffer is roughly 370KB per second of
 *  audio — this bounds memory for a project with several multi-minute music beds without needing to
 *  track raw byte counts; tune-able if real projects prove it too small/large. */
const BUFFER_CACHE_LIMIT = 12;

interface TrackClipNode {
  source: AudioBufferSourceNode;
  gainNode: GainNode;
  contextTimeAtStart: number;
  sourceTimeAtStart: number;
}

interface VideoClipNode {
  mediaSource: MediaElementAudioSourceNode;
  gainNode: GainNode;
}

/** Owns the entire Web Audio mixing graph for the live preview — see this feature's own plan
 *  (`Web Audio Mixing Engine for VCut Live Preview`) for the full rationale. Two categories of
 *  audio, handled differently on purpose:
 *
 *  - **Audio-track clips** (no picture, unconstrained): `AudioBufferSourceNode`s scheduled against
 *    `audioContext.currentTime` — a sample-accurate hardware clock. This is what actually eliminates
 *    the click at its root: there is no `currentTime`-seeking, no per-frame drift-polling loop to
 *    misfire the way the old element-based `syncMedia` did for these clips. Buffers are decoded once
 *    per ASSET (not per clip), shared across every clip referencing it.
 *  - **Video-track clips' own embedded audio** (constrained — the SAME `<video>` element must stay the
 *    picture source `PlaybackEngine.drawTransformed` draws from): `createMediaElementSource` routes
 *    that element's audio output through a dedicated `GainNode` instead of `element.volume`. The
 *    element still needs `PlaybackEngine.syncMedia`'s existing currentTime/playbackRate correction for
 *    its PICTURE, so this category is NOT fully immune to the original click — see `duckAroundSeek`'s
 *    own doc comment for the mitigation this enables (new, but a mitigation, not a structural fix).
 *
 *  Every method here assumes it's only ever called from `PlaybackEngine`'s own per-frame `tick()` (or
 *  its teardown path) — it has no clock/loop of its own beyond the `AudioContext`'s own scheduling. */
export class AudioMixEngine {
  private audioContext: AudioContext;
  private masterGain: GainNode;
  private getMediaUrl: (assetId: string) => string | null;

  private bufferCache = new Map<string, Promise<AudioBuffer>>();
  private bufferLastUsed = new Map<string, number>();
  private trackClipNodes = new Map<string, TrackClipNode>();
  private videoClipNodes = new Map<string, VideoClipNode>();
  /** One shared GainNode per AUDIO track — every clip currently playing on that track routes its own
   *  clip-level GainNode through this ONE node before reaching `masterGain` (by way of that track's own
   *  pan/analyser nodes — see `getOrCreateTrackChain`), instead of connecting straight to `masterGain`
   *  itself. Lazily created (`getOrCreateTrackChain`) the first time a
   *  clip on that track starts playing OR the Mixer panel first touches that track's fader, and never
   *  torn down proactively — an audio-context-lifetime cache, cheap enough (one GainNode per track)
   *  not to need eviction the way `bufferCache` does. This is what lets `setTrackGain` move a track's
   *  whole mix level with ONE `setTargetAtTime` call regardless of how many clips are on it, and
   *  without ever touching (let alone restarting) a clip's own `AudioBufferSourceNode` — those are
   *  one-shot/un-seekable, so recomputing a per-clip gain scalar instead would mean restarting every
   *  scheduled node on that track just because a fader moved, reintroducing exactly the click this
   *  engine's own rearchitecture eliminated. */
  private trackGainNodes = new Map<string, GainNode>();
  /** One shared `StereoPannerNode` per audio track, downstream of that track's own `GainNode` — see
   *  `getOrCreateTrackChain`'s own comment for the full chain shape and why pan sits after gain. */
  private trackPanNodes = new Map<string, StereoPannerNode>();
  /** One shared `AnalyserNode` per audio track, downstream of pan — the tap `getTrackLevelDb` reads
   *  from. Sitting LAST in the per-track chain (post-fader, post-pan) means the meter reflects exactly
   *  what's actually being sent to `masterGain`, not some pre-fader signal that wouldn't match what's
   *  audible. A plain pass-through node — connecting through it doesn't alter the signal at all, it
   *  just exposes FFT/waveform data alongside forwarding audio onward unchanged. */
  private trackAnalyserNodes = new Map<string, AnalyserNode>();
  /** Master-bus metering tap, inserted between `masterGain` and `audioContext.destination` — same
   *  pass-through reasoning as the per-track analysers, just for the final summed mix. */
  private masterAnalyser: AnalyserNode;

  constructor(getMediaUrl: (assetId: string) => string | null) {
    this.getMediaUrl = getMediaUrl;
    this.audioContext = new AudioContext();
    this.masterGain = this.audioContext.createGain();
    this.masterAnalyser = this.audioContext.createAnalyser();
    // Small FFT — a UI meter only ever needs a cheap-to-read time-domain snapshot every animation
    // frame, not fine frequency resolution; 1024 keeps `getFloatTimeDomainData` fast even with several
    // per-track analysers plus this one all being read every rAF while the Mixer panel is open.
    this.masterAnalyser.fftSize = 1024;
    this.masterGain.connect(this.masterAnalyser);
    this.masterAnalyser.connect(this.audioContext.destination);
  }

  /** `AudioContext` starts `suspended` until a user gesture resumes it — mirrors the existing
   *  `element.play().catch(() => {})` pattern for the same reason: this is called from inside `tick()`
   *  right alongside that deferred `.play()` call (see this feature's plan, "Autoplay/gesture
   *  handling"), always after a real click has already happened, but the rejection still needs
   *  swallowing rather than surfacing as an unhandled promise rejection. */
  resume(): void {
    if (this.audioContext.state === "suspended") void this.audioContext.resume().catch(() => {});
  }

  /** Lazily creates (once — see `trackGainNodes`' own comment) and wires an audio track's whole mixing
   *  chain: `gain → pan → analyser → masterGain`. Gain comes first so panning never interacts with its
   *  own `setTargetAtTime` smoothing; the analyser comes last (post-fader, post-pan) so `getTrackLevelDb`
   *  reflects exactly what's being sent to master, not a pre-fader/pre-pan signal that wouldn't match
   *  what's actually audible. Every existing caller that used to reach for the gain node alone now goes
   *  through this instead, and still gets the SAME gain node back — only the wiring downstream of it
   *  changed, not its identity. */
  private getOrCreateTrackChain(trackId: string): { gain: GainNode; pan: StereoPannerNode } {
    let gain = this.trackGainNodes.get(trackId);
    if (!gain) {
      gain = this.audioContext.createGain();
      const pan = this.audioContext.createStereoPanner();
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 1024;
      gain.connect(pan).connect(analyser).connect(this.masterGain);
      this.trackGainNodes.set(trackId, gain);
      this.trackPanNodes.set(trackId, pan);
      this.trackAnalyserNodes.set(trackId, analyser);
    }
    // `trackPanNodes` is always populated in the exact same branch that just set `trackGainNodes`
    // above, so a lookup miss here would mean the two maps somehow desynced — a bug, not a real "might
    // be absent" case worth a defensive null check.
    return { gain, pan: this.trackPanNodes.get(trackId)! };
  }

  /** Live per-track mix level — called once per tick by `PlaybackEngine.tick()` for every audio track,
   *  regardless of whether anything on it is currently playing (cheap: a no-op scalar reconciliation
   *  when nothing changed, `AudioParam.setTargetAtTime` handles the smoothing). Creates the track's
   *  whole chain on first call if nothing has played on it yet, so a fader touched before its track's
   *  first clip ever starts is already correct the instant it does. */
  setTrackGain(trackId: string, gain: number): void {
    this.getOrCreateTrackChain(trackId).gain.gain.setTargetAtTime(gain, this.audioContext.currentTime, GAIN_SMOOTHING_TIME_CONSTANT);
  }

  /** Live per-track pan — same `setTargetAtTime`/smoothing convention as `setTrackGain`, called once
   *  per tick by `PlaybackEngine.tick()` for every audio track. See `Track.pan`'s own doc comment for
   *  the equal-power algorithm this node computes natively. */
  setTrackPan(trackId: string, pan: number): void {
    this.getOrCreateTrackChain(trackId).pan.pan.setTargetAtTime(pan, this.audioContext.currentTime, GAIN_SMOOTHING_TIME_CONSTANT);
  }

  /** Live master mix level — called once per tick by `PlaybackEngine.tick()`. `masterGain` has existed
   *  since this engine's own constructor (reserved for exactly this, connected straight to
   *  `audioContext.destination`); this is simply its first writer. */
  setMasterGain(gain: number): void {
    this.masterGain.gain.setTargetAtTime(gain, this.audioContext.currentTime, GAIN_SMOOTHING_TIME_CONSTANT);
  }

  /** RMS level in dBFS for one track's post-fader/pan signal, read fresh every call — polled by
   *  `LevelMeter`'s own `requestAnimationFrame` loop, NOT by `PlaybackEngine.tick()` (metering has no
   *  connection to the render/composite loop; it just needs a live reading on demand). `null` when the
   *  track has never played anything yet (no chain/analyser exists) — the meter reads "silent" for
   *  that, same as an actual silent signal would. */
  getTrackLevelDb(trackId: string): number | null {
    const analyser = this.trackAnalyserNodes.get(trackId);
    return analyser ? this.rmsDb(analyser) : null;
  }

  /** Master-bus level — same shape as `getTrackLevelDb`, always available since the master analyser
   *  exists from construction. */
  getMasterLevelDb(): number {
    return this.rmsDb(this.masterAnalyser);
  }

  /** Reused across every `rmsDb` call (any track's analyser, or the master's) rather than allocated
   *  fresh each time — several meters can be polling every animation frame at once while the Mixer
   *  panel is open, and every analyser here shares the same `fftSize`, so one scratch buffer sized to
   *  match is enough for all of them. */
  private rmsDbScratch = new Float32Array(1024);

  /** Plain time-domain RMS converted to dBFS, floored at -60 rather than returning `-Infinity` for
   *  near/true silence — matches a hardware meter's own bottom-of-scale convention, and gives
   *  `LevelMeter`'s dB→fraction math a finite range to work with. */
  private rmsDb(analyser: AnalyserNode): number {
    const buffer = this.rmsDbScratch.length === analyser.fftSize ? this.rmsDbScratch : (this.rmsDbScratch = new Float32Array(analyser.fftSize));
    analyser.getFloatTimeDomainData(buffer);
    let sumSquares = 0;
    for (let i = 0; i < buffer.length; i++) sumSquares += buffer[i] * buffer[i];
    const rms = Math.sqrt(sumSquares / buffer.length);
    return rms > 0 ? Math.max(-60, 20 * Math.log10(rms)) : -60;
  }

  /** Replaces `PlaybackEngine.syncAudioTracks`'s old element-pool body wholesale. `active` is exactly
   *  what `PlaybackEngine.activeAudioClips` already computes (including a transition partner as its
   *  own separate entry during a real crossfade) — this schedules/reconciles/stops
   *  `AudioBufferSourceNode`s to match it, once per tick. */
  syncAudioTrackClips(active: ActiveAudioTrackClip[], playing: boolean): void {
    const activeIds = new Set(active.map((a) => a.clip.id));
    for (const [clipId, node] of this.trackClipNodes) {
      if (!playing || !activeIds.has(clipId)) this.stopTrackClipNode(clipId, node);
    }
    if (!playing) return;

    for (const { trackId, clip, sourceTime, gain } of active) {
      const existing = this.trackClipNodes.get(clip.id);
      if (!existing) {
        this.startTrackClip(trackId, clip, sourceTime, gain);
        continue;
      }
      // Cheap scalar reconciliation on an already-scheduled clip: is it still roughly where it should
      // be (routine clock noise, left alone), or did the timeline genuinely jump out from under it
      // (a scrub, a loop, resuming after a throttled tab — restart at the new position)?
      const expectedSourceTime = existing.sourceTimeAtStart + (this.audioContext.currentTime - existing.contextTimeAtStart);
      if (detectRealSeek(expectedSourceTime, sourceTime, SEEK_DETECTION_TOLERANCE)) {
        this.stopTrackClipNode(clip.id, existing);
        this.startTrackClip(trackId, clip, sourceTime, gain);
        continue;
      }
      // `gain` already carries both `Clip.gain` and any live transition ramp (`activeAudioClips` folds
      // both together) — see `audioScheduling.ts`'s own doc comment for why this is a plain per-tick
      // scalar rather than a precomputed automation curve. Track gain is NOT part of this scalar — it's
      // applied downstream by the shared per-track node this clip's own node connects through (see
      // `startTrackClip`), so `setTrackGain` can move the whole track without touching any clip node.
      existing.gainNode.gain.setTargetAtTime(gain, this.audioContext.currentTime, GAIN_SMOOTHING_TIME_CONSTANT);
    }
  }

  private startTrackClip(trackId: string, clip: Clip, sourceTime: number, gain: number): void {
    const url = this.getMediaUrl(clip.assetId);
    if (!url) return;
    this.getOrDecodeBuffer(clip.assetId, url)
      .then((buffer) => {
        // The clip may no longer be the CURRENT thing scheduled for this id by the time decode
        // finishes (a later tick's own start, or a stop, already ran) — never overwrite a node that
        // already exists, and never schedule for a clip that's since gone silent/inactive.
        if (this.trackClipNodes.has(clip.id)) return;
        const offset = Math.min(Math.max(0, sourceTime), buffer.duration);
        // How much of the CLIP's own trim window remains from this starting point — not the buffer's
        // own full remaining length, or a clip trimmed short of its source's real duration would keep
        // playing straight past its intended `sourceOut`.
        const remaining = Math.max(0, clip.sourceOut - offset);
        if (remaining <= 0) return;

        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;
        const gainNode = this.audioContext.createGain();
        gainNode.gain.value = gain;
        // Through the track's own shared gain→pan→analyser chain, not straight to masterGain — see
        // `getOrCreateTrackChain`'s own doc comment for why.
        source.connect(gainNode).connect(this.getOrCreateTrackChain(trackId).gain);

        const contextTimeAtStart = this.audioContext.currentTime;
        source.start(contextTimeAtStart, offset, remaining);
        this.trackClipNodes.set(clip.id, { source, gainNode, contextTimeAtStart, sourceTimeAtStart: offset });

        source.onended = () => {
          // Only clean up if this node is STILL the current one for this clip id — a natural end
          // racing against a reseek/restart that already replaced it must not delete the new node.
          if (this.trackClipNodes.get(clip.id) === undefined) return;
          if (this.trackClipNodes.get(clip.id)?.source === source) this.trackClipNodes.delete(clip.id);
        };
      })
      .catch(() => {
        // A decode failure (corrupt/unreachable asset) degrades to silence rather than throwing into
        // the render loop — matches this app's broader "drag/play can't destroy work" leniency.
      });
  }

  private stopTrackClipNode(clipId: string, node: TrackClipNode): void {
    try {
      node.source.stop();
    } catch {
      // Already stopped, or already ran to its natural end — nothing left to stop.
    }
    node.source.disconnect();
    node.gainNode.disconnect();
    this.trackClipNodes.delete(clipId);
  }

  /** Wires (once — see `videoClipNodes`' own comment) or reconciles a video clip's embedded-audio
   *  routing. Called every tick a video clip is on screen, right after `PlaybackEngine.syncMedia`
   *  handles that same element's PICTURE timing. `muted`/`gain` fold together into one target value —
   *  matches export's own "muted clip becomes a zero-signal source" semantics for free, no separate
   *  mute branch needed here either. */
  syncVideoClipAudio(clip: Clip, element: HTMLVideoElement, gain: number, muted: boolean): void {
    let node = this.videoClipNodes.get(clip.id);
    if (!node) {
      // `createMediaElementSource` throws `InvalidStateError` if called twice on the same element
      // across its lifetime — keying this map by clip id (the SAME key `PlaybackEngine`'s own element
      // pool uses) guarantees it only ever runs once per element/clip pairing.
      const mediaSource = this.audioContext.createMediaElementSource(element);
      const gainNode = this.audioContext.createGain();
      mediaSource.connect(gainNode).connect(this.masterGain);
      node = { mediaSource, gainNode };
      this.videoClipNodes.set(clip.id, node);
    }
    node.gainNode.gain.setTargetAtTime(muted ? 0 : gain, this.audioContext.currentTime, GAIN_SMOOTHING_TIME_CONSTANT);
  }

  /** Mitigation for the one click category this rearchitecture does NOT structurally fix — see this
   *  class's own doc comment on video-embedded audio. Called by `PlaybackEngine.syncMedia` exactly
   *  where it already decides a hard `currentTime` reseek on a video element is unavoidable: ducks that
   *  clip's dedicated `GainNode` to silence over `DUCK_RAMP_SECONDS`, via the audio thread's OWN
   *  automation clock — immune to the main-thread jank that made a flat `playbackRate` nudge
   *  insufficient in the first place (this session's earlier attempt). Deliberately schedules no
   *  ramp-BACK-up of its own: the next `syncVideoClipAudio` call — once `drawVideoClip` gets past its
   *  own `readyState < 2` early-return again — naturally smooths back to the correct target via its own
   *  `setTargetAtTime`, overriding this duck's tail end. If readiness recovery takes unusually long, the
   *  clip just stays silent a bit longer instead of resuming at a stale gain — a strictly better failure
   *  mode than the click this replaces. */
  duckAroundSeek(clipId: string): void {
    const node = this.videoClipNodes.get(clipId);
    if (!node) return;
    const now = this.audioContext.currentTime;
    node.gainNode.gain.cancelScheduledValues(now);
    node.gainNode.gain.setValueAtTime(node.gainNode.gain.value, now);
    node.gainNode.gain.linearRampToValueAtTime(0, now + DUCK_RAMP_SECONDS);
  }

  /** Must be called before a pooled video element's `src` is cleared (`PlaybackEngine.release`/
   *  `evictStale`) — otherwise this clip's `MediaElementAudioSourceNode`/`GainNode` dangle in the graph
   *  with nothing left referencing them from the picture side. */
  releaseVideoClipAudio(clipId: string): void {
    const node = this.videoClipNodes.get(clipId);
    if (!node) return;
    node.mediaSource.disconnect();
    node.gainNode.disconnect();
    this.videoClipNodes.delete(clipId);
  }

  /** Fire-and-forget decode kickoff for a clip about to become active soon (not yet) — fed by
   *  `PlaybackEngine`'s own low-frequency scan of upcoming audio-track clips, not called every rAF.
   *  Safe to call redundantly; `getOrDecodeBuffer` dedupes via its own cache. */
  prefetchAsset(assetId: string, url: string): void {
    void this.getOrDecodeBuffer(assetId, url);
  }

  private getOrDecodeBuffer(assetId: string, url: string): Promise<AudioBuffer> {
    const existing = this.bufferCache.get(assetId);
    if (existing) {
      this.bufferLastUsed.set(assetId, performance.now());
      return existing;
    }
    const promise = fetch(url)
      .then((r) => r.arrayBuffer())
      .then((data) => this.audioContext.decodeAudioData(data));
    this.bufferCache.set(assetId, promise);
    this.bufferLastUsed.set(assetId, performance.now());
    this.evictStaleBuffers();
    // A failed decode shouldn't stay permanently cached — a later retry (e.g. after a transient
    // network error) should get a fresh attempt rather than the same rejected promise forever.
    promise.catch(() => {
      this.bufferCache.delete(assetId);
      this.bufferLastUsed.delete(assetId);
    });
    return promise;
  }

  private evictStaleBuffers(): void {
    const entries = [...this.bufferLastUsed.entries()].map(([key, lastUsed]) => ({ key, lastUsed }));
    for (const assetId of lruEvict(entries, BUFFER_CACHE_LIMIT)) {
      this.bufferCache.delete(assetId);
      this.bufferLastUsed.delete(assetId);
    }
  }

  /** Tears down the entire graph — stops every scheduled node, disconnects every video-audio route,
   *  closes the context. Called from `PlaybackEngine.detach()`. */
  dispose(): void {
    for (const [clipId, node] of this.trackClipNodes) this.stopTrackClipNode(clipId, node);
    for (const clipId of [...this.videoClipNodes.keys()]) this.releaseVideoClipAudio(clipId);
    for (const node of this.trackGainNodes.values()) node.disconnect();
    this.trackGainNodes.clear();
    for (const node of this.trackPanNodes.values()) node.disconnect();
    this.trackPanNodes.clear();
    for (const node of this.trackAnalyserNodes.values()) node.disconnect();
    this.trackAnalyserNodes.clear();
    this.masterAnalyser.disconnect();
    this.masterGain.disconnect();
    void this.audioContext.close().catch(() => {});
  }
}
