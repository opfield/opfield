import { and, eq, isNull, not, notInArray, or, sql } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { backupPolicies, backupRuns } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { assertStorageHasNoActiveCopyJobs } from '@/modules/storage/storage-copy-references.js';

/**
 * What to do with finished backup history when its storage is deleted. History
 * blocks deletion unless the caller explicitly chooses `forget`: the records are
 * removed, Opfield can no longer restore or delete those backups, and their files
 * stay where they are (or go with a deleted managed storage).
 */
export type StorageBackupHistoryDisposition = 'forget';

export interface StorageBackupHistoryOptions {
  backupHistory?: StorageBackupHistoryDisposition;
}

const ACTIVE_RUN_STATUSES = ['queued', 'running'] as const;

function referencesConnection(connectionId: string) {
  return or(eq(backupRuns.destinationId, connectionId), eq(backupRuns.stagingStorageConnectionId, connectionId));
}

function finishedRun() {
  return and(notInArray(backupRuns.status, [...ACTIVE_RUN_STATUSES]), eq(backupRuns.runtimeCleanupPending, false));
}

/**
 * Finished history of a deleted database. It is kept with its files and stays
 * restorable (the history of deleted databases), but it does not keep a bucket:
 * deleting the bucket deletes those files and then this history.
 */
function orphanedFinishedRun() {
  return and(isNull(backupRuns.databaseConnectionId), finishedRun());
}

/**
 * Check before destructive runtime teardown; database FKs also close concurrent creation races.
 * Policies and active runs always block. Finished history blocks unless `backupHistory: 'forget'`
 * is passed; the caller then removes it with {@link forgetStorageBackupHistory} in the same
 * transaction that deletes the storage.
 */
export async function assertStorageHasNoBackupReferences(
  db: DrizzleExecutor,
  connectionId: string,
  options: StorageBackupHistoryOptions = {}
) {
  const [policies, runs] = await Promise.all([
    db
      .select({ id: backupPolicies.id })
      .from(backupPolicies)
      .where(
        or(eq(backupPolicies.destinationId, connectionId), eq(backupPolicies.stagingStorageConnectionId, connectionId))
      ),
    db
      .select({
        status: backupRuns.status,
        runtimeCleanupPending: backupRuns.runtimeCleanupPending,
        hasFiles: sql<boolean>`(${backupRuns.manifest} is not null and ${backupRuns.artifactsDeletedAt} is null)`,
      })
      .from(backupRuns)
      .where(referencesConnection(connectionId)),
  ]);
  const activeRuns = runs.filter(
    (run) => (ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status) || run.runtimeCleanupPending
  ).length;
  if (policies.length || activeRuns)
    throw new AppError(
      409,
      'STORAGE_REFERENCED_BY_BACKUPS',
      policies.length
        ? 'Storage is used by backup policies. Delete those policies or move them to other storage before deleting it.'
        : 'Storage is used by backup runs that are still active or cleaning up. Wait for them to finish before deleting it.',
      { policies: policies.length, activeRuns }
    );
  await assertStorageHasNoActiveCopyJobs(db, connectionId);
  const historyRecords = runs.length;
  if (historyRecords === 0 || options.backupHistory === 'forget') return;
  const backupsWithFiles = runs.filter((run) => run.hasFiles).length;
  throw new AppError(
    409,
    'STORAGE_BACKUP_HISTORY_EXISTS',
    backupsWithFiles
      ? `Storage is referenced by ${historyRecords} backup history record(s), ${backupsWithFiles} of them with backup files. Delete those backups first, or confirm forgetting the history.`
      : `Storage is referenced by ${historyRecords} backup history record(s). Confirm forgetting the history to delete it.`,
    { historyRecords, backupsWithFiles }
  );
}

/**
 * Remove finished backup history that uses this storage as destination or staging.
 * Call inside the transaction that deletes the storage, after
 * {@link assertStorageHasNoBackupReferences} with `backupHistory: 'forget'`.
 * The returned locations are for the audit log: the files there are not deleted.
 */
