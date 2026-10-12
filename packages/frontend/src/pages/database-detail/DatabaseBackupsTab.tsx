import {
  CalendarCheck,
  CalendarOff,
  DatabaseBackup,
  History,
  Play,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { confirm, confirmAction } from "@/components/common/ConfirmDialog";
import { ContentLoading } from "@/components/common/ContentLoading";
import {
  CreateFolderSelect,
  getCreateFolderChoices,
  isCreateFolderAllowed,
} from "@/components/common/CreateFolderSelect";
import { ManagedResourceFields } from "@/components/common/ManagedResourceFields";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsControlRow, SettingsInlineControl } from "@/components/common/SettingsControlRow";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { toastApiError } from "@/lib/api-error-toast";
import {
  MANAGED_DATABASE_NAME_PATTERN,
  normalizeManagedDatabaseName,
} from "@/lib/managed-database-name";
import { isDatabaseBackupCandidateNode } from "@/lib/managed-database-nodes";
import { formatBytes, formatDateTime } from "@/lib/utils";
import { minimumManagedDatabaseMemoryMb } from "@/pages/database-detail/managed-database-capacity";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { useAuthStore } from "@/stores/auth";
import { useResourceFolderStore } from "@/stores/resource-folders";
import type {
  BackupHistoryArtifactsAction,
  BackupPolicy,
  BackupPolicyInput,
  BackupRestoreInput,
  BackupRun,
  BackupRunStatus,
} from "@/types/backups";
import type { DatabaseConnection } from "@/types/databases";
import type { Node } from "@/types/nodes";

const defaultLimits = {
  workspaceBytes: 20 * 1024 ** 3,
  timeoutSeconds: 3600,
  cpuCores: 1,
  memoryMb: 1024,
};

const RUN_STATUS_BADGE: Record<BackupRunStatus, { label: string; variant: BadgeProps["variant"] }> =
  {
    queued: { label: "Queued", variant: "secondary" },
    running: { label: "Running", variant: "info" },
    completed: { label: "Completed", variant: "success" },
    failed: { label: "Failed", variant: "destructive" },
    cancelled: { label: "Cancelled", variant: "secondary" },
  };

interface BackupsCache {
  policies: BackupPolicy[];
  runs: BackupRun[];
}

function backupsCacheKey(databaseId: string) {
  return `database:backups:${databaseId}`;
}

export interface BackupSelectionOption {
  id: string;
  label: string;
  disabledReason?: string;
  provider?: string;
}

/** Storage nodes the user may run backup jobs on: the backup API's rule (nodes:backups:execute). */
export function backupExecutorOptions(
  nodes: Node[],
  hasScope: (scope: string) => boolean
): BackupSelectionOption[] {
  return nodes
    .filter(
      (node) =>
        isDatabaseBackupCandidateNode(node) &&
        (hasScope("nodes:backups:execute") || hasScope(`nodes:backups:execute:${node.id}`))
    )
    .map((node) => ({
      id: node.id,
      label: node.hostname,
      disabledReason: node.status === "online" ? undefined : "Node is offline",
    }));
}

/** History calls of one database, or of the history of deleted databases. */
export interface BackupRunApi {
  deleteHistory: (
    runId: string,
    options?: { artifacts?: BackupHistoryArtifactsAction }
  ) => Promise<unknown>;
  cancel: (runId: string, options: { force?: boolean }) => Promise<void>;
}

