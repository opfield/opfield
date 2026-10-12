// The app page: its own resource with tabs Overview · Compute · Data · Network · Nodes · Activity ·
// Settings (canvas `.design/canvas/apps/screens/AppPage.tsx`, section "app").
import {
  Box,
  Boxes,
  ChevronDown,
  Database,
  Globe,
  Globe2,
  HardDrive,
  Layers,
  Link2,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import type { AppCreateContext } from "@/components/apps/app-create-context";
import { openAppIncidents } from "@/components/apps/app-incidents";
import { IsolatedNotice } from "@/components/apps/IsolatedNotice";
import { MoveToAppDialog } from "@/components/apps/MoveToAppDialog";
import { DetailPageSkeleton } from "@/components/common/DetailPageSkeleton";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useUrlTab } from "@/hooks/use-url-tab";
import { toastApiError } from "@/lib/api-error-toast";
import { APP_TABS, type AppTab, appRoute } from "@/lib/app-routes";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { canServeLicenseFeature } from "@/stores/license-paywall";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type { AppDetail, AppMemberFamily } from "@/types";
import {
  AppCreateDialogs,
  type AppCreateRequest,
  type AppCreateType,
  appCreateFeatures,
  IMPORT_LICENSE_FEATURES,
} from "./AppCreateDialogs";
import { HealthBadge, memberTotal, plural } from "./app-shared";
import { AccessCodeDialog, type AccessCodeState } from "./dialogs/AccessCodeDialog";
import { ImportDialog, type ImportRequest } from "./dialogs/ImportDialog";
import { MoveToEnvironmentDialog } from "./dialogs/MoveToEnvironmentDialog";
import { NewEnvironmentDialog } from "./dialogs/NewEnvironmentDialog";
import { ActivityTab } from "./tabs/ActivityTab";
import { ComputeTab } from "./tabs/ComputeTab";
import { DataTab } from "./tabs/DataTab";
import { NetworkTab } from "./tabs/NetworkTab";
import { NodesTab } from "./tabs/NodesTab";
import { OverviewTab } from "./tabs/OverviewTab";
import { SettingsTab } from "./tabs/SettingsTab";
import type { MemberRef, TabActions } from "./tabs/tab-shared";
import { useAppDetail } from "./use-app";

const NEW_ITEMS: Array<{
  type: AppCreateType;
  variant?: "external";
  label: string;
  icon: typeof Box;
}> = [
  { type: "container", label: "Container or deployment", icon: Box },
  { type: "compose", label: "Compose project", icon: Boxes },
  { type: "database", label: "Database", icon: Database },
  { type: "database", variant: "external", label: "Database connection", icon: Database },
  { type: "storage", label: "Storage", icon: HardDrive },
  { type: "storage", variant: "external", label: "Storage connection", icon: HardDrive },
  { type: "route", label: "Route", icon: Globe },
  { type: "pages", label: "Pages project", icon: Globe2 },
  { type: "container-link", label: "Container link", icon: Link2 },
];

export function AppRouteFailure({ error }: { error: unknown }) {
  if (error instanceof ApiRequestError && (error.status === 403 || error.status === 404)) {
    return <Navigate to="/apps" replace />;
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <p className="text-sm text-muted-foreground">Failed to load this app.</p>
      <Button variant="outline" onClick={() => window.location.reload()}>
        Retry
      </Button>
    </div>
  );
}

