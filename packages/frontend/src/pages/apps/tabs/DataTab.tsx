// Data: databases, storage and logging environments grouped by environment (canvas frame app-data).
import { Database, DatabaseZap, HardDrive, HardDriveDownload, ScrollText } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { ContentLoading } from "@/components/common/ContentLoading";
import { RelativeTime } from "@/components/common/RelativeTime";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { Badge } from "@/components/ui/badge";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { databaseTypeLabel } from "@/lib/database-type";
import { nodeIconClassNames } from "@/lib/node-appearance";
import { databaseRoute, loggingEnvironmentRoute, storageRoute } from "@/lib/resource-routes";
import { parseResourceTag, resourceTagBadgeProps } from "@/lib/resource-tags";
import { cn } from "@/lib/utils";
import { formatProviderLabel } from "@/pages/storage-detail/shared";
import { useSystemConfigStore } from "@/stores/system-config";
import type {
  AppDetail,
  DatabaseConnection,
  LoggingEnvironment,
  ObjectStorageConnection,
} from "@/types";
import { loadAppData, useAppLoad } from "../app-resources";
import { groupByEnvironment, groupTotal, RowMenu } from "../app-shared";
import { useNodeIndex } from "../use-node-index";
import {
  AddRow,
  EmptyGroup,
  MemberMenuItems,
  present,
  type TabActions,
  TYPES,
  TypeActions,
  TypeSection,
} from "./tab-shared";

const HEALTH_BADGE: Record<string, "success" | "secondary" | "warning" | "destructive"> = {
  online: "success",
  degraded: "warning",
  offline: "destructive",
  paused: "warning",
  unknown: "secondary",
  creating: "secondary",
  updating: "warning",
  ready: "success",
  stopped: "secondary",
  error: "destructive",
  deleting: "warning",
};

const label = (status: string) => status.charAt(0).toUpperCase() + status.slice(1);

/** The list's tags (up to three) and the type badge. */
function TagSummary({ tags, type }: { tags: string[]; type: string }) {
  const shown = tags.slice(0, 3);
  return (
    <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
      {shown.map((raw) => {
        const tag = parseResourceTag(raw);
        const badge = resourceTagBadgeProps(tag.color);
        return (
          <Badge
            key={raw}
            variant={badge.variant}
            className={cn("max-w-[180px]", badge.className)}
            title={raw}
          >
            {tag.label}
          </Badge>
        );
      })}
      {tags.length > shown.length && <Badge variant="outline">+{tags.length - shown.length}</Badge>}
      <span className="inline-flex shrink-0">
        <Badge variant="outline" className="uppercase">
          {type}
        </Badge>
      </span>
    </div>
  );
}