/** Remove and cancel actions of a backup history table. `runApi` must be stable (memoized). */
export function useBackupRunActions(runApi: BackupRunApi, refresh: () => Promise<void>) {
  const deleteHistory = useCallback(
    async (run: BackupRun) => {
      if (!run.manifest || run.artifactsDeletedAt) {
        try {
          await runApi.deleteHistory(run.id);
          toast.success("History entry removed");
          await refresh();
        } catch (error) {
          toastApiError(error, "Failed to remove history entry");
        }
        return;
      }
      // The backup still has files: deleting them is explicit, and a storage
      // failure keeps the entry and offers to forget it instead.
      const location = `${run.destinationBucket}/${run.manifest.ownedPrefix}`;
      const outcome: { failure?: string } = {};
      const confirmed = await confirmAction(
        {
          title: "Delete Backup",
          description: `This deletes the backup files in ${location} and removes the entry from history. The backup can no longer be restored.`,
          confirmLabel: "Delete backup and files",
          variant: "destructive",
        },
        async () => {
          try {
            await runApi.deleteHistory(run.id, { artifacts: "delete" });
          } catch (error) {
            if (
              error instanceof ApiRequestError &&
              error.code === "BACKUP_ARTIFACT_DELETE_FAILED"
            ) {
              outcome.failure = error.message;
              return;
            }
            toastApiError(error, "Failed to delete backup");
            throw error;
          }
        }
      );
      if (!confirmed) return;
      if (outcome.failure === undefined) {
        toast.success("Backup deleted");
        await refresh();
        return;
      }
      const forget = await confirm({
        title: "Backup Files Could Not Be Deleted",
        description: `${outcome.failure} Forgetting removes the entry from history and leaves the files in ${location}.`,
        confirmLabel: "Forget entry",
        cancelLabel: "Keep entry",
        variant: "destructive",
      });
      if (!forget) return;
      try {
        await runApi.deleteHistory(run.id, { artifacts: "forget" });
        toast.success("Entry forgotten; the backup files were left in storage");
        await refresh();
      } catch (error) {
        toastApiError(error, "Failed to forget history entry");
      }
    },
    [runApi, refresh]
  );
  const cancel = useCallback(
    async (run: BackupRun, force = false) => {
      try {
        await runApi.cancel(run.id, { force });
        toast.success(force ? "Run ended" : "Cancellation requested");
        await refresh();
      } catch (error) {
        toastApiError(error, "Failed to request cancellation");
      }
    },
    [runApi, refresh]
  );
  return { deleteHistory, cancel };
}

/** Columns of a backup history table; `leadingColumns` must be stable. */
export function useBackupRunColumns({
  canRestore,
  canRun,
  canManage,
  onRestore,
  deleteHistory,
  cancel,
  leadingColumns,
}: {
  canRestore: boolean;
  canRun: boolean;
  canManage: boolean;
  onRestore: (run: BackupRun) => void;
  deleteHistory: (run: BackupRun) => Promise<void>;
  cancel: (run: BackupRun, force?: boolean) => Promise<void>;
  leadingColumns?: DataTableColumn<BackupRun>[];
}) {
  return useMemo<DataTableColumn<BackupRun>[]>(
    () => [
      ...(leadingColumns ?? []),
      {
        key: "created",
        header: "Started",
        render: (run) => <RelativeTime value={run.startedAt ?? run.createdAt} />,
      },
      {
        key: "type",
        header: "Operation",
        render: (run) => (run.direction === "backup" ? "Backup" : "Restore"),
      },
      {
        key: "status",
        header: "Status",
        render: (run) => (
          <Badge variant={RUN_STATUS_BADGE[run.status].variant}>
            {RUN_STATUS_BADGE[run.status].label}
          </Badge>
        ),
      },
      {
        key: "details",
        header: "Details",
        render: (run) => (
          <span className="text-muted-foreground">
            {run.error ??
              (run.status === "queued" || run.status === "running"
                ? run.phase.replaceAll("_", " ")
                : run.artifactsDeletedAt
                  ? "Artifacts removed by retention"
                  : "—")}
          </span>
        ),
      },
      {
        key: "size",
        header: "Size",
        align: "right",
        render: (run) => (Number(run.bytes) > 0 ? formatBytes(Number(run.bytes)) : "—"),
      },
      {
        key: "actions",
        header: "Actions",
        align: "right",
        width: "7rem",
        render: (run) => {
          const removeLabel = run.manifest && !run.artifactsDeletedAt ? "Delete" : "Remove";
          return (
            <div className="flex justify-end gap-1">
              {run.direction === "backup" &&
              run.status === "completed" &&
              !run.artifactsDeletedAt &&
              canRestore ? (
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Restore"
                  title="Restore"
                  onClick={() => onRestore(run)}
                >
                  <RotateCcw />
                </Button>
              ) : null}
              {(run.status === "queued" || run.status === "running") && canRun ? (
                run.phase === "cancelling" ? (
                  // The executor has not confirmed the cancel (for example, its node
                  // is offline). Ending the run releases the node and the schedule;
                  // the node stops the runner when it reconnects.
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Force cancel"
                    title="Force cancel"
                    onClick={() => void cancel(run, true)}
                  >
                    <X />
                  </Button>
                ) : (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Cancel"
                    title="Cancel"
                    onClick={() => void cancel(run)}
                  >
                    <X />
                  </Button>
                )
              ) : null}
              {canManage && !["queued", "running"].includes(run.status) ? (
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={removeLabel}
                  title={removeLabel}
                  onClick={() => void deleteHistory(run)}
                >
                  <Trash2 />
                </Button>
              ) : null}
            </div>
          );
        },
      },
    ],
    [canRestore, canRun, canManage, cancel, deleteHistory, leadingColumns, onRestore]
  );
}

