import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useDockerStore } from "@/stores/docker";
import type { DockerContainer } from "@/types";

type PinnedContainerMeta = {
  nodeId: string;
  nodeSlug: string;
  name: string;
  scopeResourceId?: string;
  state?: string;
  kind?: "container" | "deployment" | "compose";
  scopeBase?: "docker:containers:view" | "docker:compose:view";
};

function sameMeta(current: PinnedContainerMeta | undefined, next: PinnedContainerMeta): boolean {
  if (!current) return false;
  const keys = new Set([...Object.keys(current), ...Object.keys(next)]) as Set<
    keyof PinnedContainerMeta
  >;
  for (const key of keys) {
    if (current[key] !== next[key]) return false;
  }
  return true;
}

interface PinnedContainersState {
  dashboardContainerIds: string[];
  sidebarContainerIds: string[];
  /** Maps container/deployment ID → metadata for sidebar display */
  containerMeta: Record<string, PinnedContainerMeta>;
  refreshTick: number;
  toggleDashboard: (containerId: string, meta?: PinnedContainerMeta) => void;
  toggleSidebar: (containerId: string, meta?: PinnedContainerMeta) => void;
  removePin: (containerId: string) => void;
  isPinnedDashboard: (containerId: string) => boolean;
  isPinnedSidebar: (containerId: string) => boolean;
  /** Update display name / state (e.g. after rename or status change) */
  updateMeta: (containerId: string, meta: PinnedContainerMeta) => void;
  /** Migrate a pin from an old container ID to a new one (e.g. after recreation) */
  migrateId: (oldId: string, newId: string) => void;
  /** Remove IDs that no longer exist */
  removeOrphans: (validIds: string[]) => void;
  invalidate: () => void;
}

type PersistedPins = Pick<
  PinnedContainersState,
  "dashboardContainerIds" | "sidebarContainerIds" | "containerMeta"
>;

/** Pins saved before v1 may name builds (`kind: "build"`); drop them with their metadata. */
export function dropPinnedBuilds(state: PersistedPins): PersistedPins {
  const meta = (state.containerMeta ?? {}) as Record<string, { kind?: string }>;
  const builds = new Set(Object.keys(meta).filter((id) => meta[id]?.kind === "build"));
  if (builds.size === 0) return state;
  return {
    dashboardContainerIds: (state.dashboardContainerIds ?? []).filter((id) => !builds.has(id)),
    sidebarContainerIds: (state.sidebarContainerIds ?? []).filter((id) => !builds.has(id)),
    containerMeta: Object.fromEntries(
      Object.entries(state.containerMeta ?? {}).filter(([id]) => !builds.has(id))
    ),
  };
}

