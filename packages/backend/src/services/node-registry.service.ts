import { randomUUID } from 'node:crypto';
import type { ServerDuplexStream } from '@grpc/grpc-js';
import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { nodes, relayInstances } from '@/db/schema/index.js';
import type {
  NodeHealthReport,
  NodeManagedLinkReport,
  NodeRelayStreamReport,
  NodeStatsReport,
} from '@/db/schema/nodes.js';
import type { CommandResult, DaemonMessage, OpfieldCommand } from '@/grpc/generated/types.js';
import { compactHealthHistory } from '@/lib/health-history.js';
import { createChildLogger } from '@/lib/logger.js';
import type { DockerRuntimeStatus } from '@/modules/docker/docker.schemas.js';
import type { NotificationEvaluatorService } from '@/modules/notifications/notification-evaluator.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import { type LocalRelayOutageSignal, localRelayOutageWaitMs } from '@/services/local-relay-outage.js';
import { NodeOfflineDebounce } from '@/services/node-offline-debounce.js';

const logger = createChildLogger('NodeRegistry');
const TRAFFIC_STATS_CACHE_TTL_MS = 60_000;
const TRAFFIC_STATS_CACHE_MAX_ENTRIES = 4_096;
/** Docker daemons whose health report carries their managed links (HealthReport.managed_links). */
export const MANAGED_LINK_RUNTIME_CAPABILITY = 'managed_link_runtime_v1';
/** The node's link report counts the sessions that ended (completed_total), same-node ones included. */
export const MANAGED_LINK_COMPLETED_CAPABILITY = 'managed_link_completed_v1';
/**
 * After Opfield starts, nodes that were online reconnect to the new process within seconds (1–11 s on a test stand,
 * over the relay). Until then they count as reconnecting, not offline; one still missing after this long is shown
 * offline (stale-node detection marks it in the database later).
 */
export const NODE_STARTUP_RECONNECT_GRACE_MS = 30_000;

function hasUpdateInProgress(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const value = metadata as Record<string, unknown>;
  if (value.updateInProgress !== true) return false;
  // A queued update (waiting for lease peers or for the node's long tasks) has restarted nothing yet: the node's
  // connection problems are real ones.
  if (value.updatePhase === 'waiting_for_lease_peers' || value.updatePhase === 'waiting_for_tasks') return false;
  if (typeof value.updateDeadlineAt !== 'string') return true;
  const deadlineAt = Date.parse(value.updateDeadlineAt);
  return !Number.isFinite(deadlineAt) || Date.now() < deadlineAt;
}

function closeStream(stream: { end?: () => void; destroy?: () => void } | null | undefined): void {
  if (!stream) return;
  try {
    stream.end?.();
  } catch {
    /* ignore */
  }
  try {
    stream.destroy?.();
  } catch {
    /* ignore */
  }
}

export interface ConnectedNode {
  connectionId: string;
  nodeId: string;
  type: 'nginx' | 'bastion' | 'monitoring' | 'docker' | 'builder' | 'databases' | 'storage' | 'relay';
  hostname: string;
  /** The name an operator gave the node (rename); null or absent: the hostname names it. */
  displayName?: string | null;
  commandStream: ServerDuplexStream<DaemonMessage, OpfieldCommand>;
  logStream: ServerDuplexStream<unknown, unknown> | null;
  connectedAt: Date;
  lastHealthReport: NodeHealthReport | null;
  lastReportAt: Date | null;
  lastStatsReport: NodeStatsReport | null;
  lastTrafficStats: Record<string, unknown> | null;
  configVersionHash: string;
  capabilities: ReadonlySet<string>;
  pendingCommands: Map<
    string,
    {
      resolve: (result: CommandResult) => void;
      reject: (error: Error) => void;
      resolveAccepted: () => void;
      rejectAccepted: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >;
}

type PendingCommands = ConnectedNode['pendingCommands'];

/** The node event patterns a connection state (online/offline) observes. */
export const NODE_CONNECTION_PATTERNS = ['offline', 'online'];

/**
 * A daemon that announces this delivers the results of commands it was running when its control stream ended on its
 * next stream, so commands in flight then stay pending (each until its own timeout) instead of failing.
 */
export const COMMAND_RESULTS_RESENT_CAPABILITY = 'command_results_resent_v1';

export interface DispatchedCommand {
  accepted: Promise<void>;
  result: Promise<CommandResult>;
}

export interface TrafficStatsRequest {
  tailLines: number;
  hostId: string;
  windowSeconds: number;
}

export class NodeRegistryService {
  private nodes = new Map<string, ConnectedNode>();
  private updatingNodeIds = new Set<string>();
  private execOutputHandlers = new Map<
    string,
    Set<(data: { execId: string; data: Buffer; exited: boolean; exitCode: number }) => void>
  >();
  private logStreamHandlers = new Map<string, (lines: string[], ended?: boolean) => void>();
  private trafficStatsInFlight = new Map<string, Promise<CommandResult>>();
  private trafficStatsNodeTails = new Map<string, Promise<void>>();
  private trafficStatsCache = new Map<string, { sampledAt: number; result: CommandResult }>();
  /** When a connection was last asked for a health report outside its schedule (requestHealthReport). */
  private readonly healthRequestedAt = new WeakMap<ConnectedNode, number>();
  private readonly offlineDebounce: NodeOfflineDebounce;
  /** When the control server started taking node connections; null until it does. */
  private acceptingConnectionsSince: number | null = null;
  private localRelayOutage?: LocalRelayOutageSignal;
  private disconnectAudit?: (nodeId: string, details: Record<string, unknown>) => Promise<void>;
  /** `node.disconnected` audit rows held back while the local relay restarts; see holdDisconnectAudit. */
  private readonly heldDisconnectAudits = new Map<string, Record<string, unknown>>();
  /** Nodes whose offline decision waits for the local relay, so the wait is logged once. */
  private readonly awaitingLocalRelay = new Set<string>();
  /** Commands in flight on a stream that ended, kept while the node may reconnect (see COMMAND_RESULTS_RESENT_CAPABILITY). */
  private readonly carriedCommands = new Map<string, PendingCommands>();

