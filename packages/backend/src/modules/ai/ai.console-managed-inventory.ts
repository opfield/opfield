import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { nodes } from '@/db/schema/index.js';
import { labelString } from '@/modules/docker/docker-managed-labels.js';
import { hasOpfieldLabel, loadDockerManagedRecords } from '@/modules/docker/docker-managed-records.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';

/** How Opfield runs a managed container, which decides the tool an agent uses to change it. */
export type ManagedContainerKind = 'container' | 'deployment' | 'compose' | 'database' | 'storage' | 'internal';

export interface InventoryContainer {
  id: string;
  name: string;
  managed: boolean;
  kind: ManagedContainerKind;
  project: string | null;
  ports: number[];
}

/** The Docker objects of one node that Opfield manages, as the console guard checks them. */
export interface ManagedInventory {
  /** Every container on the node; null when the node's daemon could not list them. */
  containers: InventoryContainer[] | null;
  /** Names Opfield keeps for a container that may not exist right now (Git sources, deployments), with their owner. */
  reservedNames: Map<string, string>;
  /** Container names and runtime IDs Opfield's records hold for this node. */
  recordedNames: Set<string>;
  recordedIds: Set<string>;
  composeProjects: Set<string>;
  /** Names and IDs of managed volumes and networks (filled only when the command touches them). */
  volumes: Set<string>;
  networks: Set<string>;
  /** Storage, database and builder nodes: Opfield runs every Docker object on them. */
  allManaged: boolean;
  /** Nodes without Opfield Docker workloads (nginx, monitoring, ...): only the daemon state paths are protected. */
  noDocker: boolean;
}

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const LIST_TIMEOUT_MS = 10_000;
const INTERNAL_DOCKER_NODE_TYPES = new Set(['storage', 'databases', 'builder']);

type Labels = Record<string, string>;

function labelsOf(value: unknown): Labels {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => {
      return typeof entry[1] === 'string';
    })
  );
}

function containerKind(labels: Labels, managedProject: boolean): ManagedContainerKind {
  if (labelString(labels, 'deployment.id')) return 'deployment';
  if (managedProject || labelString(labels, 'compose.project-id')) return 'compose';
  if (labelString(labels, 'managed-database.id')) return 'database';
  if (labelString(labels, 'managed-storage.id')) return 'storage';
  if (hasOpfieldLabel(labels)) return 'internal';
  return 'container';
}

function parseList(result: { success: boolean; detail?: string; error?: string }): Record<string, unknown>[] | null {
  if (!result.success || !result.detail) return null;
  try {
    const value = JSON.parse(result.detail);
    return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : null;
  } catch {
    return null;
  }
}

async function liveList(load: () => Promise<{ success: boolean; detail?: string; error?: string }>) {
  try {
    return parseList(await load());
  } catch {
    return null;
  }
}

export interface InventoryNeeds {
  volumes: boolean;
  networks: boolean;
}

/**
 * Reads what Opfield manages on a node: its records (container identities, Git sources, deployments, Compose
 * projects, managed volumes) and the node's live containers, volumes and networks with their labels. A container
 * is managed when Opfield's records know it (by name or runtime) or it carries an Opfield label or belongs to a
 * managed Compose project; a volume or network when it is labelled or recorded as managed or a managed container
 * uses it.
 */
