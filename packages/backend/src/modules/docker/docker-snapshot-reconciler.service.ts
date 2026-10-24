import { createChildLogger } from '@/lib/logger.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import {
  DOCKER_SNAPSHOT_KINDS,
  type DockerDetailKind,
  type DockerRefreshKind,
  type DockerSnapshotKind,
  type DockerSnapshotService,
} from './docker-snapshot.service.js';

const logger = createChildLogger('DockerSnapshotReconciler');
const DAEMON_TIMEOUT_MS = 10_000;
const VOLUME_METRICS_TIMEOUT_MS = 60_000;
const MAX_GLOBAL_REFRESHES = 4;
const MAX_VOLUME_METRIC_REFRESHES = 2;
const BACKOFF_MS = [10_000, 30_000, 60_000] as const;
const DETAIL_BATCH_PER_KIND_PER_NODE = 2;

type JobPriority = 0 | 1 | 2;

interface RefreshJob {
  nodeId: string;
  kind: DockerRefreshKind;
  key?: string;
}

interface JobState {
  status: 'queued' | 'inflight';
  dirty: boolean;
  dirtyPriority?: JobPriority;
  priority: JobPriority;
  job: RefreshJob;
}

interface FailureState {
  failures: number;
  retryAt: number;
}

function jobId(job: RefreshJob) {
  return `${job.nodeId}:${job.kind}:${job.key ?? ''}`;
}

function jobPriority(job: RefreshJob, urgent: boolean): JobPriority {
  if (urgent) return 0;
  return DOCKER_SNAPSHOT_KINDS.includes(job.kind as DockerSnapshotKind) ? 1 : 2;
}

function refreshLane(job: RefreshJob) {
  return job.kind === 'volume-metrics' ? `${job.nodeId}:volume-metrics` : job.nodeId;
}

function resultData(result: { success: boolean; detail?: string; error?: string }) {
  if (!result.success) throw new Error(result.error || result.detail || 'Docker daemon command failed');
  if (!result.detail) return null;
  try {
    return JSON.parse(result.detail);
  } catch {
    return result.detail;
  }
}

function listItemKey(kind: DockerDetailKind, item: Record<string, unknown>): string | null {
  if (kind === 'container-detail') {
    const value = item.name ?? item.Name ?? item.id ?? item.Id;
    return typeof value === 'string' ? value.replace(/^\/+/, '') : null;
  }
  const value = item.name ?? item.Name;
  return typeof value === 'string' ? value : null;
}

export class DockerSnapshotReconciler {
  private readonly queue: string[] = [];
  private readonly states = new Map<string, JobState>();
  private readonly failures = new Map<string, FailureState>();
  private readonly cancelledJobs = new Set<string>();
  private readonly detailCursors = new Map<string, number>();
  private readonly activeContainerTransitions = new Set<string>();
  private readonly activeLanes = new Set<string>();
  private activeCount = 0;
  private activeVolumeMetricCount = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private unsubscribers: Array<() => void> = [];
  private running = true;
  private readonly stopWaiters = new Set<() => void>();

  constructor(
    private readonly snapshots: DockerSnapshotService,
    private readonly dispatch: NodeDispatchService,
    private readonly registry: NodeRegistryService,
    private readonly eventBus: EventBusService
  ) {}

