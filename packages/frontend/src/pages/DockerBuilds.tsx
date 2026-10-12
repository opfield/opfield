import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageTransition } from "@/components/common/PageTransition";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { SearchFilterBar } from "@/components/common/SearchFilterBar";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRealtime } from "@/hooks/use-realtime";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import type { DockerBuild, DockerBuildStatus } from "@/types";
import { DockerBuildDetailsDialog } from "./docker-detail/DockerBuildDetailsDialog";
import { DockerBuildsTable } from "./docker-detail/DockerBuildsTable";
import {
  ACTIVE_DOCKER_BUILD_STATUSES as ACTIVE,
  DOCKER_BUILD_STATUS_VARIANT,
} from "./docker-detail/docker-build-status";

export interface DockerBuildsProps {
  embedded?: boolean;
}

export function DockerBuilds({ embedded = false }: DockerBuildsProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState<DockerBuild[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [provider, setProvider] = useState("all");
  const [resource, setResource] = useState("all");
  const [builder, setBuilder] = useState("all");
  const [branch, setBranch] = useState("all");
  const [selected, setSelected] = useState<DockerBuild | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const requestId = useRef(0);
  const pollRequestId = useRef(0);
  const loadingMore = useRef(false);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const buildId = searchParams.get("build");
    if (!buildId || detailsOpen) return;
    let cancelled = false;
    void api
      .getDockerBuild(buildId)
      .then((build) => {
        if (cancelled) return;
        setSelected(build);
        setDetailsOpen(true);
      })
      .catch(() => {
        if (cancelled) return;
        setSearchParams(
          (current) => {
            const next = new URLSearchParams(current);
            next.delete("build");
            return next;
          },
          { replace: true }
        );
      });
    return () => {
      cancelled = true;
    };
  }, [detailsOpen, searchParams, setSearchParams]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [search]);

  const buildPageOptions = useCallback(
    (cursor?: string) => ({
      limit: 50,
      cursor,
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
      ...(status !== "all" ? { status: status as DockerBuildStatus } : {}),
      ...(provider !== "all" ? { provider: provider as "gitlab" | "github" | "git" } : {}),
      ...(resource !== "all" ? { sourceBindingId: resource } : {}),
      ...(builder !== "all" ? { builderNodeId: builder } : {}),
      ...(branch !== "all" ? { branch } : {}),
    }),
    [branch, builder, debouncedSearch, provider, resource, status]
  );

  const loadPage = useCallback(
    async (cursor: string | undefined, replace: boolean) => {
      if (!replace && loadingMore.current) return;
      const currentRequest = ++requestId.current;
      if (replace) setNextCursor(null);
      else loadingMore.current = true;
      setLoading(true);
      try {
        const page = await api.listDockerBuildPage(buildPageOptions(cursor));
        if (currentRequest !== requestId.current) return;
        setRows((current) => (replace ? page.data : [...current, ...page.data]));
        setNextCursor(page.nextCursor);
      } catch (error) {
        if (currentRequest === requestId.current) {
          toastApiError(error, "Failed to load builds");
        }
      } finally {
        if (currentRequest === requestId.current) {
          setLoading(false);
          loadingMore.current = false;
        }
      }
    },
    [buildPageOptions]
  );

  const refreshHead = useCallback(async () => {
    const currentRequest = ++pollRequestId.current;
    try {
      const page = await api.listDockerBuildPage(buildPageOptions());
      if (currentRequest !== pollRequestId.current) return;
      setRows((current) => {
        const refreshedIds = new Set(page.data.map((build) => build.id));
        return [
          ...page.data,
          ...current.filter((build) => !refreshedIds.has(build.id) && !ACTIVE.has(build.status)),
        ];
      });
    } catch {
      // Polling failures stay silent and preserve the current table.
    }
  }, [buildPageOptions]);

  useEffect(() => {
    void loadPage(undefined, true);
    return () => {
      pollRequestId.current += 1;
    };
  }, [loadPage]);

  const hasActiveBuilds = rows.some((build) => ACTIVE.has(build.status));
  useRealtime("docker.build.changed", () => void refreshHead(), {
    onReconnect: () => void refreshHead(),
  });
  useRealtime("docker.build.artifact.changed", () => void refreshHead());

  useEffect(() => {
    const interval = window.setInterval(
      () => {
        if (!document.hidden) void refreshHead();
      },
      hasActiveBuilds ? 5_000 : 15_000
    );
    return () => window.clearInterval(interval);
  }, [hasActiveBuilds, refreshHead]);

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

  useEffect(() => {
    if (!selected) return;
    const refreshed = rows.find((build) => build.id === selected.id);
    if (refreshed && refreshed !== selected) setSelected(refreshed);
  }, [rows, selected]);

  const optionBuilds = rows;
  const resourceOptions = useMemo(
    () =>
      [
        ...new Map(
          optionBuilds.map((build) => [build.sourceBindingId, build.target.name])
        ).entries(),
      ].sort((left, right) => left[1].localeCompare(right[1])),
    [optionBuilds]
  );
  const builderOptions = useMemo(
    () =>
      [
        ...new Map(
          optionBuilds.flatMap((build) =>
            build.builderNodeId
              ? [[build.builderNodeId, build.builderName || build.builderNodeId] as const]
              : []
          )
        ).entries(),
      ].sort((left, right) => left[1].localeCompare(right[1])),
    [optionBuilds]
  );
  const branchOptions = useMemo(
    () =>
      [...new Set(optionBuilds.map((build) => build.ref.replace("refs/heads/", "")))].sort(
        (left, right) => left.localeCompare(right)
      ),
    [optionBuilds]
  );

  const content = (
    <div className={embedded ? "flex min-h-0 flex-1 flex-col gap-3" : "space-y-3"}>
      <div className="flex items-center justify-between gap-3">
        <span />
        <ResponsiveHeaderActions actions={[]}>
          <Button
            variant="outline"
            onClick={() => void loadPage(undefined, true)}
            disabled={loading}
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </ResponsiveHeaderActions>
      </div>
      <SearchFilterBar
        search={search}
        onSearchChange={setSearch}
        hasActiveFilters={Boolean(
          search ||
            status !== "all" ||
            provider !== "all" ||
            resource !== "all" ||
            builder !== "all" ||
            branch !== "all"
        )}
        onReset={() => {
          setSearch("");
          setStatus("all");
          setProvider("all");
          setResource("all");
          setBuilder("all");
          setBranch("all");
        }}
        inlineFilters
        placeholder="Search repository, resource, branch, or SHA"
        filters={
          <>
            <div className="w-40">
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger aria-label="Build status" className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  <SelectItem value="all">All statuses</SelectItem>
                  {Object.keys(DOCKER_BUILD_STATUS_VARIANT).map((value) => (
                    <SelectItem key={value} value={value}>
                      {value.replaceAll("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-36">
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger aria-label="Git provider" className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All providers</SelectItem>
                  <SelectItem value="gitlab">GitLab</SelectItem>
                  <SelectItem value="github">GitHub</SelectItem>
                  <SelectItem value="git">Generic Git</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="w-44">
              <Select value={resource} onValueChange={setResource}>
                <SelectTrigger aria-label="Build resource" className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  <SelectItem value="all">All resources</SelectItem>
                  {resourceOptions.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-40">
              <Select value={builder} onValueChange={setBuilder}>
                <SelectTrigger aria-label="Build worker" className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  <SelectItem value="all">All workers</SelectItem>
                  {builderOptions.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-36">
              <Select value={branch} onValueChange={setBranch}>
                <SelectTrigger aria-label="Build branch" className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  <SelectItem value="all">All branches</SelectItem>
                  {branchOptions.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </>
        }
      />
      <DockerBuildsTable
        builds={rows}
        loading={loading}
        onOpenBuild={(build) => {
          setSelected(build);
          setDetailsOpen(true);
        }}
        onBuildsChanged={() => loadPage(undefined, true)}
        hasMore={Boolean(nextCursor)}
        loadingMore={loading}
        className={embedded ? "shrink" : undefined}
        scrollRef={tableScrollRef}
        sentinelRef={sentinelRef}
        emptyMessage="No builds match the current filters."
      />

      <DockerBuildDetailsDialog
        open={detailsOpen}
        build={selected}
        onOpenChange={(open) => {
          setDetailsOpen(open);
          if (!open && searchParams.has("build")) {
            setSearchParams(
              (current) => {
                const next = new URLSearchParams(current);
                next.delete("build");
                return next;
              },
              { replace: true }
            );
          }
        }}
        onExited={() => setSelected(null)}
      />
    </div>
  );

  if (embedded) return content;

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6">{content}</div>
    </PageTransition>
  );
}
