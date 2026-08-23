"use client";

import React, { useEffect, useRef, useState } from "react";
import { ChevronDown } from "@veasnawt/vicons";

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
  /** Applied to the option's own label text — used by the font picker to render each entry in its
   *  own font, a preview a native `<option>` couldn't reliably show either. */
  style?: React.CSSProperties;
}

/** A dropdown that looks the same everywhere, because it IS the same everywhere — a native `<select>`'s
 *  OPEN popup is the browser's own chrome, not something this app's stylesheet paints, and on Windows
 *  Chromium in particular that popup does not reliably honor an `<option>`'s own `background-color`/
 *  `color` (confirmed directly: `getComputedStyle` on the option reported the app's dark color, but the
 *  actual rendered popup was still the OS-default white list — a real, long-standing browser gap, not a
 *  CSS mistake here). Rendering the open list as normal DOM instead sidesteps the whole class of
 *  "adapts to the theme" bugs a native popup can have, at the cost of writing basic open/close/keyboard
 *  handling by hand. */
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  onHoverOption,
  ariaLabel,
  className,
  disabled,
  searchable,
  searchPlaceholder,
}: {
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  /** Fired with an option's value on mouse-enter and `null` on mouse-leave — lets a caller (the
   *  Inspector's font picker, so far the only user of this) drive a LIVE preview of the hovered value
   *  before it's actually committed via `onChange`. Also fired with `null` whenever the popup closes
   *  for any reason (a selection, an outside click, Escape), so a preview started by hovering can never
   *  outlive the popup that started it. Optional — every other `Dropdown` caller ignores it entirely. */
  onHoverOption?: (value: T | null) => void;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
  /** Adds a text filter at the top of the open list — worth the extra row only for a genuinely long
   *  option list (the font picker's 30+ entries); every shorter list elsewhere (Transition style, sort
   *  order, …) leaves this off and keeps its plain scroll-to-find behavior. */
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const current = options[index];
  const visibleOptions =
    searchable && query.trim() ? options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase())) : options;

  // Becoming disabled mid-open (e.g. an export starts while the list is still open) closes it —
  // a disabled `<select>` can't have an open popup either, and the button losing its click handler
  // alone wouldn't close a list already on screen.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // Closes on an outside click/tap and on Escape — the two ways a native `<select>`'s popup would
  // also dismiss without picking anything. Also resets the search query and clears any in-progress
  // hover preview — both are state that only makes sense while THIS popup instance is open.
  useEffect(() => {
    if (!open) return;
    function close() {
      setOpen(false);
      setQuery("");
      onHoverOption?.(null);
    }
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Autofocuses the search field the instant it appears — opening the popup should let a keyboard/
  // mouse user start typing immediately, matching how a native `<select>`'s own type-ahead works
  // without needing a separate click into a search box first.
  useEffect(() => {
    if (open && searchable) searchInputRef.current?.focus();
  }, [open, searchable]);

  function moveBy(delta: number) {
    const next = options[Math.min(options.length - 1, Math.max(0, index + delta))];
    if (next) onChange(next.value);
  }

  return (
    <div ref={rootRef} className={`relative ${className ?? ""}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          // Same up/down-without-opening convenience a native `<select>` gives you — no need to open
          // the list just to step to an adjacent option.
          if (e.key === "ArrowDown") {
            e.preventDefault();
            open ? setOpen(true) : moveBy(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            moveBy(-1);
          } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-1.5 rounded-md bg-white/5 px-2 py-1 text-left text-white/70 focus:outline-none focus:ring-1 focus:ring-sky-400/60 disabled:opacity-50"
      >
        <span style={current?.style} className="min-w-0 flex-1 truncate">
          {current?.label ?? ""}
        </span>
        <span aria-hidden className="flex shrink-0 items-center text-white/40">
          <ChevronDown size={12} />
        </span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-full overflow-hidden rounded-md border border-white/10 bg-[#14161c] shadow-xl">
          {searchable && (
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Escape is already handled globally (closes + clears, see the effect above); stopping
                // it here too would be redundant but harmless. Enter picks the first still-visible
                // match — the same "just start typing, hit enter" flow a native `<select>`'s own
                // type-ahead gives you, just explicit here since there's no OS-level type-ahead over a
                // plain DOM list.
                if (e.key === "Enter" && visibleOptions[0]) {
                  e.preventDefault();
                  setOpen(false);
                  setQuery("");
                  onChange(visibleOptions[0].value);
                }
              }}
              placeholder={searchPlaceholder}
              className="w-full border-b border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white placeholder:text-white/30 focus:outline-none"
            />
          )}
          <ul role="listbox" aria-label={ariaLabel} className="max-h-60 overflow-y-auto py-1">
            {visibleOptions.length === 0 && searchable && (
              <li className="px-2.5 py-1.5 text-xs text-white/40">No matches</li>
            )}
            {visibleOptions.map((o) => (
              <li
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                onClick={(e) => {
                  // Defensive, not just tidy: if a caller ever nests this inside a `<label>` again (an
                  // easy mistake — this looked exactly like the sort of small form-field row a `<label>`
                  // is normally reached for), an unstopped click bubbling up to that label would get
                  // forwarded to the toggle BUTTON below (HTML's native "click a label, activate its
                  // labelable descendant" behavior — a `<button>` counts), reopening what this click just
                  // closed. Confirmed as the actual cause of exactly that bug once, the hard way.
                  e.stopPropagation();
                  setOpen(false);
                  setQuery("");
                  onChange(o.value);
                }}
                onMouseEnter={() => onHoverOption?.(o.value)}
                onMouseLeave={() => onHoverOption?.(null)}
                style={o.style}
                className={`cursor-pointer whitespace-nowrap px-2.5 py-1.5 text-xs transition ${
                  o.value === value ? "bg-sky-500/25 text-white" : "text-white/80 hover:bg-white/10"
                }`}
              >
                {o.label}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
