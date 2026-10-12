import { useCallback, useEffect } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { type NavigationTrailState, pageKeyForPath, planBackStep } from "@/lib/navigation-trail";
import { getReturnNavigationTarget } from "@/lib/return-navigation";
import { useNavigationTrailStore } from "@/stores/navigation-trail";

let lastRecordedLocationKey: string | null = null;
let documentLocationSeen = false;

/** Browser history index of the current entry (React Router keeps it in history.state). */
function currentHistoryIdx(): number | undefined {
  if (typeof window === "undefined") return undefined;
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" ? idx : undefined;
}

/** Records console page visits into the navigation trail. Mount once inside the router. */
export function useNavigationTrailRecorder() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const record = useNavigationTrailStore((state) => state.record);

  useEffect(() => {
    if (lastRecordedLocationKey === location.key) return;
    lastRecordedLocationKey = location.key;
    const initial = !documentLocationSeen && navigationType === "POP";
    documentLocationSeen = true;
    record({
      action: navigationType,
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
      historyIdx: currentHistoryIdx(),
      initial,
    });
  }, [location, navigationType, record]);
}

/** Trail cursor only counts when it points at the page being shown. */
function trailForPath(trail: NavigationTrailState, pathname: string): NavigationTrailState | null {
  const current = trail.entries[trail.index];
  return current && current.key === pageKeyForPath(pathname) ? trail : null;
}

export interface BackNavigation {
  /** URL the page back arrow goes to, or null when only the page's own fallback applies. */
  target: string | null;
  /** Page key of the previous page in the trail, if any. */
  previousPageKey: string | null;
  /** Goes back; returns false when there is no in-console predecessor (use the fallback). */
  goBack: (options?: { followTrail?: boolean }) => boolean;
}

/**
 * Back navigation for a page: the previous page in the in-console trail, then a `returnTo` link
 * state, then nothing (the caller's fallback, usually the page's logical parent).
 */
export function useBackNavigation(): BackNavigation {
  const location = useLocation();
  const navigate = useNavigate();
  const trail = useNavigationTrailStore((state) => state.trail);
  const returnTo = getReturnNavigationTarget(location.state, "") || null;
  const syncedTrail = trailForPath(trail, location.pathname);
  const previous = syncedTrail ? syncedTrail.entries[syncedTrail.index - 1] : undefined;

  const goBack = useCallback(
    ({ followTrail = true }: { followTrail?: boolean } = {}) => {
      if (followTrail) {
        const store = useNavigationTrailStore.getState();
        const synced = trailForPath(store.trail, location.pathname);
        const step = synced ? planBackStep(synced, currentHistoryIdx()) : null;
        if (step?.kind === "history") {
          navigate(-1);
          return true;
        }
        if (step?.kind === "url") {
          // Drop the page being left before opening the previous one, so the arrival is
          // recorded onto that page instead of as a new step (no Back ping-pong).
          store.setTrail(step.nextState);
          navigate(step.url);
          return true;
        }
      }
      if (returnTo) {
        navigate(returnTo);
        return true;
      }
      return false;
    },
    [location.pathname, navigate, returnTo]
  );

  return {
    target: previous?.url ?? returnTo,
    previousPageKey: previous?.key ?? null,
    goBack,
  };
}

/** URL the page back arrow would open, or null when the page's own fallback applies. */
export function useBackTarget(): string | null {
  return useBackNavigation().target;
}

/** Test hook: forget which location was recorded last. */
export function resetNavigationTrailRecorderForTests() {
  lastRecordedLocationKey = null;
  documentLocationSeen = false;
}
