import type { Clip, ClipTransform, Project, Track } from "../project/types.ts";
import { IDENTITY_TRANSFORM } from "../project/types.ts";
import { audibleClips, clipAtTime } from "../timeline/queries.ts";
import { computeTransformedBox } from "./transformGeometry.ts";

/** How far a media element may drift from the master clock before it gets re-seeked. Below this,
 *  correcting would cause more visible stutter than the drift itself. */
const DRIFT_TOLERANCE = 0.2;
/** Media elements kept alive after they stop being needed. Keeping a few around makes scrubbing back
 *  and forth across a cut smooth, since the element is already decoded and buffered. */
const POOL_LIMIT = 8;

export interface PlaybackHost {
  getProject: () => Project | null;
  getPlayhead: () => number;
  isPlaying: () => boolean;
  /** Called as the master clock advances during playback. */
  onTimeUpdate: (seconds: number) => void;
  /** Called when playback runs off the end of the timeline. */
  onEnded: () => void;
  /** Resolves an asset to a streamable URL — injected so this class needs no knowledge of the API. */
  mediaUrlFor: (assetId: string) => string | null;
}

/** A still image is decoded into an `<img>` rather than a media element: it has no `currentTime`, no
 *  `play()`, and nothing to keep in sync — it just needs to be decoded once and then drawn on every
 *  frame it covers. */
type PoolElement = HTMLVideoElement | HTMLAudioElement | HTMLImageElement;

interface PooledMedia {
  element: PoolElement;
  lastUsed: number;
}

/** Drives the preview: advances a master clock, keeps media elements slaved to it, and composites
 *  the current frame onto a canvas.
 *
 *  ## Why a master clock rather than following `video.currentTime`
 *
 *  A single `<video>`'s own clock is the obvious choice right up until the timeline has more than one
 *  thing on it — a cut between two clips, a gap with nothing playing, or a voiceover running under
 *  the video. There's no single element whose time is authoritative in any of those cases. So this
 *  keeps its own clock from `performance.now()`, and treats every media element as a follower that
 *  gets re-seeked when it drifts (see DRIFT_TOLERANCE). Gaps then "play" correctly with nothing
 *  loaded at all, and audio stays locked to the same timeline the video is on.
 *
 *  ## Why canvas rather than showing the `<video>` directly
 *
 *  Compositing to a canvas is what lets the preview show the real output frame — correct aspect
 *  ratio, letterboxing, and a hard cut at clip boundaries with no element swap flashing through. It's
 *  also the seam where transforms and effects attach later without changing anything around it. */
export class PlaybackEngine {
  private host: PlaybackHost;
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private pool = new Map<string, PooledMedia>();
  private rafId: number | null = null;
  private lastFrameTime: number | null = null;
  private running = false;

