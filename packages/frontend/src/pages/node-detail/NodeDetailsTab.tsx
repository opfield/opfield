import { ArrowRight, ArrowUpCircle, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AppMemberBadge } from "@/components/apps/AppMembership";
import { confirmAction } from "@/components/common/ConfirmDialog";
import { DetailRow } from "@/components/common/DetailRow";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { ProxyUpstreamTarget } from "@/components/proxy/ProxyUpstreamTarget";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ProgressBar } from "@/components/ui/progress-bar";
import { useRealtime } from "@/hooks/use-realtime";
import { toastApiError } from "@/lib/api-error-toast";
import { isDevForceUpdatesEnabled } from "@/lib/dev-force-updates";
import { nodeTypeLabel } from "@/lib/node-appearance";
import {
  carriesUpdateConnections,
  lastUpdateConnectionsText,
  launcherVersionUnknownReason,
  updateConnectionsPlacement,
  updateConnectionsSummary,
} from "@/lib/node-update-connections";
import { dockerNodeListRoute, proxyHostRoute } from "@/lib/resource-routes";
import { deriveAllowedResourceIdsByScope, scopeMatches } from "@/lib/scope-utils";
import {
  cn,
  formatBytes,
  formatDateTime,
  formatFileDescriptorLimit,
  formatUptime,
} from "@/lib/utils";
import { api } from "@/services/api";
import { accessContextKey, useAuthStore } from "@/stores/auth";
import {
  handleLicenseApiError,
  requireLicenseFeature,
  usePlanIncludes,
} from "@/stores/license-paywall";
import {
  DAEMON_STREAM_HANDOVER_CAPABILITY,
  type DockerRuntimeStatus,
  getNodeLastConnectorReplacement,
  getNodeLastUpdate,
  getNodeUpdateLastError,
  getNodeUpdateTargetVersion,
  getNodeUpdateWaitingFor,
  getNodeUpdateWaitingForTasks,
  hasDaemonCapability,
  isNodeUpdateQueued,
  isNodeUpdateWaitingForTasks,
  isNodeUpdating,
  type NodeDetail,
  type NodeHealthReport,
  type ProxyHost,
} from "@/types";
import { HOSTING_PROVIDER_LABELS, type HostingNodeProjection } from "@/types/hosting";

const DOCKER_RESOURCES = [
  {
    tab: "containers",
    label: "containers",
    load: (nodeId: string) => api.listDockerContainerSnapshots({ nodeId }),
  },
  {
    tab: "images",
    label: "images",
    load: (nodeId: string) => api.listDockerImageSnapshots({ nodeId }),
  },
  {
    tab: "volumes",
    label: "volumes",
    load: (nodeId: string) => api.listDockerVolumeSnapshots({ nodeId }),
  },
  {
    tab: "networks",
    label: "networks",
    load: (nodeId: string) => api.listDockerNetworkSnapshots({ nodeId }),
  },
  {
    tab: "compose",
    label: "compose projects",
    load: (nodeId: string) => api.listDockerComposeProjects(nodeId),
  },
] as const;
type DockerResourceTab = (typeof DOCKER_RESOURCES)[number]["tab"];

interface NodeDetailsTabProps {
  hosting?: HostingNodeProjection | null;
  node: NodeDetail;
  canManageSecureRuntime: boolean;
  daemonUpdate: {
    available: boolean;
    latestVersion: string | null;
  };
  refreshNode: () => Promise<void>;
  refreshDaemonUpdateStatus: (options?: { force?: boolean }) => Promise<void>;
}

function normalizeVersion(version: string | null | undefined): string {
  return (version ?? "").replace(/^v/, "");
}

/** An update waits this long at most for the running tasks of its node (Opfield's limit). */
const UPDATE_TASK_WAIT_MS = 30 * 60_000;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "Backup of orders, Build of acme/web and 2 more" */
function taskList(labels: string[]): string {
  const shown = labels.slice(0, 3).join(", ");
  return labels.length > 3 ? `${shown} and ${labels.length - 3} more` : shown;
}

function IPAddressPanel({ title, addresses }: { title: string; addresses: string[] }) {
  return (
    <PanelShell title={title} bodyClassName="divide-y divide-border">
      {addresses.length > 0 ? (
        addresses.map((address) => (
          <div key={address} className="px-4 py-3 text-sm">
            {address}
          </div>
        ))
      ) : (
        <div className="px-4 py-3 text-sm text-muted-foreground">No addresses detected</div>
      )}
    </PanelShell>
  );
}

