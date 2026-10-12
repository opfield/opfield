import {
  Boxes,
  FolderPlus,
  Import,
  Loader2,
  Play,
  RefreshCw,
  Square,
  UploadCloud,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AppMemberBadge } from "@/components/apps/AppMembership";
import { MoveToAppDialog } from "@/components/apps/MoveToAppDialog";
import { MoveToAppRowMenu } from "@/components/apps/MoveToAppRowMenu";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { DockerFolderedResourceList } from "@/components/docker/DockerFolderedResourceList";
import { ExternalComposeBadge } from "@/components/docker/ExternalComposeBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RefreshButton } from "@/components/ui/refresh-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TruncateStart } from "@/components/ui/truncate-start";
import { useCanManageSomeFolders } from "@/hooks/use-folder-access";
import { useRealtime } from "@/hooks/use-realtime";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { toastApiError } from "@/lib/api-error-toast";
import { NORMAL_LIST_FILTER } from "@/lib/app-members";
import { createClientUuid } from "@/lib/client-id";
import { canAdoptComposeProject, hasComposeProjectScope } from "@/lib/compose-access";
import { loadVisibleDockerNodes } from "@/lib/docker-node-access";
import { nodeBadgeClassName } from "@/lib/node-appearance";
import { dockerComposeProjectRoute } from "@/lib/resource-routes";
import { createReturnNavigationState } from "@/lib/return-navigation";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import {
  handleLicenseApiError,
  requireLicenseFeature,
  usePlanIncludes,
} from "@/stores/license-paywall";
import type { DockerComposeOperationAction, DockerComposeProjectSummary, Node } from "@/types";
import { ComposeProjectEditor } from "./compose/ComposeProjectEditor";

type ComposeProjectTransition = {
  action: DockerComposeOperationAction;
  label: "starting" | "stopping" | "applying";
  operationId: string | null;
  startedAt: number;
};

const ACTIVE_OPERATION_STATUSES = new Set(["pending", "running", "cancelling", "reconciling"]);

function statusVariant(status: string) {
  if (status === "running" || status === "healthy" || status === "online")
    return "success" as const;
  if (status === "failed" || status === "missing" || status === "unavailable")
    return "destructive" as const;
  if (
    status === "degraded" ||
    status === "starting" ||
    status === "stopping" ||
    status === "restarting" ||
    status === "enabling" ||
    status === "scaling" ||
    status === "rolling_out" ||
    status === "disabling" ||
    status === "applying" ||
    status === "validating" ||
    status === "deleting"
  )
    return "warning" as const;
  return "secondary" as const;
}

/** Lifecycle actions an existing managed project keeps after the plan loses Compose applications. */
const EXISTING_PROJECT_ACTIONS = new Set<DockerComposeOperationAction>([
  "start",
  "stop",
  "restart",
  "down",
  "delete_volumes",
  "cancel",
]);

