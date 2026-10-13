import { create } from "zustand";
import { persist } from "zustand/middleware";

interface PinnedStorageState {
  sidebarStorageIds: string[];
  storageMeta: Record<
    string,
    { slug: string; name: string; provider: string; healthStatus?: string }
  >;
  refreshTick: number;
  toggleSidebar: (
    storageId: string,
    meta?: { slug: string; name: string; provider: string; healthStatus?: string }
  ) => void;
  removePin: (storageId: string) => void;
  isPinnedSidebar: (storageId: string) => boolean;
  updateMeta: (
    storageId: string,
    meta: { slug: string; name: string; provider: string; healthStatus?: string }
  ) => void;
  removeOrphans: (validIds: string[]) => void;
  invalidate: () => void;
}

export const usePinnedStorageStore = create<PinnedStorageState>()(
  persist(
    (set, get) => ({
      sidebarStorageIds: [],
      storageMeta: {},
      refreshTick: 0,

      toggleSidebar: (storageId, meta) =>
        set((s) => {
          const isSidebar = s.sidebarStorageIds.includes(storageId);
          const newMeta = { ...s.storageMeta };
          if (isSidebar) {
            delete newMeta[storageId];
          } else if (meta) {
            newMeta[storageId] = meta;
          }
          return {
            sidebarStorageIds: isSidebar
              ? s.sidebarStorageIds.filter((id) => id !== storageId)
              : [...s.sidebarStorageIds, storageId],
            storageMeta: newMeta,
          };
        }),

      removePin: (storageId) =>
        set((s) => {
          const newMeta = { ...s.storageMeta };
          delete newMeta[storageId];
          return {
            sidebarStorageIds: s.sidebarStorageIds.filter((id) => id !== storageId),
            storageMeta: newMeta,
          };
        }),

      isPinnedSidebar: (storageId) => get().sidebarStorageIds.includes(storageId),

      updateMeta: (storageId, meta) =>
        set((s) => ({
          storageMeta: { ...s.storageMeta, [storageId]: meta },
        })),

      removeOrphans: (validIds) =>
        set((s) => {
          const validSet = new Set(validIds);
          const newSide = s.sidebarStorageIds.filter((id) => validSet.has(id));
          const newMeta = { ...s.storageMeta };
          for (const id of Object.keys(newMeta)) {
            if (!validSet.has(id)) delete newMeta[id];
          }
          if (newSide.length === s.sidebarStorageIds.length) return s;
          return {
            sidebarStorageIds: newSide,
            storageMeta: newMeta,
          };
        }),

      invalidate: () => set((s) => ({ refreshTick: s.refreshTick + 1 })),
    }),
    {
      name: "opfield-pinned-storage",
      partialize: (s) => ({
        sidebarStorageIds: s.sidebarStorageIds,
        storageMeta: s.storageMeta,
      }),
    }
  )
);