  start(): void {
    if (this.unsubscribers.length > 0) return;
    this.running = true;
    this.unsubscribers.push(
      this.eventBus.subscribe('node.changed', (payload) => this.onNodeChanged(payload)),
      this.eventBus.subscribe('docker.container.changed', (payload) => this.onContainerChanged(payload)),
      this.eventBus.subscribe('docker.image.changed', (payload) =>
        this.onResourceChanged('images', undefined, payload)
      ),
      this.eventBus.subscribe('docker.volume.changed', (payload) =>
        this.onResourceChanged('volumes', ['volume-detail', 'volume-metrics'], payload)
      ),
      this.eventBus.subscribe('docker.network.changed', (payload) =>
        this.onResourceChanged('networks', undefined, payload)
      )
    );
    for (const nodeId of this.registry.getNodesByType('docker').map((node) => node.nodeId)) {
      this.enqueueNode(nodeId, { urgent: true });
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.queue.splice(0);
    for (const [id, state] of this.states) {
      state.dirty = false;
      state.dirtyPriority = undefined;
      if (state.status === 'queued') this.states.delete(id);
    }
    if (this.activeCount === 0) return;
    await new Promise<void>((resolve) => this.stopWaiters.add(resolve));
  }

  enqueue(job: RefreshJob, options: { urgent?: boolean } = {}): boolean {
    if (!this.running) return false;
    if (this.snapshots.isNodeDeleted(job.nodeId)) return false;
    const id = jobId(job);
    this.cancelledJobs.delete(id);
    const priority = jobPriority(job, options.urgent === true);
    const current = this.states.get(id);
    if (current?.status === 'inflight') {
      current.dirty = true;
      current.dirtyPriority = Math.min(current.dirtyPriority ?? priority, priority) as JobPriority;
      if (options.urgent) this.bypassBackoff(id);
      return false;
    }
    if (current?.status === 'queued') {
      current.priority = Math.min(current.priority, priority) as JobPriority;
      if (options.urgent) this.bypassBackoff(id);
      this.drain();
      return false;
    }
    if (options.urgent) this.bypassBackoff(id);
    this.states.set(id, { status: 'queued', dirty: false, priority, job });
    this.queue.push(id);
    this.drain();
    return true;
  }

  private bypassBackoff(id: string): void {
    const failure = this.failures.get(id);
    if (failure) failure.retryAt = 0;
  }

  enqueueNode(nodeId: string, options: { urgent?: boolean } = {}): void {
    for (const kind of DOCKER_SNAPSHOT_KINDS) this.enqueue({ nodeId, kind }, options);
  }

  enqueueConnected(kind: DockerSnapshotKind): void {
    for (const node of this.registry.getNodesByType('docker')) this.enqueue({ nodeId: node.nodeId, kind });
  }

  async refreshNow(nodeId: string, kind: DockerRefreshKind, key?: string): Promise<void> {
    if (this.snapshots.isNodeDeleted(nodeId)) return;
    if (DOCKER_SNAPSHOT_KINDS.includes(kind as DockerSnapshotKind)) {
      await this.refreshList(nodeId, kind as DockerSnapshotKind);
      return;
    }
    if (!key) throw new Error(`${kind} refresh requires a resource key`);
    await this.refreshDetail(nodeId, kind as DockerDetailKind, key);
  }

  /**
   * Reads a volume or network list (and the changed volume's cached inspect) back from its node now. A create or
   * remove calls it before it answers, so a read right after the answer sees the result: a created volume was 404
   * until the queued refresh ran, a removed network stayed listed. A removed volume's cached details are dropped. A
   * failed read is left to the refresh the change event queued.
   */
  async readBackNow(
    nodeId: string,
    kind: Extract<DockerSnapshotKind, 'volumes' | 'networks'>,
    change?: { volume: string; removed?: boolean }
  ): Promise<void> {
    try {
      if (change?.removed) await this.snapshots.deleteDetails(nodeId, 'volume-detail', [change.volume]);
      await this.refreshNow(nodeId, kind);
      if (change && !change.removed) await this.refreshNow(nodeId, 'volume-detail', change.volume);
    } catch (error) {
      logger.debug('Docker resource read-back failed', {
        nodeId,
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Reads a container back from its node now: the container list and its cached inspect under each of `keys` (the
   * request's reference and the name). A lifecycle request calls it before it answers, so a read right after the
   * answer sees the new state. A failed read is left to the refresh the container's event queued.
   */
  async refreshContainerNow(nodeId: string, keys: readonly (string | undefined)[]): Promise<void> {
    try {
      await this.refreshNow(nodeId, 'containers');
      for (const key of new Set(keys.filter((value): value is string => !!value))) {
        await this.refreshNow(nodeId, 'container-detail', key);
      }
    } catch (error) {
      logger.debug('Docker container read-back failed', {
        nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async finalizeContainerRecreate(nodeId: string, newContainerId: string): Promise<void> {
    if (this.snapshots.isNodeDeleted(nodeId)) return;
    const result = await this.dispatch.sendDockerContainerCommand(nodeId, 'list', {}, DAEMON_TIMEOUT_MS);
    const data = resultData(result);
    if (!Array.isArray(data)) throw new Error('Docker containers list returned an invalid payload');

    const incoming = data as Record<string, unknown>[];
    const replacement = incoming.find((item) => this.containerSnapshotAliases(item).includes(newContainerId));
    if (!replacement) throw new Error(`Replacement container ${newContainerId} is not present in Docker inventory`);

    const replacementAliases = new Set(this.containerSnapshotAliases(replacement));
    const current = await this.snapshots.getList<Record<string, unknown>[]>(nodeId, 'containers');
    const previous = (Array.isArray(current.data) ? current.data : []).find((item) =>
      this.containerSnapshotAliases(item).some((alias) => replacementAliases.has(alias))
    );
    const completedAliases = new Set([
      ...replacementAliases,
      ...(previous ? this.containerSnapshotAliases(previous) : []),
    ]);
    for (const alias of completedAliases) this.activeContainerTransitions.delete(`${nodeId}:${alias}`);

    const stableData = await this.preserveTransitioningContainers(nodeId, incoming);
    await this.snapshots.replaceList(nodeId, 'containers', stableData);
    await this.snapshots.reconcileComposeProjects(nodeId);
  }

  async enqueueDueDetails(): Promise<void> {
    for (const node of this.registry.getNodesByType('docker')) {
      await this.enqueueStaleDetails(node.nodeId, 'container-detail', 'containers');
      await this.enqueueStaleDetails(node.nodeId, 'volume-detail', 'volumes');
      await this.enqueueStaleDetails(node.nodeId, 'volume-metrics', 'volumes');
    }
  }

  private async enqueueStaleDetails(nodeId: string, detailKind: DockerDetailKind, listKind: DockerSnapshotKind) {
    const list = await this.snapshots.getList<Record<string, unknown>[]>(nodeId, listKind);
    if (!Array.isArray(list.data)) return;
    const liveKeys = new Set(
      list.data.map((item) => listItemKey(detailKind, item)).filter((key): key is string => key !== null)
    );
    this.reconcileDetailStates(nodeId, detailKind, liveKeys);
    const details = await this.snapshots.getDetails(nodeId, detailKind);
    const pending = [...this.states.values()].filter(
      (state) => state.job.nodeId === nodeId && state.job.kind === detailKind
    );
    const batchBudget = Math.max(0, DETAIL_BATCH_PER_KIND_PER_NODE - pending.length);
    if (batchBudget === 0) return;
    const now = Date.now();
    const cursorKey = `${nodeId}:${detailKind}`;
    const start = Math.min(this.detailCursors.get(cursorKey) ?? 0, Math.max(0, list.data.length - 1));
    let scanned = 0;
    let enqueued = 0;
    while (scanned < list.data.length && enqueued < batchBudget) {
      const index = (start + scanned) % list.data.length;
      const item = list.data[index]!;
      scanned += 1;
      const key = listItemKey(detailKind, item);
      if (!key) continue;
      const detail = details[key];
      const failure = this.failures.get(jobId({ nodeId, kind: detailKind, key }));
      if (failure && failure.retryAt > now) continue;
      const observedAt = detail?.observedAt
        ? Date.parse(detail.observedAt)
        : detail?.lastAttemptAt
          ? Date.parse(detail.lastAttemptAt)
          : 0;
      if (now - observedAt >= 5 * 60_000 && this.enqueue({ nodeId, kind: detailKind, key })) enqueued += 1;
    }
    if (list.data.length > 0) this.detailCursors.set(cursorKey, (start + scanned) % list.data.length);
  }

  private reconcileDetailStates(nodeId: string, detailKind: DockerDetailKind, liveKeys: Set<string>): void {
    for (const [id, state] of this.states) {
      if (state.job.nodeId !== nodeId || state.job.kind !== detailKind || !state.job.key) continue;
      if (!liveKeys.has(state.job.key)) this.cancelJob(id);
    }
    const prefix = `${nodeId}:${detailKind}:`;
    for (const id of this.failures.keys()) {
      if (id.startsWith(prefix) && !liveKeys.has(id.slice(prefix.length))) this.failures.delete(id);
    }
  }

  private cancelJob(id: string): void {
    const state = this.states.get(id);
    if (!state) return;
    this.failures.delete(id);
    state.dirty = false;
    state.dirtyPriority = undefined;
    if (state.status === 'inflight') {
      this.cancelledJobs.add(id);
      return;
    }
    const queueIndex = this.queue.indexOf(id);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    this.states.delete(id);
    this.cancelledJobs.delete(id);
  }

  private onNodeChanged(payload: unknown) {
    if (!payload || typeof payload !== 'object') return;
    const event = payload as Record<string, unknown>;
    const nodeId = typeof event.id === 'string' ? event.id : null;
    if (!nodeId) return;
    if (event.action === 'deleted') {
      this.cancelNode(nodeId);
      void this.snapshots
        .purgeNode(nodeId)
        .catch((error) => logger.warn('Failed to purge node snapshots', { nodeId, error }));
    } else if (event.status === 'online' && this.registry.getNode(nodeId)?.type === 'docker') {
      this.snapshots.reviveNode(nodeId);
      this.enqueueNode(nodeId, { urgent: true });
    } else if (event.status === 'offline') {
      void this.snapshots.publishNodeAvailability(nodeId).catch(() => {
        // Non-Docker nodes share node.changed; they have no Docker snapshots to announce.
      });
    }
  }

  private onResourceChanged(
    kind: DockerSnapshotKind,
    detailKind: DockerDetailKind | readonly DockerDetailKind[] | undefined,
    payload: unknown
  ) {
    if (!payload || typeof payload !== 'object') return;
    const event = payload as Record<string, unknown>;
    const nodeId = typeof event.nodeId === 'string' ? event.nodeId : null;
    if (!nodeId) return;
    this.enqueue({ nodeId, kind }, { urgent: true });
    if (!detailKind || event.action === 'removed' || event.action === 'deleted') return;
    const key = [event.name, event.id, event.ref].find((value): value is string => typeof value === 'string');
    if (!key) return;
    for (const detail of Array.isArray(detailKind) ? detailKind : [detailKind]) {
      this.enqueue({ nodeId, kind: detail, key }, { urgent: true });
    }
  }

  private containerTransitionKeys(nodeId: string, event: Record<string, unknown>) {
    const keys: string[] = [];
    for (const field of ['id', 'oldId', 'name', 'oldName'] as const) {
      const value = event[field];
      if (typeof value === 'string' && value) keys.push(`${nodeId}:${value}`);
    }
    return keys;
  }

  private containerSnapshotAliases(item: Record<string, unknown>): string[] {
    const aliases: string[] = [];
    for (const field of ['id', 'Id', 'name', 'Name'] as const) {
      const value = item[field];
      if (typeof value === 'string' && value) aliases.push(value.replace(/^\/+/, ''));
    }
    return aliases;
  }

  private async preserveTransitioningContainers(
    nodeId: string,
    incoming: Record<string, unknown>[]
  ): Promise<Record<string, unknown>[]> {
    const prefix = `${nodeId}:`;
    const activeAliases = new Set(
      [...this.activeContainerTransitions]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
    );
    if (activeAliases.size === 0) return incoming;

    const current = await this.snapshots.getList<Record<string, unknown>[]>(nodeId, 'containers');
    const preserved = (Array.isArray(current.data) ? current.data : []).filter((item) =>
      this.containerSnapshotAliases(item).some((alias) => activeAliases.has(alias))
    );
    if (preserved.length === 0) return incoming;

    const preservedAliases = new Set(preserved.flatMap((item) => this.containerSnapshotAliases(item)));
    return [
      ...incoming.filter((item) => !this.containerSnapshotAliases(item).some((alias) => preservedAliases.has(alias))),
      ...preserved,
    ];
  }

  private onContainerChanged(payload: unknown) {
    if (!payload || typeof payload !== 'object') return;
    const event = payload as Record<string, unknown>;
    const nodeId = typeof event.nodeId === 'string' ? event.nodeId : null;
    if (!nodeId) return;

    this.enqueue({ nodeId, kind: 'containers' }, { urgent: true });
    const transitionKeys = this.containerTransitionKeys(nodeId, event);
    const action = typeof event.action === 'string' ? event.action : '';

    if (action === 'transitioning') {
      if (event.transition) {
        for (const key of transitionKeys) this.activeContainerTransitions.add(key);
        return;
      }
      for (const key of transitionKeys) this.activeContainerTransitions.delete(key);
    } else if (action === 'recreated' || action === 'removed' || action === 'deleted') {
      for (const key of transitionKeys) this.activeContainerTransitions.delete(key);
    } else if (transitionKeys.some((key) => this.activeContainerTransitions.has(key))) {
      // Preserve the last stable inspect snapshot while a restart/recreate is
      // active. Docker can report the old runtime as exited during replacement,
      // but that transient state must not become the page's durable detail.
      return;
    }

    if (action === 'removed' || action === 'deleted') {
      // A removed container's cached inspect must not answer for it.
      const keys = [event.name, event.id].filter((value): value is string => typeof value === 'string');
      void this.snapshots.deleteDetails(nodeId, 'container-detail', keys).catch((error) => {
        logger.warn('Failed to drop the cached inspect of a removed container', { nodeId, error });
      });
      return;
    }
    // A recreated container keeps its name: its detail is cached under the name, like every other refresh, so the
    // name's cached inspect follows the new runtime at once instead of waiting for the periodic refresh.
    const detailKey = [event.name, event.id, event.ref].find(
      (value): value is string => typeof value === 'string' && value.length > 0
    );
    if (detailKey) {
      this.enqueue({ nodeId, kind: 'container-detail', key: detailKey }, { urgent: true });
    }
  }

  private cancelNode(nodeId: string): void {
    this.snapshots.markNodeDeleted(nodeId);
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const id = this.queue[index]!;
      const state = this.states.get(id);
      if (state?.job.nodeId !== nodeId) continue;
      this.queue.splice(index, 1);
      if (state.status === 'queued') this.states.delete(id);
      this.failures.delete(id);
      this.cancelledJobs.delete(id);
    }
    for (const [id, state] of this.states) {
      if (state.job.nodeId === nodeId) {
        state.dirty = false;
        state.dirtyPriority = undefined;
        this.failures.delete(id);
      }
    }
    for (const key of this.detailCursors.keys()) {
      if (key.startsWith(`${nodeId}:`)) this.detailCursors.delete(key);
    }
    for (const key of this.activeContainerTransitions) {
      if (key.startsWith(`${nodeId}:`)) this.activeContainerTransitions.delete(key);
    }
  }

  private drain(): void {
    if (!this.running) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    while (this.activeCount < MAX_GLOBAL_REFRESHES) {
      const now = Date.now();
      let index = -1;
      let bestPriority = Number.POSITIVE_INFINITY;
      for (let candidateIndex = 0; candidateIndex < this.queue.length; candidateIndex += 1) {
        const id = this.queue[candidateIndex]!;
        const state = this.states.get(id);
        if (!state || state.status !== 'queued' || this.activeLanes.has(refreshLane(state.job))) continue;
        if (state.job.kind === 'volume-metrics' && this.activeVolumeMetricCount >= MAX_VOLUME_METRIC_REFRESHES)
          continue;
        if ((this.failures.get(id)?.retryAt ?? 0) > now) continue;
        if (state.priority < bestPriority) {
          index = candidateIndex;
          bestPriority = state.priority;
        }
      }
      if (index < 0) break;
      const [id] = this.queue.splice(index, 1);
      if (!id) break;
      const state = this.states.get(id);
      if (!state) continue;
      state.status = 'inflight';
      this.activeCount += 1;
      if (state.job.kind === 'volume-metrics') this.activeVolumeMetricCount += 1;
      this.activeLanes.add(refreshLane(state.job));
      void this.run(state.job)
        .catch(() => {})
        .finally(() => this.finish(id));
    }
    this.scheduleRetry();
  }

  private scheduleRetry() {
    if (!this.running) return;
    const retryAt = this.queue
      .map((id) => this.failures.get(id)?.retryAt ?? 0)
      .filter((value) => value > Date.now())
      .sort((a, b) => a - b)[0];
    if (retryAt && !this.retryTimer) {
      this.retryTimer = setTimeout(
        () => {
          this.retryTimer = undefined;
          this.drain();
        },
        Math.max(1, retryAt - Date.now())
      );
    }
  }

  private finish(id: string) {
    const state = this.states.get(id);
    if (!state) return;
    this.activeCount -= 1;
    if (state.job.kind === 'volume-metrics') this.activeVolumeMetricCount -= 1;
    this.activeLanes.delete(refreshLane(state.job));
    if (!this.running) {
      this.states.delete(id);
      if (this.activeCount === 0) {
        for (const resolve of this.stopWaiters) resolve();
        this.stopWaiters.clear();
      }
      return;
    }
    if (this.snapshots.isNodeDeleted(state.job.nodeId)) {
      this.states.delete(id);
      this.failures.delete(id);
      this.cancelledJobs.delete(id);
      this.drain();
      return;
    }
    if (this.cancelledJobs.has(id)) {
      this.states.delete(id);
      this.failures.delete(id);
      this.cancelledJobs.delete(id);
      this.drain();
      return;
    }
    const isDetail = !DOCKER_SNAPSHOT_KINDS.includes(state.job.kind as DockerSnapshotKind);
    if (isDetail && this.failures.has(id) && !state.dirty) {
      // Keep only FailureState during detail backoff. The round-robin scheduler
      // will admit this key again after retryAt without consuming queue capacity.
      this.states.delete(id);
      this.drain();
      return;
    }
    if (state.dirty || this.failures.has(id)) {
      state.status = 'queued';
      if (state.dirtyPriority !== undefined) {
        state.priority = state.dirtyPriority;
        if (state.dirtyPriority === 0) this.bypassBackoff(id);
      }
      state.dirty = false;
      state.dirtyPriority = undefined;
      if (!this.queue.includes(id)) this.queue.push(id);
    } else {
      this.states.delete(id);
    }
    this.drain();
  }

  private async run(job: RefreshJob): Promise<void> {
    const id = jobId(job);
    if (this.snapshots.isNodeDeleted(job.nodeId) || this.cancelledJobs.has(id)) return;
    try {
      if (DOCKER_SNAPSHOT_KINDS.includes(job.kind as DockerSnapshotKind)) {
        await this.refreshList(job.nodeId, job.kind as DockerSnapshotKind);
      } else {
        await this.refreshDetail(job.nodeId, job.kind as DockerDetailKind, job.key!);
      }
      this.failures.delete(id);
    } catch (error) {
      if (this.snapshots.isNodeDeleted(job.nodeId) || this.cancelledJobs.has(id)) {
        this.failures.delete(id);
        return;
      }
      const previous = this.failures.get(id)?.failures ?? 0;
      const failures = previous + 1;
      const delay = BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)]!;
      this.failures.set(id, { failures, retryAt: Date.now() + delay });
      if (DOCKER_SNAPSHOT_KINDS.includes(job.kind as DockerSnapshotKind)) {
        await this.snapshots.markListError(job.nodeId, job.kind as DockerSnapshotKind, error);
      } else if (job.key) {
        await this.snapshots.markDetailError(job.nodeId, job.kind as DockerDetailKind, job.key, error);
      }
      logger.debug('Docker snapshot refresh failed', {
        nodeId: job.nodeId,
        kind: job.kind,
        key: job.key,
        failures,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async refreshList(nodeId: string, kind: DockerSnapshotKind) {
    if (this.snapshots.isNodeDeleted(nodeId)) return;
    await this.snapshots.markListRefreshing(nodeId, kind);
    let result: { success: boolean; detail?: string; error?: string };
    switch (kind) {
      case 'containers':
        result = await this.dispatch.sendDockerContainerCommand(nodeId, 'list', {}, DAEMON_TIMEOUT_MS);
        break;
      case 'images':
        result = await this.dispatch.sendDockerImageCommand(nodeId, 'list', {}, DAEMON_TIMEOUT_MS);
        break;
      case 'volumes':
        result = await this.dispatch.sendDockerVolumeCommand(nodeId, 'list', {}, DAEMON_TIMEOUT_MS);
        break;
      case 'networks':
        result = await this.dispatch.sendDockerNetworkCommand(nodeId, 'list', {}, DAEMON_TIMEOUT_MS);
        break;
    }
    if (this.snapshots.isNodeDeleted(nodeId)) return;
    const data = resultData(result);
    if (!Array.isArray(data)) throw new Error(`Docker ${kind} list returned an invalid payload`);
    const stableData =
      kind === 'containers'
        ? await this.preserveTransitioningContainers(nodeId, data as Record<string, unknown>[])
        : data;
    await this.snapshots.replaceList(nodeId, kind, stableData);
    await this.snapshots.reconcileComposeProjects(nodeId);
  }

  private async resolveContainerInspectKey(nodeId: string, key: string): Promise<string> {
    const list = await this.snapshots.getList<Record<string, unknown>[]>(nodeId, 'containers');
    const items = Array.isArray(list.data) ? list.data : [];
    let match = items.find(
      (item) =>
        String(item.id ?? item.Id ?? '') === key || String(item.name ?? item.Name ?? '').replace(/^\/+/, '') === key
    );

    if (!match) {
      const stale = await this.snapshots.getDetail<any>(nodeId, 'container-detail', key);
      const staleName = String(stale?.data?.name ?? stale?.data?.Name ?? '').replace(/^\/+/, '');
      if (staleName) {
        match = items.find((item) => String(item.name ?? item.Name ?? '').replace(/^\/+/, '') === staleName);
      }
    }

    if (!match) throw new Error(`Container ${key} is not present in the current Docker snapshot`);
    return String(match.name ?? match.Name ?? match.id ?? match.Id ?? key).replace(/^\/+/, '');
  }

  private async refreshDetail(nodeId: string, kind: DockerDetailKind, key: string) {
    const id = jobId({ nodeId, kind, key });
    if (this.snapshots.isNodeDeleted(nodeId) || this.cancelledJobs.has(id)) return;
    if (kind === 'container-detail' && this.activeContainerTransitions.has(`${nodeId}:${key}`)) return;
    const inspectKey = kind === 'container-detail' ? await this.resolveContainerInspectKey(nodeId, key) : key;
    const result =
      kind === 'container-detail'
        ? await this.dispatch.sendDockerContainerCommand(
            nodeId,
            'inspect',
            { containerId: inspectKey },
            DAEMON_TIMEOUT_MS
          )
        : await this.dispatch.sendDockerVolumeCommand(
            nodeId,
            kind === 'volume-metrics' ? 'metrics' : 'inspect',
            { name: key },
            kind === 'volume-metrics' ? VOLUME_METRICS_TIMEOUT_MS : DAEMON_TIMEOUT_MS
          );
    if (this.snapshots.isNodeDeleted(nodeId) || this.cancelledJobs.has(id)) return;
    await this.snapshots.replaceDetail(nodeId, kind, key, resultData(result));
  }
}
