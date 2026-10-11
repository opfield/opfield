import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  ArrowUpCircle,
  Camera,
  Database,
  Folder,
  KeyRound,
  LayoutDashboard,
  ListTodo,
  Minus,
  Pin,
  Plus,
  Power,
  PowerOff,
  RotateCcw,
  Scaling,
  ScrollText,
  Server,
  Settings,
  Shield,
  Terminal,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { Combobox, type ComboboxOption } from "@/components/common/Combobox";
import { confirm } from "@/components/common/ConfirmDialog";
import { ContentLoading } from "@/components/common/ContentLoading";
import { DetailPageSkeleton } from "@/components/common/DetailPageSkeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { Notice } from "@/components/common/Notice";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { HostingResizeDialog } from "@/components/nodes/HostingResizeDialog";
import { NodeEnrollmentDialog } from "@/components/nodes/NodeEnrollmentDialog";
import { NodeFirewallTab } from "@/components/nodes/NodeFirewallTab";
import { NodeSnapshotsTab } from "@/components/nodes/NodeSnapshotsTab";
import { ProtectedNodeBadge } from "@/components/nodes/ProtectedNodeBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HealthBars } from "@/components/ui/health-bars";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRealtime } from "@/hooks/use-realtime";
import { useStableNavigate } from "@/hooks/use-stable-navigate";
import { useUrlTab } from "@/hooks/use-url-tab";
import { getForcedDaemonUpdateForNode } from "@/lib/dev-force-updates";
import { performHostingAction } from "@/lib/hosting-intents";
import {
  hostingNodeLabel,
  hostingOperationPending,
  hostingPowerActionUnavailableReason,
} from "@/lib/hosting-status";
import { isManagedDatabaseCandidateNode } from "@/lib/managed-database-nodes";
import {
  daemonTypeForNode,
  getNodeAppearanceColor,
  isDaemonUpdateAvailable,
  NODE_APPEARANCE_COLOR_OPTIONS,
  nodeTypeLabel,
} from "@/lib/node-appearance";
import { nodeChangesFor } from "@/lib/node-changed";
import {
  isNodeHostFeatureDisabled,
  isNodeProtected,
  nodeConsoleUnavailableMessage,
  nodeHostFeatureDisabledMessage,
  nodeHostFileAccessWarning,
} from "@/lib/node-host-access";
import { confirmAndDeleteNode } from "@/lib/remove-node";
import { dockerNodeListRoute, nodeRoute } from "@/lib/resource-routes";
import { createReturnNavigationState } from "@/lib/return-navigation";
import { canCreateInFolder } from "@/lib/scope-utils";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { accessContextKey, useAuthStore } from "@/stores/auth";
import { useDaemonUpdatesStore } from "@/stores/daemon-updates";
import { useDockerStore } from "@/stores/docker";
import { usePinnedNodesStore } from "@/stores/pinned-nodes";
import type { DockerRuntimeStatus, Node, NodeAppearanceColor, NodeDetail } from "@/types";
import {
  effectiveNodeStatus,
  getNodeUpdateTargetVersion,
  isNodeIncompatible,
  isNodeUpdateWaitingForTasks,
  isNodeUpdating,
} from "@/types";
import type {
  HostingAction,
  HostingCatalog,
  HostingNodeProjection,
  HostingResource,
} from "@/types/hosting";
import { Databases } from "./Databases";
import { type FileManagerOperations, FilesTab } from "./docker-detail/FilesTab";
import { BuilderJobsTab } from "./node-detail/BuilderJobsTab";
import { NodeConfigTab } from "./node-detail/NodeConfigTab";
import { NodeConsoleTab } from "./node-detail/NodeConsoleTab";
import { NodeDetailsTab } from "./node-detail/NodeDetailsTab";
import { NodeLogsTab } from "./node-detail/NodeLogsTab";
import { NodeMonitoringTab } from "./node-detail/NodeMonitoringTab";
import { NodeNginxLogsTab } from "./node-detail/NodeNginxLogsTab";

const STATUS_BADGE: Record<
  string,
  "default" | "secondary" | "destructive" | "success" | "warning"
> = {
  online: "success",
  offline: "destructive",
  degraded: "warning",
  pending: "secondary",
  "provisioning failed": "destructive",
  error: "destructive",
  updating: "warning",
};

const OFFLINE_DISABLED_TABS = new Set([
  "monitoring",
  "files",
  "console",
  "nginx-logs",
  "daemon-logs",
]);