export function DatabaseBackupsTab({
  database,
  destinations,
  executors,
  optionsLoading = false,
  canManage,
  canRun,
  canRestore,
}: {
  database: DatabaseConnection;
  destinations: BackupSelectionOption[];
  executors: BackupSelectionOption[];
  /** Destinations and executors are still loading; policy rows name their destination. */
  optionsLoading?: boolean;
  canManage: boolean;
  canRun: boolean;
  canRestore: boolean;
}) {
  const cacheKey = backupsCacheKey(database.id);
  const [policies, setPolicies] = useState<BackupPolicy[]>(
    () => api.getCached<BackupsCache>(cacheKey)?.policies ?? []
  );
  const [runs, setRuns] = useState<BackupRun[]>(
    () => api.getCached<BackupsCache>(cacheKey)?.runs ?? []
  );
  const [loading, setLoading] = useState(() => api.getCached<BackupsCache>(cacheKey) === undefined);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [restoreRun, setRestoreRun] = useState<BackupRun | null>(null);
  useContentLoading(loading || optionsLoading);
  const refresh = useCallback(async () => {
    try {
      const [nextPolicies, nextRuns] = await Promise.all([
        api.listBackupPolicies(database.id),
        api.listBackupRuns(database.id),
      ]);
      api.setCache(cacheKey, { policies: nextPolicies, runs: nextRuns } satisfies BackupsCache);
      setPolicies(nextPolicies);
      setRuns(nextRuns);
    } catch (error) {
      toastApiError(error, "Failed to load backups");
    } finally {
      setLoading(false);
    }
  }, [cacheKey, database.id]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!runs.some((run) => run.status === "queued" || run.status === "running")) return;
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [runs, refresh]);
  const runApi = useMemo<BackupRunApi>(
    () => ({
      deleteHistory: (runId, options) => api.deleteBackupHistory(database.id, runId, options),
      cancel: (runId, options) => api.cancelBackup(database.id, runId, options),
    }),
    [database.id]
  );
  const { deleteHistory, cancel } = useBackupRunActions(runApi, refresh);
  const columns = useBackupRunColumns({
    canRestore,
    canRun,
    canManage,
    onRestore: setRestoreRun,
    deleteHistory,
    cancel,
  });
  const start = async (policy: BackupPolicy) => {
    try {
      await api.startBackup(database.id, policy.id);
      toast.success("Backup queued");
      await refresh();
    } catch (error) {
      toastApiError(error, "Failed to queue backup");
    }
  };
  const setScheduleEnabled = async (policy: BackupPolicy, enabled: boolean) => {
    try {
      await api.updateBackupPolicy(database.id, policy.id, policyInput(policy, enabled));
      toast.success(enabled ? "Backup schedule enabled" : "Backup schedule disabled");
      await refresh();
    } catch (error) {
      toastApiError(error, "Failed to update backup schedule");
    }
  };
  const removePolicy = async (policy: BackupPolicy) => {
    const ok = await confirm({
      title: "Delete Backup Policy",
      description:
        "Scheduled backups for this policy will stop. Completed backups stay in the destination storage.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await api.deleteBackupPolicy(database.id, policy.id);
      toast.success("Backup policy deleted");
      await refresh();
    } catch (error) {
      toastApiError(error, "Failed to delete backup policy");
    }
  };
  const destinationLabel = (policy: BackupPolicy) =>
    destinations.find((item) => item.id === policy.destinationId)?.label ?? "Storage";
  return (
    <div className="space-y-4">
      <PanelShell
        icon={<DatabaseBackup className="h-4 w-4" />}
        title="Backup policies"
        description="Where backups are stored, which node runs them, and how many are kept."
        actions={
          canManage ? <Button onClick={() => setPolicyOpen(true)}>Add policy</Button> : undefined
        }
      >
        {loading ? null : policies.length ? (
          policies.map((policy) => (
            <SettingsControlRow
              key={policy.id}
              title={
                policy.schedule
                  ? `Schedule ${policy.schedule} (${policy.timezone})`
                  : "Manual backups"
              }
              description={`${destinationLabel(policy)} / ${policy.bucket}${policy.prefix ? ` / ${policy.prefix}` : ""} · keeps ${policy.retentionCount} backup${policy.retentionCount === 1 ? "" : "s"}${policy.schedule && !policy.enabled ? " · schedule disabled" : ""}${policy.lastError ? ` · ${policy.lastError}` : ""}`}
            >
              <div className="flex items-center gap-1">
                {canManage && policy.schedule ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={policy.enabled ? "Disable schedule" : "Enable schedule"}
                    title={policy.enabled ? "Disable schedule" : "Enable schedule"}
                    onClick={() => void setScheduleEnabled(policy, !policy.enabled)}
                  >
                    {policy.enabled ? <CalendarOff /> : <CalendarCheck />}
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Run now"
                  title="Run now"
                  disabled={!canRun}
                  onClick={() => void start(policy)}
                >
                  <Play />
                </Button>
                {canManage ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Delete backup policy"
                    title="Delete backup policy"
                    onClick={() => void removePolicy(policy)}
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </div>
            </SettingsControlRow>
          ))
        ) : (
          <SettingsControlRow
            title="No backup policy"
            description="Add a policy with a destination, Storage node, schedule, and retention before running a backup."
          >
            <span className="text-sm text-muted-foreground">Not configured</span>
          </SettingsControlRow>
        )}
      </PanelShell>
      <PanelShell
        icon={<History className="h-4 w-4" />}
        title="Backup history"
        description="Backup and restore runs for this database."
        bodyClassName="p-0"
      >
        <DataTable
          columns={columns}
          data={runs}
          keyFn={(run) => run.id}
          loading={loading}
          emptyMessage="No backups have run for this database."
          embedded
          horizontalScroll
          minWidth="52rem"
        />
      </PanelShell>
      <PolicyDialog
        open={policyOpen}
        onOpenChange={setPolicyOpen}
        destinations={destinations}
        engine={database.type}
        executors={executors}
        onSave={async (input) => {
          await api.createBackupPolicy(database.id, input);
          toast.success("Backup policy saved");
          setPolicyOpen(false);
          await refresh();
        }}
      />
      <RestoreDialog
        run={restoreRun}
        sourceDatabaseName={database.databaseName}
        sourceResources={
          database.managed
            ? {
                storageSizeGb:
                  Math.round((Number(database.managed.storageSizeBytes) / 1024 ** 3) * 10) / 10,
                ...database.managed.runtimeConfig,
              }
            : undefined
        }
        // close-reset-ok: RestoreDialog retains the run itself
        onOpenChange={(open) => !open && setRestoreRun(null)}
        executors={executors}
        onRestore={async (input) => {
          if (!restoreRun) return;
          await api.restoreBackup(database.id, restoreRun.id, input);
          toast.success("Restore queued");
          setRestoreRun(null);
          await refresh();
        }}
      />
    </div>
  );
}

function policyInput(policy: BackupPolicy, enabled: boolean): BackupPolicyInput {
  return {
    destinationId: policy.destinationId,
    bucket: policy.bucket,
    prefix: policy.prefix,
    stagingStorageConnectionId: policy.stagingStorageConnectionId,
    stagingBucket: policy.stagingBucket,
    executorNodeId: policy.executorNodeId,
    schedule: policy.schedule,
    timezone: policy.timezone,
    retentionCount: policy.retentionCount,
    limits: policy.limits,
    enabled,
  };
}

function PolicyDialog({
  engine,
  open,
  onOpenChange,
  destinations,
  executors,
  onSave,
}: {
  engine: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  destinations: BackupSelectionOption[];
  executors: BackupSelectionOption[];
  onSave: (input: BackupPolicyInput) => Promise<void>;
}) {
  const [destinationId, setDestinationId] = useState("");
  const [executorNodeId, setExecutorNodeId] = useState("");
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("database-backups");
  const [stagingStorageConnectionId, setStagingStorageConnectionId] = useState("");
  const [stagingBucket, setStagingBucket] = useState("");
  const [schedule, setSchedule] = useState("0 2 * * *");
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  );
  const [retentionCount, setRetentionCount] = useState("7");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setSaving(false);
  }, [open]);
  const [limits, setLimits] = useState(defaultLimits);
  useEffect(() => {
    if (!open) return;
    setDestinationId("");
    setExecutorNodeId("");
    setBucket("");
    setPrefix("database-backups");
    setStagingStorageConnectionId("");
    setStagingBucket("");
    setSchedule("0 2 * * *");
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    setRetentionCount("7");
    setLimits(defaultLimits);
  }, [open]);
  const retention = Number(retentionCount);
  const save = async () => {
    if (!destinationId || !bucket.trim() || !executorNodeId) {
      toast.error("Choose a destination, bucket, and Storage node");
      return;
    }
    if (!Number.isInteger(retention) || retention < 1) {
      toast.error("Retention must be a whole number of at least 1");
      return;
    }
    if (Boolean(stagingStorageConnectionId) !== Boolean(stagingBucket.trim())) {
      toast.error("Staging storage and bucket must be configured together");
      return;
    }
    setSaving(true);
    try {
      await onSave({
        destinationId,
        bucket: bucket.trim(),
        prefix: prefix.trim(),
        stagingStorageConnectionId: stagingStorageConnectionId || null,
        stagingBucket: stagingBucket.trim() || null,
        executorNodeId,
        schedule: schedule.trim() || null,
        timezone: timezone.trim() || "UTC",
        retentionCount: retention,
        limits,
      });
    } catch (error) {
      setSaving(false);
      toastApiError(error, "Failed to save backup policy");
    }
  };
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !saving && onOpenChange(nextOpen)}>
      <DialogContent className="flex max-h-[88dvh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add Backup Policy</DialogTitle>
          <DialogDescription>
            Backups run on the selected Storage node and are uploaded to the destination storage.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 pr-1">
          <PanelShell title="Destination" description="Where completed backups are stored.">
            <SettingsControlRow
              title="Storage"
              description="Object storage connection that receives the backups."
            >
              <Choice
                label="Storage"
                value={destinationId}
                onValueChange={setDestinationId}
                options={destinations}
              />
            </SettingsControlRow>
            <SettingsControlRow title="Bucket" description="Bucket inside the destination storage.">
              <Input
                aria-label="Bucket"
                value={bucket}
                onChange={(event) => setBucket(event.target.value)}
              />
            </SettingsControlRow>
            <SettingsControlRow title="Prefix" description="Folder for this database's backups.">
              <Input
                aria-label="Prefix"
                value={prefix}
                onChange={(event) => setPrefix(event.target.value)}
              />
            </SettingsControlRow>
            {engine === "clickhouse" && (
              <SettingsControlRow
                title="S3 staging"
                description="ClickHouse writes backups to S3 natively. A file destination (FTP, SFTP) needs an S3 staging storage."
              >
                <div className="grid w-full gap-3">
                  <Choice
                    label="S3 staging storage"
                    value={stagingStorageConnectionId || "none"}
                    onValueChange={(id) => {
                      setStagingStorageConnectionId(id === "none" ? "" : id);
                      if (id === "none") setStagingBucket("");
                    }}
                    options={[
                      { id: "none", label: "Use the S3 destination directly" },
                      ...destinations.filter(
                        (item) => !["ftp", "ftps", "sftp"].includes(item.provider ?? "")
                      ),
                    ]}
                  />
                  {stagingStorageConnectionId && (
                    <SettingsInlineControl label="Staging bucket">
                      <Input
                        value={stagingBucket}
                        onChange={(event) => setStagingBucket(event.target.value)}
                      />
                    </SettingsInlineControl>
                  )}
                </div>
              </SettingsControlRow>
            )}
          </PanelShell>

          <PanelShell title="Execution" description="Which node runs backups and when.">
            <SettingsControlRow
              title="Storage node"
              description="Node that runs the backup job and uploads the result."
            >
              <Choice
                label="Storage node"
                value={executorNodeId}
                onValueChange={setExecutorNodeId}
                options={executors}
              />
            </SettingsControlRow>
            <SettingsControlRow
              title="Schedule"
              description="Five-field cron expression. Leave empty to run backups manually only."
            >
              <div className="grid w-full grid-cols-2 gap-3">
                <SettingsInlineControl label="Cron">
                  <Input value={schedule} onChange={(event) => setSchedule(event.target.value)} />
                </SettingsInlineControl>
                <SettingsInlineControl label="Timezone">
                  <Input value={timezone} onChange={(event) => setTimezone(event.target.value)} />
                </SettingsInlineControl>
              </div>
            </SettingsControlRow>
            <SettingsControlRow
              title="Retention"
              description="Completed backups to keep. Older ones are removed from the destination."
            >
              <Input
                aria-label="Completed backups to keep"
                type="number"
                min={1}
                value={retentionCount}
                onChange={(event) => setRetentionCount(event.target.value)}
              />
            </SettingsControlRow>
          </PanelShell>

          <PanelShell title="Resource limits" description="Limits for one backup or restore job.">
            <SettingsControlRow
              title="Workspace and timeout"
              description="Temporary disk space on the Storage node and the maximum job duration."
            >
              <div className="grid w-full grid-cols-2 gap-3">
                <SettingsInlineControl label="Workspace (GiB)">
                  <Input
                    type="number"
                    min={1}
                    max={1024}
                    value={limits.workspaceBytes / 1024 ** 3}
                    onChange={(event) =>
                      setLimits({
                        ...limits,
                        workspaceBytes: Number(event.target.value) * 1024 ** 3,
                      })
                    }
                  />
                </SettingsInlineControl>
                <SettingsInlineControl label="Timeout (seconds)">
                  <Input
                    type="number"
                    min={60}
                    max={86400}
                    value={limits.timeoutSeconds}
                    onChange={(event) =>
                      setLimits({ ...limits, timeoutSeconds: Number(event.target.value) })
                    }
                  />
                </SettingsInlineControl>
              </div>
            </SettingsControlRow>
            <SettingsControlRow title="CPU and memory" description="Limits of the job container.">
              <div className="grid w-full grid-cols-2 gap-3">
                <SettingsInlineControl label="CPU cores">
                  <Input
                    type="number"
                    min={1}
                    max={32}
                    value={limits.cpuCores}
                    onChange={(event) =>
                      setLimits({ ...limits, cpuCores: Number(event.target.value) })
                    }
                  />
                </SettingsInlineControl>
                <SettingsInlineControl label="Memory (MiB)">
                  <Input
                    type="number"
                    min={128}
                    max={262144}
                    value={limits.memoryMb}
                    onChange={(event) =>
                      setLimits({ ...limits, memoryMb: Number(event.target.value) })
                    }
                  />
                </SettingsInlineControl>
              </div>
            </SettingsControlRow>
          </PanelShell>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button type="button" pending={saving} onClick={() => void save()}>
            Save policy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type RestoreResourceKey = "storageSizeGb" | "cpuCores" | "memoryMb" | "swapMb";
