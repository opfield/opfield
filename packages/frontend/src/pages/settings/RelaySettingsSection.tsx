import {
  Activity,
  Ban,
  Cable,
  Cpu,
  Database,
  Gauge,
  MemoryStick,
  Network,
  Plus,
  RefreshCw,
  Save,
  Server,
  Waypoints,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { CopyCodeBlock } from "@/components/common/CopyCodeBlock";
import { OneTimeSecretDialog } from "@/components/common/OneTimeSecretDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { HostAccessInstallOptions } from "@/components/nodes/HostAccessInstallOptions";
import { NodeEnrollmentDialog } from "@/components/nodes/NodeEnrollmentDialog";
import { ProtectedNodeBadge } from "@/components/nodes/ProtectedNodeBadge";
import { TokenArgumentInstallCommand } from "@/components/nodes/TokenArgumentInstallCommand";
import { UnreleasedInstallerNote } from "@/components/nodes/UnreleasedInstallerNote";
import { RelayPortDialog } from "@/components/relays/RelayPortDialog";
import { WitnessHostingToggle } from "@/components/relays/WitnessHostingToggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NumericInput } from "@/components/ui/numeric-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatCard } from "@/components/ui/stat-card";
import { Switch } from "@/components/ui/switch";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { toastApiError } from "@/lib/api-error-toast";
import {
  DEFAULT_HOST_ACCESS_INSTALL_OPTIONS,
  withHostAccessInstallFlags,
} from "@/lib/node-host-access";
import { relayEndpointLabel } from "@/lib/relay-port";
import { relayRemovalWaitNote } from "@/lib/relay-removal";
import { activeRelayUpdateStep, relayStatusBadge } from "@/lib/relay-update-step";
import { formatBytes, formatDateTime } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useUpdateStore } from "@/stores/update";
import type {
  AuthProvisioningSettings,
  DashboardRelayInstance,
  DashboardRelaySnapshot,
  RelayLocalOutage,
  RelayReenrollment,
  RelayRevocationStatus,
} from "@/types";

const MAX_HISTORY = 60;
const RELAY_SETTINGS_CACHE_KEY = "req:/api/admin/auth-settings";
const RELAY_STATUS_CACHE_KEY = "req:/api/system/relay";

type CachedRelayStatusResponse = { data: DashboardRelaySnapshot | null };

/** Relay Pool update run states that the backend can still abandon. */
const UNFINISHED_RELAY_UPDATE_STATES = new Set([
  "preflight",
  "draining",
  "updating",
  "verifying",
  "rolling_back",
  "paused",
]);

function percent(value: number, total: number) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, (value / total) * 100));
}

function metric(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function admissionLabel(state: string | undefined) {
  switch (state) {
    case "normal":
      return "No throttling";
    case "proxy_throttled":
      return "Route fair-share";
    case "database_reserved":
      return "Database reserve";
    case "hard_pressure":
      return "Hard pressure";
    case "disabled":
      return "Disabled";
    default:
      return "Unknown";
  }
}

/**
 * Remote relays that need, or may need, a fresh enrollment to recover. Not one that only waits for
 * the local relay to come back.
 */
function canReenroll(instance: DashboardRelayInstance): boolean {
  return (
    instance.kind === "remote" &&
    Boolean(instance.nodeId) &&
    (instance.policyTrust?.state === "reenrollment_required" ||
      instance.certificate?.state === "expired" ||
      (["synchronizing", "offline", "error"].includes(instance.state) && !instance.reconnecting))
  );
}

/** The pool state while the local relay restarts: what is still going on, in plain words. */
function localRelayOutageLabel(outage: RelayLocalOutage | null | undefined): string {
  return outage?.phase === "reconnecting" ? "nodes reconnecting" : "local relay restarting";
}

/** How many nodes and relays are still coming back after the local relay restarted. */
function localRelayOutageDetail(outage: RelayLocalOutage | null | undefined): string | undefined {
  if (!outage) return undefined;
  const count = (value: number | undefined, noun: string) =>
    `${value ?? 0} ${noun}${value === 1 ? "" : "s"}`;
  const nodes = count(outage.reconnectingNodes, "node");
  return `Reconnecting: ${nodes}, ${count(outage.reconnectingRelays, "relay")}`;
}

/** Which revoked routes a relay still holds, from the counts the pool status reports. */
function revocationSummary(revocation: RelayRevocationStatus): string {
  const routes = revocation.state === "stale" ? revocation.staleRoutes : revocation.pendingRoutes;
  const label = `${routes} revoked route${routes === 1 ? "" : "s"}`;
  return revocation.state === "stale"
    ? `Stale for revocation of ${label}`
    : `Revocation of ${label} pending`;
}

/** A remote relay whose certificate Opfield should renew now. */
function canRenewCertificate(instance: DashboardRelayInstance): boolean {
  return (
    instance.kind === "remote" &&
    Boolean(instance.nodeId) &&
    (instance.certificate?.state === "expired" || instance.certificate?.state === "renewal_failed")
  );
}

function sortRelayInstances(instances: DashboardRelayInstance[]): DashboardRelayInstance[] {
  return [...instances].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "local" ? -1 : 1;
    const byName = left.displayName.localeCompare(right.displayName, undefined, {
      numeric: true,
      sensitivity: "base",
    });
    return byName || left.id.localeCompare(right.id);
  });
}

