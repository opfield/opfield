import { useEffect, useRef } from "react";

/** Pause after the last keystroke before a list applies its search. */
export const LIVE_SEARCH_DELAY_MS = 300;

/**
 * Applies the typed search on its own after a short pause, so a list never waits for Enter. `applied` is the search
 * the list currently shows; Enter can still apply it at once through the list's submit handler.
 */
export function useLiveSearch(
  input: string,
  applied: string,
  apply: (value: string) => void,
  delayMs = LIVE_SEARCH_DELAY_MS
) {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    if (input === applied) return;
    const timer = window.setTimeout(() => applyRef.current(input), delayMs);
    return () => window.clearTimeout(timer);
  }, [input, applied, delayMs]);
}
