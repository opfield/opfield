import type { DrizzleExecutor } from '@/db/client.js';
import { assertFolderDomainsAllowed } from '@/modules/apps/app-domain-allowlist.js';
import { assertAppPlacement } from '@/modules/apps/app-placement-guard.js';
import { ingressGroupMemberRows } from '@/modules/ingress-groups/ingress-nodes.js';

/** A domain created in an app environment folder: its name must match the environment's domain allowlist. */
export async function assertDomainAllowedInFolder(
  db: DrizzleExecutor,
  folderId: string | null | undefined,
  domainName: string
): Promise<void> {
  await assertFolderDomainsAllowed(db, 'domains', folderId, [domainName]);
}

/**
 * A domain created in an app environment folder is served only by nodes the environment allows (every member of an
 * ingress group) and never lands in an environment isolated by the kill switch. No-op outside apps.
 */
export async function assertDomainNodesAllowedInFolder(
  db: DrizzleExecutor,
  folderId: string | null | undefined,
  placement: { nginxNode: { id: string }; ingressGroupId: string | null }
): Promise<void> {
  if (!folderId) return;
  const nodeIds = placement.ingressGroupId
    ? (await ingressGroupMemberRows(db, placement.ingressGroupId)).map((member) => member.nodeId)
    : [placement.nginxNode.id];
  await assertAppPlacement(db, 'domains', folderId, nodeIds);
}
