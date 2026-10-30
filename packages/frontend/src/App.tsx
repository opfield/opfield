import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { AppStatusGate, clearMaintenanceAutoReloadGuard } from "@/components/common/AppStatusGate";
import { DetailPageSkeleton } from "@/components/common/DetailPageSkeleton";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { LeavePageRedirect } from "@/components/common/LeavePageRedirect";
import { RequireScope } from "@/components/common/RequireScope";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { ThemeProvider } from "@/components/layout/ThemeProvider";
import {
  LicenseFeatureBoundary,
  type LicenseFeatureFrame,
} from "@/components/license/LicenseFeatureBoundary";
import { Button } from "@/components/ui/button";
import { useGlobalSectionAccess } from "@/hooks/use-global-section-scopes";
import { usePkiAvailable, useSiemAvailable } from "@/hooks/use-plan-gated-features";
import { hasDashboardContent } from "@/lib/app-navigation";
import { getLoginRedirectUrl } from "@/lib/auth-return-to";
import { hasCreationDestination } from "@/lib/creation-folders";
import { resolveMigrationTarget } from "@/lib/docker-migration-navigation";
import { canAccessDockerSection } from "@/lib/docker-tabs";
import {
  hasLowInferenceUsage,
  INFERENCE_CATALOG_CHANGED_CHANNEL,
  INFERENCE_USAGE_CHANGED_CHANNEL,
  type InferenceUsageChangedEvent,
} from "@/lib/inference-self-usage";
import { canViewLoggingHealth } from "@/lib/logging-permissions";
import { NAVIGATION_HUBS } from "@/lib/navigation-hubs";
import {
  databaseRoute,
  dockerContainerRoute,
  dockerDeploymentRoute,
  dockerVolumeRoute,
  loggingEnvironmentRoute,
  loggingSchemaRoute,
  nodeRoute,
  proxyHostRoute,
  storageRoute,
} from "@/lib/resource-routes";
import { AccessSignInConfirm } from "@/pages/AccessSignInConfirm";
import { Administration } from "@/pages/Administration";
import { AdminNodeDetail } from "@/pages/AdminNodeDetail";
import { AdminNodes } from "@/pages/AdminNodes";
import { AIArtifactPopout } from "@/pages/AIArtifactPopout";
import { AppEnvironmentPage } from "@/pages/apps/AppEnvironmentPage";
import { AppPage } from "@/pages/apps/AppPage";
import { AppsList } from "@/pages/apps/AppsList";
import { BlockedPage } from "@/pages/Blocked";
import { CADetail } from "@/pages/CADetail";
import { CertificateDetail } from "@/pages/CertificateDetail";
import { Dashboard } from "@/pages/Dashboard";
import { DatabaseDetail } from "@/pages/DatabaseDetail";
import { Databases } from "@/pages/Databases";
import { Docker } from "@/pages/Docker";
import { DockerComposeLogsPopout } from "@/pages/DockerComposeLogsPopout";
import { DockerComposeProjectDetail } from "@/pages/DockerComposeProjectDetail";
import { DockerConsolePopout } from "@/pages/DockerConsolePopout";
import { DockerContainerDetail } from "@/pages/DockerContainerDetail";
import { DockerDeploymentDetail } from "@/pages/DockerDeploymentDetail";
import { DockerFilePopout } from "@/pages/DockerFilePopout";
import { DockerLogsPopout } from "@/pages/DockerLogsPopout";
import { DockerVolumeDetail } from "@/pages/DockerVolumeDetail";
import {
  DockerPendingContainerDetail,
  resolveContainerOrPendingSource,
} from "@/pages/docker-detail/DockerPendingContainerDetail";
import { HostingPage } from "@/pages/hosting/HostingPage";
import { IngressGroupDetail } from "@/pages/IngressGroupDetail";
import { Logging } from "@/pages/Logging";
import { LegacyNavigationRedirect, NavigationHubPage } from "@/pages/NavigationHubPage";
import { NginxTemplateEdit } from "@/pages/NginxTemplateEdit";
import { NodeConsolePopout } from "@/pages/NodeConsolePopout";
import { Notifications } from "@/pages/Notifications";
import { OAuthConsent } from "@/pages/OAuthConsent";
import { OAuthError } from "@/pages/OAuthError";
import { Profile } from "@/pages/Profile";
import { ProxyHostDetail } from "@/pages/ProxyHostDetail";
import { PageProjectDetail } from "@/pages/pages/PageProjectDetail";
import { Pages } from "@/pages/pages/Pages";
import { Settings } from "@/pages/Settings";
import { SetupWizardPage } from "@/pages/SetupWizard";
import { StatusPage } from "@/pages/StatusPage";
import { Storage } from "@/pages/Storage";
import { StorageDetail } from "@/pages/StorageDetail";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { eventStream } from "@/services/event-stream";
import { TOOL_STORE_INVALIDATION_CHANNEL_PREFIX } from "@/services/tool-store-invalidation";
import { useAIStore } from "@/stores/ai";
import {
  APP_STATUS_STORAGE_KEY,
  LEGACY_APP_STATUS_STORAGE_KEY,
  syncOpfieldOperationStatus,
  useAppStatusStore,
} from "@/stores/app-status";
import { accessContextKey, useAuthStore } from "@/stores/auth";
import { useDashboardBootstrapStore } from "@/stores/dashboard-bootstrap";
import { useDockerStore } from "@/stores/docker";
import { canServeLicenseFeature, usePlanIncludes } from "@/stores/license-paywall";
import { usePinnedContainersStore } from "@/stores/pinned-containers";
import { useResolvedPageRoute } from "@/stores/resolved-page-context";
import { useSystemConfigStore } from "@/stores/system-config";
import { syncAILiteModeFromStorageValue, UI_STORAGE_KEY, useUIStore } from "@/stores/ui";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import { useUpdateStore } from "@/stores/update";
import { AI_SCOPE, APPS_REALTIME_CHANNEL, type DockerMigration } from "@/types";
import { LEGACY_STORAGE_KEY_PREFIX } from "../../backend/src/lib/legacy-compat";

const REALTIME_RECONCILIATION_CACHE_PREFIXES = [
  "req:/api/ui/bootstrap",
  "dashboard:",
  "req:/api/monitoring/dashboard",
  "req:/api/monitoring/health-status",
  "req:/api/cas",
  "cas:list:",
  "req:/api/apps",
  "apps:",
  "req:/api/proxy-hosts",
  "req:/api/proxy-host-folders/grouped",
  "proxy:grouped",
  "req:/api/pages",
  "pages:",
  "req:/api/ssl-certificates",
  "ssl:list:",
  "req:/api/certificates",
  "certificates:list:",
  "req:/api/domains",
  "domains:list",
  "req:/api/templates",
  "templates:list",
  "req:/api/access-lists",
  "access-lists:list",
  "req:/api/nginx-templates",
  "nginx-templates:list",
  "req:/api/nodes",
  "nodes:list:",
  "req:/api/databases",
  "databases:list",
  "req:/api/logging",
  "logging:",
  "req:/api/admin/auth-settings",
  "settings:auth-provisioning",
  "req:/api/system/relay",
  "relay:",
  "req:/api/docker",
  "docker:",
  "settings:docker-registries",
  "req:/api/integrations",
  "settings:gitlab-connectors",
  "settings:cloudflare-connectors",
  "req:/api/housekeeping",
  "housekeeping:",
  "req:/api/system/license",
  "settings:license-status",
  "req:/api/status-page",
  "settings:status-page-",
  "req:/api/notifications",
  "notifications:",
  "req:/api/ai/config",
  "settings:ai-config",
  "req:/api/inference",
  "req:/api/system/version",
  "system:version",
  "req:/api/admin/users",
  "req:/api/admin/groups",
  "admin:",
  "req:/api/audit",
  "audit:",
] as const;

/** Helper to wrap a page element with a scope guard */
function scoped(scope: string, element: React.ReactElement) {
  return <RequireScope scope={scope}>{element}</RequireScope>;
}

