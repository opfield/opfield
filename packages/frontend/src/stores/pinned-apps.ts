import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Apps pinned to the dashboard and the sidebar. Placement is local; what shows comes from the server's app list. */
interface PinnedAppsState {
  dashboardAppIds: string[];
  sidebarAppIds: string[];
  toggleDashboard: (appId: string) => void;
  toggleSidebar: (appId: string) => void;
  removePin: (appId: string) => void;
}

const toggle = (ids: string[], id: string) =>
  ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];

export const usePinnedAppsStore = create<PinnedAppsState>()(
  persist(
    (set) => ({
      dashboardAppIds: [],
      sidebarAppIds: [],
      toggleDashboard: (appId) =>
        set((s) => ({ dashboardAppIds: toggle(s.dashboardAppIds, appId) })),
      toggleSidebar: (appId) => set((s) => ({ sidebarAppIds: toggle(s.sidebarAppIds, appId) })),
      removePin: (appId) =>
        set((s) => ({
          dashboardAppIds: s.dashboardAppIds.filter((id) => id !== appId),
          sidebarAppIds: s.sidebarAppIds.filter((id) => id !== appId),
        })),
    }),
    { name: "opfield-pinned-apps" }
  )
);
