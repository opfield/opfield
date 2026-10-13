import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { assertComposeNetworkMutationAllowed } from './compose/compose-child.guard.js';
import { hasDockerResourceScope } from './docker-access-resource.service.js';
import { DockerNetworkAccessResourceService } from './docker-network-access-resource.service.js';
import { DockerSnapshotService } from './docker-snapshot.service.js';

/** Networks every container may start on: Docker's default bridge, no network, and the create default. */
const OPEN_CREATE_NETWORKS = new Set(['default', 'bridge', 'none']);

/**
 * Creating a container on a network joins that network, which the connect route allows only with
 * `docker:networks:edit` on the network and never for a Compose project's network. A create applies the same rule
 * to each requested network, so `docker:containers:create` alone cannot reach services on another team's or a
 * Compose project's network. Shared namespaces and Opfield-managed networks are refused by the create itself.
 */
export async function assertCreateNetworksAccess(
  scopes: readonly string[],
  nodeId: string,
  requested: readonly string[] | undefined
): Promise<void> {
  const names = (requested ?? [])
    .map((name) => name.trim())
    .filter((name) => name && !OPEN_CREATE_NETWORKS.has(name) && name !== 'host' && !name.includes(':'));
  if (names.length === 0) return;
  const snapshot = await container
    .resolve(DockerSnapshotService)
    .getList<Array<Record<string, unknown>>>(nodeId, 'networks');
  const known = (Array.isArray(snapshot.data) ? snapshot.data : []).map((item) => ({
    id: String(item.id ?? item.Id ?? ''),
    name: String(item.name ?? item.Name ?? ''),
  }));
  const nodeWide = hasDockerResourceScope([...scopes], 'docker:networks:edit', nodeId, '');
  for (const name of names) {
    // The same identifiers the create resolves: the name, the full ID or an unambiguous ID prefix.
    const exact = known.filter((network) => network.id === name || network.name === name);
    const matches = exact.length > 0 ? exact : known.filter((network) => network.id.startsWith(name));
    const networkId = matches.length === 1 ? matches[0]!.id : name;
    if (!nodeWide) {
      const resourceId = await container.resolve(DockerNetworkAccessResourceService).resolveNetwork(nodeId, networkId);
      if (!resourceId || !hasDockerResourceScope([...scopes], 'docker:networks:edit', nodeId, resourceId)) {
        throw new AppError(403, 'FORBIDDEN', `Missing docker:networks:edit for network ${name}`, {
          requiredScope: 'docker:networks:edit',
        });
      }
    }
    await assertComposeNetworkMutationAllowed(nodeId, networkId);
  }
}