function DashboardPageGuard() {
  const scopes = useAuthStore((state) => state.user?.scopes ?? []);
  const canOpenApps = useAuthStore(
    (state) => state.hasScopedAccess("apps:view") || state.hasScope("apps:create")
  );
  const features = useSystemConfigStore((state) => state.config.features);
  const uiBootstrap = useUIBootstrapStore((state) => state.snapshot);
  const dashboardBootstrap = useDashboardBootstrapStore((state) => state.snapshot);
  const pkiAvailable = usePkiAvailable();
  const siemAvailable = useSiemAvailable();
  const canAccess = hasDashboardContent({
    scopes,
    pkiEnabled: pkiAvailable,
    siemEnabled: siemAvailable,
    loggingEnabled: features.loggingEnabled,
    inferenceEnabled: features.inferenceEnabled,
    hasLowInferenceUsage: hasLowInferenceUsage(dashboardBootstrap?.inferenceUsage ?? null),
    statusPageEnabled: uiBootstrap?.navigation.statusPageEnabled ?? false,
    pagesEnabled: uiBootstrap?.navigation.pagesEnabled ?? false,
    hasCloudflareIntegration: uiBootstrap?.navigation.hasCloudflareIntegration ?? false,
    appOnlyScopeBases: uiBootstrap?.navigation.appOnlyScopeBases,
  });

  if (canAccess) return <Dashboard />;
  // A user limited to apps starts on Apps (global sections they reach only through apps redirect here).
  if (canOpenApps || uiBootstrap?.navigation.appsByMembers === true) {
    return <Navigate to="/apps" replace />;
  }
  return <Navigate to="/profile" replace />;
}

function AIWorkspaceRouteGuard() {
  const canUseAIWorkspace = useAuthStore((state) => state.hasScope(AI_SCOPE));
  return canUseAIWorkspace ? <Dashboard /> : <Navigate to="/profile" replace />;
}

