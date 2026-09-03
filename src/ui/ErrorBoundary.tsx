import React from "react";
import { reportError } from "../api/crashLog.ts";
import { translateText } from "../i18n/translations.ts";
import { useEditorStore } from "../store/editorStore.ts";

interface State {
  error: Error | null;
}

/** Catches render-time throws anywhere in `VCutApp`'s own subtree (`VCutApp.tsx` wraps its
 *  export in exactly this) and shows a recovery screen instead of the blank, unmounted-React screen
 *  an uncaught render error produces today. Must be a class component — `getDerivedStateFromError`/
 *  `componentDidCatch` have no hooks equivalent; this is the one place in this whole app that's
 *  deliberately not a function component. `t()` is called via the plain `translateText` export (not
 *  the `useTranslation` hook, which needs a function component) — reads `language` fresh from
 *  `useEditorStore.getState()` on each render, which is exactly as current as a hook subscription
 *  would be for a screen that only ever renders once per crash anyway. */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    reportError("react-error-boundary", error, { componentStack: info.componentStack ?? undefined });
  }

  render() {
    if (!this.state.error) return this.props.children;

    const t = (text: string) => translateText(useEditorStore.getState().language, text);
    const hasCrashReporter = typeof window !== "undefined" && !!window.veasnaCrashReporter;

    return (
      <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-4 bg-[#0a0c10] p-6 text-center text-white">
        <h1 className="text-base font-semibold">{t("Something went wrong")}</h1>
        <p className="max-w-md text-xs text-white/60">
          {t("VCut hit an unexpected error and couldn't continue. Your project's last save is safe — reloading will get you back to it.")}
        </p>
        {/* The raw message, not the full stack — enough for the user to describe what happened when
            reporting a bug, without dumping an intimidating wall of text onto a recovery screen. The
            full stack already went to the crash log via componentDidCatch above. */}
        <p className="max-w-md truncate text-[11px] text-white/30" title={this.state.error.message}>
          {this.state.error.message}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => window.location.reload()}
            className="rounded-md bg-sky-500 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-400"
          >
            {t("Reload")}
          </button>
          {hasCrashReporter && (
            <button
              onClick={() => void window.veasnaCrashReporter?.showLogFolder()}
              className="rounded-md px-4 py-1.5 text-xs font-medium text-white/60 transition hover:bg-white/10 hover:text-white"
            >
              {t("Show log folder")}
            </button>
          )}
        </div>
      </div>
    );
  }
}
