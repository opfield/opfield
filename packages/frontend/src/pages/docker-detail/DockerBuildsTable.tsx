import { GitBranch, RotateCcw, Square } from "lucide-react";
import { type RefObject, useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { RelativeTime } from "@/components/common/RelativeTime";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { api } from "@/services/api";
import type { DockerBuild } from "@/types";
import { formatDockerBuildDuration, useDockerBuildClock } from "./docker-build-duration";
import {
  ACTIVE_DOCKER_BUILD_STATUSES as ACTIVE,
  DOCKER_BUILD_STATUS_VARIANT,
} from "./docker-build-status";

const RETRYABLE = new Set<DockerBuild["status"]>(["failed", "cancelled", "superseded"]);

/**
 * Every row has the same height: the tallest cell is a badge (h-6) over one text-xs line
 * (gap-1), inside the cell's py-3, plus the row's 1px bottom border. A fixed height gives
 * deterministic virtual offsets from the first paint instead of the 49px estimate.
 */
const ROW_HEIGHT = 24 + 4 + 16 + 24 + 1;
/** A badge over one muted line; both cells of a row share this box. */
const STACKED_CELL = "flex min-w-0 flex-col gap-1";
const STACKED_LINE = "max-w-full truncate text-xs leading-4 text-muted-foreground";

function shortSha(value: string) {
  return value.slice(0, 8);
}

function targetLabel(build: DockerBuild) {
  if (build.target.kind === "container") return build.target.name;
  if (build.target.kind === "deployment") return `Deployment ${build.target.name}`;
  if (build.target.kind === "compose_project") {
    return `Compose ${build.target.name}${build.serviceName ? ` · ${build.serviceName}` : ""}`;
  }
  return `Pages ${build.target.name}`;
}

interface DockerBuildsTableProps {
  builds: DockerBuild[];
  /**
   * `all` (default): builds of many resources, led by the Source / resource column.
   * `resource`: the builds of one resource, where that column would repeat one value; it is
   * dropped and Result takes the room. Compose builds differ by service, so a Service column leads.
   */
  scope?: "all" | "resource";
  loading?: boolean;
  emptyMessage: string;
  onOpenBuild: (build: DockerBuild) => void;
  /** Reloads the list after a build was cancelled or retried. */
  onBuildsChanged: () => void | Promise<void>;
  /** More builds exist below; the table shows the infinite-scroll sentinel. */
  hasMore?: boolean;
  loadingMore?: boolean;
  scrollRef?: RefObject<HTMLDivElement | null>;
  sentinelRef?: RefObject<HTMLDivElement | null>;
  /** Drop the table border when a section shell owns it. */
  embedded?: boolean;
  className?: string;
}

/** The one build table of the console: the Docker Builds page and every resource's Builds tab. */
export function DockerBuildsTable({
  builds,
  scope = "all",
  loading = false,
  emptyMessage,
  onOpenBuild,
  onBuildsChanged,
  hasMore = false,
  loadingMore = false,
  scrollRef,
  sentinelRef,
  embedded = false,
  className,
}: DockerBuildsTableProps) {
  const now = useDockerBuildClock(builds);
  const [actingBuildId, setActingBuildId] = useState<string | null>(null);

  const act = useCallback(
    async (build: DockerBuild, action: "cancel" | "retry") => {
      setActingBuildId(build.id);
      try {
        if (action === "cancel") await api.cancelDockerBuild(build.id);
        else await api.retryDockerBuild(build.id);
        await onBuildsChanged();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : `Failed to ${action} build`);
      } finally {
        setActingBuildId((current) => (current === build.id ? null : current));
      }
    },
    [onBuildsChanged]
  );

  const resourceScope = scope === "resource";
  const serviceColumn =
    resourceScope && builds.some((build) => build.target.kind === "compose_project");
  const leadingCommit = resourceScope && !serviceColumn;

  const columns = useMemo<DataTableColumn<DockerBuild>[]>(() => {
    const sourceColumn: DataTableColumn<DockerBuild> = {
      key: "source",
      header: "Source / resource",
      width: "minmax(14rem,1.6fr)",
      render: (build) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center bg-muted">
            <GitBranch className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="block truncate font-medium">{build.repositoryFullPath}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {targetLabel(build)}
            </span>
          </span>
        </span>
      ),
    };
    const serviceNameColumn: DataTableColumn<DockerBuild> = {
      key: "service",
      header: "Service",
      width: "minmax(10rem,1fr)",
      render: (build) => (
        <span className="block truncate font-medium">{build.serviceName ?? "—"}</span>
      ),
    };
    const leadingColumns = resourceScope
      ? serviceColumn
        ? [serviceNameColumn]
        : []
      : [sourceColumn];
    return [
      ...leadingColumns,
      {
        key: "commit",
        header: "Commit / ref",
        // A short SHA and a branch name: a fixed width instead of a share of the free space.
        width: "9rem",
        // Like every table, the leading column reads from the left.
        align: leadingCommit ? "left" : "right",
        render: (build) => (
          <span className={`${STACKED_CELL} ${leadingCommit ? "items-start" : "items-end"}`}>
            <Badge variant="outline" className="font-mono">
              {shortSha(build.commitSha)}
            </Badge>
            <span className={STACKED_LINE}>{build.ref.replace("refs/heads/", "")}</span>
          </span>
        ),
      },
      {
        key: "status",
        header: "Status",
        align: "right",
        width: "minmax(9rem,0.6fr)",
        render: (build) => (
          <Badge variant={DOCKER_BUILD_STATUS_VARIANT[build.status]}>
            {build.status.replaceAll("_", " ")}
          </Badge>
        ),
      },
      {
        key: "result",
        header: "Result",
        align: "right",
        width: resourceScope ? "minmax(14rem,2fr)" : "minmax(12rem,0.8fr)",
        render: (build) => {
          if (!build.artifact) {
            const active = ACTIVE.has(build.status);
            return (
              <span className={`${STACKED_CELL} items-end`}>
                <Badge variant="secondary">{active ? "Pending" : "No artifact"}</Badge>
                <span className={STACKED_LINE}>
                  {build.status === "scanning"
                    ? "Security scan"
                    : active
                      ? "Waiting for artifact"
                      : build.status === "cancelled"
                        ? "Build cancelled"
                        : build.status === "superseded"
                          ? "Superseded by a newer build"
                          : build.errorMessage || "Build failed"}
                </span>
              </span>
            );
          }
          const blocked = build.artifact.policyDecision === "rejected";
          return (
            <span className={`${STACKED_CELL} items-end`}>
              <Badge variant={blocked ? "destructive" : "success"}>
                {blocked
                  ? "Policy blocked"
                  : build.status === "succeeded"
                    ? "Deployed"
                    : "Approved"}
              </Badge>
              <span className={STACKED_LINE}>
                {blocked
                  ? build.artifact.policyReason || "Artifact rejected"
                  : build.status === "succeeded"
                    ? "Deployment completed"
                    : "Artifact approved"}
              </span>
            </span>
          );
        },
      },
      {
        key: "time",
        header: "Duration / created",
        align: "right",
        width: "minmax(11rem,0.6fr)",
        render: (build) => (
          <span className="block">
            <span className="block">{formatDockerBuildDuration(build, now)}</span>
            <RelativeTime
              value={build.createdAt}
              className="block text-xs leading-4 text-muted-foreground"
            />
          </span>
        ),
      },
      {
        key: "actions",
        header: "",
        align: "right",
        width: "4rem",
        render: (build) => (
          <span className="flex justify-end gap-1" onClick={(event) => event.stopPropagation()}>
            {ACTIVE.has(build.status) && (
              <Button
                size="icon"
                variant="ghost"
                aria-label="Cancel build"
                pending={actingBuildId === build.id}
                onClick={() => void act(build, "cancel")}
              >
                {actingBuildId !== build.id && <Square className="h-4 w-4" />}
              </Button>
            )}
            {RETRYABLE.has(build.status) && (
              <Button
                size="icon"
                variant="ghost"
                aria-label="Retry build"
                pending={actingBuildId === build.id}
                onClick={() => void act(build, "retry")}
              >
                {actingBuildId !== build.id && <RotateCcw className="h-4 w-4" />}
              </Button>
            )}
          </span>
        ),
      },
    ];
  }, [act, actingBuildId, leadingCommit, now, resourceScope, serviceColumn]);

  return (
    <DataTable
      columns={columns}
      data={builds}
      keyFn={(build) => build.id}
      onRowClick={onOpenBuild}
      loading={loading && builds.length === 0}
      fixedRowHeight={ROW_HEIGHT}
      horizontalScroll
      // The columns' own minimum: narrower screens scroll sideways, the desktop content column fits.
      minWidth={resourceScope ? (serviceColumn ? "58rem" : "48rem") : "64rem"}
      embedded={embedded}
      className={className}
      scrollRef={scrollRef}
      emptyMessage={emptyMessage}
      footer={
        hasMore ? (
          <div ref={sentinelRef} className="py-3 text-center text-xs text-muted-foreground">
            {loadingMore ? "Loading more…" : "Scroll to load older builds"}
          </div>
        ) : null
      }
    />
  );
}
