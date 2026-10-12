import {
  Archive,
  ArrowRight,
  Code2,
  Copy,
  Loader2,
  Pin,
  Play,
  RotateCcw,
  Skull,
  Square,
  Trash2,
  Truck,
  Type,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { toast } from "sonner";
import { AppMembershipLink } from "@/components/apps/AppMembership";
import { MemberIsolatedNotice, useMemberIncidentHold } from "@/components/apps/IsolatedNotice";
import { confirm } from "@/components/common/ConfirmDialog";
import { ContentLoading } from "@/components/common/ContentLoading";
import { DetailPageSkeleton } from "@/components/common/DetailPageSkeleton";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import {
  HEADER_ACTION_PRIORITY,
  ResponsiveHeaderActions,
} from "@/components/common/ResponsiveHeaderActions";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import {
  ALL_AVAILABILITY_INSTANCES,
  AvailabilityInstanceSelect,
} from "@/components/docker/availability/AvailabilityInstanceSelect";
import {
  AvailabilityProgress,
  isAvailabilityReplacing,
} from "@/components/docker/availability/AvailabilityProgress";
import { resolveAvailabilitySurfaceStatus } from "@/components/docker/availability/availability-status";
import { DockerMigrationDialog } from "@/components/docker/DockerMigrationDialog";
import { ImageReference } from "@/components/docker/ImageReference";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useDialogPresence,
} from "@/components/ui/dialog";
import { HealthBars } from "@/components/ui/health-bars";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRealtime } from "@/hooks/use-realtime";
import { useStableNavigate } from "@/hooks/use-stable-navigate";
import { useUrlTab } from "@/hooks/use-url-tab";
import { toastApiError } from "@/lib/api-error-toast";
import { projectComposeServicePolicy } from "@/lib/compose-service-availability";
import { resolveContainerImageReference } from "@/lib/docker-image-ref";
import {
  isDockerMigrationOwnedByTab,
  resolveMigrationTarget,
} from "@/lib/docker-migration-navigation";
import { dockerComposeProjectRoute, dockerContainerRoute } from "@/lib/resource-routes";
import { getReturnNavigationTarget, preserveReturnNavigationState } from "@/lib/return-navigation";
import { formatBytes } from "@/lib/utils";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { isPendingContainerOperation } from "@/services/api-docker";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import {
  handleLicenseApiError,
  requireLicenseFeature,
  usePlanIncludes,
} from "@/stores/license-paywall";
import { usePinnedContainersStore } from "@/stores/pinned-containers";
import { useResolvedPageContext } from "@/stores/resolved-page-context";
import type {
  AppMembershipRef,
  DockerAvailabilityPolicy,
  DockerHealthCheck,
  DockerMigration,
  DockerSourceBinding,
} from "@/types";
import { ConfigTab } from "./docker-detail/ConfigTab";
import { ConsoleTab } from "./docker-detail/ConsoleTab";
import { DockerResourceGitTabs } from "./docker-detail/DockerResourceGitTabs";
import { EnvironmentTab } from "./docker-detail/EnvironmentTab";
import { FilesTab } from "./docker-detail/FilesTab";
import {
  buildRolloutBusyReason,
  containerArchiveCapabilities,
  containerDisplayName,
  containerLifecycleActions,
  type InspectData,
  STATUS_BADGE,
} from "./docker-detail/helpers";
import type { ContainerDatabaseLink } from "./docker-detail/LinkRuntimeTab";
import { LogsTab } from "./docker-detail/LogsTab";
import { MultiContainerMonitoring } from "./docker-detail/MultiContainerMonitoring";
import {
  buildContainerMutationSnapshot,
  shouldSettleMutationTransition,
  useContainerMutationTransition,
} from "./docker-detail/mutation-transition";
import { OverviewTab } from "./docker-detail/OverviewTab";
import { SettingsTab } from "./docker-detail/SettingsTab";
import { useContainerDetailRealtime } from "./docker-detail/useContainerDetailRealtime";

export {
  buildContainerMutationSnapshot,
  shouldSettleMutationTransition,
} from "./docker-detail/mutation-transition";

export function isContainerTabDisabled(
  tab: string,
  {
    unavailable,
    availabilityManaged,
    transition,
    stopped,
  }: {
    unavailable: boolean;
    availabilityManaged: boolean;
    transition: boolean;
    stopped: boolean;
  }
) {
  if (
    unavailable &&
    !availabilityManaged &&
    ["logs", "console", "files", "stats", "environment", "settings"].includes(tab)
  )
    return true;
  // Only interactive runtime tools require an idle, running container.
  // Logs, monitoring and configuration remain inspectable during mutations;
  // configuration controls enforce their own mutation locks.
  return (tab === "console" || tab === "files") && (transition || stopped);
}

export async function inspectContainerAfterMutation(
  nodeId: string,
  containerId: string,
  containerName: string,
  noCache = true
): Promise<{ container: InspectData; containerId: string }> {
  try {
    const container = (await api.inspectContainer(nodeId, containerId, noCache)) as InspectData;
    return { container, containerId: String(container.Id ?? containerId) };
  } catch (error) {
    if (!containerName) throw error;
    const container = (await api.inspectContainerByName(
      nodeId,
      containerName,
      noCache
    )) as InspectData;
    const replacementId = String(container.Id ?? container.id ?? "");
    if (!replacementId) throw error;
    return { container, containerId: replacementId };
  }
}

export function splitContainerAvailabilityPolicy(policy: DockerAvailabilityPolicy | null) {
  return policy?.resourceKind === "container"
    ? { own: policy, parent: null }
    : { own: null, parent: policy };
}

export function resolveComposeOwnerName(
  policy: DockerAvailabilityPolicy | null,
  labels: Record<string, string>
) {
  return policy?.resourceKind === "compose"
    ? policy.displayName
    : labels["com.docker.compose.project"];
}

export function hasContainerRuntimeIdentityChanged(
  containerId: string | undefined,
  inspected: InspectData | null
) {
  const inspectedId = String(inspected?.Id ?? inspected?.id ?? "");
  return !!containerId && !!inspectedId && inspectedId !== containerId;
}

export function resolveContainerRouteName(
  resolvedContainerName: string | undefined,
  paramContainerName: string | undefined,
  paramContainerId: string | undefined,
  pathnameContainerName?: string
) {
  return (
    pathnameContainerName ?? paramContainerName ?? paramContainerId ?? resolvedContainerName ?? ""
  );
}

export function resolveContainerNameFromPathname(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  const containersIndex = parts.findIndex(
    (part, index) => part === "containers" && parts[index - 1] === "docker"
  );
  const encodedName = containersIndex >= 0 ? parts[containersIndex + 2] : undefined;
  if (!encodedName) return undefined;
  try {
    return decodeURIComponent(encodedName);
  } catch {
    return encodedName;
  }
}

// ── Main Page ────────────────────────────────────────────────────