function NewMenu({
  onCreate,
  onNewEnvironment,
  canCreate,
  planCreates,
}: {
  onCreate: (type: AppCreateType, variant?: "external") => void;
  onNewEnvironment?: () => void;
  canCreate: boolean;
  planCreates: (type: AppCreateType, variant?: "external") => boolean;
}) {
  const items = canCreate ? NEW_ITEMS.filter((item) => planCreates(item.type, item.variant)) : [];
  if (items.length === 0 && !onNewEnvironment) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          <Plus className="h-4 w-4" />
          New
          <ChevronDown className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {items.map((item) => (
          <DropdownMenuItem
            key={`${item.type}:${item.variant ?? ""}`}
            onClick={() => onCreate(item.type, item.variant)}
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </DropdownMenuItem>
        ))}
        {onNewEnvironment && (
          <>
            {items.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem onClick={onNewEnvironment}>
              <Layers className="h-4 w-4" />
              Environment
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppPage() {
  const { appSlug } = useParams<{ appSlug: string }>();
  const { app, setApp, loading, error, version, refresh } = useAppDetail(appSlug);
  if (!app) {
    if (error) return <AppRouteFailure error={error} />;
    if (loading) return <DetailPageSkeleton label="Loading app" />;
    return null;
  }
  return <AppPageContent app={app} setApp={setApp} version={version} refresh={refresh} />;
}

function AppPageContent({
  app,
  setApp,
  version,
  refresh,
}: {
  app: AppDetail;
  setApp: (app: AppDetail) => void;
  version: number;
  refresh: () => Promise<void>;
}) {
  const { permissions } = app;
  const canCreate = Object.values(permissions.envManage).some(Boolean);
  const canSettings =
    permissions.edit ||
    permissions.delete ||
    permissions.operate ||
    Object.values(permissions.operateEnv ?? {}).some(Boolean);
  const counts = app.environments.map((env) => env.memberCounts);
  const members = counts.reduce((sum, item) => sum + memberTotal(item), 0);
  const hasData = counts.some((item) => (item.database ?? 0) + (item.storage ?? 0) > 0);
  // Entry points of types the license plan lacks stay hidden; existing members stay listed.
  const license = useUIBootstrapStore((state) => state.snapshot?.license);
  const commercialModule = useUIBootstrapStore((state) => state.snapshot?.commercialModule);
  const planCreates = useCallback(
    (type: AppCreateType, variant?: "external") =>
      appCreateFeatures({ type, variant }).every((feature) =>
        canServeLicenseFeature({ license, commercialModule }, feature)
      ),
    [license, commercialModule]
  );
  const planImports = useCallback(
    (family: AppMemberFamily) => {
      const feature = IMPORT_LICENSE_FEATURES[family];
      return !feature || canServeLicenseFeature({ license, commercialModule }, feature);
    },
    [license, commercialModule]
  );
  const planHasData =
    planCreates("database") ||
    planCreates("database", "external") ||
    planCreates("storage") ||
    planCreates("storage", "external");
  const production = app.environments.find((env) => env.isProduction) ?? app.environments[0];

  const tabs: Array<{ value: AppTab; label: string; show: boolean }> = [
    { value: "overview", label: "Overview", show: true },
    { value: "compute", label: "Compute", show: true },
    { value: "data", label: "Data", show: hasData || (canCreate && planHasData) },
    { value: "network", label: "Network", show: true },
    { value: "nodes", label: "Nodes", show: true },
    { value: "activity", label: "Activity", show: true },
    { value: "settings", label: "Settings", show: canSettings },
  ];
  const visibleTabs = tabs.filter((tab) => tab.show).map((tab) => tab.value);
  const [activeTab, setActiveTab] = useUrlTab(
    visibleTabs.filter((tab) => (APP_TABS as readonly string[]).includes(tab)),
    "overview",
    (tab) => appRoute(app.slug, tab)
  );

  const [refreshing, setRefreshing] = useState(false);
  const [createRequest, setCreateRequest] = useState<AppCreateRequest | null>(null);
  const [importRequest, setImportRequest] = useState<ImportRequest | null>(null);
  const [moveEnvMember, setMoveEnvMember] = useState<MemberRef | null>(null);
  const [moveAppMember, setMoveAppMember] = useState<MemberRef | null>(null);
  const [newEnvOpen, setNewEnvOpen] = useState(false);
  const [accessCode, setAccessCode] = useState<AccessCodeState | null>(null);

  const createContext = useMemo<AppCreateContext>(
    () => ({
      app: { id: app.id, slug: app.slug, name: app.name },
      environments: app.environments.filter((env) => permissions.envManage[env.id]),
      environmentId: createRequest?.environmentId ?? null,
    }),
    [app, permissions.envManage, createRequest?.environmentId]
  );

  const actions: TabActions = useMemo(
    () => ({
      canCreate,
      onCreate: (type, environmentId) => setCreateRequest({ type, environmentId }),
      onImport: (family: AppMemberFamily) => setImportRequest({ family }),
      planCreates: (type) => planCreates(type),
      planImports,
      canMoveIn: (environmentId) => Boolean(permissions.envManage[environmentId]),
      onMoveToEnvironment: setMoveEnvMember,
      onMoveToApp: setMoveAppMember,
    }),
    [canCreate, permissions.envManage, planCreates, planImports]
  );

  const doRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  const createAccessCode = async (environmentId?: string) => {
    try {
      const result = await api.createAppMaintenanceAccessCode(app.id, environmentId);
      const env = app.environments.find((item) => item.id === environmentId);
      setAccessCode({ ...result, scopeLabel: env ? `${env.name} of ${app.name}` : app.name });
    } catch (reason) {
      toastApiError(reason, "Failed to create a maintenance access code");
    }
  };

  const isolated = openAppIncidents(app, "isolation").length > 0;
  const stopped = openAppIncidents(app, "shutdown").length > 0;

  return (
    <PageTransition>
      <div className="h-full space-y-4 overflow-y-auto p-6">
        <PageHeader
          leading={<PageBackButton />}
          title={app.name}
          badges={
            isolated ? (
              <Badge variant="destructive" size="inline" className="shrink-0">
                isolated
              </Badge>
            ) : stopped ? (
              <Badge variant="secondary" size="inline" className="shrink-0">
                stopped
              </Badge>
            ) : production && members > 0 ? (
              <HealthBadge health={production.health} inline />
            ) : null
          }
          description={`${plural(app.environments.length, "environment")} · ${plural(members, "resource")}`}
          actions={
            <ResponsiveHeaderActions
              reservedContentWidth={360}
              actions={[
                {
                  label: "Refresh",
                  icon: <RefreshCw className="h-4 w-4" />,
                  onClick: () => void doRefresh(),
                },
              ]}
            >
              <Button
                variant="outline"
                size="icon"
                title="Refresh"
                aria-label="Refresh app"
                onClick={() => void doRefresh()}
                disabled={refreshing}
              >
                <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
              </Button>
              {(canCreate || permissions.edit) && (
                <NewMenu
                  canCreate={canCreate}
                  planCreates={planCreates}
                  onCreate={(type, variant) => setCreateRequest({ type, variant })}
                  onNewEnvironment={permissions.edit ? () => setNewEnvOpen(true) : undefined}
                />
              )}
            </ResponsiveHeaderActions>
          }
        />

        <IsolatedNotice app={app} onChanged={() => void refresh()} />
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col">
          <TabsList className="shrink-0">
            {tabs
              .filter((tab) => tab.show)
              .map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value}>
                  {tab.label}
                </TabsTrigger>
              ))}
          </TabsList>
          <TabsContent value="overview">
            {activeTab === "overview" && <OverviewTab app={app} version={version} />}
          </TabsContent>
          <TabsContent value="compute">
            {activeTab === "compute" && (
              <ComputeTab app={app} version={version} actions={actions} />
            )}
          </TabsContent>
          <TabsContent value="data">
            {activeTab === "data" && <DataTab app={app} version={version} actions={actions} />}
          </TabsContent>
          <TabsContent value="network">
            {activeTab === "network" && (
              <NetworkTab app={app} version={version} actions={actions} />
            )}
          </TabsContent>
          <TabsContent value="nodes">
            {activeTab === "nodes" && <NodesTab app={app} version={version} />}
          </TabsContent>
          <TabsContent value="activity">
            {activeTab === "activity" && <ActivityTab app={app} version={version} />}
          </TabsContent>
          {canSettings && (
            <TabsContent value="settings">
              {activeTab === "settings" && (
                <SettingsTab
                  app={app}
                  routeCount={app.environments.reduce(
                    (sum, env) => sum + (env.memberCounts.route ?? 0),
                    0
                  )}
                  onChanged={(next) => {
                    if (next) setApp(next);
                    void refresh();
                  }}
                  onNewEnvironment={() => setNewEnvOpen(true)}
                  onCreateAccessCode={(environmentId) => void createAccessCode(environmentId)}
                />
              )}
            </TabsContent>
          )}
        </Tabs>
      </div>

      <AppCreateDialogs
        context={createContext}
        request={createRequest}
        onClose={() => setCreateRequest(null)}
        onCreated={() => void refresh()}
      />
      <ImportDialog
        app={app}
        request={importRequest}
        onClose={() => setImportRequest(null)}
        onImported={() => void refresh()}
      />
      <MoveToEnvironmentDialog
        app={app}
        member={moveEnvMember}
        onClose={() => setMoveEnvMember(null)}
        onMoved={() => void refresh()}
      />
      <MoveToAppDialog
        open={moveAppMember !== null}
        onOpenChange={(open) => {
          if (!open) setMoveAppMember(null);
        }}
        members={
          moveAppMember
            ? [
                {
                  type: moveAppMember.type,
                  id: moveAppMember.id,
                  nodeId: moveAppMember.nodeId ?? undefined,
                },
              ]
            : []
        }
        resourceLabel={moveAppMember?.name ?? ""}
        currentAppId={app.id}
        onMoved={() => void refresh()}
      />
      <NewEnvironmentDialog
        app={app}
        open={newEnvOpen}
        onOpenChange={setNewEnvOpen}
        onCreated={() => void refresh()}
      />
      <AccessCodeDialog value={accessCode} onClose={() => setAccessCode(null)} />
    </PageTransition>
  );
}
