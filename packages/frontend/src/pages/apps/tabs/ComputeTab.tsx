// Compute: containers and deployments, Compose projects with their services, Pages projects,
// each grouped by environment (canvas frames app-compute, app-empty).
import { Box, Boxes, GitBranch, Globe2, Play, RefreshCw, Square } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ContentLoading } from "@/components/common/ContentLoading";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import {
  ResourceListCell,
  type ResourceListColumn,
  ResourceListRow,
} from "@/components/common/ResourceListLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { toastApiError } from "@/lib/api-error-toast";
import { formatDisplayImageRef } from "@/lib/docker-image-ref";
import { nodeBadgeClassName, nodeIconClassNames } from "@/lib/node-appearance";
import {
  dockerComposeProjectRoute,
  dockerContainerRoute,
  dockerDeploymentRoute,
  pageProjectRoute,
} from "@/lib/resource-routes";
import { cn } from "@/lib/utils";
import { containerLifecycleActions, STATUS_BADGE } from "@/pages/docker-detail/helpers";
import { formatPageBytes } from "@/pages/pages/page-format";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { AppDetail, DockerContainer, PageProject } from "@/types";
import {
  type AppComposeRow,
  loadAppCompute,
  loadAppPages,
  serviceName,
  useAppLoad,
} from "../app-resources";
import { CountTitle, GroupedList, groupByEnvironment, groupTotal, RowMenu } from "../app-shared";
import {
  AddRow,
  EmptyGroup,
  MemberMenuItems,
  type MemberRef,
  present,
  type TabActions,
  TYPES,
  TypeActions,
  TypeSection,
} from "./tab-shared";

const nodeIdOf = (container: DockerContainer) => container.nodeId ?? container._nodeId ?? "";

function containerMember(container: DockerContainer): MemberRef {
  return container.kind === "deployment"
    ? {
        type: "deployment",
        id: container.deploymentId ?? container.id,
        nodeId: nodeIdOf(container),
        name: container.name,
        environmentId: container.app?.environmentId ?? "",
      }
    : {
        type: "container",
        id: container.name,
        nodeId: nodeIdOf(container),
        name: container.name,
        environmentId: container.app?.environmentId ?? "",
      };
}

function containerStatus(container: DockerContainer): string {
  if (container.availability === "unavailable") return "unavailable";
  return container.availabilityPolicyStatus ?? container._transition ?? container.state;
}

function containerHealth(container: DockerContainer): string {
  return (
    container.availabilityHealthStatus ??
    (container.healthStatus === "stopped"
      ? "stopped"
      : container.secureLinkDown
        ? "offline"
        : container.healthCheckEnabled
          ? (container.healthStatus ?? "unknown")
          : "disabled")
  );
}

function NodeCellBadge({ name, color }: { name?: string; color?: DockerContainer["_nodeColor"] }) {
  return (
    <Badge variant="secondary" className={nodeBadgeClassName(color ?? null)}>
      {name || "-"}
    </Badge>
  );
}