function PopoutAuthGate({ children }: { children: React.ReactElement }) {
  const navigate = useNavigate();
  const loginRedirectUrl = useRef(getLoginRedirectUrl()).current;
  const { user, isLoading, setUser, setLoading, logout } = useAuthStore();

  useEffect(() => {
    let cancelled = false;

    if (user) {
      if (isLoading) setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);

    void api
      .getCurrentUser()
      .then((freshUser) => {
        if (cancelled) return;
        if (freshUser.isBlocked && !freshUser.impersonation?.active) {
          setUser(freshUser);
          navigate("/blocked", { replace: true });
          return;
        }
        setUser(freshUser);
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof ApiRequestError && error.status === 401) {
          logout();
          navigate(loginRedirectUrl, { replace: true });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isLoading, loginRedirectUrl, logout, navigate, setLoading, setUser, user]);

  if (isLoading && !user) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to={loginRedirectUrl} replace />;
  }

  return children;
}

function DetailRouteLoading() {
  return <DetailPageSkeleton label="Loading resource" />;
}

let authDocumentNavigationStarted = false;

function AuthDocumentRoute() {
  useEffect(() => {
    if (authDocumentNavigationStarted) return;
    authDocumentNavigationStarted = true;
    window.location.replace(window.location.href);
  }, []);

  return null;
}

function DetailRouteFailure({
  error,
  fallbackPath,
  preserveNotFound = false,
  unavailable,
}: {
  error: unknown;
  fallbackPath: string;
  preserveNotFound?: boolean;
  /** Say this on 403 / 404 (with a way back to the list) instead of silently opening the list. */
  unavailable?: { message: string; backLabel: string };
}) {
  if (
    error instanceof ApiRequestError &&
    (error.status === 403 || (error.status === 404 && !preserveNotFound))
  ) {
    // Deleted or hidden: back to where it was opened from (an app tab, a node...), else the list.
    if (!unavailable) return <LeavePageRedirect fallback={fallbackPath} />;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-muted-foreground">{unavailable.message}</p>
        <Button variant="outline" asChild>
          <Link to={fallbackPath}>{unavailable.backLabel}</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <p className="text-sm text-muted-foreground">Failed to load this resource.</p>
      <Button variant="outline" onClick={() => window.location.reload()}>
        Retry
      </Button>
    </div>
  );
}

function DockerContainerDetailGuard() {
  const { nodeSlug, containerName } = useParams<{ nodeSlug: string; containerName: string }>();
  const location = useLocation();
  const navigationMigration = (location.state as { dockerMigration?: DockerMigration } | null)
    ?.dockerMigration;
  const migrationHandoff =
    navigationMigration?.resourceType === "container" &&
    navigationMigration.targetNodeSlug === nodeSlug &&
    navigationMigration.resourceName === containerName
      ? navigationMigration
      : null;
  const canAccess = useAuthStore((s) => s.hasScopedAccess("docker:containers:view"));
  const resolved = useResolvedPageRoute(
    canAccess && nodeSlug && containerName
      ? dockerContainerRoute(nodeSlug, containerName)
      : undefined,
    () =>
      resolveMigrationTarget(!!migrationHandoff?.cutoverAt, async () => {
        const node = await api.getDockerNodeBySlug(nodeSlug!);
        const container = migrationHandoff?.targetResourceId
          ? await api.inspectContainer(node.id, migrationHandoff.targetResourceId, true)
          : await resolveContainerOrPendingSource(node.id, containerName!);
        const containerId = String((container as any).Id ?? (container as any).id ?? "");
        const canonicalName = String(
          (container as any).Name ?? (container as any).name ?? ""
        ).replace(/^\/+/, "");
        if (!containerId || !canonicalName) throw new Error("Container identity is missing");
        return { node, containerId, canonicalName, container };
      }),
    ({ node, containerId, canonicalName, container }) => ({
      resourceType: "docker-container",
      resourceId: containerId,
      nodeId: node.id,
      scopeResourceId: String((container as any).scopeResourceId ?? ""),
      label: canonicalName,
    })
  );

  if (!canAccess) return <Navigate to="/" replace />;
  if (resolved.loading) return <DetailRouteLoading />;
  if (resolved.error) {
    return (
      <DetailRouteFailure
        error={resolved.error}
        fallbackPath="/docker/containers"
        preserveNotFound={!!migrationHandoff}
        unavailable={{
          message: "This container does not exist or you have no access to it.",
          backLabel: "Open Docker",
        }}
      />
    );
  }
  if (!resolved.data) return <Navigate to="/docker/containers" replace />;
  if ((resolved.data.container as any).pendingSourceBuild)
    return (
      <DockerPendingContainerDetail
        key={`${resolved.data.node.id}:${resolved.data.canonicalName}`}
        nodeId={resolved.data.node.id}
        nodeSlug={resolved.data.node.slug}
        containerName={resolved.data.canonicalName}
        snapshot={resolved.data.container}
        pageContextToken={resolved.ownerToken}
      />
    );
  return (
    <DockerContainerDetail
      resolvedNodeId={resolved.data.node.id}
      resolvedNodeSlug={resolved.data.node.slug}
      resolvedContainerId={resolved.data.containerId}
      resolvedContainerName={resolved.data.canonicalName}
      resolvedContainer={resolved.data.container}
      pageContextToken={resolved.ownerToken}
    />
  );
}

function DockerDeploymentDetailGuard() {
  const { nodeSlug, deploymentName } = useParams<{ nodeSlug: string; deploymentName: string }>();
  const location = useLocation();
  const navigationMigration = (location.state as { dockerMigration?: DockerMigration } | null)
    ?.dockerMigration;
  const migrationHandoff =
    navigationMigration?.resourceType === "deployment" &&
    navigationMigration.targetNodeSlug === nodeSlug &&
    navigationMigration.resourceName === deploymentName
      ? navigationMigration
      : null;
  const canAccess = useAuthStore((s) => s.hasScopedAccess("docker:containers:view"));
  const resolved = useResolvedPageRoute(
    canAccess && nodeSlug && deploymentName
      ? dockerDeploymentRoute(nodeSlug, deploymentName)
      : undefined,
    () =>
      resolveMigrationTarget(!!migrationHandoff?.cutoverAt, async () => {
        const node = await api.getDockerNodeBySlug(nodeSlug!);
        const deployment = await api.getDockerDeploymentByName(node.id, deploymentName!);
        return { node, deployment };
      }),
    ({ node, deployment }) => ({
      resourceType: "docker-deployment",
      resourceId: deployment.id,
      nodeId: node.id,
      label: deployment.name,
    })
  );

  if (!canAccess) return <Navigate to="/" replace />;
  if (resolved.loading) return <DetailRouteLoading />;
  if (resolved.error) {
    return (
      <DetailRouteFailure
        error={resolved.error}
        fallbackPath="/docker/deployments"
        preserveNotFound={!!migrationHandoff}
      />
    );
  }
  if (!resolved.data) return <Navigate to="/docker/deployments" replace />;
  return (
    <DockerDeploymentDetail
      resolvedNodeId={resolved.data.node.id}
      resolvedNodeSlug={resolved.data.node.slug}
      resolvedDeploymentId={resolved.data.deployment.id}
      resolvedDeploymentName={resolved.data.deployment.name}
    />
  );
}

function DockerVolumeDetailGuard() {
  const { nodeSlug, volumeName } = useParams<{ nodeSlug: string; volumeName: string }>();
  const canAccess = useAuthStore((s) => s.hasScopedAccess("docker:volumes:view"));
  const resolved = useResolvedPageRoute(
    canAccess && nodeSlug && volumeName ? dockerVolumeRoute(nodeSlug, volumeName) : undefined,
    async () => {
      const node = await api.getDockerNodeBySlug(nodeSlug!);
      const volume = await api.resolveDockerVolumeByName(node.id, volumeName!);
      return { node, volume };
    },
    ({ node, volume }) => ({
      resourceType: "docker-volume",
      resourceId: volume.name,
      nodeId: node.id,
      label: volume.name,
    })
  );

  if (!canAccess) return <Navigate to="/" replace />;
  if (resolved.loading) return <DetailRouteLoading />;
  if (resolved.error) {
    return <DetailRouteFailure error={resolved.error} fallbackPath="/docker/volumes" />;
  }
  if (!resolved.data) return <Navigate to="/docker/volumes" replace />;
  return (
    <DockerVolumeDetail
      resolvedNodeId={resolved.data.node.id}
      resolvedNodeSlug={resolved.data.node.slug}
      resolvedVolumeName={resolved.data.volume.name}
    />
  );
}

const UUID_PATH_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ProxyHostDetailGuard() {
  const { proxySlug } = useParams<{ proxySlug: string }>();
  const canAccess = useAuthStore((s) => s.hasScopedAccess("proxy:view"));
  const resolved = useResolvedPageRoute(
    canAccess && proxySlug ? proxyHostRoute(proxySlug) : undefined,
    () =>
      UUID_PATH_SEGMENT_RE.test(proxySlug!)
        ? api.getProxyHost(proxySlug!)
        : api.getProxyHostBySlug(proxySlug!),
    (host) => ({
      resourceType: "proxy-host",
      resourceId: host.id,
      label: host.domainNames[0] || host.slug,
    })
  );

  if (!canAccess) return <Navigate to="/" replace />;
  if (resolved.loading) return <DetailRouteLoading />;
  if (resolved.error) {
    return <DetailRouteFailure error={resolved.error} fallbackPath="/routes" />;
  }
  if (!resolved.data) return <Navigate to="/routes" replace />;
  return (
    <ProxyHostDetail
      resolvedProxyHostId={resolved.data.id}
      resolvedProxySlug={resolved.data.slug}
    />
  );
}

const STATUS_PAGE_FRAME: LicenseFeatureFrame = {
  kind: "page",
  title: "Status Page",
  description: "Manage public services and incident communication",
};

const PAGES_FRAME: LicenseFeatureFrame = { kind: "page", title: "Pages" };

function PagesPageGuard() {
  const { hasScope, hasScopedAccess } = useGlobalSectionAccess();
  const license = useUIBootstrapStore((state) => state.snapshot?.license);
  const entitled = license ? license.entitlements.features.includes("pages") : null;
  if (
    !hasScopedAccess("pages:view") &&
    !hasScopedAccess("pages:create") &&
    !hasScope("pages:folders:manage")
  ) {
    return <Navigate to="/" replace />;
  }
  if (entitled === null) return null;
  return (
    <LicenseFeatureBoundary feature="pages" capability="Pages" frame={PAGES_FRAME}>
      <Pages />
    </LicenseFeatureBoundary>
  );
}

function PageProjectDetailGuard() {
  const { projectSlug } = useParams<{ projectSlug: string }>();
  const hasScopedAccess = useAuthStore((state) => state.hasScopedAccess);
  const license = useUIBootstrapStore((state) => state.snapshot?.license);
  const entitled = license ? license.entitlements.features.includes("pages") : null;
  const canAccess = hasScopedAccess("pages:view");
  const resolved = useResolvedPageRoute(
    canAccess && entitled === true && projectSlug ? `/pages/${projectSlug}` : undefined,
    () => api.getPageProjectBySlug(projectSlug!),
    (project) => ({
      resourceType: "page-project",
      resourceId: project.id,
      scopeResourceId: project.id,
      label: project.name,
    })
  );
  if (!canAccess) return <Navigate to="/" replace />;
  if (entitled === null) return null;
  if (!entitled) {
    return (
      <LicenseFeatureBoundary feature="pages" capability="Pages" frame={PAGES_FRAME}>
        {null}
      </LicenseFeatureBoundary>
    );
  }
  if (resolved.loading) return <DetailRouteLoading />;
  if (resolved.error) return <DetailRouteFailure error={resolved.error} fallbackPath="/pages" />;
  if (!resolved.data) return <Navigate to="/pages" replace />;
  return (
    <PageProjectDetail
      key={resolved.data.id}
      projectId={resolved.data.id}
      resolvedSlug={resolved.data.slug}
      initialProject={resolved.data}
    />
  );
}

function CADetailGuard() {
  const { id } = useParams<{ id: string }>();
  const hasScope = useAuthStore((s) => s.hasScope);
  const pkiEnabled = useSystemConfigStore((s) => s.config.features.pkiEnabled);
  const pkiAvailable = usePkiAvailable();

  if (!pkiEnabled || !id || !hasScope(`pki:ca:view:${id}`)) {
    return <Navigate to="/" replace />;
  }
  if (!pkiAvailable) return <PkiPlanNotice title="Certificate Authorities" />;

  return <CADetail />;
}

function CertificateDetailGuard() {
  const { id } = useParams<{ id: string }>();
  const hasScope = useAuthStore((s) => s.hasScope);
  const pkiEnabled = useSystemConfigStore((s) => s.config.features.pkiEnabled);
  const pkiAvailable = usePkiAvailable();

  if (!pkiEnabled || (!hasScope("pki:cert:view") && !(id && hasScope(`pki:cert:view:${id}`)))) {
    return <Navigate to="/" replace />;
  }
  if (!pkiAvailable) return <PkiPlanNotice title="Certificates" />;

  return <CertificateDetail />;
}

/** A PKI page the plan does not include: its header and the plan notice, no requests. */
function PkiPlanNotice({ title }: { title: string }) {
  return (
    <LicenseFeatureBoundary
      feature="internal-pki"
      capability="Internal PKI"
      frame={{ kind: "page", title }}
    >
      {null}
    </LicenseFeatureBoundary>
  );
}

function NginxTemplateEditGuard() {
  const { id } = useParams<{ id?: string }>();
  const hasScope = useAuthStore((s) => s.hasScope);

  const scopes = useAuthStore((s) => s.user?.scopes);
  // Same grants as the template write routes: manage broadly or on a folder creates, manage:<id> edits.
  if (id) {
    if (!hasScope(`proxy:templates:manage:${id}`)) {
      return <Navigate to="/" replace />;
    }
  } else if (!hasCreationDestination(scopes ?? [], "proxy:templates:manage")) {
    return <Navigate to="/" replace />;
  }

  return <NginxTemplateEdit />;
}

function NodeDetailGuard() {
  const { nodeSlug } = useParams<{ nodeSlug: string }>();
  const canAccess = useAuthStore((s) => s.hasScopedAccess("nodes:details"));
  const resolved = useResolvedPageRoute(
    canAccess && nodeSlug ? nodeRoute(nodeSlug) : undefined,
    () => api.getNodeBySlug(nodeSlug!),
    (node) => ({
      resourceType: "node",
      resourceId: node.id,
      label: node.displayName || node.hostname,
    })
  );

  if (!canAccess) return <Navigate to="/" replace />;
  if (resolved.loading) return <DetailRouteLoading />;
  if (resolved.error) return <DetailRouteFailure error={resolved.error} fallbackPath="/nodes" />;
  if (!resolved.data) return <Navigate to="/nodes" replace />;
  return (
    <AdminNodeDetail resolvedNodeId={resolved.data.id} resolvedNodeSlug={resolved.data.slug} />
  );
}

/** Ingress groups have their own permission (broadly or on the group's node folder); manage implies view. */
function IngressGroupsGuard({ children }: { children: React.ReactElement }) {
  const hasScopedAccess = useAuthStore((s) => s.hasScopedAccess);
  if (!hasScopedAccess("ingress:groups:view")) {
    return <Navigate to="/" replace />;
  }
  return children;
}

function NodesPageGuard() {
  const hasScope = useAuthStore((s) => s.hasScope);
  const hasScopedAccess = useAuthStore((s) => s.hasScopedAccess);

  if (!hasScopedAccess("nodes:details") && !hasScope("nodes:folders:manage")) {
    return <Navigate to="/" replace />;
  }

  return <AdminNodes />;
}

function DockerPageGuard() {
  const { scopes } = useGlobalSectionAccess();

  // The Docker page's own tab list (lib/docker-tabs), like the sidebar item.
  if (!canAccessDockerSection(scopes)) {
    return <Navigate to="/" replace />;
  }

  return <Docker />;
}

function DockerComposeDetailGuard() {
  const canAccess = useAuthStore((state) => state.hasScopedAccess("docker:compose:view"));
  return canAccess ? <DockerComposeProjectDetail /> : <Navigate to="/docker" replace />;
}

/** Member view scopes: an app is visible without apps:view when the user can view one of its members. */
const APP_MEMBER_VIEW_SCOPES = [
  "docker:containers:view",
  "docker:compose:view",
  "databases:view",
  "storage:view",
  "proxy:view",
  "pages:view",
] as const;

function AppsPageGuard({ children }: { children: React.ReactElement }) {
  const hasAppScope = useAuthStore(
    (s) => s.hasScopedAccess("apps:view") || s.hasScope("apps:create")
  );
  // Without app scopes, apps visible through members the user can view (UI bootstrap).
  const bootstrapSettled = useUIBootstrapStore((s) => s.snapshot !== null || s.error);
  const appsByMembers = useUIBootstrapStore((s) => s.snapshot?.navigation.appsByMembers === true);
  if (hasAppScope || appsByMembers) return children;
  if (!bootstrapSettled) return null;
  return <Navigate to="/" replace />;
}

function DatabasesPageGuard() {
  const { hasScope, hasScopedAccess } = useGlobalSectionAccess();

  // Create-only (for example folder-scoped) grants open the page so the user can create.
  const canAccessDatabases =
    hasScopedAccess("databases:view") ||
    hasScopedAccess("databases:create") ||
    hasScope("databases:folders:manage");

  if (!canAccessDatabases) {
    return <Navigate to="/" replace />;
  }

  return <Databases />;
}

function DatabaseDetailGuard() {
  const { databaseSlug } = useParams<{ databaseSlug: string }>();
  const canAccess = useAuthStore((s) => s.hasScopedAccess("databases:view"));
  // A plan without database connections shows the plan notice instead of resolving the slug.
  const servable = useUIBootstrapStore((s) =>
    canServeLicenseFeature(s.snapshot, "external-database-connections")
  );
  const resolved = useResolvedPageRoute(
    canAccess && servable && databaseSlug ? databaseRoute(databaseSlug) : undefined,
    () => api.getDatabaseBySlug(databaseSlug!),
    (database) => ({
      resourceType: "database",
      resourceId: database.id,
      label: database.name,
    })
  );

  if (!canAccess) return <Navigate to="/" replace />;
  if (!servable) return <DatabaseDetail />;
  if (resolved.loading) return <DetailRouteLoading />;
  if (resolved.error) {
    return <DetailRouteFailure error={resolved.error} fallbackPath="/databases" />;
  }
  if (!resolved.data) return <Navigate to="/databases" replace />;
  return (
    <DatabaseDetail
      resolvedDatabaseId={resolved.data.id}
      resolvedDatabaseSlug={resolved.data.slug}
    />
  );
}

function StoragePageGuard() {
  const { hasScope, hasScopedAccess } = useGlobalSectionAccess();

  const canAccessStorage =
    hasScopedAccess("storage:view") ||
    hasScopedAccess("storage:create") ||
    hasScope("storage:folders:manage");

  if (!canAccessStorage) {
    return <Navigate to="/" replace />;
  }

  return <Storage />;
}

function StorageDetailGuard() {
  const { storageSlug } = useParams<{ storageSlug: string }>();
  const canAccess = useAuthStore((s) => s.hasScopedAccess("storage:view"));
  // A plan without storage connections shows the plan notice instead of resolving the slug.
  const servable = useUIBootstrapStore((s) =>
    canServeLicenseFeature(s.snapshot, "storage-connections")
  );
  const resolved = useResolvedPageRoute(
    canAccess && servable && storageSlug ? storageRoute(storageSlug) : undefined,
    () => api.getObjectStorageBySlug(storageSlug!),
    (database) => ({
      resourceType: "storage",
      resourceId: database.id,
      label: database.name,
    })
  );

  if (!canAccess) return <Navigate to="/" replace />;
  if (!servable) return <StorageDetail />;
  if (resolved.loading) return <DetailRouteLoading />;
  if (resolved.error) {
    return <DetailRouteFailure error={resolved.error} fallbackPath="/storage" />;
  }
  if (!resolved.data) return <Navigate to="/storage" replace />;
  return (
    <StorageDetail resolvedStorageId={resolved.data.id} resolvedStorageSlug={resolved.data.slug} />
  );
}

export function NotificationsPageGuard() {
  const hasAnyScope = useAuthStore((s) => s.hasAnyScope);
  const hasScopedAccess = useAuthStore((s) => s.hasScopedAccess);
  const siemEnabled = useSystemConfigStore((s) => s.config.features.siemEnabled);

  // Rules and webhooks can be granted broadly, one by one, or by folder.
  const hasCoreNotificationAccess =
    hasScopedAccess("notifications:alerts:view") || hasScopedAccess("notifications:webhooks:view");
  const canAccessNotifications =
    hasCoreNotificationAccess ||
    (siemEnabled && hasAnyScope("audit:siem:view", "audit:siem:manage"));

  if (!canAccessNotifications) {
    return <Navigate to="/" replace />;
  }

  return <Notifications />;
}

function LoggingPageGuard({ detailType }: { detailType?: "environment" | "schema" } = {}) {
  const { environmentSlug, schemaSlug } = useParams<{
    environmentSlug?: string;
    schemaSlug?: string;
  }>();
  const id =
    detailType === "environment"
      ? environmentSlug
      : detailType === "schema"
        ? schemaSlug
        : undefined;
  const loggingEnabled = useSystemConfigStore((s) => s.config.features.loggingEnabled);
  const systemConfigLoaded = useSystemConfigStore((s) => s.loaded);
  const systemConfigLoading = useSystemConfigStore((s) => s.isLoading);
  const loadSystemConfig = useSystemConfigStore((s) => s.load);
  const [systemConfigLoadFailed, setSystemConfigLoadFailed] = useState(false);
  const hasScopedAccess = useAuthStore((s) => s.hasScopedAccess);
  // The section ignores grants held only through app places; a detail reached from an app keeps them.
  const globalAccess = useGlobalSectionAccess();
  const sectionAccess = detailType && id ? hasScopedAccess : globalAccess.hasScopedAccess;
  // Same rules as the logging list routes (resource, folder and create-only grants count).
  const canAccessLoggingEnvironments =
    sectionAccess("logs:environments:view") ||
    sectionAccess("logs:read") ||
    sectionAccess("logs:environments:create");
  const canAccessLoggingSchemaList =
    sectionAccess("logs:schemas:view") || sectionAccess("logs:schemas:create");
  const canAccessLogging = canAccessLoggingEnvironments || canAccessLoggingSchemaList;
  const isEnvironmentDetail = detailType === "environment" && !!id;
  const isSchemaDetail = detailType === "schema" && !!id;
  const canResolveDetail = isEnvironmentDetail
    ? hasScopedAccess("logs:environments:view") || hasScopedAccess("logs:read")
    : isSchemaDetail
      ? hasScopedAccess("logs:schemas:view")
      : false;
  const loggingInPlan = usePlanIncludes("structured-logging");
  const resolved = useResolvedPageRoute(
    systemConfigLoaded && loggingEnabled && loggingInPlan && canResolveDetail && id
      ? isEnvironmentDetail
        ? loggingEnvironmentRoute(id)
        : loggingSchemaRoute(id)
      : undefined,
    async () =>
      isEnvironmentDetail
        ? { kind: "environment" as const, value: await api.getLoggingEnvironmentBySlug(id!) }
        : { kind: "schema" as const, value: await api.getLoggingSchemaBySlug(id!) },
    (result) => ({
      resourceType: result.kind === "environment" ? "logging-environment" : "logging-schema",
      resourceId: result.value.id,
      label: result.value.name,
    })
  );

  useEffect(() => {
    if (!systemConfigLoaded && !systemConfigLoading && !systemConfigLoadFailed) {
      void loadSystemConfig().catch(() => setSystemConfigLoadFailed(true));
    }
  }, [loadSystemConfig, systemConfigLoaded, systemConfigLoadFailed, systemConfigLoading]);

  if (systemConfigLoadFailed) {
    return <Navigate to="/" replace />;
  }

  if (!systemConfigLoaded || systemConfigLoading) {
    return <DetailPageSkeleton label="Loading logging configuration" />;
  }

  if (
    !loggingEnabled ||
    !canAccessLogging ||
    ((isEnvironmentDetail || isSchemaDetail) && !canResolveDetail)
  ) {
    return <Navigate to="/" replace />;
  }

  if (!loggingInPlan) {
    return (
      <LicenseFeatureBoundary
        feature="structured-logging"
        capability="Structured logging"
        frame={{ kind: "page", title: "Logging" }}
      >
        {null}
      </LicenseFeatureBoundary>
    );
  }

  if ((isEnvironmentDetail || isSchemaDetail) && resolved.loading) return <DetailRouteLoading />;
  if ((isEnvironmentDetail || isSchemaDetail) && resolved.error) {
    return (
      <DetailRouteFailure
        error={resolved.error}
        fallbackPath={isEnvironmentDetail ? "/logging/environments" : "/logging/schemas"}
      />
    );
  }
  if ((isEnvironmentDetail || isSchemaDetail) && !resolved.data) {
    return (
      <Navigate to={isEnvironmentDetail ? "/logging/environments" : "/logging/schemas"} replace />
    );
  }

  return (
    <Logging
      resolvedResourceId={resolved.data?.value.id}
      resolvedResourceSlug={resolved.data?.value.slug}
      resolvedSection={
        isEnvironmentDetail ? "environments" : isSchemaDetail ? "schemas" : undefined
      }
    />
  );
}

function AdministrationPageGuard() {
  const hasScopedAccess = useAuthStore((s) => s.hasScopedAccess);

  if (!["admin:audit", "admin:users", "admin:groups"].some(hasScopedAccess)) {
    return <Navigate to="/" replace />;
  }

  return <Administration />;
}

export function RealtimeBridge() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const user = useAuthStore((s) => s.user);
  const preferenceContextKey = accessContextKey(useAuthStore.getState());
  const setUser = useAuthStore((s) => s.setUser);
  const logout = useAuthStore((s) => s.logout);
  const canListNodes = useAuthStore((s) => s.hasScopedAccess("nodes:details"));
  // Apps seen only through members: membership changes can show or hide the Apps section.
  const seesAppsThroughMembers = useAuthStore(
    (s) =>
      !s.hasScopedAccess("apps:view") &&
      !s.hasScope("apps:create") &&
      APP_MEMBER_VIEW_SCOPES.some((scope) => s.hasScopedAccess(scope))
  );
  const canReceiveNodeSlug = useAuthStore(
    (s) =>
      s.hasScopedAccess("nodes:details") ||
      s.hasScopedAccess("docker:containers:view") ||
      s.hasScopedAccess("docker:images:view") ||
      s.hasScopedAccess("docker:volumes:view") ||
      s.hasScopedAccess("docker:networks:view")
  );
  const canViewProxy = useAuthStore((s) => s.hasScopedAccess("proxy:view"));
  const canViewDatabases = useAuthStore((s) => s.hasScopedAccess("databases:view"));
  const canViewStorage = useAuthStore((s) => s.hasScopedAccess("storage:view"));
  const canViewDockerContainers = useAuthStore((s) => s.hasScopedAccess("docker:containers:view"));
  const canViewPkiCertificates = useAuthStore((s) => s.hasScopedAccess("pki:cert:view"));
  const canViewSslCertificates = useAuthStore((s) => s.hasScopedAccess("ssl:cert:view"));
  const canViewCAs = useAuthStore((s) => s.hasScopedAccess("pki:ca:view"));
  const canUseAIWorkspace = useAuthStore((s) => s.hasScope(AI_SCOPE));
  const canUseInference = useAuthStore((s) => s.hasScope("feat:ai:use"));
  const canViewLogging = useAuthStore((s) => canViewLoggingHealth(s.user?.scopes ?? []));
  const canViewAudit = useAuthStore((s) => s.hasScopedAccess("admin:audit"));
  const invalidateDashboardBootstrap = useDashboardBootstrapStore((s) => s.invalidate);
  const invalidateUIBootstrap = useUIBootstrapStore((s) => s.invalidate);
  const refreshAIProviderStatus = useAIStore((s) => s.refreshProviderStatus);
  const setOpfieldUpdatingActive = useAppStatusStore((s) => s.setOpfieldUpdatingActive);
  const clearOpfieldUpdating = useAppStatusStore((s) => s.clearOpfieldUpdating);
  const hydrateAIApprovalMode = useUIStore((s) => s.hydrateAIApprovalMode);
  const beginInterfacePreferenceLoad = useUIStore((s) => s.beginInterfacePreferenceLoad);
  const hydratePreferredInterface = useUIStore((s) => s.hydratePreferredInterface);

  // EventStream owns invalidation; retain these subscriptions for the whole
  // session so warmed projections stay coherent even with no matching route mounted.
  useEffect(() => {
    if (!user) return;
    const toolInvalidationChannel = `${TOOL_STORE_INVALIDATION_CHANNEL_PREFIX}${user.id}`;
    const auth = useAuthStore.getState();
    const canViewAnyDockerSnapshot = [
      "docker:containers:view",
      "docker:images:view",
      "docker:volumes:view",
      "docker:networks:view",
    ].some((scope) => auth.hasScopedAccess(scope));
    const channels: Array<[boolean, string]> = [
      [true, toolInvalidationChannel],
      [auth.hasScopedAccess("domains:view"), "domain.changed"],
      [auth.hasScope("pki:templates:view"), "pki.template.changed"],
      [auth.hasScopedAccess("proxy:templates:view"), "nginx.template.changed"],
      [auth.hasScopedAccess("acl:view"), "access-list.changed"],
      [
        auth.hasScopedAccess("acl:view") || auth.hasScopedAccess("acl:folders:manage"),
        "access-list.folder.changed",
      ],
      [
        auth.hasScopedAccess("nodes:details") || auth.hasScope("nodes:folders:manage"),
        "node.folder.changed",
      ],
      [
        auth.hasScopedAccess("databases:view") || auth.hasScope("databases:folders:manage"),
        "database.folder.changed",
      ],
      [auth.hasScopedAccess("logs:environments:view"), "logging.environment.changed"],
      [auth.hasScopedAccess("logs:schemas:view"), "logging.schema.changed"],
      [canViewAnyDockerSnapshot, "docker.snapshot.changed"],
      [canViewAnyDockerSnapshot, "docker.folder.changed"],
      [auth.hasScopedAccess("docker:images:view"), "docker.image.changed"],
      [auth.hasScopedAccess("docker:volumes:view"), "docker.volume.changed"],
      [auth.hasScopedAccess("docker:networks:view"), "docker.network.changed"],
      [auth.hasScopedAccess("docker:tasks"), "docker.task.changed"],
      [auth.hasScopedAccess("docker:registries:view"), "docker.registry.changed"],
      [
        auth.hasScopedAccess("docker:containers:view") ||
          auth.hasScopedAccess("docker:compose:view"),
        "docker.build.changed",
      ],
      [
        auth.hasScopedAccess("docker:containers:view") ||
          auth.hasScopedAccess("docker:compose:view"),
        "docker.build.artifact.changed",
      ],
      [
        auth.hasScopedAccess("docker:containers:view") ||
          auth.hasScopedAccess("docker:compose:view"),
        "docker.build.log",
      ],
      [canViewLoggingHealth(auth.user?.scopes ?? []), "logging.health.changed"],
      [auth.hasScope("housekeeping:view"), "system.relay.health.changed"],
      [auth.hasScope("status-page:view"), "status-page.changed"],
      [auth.hasScopedAccess("notifications:alerts:view"), "notification.alert-rule.changed"],
      [
        auth.hasScopedAccess("notifications:alerts:view") ||
          auth.hasScopedAccess("notifications:alerts:folders:manage"),
        "notification.alert-rule.folder.changed",
      ],
      [auth.hasScopedAccess("notifications:webhooks:view"), "notification.webhook.changed"],
      [
        auth.hasScopedAccess("notifications:webhooks:view") ||
          auth.hasScopedAccess("notifications:webhooks:folders:manage"),
        "notification.webhook.folder.changed",
      ],
      [auth.hasScopedAccess("admin:users"), "user.changed"],
      [auth.hasScopedAccess("admin:groups"), "group.changed"],
      [auth.hasScopedAccess("admin:audit"), "audit.changed"],
      [auth.hasScopedAccess("admin:audit"), "siem.destination.changed"],
      [auth.hasScopedAccess("admin:audit"), "siem.delivery.changed"],
      [
        auth.hasAnyScope(
          AI_SCOPE,
          "feat:ai:use",
          "inference:providers:view",
          "inference:models:manage",
          "inference:limits:manage",
          "feat:ai:configure"
        ),
        INFERENCE_CATALOG_CHANGED_CHANNEL,
      ],
    ];
    const unsubscribe = channels
      .filter(([allowed]) => allowed)
      .map(([, channel]) => eventStream.subscribe(channel, () => {}));
    return () => unsubscribe.forEach((stop) => stop());
  }, [user]);

  useEffect(() => {
    if (isAuthenticated) {
      eventStream.start();
      return () => eventStream.stop();
    }
    return;
  }, [isAuthenticated]);

  // Revalidate for every access context, keeping the same user's loaded interface visible.
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    const isCurrentContext = () =>
      !cancelled && accessContextKey(useAuthStore.getState()) === preferenceContextKey;
    if (!useUIStore.getState().interfacePreferenceLoaded) beginInterfacePreferenceLoad();
    void api
      .getUserPreferences()
      .then((preferences) => {
        if (!isCurrentContext()) return;
        const ui = useUIStore.getState();
        if (!ui.aiApprovalModeLoaded) hydrateAIApprovalMode(preferences.aiApprovalMode);
        if (!ui.interfacePreferenceLoaded)
          hydratePreferredInterface(preferences.preferredInterface);
      })
      .catch(() => {
        if (isCurrentContext() && !useUIStore.getState().interfacePreferenceLoaded)
          hydratePreferredInterface(null);
      });
    return () => {
      cancelled = true;
    };
  }, [
    beginInterfacePreferenceLoad,
    hydrateAIApprovalMode,
    hydratePreferredInterface,
    preferenceContextKey,
    user?.id,
  ]);

  // Live permission updates: refresh the local user (and thus scopes) whenever
  // the server says this user's permissions changed.
  useEffect(() => {
    if (!user?.id) return;
    return eventStream.subscribe(`permissions.changed.${user.id}`, async () => {
      try {
        const freshUser = await api.getCurrentUser();
        setUser(freshUser);
      } catch {
        logout();
      }
    });
  }, [logout, setUser, user?.id]);

  // This bridge is mounted for the whole authenticated session. Dashboard and Sidebar can
  // therefore safely share a snapshot without relying on either route being mounted when
  // an event arrives.
  useEffect(() => {
    if (!user || (!canListNodes && !canReceiveNodeSlug)) return;
    return eventStream.subscribe("node.changed", () => {
      invalidateDashboardBootstrap();
      invalidateUIBootstrap();
    });
  }, [user, canListNodes, canReceiveNodeSlug, invalidateDashboardBootstrap, invalidateUIBootstrap]);

  useEffect(() => {
    if (!user || !seesAppsThroughMembers) return;
    return eventStream.subscribe(APPS_REALTIME_CHANNEL, () => invalidateUIBootstrap());
  }, [user, seesAppsThroughMembers, invalidateUIBootstrap]);

  useEffect(() => {
    if (!user || !canReceiveNodeSlug) return;
    return eventStream.subscribe("node.slug.changed", (payload) => {
      const event = payload as { id?: string; slug?: string };
      if (!event.id || !event.slug) return;
      useDockerStore.getState().syncNodeAppearance({ id: event.id, slug: event.slug });
      const pinned = usePinnedContainersStore.getState();
      for (const [containerId, meta] of Object.entries(pinned.containerMeta)) {
        if (meta.nodeId === event.id && meta.nodeSlug !== event.slug) {
          pinned.updateMeta(containerId, { ...meta, nodeSlug: event.slug });
        }
      }
      invalidateDashboardBootstrap();
      invalidateUIBootstrap();
    });
  }, [canReceiveNodeSlug, invalidateDashboardBootstrap, invalidateUIBootstrap, user]);

  useEffect(() => {
    if (!user?.id) return;
    return eventStream.subscribe(`mfa.required.${user.id}`, invalidateDashboardBootstrap);
  }, [invalidateDashboardBootstrap, user?.id]);

  useEffect(() => {
    if (!user || !canViewProxy) return;
    return eventStream.subscribe("proxy.host.changed", (payload) => {
      if ((payload as { action?: string } | null)?.action === "health.sampled") return;
      invalidateDashboardBootstrap();
    });
  }, [canViewProxy, invalidateDashboardBootstrap, user]);

  useEffect(() => {
    if (!user || (!canViewDatabases && !canViewStorage)) return;
    const channels = [
      ...(canViewDatabases ? ["database.changed"] : []),
      ...(canViewStorage ? ["storage.changed", "managed-storage.changed"] : []),
    ];
    const subscriptions = channels.map((channel) =>
      eventStream.subscribe(channel, (payload) => {
        if ((payload as { action?: string } | null)?.action === "health.sampled") return;
        invalidateDashboardBootstrap();
      })
    );
    return () => subscriptions.forEach((unsubscribe) => unsubscribe());
  }, [canViewDatabases, canViewStorage, invalidateDashboardBootstrap, user]);

  useEffect(() => {
    if (!user || !canViewDockerContainers) return;
    const unsubscribe = [
      "docker.container.changed",
      "docker.deployment.changed",
      "docker.health.changed",
      "docker.availability.changed",
      "docker.availability.operation.changed",
    ].map((channel) => eventStream.subscribe(channel, invalidateDashboardBootstrap));
    return () => unsubscribe.forEach((dispose) => dispose());
  }, [canViewDockerContainers, invalidateDashboardBootstrap, user]);

  useEffect(() => {
    if (!user || !canViewPkiCertificates) return;
    return eventStream.subscribe("cert.changed", invalidateDashboardBootstrap);
  }, [canViewPkiCertificates, invalidateDashboardBootstrap, user]);

  useEffect(() => {
    if (!user || !canViewSslCertificates) return;
    return eventStream.subscribe("ssl.cert.changed", invalidateDashboardBootstrap);
  }, [canViewSslCertificates, invalidateDashboardBootstrap, user]);

  useEffect(() => {
    if (!user || !canViewCAs) return;
    return eventStream.subscribe("ca.changed", invalidateDashboardBootstrap);
  }, [canViewCAs, invalidateDashboardBootstrap, user]);

  useEffect(() => {
    if (!user || (!canUseAIWorkspace && !canUseInference)) return;
    return eventStream.subscribe(INFERENCE_USAGE_CHANGED_CHANNEL, (payload) => {
      const event = payload as InferenceUsageChangedEvent;
      // Settlements already refresh quota consumers. A policy change also changes
      // whether AI Assistant is available, so update its session-wide status now.
      if (event.reason === "limits") void refreshAIProviderStatus().catch(() => {});
      invalidateDashboardBootstrap();
    });
  }, [
    canUseAIWorkspace,
    canUseInference,
    invalidateDashboardBootstrap,
    refreshAIProviderStatus,
    user,
  ]);

  useEffect(() => {
    if (!user || !canViewLogging) return;
    return eventStream.subscribe("logging.health.changed", invalidateDashboardBootstrap);
  }, [canViewLogging, invalidateDashboardBootstrap, user]);

  useEffect(() => {
    if (!user || !canViewAudit) return;
    return eventStream.subscribe("audit.changed", invalidateDashboardBootstrap);
  }, [canViewAudit, invalidateDashboardBootstrap, user]);

  useEffect(() => {
    if (!user) return;
    return eventStream.subscribe("system.relay.health.changed", invalidateDashboardBootstrap);
  }, [invalidateDashboardBootstrap, user]);

  // Feature flags and limits drive permission-authorized shell geometry. The
  // event carries no settings; reload the typed bootstrap atomically instead.
  useEffect(() => {
    if (!user) return;
    return eventStream.subscribe("system.config.changed", invalidateUIBootstrap);
  }, [invalidateUIBootstrap, user]);

  useEffect(() => {
    if (!user) return;
    return eventStream.subscribe("system.license.changed", invalidateUIBootstrap);
  }, [invalidateUIBootstrap, user]);

  useEffect(() => {
    if (!user) return;
    return eventStream.subscribe("integration.connector.changed", invalidateUIBootstrap);
  }, [invalidateUIBootstrap, user]);

  useEffect(() => {
    if (!user?.scopes.includes("pages:settings:view")) return;
    return eventStream.subscribe("pages.profile.changed", invalidateUIBootstrap);
  }, [invalidateUIBootstrap, user]);

  useEffect(() => {
    if (
      !user?.scopes.some(
        (scope) => scope === "status-page:view" || scope.startsWith("status-page:view:")
      )
    ) {
      return;
    }
    // The dashboard snapshot carries the Status Page sidebar dot for active incidents.
    const unsubscribe = [invalidateUIBootstrap, invalidateDashboardBootstrap].map((invalidate) =>
      eventStream.subscribe("status-page.changed", invalidate)
    );
    return () => unsubscribe.forEach((dispose) => dispose());
  }, [invalidateDashboardBootstrap, invalidateUIBootstrap, user]);

  useEffect(() => {
    if (!user) return;
    return eventStream.subscribe("system.update.changed", (payload) => {
      const ev = payload as
        | {
            updating?: boolean;
            component?: "opfield" | "relay";
            targetVersion?: string | null;
            statusChanged?: boolean;
            /** Why an Opfield update ended without reaching its target. */
            error?: string;
            rolledBack?: boolean;
          }
        | undefined;
      if (typeof ev?.updating === "boolean") {
        if (ev.component === "relay") {
          useUpdateStore.getState().setUpdating("relay", ev.updating, ev.targetVersion ?? null);
          void useUpdateStore.getState().fetchStatus();
        } else if (ev.updating) {
          useUpdateStore.getState().setUpdating("opfield", true);
          setOpfieldUpdatingActive(true, ev.targetVersion ?? null);
        } else {
          useUpdateStore.getState().clearUpdating();
          const appStatus = useAppStatusStore.getState();
          if (ev.error && appStatus.opfieldUpdatingActive) {
            // Sessions waiting for the update leave its screen with the reason.
            appStatus.setOpfieldUpdateError(ev.error, ev.targetVersion ?? null, {
              rolledBack: ev.rolledBack === true,
            });
          } else {
            clearOpfieldUpdating();
          }
        }
      }
      if (ev?.statusChanged) void useUpdateStore.getState().fetchStatus();
      invalidateDashboardBootstrap();
      invalidateUIBootstrap();
    });
  }, [
    clearOpfieldUpdating,
    invalidateDashboardBootstrap,
    invalidateUIBootstrap,
    user,
    setOpfieldUpdatingActive,
  ]);

  useEffect(() => {
    if (!user) return;
    return eventStream.subscribe("read-model.refreshed", (payload) => {
      const id = (payload as { id?: string } | null)?.id;
      if (id?.startsWith("dashboard-source:")) invalidateDashboardBootstrap();
      if (id?.startsWith("ui-shell:")) invalidateUIBootstrap();
    });
  }, [invalidateDashboardBootstrap, invalidateUIBootstrap, user]);

  useEffect(() => {
    if (!user) return;
    const unsubscribe = eventStream.onReconnect(() => {
      // Reconnect means events may have been missed. Invalidate the warmed
      // projections, then refresh the two shared snapshots that are already
      // mounted. Route data is fetched only when its route is visited again.
      for (const prefix of REALTIME_RECONCILIATION_CACHE_PREFIXES) {
        api.invalidateCache(prefix);
      }
      invalidateDashboardBootstrap();
      invalidateUIBootstrap();
    });
    return unsubscribe;
  }, [invalidateDashboardBootstrap, invalidateUIBootstrap, user]);

  return null;
}

