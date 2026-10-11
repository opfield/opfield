import {
  Activity,
  DatabaseBackup,
  Puzzle,
  ScrollText,
  ShieldCheck,
  Table2,
  Terminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import { IsolatedNotice, useMemberIncidentHold } from "@/components/apps/IsolatedNotice";
import { AvailabilityPanel } from "@/components/availability-sets/AvailabilityPanel";
import { confirm } from "@/components/common/ConfirmDialog";
import { ContentLoading } from "@/components/common/ContentLoading";
import { DetailPageSkeleton } from "@/components/common/DetailPageSkeleton";
import {
  ManagedCertificateNotice,
  useManagedCertificateStatus,
} from "@/components/common/ManagedCertificateStatus";
import { ManagedInstanceNotice } from "@/components/common/ManagedInstanceNotice";
import { PageTransition } from "@/components/common/PageTransition";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { HealthBars } from "@/components/ui/health-bars";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRealtime } from "@/hooks/use-realtime";
import { useStableNavigate } from "@/hooks/use-stable-navigate";
import { useUrlTab } from "@/hooks/use-url-tab";
import { listManagedDatabaseCandidateNodes } from "@/lib/managed-database-nodes";
import { nodeChangesFor } from "@/lib/node-changed";
import { databaseRoute } from "@/lib/resource-routes";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { usePinnedDatabasesStore } from "@/stores/pinned-databases";
import type { DatabaseConnection, DatabaseMetricSnapshot } from "@/types";
import { ClickHouseConfigDialog } from "./database-detail/ClickHouseConfigDialog";
import {
  type BackupSelectionOption,
  backupExecutorOptions,
  DatabaseBackupsTab,
} from "./database-detail/DatabaseBackupsTab";
import { DatabaseConsoleTab } from "./database-detail/DatabaseConsoleTab";
import { DatabaseCredentialsDialog } from "./database-detail/DatabaseCredentialsDialog";
import { DatabaseHeader } from "./database-detail/DatabaseHeader";
import { DatabaseOverviewTab } from "./database-detail/DatabaseOverviewTab";
import { DatabaseSettingsTab } from "./database-detail/DatabaseSettingsTab";
import { DatabaseTlsVerificationNotice } from "./database-detail/DatabaseTlsVerificationNotice";
import {
  appendDatabaseMetricSnapshot,
  hasDatabaseScope,
  isPrivateManagedDatabase,
  readDatabaseMonitoringCache,
  shouldRefreshDatabaseDetailForEvent,
  updateDatabaseMonitoringCache,
} from "./database-detail/database-detail-state";
import { ManagedDatabaseSettingsTab } from "./database-detail/ManagedDatabaseSettingsTab";
import { MoveToValkeyDialog } from "./database-detail/MoveToValkeyDialog";
import { PostgresConfigDialog } from "./database-detail/PostgresConfigDialog";
import {
  PostgresExtensionsTab,
  postgresExtensionsCacheKey,
} from "./database-detail/PostgresExtensionsTab";
import { RedisConfigDialog } from "./database-detail/RedisConfigDialog";
import { ResizeManagedDatabaseDialog } from "./database-detail/ResizeManagedDatabaseDialog";
import { SqlExplorer } from "./database-detail/SqlExplorer";
import { databaseDeleteConfirmation } from "./database-detail/shared";
import { LogsTab, type LogsTabSource } from "./docker-detail/LogsTab";

export function DatabaseDetail(props: Parameters<typeof DatabaseDetailContent>[0] = {}) {
  return (
    <LicenseFeatureBoundary
      feature="external-database-connections"
      capability="Database connections"
    >
      <DatabaseDetailContent {...props} />
    </LicenseFeatureBoundary>
  );
}

