import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import {
  type NavigationTrailState,
  pageKeyForPath,
  planBackStep,
  planLeaveStep,
} from "@/lib/navigation-trail";
import { getReturnNavigationTarget, readReturnNavigationTarget } from "@/lib/return-navigation";
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

export interface LeavePageOptions {
  /** Further paths that are gone with this page (pages of a deleted node, app, ...). */
  gonePaths?: readonly string[];
}

/**
 * Leaves a page whose resource is gone (deleted here or elsewhere, failed to load): back to where
 * the user opened it from (app tab, environment, node, folder, dashboard, search), else to a
 * `returnTo` link state, else to `fallback` (the type's list). Runs once per location, so a delete
 * and its own realtime event never navigate twice.
 */
export function useLeavePage(): (fallback: string, options?: LeavePageOptions) => void {
  const location = useLocation();
  const navigate = useNavigate();
  const locationRef = useRef(location);
  locationRef.current = location;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const leftKeyRef = useRef<string | null>(null);

  return useCallback((fallback: string, options?: LeavePageOptions) => {
    const current = locationRef.current;
    if (leftKeyRef.current === current.key) return;
    leftKeyRef.current = current.key;
    const store = useNavigationTrailStore.getState();
    const step = planLeaveStep({
      trail: store.trail,
      pathname: current.pathname,
      historyIdx: currentHistoryIdx(),
      returnTo: readReturnNavigationTarget(current.state),
      fallback,
      gonePaths: options?.gonePaths,
    });
    if (step.kind === "history") {
      navigateRef.current(-1);
      return;
    }
    if (step.nextState) store.setTrail(step.nextState);
    navigateRef.current(step.url, { replace: true });
  }, []);
}

/** Test hook: forget which location was recorded last. */
export function resetNavigationTrailRecorderForTests() {
  lastRecordedLocationKey = null;
  documentLocationSeen = false;
}