export function RelaySettingsSection({ canEdit }: { canEdit: boolean }) {
  const [initialSnapshot] = useState(() => {
    const cachedSettings = api.getCached<AuthProvisioningSettings>(
      RELAY_SETTINGS_CACHE_KEY,
      Number.POSITIVE_INFINITY
    );
    const cachedStatus = api.getCached<CachedRelayStatusResponse>(
      RELAY_STATUS_CACHE_KEY,
      Number.POSITIVE_INFINITY
    );
    return {
      settings: cachedSettings ?? null,
      status: cachedStatus?.data ?? null,
      statusCached: cachedStatus !== undefined,
    };
  });
  const initialRelay = initialSnapshot.settings?.generalSettings.relay;
  const [settings, setSettings] = useState<AuthProvisioningSettings | null>(
    initialSnapshot.settings
  );
  // Both requests feed the first render: cached settings alone would show the
  // pool as unavailable until the status arrives.
  const [initialLoadComplete, setInitialLoadComplete] = useState(
    settings !== null && initialSnapshot.statusCached
  );
  const [status, setStatus] = useState<DashboardRelaySnapshot | null>(initialSnapshot.status);
  const [history, setHistory] = useState<DashboardRelaySnapshot[]>(() =>
    initialSnapshot.status ? [initialSnapshot.status] : []
  );
  const [dataLanes, setDataLanes] = useState(initialRelay?.dataLanes ?? 4);
  const [readChunkBytes, setReadChunkBytes] = useState(initialRelay?.readChunkBytes ?? 32 * 1024);
  const [assignmentSpreadMode, setAssignmentSpreadMode] = useState<"fixed" | "all">(
    initialRelay?.assignmentSpread?.mode ?? "fixed"
  );
  const [assignmentSpreadCount, setAssignmentSpreadCount] = useState(
    initialRelay?.assignmentSpread?.mode === "fixed" ? initialRelay.assignmentSpread.count : 2
  );
  const [grantTtlHours, setGrantTtlHours] = useState(
    initialSnapshot.settings?.generalSettings.relayGrantTtlHours ?? 4
  );
  const [policyLeaseHours, setPolicyLeaseHours] = useState(
    initialSnapshot.settings?.generalSettings.relayPolicyLeaseHours ?? 72
  );
  const [autoRecovery, setAutoRecovery] = useState(
    initialSnapshot.settings?.generalSettings.relayAutoRecovery ?? true
  );
  const [adaptiveAdmissionEnabled, setAdaptiveAdmissionEnabled] = useState(
    initialRelay?.adaptiveAdmissionEnabled ?? true
  );
  const [proxyTargetPressurePercent, setProxyTargetPressurePercent] = useState(
    initialRelay?.proxyTargetPressurePercent ?? 70
  );
  const [databaseReservePercent, setDatabaseReservePercent] = useState(
    initialRelay?.databaseReservePercent ?? 20
  );
  const [hardPressurePercent, setHardPressurePercent] = useState(
    initialRelay?.hardPressurePercent ?? 95
  );
  const [saving, setSaving] = useState(false);
  // The pool action in flight (for example "rebalance" or "drain:<id>"); every
  // pool action stays disabled while one runs, the started one shows progress.
  const [poolAction, setPoolAction] = useState<string | null>(null);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [portChange, setPortChange] = useState<DashboardRelayInstance | null>(null);
  const [abandoningUpdate, setAbandoningUpdate] = useState(false);
  const [reenrollment, setReenrollment] = useState<RelayReenrollment | null>(null);
  const shownReenrollment = useRetainedDialogValue(reenrollment, reenrollment !== null);
  const [hostAccess, setHostAccess] = useState(DEFAULT_HOST_ACCESS_INSTALL_OPTIONS);
  const canAbandonRelayUpdate = useAuthStore((state) => state.hasScope("admin:update"));
  const abandonRelayUpdate = useUpdateStore((state) => state.abandonRelayUpdate);

  const recordStatus = useCallback((next: DashboardRelaySnapshot | null) => {
    // While the local relay restarts in a rollout its status can be briefly missing: keep the last one.
    setStatus((current) =>
      next === null && current?.update?.state === "updating" ? current : next
    );
    if (!next) return;
    setHistory((current) => {
      const latest = current.at(-1);
      if (latest?.lastProbeAt && latest.lastProbeAt === next.lastProbeAt) return current;
      return [...current, next].slice(-MAX_HISTORY);
    });
  }, []);

  const load = useCallback(async () => {
    const [nextSettings, nextStatus] = await Promise.all([
      api.getAuthProvisioningSettings(),
      api.getRelayStatus(),
    ]);
    setSettings(nextSettings);
    recordStatus(nextStatus);
    setDataLanes(nextSettings.generalSettings.relay?.dataLanes ?? 4);
    setReadChunkBytes(nextSettings.generalSettings.relay?.readChunkBytes ?? 32 * 1024);
    setAssignmentSpreadMode(nextSettings.generalSettings.relay?.assignmentSpread?.mode ?? "fixed");
    setAssignmentSpreadCount(
      nextSettings.generalSettings.relay?.assignmentSpread?.mode === "fixed"
        ? nextSettings.generalSettings.relay.assignmentSpread.count
        : 2
    );
    setGrantTtlHours(nextSettings.generalSettings.relayGrantTtlHours);
    setPolicyLeaseHours(nextSettings.generalSettings.relayPolicyLeaseHours);
    setAutoRecovery(nextSettings.generalSettings.relayAutoRecovery);
    setAdaptiveAdmissionEnabled(
      nextSettings.generalSettings.relay?.adaptiveAdmissionEnabled ?? true
    );
    setProxyTargetPressurePercent(
      nextSettings.generalSettings.relay?.proxyTargetPressurePercent ?? 70
    );
    setDatabaseReservePercent(nextSettings.generalSettings.relay?.databaseReservePercent ?? 20);
    setHardPressurePercent(nextSettings.generalSettings.relay?.hardPressurePercent ?? 95);
  }, [recordStatus]);

  useEffect(() => {
    void load()
      .catch((error) => toastApiError(error, "Failed to load relay settings"))
      .finally(() => setInitialLoadComplete(true));
    const timer = window.setInterval(() => {
      void api
        .getRelayStatus()
        .then(recordStatus)
        .catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [load, recordStatus]);

  const handleAbandonUpdate = async () => {
    const ok = await confirm({
      title: "Abandon Relay Pool Update?",
      description:
        "Opfield fails this update run and returns the relays it drained to service. Relays that already updated keep the new version.",
      confirmLabel: "Abandon update",
      variant: "destructive",
    });
    if (!ok) return;
    setAbandoningUpdate(true);
    try {
      await abandonRelayUpdate();
      toast.success("Relay Pool update abandoned");
      recordStatus(await api.getRelayStatus());
    } catch (error) {
      toastApiError(error, "Failed to abandon the Relay Pool update");
    } finally {
      setAbandoningUpdate(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const updated = await api.updateAuthProvisioningSettings({
        generalSettings: {
          relayAutoRecovery: autoRecovery,
          relayGrantTtlHours: grantTtlHours,
          relayPolicyLeaseHours: policyLeaseHours,
          relay: {
            dataLanes,
            readChunkBytes,
            assignmentSpread:
              assignmentSpreadMode === "all"
                ? { mode: "all" }
                : { mode: "fixed", count: assignmentSpreadCount },
            adaptiveAdmissionEnabled,
            proxyTargetPressurePercent,
            databaseReservePercent,
            hardPressurePercent,
          },
        },
      });
      setSettings(updated);
      api.setCache(RELAY_SETTINGS_CACHE_KEY, updated);
      toast.success("Relay settings saved");
    } catch (error) {
      toastApiError(error, "Failed to save relay settings");
    } finally {
      setSaving(false);
    }
  };

  const rebalance = async () => {
    if (
      !(await confirm({
        title: "Rebalance Relay Pool?",
        description:
          "Opfield will pre-register every target and verify every source before switching new tunnels to the new assignments.",
        confirmLabel: "Rebalance",
      }))
    )
      return;
    setPoolAction("rebalance");
    try {
      const outcomes = await api.rebalanceRelayPool();
      const failed = outcomes.filter(({ state }) => state === "failed");
      const pending = outcomes.some(({ state }) => state === "staging");
      if (failed.length) {
        toast.error(
          `Relay rebalance failed for ${failed.length} workload${failed.length === 1 ? "" : "s"}`,
          {
            description:
              failed.find(({ error }) => error)?.error ??
              "Existing assignments were preserved for failed workloads.",
          }
        );
      } else if (!outcomes.length) {
        toast.info("Relay assignments are already balanced");
      } else if (pending) {
        toast.info("Relay rebalance is still verifying routes");
      } else if (outcomes.every(({ state }) => state === "active")) {
        toast.success("Relay rebalance activated");
      } else {
        toast.info("Relay rebalance finished; refreshing assignment status");
      }
      // A secondary read must not hide a known mutation outcome or delay its toast.
      try {
        recordStatus(await api.getRelayStatus());
      } catch {
        toast.warning("Rebalance result received, but relay status could not be refreshed");
      }
    } catch (error) {
      toastApiError(error, "Relay rebalance failed");
    } finally {
      setPoolAction(null);
    }
  };

  const setDrain = async (instance: DashboardRelayInstance, enabled: boolean) => {
    if (
      enabled &&
      !(await confirm({
        title: `Drain ${instance.displayName}?`,
        description:
          "New tunnels will move to other relays. Existing streams can finish for up to 10 minutes, then they are disconnected. Force disconnect ends the wait immediately.",
        confirmLabel: "Drain relay",
        variant: "destructive",
      }))
    )
      return;
    setPoolAction(`drain:${instance.id}`);
    try {
      recordStatus(await api.setRelayInstanceDrain(instance.id, enabled));
      toast.success(enabled ? "Relay is draining" : "Relay resumed");
    } catch (error) {
      toastApiError(error, "Relay action failed");
    } finally {
      setPoolAction(null);
    }
  };

  const forceDisconnect = async (instance: DashboardRelayInstance) => {
    if (
      !(await confirm({
        title: `Disconnect Active Streams on ${instance.displayName}?`,
        description:
          "This immediately terminates every active tunnel on this relay. Clients may reconnect through another ready instance.",
        confirmLabel: "Force disconnect",
        variant: "destructive",
      }))
    )
      return;
    setPoolAction(`disconnect:${instance.id}`);
    try {
      recordStatus(await api.forceDisconnectRelayInstance(instance.id));
      toast.success("Active relay streams disconnected");
    } catch (error) {
      toastApiError(error, "Relay action failed");
    } finally {
      setPoolAction(null);
    }
  };

  const renewCertificate = async (instance: DashboardRelayInstance) => {
    setPoolAction(`renew:${instance.id}`);
    try {
      recordStatus(await api.renewRelayInstanceCertificate(instance.id));
      toast.success("Relay certificate renewed");
    } catch (error) {
      toastApiError(error, "Relay certificate renewal failed");
    } finally {
      setPoolAction(null);
    }
  };

  const reenroll = async (instance: DashboardRelayInstance) => {
    if (
      !(await confirm({
        title: `Re-enroll ${instance.displayName}?`,
        description:
          "Opfield issues a single-use enrollment token for this relay. Running the relay installer with it on the host enrolls the relay again: it keeps its place in the pool, gets new certificates and pins the current policy signing key. Until then the relay keeps its current identity.",
        confirmLabel: "Create token",
      }))
    )
      return;
    setPoolAction(`reenroll:${instance.id}`);
    try {
      setReenrollment(await api.reenrollRelayInstance(instance.id));
      setHostAccess(DEFAULT_HOST_ACCESS_INSTALL_OPTIONS);
    } catch (error) {
      toastApiError(error, "Failed to create a re-enrollment token");
    } finally {
      setPoolAction(null);
    }
  };

  const changePort = async (instance: DashboardRelayInstance, port: number) => {
    setPoolAction(`port:${instance.id}`);
    try {
      recordStatus(await api.setRelayInstanceServicePort(instance.id, port));
      toast.success(`${instance.displayName} is moving to port ${port}`);
    } catch (error) {
      toastApiError(error, "Failed to change the relay port");
      throw error;
    } finally {
      setPoolAction(null);
    }
  };

  const removeRelay = async (instance: DashboardRelayInstance) => {
    if (!instance.nodeId) return;
    if (
      !(await confirm({
        title: `Remove ${instance.displayName}?`,
        description:
          instance.state === "offline"
            ? "Remove this offline relay and revoke its identity. Opfield will verify that its policy has expired and every affected workload has a ready remaining relay. The supervisor must be uninstalled separately on the host."
            : "This removes the drained relay identity and its retired assignment records. The supervisor must be uninstalled separately on the host.",
        confirmLabel: "Remove relay",
        variant: "destructive",
      }))
    )
      return;
    setPoolAction(`remove:${instance.id}`);
    try {
      await api.deleteNode(instance.nodeId);
      await load();
      toast.success("Relay node removed");
    } catch (error) {
      toastApiError(error, "Relay removal failed");
    } finally {
      setPoolAction(null);
    }
  };

  useContentLoading(!initialLoadComplete);
  if (!initialLoadComplete) return null;

  if (!settings) return null;

  const healthy = status?.state === "healthy";
  const rolloutActive = UNFINISHED_RELAY_UPDATE_STATES.has(status?.update?.state ?? "");
  const memoryLimit = metric(status?.memoryLimitBytes);
  const memoryRss = metric(status?.memoryRssBytes);
  const fdLimit = metric(status?.fileDescriptorLimit);
  const openFDs = metric(status?.openFileDescriptors);
  const pressureColor =
    status?.admissionState === "normal" ? "var(--color-hue-green)" : "var(--color-hue-amber)";
  const persistedRelay = settings.generalSettings.relay;
  const persistedDataLanes = persistedRelay?.dataLanes ?? 4;
  const persistedReadChunkBytes = persistedRelay?.readChunkBytes ?? 32 * 1024;
  const persistedAssignmentSpread = persistedRelay?.assignmentSpread ?? {
    mode: "fixed" as const,
    count: 2,
  };
  const hasChanges =
    dataLanes !== persistedDataLanes ||
    readChunkBytes !== persistedReadChunkBytes ||
    assignmentSpreadMode !== persistedAssignmentSpread.mode ||
    (assignmentSpreadMode === "fixed" &&
      (persistedAssignmentSpread.mode !== "fixed" ||
        assignmentSpreadCount !== persistedAssignmentSpread.count)) ||
    adaptiveAdmissionEnabled !== (persistedRelay?.adaptiveAdmissionEnabled ?? true) ||
    proxyTargetPressurePercent !== (persistedRelay?.proxyTargetPressurePercent ?? 70) ||
    databaseReservePercent !== (persistedRelay?.databaseReservePercent ?? 20) ||
    hardPressurePercent !== (persistedRelay?.hardPressurePercent ?? 95) ||
    grantTtlHours !== settings.generalSettings.relayGrantTtlHours ||
    policyLeaseHours !== settings.generalSettings.relayPolicyLeaseHours ||
    autoRecovery !== settings.generalSettings.relayAutoRecovery;
  const instances = sortRelayInstances(status?.instances ?? []);
  const readyInstances = instances.filter((instance) => instance.state === "ready").length;
  const faultDomains = new Set(instances.map((instance) => instance.faultDomainId)).size;
  const hottestInstance = instances.reduce<DashboardRelayInstance | null>(
    (current, instance) =>
      !current || metric(instance.health?.pressurePercent) > metric(current.health?.pressurePercent)
        ? instance
        : current,
    null
  );
  const instanceColumns: SimpleTableColumn<DashboardRelayInstance>[] = [
    {
      id: "name",
      header: "Instance",
      render: (row) => (
        <div>
          <div className="flex items-center gap-2 font-medium">
            {row.displayName}
            {row.protected && <ProtectedNodeBadge size="inline" />}
          </div>
          <div className="text-xs text-muted-foreground">
            {row.kind === "local"
              ? "Opfield host"
              : row.advertisedAddresses
                  .map((address) => relayEndpointLabel(address, row.servicePort))
                  .join(", ")}
          </div>
        </div>
      ),
    },
    {
      id: "state",
      header: "State",
      render: (row) => {
        const removalWait = relayRemovalWaitNote(row);
        const badge = relayStatusBadge(row, rolloutActive);
        const { unreachable } = badge;
        return (
          <div className="space-y-1">
            <Badge variant={badge.variant}>{badge.label}</Badge>
            {unreachable && (
              <div className="text-xs text-muted-foreground">
                Nodes cannot reach{" "}
                {row.advertisedAddresses
                  .map((address) => relayEndpointLabel(address, row.servicePort))
                  .join(", ") || "its relay port"}
                ; check the port forward and firewall. It gets no connections meanwhile.
              </div>
            )}
            {row.updateStep?.state === "draining" && row.updateStep.drainDeadlineAt && (
              <div className="text-xs text-muted-foreground">
                Drains until {formatDateTime(row.updateStep.drainDeadlineAt)}
              </div>
            )}
            {row.updateStep?.error && (
              <div className="text-xs text-muted-foreground">Update: {row.updateStep.error}</div>
            )}
            {row.portChange && row.portChange.state !== "failed" && (
              <div className="text-xs text-muted-foreground">
                {row.portChange.state === "draining"
                  ? `Moving to port ${row.portChange.servicePort}: streams move to other relays`
                  : `Moving to port ${row.portChange.servicePort}: restarting on it`}
              </div>
            )}
            {row.portChange?.state === "failed" && (
              <p role="alert" className="max-w-md break-words text-xs text-destructive">
                Port change to {row.portChange.servicePort} failed: {row.portChange.error}
              </p>
            )}
            {row.policyTrust && (
              <p
                role={row.policyTrust.state === "recovered" ? undefined : "alert"}
                className={`max-w-md text-xs ${
                  row.policyTrust.state === "recovered" || row.policyTrust.state === "locked_out"
                    ? "text-warning-text"
                    : "text-destructive"
                }`}
              >
                {row.policyTrust.message}
              </p>
            )}
            {row.certificate && (
              <p
                role={row.certificate.state === "expiring" ? undefined : "alert"}
                className={`max-w-md text-xs ${
                  row.certificate.state === "expiring"
                    ? "text-muted-foreground"
                    : "text-destructive"
                }`}
              >
                {row.certificate.message}
              </p>
            )}
            {row.revocation && (
              <p
                role={row.revocation.state === "stale" ? "alert" : undefined}
                className={`max-w-md text-xs ${
                  row.revocation.state === "stale" ? "text-destructive" : "text-warning-text"
                }`}
              >
                {revocationSummary(row.revocation)} since{" "}
                <RelativeTime value={row.revocation.since} />. {row.revocation.message}
              </p>
            )}
            {removalWait && <p className="max-w-md text-xs text-muted-foreground">{removalWait}</p>}
            {badge.showLastError && (
              <p className="max-w-md break-words text-xs text-muted-foreground">
                {row.health?.lastError}
              </p>
            )}
          </div>
        );
      },
    },
    {
      id: "assignments",
      header: "Assignments",
      render: (row) => (
        <div>
          <div>{row.activeAssignments} active</div>
          {(row.retainedAssignments ?? row.activeAssignments) > row.activeAssignments && (
            <div className="text-xs text-muted-foreground">
              {(row.retainedAssignments ?? 0) - row.activeAssignments} staging / draining
            </div>
          )}
        </div>
      ),
    },
    {
      id: "load",
      header: "Load",
      render: (row) => (
        <span className="whitespace-nowrap">
          {metric(row.health?.activeTunnels)} tunnels · {metric(row.health?.pressurePercent)}%
        </span>
      ),
    },
    {
      id: "witnesses",
      header: "Witnesses",
      render: (row) => (
        <WitnessHostingToggle
          instance={row}
          canEdit={canEdit}
          onChanged={() => {
            void api
              .getRelayStatus()
              .then(recordStatus)
              .catch(() => undefined);
          }}
        />
      ),
    },
    {
      id: "version",
      header: "Version",
      render: (row) => (
        <div>
          <div>
            {row.buildVersion ??
              (row.kind === "local" ? (status?.local?.relayBuildVersion ?? "unknown") : "unknown")}
          </div>
          <div className="text-xs text-muted-foreground">
            protocol v{row.protocolMajor ?? "-"} · policy r{row.appliedPolicyRevision}
          </div>
        </div>
      ),
    },
    {
      id: "actions",
      header: "",
      align: "right",
      render: (row) =>
        row.kind === "remote" ? (
          <div className="flex items-center justify-end gap-2">
            {row.state === "draining" && metric(row.health?.activeTunnels) > 0 && (
              <Button
                variant="destructive"
                pending={poolAction === `disconnect:${row.id}`}
                disabled={!canEdit || poolAction !== null}
                onClick={() => void forceDisconnect(row)}
              >
                Force disconnect
              </Button>
            )}
            {canRenewCertificate(row) && (
              <Button
                variant="outline"
                pending={poolAction === `renew:${row.id}`}
                disabled={!canEdit || poolAction !== null}
                onClick={() => void renewCertificate(row)}
              >
                Renew certificate
              </Button>
            )}
            {canReenroll(row) && !activeRelayUpdateStep(row, rolloutActive) && (
              <Button
                variant={row.policyTrust?.state === "reenrollment_required" ? "default" : "outline"}
                pending={poolAction === `reenroll:${row.id}`}
                disabled={!canEdit || poolAction !== null}
                onClick={() => void reenroll(row)}
              >
                Re-enroll
              </Button>
            )}
            {["ready", "draining"].includes(row.state) &&
              !activeRelayUpdateStep(row, rolloutActive) &&
              (row.servicePortChange === "available" ||
                row.servicePortChange === "update_required") && (
                <Button
                  variant="outline"
                  pending={poolAction === `port:${row.id}`}
                  disabled={
                    !canEdit ||
                    poolAction !== null ||
                    row.servicePortChange !== "available" ||
                    (row.portChange != null && row.portChange.state !== "failed")
                  }
                  onClick={() => setPortChange(row)}
                >
                  {row.servicePortChange === "available" ? "Change port" : "Update the relay first"}
                </Button>
              )}
            {!activeRelayUpdateStep(row, rolloutActive) && (
              <Button
                variant="outline"
                pending={poolAction === `drain:${row.id}`}
                disabled={!canEdit || poolAction !== null}
                onClick={() => void setDrain(row, row.state !== "draining")}
              >
                {row.state === "draining" ? "Resume" : "Drain"}
              </Button>
            )}
            {!activeRelayUpdateStep(row, rolloutActive) &&
              ["draining", "offline", "error"].includes(row.state) &&
              (row.state === "offline" ||
                (metric(row.health?.activeTunnels) === 0 &&
                  (row.retainedAssignments ?? row.activeAssignments) === 0)) && (
                <Button
                  variant="destructive"
                  pending={poolAction === `remove:${row.id}`}
                  disabled={!canEdit || poolAction !== null || relayRemovalWaitNote(row) !== null}
                  onClick={() => void removeRelay(row)}
                >
                  Remove
                </Button>
              )}
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2">
            {/* A Relay Pool update drains the local relay while another relay carries its workloads. */}
            {row.state === "draining" && metric(row.health?.activeTunnels) > 0 && (
              <Button
                variant="destructive"
                pending={poolAction === `disconnect:${row.id}`}
                disabled={!canEdit || poolAction !== null}
                onClick={() => void forceDisconnect(row)}
              >
                Force disconnect
              </Button>
            )}
            <Badge variant="secondary">Local</Badge>
          </div>
        ),
    },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 border border-border bg-card p-3 text-sm">
        <span className="font-medium">Relay Pool</span>
        <Badge
          variant={
            status?.update?.state === "updating"
              ? "warning"
              : healthy
                ? "success"
                : status?.state === "recovering" ||
                    status?.state === "degraded" ||
                    status?.state === "local_relay_restarting"
                  ? "warning"
                  : "destructive"
          }
          title={
            status?.state === "local_relay_restarting"
              ? localRelayOutageDetail(status.localRelayOutage)
              : undefined
          }
        >
          {status?.update?.state === "updating"
            ? `updating to ${status.update.targetVersion}`
            : status?.state === "local_relay_restarting"
              ? localRelayOutageLabel(status.localRelayOutage)
              : (status?.state ?? "unavailable")}
        </Badge>
        <Badge variant="secondary">build {status?.relayBuildVersion ?? "unknown"}</Badge>
        <Badge variant="secondary">protocol v{status?.protocolMajor ?? "-"}</Badge>
        <Badge variant="secondary">
          {readyInstances}/{instances.length} ready
        </Badge>
        <Badge variant={faultDomains > 1 ? "success" : "secondary"}>
          {faultDomains} fault domain{faultDomains === 1 ? "" : "s"}
        </Badge>
        <Badge variant="secondary">
          worst {metric(status?.worstPressurePercent)}%
          {hottestInstance ? ` · ${hottestInstance.displayName}` : ""}
        </Badge>
        <Badge variant={status?.admissionState === "normal" ? "secondary" : "warning"}>
          {admissionLabel(status?.admissionState)}
        </Badge>
      </div>

      <PanelShell
        icon={<Server className="h-4 w-4" />}
        title="Relay instances"
        description="One logical Relay Pool; active assignments use separate physical hosts"
        wrapHeader
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => setEnrollOpen(true)}
              disabled={!canEdit || poolAction !== null}
            >
              <Plus className="h-4 w-4" />
              Add relay node
            </Button>
            <Button
              onClick={() => void rebalance()}
              pending={poolAction === "rebalance"}
              disabled={
                !canEdit ||
                poolAction !== null ||
                !status?.rebalanceAvailable ||
                Boolean(status?.blockers?.length)
              }
            >
              <RefreshCw className="h-4 w-4" />
              Rebalance
            </Button>
          </>
        }
      >
        <SimpleTable
          columns={instanceColumns}
          rows={instances}
          getRowKey={(row) => row.id}
          emptyMessage="No relay instances are registered"
        />
        {status?.rebalanceAvailable &&
          !status?.automaticRebalancePaused &&
          !status?.blockers?.length && (
            <p className="border-t border-border p-3 text-sm text-warning-text">
              Relay capacity or workload spread changed. Automatic rebalance starts after the new
              placement stays stable for 30 seconds. Existing connections drain without
              interruption.
              {status.automaticRebalanceRetryAt &&
                ` Failed attempts wait until ${formatDateTime(status.automaticRebalanceRetryAt)} before automatic retry. You can retry manually now.`}
            </p>
          )}
        {status?.automaticRebalancePaused && (
          <p className="border-t border-border p-3 text-sm text-muted-foreground">
            Automatic rebalance is paused during the Relay Pool update.
          </p>
        )}
        {status?.blockers?.map((blocker) => (
          <p
            key={blocker}
            role="alert"
            className="border-t border-border p-3 text-sm text-destructive"
          >
            {blocker}
          </p>
        ))}
        {status?.warnings?.map((warning) => (
          <p
            key={`${warning.code}:${warning.code === "offline_lease_member" ? warning.relayInstanceId : warning.endpointId}`}
            className="border-t border-border p-3 text-sm text-warning-text"
          >
            {warning.message}
          </p>
        ))}
        {status?.staging && status.staging.length > 0 && (
          <p className="border-t border-border p-3 text-sm text-warning-text">
            Rebalance is verifying {status.staging.length} staged assignment generation
            {status.staging.length === 1 ? "" : "s"} before activation.
          </p>
        )}
        {status?.update && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-3">
            <p className="min-w-0 text-sm text-muted-foreground">
              Pool update to {status.update.targetVersion}: {status.update.state}
              {status.update.error ? ` · ${status.update.error}` : ""}
            </p>
            {canAbandonRelayUpdate && UNFINISHED_RELAY_UPDATE_STATES.has(status.update.state) && (
              <Button
                variant="outline"
                onClick={() => void handleAbandonUpdate()}
                pending={abandoningUpdate}
              >
                <Ban className="h-4 w-4" />
                Abandon update
              </Button>
            )}
          </div>
        )}
      </PanelShell>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-muted-foreground">Tunnel activity</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Active tunnels"
            value={metric(status?.activeTunnels).toLocaleString()}
            icon={Activity}
            history={history.map((sample) => metric(sample.activeTunnels))}
            color="var(--color-hue-blue)"
            subtitle="Current logical streams"
          />
          <StatCard
            label="Route tunnels"
            value={metric(status?.activeProxyTunnels).toLocaleString()}
            icon={Network}
            history={history.map((sample) => metric(sample.activeProxyTunnels))}
            color="var(--color-hue-cyan)"
            subtitle="Secure Link traffic"
          />
          <StatCard
            label="Active DB tunnels"
            value={metric(status?.activeDatabaseTunnels).toLocaleString()}
            icon={Database}
            history={history.map((sample) => metric(sample.activeDatabaseTunnels))}
            color="var(--color-hue-violet)"
            subtitle="Opfield and binding streams"
          />
          <StatCard
            label="Registered endpoints"
            value={metric(status?.registeredEndpoints).toLocaleString()}
            icon={Waypoints}
            history={history.map((sample) => metric(sample.registeredEndpoints))}
            color="var(--color-hue-green)"
            subtitle="Available relay targets"
          />
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-muted-foreground">Relay resources</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Relay CPU"
            value={`${metric(status?.cpuPressurePercent)}%`}
            icon={Cpu}
            history={history.map((sample) => metric(sample.cpuPressurePercent))}
            sparklineMax={100}
            color="var(--color-hue-blue)"
            progress={{ percent: metric(status?.cpuPressurePercent) }}
            subtitle="Relay process across available CPUs"
          />
          <StatCard
            label="Resident memory"
            value={formatBytes(memoryRss)}
            icon={MemoryStick}
            history={history.map((sample) => metric(sample.memoryRssBytes))}
            sparklineMax={memoryLimit || undefined}
            color="var(--color-hue-violet)"
            progress={memoryLimit > 0 ? { percent: percent(memoryRss, memoryLimit) } : undefined}
            subtitle={
              memoryLimit > 0
                ? `${formatBytes(metric(status?.heapInUseBytes))} heap · ${formatBytes(memoryLimit)} limit`
                : `${formatBytes(metric(status?.heapInUseBytes))} heap · no cgroup limit`
            }
          />
          <StatCard
            label="File descriptors"
            value={openFDs.toLocaleString()}
            icon={Server}
            history={history.map((sample) => metric(sample.openFileDescriptors))}
            sparklineMax={fdLimit || undefined}
            color="var(--color-hue-orange)"
            progress={fdLimit > 0 ? { percent: percent(openFDs, fdLimit) } : undefined}
            subtitle={
              fdLimit > 0 ? `of ${fdLimit.toLocaleString()} process limit` : "Limit unavailable"
            }
          />
          <StatCard
            label="Admission pressure"
            value={`${metric(status?.pressurePercent)}%`}
            icon={Gauge}
            history={history.map((sample) => metric(sample.pressurePercent))}
            sparklineMax={100}
            color={pressureColor}
            progress={{ percent: metric(status?.pressurePercent), color: pressureColor }}
            subtitle={admissionLabel(status?.admissionState)}
          />
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-muted-foreground">Admission & runtime</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Route throttled"
            value={metric(status?.throttledProxyTotal).toLocaleString()}
            icon={Ban}
            history={history.map((sample) => metric(sample.throttledProxyTotal))}
            color="var(--color-hue-amber)"
            subtitle="Cumulative rejected proxy streams"
          />
          <StatCard
            label="Database throttled"
            value={metric(status?.throttledDatabaseTotal).toLocaleString()}
            icon={Cable}
            history={history.map((sample) => metric(sample.throttledDatabaseTotal))}
            color="var(--color-hue-red)"
            subtitle="Only at the hard safety cutoff"
          />
          <StatCard
            label="Data lanes"
            value={String(persistedDataLanes)}
            icon={Network}
            color="var(--color-hue-cyan)"
            subtitle="Persistent HTTP/2 lanes per daemon"
          />
          <StatCard
            label="Read buffer"
            value={`${Math.round(persistedReadChunkBytes / 1024)} KiB`}
            icon={Activity}
            color="var(--color-hue-violet)"
            subtitle="Pooled per-stream read chunk"
          />
        </div>
      </div>

      <PanelShell
        icon={<Gauge className="h-4 w-4" />}
        title="Relay runtime"
        description="Persisted Opfield settings distributed to the relay data plane"
        actions={
          <Button onClick={save} pending={saving} disabled={!canEdit || !hasChanges}>
            <Save className="h-4 w-4" />
            Save
          </Button>
        }
        dirty={hasChanges}
      >
        <SettingsControlRow
          title="Data lanes"
          description="Persistent HTTP/2 data-plane connections per daemon (1–16)"
          help="Each lane is a persistent connection from one relay daemon to Opfield. More lanes can increase parallel throughput but consume more connections and memory on both sides."
        >
          <NumericInput
            value={dataLanes}
            onChange={setDataLanes}
            min={1}
            max={16}
            disabled={!canEdit || saving}
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="Read chunk"
          description="Per-tunnel pooled read buffer; protocol frames remain capped at 1 MiB"
          help="Value is bytes per tunnel read buffer, in 4 KiB increments. Raising it increases per-tunnel memory use; it does not raise the 1 MiB protocol-frame limit."
        >
          <NumericInput
            value={readChunkBytes}
            onChange={setReadChunkBytes}
            min={4096}
            max={262144}
            step={4096}
            disabled={!canEdit || saving}
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="Default workload relay spread"
          description="Active relay instances used by new workload connections; apply bulk changes with Rebalance"
          help="Controls how many healthy relay instances receive each new workload assignment. Fixed count limits fan-out; All ready relays maximizes redundancy and connection use."
          controlsClassName="sm:w-96 sm:min-w-96 sm:max-w-96"
        >
          <div className="flex w-full items-center gap-2">
            <Select
              value={assignmentSpreadMode}
              onValueChange={(value) => setAssignmentSpreadMode(value as "fixed" | "all")}
              disabled={!canEdit || saving}
            >
              <SelectTrigger
                className="min-w-0 flex-1"
                aria-label="Default workload relay spread mode"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fixed">Fixed count</SelectItem>
                <SelectItem value="all">All ready relays</SelectItem>
              </SelectContent>
            </Select>
            {assignmentSpreadMode === "fixed" && (
              <NumericInput
                value={assignmentSpreadCount}
                onChange={setAssignmentSpreadCount}
                min={1}
                max={64}
                disabled={!canEdit || saving}
                aria-label="Default workload relay count"
                className="w-24 shrink-0"
              />
            )}
          </div>
        </SettingsControlRow>
        <SettingsControlRow
          title="Adaptive admission"
          description="Throttle new proxy streams only when measured relay pressure rises"
          help="When enabled, Opfield delays or rejects new lower-priority proxy streams as relays approach capacity while preserving room for database traffic."
        >
          <Switch
            checked={adaptiveAdmissionEnabled}
            onChange={setAdaptiveAdmissionEnabled}
            disabled={!canEdit || saving}
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="Route pressure target"
          description="Start fair-share admission for dominant proxy routes at this measured pressure"
          help="Percentage of measured relay pressure where fair-share throttling begins for new streams on dominant proxy routes."
        >
          <NumericInput
            value={proxyTargetPressurePercent}
            onChange={setProxyTargetPressurePercent}
            min={50}
            max={85}
            disabled={!canEdit || saving || !adaptiveAdmissionEnabled}
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="Database reserve"
          description="Capacity kept beyond the proxy target for higher-priority database tunnels"
          help="Additional percentage points reserved above the proxy target for database tunnels. Target plus reserve must remain below the hard cutoff."
        >
          <NumericInput
            value={databaseReservePercent}
            onChange={setDatabaseReservePercent}
            min={5}
            max={35}
            disabled={!canEdit || saving || !adaptiveAdmissionEnabled}
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="Hard pressure cutoff"
          description="Last-resort safety threshold; databases remain admissible until this point"
          help="Percentage of measured pressure where new database tunnels are also rejected. It must exceed the proxy target plus database reserve."
        >
          <NumericInput
            value={hardPressurePercent}
            onChange={setHardPressurePercent}
            min={90}
            max={99}
            disabled={!canEdit || saving || !adaptiveAdmissionEnabled}
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="Grant lifetime"
          description="Lifetime of newly issued endpoint and connection grants, in hours (1–224)"
          help="A grant authorizes a relay endpoint or connection until it expires. Shorter lifetimes rotate authorization sooner; longer lifetimes reduce renewal frequency. A relay pool member that has not upgraded still caps its own grants at 48 hours."
        >
          <NumericInput
            value={grantTtlHours}
            onChange={setGrantTtlHours}
            min={1}
            max={224}
            disabled={!canEdit || saving}
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="Policy lease"
          description="Lifetime of the signed policy Opfield pushes to a relay, in hours (1–168)"
          help="A relay keeps admitting on its last known policy until this lease expires, so it can keep serving through an Opfield outage. A relay pool member that has not upgraded still caps its own lease at 15 minutes."
        >
          <NumericInput
            value={policyLeaseHours}
            onChange={setPolicyLeaseHours}
            min={1}
            max={168}
            disabled={!canEdit || saving}
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="Automatic recovery"
          description="Allow up to three bounded managed relay recovery attempts"
          help="Lets Opfield restart or repair an unhealthy managed relay automatically. Recovery is bounded to three attempts to avoid an endless restart loop."
        >
          <Switch checked={autoRecovery} onChange={setAutoRecovery} disabled={!canEdit || saving} />
        </SettingsControlRow>
      </PanelShell>

      <PanelShell
        icon={<RefreshCw className="h-4 w-4" />}
        title="Rebalance attempts"
        description="Latest 10 attempts, newest first. Failed attempts leave the previous assignments in place."
      >
        <SimpleTable
          rows={(status?.attempts ?? []).slice(0, 10)}
          getRowKey={(row) => row.id}
          emptyMessage="No rebalance attempts recorded"
          columns={[
            {
              id: "time",
              header: "Started",
              render: (row) => <RelativeTime value={row.createdAt} />,
            },
            {
              id: "workload",
              header: "Workload",
              render: (row) => <span title={row.endpointId}>{row.workload}</span>,
            },
            { id: "generation", header: "Generation", render: (row) => row.generation },
            {
              id: "state",
              header: "State",
              render: (row) => (
                <Badge
                  variant={
                    row.state === "failed"
                      ? "destructive"
                      : row.state === "active"
                        ? "success"
                        : row.state === "staging"
                          ? "warning"
                          : "secondary"
                  }
                >
                  {row.state}
                </Badge>
              ),
            },
            {
              id: "reason",
              header: "Details",
              render: (row) =>
                row.activationError ??
                (row.state === "staging"
                  ? "Verifying routes"
                  : row.state === "draining"
                    ? "Existing connections draining"
                    : row.state === "retired"
                      ? "Replaced by a newer assignment"
                      : "Routes verified"),
            },
          ]}
        />
      </PanelShell>

      <OneTimeSecretDialog
        open={reenrollment !== null}
        onOpenChange={(open) => !open && setReenrollment(null)}
        className="sm:max-w-lg"
        title={`Re-enroll ${shownReenrollment?.displayName ?? "Relay"}`}
        description={
          shownReenrollment ? (
            <>
              Run this on the relay host. The installer updates the relay supervisor and enrolls it
              again with the token below; the relay then trusts Opfield's current policy key. The
              token is single-use and expires at{" "}
              {formatDateTime(shownReenrollment.enrollmentTokenExpiresAt)}.
            </>
          ) : null
        }
        fields={
          shownReenrollment
            ? [{ label: "Enrollment token", value: shownReenrollment.enrollmentToken }]
            : null
        }
      >
        {shownReenrollment ? (
          <UnreleasedInstallerNote installerRelease={shownReenrollment.installerRelease} />
        ) : null}
        {shownReenrollment ? (
          <HostAccessInstallOptions value={hostAccess} onChange={setHostAccess} relay />
        ) : null}
        {shownReenrollment?.installCommands.map((command) => {
          const value = withHostAccessInstallFlags(command.curl, hostAccess);
          return (
            <div key={command.target} className="space-y-1.5">
              <CopyCodeBlock
                label={command.label}
                value={value}
                copyValue={value.replace(/\s*\\\n\s*/g, " ")}
              />
              <TokenArgumentInstallCommand
                command={
                  command.tokenArgument
                    ? withHostAccessInstallFlags(command.tokenArgument.curl, hostAccess)
                    : undefined
                }
              />
            </div>
          );
        })}
      </OneTimeSecretDialog>

      <RelayPortDialog
        relay={portChange}
        instances={instances}
        // close-reset-ok: the dialog shows the relay it retains (useRetainedDialogValue) while it closes
        onOpenChange={(open) => !open && setPortChange(null)}
        onSubmit={changePort}
      />

      <NodeEnrollmentDialog
        open={enrollOpen}
        onOpenChange={setEnrollOpen}
        initialType="relay"
        lockType
        onNodeCreated={() => void load()}
        onNodeEnrolled={() => void load()}
      />
    </div>
  );
}
