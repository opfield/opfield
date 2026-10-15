import { and, desc, eq, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { auditLog } from '@/db/schema/index.js';
import { DOCKER_EXTERNAL_CHANGE_AUDIT_ACTION } from './docker-external-changes.service.js';

const CHANGE_WORDS: Record<string, string> = {
  removed: 'removed',
  created: 'created again under its name',
  renamed: 'renamed',
};

/**
 * A sentence for a build or rollout error about a container whose last change was made outside Opfield (the
 * node's Docker daemon reported it), or null when Opfield knows of none. A lookup failure is null too: the error
 * it would complete must still be reported.
 */
export async function externalContainerChangeNote(
  db: DrizzleClient,
  nodeId: string,
  containerName: string
): Promise<string | null> {
  try {
    const [row] = await db
      .select({ createdAt: auditLog.createdAt, details: auditLog.details })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, DOCKER_EXTERNAL_CHANGE_AUDIT_ACTION),
          sql`${auditLog.details}->>'nodeId' = ${nodeId}`,
          sql`(${auditLog.details}->>'name' = ${containerName} OR ${auditLog.details}->>'oldName' = ${containerName})`
        )
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    if (!row) return null;
    const change = String(row.details?.change ?? '');
    const when = row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt);
    return `Container "${containerName}" was ${CHANGE_WORDS[change] ?? 'changed'} outside Opfield at ${when} (docker on the node or another tool; see the audit log).`;
  } catch {
    return null;
  }
}
