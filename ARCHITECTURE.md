# VStudio Architecture

## Shape

`@veasna/vstudio` is a source-only React package. `studios/bp` is the host: it consumes the package
via `transpilePackages`, mounts `<VStudioApp>` at `/projects/[id]/create`, and provides the server
routes under `/api/vstudio/*`. This follows the repo's existing `packages/universe` →
`studios/universe` split.

```
packages/vstudio/src/
  project/     model, creation, serialization      (pure, no React, no I/O)
  timeline/    split/trim/move/delete, snapping    (pure)
  commands/    one class per reversible edit       (pure)
  undo/        UndoStack                           (pure)
  export/      buildExportPlan → FFmpeg argv       (pure)
  api/         browser-side client for the routes
  store/       zustand: project + undo + UI state
  playback/    PlaybackEngine (clock, media pool, canvas compositor)
  ui/          React components

studios/bp/app/api/vstudio/
  _lib/        workspace paths, ffmpeg binaries, local-only guard
  project/     GET / PUT project.json
  media/       POST import · DELETE remove · raw/ GET with Range
  export/      POST start · GET SSE progress · DELETE cancel · HEAD availability
```

Everything under `project/`, `timeline/`, `commands/`, `undo/`, and `export/` is pure and has no
imports from React, the DOM, or Node. That's what makes it directly unit-testable and is where the
test suite lives.

## The data flow

```
user action → Command → UndoStack.execute → new Project → store → UI re-render
                                                        ↘ autosave → PUT /api/vstudio/project
```

The UI never mutates media and never mutates the project in place. It constructs a command and hands
it to the store. Only the API layer and FFmpeg ever touch bytes on disk.

## Key decisions

### The project model is plain serializable data

No classes, no `Date`s, no functions. That single constraint makes `structuredClone` (used by every
edit) and a JSON round-trip (used by save/load) correct by construction rather than by discipline.
Time is stored in **seconds as floats**, because that's what both FFmpeg's `-ss`/`-t` and
`<video>.currentTime` speak. Every edit routes its result through `snapToFrame` so values still land
on real frame boundaries.

### Non-destructive by construction

A clip is `{ assetId, sourceIn, sourceOut, timelineStart }` — a *reference* to a range of a source,
never a copy. There is no code path that writes to an imported media file. Trimming changes two
numbers.

### Undo is commands + a scoped memento, not app snapshots

Each clip-editing command captures the clip arrays of **only the tracks it touches**, immediately
before applying, and restores exactly those on revert (`TrackScopedCommand`). It records nothing
about selection, playhead, zoom, or panel state — so undo reverses an *edit*, never "rewinds the
interface."

A per-track memento is used rather than hand-written inverse math because edits use overwrite
semantics: dropping a clip onto others can trim, split, or delete an arbitrary number of neighbours
(`carveRange`). Reconstructing all of that by inversion would be intricate and easy to get subtly
wrong; restoring the affected tracks is exact.

Commands that create clips (add, split, and the tail that overwrite can split off) fix those ids **at
construction, not per-apply** — otherwise a redo would produce differently-identified clips and any
later command in the stack referencing them would fail to resolve. There's a regression test for
exactly this.

### Overwrite, not ripple

Dropping a clip somewhere overwrites what's underneath. Chosen because it matches what the user sees
themselves doing: the thing they dragged ends up exactly where they dropped it, and nothing else
silently moves.

### Preview and export are separate renderers that agree

The spec calls for this and it's load-bearing: preview optimizes for responsiveness, export for
quality. They share the project model and nothing else.

- **Preview** is a canvas compositor over a pool of off-DOM `<video>`/`<audio>` elements.
- **Export** is one FFmpeg invocation built by `buildExportPlan`.

They're kept honest by using the same geometry: preview letterboxes with `min(scaleX, scaleY)` and
export uses `scale=…:force_original_aspect_ratio=decrease` + `pad`. What you preview is what you get.

### Playback runs its own master clock

A single `<video>`'s clock is the obvious choice right up until the timeline has a cut, a gap, or a
voiceover under the video — then no element's time is authoritative. So `PlaybackEngine` keeps its own
clock from `performance.now()` and treats every media element as a follower, re-seeking it when it
drifts past a tolerance. Gaps then play correctly with nothing loaded at all.

Media elements are pooled **by clip id, not asset id**, because the same asset can legitimately appear
at two timeline positions at once and one element can't be in two places.

### Transform (position/scale/rotation/crop) is one pipeline, computed once, drawn twice

