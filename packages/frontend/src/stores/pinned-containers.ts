import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useDockerStore } from "@/stores/docker";
import type { DockerContainer } from "@/types";

export type PinnedContainerMeta = {
  nodeId: string;
  nodeSlug: string;
  name: string;
  scopeResourceId?: string;
  state?: string;
  kind?: "container" | "deployment" | "compose";
  scopeBase?: "docker:containers:view" | "docker:compose:view";
};

/**
 * The key of a container pin: its node and name. Moving a container into an app, a Compose or agent recreate and
 * every other recreate give it a new Docker ID but keep the name, so the pin follows it. Deployments and Compose
 * projects are pinned by their own IDs, which recreates keep.
 */
export function containerPinKey(nodeId: string, name: string): string {
  return `${nodeId}/${name.replace(/^\//, "")}`;
}

/** The key a pin with this metadata has: containers by node and name, deployments and Compose projects by ID. */
function pinKeyOf(id: string, meta: PinnedContainerMeta): string {
  const kind = meta.kind ?? "container";
  return kind === "container" && meta.nodeId && meta.name
    ? containerPinKey(meta.nodeId, meta.name)
    : id;
}

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
  /**
   * Pin keys: `containerPinKey(nodeId, name)` for a container, the ID for a deployment or a Compose project. Every
   * method below takes these keys.
   */
  dashboardContainerIds: string[];
  sidebarContainerIds: string[];
  /** Maps pin key → metadata for sidebar display */
  containerMeta: Record<string, PinnedContainerMeta>;
  refreshTick: number;
  toggleDashboard: (containerId: string, meta?: PinnedContainerMeta) => void;
  toggleSidebar: (containerId: string, meta?: PinnedContainerMeta) => void;
  removePin: (containerId: string) => void;
  isPinnedDashboard: (containerId: string) => boolean;
  isPinnedSidebar: (containerId: string) => boolean;
  /** Update display name / state (e.g. after rename or status change) */
  updateMeta: (containerId: string, meta: PinnedContainerMeta) => void;
  /** Move a pin to a new key (a container renamed or moved to another node) */
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

/**
 * Pins saved before v2 name containers by their Docker ID, which a recreate replaces (moving a container into an app
 * among them): the pin then pointed at a container that no longer existed, and its page could not unpin it. Re-key
 * them by node and name, which the metadata of every pin carries. A pin without metadata never showed anywhere and
 * is dropped.
 */
export function keyContainerPinsByName(state: PersistedPins): PersistedPins {
  const meta = state.containerMeta ?? {};
  const containerMeta: Record<string, PinnedContainerMeta> = {};
  const rekey = (ids: string[] | undefined) => {
    const keys: string[] = [];
    for (const id of ids ?? []) {
      const item = meta[id];
      if (!item) continue;
      const key = pinKeyOf(id, item);
      if (!keys.includes(key)) keys.push(key);
      containerMeta[key] ??= item;
    }
    return keys;
  };
  return {
    dashboardContainerIds: rekey(state.dashboardContainerIds),
    sidebarContainerIds: rekey(state.sidebarContainerIds),
    containerMeta,
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
            ids.includes(oldId)
              ? ids.includes(newId)
                ? ids.filter((id) => id !== oldId)
                : ids.map((id) => (id === oldId ? newId : id))
              : ids;
          const newMeta = { ...s.containerMeta };
          if (newMeta[oldId]) {
            newMeta[newId] ??= newMeta[oldId];
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
      version: 2,
      // v1: builds can no longer be pinned (a build is one finished run, so its pin went stale).
      // v2: containers are pinned by node and name instead of their Docker ID.
      migrate: (persisted) => keyContainerPinsByName(dropPinnedBuilds(persisted as PersistedPins)),
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
    const key =
      c.kind !== "deployment" && c._nodeId && c.name ? containerPinKey(c._nodeId, c.name) : c.id;
    if (!pinnedIds.has(key)) continue;
    const existing = pinned.containerMeta[key];
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
      usePinnedContainersStore.getState().updateMeta(key, {
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
