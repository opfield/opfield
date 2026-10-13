import { and, eq, inArray, or } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { backupPolicies, backupRuns } from '@/db/schema/backups.js';
import { managedStorageClusters } from '@/db/schema/managed-storage.js';
import { AppError } from '@/middleware/error-handler.js';

/**
 * A migration write freeze (`freeze_writes`) makes every key Opfield issued on
 * a managed storage cluster read-only, but Opfield itself writes with the
 * cluster's root credentials. These helpers keep Opfield's own writers (object
 * browser, storage tools, MCP uploads, backups) from writing into a frozen
 * cluster, so nothing lands on it after the final copy. Copy jobs are exempt:
 * they are how the data moves.
 */

/**
 * The first frozen managed storage among these storage connections, or null.
 * With `lock`, the rows are read FOR SHARE: a freeze being decided (it holds
 * the cluster row FOR UPDATE) finishes first and its result is seen, so a
 * writer checking right before it starts cannot miss it. The rows are
 * selected by connection, not by frozen state, so the lock waits on them.
 */
export async function findFrozenManagedStorage(
  db: DrizzleExecutor,
  connectionIds: Array<string | null | undefined>,
  options: { lock?: boolean } = {}
): Promise<{ name: string; objectStorageConnectionId: string } | null> {
  const ids = [...new Set(connectionIds.filter((id): id is string => Boolean(id)))];
  if (!ids.length) return null;
  const query = db
    .select({
      name: managedStorageClusters.name,
      objectStorageConnectionId: managedStorageClusters.objectStorageConnectionId,
      writesFrozenAt: managedStorageClusters.writesFrozenAt,
    })
    .from(managedStorageClusters)
    .where(inArray(managedStorageClusters.objectStorageConnectionId, ids));
  const rows = options.lock ? await query.for('share') : await query;
  const frozen = rows.find((row) => row.writesFrozenAt && row.objectStorageConnectionId);
  return frozen ? { name: frozen.name, objectStorageConnectionId: frozen.objectStorageConnectionId! } : null;
}

/** 409 STORAGE_WRITES_FROZEN naming what was refused and how to proceed. */
export function storageWritesFrozenError(storageName: string, what: string) {
  return new AppError(
    409,
    'STORAGE_WRITES_FROZEN',
    `${what} refused: writes to managed storage "${storageName}" are frozen for a migration. Use the new storage, or lift the freeze with unfreeze_writes.`
  );
}

export async function assertStorageWritesNotFrozen(
  db: DrizzleExecutor,
  connectionIds: Array<string | null | undefined>,
  what: string
): Promise<void> {
  const frozen = await findFrozenManagedStorage(db, connectionIds);
  if (frozen) throw storageWritesFrozenError(frozen.name, what);
}

/**
 * Backup work that writes into this storage connection: queued or running
 * backups that use it as destination or staging, restores that stage there,
 * and enabled policies that will write there next.
 */
export async function backupWritesTo(db: DrizzleExecutor, connectionId: string) {
  const [runs, policies] = await Promise.all([
    db
      .select({ id: backupRuns.id })
      .from(backupRuns)
      .where(
        and(
          inArray(backupRuns.status, ['queued', 'running']),
          or(
            and(eq(backupRuns.destinationId, connectionId), eq(backupRuns.direction, 'backup')),
            eq(backupRuns.stagingStorageConnectionId, connectionId)
          )
        )
      ),
    db
      .select({ id: backupPolicies.id })
      .from(backupPolicies)
      .where(
        and(
          eq(backupPolicies.enabled, true),
          or(
            eq(backupPolicies.destinationId, connectionId),
            eq(backupPolicies.stagingStorageConnectionId, connectionId)
          )
        )
      ),
  ]);
  return { activeRunIds: runs.map((run) => run.id), enabledPolicyIds: policies.map((policy) => policy.id) };
}