  constructor(host: PlaybackHost) {
    this.host = host;
  }

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: false });
    this.start();
  }

  /** Tears everything down: stops the loop and releases every media element. Without the explicit
   *  `src` clear and `load()`, a detached element can keep its network request and decoder alive. */
  detach(): void {
    this.stop();
    for (const { element } of this.pool.values()) this.release(element);
    this.pool.clear();
    this.canvas = null;
    this.context = null;
  }

  private start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = null;
    const loop = () => {
      if (!this.running) return;
      this.tick();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private stop(): void {
    this.running = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private firstVisibleVideoTrack(project: Project): Track | undefined {
    return project.sequence.tracks.find((t) => t.kind === "video" && t.visible);
  }

  /** Gets (or creates) the media element for a clip. Elements are keyed by CLIP, not by asset,
   *  because the same asset can legitimately appear at two different timeline positions at once —
   *  one element can't be in two places. */
  private mediaFor(clip: Clip, kind: "video" | "audio" | "image"): PoolElement | null {
    const existing = this.pool.get(clip.id);
    if (existing) {
      existing.lastUsed = performance.now();
      return existing.element;
    }

    const url = this.host.mediaUrlFor(clip.assetId);
    if (!url) return null;

    const element =
      kind === "image"
        ? document.createElement("img")
        : kind === "video"
          ? document.createElement("video")
          : document.createElement("audio");
    element.src = url;
    // Never attached to the document: the canvas is what the user sees, and an off-DOM element still
    // decodes and plays audio perfectly well.
    if (element instanceof HTMLVideoElement) {
      element.preload = "auto";
      element.playsInline = true;
      element.muted = false;
    } else if (element instanceof HTMLAudioElement) {
      element.preload = "auto";
    }

    this.pool.set(clip.id, { element, lastUsed: performance.now() });
    this.evictStale();
    return element;
  }

  /** Releases one pooled element. An `<img>` only needs its `src` dropped; a media element also has
   *  to be paused and re-`load()`ed, or it can keep a network request and decoder alive after being
   *  discarded. */
  private release(element: PoolElement): void {
    if (element instanceof HTMLImageElement) {
      element.removeAttribute("src");
      return;
    }
    element.pause();
    element.removeAttribute("src");
    element.load();
  }

  private evictStale(): void {
    if (this.pool.size <= POOL_LIMIT) return;
    const entries = [...this.pool.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [clipId, { element }] of entries.slice(0, this.pool.size - POOL_LIMIT)) {
      this.release(element);
      this.pool.delete(clipId);
    }
  }

  /** Slaves one media element to the master clock. */
  private syncMedia(
    element: HTMLVideoElement | HTMLAudioElement,
    sourceTime: number,
    playing: boolean,
    volumeMuted: boolean
  ): void {
    element.muted = volumeMuted;

    // readyState 0 means nothing is loaded yet — seeking now would be discarded once metadata
    // arrives, so let it load and correct on a later frame.
    if (element.readyState === 0) return;

    if (Math.abs(element.currentTime - sourceTime) > DRIFT_TOLERANCE) {
      element.currentTime = sourceTime;
    }

    if (playing) {
      // `play()` rejects if the browser blocks autoplay before a user gesture. Playback here always
      // follows a real click, but the rejection still has to be swallowed or it surfaces as an
      // unhandled promise rejection in the console.
      if (element.paused) void element.play().catch(() => {});
    } else if (!element.paused) {
      element.pause();
    }
  }

  private tick(): void {
    const project = this.host.getProject();
    const context = this.context;
    const canvas = this.canvas;
    if (!project || !context || !canvas) return;

    const now = performance.now();
    const delta = this.lastFrameTime === null ? 0 : (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;

    const playing = this.host.isPlaying();
    let time = this.host.getPlayhead();

    if (playing && delta > 0) {
      time += delta;
      const total = this.totalDuration(project);
      if (time >= total) {
        this.host.onTimeUpdate(total);
        this.host.onEnded();
        this.pauseAll();
        this.drawFrame(project, context, canvas, total);
        return;
      }
      this.host.onTimeUpdate(time);
    }

    // Canvas backing store matches the sequence, so the preview shows the true output frame rather
    // than something scaled to whatever size the panel happens to be.
    if (canvas.width !== project.sequence.width || canvas.height !== project.sequence.height) {
      canvas.width = project.sequence.width;
      canvas.height = project.sequence.height;
    }

    this.drawFrame(project, context, canvas, time);
    this.syncAudioTracks(project, time, playing);
  }

  /** Audio-track clips whose time window actually contains `time` right now — as opposed to
   *  `audibleClips`, which returns every clip on every audible (unmuted/soloed) track regardless of
   *  where it sits on the timeline.
   *
   *  This distinction is what `drawFrame`'s calls to `pauseInactive` need, and using the wrong one
   *  there was a real, confirmed bug: passing ALL audible clips as "protected from pausing" meant an
   *  audio-track clip's element was NEVER told to pause once the playhead moved past its window — it
   *  just kept playing indefinitely, since `syncAudioTracks` also stops touching it the moment it's
   *  no longer active. The inverse bug hit at the same spot: during a gap in the video track,
   *  `drawFrame`'s early return called `pauseInactive(new Set())` — an EMPTY protected set — which
   *  paused every currently-audible element including audio-track clips that should keep playing
   *  under a video gap (background music, a voiceover with no matching footage yet). Both call sites
   *  now filter through this one method instead of disagreeing about what "active" means. */
  private activeAudioClips(project: Project, time: number): { clip: Clip }[] {
    return audibleClips(project).filter(
      ({ clip }) => time >= clip.timelineStart && time < clip.timelineStart + (clip.sourceOut - clip.sourceIn)
    );
  }

  private totalDuration(project: Project): number {
    let end = 0;
    for (const track of project.sequence.tracks) {
      for (const clip of track.clips) {
        end = Math.max(end, clip.timelineStart + (clip.sourceOut - clip.sourceIn));
      }
    }
    return end;
  }

  private drawFrame(
    project: Project,
    context: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    time: number
  ): void {
    context.fillStyle = "#000";
    context.fillRect(0, 0, canvas.width, canvas.height);

    // Computed once and reused by every `pauseInactive` call below, so a gap in the video track and a
    // clip actively playing agree on which audio-track elements are currently supposed to be making
    // sound — see this method's own doc comment for the two bugs that came from getting this wrong.
    const activeAudioIds = this.activeAudioClips(project, time).map((c) => c.clip.id);

    const track = this.firstVisibleVideoTrack(project);
    const clip = track ? clipAtTime(track, time) : undefined;
    if (!track || !clip) {
      this.pauseInactive(new Set(activeAudioIds));
      return;
    }

    const asset = project.assets.find((a) => a.id === clip.assetId);
    const isImage = asset?.kind === "image";
    const element = this.mediaFor(clip, isImage ? "image" : "video");
    if (!element) return;

    let sourceWidth: number;
    let sourceHeight: number;

    if (element instanceof HTMLImageElement) {
      // A still has no clock to sync and nothing to pause — it's ready as soon as it has decoded.
      if (!element.complete || element.naturalWidth === 0) return;
      sourceWidth = element.naturalWidth;
      sourceHeight = element.naturalHeight;
      this.pauseInactive(new Set([clip.id, ...activeAudioIds]));
    } else if (element instanceof HTMLVideoElement) {
      const sourceTime = clip.sourceIn + (time - clip.timelineStart);
      // A video clip's own audio is silenced when its track is hidden, or when the clip itself is
      // muted — matching what export does, so preview and output agree.
      this.syncMedia(element, sourceTime, this.host.isPlaying(), !track.visible || (clip.mutedAudio ?? false));
      this.pauseInactive(new Set([clip.id, ...activeAudioIds]));
      // readyState < 2 means no frame is decoded yet; drawing would throw or paint garbage.
      if (element.readyState < 2) return;
      sourceWidth = element.videoWidth;
      sourceHeight = element.videoHeight;
    } else {
      return;
    }

    if (sourceWidth === 0 || sourceHeight === 0) return;

    this.drawTransformed(context, element, sourceWidth, sourceHeight, canvas, clip.transform ?? IDENTITY_TRANSFORM);
  }

  /** Draws one source (video frame or image) into the sequence frame under a transform — the ONE
   *  place this class composites a source onto the canvas, so the untransformed case (identity) and a
   *  fully transformed one are guaranteed to agree on geometry rather than risking two separate code
   *  paths drifting apart.
   *
   *  Pipeline, matching `ClipTransform`'s own doc comment and `buildExportPlan`'s FFmpeg graph exactly:
   *  crop the source rect → scale-to-fit the CROPPED dimensions → apply the user `scale` multiplier →
   *  rotate around center → translate by offset. `drawImage`'s 8-argument form does the crop step
   *  itself (a source rect), so there's no need for an intermediate cropped canvas. */
  private drawTransformed(
    context: CanvasRenderingContext2D,
    element: HTMLVideoElement | HTMLImageElement,
    sourceWidth: number,
    sourceHeight: number,
    canvas: HTMLCanvasElement,
    transform: ClipTransform
  ): void {
    const box = computeTransformedBox(sourceWidth, sourceHeight, canvas.width, canvas.height, transform);
    if (!box) return;

    context.save();
    context.translate(box.centerX, box.centerY);
    if (transform.rotationDeg !== 0) context.rotate((transform.rotationDeg * Math.PI) / 180);
    context.drawImage(
      element,
      box.cropX,
      box.cropY,
      box.cropWidth,
      box.cropHeight,
      -box.width / 2,
      -box.height / 2,
      box.width,
      box.height
    );
    context.restore();
  }

  private syncAudioTracks(project: Project, time: number, playing: boolean): void {
    for (const { clip } of this.activeAudioClips(project, time)) {
      const element = this.mediaFor(clip, "audio");
      if (element instanceof HTMLAudioElement) {
        this.syncMedia(element, clip.sourceIn + (time - clip.timelineStart), playing, clip.mutedAudio ?? false);
      }
    }
  }

  /** Pauses everything that isn't currently under the playhead. Without this, a clip's audio keeps
   *  playing after the playhead has moved past it. */
  private pauseInactive(activeClipIds: Set<string>): void {
    for (const [clipId, { element }] of this.pool) {
      // Images have nothing to pause — they're just a decoded bitmap sitting in the pool.
      if (element instanceof HTMLImageElement) continue;
      if (!activeClipIds.has(clipId) && !element.paused) element.pause();
    }
  }

  private pauseAll(): void {
    for (const { element } of this.pool.values()) {
      if (!(element instanceof HTMLImageElement)) element.pause();
    }
  }
}
