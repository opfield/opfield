import {
  Activity,
  CreditCard,
  History,
  Link2,
  Plus,
  ServerCog,
  Settings,
  Trash2,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { ContentLoading } from "@/components/common/ContentLoading";
import { DetailPageSkeleton } from "@/components/common/DetailPageSkeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import {
  type ResponsiveHeaderAction,
  ResponsiveHeaderActions,
} from "@/components/common/ResponsiveHeaderActions";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/ui/stat-card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRealtime } from "@/hooks/use-realtime";
import { useStableNavigate } from "@/hooks/use-stable-navigate";
import { useUrlTab } from "@/hooks/use-url-tab";
import { toastApiError } from "@/lib/api-error-toast";
import { hostingOperationLabel } from "@/lib/hosting-status";
import { getReturnNavigationTarget } from "@/lib/return-navigation";
import { formatRelativeDate } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import {
  HOSTING_PROVIDER_LABELS,
  type HostingAccountSummary,
  type HostingCatalog,
  type HostingConnector,
  type HostingMoney,
  type HostingOperation,
  type HostingResource,
} from "@/types/hosting";
import { HostingAdoptDialog } from "./HostingAdoptDialog";
import { HostingConnectorDialog } from "./HostingConnectorDialog";
import { HostingResourcesTab } from "./HostingResourcesTab";

