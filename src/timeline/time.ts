/** Frame/second conversion and timecode formatting.
 *
 *  The project model stores time in SECONDS (floats), not frame indices. Seconds are what FFmpeg
 *  wants for `-ss`/`-t` and what `<video>.currentTime` speaks, so storing them avoids converting at
 *  every boundary. The cost is that raw float arithmetic drifts off exact frame boundaries, which is
 *  why every edit operation routes its result through `snapToFrame` — that keeps splits and trims
 *  landing on real frames while still handing FFmpeg plain seconds. */

/** Rounds `seconds` to the nearest exact frame boundary at `fps`. Guards against a non-finite or
 *  non-positive fps (a malformed project, or an asset whose fps couldn't be probed) by returning the
 *  input untouched rather than producing NaN and corrupting the whole timeline. */
export function snapToFrame(seconds: number, fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return seconds;
  return Math.round(seconds * fps) / fps;
}

export function secondsToFrames(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

export function framesToSeconds(frames: number, fps: number): number {
  return frames / fps;
}

/** One frame's duration — the granularity of frame-stepping and the minimum length of a clip. */
export function frameDuration(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return 0;
  return 1 / fps;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Formats as `MM:SS:FF`, widening to `HH:MM:SS:FF` only once the hour is non-zero — short-form work
 *  is measured in seconds, so a permanent leading `00:` would be noise on the one readout the
 *  creator looks at most. */
export function formatTimecode(seconds: number, fps: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalFrames = secondsToFrames(safe, fps);
  const framesPerSecond = Math.max(1, Math.round(fps));

  const frames = totalFrames % framesPerSecond;
  const totalSeconds = Math.floor(totalFrames / framesPerSecond);
  const secs = totalSeconds % 60;
  const mins = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);

  const pad = (n: number) => n.toString().padStart(2, "0");
  const base = `${pad(mins)}:${pad(secs)}:${pad(frames)}`;
  return hours > 0 ? `${pad(hours)}:${base}` : base;
}

/** Human-readable duration for the media library ("1:23", "0:07") — distinct from `formatTimecode`,
 *  which is the frame-accurate editing readout. */
export function formatDuration(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const total = Math.round(safe);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
