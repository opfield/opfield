import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { auditLog, nodes } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import { type DockerManagedRecords, hasOpfieldLabel, loadDockerManagedRecords } from './docker-managed-records.js';

const logger = createChildLogger('DockerExternalChanges');

/** Docker daemons that report container changes made outside Opfield (external_changes.go in the daemon). */
export const DOCKER_EXTERNAL_CHANGES_CAPABILITY = 'docker_external_changes_v1';
export const DOCKER_EXTERNAL_CHANGE_AUDIT_ACTION = 'docker.container.changed_outside_opfield';
const PULL_DEBOUNCE_MS = 1_500;
const PULL_TIMEOUT_MS = 10_000;

export interface DockerExternalChange {
  seq: number;
  at: string;
  action: 'removed' | 'created' | 'renamed';
  containerId: string;
  name: string;
  oldName?: string;
  image?: string;
  labels?: Record<string, string>;
}

interface ChangesPage {
  bootId: string;
  latest: number;
  changes: DockerExternalChange[];
}

/** What a changed container was to Opfield, or null when Opfield does not manage it. */
export function managedAs(change: DockerExternalChange, records: DockerManagedRecords): string | null {
  const labels = change.labels ?? {};
  const names = [change.name, change.oldName].filter((name): name is string => !!name);
  for (const name of names) {
    if (records.sourceContainers.has(name)) return 'Git-source container';
    const reserved = records.reservedNames.get(name);
    if (reserved) return reserved;
  }
  const project = labels['com.docker.compose.project'];
  if (project && records.composeProjects.has(project)) return `Compose project "${project}"`;
  if (hasOpfieldLabel(labels)) return 'Opfield workload';
  if (records.recordedIds.has(change.containerId)) return 'container';
  if (names.some((name) => records.recordedNames.has(name))) return 'container';
  return null;
}

function describeChange(change: DockerExternalChange): string {
  if (change.action === 'removed') return `removed`;
  if (change.action === 'renamed') return `renamed from "${change.oldName ?? ''}" to "${change.name}"`;
  return 'created under its name';
}

/**
 * Reads the container changes a Docker daemon saw outside Opfield (docker rm/run/rename on the node's console, a
 * script, another tool) and records the ones that concern a managed container: an audit entry with the container
 * and node, and the `changed_outside` event of the Container alert category. A daemon reports such a change at once
 * with a health report, whose container diff publishes `docker.container.changed`; the watcher then pulls the
 * daemon's list after its last cursor.
 */
export class DockerExternalChangeWatcher {
  private readonly cursors = new Map<string, { bootId: string; latest: number }>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<string, Promise<void>>();
  private unsubscribers: Array<() => void> = [];

  constructor(
    private readonly db: DrizzleClient,
    private readonly dispatch: Pick<NodeDispatchService, 'sendDockerContainerCommand'>,
    private readonly registry: Pick<NodeRegistryService, 'getNode' | 'hasCapability'>,
    private readonly eventBus: EventBusService,
    private readonly auditService: Pick<AuditService, 'log'>
  ) {}

