# VStudio

> Create faster. Think deeper. Tell better stories.

A fast, focused video editor for short-form creative work — built for a solo creator making 30–60
second educational and cinematic videos, not as a replacement for Premiere or Resolve.

VStudio is the **Create** stage of [BP Studio](../../studios/bp): a BP project goes Idea → Script →
**Create** → Publish, and this is where it becomes an actual video.

---

## What works today

This is the spec's "First Milestone" — the smallest set of operations that make an editor real.
Every one of these is implemented and verified end-to-end against a running app:

1. Launch VStudio from a BP project
2. Create a project (created automatically on first open)
3. Import a video
4. See it in the media library with real duration / resolution / frame rate / audio info
5. Add it to the timeline
6. Play it, with audio
7. Scrub it
8. Split it
9. Trim it
10. Move the resulting clips
11. Undo and redo every edit
12. Save the project
13. Close VStudio
14. Reopen and see the identical timeline
15. Export the edit to an MP4 that matches it

Plus: drag-and-drop import, snapping, zoom, multi-track (video + audio), dragging clips between
tracks, track lock / hide / mute / solo, autosave, export progress, and export cancellation.

**Position, scale, rotation, and crop.** Every video/image clip can be repositioned, resized, rotated
to any degree (not just 90° steps), and cropped — either by typing exact numbers into the Inspector, or
by dragging directly on the preview (drag the body to move, a corner handle to scale, the handle above
it to rotate). Both controls, and the exported file, are driven by the identical pipeline (crop → fit →
scale → rotate → position), so what you see while dragging is exactly what renders.

**Track rules.** Video and images go on video tracks; audio-only media goes on audio tracks. Dropping
media on the wrong kind of track is refused with an explanation rather than silently accepted — a clip
on a track that can't render it would just never appear. Video tracks are always grouped above audio
tracks, so "drag one track down" never lands somewhere it isn't allowed.

## What is deliberately NOT here yet

Stated plainly, because a polished UI hiding missing features is worse than an honest gap:

- **Text and captions** — no text layers, no SRT/VTT import. The caption track is designed for in the
  model but not implemented, so nothing is rendered for it.
- **Effects, transitions, keyframes** — no brightness/blur/dissolve/etc. Position/scale/rotation/crop
  IS implemented (see above), but it's a single static value per clip — nothing animates over the
  clip's duration yet.
- **On-canvas crop handles** — crop is numeric-only in the Inspector; only Position/Scale/Rotation have
  draggable handles in the preview.
- **Multi-layer video compositing** — export renders the first visible video track. Additional video
  tracks can hold clips and play in preview, but they are not composited over each other.
- **Waveforms** — audio clips render as plain blocks; no waveform is drawn or cached.
- **Proxy media** — 4K/8K sources are edited directly. There is no proxy generation step.
- **AI features** — no speech-to-text, scene detection, or smart reframing.
- **Native file picking** — imported files are *copied* into the project folder (see below).

## Supported formats

| Kind  | Extensions |
|-------|------------|
| Video | `.mp4` `.mov` `.webm` `.mkv` `.avi` `.m4v` |
| Audio | `.wav` `.mp3` `.aac` `.flac` `.m4a` `.ogg` |
| Image | `.png` `.jpg` `.jpeg` `.webp` `.gif` |

Export is H.264 / AAC in an MP4, at 1080×1920, 1920×1080, or 1080×1080, and 24/25/30/50/60 fps.

Stills have no intrinsic length, so they're placed at a default 5 seconds and can be trimmed like any
other clip. They render in the preview and export correctly (FFmpeg `-loop 1`).

## Requirements

- Node 22+
- FFmpeg and ffprobe — installed automatically as `ffmpeg-static` / `ffprobe-static`, no system
  install needed. If a package manager's build policy blocks install scripts, the binary won't
  download; VStudio detects this and tells you to run `pnpm rebuild ffmpeg-static` rather than
  failing mysteriously at export time.

## Running it

```bash
pnpm install
pnpm dev:bp                      # BP Studio on :3001
```

Then open a project and choose **Create**, or go straight to
`http://localhost:3001/projects/<projectId>/create`.

## Tests

```bash
pnpm --filter @veasna/vstudio test
```

Runs Node's built-in test runner directly against the TypeScript source — no build step, no test
framework. Covers timeline operations, undo/redo round-trips, project serialization, and FFmpeg
argument generation.

## Where your files live

Projects are stored under the workspace root (`Documents/Veasna OS` in the packaged desktop app, the
repo root in development):

```
.vstudio/<bpProjectId>/
  project.json      the edit — clips, tracks, settings
  media/            imported media (copies; originals are never touched)
  thumbnails/       generated library thumbnails
  exports/          rendered videos
```

**Importing copies the file** into `media/`. That costs disk space, and it's a deliberate trade: it
guarantees the original can never be modified, gives FFmpeg a stable path that survives the user
moving their Downloads folder, and works identically in a browser tab (where the web File API hides
real paths) and in the packaged desktop app.

**Editing is non-destructive.** A clip is a reference to a range of a source file. Trimming a
10-minute source to 15 seconds changes two numbers in `project.json` and never rewrites a byte of
media. This is covered by an end-to-end test that hashes the source file before and after a trim.

## More

- [ARCHITECTURE.md](./ARCHITECTURE.md) — how the pieces fit together and why
- [DEVELOPMENT.md](./DEVELOPMENT.md) — working on VStudio