const MAX_SERVICE_ADDRESSES = 10;
const SERVICE_ADDRESS_HOSTNAME_RE =
  /^(?=.{1,253}\.?$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.?$/;

function isValidServiceAddress(value: string): boolean {
  if (value.length > 255) return false;
  if (SERVICE_ADDRESS_HOSTNAME_RE.test(value)) return true;
  if (!value.includes(":")) return false;
  try {
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}

type ServiceAddressRow = {
  id: number;
  value: string;
};

export function AdminNodeDetail({
  resolvedNodeId,
  resolvedNodeSlug,
}: {
  resolvedNodeId?: string;
  resolvedNodeSlug?: string;
} = {}) {
  const params = useParams<{ id?: string; nodeSlug?: string; tab?: string }>();
  const id = resolvedNodeId ?? params.id;
  const routeSlug = resolvedNodeSlug ?? params.nodeSlug ?? params.id ?? "";
  const navigate = useStableNavigate();
  const location = useLocation();
  const { user, hasScope } = useAuthStore();

  const [node, setNode] = useState<NodeDetail | null>(null);
  const [hosting, setHosting] = useState<HostingNodeProjection | null>(null);
  const [hostingLoadState, setHostingLoadState] = useState<"loading" | "ready" | "error">(
    "loading"
  );
  const hostingAuthKey = accessContextKey(useAuthStore.getState());
  const [resizeContext, setResizeContext] = useState<{
    resource: HostingResource;
    catalog: HostingCatalog;
  } | null>(null);
  const [resizeLoading, setResizeLoading] = useState(false);
  const resizeReadGeneration = useRef(0);
  const resizeReadIdentity = useRef({ id, user });
  useEffect(() => {
    resizeReadIdentity.current = { id, user };
    resizeReadGeneration.current++;
    setResizeContext(null);
    setResizeLoading(false);
    return () => {
      resizeReadGeneration.current++;
    };
  }, [id, user]);
  const openHostingResize = async () => {
    if (!hosting?.connectorId || !hosting.resourceId || resizeLoading) return;
    const target = hosting;
    const generation = ++resizeReadGeneration.current;
    const authKey = accessContextKey(useAuthStore.getState());
    setResizeLoading(true);
    try {
      const [resources, catalog] = await Promise.all([
        api.listHostingResources(target.connectorId!),
        api.getHostingCatalog(target.connectorId!),
      ]);
      if (
        generation !== resizeReadGeneration.current ||
        authKey !== accessContextKey(useAuthStore.getState())
      )
        return;
      const resource = resources.find((r) => r.id === target.resourceId);
      if (!resource)
        throw new Error("The VM is no longer available for resizing. Refresh this node.");
      setResizeContext({ resource, catalog });
    } catch (e) {
      if (generation === resizeReadGeneration.current)
        toast.error(e instanceof Error ? e.message : "Could not load resize options");
    } finally {
      if (generation === resizeReadGeneration.current) setResizeLoading(false);
    }
  };
  const hostingReadGeneration = useRef(0);
  const hostingActionPending = useRef(false);
  const refreshHosting = useCallback(() => {
    if (!id) return;
    const generation = ++hostingReadGeneration.current;
    void api
      .getNodeHosting(id)
      .then((value) => {
        if (
          generation !== hostingReadGeneration.current ||
          hostingAuthKey !== accessContextKey(useAuthStore.getState())
        )
          return;
        setHosting(value);
        setHostingLoadState("ready");
      })
      .catch((error) => {
        if (
          generation !== hostingReadGeneration.current ||
          hostingAuthKey !== accessContextKey(useAuthStore.getState())
        )
          return;
        if (error instanceof ApiRequestError && [403, 404].includes(error.status)) {
          setHosting(null);
          setHostingLoadState("ready");
        } else {
          // A failed refresh is not evidence that the hosting binding or access disappeared.
          setHostingLoadState("error");
        }
      });
  }, [id, hostingAuthKey]);
  useEffect(() => {
    setHosting(null);
    setHostingLoadState("loading");
    refreshHosting();
    return () => {
      hostingReadGeneration.current += 1;
    };
  }, [refreshHosting]);
  useRealtime("integration.connector.changed", refreshHosting);
  const hostingAction = async (action: HostingAction) => {
    if (
      hostingActionPending.current ||
      !user ||
      !hosting?.connectorId ||
      !hosting.resourceId ||
      !hosting.incarnation ||
      hostingOperationPending(hosting.operation) ||
      hostingPowerActionUnavailableReason(action, hosting.powerState) ||
      !hosting.actions[action]?.available
    )
      return;
    hostingActionPending.current = true;
    try {
      if (
        !(await confirm({
          title:
            action === "delete"
              ? hosting.provider === "hostkey"
                ? "Cancel hosted server rental"
                : "Destroy hosted VM"
              : `${action === "recover" ? "Restart daemon on" : action} provider VM`,
          description: `This affects every Gateway role and workload on ${hosting.kind.toUpperCase()} ${hosting.remoteId}. ${action === "delete" ? "The VM and its data will be deleted, followed by its associated Gateway nodes. Proxmox VMs are shut down first." : action === "recover" ? "Restart only the known Gateway daemon services, without rebooting or reinstalling the VM." : "Provider VM power operations may interrupt traffic and running workloads."}`,
          variant: action === "start" ? "default" : "destructive",
        }))
      )
        return;
      const operation = await performHostingAction(hosting.resourceId, {
        action,
        expectedIncarnation: hosting.incarnation,
        confirmed: true,
      });
      setHosting((current) => (current ? { ...current, operation } : current));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Hosting action failed");
    } finally {
      hostingActionPending.current = false;
    }
  };
  const hostingActions = hosting
    ? [
        ...(hosting.connectorId && hasScope(`integrations:hosting:view:${hosting.connectorId}`)
          ? [
              {
                label: "Hosting account",
                icon: <Server className="h-4 w-4" />,
                alwaysOverflow: true,
                onClick: () =>
                  navigate(`/hosting/${hosting.connectorId}`, {
                    state: createReturnNavigationState(location),
                  }),
              },
              ...(hosting.actions.resize?.available
                ? [
                    {
                      label: "Resize VM",
                      alwaysOverflow: true,
                      icon: <Scaling className="h-4 w-4" />,
                      onClick: () => void openHostingResize(),
                      disabled: resizeLoading,
                    },
                  ]
                : []),
            ]
          : []),
        ...(["start", "shutdown", "reboot", "recover", "delete"] as const).map((action) => ({
          label:
            action === "recover"
              ? "Restart daemon"
              : action === "delete"
                ? hosting.provider === "hostkey"
                  ? "Cancel server rental"
                  : "Destroy VM"
                : `${action === "start" ? "Start" : action === "shutdown" ? "Shutdown" : "Reboot"} VM`,
          onClick: () => void hostingAction(action),
          icon:
            action === "delete" ? (
              <Trash2 className="h-4 w-4" />
            ) : action === "reboot" || action === "recover" ? (
              <RotateCcw className="h-4 w-4" />
            ) : action === "shutdown" ? (
              <PowerOff className="h-4 w-4" />
            ) : (
              <Power className="h-4 w-4" />
            ),
          separatorBefore: action === "start" || action === "recover" || action === "delete",
          disabled:
            hostingOperationPending(hosting.operation) ||
            !hosting.actions[action]?.available ||
            !!hostingPowerActionUnavailableReason(action, hosting.powerState),
          disabledReason:
            hosting.actions[action]?.reason ??
            hostingPowerActionUnavailableReason(action, hosting.powerState),
          destructive: action === "delete",
          alwaysOverflow: !(
            (action === "start" || action === "shutdown") &&
            !hostingPowerActionUnavailableReason(action, hosting.powerState) &&
            hosting.actions[action]?.available
          ),
        })),
      ]
    : [];
  const [healthHistory, setHealthHistory] = useState<Array<{ ts: string; status: string }>>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [activeTab, setActiveTab] = useUrlTab(
    [
      "overview",
      "details",
      "monitoring",
      "firewall",
      "snapshots",
      "databases",
      "files",
      "console",
      "configuration",
      "nginx-logs",
      "containers",
      "images",
      "volumes",
      "networks",
      "compose",
      "jobs",
      "daemon-logs",
    ],
    "overview",
    (tab) => nodeRoute(routeSlug, tab)
  );

  // Appearance dialog
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [appearanceName, setAppearanceName] = useState("");
  const [appearanceColor, setAppearanceColor] = useState<NodeAppearanceColor | null>(null);
  const [builderParallelism, setBuilderParallelism] = useState(1);
  const [builderTimeoutMinutes, setBuilderTimeoutMinutes] = useState(30);
  const [serviceAddressRows, setServiceAddressRows] = useState<ServiceAddressRow[]>([
    { id: 0, value: "" },
  ]);
  const [appearanceSaving, setAppearanceSaving] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [lockSaving, setLockSaving] = useState(false);
  const daemonUpdates = useDaemonUpdatesStore((s) => s.statuses);
  const daemonUpdatesLoaded = useDaemonUpdatesStore((s) => s.lastLoadedAt > 0);
  const fetchDaemonUpdates = useDaemonUpdatesStore((s) => s.fetchDaemonUpdates);
  const setDaemonUpdates = useDaemonUpdatesStore((s) => s.setDaemonUpdates);
  const [daemonUpdatesSettled, setDaemonUpdatesSettled] = useState(false);

  // Pin dialog
  const [pinOpen, setPinOpen] = useState(false);
  const [reissueNode, setReissueNode] = useState<Node | null>(null);
  const clearReissueNode = useCallback(() => setReissueNode(null), []);
  const { isPinnedDashboard, isPinnedSidebar, toggleDashboard, toggleSidebar } =
    usePinnedNodesStore();
  // An update that waits for the node's running tasks has restarted nothing: the node page stays usable.
  const nodeUpdating = node ? isNodeUpdating(node) && !isNodeUpdateWaitingForTasks(node) : false;
  const nodeUnavailable =
    node?.status === "pending" ||
    (hostingOperationPending(hosting?.operation) &&
      ["create", "install", "delete", "snapshot_restore"].includes(
        hosting?.operation?.action ?? ""
      ));
  const nodeActionsLocked =
    nodeUpdating ||
    node?.status === "pending" ||
    (hostingOperationPending(hosting?.operation) &&
      ["create", "install", "delete", "snapshot_restore"].includes(
        hosting?.operation?.action ?? ""
      ));
  const nodeOffline = node?.status !== "online" || nodeUnavailable;
  const nodeRemovalLocked = nodeUpdating || (nodeActionsLocked && node?.status !== "pending");
  const localIpAddresses = useMemo(
    () =>
      Array.from(
        new Set(
          node?.liveHealthReport?.localIpAddresses ?? node?.lastHealthReport?.localIpAddresses ?? []
        )
      ).sort(),
    [node?.lastHealthReport?.localIpAddresses, node?.liveHealthReport?.localIpAddresses]
  );
  const publicIpAddresses = useMemo(
    () =>
      Array.from(
        new Set(
          node?.liveHealthReport?.publicIpAddresses ??
            node?.lastHealthReport?.publicIpAddresses ??
            []
        )
      ).sort(),
    [node?.lastHealthReport?.publicIpAddresses, node?.liveHealthReport?.publicIpAddresses]
  );
  const nginxPublicAddresses = node?.publicServiceAddresses ?? [];
  const automaticServiceAddress =
    node?.type === "nginx" ? nginxPublicAddresses[0] : localIpAddresses[0] || publicIpAddresses[0];
  const serviceAddressOptions = useMemo<ComboboxOption[]>(() => {
    const options: ComboboxOption[] = [
      {
        value: "",
        label: automaticServiceAddress
          ? `Automatic (${automaticServiceAddress})`
          : "Automatic (no IP reported)",
        group: "Address mode",
        keywords: "automatic detected",
      },
    ];
    const seen = new Set([""]);
    const addAddresses = (addresses: string[], group: string) => {
      for (const address of addresses) {
        if (seen.has(address)) continue;
        seen.add(address);
        options.push({ value: address, label: address, group });
      }
    };
    if (node?.type !== "nginx") addAddresses(localIpAddresses, "Local addresses");
    addAddresses(
      node?.type === "nginx" ? nginxPublicAddresses : publicIpAddresses,
      "Detected public addresses"
    );
    return options;
  }, [
    automaticServiceAddress,
    localIpAddresses,
    nginxPublicAddresses,
    node?.type,
    publicIpAddresses,
  ]);
  const trimmedServiceAddresses = serviceAddressRows.map((row) => row.value.trim());
  const configuredServiceAddresses = trimmedServiceAddresses.filter(Boolean);
  const serviceAddressesDuplicate =
    new Set(configuredServiceAddresses).size !== configuredServiceAddresses.length;
  const serviceAddressesIncomplete = trimmedServiceAddresses.slice(1).some((address) => !address);
  const serviceAddressesInvalid = configuredServiceAddresses.some(
    (address) => !isValidServiceAddress(address)
  );
  const nonInteractiveWhileUpdating =
    nodeUpdating && activeTab !== "overview" && activeTab !== "jobs" && activeTab !== "daemon-logs";
  const canUseNodeConsole = !!(id && hasScope(`nodes:console:${id}`)) || hasScope("nodes:console");
  const canViewNodeLogs = !!(id && hasScope(`nodes:logs:${id}`)) || hasScope("nodes:logs");
  const canManageNode = !!id && hasScope(`nodes:manage:${id}`);
  const canViewNodeConfig =
    !!(id && hasScope(`nodes:config:view:${id}`)) || hasScope("nodes:config:view") || canManageNode;
  const canViewNodeDetails = !!(id && hasScope(`nodes:details:${id}`)) || hasScope("nodes:details");
  const firewallProvider =
    hosting?.provider === "digitalocean" ||
    hosting?.provider === "cloudblast" ||
    hosting?.provider === "proxmox"
      ? hosting.provider
      : null;
  const canViewNodeFirewall = Boolean(
    node &&
      (hosting?.kind === "vm" || (hosting?.provider === "proxmox" && hosting.kind === "ct")) &&
      hosting.resourceId &&
      hosting.connectorId &&
      firewallProvider &&
      canViewNodeDetails &&
      canViewNodeConfig &&
      hasScope(`integrations:hosting:view:${hosting.connectorId}`)
  );
  const firewallMutationLocked = Boolean(
    node?.status === "pending" ||
      (hostingOperationPending(hosting?.operation) &&
        ["create", "install", "delete", "snapshot_restore"].includes(
          hosting?.operation?.action ?? ""
        ))
  );
  // Mirrors PATCH /nodes/:id: a service address (Docker, Nginx, database and storage nodes) is node configuration,
  // so it needs node rename and node manage.
  const canEditNodeServiceAddress = canManageNode;
  const canEditBuilderSettings = !!id && node?.type === "builder" && canManageNode;
  // Secure runtime setup restarts this node's Docker daemon: node manage (admin:update still works for one release).
  const canManageSecureRuntime = canManageNode || hasScope("admin:update");
  // A protected relay: its machine owner locked Gateway out of the host, so it has no Files or Console tab.
  const nodeProtected = isNodeProtected(node);
  const canReadNodeFiles =
    !!id && !nodeProtected && (hasScope("nodes:files:read") || hasScope(`nodes:files:read:${id}`));
  const canWriteNodeFiles =
    !!id &&
    !nodeProtected &&
    (hasScope("nodes:files:write") || hasScope(`nodes:files:write:${id}`));
  const isCompatibleNode = !!node && !isNodeIncompatible(node);
  const canShowNodeConsole =
    isCompatibleNode &&
    !nodeProtected &&
    !nodeUpdating &&
    (node.status === "online" || node.status === "offline") &&
    canUseNodeConsole;
  // The node operator turned these off in the daemon config file; Gateway cannot turn them back on.
  const nodeConsoleUnavailable = nodeConsoleUnavailableMessage(node);
  const nodeFilesDisabled = isNodeHostFeatureDisabled(node, "files");
  const hostFileAccessWarning = nodeHostFileAccessWarning(node);
  const hostFileAccessNotice = hostFileAccessWarning && (
    <Notice tone="warning" className="mb-3" title={hostFileAccessWarning.title}>
      {hostFileAccessWarning.message}
    </Notice>
  );
  const canManageServiceCreationLock =
    !!node &&
    (node.type === "nginx" || node.type === "docker") &&
    (hasScope("nodes:lock") || hasScope(`nodes:lock:${node.id}`));
  const canRenameNode = !!id && hasScope(`nodes:rename:${id}`);
  const canOpenNodeSettings = canRenameNode || canEditBuilderSettings;
  const daemonUpdate = useMemo(() => {
    if (!id || !node) return { available: false, latestVersion: null };
    const forced = getForcedDaemonUpdateForNode(node);
    if (forced) return forced;
    const daemonType = daemonTypeForNode(node.type);
    const latestVersion = daemonUpdates.find(
      (status) => status.daemonType === daemonType
    )?.latestVersion;
    const available = isDaemonUpdateAvailable(node.daemonVersion, latestVersion);
    return { available, latestVersion: available ? latestVersion : null };
  }, [daemonUpdates, id, node]);
  const visibleTabs = useMemo(
    () => [
      "overview",
      ...(isCompatibleNode ? ["monitoring"] : []),
      ...(canViewNodeFirewall ? ["firewall"] : []),
      ...(hosting?.resourceId &&
      hasScope(`hosting:resources:view:${hosting.resourceId}`) &&
      hasScope(`hosting:snapshots:view:${hosting.resourceId}`)
        ? ["snapshots"]
        : []),
      ...(isCompatibleNode && isManagedDatabaseCandidateNode(node) ? ["databases"] : []),
      ...(isCompatibleNode && node.type === "nginx" && canViewNodeConfig ? ["configuration"] : []),
      ...(isCompatibleNode && node.type === "nginx" && canViewNodeLogs ? ["nginx-logs"] : []),
      ...(isCompatibleNode && canReadNodeFiles ? ["files"] : []),
      ...(node?.type === "builder" ? ["jobs"] : []),
      ...(canShowNodeConsole ? ["console"] : []),
      ...(canViewNodeLogs ? ["daemon-logs"] : []),
    ],
    [
      canReadNodeFiles,
      canShowNodeConsole,
      canViewNodeConfig,
      canViewNodeFirewall,
      canViewNodeLogs,
      isCompatibleNode,
      hosting?.resourceId,
      hasScope,
      node,
    ]
  );

  const nodeFileOperations = useMemo<FileManagerOperations | undefined>(() => {
    if (!id || !canReadNodeFiles) return undefined;
    const readOperations = {
      listDirectory: (path: string) => api.listNodeDir(id, path),
      readFile: (path: string) => api.readNodeFile(id, path),
      openFile: (filePath: string, writable = false) => {
        const params = new URLSearchParams({ path: filePath });
        if (writable && canWriteNodeFiles) params.set("writable", "1");
        const fileName = filePath.split("/").pop() || "file";
        window.open(
          `/nodes/file/${id}?${params}`,
          `node-file-${id}-${fileName}`,
          "width=900,height=600,menubar=no,toolbar=no"
        );
      },
    };
    if (!canWriteNodeFiles) return readOperations;
    return {
      ...readOperations,
      createFile: (path, content, onProgress) => api.createNodeFile(id, path, content, onProgress),
      createDirectory: (path) => api.createNodeDirectory(id, path),
      deletePath: (path) => api.deleteNodeFile(id, path),
      movePath: (fromPath, toPath) => api.moveNodeFile(id, fromPath, toPath),
      initUpload: (path, totalBytes) => api.initNodeFileUpload(id, path, totalBytes),
      uploadChunk: (uploadId, offset, content, onProgress) =>
        api.uploadNodeFileChunk(id, uploadId, offset, content, onProgress),
      completeUpload: (uploadId, path, totalBytes) =>
        api.completeNodeFileUpload(id, uploadId, path, totalBytes),
      abortUpload: (uploadId) => api.abortNodeFileUpload(id, uploadId),
    };
  }, [canReadNodeFiles, canWriteNodeFiles, id]);

  // Node reads run from polls, events and actions at once; only the latest one may land.
  const nodeRequestSeq = useRef(0);
  const loadNode = useCallback(
    async (silent = false) => {
      if (!id) return;
      if (!silent) setIsLoading(true);
      const seq = ++nodeRequestSeq.current;
      try {
        const [data, history] = await Promise.all([api.getNode(id), api.getNodeHealthHistory(id)]);
        if (seq !== nodeRequestSeq.current) return;
        setNode(data);
        setHealthHistory(history);
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) {
          usePinnedNodesStore.getState().removePin(id);
        }
        if (!silent) {
          toast.error("Failed to load node");
          navigate("/nodes");
        }
      } finally {
        if (!silent) setIsLoading(false);
      }
    },
    [id, navigate]
  );

  const refreshNodeDetails = useCallback(async () => {
    if (!id) return;
    const seq = ++nodeRequestSeq.current;
    const data = await api.getNode(id);
    if (seq === nodeRequestSeq.current) setNode(data);
  }, [id]);

  const loadDaemonUpdateStatus = useCallback(
    async (options?: { force?: boolean }) => {
      if (!id || !hasScope("admin:update")) return;
      try {
        await fetchDaemonUpdates(options);
      } catch {
        // ignore
      }
    },
    [fetchDaemonUpdates, hasScope, id]
  );

  useEffect(() => {
    if (!node) return;
    if (activeTab === "details") {
      setActiveTab("overview");
      return;
    }
    if (
      node.type === "docker" &&
      ["containers", "images", "volumes", "networks", "compose"].includes(activeTab) &&
      node.status !== "pending"
    ) {
      navigate(dockerNodeListRoute(node.id, activeTab), { replace: true });
      return;
    }
    if ((activeTab === "snapshots" || activeTab === "firewall") && hostingLoadState !== "ready")
      return;
    if (
      !visibleTabs.includes(activeTab) ||
      (nodeOffline && OFFLINE_DISABLED_TABS.has(activeTab)) ||
      (nodeUnavailable &&
        activeTab !== "overview" &&
        activeTab !== "firewall" &&
        activeTab !== "snapshots")
    ) {
      setActiveTab("overview");
    }
  }, [
    activeTab,
    hostingLoadState,
    navigate,
    node,
    nodeOffline,
    nodeUnavailable,
    setActiveTab,
    visibleTabs,
  ]);

  useEffect(() => {
    loadNode();
    const interval = setInterval(() => loadNode(true), 30000);
    return () => clearInterval(interval);
  }, [loadNode]);

  useEffect(() => {
    void loadDaemonUpdateStatus().finally(() => setDaemonUpdatesSettled(true));
  }, [loadDaemonUpdateStatus]);

  useRealtime(
    id ? "node.changed" : null,
    (payload) => {
      const changes = id ? nodeChangesFor(payload, id) : [];
      if (!id || changes.length === 0) return;
      if (changes.some((change) => change.action === "deleted")) {
        navigate("/nodes");
        return;
      }
      loadNode(true);
      void loadDaemonUpdateStatus({ force: true });
    },
    {
      // Events sent while the socket was away (a Gateway restart during an update) are lost.
      onReconnect: () => {
        loadNode(true);
        void loadDaemonUpdateStatus({ force: true });
      },
    }
  );

  useRealtime(id ? "docker.runtime.changed" : null, (payload) => {
    const event = payload as { nodeId?: string; status?: DockerRuntimeStatus };
    if (!id || event.nodeId !== id || !event.status) return;
    setNode((current) =>
      current
        ? {
            ...current,
            capabilities: {
              ...(current.capabilities ?? {}),
              dockerRuntimeStatus: event.status,
            },
          }
        : current
    );
  });

  useRealtime(id ? "node.slug.changed" : null, (payload) => {
    const event = payload as { id?: string; oldSlug?: string; slug?: string };
    if (event.id !== id || event.oldSlug !== routeSlug || !event.slug) return;
    navigate(nodeRoute(event.slug, activeTab), { replace: true });
  });

  useEffect(() => {
    if (
      nodeUpdating &&
      activeTab !== "overview" &&
      activeTab !== "jobs" &&
      activeTab !== "daemon-logs"
    ) {
      setActiveTab("overview");
    }
  }, [activeTab, nodeUpdating, setActiveTab]);

  const openAppearanceDialog = () => {
    if (!node || nodeActionsLocked) return;
    setAppearanceName(node.displayName ?? "");
    setAppearanceColor(node.appearanceColor ?? null);
    const configuredAddresses =
      node.serviceAddresses ??
      [node.serviceAddress, node.secondaryServiceAddress].filter(
        (address): address is string => !!address
      );
    setServiceAddressRows(
      (configuredAddresses.length > 0 ? configuredAddresses : [""]).map((value, index) => ({
        id: index,
        value,
      }))
    );
    const builderSettings =
      node.metadata.builderSettings && typeof node.metadata.builderSettings === "object"
        ? (node.metadata.builderSettings as Record<string, unknown>)
        : {};
    const parallelism = Number(builderSettings.parallelism);
    const timeoutMinutes = Number(builderSettings.timeoutMinutes);
    setBuilderParallelism(Number.isSafeInteger(parallelism) && parallelism >= 1 ? parallelism : 1);
    setBuilderTimeoutMinutes(
      Number.isSafeInteger(timeoutMinutes) && timeoutMinutes >= 1 ? timeoutMinutes : 30
    );
    setAppearanceOpen(true);
  };

  const handleAppearanceSave = async () => {
    if (!id || nodeActionsLocked) return;
    setAppearanceSaving(true);
    try {
      const update = {
        ...(canRenameNode
          ? {
              displayName: appearanceName.trim() || null,
              appearanceColor,
            }
          : {}),
        ...((node?.type === "docker" ||
          isManagedDatabaseCandidateNode(node) ||
          node?.type === "nginx") &&
        canEditNodeServiceAddress
          ? { serviceAddresses: configuredServiceAddresses }
          : {}),
        ...(node?.type === "builder" && canEditBuilderSettings
          ? {
              builderSettings: {
                parallelism: builderParallelism,
                timeoutMinutes: builderTimeoutMinutes,
              },
            }
          : {}),
      };
      let updated: Node;
      try {
        updated = await api.updateNode(id, update);
      } catch (error) {
        if (
          !(error instanceof ApiRequestError) ||
          error.code !== "NODE_SERVICE_ADDRESS_DOMAINS_AFFECTED" ||
          node?.type !== "nginx"
        ) {
          throw error;
        }
        const details = error.details as
          | {
              domainCount?: number;
              domains?: string[];
              previousAddress?: string;
              nextAddress?: string;
              previousAddresses?: string[];
              nextAddresses?: string[];
            }
          | undefined;
        const approved = await confirm({
          title: "Update Domain DNS Targets",
          description: `This Ingress node is used by ${details?.domainCount ?? "one or more"} domain${details?.domainCount === 1 ? "" : "s"}. Their tracked DNS target must be updated to one of: ${details?.nextAddresses?.join(", ") || details?.nextAddress || "unavailable"}.${details?.domains?.length ? ` Affected: ${details.domains.join(", ")}.` : ""}`,
          confirmLabel: "Update DNS targets",
        });
        if (!approved) return;
        updated = await api.updateNode(id, { ...update, confirmDomainDnsUpdate: true });
      }
      nodeRequestSeq.current++;
      setNode((prev) => (prev ? { ...prev, ...updated } : prev));
      if (updated.slug && updated.slug !== routeSlug) {
        navigate(nodeRoute(updated.slug, activeTab), { replace: true });
      }
      useDockerStore.getState().syncNodeAppearance(updated);
      setAppearanceOpen(false);
      usePinnedNodesStore.getState().invalidate();
      toast.success("Node updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setAppearanceSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!node || nodeRemovalLocked) return;
    try {
      if (!(await confirmAndDeleteNode(node.id, node.hostname))) return;
      usePinnedNodesStore.getState().removePin(node.id);
      toast.success("Node removed");
      navigate("/nodes");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove");
    }
  };

  const handleCheckUpdates = async () => {
    if (!node || nodeActionsLocked) return;
    setCheckingUpdates(true);
    try {
      const statuses = await api.checkDaemonUpdates();
      setDaemonUpdates(statuses);
      const daemonType = daemonTypeForNode(node.type);
      const latestVersion = statuses.find(
        (status) => status.daemonType === daemonType
      )?.latestVersion;

      if (isDaemonUpdateAvailable(node.daemonVersion, latestVersion)) {
        toast.info(`Update available: ${latestVersion}`);
      } else {
        toast.success("Node daemon is already up to date");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to check daemon updates");
    } finally {
      setCheckingUpdates(false);
    }
  };

  const handleServiceCreationLock = async (serviceCreationLocked: boolean) => {
    if (!node || nodeActionsLocked) return;
    setLockSaving(true);
    try {
      const updated = await api.setNodeServiceCreationLock(node.id, serviceCreationLocked);
      nodeRequestSeq.current++;
      setNode(updated);
      toast.success(
        serviceCreationLocked ? "Service creation locked" : "Service creation unlocked"
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update lock");
    } finally {
      setLockSaving(false);
    }
  };

  if (isLoading) return <DetailPageSkeleton label="Loading node" tabs={6} />;
  if (!node)
    return (
      <PageTransition>
        <div className="flex h-full items-center justify-center text-muted-foreground">
          Node not found
        </div>
      </PageTransition>
    );

  const updateTargetVersion = getNodeUpdateTargetVersion(node);
  const nodeState =
    node.status === "pending" &&
    hosting?.operation?.phase === "failed" &&
    ["create", "install"].includes(hosting.operation.action)
      ? "provisioning failed"
      : hostingOperationPending(hosting?.operation) && hosting?.operation
        ? hostingNodeLabel(hosting.operation).toLowerCase()
        : nodeUpdating
          ? "updating"
          : effectiveNodeStatus(node);
  const detailsTabRefreshKey = [
    "details",
    node.id,
    node.daemonVersion ?? "unknown",
    nodeUpdating ? "updating" : "stable",
  ].join(":");
  // Header actions and the Firewall and Snapshots tabs come from the hosting projection,
  // and the overview offers an available daemon update.
  const initialLoadPending =
    hostingLoadState === "loading" ||
    (hasScope("admin:update") && !daemonUpdatesLoaded && !daemonUpdatesSettled);
  const usesFillLayout =
    activeTab === "configuration" ||
    activeTab === "daemon-logs" ||
    activeTab === "nginx-logs" ||
    activeTab === "jobs" ||
    activeTab === "console";

  return (
    <PageTransition>
      <ContentLoading loading={initialLoadPending} />
      <div
        className={
          usesFillLayout
            ? "h-full p-6 flex flex-col gap-4 overflow-hidden"
            : activeTab === "containers"
              ? "h-full overflow-y-auto px-6 pt-6 pb-3 space-y-4"
              : "h-full overflow-y-auto p-6 space-y-4"
        }
      >
        <PageHeader
          className="shrink-0"
          leading={<PageBackButton onClick={() => navigate("/nodes")} />}
          title={node.displayName || node.hostname}
          badges={
            <>
              <Badge variant={STATUS_BADGE[nodeState] || "secondary"} size="inline">
                {nodeState}
              </Badge>
              {(node.type === "nginx" || node.type === "docker") && node.serviceCreationLocked && (
                <Badge variant="warning" size="inline">
                  Locked
                </Badge>
              )}
              {nodeProtected && <ProtectedNodeBadge size="inline" />}
            </>
          }
          description={
            <>
              {node.hostname} &middot; {nodeTypeLabel(node.type)} &middot;{" "}
              {node.daemonVersion ?? "unknown version"}
              {nodeUpdating && updateTargetVersion ? (
                <> &middot; updating to {updateTargetVersion}</>
              ) : null}
              {node.osInfo ? <> &middot; {node.osInfo}</> : null}
            </>
          }
          actions={
            <ResponsiveHeaderActions
              menuClassName="w-64"
              actions={[
                {
                  label: "Pin",
                  alwaysOverflow: true,
                  icon: <Pin className="h-4 w-4" />,
                  onClick: () => setPinOpen(true),
                  disabled: nodeUpdating,
                },
                ...hostingActions.map((action, index) => ({
                  ...action,
                  separatorBefore:
                    index === 0 || ("separatorBefore" in action && action.separatorBefore),
                })),
                ...(canOpenNodeSettings
                  ? [
                      {
                        label: "Settings",
                        separatorBefore: hostingActions.length === 0,
                        icon: <Settings className="h-4 w-4" />,
                        onClick: openAppearanceDialog,
                        disabled: nodeActionsLocked,
                      },
                    ]
                  : []),
                ...(canManageServiceCreationLock
                  ? [
                      {
                        label: node.serviceCreationLocked
                          ? "Unlock new services"
                          : "Lock new services",
                        onClick: () => handleServiceCreationLock(!node.serviceCreationLocked),
                        disabled: lockSaving || nodeActionsLocked,
                      },
                    ]
                  : []),
                ...(node.status === "pending" &&
                !hosting &&
                (canManageNode ||
                  canCreateInFolder(user?.scopes ?? [], "nodes:create", node.folderId, node.id))
                  ? [
                      {
                        label: "New enrollment token",
                        icon: <KeyRound className="h-4 w-4" />,
                        onClick: () => setReissueNode(node),
                        disabled: reissueNode !== null,
                        separatorBefore: true,
                      },
                    ]
                  : []),
                ...(hasScope("admin:update")
                  ? [
                      {
                        label: "Check for updates",
                        icon: <ArrowUpCircle className="h-4 w-4" />,
                        onClick: handleCheckUpdates,
                        disabled: nodeActionsLocked || checkingUpdates,
                        separatorBefore: canManageServiceCreationLock,
                      },
                    ]
                  : []),
                ...(hasScope("nodes:delete") || hasScope(`nodes:delete:${node.id}`)
                  ? [
                      {
                        label: "Remove",
                        icon: <Trash2 className="h-4 w-4" />,
                        onClick: handleDelete,
                        disabled: nodeRemovalLocked,
                        destructive: true,
                        separatorBefore: hasScope("admin:update") || canManageServiceCreationLock,
                      },
                    ]
                  : []),
              ]}
            >
              <Button
                variant="outline"
                size="icon"
                aria-label="Pin node"
                onClick={() => setPinOpen(true)}
                disabled={nodeUpdating}
              >
                <Pin className="h-4 w-4" />
              </Button>
              {hostingActions.map((action) => (
                <Button
                  key={action.label}
                  variant={
                    "destructive" in action && action.destructive ? "destructive" : "outline"
                  }
                  onClick={action.onClick}
                  disabled={"disabled" in action && action.disabled}
                >
                  {action.icon}
                  {action.label}
                </Button>
              ))}
              {canOpenNodeSettings && (
                <Button
                  variant="outline"
                  disabled={nodeActionsLocked}
                  onClick={openAppearanceDialog}
                >
                  <Settings className="h-4 w-4" />
                  Settings
                </Button>
              )}
              {canManageServiceCreationLock && (
                <Button
                  variant="outline"
                  onClick={() => handleServiceCreationLock(!node.serviceCreationLocked)}
                  disabled={nodeActionsLocked}
                  pending={lockSaving}
                >
                  {node.serviceCreationLocked ? "Unlock new services" : "Lock new services"}
                </Button>
              )}
              {hasScope("admin:update") && (
                <Button
                  variant="outline"
                  onClick={handleCheckUpdates}
                  disabled={nodeActionsLocked}
                  pending={checkingUpdates}
                >
                  <ArrowUpCircle className="h-4 w-4" />
                  Check for updates
                </Button>
              )}
              {(hasScope("nodes:delete") || hasScope(`nodes:delete:${node.id}`)) && (
                <Button variant="destructive" onClick={handleDelete} disabled={nodeRemovalLocked}>
                  <Trash2 className="h-4 w-4" />
                  Remove
                </Button>
              )}
            </ResponsiveHeaderActions>
          }
        />
        <NodeEnrollmentDialog
          open={false}
          onOpenChange={() => undefined}
          reissueNode={reissueNode}
          onReissueHandled={clearReissueNode}
          onNodeEnrolled={() => void loadNode(true)}
        />
        <HostingResizeDialog
          resource={resizeContext?.resource ?? null}
          catalog={resizeContext?.catalog}
          provider={hosting?.provider ?? "proxmox"}
          onClose={() => setResizeContext(null)}
          onChanged={refreshHosting}
        />

        {/* Health bars */}
        <HealthBars history={healthHistory} currentStatus={node.status} />

        {/* Tabs */}
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className={`flex flex-col ${usesFillLayout ? "flex-1 min-h-0" : ""}`}
        >
          <TabsList className="shrink-0">
            <TabsTrigger value="overview" className="gap-1.5">
              <LayoutDashboard className="h-3.5 w-3.5" aria-hidden="true" />
              Overview
            </TabsTrigger>
            {!isNodeIncompatible(node) && (
              <TabsTrigger
                value="monitoring"
                className="gap-1.5"
                disabled={nodeUpdating || nodeOffline}
              >
                <Activity className="h-3.5 w-3.5" aria-hidden="true" />
                Monitoring
              </TabsTrigger>
            )}
            {canViewNodeFirewall && (
              <TabsTrigger value="firewall" className="gap-1.5">
                <Shield className="h-3.5 w-3.5" aria-hidden="true" />
                Firewall
              </TabsTrigger>
            )}
            {hostingLoadState !== "ready" &&
              ["snapshots", "firewall"].includes(activeTab) &&
              !visibleTabs.includes(activeTab) && (
                <TabsTrigger value={activeTab} className="gap-1.5">
                  {activeTab === "snapshots" ? (
                    <Camera className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Shield className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {activeTab === "snapshots" ? "Snapshots" : "Firewall"}
                </TabsTrigger>
              )}
            {hosting?.resourceId &&
              hasScope(`hosting:resources:view:${hosting.resourceId}`) &&
              hasScope(`hosting:snapshots:view:${hosting.resourceId}`) && (
                <TabsTrigger value="snapshots" className="gap-1.5" disabled={nodeUpdating}>
                  <Camera className="h-3.5 w-3.5" aria-hidden="true" />
                  Snapshots
                </TabsTrigger>
              )}
            {!isNodeIncompatible(node) && isManagedDatabaseCandidateNode(node) && (
              <TabsTrigger
                value="databases"
                className="gap-1.5"
                disabled={nodeUpdating || nodeUnavailable}
              >
                <Database className="h-3.5 w-3.5" aria-hidden="true" />
                Databases
              </TabsTrigger>
            )}
            {!isNodeIncompatible(node) && canReadNodeFiles && (
              <TabsTrigger value="files" className="gap-1.5" disabled={nodeUpdating || nodeOffline}>
                <Folder className="h-3.5 w-3.5" aria-hidden="true" />
                Files
              </TabsTrigger>
            )}
            {!isNodeIncompatible(node) && node.type === "nginx" && canViewNodeConfig && (
              <TabsTrigger value="configuration" className="gap-1.5" disabled={nodeActionsLocked}>
                <Settings className="h-3.5 w-3.5" aria-hidden="true" />
                Configuration
              </TabsTrigger>
            )}
            {!isNodeIncompatible(node) && node.type === "nginx" && canViewNodeLogs && (
              <TabsTrigger
                value="nginx-logs"
                className="gap-1.5"
                disabled={nodeUpdating || nodeOffline}
              >
                <ScrollText className="h-3.5 w-3.5" aria-hidden="true" />
                Nginx Logs
              </TabsTrigger>
            )}
            {node.type === "builder" && (
              <TabsTrigger value="jobs" className="gap-1.5" disabled={nodeUnavailable}>
                <ListTodo className="h-3.5 w-3.5" aria-hidden="true" />
                Jobs
              </TabsTrigger>
            )}
            {canShowNodeConsole && (
              <TabsTrigger value="console" className="gap-1.5" disabled={nodeOffline}>
                <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
                Console
              </TabsTrigger>
            )}
            {canViewNodeLogs && (
              <TabsTrigger value="daemon-logs" className="gap-1.5" disabled={nodeOffline}>
                <ScrollText className="h-3.5 w-3.5" aria-hidden="true" />
                Logs
              </TabsTrigger>
            )}
          </TabsList>

          {isNodeIncompatible(node) && (
            <Notice
              tone="destructive"
              role="alert"
              className="mt-2"
              title="This node's daemon version is incompatible with the gateway"
            >
              Update the daemon to restore full functionality.
            </Notice>
          )}

          <div className={usesFillLayout ? "relative flex flex-col flex-1 min-h-0" : "relative"}>
            {nonInteractiveWhileUpdating && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/85 backdrop-blur-sm">
                <div className="border border-border bg-card px-6 py-4 text-center">
                  <p className="text-sm font-medium">Node daemon update in progress</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Interactive node actions are locked until the update completes.
                  </p>
                </div>
              </div>
            )}
            <TabsContent key={detailsTabRefreshKey} value="overview">
              <NodeDetailsTab
                hosting={hosting}
                node={node}
                canManageSecureRuntime={canManageSecureRuntime && !nodeActionsLocked}
                daemonUpdate={
                  nodeActionsLocked ? { available: false, latestVersion: null } : daemonUpdate
                }
                refreshNode={refreshNodeDetails}
                refreshDaemonUpdateStatus={loadDaemonUpdateStatus}
              />
            </TabsContent>
            {hostingLoadState !== "ready" &&
              ["snapshots", "firewall"].includes(activeTab) &&
              !visibleTabs.includes(activeTab) && (
                <TabsContent value={activeTab}>
                  {hostingLoadState === "error" ? (
                    <EmptyState
                      message="Could not load hosting information."
                      actionLabel="Retry"
                      onAction={refreshHosting}
                    />
                  ) : null}
                </TabsContent>
              )}
            {hosting?.resourceId &&
              hasScope(`hosting:resources:view:${hosting.resourceId}`) &&
              hasScope(`hosting:snapshots:view:${hosting.resourceId}`) && (
                <TabsContent value="snapshots">
                  {activeTab === "snapshots" && (
                    <NodeSnapshotsTab
                      resourceId={hosting.resourceId}
                      mutationLocked={nodeUpdating || nodeUnavailable}
                      onOperationChange={(operation) =>
                        setHosting((current) => (current ? { ...current, operation } : current))
                      }
                    />
                  )}
                </TabsContent>
              )}
            {!isNodeIncompatible(node) && (
              <TabsContent value="monitoring">
                {activeTab === "monitoring" && !nodeOffline && (
                  <NodeMonitoringTab
                    nodeId={node.id}
                    nodeStatus={node.status}
                    nodeType={node.type}
                    initialHealthReport={node.liveHealthReport ?? node.lastHealthReport}
                    initialMonitoringHistory={node.monitoringHistory}
                  />
                )}
              </TabsContent>
            )}
            {canViewNodeFirewall &&
              hosting?.connectorId &&
              hosting.resourceId &&
              firewallProvider && (
                <TabsContent value="firewall">
                  {activeTab === "firewall" && (
                    <NodeFirewallTab
                      nodeId={node.id}
                      connectorId={hosting.connectorId}
                      resourceId={hosting.resourceId}
                      provider={firewallProvider}
                      mutationLocked={firewallMutationLocked}
                    />
                  )}
                </TabsContent>
              )}
            {!isNodeIncompatible(node) && isManagedDatabaseCandidateNode(node) && (
              <TabsContent value="databases" className="pb-0">
                {activeTab === "databases" && !nodeUnavailable && (
                  <Databases embedded managedNodeId={node.id} />
                )}
              </TabsContent>
            )}
            {!isNodeIncompatible(node) && node.type === "nginx" && canViewNodeConfig && (
              <TabsContent value="configuration" className="flex flex-col flex-1 min-h-0">
                {activeTab === "configuration" && !nodeUnavailable && (
                  <NodeConfigTab
                    nodeId={node.id}
                    nodeStatus={node.status}
                    actionLocked={nodeUpdating}
                  />
                )}
              </TabsContent>
            )}
            {!isNodeIncompatible(node) && node.type === "nginx" && canViewNodeLogs && (
              <TabsContent value="nginx-logs" className="flex flex-col flex-1 min-h-0">
                {activeTab === "nginx-logs" && !nodeOffline && (
                  <NodeNginxLogsTab nodeId={node.id} nodeStatus={node.status} />
                )}
              </TabsContent>
            )}
            {!isNodeIncompatible(node) && canReadNodeFiles && nodeFileOperations && (
              <TabsContent value="files">
                {activeTab === "files" && nodeFilesDisabled && (
                  <EmptyState message={nodeHostFeatureDisabledMessage(node, "files")} />
                )}
                {activeTab === "files" && !nodeOffline && hostFileAccessNotice}
                {activeTab === "files" && !nodeOffline && !nodeFilesDisabled && (
                  <FilesTab
                    nodeId={node.id}
                    canBrowse={canReadNodeFiles}
                    operations={nodeFileOperations}
                    description="Browse and manage files on this node's host"
                    realtimeEvent="node.file.changed"
                    realtimeMatches={(payload) =>
                      (payload as { nodeId?: string } | undefined)?.nodeId === node.id
                    }
                  />
                )}
              </TabsContent>
            )}
            {node.type === "builder" && (
              <TabsContent value="jobs" className="flex min-h-0 flex-1 flex-col pb-0">
                {activeTab === "jobs" && !nodeUnavailable && <BuilderJobsTab nodeId={node.id} />}
              </TabsContent>
            )}
            {canShowNodeConsole && !nodeOffline && (
              <TabsContent value="console" className="flex flex-col flex-1 min-h-0">
                {activeTab === "console" &&
                  (nodeConsoleUnavailable ? (
                    <div>
                      {hostFileAccessNotice}
                      <EmptyState message={nodeConsoleUnavailable} />
                    </div>
                  ) : (
                    <NodeConsoleTab nodeId={node.id} />
                  ))}
              </TabsContent>
            )}
            {canViewNodeLogs && (
              <TabsContent value="daemon-logs" className="flex flex-col flex-1 min-h-0">
                {activeTab === "daemon-logs" && !nodeOffline && (
                  <NodeLogsTab nodeId={node.id} nodeStatus={node.status} />
                )}
              </TabsContent>
            )}
          </div>
        </Tabs>
      </div>

      {/* Settings Dialog */}
      <Dialog open={appearanceOpen} onOpenChange={setAppearanceOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Node Settings</DialogTitle>
          </DialogHeader>
          <AnimatedHeight>
            <div className="space-y-5">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Display Name</label>
                <Input
                  aria-label="Display Name"
                  value={appearanceName}
                  disabled={!canRenameNode}
                  onChange={(e) => setAppearanceName(e.target.value)}
                  placeholder={node.hostname}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleAppearanceSave();
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty to use the hostname ({node.hostname})
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Color</label>
                <div className="grid grid-cols-8 gap-2">
                  <button
                    type="button"
                    aria-label="Default color"
                    disabled={!canRenameNode}
                    className={cn(
                      "aspect-square w-full border border-border bg-muted",
                      appearanceColor === null && "border-foreground"
                    )}
                    onClick={() => setAppearanceColor(null)}
                  />
                  {NODE_APPEARANCE_COLOR_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-label={`${option.label} color`}
                      disabled={!canRenameNode}
                      className={cn(
                        "aspect-square w-full border border-border",
                        option.swatchClassName,
                        appearanceColor === option.value && "border-foreground"
                      )}
                      onClick={() => setAppearanceColor(option.value)}
                    />
                  ))}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Preview:</span>
                  <Badge
                    variant="secondary"
                    size="inline"
                    className={getNodeAppearanceColor(appearanceColor)?.badgeClassName}
                  >
                    {appearanceName.trim() || node.hostname}
                  </Badge>
                </div>
              </div>
              {(node.type === "docker" ||
                isManagedDatabaseCandidateNode(node) ||
                node.type === "nginx") && (
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Service Addresses</label>
                  <div className="w-full border border-input bg-background">
                    <AnimatePresence initial={false} mode="popLayout">
                      {serviceAddressRows.map((row, index) => (
                        <motion.div
                          layout
                          key={row.id}
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: 4 }}
                          transition={{
                            opacity: { duration: 0.12 },
                            y: { duration: 0.12, ease: [0.25, 0.1, 0.25, 1] },
                          }}
                          className="flex min-w-0 border-b border-border last:border-b-0"
                        >
                          <Combobox
                            freeText
                            showAllOptionsOnFocus
                            ariaLabel={`Service Address ${index + 1}`}
                            value={row.value}
                            options={
                              index === 0
                                ? serviceAddressOptions
                                : serviceAddressOptions.filter((option) => option.value)
                            }
                            placeholder={
                              index === 0
                                ? automaticServiceAddress
                                  ? `Automatic (${automaticServiceAddress})`
                                  : "Automatic (no IP reported)"
                                : node.type === "nginx"
                                  ? "Public IPv4 or IPv6 address"
                                  : "IPv4, IPv6, or hostname"
                            }
                            searchPlaceholder="Enter or select an address"
                            emptyMessage="Enter a valid IP address or hostname."
                            disabled={!canEditNodeServiceAddress}
                            className="min-w-0 flex-1"
                            inputClassName="h-9 rounded-none border-0 font-mono text-xs shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                            renderOption={(option) =>
                              option.value ? (
                                <span className="font-mono text-xs">{option.label}</span>
                              ) : (
                                option.label
                              )
                            }
                            onValueChange={(value) =>
                              setServiceAddressRows((rows) =>
                                rows.map((candidate) =>
                                  candidate.id === row.id ? { ...candidate, value } : candidate
                                )
                              )
                            }
                          />
                          {serviceAddressRows.length > 1 ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`Remove service address ${index + 1}`}
                              className="rounded-none border-l border-border bg-muted text-muted-foreground hover:bg-muted hover:text-foreground"
                              disabled={!canEditNodeServiceAddress}
                              onClick={() =>
                                setServiceAddressRows((rows) =>
                                  rows.filter((candidate) => candidate.id !== row.id)
                                )
                              }
                            >
                              <Minus className="h-4 w-4" />
                            </Button>
                          ) : null}
                          {index === serviceAddressRows.length - 1 &&
                          serviceAddressRows.length < MAX_SERVICE_ADDRESSES ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label="Add service address"
                              className="rounded-none border-l border-border bg-muted text-muted-foreground hover:bg-muted hover:text-foreground"
                              disabled={!canEditNodeServiceAddress}
                              onClick={() =>
                                setServiceAddressRows((rows) => [
                                  ...rows,
                                  {
                                    id: Math.max(...rows.map((candidate) => candidate.id)) + 1,
                                    value: "",
                                  },
                                ])
                              }
                            >
                              <Plus className="h-4 w-4" />
                            </Button>
                          ) : null}
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {isManagedDatabaseCandidateNode(node)
                      ? "Used as the hosts shown for published managed database ports."
                      : node.type === "nginx"
                        ? "Used as the public ingress addresses for domains assigned to this node."
                        : "Used by routes to reach published Docker ports. The first address is preferred."}
                  </p>
                  {serviceAddressesInvalid ? (
                    <p className="text-xs text-destructive">
                      Enter a valid IPv4, IPv6, or hostname for every address.
                    </p>
                  ) : null}
                </div>
              )}
              {node.type === "builder" && (
                <>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium" htmlFor="builder-parallelism">
                      Parallel jobs
                    </label>
                    <Input
                      id="builder-parallelism"
                      type="number"
                      min={1}
                      max={16}
                      value={builderParallelism}
                      disabled={!canEditBuilderSettings}
                      onChange={(event) => setBuilderParallelism(Number(event.target.value))}
                    />
                    <p className="text-xs text-muted-foreground">
                      Maximum builds assigned to this worker at the same time. Default: 1.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium" htmlFor="builder-timeout-minutes">
                      Build timeout (minutes)
                    </label>
                    <Input
                      id="builder-timeout-minutes"
                      type="number"
                      min={1}
                      max={360}
                      value={builderTimeoutMinutes}
                      disabled={!canEditBuilderSettings}
                      onChange={(event) => setBuilderTimeoutMinutes(Number(event.target.value))}
                    />
                    <p className="text-xs text-muted-foreground">
                      Hard upper limit for one build on this worker. Default: 30 minutes.
                    </p>
                  </div>
                </>
              )}
            </div>
          </AnimatedHeight>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAppearanceOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleAppearanceSave}
              pending={appearanceSaving}
              disabled={
                nodeActionsLocked ||
                serviceAddressesIncomplete ||
                serviceAddressesDuplicate ||
                serviceAddressesInvalid ||
                (node.type === "builder" &&
                  (!Number.isSafeInteger(builderParallelism) ||
                    builderParallelism < 1 ||
                    builderParallelism > 16 ||
                    !Number.isSafeInteger(builderTimeoutMinutes) ||
                    builderTimeoutMinutes < 1 ||
                    builderTimeoutMinutes > 360))
              }
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pin Dialog */}
      <Dialog open={pinOpen} onOpenChange={setPinOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Pin Node</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Add to dashboard</p>
                <p className="text-xs text-muted-foreground">Show overview card on the dashboard</p>
              </div>
              <Switch
                checked={isPinnedDashboard(node.id)}
                onChange={() => toggleDashboard(node.id)}
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Add to sidebar</p>
                <p className="text-xs text-muted-foreground">Quick access link in the sidebar</p>
              </div>
              <Switch checked={isPinnedSidebar(node.id)} onChange={() => toggleSidebar(node.id)} />
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}