const RESTORE_RESOURCE_KEYS: RestoreResourceKey[] = [
  "storageSizeGb",
  "cpuCores",
  "memoryMb",
  "swapMb",
];

function restoreResourceInputs(source?: Record<RestoreResourceKey, number>) {
  return Object.fromEntries(
    RESTORE_RESOURCE_KEYS.map((key) => [
      key,
      source && (key === "swapMb" ? source[key] >= 0 : source[key] > 0) ? String(source[key]) : "",
    ])
  ) as Record<RestoreResourceKey, string>;
}

/** The entered size and resources of the new database, or the first field that is not valid. */
function parsedRestoreResources(
  inputs: Record<RestoreResourceKey, string>,
  minimumMemoryMb: number
): { resources: Partial<Record<RestoreResourceKey, number>> } | { error: string } {
  const resources: Partial<Record<RestoreResourceKey, number>> = {};
  for (const key of RESTORE_RESOURCE_KEYS) {
    const text = inputs[key].trim();
    if (!text) continue;
    const value = Number(text);
    const valid =
      key === "storageSizeGb"
        ? value >= 0.1 && Math.abs(value * 10 - Math.round(value * 10)) < 1e-9
        : key === "cpuCores"
          ? value >= 0.1
          : Number.isInteger(value) && value >= (key === "memoryMb" ? minimumMemoryMb : 0);
    if (!Number.isFinite(value) || !valid) {
      return {
        error:
          key === "storageSizeGb"
            ? "Storage must be at least 0.1 GB with one decimal at most"
            : key === "cpuCores"
              ? "CPU cores must be at least 0.1"
              : key === "memoryMb"
                ? `Memory must be a whole number of MB, at least ${minimumMemoryMb}`
                : "Swap must be a whole number of MB",
      };
    }
    resources[key] = value;
  }
  return { resources };
}

