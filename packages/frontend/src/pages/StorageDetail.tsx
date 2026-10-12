import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import { MemberIsolatedNotice, useMemberIncidentHold } from "@/components/apps/IsolatedNotice";
import { AvailabilityPanel } from "@/components/availability-sets/AvailabilityPanel";
import { confirm } from "@/components/common/ConfirmDialog";
import { DetailPageSkeleton } from "@/components/common/DetailPageSkeleton";
import {
  ManagedCertificateNotice,
  useManagedCertificateStatus,
} from "@/components/common/ManagedCertificateStatus";
import { ManagedInstanceNotice } from "@/components/common/ManagedInstanceNotice";
import { PageTransition } from "@/components/common/PageTransition";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HealthBars } from "@/components/ui/health-bars";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRealtime } from "@/hooks/use-realtime";
import { useStableNavigate } from "@/hooks/use-stable-navigate";
import { useUrlTab } from "@/hooks/use-url-tab";
import { toastApiError } from "@/lib/api-error-toast";
import { storageRoute } from "@/lib/resource-routes";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import type { StorageDeleteOptions } from "@/services/api-object-storage";
import { useAuthStore } from "@/stores/auth";
import { usePinnedStorageStore } from "@/stores/pinned-storage";
import type { ObjectStorageConnection, ObjectStorageMetricSnapshot } from "@/types";
import { ManagedObjectStorageSettingsTab } from "./storage-detail/ManagedObjectStorageSettingsTab";
import { ManagedStorageFullNotice } from "./storage-detail/ManagedStorageFullNotice";
import { ManagedStorageLegacyEngineBanner } from "./storage-detail/ManagedStorageLegacyEngineBanner";
import {
  managedStorageEngine,
  managedStorageErrorMessage,
} from "./storage-detail/managed-storage-engine";
import { ObjectBrowser } from "./storage-detail/ObjectBrowser";
import { StorageCredentialsDialog } from "./storage-detail/StorageCredentialsDialog";
import { StorageHeader } from "./storage-detail/StorageHeader";
import { StorageIamKeysTab } from "./storage-detail/StorageIamKeysTab";
import { StorageOverviewTab } from "./storage-detail/StorageOverviewTab";
import { StorageSettingsTab } from "./storage-detail/StorageSettingsTab";

export function StorageDetail(props: Parameters<typeof StorageDetailContent>[0] = {}) {
  return (
    <LicenseFeatureBoundary
      feature="storage-connections"
      capability="Storage connections"
      frame={{ kind: "page", title: "Storage" }}
    >
      <StorageDetailContent {...props} />
    </LicenseFeatureBoundary>
  );
}