export async function loadManagedInventory(
  db: DrizzleClient,
  dispatch: Pick<
    NodeDispatchService,
    'sendDockerContainerCommand' | 'sendDockerVolumeCommand' | 'sendDockerNetworkCommand'
  >,
  nodeId: string,
  needs: InventoryNeeds
): Promise<ManagedInventory> {
  const inventory: ManagedInventory = {
    containers: null,
    reservedNames: new Map(),
    recordedNames: new Set(),
    recordedIds: new Set(),
    composeProjects: new Set(),
    volumes: new Set(),
    networks: new Set(),
    allManaged: false,
    noDocker: false,
  };
  const [node] = await db
    .select({ type: nodes.type, capabilities: nodes.capabilities })
    .from(nodes)
    .where(eq(nodes.id, nodeId))
    .limit(1);
  const daemonType = (node?.capabilities as { daemonType?: unknown } | null)?.daemonType;
  if (node && node.type !== 'docker') {
    if (!INTERNAL_DOCKER_NODE_TYPES.has(node.type) && daemonType !== 'docker') {
      inventory.noDocker = true;
      return inventory;
    }
    inventory.allManaged = true;
  }

  const records = await loadDockerManagedRecords(db, nodeId);
  inventory.recordedNames = records.recordedNames;
  inventory.recordedIds = records.recordedIds;
  inventory.reservedNames = records.reservedNames;
  inventory.composeProjects = records.composeProjects;
  inventory.volumes = records.volumes;
  inventory.networks = records.networks;

  const listed = await liveList(() => dispatch.sendDockerContainerCommand(nodeId, 'list', {}, LIST_TIMEOUT_MS));
  if (listed) {
    inventory.containers = listed.map((item) => {
      const labels = labelsOf(item.labels ?? item.Labels);
      const id = String(item.id ?? item.Id ?? '');
      const name = String(item.name ?? item.Name ?? '').replace(/^\/+/, '');
      const project = labels[COMPOSE_PROJECT_LABEL] ?? null;
      const managedProject = !!project && inventory.composeProjects.has(project);
      const managed =
        inventory.allManaged ||
        hasOpfieldLabel(labels) ||
        managedProject ||
        inventory.recordedNames.has(name) ||
        inventory.recordedIds.has(id) ||
        inventory.reservedNames.has(name);
      const ports = Array.isArray(item.ports ?? item.Ports)
        ? ((item.ports ?? item.Ports) as Array<Record<string, unknown>>)
            .map((port) => Number(port.publicPort ?? port.PublicPort ?? 0))
            .filter((port) => port > 0)
        : [];
      return { id, name, managed, kind: containerKind(labels, managedProject), project, ports };
    });
  }
  const managedNames = new Set((inventory.containers ?? []).filter((c) => c.managed).map((c) => c.name));

  if (needs.volumes) {
    const listedVolumes = await liveList(() => dispatch.sendDockerVolumeCommand(nodeId, 'list', {}, LIST_TIMEOUT_MS));
    for (const volume of listedVolumes ?? []) {
      const name = String(volume.Name ?? volume.name ?? '');
      const labels = labelsOf(volume.Labels ?? volume.labels);
      const usedBy = Array.isArray(volume.UsedBy) ? (volume.UsedBy as unknown[]).map(String) : [];
      const project = labels[COMPOSE_PROJECT_LABEL];
      if (
        inventory.allManaged ||
        hasOpfieldLabel(labels) ||
        (project && inventory.composeProjects.has(project)) ||
        usedBy.some((user) => managedNames.has(user))
      ) {
        inventory.volumes.add(name);
      }
    }
  }
  if (needs.networks) {
    const listedNetworks = await liveList(() => dispatch.sendDockerNetworkCommand(nodeId, 'list', {}, LIST_TIMEOUT_MS));
    for (const network of listedNetworks ?? []) {
      const name = String(network.Name ?? network.name ?? '');
      const id = String(network.Id ?? network.ID ?? network.id ?? '');
      const labels = labelsOf(network.Labels ?? network.labels);
      const members = Object.values((network.Containers ?? {}) as Record<string, { Name?: string }>);
      const project = labels[COMPOSE_PROJECT_LABEL];
      if (
        inventory.allManaged ||
        hasOpfieldLabel(labels) ||
        (project && inventory.composeProjects.has(project)) ||
        members.some((member) => member?.Name && managedNames.has(member.Name)) ||
        inventory.networks.has(name)
      ) {
        inventory.networks.add(name);
        if (id) inventory.networks.add(id);
      }
    }
  }
  return inventory;
}