export function DockerContainerDetail({
  resolvedNodeId,
  resolvedNodeSlug,
  resolvedContainerId,
  resolvedContainerName,
  resolvedContainer,
  pageContextToken,
}: {
  resolvedNodeId?: string;
  resolvedNodeSlug?: string;
  resolvedContainerId?: string;
  resolvedContainerName?: string;
  resolvedContainer?: InspectData;
  pageContextToken?: number | null;
} = {}) {
  const params = useParams<{
    nodeId?: string;
    nodeSlug?: string;
    containerId?: string;
    containerName?: string;
    tab?: string;
  }>();
  const location = useLocation();
  const nodeId = resolvedNodeId ?? params.nodeId;
  const nodeSlug = resolvedNodeSlug ?? params.nodeSlug ?? params.nodeId ?? "";
  const routeContainerName = resolveContainerRouteName(
    resolvedContainerName,
    params.containerName,
    params.containerId,
    resolveContainerNameFromPathname(location.pathname)
  );
  const [containerId, setContainerId] = useState(resolvedContainerId ?? params.containerId);
  const navigate = useStableNavigate();
  const backTarget = getReturnNavigationTarget(location.state, "/docker");
  const [container, setContainer] = useState<InspectData | null>(resolvedContainer ?? null);
  // Gateway adds the container's app (when it is a member) next to the inspect data.
  const containerApp = (container?.app ??
    resolvedContainer?.app ??
    null) as AppMembershipRef | null;
  // The open incident of the container's app environment refuses removing and renaming it (and its links).
  const {
    app: memberApp,
    reload: reloadMemberApp,
    hold: incidentHold,
  } = useMemberIncidentHold(containerApp);
  const containerRef = useRef<InspectData | null>(resolvedContainer ?? null);
  const scopeResourceId = String(
    container?.scopeResourceId ?? resolvedContainer?.scopeResourceId ?? ""
  );
  const { hasScope, isLoading: authLoading } = useAuthStore();
  const hasContainerScope = (baseScope: string) =>
    !!nodeId &&
    (scopeResourceId
      ? hasScope(`${baseScope}:${nodeId}/${scopeResourceId}`)
      : hasScope(baseScope) || hasScope(`${baseScope}:${nodeId}`));
  const canManage = hasContainerScope("docker:containers:manage");
  const canEdit = hasContainerScope("docker:containers:edit");
  const canCreate =
    (hasScope("docker:containers:create") ||
      !!(nodeId && hasScope(`docker:containers:create:${nodeId}`)) ||
      !!(
        container?.folderId && hasScope(`docker:containers:create:folder/${container.folderId}`)
      )) &&
    hasContainerScope("docker:containers:environment") &&
    hasContainerScope("docker:containers:secrets");
  const canDelete = hasContainerScope("docker:containers:delete");
  const canMigrate = hasContainerScope("docker:containers:migrate");
  const canViewContainer = hasContainerScope("docker:containers:view");
  const canUseConsole = hasContainerScope("docker:containers:console");
  const canReadFiles = hasContainerScope("docker:containers:files:read");
  const canWriteFiles = hasContainerScope("docker:containers:files:write");
  const canUseEnvironment = hasContainerScope("docker:containers:environment");
  const canUseSecrets = hasContainerScope("docker:containers:secrets");
  const archiveCapabilities = containerArchiveCapabilities({
    export: hasContainerScope("docker:containers:export"),
    files: canReadFiles,
    environment: canUseEnvironment,
    secrets: canUseSecrets,
  });
  const invalidate = useDockerStore((s) => s.invalidate);
  const setSelectedNode = useDockerStore((s) => s.setSelectedNode);
  const dockerNodes = useDockerStore((s) => s.dockerNodes);
  const previousNodeIdRef = useRef(useDockerStore.getState().selectedNodeId);

  // Temporarily scope store-backed invalidation to this node while the detail page is mounted,
  // then restore the previous list filter on unmount.
  useEffect(() => {
    if (nodeId) {
      setSelectedNode(nodeId);
    }

    return () => {
      setSelectedNode(previousNodeIdRef.current);
    };
  }, [nodeId, setSelectedNode]);
  const [healthCheck, setHealthCheck] = useState<DockerHealthCheck | null>(null);
  const [sourceIdentity, setSourceIdentity] = useState<Pick<
    DockerSourceBinding,
    "id" | "repositoryFullPath" | "deployedCommitSha"
  > | null>(null);
  const [sourceIdentityRevision, setSourceIdentityRevision] = useState(0);
  // First responses the header depends on; later refreshes update it in place.
  const [sourceIdentityLoaded, setSourceIdentityLoaded] = useState(false);
  const [healthCheckLoaded, setHealthCheckLoaded] = useState(false);
  const planIncludesGitDeploy = usePlanIncludes("git-push-to-deploy");
  const planIncludesMigration = usePlanIncludes("cross-node-migration");
  const planIncludesContainerExport = usePlanIncludes("container-export");
  // Source and Builds need Git push-to-deploy; an already bound source stays manageable.
  const gitTabsVisible = planIncludesGitDeploy || sourceIdentity !== null;
  const [parentAvailabilityLoaded, setParentAvailabilityLoaded] = useState(false);
  const [composeServiceImageLoaded, setComposeServiceImageLoaded] = useState(false);
  const [composeOwnerLoadedFor, setComposeOwnerLoadedFor] = useState<string | null>(null);
  const [runtimeSecureLinkDown, setRuntimeSecureLinkDown] = useState(false);
  const [ownAvailabilityPolicy, setAvailabilityPolicy] = useState<DockerAvailabilityPolicy | null>(
    null
  );
  const [availabilityLoaded, setAvailabilityLoaded] = useState(false);
  const [parentAvailabilityPolicy, setParentAvailabilityPolicy] =
    useState<DockerAvailabilityPolicy | null>(null);
  const [composeServiceImage, setComposeServiceImage] = useState<string | null>(null);
  const composeServiceName = String(
    (container?.Config?.Labels ?? resolvedContainer?.Config?.Labels)?.[
      "com.docker.compose.service"
    ] ?? ""
  );
  const sourceOwnerLabels = (container?.Config?.Labels ?? container?.Labels ?? {}) as Record<
    string,
    string
  >;
  const sourceOwnerComposeId =
    parentAvailabilityPolicy?.composeProjectId ||
    sourceOwnerLabels["wiolett.gateway.compose.project-id"];
  const sourceOwnerDeploymentId =
    parentAvailabilityPolicy?.deploymentId || sourceOwnerLabels["wiolett.gateway.deployment.id"];
  const serviceAvailabilityPolicy = useMemo(
    () =>
      projectComposeServicePolicy(
        parentAvailabilityPolicy,
        composeServiceName,
        composeServiceImage
      ),
    [parentAvailabilityPolicy, composeServiceName, composeServiceImage]
  );
  const availabilityPolicy = serviceAvailabilityPolicy ?? ownAvailabilityPolicy;
  useEffect(() => {
    // A new Compose revision must refresh the service image even when the project ID is stable.
    void parentAvailabilityPolicy?.composeRevisionId;
    if (!parentAvailabilityPolicy?.composeProjectId || !composeServiceName) return;
    let cancelled = false;
    setComposeServiceImage(null);
    void api
      .getDockerComposeProject(
        parentAvailabilityPolicy.sourceNodeId ?? parentAvailabilityPolicy.originNodeId ?? nodeId!,
        parentAvailabilityPolicy.composeProjectId
      )
      .then((project) => {
        if (!cancelled)
          setComposeServiceImage(
            project.activeRevision?.normalizedModel.services[composeServiceName]?.image ?? null
          );
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setComposeServiceImageLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [
    parentAvailabilityPolicy?.composeProjectId,
    parentAvailabilityPolicy?.composeRevisionId,
    parentAvailabilityPolicy?.sourceNodeId,
    parentAvailabilityPolicy?.originNodeId,
    composeServiceName,
    nodeId,
  ]);
  const applyAvailabilityPolicy = useCallback((policy: DockerAvailabilityPolicy | null) => {
    // A Compose child resolves to its parent's policy, whose placements contain
    // arrays of services, not the scalar containerId used by this page's selector.
    const split = splitContainerAvailabilityPolicy(policy);
    setAvailabilityPolicy(split.own);
    if (split.parent) setParentAvailabilityPolicy(split.parent);
  }, []);
  const runtimeReplacingRef = useRef(false);
  const [selectedPlacementId, setSelectedPlacementId] = useState<string | null>(null);
  const [selectedLogsPlacementId, setSelectedLogsPlacementId] = useState(
    ALL_AVAILABILITY_INSTANCES
  );
  const logicalWorkloadIdentity = (container?.logicalWorkload ??
    resolvedContainer?.logicalWorkload) as
    | {
        policyId?: string;
        mode?: string;
        managementNodeId?: string;
        managementResourceId?: string;
        runtimeNodeId?: string;
        runtimeContainerId?: string;
        placementId?: string;
      }
    | undefined;
  const availabilityManaged = Boolean(
    logicalWorkloadIdentity || (availabilityPolicy && availabilityPolicy.mode !== "single")
  );
  const runtimeSecureLinkContainerRef = useRef(containerId);

  const [activeTab, setActiveTab] = useUrlTab(
    [
      "overview",
      "source",
      "builds",
      "logs",
      "console",
      "files",
      "stats",
      "environment",
      "settings",
    ],
    "overview",
    (tab) => dockerContainerRoute(nodeSlug, routeContainerName, tab)
  );
  const [isLoading, setIsLoading] = useState(!resolvedContainer);
  const [actionLoading, setActionLoading] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [restoredMigration, setRestoredMigration] = useState<DockerMigration | null>(null);
  const migrationPresent = useDialogPresence(migrationOpen);
  useEffect(() => {
    if (!migrationPresent) setRestoredMigration(null);
  }, [migrationPresent]);
  const [renameValue, setRenameValue] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveImageMode, setArchiveImageMode] = useState<"portable" | "registry">("portable");
  const [archiveWritableLayer, setArchiveWritableLayer] = useState(false);
  const [archiveIncludeEnvironment, setArchiveIncludeEnvironment] = useState(false);
  const [archiveIncludeSecrets, setArchiveIncludeSecrets] = useState(false);
  const [archiveExporting, setArchiveExporting] = useState(false);
  const [archiveDevPreview, setArchiveDevPreview] = useState(false);
  const [composeOwnerProjectId, setComposeOwnerProjectId] = useState<string | null>(null);

  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === "undefined") return;
    const gatewayDev = (window.gatewayDev ??= {});
    const openGwcaExportModal = () => {
      setArchiveDevPreview(true);
      setArchiveImageMode("portable");
      setArchiveWritableLayer(true);
      setArchiveIncludeEnvironment(true);
      setArchiveIncludeSecrets(true);
      setArchiveOpen(true);
    };
    gatewayDev.openGwcaExportModal = openGwcaExportModal;
    return () => {
      if (gatewayDev.openGwcaExportModal === openGwcaExportModal) {
        delete gatewayDev.openGwcaExportModal;
      }
    };
  }, []);

  useEffect(() => {
    setContainerId(resolvedContainerId ?? params.containerId);
    if (resolvedContainer) {
      containerRef.current = resolvedContainer;
      setContainer(resolvedContainer);
      setIsLoading(false);
    }
  }, [params.containerId, resolvedContainer, resolvedContainerId]);

  useEffect(() => {
    // Realtime build events deliberately retrigger this source lookup.
    void sourceIdentityRevision;
    const runtimeContainerId = container?.Id ?? containerId;
    if (!nodeId || !routeContainerName || !runtimeContainerId) {
      setSourceIdentity(null);
      setSourceIdentityLoaded(true);
      return;
    }

    let cancelled = false;
    void api
      .getDockerSource(
        sourceOwnerComposeId
          ? {
              kind: "compose_project",
              nodeId: parentAvailabilityPolicy?.originNodeId || nodeId,
              composeProjectId: sourceOwnerComposeId,
            }
          : sourceOwnerDeploymentId
            ? {
                kind: "deployment",
                nodeId: parentAvailabilityPolicy?.originNodeId || nodeId,
                deploymentId: sourceOwnerDeploymentId,
              }
            : { kind: "container", nodeId, containerName: routeContainerName }
      )
      .then((source) => {
        if (cancelled) return;
        setSourceIdentity(
          source
            ? {
                id: source.id,
                repositoryFullPath: source.repositoryFullPath,
                deployedCommitSha: source.deployedCommitSha,
              }
            : null
        );
      })
      .catch(() => {
        if (!cancelled) setSourceIdentity(null);
      })
      .finally(() => {
        if (!cancelled) setSourceIdentityLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [
    container?.Id,
    containerId,
    nodeId,
    routeContainerName,
    sourceOwnerComposeId,
    sourceOwnerDeploymentId,
    parentAvailabilityPolicy?.originNodeId,
    sourceIdentityRevision,
  ]);

  useRealtime(
    sourceIdentity ? "docker.build.changed" : null,
    (payload) => {
      if ((payload as { sourceBindingId?: string })?.sourceBindingId === sourceIdentity?.id)
        setSourceIdentityRevision((revision) => revision + 1);
    },
    { onReconnect: () => setSourceIdentityRevision((revision) => revision + 1) }
  );

  useEffect(() => {
    if (!nodeId || !routeContainerName) {
      setAvailabilityPolicy(null);
      setAvailabilityLoaded(true);
      return;
    }
    let cancelled = false;
    setAvailabilityLoaded(false);
    void api
      .getDockerAvailability({ type: "container", nodeId, containerName: routeContainerName })
      .then((policy) => {
        if (!cancelled) applyAvailabilityPolicy(policy);
      })
      .catch(() => {
        if (!cancelled) setAvailabilityPolicy(null);
      })
      .finally(() => {
        if (!cancelled) setAvailabilityLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [applyAvailabilityPolicy, nodeId, routeContainerName]);

  useRealtime("docker.availability.changed", (payload) => {
    const event = payload as { policyId?: string };
    if (availabilityPolicy?.id && event.policyId && event.policyId !== availabilityPolicy.id)
      return;
    if (!nodeId || !routeContainerName) return;
    void api
      .getDockerAvailability({ type: "container", nodeId, containerName: routeContainerName })
      .then(applyAvailabilityPolicy)
      .catch(() => setAvailabilityPolicy(null));
  });
  useRealtime("docker.availability.operation.changed", (payload) => {
    const event = payload as { policyId?: string };
    if (availabilityPolicy?.id && event.policyId && event.policyId !== availabilityPolicy.id)
      return;
    if (!nodeId || !routeContainerName) return;
    void api
      .getDockerAvailability({ type: "container", nodeId, containerName: routeContainerName })
      .then(applyAvailabilityPolicy)
      .catch(() => setAvailabilityPolicy(null));
  });

  // Pin
  const [pinOpen, setPinOpen] = useState(false);
  const { isPinnedDashboard, isPinnedSidebar, toggleDashboard, toggleSidebar, updateMeta } =
    usePinnedContainersStore();
  const navigationMigration = (location.state as { dockerMigration?: DockerMigration } | null)
    ?.dockerMigration;
  const migrationHandoff =
    restoredMigration ??
    (navigationMigration?.resourceType === "container" &&
    navigationMigration.targetNodeId === nodeId &&
    navigationMigration.resourceName === routeContainerName
      ? navigationMigration
      : null);
  const handleMigrationCutover = useCallback(
    (migration: DockerMigration) => {
      if (!migration.targetNodeSlug) return;
      if (containerId && migration.targetResourceId) {
        const pins = usePinnedContainersStore.getState();
        pins.migrateId(containerId, migration.targetResourceId);
        pins.updateMeta(migration.targetResourceId, {
          nodeId: migration.targetNodeId,
          nodeSlug: migration.targetNodeSlug,
          name: migration.resourceName,
          state: containerRef.current?.State?.Status,
          scopeResourceId,
        });
      }
      navigate(dockerContainerRoute(migration.targetNodeSlug, migration.resourceName, activeTab), {
        replace: true,
        state: {
          ...preserveReturnNavigationState(location.state),
          ...(isDockerMigrationOwnedByTab(migration.id) ? { dockerMigration: migration } : {}),
        },
      });
    },
    [activeTab, containerId, location.state, navigate, scopeResourceId]
  );

  useEffect(() => {
    const incoming = navigationMigration;
    if (
      !incoming ||
      incoming.id === restoredMigration?.id ||
      incoming.resourceType !== "container" ||
      incoming.targetNodeId !== nodeId ||
      incoming.resourceName !== routeContainerName
    ) {
      return;
    }
    setRestoredMigration(incoming);
    setMigrationOpen(true);
    navigate(`${location.pathname}${location.search}${location.hash}`, {
      replace: true,
      state: preserveReturnNavigationState(location.state),
    });
  }, [location, navigate, navigationMigration, nodeId, restoredMigration?.id, routeContainerName]);

  const handleMigrationOpenChange = useCallback((nextOpen: boolean) => {
    setMigrationOpen(nextOpen);
  }, []);
  const navigatePreservingContext = useCallback(
    (to: string, options?: { replace?: boolean }) =>
      navigate(to, { ...options, state: location.state }),
    [location.state, navigate]
  );
  const composeManagedForTabs = Boolean(
    (container?.Config?.Labels ?? container?.Labels)?.["com.docker.compose.project"]
  );
  const visibleTabs = useMemo(
    () => [
      "overview",
      // Keep the Source and Builds tabs reachable until the bound-source lookup settles.
      ...(gitTabsVisible || !sourceIdentityLoaded ? ["source", "builds"] : []),
      ...(canViewContainer ? ["logs"] : []),
      ...(canUseConsole ? ["console"] : []),
      ...(canReadFiles ? ["files"] : []),
      ...(canViewContainer ? ["stats"] : []),
      ...(canUseEnvironment || canUseSecrets ? ["environment"] : []),
      ...(canEdit || (composeManagedForTabs && canViewContainer) ? ["settings"] : []),
      ...(canViewContainer ? ["config"] : []),
    ],
    [
      canEdit,
      canReadFiles,
      canUseConsole,
      canUseEnvironment,
      canUseSecrets,
      canViewContainer,
      composeManagedForTabs,
      gitTabsVisible,
      sourceIdentityLoaded,
    ]
  );
  const backendTransition = container?._transition as string | undefined;
  const { effectiveTransition, beginMutationTransition, clearMutationTransition } =
    useContainerMutationTransition(backendTransition);
  const adoptReplacementContainerId = useCallback(
    (replacementId: string) => {
      if (!containerId || replacementId === containerId) return;
      try {
        usePinnedContainersStore.getState().migrateId(containerId, replacementId);
      } catch {
        /* ignore */
      }
      setContainerId(replacementId);
      clearMutationTransition();
      if (pageContextToken != null && nodeId) {
        useResolvedPageContext.getState().resolve(pageContextToken, {
          resourceType: "docker-container",
          resourceId: replacementId,
          nodeId,
          scopeResourceId,
          label: routeContainerName,
        });
      }
    },
    [
      clearMutationTransition,
      containerId,
      nodeId,
      pageContextToken,
      routeContainerName,
      scopeResourceId,
    ]
  );

  const fetchContainer = useCallback(
    async (silent = false, noCache = false) => {
      if (runtimeReplacingRef.current) return;
      if (!nodeId || (!containerId && !routeContainerName)) return;
      if (!silent) setIsLoading(true);
      const load = (bypassCache: boolean) =>
        resolveMigrationTarget(!!migrationHandoff?.cutoverAt, async () => {
          if (logicalWorkloadIdentity) {
            const inspected = (await api.inspectContainerByName(
              logicalWorkloadIdentity.managementNodeId || nodeId,
              logicalWorkloadIdentity.managementResourceId || routeContainerName,
              bypassCache
            )) as InspectData;
            const replacementId = String(inspected.Id ?? inspected.id ?? containerId ?? "");
            if (replacementId) adoptReplacementContainerId(replacementId);
            return inspected;
          }
          const inspected = await inspectContainerAfterMutation(
            nodeId,
            containerId!,
            routeContainerName,
            bypassCache
          );
          adoptReplacementContainerId(inspected.containerId);
          return inspected.container;
        });
      try {
        let data: InspectData;
        try {
          data = await load(noCache);
        } catch (err) {
          // Right after a recreate the cached inspect can lag behind the new runtime: the node is asked once
          // before the container counts as gone (no error toast, the pin stays).
          if (noCache || !(err instanceof ApiRequestError && err.status === 404)) throw err;
          data = await load(true);
        }
        setContainer(data);
        if ((data as any)?._transition) {
          clearMutationTransition();
        }
        // Keep pinned meta in sync
        if (containerId && usePinnedContainersStore.getState().isPinnedSidebar(containerId)) {
          const cName =
            String((data as any)?.Name ?? "").replace(/^\//, "") || containerId.slice(0, 12);
          const cState = (data as any)?._transition ?? (data as any)?.State?.Status ?? "unknown";
          updateMeta(containerId, {
            nodeId,
            nodeSlug,
            name: cName,
            state: cState,
            scopeResourceId: String((data as any)?.scopeResourceId ?? ""),
          });
        }
      } catch (err) {
        if (
          containerId &&
          !migrationHandoff &&
          err instanceof ApiRequestError &&
          err.status === 404
        ) {
          usePinnedContainersStore.getState().removePin(containerId);
        }
        if (!silent) {
          toast.error("Failed to load container");
          if (!migrationHandoff) navigate(backTarget);
        }
      } finally {
        if (!silent) setIsLoading(false);
      }
    },
    [
      backTarget,
      adoptReplacementContainerId,
      clearMutationTransition,
      nodeId,
      nodeSlug,
      containerId,
      migrationHandoff,
      navigate,
      updateMeta,
      routeContainerName,
      logicalWorkloadIdentity,
    ]
  );

  useEffect(() => {
    const targetId = migrationHandoff?.targetResourceId;
    if (targetId && targetId !== containerId) setContainerId(targetId);
  }, [containerId, migrationHandoff?.targetResourceId]);

  useEffect(() => {
    if (!availabilityLoaded || availabilityManaged) return;
    const runtimeIdentityChanged = hasContainerRuntimeIdentityChanged(
      containerId,
      containerRef.current
    );
    if (!resolvedContainer || migrationHandoff?.targetResourceId || runtimeIdentityChanged) {
      void fetchContainer(true, Boolean(migrationHandoff?.targetResourceId));
    }
    // Safety-net poll — realtime channel handles fast updates, this just
    // catches anything that slipped through (e.g. between reconnects).
    const interval = setInterval(() => void fetchContainer(true, true), 30000);
    return () => clearInterval(interval);
  }, [
    availabilityLoaded,
    availabilityManaged,
    containerId,
    fetchContainer,
    migrationHandoff?.targetResourceId,
    resolvedContainer,
  ]);

  const refreshContainer = useCallback(() => fetchContainer(true, true), [fetchContainer]);

  useEffect(() => {
    containerRef.current = container;
  }, [container]);

  const refreshAfterMutation = useCallback(async () => {
    if (!nodeId || !containerId) return;

    const before = containerRef.current;
    const previousSignature = buildContainerMutationSnapshot(before);

    const attempts = [0, 250, 750, 1500, 2500, 3500, 5000, 7500];
    for (const delayMs of attempts) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      try {
        const stableName =
          routeContainerName || String(before?.Name ?? before?.name ?? "").replace(/^\//, "");
        const inspected = await inspectContainerAfterMutation(nodeId, containerId, stableName);
        const next = inspected.container;
        adoptReplacementContainerId(inspected.containerId);
        setContainer(next);
        containerRef.current = next;
        if (shouldSettleMutationTransition(previousSignature, next)) {
          clearMutationTransition();
          return;
        }
      } catch {
        // Realtime/delete handlers already deal with hard failures; keep polling briefly.
      }
    }
  }, [
    adoptReplacementContainerId,
    clearMutationTransition,
    containerId,
    nodeId,
    routeContainerName,
  ]);

  // Realtime: refetch on any container.changed event for this container's name.
  // Also handle the recreate ID migration for every open tab.
  const containerName = ((container?.Name ?? "") as string).replace(/^\//, "");
  const databaseLinks = (
    ((container as any)?.databaseLinks ?? []) as ContainerDatabaseLink[]
  ).filter((link) => link?.binding?.targetType === "container");
  const servingPlacements = useMemo(
    () =>
      (availabilityPolicy?.placements ?? [])
        .filter((placement) => placement.serving && placement.actualState === "serving")
        .sort(
          (left, right) =>
            right.generation - left.generation || left.nodeId.localeCompare(right.nodeId)
        ),
    [availabilityPolicy?.placements]
  );
  const availabilityRuntimePlacement =
    servingPlacements.find((placement) => placement.id === selectedPlacementId) ??
    servingPlacements.find((placement) => placement.nodeId === nodeId) ??
    servingPlacements[0];
  useEffect(() => {
    if (servingPlacements.length === 0) {
      setSelectedPlacementId(null);
      return;
    }
    if (!servingPlacements.some((placement) => placement.id === selectedPlacementId)) {
      setSelectedPlacementId(
        (servingPlacements.find((placement) => placement.nodeId === nodeId) ??
          servingPlacements[0])!.id
      );
    }
  }, [nodeId, selectedPlacementId, servingPlacements]);
  const availabilityRuntimeContainerId = String(
    availabilityRuntimePlacement?.runtimeIdentity?.containerId ?? ""
  );
  const runtimeNodeId =
    availabilityRuntimePlacement?.nodeId || logicalWorkloadIdentity?.runtimeNodeId || nodeId!;
  const runtimeContainerId =
    availabilityRuntimeContainerId || logicalWorkloadIdentity?.runtimeContainerId || containerId!;
  const managementNodeId = availabilityManaged
    ? availabilityPolicy?.sourceNodeId || logicalWorkloadIdentity?.managementNodeId || nodeId!
    : nodeId!;
  const managementContainerId = availabilityManaged
    ? logicalWorkloadIdentity?.managementResourceId || routeContainerName
    : containerId!;
  useEffect(() => {
    if (!availabilityManaged || !runtimeNodeId || !availabilityRuntimeContainerId) return;
    let cancelled = false;
    void api
      .inspectContainer(runtimeNodeId, availabilityRuntimeContainerId, true)
      .then((runtimeContainer) => {
        if (!cancelled) setContainer(runtimeContainer as InspectData);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [availabilityManaged, availabilityRuntimeContainerId, runtimeNodeId]);
  const availabilityLogSources = useMemo(
    () =>
      servingPlacements.flatMap((placement) => {
        const placementContainerId = String(placement.runtimeIdentity?.containerId ?? "");
        if (!placementContainerId) return [];
        const runtimeNode = dockerNodes.find((candidate) => candidate.id === placement.nodeId);
        const title =
          runtimeNode?.displayName ||
          runtimeNode?.hostname ||
          runtimeNode?.slug ||
          placement.nodeId.slice(0, 8);
        return [
          {
            channelId: placement.id,
            runtimeKey: `${placement.nodeId}:${placementContainerId}`,
            title,
            description: `stdout and stderr from ${title}`,
            state: "running",
            downloadFileName: `${routeContainerName}-${title}-logs.txt`,
            createWebSocket: (tail: number) =>
              api.createLogStreamWebSocket(placement.nodeId, placementContainerId, tail),
            getLogs: (params: { tail?: number; timestamps?: boolean }) =>
              api.getContainerLogs(placement.nodeId, placementContainerId, params),
            popoutUrl: `/docker/logs/${placement.nodeId}/${placementContainerId}`,
          },
        ];
      }),
    [dockerNodes, routeContainerName, servingPlacements]
  );
  const monitoringInstances = useMemo(() => {
    if (availabilityManaged && servingPlacements.length > 0) {
      return servingPlacements.flatMap((placement) => {
        const placementContainerId = String(
          placement.runtimeIdentity?.containerId ?? placement.runtimeIdentity?.containerName ?? ""
        );
        if (!placementContainerId) return [];
        const runtimeNode = dockerNodes.find((candidate) => candidate.id === placement.nodeId);
        const nodeTitle =
          runtimeNode?.displayName ||
          runtimeNode?.hostname ||
          runtimeNode?.slug ||
          placement.nodeId.slice(0, 8);
        return [
          {
            id: placement.id,
            title: nodeTitle,
            description: routeContainerName,
            nodeId: placement.nodeId,
            containerId: placementContainerId,
          },
        ];
      });
    }
    const fallbackNodeId = availabilityManaged ? runtimeNodeId : nodeId!;
    const fallbackContainerId = availabilityManaged ? runtimeContainerId : containerId!;
    const runtimeNode = dockerNodes.find((candidate) => candidate.id === fallbackNodeId);
    return [
      {
        id:
          (availabilityManaged ? logicalWorkloadIdentity?.placementId : undefined) ||
          fallbackContainerId ||
          routeContainerName,
        title:
          runtimeNode?.displayName ||
          runtimeNode?.hostname ||
          runtimeNode?.slug ||
          routeContainerName,
        description: runtimeNode?.displayName || runtimeNode?.hostname || runtimeNode?.slug,
        nodeId: fallbackNodeId,
        containerId: fallbackContainerId,
        data: container ?? undefined,
      },
    ];
  }, [
    availabilityManaged,
    container,
    containerId,
    dockerNodes,
    logicalWorkloadIdentity?.placementId,
    nodeId,
    routeContainerName,
    runtimeContainerId,
    runtimeNodeId,
    servingPlacements,
  ]);
  useEffect(() => {
    if (runtimeSecureLinkContainerRef.current === containerId) return;
    runtimeSecureLinkContainerRef.current = containerId;
    setRuntimeSecureLinkDown(false);
  }, [containerId]);
  useEffect(() => {
    if (databaseLinks.length === 0) setRuntimeSecureLinkDown(false);
  }, [databaseLinks.length]);
  useRealtime("database.changed", () => void refreshContainer());

  const fetchHealthCheck = useCallback(async () => {
    if (!availabilityLoaded || availabilityManaged) {
      if (availabilityManaged) {
        setHealthCheck(null);
        setHealthCheckLoaded(true);
      }
      return;
    }
    if (!nodeId || !containerName) {
      setHealthCheckLoaded(true);
      return;
    }

    try {
      const next = await api.getContainerHealthCheck(nodeId, containerName);
      setHealthCheck(next);
    } catch {
      setHealthCheck(null);
    } finally {
      setHealthCheckLoaded(true);
    }
  }, [availabilityLoaded, availabilityManaged, containerName, nodeId]);

  useEffect(() => {
    void fetchHealthCheck();
  }, [fetchHealthCheck]);
  useContainerDetailRealtime({
    nodeId,
    nodeSlug,
    containerId,
    routeContainerName,
    activeTab,
    navigate: navigatePreservingContext,
    refreshContainer,
    transition: backendTransition,
    clearMutationTransition,
    onContainerIdChange: adoptReplacementContainerId,
    onMigrationCutover: handleMigrationCutover,
    pageContextToken,
  });

  useRealtime("docker.snapshot.changed", (payload) => {
    const event = payload as { nodeId?: string; kind?: string; key?: string };
    if (event.kind !== "container-detail" || event.nodeId !== nodeId) return;
    if (
      event.key &&
      event.key !== containerId &&
      event.key !== containerName &&
      event.key !== routeContainerName
    ) {
      return;
    }
    // The snapshot is already fresh when this event is published. Forcing
    // another backend refresh here would publish the same event again and
    // create an unbounded request/event feedback loop.
    void fetchContainer(true);
  });

  // A build rollout starting or finishing changes whether the container is busy.
  useRealtime("docker.build.changed", (payload) => {
    const event = payload as { targetKind?: string; targetName?: string };
    if (event.targetKind !== "container" || event.targetName !== routeContainerName) return;
    void fetchContainer(true);
  });

  useRealtime("docker.health.changed", (payload) => {
    const ev = payload as {
      nodeId?: string;
      target?: string;
      containerName?: string;
    };
    if (ev.nodeId !== nodeId || ev.target !== "container" || ev.containerName !== containerName) {
      return;
    }

    void fetchHealthCheck();
  });

  useEffect(() => {
    if (authLoading) return;
    if (!visibleTabs.includes(activeTab)) {
      setActiveTab("overview");
    }
  }, [activeTab, authLoading, setActiveTab, visibleTabs]);

  // ── Action helpers ──
  // The header action whose request is running, so its button shows the pending state.
  const [pendingHeaderAction, setPendingHeaderAction] = useState<string | null>(null);
  // A removal started while a stop or kill request still runs owns the header state from then on.
  const removingRef = useRef(false);
  const doAction = async (fn: () => Promise<unknown>, successMsg: string, actionLabel?: string) => {
    setActionLoading(true);
    setPendingHeaderAction(actionLabel ?? null);
    try {
      const result = await fn();
      // A stop or restart still running after the request's wait goes on; the badge shows it until it ends.
      if (isPendingContainerOperation(result))
        toast.info(`Container is still ${result.transition}`);
      else toast.success(successMsg);
      invalidate("containers", "tasks");
      // A cached pre-action inspect can overwrite the fresh realtime result.
      // Read the authoritative state without remounting the detail page.
      await refreshContainer();
    } catch (err) {
      toastApiError(err, "Action failed");
    } finally {
      if (!removingRef.current) {
        setActionLoading(false);
        setPendingHeaderAction(null);
      }
    }
  };

  const handleRemove = async () => {
    if (availabilityManaged) {
      toast.error("Disable Availability in Settings before removing this container.");
      return;
    }
    const ok = await confirm({
      title: "Remove Container",
      description: `Remove "${containerDisplayName(container?.Name ?? "")}"? This cannot be undone.`,
      confirmLabel: "Remove",
    });
    if (!ok) return;
    removingRef.current = true;
    setActionLoading(true);
    setPendingHeaderAction("Remove");
    try {
      const pending = await api.removeContainer(nodeId!, containerId!);
      usePinnedContainersStore.getState().removePin(containerId!);
      toast.success(
        pending ? "Container will be removed once it has stopped" : "Container removed"
      );
      invalidate("containers", "tasks");
      navigate(backTarget);
    } catch (err) {
      toastApiError(err, "Failed to remove");
      removingRef.current = false;
      setActionLoading(false);
      setPendingHeaderAction(null);
    }
  };

  const handleDuplicate = async () => {
    const dName = `${containerDisplayName(container?.Name ?? "")}-copy`;
    setActionLoading(true);
    setPendingHeaderAction("Duplicate");
    try {
      const result = await api.duplicateContainer(
        nodeId!,
        containerId!,
        dName,
        typeof container?.folderId === "string" ? container.folderId : null
      );
      toast.success("Container duplicated");
      await invalidate("containers");
      if ((result as any)?.id ?? (result as any)?.Id) {
        const currentNodeSlug =
          useDockerStore.getState().dockerNodes.find((node) => node.id === nodeId)?.slug ||
          nodeSlug;
        navigate(dockerContainerRoute(currentNodeSlug, dName), {
          replace: true,
          state: location.state,
        });
      }
    } catch (err) {
      toastApiError(err, "Failed to duplicate");
    } finally {
      setActionLoading(false);
      setPendingHeaderAction(null);
    }
  };

  const handleArchiveExport = async () => {
    if (archiveDevPreview) {
      toast.info("GWCA export development preview", {
        description: "No archive was downloaded.",
      });
      return;
    }
    setArchiveExporting(true);
    const toastId = toast.loading("Exporting container archive...", {
      description: "Preparing archive",
      duration: Infinity,
      dismissible: false,
    });
    try {
      const archive = await api.downloadContainerArchive(
        nodeId!,
        containerId!,
        archiveWritableLayer,
        archiveImageMode,
        archiveCapabilities.canIncludeEnvironment &&
          archiveCapabilities.canIncludeSecrets &&
          archiveIncludeEnvironment &&
          archiveIncludeSecrets,
        archiveCapabilities.canIncludeEnvironment && archiveIncludeEnvironment,
        ({ loaded, total }) => {
          const description =
            total > 0
              ? `${Math.min(100, Math.round((loaded / total) * 100))}% (${formatBytes(loaded)} / ${formatBytes(total)})`
              : loaded > 0
                ? `${formatBytes(loaded)} downloaded`
                : "Preparing archive";
          toast.loading("Exporting container archive...", {
            id: toastId,
            description,
            duration: Infinity,
            dismissible: false,
          });
        }
      );

      const link = document.createElement("a");
      const downloadUrl = URL.createObjectURL(archive);
      link.href = downloadUrl;
      link.download = `${containerDisplayName(container?.Name ?? "container")}.gwca`;
      link.click();
      URL.revokeObjectURL(downloadUrl);
      setArchiveOpen(false);
      toast.success("Container archive downloaded", {
        id: toastId,
        duration: 5000,
        dismissible: true,
      });
    } catch (err) {
      if (handleLicenseApiError(err, "Container archive export")) {
        toast.dismiss(toastId);
      } else {
        toast.error(err instanceof Error ? err.message : "Failed to export archive", {
          id: toastId,
          description: null,
          duration: 8000,
          dismissible: true,
        });
      }
    } finally {
      setArchiveExporting(false);
    }
  };

  const openRename = () => {
    setRenameValue(containerDisplayName(container?.Name ?? ""));
    setRenameOpen(true);
  };

  const handleRename = async () => {
    if (actionLoading || !renameValue.trim()) return;
    const nextName = renameValue.trim();
    setActionLoading(true);
    try {
      await api.renameContainer(nodeId!, containerId!, nextName);
      toast.success("Container renamed");
      setRenameOpen(false);
      invalidate("containers");
      const currentNodeSlug =
        useDockerStore.getState().dockerNodes.find((node) => node.id === nodeId)?.slug || nodeSlug;
      navigate(dockerContainerRoute(currentNodeSlug, nextName, activeTab), {
        replace: true,
        state: location.state,
      });
    } catch (err) {
      toastApiError(err, "Failed to rename");
    } finally {
      setActionLoading(false);
    }
  };

  const name = availabilityManaged
    ? routeContainerName
    : containerDisplayName(container?.Name ?? "");
  const baseState = container?.State?.Status ?? (container?.State?.Running ? "running" : "stopped");
  const state = effectiveTransition ?? baseState;
  const availabilityServing =
    (availabilityPolicy?.placements ?? []).filter(
      (placement) => placement.serving && placement.actualState === "serving"
    ).length ?? 0;
  const availabilityDesired =
    availabilityPolicy?.mode === "replicated" ? availabilityPolicy.desiredReplicaCount : 1;
  const availabilitySurfaceStatus =
    availabilityManaged && availabilityPolicy
      ? resolveAvailabilitySurfaceStatus({
          policyStatus: availabilityPolicy.status,
          operation: availabilityPolicy.latestOperation,
          shouldRun: availabilityPolicy.shouldRun,
          serving: availabilityServing,
          desired: availabilityDesired,
        })
      : null;
  const availabilityTransition =
    availabilitySurfaceStatus &&
    ["rolling_out", "starting", "stopping", "restarting"].includes(availabilitySurfaceStatus)
      ? availabilitySurfaceStatus
      : null;
  const logicalAvailabilityStatus = availabilityManaged ? availabilitySurfaceStatus : null;
  const displayState = logicalAvailabilityStatus ?? state;
  const logicalHealthStatus =
    availabilityManaged && availabilityPolicy
      ? !availabilityPolicy.shouldRun
        ? "stopped"
        : availabilityTransition
          ? "online"
          : availabilityServing === 0
            ? "offline"
            : availabilityServing < availabilityDesired
              ? "degraded"
              : "online"
      : null;
  const lifecycleActions = containerLifecycleActions(
    availabilityManaged ? (availabilityPolicy?.shouldRun ? "running" : "stopped") : state
  );
  const environmentWorkloadState = availabilityManaged
    ? availabilityPolicy?.shouldRun
      ? "running"
      : "stopped"
    : state;
  const image =
    (serviceAvailabilityPolicy
      ? composeServiceImage || "—"
      : availabilityPolicy?.sourceImageReference) ||
    (container ? resolveContainerImageReference(container) : "");
  const unavailable = container?.availability === "unavailable";
  const secureLinkDown = Boolean((container as any)?.secureLinkDown) || runtimeSecureLinkDown;
  const labels = (container?.Config?.Labels ?? container?.Labels ?? {}) as Record<string, string>;
  const composeManaged = Boolean(labels["com.docker.compose.project"]);
  const composeProjectName = resolveComposeOwnerName(parentAvailabilityPolicy, labels);
  const composeProjectId =
    parentAvailabilityPolicy?.composeProjectId || labels["wiolett.gateway.compose.project-id"];
  const parentDeploymentId = labels["wiolett.gateway.deployment.id"];
  const refreshParentAvailability = useCallback(async () => {
    const resource = composeProjectId
      ? { type: "compose" as const, composeProjectId }
      : parentDeploymentId
        ? { type: "deployment" as const, deploymentId: parentDeploymentId }
        : null;
    if (!resource) {
      setParentAvailabilityPolicy(null);
      setParentAvailabilityLoaded(true);
      return;
    }
    try {
      setParentAvailabilityPolicy(await api.getDockerAvailability(resource));
    } catch {
      setParentAvailabilityPolicy(null);
    } finally {
      setParentAvailabilityLoaded(true);
    }
  }, [composeProjectId, parentDeploymentId]);
  useEffect(() => {
    void refreshParentAvailability();
  }, [refreshParentAvailability]);
  useRealtime("docker.availability.operation.changed", refreshParentAvailability);
  useRealtime("docker.availability.changed", refreshParentAvailability);
  const runtimePolicy = availabilityPolicy ?? parentAvailabilityPolicy;
  const runtimeReplacing = isAvailabilityReplacing(runtimePolicy);
  const wasReplacing = useRef(false);
  runtimeReplacingRef.current = runtimeReplacing;
  useEffect(() => {
    if (wasReplacing.current && !runtimeReplacing) void fetchContainer(true, true);
    wasReplacing.current = runtimeReplacing;
  }, [runtimeReplacing, fetchContainer]);
  const availabilityBusy = Boolean(
    availabilityPolicy?.latestOperation &&
      ["pending", "running", "waiting", "cleanup_pending"].includes(
        availabilityPolicy.latestOperation.status
      )
  );
  // A build rollout owns the container from acceptance until it finishes; the
  // server refuses every mutation (409) meanwhile, so disable them with the reason.
  const buildRolloutReason = buildRolloutBusyReason(container?._buildRollout, "container");
  const actionDisabled =
    actionLoading ||
    (availabilityManaged ? availabilityBusy : !!effectiveTransition || unavailable) ||
    composeManaged ||
    !!buildRolloutReason;
  // A container that is stopping can be removed: the removal waits for the stop, or removes the container once the
  // stop has ended (202).
  const stopping =
    effectiveTransition === "stopping" ||
    effectiveTransition === "killing" ||
    pendingHeaderAction === "Stop" ||
    pendingHeaderAction === "Kill";
  const removeDisabled =
    availabilityManaged ||
    incidentHold.kept !== null ||
    (stopping
      ? unavailable || composeManaged || !!buildRolloutReason || pendingHeaderAction === "Remove"
      : actionDisabled);
  const deploymentManaged = labels["wiolett.gateway.deployment.managed"] === "true";
  const gpuMapped =
    container?.gpuAttachment?.mode === "managed" || container?.gpuAttachment?.mode === "external";
  const gpuPortabilityReason =
    "GPU-attached containers cannot be migrated or exported in this version";
  const migrationDisabledReason = gpuMapped
    ? gpuPortabilityReason
    : composeManaged
      ? "Docker Compose resources cannot be migrated"
      : deploymentManaged
        ? "Migrate this container through its Opfield deployment"
        : (buildRolloutReason ??
          (actionDisabled ? "Container is unavailable or changing state" : undefined));
  const currentTransition = runtimeReplacing ? "replacing" : effectiveTransition;
  const isStopped = availabilityManaged
    ? !availabilityPolicy?.shouldRun || availabilityServing === 0
    : baseState !== "running";
  const isTabDisabled = useCallback(
    (tab: string) =>
      isContainerTabDisabled(tab, {
        unavailable,
        availabilityManaged,
        transition: !!currentTransition,
        stopped: isStopped,
      }),
    [unavailable, availabilityManaged, currentTransition, isStopped]
  );

  useEffect(() => {
    if (!composeManaged || composeProjectId || !composeProjectName || !nodeId) {
      setComposeOwnerProjectId(composeProjectId || null);
      return;
    }
    let cancelled = false;
    api
      .listDockerComposeProjects(nodeId)
      .then(
        (projects) => projects.find((project) => project.name === composeProjectName)?.id ?? null
      )
      .then((ownerId) => {
        if (!cancelled) setComposeOwnerProjectId(ownerId);
      })
      .catch(() => {
        if (!cancelled) setComposeOwnerProjectId(null);
      })
      .finally(() => {
        if (!cancelled) setComposeOwnerLoadedFor(composeProjectName);
      });
    return () => {
      cancelled = true;
    };
  }, [composeManaged, composeProjectId, composeProjectName, nodeId]);

  // Leave read-only diagnostics open while lifecycle actions run. Only console
  // and filesystem tools require a stable running process.
  useEffect(() => {
    if (isLoading || !container) return;
    if (isTabDisabled(activeTab)) {
      setActiveTab("overview");
    }

    if (containerId && isTabDisabled("console")) {
      try {
        const consoleChannel = new BroadcastChannel(`docker-console:${containerId}`);
        consoleChannel.postMessage({ type: "request-close" });
        consoleChannel.close();
      } catch {}
    }
  }, [activeTab, container, containerId, isTabDisabled, isLoading, setActiveTab]);

  const composeOwnerLookupPending =
    composeManaged &&
    !composeProjectId &&
    !!composeProjectName &&
    !!nodeId &&
    composeOwnerLoadedFor !== composeProjectName;
  const composeServiceImagePending =
    !!parentAvailabilityPolicy?.composeProjectId &&
    !!composeServiceName &&
    !composeServiceImageLoaded;
  const headerDataLoading =
    !availabilityLoaded ||
    (Boolean(composeProjectId || parentDeploymentId) && !parentAvailabilityLoaded) ||
    !sourceIdentityLoaded ||
    !healthCheckLoaded ||
    composeOwnerLookupPending ||
    composeServiceImagePending;

  if (isLoading) return <DetailPageSkeleton label="Loading container" tabs={6} />;
  if (!container)
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Container not found
      </div>
    );

  const headerActions = [
    ...(canViewContainer
      ? [
          {
            label: "View config",
            icon: <Code2 className="h-4 w-4" />,
            onClick: () => setConfigOpen(true),
            alwaysOverflow: true,
          },
        ]
      : []),
    {
      label: "Pin",
      icon: <Pin className="h-4 w-4" />,
      onClick: () => setPinOpen(true),
      disabled: actionDisabled,
    },
    ...(!composeManaged &&
    planIncludesMigration &&
    canMigrate &&
    availabilityLoaded &&
    !availabilityManaged &&
    (!parentAvailabilityPolicy || parentAvailabilityPolicy.mode === "single")
      ? [
          {
            label: "Migrate",
            icon: <Truck className="h-4 w-4" />,
            onClick: () => {
              if (!requireLicenseFeature("cross-node-migration", "Cross-node migration")) return;
              setMigrationOpen(true);
            },
            disabled: Boolean(migrationDisabledReason),
            disabledReason: migrationDisabledReason,
          },
        ]
      : []),
    ...(!composeManaged && lifecycleActions.canStart && canManage
      ? [
          {
            label: "Start",
            icon: <Play className="h-4 w-4" />,
            onClick: () =>
              doAction(
                () => api.startContainer(managementNodeId, managementContainerId),
                "Container started",
                "Start"
              ),
            disabled: actionDisabled,
            priority: HEADER_ACTION_PRIORITY.primary,
          },
        ]
      : []),
    ...(!composeManaged && lifecycleActions.canStop && canManage
      ? [
          {
            label: "Stop",
            icon: <Square className="h-4 w-4" />,
            onClick: () =>
              doAction(
                () => api.stopContainer(managementNodeId, managementContainerId),
                "Container stopped",
                "Stop"
              ),
            disabled: actionDisabled,
            priority: HEADER_ACTION_PRIORITY.primary,
          },
          ...(lifecycleActions.canRestart
            ? [
                {
                  label: "Restart",
                  icon: <RotateCcw className="h-4 w-4" />,
                  onClick: () =>
                    doAction(
                      () => api.restartContainer(managementNodeId, managementContainerId),
                      "Container restarted",
                      "Restart"
                    ),
                  disabled: actionDisabled,
                  priority: HEADER_ACTION_PRIORITY.primary,
                },
              ]
            : []),
        ]
      : []),
    ...(!composeManaged && canEdit
      ? [
          {
            label: "Rename",
            icon: <Type className="h-4 w-4" />,
            onClick: openRename,
            disabled: actionDisabled || incidentHold.kept !== null,
            disabledReason: incidentHold.kept ?? undefined,
            separatorBefore: true,
          },
        ]
      : []),
    ...(!composeManaged && canCreate
      ? [
          {
            label: "Duplicate",
            icon: <Copy className="h-4 w-4" />,
            onClick: handleDuplicate,
            disabled: actionDisabled,
          },
        ]
      : []),
    ...(!composeManaged && planIncludesContainerExport && archiveCapabilities.canExport
      ? [
          {
            label: "Export archive",
            icon: <Archive className="h-4 w-4" />,
            onClick: () => {
              if (!requireLicenseFeature("container-export", "Container archive export")) return;
              setArchiveDevPreview(false);
              setArchiveImageMode(archiveCapabilities.canExportPortable ? "portable" : "registry");
              setArchiveWritableLayer(false);
              setArchiveIncludeEnvironment(false);
              setArchiveIncludeSecrets(false);
              setArchiveOpen(true);
            },
            disabled: actionDisabled || gpuMapped,
            disabledReason: gpuMapped ? gpuPortabilityReason : undefined,
          },
        ]
      : []),
    ...(!composeManaged && canManage
      ? [
          {
            label: "Kill",
            icon: <Skull className="h-4 w-4" />,
            onClick: () =>
              doAction(
                () => api.killContainer(managementNodeId, managementContainerId),
                "Container killed",
                "Kill"
              ),
            disabled: unavailable || !lifecycleActions.canKill,
            destructive: true,
            separatorBefore: true,
            priority: HEADER_ACTION_PRIORITY.emergency,
          },
        ]
      : []),
    ...(!composeManaged && canDelete
      ? [
          {
            label: "Remove",
            icon: <Trash2 className="h-4 w-4" />,
            onClick: handleRemove,
            disabled: removeDisabled,
            disabledReason: availabilityManaged
              ? "Disable Availability in Settings before removing this container."
              : (incidentHold.kept ?? undefined),
            destructive: true,
            separatorBefore: !canManage,
          },
        ]
      : []),
  ];
  const isTerminalTab = activeTab === "console" || activeTab === "logs";

  return (
    <PageTransition>
      <div
        className={`h-full p-6 flex flex-col gap-4 ${
          isTerminalTab ? "overflow-hidden" : "overflow-y-auto"
        }`}
      >
        <ContentLoading loading={headerDataLoading} />
        <PageHeader
          className="shrink-0"
          leading={<PageBackButton onClick={() => navigate(backTarget)} />}
          title={name}
          badges={
            <>
              <Badge
                variant={STATUS_BADGE[displayState] ?? "secondary"}
                size="inline"
                className="shrink-0"
              >
                {displayState.replaceAll("_", " ")}
              </Badge>
              {secureLinkDown && (
                <>
                  <Badge variant="destructive" size="inline" className="shrink-0">
                    Unhealthy
                  </Badge>
                  <Badge variant="destructive" size="inline" className="shrink-0">
                    Secure Link Down
                  </Badge>
                </>
              )}
            </>
          }
          description={
            sourceIdentity ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{sourceIdentity.repositoryFullPath}</span>
                {sourceIdentity.deployedCommitSha ? (
                  <>
                    <span aria-hidden="true">&middot;</span>
                    <span className="shrink-0 font-mono">
                      {sourceIdentity.deployedCommitSha.slice(0, 10)}
                    </span>
                  </>
                ) : null}
                {containerApp ? (
                  <span className="shrink-0">
                    &middot; <AppMembershipLink app={containerApp} />
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="flex min-w-0 items-center gap-1.5">
                <ImageReference value={image} copyable={false} className="justify-start" />
                <span className="shrink-0">
                  &middot; {(container.Id ?? containerId ?? "").slice(0, 12)}
                </span>
                {containerApp ? (
                  <span className="shrink-0">
                    &middot; <AppMembershipLink app={containerApp} />
                  </span>
                ) : null}
              </span>
            )
          }
          actions={
            <ResponsiveHeaderActions actions={headerActions}>
              {headerActions.map((headerAction) => (
                <Button
                  key={headerAction.label}
                  variant="outline"
                  size={headerAction.label === "Pin" ? "icon" : "default"}
                  disabled={headerAction.disabled}
                  pending={pendingHeaderAction === headerAction.label}
                  title={
                    headerAction.disabled
                      ? (headerAction.disabledReason ?? buildRolloutReason ?? undefined)
                      : undefined
                  }
                  onClick={headerAction.onClick}
                >
                  {pendingHeaderAction === headerAction.label ? null : headerAction.icon}
                  {headerAction.label === "Pin" ? null : headerAction.label}
                </Button>
              ))}
            </ResponsiveHeaderActions>
          }
        />

        <MemberIsolatedNotice
          app={containerApp}
          memberApp={memberApp}
          onChanged={reloadMemberApp}
        />

        {buildRolloutReason && !composeManaged && (
          <div
            role="status"
            className="flex items-center gap-2 border border-primary/20 bg-primary/5 p-3 text-sm"
          >
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
            <p>
              {buildRolloutReason}. Configuration and lifecycle changes are disabled until then;
              managed links can still be saved and reach the new revision.
            </p>
          </div>
        )}

        {composeManaged && (
          <div className="flex flex-wrap items-center justify-between gap-3 border border-primary/20 bg-primary/5 p-3 text-sm">
            <div>
              <p className="font-medium">Managed by Compose project {composeProjectName}</p>
              <p className="text-muted-foreground">
                Direct lifecycle and configuration changes are disabled. Runtime settings remain
                available for inspection; use the Compose project to change them.
              </p>
            </div>
            {(composeProjectId || composeOwnerProjectId) && (
              <Button
                variant="quiet"
                size="inline"
                className="shrink-0 text-sm text-foreground hover:underline [&_svg]:size-3.5"
                onClick={() =>
                  navigate(dockerComposeProjectRoute(composeProjectId || composeOwnerProjectId!))
                }
              >
                Open Compose project
                <ArrowRight />
              </Button>
            )}
          </div>
        )}

        {healthCheck?.enabled && (
          <HealthBars
            history={healthCheck.healthHistory}
            currentStatus={
              logicalHealthStatus ??
              (healthCheck.healthStatus === "stopped"
                ? "stopped"
                : secureLinkDown
                  ? "offline"
                  : healthCheck.healthStatus)
            }
          />
        )}

        {/* Tabs */}
        <AvailabilityProgress policy={runtimePolicy} />
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex flex-col flex-1 min-h-0"
        >
          <TabsList className="shrink-0">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            {gitTabsVisible && (
              <TabsTrigger value="source" className="gap-1.5">
                Source
              </TabsTrigger>
            )}
            {gitTabsVisible && (
              <TabsTrigger value="builds" className="gap-1.5">
                Builds
              </TabsTrigger>
            )}
            {canViewContainer && (
              <TabsTrigger value="logs" disabled={isTabDisabled("logs")}>
                Logs
              </TabsTrigger>
            )}
            {canUseConsole && (
              <TabsTrigger value="console" disabled={isTabDisabled("console")}>
                Console
              </TabsTrigger>
            )}
            {canReadFiles && (
              <TabsTrigger value="files" disabled={isTabDisabled("files")}>
                Files
              </TabsTrigger>
            )}
            {canViewContainer && (
              <TabsTrigger value="stats" disabled={isTabDisabled("stats")}>
                Monitoring
              </TabsTrigger>
            )}
            {(canUseEnvironment || canUseSecrets) && !composeManaged && (
              <TabsTrigger value="environment" disabled={isTabDisabled("environment")}>
                Environment
              </TabsTrigger>
            )}
            {(canEdit || (composeManaged && canViewContainer)) && (
              <TabsTrigger value="settings" disabled={isTabDisabled("settings")}>
                Settings
              </TabsTrigger>
            )}
          </TabsList>
          <TabsContent value="overview" className="pb-0">
            <OverviewTab
              nodeId={nodeId!}
              containerId={containerId!}
              data={container}
              imageReferenceOverride={
                serviceAvailabilityPolicy
                  ? composeServiceImage || "—"
                  : availabilityPolicy?.sourceImageReference
              }
              sourceIdentity={sourceIdentity}
              databaseLinks={databaseLinks}
              onSecureLinkHealthChange={setRuntimeSecureLinkDown}
              logicalContainerName={routeContainerName}
              availabilityPolicy={availabilityPolicy}
              availabilityLoading={!availabilityLoaded}
            />
          </TabsContent>
          <TabsContent value="source" className="pb-6">
            <DockerResourceGitTabs
              target={{ kind: "container", nodeId: nodeId!, containerName: routeContainerName }}
              view="source"
            />
          </TabsContent>
          <TabsContent value="builds" className="flex min-h-0 flex-1 flex-col pb-0">
            <DockerResourceGitTabs
              target={{ kind: "container", nodeId: nodeId!, containerName: routeContainerName }}
              view="builds"
            />
          </TabsContent>
          {canViewContainer && !isTabDisabled("logs") && (
            <TabsContent value="logs" className="flex flex-col flex-1 min-h-0 pb-0">
              {availabilityManaged && servingPlacements.length > 1 ? (
                <LogsTab
                  {...(selectedLogsPlacementId === ALL_AVAILABILITY_INSTANCES
                    ? { sources: availabilityLogSources }
                    : {
                        source:
                          availabilityLogSources.find(
                            (source) => source.channelId === selectedLogsPlacementId
                          ) ?? availabilityLogSources[0]!,
                      })}
                  headerActions={
                    <AvailabilityInstanceSelect
                      placements={servingPlacements}
                      nodes={dockerNodes}
                      value={selectedLogsPlacementId}
                      onValueChange={setSelectedLogsPlacementId}
                      includeAll
                    />
                  }
                />
              ) : (
                <LogsTab
                  nodeId={runtimeNodeId}
                  containerId={runtimeContainerId}
                  containerState={baseState}
                  inspectData={container}
                />
              )}
            </TabsContent>
          )}
          {canUseConsole && !currentTransition && (!unavailable || availabilityManaged) && (
            <TabsContent value="console" className="flex flex-col flex-1 min-h-0">
              <ConsoleTab
                nodeId={runtimeNodeId}
                containerId={runtimeContainerId}
                scopeResourceId={scopeResourceId}
                scopeNodeId={nodeId!}
                headerActions={
                  servingPlacements.length > 1 ? (
                    <AvailabilityInstanceSelect
                      placements={servingPlacements}
                      nodes={dockerNodes}
                      value={availabilityRuntimePlacement?.id ?? servingPlacements[0]!.id}
                      onValueChange={setSelectedPlacementId}
                    />
                  ) : undefined
                }
              />
            </TabsContent>
          )}
          {canReadFiles && !currentTransition && (!unavailable || availabilityManaged) && (
            <TabsContent value="files" className="pb-0">
              <FilesTab
                nodeId={runtimeNodeId}
                containerId={runtimeContainerId}
                scopeResourceId={scopeResourceId}
                scopeNodeId={nodeId!}
                canWrite={canWriteFiles}
                headerActions={
                  servingPlacements.length > 1 ? (
                    <AvailabilityInstanceSelect
                      placements={servingPlacements}
                      nodes={dockerNodes}
                      value={availabilityRuntimePlacement?.id ?? servingPlacements[0]!.id}
                      onValueChange={setSelectedPlacementId}
                    />
                  ) : undefined
                }
              />
            </TabsContent>
          )}
          {canViewContainer && (!unavailable || availabilityManaged) && (
            <TabsContent value="stats" className="pb-0">
              <MultiContainerMonitoring instances={monitoringInstances} />
            </TabsContent>
          )}
          {(canUseEnvironment || canUseSecrets) &&
            (!unavailable || availabilityManaged) &&
            !composeManaged && (
              <TabsContent value="environment" className="flex flex-col flex-1 min-h-0 pb-0">
                <EnvironmentTab
                  nodeId={managementNodeId}
                  containerId={managementContainerId}
                  containerName={name}
                  scopeResourceId={scopeResourceId}
                  containerState={environmentWorkloadState}
                  disabled={!!currentTransition || !!buildRolloutReason}
                  managedLinksDisabled={!!currentTransition}
                  linkRemovalDisabledReason={incidentHold.kept}
                  onMutationStart={beginMutationTransition}
                  onMutationEnd={clearMutationTransition}
                  onRecreating={refreshAfterMutation}
                />
              </TabsContent>
            )}
          {(canEdit || (composeManaged && canViewContainer)) &&
            (!unavailable || availabilityManaged) && (
              <TabsContent value="settings" className="pb-0">
                <SettingsTab
                  nodeId={managementNodeId}
                  containerId={managementContainerId}
                  scopeResourceId={scopeResourceId}
                  data={container}
                  onMutationStart={beginMutationTransition}
                  onMutationEnd={clearMutationTransition}
                  onRecreating={refreshAfterMutation}
                  onRefresh={refreshAfterMutation}
                  onHealthCheckSaved={setHealthCheck}
                  transition={currentTransition ?? (buildRolloutReason ? "deploying" : undefined)}
                  readOnly={composeManaged}
                  availabilityManaged={availabilityManaged}
                  logicalContainerName={availabilityManaged ? routeContainerName : undefined}
                  imageReferenceOverride={availabilityPolicy?.sourceImageReference}
                  onAvailabilityDisableQueued={({ nodeSlug: survivorNodeSlug }) =>
                    navigate(
                      dockerContainerRoute(survivorNodeSlug, routeContainerName, "settings"),
                      { replace: true }
                    )
                  }
                />
              </TabsContent>
            )}
        </Tabs>
      </div>
      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Container Configuration</DialogTitle>
          </DialogHeader>
          <ConfigTab data={container} editorHeight="min(60dvh, 640px)" />
        </DialogContent>
      </Dialog>
      {/* Pin Dialog */}
      <DockerMigrationDialog
        open={migrationOpen}
        onOpenChange={handleMigrationOpenChange}
        onCutover={handleMigrationCutover}
        initialMigration={restoredMigration}
        resource={{
          type: "container",
          nodeId: nodeId!,
          containerName: name,
          displayName: name,
          sourceState: baseState,
        }}
      />
      <Dialog open={pinOpen} onOpenChange={setPinOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Pin Container</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Add to dashboard</p>
                <p className="text-xs text-muted-foreground">
                  Show compact status on the dashboard
                </p>
              </div>
              <Switch
                checked={isPinnedDashboard(containerId!)}
                disabled={!!effectiveTransition}
                onChange={() => {
                  toggleDashboard(containerId!, {
                    nodeId: nodeId!,
                    nodeSlug,
                    name,
                    state: baseState,
                    scopeResourceId,
                  });
                  usePinnedContainersStore.getState().invalidate();
                }}
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Add to sidebar</p>
                <p className="text-xs text-muted-foreground">Quick access link in the sidebar</p>
              </div>
              <Switch
                checked={isPinnedSidebar(containerId!)}
                disabled={!!effectiveTransition}
                onChange={() => {
                  toggleSidebar(containerId!, {
                    nodeId: nodeId!,
                    nodeSlug,
                    name,
                    state: baseState,
                    scopeResourceId,
                  });
                  usePinnedContainersStore.getState().invalidate();
                }}
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={archiveOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && archiveExporting) return;
          setArchiveOpen(nextOpen);
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          hideCloseButton={archiveExporting}
          onEscapeKeyDown={(event) => {
            if (archiveExporting) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (archiveExporting) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Export Container Archive</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <p className="text-muted-foreground">
              Container settings and volume declarations are included. Volume contents are not
              included.
            </p>
            <div className="space-y-1.5">
              <p className="font-medium">Image mode</p>
              <Select
                value={archiveImageMode}
                disabled={archiveExporting}
                onValueChange={(value) => {
                  const mode = value as "portable" | "registry";
                  setArchiveImageMode(mode);
                  if (mode === "registry") setArchiveWritableLayer(false);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    value="portable"
                    disabled={!archiveCapabilities.canExportPortable && !archiveDevPreview}
                  >
                    Portable · include Docker image
                  </SelectItem>
                  <SelectItem value="registry">Registry-backed · configuration only</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {archiveImageMode === "portable"
                  ? "The archive is self-contained and can be imported without registry access."
                  : "The target node must already have or be able to pull the exact image digest."}
              </p>
              {!archiveCapabilities.canExportPortable && !archiveDevPreview && (
                <p className="text-xs text-muted-foreground">
                  Portable export requires Files access.
                </p>
              )}
            </div>
            <PanelShell>
              <SettingsControlRow
                title="Include writable layer"
                description="Captures current container filesystem changes without pausing it. Concurrent writes may produce an application-inconsistent snapshot."
                controlsClassName="sm:min-w-0"
              >
                <Switch
                  checked={archiveWritableLayer}
                  onChange={setArchiveWritableLayer}
                  disabled={archiveExporting || archiveImageMode === "registry"}
                  ariaLabel="Include writable container layer"
                />
              </SettingsControlRow>
              {(archiveCapabilities.canIncludeEnvironment || archiveDevPreview) && (
                <SettingsControlRow
                  title="Include environment"
                  description="Includes Opfield-managed container environment overrides. Environment values baked into the image may still be present in a portable archive."
                  controlsClassName="sm:min-w-0"
                >
                  <Switch
                    checked={archiveIncludeEnvironment}
                    onChange={(includeEnvironment) => {
                      setArchiveIncludeEnvironment(includeEnvironment);
                      if (!includeEnvironment) setArchiveIncludeSecrets(false);
                    }}
                    disabled={archiveExporting}
                    ariaLabel="Include container environment"
                  />
                </SettingsControlRow>
              )}
              {archiveIncludeEnvironment &&
                (archiveCapabilities.canIncludeSecrets || archiveDevPreview) && (
                  <SettingsControlRow
                    title="Include secrets"
                    description="Stores decrypted secret values in the archive. Treat the downloaded file as sensitive."
                    controlsClassName="sm:min-w-0"
                  >
                    <Switch
                      checked={archiveIncludeSecrets}
                      onChange={setArchiveIncludeSecrets}
                      disabled={archiveExporting}
                      ariaLabel="Include container secrets"
                    />
                  </SettingsControlRow>
                )}
            </PanelShell>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setArchiveOpen(false)}
              disabled={archiveExporting}
            >
              Cancel
            </Button>
            <Button onClick={() => void handleArchiveExport()} pending={archiveExporting}>
              Download .gwca
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Rename Dialog */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename Container</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            disabled={!!effectiveTransition}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder="New container name"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRename();
            }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleRename}
              pending={actionLoading}
              disabled={!!effectiveTransition || !renameValue.trim()}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}
