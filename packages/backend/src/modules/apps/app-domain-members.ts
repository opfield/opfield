import { eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { domains, ingressGroupMembers } from '@/db/schema/index.js';

/** A domain as an app member: served by its ingress node, or every member of its ingress group. */
export interface DomainMemberRow {
  id: string;
  name: string;
  folderId: string | null;
  nodeIds: string[];
  isSystem: boolean;
}

async function groupNodeIds(db: DrizzleClient, groupIds: readonly string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const unique = [...new Set(groupIds)];
  if (unique.length === 0) return result;
  const rows = await db
    .select({ groupId: ingressGroupMembers.groupId, nodeId: ingressGroupMembers.nodeId })
    .from(ingressGroupMembers)
    .where(inArray(ingressGroupMembers.groupId, unique));
  for (const row of rows) result.set(row.groupId, [...(result.get(row.groupId) ?? []), row.nodeId]);
  return result;
}

function toMemberRows(
  rows: ReadonlyArray<{
    id: string;
    domain: string;
    folderId: string | null;
    nginxNodeId: string | null;
    ingressGroupId: string | null;
    isSystem: boolean;
  }>,
  groups: ReadonlyMap<string, string[]>
): DomainMemberRow[] {
  return rows.map((row) => ({
    id: row.id,
    name: row.domain,
    folderId: row.folderId,
    nodeIds: row.ingressGroupId ? (groups.get(row.ingressGroupId) ?? []) : row.nginxNodeId ? [row.nginxNodeId] : [],
    isSystem: row.isSystem,
  }));
}

const DOMAIN_MEMBER_COLUMNS = {
  id: domains.id,
  domain: domains.domain,
  folderId: domains.folderId,
  nginxNodeId: domains.nginxNodeId,
  ingressGroupId: domains.ingressGroupId,
  isSystem: domains.isSystem,
};

/** Domains in the given (hidden environment) folders. */
export async function domainsInFolders(db: DrizzleClient, folderIds: readonly string[]): Promise<DomainMemberRow[]> {
  if (folderIds.length === 0) return [];
  const rows = await db
    .select(DOMAIN_MEMBER_COLUMNS)
    .from(domains)
    .where(inArray(domains.folderId, [...folderIds]));
  return toMemberRows(rows, await groupNodeIds(db, rows.map((row) => row.ingressGroupId).filter(isString)));
}

/** One domain by id (null when it does not exist). */
export async function domainMemberById(db: DrizzleClient, id: string): Promise<DomainMemberRow | null> {
  const [row] = await db.select(DOMAIN_MEMBER_COLUMNS).from(domains).where(eq(domains.id, id)).limit(1);
  if (!row) return null;
  return toMemberRows([row], await groupNodeIds(db, row.ingressGroupId ? [row.ingressGroupId] : []))[0] ?? null;
}

function isString(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0;
}