export function DataTab({
  app,
  version,
  actions,
}: {
  app: AppDetail;
  version: number;
  actions: TabActions;
}) {
  const navigate = useNavigate();
  const { byId: nodesById } = useNodeIndex(version);
  // Logging environments are listed only while logging is on for this Opfield.
  const loggingEnabled = useSystemConfigStore((state) => state.config.features.loggingEnabled);
  const data = useAppLoad(`data:${app.id}:${loggingEnabled}`, version, () =>
    loadAppData(app.id, { loggingEnabled })
  );
  if (data.loading) return <ContentLoading loading />;

  const databases = groupByEnvironment(
    app.environments,
    data.data?.databases ?? [],
    (row) => row.app?.environmentId
  );
  const storage = groupByEnvironment(
    app.environments,
    data.data?.storage ?? [],
    (row) => row.app?.environmentId
  );
  const logging = groupByEnvironment(
    app.environments,
    data.data?.logging ?? [],
    (row) => row.app?.environmentId
  );

  const nameCell = (
    Icon: typeof Database,
    nodeId: string | undefined,
    name: string,
    detail: string
  ) => {
    const icon = nodeIconClassNames(nodeId ? nodesById.get(nodeId)?.appearanceColor : null);
    return (
      <div className="flex min-w-0 items-center gap-4">
        <div className={icon.wrapper}>
          <Icon className={cn("h-5 w-5", icon.icon)} />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="truncate text-xs text-muted-foreground">{detail}</p>
        </div>
      </div>
    );
  };

  const databaseColumns: ResourceListColumn<DatabaseConnection>[] = [
    {
      id: "name",
      label: "Name",
      width: "36%",
      renderCell: (row) =>
        nameCell(
          row.managed ? DatabaseZap : Database,
          row.managed?.nodeId,
          row.name,
          `${row.host}:${row.port}${row.databaseName ? ` · ${row.databaseName}` : ""}`
        ),
    },
    {
      id: "tags",
      label: "Tags",
      width: "30%",
      align: "right",
      renderCell: (row) => <TagSummary tags={row.tags} type={databaseTypeLabel(row.type)} />,
    },
    {
      id: "lastCheck",
      label: "Last Check",
      width: "13%",
      align: "center",
      renderCell: (row) => (
        <Badge variant="outline">
          <RelativeTime value={row.lastHealthCheckAt} fallback="Never" />
        </Badge>
      ),
    },
    {
      id: "health",
      label: "Health",
      width: "13%",
      align: "center",
      renderCell: (row) => {
        const status = row.managed?.status === "paused" ? "paused" : row.healthStatus;
        return <Badge variant={HEALTH_BADGE[status] ?? "secondary"}>{label(status)}</Badge>;
      },
    },
    {
      id: "actions",
      label: "Actions",
      width: "5rem",
      align: "right",
      renderCell: (row) => (
        <RowMenu label={`Actions for ${row.name}`}>
          <DropdownMenuItem onClick={() => navigate(databaseRoute(row.slug))}>
            Open
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate(databaseRoute(row.slug, "explorer"))}>
            Explorer
          </DropdownMenuItem>
          {row.managed && (
            <DropdownMenuItem onClick={() => navigate(databaseRoute(row.slug, "backups"))}>
              Backups
            </DropdownMenuItem>
          )}
          <MemberMenuItems
            member={{
              type: "database",
              id: row.id,
              nodeId: row.managed?.nodeId ?? null,
              name: row.name,
              environmentId: row.app?.environmentId ?? "",
            }}
            actions={actions}
          />
        </RowMenu>
      ),
    },
  ];

  const storageColumns: ResourceListColumn<ObjectStorageConnection>[] = [
    {
      id: "name",
      label: "Name",
      width: "36%",
      renderCell: (row) =>
        nameCell(
          row.managed ? HardDriveDownload : HardDrive,
          row.managed?.nodeId,
          row.name,
          `${row.endpoint || formatProviderLabel(row.provider)}${row.defaultBucket ? ` · ${row.defaultBucket}` : ""}`
        ),
    },
    {
      id: "tags",
      label: "Tags",
      width: "30%",
      align: "right",
      renderCell: (row) => <TagSummary tags={row.tags} type={formatProviderLabel(row.provider)} />,
    },
    {
      id: "lastCheck",
      label: "Last Check",
      width: "13%",
      align: "center",
      renderCell: (row) => (
        <Badge variant="outline">
          <RelativeTime value={row.lastHealthCheckAt} fallback="Never" />
        </Badge>
      ),
    },
    {
      id: "health",
      label: "Health",
      width: "13%",
      align: "center",
      renderCell: (row) => {
        const status = row.managed?.status ?? row.healthStatus;
        return <Badge variant={HEALTH_BADGE[status] ?? "secondary"}>{label(status)}</Badge>;
      },
    },
    {
      id: "actions",
      label: "Actions",
      width: "5rem",
      align: "right",
      renderCell: (row) => (
        <RowMenu label={`Actions for ${row.name}`}>
          <DropdownMenuItem onClick={() => navigate(storageRoute(row))}>Open</DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate(storageRoute(row, "browser"))}>
            Objects
          </DropdownMenuItem>
          <MemberMenuItems
            member={{
              type: "storage",
              id: row.id,
              nodeId: row.managed?.nodeId ?? null,
              name: row.name,
              environmentId: row.app?.environmentId ?? "",
            }}
            actions={actions}
          />
        </RowMenu>
      ),
    },
  ];

  const loggingColumns: ResourceListColumn<LoggingEnvironment>[] = [
    {
      id: "name",
      label: "Name",
      width: "36%",
      renderCell: (row) =>
        nameCell(
          ScrollText,
          undefined,
          row.name,
          `${row.slug}${row.description ? ` · ${row.description}` : ""}`
        ),
    },
    {
      id: "schema",
      label: "Schema",
      width: "30%",
      align: "right",
      renderCell: (row) => (
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <Badge variant="outline" className="max-w-[180px]" title={row.schemaName ?? undefined}>
            {row.schemaName ?? "No schema"}
          </Badge>
          <span className="inline-flex shrink-0">
            <Badge variant="outline">{row.retentionDays}d</Badge>
          </span>
        </div>
      ),
    },
    {
      id: "lastIngest",
      label: "Last Ingest",
      width: "13%",
      align: "center",
      renderCell: (row) => (
        <Badge variant="outline">
          <RelativeTime value={row.lastIngestAt ?? null} fallback="Never" />
        </Badge>
      ),
    },
    {
      id: "status",
      label: "Status",
      width: "13%",
      align: "center",
      renderCell: (row) => (
        <Badge variant={row.enabled ? "success" : "secondary"}>
          {row.enabled ? "Enabled" : "Disabled"}
        </Badge>
      ),
    },
    {
      id: "actions",
      label: "Actions",
      width: "5rem",
      align: "right",
      renderCell: (row) => (
        <RowMenu label={`Actions for ${row.name}`}>
          <DropdownMenuItem onClick={() => navigate(loggingEnvironmentRoute(row.slug, "logs"))}>
            Logs
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate(loggingEnvironmentRoute(row.slug, "tokens"))}>
            Tokens
          </DropdownMenuItem>
          <MemberMenuItems
            member={{
              type: "logging",
              id: row.id,
              nodeId: null,
              name: row.name,
              environmentId: row.app?.environmentId ?? "",
            }}
            actions={actions}
          />
        </RowMenu>
      ),
    },
  ];

  if (groupTotal(databases) + groupTotal(storage) + groupTotal(logging) === 0) {
    return (
      <EmptyGroup
        title="Data"
        icon={<Database className="h-4 w-4" />}
        types={[TYPES.databases, TYPES.storage, TYPES.logging]}
        message="No databases, storage or logging environments yet."
        actions={actions}
      />
    );
  }

  return (
    <div className="space-y-4 pb-6">
      {groupTotal(databases) > 0 && (
        <TypeSection
          app={app}
          title={TYPES.databases.title}
          description="Databases by environment"
          icon={<Database className="h-4 w-4" />}
          headerActions={
            actions.canCreate ? <TypeActions type={TYPES.databases} actions={actions} /> : undefined
          }
          columns={databaseColumns}
          groups={databases}
          rowKey={(row) => row.id}
          onRowClick={(row) => navigate(databaseRoute(row.slug))}
        />
      )}
      {groupTotal(storage) > 0 && (
        <TypeSection
          app={app}
          title={TYPES.storage.title}
          description="Storage by environment"
          icon={<HardDrive className="h-4 w-4" />}
          headerActions={
            actions.canCreate ? <TypeActions type={TYPES.storage} actions={actions} /> : undefined
          }
          columns={storageColumns}
          groups={storage}
          rowKey={(row) => row.id}
          onRowClick={(row) => navigate(storageRoute(row))}
        />
      )}
      {groupTotal(logging) > 0 && (
        <TypeSection
          app={app}
          title={TYPES.logging.title}
          description="Log ingestion by environment"
          icon={<ScrollText className="h-4 w-4" />}
          headerActions={
            actions.canCreate ? <TypeActions type={TYPES.logging} actions={actions} /> : undefined
          }
          columns={loggingColumns}
          groups={logging}
          rowKey={(row) => row.id}
          onRowClick={(row) => navigate(loggingEnvironmentRoute(row.slug, "logs"))}
        />
      )}
      {actions.canCreate && (
        <AddRow
          types={present([
            groupTotal(databases) === 0 && TYPES.databases,
            groupTotal(storage) === 0 && TYPES.storage,
            groupTotal(logging) === 0 && TYPES.logging,
          ])}
          actions={actions}
        />
      )}
    </div>
  );
}