function DatabaseDetailContent({
  resolvedDatabaseId,
  resolvedDatabaseSlug,
}: {
  resolvedDatabaseId?: string;
  resolvedDatabaseSlug?: string;
} = {}) {
  const params = useParams<{ id?: string; databaseSlug?: string; tab?: string }>();
  const id = resolvedDatabaseId ?? params.id;
  const routeSlug = resolvedDatabaseSlug ?? params.databaseSlug ?? params.id ?? "";
  const initialMonitoringCache = readDatabaseMonitoringCache(id);
  const navigate = useStableNavigate();
  const { hasScope } = useAuthStore();
  const [database, setDatabase] = useState<DatabaseConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [liveHealthHistory, setLiveHealthHistory] = useState<DatabaseConnection["healthHistory"]>(
    initialMonitoringCache?.healthHistory ?? []
  );
  const [liveHealthStatus, setLiveHealthStatus] = useState<DatabaseConnection["healthStatus"]>(
    initialMonitoringCache?.healthStatus ?? "unknown"
  );
  const [monitoringHistory, setMonitoringHistory] = useState<DatabaseMetricSnapshot[]>(
    initialMonitoringCache?.history ?? []
  );
  const [monitoringLoading, setMonitoringLoading] = useState(
    (initialMonitoringCache?.history.length ?? 0) === 0
  );
  // The database whose stream has delivered its saved history (possibly empty). A reload of
  // the same database must not wait for monitoring again: an empty history is final until
  // the next snapshot.
  const monitoringHistoryReceivedFor = useRef<string | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [privateManagedInfoOpen, setPrivateManagedInfoOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [resizeOpen, setResizeOpen] = useState(false);
  const [clickHouseConfigOpen, setClickHouseConfigOpen] = useState(false);
  const [redisConfigOpen, setRedisConfigOpen] = useState(false);
  const [postgresConfigOpen, setPostgresConfigOpen] = useState(false);
  const [moveToValkeyOpen, setMoveToValkeyOpen] = useState(false);
  const [explorerFocused, setExplorerFocused] = useState(false);
  const [revealedCredentials, setRevealedCredentials] = useState<Record<string, unknown> | null>(
    null
  );
  const [loadingCredentials, setLoadingCredentials] = useState(false);
  const { isPinnedDashboard, isPinnedSidebar, toggleDashboard, toggleSidebar } =
    usePinnedDatabasesStore();
  const loadedDatabaseId = database?.id ?? "";
  const isManagedPaused = database?.managed?.status === "paused";

  const canEdit = hasDatabaseScope(hasScope, "databases:edit", id);
  const canManageSettings = canEdit && (!database?.managed || database.managed.status !== "paused");
  const canResize = canManageSettings && database?.managed?.status === "ready";
  const canPause = canEdit && database?.managed?.status === "ready";
  const canUnpause = canEdit && database?.managed?.status === "paused";
  const canRestart = canEdit && !!database?.managed && database.managed.status !== "paused";
  const canMoveToValkey =
    canManageSettings && database?.type === "redis" && database.managed?.engine === "redis";
  const {
    app: memberApp,
    reload: reloadMemberApp,
    hold: incidentHold,
  } = useMemberIncidentHold(database?.app);
  const storeStoppedReason =
    database?.managed?.status !== "ready" ? "Available when the key-value store is running." : null;
  const moveToValkeyDisabledReason = incidentHold.kept ?? storeStoppedReason;
  const canDelete = hasDatabaseScope(hasScope, "databases:delete", id);
  const canRead = hasDatabaseScope(hasScope, "databases:query:read", id);
  const canWrite = hasDatabaseScope(hasScope, "databases:query:write", id);
  const canAdmin = hasDatabaseScope(hasScope, "databases:query:admin", id);
  const canReveal = hasDatabaseScope(hasScope, "databases:credentials:reveal", id);
  const canViewBackups = hasDatabaseScope(hasScope, "databases:backups:view", id);
  const canManageBackups = hasDatabaseScope(hasScope, "databases:backups:manage", id);
  const canRunBackups = hasDatabaseScope(hasScope, "databases:backups:run", id);
  const canRestoreBackups = hasDatabaseScope(hasScope, "databases:backups:restore", id);
  const [backupDestinations, setBackupDestinations] = useState<BackupSelectionOption[]>([]);
  const [backupExecutors, setBackupExecutors] = useState<BackupSelectionOption[]>([]);
  // The Backups tab names each policy's destination, so its first reveal waits for the options.
  const [backupOptionsLoaded, setBackupOptionsLoaded] = useState(false);
  const canViewMonitoring = hasDatabaseScope(hasScope, "databases:view", id);

  const [activeTab, setActiveTab] = useUrlTab(
    ["overview", "explorer", "console", "logs", "extensions", "backups", "availability"],
    "overview",
    (tab) => databaseRoute(routeSlug, tab)
  );

  useEffect(() => {
    if (activeTab !== "backups" || !canViewBackups) return;
    let current = true;
    void Promise.all([
      api.listObjectStorages({ limit: 200 }),
      listManagedDatabaseCandidateNodes(200),
    ])
      .then(([storage, nodes]) => {
        if (!current) return;
        setBackupDestinations(
          storage.data
            // Same storage check as the backup API: the runner uses the saved credentials
            // (storage:credentials:reveal implies it); no object browser access is needed.
            .filter((item) => hasScope(`storage:credentials:use:${item.id}`))
            .map((item) => ({ id: item.id, label: item.name, provider: item.provider }))
        );
        setBackupExecutors(backupExecutorOptions(nodes, hasScope));
      })
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : "Failed to load backup destinations")
      )
      .finally(() => {
        if (current) setBackupOptionsLoaded(true);
      });
    return () => {
      current = false;
    };
  }, [activeTab, canViewBackups, hasScope]);

  const loadedRouteIdRef = useRef<string | null>(null);
  const load = useCallback(async () => {
    if (!id) return;
    // Refreshing the database that is already on screen must not swap the page
    // for the skeleton: that would unmount the active tab and drop its state.
    if (loadedRouteIdRef.current !== id) setLoading(true);
    try {
      const [database, healthHistory] = await Promise.all([
        api.getDatabase(id),
        api.getDatabaseHealthHistory(id),
      ]);
      loadedRouteIdRef.current = id;
      setDatabase(database);
      setLiveHealthHistory(healthHistory);
      setLiveHealthStatus(database.healthStatus);
      updateDatabaseMonitoringCache(database.id, {
        healthHistory,
        healthStatus: database.healthStatus,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load database");
      navigate("/databases");
    } finally {
      setLoading(false);
    }
  }, [id, navigate]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!loadedDatabaseId) return;
    setRevealedCredentials(null);
    setCredentialsOpen(false);
  }, [loadedDatabaseId]);

  useEffect(() => {
    if (
      ((database && !(database.capabilities?.catalogExplorer ?? database.type !== "redis")) ||
        liveHealthStatus === "offline" ||
        isManagedPaused) &&
      activeTab === "explorer"
    ) {
      setActiveTab("overview");
    }
  }, [activeTab, database, isManagedPaused, liveHealthStatus, setActiveTab]);

  useEffect(() => {
    if ((liveHealthStatus === "offline" || isManagedPaused) && activeTab === "console") {
      setActiveTab("overview");
    }
  }, [activeTab, isManagedPaused, liveHealthStatus, setActiveTab]);

  const managedNodeAvailable = database?.managed?.nodeAvailable !== false;
  const managedNodeId = database?.managed?.nodeId;
  const managedInstanceId = database?.managed?.id;
  const canObserveManagedNode = hasDatabaseScope(hasScope, "nodes:details", managedNodeId);

  useEffect(() => {
    if (activeTab === "logs" && !managedNodeAvailable) setActiveTab("overview");
  }, [activeTab, managedNodeAvailable, setActiveTab]);

  useEffect(() => {
    if (
      !database ||
      database.type !== "postgres" ||
      !database.managed ||
      database.managed.status !== "ready" ||
      !managedNodeAvailable ||
      !(canRead || canWrite || canAdmin)
    ) {
      return;
    }
    const cacheKey = postgresExtensionsCacheKey(database.id);
    if (api.getCached(cacheKey)) return;
    void api
      .listManagedPostgresExtensions(database.id)
      .then((extensions) => api.setCache(cacheKey, extensions))
      .catch(() => undefined);
  }, [canAdmin, canRead, canWrite, database, managedNodeAvailable]);

  useEffect(() => {
    if (
      activeTab === "extensions" &&
      (liveHealthStatus === "offline" || isManagedPaused || !managedNodeAvailable)
    ) {
      setActiveTab("overview");
    }
  }, [activeTab, isManagedPaused, liveHealthStatus, managedNodeAvailable, setActiveTab]);

  useRealtime(canObserveManagedNode ? "node.changed" : null, (payload) => {
    const event = managedNodeId
      ? nodeChangesFor(payload, managedNodeId)
          .filter((change) => change.status)
          .at(-1)
      : undefined;
    if (!event?.status) return;
    setDatabase((current) =>
      current?.managed
        ? {
            ...current,
            managed: { ...current.managed, nodeAvailable: event.status === "online" },
          }
        : current
    );
  });

  useEffect(() => {
    if (!id || !managedInstanceId) return;
    let cancelled = false;
    const refreshAvailability = () => {
      void api
        .getDatabase(id)
        .then((next) => {
          if (cancelled) return;
          setDatabase((current) => {
            if (!current?.managed || !next.managed) return current;
            if (current.managed.nodeAvailable === next.managed.nodeAvailable) return current;
            return {
              ...current,
              managed: { ...current.managed, nodeAvailable: next.managed.nodeAvailable },
            };
          });
        })
        .catch(() => undefined);
    };
    refreshAvailability();
    const interval = setInterval(refreshAvailability, 5_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [id, managedInstanceId]);

  useEffect(() => {
    if (
      activeTab !== "explorer" ||
      (database && !(database.capabilities?.catalogExplorer ?? database.type !== "redis"))
    ) {
      setExplorerFocused(false);
    }
  }, [activeTab, database]);

  useEffect(() => {
    if (!database) return;
    // Health status and history are owned by load() and the monitoring stream.
    // Resetting them here used to wipe the history load() had just fetched, and
    // an offline database never gets it back from the stream.
    const cached = readDatabaseMonitoringCache(database.id);
    setMonitoringHistory(cached?.history ?? []);
    setMonitoringLoading(
      canViewMonitoring &&
        database.healthStatus !== "offline" &&
        database.managed?.status !== "paused" &&
        (cached?.history.length ?? 0) === 0 &&
        monitoringHistoryReceivedFor.current !== database.id
    );
  }, [canViewMonitoring, database]);

  // The stream is keyed by the route id, not by the loaded database object: it
  // opens alongside load() so the saved metric history is already there when the
  // page renders, and a reload of the same database does not reconnect it.
  useEffect(() => {
    if (!id || !canViewMonitoring || isManagedPaused) {
      setMonitoringLoading(false);
      return;
    }
    const es = api.createDatabaseMonitoringStream(id);
    es.addEventListener("connected", (event: MessageEvent) => {
      const message = JSON.parse(event.data) as {
        healthHistory?: DatabaseConnection["healthHistory"];
        healthStatus?: DatabaseConnection["healthStatus"];
      };
      if (message.healthHistory) setLiveHealthHistory(message.healthHistory);
      if (message.healthStatus) setLiveHealthStatus(message.healthStatus);
      updateDatabaseMonitoringCache(id, {
        ...(message.healthHistory ? { healthHistory: message.healthHistory } : {}),
        ...(message.healthStatus ? { healthStatus: message.healthStatus } : {}),
      });
    });
    es.addEventListener("history", (event: MessageEvent) => {
      const message = JSON.parse(event.data);
      const history = message.history ?? [];
      monitoringHistoryReceivedFor.current = id;
      setMonitoringHistory(history);
      updateDatabaseMonitoringCache(id, { history });
      setMonitoringLoading(false);
    });
    es.addEventListener("snapshot", (event: MessageEvent) => {
      const snapshot = JSON.parse(event.data) as DatabaseMetricSnapshot;
      setMonitoringHistory((previous) => {
        const history = appendDatabaseMetricSnapshot(previous, snapshot);
        updateDatabaseMonitoringCache(id, { history, healthStatus: snapshot.status });
        return history;
      });
      setLiveHealthStatus(snapshot.status);
      setMonitoringLoading(false);
    });
    es.onerror = () => {
      monitoringHistoryReceivedFor.current = id;
      setMonitoringLoading(false);
    };
    return () => es.close();
  }, [canViewMonitoring, id, isManagedPaused]);

  useRealtime(id ? "database.changed" : null, (payload) => {
    const event = payload as {
      id?: string;
      action?: string;
      healthStatus?: DatabaseConnection["healthStatus"];
      sampledAt?: string;
      oldSlug?: string;
      slug?: string;
    };
    if (!event || event.id !== id) return;
    if (event.oldSlug === routeSlug && event.slug) {
      navigate(databaseRoute(event.slug, activeTab), { replace: true });
      return;
    }
    if (event.action === "deleted") {
      navigate("/databases");
      return;
    }
    if (event.action === "health.sampled") {
      if (event.healthStatus) setLiveHealthStatus(event.healthStatus);
      if (event.sampledAt && event.healthStatus) {
        setLiveHealthHistory((prev) => [
          ...(prev ?? []),
          { ts: event.sampledAt!, status: event.healthStatus! },
        ]);
      }
      return;
    }
    if (
      event.action === "health.online" ||
      event.action === "health.degraded" ||
      event.action === "health.offline"
    ) {
      if (event.healthStatus) setLiveHealthStatus(event.healthStatus);
      return;
    }
    if (!shouldRefreshDatabaseDetailForEvent(event.action)) return;
    void load();
  });

  const managedLogSource = useMemo<LogsTabSource | null>(() => {
    if (!database?.managed) return null;
    const staticState =
      database.managed.status === "paused" || database.managed.status === "stopped";
    return {
      channelId: `database:${database.id}`,
      title: "Database Logs",
      description: staticState
        ? `Database is ${database.managed.status} — showing last logs`
        : "stdout and stderr output from the database container",
      state: staticState ? database.managed.status : "running",
      downloadFileName: `${database.slug}-logs.txt`,
      createWebSocket: (tail) => api.createManagedDatabaseLogStreamWebSocket(database.id, tail),
      getLogs: (params) => api.getManagedDatabaseLogs(database.id, params),
    };
  }, [database]);

  const remove = async () => {
    if (!id || !database) return;
    const deletion = databaseDeleteConfirmation(database);
    const ok = await confirm({
      title: deletion.title,
      description: deletion.description,
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await api.deleteDatabase(id);
      usePinnedDatabasesStore.getState().removePin(id);
      toast.success(deletion.successMessage);
      navigate("/databases");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete database");
    }
  };

  const testConnection = async () => {
    if (!canEdit || !database) return;
    try {
      const result = await api.testDatabase(database.id);
      toast.success(`Connection OK in ${result.responseMs} ms`);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Connection test failed");
    }
  };

  const revealCredentials = async () => {
    if (!database || !canReveal) return;
    if (isPrivateManagedDatabase(database)) {
      setPrivateManagedInfoOpen(true);
      return;
    }
    setCredentialsOpen(true);
    if (revealedCredentials) return;
    setLoadingCredentials(true);
    try {
      setRevealedCredentials(
        database.managed
          ? await api.revealManagedDatabaseCredentials(database.managed.id)
          : await api.revealDatabaseCredentials(database.id)
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to reveal credentials");
    } finally {
      setLoadingCredentials(false);
    }
  };

  const rotateDirectCredentials = async () => {
    if (!database?.managed || !canEdit || database.managed.publishedPort == null) return;
    const ok = await confirm({
      title: "Rotate Direct-Access Credentials",
      description:
        "Existing direct TCP clients will stop authenticating. Secure database links are not affected.",
      confirmLabel: "Rotate credentials",
      variant: "destructive",
    });
    if (!ok) return;
    setLoadingCredentials(true);
    try {
      const credentials = await api.rotateManagedDatabaseDirectCredentials(database.managed.id);
      setRevealedCredentials(credentials);
      setCredentialsOpen(true);
      toast.success("Direct-access credentials rotated");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to rotate direct-access credentials"
      );
    } finally {
      setLoadingCredentials(false);
    }
  };

  const managedDatabaseId = database?.managed?.id;
  const loadManagedCertificate = useCallback(
    () =>
      managedDatabaseId
        ? api.getManagedDatabaseCertificate(managedDatabaseId)
        : Promise.reject(new Error("Not a managed database")),
    [managedDatabaseId]
  );
  const managedCertificate = useManagedCertificateStatus(loadManagedCertificate, {
    enabled: !!managedDatabaseId && !!database?.managed?.tlsEnabled,
    refreshKey: `${database?.updatedAt}:${database?.managed?.status}`,
  });
  const canRotateCertificate =
    !!database?.managed && canManageSettings && database.managed.publishedPort != null;

  /** Resolves to whether a rotation was requested (for the certificate notice). */
  const rotateCertificate = async () => {
    if (!database?.managed || !canRotateCertificate) return false;
    const ok = await confirm({
      title: "Rotate TLS Certificate",
      description:
        "Gateway will issue a replacement certificate for this database node's current IP addresses. The running database reloads it without a restart (older node daemons recreate the database). Direct clients must continue trusting the same Gateway Database CA.",
      confirmLabel: "Rotate certificate",
    });
    if (!ok) return false;
    try {
      const result = await api.rotateManagedDatabaseCertificate(database.managed.id);
      toast.success(
        result.certificateRenewal && !result.certificateRenewal.restarted
          ? "TLS certificate rotated without a restart"
          : "TLS certificate rotated"
      );
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to rotate TLS certificate");
    }
    return true;
  };

  const pause = async () => {
    if (!database?.managed || !canPause) return;
    const ok = await confirm({
      title: "Pause Database",
      description:
        "This pauses the database container and disconnects active clients. Health checks, metrics, Explorer, and Console will be disabled until you unpause it.",
      confirmLabel: "Pause database",
      variant: "default",
    });
    if (!ok) return;
    try {
      await api.pauseManagedDatabase(database.managed.id);
      toast.success("Database paused");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to pause database");
    }
  };

  const unpause = async () => {
    if (!database?.managed || !canUnpause) return;
    try {
      await api.unpauseManagedDatabase(database.managed.id);
      toast.success("Database unpaused");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to unpause database");
    }
  };

  const restart = async () => {
    if (!database?.managed || !canRestart) return;
    try {
      await api.restartManagedDatabase(database.managed.id);
      toast.success("Database restart requested");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to restart database");
    }
  };

  if (loading) return <DetailPageSkeleton label="Loading database" tabs={5} />;
  if (!database)
    return (
      <PageTransition>
        <div className="flex h-full items-center justify-center text-muted-foreground">
          Database not found
        </div>
      </PageTransition>
    );

  const isFullHeightTab =
    activeTab === "explorer" ||
    activeTab === "console" ||
    activeTab === "logs" ||
    activeTab === "extensions";
  const supportsExplorer = database.capabilities?.catalogExplorer ?? database.type !== "redis";
  const supportsConsole =
    (database.capabilities?.sqlConsole ?? database.type !== "redis") ||
    (database.capabilities?.commandConsole ?? database.type === "redis");
  const supportsExtensions = database.type === "postgres" && !!database.managed;
  const hideDatabaseChrome = explorerFocused && activeTab === "explorer" && supportsExplorer;
  const displayHealthStatus = isManagedPaused ? "paused" : liveHealthStatus;
  const consoleDisabled = liveHealthStatus === "offline" || isManagedPaused;
  const explorerDisabled = liveHealthStatus === "offline" || isManagedPaused;
  const extensionsDisabled =
    liveHealthStatus === "offline" || isManagedPaused || !managedNodeAvailable;

  return (
    <PageTransition>
      <div
        className={cn(
          hideDatabaseChrome
            ? "h-full flex flex-col overflow-hidden gap-0 p-0"
            : isFullHeightTab
              ? "h-full flex flex-col overflow-hidden gap-4 p-6"
              : "h-full overflow-y-auto p-6 space-y-4"
        )}
      >
        {!hideDatabaseChrome && (
          <>
            <DatabaseHeader
              database={database}
              healthStatus={displayHealthStatus}
              canEdit={canManageSettings}
              canResize={canResize}
              canPause={canPause}
              canUnpause={canUnpause}
              canRestart={canRestart}
              canConfigureClickHouse={
                canManageSettings && database.type === "clickhouse" && !!database.managed
              }
              canConfigureRedis={
                canManageSettings && database.type === "redis" && !!database.managed
              }
              canConfigurePostgres={
                canManageSettings && database.type === "postgres" && !!database.managed
              }
              canMoveToValkey={canMoveToValkey}
              moveToValkeyDisabledReason={moveToValkeyDisabledReason}
              canReveal={canReveal}
              canRotateDirectCredentials={
                canManageSettings && database.managed?.publishedPort != null
              }
              canRotateCertificate={canManageSettings && database.managed?.publishedPort != null}
              canDelete={canDelete}
              removeDisabledReason={incidentHold.kept}
              onOpenPin={() => setPinOpen(true)}
              onBack={() => navigate("/databases")}
              onTest={() => void testConnection()}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenResize={() => setResizeOpen(true)}
              onPause={() => void pause()}
              onUnpause={() => void unpause()}
              onRestart={() => void restart()}
              onConfigureClickHouse={() => setClickHouseConfigOpen(true)}
              onConfigureRedis={() => setRedisConfigOpen(true)}
              onConfigurePostgres={() => setPostgresConfigOpen(true)}
              onMoveToValkey={() => setMoveToValkeyOpen(true)}
              onRevealCredentials={() => void revealCredentials()}
              onRotateDirectCredentials={() => void rotateDirectCredentials()}
              onRotateCertificate={() => void rotateCertificate()}
              onRemove={() => void remove()}
            />
            {database.app && memberApp && (
              <IsolatedNotice
                app={memberApp}
                environmentIds={[database.app.environmentId]}
                onChanged={reloadMemberApp}
              />
            )}

            <ManagedInstanceNotice managed={database.managed} />

            <DatabaseTlsVerificationNotice
              database={database}
              canEdit={canManageSettings}
              onOpenSettings={() => setSettingsOpen(true)}
              onVerified={(updated) => {
                setDatabase(updated);
                void load();
              }}
            />

            {/* The certificate detail row and any warning wait for the first status. */}
            <ContentLoading loading={managedCertificate.loading} />
            <ManagedCertificateNotice
              status={managedCertificate.status}
              onRenew={canRotateCertificate ? rotateCertificate : undefined}
              onRenewed={managedCertificate.refresh}
              renewLabel="Rotate now"
            />

            {!isManagedPaused && (
              <HealthBars history={liveHealthHistory} currentStatus={liveHealthStatus} />
            )}
          </>
        )}

        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className={cn("flex flex-col", isFullHeightTab && "flex-1 min-h-0")}
        >
          {!hideDatabaseChrome && (
            <TabsList className="shrink-0">
              <TabsTrigger value="overview" className="gap-1.5">
                <Activity className="h-3.5 w-3.5" />
                Overview
              </TabsTrigger>
              {canRead && supportsExplorer && (
                <TabsTrigger value="explorer" disabled={explorerDisabled} className="gap-1.5">
                  <Table2 className="h-3.5 w-3.5" />
                  Explorer
                </TabsTrigger>
              )}
              {(canRead || canWrite || canAdmin) && supportsConsole && (
                <TabsTrigger value="console" disabled={consoleDisabled} className="gap-1.5">
                  <Terminal className="h-3.5 w-3.5" />
                  Console
                </TabsTrigger>
              )}
              {(canRead || canWrite || canAdmin) && supportsExtensions && (
                <TabsTrigger value="extensions" disabled={extensionsDisabled} className="gap-1.5">
                  <Puzzle className="h-3.5 w-3.5" />
                  Extensions
                </TabsTrigger>
              )}
              {canViewBackups && (
                <TabsTrigger value="backups" className="gap-1.5">
                  <DatabaseBackup className="h-3.5 w-3.5" />
                  Backups
                </TabsTrigger>
              )}
              {database.managed && canViewMonitoring && (
                <TabsTrigger value="logs" disabled={!managedNodeAvailable} className="gap-1.5">
                  <ScrollText className="h-3.5 w-3.5" />
                  Logs
                </TabsTrigger>
              )}
              {database.managed && canViewMonitoring && (
                <TabsTrigger value="availability" className="gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Availability
                </TabsTrigger>
              )}
            </TabsList>
          )}

          {database.managed && canViewMonitoring && (
            <TabsContent value="availability" className="space-y-4">
              <AvailabilityPanel
                owner={{ kind: "database", id: database.managed.id }}
                engine={database.type}
                resourceName={database.name}
                originNodeId={database.managed.nodeId}
                canManage={canEdit}
                onChanged={() => void load()}
              />
            </TabsContent>
          )}

          {canViewBackups && (
            <TabsContent value="backups">
              <DatabaseBackupsTab
                database={database}
                destinations={backupDestinations}
                executors={backupExecutors}
                optionsLoading={!backupOptionsLoaded}
                canManage={canManageBackups}
                canRun={canRunBackups}
                canRestore={canRestoreBackups}
              />
            </TabsContent>
          )}
          <TabsContent value="overview" className="space-y-4">
            <DatabaseOverviewTab
              database={database}
              certificateStatus={managedCertificate.status}
              canViewMonitoring={canViewMonitoring}
              healthStatus={displayHealthStatus}
              history={monitoringHistory}
              monitoringLoading={monitoringLoading}
            />
          </TabsContent>

          {canRead && supportsExplorer && (
            <TabsContent
              value="explorer"
              className={cn("flex flex-col flex-1 min-h-0", hideDatabaseChrome && "mt-0")}
            >
              {(database.type === "postgres" || database.type === "clickhouse") &&
              !explorerDisabled ? (
                <SqlExplorer
                  database={database}
                  canWrite={canWrite || canAdmin}
                  canAdmin={canAdmin}
                  focused={explorerFocused}
                  onToggleFocus={() => setExplorerFocused((current) => !current)}
                />
              ) : explorerDisabled ? (
                <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                  Explorer is unavailable while the database is offline or paused.
                </div>
              ) : (
                <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                  Explorer is not available for this database provider.
                </div>
              )}
            </TabsContent>
          )}

          {(canRead || canWrite || canAdmin) && supportsConsole && !consoleDisabled && (
            <TabsContent
              value="console"
              className="space-y-4 flex flex-col flex-1 min-h-0 overflow-hidden"
            >
              <DatabaseConsoleTab database={database} />
            </TabsContent>
          )}

          {(canRead || canWrite || canAdmin) && supportsExtensions && !extensionsDisabled && (
            <TabsContent value="extensions" className="flex flex-1 min-h-0 overflow-hidden">
              <PostgresExtensionsTab database={database} canManage={canAdmin} />
            </TabsContent>
          )}

          {managedLogSource && canViewMonitoring && managedNodeAvailable && (
            <TabsContent value="logs" className="flex flex-1 min-h-0 overflow-hidden">
              <LogsTab source={managedLogSource} />
            </TabsContent>
          )}
        </Tabs>
      </div>

      <DatabaseCredentialsDialog
        database={database}
        credentials={revealedCredentials}
        loading={loadingCredentials}
        open={credentialsOpen}
        onOpenChange={setCredentialsOpen}
      />

      <Dialog open={privateManagedInfoOpen} onOpenChange={setPrivateManagedInfoOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Private Managed Database</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              This database has no published network interface. It currently accepts connections
              only through a secure managed database link.
            </p>
            <p>Publish a TCP port in Database Settings to enable direct connections.</p>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={pinOpen} onOpenChange={setPinOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Pin Database</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Add to dashboard</p>
                <p className="text-xs text-muted-foreground">
                  Show a compact health card on the dashboard
                </p>
              </div>
              <Switch
                checked={isPinnedDashboard(database.id)}
                onChange={() => {
                  toggleDashboard(database.id, {
                    slug: database.slug,
                    name: database.name,
                    type: database.type,
                    healthStatus: liveHealthStatus,
                  });
                  usePinnedDatabasesStore.getState().invalidate();
                }}
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Add to sidebar</p>
                <p className="text-xs text-muted-foreground">Quick access link in the sidebar</p>
              </div>
              <Switch
                checked={isPinnedSidebar(database.id)}
                onChange={() => {
                  toggleSidebar(database.id, {
                    slug: database.slug,
                    name: database.name,
                    type: database.type,
                    healthStatus: liveHealthStatus,
                  });
                  usePinnedDatabasesStore.getState().invalidate();
                }}
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {canEdit && (
        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Database Settings</DialogTitle>
            </DialogHeader>
            {database.managed ? (
              <ManagedDatabaseSettingsTab
                database={database}
                onSaved={() => {
                  setSettingsOpen(false);
                  void load();
                }}
              />
            ) : (
              <DatabaseSettingsTab
                database={database}
                onSaved={(updated) => {
                  setSettingsOpen(false);
                  setDatabase(updated);
                  if (updated.slug !== routeSlug) {
                    navigate(databaseRoute(updated.slug, activeTab), { replace: true });
                  } else {
                    void load();
                  }
                }}
              />
            )}
          </DialogContent>
        </Dialog>
      )}

      {canResize && (
        <ResizeManagedDatabaseDialog
          database={database}
          open={resizeOpen}
          onOpenChange={setResizeOpen}
          onResized={() => void load()}
        />
      )}

      {canManageSettings && database.type === "clickhouse" && database.managed && (
        <ClickHouseConfigDialog
          database={database}
          open={clickHouseConfigOpen}
          onOpenChange={setClickHouseConfigOpen}
          onSaved={() => void load()}
        />
      )}

      {canMoveToValkey && database.managed && (
        <MoveToValkeyDialog
          open={moveToValkeyOpen}
          managedDatabaseId={database.managed.id}
          onOpenChange={setMoveToValkeyOpen}
          onMoved={() => void load()}
        />
      )}

      {canManageSettings && database.type === "redis" && database.managed && (
        <RedisConfigDialog
          database={database}
          open={redisConfigOpen}
          onOpenChange={setRedisConfigOpen}
          onSaved={() => void load()}
        />
      )}

      {canManageSettings && database.type === "postgres" && database.managed && (
        <PostgresConfigDialog
          database={database}
          open={postgresConfigOpen}
          onOpenChange={setPostgresConfigOpen}
          onSaved={() => void load()}
        />
      )}
    </PageTransition>
  );
}

import { LicenseFeatureBoundary } from "@/components/license/LicenseFeatureBoundary";