export const usePinnedContainersStore = create<PinnedContainersState>()(
  persist(
    (set, get) => ({
      dashboardContainerIds: [],
      sidebarContainerIds: [],
      containerMeta: {},
      refreshTick: 0,

      toggleDashboard: (containerId, meta) =>
        set((s) => {
          const isDashboard = s.dashboardContainerIds.includes(containerId);
          return {
            dashboardContainerIds: isDashboard
              ? s.dashboardContainerIds.filter((id) => id !== containerId)
              : [...s.dashboardContainerIds, containerId],
            containerMeta:
              !isDashboard && meta ? { ...s.containerMeta, [containerId]: meta } : s.containerMeta,
          };
        }),

      toggleSidebar: (containerId, meta) =>
        set((s) => {
          const isSidebar = s.sidebarContainerIds.includes(containerId);
          const newMeta = { ...s.containerMeta };
          if (isSidebar && !s.dashboardContainerIds.includes(containerId)) {
            delete newMeta[containerId];
          } else if (meta) {
            newMeta[containerId] = meta;
          }
          return {
            sidebarContainerIds: isSidebar
              ? s.sidebarContainerIds.filter((id) => id !== containerId)
              : [...s.sidebarContainerIds, containerId],
            containerMeta: newMeta,
          };
        }),

      removePin: (containerId) =>
        set((s) => {
          const newMeta = { ...s.containerMeta };
          delete newMeta[containerId];
          return {
            dashboardContainerIds: s.dashboardContainerIds.filter((id) => id !== containerId),
            sidebarContainerIds: s.sidebarContainerIds.filter((id) => id !== containerId),
            containerMeta: newMeta,
          };
        }),

      isPinnedDashboard: (containerId) => get().dashboardContainerIds.includes(containerId),
      isPinnedSidebar: (containerId) => get().sidebarContainerIds.includes(containerId),

      updateMeta: (containerId, meta) =>
        set((s) => {
          // Unchanged metadata keeps the same object, so subscribers (the
          // dashboard bootstrap request among them) do not recompute.
          if (sameMeta(s.containerMeta[containerId], meta)) return s;
          return { containerMeta: { ...s.containerMeta, [containerId]: meta } };
        }),

      migrateId: (oldId, newId) =>
        set((s) => {
          if (oldId === newId) return s;
          const replaceId = (ids: string[]) =>
            ids.includes(oldId) ? ids.map((id) => (id === oldId ? newId : id)) : ids;
          const newMeta = { ...s.containerMeta };
          if (newMeta[oldId]) {
            newMeta[newId] = newMeta[oldId];
            delete newMeta[oldId];
          }
          return {
            dashboardContainerIds: replaceId(s.dashboardContainerIds),
            sidebarContainerIds: replaceId(s.sidebarContainerIds),
            containerMeta: newMeta,
          };
        }),

      removeOrphans: (validIds) =>
        set((s) => {
          const validSet = new Set(validIds);
          const newDash = s.dashboardContainerIds.filter((id) => validSet.has(id));
          const newSide = s.sidebarContainerIds.filter((id) => validSet.has(id));
          const newMeta = { ...s.containerMeta };
          for (const id of Object.keys(newMeta)) {
            if (!validSet.has(id)) delete newMeta[id];
          }
          if (
            newDash.length === s.dashboardContainerIds.length &&
            newSide.length === s.sidebarContainerIds.length
          )
            return s;
          return {
            dashboardContainerIds: newDash,
            sidebarContainerIds: newSide,
            containerMeta: newMeta,
          };
        }),

      invalidate: () => set((s) => ({ refreshTick: s.refreshTick + 1 })),
    }),
    {
      name: "opfield-pinned-containers",
      version: 1,
      // v1: builds can no longer be pinned (a build is one finished run, so its pin went stale).
      migrate: (persisted) => dropPinnedBuilds(persisted as PersistedPins),
      partialize: (s) => ({
        dashboardContainerIds: s.dashboardContainerIds,
        sidebarContainerIds: s.sidebarContainerIds,
        containerMeta: s.containerMeta,
      }),
    }
  )
);

/**
 * Sync pinned container meta from a container list (the Docker list; an app's Compute tab for
 * app members, which the Docker list leaves out).
 */
export function syncPinnedContainerMeta(containers: readonly DockerContainer[]) {
  const pinned = usePinnedContainersStore.getState();
  const pinnedIds = new Set([...pinned.sidebarContainerIds, ...pinned.dashboardContainerIds]);
  if (pinnedIds.size === 0) return;

  for (const c of containers) {
    if (!pinnedIds.has(c.id)) continue;
    const existing = pinned.containerMeta[c.id];
    const effectiveState = (c as any)._transition ?? c.state;
    const effectiveKind = c.kind === "deployment" ? "deployment" : (existing?.kind ?? "container");
    if (
      existing &&
      (existing.state !== effectiveState ||
        existing.name !== c.name ||
        existing.kind !== effectiveKind ||
        existing.nodeSlug !== c._nodeSlug ||
        existing.scopeResourceId !== c.scopeResourceId)
    ) {
      usePinnedContainersStore.getState().updateMeta(c.id, {
        ...existing,
        nodeSlug: c._nodeSlug || existing.nodeSlug,
        name: c.name || existing.name,
        state: effectiveState,
        kind: effectiveKind,
        scopeResourceId: c.scopeResourceId ?? existing.scopeResourceId,
      });
    }
  }
}

// Sync pinned container meta when docker store containers update
let prevContainers: DockerContainer[] = [];
useDockerStore.subscribe((state) => {
  if (state.containers === prevContainers) return;
  prevContainers = state.containers;
  syncPinnedContainerMeta(state.containers);
});
