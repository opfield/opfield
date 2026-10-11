// Allowed nodes of an environment: the Nodes tab (read-only, grouped) and the environment page.
import { Server } from "lucide-react";
import type { ReactNode } from "react";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { nodeStatusTone } from "@/components/common/resource-status";
import { Badge } from "@/components/ui/badge";
import { nodeIconClassNames, nodeTypeLabel } from "@/lib/node-appearance";
import { cn } from "@/lib/utils";
import type { AppNodeUsage, Node } from "@/types";
import { plural } from "./app-shared";
import { nodeDisplayName } from "./use-node-index";

export interface AllowedNodeRow {
  nodeId: string;
  node: Node | undefined;
  usedBy: AppNodeUsage | undefined;
}

export function usageText(usage: AppNodeUsage | undefined): string {
  if (!usage) return "—";
  const parts = [
    usage.containers ? plural(usage.containers, "container") : null,
    usage.compose ? `${usage.compose} Compose` : null,
    usage.databases ? plural(usage.databases, "database") : null,
    usage.storage ? `${usage.storage} storage` : null,
    usage.routes ? plural(usage.routes, "route") : null,
    usage.pages ? `${usage.pages} Pages` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "Nothing yet";
}

export function usageCount(usage: AppNodeUsage | undefined): number {
  if (!usage) return 0;
  return Object.values(usage).reduce((sum, value) => sum + (value ?? 0), 0);
}

export function allowedNodeColumns(
  actions?: (row: AllowedNodeRow) => ReactNode
): ResourceListColumn<AllowedNodeRow>[] {
  return [
    {
      id: "name",
      label: "Node",
      width: "26%",
      renderCell: (row) => {
        const icon = nodeIconClassNames(row.node?.appearanceColor);
        return (
          <div className="flex min-w-0 items-center gap-4">
            <div className={icon.wrapper}>
              <Server className={cn("h-5 w-5", icon.icon)} />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {nodeDisplayName(row.node, row.nodeId)}
              </p>
              <p className="truncate text-xs text-muted-foreground">{row.node?.hostname ?? ""}</p>
            </div>
          </div>
        );
      },
    },
    {
      id: "type",
      label: "Type",
      width: "8rem",
      renderCell: (row) =>
        row.node ? <Badge variant="outline">{nodeTypeLabel(row.node.type)}</Badge> : null,
    },
    {
      id: "usage",
      label: "CPU · Memory · Disk",
      cellContentClassName: "text-sm text-muted-foreground",
      renderCell: (row) => {
        const health = row.node?.lastHealthReport;
        if (!health) return "—";
        const memory =
          health.systemMemoryTotalBytes > 0
            ? Math.round((health.systemMemoryUsedBytes / health.systemMemoryTotalBytes) * 100)
            : 0;
        const disk = Math.round(
          health.diskMounts?.find((mount) => mount.mountPoint === "/")?.usagePercent ?? 0
        );
        return `${health.cpuPercent.toFixed(0)}% · ${memory}% · ${disk}%`;
      },
    },
    {
      id: "used",
      label: "Used by",
      cellContentClassName: "text-sm text-muted-foreground",
      renderCell: (row) => usageText(row.usedBy),
    },
    {
      id: "health",
      label: "Health",
      width: "7rem",
      renderCell: (row) => {
        const status = row.node?.status ?? "unknown";
        return <Badge variant={nodeStatusTone(status)}>{status}</Badge>;
      },
    },
    ...(actions
      ? [
          {
            id: "actions",
            label: "Actions",
            width: "5rem",
            align: "right" as const,
            renderCell: actions,
          },
        ]
      : []),
  ];
}
