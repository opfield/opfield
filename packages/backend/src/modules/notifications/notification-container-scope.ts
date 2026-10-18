import { and, eq, inArray, isNotNull, like, or } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerAccessResources } from '@/db/schema/index.js';

/** A Docker runtime container id: 64 hex characters, or the 12-character short form (or longer prefix). */
const RUNTIME_ID = /^[0-9a-f]{12,64}$/;

/**
 * Container rules are scoped by container name, the stable identity every container alert is keyed by (a recreated
 * container keeps its name and gets a new runtime id). A runtime id given over the API or MCP is replaced by the name
 * of the container it belongs to; anything else is kept as given. Stand 2.12.6-rc.2, O-8.
 */
export async function containerScopeByName(db: DrizzleClient, resourceIds: readonly string[]): Promise<string[]> {
  const runtimeIds = [...new Set(resourceIds.filter((id) => RUNTIME_ID.test(id)))];
  if (runtimeIds.length === 0) return [...resourceIds];
  const rows = await db
    .select({ name: dockerAccessResources.resourceKey, runtimeId: dockerAccessResources.runtimeId })
    .from(dockerAccessResources)
    .where(
      and(
        eq(dockerAccessResources.resourceType, 'container'),
        isNotNull(dockerAccessResources.runtimeId),
        or(
          inArray(dockerAccessResources.runtimeId, runtimeIds),
          ...runtimeIds.map((id) => like(dockerAccessResources.runtimeId, `${id}%`))
        )
      )
    );
  const nameOf = (id: string) => rows.find((row) => row.runtimeId === id || row.runtimeId?.startsWith(id))?.name;
  return [...new Set(resourceIds.map((id) => (RUNTIME_ID.test(id) ? (nameOf(id) ?? id) : id)))];
}
