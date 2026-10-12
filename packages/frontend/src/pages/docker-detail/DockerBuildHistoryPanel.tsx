import { Hammer } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PanelShell } from "@/components/common/PanelShell";
import { useRealtime } from "@/hooks/use-realtime";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import type { DockerBuild } from "@/types";
import { DockerBuildDetailsDialog } from "./DockerBuildDetailsDialog";
import { DockerBuildsTable } from "./DockerBuildsTable";
import { ACTIVE_DOCKER_BUILD_STATUSES } from "./docker-build-status";

interface DockerBuildHistoryPanelProps {
  sourceBindingId?: string;
  /** The resource's source is still loading. */
  loading?: boolean;
}

function compareBuildsNewestFirst(left: DockerBuild, right: DockerBuild): number {
  const createdAtOrder = right.createdAt.localeCompare(left.createdAt);
  return createdAtOrder || right.id.localeCompare(left.id);
}

/** The Builds tab of a resource: its build history in the shared build table. */
export function DockerBuildHistoryPanel({
  sourceBindingId,
  loading = false,
}: DockerBuildHistoryPanelProps) {
  const [selected, setSelected] = useState<DockerBuild | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [builds, setBuilds] = useState<DockerBuild[]>([]);
  // History loads on mount; start as loading so the tab waits for the first page.
  const [historyLoading, setHistoryLoading] = useState(() => Boolean(sourceBindingId));
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const headRequestId = useRef(0);
  const pageRequestId = useRef(0);
  const paginationInitialized = useRef(false);
  const loadingMore = useRef(false);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const pointRequestIds = useRef(new Map<string, number>());
  const sourceGenerationRef = useRef({ sourceBindingId, generation: 0 });
  if (sourceGenerationRef.current.sourceBindingId !== sourceBindingId) {
    sourceGenerationRef.current = {
      sourceBindingId,
      generation: sourceGenerationRef.current.generation + 1,
    };
    pointRequestIds.current.clear();
  }
  const sourceBindingIdRef = useRef(sourceBindingId);
  sourceBindingIdRef.current = sourceBindingId;

  const loadHead = useCallback(
    async (reset: boolean) => {
      if (!sourceBindingId) return;
      const currentRequest = ++headRequestId.current;
      pageRequestId.current += 1;
      loadingMore.current = false;
      if (reset) {
        paginationInitialized.current = false;
        setNextCursor(null);
        setHistoryLoading(true);
      }
      try {
        const page = await api.listDockerBuildPage({ sourceBindingId, limit: 50 });
        if (currentRequest !== headRequestId.current) return;
        setBuilds((current) => {
          if (reset) return page.data;
          const refreshedIds = new Set(page.data.map((build) => build.id));
          return [...page.data, ...current.filter((build) => !refreshedIds.has(build.id))];
        });
        if (reset || !paginationInitialized.current) {
          paginationInitialized.current = true;
          setNextCursor(page.nextCursor);
        }
      } catch (error) {
        if (reset && currentRequest === headRequestId.current) {
          toastApiError(error, "Failed to load build history");
        }
      } finally {
        if (currentRequest === headRequestId.current) setHistoryLoading(false);
      }
    },
    [sourceBindingId]
  );

  const loadPage = useCallback(
    async (cursor: string) => {
      if (!sourceBindingId || loadingMore.current) return;
      const currentRequest = ++pageRequestId.current;
      loadingMore.current = true;
      setHistoryLoading(true);
      try {
        const page = await api.listDockerBuildPage({ sourceBindingId, cursor, limit: 50 });
        if (currentRequest !== pageRequestId.current) return;
        setBuilds((current) => {
          const existingIds = new Set(current.map((build) => build.id));
          return [...current, ...page.data.filter((build) => !existingIds.has(build.id))];
        });
        setNextCursor(page.nextCursor);
      } catch (error) {
        if (currentRequest === pageRequestId.current) {
          toastApiError(error, "Failed to load build history");
        }
      } finally {
        if (currentRequest === pageRequestId.current) {
          setHistoryLoading(false);
          loadingMore.current = false;
        }
      }
    },
    [sourceBindingId]
  );

  const refreshHead = useCallback(() => loadHead(false), [loadHead]);

  const refreshBuild = useCallback(
    async (buildId: string) => {
      const expectedSourceBindingId = sourceBindingId;
      if (!expectedSourceBindingId) return;
      const expectedSourceGeneration = sourceGenerationRef.current.generation;
      const requestId = (pointRequestIds.current.get(buildId) ?? 0) + 1;
      pointRequestIds.current.set(buildId, requestId);
      try {
        const build = await api.getDockerBuild(buildId);
        if (
          sourceBindingIdRef.current !== expectedSourceBindingId ||
          sourceGenerationRef.current.generation !== expectedSourceGeneration ||
          pointRequestIds.current.get(buildId) !== requestId ||
          build.sourceBindingId !== expectedSourceBindingId
        ) {
          return;
        }
        setBuilds((current) => {
          const existingIndex = current.findIndex((candidate) => candidate.id === build.id);
          const next =
            existingIndex === -1
              ? [...current, build]
              : current.map((candidate, index) => (index === existingIndex ? build : candidate));
          return next.sort(compareBuildsNewestFirst);
        });
      } catch {
        // The head refresh remains the fallback for deleted or no-longer-visible builds.
      }
    },
    [sourceBindingId]
  );

  const refreshTrackedActiveBuilds = useCallback(() => {
    for (const build of builds) {
      if (ACTIVE_DOCKER_BUILD_STATUSES.has(build.status)) void refreshBuild(build.id);
    }
  }, [builds, refreshBuild]);

  useEffect(
    () => () => {
      headRequestId.current += 1;
      pageRequestId.current += 1;
    },
    []
  );

  useEffect(() => {
    void loadHead(true);
  }, [loadHead]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = tableScrollRef.current;
    if (!sentinel || !root || !nextCursor) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loadingMore.current) {
          void loadPage(nextCursor);
        }
      },
      { root, rootMargin: "320px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadPage, nextCursor]);

  useEffect(() => {
    if (!selected) return;
    const refreshed = builds.find((build) => build.id === selected.id);
    if (refreshed && refreshed !== selected) setSelected(refreshed);
  }, [builds, selected]);

  useRealtime(
    sourceBindingId ? "docker.build.changed" : null,
    (payload) => {
      const event = payload as { buildId?: string; sourceBindingId?: string } | undefined;
      if (event?.sourceBindingId === sourceBindingId) {
        const buildId = event?.buildId;
        if (buildId) void refreshBuild(buildId);
        void refreshHead();
      }
    },
    {
      onReconnect: () => {
        refreshTrackedActiveBuilds();
        void refreshHead();
      },
    }
  );
  useRealtime(sourceBindingId ? "docker.build.artifact.changed" : null, (payload) => {
    const event = payload as { buildId?: string; sourceBindingId?: string } | undefined;
    if (event?.sourceBindingId === sourceBindingId) {
      const buildId = event?.buildId;
      if (buildId) void refreshBuild(buildId);
      void refreshHead();
    }
  });

  const hasActiveBuilds = builds.some((build) => ACTIVE_DOCKER_BUILD_STATUSES.has(build.status));
  useEffect(() => {
    if (!sourceBindingId) return;
    const interval = window.setInterval(
      () => {
        if (!document.hidden) {
          refreshTrackedActiveBuilds();
          void refreshHead();
        }
      },
      hasActiveBuilds ? 5_000 : 15_000
    );
    return () => window.clearInterval(interval);
  }, [hasActiveBuilds, refreshHead, refreshTrackedActiveBuilds, sourceBindingId]);

  return (
    <>
      <PanelShell
        icon={<Hammer className="h-4 w-4" />}
        title="Builds"
        description="Build history, security decisions, and deployment results."
        className="flex h-fit max-h-full min-h-0 flex-col"
        bodyClassName="flex min-h-0 flex-1 p-0"
      >
        <DockerBuildsTable
          builds={builds}
          scope="resource"
          loading={loading || historyLoading}
          onOpenBuild={(build) => {
            setSelected(build);
            setDetailsOpen(true);
          }}
          onBuildsChanged={refreshHead}
          hasMore={Boolean(nextCursor)}
          loadingMore={historyLoading}
          embedded
          className="h-fit w-full max-h-full [&_[data-route-scroll-container]]:flex-1"
          scrollRef={tableScrollRef}
          sentinelRef={sentinelRef}
          emptyMessage="No builds yet."
        />
      </PanelShell>

      <DockerBuildDetailsDialog
        open={detailsOpen}
        build={selected}
        onOpenChange={setDetailsOpen}
        onExited={() => setSelected(null)}
      />
    </>
  );
}
