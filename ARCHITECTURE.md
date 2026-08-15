# VStudio Architecture

## Shape

`@veasna/vstudio` is a source-only React package. `studios/vstudio` is its real host: a standalone
Next.js app that consumes the package via `transpilePackages`, mounts `<VStudioApp>` at `/edit`, and
provides every server route under `/api/vstudio/*`. This follows the repo's existing
`packages/universe` → `studios/universe` split.

`studios/bp` does NOT host the editor itself — it's a consumer, exactly like Universe is a consumer
of `studios/bp`/`studios/vstudio`/`studios/gamedev`. BP's Create stage
(`app/projects/[id]/create/page.tsx`) embeds VStudio via `<iframe src="${vstudioUrl}/edit?projectId=...">`,
resolving `vstudioUrl` from its own tiny `/api/vstudio-url` route (env-var-backed in the packaged
desktop app, since the Electron `window.veasnaStudios` bridge Universe uses to resolve *its own*
embedded studios isn't reachable from inside BP's `<webview>`). Same project data either way — BP
never touches `project.json` or the media folder directly, it only ever talks to VStudio's API
through the iframe's own same-origin requests.

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

studios/vstudio/
  app/edit/          the editor page — reads ?projectId=&projectName= and renders <VStudioApp>
  app/page.tsx        VStudio's own home page — list/create projects with no host app involved
  app/api/vstudio/
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

### Effects (brightness/contrast/saturation/blur/opacity) attach the same way Transform did

`ClipEffects` is optional on `Clip`, same absent-means-default / delete-rather-than-store-identity
rules as `ClipTransform` (`setClipEffects`, `isIdentityEffects`) — this was the literal seam this
file's own "Extension points" section named before Effects existed, so no new pattern was needed,
just the existing one applied to a second field.

