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
/**
 * The daemon judges a Docker event 3 s after it (externalChangeSettle in external_changes.go) and only then lists it.
 * The health report that publishes the container diff leaves at the event itself, so the pull it starts usually comes
 * before the change is listed; a second pull after the settle reads it.
 */
const PULL_AFTER_SETTLE_MS = 6_000;
/** Every capable node is read this often as well, so a change whose trigger was missed is still recorded. */
const SWEEP_INTERVAL_MS = 60_000;
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
 * What the change means for Opfield, for the alert ({{details.effect}}): a container created by hand under a managed
 * name had no permissions or source to lose, unlike a managed container that was renamed or removed.
 */
export function describeEffect(change: Pick<DockerExternalChange, 'action'>, kind: string): string {
  const source = kind === 'Git-source container';
  if (change.action === 'created') {
    return source
      ? 'Opfield does not manage the new container, and the Git source that holds this name does not build into it.'
      : 'Opfield does not manage the new container: it has no Opfield permissions.';
  }
  if (change.action === 'renamed') {
    return source
      ? 'Opfield no longer tracks it as before: its permissions were reset and its Git source builds refuse it.'
      : 'Opfield no longer tracks it as before: its permissions were reset.';
  }
  return source
    ? 'Its permissions went with it; its Git source still holds the name until it is removed.'
    : 'Its permissions went with it.';
}

/**
 * Reads the container changes a Docker daemon saw outside Opfield (docker rm/run/rename on the node's console, a
 * script, another tool) and records the ones that concern a managed container: an audit entry with the container
 * and node, and the `changed_outside` event of the Container alert category. The container diff of a health report
 * publishes `docker.container.changed`; the watcher then pulls the daemon's list after its last cursor, once at once
 * and once after the daemon's settle time, and it reads every capable node once a minute as well.
 */
export class DockerExternalChangeWatcher {
  private readonly cursors = new Map<string, { bootId: string; latest: number }>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<string, Promise<void>>();
  /** The last pull failure per node, so a node that keeps failing logs one warning per new error. */
  private readonly failures = new Map<string, string>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribers: Array<() => void> = [];

  constructor(
    private readonly db: DrizzleClient,
    private readonly dispatch: Pick<NodeDispatchService, 'sendDockerContainerCommand'>,
    private readonly registry: Pick<NodeRegistryService, 'getNode' | 'hasCapability' | 'getNodesByType'>,
    private readonly eventBus: EventBusService,
    private readonly auditService: Pick<AuditService, 'log'>
  ) {}

  start(): void {
    if (this.unsubscribers.length > 0) return;
    const onChange = (payload: unknown) => {
      const nodeId = (payload as { nodeId?: unknown; id?: unknown } | null)?.nodeId;
      if (typeof nodeId !== 'string') return;
      this.schedule(nodeId);
      this.schedule(nodeId, PULL_AFTER_SETTLE_MS);
    };
    const onNode = (payload: unknown) => {
      const nodeId = (payload as { id?: unknown } | null)?.id;
      if (typeof nodeId === 'string') this.schedule(nodeId);
    };
    this.unsubscribers.push(
      this.eventBus.subscribe('docker.container.changed', onChange),
      this.eventBus.subscribe('node.changed', onNode)
    );
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Pulls the node after `delayMs`; a pull already waiting for the same delay covers this request too. */
  schedule(nodeId: string, delayMs = PULL_DEBOUNCE_MS): void {
    const key = `${nodeId}:${delayMs}`;
    if (this.timers.has(key)) return;
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.pullNow(nodeId);
    }, delayMs);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  /** Reads every connected Docker node that reports changes outside Opfield. */
  sweep(): void {
    for (const node of this.registry.getNodesByType('docker')) {
      if (this.registry.hasCapability(node.nodeId, DOCKER_EXTERNAL_CHANGES_CAPABILITY)) void this.pullNow(node.nodeId);
    }
  }

  /** Pulls and records the node's new changes; one pull per node at a time. */
  pullNow(nodeId: string): Promise<void> {
    const current = this.running.get(nodeId);
    if (current) return current;
    const run = this.pull(nodeId)
      .then(() => {
        this.failures.delete(nodeId);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (this.failures.get(nodeId) === message) return;
        this.failures.set(nodeId, message);
        logger.warn('Reading container changes outside Opfield failed', { nodeId, error: message });
      })
      .finally(() => this.running.delete(nodeId));
    this.running.set(nodeId, run);
    return run;
  }

  private async read(nodeId: string, after: number): Promise<ChangesPage> {
    const result = await this.dispatch.sendDockerContainerCommand(
      nodeId,
      'external_changes',
      { configJson: JSON.stringify({ after }) },
      PULL_TIMEOUT_MS
    );
    if (!result.success) throw new Error(result.error || 'the daemon refused external_changes');
    const page = JSON.parse(result.detail || 'null') as ChangesPage | null;
    if (!page || !Array.isArray(page.changes)) throw new Error('the daemon answered external_changes without a list');
    return page;
  }

  private async pull(nodeId: string): Promise<void> {
    const node = this.registry.getNode(nodeId);
    if (node?.type !== 'docker' || !this.registry.hasCapability(nodeId, DOCKER_EXTERNAL_CHANGES_CAPABILITY)) return;
    const cursor = this.cursors.get(nodeId);
    let page = await this.read(nodeId, cursor?.latest ?? 0);
    // A restarted daemon numbers its changes from 1 again.
    if (cursor && page.bootId !== cursor.bootId && cursor.latest > 0) page = await this.read(nodeId, 0);
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
      effect: describeEffect(change, kind),
    });
    logger.warn('Managed container changed outside Opfield', {
      nodeId,
      container: change.name,
      change: change.action,
      managedAs: kind,
    });
  }
}
