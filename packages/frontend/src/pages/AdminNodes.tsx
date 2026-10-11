import {
  ArrowUpCircle,
  Cloud,
  ExternalLink,
  FolderPlus,
  KeyRound,
  Lock,
  Unlock,
  MoreVertical,
  Plus,
  Server,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { InterfaceChoiceDialog } from "@/components/ai/InterfaceChoiceDialog";
import { ContentLoading } from "@/components/common/ContentLoading";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderedResourceList } from "@/components/common/FolderedResourceList";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { RelativeTime } from "@/components/common/RelativeTime";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { BulkNodeUpdateDialog } from "@/components/nodes/BulkNodeUpdateDialog";
import { NodeEnrollmentDialog } from "@/components/nodes/NodeEnrollmentDialog";
import { ProtectedNodeBadge } from "@/components/nodes/ProtectedNodeBadge";
import { Badge } from "@/components/ui/badge";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCanManageSomeFolders } from "@/hooks/use-folder-access";
import { useRealtime } from "@/hooks/use-realtime";
import { hostingNodeLabel } from "@/lib/hosting-status";
import {
  daemonTypeForNode,
  isDaemonUpdateAvailable,
  nodeIconClassNames,
  nodeTypeLabel,
} from "@/lib/node-appearance";
import { isNodeProtected } from "@/lib/node-host-access";
import { confirmAndDeleteNode } from "@/lib/remove-node";
import { nodeRoute } from "@/lib/resource-routes";
import { canCreateInFolder } from "@/lib/scope-utils";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { accessContextKey, useAuthStore } from "@/stores/auth";
import { useDaemonUpdatesStore } from "@/stores/daemon-updates";
import { useNodesStore } from "@/stores/nodes";
import { usePinnedNodesStore } from "@/stores/pinned-nodes";
import { useUIStore } from "@/stores/ui";
import type { Node, NodeStatus } from "@/types";
import {
  effectiveNodeStatus,
  getNodeUpdateLastError,
  isNodeIncompatible,
  isNodeUpdateQueued,
  isNodeUpdating,
} from "@/types";
import type { HostingConnector } from "@/types/hosting";
import { HOSTING_PROVIDER_LABELS, type HostingNodeBinding } from "@/types/hosting";
import { HostingIntegrationsSection } from "./settings/HostingIntegrationsSection";

const STATUS_BADGE: Record<
  string,
  "default" | "secondary" | "destructive" | "success" | "warning"
> = {
  online: "success",
  offline: "destructive",
  degraded: "warning",
  pending: "secondary",
  error: "destructive",
};

function formatDaemonVersion(version: string | null | undefined): string {
  if (!version) return "";
  return version.startsWith("v") ? version : `v${version}`;
}

