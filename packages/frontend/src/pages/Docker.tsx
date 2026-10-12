import { ArchiveRestore, FolderPlus, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ContentLoading } from "@/components/common/ContentLoading";
import { EmptyState } from "@/components/common/EmptyState";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { Button } from "@/components/ui/button";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  canCreateDockerResourceOnNode,
  type DockerNodeScope,
  fetchDockerNodeList,
  loadVisibleDockerNodes,
} from "@/lib/docker-node-access";
import { api } from "@/services/api";
import { accessContextKey, useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import { requireLicenseFeature, usePlanIncludes } from "@/stores/license-paywall";
import type { Node as GatewayNode } from "@/types";
import { DockerBuilds } from "./DockerBuilds";
import { DockerComposeProjects } from "./DockerComposeProjects";
import { DockerContainers } from "./DockerContainers";
import { DockerImages } from "./DockerImages";
import { DockerNetworks } from "./DockerNetworks";
import { DockerTasks } from "./DockerTasks";
import { DockerVolumes } from "./DockerVolumes";
import { GwcaImportDialog } from "./docker/GwcaImportDialog";

const TABS = [
  { value: "containers", label: "Containers", scope: "docker:containers:view" },
  { value: "compose", label: "Compose", scope: "docker:compose:view" },
  { value: "images", label: "Images", scope: "docker:images:view" },
  { value: "volumes", label: "Volumes", scope: "docker:volumes:view" },
  { value: "networks", label: "Networks", scope: "docker:networks:view" },
  { value: "tasks", label: "Tasks", scope: "docker:tasks" },
  { value: "builds", label: "Builds", scope: "docker:containers:view" },
] as const;

// Creation scopes list nodes too, so a folder-only creator (whose folder may still be empty) gets the same node
// pickers the backend accepts instead of a "no Docker nodes" page.
const DOCKER_NODE_SCOPES_BY_TAB: Partial<
  Record<(typeof TABS)[number]["value"], DockerNodeScope[]>
> = {
  containers: ["docker:containers:view", "docker:containers:create"],
  images: ["docker:images:view", "docker:images:pull"],
  volumes: ["docker:volumes:view", "docker:volumes:create"],
  networks: ["docker:networks:view", "docker:networks:create"],
  compose: ["docker:compose:view", "docker:compose:create"],
};

export function Docker() {
  const { tab: tabParam } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedNodeId = searchParams.get("nodeId");
  const { hasScope, hasScopedAccess, user } = useAuthStore();
  const setSelectedNode = useDockerStore((s) => s.setSelectedNode);
  const selectedNodeId = useDockerStore((s) => s.selectedNodeId);
  const setDockerNodes = useDockerStore((s) => s.setDockerNodes);
  const fetchContainers = useDockerStore((s) => s.fetchContainers);
  const fetchImages = useDockerStore((s) => s.fetchImages);
  const fetchVolumes = useDockerStore((s) => s.fetchVolumes);
  const fetchNetworks = useDockerStore((s) => s.fetchNetworks);
  const fetchTasks = useDockerStore((s) => s.fetchTasks);
  const fetchComposeProjects = useDockerStore((s) => s.fetchComposeProjects);
  const loading = useDockerStore((s) => s.loading);
  const dockerNodes = useDockerStore((s) => s.dockerNodes);
  const [importOpen, setImportOpen] = useState(false);
  const [importDevPreview, setImportDevPreview] = useState(false);
  // Nodes the import route accepts for some destination: broad, node or folder creation grants (a folder grant
  // works on every Docker node; the dialog then offers only the folders the user may create in).
  const archiveImportNodes = dockerNodes.filter((node) =>
    canCreateDockerResourceOnNode(user?.scopes ?? [], "docker:containers:create", node.id)
  );
  const imageActionNodeId =
    selectedNodeId ?? (dockerNodes.length === 1 ? dockerNodes[0]?.id : null);
  const canPruneImages = Boolean(
    imageActionNodeId &&
      (hasScope("docker:images:delete") || hasScope(`docker:images:delete:${imageActionNodeId}`))
  );

  const deployContainerRef = useRef<(() => void) | null>(null);
  const createFolderRef = useRef<(() => void) | null>(null);
  const createImageFolderRef = useRef<(() => void) | null>(null);
  const createVolumeFolderRef = useRef<(() => void) | null>(null);
  const createNetworkFolderRef = useRef<(() => void) | null>(null);
  const createComposeFolderRef = useRef<(() => void) | null>(null);
  const createComposeRef = useRef<(() => void) | null>(null);
  const pullImageRef = useRef<(() => void) | null>(null);
  const pruneImagesRef = useRef<(() => void) | null>(null);
  const createVolumeRef = useRef<(() => void) | null>(null);
  const createNetworkRef = useRef<(() => void) | null>(null);
  const refreshContainersRef = useRef<(() => void) | null>(null);
  const refreshImagesRef = useRef<(() => void) | null>(null);
  const refreshVolumesRef = useRef<(() => void) | null>(null);
  const refreshNetworksRef = useRef<(() => void) | null>(null);
  const refreshComposeRef = useRef<(() => void) | null>(null);

  const canManageContainerFolders = hasScopedAccess("docker:folders:manage");
  // Builds come from Git push-to-deploy; past builds stay visible after the plan loses it.
  const planIncludesGitDeploy = usePlanIncludes("git-push-to-deploy");
  const planIncludesContainerExport = usePlanIncludes("container-export");
  const planIncludesCompose = usePlanIncludes("compose-applications");
  const canViewBuilds = hasScopedAccess("docker:containers:view");
  const [buildsExist, setBuildsExist] = useState(false);
  useEffect(() => {
    if (planIncludesGitDeploy || !canViewBuilds) return;
    let cancelled = false;
    void api
      .listDockerBuildPage({ limit: 1 })
      .then((page) => {
        if (!cancelled) setBuildsExist(page.data.length > 0);
      })
      .catch(() => {
        if (!cancelled) setBuildsExist(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canViewBuilds, planIncludesGitDeploy]);
  const visibleTabs = TABS.filter(
    (t) =>
      (hasScopedAccess(t.scope) || (t.value === "containers" && canManageContainerFolders)) &&
      (t.value !== "builds" || planIncludesGitDeploy || buildsExist)
  );
  const visibleTabKey = visibleTabs.map((tab) => tab.value).join("|");
  const activeTab =
    tabParam && visibleTabs.some((t) => t.value === tabParam)
      ? tabParam
      : visibleTabs[0]?.value || "containers";
  const usesFillLayout = activeTab === "tasks" || activeTab === "builds";
  const activeTabLoading =
    activeTab === "containers"
      ? loading.containers
      : activeTab === "images"
        ? loading.images
        : activeTab === "volumes"
          ? loading.volumes
          : activeTab === "networks"
            ? loading.networks
            : activeTab === "compose"
              ? loading.compose
              : activeTab === "tasks"
                ? loading.tasks
                : false;
  const nodeSelectionKey = `${accessContextKey(useAuthStore.getState())}:${activeTab}:${requestedNodeId ?? ""}`;
  const [resolvedNodeSelection, setResolvedNodeSelection] = useState("");
  const [nodeSelectionError, setNodeSelectionError] = useState<string | null>(null);
  const nodeSelectionReady = resolvedNodeSelection === nodeSelectionKey;
  const nodeActionsDisabled = !nodeSelectionReady || !!nodeSelectionError;
  const appliedNodeQuery = useRef<string | undefined>(undefined);
  // One Docker node list per node selection: the active tab and the preload of
  // the other tabs filter the same list instead of fetching it once per tab.
  const nodeListRef = useRef<{ key: string; request: Promise<GatewayNode[]> } | null>(null);
  const listDockerNodes = useCallback(() => {
    const current = nodeListRef.current;
    if (current?.key === nodeSelectionKey) return current.request;
    const request = fetchDockerNodeList();
    nodeListRef.current = { key: nodeSelectionKey, request };
    request.catch(() => {
      if (nodeListRef.current?.request === request) nodeListRef.current = null;
    });
    return request;
  }, [nodeSelectionKey]);

  // Fetch docker nodes on mount, store in zustand for multi-node fetching
  useEffect(() => {
    let cancelled = false;
    const scopeBases =
      DOCKER_NODE_SCOPES_BY_TAB[activeTab as keyof typeof DOCKER_NODE_SCOPES_BY_TAB];
    if (!scopeBases) {
      setResolvedNodeSelection(nodeSelectionKey);
      setNodeSelectionError(null);
      return;
    }
    loadVisibleDockerNodes(
      user?.scopes ?? [],
      scopeBases,
      hasScopedAccess("nodes:details"),
      listDockerNodes
    )
      .then((nodes) => {
        if (cancelled) return;
        setDockerNodes(nodes);
        if (requestedNodeId && !nodes.some((node) => node.id === requestedNodeId)) {
          setSelectedNode(null);
          setNodeSelectionError(
            "The selected Docker node is unavailable or you do not have access to it."
          );
        } else {
          if (appliedNodeQuery.current !== (requestedNodeId ?? "")) {
            setSelectedNode(requestedNodeId);
            if (requestedNodeId) useDockerStore.getState().resetFilters();
            appliedNodeQuery.current = requestedNodeId ?? "";
          }
          setNodeSelectionError(null);
        }
        setResolvedNodeSelection(nodeSelectionKey);
      })
      .catch(() => {
        if (cancelled) return;
        setNodeSelectionError("Failed to load Docker nodes.");
        setResolvedNodeSelection(nodeSelectionKey);
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeTab,
    hasScopedAccess,
    listDockerNodes,
    nodeSelectionKey,
    requestedNodeId,
    setDockerNodes,
    setSelectedNode,
    user?.scopes,
  ]);

  useEffect(() => {
    let cancelled = false;

    const preload = async () => {
      if (!nodeSelectionReady || nodeSelectionError) return;
      for (const tab of visibleTabKey.split("|").filter(Boolean)) {
        if (tab === activeTab) continue;
        if (cancelled) return;
        const scopeBases = DOCKER_NODE_SCOPES_BY_TAB[tab as keyof typeof DOCKER_NODE_SCOPES_BY_TAB];
        let nodeIdOverride: string | null | undefined;
        let nodesOverride: GatewayNode[] | undefined;
        if (scopeBases) {
          try {
            const nodes = await loadVisibleDockerNodes(
              user?.scopes ?? [],
              scopeBases,
              hasScopedAccess("nodes:details"),
              listDockerNodes
            );
            if (cancelled) return;
            const selectedNodeId = useDockerStore.getState().selectedNodeId;
            nodeIdOverride = nodes.some((node) => node.id === selectedNodeId)
              ? selectedNodeId
              : null;
            nodesOverride = nodes;
          } catch {
            continue;
          }
        }

        if (tab === "containers") await fetchContainers(nodeIdOverride, "", nodesOverride);
        if (tab === "images") await fetchImages(nodeIdOverride, "", nodesOverride);
        if (tab === "volumes") await fetchVolumes(nodeIdOverride, "", nodesOverride);
        if (tab === "networks") await fetchNetworks(nodeIdOverride, "", nodesOverride);
        if (tab === "compose") await fetchComposeProjects(nodeIdOverride);
        if (tab === "tasks") await fetchTasks(null);
      }
    };

    void preload();
    return () => {
      cancelled = true;
    };
  }, [
    activeTab,
    fetchContainers,
    fetchImages,
    fetchNetworks,
    fetchComposeProjects,
    fetchTasks,
    fetchVolumes,
    hasScopedAccess,
    listDockerNodes,
    user?.scopes,
    visibleTabKey,
    nodeSelectionReady,
    nodeSelectionError,
  ]);

  const handleTabChange = (value: string) => {
    const query = new URLSearchParams(searchParams);
    if (selectedNodeId) query.set("nodeId", selectedNodeId);
    else query.delete("nodeId");
    navigate(`/docker/${value}${query.size ? `?${query}` : ""}`, { replace: true });
  };

  const handleRefresh = async () => {
    switch (activeTab) {
      case "containers":
        return refreshContainersRef.current?.();
      case "images":
        return refreshImagesRef.current?.();
      case "volumes":
        return refreshVolumesRef.current?.();
      case "networks":
        return refreshNetworksRef.current?.();
      case "compose":
        return refreshComposeRef.current?.();
      case "tasks":
        return fetchTasks();
    }
  };

  const openImport = () => {
    if (!requireLicenseFeature("container-export", "Container archive import")) return;
    setImportDevPreview(false);
    setImportOpen(true);
  };

  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === "undefined") return;
    const gatewayDev = (window.gatewayDev ??= {});
    const openGwcaImportModal = () => {
      setImportDevPreview(true);
      setImportOpen(true);
    };
    gatewayDev.openGwcaImportModal = openGwcaImportModal;
    return () => {
      if (gatewayDev.openGwcaImportModal === openGwcaImportModal) {
        delete gatewayDev.openGwcaImportModal;
      }
    };
  }, []);

  const renderActions = () => {
    switch (activeTab) {
      case "containers":
        return (
          <>
            {canManageContainerFolders && (
              <Button
                disabled={nodeActionsDisabled}
                variant="outline"
                onClick={() => createFolderRef.current?.()}
              >
                <FolderPlus className="h-4 w-4 mr-1" />
                New Folder
              </Button>
            )}
            {planIncludesContainerExport && hasScopedAccess("docker:containers:create") && (
              <Button disabled={nodeActionsDisabled} variant="outline" onClick={openImport}>
                <ArchiveRestore className="h-4 w-4 mr-1" />
                Import .gwca
              </Button>
            )}
            {hasScopedAccess("docker:containers:create") && (
              <Button disabled={nodeActionsDisabled} onClick={() => deployContainerRef.current?.()}>
                <Plus className="h-4 w-4 mr-1" />
                Deploy
              </Button>
            )}
          </>
        );
      case "images":
        return (
          <>
            {canManageContainerFolders && (
              <Button
                disabled={nodeActionsDisabled}
                variant="outline"
                onClick={() => createImageFolderRef.current?.()}
              >
                <FolderPlus className="h-4 w-4 mr-1" />
                New Folder
              </Button>
            )}
            {canPruneImages && (
              <Button
                disabled={nodeActionsDisabled}
                variant="outline"
                onClick={() => pruneImagesRef.current?.()}
              >
                <Trash2 className="h-4 w-4 mr-1" />
                Prune Dangling
              </Button>
            )}
            {hasScopedAccess("docker:images:pull") && (
              <Button disabled={nodeActionsDisabled} onClick={() => pullImageRef.current?.()}>
                <Plus className="h-4 w-4 mr-1" />
                Pull Image
              </Button>
            )}
          </>
        );
      case "volumes":
        return (
          <>
            {canManageContainerFolders && (
              <Button
                disabled={nodeActionsDisabled}
                variant="outline"
                onClick={() => createVolumeFolderRef.current?.()}
              >
                <FolderPlus className="h-4 w-4 mr-1" />
                New Folder
              </Button>
            )}
            {hasScopedAccess("docker:volumes:create") && (
              <Button disabled={nodeActionsDisabled} onClick={() => createVolumeRef.current?.()}>
                <Plus className="h-4 w-4 mr-1" />
                Create Volume
              </Button>
            )}
          </>
        );
      case "networks":
        return (
          <>
            {canManageContainerFolders && (
              <Button
                disabled={nodeActionsDisabled}
                variant="outline"
                onClick={() => createNetworkFolderRef.current?.()}
              >
                <FolderPlus className="h-4 w-4 mr-1" />
                New Folder
              </Button>
            )}
            {hasScopedAccess("docker:networks:create") && (
              <Button disabled={nodeActionsDisabled} onClick={() => createNetworkRef.current?.()}>
                <Plus className="h-4 w-4 mr-1" />
                Create Network
              </Button>
            )}
          </>
        );
      case "compose":
        return (
          <>
            {canManageContainerFolders && (
              <Button
                disabled={nodeActionsDisabled}
                variant="outline"
                onClick={() => createComposeFolderRef.current?.()}
              >
                <FolderPlus className="h-4 w-4 mr-1" />
                New Folder
              </Button>
            )}
            {planIncludesCompose && hasScopedAccess("docker:compose:create") && (
              <Button disabled={nodeActionsDisabled} onClick={() => createComposeRef.current?.()}>
                <Plus className="h-4 w-4 mr-1" />
                New Project
              </Button>
            )}
          </>
        );
      default:
        return null;
    }
  };
  const headerActions = [
    { label: "Refresh", onClick: handleRefresh, disabled: activeTabLoading },
    ...(activeTab === "containers" && canManageContainerFolders
      ? [
          {
            label: "New Folder",
            icon: <FolderPlus className="h-4 w-4" />,
            onClick: () => createFolderRef.current?.(),
          },
        ]
      : []),
    ...(activeTab === "containers" && hasScopedAccess("docker:containers:create")
      ? [
          ...(planIncludesContainerExport
            ? [
                {
                  label: "Import .gwca",
                  icon: <ArchiveRestore className="h-4 w-4" />,
                  onClick: openImport,
                },
              ]
            : []),
          {
            label: "Deploy",
            icon: <Plus className="h-4 w-4" />,
            onClick: () => deployContainerRef.current?.(),
          },
        ]
      : []),
    ...(activeTab === "images" && canManageContainerFolders
      ? [
          {
            label: "New Folder",
            icon: <FolderPlus className="h-4 w-4" />,
            onClick: () => createImageFolderRef.current?.(),
          },
        ]
      : []),
    ...(activeTab === "images" && hasScopedAccess("docker:images:pull")
      ? [
          {
            label: "Pull Image",
            icon: <Plus className="h-4 w-4" />,
            onClick: () => pullImageRef.current?.(),
          },
        ]
      : []),
    ...(activeTab === "images" && canPruneImages
      ? [
          {
            label: "Prune Dangling",
            icon: <Trash2 className="h-4 w-4" />,
            onClick: () => pruneImagesRef.current?.(),
          },
        ]
      : []),
    ...(activeTab === "volumes" && canManageContainerFolders
      ? [
          {
            label: "New Folder",
            icon: <FolderPlus className="h-4 w-4" />,
            onClick: () => createVolumeFolderRef.current?.(),
          },
        ]
      : []),
    ...(activeTab === "volumes" && hasScopedAccess("docker:volumes:create")
      ? [
          {
            label: "Create Volume",
            icon: <Plus className="h-4 w-4" />,
            onClick: () => createVolumeRef.current?.(),
          },
        ]
      : []),
    ...(activeTab === "networks" && canManageContainerFolders
      ? [
          {
            label: "New Folder",
            icon: <FolderPlus className="h-4 w-4" />,
            onClick: () => createNetworkFolderRef.current?.(),
          },
        ]
      : []),
    ...(activeTab === "networks" && hasScopedAccess("docker:networks:create")
      ? [
          {
            label: "Create Network",
            icon: <Plus className="h-4 w-4" />,
            onClick: () => createNetworkRef.current?.(),
          },
        ]
      : []),
    ...(activeTab === "compose" && canManageContainerFolders
      ? [
          {
            label: "New Folder",
            icon: <FolderPlus className="h-4 w-4" />,
            onClick: () => createComposeFolderRef.current?.(),
          },
        ]
      : []),
    ...(activeTab === "compose" && planIncludesCompose && hasScopedAccess("docker:compose:create")
      ? [
          {
            label: "New Project",
            icon: <Plus className="h-4 w-4" />,
            onClick: () => createComposeRef.current?.(),
          },
        ]
      : []),
  ];

  const renderTabContent = (children: ReactNode) => {
    if (!nodeSelectionReady) return <ContentLoading loading />;
    if (nodeSelectionError)
      return (
        <EmptyState
          message={nodeSelectionError}
          actionLabel="View all nodes"
          onAction={() => navigate(`/docker/${activeTab}`, { replace: true })}
        />
      );
    return children;
  };
  return (
    <PageTransition>
      <div
        className={
          usesFillLayout
            ? "h-full overflow-hidden flex flex-col p-6 gap-4"
            : activeTab === "containers"
              ? "h-full overflow-y-auto px-6 pt-6 pb-3 space-y-4"
              : "h-full overflow-y-auto p-6 space-y-4"
        }
      >
        {/* Header */}
        <PageHeader
          className="shrink-0"
          leading={<LiteModeBackButton />}
          title="Docker"
          description="Manage containers, images, volumes, networks, and Compose projects"
          actions={
            <ResponsiveHeaderActions
              actions={headerActions.map((action) => ({
                ...action,
                disabled: nodeActionsDisabled || ("disabled" in action && action.disabled),
              }))}
            >
              <RefreshButton
                onClick={handleRefresh}
                disabled={nodeActionsDisabled || activeTabLoading}
              />
              {renderActions()}
            </ResponsiveHeaderActions>
          }
        />

        {/* Tabs */}
        <Tabs
          value={activeTab}
          onValueChange={handleTabChange}
          className={`flex flex-col ${usesFillLayout ? "flex-1 min-h-0" : ""}`}
        >
          <TabsList className="shrink-0">
            {visibleTabs.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value} className="gap-1.5">
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="containers">
            {renderTabContent(
              <DockerContainers
                embedded
                onDeployRef={(fn) => {
                  deployContainerRef.current = fn;
                }}
                onCreateFolderRef={(fn) => {
                  createFolderRef.current = fn;
                }}
                onRefreshRef={(fn) => {
                  refreshContainersRef.current = fn;
                }}
              />
            )}
          </TabsContent>
          <TabsContent value="images">
            {renderTabContent(
              <DockerImages
                embedded
                onPullRef={(fn) => {
                  pullImageRef.current = fn;
                }}
                onCreateFolderRef={(fn) => {
                  createImageFolderRef.current = fn;
                }}
                onRefreshRef={(fn) => {
                  refreshImagesRef.current = fn;
                }}
                onPruneRef={(fn) => {
                  pruneImagesRef.current = fn;
                }}
              />
            )}
          </TabsContent>
          <TabsContent value="volumes">
            {renderTabContent(
              <DockerVolumes
                embedded
                onCreateRef={(fn) => {
                  createVolumeRef.current = fn;
                }}
                onCreateFolderRef={(fn) => {
                  createVolumeFolderRef.current = fn;
                }}
                onRefreshRef={(fn) => {
                  refreshVolumesRef.current = fn;
                }}
              />
            )}
          </TabsContent>
          <TabsContent value="networks">
            {renderTabContent(
              <DockerNetworks
                embedded
                onCreateRef={(fn) => {
                  createNetworkRef.current = fn;
                }}
                onCreateFolderRef={(fn) => {
                  createNetworkFolderRef.current = fn;
                }}
                onRefreshRef={(fn) => {
                  refreshNetworksRef.current = fn;
                }}
              />
            )}
          </TabsContent>
          <TabsContent value="compose">
            {renderTabContent(
              <DockerComposeProjects
                embedded
                onCreateRef={(fn) => {
                  createComposeRef.current = fn;
                }}
                onCreateFolderRef={(fn) => {
                  createComposeFolderRef.current = fn;
                }}
                onRefreshRef={(fn) => {
                  refreshComposeRef.current = fn;
                }}
              />
            )}
          </TabsContent>
          <TabsContent value="tasks" className="flex flex-col flex-1 min-h-0">
            {renderTabContent(<DockerTasks embedded />)}
          </TabsContent>
          <TabsContent value="builds" className="flex flex-col flex-1 min-h-0">
            {renderTabContent(<DockerBuilds embedded />)}
          </TabsContent>
        </Tabs>
        <GwcaImportDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          nodes={archiveImportNodes}
          onImported={() => refreshContainersRef.current?.()}
          devPreview={importDevPreview}
        />
      </div>
    </PageTransition>
  );
}
