// Network: routes and the private connections member workloads start (container links, database
// and storage bindings), grouped by environment (canvas frame app-network).
import { Globe, Link2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { ContentLoading } from "@/components/common/ContentLoading";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ProxyUpstreamTarget } from "@/components/proxy/ProxyUpstreamTarget";
import { Badge } from "@/components/ui/badge";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/lib/api-error-toast";
import { nodeBadgeClassName } from "@/lib/node-appearance";
import { isOpfieldPublicRoute } from "@/lib/proxy-route-protection";
import { proxyHostRoute } from "@/lib/resource-routes";
import { HEALTH_BADGE, HEALTH_LABEL, TYPE_BADGE } from "@/pages/proxy-detail/helpers";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type { AppDetail, ProxyHost } from "@/types";
import { type AppLinkRow, loadAppNetwork, useAppLoad } from "../app-resources";
import {
  groupByEnvironment,
  groupTotal,
  HiddenMembersNotice,
  presentHiddenMembers,
  RowMenu,
} from "../app-shared";
import { nodeDisplayName, useNodeIndex } from "../use-node-index";
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

export function NetworkTab({
  app,
  version,
  actions,
}: {
  app: AppDetail;
  version: number;
  actions: TabActions;
}) {
  const navigate = useNavigate();
  const hasScope = useAuthStore((state) => state.hasScope);
  // Routes and the workloads behind links have their own view scopes: list only what is allowed.
  const canViewContainers = useAuthStore((state) =>
    state.hasScopedAccess("docker:containers:view")
  );
  const canViewCompose = useAuthStore((state) => state.hasScopedAccess("docker:compose:view"));
  const canViewRoutes = useAuthStore((state) => state.hasScopedAccess("proxy:view"));
  const opfieldPublicUrl = useUIBootstrapStore(
    (state) => state.snapshot?.systemConfig.publicUrl ?? null
  );
  const { byId: nodesById } = useNodeIndex(version);
  const [localVersion, setLocalVersion] = useState(0);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const network = useAppLoad(`network:${app.id}`, version + localVersion, () =>
    loadAppNetwork(app.id, {
      containers: canViewContainers,
      compose: canViewCompose,
      routes: canViewRoutes,
    })
  );
  if (network.loading) return <ContentLoading loading />;

  const canEditHost = (host: ProxyHost) =>
    hasScope("proxy:edit") || hasScope(`proxy:edit:${host.id}`);

  const withToggle = async (
    host: ProxyHost,
    run: () => Promise<unknown>,
    done: string,
    failed: string
  ) => {
    setToggling((current) => new Set(current).add(host.id));
    try {
      await run();
      api.invalidateCache("req:/api/proxy-hosts");
      toast.success(done);
      setLocalVersion((current) => current + 1);
    } catch (error) {
      toastApiError(error, failed);
    } finally {
      setToggling((current) => {
        const next = new Set(current);
        next.delete(host.id);
        return next;
      });
    }
  };

  const toggleMaintenance = async (host: ProxyHost) => {
    const entering = !host.maintenanceEnabled;
    if (entering) {
      const ok = await confirm({
        title: "Enable Maintenance Mode",
        description:
          "All requests to this route will receive HTTP 503 and managed health checks will pause until maintenance ends.",
        confirmLabel: "Enable Maintenance",
      });
      if (!ok) return;
    }
    await withToggle(
      host,
      () => api.toggleProxyMaintenance(host.id, entering),
      entering ? "Maintenance mode enabled" : "Maintenance mode disabled",
      "Failed to update maintenance mode"
    );
  };

  const routes = groupByEnvironment(
    app.environments,
    network.data?.routes ?? [],
    (row) => row.app?.environmentId
  );
  const links = groupByEnvironment(
    app.environments,
    network.data?.links ?? [],
    (row) => row.environmentId
  );

  const linkColumns: ResourceListColumn<AppLinkRow>[] = [
    {
      id: "connection",
      label: "Connection",
      renderCell: (link) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{`${link.from} → ${link.to}`}</p>
          <p className="truncate text-xs text-muted-foreground">{link.detail}</p>
        </div>
      ),
    },
    {
      id: "status",
      label: "Status",
      width: "8rem",
      renderCell: (link) => <Badge variant={link.tone}>{link.status.replaceAll("_", " ")}</Badge>,
    },
  ];

  const routeColumns: ResourceListColumn<ProxyHost>[] = [
    {
      id: "domain-names",
      label: "Domains",
      renderCell: (host) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{host.domainNames[0]}</p>
          {host.domainNames.length > 1 && (
            <p className="truncate text-xs text-muted-foreground">
              +{host.domainNames.length - 1} more
            </p>
          )}
        </div>
      ),
    },
    {
      id: "upstream",
      label: "Target",
      width: "10rem",
      cellContentClassName: "text-sm text-muted-foreground",
      renderCell: (host) =>
        host.type === "proxy" ? (
          <ProxyUpstreamTarget host={host} />
        ) : host.type === "redirect" && host.redirectUrl ? (
          host.redirectUrl
        ) : (
          "—"
        ),
    },
    {
      id: "ingress-node",
      label: "Ingress Node",
      width: "9rem",
      renderCell: (host) => {
        const node = host.nodeId ? nodesById.get(host.nodeId) : undefined;
        return (
          <Badge variant="secondary" className={nodeBadgeClassName(node?.appearanceColor)}>
            {host.nodeId ? nodeDisplayName(node, host.nodeId) : "Unassigned"}
          </Badge>
        );
      },
    },
    {
      id: "type",
      label: "Type",
      width: "6.5rem",
      renderCell: (host) => (
        <Badge variant={TYPE_BADGE[host.type] ?? "secondary"}>{host.type}</Badge>
      ),
    },
    {
      id: "ssl",
      label: "TLS",
      width: "4.5rem",
      renderCell: (host) =>
        host.sslEnabled ? (
          <Badge variant="success">SSL</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "health",
      label: "Health",
      width: "8rem",
      renderCell: (host) => {
        if (host.maintenanceEnabled) return <Badge variant="warning">Maintenance</Badge>;
        const status = host.rawConfigEnabled
          ? "disabled"
          : host.effectiveHealthStatus || host.healthStatus;
        return (
          <Badge variant={HEALTH_BADGE[status] ?? "secondary"}>
            {HEALTH_LABEL[status] ?? status}
          </Badge>
        );
      },
    },
    {
      id: "enabled",
      label: "Enabled",
      width: "5.5rem",
      renderCell: (host) => {
        const locked =
          host.isSystem || (isOpfieldPublicRoute(host, opfieldPublicUrl) && host.enabled);
        return (
          <div onClick={(event) => event.stopPropagation()}>
            <Switch
              checked={locked ? true : host.enabled}
              onChange={(enabled) =>
                void withToggle(
                  host,
                  () => api.toggleProxyHost(host.id, enabled),
                  enabled ? "Route enabled" : "Route disabled",
                  "Failed to toggle route"
                )
              }
              disabled={locked || !canEditHost(host) || toggling.has(host.id)}
              ariaLabel={`Enable ${host.domainNames[0] ?? "route"}`}
            />
          </div>
        );
      },
    },
    {
      id: "actions",
      label: "Actions",
      width: "5rem",
      align: "right",
      renderCell: (host) => (
        <RowMenu label={`Route actions for ${host.domainNames[0] ?? host.slug}`}>
          <DropdownMenuItem onClick={() => navigate(proxyHostRoute(host.slug))}>
            Edit
          </DropdownMenuItem>
          {canEditHost(host) && (
            <DropdownMenuItem
              disabled={
                toggling.has(host.id) ||
                (isOpfieldPublicRoute(host, opfieldPublicUrl) && !host.maintenanceEnabled) ||
                (!host.maintenanceEnabled &&
                  (!host.enabled || host.type !== "proxy" || host.rawConfigEnabled))
              }
              onClick={() => void toggleMaintenance(host)}
            >
              {host.maintenanceEnabled ? "Disable Maintenance" : "Enable Maintenance"}
            </DropdownMenuItem>
          )}
          <MemberMenuItems
            member={{
              type: "route",
              id: host.id,
              nodeId: host.nodeId ?? null,
              name: host.domainNames[0] ?? host.slug,
              environmentId: host.app?.environmentId ?? "",
            }}
            actions={actions}
          />
        </RowMenu>
      ),
    },
  ];

  // Named only when the app has members of that type the user cannot see.
  const hidden = presentHiddenMembers(app, network.data?.hidden ?? []);
  if (groupTotal(routes) + groupTotal(links) === 0) {
    const empty = (
      <EmptyGroup
        title="Network"
        icon={<Globe className="h-4 w-4" />}
        types={[TYPES.routes, TYPES.links]}
        message="No routes or container links yet."
        actions={actions}
      />
    );
    if (hidden.length === 0) return empty;
    return (
      <div className="space-y-4 pb-6">
        <HiddenMembersNotice hidden={hidden} />
        {empty}
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-6">
      <HiddenMembersNotice hidden={hidden} />
      {groupTotal(routes) > 0 && (
        <TypeSection
          app={app}
          title={TYPES.routes.title}
          description="Routes by environment"
          icon={<Globe className="h-4 w-4" />}
          headerActions={
            actions.canCreate ? <TypeActions type={TYPES.routes} actions={actions} /> : undefined
          }
          columns={routeColumns}
          groups={routes}
          rowKey={(row) => row.id}
          onRowClick={(row) => navigate(proxyHostRoute(row.slug))}
        />
      )}
      {groupTotal(links) > 0 && (
        <TypeSection
          app={app}
          title={TYPES.links.title}
          description="Private connections to databases and storage"
          icon={<Link2 className="h-4 w-4" />}
          headerActions={
            actions.canCreate ? <TypeActions type={TYPES.links} actions={actions} /> : undefined
          }
          columns={linkColumns}
          groups={links}
          rowKey={(row) => row.id}
          onRowClick={(row) => {
            if (row.route) navigate(row.route);
          }}
        />
      )}
      {actions.canCreate && (
        <AddRow
          types={present([
            groupTotal(routes) === 0 && TYPES.routes,
            groupTotal(links) === 0 && TYPES.links,
          ])}
          actions={actions}
        />
      )}
    </div>
  );
}