export async function forgetStorageBackupHistory(db: DrizzleExecutor, connectionId: string) {
  const removed = await db
    .delete(backupRuns)
    .where(and(referencesConnection(connectionId), finishedRun()))
    .returning({
      id: backupRuns.id,
      destinationId: backupRuns.destinationId,
      destinationBucket: backupRuns.destinationBucket,
      ownedPrefix: sql<string | null>`${backupRuns.manifest}->>'ownedPrefix'`,
      artifactsDeletedAt: backupRuns.artifactsDeletedAt,
    });
  const withFiles = removed.filter((run) => run.ownedPrefix && !run.artifactsDeletedAt);
  return {
    historyRecords: removed.length,
    backupsWithFiles: withFiles.length,
    // Bounded so a long history cannot bloat one audit entry.
    keptFiles: withFiles.slice(0, 50).map((run) => ({
      runId: run.id,
      storageId: run.destinationId,
      bucket: run.destinationBucket,
      prefix: run.ownedPrefix,
    })),
  };
}

/**
 * Check before deleting one bucket: backup history and policies read and write through it by name. History of
 * deleted databases does not count (see {@link forgetOrphanedBucketBackupHistory}).
 */
export async function assertStorageBucketHasNoBackupReferences(
  db: DrizzleExecutor,
  connectionId: string,
  bucket: string
) {
  const [policies, runs] = await Promise.all([
    db
      .select({ id: backupPolicies.id })
      .from(backupPolicies)
      .where(
        or(
          and(eq(backupPolicies.destinationId, connectionId), eq(backupPolicies.bucket, bucket)),
          and(eq(backupPolicies.stagingStorageConnectionId, connectionId), eq(backupPolicies.stagingBucket, bucket))
        )
      )
      .limit(1),
    db
      .select({ id: backupRuns.id })
      .from(backupRuns)
      .where(
        and(
          or(
            and(eq(backupRuns.destinationId, connectionId), eq(backupRuns.destinationBucket, bucket)),
            and(eq(backupRuns.stagingStorageConnectionId, connectionId), eq(backupRuns.stagingBucket, bucket))
          ),
          not(orphanedFinishedRun()!)
        )
      )
      .limit(1),
  ]);
  if (policies.length || runs.length)
    throw new AppError(
      409,
      'STORAGE_BUCKET_REFERENCED_BY_BACKUPS',
      'Bucket is referenced by backup policies or retained history. Remove those references before deleting it.'
    );
}

/**
 * After a bucket was deleted: removes the finished history of deleted databases whose backup files were in it.
 * Nothing could reach that history any more, and its files went with the bucket. Returns how many records it removed.
 */
export async function forgetOrphanedBucketBackupHistory(db: DrizzleExecutor, connectionId: string, bucket: string) {
  const removed = await db
    .delete(backupRuns)
    .where(
      and(eq(backupRuns.destinationId, connectionId), eq(backupRuns.destinationBucket, bucket), orphanedFinishedRun())
    )
    .returning({ id: backupRuns.id });
  return removed.length;
}

/** Reads the target storage for {@link rehomeStorageBackupHistory}; both may throw, which counts as missing. */
export interface BackupHistoryRehomeProbe {
  /** Size of one object in the target storage. */
  objectSize(bucket: string, key: string): Promise<number>;
  bucketExists(bucket: string): Promise<boolean>;
}

export interface BackupHistoryRehomeResult {
  dryRun: boolean;
  /** Finished runs that referenced the source storage. */
  historyRecords: number;
  /** Runs now pointing at the target (or that would, on a dry run). */
  rehomed: number;
  /** Artifact objects found in the target with the size their manifest recorded. */
  verifiedArtifacts: number;
  /** Runs left on the source, with the first reason found. */
  blocked: Array<{ runId: string; reason: string; bucket?: string | null; key?: string }>;
  /** Backup policies that still write to the source; move them with the backup policy update first. */
  policiesStillUsingSource: number;
}

const REHOME_BLOCKED_REPORT_LIMIT = 100;

/**
 * Move finished backup history from one storage connection to another after
 * its files were copied there (for example by a storage copy job), so the
 * source can be deleted without forgetting the history.
 *
 * A run keeps its bucket and keys; only the storage it points at changes. A
 * run whose files still exist moves only when every artifact of its manifest
 * is in the target, in the same bucket and key, with the size the manifest
 * recorded; restore verifies the checksums again. Staging references move when
 * the staging bucket exists in the target (staging only holds scratch data). A
 * run moves completely or not at all, and blocked runs are reported. Active
 * runs refuse the whole operation; policies are not changed here.
 */
