"use client";

import { createPortal } from "react-dom";
import { Close } from "@veasnawt/vicons";
import { useTranslation } from "../i18n/useTranslation.ts";
import { addDragListeners, clientPoint, preventDefaultIfMouse } from "./pointerEvents.ts";

export interface FloatRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Generic floating-window chrome for a panel that also has a DOCKED shape elsewhere (currently
 *  Mixer/Scopes, `VCutApp.tsx`'s own `floatState`) — this component only ever renders the FLOATING
 *  case; the docked case renders the panel's own component directly, with no wrapper at all, so this
 *  file has zero involvement when nothing is floating. Deliberately generic (`children`, not a
 *  panel-specific prop) so a third panel can float later without touching this file.
 *
 *  Modeled on two patterns already used elsewhere in this app rather than inventing new ones:
 *  `TransitionPickerMenu.tsx`'s `createPortal`/`position:fixed`/`z-50` shape for the floating chrome
 *  itself, and `VCutApp.tsx`'s `beginTimelineResize` drag shape (`preventDefaultIfMouse` →
 *  `clientPoint` → capture a start value → `addDragListeners` → compute delta → clamp → report back)
 *  for both the move-by-title-bar and resize-by-corner-handle interactions below — the same
 *  `pointerEvents.ts` primitives every other drag interaction in this app already shares.
 *
 *  Deliberately has NO outside-click/Escape-to-dismiss, unlike `TransitionPickerMenu`'s popup — a
 *  floating Mixer/Scopes is a persistent workspace window a user arranges deliberately, not a transient
 *  menu; only the explicit Dock button here closes it. `rect`/`onRectChange` are fully controlled by
 *  the caller (`VCutApp.tsx`'s `floatState`) — this component never owns position/size itself, so
 *  it has nothing of its own to lose if the caller re-renders. */
export function FloatablePanel({
  title,
  rect,
  onRectChange,
  onDock,
  minWidth,
  minHeight,
  children,
}: {
  title: string;
  rect: FloatRect;
  onRectChange: (rect: FloatRect) => void;
  onDock: () => void;
  minWidth: number;
  minHeight: number;
  children: React.ReactNode;
}) {
  const t = useTranslation();

  function beginMove(event: React.MouseEvent | React.TouchEvent) {
    preventDefaultIfMouse(event);
    const start = clientPoint(event);
    const origin = rect;
    const removeListeners = addDragListeners(
      (moveEvent) => {
        const point = clientPoint(moveEvent);
        const dx = point.x - start.x;
        const dy = point.y - start.y;
        // Clamped to keep at least an 8px sliver on every edge grabbable/visible — the same "never
        // let a drag push the thing you're dragging somewhere you can no longer reach it" floor
        // `beginTimelineResize`'s own clamp exists for, just in two axes instead of one.
        const x = Math.min(Math.max(8, origin.x + dx), window.innerWidth - origin.width - 8);
        const y = Math.min(Math.max(8, origin.y + dy), window.innerHeight - origin.height - 8);
        onRectChange({ ...origin, x, y });
      },
      () => removeListeners()
    );
  }

  function beginResize(event: React.MouseEvent | React.TouchEvent) {
    event.stopPropagation();
    preventDefaultIfMouse(event);
    const start = clientPoint(event);
    const origin = rect;
    const removeListeners = addDragListeners(
      (moveEvent) => {
        const point = clientPoint(moveEvent);
        const dx = point.x - start.x;
        const dy = point.y - start.y;
        const width = Math.min(Math.max(minWidth, origin.width + dx), window.innerWidth - origin.x - 8);
        const height = Math.min(Math.max(minHeight, origin.height + dy), window.innerHeight - origin.y - 8);
        onRectChange({ ...origin, width, height });
      },
      () => removeListeners()
    );
  }

  return createPortal(
    <div
      style={{ position: "fixed", left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      className="z-50 flex flex-col overflow-hidden rounded-lg border border-white/10 bg-[#0d0f14] shadow-2xl"
    >
      <div
        onMouseDown={beginMove}
        onTouchStart={beginMove}
        className="flex shrink-0 cursor-move touch-none items-center justify-between gap-2 border-b border-white/10 bg-white/[0.03] px-3 py-1.5"
      >
        <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-white/50">{title}</span>
        <button
          onClick={onDock}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          title={t("Dock")}
          aria-label={t("Dock {title}", { title })}
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-white/50 transition hover:bg-white/10 hover:text-white"
        >
          <Close size={12} />
          {t("Dock")}
        </button>
      </div>

      <div className="min-h-0 flex-1">{children}</div>

      <div
        onMouseDown={beginResize}
        onTouchStart={beginResize}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("Resize {title}", { title })}
        title={t("Resize")}
        className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize touch-none"
      >
        {/* Plain diagonal-grip glyph, no icon needed for something this small and this standard a
            gesture (every OS window's own resize corner looks roughly like this). */}
        <svg viewBox="0 0 16 16" className="h-full w-full p-1 text-white/25">
          <path d="M14 14L14 10M14 14L10 14M14 6L6 14" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      </div>
    </div>,
    document.body
  );
}