The one genuinely new problem Effects introduces (Transform didn't have it, since geometry has no
equivalent ambiguity): preview (Canvas2D `context.filter`) and export (FFmpeg's `eq`/`gblur` filters)
don't share one native convention for every field. `opacity`/`saturation`/`contrast` are exact
matches (both renderers already agree on a multiplicative 1.0-is-unchanged convention for the latter
two); `brightness` and `blur` are documented, deliberate approximations — FFmpeg's `eq=brightness=`
is additive while CSS `brightness()` is multiplicative, and CSS `blur(Xpx)` uses a different kernel
than FFmpeg's `gblur=sigma=X`. `ClipEffects`'s own doc comment (`project/types.ts`) is the one place
this is spelled out; `buildCanvasFilterString` (`playback/PlaybackEngine.ts`) is the one place the
brightness conversion formula lives.

Export's chain reuses `buildTransformFilters` itself rather than a parallel function — the trigger
for routing a clip through the full crop/scale/rotate/overlay chain (instead of the plain, cheaper
`scale`+`pad` chain) generalized from "has a real transform" to "has a real transform OR real
effects", so an effects-only clip (no transform) still gets `IDENTITY_TRANSFORM`'s neutral geometry
and the full chain, while a genuinely untouched clip keeps today's exact simple path. `eq=` sits
right after `format=rgba` (order-independent color math); `gblur=` after `scale` (so its sigma
corresponds to the clip's FINAL on-screen size, not its source resolution); `colorchannelmixer=aa=`
right before the final `overlay` compositing step (alpha only matters at the blend, not upstream).

### Transitions (crossfade) are the first cross-clip concept

Everything above describes ONE clip; a transition is the first thing that relates TWO adjacent
clips on the same track. The key simplification is that it doesn't change that: a transition never
makes clips overlap in storage — `Clip.timelineStart`/`sourceIn`/`sourceOut` stay exactly as
`addClip`/`moveClip`/`trimClip`/`splitClip`/`carveRange` already enforce. `Clip.transitionIn?:
{ duration: number; type: "crossfade" }` is purely a render-time instruction: "blend in from
whatever clip ends exactly where I start."

`timeline/transitions.ts`'s `findTransitionPartner(track, clip)` is the ONE place both
`PlaybackEngine` and `buildExportPlan` decide whether a transition actually applies — re-checked
fresh on every call (zero-gap adjacency, duration clamped to both clips' current lengths), not
maintained through edits. An edit that breaks the precondition (a dragged-open gap, an over-trim)
just makes the transition silently stop applying — falls back to a plain cut — rather than needing
cleanup logic threaded through every edit operation. `splitClip`'s tail piece never inherits
`transitionIn` from the clip it was split from, the same way it never inherits `transform`/
`effects`/`mutedAudio` — no special-casing needed there either.

**The blend window is asymmetric, and preview/export must agree on WHERE.** The transition's
`duration` seconds live entirely within the INCOMING clip's own nominal window
(`[clip.timelineStart, clip.timelineStart + duration)`), never the outgoing clip's. In preview,
`drawVideoLayer` draws the outgoing clip's own tail frame (via a stripped-down sibling path,
`drawTransitionPartner`) underneath the incoming clip's normal frame, cross-fading between them —
plain alpha compositing, driven by a new `alphaMultiplier` parameter on `drawTransformed` that
layers on TOP of a clip's own `effects.opacity` rather than replacing it. In export, `buildSegments`
splices a third segment kind (`"transition"`, alongside `"clip"`/`"gap"`) directly into the same
list that already feeds the one `concat=n=X:v=1:a=1` chain — the outgoing clip's own segment is
emitted in FULL (unshortened; its tail plays once plainly, then again inside the transition), and
only the incoming clip's segment is shortened, at its HEAD, by the transition's own duration. This
keeps total exported duration exactly equal to the sum of every clip's nominal length, with no
separate accounting needed. The transition segment itself prepares two small `-ss`/`-t` slices (each
run through the SAME per-clip filter chain a plain segment already uses, so a transitioning clip's
own transform/effects still apply to its half), then blends them with `xfade=transition=fade` and
`acrossfade` — `offset=0` on both, since the two slices are already exactly `duration`-long and
start together.

### Multi-layer video compositing is free in preview, real work in export

Every visible video track composites, in array order — later tracks drawn on top of earlier ones,
the identical rule `drawTextLayer` already used for stacking text tracks (see its own comment).
`PlaybackEngine.drawVideoLayer` needed almost no new logic for this: `drawFrame` clears the canvas to
opaque black exactly ONCE per frame (not per track), and every `drawTransformed` call only ever
touches its own destination rect via `drawImage` — so a track's own gaps and letterbox bars naturally
show whatever a lower track already drew (or the original black clear) simply by never being painted
over, and a clip's own `effects.opacity` blends against that same prior canvas content via
`context.globalAlpha`. Real cross-track alpha compositing, with zero new blending code — the entire
change was generalizing "find the one video track" into "iterate every visible one."

Export has no equivalent "just don't touch those pixels" primitive, so it has to build the concept of
transparency explicitly. Each visible video track gets its own segment-based concat chain (built by
the exact same per-clip filter logic a single track always used), but a `transparent` flag — true for
every track except the bottom (base) one — swaps every "nothing here" fill from opaque `black` to
`black@0`: a non-base track's own gap segments, the plain scale+pad chain's letterbox `pad=`
(preceded by `format=rgba`), and a transformed clip's own internal micro-background inside
`buildTransformFilters`. The base track's own path is untouched byte-for-byte — zero regression risk
for the single-track case, which is still the overwhelming common one. Once every track has its own
`[cvN]`/`[caN]` pair, the video streams layer together with chained `overlay=format=auto` calls
(base first, so the result is guaranteed fully opaque — required since the `yuv420p` output has no
alpha channel at all), and every extra track's own audio folds into the SAME `amix` stage that
already mixes in voiceover/music overlay clips.

### Export builds one filter graph

`buildExportPlan` walks each visible video track and emits a segment per clip plus a **real black (or,
on a non-base track, transparent) + silence segment for every gap** — otherwise the exported video
would be shorter than the edit and everything after a gap would land at the wrong time.

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

- **More transition styles** (wipe/slide/etc.) — crossfade (see "Transitions" above) is the only
  `type` implemented. FFmpeg's `xfade` supports many more, but matching one in the canvas preview
  needs real clip-path masking, not just alpha blending — deliberately left out of this pass.
- **Blend modes** (multiply/screen/etc.) — cross-track compositing (see "Multi-layer video
  compositing" above) is plain alpha-over only, driven by each clip's own `effects.opacity`. A blend
  mode would need a new field (Track- or Clip-scoped) and a matching `context.globalCompositeOperation`
  value in preview plus an FFmpeg `blend=all_mode=` value in export instead of `overlay`'s default.
- **Keyframes** want an animatable-property layer over `ClipTransform` AND now `ClipEffects`
  (interpolating between timestamped values instead of one static one, for either); both
  `SetClipTransformCommand` and `SetClipEffectsCommand`'s trivial-inverse shape would need to become
  a `TrackScopedCommand`-style memento once a value can vary within a clip.
- **On-canvas crop handles** would reuse `TransformHandles`' existing drag-then-single-commit
  machinery, just computing crop fractions instead of scale/rotation from the drag delta.
- **Captions** get a track kind and a render pass in both renderers (distinct from Text, which is
  already a real track kind — captions specifically means importing/generating a synced subtitle
  track, not just rendering text).
- **Proxies** slot into `mediaUrlFor` (preview) while export keeps resolving originals.
- **AI features** belong behind the API layer as separate routes; nothing in the core model needs to
  know about them.