export async function rehomeStorageBackupHistory(
  db: DrizzleExecutor,
  sourceConnectionId: string,
  targetConnectionId: string,
  probe: BackupHistoryRehomeProbe,
  options: { dryRun?: boolean } = {}
): Promise<BackupHistoryRehomeResult> {
  if (sourceConnectionId === targetConnectionId)
    throw new AppError(400, 'BACKUP_HISTORY_SAME_STORAGE', 'Choose a different storage to move the backup history to');
  const [policies, runs] = await Promise.all([
    db
      .select({ id: backupPolicies.id })
      .from(backupPolicies)
      .where(
        or(
          eq(backupPolicies.destinationId, sourceConnectionId),
          eq(backupPolicies.stagingStorageConnectionId, sourceConnectionId)
        )
      ),
    db
      .select({
        id: backupRuns.id,
        status: backupRuns.status,
        runtimeCleanupPending: backupRuns.runtimeCleanupPending,
        destinationId: backupRuns.destinationId,
        destinationBucket: backupRuns.destinationBucket,
        stagingStorageConnectionId: backupRuns.stagingStorageConnectionId,
        stagingBucket: backupRuns.stagingBucket,
        manifest: backupRuns.manifest,
        artifactsDeletedAt: backupRuns.artifactsDeletedAt,
      })
      .from(backupRuns)
      .where(referencesConnection(sourceConnectionId)),
  ]);
  const activeRuns = runs.filter(
    (run) => (ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status) || run.runtimeCleanupPending
  ).length;
  if (activeRuns)
    throw new AppError(
      409,
      'STORAGE_REFERENCED_BY_BACKUPS',
      'Backup runs that use this storage are still active or cleaning up. Wait for them to finish before moving the history.',
      { activeRuns }
    );

  const result: BackupHistoryRehomeResult = {
    dryRun: options.dryRun === true,
    historyRecords: runs.length,
    rehomed: 0,
    verifiedArtifacts: 0,
    blocked: [],
    policiesStillUsingSource: policies.length,
  };
  const block = (entry: BackupHistoryRehomeResult['blocked'][number]) => {
    if (result.blocked.length < REHOME_BLOCKED_REPORT_LIMIT) result.blocked.push(entry);
  };
  const buckets = new Map<string, Promise<boolean>>();
  const bucketExists = (bucket: string) => {
    let known = buckets.get(bucket);
    if (!known) {
      known = probe.bucketExists(bucket).catch(() => false);
      buckets.set(bucket, known);
    }
    return known;
  };

  for (const run of runs) {
    const moveDestination = run.destinationId === sourceConnectionId;
    const moveStaging = run.stagingStorageConnectionId === sourceConnectionId;
    let verified = 0;
    let blocked = false;
    if (moveDestination && run.manifest && !run.artifactsDeletedAt) {
      for (const key of run.manifest.artifactKeys) {
        let size: number | null = null;
        let reason = 'artifact is missing in the target storage';
        try {
          size = await probe.objectSize(run.destinationBucket, key);
        } catch (error) {
          if (error instanceof Error && error.message)
            reason = `artifact is missing in the target storage: ${error.message}`;
        }
        const expected = run.manifest.sizes?.[key];
        if (size === null || (typeof expected === 'number' && size !== expected)) {
          block({
            runId: run.id,
            reason:
              size === null
                ? reason
                : `artifact size in the target storage is ${size} bytes, the manifest has ${expected}`,
            bucket: run.destinationBucket,
            key,
          });
          blocked = true;
          break;
        }
        verified += 1;
      }
    } else if (moveDestination && !(await bucketExists(run.destinationBucket))) {
      // History without files still names its bucket; restore and cleanup use it.
      block({
        runId: run.id,
        reason: 'destination bucket is missing in the target storage',
        bucket: run.destinationBucket,
      });
      blocked = true;
    }
    if (!blocked && moveStaging && (!run.stagingBucket || !(await bucketExists(run.stagingBucket)))) {
      block({ runId: run.id, reason: 'staging bucket is missing in the target storage', bucket: run.stagingBucket });
      blocked = true;
    }
    if (blocked) continue;
    result.verifiedArtifacts += verified;
    if (!result.dryRun) {
      const moved = await db
        .update(backupRuns)
        .set({
          ...(moveDestination ? { destinationId: targetConnectionId } : {}),
          ...(moveStaging ? { stagingStorageConnectionId: targetConnectionId } : {}),
        })
        .where(and(eq(backupRuns.id, run.id), referencesConnection(sourceConnectionId), finishedRun()))
        .returning({ id: backupRuns.id });
      if (!moved.length) {
        block({ runId: run.id, reason: 'backup run changed while the history was being moved' });
        continue;
      }
    }
    result.rehomed += 1;
  }
  return result;
}