export function NodeDetailsTab({
  hosting,
  node,
  canManageSecureRuntime,
  daemonUpdate,
  refreshNode,
  refreshDaemonUpdateStatus,
}: NodeDetailsTabProps) {
  const navigate = useNavigate();
  // Secure Runtime setup needs its plan feature; a node that already has the runtime keeps the panel.
  const secureRuntimeLicensed = usePlanIncludes("secure-runtime");
  const [proxyHosts, setProxyHosts] = useState<ProxyHost[]>([]);
  const [proxyHostsLoading, setProxyHostsLoading] = useState(
    node.type === "nginx" && node.status === "online" && node.isConnected
  );
  const user = useAuthStore((state) => state.user);
  const canUpdateDaemon = useAuthStore((state) => state.hasScope("admin:update"));
  const authKey = accessContextKey(useAuthStore.getState());
  const dockerResources = useMemo(() => {
    const scopes = user?.scopes ?? [];
    const allowed = deriveAllowedResourceIdsByScope(scopes);
    return DOCKER_RESOURCES.map((resource) => {
      const scope = `docker:${resource.tab}:view`;
      return {
        ...resource,
        canView:
          scopeMatches(scopes, `${scope}:${node.id}`) ||
          (allowed[scope] ?? []).some((id) => id.startsWith(`${node.id}/`)),
      };
    });
  }, [node.id, user?.scopes]);
  const [dockerCounts, setDockerCounts] = useState<Partial<Record<DockerResourceTab, number>>>({});
  const [dockerCountsLoading, setDockerCountsLoading] = useState(node.type === "docker");
  const [containerStates, setContainerStates] = useState<{
    running: number;
    stopped: number;
    paused: number;
  } | null>(null);
  const dockerReadGeneration = useRef(0);
  const dockerCountRequests = useRef<Partial<Record<DockerResourceTab, number>>>({});
  const dockerCountIdentity = useRef({ nodeId: node.id, authKey });
  dockerCountIdentity.current = { nodeId: node.id, authKey };
  const refreshDockerCounts = useCallback(
    async (kind?: string) => {
      if (node.type !== "docker") return;
      const generation = dockerReadGeneration.current;
      await Promise.all(
        dockerResources
          .filter((resource) => resource.canView && (!kind || resource.tab === kind))
          .map(async (resource) => {
            const request = (dockerCountRequests.current[resource.tab] ?? 0) + 1;
            dockerCountRequests.current[resource.tab] = request;
            try {
              const rows = await resource.load(node.id);
              if (
                generation !== dockerReadGeneration.current ||
                request !== dockerCountRequests.current[resource.tab] ||
                dockerCountIdentity.current.nodeId !== node.id ||
                authKey !== accessContextKey(useAuthStore.getState())
              )
                return;
              const total =
                (rows[0] as { _listTotal?: number } | undefined)?._listTotal ?? rows.length;
              setDockerCounts((current) => ({ ...current, [resource.tab]: total }));
              if (resource.tab === "containers") {
                const containers = rows as Array<{ state?: string; _listTruncated?: boolean }>;
                setContainerStates(
                  containers.some((container) => container._listTruncated)
                    ? null
                    : {
                        running: containers.filter((container) => container.state === "running")
                          .length,
                        stopped: containers.filter(
                          (container) =>
                            container.state === "exited" || container.state === "stopped"
                        ).length,
                        paused: containers.filter((container) => container.state === "paused")
                          .length,
                      }
                );
              }
            } catch {
              // Keep the last known count on transient refresh failures; never turn an error into zero.
            }
          })
      );
    },
    [authKey, dockerResources, node.id, node.type]
  );
  useEffect(() => {
    let active = true;
    dockerReadGeneration.current++;
    setDockerCounts({});
    setContainerStates(null);
    void refreshDockerCounts().finally(() => {
      if (active) setDockerCountsLoading(false);
    });
    return () => {
      active = false;
      dockerReadGeneration.current++;
    };
  }, [refreshDockerCounts]);
  useRealtime(
    node.type === "docker" ? "docker.snapshot.changed" : null,
    (payload) => {
      const event = payload as { nodeId?: string; kind?: string };
      if (event.nodeId === node.id) void refreshDockerCounts(event.kind);
    },
    { onReconnect: () => void refreshDockerCounts() }
  );
  useRealtime(node.type === "docker" ? "docker.compose.changed" : null, (payload) => {
    const event = payload as { nodeId?: string };
    if (event.nodeId === node.id) void refreshDockerCounts("compose");
  });
  const [isUpdating, setIsUpdating] = useState(false);
  // The update this page started, until the node shows it running, finishing or failing.
  const [pendingUpdate, setPendingUpdate] = useState<{
    target: string;
    errorAtTrigger: string | null;
    sawUpdating: boolean;
  } | null>(null);
  const [ipAddressesOpen, setIpAddressesOpen] = useState(false);
  const h: NodeHealthReport | null = node.liveHealthReport ?? node.lastHealthReport;
  const caps = (node.capabilities ?? {}) as Record<string, unknown>;
  const reportedRuntimeStatus = caps.dockerRuntimeStatus as DockerRuntimeStatus | undefined;
  const [runtimeStatus, setRuntimeStatus] = useState<DockerRuntimeStatus | undefined>(
    reportedRuntimeStatus
  );
  const [runtimeAction, setRuntimeAction] = useState<"preflight" | "install" | null>(null);
  const nodeUpdating = isNodeUpdating(node);
  const updateQueued = isNodeUpdateQueued(node);
  const updateWaitingFor = getNodeUpdateWaitingFor(node);
  const updateWaitsForTasks = isNodeUpdateWaitingForTasks(node);
  const updateWaitingForTasks = getNodeUpdateWaitingForTasks(node);
  const updateTaskWaitStartedAt = Date.parse(String(node.metadata?.updateTaskWaitStartedAt ?? ""));
  const lastUpdate = getNodeLastUpdate(node);
  const lastConnectorReplacement = getNodeLastConnectorReplacement(node);
  const lastUpdateError = getNodeUpdateLastError(node);
  // A live NodeControl stream is sufficient to deliver the update even when
  // the daemon and the new generic tunnel protocol do not match yet.
  const canTriggerDaemonUpdate = node.status === "online" && node.isConnected;
  const updateTargetVersion = getNodeUpdateTargetVersion(node);
  // What an update does to the connections through the daemon; monitoring daemons carry none.
  const showsUpdateConnections = carriesUpdateConnections(node.type);
  const updateConnections = updateConnectionsSummary(
    hasDaemonCapability(node, DAEMON_STREAM_HANDOVER_CAPABILITY),
    h?.updateConnections
  );
  const updateConnectionsRow = (label: string) => (
    <DetailRow
      label={label}
      value={
        <span className="flex flex-col items-end gap-0.5">
          <span>{updateConnections.text}</span>
          {updateConnections.detail && (
            <span className="text-xs text-muted-foreground">{updateConnections.detail}</span>
          )}
        </span>
      }
    />
  );
  const localIpAddresses = Array.from(new Set(h?.localIpAddresses ?? [])).sort();
  const publicIpAddresses = Array.from(new Set(h?.publicIpAddresses ?? [])).sort();
  const ipAddressCount = new Set([...localIpAddresses, ...publicIpAddresses]).size;
  const resourcesRef = useRef<HTMLDivElement>(null);
  const [resourcesHeight, setResourcesHeight] = useState(0);

  useEffect(() => {
    setRuntimeStatus(reportedRuntimeStatus);
  }, [reportedRuntimeStatus]);

  useEffect(() => {
    if (runtimeAction !== "install" && runtimeStatus?.state !== "installing") return;
    void refreshNode().catch(() => undefined);
    const interval = window.setInterval(() => {
      void refreshNode().catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [refreshNode, runtimeAction, runtimeStatus?.state]);

  useEffect(() => {
    if (!resourcesRef.current) return;
    const ro = new ResizeObserver(([entry]) => {
      setResourcesHeight(entry.contentRect.height + 2); // +2 for border
    });
    ro.observe(resourcesRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!pendingUpdate) return;
    const current = normalizeVersion(node.daemonVersion);
    const target = normalizeVersion(pendingUpdate.target);
    // A failure recorded after the click, or an update that ran and ended, ends the wait too: the
    // Update panel comes back with the reason instead of staying hidden.
    const failed = !!lastUpdateError && lastUpdateError.at !== pendingUpdate.errorAtTrigger;
    if (
      (target && current === target) ||
      !daemonUpdate.available ||
      failed ||
      (pendingUpdate.sawUpdating && !nodeUpdating)
    ) {
      setPendingUpdate(null);
    } else if (nodeUpdating && !pendingUpdate.sawUpdating) {
      setPendingUpdate({ ...pendingUpdate, sawUpdating: true });
    }
  }, [daemonUpdate.available, lastUpdateError, node.daemonVersion, nodeUpdating, pendingUpdate]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (node.type === "nginx") {
        if (node.status !== "online" || !node.isConnected) {
          setProxyHosts([]);
          setProxyHostsLoading(false);
          return;
        }
        try {
          const resp = await api.listProxyHosts({ nodeId: node.id, limit: 100 });
          if (!cancelled) setProxyHosts(resp.data ?? []);
        } catch {
          if (!cancelled) setProxyHosts([]);
        } finally {
          if (!cancelled) setProxyHostsLoading(false);
        }
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [node.id, node.isConnected, node.status, node.type]);

  const handleDaemonUpdate = async () => {
    if (isDevForceUpdatesEnabled()) {
      toast.info("Local update preview only");
      return;
    }
    setIsUpdating(true);
    const targetVersion = daemonUpdate.latestVersion;
    let result: Awaited<ReturnType<typeof api.triggerDaemonUpdate>>;
    try {
      result = await api.triggerDaemonUpdate(node.id);
    } catch (err) {
      toastApiError(err, "Failed to trigger update");
      setIsUpdating(false);
      return;
    }
    if (targetVersion) {
      setPendingUpdate({
        target: targetVersion,
        errorAtTrigger: lastUpdateError?.at ?? null,
        sawUpdating: false,
      });
    }
    toast.success(
      result.waitingForTasks
        ? `Daemon update queued — it starts once ${plural(result.waitingForTasks, "running task")} on the node finish, at the latest in 30 minutes`
        : result.leaseSequenced
          ? "Daemon update queued — the node restarts once the other members of its availability lease have settled"
          : "Daemon update triggered — the node will restart shortly"
    );
    // The update runs regardless of whether this refresh succeeds; realtime events refresh the page too.
    await Promise.all([refreshNode(), refreshDaemonUpdateStatus({ force: true })]).catch(
      () => undefined
    );
    setIsUpdating(false);
  };

  // The confirmed "Update now" of an update that waits for the running tasks of the node.
  const handleUpdateNow = () =>
    void confirmAction(
      {
        title: "Update now?",
        description: `The daemon restarts without waiting for the running tasks on this node: ${taskList(
          updateWaitingForTasks.map((task) => task.label)
        )}. They may fail.`,
        confirmLabel: "Update now",
        variant: "destructive",
      },
      async () => {
        try {
          await api.triggerDaemonUpdate(node.id, { now: true });
        } catch (err) {
          toastApiError(err, "Failed to update now");
          throw err;
        }
        toast.success("Daemon update starts now");
        await refreshNode().catch(() => undefined);
      }
    );

  const handleRuntimeAction = async (action: "preflight" | "install") => {
    if (!requireLicenseFeature("secure-runtime", "Secure Runtime setup")) return;
    setRuntimeAction(action);
    try {
      const status =
        action === "install"
          ? await api.installDockerRuntime(node.id)
          : await api.preflightDockerRuntime(node.id);
      setRuntimeStatus(status);
      toast.success(
        action === "install" ? "Secure runtime installed" : "Compatibility check completed"
      );
      await refreshNode();
    } catch (err) {
      if (!handleLicenseApiError(err, "Secure Runtime setup")) {
        toastApiError(err, "Secure runtime setup failed");
      }
    } finally {
      setRuntimeAction(null);
    }
  };

  const runtimeInstalling = runtimeAction === "install" || runtimeStatus?.state === "installing";
  useContentLoading(dockerCountsLoading || proxyHostsLoading);
  const proxyHostColumns: SimpleTableColumn<ProxyHost>[] = [
    {
      id: "domain",
      header: "Domain",
      cellClassName: "font-medium",
      // The node's view keeps app members; the badge opens the app.
      render: (host) =>
        host.app ? (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{host.domainNames.join(", ")}</span>
            <AppMemberBadge app={host.app} />
          </span>
        ) : (
          host.domainNames.join(", ")
        ),
    },
    {
      id: "type",
      header: "Type",
      cellClassName: "capitalize text-muted-foreground",
      render: (host) => host.type,
    },
    {
      id: "target",
      header: "Target",
      cellClassName: "text-muted-foreground",
      render: (host) => <ProxyUpstreamTarget host={host} />,
    },
    {
      id: "status",
      header: "Status",
      render: (host) => (
        <Badge variant={host.enabled ? "success" : "secondary"}>
          {host.enabled ? "active" : "disabled"}
        </Badge>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {(hosting || node.type === "docker") && (
        <div
          className={cn(
            "grid grid-cols-1 gap-4",
            hosting && node.type === "docker" && "min-[1044px]:grid-cols-2"
          )}
        >
          {node.type === "docker" && (
            <PanelShell title="Docker" bodyClassName="divide-y divide-border">
              {dockerResources.map((resource) => (
                <DetailRow
                  key={resource.tab}
                  label={`${resource.canView ? (dockerCounts[resource.tab] ?? "—") : "—"} ${resource.label}`}
                  value={
                    resource.canView ? (
                      <Button asChild variant="link" className="h-auto p-0">
                        <Link to={dockerNodeListRoute(node.id, resource.tab)}>
                          View {resource.label}
                          <ArrowRight data-icon="inline-end" />
                        </Link>
                      </Button>
                    ) : (
                      "No access"
                    )
                  }
                />
              ))}
            </PanelShell>
          )}
          {hosting && (
            <PanelShell title="Hosting" bodyClassName="divide-y divide-border">
              <DetailRow
                label="Provider"
                value={`${HOSTING_PROVIDER_LABELS[hosting.provider]} · ${hosting.connectorName ?? "Disconnected account"}`}
              />
              <DetailRow
                label="Resource"
                value={
                  hosting.resourceId
                    ? `${hosting.kind.toUpperCase()} ${hosting.remoteId} · ${hosting.locationName ?? hosting.location}`
                    : "Waiting for provider VM"
                }
              />
              <DetailRow
                label="Resources"
                value={`${hosting.cpu ?? "—"} vCPU · ${hosting.memoryMb ?? "—"} MiB RAM · ${hosting.diskGb ?? "—"} GiB disk`}
              />
              {hosting.provider === "proxmox" && (
                <DetailRow label="Ownership" value={hosting.origin} />
              )}
              <DetailRow label="Updated" value={<RelativeTime value={hosting.observedAt} />} />
              {hosting.price && (
                <DetailRow
                  label={hosting.price.estimated ? "Estimated cost" : "Cost"}
                  value={`${hosting.price.amount} ${hosting.price.currency} / ${hosting.price.period ?? "billing period"}`}
                />
              )}
              {hosting.identityConflict && (
                <DetailRow
                  label="Management"
                  value="Provider resource identity changed. Remote actions are disabled."
                />
              )}
            </PanelShell>
          )}
        </div>
      )}

      {node.type === "docker" && (
        <PanelShell
          role="region"
          aria-label="Container summary"
          bodyClassName="grid grid-cols-4 divide-x divide-border"
        >
          {[
            { label: "Running", count: containerStates?.running },
            { label: "Stopped", count: containerStates?.stopped },
            { label: "Paused", count: containerStates?.paused },
            { label: "Total", count: dockerCounts.containers },
          ].map((item) => (
            <div key={item.label} className="p-4 text-center">
              <p className="font-display text-2xl font-bold">
                {dockerResources[0].canView ? (item.count ?? "—") : "—"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">{item.label}</p>
            </div>
          ))}
        </PanelShell>
      )}

      {!nodeUpdating && daemonUpdate.available && !pendingUpdate && (
        <PanelShell
          title={<span className="text-warning-text">Update Available</span>}
          description={`${daemonUpdate.latestVersion} is ready to install`}
          dirty
          actions={
            node.type === "relay" ? (
              // A relay restart drops the control streams it carries; the Relay Pool update drains
              // and orders relays, so relay nodes update from there.
              <Button asChild variant="warning">
                <Link to="/settings/general">
                  <ArrowUpCircle />
                  Update the Relay Pool
                </Link>
              </Button>
            ) : (
              <Button
                variant="warning"
                onClick={handleDaemonUpdate}
                pending={isUpdating}
                disabled={!canTriggerDaemonUpdate}
                title={
                  canTriggerDaemonUpdate
                    ? undefined
                    : "Daemon update requires a connected compatible node"
                }
              >
                <ArrowUpCircle />
                Update to {daemonUpdate.latestVersion}
              </Button>
            )
          }
        >
          <div className="divide-y divide-border">
            <DetailRow label="Current version" value={node.daemonVersion ?? "Unknown"} />
            <DetailRow label="New version" value={daemonUpdate.latestVersion ?? "Unknown"} />
            {showsUpdateConnections && updateConnectionsRow("Connections")}
            {lastUpdateError && (
              <DetailRow
                label="Last attempt"
                value={
                  <span className="text-destructive">
                    {lastUpdateError.message}
                    {lastUpdateError.at ? (
                      <>
                        {" "}
                        (<RelativeTime value={lastUpdateError.at} />)
                      </>
                    ) : null}
                  </span>
                }
              />
            )}
          </div>
        </PanelShell>
      )}

      {updateWaitsForTasks && (
        <PanelShell
          title={<span className="text-warning-text">Update Waiting</span>}
          description={`Waits for ${plural(updateWaitingForTasks.length, "running task")}: ${taskList(
            updateWaitingForTasks.map((task) => task.label)
          )}`}
          dirty
          actions={
            canUpdateDaemon ? (
              <Button variant="warning" onClick={handleUpdateNow}>
                <ArrowUpCircle />
                Update now
              </Button>
            ) : null
          }
        >
          <div className="divide-y divide-border">
            <DetailRow label="New version" value={updateTargetVersion ?? "Unknown"} />
            {Number.isFinite(updateTaskWaitStartedAt) && (
              <DetailRow
                label="Starts by"
                value={formatDateTime(new Date(updateTaskWaitStartedAt + UPDATE_TASK_WAIT_MS))}
              />
            )}
            {showsUpdateConnections && updateConnectionsRow("Connections")}
          </div>
        </PanelShell>
      )}

      {node.type === "docker" &&
        runtimeStatus?.state !== "healthy" &&
        (secureRuntimeLicensed || Boolean(runtimeStatus?.installedVersion)) && (
          <PanelShell
            title="Secure Runtime Setup"
            description={
              runtimeInstalling
                ? "Installing and verifying Secure Runtime"
                : runtimeStatus?.message || "Check this node for gVisor compatibility"
            }
            actions={
              !canManageSecureRuntime || !secureRuntimeLicensed ? null : runtimeInstalling ? (
                <Button pending>Setting up...</Button>
              ) : (runtimeStatus?.state === "installable" || runtimeStatus?.state === "failed") &&
                runtimeStatus.remoteInstallable ? (
                <Button
                  onClick={() => handleRuntimeAction("install")}
                  disabled={runtimeAction !== null || node.status !== "online" || !node.isConnected}
                >
                  <ShieldCheck />
                  {runtimeStatus.state === "failed" ? "Retry setup" : "Setup"}
                </Button>
              ) : runtimeStatus?.state !== "unsupported" ? (
                <Button
                  variant="outline"
                  onClick={() => handleRuntimeAction("preflight")}
                  pending={runtimeAction === "preflight"}
                  disabled={runtimeAction !== null || node.status !== "online" || !node.isConnected}
                >
                  Check compatibility
                </Button>
              ) : null
            }
          >
            <div className="divide-y divide-border">
              <DetailRow
                label="Status"
                value={
                  <Badge variant={runtimeStatus?.state === "unsupported" ? "secondary" : "warning"}>
                    {runtimeInstalling ? "installing" : (runtimeStatus?.state ?? "unknown")}
                  </Badge>
                }
              />
              {runtimeInstalling && runtimeStatus?.message && (
                <DetailRow label="Step" value={runtimeStatus.message} />
              )}
              {runtimeStatus?.step === "downloading" &&
                runtimeStatus.progressPercent !== undefined && (
                  <DetailRow
                    label="Download"
                    value={
                      <span className="flex w-full max-w-xs items-center gap-3">
                        <ProgressBar
                          value={runtimeStatus.progressPercent}
                          aria-label="gVisor download progress"
                        />
                        <span className="w-10 shrink-0 text-right tabular-nums">
                          {runtimeStatus.progressPercent}%
                        </span>
                      </span>
                    }
                  />
                )}
              {runtimeStatus?.localInstallCommand && !runtimeStatus.remoteInstallable && (
                <DetailRow
                  label="Local setup"
                  value={
                    <span className="font-mono text-xs">{runtimeStatus.localInstallCommand}</span>
                  }
                />
              )}
            </div>
          </PanelShell>
        )}

      {/* Node Details — 2 cards side by side */}
      <div className="grid grid-cols-1 gap-4 min-[1044px]:grid-cols-2">
        {/* Identity */}
        <PanelShell
          title="Identity"
          bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
        >
          <DetailRow label="Node ID" value={<span className="break-all">{node.id}</span>} />
          <DetailRow label="Hostname" value={node.hostname} />
          <DetailRow
            label="Type"
            value={
              <Badge variant="secondary" className="uppercase">
                {nodeTypeLabel(node.type)}
              </Badge>
            }
          />
          {node.osInfo && <DetailRow label="OS" value={node.osInfo} />}
          <DetailRow
            label="IP Addresses"
            value={
              <Button
                variant="link"
                className="h-auto p-0"
                onClick={() => setIpAddressesOpen(true)}
              >
                View {ipAddressCount} {ipAddressCount === 1 ? "address" : "addresses"}
              </Button>
            }
          />
        </PanelShell>

        {/* Runtime */}
        <PanelShell
          title="Runtime"
          bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
        >
          <DetailRow
            label="Daemon Version"
            value={
              <div className="flex items-center gap-2">
                {node.daemonVersion ? (
                  <Badge variant="secondary" className="uppercase">
                    {node.daemonVersion}
                  </Badge>
                ) : (
                  "Unknown"
                )}
                {(caps.versionMismatch as boolean) && <Badge variant="warning">Mismatch</Badge>}
                {nodeUpdating && (
                  <Badge
                    variant="warning"
                    title={
                      updateWaitsForTasks
                        ? `Waits for ${plural(updateWaitingForTasks.length, "running task")}`
                        : updateQueued && updateWaitingFor.length > 0
                          ? updateWaitingFor.every((entry) => entry.reason === "ingress_last")
                            ? `Waits for ${plural(updateWaitingFor.length, "other node")} of this batch to finish updating: ingress nodes update last`
                            : `Waits for ${updateWaitingFor.length} lease member${updateWaitingFor.length === 1 ? "" : "s"}: ${updateWaitingFor.map((entry) => entry.reason).join(", ")}`
                          : undefined
                    }
                  >
                    {updateQueued ? "Queued" : "Updating"}
                    {updateTargetVersion ? ` to ${updateTargetVersion}` : ""}
                  </Badge>
                )}
              </div>
            }
          />
          {node.daemonVersion && (
            <DetailRow
              label="Launcher Version"
              value={
                typeof caps.launcherVersion === "string" && caps.launcherVersion ? (
                  <Badge variant="secondary" className="uppercase">
                    {caps.launcherVersion}
                  </Badge>
                ) : (
                  <span className="flex flex-col items-end gap-0.5">
                    <span>Unknown</span>
                    <span className="text-xs text-muted-foreground">
                      {launcherVersionUnknownReason(caps.capabilities)}
                    </span>
                  </span>
                )
              }
            />
          )}
          {typeof h?.leaseWatchdogVersion === "string" && h.leaseWatchdogVersion && (
            <DetailRow
              label="Lease Watchdog Version"
              value={
                <Badge variant="secondary" className="uppercase">
                  {h.leaseWatchdogVersion}
                </Badge>
              }
            />
          )}
          {/* What the next daemon update does to open connections, also with no update available. The Update
              Available and Update Waiting panels show it themselves. */}
          {updateConnectionsPlacement(
            node.type,
            (!nodeUpdating && daemonUpdate.available && !pendingUpdate) || updateWaitsForTasks
          ) === "runtime" && updateConnectionsRow("Next Update")}
          {node.type === "nginx" && (
            <DetailRow label="Nginx Version" value={String(caps.nginxVersion ?? "Unknown")} />
          )}
          {node.type === "docker" && (
            <DetailRow label="Docker Version" value={String(caps.dockerVersion ?? "Unknown")} />
          )}
          {node.type === "docker" && runtimeStatus && (
            <DetailRow
              label="Secure Runtime"
              value={
                <div className="flex items-center gap-2">
                  <Badge
                    variant={
                      runtimeStatus.state === "healthy"
                        ? "success"
                        : runtimeStatus.state === "failed"
                          ? "destructive"
                          : runtimeStatus.state === "unsupported"
                            ? "secondary"
                            : "warning"
                    }
                    className="uppercase"
                  >
                    {runtimeStatus.state}
                  </Badge>
                  {runtimeStatus.installedVersion && (
                    <Badge variant="secondary">{runtimeStatus.installedVersion}</Badge>
                  )}
                </div>
              }
            />
          )}
          {lastUpdate && (
            <DetailRow
              label="Last Update"
              value={
                <span className="flex flex-col items-end gap-0.5">
                  <span>
                    {lastUpdate.targetVersion}
                    {lastUpdate.rolledBackTo ? `, rolled back to ${lastUpdate.rolledBackTo}` : ""}
                    {lastUpdate.completedAt ? (
                      <>
                        {" "}
                        (<RelativeTime value={lastUpdate.completedAt} />)
                      </>
                    ) : null}
                  </span>
                  {lastUpdate.connections && (
                    <span className="text-xs text-muted-foreground">
                      {lastUpdateConnectionsText(lastUpdate.connections)}
                    </span>
                  )}
                  {lastUpdate.serviceRestart && (
                    <span className="text-xs text-muted-foreground">
                      {lastUpdate.serviceRestart}
                    </span>
                  )}
                  {lastUpdate.warnings.map((warning) => (
                    <span key={warning} className="text-xs text-warning-text">
                      {warning}
                    </span>
                  ))}
                </span>
              }
            />
          )}
          {lastConnectorReplacement && (
            <DetailRow
              label="Connector Replacement"
              value={
                <span>
                  Cut {plural(lastConnectorReplacement.connectionsCut, "connection")} of the
                  replaced Secure Link connector (
                  <RelativeTime value={lastConnectorReplacement.at} />)
                </span>
              }
            />
          )}
          <DetailRow label="Created" value={<RelativeTime value={node.createdAt} />} />
          <DetailRow
            label="Last Seen"
            value={<RelativeTime value={node.lastSeenAt} fallback="Never" />}
          />
        </PanelShell>
      </div>

      {/* System Stats */}
      {h && (
        <div className="grid grid-cols-1 gap-4 min-[1044px]:grid-cols-2 min-[1044px]:items-start">
          {/* Resources */}
          <div
            ref={(el) => {
              if (el) resourcesRef.current = el;
            }}
          >
            <PanelShell title="System Information" bodyClassName="divide-y divide-border">
              {"cpuModel" in caps && <DetailRow label="CPU" value={String(caps.cpuModel)} />}
              {"cpuCores" in caps && <DetailRow label="CPU Cores" value={String(caps.cpuCores)} />}
              {"architecture" in caps && (
                <DetailRow label="Architecture" value={String(caps.architecture)} />
              )}
              {"kernelVersion" in caps && (
                <DetailRow label="Kernel" value={String(caps.kernelVersion)} />
              )}
              <DetailRow label="Uptime" value={formatUptime(h.systemUptimeSeconds)} />
              <DetailRow
                label="File Descriptors"
                value={`${h.openFileDescriptors.toLocaleString()} / ${formatFileDescriptorLimit(h.maxFileDescriptors)}`}
              />
            </PanelShell>
          </div>

          {/* Disk Mounts */}
          <PanelShell
            title="Disk Mounts"
            className="flex flex-col"
            style={{ height: resourcesHeight > 0 ? resourcesHeight : undefined }}
            bodyClassName="flex flex-1 min-h-0 flex-col"
          >
            {h.diskMounts && h.diskMounts.length > 0 ? (
              <div className="overflow-y-auto flex-1 min-h-0 -mb-px">
                {h.diskMounts.map((m) => (
                  <div key={m.mountPoint} className="px-4 py-3 space-y-1 border-b border-border">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-mono">{m.mountPoint}</span>
                        {m.mountPoint === "/" && (
                          <Badge variant="outline" size="inline">
                            ROOT DISK
                          </Badge>
                        )}
                      </div>
                      <span className="text-sm text-muted-foreground">
                        {Math.round(m.usagePercent)}%
                      </span>
                    </div>
                    <div className="h-1.5 w-full bg-muted overflow-hidden">
                      <div
                        className={cn(
                          "h-full",
                          m.usagePercent >= 90
                            ? "bg-destructive"
                            : m.usagePercent >= 80
                              ? "bg-warning"
                              : "bg-foreground"
                        )}
                        style={{ width: `${Math.min(m.usagePercent, 100)}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{formatBytes(m.usedBytes)} used</span>
                      <span>{formatBytes(m.totalBytes)} total</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState message="No disk data" embedded />
            )}
          </PanelShell>
        </div>
      )}

      <Dialog open={ipAddressesOpen} onOpenChange={setIpAddressesOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>IP Addresses</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <IPAddressPanel title="Public IP Addresses" addresses={publicIpAddresses} />
            <IPAddressPanel title="Local IP Addresses" addresses={localIpAddresses} />
          </div>
        </DialogContent>
      </Dialog>

      {/* Assigned Proxy Hosts — nginx nodes only */}
      {node.type === "nginx" && (
        <PanelShell
          title="Assigned Routes"
          actions={<Badge variant="secondary">{proxyHosts.length}</Badge>}
        >
          <SimpleTable
            columns={proxyHostColumns}
            rows={proxyHosts}
            getRowKey={(host) => host.id}
            onRowClick={(host) => navigate(proxyHostRoute(host.slug))}
            emptyMessage="No routes assigned yet"
          />
        </PanelShell>
      )}
    </div>
  );
}
