import {
  ArrowRightLeft,
  Copy,
  ExternalLink,
  FileCode2,
  Network,
  Settings,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AppMembershipLink } from "@/components/apps/AppMembership";
import { MemberIsolatedNotice, useMemberIncidentHold } from "@/components/apps/IsolatedNotice";
import { confirm } from "@/components/common/ConfirmDialog";
import { CopyCodeBlock } from "@/components/common/CopyCodeBlock";
import { CopyValueField } from "@/components/common/CopyValueField";
import { DetailPageSkeleton } from "@/components/common/DetailPageSkeleton";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import {
  HEADER_ACTION_PRIORITY,
  ResponsiveHeaderActions,
} from "@/components/common/ResponsiveHeaderActions";
import { CreateProxyHostDialog } from "@/components/proxy/CreateProxyHostDialog";
import { DEFAULT_PROXY_UPSTREAM } from "@/components/proxy/ProxyUpstreamEditor";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useLeavePage } from "@/hooks/use-navigation-trail";
import { useRealtime } from "@/hooks/use-realtime";
import { useUrlTab } from "@/hooks/use-url-tab";
import { toastApiError } from "@/lib/api-error-toast";
import { loadPageDeployments } from "@/lib/page-deployments";
import { proxyHostRoute } from "@/lib/resource-routes";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { useAuthStore } from "@/stores/auth";
import { hasLicenseFeature, usePlanIncludes } from "@/stores/license-paywall";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type { PageProject, PageProjectPlacementOption } from "@/types";
import { DockerResourceGitTabs } from "../docker-detail/DockerResourceGitTabs";
import { PageDeploymentsTab } from "./PageDeploymentsTab";
import { PageManualDeployDialog } from "./PageManualDeployDialog";
import { PageProjectSettingsDialog } from "./PageProjectSettingsTab";
import { PageRuntimeConfigTab } from "./PageRuntimeConfigTab";
import { PageTagsTab } from "./PageTagsTab";
import { PageTokensTab } from "./PageTokensTab";
import { PAGE_HOME_NODE_HINT } from "./page-format";

const PROJECT_TABS = [
  "deployments",
  "source",
  "builds",
  "tags",
  "tokens",
  "configuration",
] as const;

