import { create } from "zustand";
import {
  EMPTY_NAVIGATION_TRAIL,
  type NavigationTrailState,
  type NavigationVisit,
  parseNavigationTrail,
  recordNavigation,
} from "@/lib/navigation-trail";

const STORAGE_KEY = "opfield:navigation-trail";

function readStoredTrail(): NavigationTrailState {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? parseNavigationTrail(JSON.parse(raw)) : EMPTY_NAVIGATION_TRAIL;
  } catch {
    return EMPTY_NAVIGATION_TRAIL;
  }
}

function writeStoredTrail(trail: NavigationTrailState) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(trail));
  } catch {
    // Storage full or blocked: the trail still works for this document.
  }
}

interface NavigationTrailStore {
  trail: NavigationTrailState;
  record: (visit: NavigationVisit) => void;
  setTrail: (trail: NavigationTrailState) => void;
  reset: () => void;
}

/** Per-tab trail of console pages; kept in sessionStorage so a reload keeps it. */
export const useNavigationTrailStore = create<NavigationTrailStore>((set, get) => ({
  trail: typeof window === "undefined" ? EMPTY_NAVIGATION_TRAIL : readStoredTrail(),
  record: (visit) => {
    const next = recordNavigation(get().trail, visit);
    if (next === get().trail) return;
    set({ trail: next });
    writeStoredTrail(next);
  },
  setTrail: (trail) => {
    set({ trail });
    writeStoredTrail(trail);
  },
  reset: () => {
    set({ trail: EMPTY_NAVIGATION_TRAIL });
    writeStoredTrail(EMPTY_NAVIGATION_TRAIL);
  },
}));
