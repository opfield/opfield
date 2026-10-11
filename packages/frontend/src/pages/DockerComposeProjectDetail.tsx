import {
  Activity,
  Boxes,
  EllipsisVertical,
  ExternalLink,
  FilePenLine,
  FolderOpen,
  GitBranch,
  Hammer,
  HardDrive,
  History,
  Network,
  Pin,
  Play,
  RefreshCw,
  ScrollText,
  Square,
  Terminal,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { AppMembershipLink } from "@/components/apps/AppMembership";
import { MemberIsolatedNotice } from "@/components/apps/IsolatedNotice";
import { confirm } from "@/components/common/ConfirmDialog";
import { ContentLoading } from "@/components/common/ContentLoading";
import { DetailPageSkeleton } from "@/components/common/DetailPageSkeleton";
import { DetailRow } from "@/components/common/DetailRow";
import { Notice } from "@/components/common/Notice";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import {
  type ResponsiveHeaderAction,
  ResponsiveHeaderActions,
} from "@/components/common/ResponsiveHeaderActions";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import {
  ALL_AVAILABILITY_INSTANCES,
  AvailabilityInstanceSelect,
} from "@/components/docker/availability/AvailabilityInstanceSelect";
import {
  AvailabilityProgress,
  isAvailabilityReplacing,
} from "@/components/docker/availability/AvailabilityProgress";
import { AvailabilitySection } from "@/components/docker/availability/AvailabilitySection";
import { AvailabilitySummary } from "@/components/docker/availability/AvailabilitySummary";
import { resolveAvailabilitySurfaceStatus } from "@/components/docker/availability/availability-status";
import { ExternalComposeBadge } from "@/components/docker/ExternalComposeBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatCard } from "@/components/ui/stat-card";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRealtime } from "@/hooks/use-realtime";
import { useUrlTab } from "@/hooks/use-url-tab";
import { createClientUuid } from "@/lib/client-id";
import { canAdoptComposeProject, hasComposeProjectScope } from "@/lib/compose-access";
import { composeServiceRows } from "@/lib/compose-service-availability";
import {
  dockerComposeProjectRoute,
  dockerComposeRootRoute,
  dockerContainerRoute,
} from "@/lib/resource-routes";
import { getReturnNavigationTarget } from "@/lib/return-navigation";
import { scopeMatches } from "@/lib/scope-utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import { handleLicenseApiError, requireLicenseFeature } from "@/stores/license-paywall";
import { usePinnedContainersStore } from "@/stores/pinned-containers";
import type {
  DockerAvailabilityPolicy,
  DockerComposeOperation,
  DockerComposeOperationAction,
  DockerComposeProject,
  DockerComposeRevision,
  NodeDetail,
} from "@/types";
import { ComposeProjectEditor } from "./compose/ComposeProjectEditor";
import { ComposeVariablesTab } from "./compose/ComposeVariablesTab";
import { DockerResourceGitTabs } from "./docker-detail/DockerResourceGitTabs";
import { WorkloadLinkRuntime } from "./docker-detail/LinkRuntimeTab";
import { LogsTab, type LogsTabSource } from "./docker-detail/LogsTab";
import { MultiContainerMonitoring } from "./docker-detail/MultiContainerMonitoring";

const ACTIVE_STATUSES = new Set(["pending", "running", "cancelling", "reconciling"]);

type ComposeService = DockerComposeProject["services"][number];

function projectStatusVariant(status: DockerComposeProject["status"]) {
  if (status === "running") return "success" as const;
  if (status === "failed" || status === "missing") return "destructive" as const;
  if (
    status === "degraded" ||
    status === "applying" ||
    status === "validating" ||
    status === "deleting"
  ) {
    return "warning" as const;
  }
  return "secondary" as const;
}

function operationStatusVariant(status: DockerComposeOperation["status"]) {
  if (status === "succeeded") return "success" as const;
  if (status === "failed") return "destructive" as const;
  if (status === "running" || status === "reconciling") return "warning" as const;
  return "secondary" as const;
}

function formatDuration(startedAt: string | null, completedAt: string | null) {
  if (!startedAt) return "—";
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function operationIcon(action: DockerComposeOperationAction) {
  if (action === "pull_apply" || action === "apply") return UploadCloud;
  if (action === "start") return Play;
  if (action === "stop" || action === "down") return Square;
  if (action === "delete_volumes") return Trash2;
  return RefreshCw;
}

export function DockerComposeProjectDetail() {
  const { projectId = "" } = useParams<{ projectId: string; tab?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { hasScopedAccess, user } = useAuthStore();
  const dockerNodes = useDockerStore((state) => state.dockerNodes);
  const [project, setProject] = useState<DockerComposeProject | null>(null);
  const [availabilityPolicy, setAvailabilityPolicy] = useState<DockerAvailabilityPolicy | null>(
    null
  );
  const [node, setNode] = useState<NodeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<DockerComposeOperationAction | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [selectedServiceName, setSelectedServiceName] = useState<string | null>(null);
  const [selectedLogsPlacementId, setSelectedLogsPlacementId] = useState(
    ALL_AVAILABILITY_INSTANCES
  );
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [adoptOpen, setAdoptOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityDetailsOpen, setActivityDetailsOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [selectedOperation, setSelectedOperation] = useState<DockerComposeOperation | null>(null);
  const [latestOperation, setLatestOperation] = useState<DockerComposeOperation | null>(null);
  const [recentActivity, setRecentActivity] = useState<DockerComposeOperation[]>([]);
  // Recent activity loads right after the project; the Overview tab waits for it.
  const [recentActivityLoading, setRecentActivityLoading] = useState(true);
  const [availabilityLoaded, setAvailabilityLoaded] = useState(false);
  const [activityOperations, setActivityOperations] = useState<DockerComposeOperation[]>([]);
  const [activityNextCursor, setActivityNextCursor] = useState<string | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityLoadingMore, setActivityLoadingMore] = useState(false);
  const [activityRefreshVersion, setActivityRefreshVersion] = useState(0);
  const activityScrollRef = useRef<HTMLDivElement>(null);
  const activitySentinelRef = useRef<HTMLDivElement>(null);
  const { isPinnedDashboard, isPinnedSidebar, toggleDashboard, toggleSidebar } =
    usePinnedContainersStore();
  const [activeTab, setActiveTab] = useUrlTab(
    [
      "overview",
      "services",
      "source",
      "builds",
      "monitoring",
      "configuration",
      "variables",
      "logs",
      "settings",
    ],
    "overview",
    (tab) => dockerComposeProjectRoute(projectId, tab)
  );
  const backTarget = getReturnNavigationTarget(location.state, dockerComposeRootRoute());

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const summaries = await api.listDockerComposeProjects();
      const summary = summaries.find((candidate) => candidate.id === projectId);
      if (!summary) throw new Error("Compose project not found");
      const [detail, nodeDetail] = await Promise.all([
        api.getDockerComposeProject(summary.nodeId, projectId),
        api.getNode(summary.nodeId),
      ]);
      setProject(detail);
      setNode(nodeDetail);
      setLatestOperation(summary.lastOperation ?? null);
      setSelectedServiceName((current) => current ?? detail.services[0]?.name ?? null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load Compose project");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadAvailability = useCallback(async () => {
    if (!projectId) return;
    try {
      setAvailabilityPolicy(
        await api.getDockerAvailability({ type: "compose", composeProjectId: projectId })
      );
    } catch {
      setAvailabilityPolicy(null);
    } finally {
      setAvailabilityLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    void loadAvailability();
  }, [loadAvailability]);
  useRealtime("docker.availability.changed", loadAvailability);
  useRealtime("docker.availability.operation.changed", loadAvailability);

  useRealtime("docker.compose.changed", (payload) => {
    const event = payload as { projectId?: string } | undefined;
    if (event?.projectId && event.projectId !== projectId) return;
    void load();
    setActivityRefreshVersion((current) => current + 1);
  });

  const currentOperation = useMemo(
    () => (latestOperation && ACTIVE_STATUSES.has(latestOperation.status) ? latestOperation : null),
    [latestOperation]
  );

  const loadRecentActivity = useCallback(async () => {
    if (!project) return;
    setRecentActivityLoading(true);
    try {
      const result = await api.listDockerComposeOperations(project.nodeId, project.id, {
        limit: 6,
      });
      setRecentActivity(result.data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load Compose activity");
    } finally {
      setRecentActivityLoading(false);
    }
  }, [project]);

  const loadActivity = useCallback(
    async (cursor?: string) => {
      if (!project) return;
      if (cursor) setActivityLoadingMore(true);
      else setActivityLoading(true);
      try {
        const result = await api.listDockerComposeOperations(project.nodeId, project.id, {
          cursor,
          limit: 50,
        });
        setActivityOperations((current) => {
          if (!cursor) return result.data;
          const existing = new Set(current.map((operation) => operation.id));
          return [...current, ...result.data.filter((operation) => !existing.has(operation.id))];
        });
        setActivityNextCursor(result.nextCursor);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to load Compose activity");
      } finally {
        if (cursor) setActivityLoadingMore(false);
        else setActivityLoading(false);
      }
    },
    [project]
  );

  useEffect(() => {
    if (!project) return;
    void activityRefreshVersion;
    void loadRecentActivity();
  }, [activityRefreshVersion, loadRecentActivity, project]);

  useEffect(() => {
    if (!activityOpen || !project) return;
    void activityRefreshVersion;
    setActivityOperations([]);
    setActivityNextCursor(null);
    void loadActivity();
  }, [activityOpen, activityRefreshVersion, loadActivity, project]);

  useEffect(() => {
    const sentinel = activitySentinelRef.current;
    const root = activityScrollRef.current;
    if (!activityOpen || !sentinel || !root || !activityNextCursor) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !activityLoading && !activityLoadingMore) {
          void loadActivity(activityNextCursor);
        }
      },
      { root, rootMargin: "320px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [activityLoading, activityLoadingMore, activityNextCursor, activityOpen, loadActivity]);

  useEffect(() => {
    if (project?.desiredState === "stopped" && activeTab === "monitoring") {
      setActiveTab("overview");
    }
  }, [activeTab, project?.desiredState, setActiveTab]);

  const canManage =
    !!project &&
    hasComposeProjectScope(user?.scopes ?? [], "docker:compose:manage", project.nodeId, project.id);
  const canAdopt =
    !!project && canAdoptComposeProject(user?.scopes ?? [], project.nodeId, project.id);
  const canDelete =
    !!project &&
    hasComposeProjectScope(user?.scopes ?? [], "docker:compose:delete", project.nodeId, project.id);
  const canUseConsole = hasScopedAccess("docker:containers:console");
  const canReadFiles = hasScopedAccess("docker:containers:files:read");

  const runAction = async (nextAction: DockerComposeOperationAction, revisionId?: string) => {
    if (!project || !requireLicenseFeature("compose-applications", "Compose lifecycle")) return;
    if (
      nextAction === "down" &&
      !(await confirm({
        title: "Bring Project Down",
        description:
          "Stop and remove project containers and non-external networks? Named volumes are preserved.",
        confirmLabel: "Down",
      }))
    ) {
      return;
    }
    setAction(nextAction);
    try {
      await api.startDockerComposeOperation(project.nodeId, project.id, nextAction, {
        revisionId,
        idempotencyKey: createClientUuid(),
      });
      toast.success(
        nextAction === "pull_apply" ? "Pull & Apply started" : `Compose ${nextAction} started`
      );
      await load();
    } catch (error) {
      if (!handleLicenseApiError(error, "Compose lifecycle")) {
        toast.error(error instanceof Error ? error.message : "Compose operation failed");
      }
    } finally {
      setAction(null);
    }
  };

  const deleteProject = async () => {
    if (
      !project ||
      !(await confirm({
        title: "Delete Compose Project",
        description:
          "Permanently remove this project, its containers, non-external networks, project-owned volumes, revisions, and secrets? External resources are not deleted.",
        confirmLabel: "Delete everything",
      }))
    ) {
      return;
    }
    setDeleting(true);
    try {
      await api.deleteDockerComposeProject(project.nodeId, project.id);
      toast.success("Compose project and runtime resources deleted");
      navigate(dockerComposeRootRoute(), { replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete Compose project");
    } finally {
      setDeleting(false);
    }
  };

  const deleteRevision = async (revision: DockerComposeRevision) => {
    if (
      !project ||
      revision.id === project.activeRevisionId ||
      !(await confirm({
        title: `Delete Revision ${revision.revisionNumber}`,
        description:
          "Delete this inactive immutable revision? Existing operation history remains, but this configuration can no longer be reapplied.",
        confirmLabel: "Delete revision",
      }))
    ) {
      return;
    }
    try {
      await api.deleteDockerComposeRevision(project.nodeId, project.id, revision.id);
      toast.success(`Revision ${revision.revisionNumber} deleted`);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete revision");
    }
  };

  // Same gate as the Availability routes; the Settings tab holds only Availability, so it goes too.
  const canManageAvailability =
    !!project &&
    scopeMatches(user?.scopes ?? [], `docker:availability:manage:${project.nodeId}/${project.id}`);
  useEffect(() => {
    if (project && !canManageAvailability && activeTab === "settings") setActiveTab("overview");
  }, [activeTab, canManageAvailability, project, setActiveTab]);

  if (loading) return <DetailPageSkeleton label="Loading Compose project" tabs={8} />;
  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Compose project not found
      </div>
    );
  }

  const displayedServices = composeServiceRows(project, availabilityPolicy);
  const selectedService =
    displayedServices.find((service) => service.name === selectedServiceName) ??
    displayedServices[0];
  const monitoredServices = displayedServices.filter(
    (service) => service.state === "running" && Boolean(service.containerIds[0])
  );
  const inactiveRevisions = (project.revisions ?? []).filter(
    (revision) => revision.id !== project.activeRevisionId
  );
  const awaitingInitialBuild = project.managementState === "managed" && !project.activeRevisionId;
  const pinAction: ResponsiveHeaderAction = {
    label: "Pin",
    icon: <Pin className="h-4 w-4" />,
    onClick: () => setPinOpen(true),
  };
  const headerActions: Array<ResponsiveHeaderAction & { actionKey?: string }> =
    project.managementState === "external"
      ? canAdopt
        ? [
            pinAction,
            {
              label: "Adopt into Gateway",
              icon: <UploadCloud className="h-4 w-4" />,
              onClick: async () => {
                if (
                  await confirm({
                    title: `Adopt ${project.name}`,
                    description:
                      "Bring this external Compose project under Gateway lifecycle and immutable revision management?",
                    confirmLabel: "Adopt project",
                  })
                )
                  setAdoptOpen(true);
              },
            },
          ]
        : [pinAction]
      : [
          pinAction,
          { label: "Refresh", icon: <RefreshCw className="h-4 w-4" />, onClick: () => void load() },
          ...(canManage
            ? [
                {
                  label: project.status === "running" ? "Stop" : "Start",
                  actionKey: project.status === "running" ? "stop" : "start",
                  icon:
                    project.status === "running" ? (
                      <Square className="h-4 w-4" />
                    ) : (
                      <Play className="h-4 w-4" />
                    ),
                  onClick: () => void runAction(project.status === "running" ? "stop" : "start"),
                  disabled:
                    awaitingInitialBuild ||
                    !!currentOperation ||
                    !!action ||
                    project.status === "deleting",
                  disabledReason: awaitingInitialBuild
                    ? "Build and deploy the first revision from Source"
                    : undefined,
                },
                {
                  label: "Pull & Apply",
                  actionKey: "pull_apply",
                  icon: <UploadCloud className="h-4 w-4" />,
                  onClick: () => void runAction("pull_apply"),
                  disabled:
                    awaitingInitialBuild ||
                    !!currentOperation ||
                    !!action ||
                    project.status === "deleting",
                  disabledReason: awaitingInitialBuild
                    ? "Build and deploy the first revision from Source"
                    : undefined,
                },
                {
                  label: "Change revision",
                  icon: <History className="h-4 w-4" />,
                  onClick: () => setRevisionsOpen(true),
                  disabled:
                    !!currentOperation ||
                    project.status === "deleting" ||
                    inactiveRevisions.length === 0,
                  disabledReason: currentOperation
                    ? "Wait for the active operation to finish"
                    : inactiveRevisions.length === 0
                      ? "No previous revisions"
                      : undefined,
                  alwaysOverflow: true,
                },
                ...(currentOperation
                  ? [
                      {
                        label: "Cancel operation",
                        actionKey: "cancel",
                        onClick: () => void runAction("cancel"),
                        destructive: true,
                      },
                    ]
                  : []),
              ]
            : []),
          ...(canDelete
            ? [
                {
                  label: "Delete project",
                  actionKey: "delete",
                  icon: <Trash2 className="h-4 w-4" />,
                  onClick: () => void deleteProject(),
                  disabled: !!currentOperation || deleting || project.status === "deleting",
                  disabledReason: currentOperation
                    ? "Wait for the active operation to finish"
                    : deleting || project.status === "deleting"
                      ? "Deleting project runtime resources"
                      : undefined,
                  destructive: true,
                  separatorBefore: true,
                },
              ]
            : []),
        ];

  const openContainerTarget = async (service: ComposeService, tab?: string) => {
    if (isAvailabilityReplacing(availabilityPolicy) || currentOperation) return;
    setSelectedServiceName(service.name);
    try {
      let targetNodeId = project.nodeId;
      let containerId = service.containerIds[0];
      if (availabilityPolicy && availabilityPolicy.mode !== "single") {
        const latestPolicy = await api.getDockerAvailability({
          type: "compose",
          composeProjectId: project.id,
        });
        setAvailabilityPolicy(latestPolicy);
        if (!latestPolicy || isAvailabilityReplacing(latestPolicy)) {
          toast.info("The workload is being replaced. Wait for the operation to finish.");
          return;
        }
        const target = latestPolicy.placements
          .flatMap((placement) => {
            if (!placement.serving || placement.actualState !== "serving") return [];
            const containers = Array.isArray(placement.runtimeIdentity.containers)
              ? (placement.runtimeIdentity.containers as Array<Record<string, unknown>>)
              : [];
            return containers
              .filter((container) => container.serviceName === service.name)
              .map((container) => ({
                nodeId: placement.nodeId,
                containerId: String(container.containerId ?? container.containerName ?? ""),
              }));
          })
          .find((candidate) => candidate.containerId);
        if (!target) {
          toast.info("No serving instance is available for this service yet.");
          return;
        }
        targetNodeId = target.nodeId;
        containerId = target.containerId;
      }
      if (!containerId) return;
      const targetNode =
        targetNodeId === node?.id
          ? node
          : (dockerNodes.find((candidate) => candidate.id === targetNodeId) ??
            (await api.getNode(targetNodeId)));
      if (!targetNode?.slug) return;
      const container = await api.inspectContainer(targetNodeId, containerId, true);
      const canonicalName = String(container.Name ?? container.name ?? "").replace(/^\/+/, "");
      if (!canonicalName) throw new Error("Container identity is missing");
      navigate(dockerContainerRoute(targetNode.slug, canonicalName, tab), {
        state: { returnTo: location.pathname },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to open the service container");
    }
  };

  const serviceColumns: DataTableColumn<ComposeService>[] = [
    {
      key: "service",
      header: "Service",
      width: "minmax(180px, 1fr)",
      render: (service) => (
        <span className="inline-flex items-center gap-2 font-medium">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
            <Boxes className="h-4 w-4 text-muted-foreground" />
          </span>
          {service.name}
        </span>
      ),
    },
    {
      key: "image",
      header: "Image",
      width: "minmax(260px, 1.6fr)",
      truncate: true,
      render: (service) => (
        <span className="font-mono text-xs">
          {serviceDisplayImage(service.name, service.image) || "—"}
        </span>
      ),
    },
    {
      key: "state",
      header: "State",
      width: "140px",
      render: (service) => (
        <Badge
          variant={
            isAvailabilityReplacing(availabilityPolicy) || currentOperation
              ? "warning"
              : service.state === "running"
                ? "success"
                : "secondary"
          }
        >
          {isAvailabilityReplacing(availabilityPolicy)
            ? availabilityStatus?.replaceAll("_", " ") || "Replacing"
            : currentOperation
              ? currentOperation.action.replaceAll("_", " ")
              : service.state}
        </Badge>
      ),
    },
    {
      key: "health",
      header: "Health",
      width: "130px",
      render: (service) => (
        <Badge variant={service.health === "healthy" ? "success" : "secondary"}>
          {service.health}
        </Badge>
      ),
    },
    {
      key: "containers",
      header: "Containers",
      width: "110px",
      align: "right",
      render: (service) => <Badge variant="secondary">{service.containerIds.length}</Badge>,
    },
    {
      key: "actions",
      header: "Actions",
      width: "110px",
      align: "right",
      render: (service) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              disabled={
                service.containerIds.length === 0 ||
                isAvailabilityReplacing(availabilityPolicy) ||
                Boolean(currentOperation)
              }
              aria-label={`Actions for ${service.name}`}
              title={`Actions for ${service.name}`}
              onClick={(event) => event.stopPropagation()}
            >
              <EllipsisVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
            <DropdownMenuItem onSelect={() => void openContainerTarget(service)}>
              <ExternalLink className="mr-2 h-4 w-4" />
              Container details
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void openContainerTarget(service, "logs")}>
              <ScrollText className="mr-2 h-4 w-4" />
              Logs
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void openContainerTarget(service, "stats")}>
              <Activity className="mr-2 h-4 w-4" />
              Monitoring
            </DropdownMenuItem>
            {(canUseConsole || canReadFiles) && <DropdownMenuSeparator />}
            {canUseConsole && (
              <DropdownMenuItem onSelect={() => void openContainerTarget(service, "console")}>
                <Terminal className="mr-2 h-4 w-4" />
                Console
              </DropdownMenuItem>
            )}
            {canReadFiles && (
              <DropdownMenuItem onSelect={() => void openContainerTarget(service, "files")}>
                <FolderOpen className="mr-2 h-4 w-4" />
                Files
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  const revisionColumns: DataTableColumn<DockerComposeRevision>[] = [
    {
      key: "revision",
      header: "Revision",
      width: "110px",
      render: (revision) => (
        <span className="flex items-center gap-2 font-medium">
          <History className="h-4 w-4 text-muted-foreground" />#{revision.revisionNumber}
        </span>
      ),
    },
    {
      key: "digest",
      header: "Digest",
      width: "minmax(190px, 1fr)",
      truncate: true,
      render: (revision) => <code className="text-xs">{revision.configDigest}</code>,
    },
    {
      key: "created",
      header: "Created",
      width: "110px",
      render: (revision) => (
        <RelativeTime value={revision.createdAt} className="text-muted-foreground" />
      ),
    },
    {
      key: "actions",
      header: "Actions",
      width: "80px",
      align: "right",
      render: (revision) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" onClick={(event) => event.stopPropagation()}>
              <EllipsisVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
            <DropdownMenuItem
              disabled={!!currentOperation || revision.id === project.activeRevisionId}
              onSelect={() => void runAction("pull_apply", revision.id)}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Reapply
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              disabled={revision.id === project.activeRevisionId}
              onSelect={() => void deleteRevision(revision)}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete revision
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  const recentActivityColumns: SimpleTableColumn<DockerComposeOperation>[] = [
    {
      id: "type",
      header: "Type",
      render: (operation) => {
        const Icon = operationIcon(operation.action);
        return (
          <span className="inline-flex items-center gap-2 font-medium">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
              <Icon className="h-4 w-4 text-muted-foreground" />
            </span>
            {operation.action.replaceAll("_", " ")}
          </span>
        );
      },
    },
    {
      id: "status",
      header: "Status",
      render: (operation) => (
        <Badge variant={operationStatusVariant(operation.status)}>{operation.status}</Badge>
      ),
    },
    {
      id: "progress",
      header: "Progress / error",
      cellClassName: "max-w-0 truncate",
      render: (operation) => (
        <span className={operation.error ? "text-destructive" : "text-muted-foreground"}>
          {operation.error || operation.progress || "—"}
        </span>
      ),
    },
    {
      id: "started",
      header: "Started",
      render: (operation) => (
        <RelativeTime value={operation.createdAt} className="text-muted-foreground" />
      ),
    },
    {
      id: "duration",
      header: "Duration",
      align: "right",
      cellClassName: "text-muted-foreground",
      render: (operation) => formatDuration(operation.startedAt, operation.completedAt),
    },
  ];

  const activityColumns: DataTableColumn<DockerComposeOperation>[] = [
    {
      key: "type",
      header: "Type",
      width: "minmax(220px, 1.2fr)",
      render: (operation) => {
        const Icon = operationIcon(operation.action);
        return (
          <span className="inline-flex items-center gap-2 font-medium">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
              <Icon className="h-4 w-4 text-muted-foreground" />
            </span>
            {operation.action.replaceAll("_", " ")}
          </span>
        );
      },
    },
    {
      key: "status",
      header: "Status",
      width: "130px",
      render: (operation) => (
        <Badge variant={operationStatusVariant(operation.status)}>{operation.status}</Badge>
      ),
    },
    {
      key: "progress",
      header: "Progress / error",
      width: "minmax(240px, 1.5fr)",
      truncate: true,
      render: (operation) => (
        <span className={operation.error ? "text-destructive" : "text-muted-foreground"}>
          {operation.error || operation.progress || "—"}
        </span>
      ),
    },
    {
      key: "started",
      header: "Started",
      width: "190px",
      render: (operation) => (
        <RelativeTime value={operation.createdAt} className="text-muted-foreground" />
      ),
    },
    {
      key: "duration",
      header: "Duration",
      width: "100px",
      align: "right",
      render: (operation) => (
        <span className="text-muted-foreground">
          {formatDuration(operation.startedAt, operation.completedAt)}
        </span>
      ),
    },
  ];

  const activityTableHeight = activityOperations.length
    ? 49 + activityOperations.length * 49 + (activityNextCursor ? 44 : 0)
    : undefined;

  const openActivity = () => {
    setActivityOperations([]);
    setActivityNextCursor(null);
    setActivityLoading(true);
    setActivityLoadingMore(false);
    setActivityOpen(true);
  };

  const logsSource: LogsTabSource = {
    channelId: `compose:${project.nodeId}:${project.name}`,
    title: "Compose logs",
    description: selectedService
      ? `Aggregated project output. Selected service: ${selectedService.name}.`
      : "Aggregated stdout and stderr output from project services.",
    state: project.status,
    downloadFileName: `compose-${project.name}-logs.txt`,
    createWebSocket: (tail) => {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      return new WebSocket(
        `${proto}//${window.location.host}/api/docker/nodes/${project.nodeId}/compose/${encodeURIComponent(project.name)}/logs/stream?tail=${tail}`
      );
    },
    getLogs: async () => [],
    popoutUrl: `/docker/compose-logs/${project.nodeId}/${encodeURIComponent(project.name)}`,
  };

  const usesInternalScroll = new Set(["services", "configuration", "logs"]).has(activeTab);
  const availabilityActive =
    availabilityPolicy?.mode !== undefined && availabilityPolicy.mode !== "single";
  const availabilityLogSources = availabilityActive
    ? (availabilityPolicy?.placements ?? []).flatMap((placement) => {
        if (!placement.serving || placement.actualState !== "serving") return [];
        const runtimeContainers = Array.isArray(placement.runtimeIdentity?.containers)
          ? (placement.runtimeIdentity.containers as Array<Record<string, unknown>>)
          : [];
        const runtimeContainer = runtimeContainers.find(
          (candidate) => String(candidate.serviceName ?? "") === selectedService?.name
        );
        const containerId = String(
          runtimeContainer?.containerId ?? runtimeContainer?.containerName ?? ""
        );
        if (!containerId) return [];
        const runtimeNode = dockerNodes.find((candidate) => candidate.id === placement.nodeId);
        const nodeTitle =
          runtimeNode?.displayName ||
          runtimeNode?.hostname ||
          runtimeNode?.slug ||
          placement.nodeId.slice(0, 8);
        return [
          {
            channelId: placement.id,
            runtimeKey: `${placement.nodeId}:${containerId}`,
            title: nodeTitle,
            description: `${selectedService?.name ?? "Service"} output from ${nodeTitle}`,
            state: "running",
            downloadFileName: `compose-${project.name}-${selectedService?.name ?? "service"}-${nodeTitle}-logs.txt`,
            createWebSocket: (tail: number) =>
              api.createLogStreamWebSocket(placement.nodeId, containerId, tail),
            getLogs: (params: { tail?: number; timestamps?: boolean }) =>
              api.getContainerLogs(placement.nodeId, containerId, params),
            popoutUrl: `/docker/logs/${placement.nodeId}/${containerId}`,
          },
        ];
      })
    : [];
  const serviceDisplayImage = (serviceName: string, runtimeImage?: string) =>
    availabilityActive
      ? project.activeRevision?.normalizedModel.services[serviceName]?.image || runtimeImage
      : runtimeImage;
  const availabilityMonitoringInstances = availabilityActive
    ? (availabilityPolicy?.placements ?? []).flatMap((placement) => {
        if (!placement.serving || placement.actualState !== "serving") return [];
        const runtimeContainers = Array.isArray(placement.runtimeIdentity?.containers)
          ? (placement.runtimeIdentity.containers as Array<Record<string, unknown>>)
          : [];
        const runtimeNode = dockerNodes.find((candidate) => candidate.id === placement.nodeId);
        const nodeTitle =
          runtimeNode?.displayName ||
          runtimeNode?.hostname ||
          runtimeNode?.slug ||
          placement.nodeId.slice(0, 8);
        return runtimeContainers.flatMap((runtimeContainer, index) => {
          const containerId = String(
            runtimeContainer.containerId ?? runtimeContainer.containerName ?? ""
          );
          if (!containerId) return [];
          const serviceName = String(runtimeContainer.serviceName ?? `Service ${index + 1}`);
          return [
            {
              id: `${placement.id}:${containerId}`,
              groupTitle: nodeTitle,
              title: serviceName,
              description:
                serviceDisplayImage(serviceName, String(runtimeContainer.image ?? "")) ||
                project.name,
              nodeId: placement.nodeId,
              containerId,
            },
          ];
        });
      })
    : [];
  const composeMonitoringInstances =
    availabilityMonitoringInstances.length > 0
      ? availabilityMonitoringInstances
      : monitoredServices.map((service) => ({
          id: `${project.nodeId}:${service.name}:${service.containerIds[0]}`,
          groupTitle: availabilityActive
            ? node?.displayName || node?.hostname || project.nodeId
            : undefined,
          title: service.name,
          description: serviceDisplayImage(service.name, service.image),
          nodeId: project.nodeId,
          containerId: service.containerIds[0]!,
        }));
  const availabilityServing =
    availabilityPolicy?.placements.filter(
      (placement) => placement.serving && placement.actualState === "serving"
    ).length ?? 0;
  const availabilityDesired =
    availabilityPolicy?.mode === "replicated" ? availabilityPolicy.desiredReplicaCount : 1;
  const availabilityStatus =
    availabilityActive && availabilityPolicy
      ? resolveAvailabilitySurfaceStatus({
          policyStatus: availabilityPolicy.status,
          operation: availabilityPolicy.latestOperation,
          shouldRun: availabilityPolicy.shouldRun,
          serving: availabilityServing,
          desired: availabilityDesired,
        })
      : null;
  const displayedDrift = availabilityActive ? false : project.drifted;
  const logicalServiceCount = availabilityActive
    ? (availabilityPolicy.serviceCount ??
      Object.keys(project.activeRevision?.normalizedModel.services ?? {}).length)
    : project.serviceCount;
  const availabilityBadgeVariant =
    availabilityStatus === "online"
      ? ("success" as const)
      : availabilityStatus === "offline" || availabilityStatus === "failed"
        ? ("destructive" as const)
        : availabilityStatus &&
            ["degraded", "rolling_out", "starting", "stopping", "restarting"].includes(
              availabilityStatus
            )
          ? ("warning" as const)
          : availabilityStatus === "stopped"
            ? ("secondary" as const)
            : null;

  return (
    <PageTransition>
      <div
        className={`flex h-full flex-col gap-4 p-6 ${
          usesInternalScroll ? "overflow-hidden" : "overflow-y-auto"
        }`}
      >
        <ContentLoading loading={!availabilityLoaded} />
        <PageHeader
          className="shrink-0"
          leading={<PageBackButton onClick={() => navigate(backTarget)} />}
          title={project.name}
          badges={
            <>
              {project.managementState === "external" && <ExternalComposeBadge />}
              <Badge
                size="inline"
                className="shrink-0"
                variant={
                  availabilityBadgeVariant ??
                  (project.drifted ? "warning" : projectStatusVariant(project.status))
                }
              >
                {String(
                  availabilityStatus ?? (project.drifted ? "Drift" : project.status)
                ).replaceAll("_", " ")}
              </Badge>
            </>
          }
          description={
            <>
              {availabilityActive
                ? "Availability"
                : node?.displayName || node?.hostname || project.nodeId}{" "}
              · {logicalServiceCount} {logicalServiceCount === 1 ? "service" : "services"}
              {project.app ? (
                <>
                  {" · "}
                  <AppMembershipLink app={project.app} />
                </>
              ) : null}
            </>
          }
          actions={
            <ResponsiveHeaderActions actions={headerActions}>
              {headerActions.map((headerAction) => {
                const pending =
                  headerAction.actionKey === "delete"
                    ? deleting
                    : !!headerAction.actionKey && action === headerAction.actionKey;
                return (
                  <Button
                    key={headerAction.label}
                    variant={headerAction.label === "Pull & Apply" ? "default" : "outline"}
                    size={headerAction.label === "Pin" ? "icon" : "default"}
                    disabled={headerAction.disabled}
                    pending={pending}
                    title={headerAction.disabled ? headerAction.disabledReason : undefined}
                    onClick={headerAction.onClick}
                  >
                    {pending ? null : headerAction.icon}
                    {headerAction.label === "Pin" ? null : headerAction.label}
                  </Button>
                );
              })}
            </ResponsiveHeaderActions>
          }
        />

        <MemberIsolatedNotice app={project.app} />

        {project.availability === "unavailable" && (
          <Notice
            tone="warning"
            icon={Activity}
            className="shrink-0"
            title="The node snapshot is unavailable"
          >
            <p>Last known Compose metadata is shown.</p>
          </Notice>
        )}
        <AvailabilityProgress policy={availabilityPolicy} fallbackOperation={currentOperation} />
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="shrink-0">
            <TabsTrigger value="overview" className="gap-1.5">
              Overview
            </TabsTrigger>
            <TabsTrigger value="services" className="gap-1.5">
              <Boxes className="h-3.5 w-3.5" /> Services
            </TabsTrigger>
            <TabsTrigger value="source" className="gap-1.5">
              <GitBranch className="h-3.5 w-3.5" /> Source
            </TabsTrigger>
            <TabsTrigger value="builds" className="gap-1.5">
              <Hammer className="h-3.5 w-3.5" /> Builds
            </TabsTrigger>
            <TabsTrigger
              value="monitoring"
              className="gap-1.5"
              disabled={project.desiredState === "stopped"}
            >
              Monitoring
            </TabsTrigger>
            <TabsTrigger value="configuration" className="gap-1.5">
              Configuration
            </TabsTrigger>
            <TabsTrigger value="variables" className="gap-1.5">
              Variables
            </TabsTrigger>
            <TabsTrigger value="logs" className="gap-1.5">
              Logs
            </TabsTrigger>
            {canManageAvailability && <TabsTrigger value="settings">Settings</TabsTrigger>}
          </TabsList>

          <TabsContent value="overview" className="pb-6">
            <div className="space-y-4">
              <AvailabilitySummary resource={{ type: "compose", composeProjectId: project.id }} />
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard
                  label="Services"
                  value={`${displayedServices.filter((service) => service.state === "running").length}/${displayedServices.length}`}
                  icon={Boxes}
                  subtitle="running"
                />
                <StatCard
                  label="Healthy"
                  value={`${displayedServices.filter((service) => service.health === "healthy").length}/${displayedServices.length}`}
                  icon={Activity}
                  subtitle="service health"
                />
                <StatCard
                  label="Volumes"
                  value={String(project.volumeNames.length)}
                  icon={HardDrive}
                  subtitle="named project volumes"
                />
                <StatCard
                  label="Networks"
                  value={String(project.networkNames.length)}
                  icon={Network}
                  subtitle="project and external"
                />
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <PanelShell
                  title="Project"
                  icon={<Boxes className="h-4 w-4" />}
                  description="Identity, node placement and management boundary."
                  bodyClassName="divide-y divide-border"
                >
                  <DetailRow
                    label="Project ID"
                    value={<code className="text-xs">{project.id}</code>}
                  />
                  <DetailRow
                    label="Node"
                    value={node?.displayName || node?.hostname || project.nodeId}
                  />
                  <DetailRow label="Management" value={project.managementState} />
                  <DetailRow label="Desired state" value={project.desiredState} />
                  <DetailRow label="Availability" value={project.availability} />
                </PanelShell>
                <PanelShell
                  title="Runtime"
                  icon={<Activity className="h-4 w-4" />}
                  description="Current node-observed state and drift status."
                  bodyClassName="divide-y divide-border"
                >
                  <DetailRow
                    label="Active revision"
                    value={
                      project.activeRevision ? `#${project.activeRevision.revisionNumber}` : "—"
                    }
                  />
                  <DetailRow
                    label="Last seen"
                    value={<RelativeTime value={project.lastSeenAt} />}
                  />
                  <DetailRow label="Volumes" value={project.volumeNames.join(", ") || "—"} />
                  <DetailRow label="Networks" value={project.networkNames.join(", ") || "—"} />
                  <DetailRow
                    label="Drift"
                    value={
                      <Badge variant={displayedDrift ? "warning" : "success"}>
                        {displayedDrift ? "Detected" : "None"}
                      </Badge>
                    }
                  />
                </PanelShell>
              </div>
              <WorkloadLinkRuntime
                nodeId={project.nodeId}
                targetType="compose_service"
                targetResourceId={project.id}
              />
              <PanelShell
                title="Recent activity"
                icon={<History className="h-4 w-4" />}
                description="The six latest Compose lifecycle operations."
                actions={
                  <Button
                    variant="quiet"
                    size="inline"
                    className="text-sm font-normal"
                    onClick={openActivity}
                  >
                    View all
                  </Button>
                }
              >
                <SimpleTable
                  columns={recentActivityColumns}
                  rows={recentActivity}
                  getRowKey={(operation) => operation.id}
                  loading={recentActivityLoading}
                  loadingMessage="Loading activity..."
                  emptyMessage="No operations yet."
                  tableClassName="min-w-[800px] table-fixed"
                  onRowClick={(operation) => {
                    setSelectedOperation(operation);
                    setActivityDetailsOpen(true);
                  }}
                />
              </PanelShell>
            </div>
          </TabsContent>

          <TabsContent value="services" className="flex min-h-0 flex-1 flex-col pb-0">
            <PanelShell
              title="Services"
              description="Observed services and owned containers. Use a new revision to remove a service; direct container mutations are disabled."
              className="flex h-fit max-h-full min-h-0 flex-col"
              bodyClassName="flex min-h-0 flex-1 p-0"
            >
              <DataTable
                columns={serviceColumns}
                data={displayedServices}
                keyFn={(service) => service.name}
                onRowClick={
                  isAvailabilityReplacing(availabilityPolicy) || currentOperation
                    ? undefined
                    : (service) => void openContainerTarget(service)
                }
                emptyMessage="No runtime services observed."
                horizontalScroll
                minWidth="900px"
                embedded
                className="h-fit w-full max-h-full [&_[data-route-scroll-container]]:flex-1"
              />
            </PanelShell>
          </TabsContent>

          <TabsContent value="source" className="pb-6">
            <DockerResourceGitTabs
              target={{
                kind: "compose_project",
                nodeId: project.nodeId,
                composeProjectId: project.id,
              }}
              view="source"
              composeVariables={project.activeRevision?.variables ?? {}}
              composeSecretKeys={project.activeRevision?.secretKeys ?? []}
            />
          </TabsContent>

          <TabsContent value="builds" className="flex min-h-0 flex-1 flex-col pb-0">
            <DockerResourceGitTabs
              target={{
                kind: "compose_project",
                nodeId: project.nodeId,
                composeProjectId: project.id,
              }}
              view="builds"
            />
          </TabsContent>

          <TabsContent value="monitoring" className="pb-0">
            <MultiContainerMonitoring instances={composeMonitoringInstances} />
          </TabsContent>

          <TabsContent value="configuration" className="flex min-h-0 flex-1 flex-col pb-0">
            <PanelShell
              title="Active immutable configuration"
              description="Gateway-stored Compose YAML for the active revision. Editing creates a new immutable revision."
              actions={
                project.managementState === "managed" && canManage ? (
                  <Button onClick={() => setRevisionOpen(true)}>
                    <FilePenLine className="mr-1 h-4 w-4" /> New revision
                  </Button>
                ) : null
              }
              className="flex min-h-0 flex-1 flex-col"
              bodyClassName="flex min-h-0 flex-1 p-0"
            >
              {project.activeRevision ? (
                <CodeEditor
                  value={project.activeRevision.sourceYaml}
                  onChange={() => {}}
                  readOnly
                  language="yaml"
                  minHeight="0"
                  height="100%"
                  bordered={false}
                />
              ) : (
                <p className="p-4 text-sm text-muted-foreground">
                  No Gateway-managed configuration. Adopt the external project by supplying complete
                  YAML.
                </p>
              )}
            </PanelShell>
          </TabsContent>

          <TabsContent value="variables" className="pb-0">
            <ComposeVariablesTab project={project} canManage={canManage} onApplied={load} />
          </TabsContent>
          {canManageAvailability && (
            <TabsContent value="settings" className="pb-6">
              <AvailabilitySection
                resource={{ type: "compose", composeProjectId: project.id }}
                canManage
              />
            </TabsContent>
          )}

          <TabsContent value="logs" className="flex min-h-0 flex-1 flex-col pb-0">
            {availabilityActive && availabilityLogSources.length > 0 ? (
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
                    placements={availabilityPolicy!.placements.filter(
                      (placement) => placement.serving && placement.actualState === "serving"
                    )}
                    nodes={dockerNodes}
                    value={selectedLogsPlacementId}
                    onValueChange={setSelectedLogsPlacementId}
                    includeAll
                  />
                }
              />
            ) : (
              <LogsTab source={logsSource} />
            )}
          </TabsContent>
        </Tabs>
      </div>
      <Dialog open={adoptOpen} onOpenChange={setAdoptOpen}>
        <DialogContent clipOverflow className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Adopt Compose Project</DialogTitle>
            <DialogDescription>
              Review the complete configuration before adopting {project.name}.
            </DialogDescription>
          </DialogHeader>
          <ComposeProjectEditor
            projectIdOverride={project.id}
            adoptionOverride
            onClose={() => {
              setAdoptOpen(false);
              void load();
            }}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={revisionOpen} onOpenChange={setRevisionOpen}>
        <DialogContent clipOverflow className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>New Revision for {project.name}</DialogTitle>
            <DialogDescription>
              Edit the Compose YAML. Applying creates a new immutable revision.
            </DialogDescription>
          </DialogHeader>
          <ComposeProjectEditor
            projectIdOverride={project.id}
            compactRevision
            onClose={() => {
              setRevisionOpen(false);
              void load();
            }}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={revisionsOpen} onOpenChange={setRevisionsOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Change Revision</DialogTitle>
            <DialogDescription>
              Reapply an immutable revision or remove an inactive revision.
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-hidden border border-border">
            <DataTable
              columns={revisionColumns}
              data={inactiveRevisions}
              keyFn={(revision) => revision.id}
              emptyMessage="No revisions."
              horizontalScroll
              minWidth="520px"
              embedded
            />
          </div>
          {project.managementState === "managed" && canManage && (
            <div className="flex justify-end">
              <Button
                onClick={() => {
                  setRevisionsOpen(false);
                  setRevisionOpen(true);
                }}
              >
                <FilePenLine className="mr-1 h-4 w-4" /> New revision
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={activityOpen} onOpenChange={setActivityOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-h-[92dvh] sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Compose Activity</DialogTitle>
            <DialogDescription>
              Lifecycle operation history. Scroll the table to load older operations.
            </DialogDescription>
          </DialogHeader>
          <div
            className="max-h-[min(70dvh,44rem)] overflow-hidden"
            style={activityTableHeight ? { height: activityTableHeight } : undefined}
          >
            <DataTable
              columns={activityColumns}
              data={activityOperations}
              loading={activityLoading && activityOperations.length === 0}
              keyFn={(operation) => operation.id}
              emptyMessage="No operations yet."
              horizontalScroll
              minWidth="900px"
              className="h-full w-full"
              scrollRef={activityScrollRef}
              footer={
                activityNextCursor ? (
                  <div
                    ref={activitySentinelRef}
                    className="p-3 text-center text-xs text-muted-foreground"
                  >
                    {activityLoadingMore
                      ? "Loading older activity..."
                      : "Scroll to load older activity"}
                  </div>
                ) : null
              }
              onRowClick={(operation) => {
                setSelectedOperation(operation);
                setActivityDetailsOpen(true);
              }}
            />
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={activityDetailsOpen} onOpenChange={setActivityDetailsOpen}>
        <DialogContent
          className="sm:max-w-xl"
          onAnimationEnd={(event) => {
            if (
              event.target === event.currentTarget &&
              event.currentTarget.dataset.state === "closed"
            ) {
              setSelectedOperation(null);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Activity Details</DialogTitle>
            <DialogDescription>
              Compose lifecycle operation and immutable revision reference.
            </DialogDescription>
          </DialogHeader>
          {selectedOperation && (
            <div className="divide-y divide-border border border-border">
              <DetailRow label="Action" value={selectedOperation.action.replaceAll("_", " ")} />
              <DetailRow
                label="Status"
                value={
                  <Badge variant={operationStatusVariant(selectedOperation.status)}>
                    {selectedOperation.status}
                  </Badge>
                }
              />
              <DetailRow
                label="Operation ID"
                value={<code className="text-xs">{selectedOperation.id}</code>}
              />
              <DetailRow
                label="Revision"
                value={
                  selectedOperation.revisionId ? (
                    <code className="text-xs">{selectedOperation.revisionId}</code>
                  ) : (
                    "—"
                  )
                }
              />
              <DetailRow label="Progress" value={selectedOperation.progress || "—"} />
              <DetailRow
                label="Error"
                value={
                  selectedOperation.error ? (
                    <span className="whitespace-pre-wrap break-words text-left text-sm text-destructive">
                      {selectedOperation.error}
                    </span>
                  ) : (
                    "—"
                  )
                }
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={pinOpen} onOpenChange={setPinOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Pin Compose Project</DialogTitle>
            <DialogDescription>Choose where {project.name} should stay visible.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Add to dashboard</p>
                <p className="text-xs text-muted-foreground">Show compact lifecycle status</p>
              </div>
              <Switch
                checked={isPinnedDashboard(project.id)}
                onChange={() => {
                  toggleDashboard(project.id, {
                    nodeId: project.nodeId,
                    nodeSlug: node?.slug ?? project.nodeId,
                    name: project.name,
                    state: project.status,
                    kind: "compose",
                    scopeBase: "docker:compose:view",
                    scopeResourceId: project.id,
                  });
                  usePinnedContainersStore.getState().invalidate();
                }}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Add to sidebar</p>
                <p className="text-xs text-muted-foreground">Quick access from navigation</p>
              </div>
              <Switch
                checked={isPinnedSidebar(project.id)}
                onChange={() => {
                  toggleSidebar(project.id, {
                    nodeId: project.nodeId,
                    nodeSlug: node?.slug ?? project.nodeId,
                    name: project.name,
                    state: project.status,
                    kind: "compose",
                    scopeBase: "docker:compose:view",
                    scopeResourceId: project.id,
                  });
                  usePinnedContainersStore.getState().invalidate();
                }}
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}