export function RestoreDialog({
  run: runProp,
  sourceDatabaseName,
  sourceResources,
  onOpenChange,
  executors,
  onRestore,
}: {
  run: BackupRun | null;
  /** Database name of the source connection, used when the backup manifest does not record one. */
  sourceDatabaseName?: string | null;
  /** Size and resources of the source managed database: the defaults of the new one. */
  sourceResources?: Record<RestoreResourceKey, number>;
  onOpenChange: (open: boolean) => void;
  executors: BackupSelectionOption[];
  onRestore: (
    input: Pick<
      BackupRestoreInput,
      | "executorNodeId"
      | "newManagedDatabaseName"
      | "targetDatabaseName"
      | "folderId"
      | RestoreResourceKey
    >
  ) => Promise<void>;
}) {
  const run = useRetainedDialogValue(runProp, runProp !== null);
  const [executorNodeId, setExecutorNodeId] = useState("");
  const [resourceInputs, setResourceInputs] = useState(() =>
    restoreResourceInputs(sourceResources)
  );
  const minimumMemoryMb = minimumManagedDatabaseMemoryMb(run?.engine ?? "postgres");
  const resourceCheck = parsedRestoreResources(resourceInputs, minimumMemoryMb);
  const resourceError = "error" in resourceCheck ? resourceCheck.error : null;
  const [newManagedDatabaseName, setNewManagedDatabaseName] = useState("");
  const [folderId, setFolderId] = useState("");
  const scopes = useAuthStore((state) => state.user?.scopes);
  const databaseFolders = useResourceFolderStore((state) => state.foldersByType.database);
  const foldersLoading = useResourceFolderStore((state) => state.loadingByType.database);
  const fetchFolders = useResourceFolderStore((state) => state.fetchFolders);
  // Same rule as the restore route: databases:create on the Storage node or the chosen folder.
  const folderChoices = useMemo(
    () =>
      getCreateFolderChoices(
        scopes ?? [],
        "databases:create",
        databaseFolders,
        executorNodeId || undefined
      ),
    [databaseFolders, executorNodeId, scopes]
  );
  const destinationAllowed = isCreateFolderAllowed(folderChoices, folderId);
  const [targetDatabaseName, setTargetDatabaseName] = useState("");
  const [restoring, setRestoring] = useState(false);
  const runId = run?.id;
  // A key-value store has no named databases, so the new managed target ignores this name.
  const hasDatabaseName = run?.engine !== "redis";
  const defaultTargetDatabaseName = normalizeManagedDatabaseName(
    run?.manifest?.sourceDatabase ?? sourceDatabaseName
  );
  const trimmedTargetDatabaseName = targetDatabaseName.trim();
  const targetDatabaseNameError =
    hasDatabaseName &&
    trimmedTargetDatabaseName &&
    !MANAGED_DATABASE_NAME_PATTERN.test(trimmedTargetDatabaseName)
      ? "Use letters, digits and underscores, starting with a letter or underscore (up to 63 characters)"
      : null;
  const sourceResourceKey = JSON.stringify(sourceResources ?? null);
  useEffect(() => {
    if (!runId) return;
    setExecutorNodeId("");
    setNewManagedDatabaseName("");
    setFolderId("");
    setTargetDatabaseName(defaultTargetDatabaseName);
    setResourceInputs(restoreResourceInputs(JSON.parse(sourceResourceKey) ?? undefined));
    void fetchFolders("database");
  }, [defaultTargetDatabaseName, fetchFolders, runId, sourceResourceKey]);
  const restore = async () => {
    if (!executorNodeId || !newManagedDatabaseName.trim()) {
      toast.error("Choose the Storage node and a name for the new database");
      return;
    }
    if (targetDatabaseNameError || !destinationAllowed || !("resources" in resourceCheck)) return;
    setRestoring(true);
    try {
      await onRestore({
        executorNodeId,
        newManagedDatabaseName: newManagedDatabaseName.trim(),
        ...resourceCheck.resources,
        ...(folderId ? { folderId } : {}),
        ...(hasDatabaseName && trimmedTargetDatabaseName
          ? { targetDatabaseName: trimmedTargetDatabaseName }
          : {}),
      });
    } catch (error) {
      toastApiError(error, "Failed to queue restore");
    } finally {
      setRestoring(false);
    }
  };
  return (
    <Dialog
      open={Boolean(runProp)}
      onOpenChange={(nextOpen) => !restoring && onOpenChange(nextOpen)}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Restore Backup</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <ContentLoading loading={foldersLoading} />
          <DialogDescription>
            Restores the backup from {run ? formatDateTime(run.startedAt ?? run.createdAt) : ""}{" "}
            into a new managed database. Existing databases are never overwritten.
          </DialogDescription>
          <div className="space-y-1.5">
            <span className="text-sm font-medium">Storage node</span>
            <Choice
              label="Storage node"
              value={executorNodeId}
              onValueChange={setExecutorNodeId}
              options={executors}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="backup-restore-folder">
              Folder
            </label>
            <CreateFolderSelect
              id="backup-restore-folder"
              choices={folderChoices}
              value={folderId}
              onChange={setFolderId}
              loading={foldersLoading}
              disabled={restoring}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="backup-restore-database-name">
              New managed database name
            </label>
            <Input
              id="backup-restore-database-name"
              value={newManagedDatabaseName}
              onChange={(event) => setNewManagedDatabaseName(event.target.value)}
              disabled={restoring}
            />
          </div>
          {hasDatabaseName && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="backup-restore-target-database-name">
                Database name (optional)
              </label>
              <Input
                id="backup-restore-target-database-name"
                value={targetDatabaseName}
                placeholder={defaultTargetDatabaseName}
                onChange={(event) => setTargetDatabaseName(event.target.value)}
                disabled={restoring}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={targetDatabaseNameError ? true : undefined}
                aria-describedby="backup-restore-target-database-name-hint"
              />
              <p
                id="backup-restore-target-database-name-hint"
                className={
                  targetDatabaseNameError
                    ? "text-xs text-destructive"
                    : "text-xs text-muted-foreground"
                }
              >
                {targetDatabaseNameError ??
                  "Database created inside the new managed database. Defaults to the source name."}
              </p>
            </div>
          )}
          <ManagedResourceFields
            idPrefix="backup-restore"
            values={resourceInputs}
            capacity={{}}
            onChange={(key, value) =>
              setResourceInputs((current) => ({ ...current, [key]: value }))
            }
            minimumMemoryMb={minimumMemoryMb}
          />
          <p
            className={resourceError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
          >
            {resourceError ??
              (sourceResources
                ? "Defaults to the size of the source database."
                : `Empty fields use the defaults: storage three times the backup (at least 20 GB), 1 CPU core, ${
                    run?.engine === "clickhouse" ? 2048 : 1024
                  } MB of memory, no swap.`)}
          </p>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={restoring}
          >
            Cancel
          </Button>
          <Button
            type="button"
            pending={restoring}
            disabled={
              Boolean(targetDatabaseNameError) || Boolean(resourceError) || !destinationAllowed
            }
            onClick={() => void restore()}
          >
            Queue restore
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Choice({
  label,
  value,
  onValueChange,
  options,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: BackupSelectionOption[];
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger aria-label={label}>
        <SelectValue placeholder={`Select ${label.toLowerCase()}`} />
      </SelectTrigger>
      <SelectContent className="w-[var(--radix-select-trigger-width)]">
        {options.map((option) => (
          <SelectItem
            key={option.id}
            value={option.id}
            disabled={Boolean(option.disabledReason)}
            description={option.disabledReason}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
