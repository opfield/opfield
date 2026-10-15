import {
  ArrowRightLeft,
  Copy,
  ExternalLink,
  FolderPlus,
  Globe2,
  MoreVertical,
  Plus,
  Settings,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { MoveToAppDialog } from "@/components/apps/MoveToAppDialog";
import { confirm } from "@/components/common/ConfirmDialog";
import { ContentLoading } from "@/components/common/ContentLoading";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderedResourceList } from "@/components/common/FolderedResourceList";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import { RelativeTime } from "@/components/common/RelativeTime";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
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
import { useCanManageSomeFolders } from "@/hooks/use-folder-access";
import { useGlobalSectionAccess } from "@/hooks/use-global-section-scopes";
import { useRealtime } from "@/hooks/use-realtime";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { toastApiError } from "@/lib/api-error-toast";
import { NORMAL_LIST_FILTER } from "@/lib/app-members";
import { hasCreationDestination } from "@/lib/creation-folders";
import { nodeIconClassNames } from "@/lib/node-appearance";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { PageProject } from "@/types";
import { CreatePageProjectDialog } from "./CreatePageProjectDialog";
import { PageManualDeployDialog } from "./PageManualDeployDialog";
import { formatPageBytes } from "./page-format";

const projectColumns: ResourceListColumn<PageProject>[] = [
  {
    id: "name",
    label: "Project",
    renderCell: (project) => {
      const iconClassNames = nodeIconClassNames(project.appearanceColor);
      return (
        <div className="flex min-w-0 items-center gap-4">
          <div className={iconClassNames.wrapper}>
            <Globe2 className={`h-5 w-5 ${iconClassNames.icon}`} />
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
    label: "Releases",
    width: "6.5rem",
    align: "right",
    renderCell: (project) => <Badge variant="secondary">{project.deploymentCount}</Badge>,
  },
  {
    id: "tags",
    label: "Tags",
    width: "5rem",
    align: "right",
    renderCell: (project) => <Badge variant="secondary">{project.tagCount}</Badge>,
  },
  {
    id: "storage",
    label: "Storage",
    width: "10rem",
    align: "right",
    renderCell: (project) => (
      <Badge variant="secondary">
        {`${formatPageBytes(project.storageUsedBytes)} / ${formatPageBytes(project.storageQuotaBytes)}`}
      </Badge>
    ),
  },
  {
    id: "updated",
    label: "Updated",
    width: "7.5rem",
    align: "right",
    cellContentClassName: "text-sm text-muted-foreground",
    renderCell: (project) => <RelativeTime value={project.updatedAt} />,
  },
];

export function Pages() {
  const navigate = useNavigate();
  const { hasScope, hasScopedAccess } = useAuthStore();
  const canView = hasScopedAccess("pages:view");
  // Creating needs a destination outside app places (broad, node or user folder grant).
  const globalAccess = useGlobalSectionAccess();
  const canCreate = hasCreationDestination(globalAccess.scopes, "pages:create", {
    nodeGrants: true,
  });
  const canViewSettings = hasScope("pages:settings:view") || hasScope("pages:settings:edit");
  const canManageFolders = useCanManageSomeFolders("pages:folders:manage");
  const canEdit = hasScopedAccess("pages:edit");
  const canDeployAny = hasScopedAccess("pages:deploy");
  const canDeleteAny = hasScopedAccess("pages:delete");
  const [projects, setProjects] = useState<PageProject[]>(() => {
    const cached = api.getCached<{ data: PageProject[] }>("pages:projects");
    return cached?.data ?? [];
  });
  const projectsRef = useRef(projects);
  const loadVersion = useRef(0);
  projectsRef.current = projects;
  const [loading, setLoading] = useState(canView);
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [createFolderAction, setCreateFolderAction] = useState<(() => void) | null>(null);
  const [moveToAppProject, setMoveToAppProject] = useState<PageProject | null>(null);
  const [deployProject, setDeployProject] = useState<PageProject | null>(null);
  const shownMoveToAppProject = useRetainedDialogValue(moveToAppProject, moveToAppProject !== null);
  const shownDeployProject = useRetainedDialogValue(deployProject, deployProject !== null);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    if (!canView) {
      setLoading(false);
      return;
    }
    setLoading((current) => current || projectsRef.current.length === 0);
    try {
      // App members live on their app's page: the server leaves them out.
      const response = await api.listPageProjects({ page: 1, limit: 100, ...NORMAL_LIST_FILTER });
      if (version !== loadVersion.current) return;
      setProjects(response.data ?? []);
      api.setCache("pages:projects", response);
    } catch (error) {
      if (version !== loadVersion.current) return;
      if (projectsRef.current.length === 0) {
        toastApiError(error, "Failed to load Pages");
      }
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, [canView]);

  useEffect(() => {
    void load();
    return () => {
      ++loadVersion.current;
    };
  }, [load]);

  useRealtime("pages.project.changed", () => void load());
  useRealtime("pages.folder.changed", () => void load());

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle
      ? projects.filter(
          (project) =>
            project.name.toLowerCase().includes(needle) ||
            project.slug.toLowerCase().includes(needle)
        )
      : projects;
  }, [projects, search]);

  const openProject = useCallback(
    (project: PageProject) => navigate(`/pages/${project.slug}/deployments`),
    [navigate]
  );
  const removeProject = useCallback(
    async (project: PageProject) => {
      const ok = await confirm({
        title: "Delete Page Project",
        description: `Delete ${project.name}? The Project must have no Deployments or Pages Routes.`,
        confirmLabel: "Delete Project",
        variant: "destructive",
      });
      if (!ok) return;
      try {
        await api.deletePageProject(project.id);
        toast.success("Page Project deleted");
        await load();
      } catch (error) {
        toastApiError(error, "Failed to delete Page Project");
      }
    },
    [load]
  );

  const columns = useMemo<ResourceListColumn<PageProject>[]>(
    () =>
      canEdit || canDeployAny || canDeleteAny
        ? [
            ...projectColumns,
            {
              id: "actions",
              label: "Actions",
              width: "5rem",
              align: "right",
              renderCell: (project) => {
                const canDeployRow = hasScopedAccess(`pages:deploy:${project.id}`);
                const canMoveRow = !project.app && hasScopedAccess(`pages:edit:${project.id}`);
                // An app member's incident can hold its deletion: delete it from its page.
                const canDeleteRow = !project.app && hasScopedAccess(`pages:delete:${project.id}`);
                const domainUrl = project.primaryDomain
                  ? `${window.location.protocol}//${project.primaryDomain}`
                  : null;
                return (
                  // The row opens the project on click; the menu must not.
                  <div
                    className="flex justify-end"
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label={`${project.name} actions`}>
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {canDeployRow && (
                          <DropdownMenuItem onClick={() => setDeployProject(project)}>
                            <UploadCloud className="h-4 w-4" />
                            Deploy
                          </DropdownMenuItem>
                        )}
                        {domainUrl && (
                          <DropdownMenuItem
                            onClick={() => {
                              void navigator.clipboard?.writeText(domainUrl);
                              toast.success("Copied");
                            }}
                          >
                            <Copy className="h-4 w-4" />
                            Copy domain
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onClick={() => openProject(project)}>
                          <ExternalLink className="h-4 w-4" />
                          Open
                        </DropdownMenuItem>
                        {canMoveRow && (
                          <DropdownMenuItem onClick={() => setMoveToAppProject(project)}>
                            <ArrowRightLeft className="h-4 w-4" />
                            Move to app...
                          </DropdownMenuItem>
                        )}
                        {canDeleteRow && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => void removeProject(project)}
                              className="text-destructive"
                            >
                              <Trash2 className="h-4 w-4" />
                              Delete project
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                );
              },
            },
          ]
        : projectColumns,
    [canEdit, canDeployAny, canDeleteAny, hasScopedAccess, openProject, removeProject]
  );

  return (
    <PageTransition>
      <ContentLoading loading={loading} />
      <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <LiteModeBackButton />
            <div>
              <h1 className="font-display text-2xl font-bold">Pages</h1>
              <p className="text-sm text-muted-foreground">
                {projects.length} project{projects.length === 1 ? "" : "s"}
              </p>
            </div>
          </div>
          <ResponsiveHeaderActions
            actions={[
              ...(canViewSettings
                ? [
                    {
                      id: "pages-settings",
                      label: "Settings",
                      icon: <Settings className="h-4 w-4" />,
                      onClick: () =>
                        navigate("/settings/features", { state: { scrollTarget: "pages" } }),
                      priority: 50,
                    },
                  ]
                : []),
              ...(canManageFolders && createFolderAction
                ? [
                    {
                      id: "create-pages-folder",
                      label: "Add Folder",
                      icon: <FolderPlus className="h-4 w-4" />,
                      onClick: createFolderAction,
                      priority: 30,
                    },
                  ]
                : []),
              ...(canCreate
                ? [
                    {
                      id: "create-page-project",
                      label: "Create project",
                      icon: <Plus className="h-4 w-4" />,
                      onClick: () => setDialogOpen(true),
                      priority: 100,
                    },
                  ]
                : []),
            ]}
          >
            {canViewSettings && (
              <Button
                variant="outline"
                onClick={() => navigate("/settings/features", { state: { scrollTarget: "pages" } })}
              >
                <Settings className="h-4 w-4" />
                Settings
              </Button>
            )}
            {canManageFolders && createFolderAction && (
              <Button variant="outline" onClick={() => createFolderAction?.()}>
                <FolderPlus className="h-4 w-4" />
                Add Folder
              </Button>
            )}
            {canCreate ? (
              <Button onClick={() => setDialogOpen(true)}>
                <Plus className="h-4 w-4" />
                Create project
              </Button>
            ) : (
              <span />
            )}
          </ResponsiveHeaderActions>
        </div>

        {!canView ? (
          <EmptyState message="You do not have permission to view Page Projects." />
        ) : (
          <FolderedResourceList<PageProject>
            resourceType="pages-project"
            realtimeChannel="pages.folder.changed"
            resources={filtered}
            columns={columns}
            search={{
              search,
              onSearchChange: setSearch,
              placeholder: "Search Page Projects...",
              hasActiveFilters: search.trim() !== "",
              onReset: () => setSearch(""),
            }}
            loading={loading}
            loadingLabel="Loading Page Projects..."
            emptyState={
              <EmptyState
                message="No Page Projects yet. Pages accepts prebuilt static artifacts and requires no per-site container."
                {...(canCreate
                  ? { actionLabel: "Create project", onAction: () => setDialogOpen(true) }
                  : {})}
                hasActiveFilters={search.trim() !== ""}
                onReset={() => setSearch("")}
              />
            }
            canManageFolders={canManageFolders}
            canReorganizeItem={(project) => !project.app && (canManageFolders || canEdit)}
            getResourceLabel={(project) => project.name}
            onItemClick={openProject}
            onRefresh={load}
            onCreateFolderRef={(fn) => setCreateFolderAction(() => fn)}
          />
        )}
      </div>
      {canEdit && (
        <MoveToAppDialog
          open={moveToAppProject !== null}
          onOpenChange={(open) => {
            if (!open) setMoveToAppProject(null);
          }}
          members={shownMoveToAppProject ? [{ type: "pages", id: shownMoveToAppProject.id }] : []}
          resourceLabel={shownMoveToAppProject?.name ?? "the Page Project"}
          onMoved={() => void load()}
        />
      )}
      {/* close-reset-ok: the retained project keeps the dialog mounted through its exit animation */}
      {shownDeployProject && (
        <PageManualDeployDialog
          open={deployProject !== null}
          onOpenChange={(open) => {
            if (!open) setDeployProject(null);
          }}
          projectId={shownDeployProject.id}
          onUploaded={() => navigate(`/pages/${shownDeployProject.slug}/deployments`)}
        />
      )}
      <CreatePageProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={(project) => {
          setProjects((current) => [project, ...current]);
          navigate(`/pages/${project.slug}/deployments`);
        }}
      />
    </PageTransition>
  );
}
