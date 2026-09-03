# Developing VCut

## Setup

```bash
pnpm install
pnpm dev:vcut
```

Open `http://localhost:3002` — VCut's own home page, no BP project required. To develop against
BP's Create-stage embedding specifically (the `<iframe>` path), also run `pnpm dev:bp` and open a
project's Create stage from there instead.

Next.js 16 allows **one dev server per project directory**. If `pnpm dev:vcut` reports the port is
in use, an earlier server is still running; Next prints its PID and the exact `taskkill` / `kill`
command to stop it. Note that the packaged Veasna OS desktop app also serves VCut on :3002, so
close it (or run `next dev -p <other>`) when developing.

## Tests

```bash
pnpm --filter @veasnawt/vcut test        # node --test over tests/*.test.ts
```

These run Node's built-in test runner **directly against TypeScript source** — no build step and no
test framework. Two constraints follow from that, and both are load-bearing:

1. **Relative imports carry explicit `.ts`/`.tsx` extensions.** Node's ESM resolver requires them.
   `allowImportingTsExtensions` is enabled in this package's tsconfig (and bp's, since bp typechecks
   this source too).
2. **No TypeScript parameter properties** (`constructor(private x: T)`). They can't be erased by
   stripping types alone, so Node rejects them. Declare fields explicitly instead — see the note in
   `commands/index.ts`.

Type-only imports must use `import type`, for the same erasure reason.

## Typecheck

```bash
# the package
./studios/universe/node_modules/.bin/tsc --noEmit -p packages/vcut/tsconfig.json
# the host (also typechecks the package's source)
cd studios/vcut && ./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

## Styling

VCut's components use Tailwind utilities, but Tailwind only scans the app it runs in.
`studios/vcut` therefore declares this package as an extra source in `app/globals.css`:

```css
@source "../../../packages/vcut/src";
```

**Without it the editor renders completely unstyled** — every utility class it uses simply won't exist
in the generated stylesheet. This is easy to miss because the app still *works*: layout driven by
inline styles (clip positions) is fine, so you get a functional editor with zero-height clips and
invisible drag handles. If you add another host app, it needs this line too.

## Adding an edit operation

1. Write the pure transform in `timeline/operations.ts` (project in → new project out, never mutate).
2. Add a test in `tests/operations.test.ts`, including the boundary cases.
3. Wrap it in a command in `commands/index.ts`, extending `TrackScopedCommand` if it changes clips.
4. Add it to `tests/undo.test.ts`'s round-trip suite — apply → revert → redo must return to identical
   state.
5. Wire it to the UI, dispatching through `useEditorStore().run(command)`.

If the operation creates clips, generate their ids **in the command's constructor** and thread them
through, so redo reproduces the same ids. `tests/undo.test.ts` has a test that catches getting this
wrong.

## Working on export

`buildExportPlan` is pure — the fastest loop is a unit test, not a render. To see the actual argv:

```js
import { buildExportPlan } from "./src/export/buildExportPlan.ts";
console.log(buildExportPlan(project, { inputPathFor: (id) => `/m/${id}.mp4`, outputPath: "/o.mp4" }).args.join(" "));
```

Then run that argv against the bundled FFmpeg directly to iterate on the filter graph without the app
in the loop. This is exactly how the transform feature's `crop`/`rotate`/`overlay` chain was developed:
a standalone `execFileSync(ffmpegBinary, [...])` script against a `testsrc` pattern, inspecting the
rendered PNG, before any of it was wired into `buildExportPlan`. For anything involving FFmpeg's
expression syntax (the `min(...)`, `rotw(a)`, `(W-w)/2+x` style arguments used by the transform
filters), verify against the real binary rather than trusting memory of the exact syntax — it's easy
to get subtly wrong, and a filter graph that mis-parses fails immediately and loudly, which makes this
loop fast.

## End-to-end verification

The editor is driven through its real UI (clicks, drags, keyboard) with Playwright, and verified
through its real API — no test-only hooks are added to the app. The one accommodation made for
testability was giving interactive elements proper `aria-label`s, which they should have anyway.

The 15 milestone operations are checked in one pass, including that the source file's SHA-256 is
unchanged after a trim, and that the exported MP4's real duration (via ffprobe) matches the timeline.

## Gotchas worth knowing

- **`ffmpeg-static` downloads its binary in a postinstall step.** `pnpm-workspace.yaml` must allow it
  (`allowBuilds: ffmpeg-static: true`). If the package is already installed, pnpm won't re-run the
  script — use `pnpm rebuild ffmpeg-static`, or run its `install.js` directly.
- **Don't dispatch commands from inside a `setState` updater.** Updaters run during render, and
  dispatching a store update from there triggers React's "Cannot update a component while rendering a
  different component" warning. `TimelineClip` mirrors its drag preview into a ref precisely so the
  mouse-up handler can read the final value without this.
- **`structuredClone` is the cloning primitive** throughout. It only works because the model is plain
  data — don't put a class instance, `Map`, or function into `Project`.