function OpfieldApp() {
  const [startupChecked, setStartupChecked] = useState(false);
  const [setupPending, setSetupPending] = useState(false);
  const user = useAuthStore((s) => s.user);
  const maintenanceActive = useAppStatusStore((s) => s.maintenanceActive);
  const setMaintenanceActive = useAppStatusStore((s) => s.setMaintenanceActive);
  const setOpfieldRestartingActive = useAppStatusStore((s) => s.setOpfieldRestartingActive);
  const clearOpfieldRestarting = useAppStatusStore((s) => s.clearOpfieldRestarting);
  // Keep navigation/chrome mounted for scope changes. DashboardLayout fences its protected content separately.
  const authRouteKey = user ? `${user.id}:${user.isBlocked ? "blocked" : "active"}` : "anonymous";

  useEffect(() => {
    if (maintenanceActive) return;
    const timer = window.setTimeout(clearMaintenanceAutoReloadGuard, 60_000);
    return () => window.clearTimeout(timer);
  }, [maintenanceActive]);

  useEffect(() => {
    // legacy-name: auth key old releases wrote, removed on load — remove once 2.12.0 is no longer an update source
    localStorage.removeItem(`${LEGACY_STORAGE_KEY_PREFIX}-auth`);

    let cancelled = false;

    const checkHealth = async () => {
      try {
        const [response, setupResponse] = await Promise.all([
          fetch("/health", {
            cache: "no-store",
            headers: { "X-Opfield-Health-Probe": "startup" },
          }),
          fetch("/api/setup/status", { cache: "no-store", credentials: "include" }),
        ]);
        const setup = setupResponse.ok
          ? ((await setupResponse.json()) as { data?: { state?: string } })
          : null;
        const health = response.ok
          ? ((await response.json()) as { lifecycleState?: string })
          : null;
        if (!cancelled) {
          setMaintenanceActive(!response.ok);
          if (health?.lifecycleState && health.lifecycleState !== "running") {
            setOpfieldRestartingActive(true);
          } else if (health?.lifecycleState === "running") {
            clearOpfieldRestarting();
          }
          setSetupPending(setup?.data?.state === "pending");
          setStartupChecked(true);
        }
      } catch {
        if (!cancelled) {
          setMaintenanceActive(true);
          setStartupChecked(true);
        }
      }
    };

    void checkHealth();

    return () => {
      cancelled = true;
    };
  }, [clearOpfieldRestarting, setOpfieldRestartingActive, setMaintenanceActive]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === UI_STORAGE_KEY) {
        syncAILiteModeFromStorageValue(event.newValue);
        return;
      }

      if (
        (event.key !== APP_STATUS_STORAGE_KEY && event.key !== LEGACY_APP_STATUS_STORAGE_KEY) ||
        event.newValue == null
      ) {
        return;
      }

      try {
        const parsed = JSON.parse(event.newValue) as {
          state?: {
            opfieldUpdatingActive?: boolean;
            opfieldUpdatingTargetVersion?: string | null;
            opfieldRestartingActive?: boolean;
            opfieldRestartTargetUrl?: string | null;
          };
        };
        const opfieldUpdatingActive = parsed.state?.opfieldUpdatingActive === true;
        const opfieldRestartingActive =
          !opfieldUpdatingActive && parsed.state?.opfieldRestartingActive === true;
        syncOpfieldOperationStatus({
          opfieldUpdatingActive,
          opfieldUpdatingTargetVersion: opfieldUpdatingActive
            ? (parsed.state?.opfieldUpdatingTargetVersion ?? null)
            : null,
          opfieldRestartingActive,
          opfieldRestartTargetUrl: opfieldRestartingActive
            ? (parsed.state?.opfieldRestartTargetUrl ?? null)
            : null,
        });
      } catch {
        // Ignore malformed storage updates.
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  if (!startupChecked) {
    return (
      <ThemeProvider>
        <div className="h-screen bg-background" aria-busy="true" aria-label="Loading application" />
      </ThemeProvider>
    );
  }

  if (maintenanceActive) {
    return (
      <ErrorBoundary>
        <ThemeProvider>
          <AppStatusGate />
        </ThemeProvider>
      </ErrorBoundary>
    );
  }

  if (setupPending) {
    return (
      <ErrorBoundary>
        <ThemeProvider>
          <SetupWizardPage />
        </ThemeProvider>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <RealtimeBridge />
        <AppStatusGate />
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<AuthDocumentRoute />} />
            <Route path="/reset-password" element={<AuthDocumentRoute />} />
            <Route path="/callback" element={<AuthDocumentRoute />} />
            <Route path="/oauth/consent" element={<OAuthConsent />} />
            <Route path="/access-sign-in/confirm" element={<AccessSignInConfirm />} />
            <Route path="/oauth/error" element={<OAuthError />} />
            <Route path="/blocked" element={<BlockedPage />} />
            <Route
              path="/docker/console/:nodeId/:containerId"
              element={
                <PopoutAuthGate>
                  <DockerConsolePopout />
                </PopoutAuthGate>
              }
            />
            <Route
              path="/docker/logs/:nodeId/:containerId"
              element={
                <PopoutAuthGate>
                  <DockerLogsPopout />
                </PopoutAuthGate>
              }
            />
            <Route
              path="/storage/file/:storageId"
              element={
                <PopoutAuthGate>
                  <DockerFilePopout />
                </PopoutAuthGate>
              }
            />
            <Route
              path="/docker/file/:nodeId/:containerId"
              element={
                <PopoutAuthGate>
                  <DockerFilePopout />
                </PopoutAuthGate>
              }
            />
            <Route
              path="/docker/volume-file/:nodeId/:volumeName"
              element={
                <PopoutAuthGate>
                  <DockerFilePopout />
                </PopoutAuthGate>
              }
            />
            <Route
              path="/nodes/file/:nodeId"
              element={
                <PopoutAuthGate>
                  <DockerFilePopout />
                </PopoutAuthGate>
              }
            />
            <Route
              path="/ai/artifact/:artifactId"
              element={
                <PopoutAuthGate>
                  <AIArtifactPopout />
                </PopoutAuthGate>
              }
            />
            <Route
              path="/docker/compose-logs/:nodeId/:project"
              element={
                <PopoutAuthGate>
                  <DockerComposeLogsPopout />
                </PopoutAuthGate>
              }
            />
            <Route
              path="/nodes/console/:nodeId"
              element={
                <PopoutAuthGate>
                  <NodeConsolePopout />
                </PopoutAuthGate>
              }
            />
            <Route element={<DashboardLayout key={authRouteKey} />}>
              <Route path="/" element={<DashboardPageGuard />} />
              <Route path="/ai/chats/:conversationId" element={<AIWorkspaceRouteGuard />} />
              <Route path="/dashboard" element={<DashboardPageGuard />} />
              <Route
                path="/apps"
                element={
                  <AppsPageGuard>
                    <AppsList />
                  </AppsPageGuard>
                }
              />
              <Route
                path="/apps/:appSlug/env/:envSlug"
                element={
                  <AppsPageGuard>
                    <AppEnvironmentPage />
                  </AppsPageGuard>
                }
              />
              <Route
                path="/apps/:appSlug/:tab?"
                element={
                  <AppsPageGuard>
                    <AppPage />
                  </AppsPageGuard>
                }
              />
              {NAVIGATION_HUBS.flatMap((hub) =>
                hub.tabs.map((tab) => (
                  <Route
                    key={tab.path}
                    path={tab.path}
                    element={<NavigationHubPage hubId={hub.id} tab={tab.value} />}
                  />
                ))
              )}
              <Route
                path="/routes/new"
                element={<NavigationHubPage hubId="routes" tab="routes" create />}
              />
              <Route path="/proxy-hosts" element={<LegacyNavigationRedirect />} />
              <Route path="/proxy-hosts/new" element={<LegacyNavigationRedirect />} />
              <Route path="/proxy-hosts/:proxySlug/:tab?" element={<ProxyHostDetailGuard />} />
              <Route path="/pages/:projectSlug/:tab?" element={<PageProjectDetailGuard />} />
              <Route path="/pages" element={<PagesPageGuard />} />
              <Route path="/nginx-templates/new" element={<NginxTemplateEditGuard />} />
              <Route path="/nginx-templates/:id" element={<NginxTemplateEditGuard />} />
              <Route path="/ssl-certificates/*" element={<LegacyNavigationRedirect />} />
              <Route path="/domains/*" element={<LegacyNavigationRedirect />} />
              <Route path="/ingress-groups" element={<LegacyNavigationRedirect />} />
              <Route
                path="/ingress-groups/:groupId"
                element={
                  <IngressGroupsGuard>
                    <IngressGroupDetail />
                  </IngressGroupsGuard>
                }
              />
              <Route path="/access-lists/*" element={<LegacyNavigationRedirect />} />
              <Route path="/cas" element={<LegacyNavigationRedirect />} />
              <Route path="/cas/:id" element={<CADetailGuard />} />
              <Route path="/certificates/:id" element={<CertificateDetailGuard />} />
              <Route path="/templates/*" element={<LegacyNavigationRedirect />} />
              <Route path="/administration" element={<AdministrationPageGuard />} />
              <Route path="/administration/:tab" element={<AdministrationPageGuard />} />
              <Route
                path="/audit"
                element={scoped("admin:audit", <Navigate to="/administration/audit" replace />)}
              />
              <Route path="/notifications/:tab?" element={<NotificationsPageGuard />} />
              <Route
                path="/status-page/:tab?"
                element={scoped(
                  "status-page:view",
                  <LicenseFeatureBoundary
                    feature="status-pages"
                    capability="Status Page"
                    frame={STATUS_PAGE_FRAME}
                  >
                    <StatusPage />
                  </LicenseFeatureBoundary>
                )}
              />
              <Route path="/databases" element={<DatabasesPageGuard />} />
              <Route path="/storage" element={<StoragePageGuard />} />
              <Route path="/storage/:storageSlug/:tab?" element={<StorageDetailGuard />} />
              <Route path="/databases/:databaseSlug/:tab?" element={<DatabaseDetailGuard />} />
              <Route path="/logging" element={<LoggingPageGuard />} />
              <Route path="/logging/:section" element={<LoggingPageGuard />} />
              <Route
                path="/logging/environments/:environmentSlug/:tab?"
                element={<LoggingPageGuard detailType="environment" />}
              />
              <Route
                path="/logging/schemas/:schemaSlug/:tab?"
                element={<LoggingPageGuard detailType="schema" />}
              />
              <Route path="/profile/:tab?" element={<Profile />} />
              <Route path="/settings/:tab?" element={<Settings />} />
              <Route
                path="/admin/users"
                element={scoped("admin:users", <Navigate to="/administration/users" replace />)}
              />
              <Route
                path="/admin/groups"
                element={scoped("admin:groups", <Navigate to="/administration/groups" replace />)}
              />
              <Route path="/nodes" element={<NodesPageGuard />} />
              <Route path="/hosting/:connectorId/:tab?" element={<HostingPage />} />
              <Route path="/nodes/:nodeSlug/:tab?" element={<NodeDetailGuard />} />
              <Route
                path="/docker/compose/new"
                element={<Navigate to="/docker/compose" replace />}
              />
              <Route
                path="/docker/compose/:projectId/:tab?"
                element={<DockerComposeDetailGuard />}
              />
              <Route path="/docker/:tab?" element={<DockerPageGuard />} />
              <Route
                path="/docker/containers/:nodeSlug/:containerName/:tab?"
                element={<DockerContainerDetailGuard />}
              />
              <Route
                path="/docker/deployments/:nodeSlug/:deploymentName/:tab?"
                element={<DockerDeploymentDetailGuard />}
              />
              <Route
                path="/docker/volumes/:nodeSlug/:volumeName/:tab?"
                element={<DockerVolumeDetailGuard />}
              />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default function App() {
  return <OpfieldApp />;
}
