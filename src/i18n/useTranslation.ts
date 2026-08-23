import { useEditorStore } from "../store/editorStore.ts";
import { translateText } from "./translations.ts";

/** The hook every UI component uses: `const t = useTranslation();` then `t("Export")`. Subscribes to
 *  `language` so every component using it re-renders when the toggle flips — the plain `translateText`
 *  export exists separately for non-component code (store actions) that already has `language` on
 *  hand and has no hook to call. */
export function useTranslation() {
  const language = useEditorStore((s) => s.language);
  return (text: string, params?: Record<string, string | number>) => translateText(language, text, params);
}
