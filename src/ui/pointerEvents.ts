import type React from "react";

/** Extracts client coordinates from either a mouse or touch event — the drag interactions in this
 *  editor (ruler scrub, clip move/trim, transform handles) support both input types through ONE
 *  shared drag implementation rather than duplicating the drag math per pointer type. Mobile browsers
 *  no longer synthesize mouse events from touch, so without this every drag-based interaction here
 *  was silently dead on a real touchscreen — taps worked (they fire `click`), drags did not. */
export function clientPoint(e: MouseEvent | TouchEvent | React.MouseEvent | React.TouchEvent): { x: number; y: number } {
  if ("touches" in e) {
    const touch = e.touches[0] ?? e.changedTouches[0];
    return { x: touch?.clientX ?? 0, y: touch?.clientY ?? 0 };
  }
  return { x: e.clientX, y: e.clientY };
}

/** `preventDefault()`, but only for a mouse event — React's `onTouchStart`/`onTouchMove` JSX props
 *  are passive by default (same reason `onWheel` is: touch-scroll performance), so calling
 *  `preventDefault` from inside one throws "Unable to preventDefault inside passive event listener
 *  invocation" and does nothing anyway. It isn't needed there regardless: the drag-source elements
 *  this pairs with all carry `touch-none` in their className, which suppresses the browser's default
 *  touch gestures (scroll/pan) declaratively instead. Mouse still needs the JS call — `touch-none` is
 *  a no-op for a mouse pointer — mainly to stop text selection while dragging. */
export function preventDefaultIfMouse(e: React.MouseEvent | React.TouchEvent): void {
  if (!("touches" in e)) e.preventDefault();
}

/** Registers `onMove`/`onEnd` for BOTH mouse and touch, and returns one function that removes all
 *  four listeners — the pattern every drag interaction in this file uses on press, so a single mouse-
 *  or single-finger-touch gesture is handled identically from here on. `{ passive: false }` on the
 *  touch listeners is what allows `preventDefault` inside them; without it the browser would still try
 *  to scroll/pan the page underneath the drag (see MDN on passive event listeners — React's own
 *  `onTouchMove` JSX prop is passive by default for the same scroll-performance reason `onWheel` is,
 *  which is why this attaches natively instead). */
export function addDragListeners(onMove: (e: MouseEvent | TouchEvent) => void, onEnd: (e: MouseEvent | TouchEvent) => void): () => void {
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onEnd);
  window.addEventListener("touchmove", onMove, { passive: false });
  window.addEventListener("touchend", onEnd);
  window.addEventListener("touchcancel", onEnd);
  return () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onEnd);
    window.removeEventListener("touchmove", onMove);
    window.removeEventListener("touchend", onEnd);
    window.removeEventListener("touchcancel", onEnd);
  };
}