export function ComputeTab({
  app,
  version,
  actions,
}: {
  app: AppDetail;
  version: number;
  actions: TabActions;
}) {
  const navigate = useNavigate();
  const canManage = useAuthStore((state) => state.hasScopedAccess("docker:containers:manage"));
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [localVersion, setLocalVersion] = useState(0);
  const compute = useAppLoad(`compute:${app.id}`, version + localVersion, () =>
    loadAppCompute(app.id)
  );
  const pages = useAppLoad(`pages:${app.id}`, version, () => loadAppPages(app.id));

  if (compute.loading || pages.loading) return <ContentLoading loading />;

  const containers = groupByEnvironment(
    app.environments,
    compute.data?.containers ?? [],
    (row) => row.app?.environmentId
  );
  const compose = groupByEnvironment(
    app.environments,
    compute.data?.compose ?? [],
    (row) => row.project.app?.environmentId
  );
  const pageGroups = groupByEnvironment(
    app.environments,
    pages.data ?? [],
    (row) => row.app?.environmentId
  );

  const openContainer = (container: DockerContainer, tab?: string) =>
    navigate(
      container.kind === "deployment"
        ? dockerDeploymentRoute(container._nodeSlug ?? "", container.name, tab)
        : dockerContainerRoute(container._nodeSlug ?? "", container.name, tab)
    );

  const lifecycle = async (container: DockerContainer, action: "start" | "stop" | "restart") => {
    const nodeId = nodeIdOf(container);
    setBusy((current) => ({ ...current, [container.id]: action }));
    try {
      if (container.kind === "deployment") {
        const id = container.deploymentId ?? container.id;
        if (action === "start") await api.startDockerDeployment(nodeId, id);
        if (action === "stop") await api.stopDockerDeployment(nodeId, id);
        if (action === "restart") await api.restartDockerDeployment(nodeId, id);
      } else {
        if (action === "start") await api.startContainer(nodeId, container.id);
        if (action === "stop") await api.stopContainer(nodeId, container.id);
        if (action === "restart") await api.restartContainer(nodeId, container.id);
      }
      setLocalVersion((current) => current + 1);
    } catch (error) {
      toastApiError(error, `Failed to ${action} ${container.name}`);
    } finally {
      setBusy((current) => {
        const next = { ...current };
        delete next[container.id];
        return next;
      });
    }
  };

  const containerColumns: ResourceListColumn<DockerContainer>[] = [
    {
      id: "name",
      label: "Name",
      width: "28%",
      renderCell: (row) => (
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
            {row.kind === "deployment" ? (
              <GitBranch className="h-4 w-4 text-muted-foreground" />
            ) : (
              <Box className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium">{row.name}</span>
              {row.kind === "deployment" && (
                <Badge variant="outline" size="inline" className="shrink-0">
                  Deployment
                </Badge>
              )}
            </div>
            <p className="truncate font-mono text-xs text-muted-foreground">
              {row.kind === "deployment" ? `active ${row.activeSlot ?? "-"}` : row.id.slice(0, 12)}
            </p>
          </div>
        </div>
      ),
    },
    {
      id: "image",
      label: "Image",
      width: "28%",
      renderCell: (row) => (
        <Badge variant="secondary" className="max-w-full font-mono">
          {row.pendingSourceBuild ? "Awaiting build" : formatDisplayImageRef(row.image ?? "")}
        </Badge>
      ),
    },
    {
      id: "node",
      label: "Node",
      renderCell: (row) => <NodeCellBadge name={row._nodeName} color={row._nodeColor} />,
    },
    {
      id: "status",
      label: "Status",
      width: "8.5rem",
      renderCell: (row) => {
        const status = containerStatus(row);
        return (
          <Badge variant={STATUS_BADGE[status] ?? "secondary"}>{status.replaceAll("_", " ")}</Badge>
        );
      },
    },
    {
      id: "health",
      label: "Health",
      width: "7rem",
      renderCell: (row) => {
        const health = containerHealth(row);
        return <Badge variant={STATUS_BADGE[health] ?? "secondary"}>{health}</Badge>;
      },
    },
    {
      id: "actions",
      label: "Actions",
      width: "7.5rem",
      align: "right",
      cellContentClassName: "gap-1 pl-3 whitespace-nowrap",
      renderCell: (row) => {
        const life = row.pendingSourceBuild
          ? { canStart: false, canStop: false, canRestart: false }
          : containerLifecycleActions(row.state);
        const running = busy[row.id];
        const disabled =
          Boolean(running) || Boolean(row._transition) || row.availability === "unavailable";
        return (
          <div
            className="flex items-center justify-end gap-1"
            onClick={(event) => event.stopPropagation()}
          >
            {canManage && life.canStop && (
              <Button
                variant="ghost"
                size="icon"
                title="Stop"
                pending={running === "stop"}
                disabled={disabled}
                onClick={() => void lifecycle(row, "stop")}
              >
                {running !== "stop" && <Square className="h-3.5 w-3.5" />}
              </Button>
            )}
            {canManage && life.canRestart && (
              <Button
                variant="ghost"
                size="icon"
                title="Restart"
                pending={running === "restart"}
                disabled={disabled}
                onClick={() => void lifecycle(row, "restart")}
              >
                {running !== "restart" && <RefreshCw className="h-3.5 w-3.5" />}
              </Button>
            )}
            {canManage && !life.canStop && life.canStart && (
              <Button
                variant="ghost"
                size="icon"
                title="Start"
                pending={running === "start"}
                disabled={disabled}
                onClick={() => void lifecycle(row, "start")}
              >
                {running !== "start" && <Play className="h-3.5 w-3.5" />}
              </Button>
            )}
            <RowMenu label={`Actions for ${row.name}`}>
              <DropdownMenuItem onClick={() => openContainer(row)}>Open</DropdownMenuItem>
              <DropdownMenuItem onClick={() => openContainer(row, "logs")}>Logs</DropdownMenuItem>
              <DropdownMenuItem onClick={() => openContainer(row, "console")}>
                Console
              </DropdownMenuItem>
              <MemberMenuItems member={containerMember(row)} actions={actions} />
            </RowMenu>
          </div>
        );
      },
    },
  ];

  const composeColumns: ResourceListColumn<AppComposeRow>[] = [
    { id: "name", label: "Project / service", width: "28%" },
    { id: "image", label: "Image", width: "28%" },
    { id: "node", label: "Node" },
    { id: "status", label: "Status", width: "8.5rem" },
    { id: "health", label: "Health", width: "7rem" },
    { id: "actions", label: "Actions", width: "7.5rem", align: "right" },
  ];

  const composeRows = (rows: AppComposeRow[]) =>
    rows.flatMap(({ project, services }) => {
      const member: MemberRef = {
        type: "compose",
        id: project.id,
        nodeId: project.nodeId,
        name: project.name,
        environmentId: project.app?.environmentId ?? "",
      };
      const status = project.availabilityPolicyStatus ?? project.status;
      return [
        <ResourceListRow
          key={project.id}
          interactive
          onClick={() => navigate(dockerComposeProjectRoute(project.id))}
        >
          <ResourceListCell>
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Boxes className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{project.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {project.runningServiceCount}/{project.serviceCount} services running
                </p>
              </div>
            </div>
          </ResourceListCell>
          <ResourceListCell />
          <ResourceListCell>
            <NodeCellBadge name={project._nodeName} color={project._nodeColor} />
          </ResourceListCell>
          <ResourceListCell>
            <Badge variant={STATUS_BADGE[status] ?? "secondary"}>
              {status.replaceAll("_", " ")}
            </Badge>
          </ResourceListCell>
          <ResourceListCell />
          <ResourceListCell align="right">
            <RowMenu label={`Actions for ${project.name}`}>
              <DropdownMenuItem onClick={() => navigate(dockerComposeProjectRoute(project.id))}>
                Open
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => navigate(dockerComposeProjectRoute(project.id, "services"))}
              >
                Services
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => navigate(dockerComposeProjectRoute(project.id, "logs"))}
              >
                Logs
              </DropdownMenuItem>
              <MemberMenuItems member={member} actions={actions} />
            </RowMenu>
          </ResourceListCell>
        </ResourceListRow>,
        ...services.map((service) => {
          const serviceStatus = containerStatus(service);
          const serviceHealth = containerHealth(service);
          return (
            <ResourceListRow
              key={`${project.id}/${service.id}`}
              interactive
              onClick={() => openContainer(service)}
            >
              <ResourceListCell depth={1}>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{serviceName(service)}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {service.id.slice(0, 12)}
                  </p>
                </div>
              </ResourceListCell>
              <ResourceListCell>
                <Badge variant="secondary" className="max-w-full font-mono">
                  {formatDisplayImageRef(service.image ?? "")}
                </Badge>
              </ResourceListCell>
              <ResourceListCell />
              <ResourceListCell>
                <Badge variant={STATUS_BADGE[serviceStatus] ?? "secondary"}>
                  {serviceStatus.replaceAll("_", " ")}
                </Badge>
              </ResourceListCell>
              <ResourceListCell>
                <Badge variant={STATUS_BADGE[serviceHealth] ?? "secondary"}>{serviceHealth}</Badge>
              </ResourceListCell>
              <ResourceListCell align="right">
                <RowMenu label={`Actions for ${serviceName(service)}`}>
                  <DropdownMenuItem onClick={() => openContainer(service)}>
                    Container details
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => openContainer(service, "logs")}>
                    Logs
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => openContainer(service, "console")}>
                    Console
                  </DropdownMenuItem>
                </RowMenu>
              </ResourceListCell>
            </ResourceListRow>
          );
        }),
      ];
    });

  const pageColumns: ResourceListColumn<PageProject>[] = [
    {
      id: "name",
      label: "Project",
      width: "30%",
      renderCell: (project) => {
        const icon = nodeIconClassNames(project.appearanceColor);
        return (
          <div className="flex min-w-0 items-center gap-4">
            <div className={icon.wrapper}>
              <Globe2 className={cn("h-5 w-5", icon.icon)} />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{project.name}</p>
              <p className="truncate text-xs text-muted-foreground">{project.slug}</p>
            </div>
          </div>
        );
      },
    },
    {
      id: "deployments",
      label: "Deployments",
      width: "16%",
      cellContentClassName: "text-sm text-muted-foreground",
      renderCell: (project) => project.deploymentCount,
    },
    {
      id: "tags",
      label: "Tags",
      width: "10%",
      cellContentClassName: "text-sm text-muted-foreground",
      renderCell: (project) => project.tagCount,
    },
    {
      id: "storage",
      label: "Storage",
      width: "16%",
      cellContentClassName: "text-sm text-muted-foreground",
      renderCell: (project) =>
        `${formatPageBytes(project.storageUsedBytes)} / ${formatPageBytes(project.storageQuotaBytes)}`,
    },
    {
      id: "updated",
      label: "Updated",
      cellContentClassName: "text-sm text-muted-foreground",
      renderCell: (project) => <RelativeTime value={project.updatedAt} />,
    },
    {
      id: "actions",
      label: "Actions",
      width: "5rem",
      align: "right",
      renderCell: (project) => (
        <RowMenu label={`Actions for ${project.name}`}>
          <DropdownMenuItem onClick={() => navigate(pageProjectRoute(project.slug))}>
            Open
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate(pageProjectRoute(project.slug, "deployments"))}>
            Deployments
          </DropdownMenuItem>
          <MemberMenuItems
            member={{
              type: "pages",
              id: project.id,
              nodeId: project.nodeId,
              name: project.name,
              environmentId: project.app?.environmentId ?? "",
            }}
            actions={actions}
          />
        </RowMenu>
      ),
    },
  ];

  const total = groupTotal(containers) + groupTotal(compose) + groupTotal(pageGroups);
  if (total === 0) {
    return (
      <EmptyGroup
        title="Compute"
        icon={<Box className="h-4 w-4" />}
        types={[TYPES.containers, TYPES.compose, TYPES.pages]}
        message="No containers, Compose projects or Pages projects yet. Create one or import an existing one."
        actions={actions}
      />
    );
  }

  return (
    <div className="space-y-4 pb-6">
      {groupTotal(containers) > 0 && (
        <TypeSection
          app={app}
          title={TYPES.containers.title}
          description="Containers and deployments by environment"
          icon={<Box className="h-4 w-4" />}
          headerActions={
            actions.canCreate ? (
              <TypeActions type={TYPES.containers} actions={actions} />
            ) : undefined
          }
          columns={containerColumns}
          groups={containers}
          rowKey={(row) => `${nodeIdOf(row)}:${row.id}`}
          onRowClick={(row) => openContainer(row)}
        />
      )}
      {groupTotal(compose) > 0 && (
        <PanelShell
          title={<CountTitle title={TYPES.compose.title} count={groupTotal(compose)} />}
          icon={<Boxes className="h-4 w-4" />}
          description="Compose projects and their services"
          actions={
            actions.canCreate ? <TypeActions type={TYPES.compose} actions={actions} /> : undefined
          }
        >
          <GroupedList
            appSlug={app.slug}
            columns={composeColumns}
            groups={compose}
            rowKey={(row) => row.project.id}
            renderRows={composeRows}
          />
        </PanelShell>
      )}
      {groupTotal(pageGroups) > 0 && (
        <TypeSection
          app={app}
          title={TYPES.pages.title}
          description="Static sites by environment"
          icon={<Globe2 className="h-4 w-4" />}
          headerActions={
            actions.canCreate ? <TypeActions type={TYPES.pages} actions={actions} /> : undefined
          }
          columns={pageColumns}
          groups={pageGroups}
          rowKey={(row) => row.id}
          onRowClick={(row) => navigate(pageProjectRoute(row.slug))}
        />
      )}
      {actions.canCreate && (
        <AddRow
          types={present([
            groupTotal(containers) === 0 && TYPES.containers,
            groupTotal(compose) === 0 && TYPES.compose,
            groupTotal(pageGroups) === 0 && TYPES.pages,
          ])}
          actions={actions}
        />
      )}
    </div>
  );
}
