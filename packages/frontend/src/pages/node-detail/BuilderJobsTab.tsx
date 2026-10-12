import { Hammer } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PanelShell } from "@/components/common/PanelShell";
import { useRealtime } from "@/hooks/use-realtime";
import { pickerLoadError } from "@/lib/picker-load-error";
import { api } from "@/services/api";
import type { DockerBuild } from "@/types";
import { DockerBuildDetailsDialog } from "../docker-detail/DockerBuildDetailsDialog";
import { DockerBuildsTable } from "../docker-detail/DockerBuildsTable";
import { ACTIVE_DOCKER_BUILD_STATUSES } from "../docker-detail/docker-build-status";

/** Build jobs of one Build Worker, in the shared build table. */
export function BuilderJobsTab({ nodeId }: { nodeId: string }) {
  const [rows, setRows] = useState<DockerBuild[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DockerBuild | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const requestId = useRef(0);
  const refreshRequestId = useRef(0);
  const loadingMore = useRef(false);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const loadPage = useCallback(
    async (cursor: string | undefined, replace: boolean) => {
      if (!replace && loadingMore.current) return;
      const currentRequest = ++requestId.current;
      if (replace) setNextCursor(null);
      else loadingMore.current = true;
      setLoading(true);
      try {
        const page = await api.listDockerBuildPage({ builderNodeId: nodeId, cursor, limit: 50 });
        if (currentRequest !== requestId.current) return;
        setRows((current) => (replace ? page.data : [...current, ...page.data]));
        setNextCursor(page.nextCursor);
        setLoadError(null);
      } catch (error) {
        // Shown in the table: opening the tab or scrolling is not an action to toast about.
        if (currentRequest === requestId.current) {
          setLoadError(pickerLoadError(error, "Build Worker jobs"));
        }
      } finally {
        if (currentRequest === requestId.current) {
          setLoading(false);
          loadingMore.current = false;
        }
      }
    },
    [nodeId]
  );

  const refreshHead = useCallback(async () => {
    const currentRequest = ++refreshRequestId.current;
    try {
      const page = await api.listDockerBuildPage({ builderNodeId: nodeId, limit: 50 });
      if (currentRequest !== refreshRequestId.current) return;
      setRows((current) => {
        const refreshedIds = new Set(page.data.map((build) => build.id));
        return [
          ...page.data,
          ...current.filter(
            (build) =>
              !refreshedIds.has(build.id) && !ACTIVE_DOCKER_BUILD_STATUSES.has(build.status)
          ),
        ];
      });
      setNextCursor(page.nextCursor);
    } catch {
      // Realtime and fallback polling keep the current table stable on transient errors.
    }
  }, [nodeId]);

  useEffect(() => {
    void loadPage(undefined, true);
    return () => {
      requestId.current += 1;
      refreshRequestId.current += 1;
    };
  }, [loadPage]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = tableScrollRef.current;
    if (!sentinel || !root || !nextCursor) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loadingMore.current) {
          void loadPage(nextCursor, false);
        }
      },
      { root, rootMargin: "320px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadPage, nextCursor]);

  useRealtime("docker.build.changed", (payload) => {
    const event = payload as { builderNodeId?: string } | undefined;
    if (!event?.builderNodeId || event.builderNodeId === nodeId) void refreshHead();
  });
  useRealtime("docker.build.artifact.changed", (payload) => {
    const event = payload as { builderNodeId?: string } | undefined;
    if (!event?.builderNodeId || event.builderNodeId === nodeId) void refreshHead();
  });

  const hasActiveJobs = rows.some((build) => ACTIVE_DOCKER_BUILD_STATUSES.has(build.status));
  useEffect(() => {
    const interval = window.setInterval(() => void refreshHead(), hasActiveJobs ? 5_000 : 15_000);
    return () => window.clearInterval(interval);
  }, [hasActiveJobs, refreshHead]);

  useEffect(() => {
    if (!selected) return;
    const refreshed = rows.find((build) => build.id === selected.id);
    if (refreshed && refreshed !== selected) setSelected(refreshed);
  }, [rows, selected]);

  return (
    <div className="flex min-h-0 max-h-full flex-1 flex-col">
      <PanelShell
        icon={<Hammer className="h-4 w-4" />}
        title="Build jobs"
        description="All builds assigned to this Build Worker. Scroll to load older jobs."
        className="flex h-fit max-h-full min-h-0 flex-col"
        bodyClassName="flex min-h-0 flex-1 p-0"
      >
        {/* A Build Worker builds for many resources, so the Source / resource column stays. */}
        <DockerBuildsTable
          builds={rows}
          loading={loading}
          onOpenBuild={(build) => {
            setSelected(build);
            setDetailsOpen(true);
          }}
          onBuildsChanged={refreshHead}
          hasMore={Boolean(nextCursor)}
          loadingMore={loading}
          embedded
          className="h-fit w-full max-h-full [&_[data-route-scroll-container]]:flex-1"
          scrollRef={tableScrollRef}
          sentinelRef={sentinelRef}
          emptyMessage={loadError ?? "No jobs have been assigned to this Build Worker."}
        />
      </PanelShell>

      <DockerBuildDetailsDialog
        open={detailsOpen}
        build={selected}
        onOpenChange={setDetailsOpen}
        onExited={() => setSelected(null)}
      />
    </div>
  );
}
