"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { NumberField } from "./NumberField.tsx";

const DEFAULT_SECONDS_PER_LINE = 3;

/** Turns a pasted block of text — a script, lyrics, a caption list — into a run of text clips, one
 *  per non-empty line, placed back-to-back starting at the playhead. A purely client-side sibling to
 *  Auto Captions: same DESTINATION (`landCaptions` → `AddCaptionsCommand`, one new "Captions" text
 *  track, one undo-able step), but no audio, no transcription job, no server round-trip at all — the
 *  "timing" here is just `secondsPerLine * lineIndex`, computed locally the instant Generate is
 *  clicked, so this dialog needs none of Auto Captions' job/SSE/credentials machinery. */
export function TextToClipsDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslation();
  const landCaptions = useEditorStore((s) => s.landCaptions);
  const [text, setText] = useState("");
  const [secondsPerLine, setSecondsPerLine] = useState(DEFAULT_SECONDS_PER_LINE);

  // Blank lines are just formatting/spacing in a pasted script — they don't become empty clips (an
  // empty text clip has nothing to show and nothing meaningful to select/edit later).
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  function generate() {
    if (lines.length === 0) return;
    const playhead = useEditorStore.getState().playhead;
    const segments = lines.map((content, i) => ({
      content,
      start: playhead + i * secondsPerLine,
      end: playhead + (i + 1) * secondsPerLine,
    }));
    landCaptions(segments);
    onClose();
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t("Import Text as Clips")}
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-xl border border-white/10 bg-[#12151c] p-5 shadow-2xl">
        <h2 className="text-sm font-semibold text-white">{t("Import Text as Clips")}</h2>
        <p className="mt-2 text-xs leading-relaxed text-white/60">
          {t("Paste a script, lyrics, or a caption list — each line becomes its own text clip, placed back-to-back starting at the playhead.")}
        </p>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          autoFocus
          placeholder={t("One line per clip…")}
          // 16px below `lg`: same iOS Safari auto-zoom-on-focus reasoning every other text input in
          // this app already follows (see MediaLibrary's search box for the original instance).
          className="mt-3 w-full resize-none rounded bg-white/5 px-2.5 py-2 text-[16px] text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-sky-400/60 lg:text-[13px]"
        />

        <div className="mt-1 flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <NumberField
              label={t("Seconds per line")}
              value={secondsPerLine}
              suffix="s"
              step={0.5}
              min={0.5}
              max={10}
              onCommit={(v) => setSecondsPerLine(v)}
            />
          </div>
          <span className="shrink-0 text-[11px] text-white/35">{t("{n} clips", { n: lines.length })}</span>
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            {t("Cancel")}
          </button>
          <button
            onClick={generate}
            disabled={lines.length === 0}
            className="rounded-md bg-sky-500 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-400 disabled:opacity-50"
          >
            {t("Generate Clips")}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
