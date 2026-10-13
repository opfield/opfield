import { and, eq, ne, or } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { dockerAvailabilityPolicies, dockerSourceBindings } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { detachRemovedContainerSource } from './docker-container-source-detach.js';
import { DockerSourceService } from './docker-source.service.js';

const logger = createChildLogger('DockerSourceOrphanRepair');

export interface DockerSourceOrphanRepairDeps {
  /** True only while the node's daemon is connected. */
  isNodeOnline(nodeId: string): boolean;
  /** Live container list of the node (the same command Opfield's container lists use). */
  listContainers(nodeId: string): Promise<{ success: boolean; detail?: string }>;
  /** True while the container has an active transition or lock in the host's docker transition registry. */
  hasActiveTransition(nodeId: string, name: string): boolean;
  /** Clock, replaceable in tests. */
  now?(): number;
}

/** A container must be seen absent in two passes at least this far apart before its binding is removed. */
export const ORPHAN_CONFIRMATION_MS = 5 * 60 * 1000;

function listedNames(result: { success: boolean; detail?: string }): Set<string> | null {
  if (!result.success || !result.detail) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.detail);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const names = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object') return null;
    const entry = item as Record<string, unknown>;
    const name = String(entry.name ?? entry.Name ?? '').replace(/^\/+/, '');
    if (name) names.add(name);
    const listedNamesArray = entry.Names;
    if (Array.isArray(listedNamesArray)) {
      for (const alias of listedNamesArray) names.add(String(alias).replace(/^\/+/, ''));
    }
  }
  return names;
}

/**
 * Container source bindings whose container no longer exists: older releases
 * left the binding behind when a container was removed, so its auto-build kept
 * polling and a later container of the same name inherited it.
 *
 * A binding is removed only when its node is online, the node's live container
 * list was read successfully and has no such container in two passes at least
 * {@link ORPHAN_CONFIRMATION_MS} apart, and the binding is not a Git source
 * container that legitimately has no container yet. A recreate briefly hides
 * the name from the list, so a container with an active transition is skipped,
 * and any sign of life (listed, pending, in transition), an offline node or an
 * unknown inventory forgets the first sighting. A container under an
 * availability policy may run on another node than its binding names, so its
 * binding is never touched. Sightings are kept in memory only. Idempotent.
 */
export class OrphanedSourceBindingRepair {
  private readonly firstAbsent = new Map<string, number>();

  private readonly db: DrizzleClient;
  private readonly deps: DockerSourceOrphanRepairDeps;

  constructor(db: DrizzleClient, deps: DockerSourceOrphanRepairDeps) {
    this.db = db;
    this.deps = deps;
  }

  private forgetNode(nodeId: string) {
    for (const key of this.firstAbsent.keys()) if (key.split('|')[1] === nodeId) this.firstAbsent.delete(key);
  }

  /** Runs one pass; returns the number of removed bindings. */
  async run(): Promise<number> {
    const db = this.db;
    const deps = this.deps;
    const now = (deps.now ?? Date.now)();
    const rows = await db
      .select({
        id: dockerSourceBindings.id,
        nodeId: dockerSourceBindings.nodeId,
        containerName: dockerSourceBindings.containerName,
        initialConfig: dockerSourceBindings.initialConfig,
        deployedCommitSha: dockerSourceBindings.deployedCommitSha,
        deployingCommitSha: dockerSourceBindings.deployingCommitSha,
      })
      .from(dockerSourceBindings)
      .where(eq(dockerSourceBindings.targetKind, 'container'));
    const availabilityManaged = new Set(
      (
        await db
          .select({ containerName: dockerAvailabilityPolicies.containerName })
          .from(dockerAvailabilityPolicies)
          .where(
            and(
              eq(dockerAvailabilityPolicies.resourceKind, 'container'),
              or(ne(dockerAvailabilityPolicies.mode, 'single'), ne(dockerAvailabilityPolicies.status, 'single'))
            )
          )
      ).map((policy) => policy.containerName)
    );

    const byNode = new Map<string, typeof rows>();
    for (const row of rows) {
      if (!row.nodeId || !row.containerName) continue;
      byNode.set(row.nodeId, [...(byNode.get(row.nodeId) ?? []), row]);
    }
    const keyOf = (row: { id: string; nodeId: string | null; containerName: string | null }) =>
      `${row.id}|${row.nodeId}|${row.containerName}`;
    // Bindings that are gone or were renamed since the last pass.
    const live = new Set(rows.map(keyOf));
    for (const key of this.firstAbsent.keys()) if (!live.has(key)) this.firstAbsent.delete(key);

    let removed = 0;
    for (const [nodeId, bindings] of byNode) {
      try {
        if (!deps.isNodeOnline(nodeId)) {
          this.forgetNode(nodeId);
          continue;
        }
        const names = listedNames(await deps.listContainers(nodeId));
        if (!names) {
          this.forgetNode(nodeId);
          continue;
        }
        const service = container.isRegistered(DockerSourceService) ? container.resolve(DockerSourceService) : null;
        const pendingNames = new Set(
          (service ? await service.listPendingContainers(nodeId) : []).map((p) => p.containerName)
        );

        for (const binding of bindings) {
          const containerName = binding.containerName as string;
          const key = keyOf(binding);
          // A Git source waiting for its first build owns its name without a container; a Compose rollout
          // marks its target commit while it replaces containers.
          const awaitingFirstBuild = binding.initialConfig != null && binding.deployedCommitSha == null;
          if (
            names.has(containerName) ||
            availabilityManaged.has(containerName) ||
            pendingNames.has(containerName) ||
            awaitingFirstBuild ||
            binding.deployingCommitSha != null ||
            deps.hasActiveTransition(nodeId, containerName)
          ) {
            this.firstAbsent.delete(key);
            continue;
          }
          const first = this.firstAbsent.get(key);
          if (first === undefined) {
            this.firstAbsent.set(key, now);
            continue;
          }
          if (now - first < ORPHAN_CONFIRMATION_MS) continue;
          try {
            await detachRemovedContainerSource(db, nodeId, containerName, 'system');
            this.firstAbsent.delete(key);
            removed += 1;
            logger.info('Removed the Git source binding of a container that no longer exists', {
              nodeId,
              containerName,
              bindingId: binding.id,
            });
          } catch (error) {
            logger.warn('Failed to remove an orphaned container source binding', {
              nodeId,
              containerName,
              bindingId: binding.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (error) {
        this.forgetNode(nodeId);
        logger.warn('Skipped orphaned container source binding check for a node', {
          nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return removed;
  }
}
