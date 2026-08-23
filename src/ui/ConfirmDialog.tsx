"use client";

import { createPortal } from "react-dom";
import { useTranslation } from "../i18n/useTranslation.ts";

/** A small confirm/cancel modal for actions that need a deliberate second click before they happen —
 *  same overlay/card visual language as `ExportDialog`, kept generic (title/message/labels as props)
 *  rather than one-off inline JSX per call site, since "are you sure?" is exactly the kind of prompt
 *  more than one destructive action in this editor will eventually need.
 *
 *  Rendered via a portal into `document.body` rather than in place. `fixed inset-0` is normally
 *  viewport-relative, but per the CSS spec ANY ancestor with a `transform` becomes the containing
 *  block for a `position: fixed` descendant instead — and `TrackHeader` (this dialog's original call
 *  site) lives inside `Timeline`'s track-header list, which gets a `transform: translateY(...)`
 *  applied to keep it in sync with the timeline's own scroll (see Timeline.tsx). Without the portal,
 *  that turned this dialog's "cover the whole screen" overlay into "cover the 116px-wide, clipped
 *  header column instead" — the actual "remove track" confirmation appearing squeezed and cut off. A
 *  portal sidesteps the whole containing-block chain, which is also just the right general fix for any
 *  modal: nothing about a confirmation dialog should depend on where in the tree it happens to be
 *  mounted. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = true,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useTranslation();
  const resolvedConfirmLabel = confirmLabel ?? t("Remove");
  const resolvedCancelLabel = cancelLabel ?? t("Cancel");
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onCancel}
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl border border-white/10 bg-[#12151c] p-5 shadow-2xl"
      >
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        <p className="mt-2 text-xs leading-relaxed text-white/60">{message}</p>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            {resolvedCancelLabel}
          </button>
          <button
            onClick={onConfirm}
            autoFocus
            className={`rounded-md px-3 py-1.5 text-xs font-semibold text-white transition ${
              danger ? "bg-rose-500 hover:bg-rose-400" : "bg-sky-500 hover:bg-sky-400"
            }`}
          >
            {resolvedConfirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
