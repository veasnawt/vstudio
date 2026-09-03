declare global {
  interface Window {
    /** Only defined inside the packaged/dev Electron shell (`apps/vcut-desktop`), wired up by its
     *  own `preload.ts` — absent entirely in a plain browser tab or BP Studio's `<iframe>` embed,
     *  which is exactly how `reportError` below picks its transport. */
    veasnaCrashReporter?: {
      report: (payload: { context: string; message: string; stack?: string }) => Promise<void>;
      showLogFolder: () => Promise<void>;
    };
  }
}

/** Routes a caught error to whichever transport is actually available — the Electron IPC bridge
 *  (`window.veasnaCrashReporter`, desktop only, relays to `apps/vcut-desktop/src/main.ts`'s own
 *  `logCrash`) if present, else a best-effort POST to the web fallback API route (covers both the
 *  standalone `/` page and BP Studio's `<iframe>` embed of `/edit`, neither of which has filesystem
 *  access from the browser to write a log itself). Never throws itself, and never awaited by its
 *  callers — a failure to REPORT an error must never become a second, more confusing error on top of
 *  the one already being handled. */
export function reportError(context: string, error: unknown, extra?: Record<string, unknown>): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  // Always logged locally too — dev-mode console visibility shouldn't depend on either transport
  // below actually succeeding.
  console.error(`[${context}]`, error);

  if (typeof window === "undefined") return;
  const payload = { context, message, stack, extra };
  if (window.veasnaCrashReporter) {
    void window.veasnaCrashReporter.report(payload).catch(() => {});
  } else {
    void fetch("/api/vcut/crash-report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }
}