  constructor(
    private db: DrizzleClient,
    options: { offlineDebounceMs?: number } = {}
  ) {
    this.offlineDebounce = new NodeOfflineDebounce(options.offlineDebounceMs);
  }

  private eventBus?: EventBusService;
  private evaluator?: NotificationEvaluatorService;
  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  setEvaluator(evaluator: NotificationEvaluatorService) {
    this.evaluator = evaluator;
  }

  /** The local relay's outages: a node that dropped with it is reconnecting, not offline (local-relay-outage). */
  setLocalRelayOutage(signal: LocalRelayOutageSignal) {
    this.localRelayOutage = signal;
  }

  /** Writes a held-back `node.disconnected` audit row; see holdDisconnectAudit. */
  setDisconnectAudit(write: (nodeId: string, details: Record<string, unknown>) => Promise<void>) {
    this.disconnectAudit = write;
  }

  setNodeUpdateInProgress(nodeId: string, updating: boolean): void {
    if (updating) this.updatingNodeIds.add(nodeId);
    else this.updatingNodeIds.delete(nodeId);
  }

  isNodeUpdateInProgress(nodeId: string): boolean {
    return this.updatingNodeIds.has(nodeId);
  }

  /**
   * The node is away because a daemon update restarts it (the update keeps its status until it settles, see
   * markDisconnectedOffline): it reads as reconnecting, not offline, for the whole trial (stand rc.8, O-3).
   */
  isAwayForUpdate(nodeId: string, metadata?: unknown): boolean {
    if (this.nodes.has(nodeId)) return false;
    return this.updatingNodeIds.has(nodeId) || hasUpdateInProgress(metadata);
  }

  private isNodeUpdateProtected(nodeId: string, metadata: unknown): boolean {
    if (metadata && typeof metadata === 'object') {
      const protectedByMetadata = hasUpdateInProgress(metadata);
      if (protectedByMetadata) this.updatingNodeIds.add(nodeId);
      else this.updatingNodeIds.delete(nodeId);
      return protectedByMetadata;
    }
    return this.isNodeUpdateInProgress(nodeId);
  }

