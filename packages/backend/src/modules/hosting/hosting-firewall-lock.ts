import { and, inArray, sql } from 'drizzle-orm';
import type { DrizzleTransaction } from '@/db/client.js';
import { hostingFirewalls } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';

/**
 * How long a lifecycle change waits for the firewall lock. The periodic firewall observation holds it while it reads
 * the provider (seconds); a delete or reboot that arrived then was refused at once with HOSTING_FIREWALL_BUSY.
 */
export const HOSTING_FIREWALL_LOCK_WAIT_MS = 30_000;

function busy(): AppError {
  return new AppError(409, 'HOSTING_FIREWALL_BUSY', 'Firewall is synchronizing; try again shortly');
}

/** PostgreSQL lock_not_available (55P03): lock_timeout ended the wait. */
function isLockTimeout(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 4; depth += 1) {
    if ((current as { code?: unknown }).code === '55P03') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Takes the transaction-scoped firewall lock of a hosting resource, waiting up to `waitMs` for a running firewall
 * synchronization to let it go (0: refuse at once). 409 HOSTING_FIREWALL_BUSY when it is still held then.
 */
export async function acquireHostingFirewallLock(
  tx: DrizzleTransaction,
  resourceId: string,
  waitMs = HOSTING_FIREWALL_LOCK_WAIT_MS
): Promise<void> {
  const key = `hosting-firewall:${resourceId}`;
  if (waitMs <= 0) {
    const lock = await tx.execute<{ acquired: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS acquired`
    );
    if (!lock.rows[0]?.acquired) throw busy();
    return;
  }
  const [previous] = (await tx.execute<{ value: string }>(sql`SELECT current_setting('lock_timeout') AS value`)).rows;
  await tx.execute(sql`SELECT set_config('lock_timeout', ${`${Math.round(waitMs)}ms`}, true)`);
  try {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
  } catch (error) {
    if (isLockTimeout(error)) throw busy();
    throw error;
  }
  await tx.execute(sql`SELECT set_config('lock_timeout', ${previous?.value ?? '0'}, true)`);
}

/**
 * Connector/node lifecycle and firewall writes must have one winner, even between the final fence and HTTP send.
 * `deleting`: the resources go away (a node or VM delete): firewall changes still pending or applying on them do not
 * hold the deletion back, the firewall worker finds the VM gone and ends them.
 */
export async function lockHostingFirewalls(
  tx: DrizzleTransaction,
  resourceIds: string[],
  options: { deleting?: boolean; waitMs?: number } = {}
): Promise<void> {
  const ids = [...new Set(resourceIds)].sort();
  if (!ids.length) return;
  for (const id of ids) await acquireHostingFirewallLock(tx, id, options.waitMs);
  if (options.deleting) return;
  const [active] = await tx
    .select({ id: hostingFirewalls.resourceId })
    .from(hostingFirewalls)
    .where(and(inArray(hostingFirewalls.resourceId, ids), inArray(hostingFirewalls.status, ['pending', 'applying'])))
    .limit(1);
  if (active)
    throw new AppError(
      409,
      'HOSTING_FIREWALL_BUSY',
      'Wait for firewall changes to finish before changing this resource'
    );
}