function StorageDetailContent({
  resolvedStorageId,
  resolvedStorageSlug,
}: {
  resolvedStorageId?: string;
  resolvedStorageSlug?: string;
} = {}) {
  const params = useParams<{ id?: string; storageSlug?: string; tab?: string }>();
  const id = resolvedStorageId ?? params.id;
  const routeSlug = resolvedStorageSlug ?? params.storageSlug ?? params.id ?? "";
  const navigate = useStableNavigate();
  const { hasScope } = useAuthStore();
  const [storage, setStorage] = useState<ObjectStorageConnection | null>(null);
  // The open incident of the storage's app environment refuses removing it.
  const {
    app: memberApp,
    reload: reloadMemberApp,
    hold: incidentHold,
  } = useMemberIncidentHold(storage?.app);
  const loadGeneration = useRef(0);
  const loadedStorageId = storage && storage.id === id ? storage.id : null;
  const [loading, setLoading] = useState(true);
  const [liveHealthHistory, setLiveHealthHistory] = useState<
    ObjectStorageConnection["healthHistory"]
  >([]);
  const [liveHealthStatus, setLiveHealthStatus] =
    useState<ObjectStorageConnection["healthStatus"]>("unknown");
  const [monitoringHistory, setMonitoringHistory] = useState<ObjectStorageMetricSnapshot[]>([]);
  // The storage whose monitoring stream has delivered its history (or failed).
  const [monitoringSettledFor, setMonitoringSettledFor] = useState<string | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [managedCredentialsOpen, setManagedCredentialsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [revealedCredentials, setRevealedCredentials] = useState<Record<string, unknown> | null>(
    null
  );
  const [loadingCredentials, setLoadingCredentials] = useState(false);
  const { isPinnedSidebar, toggleSidebar } = usePinnedStorageStore();

  const canEdit = !!(id && (hasScope("storage:edit") || hasScope(`storage:edit:${id}`)));
  const canDelete = !!(id && (hasScope("storage:delete") || hasScope(`storage:delete:${id}`)));
  const canRestart = canEdit && !!storage?.managed;
  const canRetry = canEdit && storage?.managed?.status === "error";
  const canRead = !!(
    id &&
    (hasScope("storage:objects:read") || hasScope(`storage:objects:read:${id}`))
  );
  const canWrite = !!(
    id &&
    (hasScope("storage:objects:write") || hasScope(`storage:objects:write:${id}`))
  );
  // Bucket create/delete is storage:objects:admin in the API, not object write.
  const canAdminBuckets = !!(
    id &&
    (hasScope("storage:objects:admin") || hasScope(`storage:objects:admin:${id}`))
  );
  const canReveal = !!(
    id &&
    (hasScope("storage:credentials:reveal") || hasScope(`storage:credentials:reveal:${id}`))
  );
  const canViewMonitoring = !!(id && (hasScope("storage:view") || hasScope(`storage:view:${id}`)));
  const availabilityTabVisible = useAvailabilityTabVisible(
    storage?.managed ? { kind: "storage", id: storage.managed.id } : null
  );
  const canManageIam = !!(id && (hasScope("storage:iam") || hasScope(`storage:iam:${id}`)));
  const monitoringLoading =
    canViewMonitoring && !!loadedStorageId && monitoringSettledFor !== loadedStorageId;

  const [activeTab, setActiveTab] = useUrlTab(
    ["overview", "browser", "iam-keys", "availability"],
    "overview",
    (tab) => storageRoute(routeSlug, tab)
  );

  const loadedRouteIdRef = useRef<string | null>(null);
  const load = useCallback(async () => {
    if (!id) return;
    const generation = ++loadGeneration.current;
    // Refreshing the storage already on screen keeps the page and its active tab.
    if (loadedRouteIdRef.current !== id) setLoading(true);
    try {
      const [storage, healthHistory] = await Promise.all([
        api.getObjectStorage(id),
        api.getObjectStorageHealthHistory(id),
      ]);
      if (generation !== loadGeneration.current) return;
      loadedRouteIdRef.current = id;
      setStorage(storage);
      setLiveHealthHistory(healthHistory);
      setLiveHealthStatus(storage.healthStatus);
    } catch (error) {
      if (generation !== loadGeneration.current) return;
      toastApiError(error, "Failed to load storage");
      navigate("/storage");
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [id, navigate]);

  useEffect(() => {
    void load();
    return () => {
      loadGeneration.current++;
    };
  }, [load]);

  useEffect(() => {
    if (liveHealthStatus === "offline" && activeTab === "browser") {
      setActiveTab("overview");
    }
  }, [activeTab, liveHealthStatus, setActiveTab]);

  useEffect(() => {
    setMonitoringHistory([]);
    if (!loadedStorageId || !canViewMonitoring) return;
    let current = true;
    const es = api.createObjectStorageMonitoringStream(loadedStorageId);
    es.addEventListener("connected", (event: MessageEvent) => {
      if (!current) return;
      const message = JSON.parse(event.data);
      if (message.healthHistory) setLiveHealthHistory(message.healthHistory);
      if (message.healthStatus) setLiveHealthStatus(message.healthStatus);
    });
    es.addEventListener("history", (event: MessageEvent) => {
      if (!current) return;
      const message = JSON.parse(event.data);
      setMonitoringHistory(message.history ?? []);
      setMonitoringSettledFor(loadedStorageId);
    });
    es.addEventListener("snapshot", (event: MessageEvent) => {
      if (!current) return;
      const snapshot = JSON.parse(event.data) as ObjectStorageMetricSnapshot;
      setMonitoringHistory((prev) => [...prev, snapshot].slice(-60));
      setLiveHealthStatus(snapshot.status);
      setMonitoringSettledFor(loadedStorageId);
    });
    es.onerror = () => {
      if (current) setMonitoringSettledFor(loadedStorageId);
    };
    return () => {
      current = false;
      es.close();
    };
  }, [canViewMonitoring, loadedStorageId]);

  useRealtime(id ? "storage.changed" : null, (payload) => {
    const event = payload as {
      id?: string;
      action?: string;
      healthStatus?: ObjectStorageConnection["healthStatus"];
      sampledAt?: string;
      oldSlug?: string;
      slug?: string;
    };
    if (!event || event.id !== id) return;
    if (event.oldSlug === routeSlug && event.slug) {
      navigate(storageRoute(event.slug, activeTab), { replace: true });
      return;
    }
    if (event.action === "deleted") {
      navigate("/storage");
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
    void load();
  });

  const remove = async () => {
    if (!id || !storage) return;
    const ok = await confirm({
      title: "Delete Storage",
      description: `Delete saved connection "${storage.name}"?`,
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    const managedId = storage.managed?.id;
    const deleteStorage = (options?: StorageDeleteOptions) =>
      managedId
        ? api.deleteManagedObjectStorage(managedId, options)
        : api.deleteObjectStorage(id, options);
    try {
      try {
        await deleteStorage();
      } catch (error) {
        const history = backupHistoryReference(error);
        if (!history) throw error;
        // Finished backup history only goes away with an explicit second confirmation.
        const forget = await confirm({
          title: "Forget Backup History?",
          description: forgetBackupHistoryDescription(history, Boolean(managedId)),
          confirmLabel: "Forget history and delete",
          cancelLabel: "Keep storage",
          variant: "destructive",
        });
        if (!forget) return;
        await deleteStorage({ backupHistory: "forget" });
      }
      usePinnedStorageStore.getState().removePin(id);
      toast.success("Storage deleted");
      navigate("/storage");
    } catch (error) {
      toastApiError(error, "Failed to delete storage");
    }
  };

  const restart = async () => {
    if (!storage?.managed || !canRestart) return;
    try {
      await api.restartManagedObjectStorage(storage.managed.id);
      toast.success("Storage restart requested");
      await load();
    } catch (error) {
      toast.error(managedStorageErrorMessage(error, "Failed to restart storage"));
    }
  };

  const managedId = storage?.managed?.id;
  const loadManagedCertificate = useCallback(
    () =>
      managedId
        ? api.getManagedObjectStorageCertificate(managedId)
        : Promise.reject(new Error("Not managed storage")),
    [managedId]
  );
  const managedCertificate = useManagedCertificateStatus(loadManagedCertificate, {
    enabled: !!managedId,
    refreshKey: storage?.updatedAt,
  });

  const renewManagedCertificate = async () => {
    if (!managedId || !canEdit) return false;
    const ok = await confirm({
      title: "Renew TLS Certificate",
      description:
        "Opfield issues a new certificate from the Storage CA and the running storage loads it without a restart. S3 clients keep trusting the same Storage CA.",
      confirmLabel: "Renew certificate",
      variant: "default",
    });
    if (!ok) return false;
    try {
      const { outcome } = await api.renewManagedObjectStorageCertificate(managedId);
      toast.success(
        outcome.status === "awaiting_reload"
          ? "Certificate delivered; the storage loads it on its own schedule"
          : outcome.restarted
            ? "Certificate renewed (the storage was restarted)"
            : "Certificate renewed without a restart"
      );
      return true;
    } catch (error) {
      toast.error(managedStorageErrorMessage(error, "Failed to renew the certificate"));
      return true;
    }
  };

  const retryProvisioning = async () => {
    if (!storage?.managed || !canRetry) return;
    try {
      await api.retryManagedObjectStorageProvisioning(storage.managed.id);
      toast.success("Storage provisioning retry requested");
      await load();
    } catch (error) {
      toast.error(managedStorageErrorMessage(error, "Failed to retry provisioning"));
    }
  };

  const testConnection = async () => {
    if (!canEdit || !storage) return;
    try {
      const result = await api.testObjectStorage(storage.id);
      if (result.ok) {
        toast.success(`Connection OK in ${result.responseMs} ms`);
      } else {
        toast.error(`Connection failed: ${result.status}`);
      }
      await load();
    } catch (error) {
      toastApiError(error, "Connection test failed");
    }
  };

  const revealCredentials = async () => {
    if (!storage || !canReveal) return;
    if (storage.managed) {
      setManagedCredentialsOpen(true);
      return;
    }
    setCredentialsOpen(true);
    if (revealedCredentials) return;
    setLoadingCredentials(true);
    try {
      setRevealedCredentials(
        (await api.revealObjectStorageCredentials(storage.id)) as unknown as Record<string, unknown>
      );
    } catch (error) {
      toastApiError(error, "Failed to reveal credentials");
    } finally {
      setLoadingCredentials(false);
    }
  };

  if (loading || !storage) return <DetailPageSkeleton label="Loading storage" />;

  const browserDisabled = liveHealthStatus === "offline";
  const engine = managedStorageEngine(storage);

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6 space-y-4">
        <StorageHeader
          storage={storage}
          healthStatus={liveHealthStatus}
          canEdit={canEdit}
          canRestart={canRestart}
          canRetry={canRetry}
          canReveal={canReveal}
          canDelete={canDelete}
          removeDisabledReason={incidentHold.kept}
          onOpenPin={() => setPinOpen(true)}
          onBack={() => navigate("/storage")}
          onTest={() => void testConnection()}
          onOpenSettings={() => setSettingsOpen(true)}
          onRestart={() => void restart()}
          onRetry={() => void retryProvisioning()}
          onRevealCredentials={() => void revealCredentials()}
          onRemove={() => void remove()}
        />
        <MemberIsolatedNotice app={storage.app} memberApp={memberApp} onChanged={reloadMemberApp} />

        <HealthBars history={liveHealthHistory} currentStatus={liveHealthStatus} />

        <ManagedStorageFullNotice storage={storage} />

        <ManagedInstanceNotice managed={storage.managed} />

        <ManagedStorageLegacyEngineBanner storage={storage} />

        {/* The certificate detail row and any warning wait for the first status. */}
        <ContentLoading loading={managedCertificate.loading} />
        <ManagedCertificateNotice
          status={managedCertificate.status}
          onRenew={canEdit ? renewManagedCertificate : undefined}
          onRenewed={managedCertificate.refresh}
        />

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col">
          <TabsList className="shrink-0">
            <TabsTrigger value="overview" className="gap-1.5">
              Overview
            </TabsTrigger>
            {canRead && (
              <TabsTrigger value="browser" disabled={browserDisabled} className="gap-1.5">
                Objects
              </TabsTrigger>
            )}
            {storage.managed && (
              <TabsTrigger value="iam-keys" className="gap-1.5">
                IAM Keys
              </TabsTrigger>
            )}
            {storage.managed &&
              engine === "seaweedfs" &&
              canViewMonitoring &&
              availabilityTabVisible && (
                <TabsTrigger value="availability" className="gap-1.5">
                  Availability
                </TabsTrigger>
              )}
          </TabsList>

          <TabsContent value="overview" className="space-y-4">
            <StorageOverviewTab
              storage={storage}
              certificateStatus={managedCertificate.status}
              canViewMonitoring={canViewMonitoring}
              healthStatus={liveHealthStatus}
              history={monitoringHistory}
              monitoringLoading={monitoringLoading}
            />
          </TabsContent>

          {canRead && (
            <TabsContent value="browser" className="space-y-4">
              {browserDisabled ? (
                <div className="border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                  Object browser is unavailable while the storage is offline.
                </div>
              ) : (
                <ObjectBrowser
                  storage={storage}
                  canWrite={canWrite}
                  canCreateBuckets={canAdminBuckets}
                />
              )}
            </TabsContent>
          )}

          {storage.managed && (
            <TabsContent value="iam-keys" className="space-y-4">
              <StorageIamKeysTab
                managedId={storage.managed.id}
                engine={engine ?? undefined}
                canManage={canManageIam}
              />
            </TabsContent>
          )}

          {storage.managed &&
            engine === "seaweedfs" &&
            canViewMonitoring &&
            availabilityTabVisible && (
              <TabsContent value="availability" className="space-y-4">
                <AvailabilityPanel
                  owner={{ kind: "storage", id: storage.managed.id }}
                  engine="seaweedfs"
                  resourceName={storage.name}
                  originNodeId={storage.managed.nodeId}
                  canManage={canEdit}
                  onChanged={() => void load()}
                />
              </TabsContent>
            )}
        </Tabs>
      </div>

      <Dialog open={credentialsOpen} onOpenChange={setCredentialsOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Stored Credentials</DialogTitle>
            <DialogDescription>
              The credentials Opfield uses to reach this storage, decrypted for viewing.
            </DialogDescription>
          </DialogHeader>
          <div className="border border-border bg-card overflow-hidden">
            <ContentLoading loading={loadingCredentials} />
            {loadingCredentials ? null : (
              <pre className="overflow-x-auto p-4 text-sm whitespace-pre-wrap">
                {revealedCredentials
                  ? JSON.stringify(revealedCredentials, null, 2)
                  : "Credentials are hidden."}
              </pre>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* close-reset-ok: storage is loaded page data, not cleared on close */}
      {storage.managed && (
        <StorageCredentialsDialog
          managedId={storage.managed.id}
          endpoint={storage.endpoint}
          region={storage.region}
          engine={engine ?? undefined}
          // Managed endpoints are https exactly when the cluster serves TLS.
          tlsEnabled={storage.endpoint?.startsWith("https://") ?? false}
          publishedPort={storage.managed.publishedPort}
          connectionName={storage.name}
          open={managedCredentialsOpen}
          onOpenChange={setManagedCredentialsOpen}
        />
      )}

      <Dialog open={pinOpen} onOpenChange={setPinOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Pin Storage</DialogTitle>
            <DialogDescription>Choose where this storage appears as a shortcut.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Add to sidebar</p>
                <p className="text-xs text-muted-foreground">Quick access link in the sidebar</p>
              </div>
              <Switch
                checked={isPinnedSidebar(storage.id)}
                onChange={() => {
                  toggleSidebar(storage.id, {
                    slug: storage.slug,
                    name: storage.name,
                    provider: storage.provider,
                    healthStatus: liveHealthStatus,
                  });
                  usePinnedStorageStore.getState().invalidate();
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
              <DialogTitle>Storage Settings</DialogTitle>
              <DialogDescription>
                Connection details and metadata for this storage.
              </DialogDescription>
            </DialogHeader>
            {storage.managed ? (
              <ManagedObjectStorageSettingsTab
                storage={storage}
                onSaved={() => {
                  setSettingsOpen(false);
                  void load();
                }}
              />
            ) : (
              <StorageSettingsTab
                storage={storage}
                onSaved={(updated) => {
                  setSettingsOpen(false);
                  setStorage(updated);
                  if (updated.slug !== routeSlug) {
                    navigate(storageRoute(updated.slug, activeTab), { replace: true });
                  } else {
                    void load();
                  }
                }}
              />
            )}
          </DialogContent>
        </Dialog>
      )}
    </PageTransition>
  );
}

interface BackupHistoryReference {
  historyRecords: number;
  backupsWithFiles: number;
}

/** The 409 the storage API returns while only finished backup history references the storage. */
function backupHistoryReference(error: unknown): BackupHistoryReference | null {
  if (!(error instanceof ApiRequestError) || error.code !== "STORAGE_BACKUP_HISTORY_EXISTS") {
    return null;
  }
  const details = (error.details ?? {}) as Partial<BackupHistoryReference>;
  return {
    historyRecords: Number(details.historyRecords) || 0,
    backupsWithFiles: Number(details.backupsWithFiles) || 0,
  };
}

function forgetBackupHistoryDescription(history: BackupHistoryReference, managed: boolean): string {
  const entries =
    history.historyRecords === 1
      ? "1 backup history entry references"
      : `${history.historyRecords} backup history entries reference`;
  const withFiles =
    history.backupsWithFiles > 0
      ? `, ${history.backupsWithFiles} of them with backup files that still exist`
      : "";
  const files = managed
    ? "Backup files stored in this managed storage are deleted with it."
    : "Their backup files are not deleted and stay in the buckets.";
  return `${entries} this storage${withFiles}. Forgetting removes this history from Opfield, so those backups can no longer be restored or deleted here. ${files}`;
}

import { useAvailabilityTabVisible } from "@/components/availability-sets/use-availability-tab";
import { ContentLoading } from "@/components/common/ContentLoading";
import { LicenseFeatureBoundary } from "@/components/license/LicenseFeatureBoundary";