  start(): void {
    if (this.unsubscribers.length > 0) return;
    const onChange = (payload: unknown) => {
      const nodeId = (payload as { nodeId?: unknown; id?: unknown } | null)?.nodeId;
      if (typeof nodeId === 'string') this.schedule(nodeId);
    };
    const onNode = (payload: unknown) => {
      const nodeId = (payload as { id?: unknown } | null)?.id;
      if (typeof nodeId === 'string') this.schedule(nodeId);
    };
    this.unsubscribers.push(
      this.eventBus.subscribe('docker.container.changed', onChange),
      this.eventBus.subscribe('node.changed', onNode)
    );
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  schedule(nodeId: string): void {
    if (this.timers.has(nodeId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(nodeId);
      void this.pullNow(nodeId);
    }, PULL_DEBOUNCE_MS);
    timer.unref?.();
    this.timers.set(nodeId, timer);
  }

  /** Pulls and records the node's new changes; one pull per node at a time. */
  pullNow(nodeId: string): Promise<void> {
    const current = this.running.get(nodeId);
    if (current) return current;
    const run = this.pull(nodeId)
      .catch((error) => {
        logger.debug('Reading container changes outside Opfield failed', {
          nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => this.running.delete(nodeId));
    this.running.set(nodeId, run);
    return run;
  }

  private async read(nodeId: string, after: number): Promise<ChangesPage | null> {
    const result = await this.dispatch.sendDockerContainerCommand(
      nodeId,
      'external_changes',
      { configJson: JSON.stringify({ after }) },
      PULL_TIMEOUT_MS
    );
    if (!result.success || !result.detail) return null;
    const page = JSON.parse(result.detail) as ChangesPage;
    return Array.isArray(page?.changes) ? page : null;
  }

  private async pull(nodeId: string): Promise<void> {
    const node = this.registry.getNode(nodeId);
    if (node?.type !== 'docker' || !this.registry.hasCapability(nodeId, DOCKER_EXTERNAL_CHANGES_CAPABILITY)) return;
    const cursor = this.cursors.get(nodeId);
    let page = await this.read(nodeId, cursor?.latest ?? 0);
    // A restarted daemon numbers its changes from 1 again.
    if (page && cursor && page.bootId !== cursor.bootId && cursor.latest > 0) page = await this.read(nodeId, 0);
    if (!page) return;
    if (page.changes.length > 0) {
      const records = await loadDockerManagedRecords(this.db, nodeId);
      for (const change of page.changes) await this.record(nodeId, node.hostname, change, records);
    }
    this.cursors.set(nodeId, { bootId: page.bootId, latest: page.latest });
  }

  private async alreadyRecorded(nodeId: string, containerId: string, changeKey: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.resourceType, 'docker-container'),
          eq(auditLog.resourceId, containerId),
          eq(auditLog.action, DOCKER_EXTERNAL_CHANGE_AUDIT_ACTION),
          sql`${auditLog.details}->>'nodeId' = ${nodeId}`,
          sql`${auditLog.details}->>'changeKey' = ${changeKey}`
        )
      )
      .limit(1);
    return !!row;
  }

  private async record(nodeId: string, hostname: string, change: DockerExternalChange, records: DockerManagedRecords) {
    const kind = managedAs(change, records);
    if (!kind) return;
    // Opfield restarted while the daemon kept its list: the change may be on record already.
    const changeKey = `${change.containerId}:${change.action}:${change.at}`;
    if (await this.alreadyRecorded(nodeId, change.containerId, changeKey)) return;
    const [row] = await this.db
      .select({ displayName: nodes.displayName })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    const nodeName = row?.displayName || hostname;
    const occurredAt = new Date(change.at);
    await this.auditService.log({
      userId: null,
      action: DOCKER_EXTERNAL_CHANGE_AUDIT_ACTION,
      resourceType: 'docker-container',
      resourceId: change.containerId,
      details: {
        nodeId,
        nodeName,
        name: change.name,
        ...(change.oldName ? { oldName: change.oldName } : {}),
        change: change.action,
        managedAs: kind,
        image: change.image ?? null,
        changeKey,
        summary: `Container "${change.oldName || change.name}" on ${nodeName} was ${describeChange(change)} outside Opfield`,
      },
      ...(Number.isFinite(occurredAt.getTime()) ? { occurredAt } : {}),
    });
    this.eventBus.publish('docker.container.external_change', {
      nodeId,
      nodeName,
      id: change.containerId,
      name: change.oldName && change.action === 'renamed' ? change.oldName : change.name,
      change: change.action,
      managedAs: kind,
    });
    logger.warn('Managed container changed outside Opfield', {
      nodeId,
      container: change.name,
      change: change.action,
      managedAs: kind,
    });
  }
}
