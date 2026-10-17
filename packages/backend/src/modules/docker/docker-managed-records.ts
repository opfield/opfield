import { and, eq, isNotNull } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerAccessResources,
  dockerComposeProjects,
  dockerDeploymentSlots,
  dockerDeployments,
  dockerManagedVolumes,
  dockerSourceBindings,
} from '@/db/schema/index.js';
import { LEGACY_COM_LABEL_PREFIX, LEGACY_LABEL_PREFIX, LEGACY_NET_LABEL_PREFIX } from '@/lib/legacy-compat.js';

/**
 * What Opfield's records say it manages on a Docker node, whether or not the objects exist right now: the
 * containers it gave an access identity (by name and runtime), the names its Git sources and deployments keep, its
 * Compose projects, managed volumes and deployment networks.
 */
export interface DockerManagedRecords {
  recordedNames: Set<string>;
  recordedIds: Set<string>;
  /** Container names kept for a Git source or a deployment (slot and router containers), with their owner. */
  reservedNames: Map<string, string>;
  /** Container names a Git source deploys to, with the source binding ID. */
  sourceContainers: Map<string, string>;
  composeProjects: Set<string>;
  volumes: Set<string>;
  networks: Set<string>;
}

export async function loadDockerManagedRecords(db: DrizzleClient, nodeId: string): Promise<DockerManagedRecords> {
  const [identities, sources, deployments, slots, projects, volumes] = await Promise.all([
    db
      .select({ name: dockerAccessResources.resourceKey, runtimeId: dockerAccessResources.runtimeId })
      .from(dockerAccessResources)
      .where(
        and(
          eq(dockerAccessResources.nodeId, nodeId),
          eq(dockerAccessResources.resourceType, 'container'),
          isNotNull(dockerAccessResources.runtimeId)
        )
      ),
    db
      .select({ id: dockerSourceBindings.id, name: dockerSourceBindings.containerName })
      .from(dockerSourceBindings)
      .where(and(eq(dockerSourceBindings.nodeId, nodeId), eq(dockerSourceBindings.targetKind, 'container'))),
    db
      .select({
        name: dockerDeployments.name,
        routerName: dockerDeployments.routerName,
        networkName: dockerDeployments.networkName,
      })
      .from(dockerDeployments)
      .where(eq(dockerDeployments.nodeId, nodeId)),
    db
      .select({ name: dockerDeploymentSlots.containerName, deployment: dockerDeployments.name })
      .from(dockerDeploymentSlots)
      .innerJoin(dockerDeployments, eq(dockerDeployments.id, dockerDeploymentSlots.deploymentId))
      .where(eq(dockerDeployments.nodeId, nodeId)),
    db
      .select({ name: dockerComposeProjects.name })
      .from(dockerComposeProjects)
      .where(eq(dockerComposeProjects.nodeId, nodeId)),
    db
      .select({ name: dockerManagedVolumes.volumeName })
      .from(dockerManagedVolumes)
      .where(eq(dockerManagedVolumes.nodeId, nodeId)),
  ]);
  const records: DockerManagedRecords = {
    recordedNames: new Set(),
    recordedIds: new Set(),
    reservedNames: new Map(),
    sourceContainers: new Map(),
    composeProjects: new Set(projects.map((row) => row.name)),
    volumes: new Set(volumes.map((row) => row.name)),
    networks: new Set(),
  };
  for (const row of identities) {
    records.recordedNames.add(row.name);
    if (row.runtimeId) records.recordedIds.add(row.runtimeId);
  }
  for (const row of sources) {
    if (!row.name) continue;
    records.reservedNames.set(row.name, 'its Git source');
    records.sourceContainers.set(row.name, row.id);
  }
  for (const row of deployments) {
    records.reservedNames.set(row.name, `deployment "${row.name}"`);
    records.reservedNames.set(row.routerName, `deployment "${row.name}"`);
    records.networks.add(row.networkName);
  }
  for (const row of slots) records.reservedNames.set(row.name, `deployment "${row.deployment}"`);
  return records;
}

// legacy-name: pre-2.12.1 labels — remove once every node reports none
const OPFIELD_LABEL = new RegExp(
  `^(?:${['net.opfield.', LEGACY_LABEL_PREFIX, LEGACY_NET_LABEL_PREFIX, LEGACY_COM_LABEL_PREFIX].map((prefix) => prefix.replaceAll('.', '\\.')).join('|')})`
);

/** Whether a Docker object carries an Opfield label (either namespace). */
export function hasOpfieldLabel(labels: Record<string, string>): boolean {
  return Object.keys(labels).some((key) => OPFIELD_LABEL.test(key));
}
