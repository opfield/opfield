import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { auditLog } from '@/db/schema/index.js';

/**
 * Whether a container that does not run was stopped on request or crashed. The app health, the Docker health check
 * and a Git build rollout (which leaves a container stopped on request stopped, but restarts a crashed one) share
 * these rules.
 */

/** Docker's exit code from a container list status ("Exited (137) 3 minutes ago"), or null. */
export function containerExitCode(status: string | null | undefined): number | null {
  const match = /^exited\s*\((-?\d+)\)/i.exec(String(status ?? '').trim());
  return match ? Number(match[1]) : null;
}

/**
 * Whether an exited container was stopped on request rather than crashed. A stop (Opfield, the API, MCP or
 * `docker stop`) sends the stop signal and, after the timeout, SIGKILL: the process exits 0 or with the signal's code
 * (130 SIGINT, 143 SIGTERM, 137 SIGKILL; `docker kill` is 137 too). A process that crashes exits with another code; a
 * kernel OOM kill is also 137 but Docker marks it OOMKilled, so 137 counts as a stop only when the inspect says it was
 * not one (unknown is a crash).
 */
export function stoppedOnRequest(exitCode: number | null, oomKilled: boolean | null | undefined): boolean {
  if (exitCode === null || oomKilled === true) return false;
  if (exitCode === 0 || exitCode === 130 || exitCode === 143) return true;
  return exitCode === 137 && oomKilled === false;
}

/**
 * The same judgement from a container's inspect: created and never started (or recreated stopped) is stopped; exited
 * is stopped when its exit was a stop; running, restarting, dead or anything else is not.
 */
export function inspectStoppedOnRequest(inspect: { State?: Record<string, unknown> | null } | null | undefined) {
  const state = inspect?.State ?? {};
  const status = String(state.Status ?? '').toLowerCase();
  if (status === 'created') return true;
  if (status !== 'exited') return false;
  const exitCode = typeof state.ExitCode === 'number' && Number.isInteger(state.ExitCode) ? state.ExitCode : null;
  const oomKilled = typeof state.OOMKilled === 'boolean' ? state.OOMKilled : null;
  return stoppedOnRequest(exitCode, oomKilled);
}

/**
 * Whether the last lifecycle action Opfield recorded for a container (by its name and runtime IDs) is a Stop. A
 * runtime's exited/offline state is not stop intent: only a successful, explicit Stop after its last
 * Start/Restart/Create/Kill/Remove/running Recreate qualifies.
 */
export async function lastLifecycleIsStop(db: DrizzleClient, nodeId: string, runtimeIds: string[]): Promise<boolean> {
  const [lastLifecycle] = await db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.resourceType, 'docker-container'),
        inArray(auditLog.resourceId, runtimeIds),
        sql`${auditLog.details}->>'nodeId' = ${nodeId}`,
        // A recreate that kept the container stopped (a build rollout or a settings change on a stopped container)
        // is no lifecycle change: the Stop before it still holds.
        sql`not (${auditLog.action} = 'docker.container.recreate' and coalesce(${auditLog.details}->>'expectedState', '') = 'created')`,
        inArray(auditLog.action, [
          'docker.container.stop',
          'docker.container.start',
          'docker.container.restart',
          'docker.container.create',
          'docker.container.recreate',
          'docker.container.kill',
          'docker.container.remove',
        ])
      )
    )
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(1);
  return lastLifecycle?.action === 'docker.container.stop';
}
