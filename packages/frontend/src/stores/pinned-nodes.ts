import { create } from "zustand";
import { persist } from "zustand/middleware";

interface PinnedNodesState {
  dashboardNodeIds: string[];
  sidebarNodeIds: string[];
  refreshTick: number;
  toggleDashboard: (nodeId: string) => void;
  toggleSidebar: (nodeId: string) => void;
  removePin: (nodeId: string) => void;
  isPinnedDashboard: (nodeId: string) => boolean;
  isPinnedSidebar: (nodeId: string) => boolean;
  /** Remove IDs that no longer exist */
  removeOrphans: (validIds: string[]) => void;
  /** Trigger sidebar/dashboard refetch of pinned node data */
  invalidate: () => void;
}

export const usePinnedNodesStore = create<PinnedNodesState>()(
  persist(
    (set, get) => ({
      dashboardNodeIds: [],
      sidebarNodeIds: [],
      refreshTick: 0,

      toggleDashboard: (nodeId) =>
        set((s) => ({
          dashboardNodeIds: s.dashboardNodeIds.includes(nodeId)
            ? s.dashboardNodeIds.filter((id) => id !== nodeId)
            : [...s.dashboardNodeIds, nodeId],
        })),

      toggleSidebar: (nodeId) =>
        set((s) => ({
          sidebarNodeIds: s.sidebarNodeIds.includes(nodeId)
            ? s.sidebarNodeIds.filter((id) => id !== nodeId)
            : [...s.sidebarNodeIds, nodeId],
        })),

      removePin: (nodeId) =>
        set((s) => ({
          dashboardNodeIds: s.dashboardNodeIds.filter((id) => id !== nodeId),
          sidebarNodeIds: s.sidebarNodeIds.filter((id) => id !== nodeId),
        })),

      isPinnedDashboard: (nodeId) => get().dashboardNodeIds.includes(nodeId),
      isPinnedSidebar: (nodeId) => get().sidebarNodeIds.includes(nodeId),

      removeOrphans: (validIds) =>
        set((s) => {
          const validSet = new Set(validIds);
          const newDash = s.dashboardNodeIds.filter((id) => validSet.has(id));
          const newSide = s.sidebarNodeIds.filter((id) => validSet.has(id));
          if (
            newDash.length === s.dashboardNodeIds.length &&
            newSide.length === s.sidebarNodeIds.length
          )
            return s;
          return { dashboardNodeIds: newDash, sidebarNodeIds: newSide };
        }),

      invalidate: () => set((s) => ({ refreshTick: s.refreshTick + 1 })),
    }),
    {
      name: "opfield-pinned-nodes",
      partialize: (s) => ({
        dashboardNodeIds: s.dashboardNodeIds,
        sidebarNodeIds: s.sidebarNodeIds,
      }),
    }
  )
);
