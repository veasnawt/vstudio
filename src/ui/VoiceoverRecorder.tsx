"use client";

import { useEffect, useRef, useState } from "react";
import { Microphone } from "@veasnawt/vicons";
import { AddClipCommand } from "../commands/index.ts";
import { useEditorStore } from "../store/editorStore.ts";

/** How often the live recording indicator's length is refreshed while capturing. Fast enough to look
 *  genuinely live growing on the timeline, far below the cost of the 30-60/sec playhead updates
 *  `PlaybackEngine` deliberately avoids subscribing every clip to — this only ever drives ONE overlay
 *  element (see `Timeline.tsx`'s `recording &&` block), not a per-clip re-render. */
const INDICATOR_TICK_MS = 150;

/** Candidate `MediaRecorder` mime types, most-preferred first. Browsers vary in which container/codec
 *  they'll actually record to (Chrome/Firefox favor WebM+Opus, Safari's MediaRecorder support is
 *  spottier and prefers different types) — probing `isTypeSupported` and falling back to the browser's
 *  own default (an empty options object) is what keeps this working everywhere, rather than throwing
 *  on an explicit type this particular browser doesn't support. */
const CANDIDATE_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Records a voiceover straight from the microphone and places it directly on the timeline at the
 *  playhead — a toolbar action, not a media-library one, so the result shows up where you're
 *  actually working (timeline + preview), with no separate "now go find it and place it" step.
 *  A live indicator (`useEditorStore`'s `recording` state, rendered by `Timeline.tsx`) grows in the
 *  target track's lane for the ENTIRE capture — the point of it is that there's nothing to wait for:
 *  the target track/start are picked and shown the instant recording begins, not once it stops. Still
 *  goes through the same `importFiles` path a dragged-in audio file does under the hood once capture
 *  actually ends (probed, copied into the project, added as a normal asset) — recording is just
 *  another SOURCE of a `File`, not a parallel import system; only what happens with the resulting
 *  asset differs from a plain import, and that async step is now purely a background finalize instead
 *  of something the indicator's very existence depends on. */
export function VoiceoverRecorder() {
  const importFiles = useEditorStore((s) => s.importFiles);
  const run = useEditorStore((s) => s.run);
  const setStatus = useEditorStore((s) => s.setStatus);

  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  /** Where THIS take lands, fixed the instant capture begins (see `beginVoiceoverRecording`) — read
   *  again in `onstop` so the real clip lands in the exact spot the live indicator has been showing,
   *  not wherever the playhead/track picking logic would resolve to a moment later. */
  const targetRef = useRef<{ trackId: string; start: number } | null>(null);

  function releaseStream() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }

  // Leaving the page (or this component going away) mid-recording must not leave the microphone
  // silently "hot" — the browser's own mic-in-use indicator would keep showing with nothing the user
  // can see here to turn it off.
  useEffect(() => releaseStream, []);

  async function start() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      // The single most common real-world cause: `getUserMedia` only exists in a "secure context"
      // (`https:`, or `localhost`/`127.0.0.1` exactly) — a LAN IP like `192.168.1.18` over plain HTTP
      // (the same address `_lib/localOnly.ts`'s own LAN-access allowance is FOR) is not one. Safari in
      // particular has no exception for private/LAN addresses the way some Chromium builds do, so
      // `navigator.mediaDevices` is entirely `undefined` there — confirmed live, not just from spec —
      // rather than merely missing `getUserMedia` off an otherwise-present object. Told apart from a
      // browser that's simply too old to have the API at all, since the fix is completely different
      // (there's no version to upgrade to here — the origin itself has to change).
      const insecure = typeof window !== "undefined" && window.isSecureContext === false;
      setStatus(
        insecure
          ? "Recording needs a secure connection (HTTPS, or localhost) — this page was opened over a plain http:// LAN address, which browsers block microphone access from."
          : "This browser can't record audio — no microphone API available",
        "error"
      );
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      // Distinguished because the fix differs: a real "no" needs a permission-settings change, a
      // missing device needs different hardware, anything else (including a late-caught insecure-
      // context `SecurityError` some browsers report here instead of via the guard above) falls back
      // to the same generic message the code already had.
      const name = err instanceof Error ? err.name : "";
      setStatus(
        name === "NotAllowedError"
          ? "Microphone access was denied — allow it for this site in your browser's settings and try again."
          : name === "NotFoundError"
            ? "No microphone was found on this device."
            : "Microphone access was denied or unavailable",
        "error"
      );
      return;
    }

    // Picked and shown on the timeline THE INSTANT capture begins — see `beginVoiceoverRecording`'s
    // own comment for why the real clip, placed once the take finishes, reuses this exact value
    // rather than re-resolving a target/start from scratch (which could land somewhere slightly
    // different once the true duration is known, making the indicator visibly jump at the end).
    const target = useEditorStore.getState().beginVoiceoverRecording();
    if (!target) {
      stream.getTracks().forEach((track) => track.stop());
      setStatus("Open a project before recording a voiceover", "error");
      return;
    }
    targetRef.current = target;

    streamRef.current = stream;
    chunksRef.current = [];
    const mimeType = CANDIDATE_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported?.(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = async () => {
      releaseStream();
      const finalTarget = targetRef.current;
      targetRef.current = null;
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      chunksRef.current = [];
      // A container-appropriate extension, not just ".webm" always — `importMedia`'s server side
      // probes the actual bytes with ffprobe regardless, but a mismatched extension is still
      // needlessly confusing to see later in an OS file browser (it's kept out of the Media Library
      // itself — see `hiddenFromLibrary` below — so this no longer matters for that specifically).
      const ext = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "m4a" : "webm";
      const stamp = new Date().toLocaleTimeString([], { hour12: false }).replace(/:/g, "-");
      const file = new File([blob], `Voiceover ${stamp}.${ext}`, { type: blob.type });
      // A quick voiceover take belongs on the timeline, not in the library alongside deliberately
      // imported media — it's still a real asset underneath (the placed clip references it like any
      // other), just excluded from the list `MediaLibrary` renders.
      const [asset] = await importFiles([file], { hiddenFromLibrary: true });
      if (asset && finalTarget) run(new AddClipCommand(finalTarget.trackId, asset.id, finalTarget.start));
      useEditorStore.getState().clearRecordingIndicator();
    };

    recorder.start();
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    setElapsed(0);
    setRecording(true);
    timerRef.current = setInterval(() => {
      const elapsedSeconds = (Date.now() - startedAtRef.current) / 1000;
      setElapsed(Math.floor(elapsedSeconds));
      const store = useEditorStore.getState();
      store.updateRecordingElapsed(elapsedSeconds);
      // Advances the playhead in lockstep with the growing indicator — the same reason playback
      // moves it, so the preview shows roughly where the take currently is instead of sitting frozen
      // at the spot recording started from. `setPlayhead` clamps to the CURRENT timeline length on its
      // own, same as everywhere else it's called from.
      store.setPlayhead(target.start + elapsedSeconds);
    }, INDICATOR_TICK_MS);
  }

  function stop() {
    recorderRef.current?.stop();
    recorderRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setRecording(false);
    // Freezes the indicator at its final length instead of letting it vanish while `onstop`'s async
    // import runs — it reappears as the real clip (or clears on failure) once that settles.
    useEditorStore.getState().finalizeRecordingIndicator();
  }

  // Sized to match ToolbarButton (VStudioApp.tsx's h-8 icon buttons) while recording, but wider —
  // the elapsed-time readout needs the room, and a growing/shrinking control is a fine trade for
  // showing the one piece of info (how long you've been talking) that actually matters mid-recording.
  if (recording) {
    return (
      <button
        onClick={stop}
        aria-label="Stop recording"
        title="Stop recording"
        className="flex h-8 shrink-0 items-center gap-1.5 rounded px-2 text-xs font-medium tabular-nums text-rose-300 transition hover:bg-rose-500/20"
      >
        <span aria-hidden className="h-2.5 w-2.5 animate-pulse rounded-full bg-rose-400" />
        {pad2(Math.floor(elapsed / 60))}:{pad2(elapsed % 60)}
      </button>
    );
  }

  return (
    <button
      onClick={start}
      aria-label="Record voiceover"
      title="Record a voiceover from your microphone"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-white/70 transition hover:bg-white/10 hover:text-white"
    >
      <Microphone size={20} />
    </button>
  );
}
