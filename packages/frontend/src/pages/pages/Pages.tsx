import { FolderPlus, Globe2, Plus, Settings } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { MoveToAppDialog } from "@/components/apps/MoveToAppDialog";
import { MoveToAppRowMenu } from "@/components/apps/MoveToAppRowMenu";
import { ContentLoading } from "@/components/common/ContentLoading";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderedResourceList } from "@/components/common/FolderedResourceList";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import { RelativeTime } from "@/components/common/RelativeTime";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { Button } from "@/components/ui/button";
import { useCanManageSomeFolders } from "@/hooks/use-folder-access";
import { useRealtime } from "@/hooks/use-realtime";
import { NORMAL_LIST_FILTER } from "@/lib/app-members";
import { nodeIconClassNames } from "@/lib/node-appearance";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { PageProject } from "@/types";
import { CreatePageProjectDialog } from "./CreatePageProjectDialog";
import { formatPageBytes } from "./page-format";

const projectColumns: ResourceListColumn<PageProject>[] = [
  {
    id: "name",
    label: "Project",
    width: "34%",
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
    label: "Deployments",
    width: "20%",
    cellContentClassName: "text-sm text-muted-foreground",
    renderCell: (project) => project.deploymentCount,
  },
  {
    id: "tags",
    label: "Tags",
    width: "10%",
    cellContentClassName: "text-sm text-muted-foreground",
    renderCell: (project) => project.tagCount,
  },
  {
    id: "storage",
    label: "Storage",
    width: "14%",
    cellContentClassName: "text-sm text-muted-foreground",
    renderCell: (project) =>
      `${formatPageBytes(project.storageUsedBytes)} / ${formatPageBytes(project.storageQuotaBytes)}`,
  },
  {
    id: "updated",
    label: "Updated",
    width: "22%",
    align: "right",
    cellContentClassName: "text-sm text-muted-foreground",
    renderCell: (project) => <RelativeTime value={project.updatedAt} />,
  },
];

export function Pages() {
  const navigate = useNavigate();
  const { hasScope, hasScopedAccess } = useAuthStore();
  const canView = hasScopedAccess("pages:view");
  const canCreate = hasScopedAccess("pages:create");
  const canViewSettings = hasScope("pages:settings:view") || hasScope("pages:settings:edit");
  const canManageFolders = useCanManageSomeFolders("pages:folders:manage");
  const canEdit = hasScopedAccess("pages:edit");
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
        toast.error(error instanceof Error ? error.message : "Failed to load Pages");
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
  const columns = useMemo<ResourceListColumn<PageProject>[]>(
    () =>
      canEdit
        ? [
            ...projectColumns,
            {
              id: "actions",
              label: "Actions",
              width: "4.5rem",
              align: "right",
              renderCell: (project) =>
                !project.app && hasScope(`pages:edit:${project.id}`) ? (
                  <MoveToAppRowMenu
                    resourceLabel={project.name}
                    onOpen={() => openProject(project)}
                    onMoveToApp={() => setMoveToAppProject(project)}
                  />
                ) : null,
            },
          ]
        : projectColumns,
    [canEdit, hasScope, openProject]
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
            minWidth={720}
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
          members={moveToAppProject ? [{ type: "pages", id: moveToAppProject.id }] : []}
          resourceLabel={moveToAppProject?.name ?? "the Page Project"}
          onMoved={() => void load()}
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
