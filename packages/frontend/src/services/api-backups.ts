import type {
  BackupHistoryArtifactsAction,
  BackupHistoryDeleteResult,
  BackupPolicy,
  BackupPolicyInput,
  BackupRestoreInput,
  BackupRun,
} from "@/types/backups";
import type { ApiClientBaseConstructor } from "./api-mixins";

export function withBackupApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class BackupApiClient extends Base {
    listBackupPolicies(databaseId: string) {
      return this.unwrapData(
        this.request<{ data: BackupPolicy[] }>(
          `/databases/${encodeURIComponent(databaseId)}/backups/policies`
        )
      );
    }
    createBackupPolicy(databaseId: string, input: BackupPolicyInput) {
      return this.unwrapData(
        this.request<{ data: BackupPolicy }>(
          `/databases/${encodeURIComponent(databaseId)}/backups/policies`,
          { method: "POST", body: JSON.stringify(input) }
        )
      );
    }
    updateBackupPolicy(databaseId: string, policyId: string, input: BackupPolicyInput) {
      return this.unwrapData(
        this.request<{ data: BackupPolicy }>(
          `/databases/${encodeURIComponent(databaseId)}/backups/policies/${encodeURIComponent(policyId)}`,
          { method: "PUT", body: JSON.stringify(input) }
        )
      );
    }
    async deleteBackupPolicy(databaseId: string, policyId: string) {
      await this.request(
        `/databases/${encodeURIComponent(databaseId)}/backups/policies/${encodeURIComponent(policyId)}`,
        { method: "DELETE" }
      );
    }
    listBackupRuns(databaseId: string) {
      return this.unwrapData(
        this.request<{ data: BackupRun[] }>(
          `/databases/${encodeURIComponent(databaseId)}/backups/runs`
        )
      );
    }
    startBackup(databaseId: string, policyId: string) {
      return this.unwrapData(
        this.request<{ data: BackupRun }>(
          `/databases/${encodeURIComponent(databaseId)}/backups/policies/${encodeURIComponent(policyId)}/runs`,
          { method: "POST" }
        )
      );
    }
    restoreBackup(databaseId: string, runId: string, input: BackupRestoreInput) {
      return this.unwrapData(
        this.request<{ data: BackupRun }>(
          `/databases/${encodeURIComponent(databaseId)}/backups/runs/${encodeURIComponent(runId)}/restore`,
          { method: "POST", body: JSON.stringify(input) }
        )
      );
    }
    /**
     * A backup whose files still exist needs `artifacts`: "delete" removes the
     * files first, "forget" removes only the history entry.
     */
    deleteBackupHistory(
      databaseId: string,
      runId: string,
      options: { artifacts?: BackupHistoryArtifactsAction } = {}
    ) {
      const query = options.artifacts ? `?artifacts=${options.artifacts}` : "";
      return this.request<BackupHistoryDeleteResult>(
        `/databases/${encodeURIComponent(databaseId)}/backups/runs/${encodeURIComponent(runId)}${query}`,
        { method: "DELETE" }
      );
    }
    async cancelBackup(databaseId: string, runId: string, options: { force?: boolean } = {}) {
      await this.request(
        `/databases/${encodeURIComponent(databaseId)}/backups/runs/${encodeURIComponent(runId)}/cancel${options.force ? "?force=true" : ""}`,
        { method: "POST" }
      );
    }
    /** Backup and restore runs of deleted databases; their files are kept. */
    listOrphanedBackupRuns() {
      return this.unwrapData(
        this.request<{ data: BackupRun[] }>("/databases/backups/orphaned/runs")
      );
    }
    restoreOrphanedBackup(runId: string, input: BackupRestoreInput) {
      return this.unwrapData(
        this.request<{ data: BackupRun }>(
          `/databases/backups/orphaned/runs/${encodeURIComponent(runId)}/restore`,
          { method: "POST", body: JSON.stringify(input) }
        )
      );
    }
    deleteOrphanedBackupHistory(
      runId: string,
      options: { artifacts?: BackupHistoryArtifactsAction } = {}
    ) {
      const query = options.artifacts ? `?artifacts=${options.artifacts}` : "";
      return this.request<BackupHistoryDeleteResult>(
        `/databases/backups/orphaned/runs/${encodeURIComponent(runId)}${query}`,
        { method: "DELETE" }
      );
    }
    async cancelOrphanedBackup(runId: string, options: { force?: boolean } = {}) {
      await this.request(
        `/databases/backups/orphaned/runs/${encodeURIComponent(runId)}/cancel${options.force ? "?force=true" : ""}`,
        { method: "POST" }
      );
    }
  };
}