  /**
   * name: the node's display name, else its hostname (alerts name a node as the rest of Opfield does); hostname: the
   * node's real hostname. The alert context carries {{node.id}}, {{node.name}} and {{details.hostname}} as their names
   * say (rc.3 O-A7: node.id was null and details.hostname held the display name).
   */
  private observeNodeState(nodeId: string, state: 'online' | 'offline', name?: string, hostname?: string) {
    this.evaluator
      ?.observeStatefulEvent(
        'node',
        state,
        { type: 'node', id: nodeId, name: name ?? nodeId },
        { nodeId, node_name: name ?? nodeId, hostname: hostname ?? name },
        // Node Offline and Node Online only: other node states (Docker Engine unavailable) are observed by their own
        // sources and must not be cleared by every connect or report.
        NODE_CONNECTION_PATTERNS
      )
      .catch((error) => {
        logger.debug('Node stateful event observation failed', {
          nodeId,
          state,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  observeDockerContainerState(nodeId: string, id: string, name?: string, state?: string) {
    const normalizedState = this.normalizeDockerContainerState(state);
    if (!normalizedState) return;

    const resourceId = name || id;
    const observedPatterns =
      normalizedState === 'started' || normalizedState === 'removed' ? ['stopped', 'exited'] : [normalizedState];

    this.evaluator
      ?.observeStatefulEvent(
        'container',
        normalizedState,
        { type: 'container', id: resourceId, name: name ?? id },
        { nodeId, containerId: id, state },
        observedPatterns
      )
      .catch((error) => {
        logger.debug('Docker container stateful event observation failed', {
          nodeId,
          containerId: id,
          state,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private normalizeDockerContainerState(state?: string): 'started' | 'stopped' | 'exited' | 'removed' | null {
    switch (state?.toLowerCase()) {
      case 'running':
        return 'started';
      case 'stopped':
        return 'stopped';
      case 'exited':
      case 'dead':
        return 'exited';
      case 'removed':
        return 'removed';
      default:
        return null;
    }
  }

  publishNodeChanged(nodeId: string, status: string, hostname?: string) {
    this.eventBus?.publish('node.changed', { id: nodeId, action: 'updated', status, hostname });
  }

  publishDockerRuntimeChanged(nodeId: string, status: DockerRuntimeStatus) {
    this.eventBus?.publish('docker.runtime.changed', { nodeId, status });
  }

  publishRelayRuntimeChanged(nodeId: string, relayInstanceId: string) {
    this.eventBus?.publish('system.relay.health.changed', {
      nodeId,
      instanceId: relayInstanceId,
      action: 'runtime_status_changed',
    });
  }

  publishDockerContainerChanged(
    nodeId: string,
    id: string,
    name?: string,
    state?: string,
    options: { observe?: boolean } = {}
  ) {
    this.eventBus?.publish('docker.container.changed', {
      nodeId,
      id,
      name,
      action: 'updated',
      state,
    });
    if (options.observe !== false) {
      this.observeDockerContainerState(nodeId, id, name, state);
    }
  }

  registerExecHandler(execId: string, handler: (data: any) => void) {
    let handlers = this.execOutputHandlers.get(execId);
    if (!handlers) {
      handlers = new Set();
      this.execOutputHandlers.set(execId, handlers);
    }
    handlers.add(handler);
  }

  removeExecHandler(execId: string, handler?: (data: any) => void) {
    if (handler) {
      const handlers = this.execOutputHandlers.get(execId);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) this.execOutputHandlers.delete(execId);
      }
    } else {
      this.execOutputHandlers.delete(execId);
    }
  }

  getExecHandlerCount(execId: string): number {
    return this.execOutputHandlers.get(execId)?.size ?? 0;
  }

  handleExecOutput(execId: string, data: any) {
    const handlers = this.execOutputHandlers.get(execId);
    if (handlers) {
      for (const handler of handlers) handler(data);
    }
  }

  registerLogStreamHandler(key: string, handler: (lines: string[], ended?: boolean) => void) {
    this.logStreamHandlers.set(key, handler);
    return () => {
      if (this.logStreamHandlers.get(key) === handler) {
        this.logStreamHandlers.delete(key);
      }
    };
  }

  removeLogStreamHandler(key: string) {
    this.logStreamHandlers.delete(key);
  }

  handleLogStream(key: string, lines: string[], ended?: boolean) {
    const handler = this.logStreamHandlers.get(key);
    if (handler) handler(lines, ended);
  }

  async register(
    nodeId: string,
    type: 'nginx' | 'bastion' | 'monitoring' | 'docker' | 'builder' | 'databases' | 'storage' | 'relay',
    hostname: string,
    configVersionHash: string,
    commandStream: ServerDuplexStream<DaemonMessage, OpfieldCommand>,
    options: { isCurrentRegistration?: () => boolean; capabilities?: string[] } = {}
  ): Promise<void> {
    const connectionId = randomUUID();

    if (options.isCurrentRegistration && !options.isCurrentRegistration()) {
      throw new Error('Registration superseded');
    }

    const [registeredNode] = await this.db
      .update(nodes)
      .set({
        status: 'online',
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(nodes.id, nodeId))
      .returning({ metadata: nodes.metadata, displayName: nodes.displayName });
    if (!registeredNode) {
      closeStream(commandStream);
      throw new Error('Node no longer exists');
    }
    this.setNodeUpdateInProgress(nodeId, hasUpdateInProgress(registeredNode.metadata));

    if (options.isCurrentRegistration && !options.isCurrentRegistration()) {
      throw new Error('Registration superseded');
    }

    // Replace stale/overlapping connection for the same node ID.
    const existing = this.nodes.get(nodeId);
    if (existing) {
      logger.warn('Replacing existing daemon connection for node', { nodeId, hostname });
      this.carryPendingCommands(nodeId, existing);
      closeStream(existing.logStream as any);
      closeStream(existing.commandStream as any);
    }
    const pendingCommands = this.takeCarriedCommands(nodeId, options.capabilities ?? []);

    this.clearTrafficStatsState(nodeId);

    this.nodes.set(nodeId, {
      connectionId,
      nodeId,
      type,
      hostname,
      displayName: registeredNode.displayName ?? null,
      commandStream,
      logStream: null,
      connectedAt: new Date(),
      lastHealthReport: null,
      lastReportAt: null,
      lastStatsReport: null,
      lastTrafficStats: null,
      configVersionHash,
      capabilities: new Set(options.capabilities ?? []),
      pendingCommands,
    });

    if (this.offlineDebounce.cancel(nodeId)) {
      logger.info('Node reconnected before its offline grace elapsed', { nodeId, hostname });
    }
    // Back while the local relay restarted or right after: its drop is not recorded at all.
    this.heldDisconnectAudits.delete(nodeId);
    this.awaitingLocalRelay.delete(nodeId);
    logger.info('Node registered', { nodeId, type, hostname });
    this.observeNodeState(nodeId, 'online', registeredNode.displayName || hostname, hostname);
  }

  async deregister(nodeId: string, commandStream?: ServerDuplexStream<DaemonMessage, OpfieldCommand>): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (!node) return; // Already removed
    if (commandStream && node.commandStream !== commandStream) {
      logger.debug('Ignoring stale deregister for replaced node stream', { nodeId });
      return;
    }

    // A stream that ended on its own may come back in a moment; an explicit removal (no stream) is final.
    const mayReconnect = !!commandStream && this.offlineDebounce.enabled;
    if (mayReconnect) this.carryPendingCommands(nodeId, node);
    else {
      this.cleanupPendingCommands(node);
      this.rejectCarriedCommands(nodeId);
    }
    this.nodes.delete(nodeId);
    this.clearTrafficStatsState(nodeId);

    if (mayReconnect) {
      logger.info('Node stream closed; waiting for it to reconnect before marking it offline', {
        nodeId,
        graceMs: this.offlineDebounce.delayMs,
      });
      // Every control stream runs through the local relay: whether it went down is known before this grace ends.
      void this.localRelayOutage?.confirmLocalRelay();
      this.offlineDebounce.schedule(
        nodeId,
        () => this.settleDisconnect(nodeId, node.hostname),
        this.offlineFailureLogger(nodeId)
      );
      return;
    }
    this.offlineDebounce.cancel(nodeId);
    this.awaitingLocalRelay.delete(nodeId);
    await this.markDisconnectedOffline(nodeId, node.hostname);
  }

  private offlineFailureLogger(nodeId: string) {
    return (error: unknown) =>
      logger.warn('Failed to mark disconnected node offline', {
        nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
  }

  /** How long a node that dropped stays reconnecting because of the local relay; null when no outage covers it. */
  private localRelayWaitMs(now = Date.now()): number | null {
    return localRelayOutageWaitMs(this.localRelayOutage?.latestOutage(), now);
  }

  /**
   * Ends a node's offline grace. A node still away while the local relay does not serve, or within the reconnect grace
   * after it serves again, keeps waiting: its stream ended with the relay, not with the node. One still away after
   * that is marked offline like any other, its alerts only later.
   */
  private async settleDisconnect(nodeId: string, hostname: string): Promise<void> {
    if (this.nodes.has(nodeId)) return;
    let waitMs = this.localRelayWaitMs();
    if (waitMs === null && this.localRelayOutage) {
      // The supervisor probes every few seconds: look at the relay itself before calling the node offline.
      await this.localRelayOutage.confirmLocalRelay();
      waitMs = this.localRelayWaitMs();
    }
    if (waitMs !== null && !this.nodes.has(nodeId)) {
      if (!this.awaitingLocalRelay.has(nodeId)) {
        this.awaitingLocalRelay.add(nodeId);
        logger.info('Node is away while the local relay restarts; it counts as reconnecting', { nodeId, hostname });
      }
      this.offlineDebounce.schedule(
        nodeId,
        () => this.settleDisconnect(nodeId, hostname),
        this.offlineFailureLogger(nodeId),
        waitMs
      );
      return;
    }
    if (this.awaitingLocalRelay.delete(nodeId)) {
      logger.warn('Node did not come back after the local relay restarted; marking it offline', { nodeId, hostname });
    }
    await this.markDisconnectedOffline(nodeId, hostname);
  }

  /**
   * Whether the `node.disconnected` audit row of a stream that just ended is held back: while the local relay does not
   * serve (or nodes are within the reconnect grace after it), every node drops at once, and a row per node would read
   * as the whole fleet failing. A held row is written once the node is judged offline, never when it comes back. The
   * relay is checked first, since its probe may not have seen the outage yet.
   */
  async holdDisconnectAudit(nodeId: string, details: Record<string, unknown>): Promise<boolean> {
    if (!this.localRelayOutage || !this.disconnectAudit) return false;
    if (this.localRelayWaitMs() === null) {
      await this.localRelayOutage.confirmLocalRelay();
      if (this.localRelayWaitMs() === null) return false;
    }
    if (this.nodes.has(nodeId)) return true;
    this.heldDisconnectAudits.set(nodeId, { ...details, disconnectedAt: new Date().toISOString() });
    return true;
  }

  /** Writes the audit row held back for a node that did not come back; see holdDisconnectAudit. */
  private async releaseHeldDisconnectAudit(nodeId: string): Promise<void> {
    const details = this.heldDisconnectAudits.get(nodeId);
    if (!details) return;
    this.heldDisconnectAudits.delete(nodeId);
    await this.disconnectAudit?.(nodeId, details).catch((error) =>
      logger.warn('Failed to record a node stream disconnect', {
        nodeId,
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }

  private async markDisconnectedOffline(nodeId: string, hostname: string): Promise<void> {
    this.rejectCarriedCommands(nodeId);
    // A replacement stream registered meanwhile: the node never went offline.
    if (this.nodes.has(nodeId)) return;
    await this.releaseHeldDisconnectAudit(nodeId);
    // A remote relay's pool state follows its control stream, after the same grace (markRelayInstanceOffline).
    await this.db
      .update(relayInstances)
      .set({ state: 'offline', updatedAt: new Date() })
      .where(eq(relayInstances.nodeId, nodeId));
    if (this.nodes.has(nodeId)) return;
    const [dbNode] = await this.db
      .select({ metadata: nodes.metadata, displayName: nodes.displayName })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (this.isNodeUpdateProtected(nodeId, dbNode?.metadata)) {
      this.updatingNodeIds.add(nodeId);
      logger.info('Node disconnected for daemon update; preserving status', { nodeId });
      return;
    }
    if (this.nodes.has(nodeId)) return;

    await this.db
      .update(nodes)
      .set({
        status: 'offline',
        updatedAt: new Date(),
      })
      .where(eq(nodes.id, nodeId));

    // Record unhealthy hour in health history so the health bar shows the offline state
    await this.recordOfflineStatus(nodeId);

    logger.info('Node deregistered', { nodeId });
    this.eventBus?.publish('node.changed', {
      id: nodeId,
      action: 'updated',
      status: 'offline',
      hostname,
    });
    this.observeNodeState(nodeId, 'offline', dbNode?.displayName || hostname, hostname);
  }

  getNode(nodeId: string): ConnectedNode | undefined {
    return this.nodes.get(nodeId);
  }

  /**
   * The name of a connected node as the rest of Opfield shows it: its display name, else its hostname; undefined when
   * it is not connected. Alerts, events and availability views all name a node this way.
   */
  nodeName(nodeId: string): string | undefined {
    const node = this.nodes.get(nodeId);
    return node ? node.displayName || node.hostname : undefined;
  }

  /** A renamed node keeps its new name in the alerts and events of its live connection. */
  setDisplayName(nodeId: string, displayName: string | null): void {
    const node = this.nodes.get(nodeId);
    if (node) node.displayName = displayName;
  }

  /** Called once the control server listens: the startup reconnect grace runs from here. */
  startAcceptingConnections(now = Date.now()): void {
    this.acceptingConnectionsSince ??= now;
  }

  /**
   * The node is not connected but is expected back: its stream closed moments ago and it is still inside the
   * reconnect grace, the local relay every stream runs through restarts (or restarted moments ago), or Opfield itself
   * started moments ago and the node has not reconnected to it yet.
   */
  isReconnecting(nodeId: string, now = Date.now()): boolean {
    if (this.nodes.has(nodeId)) return false;
    if (this.offlineDebounce.isPending(nodeId)) return true;
    // While the local relay restarts every node is expected back, also one that never reached this process yet.
    if (this.localRelayWaitMs(now) !== null) return true;
    return (
      this.acceptingConnectionsSince === null || now - this.acceptingConnectionsSince < NODE_STARTUP_RECONNECT_GRACE_MS
    );
  }

  /**
   * The node is not connected while the local relay does not serve, or served again moments ago. Callers ask this of
   * nodes still online in the database: their offline transition waits for the relay, so one offline there was gone
   * before it.
   */
  isAwaitingLocalRelay(nodeId: string, now = Date.now()): boolean {
    return !this.nodes.has(nodeId) && this.localRelayWaitMs(now) !== null;
  }

  /**
   * Marks a node that is still disconnected offline once its daemon update stopped covering it, with the health
   * history entry, event and alert of an ordinary disconnect. While the local relay restarts it waits like any drop.
   */
  async markOfflineAfterUpdate(nodeId: string): Promise<void> {
    if (this.nodes.has(nodeId)) return;
    const [row] = await this.db.select({ hostname: nodes.hostname }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!row) return;
    await this.settleDisconnect(nodeId, row.hostname);
  }

  hasCapability(nodeId: string, capability: string): boolean {
    return this.nodes.get(nodeId)?.capabilities.has(capability) ?? false;
  }

  /**
   * What the node running a managed link's workloads last reported about the link: `link` is null when the report
   * leaves it out (the link has no connections there). Null when the node is not connected, has not reported since it
   * connected, or its daemon does not report links.
   */
  managedLinkReport(
    nodeId: string,
    ownerKind: string,
    ownerId: string
  ): { link: NodeManagedLinkReport | null; reportedAt: Date; countsCompleted?: boolean } | null {
    const node = this.nodes.get(nodeId);
    if (!node?.capabilities.has(MANAGED_LINK_RUNTIME_CAPABILITY) || !node.lastHealthReport || !node.lastReportAt) {
      return null;
    }
    const links = node.lastHealthReport.managedLinks ?? [];
    const link = links.find((candidate) => candidate.ownerKind === ownerKind && candidate.ownerId === ownerId);
    // The proto reads an absent completed_total as 0: a node counts completions when it says so, or once it reported one.
    const countsCompleted =
      node.capabilities.has(MANAGED_LINK_COMPLETED_CAPABILITY) ||
      links.some((candidate) => (candidate.completedTotal ?? 0) > 0);
    return { link: link ?? null, reportedAt: node.lastReportAt, countsCompleted };
  }

  /**
   * The relay stream sessions (RSv1) connected daemons reported within maxAgeMs. Daemons that do not report them are
   * left out; their streams are raw.
   */
  relayStreamReports(maxAgeMs = 90_000, now = Date.now()): Array<{ nodeId: string; report: NodeRelayStreamReport }> {
    const reports: Array<{ nodeId: string; report: NodeRelayStreamReport }> = [];
    for (const [nodeId, node] of this.nodes) {
      const report = node.lastHealthReport?.relayStreams;
      if (!report || !node.lastReportAt || now - node.lastReportAt.getTime() > maxAgeMs) continue;
      reports.push({ nodeId, report });
    }
    return reports;
  }

  /**
   * Asks a connected node for a health report now, at most once per minIntervalMs (fire and forget): a link runtime
   * being watched gets the node's current counts instead of a report up to 30 s old.
   */
  requestHealthReport(nodeId: string, minIntervalMs: number): void {
    const node = this.nodes.get(nodeId);
    if (!node || this.isNodeUpdateInProgress(nodeId)) return;
    const now = Date.now();
    if (now - (this.healthRequestedAt.get(node) ?? 0) < minIntervalMs) return;
    this.healthRequestedAt.set(node, now);
    try {
      node.commandStream.write({ commandId: '', requestHealth: {} }, (error: Error | null | undefined) => {
        if (error) logger.debug('Health request write failed', { nodeId, error: error.message });
      });
    } catch {
      // The stream is closing; the next registration reports again.
    }
  }

  getAllNodes(): ConnectedNode[] {
    return Array.from(this.nodes.values());
  }

  getNodesByType(
    type: 'nginx' | 'bastion' | 'monitoring' | 'docker' | 'databases' | 'storage' | 'relay'
  ): ConnectedNode[] {
    return this.getAllNodes().filter((n) => n.type === type);
  }

  getConnectedNodeIds(): string[] {
    return Array.from(this.nodes.keys());
  }

  async sendCommand(nodeId: string, command: Partial<OpfieldCommand>, timeoutMs = 30000): Promise<CommandResult> {
    const dispatched = this.dispatchCommand(nodeId, command, timeoutMs);
    void dispatched.accepted.catch(() => {});
    return dispatched.result;
  }

  /**
   * Coalesces equivalent traffic samples and serializes access-log scans per
   * nginx node. The cache is last-good only: failed samples never replace it.
   */
  requestTrafficStats(nodeId: string, request: TrafficStatsRequest, minFreshMs = 0): Promise<CommandResult> {
    const connectionId = this.nodes.get(nodeId)?.connectionId;
    if (!connectionId) return Promise.reject(new Error(`Node ${nodeId} is not connected`));
    const key = `${nodeId}\u0000${request.hostId}\u0000${request.tailLines}\u0000${request.windowSeconds}`;
    this.pruneTrafficStatsCache(Date.now());
    const cached = this.trafficStatsCache.get(key);
    if (cached && minFreshMs > 0 && Date.now() - cached.sampledAt < minFreshMs) {
      return Promise.resolve(cached.result);
    }

    const active = this.trafficStatsInFlight.get(key);
    if (active) return active;

    const previous = this.trafficStatsNodeTails.get(nodeId) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(() => {
        if (this.nodes.get(nodeId)?.connectionId !== connectionId) {
          throw new Error(`Node ${nodeId} connection changed before traffic stats request`);
        }
        return this.sendCommand(nodeId, { requestTrafficStats: request }, 10_000);
      })
      .then((result) => {
        if (result.success) {
          const sampledAt = Date.now();
          this.trafficStatsCache.set(key, { sampledAt, result });
          this.pruneTrafficStatsCache(sampledAt);
          if (!request.hostId && result.detail) {
            try {
              const node = this.nodes.get(nodeId);
              if (node) node.lastTrafficStats = JSON.parse(result.detail);
            } catch {
              // Keep the previous last-good node snapshot on malformed output.
            }
          }
        }
        return result;
      })
      .finally(() => {
        if (this.trafficStatsInFlight.get(key) === task) this.trafficStatsInFlight.delete(key);
      });
    this.trafficStatsInFlight.set(key, task);

    const tail = task.then(
      () => undefined,
      () => undefined
    );
    this.trafficStatsNodeTails.set(nodeId, tail);
    void tail.then(() => {
      if (this.trafficStatsNodeTails.get(nodeId) === tail) this.trafficStatsNodeTails.delete(nodeId);
    });
    return task;
  }

  private pruneTrafficStatsCache(now: number): void {
    for (const [key, cached] of this.trafficStatsCache) {
      if (now - cached.sampledAt >= TRAFFIC_STATS_CACHE_TTL_MS) this.trafficStatsCache.delete(key);
    }
    if (this.trafficStatsCache.size <= TRAFFIC_STATS_CACHE_MAX_ENTRIES) return;
    const overflow = this.trafficStatsCache.size - TRAFFIC_STATS_CACHE_MAX_ENTRIES;
    const oldestKeys = [...this.trafficStatsCache.entries()]
      .sort((left, right) => left[1].sampledAt - right[1].sampledAt)
      .slice(0, overflow)
      .map(([key]) => key);
    for (const key of oldestKeys) this.trafficStatsCache.delete(key);
  }

  private clearTrafficStatsState(nodeId: string): void {
    const prefix = `${nodeId}\u0000`;
    for (const key of this.trafficStatsCache.keys()) {
      if (key.startsWith(prefix)) this.trafficStatsCache.delete(key);
    }
    for (const key of this.trafficStatsInFlight.keys()) {
      if (key.startsWith(prefix)) this.trafficStatsInFlight.delete(key);
    }
    this.trafficStatsNodeTails.delete(nodeId);
  }

  dispatchCommand(nodeId: string, command: Partial<OpfieldCommand>, timeoutMs = 30000): DispatchedCommand {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} is not connected`);
    }

    // A caller may name the command (a pull's task records the ID to ask the daemon for its outcome later).
    const commandId = command.commandId || randomUUID();
    const sentAt = Date.now();
    const fullCommand: OpfieldCommand = {
      ...command,
      commandId,
      // The daemon drops a command that is already past the point where the
      // Opfield stops waiting for it. It judges the deadline against sentAt,
      // on the Opfield clock, so clock skew between hosts cannot expire it.
      // Older daemons ignore both fields.
      expiresAtUnixMs: String(sentAt + timeoutMs),
      sentAtUnixMs: String(sentAt),
    };

    let resolveAccepted!: () => void;
    let rejectAccepted!: (error: Error) => void;
    const accepted = new Promise<void>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });

    const result = new Promise<CommandResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        node.pendingCommands.delete(commandId);
        // The stream the command went out on ended meanwhile (a daemon update, a reconnect) and no answer came over
        // the next one: the command was lost with that stream, as when a stream ends without a next one (stand rc.12
        // F-2: health probes sent while a batch updated their nodes warned as timeouts).
        const error =
          this.nodes.get(nodeId)?.connectionId === node.connectionId
            ? new Error(`Command ${commandId} timed out after ${timeoutMs}ms`)
            : new Error('Node disconnected');
        rejectAccepted(error);
        reject(error);
      }, timeoutMs);

      node.pendingCommands.set(commandId, {
        resolve,
        reject,
        resolveAccepted,
        rejectAccepted,
        timeout,
      });

      node.commandStream.write(fullCommand, (err: Error | null | undefined) => {
        if (err) {
          clearTimeout(timeout);
          node.pendingCommands.delete(commandId);
          const error = new Error(`Failed to send command: ${err.message}`);
          rejectAccepted(error);
          reject(error);
          return;
        }
        resolveAccepted();
      });
    });

    return { accepted, result };
  }

  /** Fire-and-forget: write a command to the stream without awaiting a response */
  sendCommandNoWait(nodeId: string, command: Partial<OpfieldCommand>): void {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} is not connected`);
    }

    const fullCommand: OpfieldCommand = {
      commandId: '',
      ...command,
    };

    node.commandStream.write(fullCommand, (err: Error | null | undefined) => {
      if (err) {
        logger.debug('Fire-and-forget write failed', { nodeId, error: err.message });
      }
    });
  }

  handleCommandResult(nodeId: string, result: CommandResult): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    const pending = node.pendingCommands.get(result.commandId);
    if (pending) {
      clearTimeout(pending.timeout);
      node.pendingCommands.delete(result.commandId);
      pending.resolveAccepted();
      pending.resolve(result);
    }
  }

  updateHealthReport(nodeId: string, report: NodeHealthReport): void {
    const node = this.nodes.get(nodeId);
    if (node) {
      const previousIngressAddresses = [
        ...(node.lastHealthReport?.localIpAddresses ?? []),
        ...(node.lastHealthReport?.publicIpAddresses ?? []),
      ]
        .map((address) => address.trim())
        .filter(Boolean)
        .sort();
      const nextIngressAddresses = [...(report.localIpAddresses ?? []), ...(report.publicIpAddresses ?? [])]
        .map((address) => address.trim())
        .filter(Boolean)
        .sort();
      node.lastHealthReport = report;
      node.lastReportAt = new Date();
      if (node.type === 'nginx' && previousIngressAddresses.join('\u0000') !== nextIngressAddresses.join('\u0000')) {
        this.eventBus?.publish('node.ingress_addresses.changed', { id: nodeId });
      }
    }
  }

  updateStatsReport(nodeId: string, report: NodeStatsReport): void {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.lastStatsReport = report;
    }
  }

  async updateLastSeen(nodeId: string): Promise<void> {
    await this.db
      .update(nodes)
      .set({
        lastSeenAt: new Date(),
      })
      .where(eq(nodes.id, nodeId));
  }

  /** Mark nodes as offline if they haven't been seen recently */
  async markStaleNodesOffline(staleThresholdMs = 90000): Promise<void> {
    const now = Date.now();
    // Nodes stop reporting while the local relay does not serve; they are judged once its reconnect grace is over.
    if (this.localRelayWaitMs(now) !== null) return;
    const connectedIds = this.getConnectedNodeIds();

    // For nodes that are in the DB as 'online' but not in our connected set
    // This handles ungraceful disconnects that the gRPC layer didn't catch
    const dbOnlineNodes = await this.db
      .select({
        id: nodes.id,
        hostname: nodes.hostname,
        displayName: nodes.displayName,
        lastSeenAt: nodes.lastSeenAt,
        metadata: nodes.metadata,
      })
      .from(nodes)
      .where(eq(nodes.status, 'online'));

    for (const dbNode of dbOnlineNodes) {
      if (this.isNodeUpdateProtected(dbNode.id, dbNode.metadata)) continue;
      // Its own offline grace settles a node whose stream ended in this process.
      if (this.offlineDebounce.isPending(dbNode.id)) continue;
      if (!connectedIds.includes(dbNode.id)) {
        const lastSeen = dbNode.lastSeenAt?.getTime() ?? 0;
        if (now - lastSeen > staleThresholdMs) {
          await this.db
            .update(nodes)
            .set({
              status: 'offline',
              updatedAt: new Date(),
            })
            .where(eq(nodes.id, dbNode.id));
          await this.recordOfflineStatus(dbNode.id);
          logger.warn('Marked stale node as offline', { nodeId: dbNode.id });
          this.eventBus?.publish('node.changed', {
            id: dbNode.id,
            action: 'updated',
            status: 'offline',
            hostname: dbNode.hostname,
          });
          this.observeNodeState(
            dbNode.id,
            'offline',
            dbNode.displayName || dbNode.hostname || undefined,
            dbNode.hostname || undefined
          );
        }
      }
    }
  }

  /** Record ongoing offline entries for disconnected nodes + detect missed reports from connected ones */
  async recordHealthChecks(missedThresholdMs = 60000): Promise<void> {
    const now = Date.now();

    // 1. Connected nodes that stopped sending reports — mark offline and notify
    for (const node of this.nodes.values()) {
      if (!node.lastReportAt) continue;
      const elapsed = now - node.lastReportAt.getTime();
      if (elapsed > missedThresholdMs) {
        // Update DB status and publish event (only once per transition)
        const [dbRow] = await this.db
          .select({ status: nodes.status, metadata: nodes.metadata })
          .from(nodes)
          .where(eq(nodes.id, node.nodeId))
          .limit(1);
        if (this.isNodeUpdateProtected(node.nodeId, dbRow?.metadata)) continue;

        await this.recordOfflineStatus(node.nodeId);
        if (dbRow?.status === 'online') {
          await this.db
            .update(nodes)
            .set({ status: 'offline', updatedAt: new Date() })
            .where(eq(nodes.id, node.nodeId));
          this.eventBus?.publish('node.changed', {
            id: node.nodeId,
            action: 'updated',
            status: 'offline',
            hostname: node.hostname,
          });
          this.observeNodeState(node.nodeId, 'offline', node.displayName || node.hostname, node.hostname);
          logger.warn('Marked connected node offline (missed health reports)', {
            nodeId: node.nodeId,
            elapsedMs: elapsed,
          });
        } else if (dbRow?.status === 'offline') {
          this.observeNodeState(node.nodeId, 'offline', node.displayName || node.hostname, node.hostname);
        }
      }
    }

    // 2. Disconnected nodes — keep recording offline entries (same as proxy health check job)
    const connectedIds = this.getConnectedNodeIds();
    const offlineNodes = await this.db
      .select({ id: nodes.id, hostname: nodes.hostname, displayName: nodes.displayName, metadata: nodes.metadata })
      .from(nodes)
      .where(eq(nodes.status, 'offline'));

    for (const dbNode of offlineNodes) {
      if (this.isNodeUpdateProtected(dbNode.id, dbNode.metadata)) continue;
      if (!connectedIds.includes(dbNode.id)) {
        await this.recordOfflineStatus(dbNode.id);
        this.observeNodeState(
          dbNode.id,
          'offline',
          dbNode.displayName || dbNode.hostname || undefined,
          dbNode.hostname || undefined
        );
      }
    }
  }

  /** Record an offline entry in health history (same format as proxy health checks) */
  private async recordOfflineStatus(nodeId: string): Promise<void> {
    try {
      const nowMs = Date.now();
      const [row] = await this.db
        .select({ healthHistory: nodes.healthHistory })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .limit(1);

      const history = compactHealthHistory(
        [
          ...((row?.healthHistory as Array<{ ts: string; status: string }>) ?? []),
          { ts: new Date(nowMs).toISOString(), status: 'offline' },
        ],
        { nowMs }
      );

      await this.db.update(nodes).set({ healthHistory: history }).where(eq(nodes.id, nodeId));
    } catch (err) {
      logger.warn('Failed to record offline status', { nodeId, error: (err as Error).message });
    }
  }

  private cleanupPendingCommands(node: ConnectedNode): void {
    rejectPendingCommands(node.pendingCommands);
  }

  /**
   * Keeps the commands of a stream that ended for the node's next stream (each still ends at its own timeout) when its
   * daemon resends results across a reconnect; fails them at once otherwise.
   */
  private carryPendingCommands(nodeId: string, node: ConnectedNode): void {
    const pending = node.pendingCommands;
    if (!node.capabilities.has(COMMAND_RESULTS_RESENT_CAPABILITY)) {
      rejectPendingCommands(pending);
      return;
    }
    if (pending.size === 0) return;
    const carried = this.carriedCommands.get(nodeId);
    if (!carried) {
      this.carriedCommands.set(nodeId, pending);
      return;
    }
    for (const [id, command] of pending) carried.set(id, command);
    pending.clear();
  }

  /**
   * The commands the node's next stream takes over: all that are still pending when the daemon resends the results of
   * commands it ran across a reconnect; none otherwise (they fail as the stream ended).
   */
  private takeCarriedCommands(nodeId: string, capabilities: readonly string[]): PendingCommands {
    const carried = this.carriedCommands.get(nodeId);
    this.carriedCommands.delete(nodeId);
    if (!carried) return new Map();
    if (capabilities.includes(COMMAND_RESULTS_RESENT_CAPABILITY)) return carried;
    rejectPendingCommands(carried);
    return new Map();
  }

  private rejectCarriedCommands(nodeId: string): void {
    const carried = this.carriedCommands.get(nodeId);
    if (!carried) return;
    this.carriedCommands.delete(nodeId);
    rejectPendingCommands(carried);
  }
}

function rejectPendingCommands(pending: PendingCommands): void {
  for (const [id, command] of pending) {
    clearTimeout(command.timeout);
    const error = new Error('Node disconnected');
    command.rejectAccepted(error);
    command.reject(error);
    pending.delete(id);
  }
}
