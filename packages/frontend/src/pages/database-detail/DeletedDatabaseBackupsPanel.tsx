import { History } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { toastApiError } from "@/lib/api-error-toast";
import { databaseTypeLabel } from "@/lib/database-type";
import { listManagedDatabaseCandidateNodes } from "@/lib/managed-database-nodes";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { BackupRun } from "@/types/backups";
import {
  type BackupRunApi,
  type BackupSelectionOption,
  backupExecutorOptions,
  RestoreDialog,
  useBackupRunActions,
  useBackupRunColumns,
} from "./DatabaseBackupsTab";

const runApi: BackupRunApi = {
  deleteHistory: (runId, options) => api.deleteOrphanedBackupHistory(runId, options),
  cancel: (runId, options) => api.cancelOrphanedBackup(runId, options),
};

const leadingColumns: DataTableColumn<BackupRun>[] = [
  {
    key: "database",
    header: "Database",
    render: (run) => (
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          {run.databaseConnectionName ?? "Deleted database"}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {databaseTypeLabel(run.engine)}
          {run.manifest?.engineVersion ? ` · ${run.manifest.engineVersion}` : ""}
        </p>
      </div>
    ),
  },
];

/**
 * Backups whose database was deleted: Gateway keeps their history and files. Shown on the
 * Databases page to callers with the unscoped backup view scope (deleting a database removes the
 * grants that name it), and only when there is such history.
 */
export function DeletedDatabaseBackupsPanel() {
  const hasScope = useAuthStore((state) => state.hasScope);
  const canView = hasScope("databases:backups:view");
  const canManage = hasScope("databases:backups:manage");
  const canRun = hasScope("databases:backups:run");
  const canRestore = hasScope("databases:backups:restore");
  const [runs, setRuns] = useState<BackupRun[]>([]);
  const [restoreRun, setRestoreRun] = useState<BackupRun | null>(null);
  const [executors, setExecutors] = useState<BackupSelectionOption[]>([]);
  const refresh = useCallback(async () => {
    try {
      setRuns(await api.listOrphanedBackupRuns());
    } catch {
      // Without the backup module there is no such history; the panel stays hidden.
      setRuns([]);
    }
  }, []);
  useEffect(() => {
    if (canView) void refresh();
  }, [canView, refresh]);
  useEffect(() => {
    if (!runs.some((run) => run.status === "queued" || run.status === "running")) return;
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [runs, refresh]);
  useEffect(() => {
    if (!restoreRun) return;
    let current = true;
    void listManagedDatabaseCandidateNodes(200)
      .then((nodes) => {
        if (current) setExecutors(backupExecutorOptions(nodes, hasScope));
      })
      .catch((error) => toastApiError(error, "Failed to load Storage nodes"));
    return () => {
      current = false;
    };
  }, [restoreRun, hasScope]);
  const { deleteHistory, cancel } = useBackupRunActions(runApi, refresh);
  const columns = useBackupRunColumns({
    canRestore,
    canRun,
    canManage,
    onRestore: setRestoreRun,
    deleteHistory,
    cancel,
    leadingColumns,
  });
  if (!canView || runs.length === 0) return null;
  return (
    <>
      <PanelShell
        icon={<History className="h-4 w-4" />}
        title="Backups of deleted databases"
        description="Backup history kept after its database was deleted. A backup restores into a new database."
        bodyClassName="p-0"
      >
        <DataTable
          columns={columns}
          data={runs}
          keyFn={(run) => run.id}
          emptyMessage="No backups of deleted databases."
          embedded
          horizontalScroll
          minWidth="60rem"
        />
      </PanelShell>
      <RestoreDialog
        run={restoreRun}
        onOpenChange={(open) => !open && setRestoreRun(null)}
        executors={executors}
        onRestore={async (input) => {
          if (!restoreRun) return;
          await api.restoreOrphanedBackup(restoreRun.id, input);
          toast.success("Restore queued");
          setRestoreRun(null);
          await refresh();
        }}
      />
    </>
  );
}