`ClipTransform` is optional on `Clip` — absent means untransformed, and `setClipTransform` deletes the
field entirely rather than storing an "identity" object when a transform is reset, so an untouched
clip's `project.json` stays exactly as small as before this feature existed, and undoing a transform
edit restores a truly absent field (verified by a round-trip equality test), not a structurally
different-but-equivalent one.

The pipeline is fixed and identical everywhere it's computed: **crop the source rect (in the source's
own unrotated space) → scale-to-fit the CROPPED dimensions into the frame → apply the user's `scale`
multiplier → rotate around center → translate by offset.** `computeTransformedBox`
(`playback/transformGeometry.ts`) is the ONE place this is computed for anything screen-side — both
`PlaybackEngine.drawTransformed` (which draws it) and `TransformHandles` (which needs the same box's
screen position to draw its drag handles in the right place) call it, rather than risking two
implementations of the same math drifting apart the way preview/export already had to be kept in sync
once (see above).

Export's version of the same pipeline lives in `buildExportPlan`'s `buildTransformFilters` — a real
FFmpeg `crop`→`format=rgba`→`scale`→`rotate`→`overlay` chain, kept on a **separate code path** from the
plain `scale`+`pad` chain used for an untransformed clip (`isIdentityTransform` decides which), so
existing untouched clips never regress just because this feature exists. Two FFmpeg-specific
mechanisms make the export side tractable without any JS-side trigonometry: `rotate`'s
`ow=rotw(a):oh=roth(a)` macros let FFmpeg itself compute the exact bounding box that fits the rotated
content losslessly, and `overlay`'s `W`/`H`/`w`/`h` expression variables let the composite position
reference both inputs' real sizes symbolically. `format=rgba` right after `crop` is what makes
`rotate`'s `black@0` fill genuinely transparent padding instead of a visible black box — the filter
chain was verified frame-by-frame against the real bundled FFmpeg binary before being wired into the
route (crop, zoom, and a 37° rotation are all visible with clean transparent compositing in the
verification render).

On-canvas dragging (`TransformHandles`) follows the exact local-preview-then-single-commit pattern
`TimelineClip` established: a drag updates only local component state, so React re-renders freely
without touching the undo stack on every pixel of movement, and exactly one
`SetClipTransformCommand` is dispatched on release.

### Export builds one filter graph

`buildExportPlan` walks the video track and emits a segment per clip plus a **real black + silence
segment for every gap** — otherwise the exported video would be shorter than the edit and everything
after a gap would land at the wrong time.

Each clip gets its own `-i` with `-ss`/`-t` *before* it, so FFmpeg seeks and decodes only the range
actually needed — exactly the case non-destructive editing creates. Audio-track clips are positioned
with `adelay` and mixed with `amix=…:normalize=0` (normalization would make adding a music track
mysteriously duck the narration).

It's a pure function returning an argv array, so the whole graph is unit-tested without spawning
anything.

### Range streaming is mandatory, not an optimization

A `<video>` will not let the user seek in a resource the server can't serve partially. Without a 206
response, scrubbing — the most-used interaction in an editor — is impossible. `media/raw` implements
`bytes=a-b`, `bytes=a-`, and `bytes=-n`.

### Storage

Paths come from `VEASNA_WORKSPACE_ROOT` (set by the packaged desktop app to `Documents/Veasna OS`)
falling back to a `process.cwd()`-relative path in dev — the same convention `studios/universe` uses.
Never a hardcoded machine path. Untrusted path input (project ids from the URL, asset `relPath` from a
hand-editable project file) is validated and confined with `resolveWithin`.

## Extension points

The milestone stopped short of these on purpose, but the seams exist:

- **Effects** (brightness/blur/etc.) attach the same way transform did: a stage in
  `computeTransformedBox`/`drawTransformed` and a matching filter in `buildTransformFilters` — the two
  places already kept in sync for exactly this reason.
- **Keyframes** want an animatable-property layer over `ClipTransform` (interpolating between
  timestamped values instead of one static one); `SetClipTransformCommand`'s trivial-inverse shape
  would need to become a `TrackScopedCommand`-style memento once a transform can vary within a clip.
- **On-canvas crop handles** would reuse `TransformHandles`' existing drag-then-single-commit
  machinery, just computing crop fractions instead of scale/rotation from the drag delta.
- **Captions** get a track kind and a render pass in both renderers.
- **Proxies** slot into `mediaUrlFor` (preview) while export keeps resolving originals.
- **AI features** belong behind the API layer as separate routes; nothing in the core model needs to
  know about them.
