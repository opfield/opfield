// An environment's own page: variables, secrets, maintenance for all its routes, its node and
// domain allowlists (canvas section "envs": env-live, env-staging, env-live-maintenance, env-allow-node,
// env-live-overridden, env-access-code) and Promote (env-promote, env-promote-summary).
import { ChevronRight, KeyRound, Plus, RefreshCw, Server, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { IsolatedNotice } from "@/components/apps/IsolatedNotice";
import { confirm } from "@/components/common/ConfirmDialog";
import { DetailPageSkeleton } from "@/components/common/DetailPageSkeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/lib/api-error-toast";
import { appEnvironmentRoute, appRoute } from "@/lib/app-routes";
import { nodeRoute } from "@/lib/resource-routes";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { usePublishedPageResource } from "@/stores/resolved-page-context";
import type { AppAllowedNodes, AppDetail, AppEnvironmentDetail, ProxyHost } from "@/types";
import { AppRouteFailure } from "./AppPage";
import {
  type AllowedNodeRow,
  allowedNodeColumns,
  allowedNodeName,
  usageCount,
  usageText,
} from "./allowed-nodes";
import {
  CountTitle,
  FlatList,
  HealthBadge,
  MoreMenu,
  memberTotal,
  plural,
  RowMenu,
} from "./app-shared";
import { AccessCodeDialog, type AccessCodeState } from "./dialogs/AccessCodeDialog";
import { AllowNodeDialog } from "./dialogs/AllowNodeDialog";
import { AllowedDomainsPanel } from "./env/AllowedDomainsPanel";
import { PromotePanel } from "./env/PromotePanel";
import { VariablesPanel } from "./env/VariablesPanel";
import { useAppDetail } from "./use-app";
import { useNodeIndex } from "./use-node-index";

export function AppEnvironmentPage() {
  const { appSlug, envSlug } = useParams<{ appSlug: string; envSlug: string }>();
  const { app, loading, error, version, refresh } = useAppDetail(appSlug);
  // The environment this page showed last, so a rename made elsewhere follows its new slug.
  const shownEnvIdRef = useRef<string | null>(null);
  const env =
    app?.environments.find((item) => item.slug === envSlug || item.id === envSlug) ?? null;
  usePublishedPageResource(
    appSlug && envSlug
      ? `/apps/${encodeURIComponent(appSlug)}/env/${encodeURIComponent(envSlug)}`
      : undefined,
    app && env && env.access !== "members"
      ? {
          resourceType: "app-environment",
          resourceId: env.id,
          scopeResourceId: app.id,
          label: `${env.name} of ${app.name}`,
        }
      : null
  );
  if (!app) {
    if (error) return <AppRouteFailure error={error} />;
    if (loading) return <DetailPageSkeleton label="Loading environment" />;
    return null;
  }
  const renamed = env
    ? undefined
    : app.environments.find((item) => item.id === shownEnvIdRef.current);
  if (renamed && renamed.access !== "members") {
    return <Navigate to={appEnvironmentRoute(app.slug, renamed.slug)} replace />;
  }
  // A deleted environment, or one seen only through members (its page is its settings): back to its app.
  if (!env || env.access === "members") return <Navigate to={appRoute(app.slug)} replace />;
  shownEnvIdRef.current = env.id;
  return <EnvironmentContent app={app} env={env} version={version} refresh={refresh} />;
}

function EnvironmentContent({
  app,
  env,
  version,
  refresh,
}: {
  app: AppDetail;
  env: AppEnvironmentDetail;
  version: number;
  refresh: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const canManage = Boolean(app.permissions.envManage[env.id]);
  const canIssueCode = canManage || app.permissions.edit || app.permissions.operate;
  const canViewRoutes = useAuthStore((state) => state.hasScopedAccess("proxy:view"));
  const { nodes, byId: nodesById } = useNodeIndex(version);
  const [refreshing, setRefreshing] = useState(false);
  const [allowOpen, setAllowOpen] = useState(false);
  const [accessCode, setAccessCode] = useState<AccessCodeState | null>(null);
  const [allowed, setAllowed] = useState<AppAllowedNodes | null>(null);
  const [routes, setRoutes] = useState<ProxyHost[] | null>(null);
  const [maintenanceSaving, setMaintenanceSaving] = useState(false);

  // From a blocked create dialog: open Allow Node on arrival.
  useEffect(() => {
    if (searchParams.get("allow") !== "node") return;
    if (canManage) setAllowOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("allow");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, canManage]);

  const loadExtras = useCallback(async () => {
    const [nodesResult, routesResult] = await Promise.all([
      api.listAppAllowedNodes(app.id, env.id).catch(() => null),
      // Routes need proxy:view: without it the count comes from the app (no refused request).
      canViewRoutes ? api.listAppRoutes(app.id).catch(() => null) : Promise.resolve(null),
    ]);
    setAllowed(nodesResult);
    setRoutes(
      routesResult ? routesResult.filter((route) => route.app?.environmentId === env.id) : null
    );
  }, [app.id, env.id, canViewRoutes]);

  useEffect(() => {
    void version;
    void loadExtras();
  }, [loadExtras, version]);

  const doRefresh = async () => {
    setRefreshing(true);
    await Promise.all([refresh(), loadExtras()]);
    setRefreshing(false);
  };

  const createAccessCode = async () => {
    try {
      const result = await api.createAppMaintenanceAccessCode(app.id, env.id);
      setAccessCode({ ...result, scopeLabel: `${env.name} of ${app.name}` });
    } catch (error) {
      toastApiError(error, "Failed to create a maintenance access code");
    }
  };

  const setMaintenance = async (enabled: boolean) => {
    if (enabled) {
      const ok = await confirm({
        title: `Maintenance for ${env.name}`,
        description: `Every route of ${env.name} returns the maintenance page (HTTP 503) until you turn it off. Each route's own maintenance setting is kept.`,
        confirmLabel: "Turn On",
      });
      if (!ok) return;
    }
    setMaintenanceSaving(true);
    try {
      await api.updateAppEnvironment(app.id, env.id, { maintenanceEnabled: enabled });
      toast.success(enabled ? `Maintenance on for ${env.name}` : `Maintenance off for ${env.name}`);
      await refresh();
      await loadExtras();
    } catch (error) {
      toastApiError(error, "Failed to update maintenance");
    } finally {
      setMaintenanceSaving(false);
    }
  };

  const removeNode = async (row: AllowedNodeRow) => {
    const used = usageCount(row.usedBy);
    const name = allowedNodeName(row);
    const ok = await confirm({
      title: `Remove ${name} from ${env.name}`,
      description:
        used > 0
          ? `${usageText(row.usedBy)} of ${env.name} keep running there. New resources of ${env.name} can no longer be created on it.`
          : `New resources of ${env.name} can no longer be created on it.`,
      confirmLabel: "Remove",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      setAllowed(await api.removeAppNode(app.id, env.id, row.nodeId));
      toast.success(`${name} removed from ${env.name}`);
      void refresh();
    } catch (error) {
      toastApiError(error, "Failed to remove the node");
    }
  };

  const nodeIds = allowed ? allowed.nodes.map((node) => node.nodeId) : env.allowedNodeIds;
  const nodeRows: AllowedNodeRow[] = nodeIds.map((nodeId) => ({
    nodeId,
    node: nodesById.get(nodeId),
    allowed: allowed?.nodes.find((node) => node.nodeId === nodeId),
    usedBy: allowed?.nodes.find((node) => node.nodeId === nodeId)?.usedBy,
  }));
  const columns = allowedNodeColumns((row) => (
    <RowMenu label={`Actions for ${allowedNodeName(row)}`}>
      <DropdownMenuItem
        disabled={!row.node}
        onClick={() => row.node && navigate(nodeRoute(row.node.slug))}
      >
        Open node
      </DropdownMenuItem>
      {canManage && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive" onClick={() => void removeNode(row)}>
            Remove from allowed
          </DropdownMenuItem>
        </>
      )}
    </RowMenu>
  ));

  // Without the route list (no proxy:view) the environment's maintenance summary has the counts.
  const summaryCount = (key: string) => {
    const value = env.maintenance?.[key];
    return typeof value === "number" ? value : null;
  };
  const routeTotal = routes?.length ?? summaryCount("routeCount") ?? env.memberCounts.route ?? 0;
  const routesInMaintenance =
    routes?.filter((route) => route.maintenanceEnabled).length ??
    summaryCount("ownMaintenanceCount") ??
    0;
  const overridden = app.maintenanceOverride;
  const maintenanceBadge = overridden ? (
    <Badge variant="warning" size="inline">
      Overridden by the app
    </Badge>
  ) : env.maintenanceEnabled ? (
    <Badge variant="warning" size="inline">
      Maintenance
    </Badge>
  ) : routesInMaintenance > 0 ? (
    <Badge variant="warning" size="inline">
      {routesInMaintenance} of {routeTotal} routes
    </Badge>
  ) : (
    <Badge variant="secondary" size="inline">
      Off
    </Badge>
  );

  return (
    <PageTransition>
      <div className="h-full space-y-4 overflow-y-auto p-6">
        <PageHeader
          leading={<PageBackButton onClick={() => navigate(appRoute(app.slug))} />}
          title={env.name}
          badges={
            <>
              {env.isProduction && (
                <Badge variant="outline" size="inline" className="shrink-0">
                  Production
                </Badge>
              )}
              {memberTotal(env.memberCounts) > 0 && <HealthBadge health={env.health} inline />}
            </>
          }
          description={
            <span className="inline-flex items-center gap-1">
              <Button asChild variant="link" className="h-auto p-0">
                <Link to={appRoute(app.slug)}>{app.name}</Link>
              </Button>
              <ChevronRight className="h-3.5 w-3.5" />
              Environment {env.name} · {plural(memberTotal(env.memberCounts), "resource")}
            </span>
          }
          actions={
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                title="Refresh"
                aria-label="Refresh environment"
                onClick={() => void doRefresh()}
                disabled={refreshing}
              >
                <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
              </Button>
              {canIssueCode && (
                <MoreMenu label="More environment actions">
                  <DropdownMenuItem onClick={() => void createAccessCode()}>
                    <KeyRound className="h-4 w-4" />
                    Create Maintenance Access Code
                  </DropdownMenuItem>
                </MoreMenu>
              )}
            </div>
          }
        />

        <IsolatedNotice app={app} environmentIds={[env.id]} onChanged={() => void refresh()} />

        {canManage && <VariablesPanel app={app} env={env} version={version} />}

        <PanelShell
          title="Maintenance"
          icon={<Wrench className="h-4 w-4" />}
          description={`All routes of ${env.name} at once`}
        >
          <SettingsControlRow
            title="Maintenance"
            description={
              overridden
                ? `App maintenance is on for all ${plural(routeTotal, "route")}`
                : `${plural(routeTotal, "route")} return HTTP 503 while on`
            }
          >
            <div className="flex items-center gap-3">
              {maintenanceBadge}
              <Switch
                checked={overridden || env.maintenanceEnabled}
                onChange={(enabled) => void setMaintenance(enabled)}
                disabled={!canManage || overridden || maintenanceSaving}
                ariaLabel={`Maintenance for all routes of ${env.name}`}
              />
            </div>
          </SettingsControlRow>
        </PanelShell>

        <PanelShell
          title={<CountTitle title="Allowed nodes" count={nodeRows.length} />}
          icon={<Server className="h-4 w-4" />}
          description={`Nodes ${env.name} may use`}
          actions={
            canManage ? (
              <Button onClick={() => setAllowOpen(true)}>
                <Plus className="h-3.5 w-3.5" />
                Allow node
              </Button>
            ) : undefined
          }
        >
          {nodeRows.length === 0 ? (
            <EmptyState
              message={`No nodes allowed yet. Resources of ${env.name} are created only on its allowed nodes.`}
              embedded
              {...(canManage
                ? { actionLabel: "Allow a node", onAction: () => setAllowOpen(true) }
                : {})}
            />
          ) : (
            <FlatList
              columns={columns}
              rows={nodeRows}
              rowKey={(row) => row.nodeId}
              onRowClick={(row) => {
                if (row.node) navigate(nodeRoute(row.node.slug));
              }}
            />
          )}
        </PanelShell>
        <AllowedDomainsPanel
          app={app}
          env={env}
          canManage={canManage}
          onSaved={() => void refresh()}
        />
        <PromotePanel app={app} env={env} />
      </div>

      <AllowNodeDialog
        app={app}
        env={env}
        nodes={nodes}
        open={allowOpen}
        onOpenChange={setAllowOpen}
        onAllowed={() => {
          void refresh();
          void loadExtras();
        }}
      />
      <AccessCodeDialog value={accessCode} onClose={() => setAccessCode(null)} />
    </PageTransition>
  );
}