export function DockerComposeProjects({
  embedded,
  fixedNodeId,
  onCreateRef,
  onCreateFolderRef,
  onRefreshRef,
  initialCreateOpen,
}: {
  embedded?: boolean;
  fixedNodeId?: string;
  onCreateRef?: (fn: () => void) => void;
  onCreateFolderRef?: (fn: () => void) => void;
  onRefreshRef?: (fn: () => void) => void;
  initialCreateOpen?: boolean;
} = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { hasScopedAccess, user } = useAuthStore();
  const projects = useDockerStore((state) => state.composeProjects);
  const fetchProjects = useDockerStore((state) => state.fetchComposeProjects);
  const loading = useDockerStore((state) => state.loading.compose);
  const selectedNodeId = useDockerStore((state) => state.selectedNodeId);
  const setSelectedNode = useDockerStore((state) => state.setSelectedNode);
  const storeNodes = useDockerStore((state) => state.dockerNodes);
  const nodesLoaded = useDockerStore((state) => state.dockerNodesLoaded);
  const setDockerNodes = useDockerStore((state) => state.setDockerNodes);
  const [localNodes, setLocalNodes] = useState<Node[]>([]);
  const [search, setSearch] = useState("");
  // The first list request; until it settles an empty list is not yet "no projects".
  const [initialFetchDone, setInitialFetchDone] = useState(false);
  const [createOpen, setCreateOpen] = useState(initialCreateOpen ?? false);
  const [adoptEditorProject, setAdoptEditorProject] = useState<DockerComposeProjectSummary | null>(
    null
  );
  const [projectTransitions, setProjectTransitions] = useState<
    Record<string, ComposeProjectTransition>
  >({});
  const createFolderRef = useRef<(() => void) | null>(null);
  const visibleNodeId = fixedNodeId ?? selectedNodeId;
  const canManageSomeFolders = useCanManageSomeFolders("docker:folders:manage");
  const canManageFolders = !fixedNodeId && canManageSomeFolders;
  // Creating, adopting and applying need Compose applications; existing projects keep start and stop.
  const planIncludesCompose = usePlanIncludes("compose-applications");
  const canCreate = planIncludesCompose && hasScopedAccess("docker:compose:create");
  // A node's view keeps app members (with an app badge); the normal list leaves them to their app.
  const loadProjects = useCallback(
    () => fetchProjects(fixedNodeId, fixedNodeId ? {} : NORMAL_LIST_FILTER),
    [fetchProjects, fixedNodeId]
  );
  const canMoveToApps = !fixedNodeId && hasScopedAccess("docker:compose:manage");
  const [moveToAppProject, setMoveToAppProject] = useState<DockerComposeProjectSummary | null>(
    null
  );
  const shownMoveToAppProject = useRetainedDialogValue(moveToAppProject, moveToAppProject !== null);

  const openCreate = useCallback(() => {
    if (!requireLicenseFeature("compose-applications", "Compose projects")) return;
    setCreateOpen(true);
  }, []);

  useEffect(() => onCreateRef?.(openCreate), [onCreateRef, openCreate]);
  useEffect(() => onRefreshRef?.(() => void loadProjects()), [loadProjects, onRefreshRef]);
  useEffect(() => {
    if (fixedNodeId) {
      setSelectedNode(fixedNodeId);
      return;
    }
    if (embedded && nodesLoaded) return;
    loadVisibleDockerNodes(
      user?.scopes ?? [],
      ["docker:compose:view"],
      hasScopedAccess("nodes:details")
    )
      .then((nodes) => {
        setLocalNodes(nodes);
        setDockerNodes(nodes);
      })
      .catch(() => toast.error("Failed to load Docker nodes"));
  }, [
    embedded,
    fixedNodeId,
    hasScopedAccess,
    nodesLoaded,
    setDockerNodes,
    setSelectedNode,
    user?.scopes,
  ]);
  useEffect(() => {
    void loadProjects().finally(() => setInitialFetchDone(true));
    const interval = window.setInterval(() => void loadProjects(), 30_000);
    return () => window.clearInterval(interval);
  }, [loadProjects]);
  useRealtime("docker.compose.changed", (payload) => {
    const event = payload as { nodeId?: string } | undefined;
    if (visibleNodeId && event?.nodeId && event.nodeId !== visibleNodeId) return;
    void loadProjects();
  });

  const hasActiveTransitions = Object.keys(projectTransitions).length > 0;

  useEffect(() => {
    if (!hasActiveTransitions) return;
    void loadProjects();
    const interval = window.setInterval(() => void loadProjects(), 1_000);
    return () => window.clearInterval(interval);
  }, [hasActiveTransitions, loadProjects]);

  useEffect(() => {
    setProjectTransitions((current) => {
      let changed = false;
      const next = { ...current };
      for (const [projectId, transition] of Object.entries(current)) {
        const project = projects.find((candidate) => candidate.id === projectId);
        const operation = project?.lastOperation;
        const terminalOperation =
          transition.operationId &&
          operation?.id === transition.operationId &&
          !ACTIVE_OPERATION_STATUSES.has(operation.status);
        const expired = Date.now() - transition.startedAt > 5 * 60_000;
        if (terminalOperation || expired) {
          delete next[projectId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [projects]);

  const runAction = useCallback(
    async (project: DockerComposeProjectSummary, action: DockerComposeOperationAction) => {
      if (
        !EXISTING_PROJECT_ACTIONS.has(action) &&
        !requireLicenseFeature("compose-applications", "Compose lifecycle")
      )
        return;
      if (
        action === "stop" &&
        !(await confirm({
          title: `Stop ${project.name}`,
          description:
            "Stop all containers in this Compose project? The project remains managed and can be started again.",
          confirmLabel: "Stop",
          variant: "destructive",
        }))
      ) {
        return;
      }
      const label = action === "start" ? "starting" : action === "stop" ? "stopping" : "applying";
      setProjectTransitions((current) => ({
        ...current,
        [project.id]: {
          action,
          label,
          operationId: null,
          startedAt: Date.now(),
        },
      }));
      try {
        const operation = await api.startDockerComposeOperation(
          project.nodeId,
          project.id,
          action,
          {
            idempotencyKey: createClientUuid(),
          }
        );
        setProjectTransitions((current) =>
          current[project.id]
            ? {
                ...current,
                [project.id]: { ...current[project.id], operationId: operation.id },
              }
            : current
        );
        toast.success(
          action === "pull_apply" ? "Pull & Apply started" : `Compose ${action} started`
        );
        void loadProjects();
      } catch (error) {
        setProjectTransitions((current) => {
          const next = { ...current };
          delete next[project.id];
          return next;
        });
        if (!handleLicenseApiError(error, "Compose lifecycle"))
          toastApiError(error, "Compose operation failed");
      }
    },
    [loadProjects]
  );

  const adoptProject = useCallback(async (project: DockerComposeProjectSummary) => {
    if (!requireLicenseFeature("compose-applications", "Compose adoption")) return;
    const accepted = await confirm({
      title: `Adopt ${project.name}`,
      description:
        "Bring this external Compose project under Opfield lifecycle and immutable revision management?",
      confirmLabel: "Adopt project",
    });
    if (!accepted) return;

    setAdoptEditorProject(project);
  }, []);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return projects
      .filter((project) => !visibleNodeId || project.nodeId === visibleNodeId)
      .filter((project) => !!fixedNodeId || !project.app)
      .filter(
        (project) =>
          !query ||
          `${project.name} ${project._nodeName ?? ""} ${project.status}`
            .toLowerCase()
            .includes(query)
      );
  }, [fixedNodeId, projects, search, visibleNodeId]);
  const retainedAdoptEditorProject = useRetainedDialogValue(
    adoptEditorProject,
    !!adoptEditorProject
  );

  const columns = useMemo<ResourceListColumn<DockerComposeProjectSummary>[]>(
    () => [
      {
        id: "name",
        label: "Project",
        width: "minmax(0, 1.4fr)",
        renderCell: (project) => (
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
              <Boxes className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <TruncateStart text={project.name} className="min-w-0 text-sm font-medium" />
                {project.managementState === "external" && <ExternalComposeBadge />}
                {project.app && <AppMemberBadge app={project.app} />}
              </div>
            </div>
          </div>
        ),
      },
      ...(!fixedNodeId
        ? [
            {
              id: "node",
              label: "Node",
              width: "minmax(0, 1fr)",
              align: "right",
              renderCell: (project: DockerComposeProjectSummary) => (
                <Badge variant="secondary" className={nodeBadgeClassName(project._nodeColor)}>
                  <span className="truncate">{project._nodeName || project.nodeId}</span>
                </Badge>
              ),
            } satisfies ResourceListColumn<DockerComposeProjectSummary>,
          ]
        : []),
      {
        id: "status",
        label: "Status",
        width: "8rem",
        align: "right",
        renderCell: (project) => {
          const transition = projectTransitions[project.id];
          const status =
            project.availabilityPolicyStatus ??
            transition?.label ??
            (project.drifted ? "drift" : project.status);
          return (
            <Badge
              variant={
                project.availabilityPolicyStatus
                  ? statusVariant(status as DockerComposeProjectSummary["status"])
                  : transition || project.drifted
                    ? "warning"
                    : statusVariant(project.status)
              }
              className="gap-1"
            >
              {transition && <Loader2 className="h-3 w-3 animate-spin" />}
              {status.replaceAll("_", " ")}
            </Badge>
          );
        },
      },
      {
        id: "services",
        label: "Services",
        width: "7rem",
        align: "right",
        renderCell: (project) => (
          <Badge
            variant={project.runningServiceCount === project.serviceCount ? "secondary" : "warning"}
          >
            {project.runningServiceCount}/{project.serviceCount}
          </Badge>
        ),
      },
      {
        id: "actions",
        label: "Actions",
        width: canMoveToApps ? "8.5rem" : "6.5rem",
        align: "right",
        renderCell: (project) => (
          // Keep all lifecycle controls inert until the matching async operation is terminal.
          <div
            className="flex items-center justify-end gap-1"
            onClick={(event) => event.stopPropagation()}
          >
            {project.managementState === "external"
              ? planIncludesCompose &&
                canAdoptComposeProject(user?.scopes ?? [], project.nodeId, project.id) && (
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Adopt into Opfield"
                    aria-label={`Adopt ${project.name} into Opfield`}
                    onClick={() => void adoptProject(project)}
                  >
                    <Import />
                  </Button>
                )
              : hasComposeProjectScope(
                  user?.scopes ?? [],
                  "docker:compose:manage",
                  project.nodeId,
                  project.id
                ) && (
                  <>
                    {project.status === "running" ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Stop"
                        aria-label={`Stop ${project.name}`}
                        disabled={Boolean(projectTransitions[project.id])}
                        onClick={() => void runAction(project, "stop")}
                      >
                        <Square />
                      </Button>
                    ) : (
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Start"
                        aria-label={`Start ${project.name}`}
                        disabled={Boolean(projectTransitions[project.id])}
                        onClick={() => void runAction(project, "start")}
                      >
                        <Play />
                      </Button>
                    )}
                    {planIncludesCompose && (
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Pull & Apply"
                        aria-label={`Pull and apply ${project.name}`}
                        disabled={Boolean(projectTransitions[project.id])}
                        onClick={() => void runAction(project, "pull_apply")}
                      >
                        <UploadCloud />
                      </Button>
                    )}
                  </>
                )}
            {canMoveToApps &&
              !project.app &&
              project.managementState !== "external" &&
              hasComposeProjectScope(
                user?.scopes ?? [],
                "docker:compose:manage",
                project.nodeId,
                project.id
              ) && (
                <MoveToAppRowMenu
                  resourceLabel={project.name}
                  onMoveToApp={() => setMoveToAppProject(project)}
                />
              )}
          </div>
        ),
      },
    ],
    [
      adoptProject,
      canMoveToApps,
      fixedNodeId,
      planIncludesCompose,
      projectTransitions,
      runAction,
      user?.scopes,
    ]
  );

  const nodes = embedded ? storeNodes : localNodes.length ? localNodes : storeNodes;
  const content = (
    <>
      {!embedded && (
        <PageHeader
          title="Compose Projects"
          description="Discover and manage single-node Docker Compose projects"
          actions={
            <ResponsiveHeaderActions
              actions={[
                {
                  label: "Refresh",
                  icon: <RefreshCw className="h-4 w-4" />,
                  onClick: () => void loadProjects(),
                  disabled: loading,
                },
                ...(canManageFolders
                  ? [
                      {
                        label: "New Folder",
                        icon: <FolderPlus className="h-4 w-4" />,
                        onClick: () => createFolderRef.current?.(),
                      },
                    ]
                  : []),
                ...(canCreate ? [{ label: "New Project", onClick: openCreate }] : []),
              ]}
            >
              <RefreshButton onClick={() => void loadProjects()} disabled={loading} />
              {canManageFolders && (
                <Button variant="outline" onClick={() => createFolderRef.current?.()}>
                  <FolderPlus className="mr-1 h-4 w-4" />
                  New Folder
                </Button>
              )}
              {canCreate && <Button onClick={openCreate}>New Project</Button>}
            </ResponsiveHeaderActions>
          }
        />
      )}
      <DockerFolderedResourceList
        resourceType="compose"
        resources={filtered}
        columns={columns}
        search={{
          initialFiltersOpen: new URLSearchParams(location.search).get("filters") === "1",
          search,
          onSearchChange: setSearch,
          placeholder: "Search Compose projects...",
          hasActiveFilters: search !== "" || !!selectedNodeId,
          onReset: () => {
            setSearch("");
            if (!fixedNodeId) setSelectedNode(null);
          },
          filters: fixedNodeId ? undefined : (
            <Select
              value={selectedNodeId ?? "__all__"}
              onValueChange={(value) => setSelectedNode(value === "__all__" ? null : value)}
            >
              <SelectTrigger className="w-48">
                <SelectValue placeholder="All nodes" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All nodes</SelectItem>
                {nodes.map((node) => (
                  <SelectItem key={node.id} value={node.id}>
                    {node.displayName || node.hostname}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ),
        }}
        loading={
          (projects.length === 0 && (!initialFetchDone || loading)) ||
          (!fixedNodeId && !nodesLoaded && nodes.length === 0)
        }
        loadingLabel="Loading Compose projects..."
        emptyState={
          <EmptyState
            message="No Compose projects found."
            hasActiveFilters={search !== ""}
            onReset={() => setSearch("")}
            actionLabel={canCreate ? "Create a project" : undefined}
            onAction={canCreate ? openCreate : undefined}
          />
        }
        minWidth={fixedNodeId ? "720px" : "980px"}
        fixedNodeId={fixedNodeId}
        canManageFolders={canManageFolders}
        canReorganizeItem={(project) => !project.app}
        getResourceKey={(project) => project.id}
        getResourceLabel={(project) => project.name}
        onItemClick={(project) =>
          navigate(dockerComposeProjectRoute(project.id), {
            state: createReturnNavigationState(location),
          })
        }
        onRefresh={() => loadProjects()}
        onCreateFolderRef={(fn) => {
          createFolderRef.current = fn;
          onCreateFolderRef?.(fn);
        }}
      />
    </>
  );
  const createDialog = (
    <Dialog open={createOpen} onOpenChange={setCreateOpen}>
      <DialogContent clipOverflow className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>New Compose Project</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          Deploy a single-file, image-only Compose project to a Docker node.
        </DialogDescription>
        <ComposeProjectEditor defaultNodeId={fixedNodeId} onClose={() => setCreateOpen(false)} />
      </DialogContent>
    </Dialog>
  );
  const adoptDialog = (
    <Dialog
      open={!!adoptEditorProject}
      onOpenChange={(open) => !open && setAdoptEditorProject(null)}
    >
      <DialogContent clipOverflow className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Adopt Compose Project</DialogTitle>
        </DialogHeader>
        <DialogDescription>Review the configuration before adopting the project.</DialogDescription>
        {retainedAdoptEditorProject && (
          <ComposeProjectEditor
            projectIdOverride={retainedAdoptEditorProject.id}
            adoptionOverride
            onClose={() => setAdoptEditorProject(null)}
          />
        )}
      </DialogContent>
    </Dialog>
  );

  const moveToAppDialog = canMoveToApps ? (
    <MoveToAppDialog
      open={moveToAppProject !== null}
      onOpenChange={(open) => {
        if (!open) setMoveToAppProject(null);
      }}
      members={
        shownMoveToAppProject
          ? [
              {
                type: "compose",
                id: shownMoveToAppProject.id,
                nodeId: shownMoveToAppProject.nodeId,
                resourceKey: shownMoveToAppProject.id,
              },
            ]
          : []
      }
      resourceLabel={shownMoveToAppProject?.name ?? "the Compose project"}
      onMoved={() => void loadProjects()}
    />
  ) : null;

  return embedded ? (
    <>
      {content}
      {createDialog}
      {adoptDialog}
      {moveToAppDialog}
    </>
  ) : (
    <PageTransition>
      <div className="min-h-full space-y-4 p-6">{content}</div>
      {createDialog}
      {adoptDialog}
      {moveToAppDialog}
    </PageTransition>
  );
}
