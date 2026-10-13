import { create } from "zustand";
import { persist } from "zustand/middleware";

interface PinnedProxiesState {
  dashboardProxyIds: string[];
  sidebarProxyIds: string[];
  refreshTick: number;
  toggleDashboard: (proxyId: string) => void;
  toggleSidebar: (proxyId: string) => void;
  removePin: (proxyId: string) => void;
  isPinnedDashboard: (proxyId: string) => boolean;
  isPinnedSidebar: (proxyId: string) => boolean;
  removeOrphans: (validIds: string[]) => void;
  invalidate: () => void;
}

export const usePinnedProxiesStore = create<PinnedProxiesState>()(
  persist(
    (set, get) => ({
      dashboardProxyIds: [],
      sidebarProxyIds: [],
      refreshTick: 0,

      toggleDashboard: (proxyId) =>
        set((s) => ({
          dashboardProxyIds: s.dashboardProxyIds.includes(proxyId)
            ? s.dashboardProxyIds.filter((id) => id !== proxyId)
            : [...s.dashboardProxyIds, proxyId],
        })),

      toggleSidebar: (proxyId) =>
        set((s) => ({
          sidebarProxyIds: s.sidebarProxyIds.includes(proxyId)
            ? s.sidebarProxyIds.filter((id) => id !== proxyId)
            : [...s.sidebarProxyIds, proxyId],
        })),

      removePin: (proxyId) =>
        set((s) => ({
          dashboardProxyIds: s.dashboardProxyIds.filter((id) => id !== proxyId),
          sidebarProxyIds: s.sidebarProxyIds.filter((id) => id !== proxyId),
        })),

      isPinnedDashboard: (proxyId) => get().dashboardProxyIds.includes(proxyId),
      isPinnedSidebar: (proxyId) => get().sidebarProxyIds.includes(proxyId),

      removeOrphans: (validIds) =>
        set((s) => {
          const validSet = new Set(validIds);
          const newDash = s.dashboardProxyIds.filter((id) => validSet.has(id));
          const newSide = s.sidebarProxyIds.filter((id) => validSet.has(id));
          if (
            newDash.length === s.dashboardProxyIds.length &&
            newSide.length === s.sidebarProxyIds.length
          )
            return s;
          return { dashboardProxyIds: newDash, sidebarProxyIds: newSide };
        }),

      invalidate: () => set((s) => ({ refreshTick: s.refreshTick + 1 })),
    }),
    {
      name: "opfield-pinned-proxy-hosts",
      partialize: (s) => ({
        dashboardProxyIds: s.dashboardProxyIds,
        sidebarProxyIds: s.sidebarProxyIds,
      }),
    }
  )
);
