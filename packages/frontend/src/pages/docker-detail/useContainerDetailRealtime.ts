import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { useRealtime } from "@/hooks/use-realtime";
import { dockerContainerRoute } from "@/lib/resource-routes";
import { usePinnedContainersStore } from "@/stores/pinned-containers";
import { useResolvedPageContext } from "@/stores/resolved-page-context";
import type { DockerMigration } from "@/types";

const MIGRATION_RELOCATION_GRACE_MS = 2_000;
const MIGRATION_TRANSITION_SETTLE_INTERVAL_MS = 1_000;
const MIGRATION_TRANSITION_SETTLE_ATTEMPTS = 30;

interface UseContainerDetailRealtimeParams {
  nodeId?: string;
  nodeSlug: string;
  containerId?: string;
  routeContainerName: string;
  activeTab: string;
  navigate: (to: string, options?: { replace?: boolean }) => void;
  /** Leaves the page once the container is gone (back to where it was opened from). */
  leave: () => void;
  refreshContainer: () => Promise<void>;
  transition?: string;
  clearMutationTransition: () => void;
  onContainerIdChange: (containerId: string) => void;
  onMigrationCutover: (migration: DockerMigration) => void;
  pageContextToken?: number | null;
}

type ContainerChangedEvent = {
  nodeId?: string;
  name?: string;
  id?: string;
  oldId?: string;
  oldName?: string;
  action?: string;
  transition?: string | null;
  scopeResourceId?: string;
};

export function matchesCurrentContainerRecreate(
  event: ContainerChangedEvent,
  containerId: string | undefined,
  routeContainerName: string
): boolean {
  return (
    event.action === "recreated" &&
    event.name === routeContainerName &&
    !!event.id &&
    (event.oldId === containerId || event.id === containerId)
  );
}

export function useContainerDetailRealtime({
  nodeId,
  nodeSlug,
  containerId,
  routeContainerName,
  activeTab,
  navigate,
  leave,
  refreshContainer,
  transition,
  clearMutationTransition,
  onContainerIdChange,
  onMigrationCutover,
  pageContextToken,
}: UseContainerDetailRealtimeParams) {
  const cutoverSeen = useRef(false);
  const removalFallback = useRef<number | null>(null);

  const clearRemovalFallback = useCallback(() => {
    if (removalFallback.current === null) return;
    window.clearTimeout(removalFallback.current);
    removalFallback.current = null;
  }, []);

  useEffect(() => () => clearRemovalFallback(), [clearRemovalFallback]);

  // The transition-clear event can be published before the target detail page
  // subscribes during a migration redirect. Re-read the authoritative state
  // while migrating so a missed one-shot event cannot leave the page locked.
  useEffect(() => {
    if (transition !== "migrating") return;
    let cancelled = false;
    let timer: number | null = null;
    let attempts = 0;

    const settle = async () => {
      attempts += 1;
      await refreshContainer();
      if (!cancelled && attempts < MIGRATION_TRANSITION_SETTLE_ATTEMPTS) {
        timer = window.setTimeout(settle, MIGRATION_TRANSITION_SETTLE_INTERVAL_MS);
      }
    };

    timer = window.setTimeout(settle, 250);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [refreshContainer, transition]);

  useRealtime("node.slug.changed", (payload) => {
    const event = payload as { id?: string; oldSlug?: string; slug?: string };
    if (event.id !== nodeId || event.oldSlug !== nodeSlug || !event.slug) return;
    navigate(dockerContainerRoute(event.slug, routeContainerName, activeTab), { replace: true });
  });

  useRealtime("docker.migration.changed", (payload) => {
    const event = payload as DockerMigration;
    if (
      !event.cutoverAt ||
      event.resourceType !== "container" ||
      event.sourceNodeId !== nodeId ||
      event.resourceName !== routeContainerName
    ) {
      return;
    }
    cutoverSeen.current = true;
    clearRemovalFallback();
    onMigrationCutover(event);
  });

  useRealtime("docker.container.changed", (payload) => {
    const ev = payload as ContainerChangedEvent;
    if (!ev || ev.nodeId !== nodeId) return;

    if (
      ev.action === "renamed" &&
      ev.id === containerId &&
      ev.oldName === routeContainerName &&
      ev.name &&
      ev.name !== routeContainerName
    ) {
      navigate(dockerContainerRoute(nodeSlug, ev.name, activeTab), { replace: true });
      return;
    }

    if (matchesCurrentContainerRecreate(ev, containerId, routeContainerName)) {
      const replacementId = ev.id;
      if (!replacementId) return;
      clearMutationTransition();
      if (replacementId === containerId) {
        void refreshContainer();
        return;
      }
      try {
        if (ev.oldId) usePinnedContainersStore.getState().migrateId(ev.oldId, replacementId);
      } catch {
        /* ignore */
      }
      onContainerIdChange(replacementId);
      if (pageContextToken != null && nodeId) {
        useResolvedPageContext.getState().resolve(pageContextToken, {
          resourceType: "docker-container",
          resourceId: replacementId,
          nodeId,
          scopeResourceId: ev.scopeResourceId,
          label: routeContainerName,
        });
      }
      return;
    }

    const matchesCurrentContainer =
      ev.id === containerId && (!ev.name || ev.name === routeContainerName);
    const matchesIdlessTransitionClear =
      ev.action === "transitioning" && !ev.id && ev.name === routeContainerName;
    if (!matchesCurrentContainer && !matchesIdlessTransitionClear) return;

    if (ev.action === "removed") {
      clearMutationTransition();
      if (cutoverSeen.current || removalFallback.current !== null) return;
      removalFallback.current = window.setTimeout(() => {
        removalFallback.current = null;
        if (cutoverSeen.current) return;
        toast.info("Container was removed");
        leave();
      }, MIGRATION_RELOCATION_GRACE_MS);
      return;
    }
    if (ev.action === "transitioning" && !ev.transition) {
      clearMutationTransition();
    }
    void refreshContainer();
  });
}