export function AdminNodes() {
  const navigate = useNavigate();
  const { hasScope, hasScopedAccess } = useAuthStore();
  const authKey = useAuthStore(accessContextKey);
  const user = useAuthStore((state) => state.user);
  const canViewHosting = hasScopedAccess("integrations:hosting:view");
  const [selectedTab, setSelectedTab] = useState("nodes");
  const { nodes, isLoading, filters, total, fetchNodes, setFilters, resetFilters } =
    useNodesStore();

  const [searchInput, setSearchInput] = useState(filters.search);
  const [enrollDialogOpen, setEnrollDialogOpen] = useState(false);
  const [choiceOpen, setChoiceOpen] = useState(false);
  const [bulkUpdateOpen, setBulkUpdateOpen] = useState(false);
  const [lockingNodeId, setLockingNodeId] = useState<string | null>(null);
  const [reissueNode, setReissueNode] = useState<Node | null>(null);
  const [enrollMode, setEnrollMode] = useState<"external" | "hosting">("external");
  const [hostingUnavailable, setHostingUnavailable] = useState(false);
  const [checkingHosting, setCheckingHosting] = useState(false);
  const choiceRequest = useRef(0);
  useEffect(
    () => () => {
      choiceRequest.current += 1;
    },
    []
  );
  const closeChoice = () => {
    choiceRequest.current += 1;
    setChoiceOpen(false);
    setCheckingHosting(false);
  };
  const chooseExternal = () => {
    closeChoice();
    setEnrollMode("external");
    setEnrollDialogOpen(true);
  };
  const chooseHosted = async () => {
    const request = ++choiceRequest.current;
    setCheckingHosting(true);
    try {
      const connectors = await api.listHostingConnectors();
      if (request !== choiceRequest.current) return;
      closeChoice();
      if (!connectors.some((connector) => connector.enabled)) {
        setHostingUnavailable(true);
        return;
      }
      setEnrollMode("hosting");
      setEnrollDialogOpen(true);
    } catch (error) {
      if (request === choiceRequest.current) {
        setCheckingHosting(false);
        toast.error(
          error instanceof Error ? error.message : "Failed to load hosting integrations."
        );
      }
    }
  };
  const [hostingBindings, setHostingBindings] = useState<Record<string, HostingNodeBinding>>({});
  const [hostingAccounts, setHostingAccounts] = useState<Array<{ value: string; label: string }>>(
    []
  );
  const hostingGeneration = useRef(0);
  const [hostingSettledAuthKey, setHostingSettledAuthKey] = useState<string | null>(null);
  const updateHostingAccounts = useCallback((accounts: HostingConnector[]) => {
    setHostingAccounts(accounts.map((account) => ({ value: account.id, label: account.name })));
  }, []);
  const refreshHosting = useCallback(() => {
    const generation = ++hostingGeneration.current;
    const bindingsRequest = api
      .listNodeHostingBindings()
      .then((bindings) => {
        if (generation === hostingGeneration.current) setHostingBindings(bindings);
      })
      .catch(() => {
        if (generation === hostingGeneration.current) setHostingBindings({});
      });
    if (!canViewHosting) {
      setHostingAccounts([]);
      void bindingsRequest.finally(() => {
        if (generation === hostingGeneration.current) setHostingSettledAuthKey(authKey);
      });
      return;
    }
    const accountsRequest = api
      .listHostingConnectors()
      .then((accounts) => {
        if (generation === hostingGeneration.current) updateHostingAccounts(accounts);
      })
      .catch(() => {
        // Keep a loaded provider tab available during a transient refresh failure.
        // Identity/permission changes clear this list in the auth-context effect below.
      });
    void Promise.all([bindingsRequest, accountsRequest]).finally(() => {
      if (generation === hostingGeneration.current) setHostingSettledAuthKey(authKey);
    });
  }, [authKey, canViewHosting, updateHostingAccounts]);
  useEffect(() => {
    if (authKey !== accessContextKey(useAuthStore.getState())) return;
    setHostingAccounts([]);
    setHostingBindings({});
    setSelectedTab("nodes");
    refreshHosting();
    return () => {
      hostingGeneration.current++;
    };
  }, [refreshHosting, authKey]);
  useRealtime("integration.connector.changed", refreshHosting, { onReconnect: refreshHosting });
  const showProviderTabs = canViewHosting && hostingAccounts.length > 0;
  const activeTab = showProviderTabs ? selectedTab : "nodes";
  useEffect(() => {
    if (!showProviderTabs) setSelectedTab("nodes");
  }, [showProviderTabs]);
  const [createFolderAction, setCreateFolderAction] = useState<(() => void) | null>(null);
  const daemonUpdates = useDaemonUpdatesStore((s) => s.statuses);
  const daemonUpdatesLoaded = useDaemonUpdatesStore((s) => s.lastLoadedAt > 0);
  const fetchDaemonUpdates = useDaemonUpdatesStore((s) => s.fetchDaemonUpdates);
  // Hidden update notifications show the node's status instead of the available version.
  const showUpdateNotifications = useUIStore((s) => s.showUpdateNotifications);
  // The status column shows available daemon updates, so the first list waits for them.
  const [daemonUpdatesSettled, setDaemonUpdatesSettled] = useState(false);
  const daemonUpdatesLoading =
    hasScope("admin:update") && !daemonUpdatesLoaded && !daemonUpdatesSettled;

  const loadDaemonUpdates = useCallback(
    async (options?: { force?: boolean }) => {
      if (!hasScope("admin:update")) return;
      try {
        await fetchDaemonUpdates(options);
      } catch {
        // ignore
      }
    },
    [fetchDaemonUpdates, hasScope]
  );

  useEffect(() => {
    fetchNodes();
  }, [fetchNodes]);

  useRealtime(
    "node.changed",
    () => {
      void loadDaemonUpdates({ force: true });
    },
    {
      // Events sent while the socket was away (a Gateway restart during updates) are lost.
      onReconnect: () => {
        useNodesStore.getState().invalidate();
        void loadDaemonUpdates({ force: true });
      },
    }
  );

  // Fetch daemon update statuses
  useEffect(() => {
    void loadDaemonUpdates().finally(() => setDaemonUpdatesSettled(true));
  }, [loadDaemonUpdates]);

  // Offered while any node, on any page of the list, runs an older daemon than its type's latest.
  const canBulkUpdate =
    hasScope("admin:update") &&
    daemonUpdates.some(
      (status) =>
        (status.daemonType as string) !== "relay" &&
        status.nodes.some((entry) =>
          isDaemonUpdateAvailable(entry.currentVersion, status.latestVersion)
        )
    );

  const handleSearch = () => setFilters({ search: searchInput });
  const hasActiveFilters =
    filters.search !== "" || filters.status !== "all" || filters.hosting !== "all";
  const canManageFolders = useCanManageSomeFolders("nodes:folders:manage");

  const handleDelete = useCallback(
    async (nodeId: string, hostname: string) => {
      try {
        if (!(await confirmAndDeleteNode(nodeId, hostname))) return;
        usePinnedNodesStore.getState().removePin(nodeId);
        toast.success("Node removed");
        fetchNodes();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to remove node");
      }
    },
    [fetchNodes]
  );

  const handleServiceCreationLock = useCallback(
    async (node: Node, serviceCreationLocked: boolean) => {
      setLockingNodeId(node.id);
      try {
        await api.setNodeServiceCreationLock(node.id, serviceCreationLocked);
        toast.success(
          serviceCreationLocked ? "Service creation locked" : "Service creation unlocked"
        );
        fetchNodes();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update lock");
      } finally {
        setLockingNodeId(null);
      }
    },
    [fetchNodes]
  );
  const clearReissueNode = useCallback(() => setReissueNode(null), []);

  const columns = useMemo<ResourceListColumn<Node>[]>(
    () => [
      {
        id: "name",
        label: "Name",
        width: "34%",
        renderCell: (node) => {
          const iconClassNames = nodeIconClassNames(node.appearanceColor);
          return (
            <div className="flex min-w-0 items-center gap-4">
              <div className={iconClassNames.wrapper}>
                <Server className={cn("h-5 w-5", iconClassNames.icon)} />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{node.displayName || node.hostname}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {node.displayName ? node.hostname : ""} {formatDaemonVersion(node.daemonVersion)}
                  {hostingBindings[node.id] && (
                    <>
                      {" "}
                      ·{" "}
                      {hostingBindings[node.id].connectorName ??
                        HOSTING_PROVIDER_LABELS[hostingBindings[node.id].provider]}
                    </>
                  )}
                </p>
              </div>
            </div>
          );
        },
      },
      {
        id: "type",
        label: "Type",
        width: "13%",
        align: "right",
        renderCell: (node) => <Badge variant="secondary">{nodeTypeLabel(node.type)}</Badge>,
      },
      {
        id: "lock",
        label: "Lock",
        width: "13%",
        align: "right",
        renderCell: (node) =>
          isNodeProtected(node) ? (
            <ProtectedNodeBadge label="PROTECTED" />
          ) : (node.type === "nginx" || node.type === "docker") && node.serviceCreationLocked ? (
            <Badge variant="warning">LOCKED</Badge>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
      {
        id: "lastSeen",
        label: "Last Seen",
        width: "16%",
        align: "right",
        renderCell: (node) => (
          <Badge variant="outline">
            <RelativeTime value={node.lastSeenAt} fallback="Never" />
          </Badge>
        ),
      },
      {
        id: "status",
        label: "Status",
        width: "14%",
        align: "right",
        renderCell: (node) => {
          if (isNodeUpdating(node)) {
            return (
              <Badge variant="warning">{isNodeUpdateQueued(node) ? "QUEUED" : "UPDATING"}</Badge>
            );
          }
          if (isNodeIncompatible(node)) return <Badge variant="destructive">INCOMPATIBLE</Badge>;
          const hostingPhase = hostingBindings[node.id]?.operationPhase;
          const hostingAction = hostingBindings[node.id]?.operationAction;
          if (
            (node.status === "pending" ||
              ["create", "install", "delete"].includes(hostingAction ?? "")) &&
            hostingPhase &&
            hostingPhase !== "ready"
          ) {
            return (
              <Badge variant={hostingPhase === "failed" ? "destructive" : "warning"}>
                {hostingPhase === "failed"
                  ? "Provisioning failed"
                  : hostingNodeLabel({
                      action: hostingAction ?? "create",
                      phase: hostingPhase,
                    })}
              </Badge>
            );
          }
          const eStatus = effectiveNodeStatus(node);
          const daemonType = daemonTypeForNode(node.type);
          const typeStatus = daemonUpdates.find((s) => s.daemonType === daemonType);
          if (
            showUpdateNotifications &&
            eStatus === "online" &&
            isDaemonUpdateAvailable(node.daemonVersion, typeStatus?.latestVersion)
          ) {
            const lastError = getNodeUpdateLastError(node);
            return (
              <Badge
                variant="warning-solid"
                title={lastError ? `Last update failed: ${lastError.message}` : undefined}
              >
                {typeStatus?.latestVersion}
              </Badge>
            );
          }
          return <Badge variant={STATUS_BADGE[eStatus] || "secondary"}>{eStatus}</Badge>;
        },
      },
      {
        id: "actions",
        label: "Actions",
        width: "5rem",
        align: "right",
        renderCell: (node) => {
          const binding = hostingBindings[node.id];
          const hostingBusy =
            ["create", "install", "delete"].includes(binding?.operationAction ?? "") &&
            !["ready", "failed"].includes(binding?.operationPhase ?? "ready");
          const updating = isNodeUpdating(node);
          // The node page's actions, with the same grants and locks.
          const actionsLocked = updating || node.status === "pending" || hostingBusy;
          const canLock =
            (node.type === "nginx" || node.type === "docker") &&
            (hasScope("nodes:lock") || hasScope(`nodes:lock:${node.id}`));
          const canReissue =
            node.status === "pending" &&
            !binding &&
            (hasScope(`nodes:manage:${node.id}`) ||
              canCreateInFolder(user?.scopes ?? [], "nodes:create", node.folderId, node.id));
          const canRemove = hasScope("nodes:delete") || hasScope(`nodes:delete:${node.id}`);
          if (!canLock && !canReissue && !canRemove) return null;
          return (
            <div
              className="flex justify-end"
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    pending={lockingNodeId === node.id}
                    aria-label={`${node.displayName || node.hostname} actions`}
                  >
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => navigate(nodeRoute(node.slug))}>
                    <ExternalLink className="h-4 w-4" />
                    Open
                  </DropdownMenuItem>
                  {canLock && (
                    <DropdownMenuItem
                      disabled={actionsLocked || lockingNodeId !== null}
                      onClick={() =>
                        void handleServiceCreationLock(node, !node.serviceCreationLocked)
                      }
                    >
                      {node.serviceCreationLocked ? (
                        <Unlock className="h-4 w-4" />
                      ) : (
                        <Lock className="h-4 w-4" />
                      )}
                      {node.serviceCreationLocked ? "Unlock new services" : "Lock new services"}
                    </DropdownMenuItem>
                  )}
                  {canReissue && (
                    <DropdownMenuItem
                      disabled={reissueNode !== null}
                      onClick={() => setReissueNode(node)}
                    >
                      <KeyRound className="h-4 w-4" />
                      New enrollment token
                    </DropdownMenuItem>
                  )}
                  {canRemove && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive"
                        disabled={updating || (node.status !== "pending" && hostingBusy)}
                        onClick={() => void handleDelete(node.id, node.hostname)}
                      >
                        <Trash2 className="h-4 w-4" />
                        Remove
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        },
      },
    ],
    [
      daemonUpdates,
      hasScope,
      handleDelete,
      handleServiceCreationLock,
      hostingBindings,
      lockingNodeId,
      navigate,
      reissueNode,
      showUpdateNotifications,
      user?.scopes,
    ]
  );

  return (
    <PageTransition>
      <ContentLoading loading={hostingSettledAuthKey !== authKey || daemonUpdatesLoading} />
      <div className="h-full overflow-y-auto p-6 space-y-4">
        <PageHeader
          leading={<LiteModeBackButton />}
          title="Nodes"
          description={
            activeTab === "providers"
              ? `${hostingAccounts.length} hosting account${hostingAccounts.length === 1 ? "" : "s"} connected`
              : `${total} node${total !== 1 ? "s" : ""} registered`
          }
          actions={
            activeTab === "nodes" && (
              <ResponsiveHeaderActions
                actions={[
                  ...(canBulkUpdate
                    ? [
                        {
                          label: "Update Nodes",
                          icon: <ArrowUpCircle className="h-4 w-4" />,
                          onClick: () => setBulkUpdateOpen(true),
                        },
                      ]
                    : []),
                  ...(canManageFolders && createFolderAction
                    ? [
                        {
                          label: "Add Folder",
                          icon: <FolderPlus className="h-4 w-4" />,
                          onClick: createFolderAction,
                        },
                      ]
                    : []),
                  ...(hasScopedAccess("nodes:create")
                    ? [
                        {
                          label: "Add Node",
                          icon: <Plus className="h-4 w-4" />,
                          onClick: () => setChoiceOpen(true),
                        },
                      ]
                    : []),
                ]}
              >
                {canBulkUpdate && (
                  <Button variant="outline" onClick={() => setBulkUpdateOpen(true)}>
                    <ArrowUpCircle className="h-4 w-4" />
                    Update Nodes
                  </Button>
                )}
                {canManageFolders && (
                  <Button variant="outline" onClick={() => createFolderAction?.()}>
                    <FolderPlus className="h-4 w-4" />
                    Add Folder
                  </Button>
                )}
                {hasScopedAccess("nodes:create") && (
                  <Button onClick={() => setChoiceOpen(true)}>
                    <Plus className="h-4 w-4" />
                    Add Node
                  </Button>
                )}
              </ResponsiveHeaderActions>
            )
          }
        />

        <Tabs value={activeTab} onValueChange={setSelectedTab}>
          {showProviderTabs && (
            <TabsList aria-label="Infrastructure views">
              <TabsTrigger value="nodes">Nodes</TabsTrigger>
              <TabsTrigger value="providers">Providers</TabsTrigger>
            </TabsList>
          )}
          <TabsContent value="nodes" className={showProviderTabs ? undefined : "mt-0"}>
            <FolderedResourceList<Node>
              resourceType="node"
              realtimeChannel="node.folder.changed"
              resources={nodes}
              columns={columns}
              search={{
                search: searchInput,
                onSearchChange: setSearchInput,
                onSearchSubmit: handleSearch,
                placeholder: "Search by hostname...",
                hasActiveFilters,
                onReset: () => {
                  setSearchInput("");
                  resetFilters();
                },
                filters: (
                  <>
                    <Select
                      value={filters.hosting}
                      onValueChange={(hosting) => setFilters({ hosting })}
                    >
                      <SelectTrigger className="w-36">
                        <SelectValue placeholder="Hosting" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All hosting</SelectItem>
                        <SelectItem value="unmanaged">No hosting link</SelectItem>
                        {hostingAccounts.map((account) => (
                          <SelectItem key={account.value} value={account.value}>
                            {account.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={filters.status}
                      onValueChange={(v) => setFilters({ status: v as NodeStatus | "all" })}
                    >
                      <SelectTrigger className="w-36">
                        <SelectValue placeholder="Status" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All statuses</SelectItem>
                        <SelectItem value="online">Online</SelectItem>
                        <SelectItem value="offline">Offline</SelectItem>
                        <SelectItem value="pending">Pending</SelectItem>
                        <SelectItem value="error">Error</SelectItem>
                      </SelectContent>
                    </Select>
                  </>
                ),
              }}
              loading={isLoading}
              loadingLabel="Loading nodes..."
              emptyState={
                <EmptyState
                  message="No nodes found. Add a node to start managing infrastructure remotely."
                  actionLabel={hasScopedAccess("nodes:create") ? "Add Node" : undefined}
                  onAction={hasScopedAccess("nodes:create") ? () => setChoiceOpen(true) : undefined}
                  hasActiveFilters={hasActiveFilters}
                  onReset={() => {
                    setSearchInput("");
                    resetFilters();
                  }}
                />
              }
              minWidth={900}
              canManageFolders={canManageFolders}
              canViewItem={(node) =>
                hasScope("nodes:details") || hasScope(`nodes:details:${node.id}`)
              }
              canReorganizeItem={() => canManageFolders}
              getResourceLabel={(node) => node.displayName || node.hostname}
              onItemClick={(node) => navigate(nodeRoute(node.slug))}
              onRefresh={() => fetchNodes()}
              onCreateFolderRef={(fn) => setCreateFolderAction(() => fn)}
            />
          </TabsContent>
          {showProviderTabs && (
            <TabsContent value="providers">
              <HostingIntegrationsSection
                key={authKey}
                title="Providers"
                onConnectorsChange={updateHostingAccounts}
              />
            </TabsContent>
          )}
        </Tabs>
      </div>

      <InterfaceChoiceDialog
        open={choiceOpen}
        busy={checkingHosting}
        onOpenChange={(open) => !open && closeChoice()}
        title="Add Node"
        description="Connect an existing machine or create a new VM through a hosting integration."
        choices={[
          {
            label: "External VM",
            icon: Server,
            description:
              "Connect a machine you already manage. Run the setup command on that host to install the daemon and enroll it with Gateway.",
            onSelect: chooseExternal,
          },
          {
            label: "Hosted VM",
            icon: Cloud,
            description:
              "Create a VM using a connected hosting provider. Gateway provisions the machine, installs the daemon and enrolls the node automatically.",
            onSelect: () => void chooseHosted(),
          },
        ]}
      />
      <Dialog open={hostingUnavailable} onOpenChange={setHostingUnavailable}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Connect a Hosting Provider</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            To create a hosted VM, connect or enable a hosting provider in Integrations first. You
            can still connect an existing machine as an External VM.
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHostingUnavailable(false)}>
              Close
            </Button>
            <Button
              onClick={() => {
                setHostingUnavailable(false);
                navigate("/settings/integrations", {
                  state: { scrollTarget: "hosting-integrations" },
                });
              }}
            >
              Open integrations
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <NodeEnrollmentDialog
        open={enrollDialogOpen}
        onOpenChange={setEnrollDialogOpen}
        initialMode={enrollMode}
        lockMode
        onNodeCreated={() => fetchNodes()}
        onNodeEnrolled={() => fetchNodes()}
        onHostingCreated={fetchNodes}
        reissueNode={reissueNode}
        onReissueHandled={clearReissueNode}
      />
      <BulkNodeUpdateDialog open={bulkUpdateOpen} onOpenChange={setBulkUpdateOpen} />
    </PageTransition>
  );
}