function MigrateProjectDialog({
  open,
  onOpenChange,
  project,
  onMigrated,
  onCreateGroupRoute,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: PageProject;
  onMigrated: (project: PageProject) => void;
  /** Opens the Pages Route create flow for this project, when the caller can use an ingress group. */
  onCreateGroupRoute?: () => void;
}) {
  const [nodes, setNodes] = useState<PageProjectPlacementOption[]>([]);
  const [targetNodeId, setTargetNodeId] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setSaving(false);
  }, [open]);

  // A Project in an app environment moves only to the nodes that environment allows.
  const folderId = project.folderId;
  useEffect(() => {
    if (!open) return;
    setTargetNodeId("");
    setLoading(true);
    void api
      .listPageProjectPlacementOptions(folderId)
      .then(setNodes)
      .catch((error) => toastApiError(error, "Failed to load Pages nodes"))
      .finally(() => setLoading(false));
  }, [folderId, open]);

  const migrate = async () => {
    if (!targetNodeId || saving) return;
    setSaving(true);
    try {
      const updated = await api.migratePageProject(project.id, targetNodeId);
      onMigrated(updated);
      toast.success(
        updated.migrationStatus === "cleanup_pending"
          ? "Page Project migrated; source cleanup is pending"
          : "Page Project migrated"
      );
      onOpenChange(false);
    } catch (error) {
      setSaving(false);
      toastApiError(error, "Failed to migrate Page Project");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Migrate Page Project</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          Stage static releases and previews on another Pages-capable node, then switch this
          Project.
        </DialogDescription>
        <div className="space-y-1.5">
          <label htmlFor="page-project-migration-node" className="text-sm font-medium">
            New home node
          </label>
          <Select value={targetNodeId} onValueChange={setTargetNodeId} disabled={loading || saving}>
            <SelectTrigger id="page-project-migration-node">
              <SelectValue placeholder={loading ? "Loading nodes…" : "Select a node"} />
            </SelectTrigger>
            <SelectContent>
              {nodes
                .filter((node) => node.id !== project.nodeId)
                .map((node) => (
                  <SelectItem
                    key={node.id}
                    value={node.id}
                    disabled={node.status !== "online" || !node.pagesCapable}
                  >
                    {node.displayName || node.hostname}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{PAGE_HOME_NODE_HINT}</p>
          {onCreateGroupRoute && (
            <Button
              variant="link"
              className="h-auto px-0"
              onClick={() => {
                onOpenChange(false);
                onCreateGroupRoute();
              }}
              disabled={saving}
            >
              <Network className="h-4 w-4" />
              Create route on a group
            </Button>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void migrate()} disabled={!targetNodeId || saving}>
            <ArrowRightLeft className="h-4 w-4" />
            {saving ? "Migrating…" : "Migrate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeployInstructionsDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}) {
  const endpoint = `${window.location.origin}/api/pages-deploy/deployments`;
  const payload = JSON.stringify(
    {
      projectId,
      declaredSizeBytes: 0,
      sha256: "…",
      tag: "preview-mr-42",
      source: { provider: "gitlab", mergeRequest: "!42" },
    },
    null,
    2
  );
  const createCommand = `curl -X POST '${endpoint}' \\
  -H 'Authorization: Bearer <deploy-token>' \\
  -H 'Content-Type: application/json' \\
  --data '${payload}'`;
  const uploadCommand = `curl -X PUT '${window.location.origin}/api/pages-deploy/uploads/<upload-id>/chunks' \\
  -H 'Authorization: Bearer <deploy-token>' \\
  -H 'Content-Type: application/octet-stream' \\
  -H 'Upload-Offset: 0' \\
  --data-binary @site.tar.gz

curl -X POST '${window.location.origin}/api/pages-deploy/uploads/<upload-id>/finalize' \\
  -H 'Authorization: Bearer <deploy-token>'`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Deploy Instructions</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          Upload a prebuilt static archive through the resumable webhook API.
        </DialogDescription>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Create Upload</label>
            <p className="text-xs text-muted-foreground">
              Create a resumable upload session using a Pages deploy token.
            </p>
            <CopyCodeBlock
              label="Create upload command"
              value={createCommand}
              className="[&>p]:hidden"
              codeClassName="min-h-0"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Upload and Finalize</label>
            <p className="text-xs text-muted-foreground">
              Replace upload-id with the ID returned above. Opfield then publishes latest and the
              requested Tag.
            </p>
            <CopyCodeBlock
              label="Upload and finalize commands"
              value={uploadCommand}
              className="[&>p]:hidden"
              codeClassName="min-h-0"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Project ID</label>
            <p className="text-xs text-muted-foreground">Use this ID in the deployment payload.</p>
            <CopyValueField label="Project ID" value={projectId} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function PageProjectDetail({
  projectId,
  resolvedSlug,
  initialProject,
}: {
  projectId: string;
  resolvedSlug: string;
  /** The Project the route already resolved; the page starts from it instead of fetching it again. */
  initialProject?: PageProject;
}) {
  const navigate = useNavigate();
  const leavePage = useLeavePage();
  const canView = useAuthStore((state) => state.hasScopedAccess(`pages:view:${projectId}`));
  const canDeploy = useAuthStore((state) => state.hasScopedAccess(`pages:deploy:${projectId}`));
  const canEdit = useAuthStore((state) => state.hasScopedAccess(`pages:edit:${projectId}`));
  const canDelete = useAuthStore((state) => state.hasScopedAccess(`pages:delete:${projectId}`));
  const initialProjectRef = useRef(initialProject?.id === projectId ? initialProject : undefined);
  const [project, setProject] = useState<PageProject | null>(initialProjectRef.current ?? null);
  // The open incident of the project's app environment refuses deleting it.
  const {
    app: memberApp,
    reload: reloadMemberApp,
    hold: incidentHold,
  } = useMemberIncidentHold(project?.app);
  const [loading, setLoading] = useState(!initialProjectRef.current);
  const [deployInstructionsOpen, setDeployInstructionsOpen] = useState(false);
  const [manualDeployOpen, setManualDeployOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [migrateOpen, setMigrateOpen] = useState(false);
  const [migrationAvailable, setMigrationAvailable] = useState(false);
  const [homeNodeName, setHomeNodeName] = useState<string | null>(null);
  const [groupRouteAvailable, setGroupRouteAvailable] = useState(false);
  const [groupRouteOpen, setGroupRouteOpen] = useState(false);
  const canCreateRoute = useAuthStore((state) => state.hasScopedAccess("proxy:create"));
  // Ingress groups need their license feature; the bootstrap license makes the check reactive.
  const ingressGroupsLicensed = useUIBootstrapStore(
    (state) => !!state.snapshot?.license && hasLicenseFeature("multi-node-availability") === true
  );
  const [latestPreviewHostname, setLatestPreviewHostname] = useState<string | null>(null);
  const deletingRef = useRef(false);
  const loadedProjectIdRef = useRef<string | null>(null);
  const latestPreviewRequestRef = useRef(0);
  const [activeTab, setActiveTab] = useUrlTab(
    [...PROJECT_TABS],
    "deployments",
    (tab) => `/pages/${resolvedSlug}/${tab}`
  );
  // Source and Builds need Git push-to-deploy; an already bound source stays manageable.
  const planIncludesGitDeploy = usePlanIncludes("git-push-to-deploy");
  const [boundSourceFor, setBoundSourceFor] = useState<{
    projectId: string;
    bound: boolean;
  } | null>(null);
  const sourceNodeId = project?.nodeId ?? undefined;
  const sourceProjectId = project?.id;
  useEffect(() => {
    if (planIncludesGitDeploy || !sourceProjectId) return;
    let cancelled = false;
    void api
      .getDockerSource({
        kind: "pages_project",
        nodeId: sourceNodeId,
        pageProjectId: sourceProjectId,
      })
      .then((source) => {
        if (!cancelled) setBoundSourceFor({ projectId: sourceProjectId, bound: source !== null });
      })
      .catch(() => {
        if (!cancelled) setBoundSourceFor({ projectId: sourceProjectId, bound: false });
      });
    return () => {
      cancelled = true;
    };
  }, [planIncludesGitDeploy, sourceNodeId, sourceProjectId]);
  const gitTabsVisible =
    planIncludesGitDeploy ||
    (boundSourceFor !== null &&
      boundSourceFor.projectId === sourceProjectId &&
      boundSourceFor.bound);

  const load = useCallback(async () => {
    if (deletingRef.current) return;
    try {
      const next = await api.getPageProject(projectId);
      if (deletingRef.current) return;
      loadedProjectIdRef.current = projectId;
      setProject(next);
    } catch (error) {
      if (deletingRef.current) return;
      if (
        error instanceof ApiRequestError &&
        error.status === 404 &&
        loadedProjectIdRef.current === projectId
      ) {
        // Deleted elsewhere while shown: back to where it was opened from.
        toast.info("Page Project was deleted");
        leavePage("/pages");
        return;
      }
      toastApiError(error, "Failed to load Page Project");
    } finally {
      setLoading(false);
    }
  }, [leavePage, projectId]);

  const loadLatestPreview = useCallback(
    async ({ fresh = true }: { fresh?: boolean } = {}) => {
      const requestId = ++latestPreviewRequestRef.current;
      try {
        const response = await loadPageDeployments(projectId, { fresh });
        if (requestId !== latestPreviewRequestRef.current) return;
        setLatestPreviewHostname(
          response.data?.find((deployment) => deployment.status === "ready")?.previewHostname ??
            null
        );
      } catch {
        if (requestId === latestPreviewRequestRef.current) setLatestPreviewHostname(null);
      }
    },
    [projectId]
  );

  useEffect(() => {
    if (!canView) return;
    if (!initialProjectRef.current) void load();
    // Starts the Deployments request that the Deployments tab then shares.
    void loadLatestPreview({ fresh: false });
  }, [canView, load, loadLatestPreview]);
  useRealtime("pages.project.changed", (payload) => {
    const event = payload as { projectId?: string };
    if (!event.projectId || event.projectId === projectId) void load();
  });
  useRealtime("pages.deployment.changed", (payload) => {
    const event = payload as { projectId?: string };
    if (!event.projectId || event.projectId === projectId) void loadLatestPreview();
  });

  // Realtime refreshes replace the Project object; only its node decides the answer.
  const hasProject = project !== null;
  const projectNodeId = project?.nodeId ?? null;
  useEffect(() => {
    if (!canEdit || !hasProject) {
      setMigrationAvailable(false);
      return;
    }

    let active = true;
    void api
      .listPageProjectPlacementOptions()
      .then((nodes) => {
        if (!active) return;
        setMigrationAvailable(
          nodes.some(
            (node) => node.id !== projectNodeId && node.status === "online" && node.pagesCapable
          )
        );
        const homeNode = nodes.find((node) => node.id === projectNodeId);
        setHomeNodeName(homeNode ? homeNode.displayName || homeNode.hostname : null);
      })
      .catch(() => {
        if (active) setMigrationAvailable(false);
      });

    return () => {
      active = false;
    };
  }, [canEdit, hasProject, projectNodeId]);

  // "Create route on a group" shows only when the user can place a route on at least one ingress group.
  useEffect(() => {
    if (!canCreateRoute || !ingressGroupsLicensed) {
      setGroupRouteAvailable(false);
      return;
    }
    let active = true;
    void api
      .listRouteIngressGroups()
      .then((groups) => {
        if (active) setGroupRouteAvailable(groups.length > 0);
      })
      .catch(() => {
        if (active) setGroupRouteAvailable(false);
      });
    return () => {
      active = false;
    };
  }, [canCreateRoute, ingressGroupsLicensed]);

  const projectName = project?.name ?? "";
  const groupRouteUpstream = useMemo(
    () => ({
      ...DEFAULT_PROXY_UPSTREAM,
      kind: "pages" as const,
      pageProjectId: projectId,
      pageProjectLabel: projectName,
    }),
    [projectId, projectName]
  );
  const openGroupRoute = groupRouteAvailable ? () => setGroupRouteOpen(true) : undefined;

  const previewsEnabled = project?.previewsEnabled ?? true;
  const publicHostname = project?.primaryDomain ?? (previewsEnabled ? latestPreviewHostname : null);
  const latestPreviewUrl = publicHostname ? `${window.location.protocol}//${publicHostname}` : null;
  const visibleTab =
    PROJECT_TABS.includes(activeTab as (typeof PROJECT_TABS)[number]) &&
    (gitTabsVisible || (activeTab !== "source" && activeTab !== "builds"))
      ? activeTab
      : "deployments";

  const remove = async () => {
    if (!project) return;
    if (
      !(await confirm({
        title: "Delete Page Project",
        description: `Delete ${project.name}? The Project must have no Deployments or Pages Routes.`,
        confirmLabel: "Delete Project",
        variant: "destructive",
      }))
    ) {
      return;
    }
    try {
      deletingRef.current = true;
      await api.deletePageProject(project.id);
      toast.success("Page Project deleted");
      leavePage("/pages");
    } catch (error) {
      deletingRef.current = false;
      toastApiError(error, "Failed to delete Page Project");
    }
  };

  if (!canView) return null;
  if (loading && !project) return <DetailPageSkeleton label="Loading Page Project" tabs={6} />;
  if (!project) return null;

  return (
    <PageTransition>
      <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
        <div className="flex shrink-0 items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <PageBackButton onClick={() => navigate("/pages")} label="Back to Pages" />
            <div className="min-w-0">
              <h1 className="min-w-0 truncate font-display text-2xl font-bold">{project.name}</h1>
              <p className="truncate text-sm text-muted-foreground">
                {project.slug}
                {project.description ? ` · ${project.description}` : ""}
                {project.app ? (
                  <>
                    {" · "}
                    <AppMembershipLink app={project.app} />
                  </>
                ) : null}
              </p>
            </div>
          </div>
          <ResponsiveHeaderActions
            actions={[
              ...(canDeploy
                ? [
                    {
                      id: "deploy",
                      label: "Deploy",
                      icon: <UploadCloud className="h-4 w-4" />,
                      onClick: () => setManualDeployOpen(true),
                      priority: HEADER_ACTION_PRIORITY.primary,
                    },
                    {
                      id: "deploy-instructions",
                      label: "Deploy instructions",
                      icon: <FileCode2 className="h-4 w-4" />,
                      onClick: () => setDeployInstructionsOpen(true),
                      alwaysOverflow: true,
                      priority: 20,
                    },
                  ]
                : []),
              ...(canEdit
                ? [
                    {
                      id: "project-settings",
                      label: "Settings",
                      icon: <Settings className="h-4 w-4" />,
                      onClick: () => setSettingsOpen(true),
                      priority: 50,
                    },
                    {
                      id: "migrate-project",
                      label: "Migrate",
                      icon: <ArrowRightLeft className="h-4 w-4" />,
                      onClick: () => setMigrateOpen(true),
                      disabled: !migrationAvailable,
                      disabledReason: "No other Pages-capable node is available",
                      alwaysOverflow: true,
                      priority: 10,
                    },
                  ]
                : []),
              ...(latestPreviewUrl
                ? [
                    {
                      id: "copy-latest-preview",
                      label: project?.primaryDomain ? "Copy domain" : "Copy latest preview",
                      icon: <Copy className="h-4 w-4" />,
                      onClick: () => {
                        void navigator.clipboard?.writeText(latestPreviewUrl);
                        toast.success("Copied");
                      },
                      priority: 40,
                    },
                  ]
                : []),
              ...(canDelete
                ? [
                    {
                      id: "delete-project",
                      label: "Delete project",
                      icon: <Trash2 className="h-4 w-4" />,
                      onClick: () => void remove(),
                      disabled: incidentHold.kept !== null,
                      disabledReason: incidentHold.kept ?? undefined,
                      destructive: true,
                      separatorBefore: true,
                    },
                  ]
                : []),
            ]}
          >
            {canDeploy && (
              <Button onClick={() => setManualDeployOpen(true)}>
                <UploadCloud className="h-4 w-4" />
                Deploy
              </Button>
            )}
            {canDeploy && (
              <Button variant="outline" onClick={() => setDeployInstructionsOpen(true)}>
                <FileCode2 className="h-4 w-4" />
                Deploy instructions
              </Button>
            )}
            {canEdit && (
              <Button variant="outline" onClick={() => setSettingsOpen(true)}>
                <Settings className="h-4 w-4" />
                Settings
              </Button>
            )}
            {canEdit && (
              <Button
                variant="outline"
                onClick={() => setMigrateOpen(true)}
                disabled={!migrationAvailable}
              >
                <ArrowRightLeft className="h-4 w-4" />
                Migrate
              </Button>
            )}
            {latestPreviewUrl && (
              <Button
                variant="outline"
                onClick={() => {
                  void navigator.clipboard?.writeText(latestPreviewUrl);
                  toast.success("Copied");
                }}
              >
                <Copy className="h-4 w-4" />
                {project.primaryDomain ? "Copy domain" : "Copy preview"}
              </Button>
            )}
            {canDelete && (
              <Button
                variant="destructive"
                onClick={() => void remove()}
                disabled={incidentHold.kept !== null}
                title={incidentHold.kept ?? undefined}
              >
                <Trash2 className="h-4 w-4" />
                Delete project
              </Button>
            )}
          </ResponsiveHeaderActions>
        </div>
        <MemberIsolatedNotice app={project.app} memberApp={memberApp} onChanged={reloadMemberApp} />

        {latestPreviewUrl && (
          <CopyValueField
            label={project?.primaryDomain ? "Domain" : "Latest immutable preview"}
            value={publicHostname ?? latestPreviewUrl}
            copyValue={latestPreviewUrl}
            actions={
              <Button
                asChild
                variant="ghost"
                size="icon"
                className="rounded-none border-l bg-muted text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <a
                  href={latestPreviewUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={project.primaryDomain ? "Open domain" : "Open preview"}
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              </Button>
            }
          />
        )}

        <Tabs
          value={visibleTab}
          onValueChange={setActiveTab}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="shrink-0">
            <TabsTrigger value="deployments" className="gap-1.5">
              Deployments
            </TabsTrigger>
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
            <TabsTrigger value="tags" className="gap-1.5">
              Tags
            </TabsTrigger>
            <TabsTrigger value="tokens" className="gap-1.5">
              Deploy tokens
            </TabsTrigger>
            <TabsTrigger value="configuration" className="gap-1.5">
              Configuration
            </TabsTrigger>
          </TabsList>
          <TabsContent value="deployments" className="pb-0">
            <PageDeploymentsTab projectId={project.id} previewsEnabled={previewsEnabled} />
          </TabsContent>
          <TabsContent value="source" className="pb-6">
            <DockerResourceGitTabs
              target={{
                kind: "pages_project",
                nodeId: project.nodeId ?? undefined,
                pageProjectId: project.id,
              }}
              view="source"
              canEdit={canEdit}
              canBuild={canDeploy}
            />
          </TabsContent>
          <TabsContent value="builds" className="flex min-h-0 flex-1 flex-col pb-0">
            <DockerResourceGitTabs
              target={{
                kind: "pages_project",
                nodeId: project.nodeId ?? undefined,
                pageProjectId: project.id,
              }}
              view="builds"
            />
          </TabsContent>
          <TabsContent value="tags" className="pb-0">
            <PageTagsTab projectId={project.id} />
          </TabsContent>
          <TabsContent value="tokens" className="pb-0">
            <PageTokensTab projectId={project.id} />
          </TabsContent>
          <TabsContent value="configuration" className="flex min-h-0 flex-1 flex-col pb-0">
            <PageRuntimeConfigTab projectId={project.id} />
          </TabsContent>
        </Tabs>
      </div>
      <DeployInstructionsDialog
        open={deployInstructionsOpen}
        onOpenChange={setDeployInstructionsOpen}
        projectId={project.id}
      />
      <PageManualDeployDialog
        open={manualDeployOpen}
        onOpenChange={setManualDeployOpen}
        projectId={project.id}
        onUploaded={() => setActiveTab("deployments")}
      />
      <PageProjectSettingsDialog
        project={project}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onProjectChange={setProject}
        homeNodeName={homeNodeName}
        onCreateGroupRoute={openGroupRoute}
      />
      <MigrateProjectDialog
        project={project}
        open={migrateOpen}
        onOpenChange={setMigrateOpen}
        onMigrated={setProject}
        onCreateGroupRoute={openGroupRoute}
      />
      {groupRouteAvailable && (
        <CreateProxyHostDialog
          open={groupRouteOpen}
          onOpenChange={setGroupRouteOpen}
          initialUpstream={groupRouteUpstream}
          onSuccess={(_, host) => {
            if (host) navigate(proxyHostRoute(host.slug));
          }}
        />
      )}
    </PageTransition>
  );
}
