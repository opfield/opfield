import { Box, Boxes, Database } from "lucide-react";
import { Link } from "react-router-dom";
import { databaseHealthTone, dockerStateTone } from "@/components/common/resource-status";
import { Badge } from "@/components/ui/badge";
import { databaseTypeLabel } from "@/lib/database-type";
import {
  databaseRoute,
  dockerComposeProjectRoute,
  dockerContainerRoute,
  dockerDeploymentRoute,
} from "@/lib/resource-routes";
import { cn } from "@/lib/utils";
import type { DashboardBootstrapPinnedResources } from "@/types/dashboard";

type DatabaseResource = DashboardBootstrapPinnedResources["databases"][number];
type DockerResource = DashboardBootstrapPinnedResources["dockerResources"][number];

/** A pinned card behind a Dashboard attention notice gets the warning border of the Expiring Soon card. */
function pinnedCardClass(attention: boolean): string {
  return cn(
    "flex items-center justify-between rounded-lg border bg-card px-4 py-3 transition-colors hover:bg-accent",
    attention ? "border-warning/60" : "border-border"
  );
}

export function PinnedDatabaseCard({
  database,
  attention = false,
}: {
  database: DatabaseResource;
  attention?: boolean;
}) {
  return (
    <Link to={databaseRoute(database.slug, "overview")} className={pinnedCardClass(attention)}>
      <div className="flex min-w-0 items-center gap-3">
        <Database className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{database.name}</p>
          <p className="text-xs text-muted-foreground">{databaseTypeLabel(database.type)}</p>
        </div>
      </div>
      <Badge variant={databaseHealthTone(database.healthStatus)} size="inline">
        {database.healthStatus ?? "unknown"}
      </Badge>
    </Link>
  );
}

export function PinnedDockerResourceCard({
  resource,
  attention = false,
}: {
  resource: DockerResource;
  attention?: boolean;
}) {
  const route =
    resource.kind === "deployment"
      ? dockerDeploymentRoute(resource.nodeSlug, resource.name)
      : resource.kind === "compose"
        ? dockerComposeProjectRoute(resource.id)
        : dockerContainerRoute(resource.nodeSlug, resource.name);
  const Icon = resource.kind === "compose" ? Boxes : Box;
  return (
    <Link to={route} className={pinnedCardClass(attention)}>
      <div className="flex min-w-0 items-center gap-3">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{resource.name}</p>
          <p className="text-xs text-muted-foreground">{resource.kind}</p>
        </div>
      </div>
      <Badge variant={dockerStateTone(resource.state)} size="inline">
        {resource.state ?? "unknown"}
      </Badge>
    </Link>
  );
}