export interface HostingIntegrationDetailProps {
  acceptedOperations?: HostingOperation[];
  onCreate?: (connectorId: string) => void;
  onInstall?: (connectorId: string, resource: HostingResource) => void;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function operationVariant(
  phase: HostingOperation["phase"]
): "success" | "secondary" | "warning" | "destructive" | "outline" {
  if (phase === "ready") return "success";
  if (phase === "failed") return "destructive";
  if (phase === "unknown") return "warning";
  if (phase === "pending" || phase === "dispatching") return "secondary";
  return "outline";
}

function formatCapacity(value: number | null, unit: "MB" | "GB"): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toLocaleString()} ${unit}`;
}
function accountMoney(value: HostingMoney): string {
  return `${Number(value.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${value.currency}`;
}

export function HostingIntegrationDetail({
  acceptedOperations,
  onCreate,
  onInstall,
}: HostingIntegrationDetailProps) {
  const { connectorId } = useParams<{ connectorId?: string }>();
  const navigate = useStableNavigate();
  const location = useLocation();
  const returnTo = getReturnNavigationTarget(location.state, "/settings/integrations");
  const [adoptOpen, setAdoptOpen] = useState(false);
  const { hasScope, hasScopedAccess } = useAuthStore();
  const canView = !!connectorId && hasScope(`integrations:hosting:view:${connectorId}`);
  const canManage = !!connectorId && hasScope(`integrations:hosting:manage:${connectorId}`);
  const canViewAccountSummary = canView && hasScope(`hosting:billing:view:${connectorId}`);
  const [accountSummary, setAccountSummary] = useState<{
    id: string;
    data: HostingAccountSummary | null;
  } | null>(null);
  const summary =
    canViewAccountSummary && accountSummary?.id === connectorId ? accountSummary.data : null;
  const canCreate =
    !!connectorId &&
    hasScope(`hosting:resources:create:${connectorId}`) &&
    hasScopedAccess("nodes:create");
  const [configureOpen, setConfigureOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const loadGeneration = useRef(0);
  const [connector, setConnector] = useState<HostingConnector | null>(null);
  const [resources, setResources] = useState<HostingResource[]>([]);
  const [storedOperations, setOperations] = useState<HostingOperation[]>([]);
  const operations = useMemo(() => {
    const merged = new Map(storedOperations.map((operation) => [operation.id, operation]));
    for (const operation of acceptedOperations ?? []) {
      if (operation.connectorId !== connectorId) continue;
      const stored = merged.get(operation.id);
      if (!stored || stored.updatedAt < operation.updatedAt) merged.set(operation.id, operation);
    }
    return [...merged.values()];
  }, [storedOperations, acceptedOperations, connectorId]);
  const [catalog, setCatalog] = useState<HostingCatalog | null>(null);
  // The connector the catalog request last settled for. The catalog is auxiliary and never
  // holds the page; the Proxmox capacity panel says so while it is still on its way.
  const [catalogConnectorId, setCatalogConnectorId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedConnectorId, setLoadedConnectorId] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [resourceError, setResourceError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    if (!connectorId || !canView) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setResourceError(null);
    setOperationError(null);
    try {
      const nextConnector = await api.getHostingConnector(connectorId);
      if (generation !== loadGeneration.current) return;
      setConnector(nextConnector);
      if (canViewAccountSummary) {
        void api.getHostingAccountSummary(connectorId).then(
          (data) => {
            if (generation === loadGeneration.current) setAccountSummary({ id: connectorId, data });
          },
          () => {
            if (generation === loadGeneration.current)
              setAccountSummary({ id: connectorId, data: null });
          }
        );
      }
      // Catalog metadata is auxiliary; it must never block rendering the resource snapshot.
      void api
        .getHostingCatalog(connectorId)
        .then(
          (value) => {
            if (generation === loadGeneration.current) setCatalog(value);
          },
          () => {
            if (generation === loadGeneration.current) setCatalog(null);
          }
        )
        .finally(() => {
          if (generation === loadGeneration.current) setCatalogConnectorId(connectorId);
        });
      const [resourceResult, operationResult] = await Promise.allSettled([
        api.listHostingResources(connectorId),
        api.listHostingOperations(connectorId),
      ]);
      if (generation !== loadGeneration.current) return;
      if (resourceResult.status === "fulfilled") setResources(resourceResult.value ?? []);
      else {
        setResources([]);
        setResourceError(
          errorMessage(resourceResult.reason, "Provider resources are unavailable for this scope.")
        );
      }
      if (operationResult.status === "fulfilled") setOperations(operationResult.value ?? []);
      else {
        setOperations([]);
        setOperationError(
          errorMessage(operationResult.reason, "Hosting operations are unavailable for this scope.")
        );
      }
    } catch (requestError) {
      if (generation !== loadGeneration.current) return;
      const message = errorMessage(requestError, "Failed to load hosting integration.");
      setError(message);
      toast.error(message);
    } finally {
      if (generation === loadGeneration.current) {
        setLoadedConnectorId(connectorId);
        setLoading(false);
      }
    }
  }, [canView, canViewAccountSummary, connectorId]);

  useEffect(() => {
    void load();
    return () => {
      loadGeneration.current += 1;
    };
  }, [load]);

  useRealtime(
    canView ? "integration.connector.changed" : null,
    (payload) => {
      const event = payload as { connectorId?: string; id?: string } | null;
      if (event?.connectorId && event.connectorId !== connectorId) return;
      if (event?.id && event.id !== connectorId && !event.connectorId) return;
      void load();
    },
    { onReconnect: load }
  );

  const visibleTabs = useMemo(() => ["overview", "resources"], []);
  const [activeTab, setActiveTab] = useUrlTab(
    visibleTabs,
    "overview",
    (tab) => `/hosting/${encodeURIComponent(connectorId ?? "")}/${tab}`
  );

  const operationColumns = useMemo<SimpleTableColumn<HostingOperation>[]>(
    () => [
      {
        id: "action",
        header: "Action",
        render: (operation) => operation.action,
      },
      {
        id: "resource",
        header: "Resource",
        // Names, not ids: the resource of this integration, else the node the operation is for.
        render: (operation) =>
          (operation.resourceId
            ? resources.find(
                (resource) =>
                  resource.id === operation.resourceId || resource.remoteId === operation.resourceId
              )?.name
            : undefined) ??
          operation.node?.name ??
          (operation.resourceId || operation.nodeId ? "Removed resource" : "Account"),
      },
      {
        id: "status",
        header: "Status",
        render: (operation) => (
          <div className="min-w-0">
            <Badge variant={operationVariant(operation.phase)} size="inline">
              {hostingOperationLabel(operation)}
            </Badge>
            {operation.errorMessage && (
              <p className="mt-1 text-xs text-muted-foreground">{operation.errorMessage}</p>
            )}
          </div>
        ),
      },
      {
        id: "updated",
        header: "Updated",
        render: (operation) => <RelativeTime value={operation.updatedAt} />,
      },
    ],
    [resources]
  );

  if (!canView) {
    return (
      <PageTransition>
        <EmptyState message="You do not have permission to view hosting integrations." />
      </PageTransition>
    );
  }

  if (loading && loadedConnectorId !== connectorId)
    return <DetailPageSkeleton label="Loading hosting integration" />;

  if (error || !connector || !connectorId) {
    return (
      <PageTransition>
        <EmptyState
          message={error ?? "Hosting integration was not found."}
          actionLabel="Back"
          actionHref={returnTo}
        />
      </PageTransition>
    );
  }

  // The account balance and expense cards come from a follow-up request.
  const overviewLoading = canViewAccountSummary && accountSummary?.id !== connectorId;
  const managedResources = resources.filter((resource) => resource.origin !== "discovered");
  const unresolvedAdoption = resources.filter(
    (resource) => resource.origin === "discovered" && resource.nodes.length === 0
  );
  const historyRows = [...operations]
    .filter((operation) => operation.action !== "topup")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 8);
  const headerActions: ResponsiveHeaderAction[] = [
    ...(canCreate && connector.enabled && connector.capabilities.create && onCreate
      ? [
          {
            id: "create",
            label: "Create VM",
            icon: <Plus className="h-4 w-4" />,
            onClick: () => onCreate(connector.id),
            priority: 100,
          } satisfies ResponsiveHeaderAction,
        ]
      : []),
    ...(canManage
      ? ([
          {
            id: "adopt",
            label: "Adopt nodes",
            icon: <Link2 className="h-4 w-4" />,
            onClick: () => setAdoptOpen(true),
            alwaysOverflow: true,
            disabled: deleting || !connector.enabled,
          },
          {
            id: "configure",
            label: "Configure",
            icon: <Settings className="h-4 w-4" />,
            onClick: () => setConfigureOpen(true),
            alwaysOverflow: true,
            disabled: deleting,
          },
          {
            id: "delete",
            label: "Delete connector",
            icon: <Trash2 className="h-4 w-4" />,
            destructive: true,
            alwaysOverflow: true,
            disabled: deleting,
            onClick: async () => {
              if (
                !(await confirm({
                  title: "Delete Hosting Connector?",
                  description:
                    "Provider VMs and Opfield nodes will not be deleted. Reconnecting this account can restore their hosting associations.",
                  confirmLabel: "Delete connector",
                  variant: "destructive",
                }))
              )
                return;
              setDeleting(true);
              try {
                await api.deleteHostingConnector(connector.id);
                toast.success("Hosting connector deleted");
                navigate(returnTo);
              } catch (cause) {
                toastApiError(cause, "Failed to delete hosting connector.");
              } finally {
                setDeleting(false);
              }
            },
          },
        ] satisfies ResponsiveHeaderAction[])
      : []),
  ];

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6 space-y-4">
        <PageHeader
          className="shrink-0"
          leading={<PageBackButton onClick={() => navigate(returnTo)} />}
          title={connector.name}
          badges={
            <>
              <Badge variant="outline" size="inline">
                {HOSTING_PROVIDER_LABELS[connector.provider]}
              </Badge>
              <Badge variant={connector.enabled ? "success" : "secondary"} size="inline">
                {connector.enabled ? "enabled" : "disabled"}
              </Badge>
              <Badge
                variant={connector.syncStatus === "error" ? "destructive" : "outline"}
                size="inline"
              >
                {connector.syncStatus}
              </Badge>
            </>
          }
          description={`${connector.baseUrl} · ${resources.length} ${
            resources.length === 1 ? "resource" : "resources"
          }`}
          actions={
            <ResponsiveHeaderActions actions={headerActions}>
              {headerActions.map((action) => (
                <Button
                  key={action.id ?? action.label}
                  type="button"
                  variant={action.id === "create" ? "default" : "outline"}
                  disabled={action.disabled}
                  title={action.disabled ? action.disabledReason : undefined}
                  onClick={action.onClick}
                >
                  {action.icon}
                  {action.label}
                </Button>
              ))}
            </ResponsiveHeaderActions>
          }
        />

        {connector.syncLastError && <EmptyState message={connector.syncLastError} />}
        {resourceError && <EmptyState message={resourceError} />}
        {operationError && <EmptyState message={operationError} />}

        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="shrink-0">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="resources">Virtual machines</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="pb-6">
            <ContentLoading loading={overviewLoading} />
            <div className="space-y-4">
              <div
                className={`grid gap-4 sm:grid-cols-2 ${
                  summary?.balance && summary?.monthlyExpenses
                    ? "xl:grid-cols-4"
                    : summary?.balance || summary?.monthlyExpenses
                      ? "xl:grid-cols-3"
                      : ""
                }`}
              >
                <StatCard
                  label="Virtual machines"
                  value={String(resources.length)}
                  icon={ServerCog}
                  subtitle={`${managedResources.length} managed`}
                />
                <StatCard
                  label="Automatic adoption"
                  value={connector.settings.adoptionEnabled ? "Enabled" : "Disabled"}
                  icon={Activity}
                  subtitle={`${unresolvedAdoption.length} unbound resources`}
                />
                {summary?.balance ? (
                  <StatCard
                    label="Account balance"
                    value={accountMoney(summary.balance)}
                    icon={Wallet}
                    subtitle={`Updated ${formatRelativeDate(summary.observedAt)}`}
                  />
                ) : null}
                {summary?.monthlyExpenses ? (
                  <StatCard
                    label="Monthly expenses"
                    value={accountMoney(summary.monthlyExpenses)}
                    icon={CreditCard}
                    subtitle="Accessible VMs · estimated monthly equivalent"
                  />
                ) : null}
              </div>

              <PanelShell
                title="Connection"
                icon={<ServerCog className="h-4 w-4" />}
                description="Provider identity and current Opfield sync state."
              >
                <SettingsControlRow title="Provider">
                  <span className="text-sm text-muted-foreground">
                    {HOSTING_PROVIDER_LABELS[connector.provider]}
                  </span>
                </SettingsControlRow>
                <SettingsControlRow title="Connector ID">
                  <span className="text-sm text-muted-foreground">
                    {<code className="break-all text-xs">{connector.id}</code>}
                  </span>
                </SettingsControlRow>
                <SettingsControlRow title="API origin">
                  <span className="text-sm text-muted-foreground">
                    {<span className="max-w-full truncate">{connector.baseUrl}</span>}
                  </span>
                </SettingsControlRow>
                <SettingsControlRow title="Sync">
                  <Badge
                    variant={
                      connector.syncStatus === "success"
                        ? "success"
                        : connector.syncStatus === "error"
                          ? "destructive"
                          : "secondary"
                    }
                    size="inline"
                  >
                    {connector.syncStatus}
                  </Badge>
                </SettingsControlRow>
                <SettingsControlRow title="Last connection test">
                  <RelativeTime
                    value={connector.testedAt}
                    fallback="Never"
                    className="text-sm text-muted-foreground"
                  />
                </SettingsControlRow>
                <SettingsControlRow title="Last sync">
                  <RelativeTime
                    value={connector.syncedAt}
                    fallback="Never synced"
                    className="text-sm text-muted-foreground"
                  />
                </SettingsControlRow>
              </PanelShell>

              {connector.provider === "proxmox" ? (
                <PanelShell
                  title="Proxmox capacity"
                  icon={<ServerCog className="h-4 w-4" />}
                  description="Host and storage capacity returned by the provider catalog."
                >
                  {catalog?.capacity?.length ? (
                    <SimpleTable
                      columns={[
                        { id: "name", header: "Host", render: (host) => host.name },
                        {
                          id: "status",
                          header: "Status",
                          render: (host) => (
                            <Badge variant={host.online ? "success" : "destructive"} size="inline">
                              {host.online ? "online" : "offline"}
                            </Badge>
                          ),
                        },
                        {
                          id: "memory",
                          header: "Memory",
                          render: (host) =>
                            `${formatCapacity(host.memoryUsedMb, "MB")} / ${formatCapacity(host.memoryTotalMb, "MB")}`,
                        },
                        {
                          id: "disk",
                          header: "Disk",
                          render: (host) =>
                            `${formatCapacity(host.diskUsedGb, "GB")} / ${formatCapacity(host.diskTotalGb, "GB")}`,
                        },
                      ]}
                      rows={catalog.capacity}
                      getRowKey={(host) => host.id}
                      emptyMessage="No Proxmox capacity reported."
                    />
                  ) : (
                    <EmptyState
                      message={
                        catalogConnectorId === connectorId
                          ? "Capacity is unavailable for this connector."
                          : "Loading capacity from the provider…"
                      }
                      embedded
                    />
                  )}
                </PanelShell>
              ) : null}

              <PanelShell
                title="Recent account operations"
                icon={<History className="h-4 w-4" />}
                description="Backend activity history. Current progress and available actions are shown on each resource."
              >
                <SimpleTable
                  columns={operationColumns}
                  rows={historyRows}
                  getRowKey={(operation) => operation.id}
                  loading={false}
                  emptyMessage="No hosting operations recorded."
                />
              </PanelShell>
            </div>
          </TabsContent>

          <TabsContent value="resources" className="pb-6">
            <HostingResourcesTab
              connector={connector}
              resources={resources}
              operations={operations}
              catalog={catalog}
              loading={loading}
              onInstall={onInstall ? (resource) => onInstall(connector.id, resource) : undefined}
              onChanged={() => void load()}
            />
          </TabsContent>
        </Tabs>
      </div>
      <HostingAdoptDialog
        open={adoptOpen}
        connectorId={connector.id}
        onClose={() => setAdoptOpen(false)}
        onAdopted={() => void load()}
      />
      <HostingConnectorDialog
        open={configureOpen}
        connector={connector}
        onClose={() => setConfigureOpen(false)}
        onSaved={() => void load()}
      />
    </PageTransition>
  );
}
