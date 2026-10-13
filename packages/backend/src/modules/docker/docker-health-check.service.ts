import { and, desc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  auditLog,
  type DockerHealthEntry,
  type DockerHealthStatus,
  dockerAccessResources,
  dockerAvailabilityPlacements,
  dockerAvailabilityPolicies,
  dockerComposeProjects,
  dockerDeploymentRoutes,
  dockerDeployments,
  dockerHealthChecks,
  managedDatabaseBindings,
} from '@/db/schema/index.js';
import { compactHealthHistory } from '@/lib/health-history.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { NotificationEvaluatorService } from '@/modules/notifications/notification-evaluator.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { DockerWorkloadResolverService } from './availability/docker-workload-resolver.service.js';
import type { DockerHealthCheckUpsertInput } from './docker.schemas.js';
import { isDockerDeploymentManaged } from './docker-deployment-labels.js';
import { DEFAULT_CONFIG, healthAction, normalizePath, parseDispatchResult } from './docker-health-check.helpers.js';

const logger = createChildLogger('DockerHealthCheckService');

/** Within this long after start, a probe that failed only because its node has not reconnected yet is retried. */
export const DOCKER_HEALTH_RECONNECT_GRACE_MS = 60_000;
/** Consecutive failed probes before a workload that was up is reported offline; one success brings it back. */
export const DOCKER_HEALTH_OFFLINE_AFTER_FAILURES = 2;
/** Consecutive checks that must see a binding in `error` before the workload is reported offline for it. */
export const DOCKER_HEALTH_BINDING_ERROR_CHECKS = 2;
/** Binding events for one workload within this window cause a single recheck. */
export const DOCKER_HEALTH_RECHECK_DEBOUNCE_MS = 5_000;

type ProbeOutcome = {
  ok: boolean;
  status: DockerHealthStatus | 'stopped';
  responseMs?: number;
  httpStatus?: number;
  skipped?: boolean;
  /** The probe never reached the daemon because this node was not connected. */
  unreachableNodeId?: string;
};

/** The registry's not-connected / disconnected errors and the dispatch layer's wrappers of them. */
export function isNodeUnreachableError(error: unknown): boolean {
  if (error instanceof AppError && ['NODE_NOT_CONNECTED', 'AVAILABILITY_NODE_DISCONNECTED'].includes(error.code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message === 'Node disconnected' || /^Node \S+ is not connected$/.test(message);
}

function healthCheckDue(row: Pick<HealthRow, 'lastHealthCheckAt' | 'intervalSeconds'>, now: number): boolean {
  if (!row.lastHealthCheckAt) return true;
  return now - new Date(row.lastHealthCheckAt).getTime() >= Math.max(5, row.intervalSeconds ?? 30) * 1000;
}

export interface DockerHealthRouteOption {
  id: string;
  scheme: 'http' | 'https';
  hostPort: number;
  containerPort: number;
  label: string;
  isPrimary?: boolean;
}

export interface DockerHealthCheckDto {
  id: string | null;
  target: 'container' | 'deployment';
  nodeId: string;
  containerName: string | null;
  deploymentId: string | null;
  enabled: boolean;
  scheme: 'http' | 'https';
  hostPort: number | null;
  containerPort: number | null;
  path: string;
  statusMin: number;
  statusMax: number;
  expectedBody: string | null;
  bodyMatchMode: 'includes' | 'exact' | 'starts_with' | 'ends_with';
  intervalSeconds: number;
  timeoutSeconds: number;
  slowThreshold: number;
  healthStatus: DockerHealthStatus | 'stopped';
  lastHealthCheckAt: Date | null;
  healthHistory: DockerHealthEntry[];
  routeOptions: DockerHealthRouteOption[];
}

type HealthRow = typeof dockerHealthChecks.$inferSelect;
type HealthTarget = Pick<HealthRow, 'target' | 'nodeId' | 'containerName' | 'deploymentId'>;
type HealthWorkloadResolver = Pick<DockerWorkloadResolverService, 'resolveContainerRuntimeTarget'> &
  Partial<Pick<DockerWorkloadResolverService, 'findPolicy'>>;

export class DockerHealthCheckService {
  private eventBus?: EventBusService;
  private evaluator?: NotificationEvaluatorService;
  private workloadResolver?: HealthWorkloadResolver;
  private readonly startedAt = Date.now();
  /** Consecutive failed probes per health check row, kept until a probe succeeds. */
  private readonly failureStreaks = new Map<string, number>();
  /** Consecutive checks per row that saw a managed database binding in `error`. */
  private readonly bindingErrorStreaks = new Map<string, number>();
  /** Rows being checked; a recheck and the scheduled run never check one row at the same time. */
  private readonly inFlight = new Set<string>();
  private readonly recheckTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly dispatch: NodeDispatchService
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
    // Relay health is not judged here: a binding's own status reflects its path, and its changes arrive as
    // database.changed. Each burst of those events causes at most one recheck per workload, and only when due.
    bus.subscribe('database.changed', (payload) => {
      const event = payload as {
        resourceKind?: unknown;
        targetNodeId?: unknown;
        targetType?: unknown;
        targetResourceId?: unknown;
      } | null;
      if (
        event?.resourceKind !== 'managed_database_binding' ||
        typeof event.targetNodeId !== 'string' ||
        (event.targetType !== 'container' && event.targetType !== 'deployment') ||
        typeof event.targetResourceId !== 'string'
      ) {
        return;
      }
      this.scheduleRecheck(event.targetNodeId, event.targetType, event.targetResourceId);
    });
  }

  setEvaluator(evaluator: NotificationEvaluatorService) {
    this.evaluator = evaluator;
  }

  setWorkloadResolver(resolver: HealthWorkloadResolver) {
    this.workloadResolver = resolver;
  }

  async getContainer(nodeId: string, containerName: string): Promise<DockerHealthCheckDto> {
    const identity = { target: 'container' as const, nodeId, containerName, deploymentId: null };
    const stopped = await this.isIntentionallyStopped(identity);
    const [row, options] = await Promise.all([
      this.db.query.dockerHealthChecks.findFirst({
        where: and(
          eq(dockerHealthChecks.target, 'container'),
          eq(dockerHealthChecks.nodeId, nodeId),
          eq(dockerHealthChecks.containerName, containerName)
        ),
      }),
      stopped ? Promise.resolve([]) : this.getContainerRouteOptions(nodeId, containerName),
    ]);
    const dto = this.toDto(row ?? null, identity, options);
    return stopped ? { ...dto, healthStatus: 'stopped' } : dto;
  }

  async getDeployment(nodeId: string, deploymentId: string): Promise<DockerHealthCheckDto> {
    const [deployment] = await this.db
      .select({ id: dockerDeployments.id })
      .from(dockerDeployments)
      .where(and(eq(dockerDeployments.nodeId, nodeId), eq(dockerDeployments.id, deploymentId)))
      .limit(1);
    if (!deployment) throw new AppError(404, 'NOT_FOUND', 'Deployment not found');

    await this.ensureDeploymentDefault(nodeId, deploymentId);
    const [row, options] = await Promise.all([
      this.db.query.dockerHealthChecks.findFirst({
        where: and(eq(dockerHealthChecks.target, 'deployment'), eq(dockerHealthChecks.deploymentId, deploymentId)),
      }),
      this.getDeploymentRouteOptions(deploymentId),
    ]);
    const dto = this.toDto(row ?? null, { target: 'deployment', nodeId, containerName: null, deploymentId }, options);
    return (await this.isIntentionallyStopped(dto)) ? { ...dto, healthStatus: 'stopped' } : dto;
  }

  async upsertContainer(nodeId: string, containerName: string, input: DockerHealthCheckUpsertInput) {
    const routeOptions = await this.getContainerRouteOptions(nodeId, containerName);
    const values = this.normalizeInput(input, routeOptions, 'container');
    const [row] = await this.db
      .insert(dockerHealthChecks)
      .values({
        target: 'container',
        nodeId,
        containerName,
        deploymentId: null,
        ...values,
        healthStatus: values.enabled ? 'unknown' : 'disabled',
        healthHistory: [],
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [dockerHealthChecks.nodeId, dockerHealthChecks.containerName],
        set: { ...values, healthStatus: values.enabled ? 'unknown' : 'disabled', updatedAt: new Date() },
      })
      .returning();
    this.eventBus?.publish('docker.health.changed', {
      action: 'health.configured',
      target: 'container',
      nodeId,
      containerName,
      healthCheckId: row.id,
    });
    return this.toDto(row, { target: 'container', nodeId, containerName, deploymentId: null }, routeOptions);
  }

  async upsertDeployment(nodeId: string, deploymentId: string, input: DockerHealthCheckUpsertInput) {
    const deployment = await this.db.query.dockerDeployments.findFirst({
      where: and(eq(dockerDeployments.nodeId, nodeId), eq(dockerDeployments.id, deploymentId)),
    });
    if (!deployment) throw new AppError(404, 'NOT_FOUND', 'Deployment not found');

    const routeOptions = await this.getDeploymentRouteOptions(deploymentId);
    const values = this.normalizeInput(input, routeOptions, 'deployment');
    const [row] = await this.db
      .insert(dockerHealthChecks)
      .values({
        target: 'deployment',
        nodeId,
        containerName: null,
        deploymentId,
        ...values,
        healthStatus: values.enabled ? 'unknown' : 'disabled',
        healthHistory: [],
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: dockerHealthChecks.deploymentId,
        set: { ...values, healthStatus: values.enabled ? 'unknown' : 'disabled', updatedAt: new Date() },
      })
      .returning();
    await this.db
      .update(dockerDeployments)
      .set({
        healthConfig: {
          ...deployment.healthConfig,
          path: values.path,
          statusMin: values.statusMin,
          statusMax: values.statusMax,
          intervalSeconds: values.intervalSeconds,
          timeoutSeconds: values.timeoutSeconds,
        },
        updatedAt: new Date(),
      })
      .where(and(eq(dockerDeployments.nodeId, nodeId), eq(dockerDeployments.id, deploymentId)));
    if (values.hostPort && values.containerPort) {
      await this.db
        .update(dockerDeploymentRoutes)
        .set({ isPrimary: false })
        .where(eq(dockerDeploymentRoutes.deploymentId, deploymentId));
      await this.db
        .update(dockerDeploymentRoutes)
        .set({ isPrimary: true })
        .where(
          and(
            eq(dockerDeploymentRoutes.deploymentId, deploymentId),
            eq(dockerDeploymentRoutes.hostPort, values.hostPort),
            eq(dockerDeploymentRoutes.containerPort, values.containerPort)
          )
        );
    }
    this.eventBus?.publish('docker.health.changed', {
      action: 'health.configured',
      target: 'deployment',
      nodeId,
      deploymentId,
      healthCheckId: row.id,
    });
    return this.toDto(row, { target: 'deployment', nodeId, containerName: null, deploymentId }, routeOptions);
  }

  async testContainer(nodeId: string, containerName: string, input?: DockerHealthCheckUpsertInput) {
    if (await this.isIntentionallyStopped({ target: 'container', nodeId, containerName, deploymentId: null })) {
      return { ok: true, status: 'stopped' as const, skipped: true };
    }
    const current = await this.getContainer(nodeId, containerName);
    const config = input
      ? this.mergeDto(current, this.normalizeInput(input, current.routeOptions, 'container'))
      : current;
    return this.probeConfig(config, true);
  }

  async testDeployment(nodeId: string, deploymentId: string, input?: DockerHealthCheckUpsertInput) {
    if (await this.isIntentionallyStopped({ target: 'deployment', nodeId, deploymentId, containerName: null })) {
      return { ok: true, status: 'stopped' as const, skipped: true };
    }
    const current = await this.getDeployment(nodeId, deploymentId);
    const config = input
      ? this.mergeDto(current, this.normalizeInput(input, current.routeOptions, 'deployment'))
      : current;
    return this.probeConfig(config, true);
  }

  async getRowsForContainers(nodeId: string, containerNames: string[]) {
    if (containerNames.length === 0) return new Map<string, HealthRow>();
    const rows = await this.db
      .select({
        id: dockerHealthChecks.id,
        target: dockerHealthChecks.target,
        nodeId: dockerHealthChecks.nodeId,
        containerName: dockerHealthChecks.containerName,
        deploymentId: dockerHealthChecks.deploymentId,
        enabled: dockerHealthChecks.enabled,
        healthStatus: dockerHealthChecks.healthStatus,
        lastHealthCheckAt: dockerHealthChecks.lastHealthCheckAt,
      })
      .from(dockerHealthChecks)
      .where(
        and(
          eq(dockerHealthChecks.target, 'container'),
          eq(dockerHealthChecks.nodeId, nodeId),
          inArray(dockerHealthChecks.containerName, containerNames)
        )
      );
    const projected = await this.projectStoppedHealth(rows);
    return new Map(projected.flatMap((row) => (row.containerName ? [[row.containerName, row] as const] : [])));
  }

  async listNavigationHealth() {
    const rows = await this.db
      .select({
        target: dockerHealthChecks.target,
        nodeId: dockerHealthChecks.nodeId,
        deploymentId: dockerHealthChecks.deploymentId,
        containerResourceId: dockerAccessResources.id,
        containerName: dockerHealthChecks.containerName,
        enabled: dockerHealthChecks.enabled,
        healthStatus: dockerHealthChecks.healthStatus,
      })
      .from(dockerHealthChecks)
      .leftJoin(
        dockerAccessResources,
        and(
          eq(dockerHealthChecks.target, 'container'),
          eq(dockerHealthChecks.nodeId, dockerAccessResources.nodeId),
          eq(dockerHealthChecks.containerName, dockerAccessResources.resourceKey)
        )
      )
      .where(eq(dockerHealthChecks.enabled, true));

    const projected = await this.projectStoppedHealth(rows);
    return projected.flatMap((row) => {
      const resourceId = row.target === 'deployment' ? row.deploymentId : row.containerResourceId;
      return resourceId
        ? [
            {
              nodeId: row.nodeId,
              resourceId,
              containerName: row.containerName,
              deploymentId: row.deploymentId,
              enabled: row.enabled,
              healthStatus: row.healthStatus,
            },
          ]
        : [];
    });
  }

  async getRowsForDeployments(deploymentIds: string[]) {
    if (deploymentIds.length === 0) return new Map<string, HealthRow>();
    const rows = await this.db
      .select({
        id: dockerHealthChecks.id,
        target: dockerHealthChecks.target,
        nodeId: dockerHealthChecks.nodeId,
        containerName: dockerHealthChecks.containerName,
        deploymentId: dockerHealthChecks.deploymentId,
        enabled: dockerHealthChecks.enabled,
        healthStatus: dockerHealthChecks.healthStatus,
        lastHealthCheckAt: dockerHealthChecks.lastHealthCheckAt,
      })
      .from(dockerHealthChecks)
      .where(and(eq(dockerHealthChecks.target, 'deployment'), inArray(dockerHealthChecks.deploymentId, deploymentIds)));
    const projected = await this.projectStoppedHealth(rows);
    return new Map(projected.flatMap((row) => (row.deploymentId ? [[row.deploymentId, row] as const] : [])));
  }

  private async projectStoppedHealth<T extends HealthTarget & { healthStatus: DockerHealthStatus }>(rows: T[]) {
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        healthStatus: (await this.isIntentionallyStopped(row)) ? ('stopped' as const) : row.healthStatus,
      }))
    );
  }

  async ensureDeploymentDefault(nodeId: string, deploymentId: string) {
    const [deployment] = await this.db
      .select({
        id: dockerDeployments.id,
        nodeId: dockerDeployments.nodeId,
        healthConfig: dockerDeployments.healthConfig,
      })
      .from(dockerDeployments)
      .where(and(eq(dockerDeployments.nodeId, nodeId), eq(dockerDeployments.id, deploymentId)))
      .limit(1);
    if (!deployment) return null;

    const routes = await this.db
      .select()
      .from(dockerDeploymentRoutes)
      .where(eq(dockerDeploymentRoutes.deploymentId, deploymentId));
    const primary = routes.find((route) => route.isPrimary) ?? routes[0];
    if (!primary) return null;

    const [row] = await this.db
      .insert(dockerHealthChecks)
      .values({
        target: 'deployment',
        nodeId,
        deploymentId,
        enabled: true,
        scheme: 'http',
        hostPort: primary.hostPort,
        containerPort: primary.containerPort,
        path: deployment.healthConfig.path,
        statusMin: deployment.healthConfig.statusMin,
        statusMax: deployment.healthConfig.statusMax,
        intervalSeconds: Math.max(5, deployment.healthConfig.intervalSeconds),
        timeoutSeconds: deployment.healthConfig.timeoutSeconds,
        slowThreshold: 1000,
        healthStatus: 'unknown',
      })
      .onConflictDoNothing({ target: dockerHealthChecks.deploymentId })
      .returning();
    return row ?? null;
  }

  async alignDeploymentHealthCheck(nodeId: string, deploymentId: string) {
    await this.ensureDeploymentDefault(nodeId, deploymentId);
    const [row] = await this.db
      .select()
      .from(dockerHealthChecks)
      .where(and(eq(dockerHealthChecks.target, 'deployment'), eq(dockerHealthChecks.deploymentId, deploymentId)))
      .limit(1);
    if (!row) return;

    const [deployment, routes] = await Promise.all([
      this.db.query.dockerDeployments.findFirst({ where: eq(dockerDeployments.id, deploymentId) }),
      this.db.select().from(dockerDeploymentRoutes).where(eq(dockerDeploymentRoutes.deploymentId, deploymentId)),
    ]);
    if (!deployment || routes.length === 0) return;

    const selected =
      routes.find((route) => route.hostPort === row.hostPort && route.containerPort === row.containerPort) ??
      routes.find((route) => route.isPrimary) ??
      routes[0];
    await this.db
      .update(dockerHealthChecks)
      .set({
        hostPort: selected.hostPort,
        containerPort: selected.containerPort,
        path: deployment.healthConfig.path,
        statusMin: deployment.healthConfig.statusMin,
        statusMax: deployment.healthConfig.statusMax,
        intervalSeconds: Math.max(5, deployment.healthConfig.intervalSeconds),
        timeoutSeconds: deployment.healthConfig.timeoutSeconds,
        updatedAt: new Date(),
      })
      .where(eq(dockerHealthChecks.id, row.id));
  }

  async runDueChecks(now = new Date()) {
    const dueRows = await this.db
      .select()
      .from(dockerHealthChecks)
      .where(
        and(
          eq(dockerHealthChecks.enabled, true),
          or(
            sql`${dockerHealthChecks.lastHealthCheckAt} IS NULL`,
            lte(
              dockerHealthChecks.lastHealthCheckAt,
              sql`${now.toISOString()}::timestamptz - (${dockerHealthChecks.intervalSeconds} * interval '1 second')`
            )
          )
        )
      );
    if (dueRows.length === 0) return;

    const results = await Promise.allSettled(dueRows.map((row) => this.checkAndStore(row)));
    const errors = results.filter((result) => result.status === 'rejected');
    if (errors.length > 0) {
      logger.warn('Some Docker health checks failed to execute', { errors: errors.length, total: dueRows.length });
    }
  }

  private async checkAndStore(row: HealthRow) {
    if (this.inFlight.has(row.id)) return;
    this.inFlight.add(row.id);
    try {
      await this.checkAndStoreRow(row);
    } finally {
      this.inFlight.delete(row.id);
    }
  }

  /**
   * Whether a probe that never reached its node should be retried instead of recorded: Opfield started moments ago,
   * the node's stream closed moments ago, or the node's daemon is being updated. Same graces as the route job.
   */
  private async nodeExpectedBack(nodeId: string): Promise<boolean> {
    if (Date.now() - this.startedAt < DOCKER_HEALTH_RECONNECT_GRACE_MS) return true;
    if (this.dispatch.isNodeReconnecting?.(nodeId)) return true;
    return (await this.dispatch.isNodeUpdateInProgress?.(nodeId)?.catch(() => false)) === true;
  }

  private async checkAndStoreRow(row: HealthRow) {
    const previousStatus = row.healthStatus as DockerHealthStatus;
    const probe: ProbeOutcome = await this.probeRow(row);
    if (probe.status === 'stopped') return this.storeStopped(row);
    if (probe.unreachableNodeId && (await this.nodeExpectedBack(probe.unreachableNodeId))) {
      // Nothing is recorded and lastHealthCheckAt stays, so the next run probes again once the node is back.
      logger.debug('Docker health probe waits for its node to reconnect', {
        healthCheckId: row.id,
        nodeId: probe.unreachableNodeId,
      });
      return;
    }
    const probeFailed = probe.status === 'offline';
    const failures = probeFailed ? (this.failureStreaks.get(row.id) ?? 0) + 1 : 0;
    if (probeFailed) this.failureStreaks.set(row.id, failures);
    else this.failureStreaks.delete(row.id);
    if (probeFailed && previousStatus !== 'offline' && failures < DOCKER_HEALTH_OFFLINE_AFTER_FAILURES) {
      // One failed probe is not an outage: keep the status, record and report nothing, probe again next run.
      return;
    }
    const dependency = await this.databaseDependencyState(row);
    // A stop may have been requested while a probe/dependency lookup was in flight.
    if (await this.isIntentionallyStopped(row)) return this.storeStopped(row);
    const status: DockerHealthStatus = dependency.offline ? 'offline' : probe.status;
    const entry: DockerHealthEntry = {
      ts: new Date().toISOString(),
      status,
      ...(probe.responseMs !== undefined ? { responseMs: probe.responseMs } : {}),
      ...(status === 'degraded' ? { slow: true } : {}),
    };
    const history = compactHealthHistory([...((row.healthHistory ?? []) as DockerHealthEntry[]), entry]);

    await this.db
      .update(dockerHealthChecks)
      .set({ healthStatus: status, lastHealthCheckAt: new Date(), healthHistory: history, updatedAt: new Date() })
      .where(eq(dockerHealthChecks.id, row.id));

    const resourceType = row.target === 'deployment' ? 'docker_deployment' : 'docker_container';
    const resourceId = row.target === 'deployment' ? row.deploymentId! : row.containerName!;
    const resourceName =
      row.target === 'deployment' ? await this.getDeploymentName(row.deploymentId!) : row.containerName!;
    if (await this.isIntentionallyStopped(row)) return this.storeStopped(row, true);
    await this.evaluator?.observeStatefulEvent(
      'container',
      healthAction(status),
      { type: resourceType, id: resourceId, name: resourceName },
      {
        health_status: status,
        ...(dependency.cause ? { health_cause: dependency.cause } : {}),
        nodeId: row.nodeId,
        resource_type: resourceType,
      },
      ['health.online', 'health.degraded', 'health.offline']
    );
    if (dependency.hasBindings) {
      await this.evaluator?.observeStatefulEvent(
        'container',
        dependency.offline ? 'dependency.database_offline' : 'dependency.database_online',
        { type: resourceType, id: resourceId, name: resourceName },
        { health_status: status, health_cause: dependency.cause, nodeId: row.nodeId, resource_type: resourceType },
        ['dependency.database_offline']
      );
    }

    if (previousStatus !== status) {
      this.eventBus?.publish('docker.health.changed', {
        action: healthAction(status),
        health_status: status,
        healthStatus: status,
        previousStatus,
        target: row.target,
        nodeId: row.nodeId,
        containerName: row.containerName,
        deploymentId: row.deploymentId,
        id: resourceId,
        name: resourceName,
        resourceType,
        health_cause: dependency.cause,
      });
    }
  }

  private async storeStopped(row: HealthRow, discardInFlightSample = false): Promise<void> {
    // health_status is a PostgreSQL enum. Keep its existing neutral value while
    // exposing intentional stop separately; do not disable the configured check.
    await this.db
      .update(dockerHealthChecks)
      .set({
        healthStatus: 'disabled',
        lastHealthCheckAt: new Date(),
        updatedAt: new Date(),
        ...(discardInFlightSample ? { healthHistory: row.healthHistory } : {}),
      })
      .where(eq(dockerHealthChecks.id, row.id));
    if (row.healthStatus === 'disabled') return;
    this.eventBus?.publish('docker.health.changed', {
      action: 'health.stopped',
      health_status: 'stopped',
      healthStatus: 'stopped',
      previousStatus: row.healthStatus,
      target: row.target,
      nodeId: row.nodeId,
      containerName: row.containerName,
      deploymentId: row.deploymentId,
      id: row.deploymentId ?? row.containerName,
      resourceType: row.target === 'deployment' ? 'docker_deployment' : 'docker_container',
      health_cause: null,
    });
  }

  private async databaseDependencyState(row: HealthRow): Promise<{
    offline: boolean;
    cause: 'binding_error' | null;
    hasBindings: boolean;
  }> {
    const targetResourceId = row.target === 'deployment' ? row.deploymentId : row.containerName;
    if (!targetResourceId || typeof (this.db as { select?: unknown }).select !== 'function') {
      return { offline: false, cause: null, hasBindings: false };
    }
    const bindings = await this.db
      .select({ status: managedDatabaseBindings.status })
      .from(managedDatabaseBindings)
      .where(
        and(
          eq(managedDatabaseBindings.targetNodeId, row.nodeId),
          eq(managedDatabaseBindings.targetType, row.target),
          eq(managedDatabaseBindings.targetResourceId, targetResourceId)
        )
      );
    // Judged only by the bindings' own status, never by a global relay signal. A binding that flips to `error` for
    // one check (a relay or node restart) does not take the workload offline; one that stays in error does.
    const bindingError = bindings.some((binding) => binding.status === 'error');
    const errorChecks = bindingError ? (this.bindingErrorStreaks.get(row.id) ?? 0) + 1 : 0;
    if (bindingError) this.bindingErrorStreaks.set(row.id, errorChecks);
    else this.bindingErrorStreaks.delete(row.id);
    if (bindings.length === 0) return { offline: false, cause: null, hasBindings: false };
    if (errorChecks >= DOCKER_HEALTH_BINDING_ERROR_CHECKS) {
      return { offline: true, cause: 'binding_error', hasBindings: true };
    }
    return { offline: false, cause: null, hasBindings: true };
  }

  private scheduleRecheck(nodeId: string, target: 'container' | 'deployment', targetResourceId: string): void {
    const key = `${nodeId}:${target}:${targetResourceId}`;
    if (this.recheckTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.recheckTimers.delete(key);
      this.recheckTarget(nodeId, target, targetResourceId).catch((error) => {
        logger.debug('Docker health recheck failed', {
          nodeId,
          target,
          targetResourceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, DOCKER_HEALTH_RECHECK_DEBOUNCE_MS);
    timer.unref?.();
    this.recheckTimers.set(key, timer);
  }

  private async recheckTarget(
    nodeId: string,
    target: 'container' | 'deployment' | 'compose_service',
    targetResourceId: string
  ): Promise<void> {
    if (target === 'compose_service') return;
    const row = await this.db.query.dockerHealthChecks.findFirst({
      where:
        target === 'deployment'
          ? and(
              eq(dockerHealthChecks.enabled, true),
              eq(dockerHealthChecks.target, 'deployment'),
              eq(dockerHealthChecks.nodeId, nodeId),
              eq(dockerHealthChecks.deploymentId, targetResourceId)
            )
          : and(
              eq(dockerHealthChecks.enabled, true),
              eq(dockerHealthChecks.target, 'container'),
              eq(dockerHealthChecks.nodeId, nodeId),
              eq(dockerHealthChecks.containerName, targetResourceId)
            ),
    });
    // A row checked within its interval waits for its turn: history never gets more than one sample per interval.
    if (row && healthCheckDue(row, Date.now())) await this.checkAndStore(row);
  }

  private async getDeploymentName(deploymentId: string) {
    const row = await this.db.query.dockerDeployments.findFirst({ where: eq(dockerDeployments.id, deploymentId) });
    return row?.name ?? deploymentId;
  }

  private async probeRow(row: HealthRow): Promise<ProbeOutcome> {
    const availability = await this.availabilityHealth(row);
    if (availability) return availability;
    const probeNodeId = await this.resolveAvailabilityProbeNodeId(row);
    let options: DockerHealthRouteOption[] = [];
    if (row.target === 'deployment' && row.deploymentId) {
      options = await this.getDeploymentRouteOptions(row.deploymentId);
    } else if (row.containerName) {
      try {
        options = await this.getContainerRouteOptions(row.nodeId, row.containerName);
      } catch (error) {
        // A node that cannot be asked is not a container without its route.
        if (isNodeUnreachableError(error)) {
          return { ok: false, status: 'offline', unreachableNodeId: row.nodeId };
        }
        options = [];
      }
    }
    const routeAvailable = options.some(
      (option) => option.hostPort === row.hostPort && option.containerPort === row.containerPort
    );
    if (!routeAvailable) return { ok: false, status: 'offline' as DockerHealthStatus };

    return this.probeConfig(
      this.toDto(
        row,
        {
          target: row.target,
          nodeId: probeNodeId,
          containerName: row.containerName,
          deploymentId: row.deploymentId,
        },
        options
      ),
      false
    );
  }

  private async findAvailabilityPolicy(row: HealthTarget) {
    if (this.workloadResolver?.findPolicy) {
      const resource =
        row.target === 'deployment' && row.deploymentId
          ? { type: 'deployment' as const, deploymentId: row.deploymentId }
          : row.containerName
            ? { type: 'container' as const, nodeId: row.nodeId, containerName: row.containerName }
            : null;
      const policy = resource ? await this.workloadResolver.findPolicy(resource) : null;
      return policy;
    }
    const resourceCondition =
      row.target === 'deployment' && row.deploymentId
        ? and(
            eq(dockerAvailabilityPolicies.resourceKind, 'deployment'),
            eq(dockerAvailabilityPolicies.deploymentId, row.deploymentId)
          )
        : row.target === 'container' && row.containerName
          ? and(
              eq(dockerAvailabilityPolicies.resourceKind, 'container'),
              eq(dockerAvailabilityPolicies.sourceNodeId, row.nodeId),
              eq(dockerAvailabilityPolicies.containerName, row.containerName)
            )
          : null;
    if (!resourceCondition || typeof (this.db as { select?: unknown }).select !== 'function') return null;
    const [policy] = await this.db
      .select({
        id: dockerAvailabilityPolicies.id,
        mode: dockerAvailabilityPolicies.mode,
        shouldRun: dockerAvailabilityPolicies.shouldRun,
        composeProjectId: dockerAvailabilityPolicies.composeProjectId,
        desiredReplicaCount: dockerAvailabilityPolicies.desiredReplicaCount,
      })
      .from(dockerAvailabilityPolicies)
      .where(resourceCondition)
      .limit(1);
    return policy ?? null;
  }

  private async isIntentionallyStopped(row: HealthTarget): Promise<boolean> {
    const policy = await this.findAvailabilityPolicy(row);
    if (policy && policy.mode !== 'single') return policy.shouldRun === false;
    return this.singleWorkloadStopped(row, policy);
  }

  private async singleWorkloadStopped(
    row: HealthTarget,
    policy?: { composeProjectId?: string | null } | null
  ): Promise<boolean> {
    if (typeof (this.db as { select?: unknown }).select !== 'function') return false;
    if (row.target === 'deployment' && row.deploymentId) {
      const [deployment] = await this.db
        .select({ status: dockerDeployments.status })
        .from(dockerDeployments)
        .where(eq(dockerDeployments.id, row.deploymentId))
        .limit(1);
      return deployment?.status === 'stopped';
    }
    if (policy?.composeProjectId) {
      const [project] = await this.db
        .select({ desiredState: dockerComposeProjects.desiredState })
        .from(dockerComposeProjects)
        .where(eq(dockerComposeProjects.id, policy.composeProjectId))
        .limit(1);
      return project?.desiredState === 'stopped';
    }
    if (!row.containerName) return false;
    const [resource] = await this.db
      .select({ runtimeId: dockerAccessResources.runtimeId })
      .from(dockerAccessResources)
      .where(
        and(eq(dockerAccessResources.nodeId, row.nodeId), eq(dockerAccessResources.resourceKey, row.containerName))
      )
      .limit(1);
    // A runtime's exited/offline state is not stop intent. Only a successful,
    // explicit Stop after its last Start/Restart/Create/Kill/Remove qualifies.
    const runtimeIds = [row.containerName, ...(resource?.runtimeId ? [resource.runtimeId] : [])];
    const [lastLifecycle] = await this.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.resourceType, 'docker-container'),
          inArray(auditLog.resourceId, runtimeIds),
          sql`${auditLog.details}->>'nodeId' = ${row.nodeId}`,
          inArray(auditLog.action, [
            'docker.container.stop',
            'docker.container.start',
            'docker.container.restart',
            'docker.container.create',
            'docker.container.recreate',
            'docker.container.kill',
            'docker.container.remove',
          ])
        )
      )
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(1);
    return lastLifecycle?.action === 'docker.container.stop';
  }

  private async availabilityHealth(
    row: HealthTarget
  ): Promise<{ ok: boolean; status: DockerHealthStatus | 'stopped'; responseMs?: number } | null> {
    const policy = await this.findAvailabilityPolicy(row);
    if (!policy || policy.mode === 'single') {
      return (await this.singleWorkloadStopped(row, policy)) ? { ok: true, status: 'stopped' } : null;
    }
    if (policy.shouldRun === false) return { ok: true, status: 'stopped' };
    const placements = await this.db
      .select({
        serving: dockerAvailabilityPlacements.serving,
        actualState: dockerAvailabilityPlacements.actualState,
        dependencyState: dockerAvailabilityPlacements.dependencyState,
        applicationHealth: dockerAvailabilityPlacements.applicationHealth,
      })
      .from(dockerAvailabilityPlacements)
      .where(eq(dockerAvailabilityPlacements.policyId, policy.id));
    const desired = policy.mode === 'replicated' ? policy.desiredReplicaCount : 1;
    const serving = placements.filter((placement) => placement.serving && placement.actualState === 'serving');
    const healthy = serving.filter(
      (placement) => placement.dependencyState === 'ready' && placement.applicationHealth === 'healthy'
    );
    const status: DockerHealthStatus =
      healthy.length >= desired ? 'online' : healthy.length > 0 || serving.length > 0 ? 'degraded' : 'offline';
    return { ok: status !== 'offline', status };
  }

  private async resolveAvailabilityProbeNodeId(row: HealthRow): Promise<string> {
    const resourceCondition =
      row.target === 'deployment' && row.deploymentId
        ? and(
            eq(dockerAvailabilityPolicies.resourceKind, 'deployment'),
            eq(dockerAvailabilityPolicies.deploymentId, row.deploymentId)
          )
        : row.target === 'container' && row.containerName
          ? and(
              eq(dockerAvailabilityPolicies.resourceKind, 'container'),
              eq(dockerAvailabilityPolicies.sourceNodeId, row.nodeId),
              eq(dockerAvailabilityPolicies.containerName, row.containerName)
            )
          : null;
    if (!resourceCondition || typeof (this.db as { select?: unknown }).select !== 'function') return row.nodeId;

    const [placement] = await this.db
      .select({ nodeId: dockerAvailabilityPlacements.nodeId })
      .from(dockerAvailabilityPlacements)
      .innerJoin(dockerAvailabilityPolicies, eq(dockerAvailabilityPolicies.id, dockerAvailabilityPlacements.policyId))
      .where(
        and(
          resourceCondition,
          inArray(dockerAvailabilityPolicies.mode, ['replicated', 'failover']),
          eq(dockerAvailabilityPlacements.generation, dockerAvailabilityPolicies.desiredGeneration),
          eq(dockerAvailabilityPlacements.serving, true),
          eq(dockerAvailabilityPlacements.actualState, 'serving')
        )
      )
      .orderBy(desc(dockerAvailabilityPlacements.updatedAt))
      .limit(1);
    return placement?.nodeId ?? row.nodeId;
  }

  private async probeConfig(config: DockerHealthCheckDto, requireEnabledRoute: boolean): Promise<ProbeOutcome> {
    if (await this.isIntentionallyStopped(config)) return { ok: true, status: 'stopped' as const, skipped: true };
    if (!config.enabled && requireEnabledRoute) {
      throw new AppError(400, 'HEALTH_CHECK_DISABLED', 'Enable the health check before testing it');
    }
    if (!config.hostPort || !config.containerPort) {
      throw new AppError(400, 'HEALTH_ROUTE_REQUIRED', 'Select a published HTTP route before testing health');
    }
    try {
      const result = await this.dispatch.sendDockerContainerCommand(
        config.nodeId,
        'http_probe',
        {
          configJson: JSON.stringify({
            scheme: config.scheme,
            hostPort: config.hostPort,
            path: normalizePath(config.path),
            statusMin: config.statusMin,
            statusMax: config.statusMax,
            expectedBody: config.expectedBody ?? '',
            bodyMatchMode: config.bodyMatchMode,
            timeoutSeconds: config.timeoutSeconds,
            slowThreshold: config.slowThreshold,
          }),
        },
        config.timeoutSeconds * 1000 + 5000
      );
      if (await this.isIntentionallyStopped(config)) return { ok: true, status: 'stopped' as const, skipped: true };
      const probe = parseDispatchResult(result) as {
        ok?: boolean;
        status?: DockerHealthStatus;
        httpStatus?: number;
        responseMs?: number;
        error?: string;
      };
      return {
        ok: Boolean(probe?.ok),
        status: probe?.status ?? ('offline' as DockerHealthStatus),
        httpStatus: probe?.httpStatus,
        responseMs: probe?.responseMs,
      };
    } catch (error) {
      if (await this.isIntentionallyStopped(config)) return { ok: true, status: 'stopped' as const, skipped: true };
      logger.debug('Docker health probe failed', {
        nodeId: config.nodeId,
        hostPort: config.hostPort,
        path: config.path,
        error: error instanceof Error ? error.message : String(error),
      });
      const unreachable = isNodeUnreachableError(error) || !this.dispatch.isNodeConnected(config.nodeId);
      return {
        ok: false,
        status: 'offline' as DockerHealthStatus,
        ...(unreachable ? { unreachableNodeId: config.nodeId } : {}),
      };
    }
  }

  private normalizeInput(
    input: DockerHealthCheckUpsertInput,
    options: DockerHealthRouteOption[],
    target: 'container' | 'deployment'
  ) {
    const hostPort = input.hostPort ?? null;
    const containerPort = input.containerPort ?? null;
    if (input.enabled && (!hostPort || !containerPort)) {
      throw new AppError(400, 'HEALTH_ROUTE_REQUIRED', 'Select a published HTTP route before enabling health checks');
    }
    if (hostPort && containerPort) {
      const found = options.some((option) => option.hostPort === hostPort && option.containerPort === containerPort);
      if (!found) {
        throw new AppError(
          400,
          'HEALTH_ROUTE_INVALID',
          target === 'deployment'
            ? 'Selected route is not configured for this deployment'
            : 'Selected route is not a published port on this container'
        );
      }
    }
    return {
      enabled: input.enabled,
      scheme: input.scheme,
      hostPort,
      containerPort,
      path: normalizePath(input.path),
      statusMin: input.statusMin,
      statusMax: input.statusMax,
      expectedBody: input.expectedBody?.trim() ? input.expectedBody : null,
      bodyMatchMode: input.bodyMatchMode,
      intervalSeconds: input.intervalSeconds,
      timeoutSeconds: input.timeoutSeconds,
      slowThreshold: input.slowThreshold,
    };
  }

  private mergeDto(
    current: DockerHealthCheckDto,
    input: ReturnType<DockerHealthCheckService['normalizeInput']>
  ): DockerHealthCheckDto {
    return {
      ...current,
      ...input,
      healthStatus: current.healthStatus,
      healthHistory: current.healthHistory,
      lastHealthCheckAt: current.lastHealthCheckAt,
      routeOptions: current.routeOptions,
    };
  }

  private toDto(
    row: HealthRow | null,
    identity: {
      target: 'container' | 'deployment';
      nodeId: string;
      containerName: string | null;
      deploymentId: string | null;
    },
    routeOptions: DockerHealthRouteOption[]
  ): DockerHealthCheckDto {
    const source = row ?? DEFAULT_CONFIG;
    return {
      id: row?.id ?? null,
      target: identity.target,
      nodeId: identity.nodeId,
      containerName: identity.containerName,
      deploymentId: identity.deploymentId,
      enabled: source.enabled,
      scheme: source.scheme,
      hostPort: source.hostPort,
      containerPort: source.containerPort,
      path: source.path,
      statusMin: source.statusMin,
      statusMax: source.statusMax,
      expectedBody: source.expectedBody,
      bodyMatchMode: source.bodyMatchMode,
      intervalSeconds: source.intervalSeconds,
      timeoutSeconds: source.timeoutSeconds,
      slowThreshold: source.slowThreshold,
      healthStatus: row?.healthStatus ?? (source.enabled ? 'unknown' : 'disabled'),
      lastHealthCheckAt: source.lastHealthCheckAt,
      healthHistory: source.healthHistory ?? [],
      routeOptions,
    };
  }

  private async getContainerRouteOptions(nodeId: string, containerName: string): Promise<DockerHealthRouteOption[]> {
    const runtimeTarget = await this.workloadResolver?.resolveContainerRuntimeTarget(nodeId, containerName);
    const inspectNodeId = runtimeTarget?.nodeId ?? nodeId;
    const inspectContainerId = runtimeTarget?.containerId ?? containerName;
    const result = await this.dispatch.sendDockerContainerCommand(inspectNodeId, 'inspect', {
      containerId: inspectContainerId,
    });
    if (!result.success) throw new AppError(502, 'DISPATCH_ERROR', result.error || 'Could not inspect container');
    const inspect = result.detail ? JSON.parse(result.detail) : null;
    const labels = inspect?.Config?.Labels ?? {};
    if (isDockerDeploymentManaged(labels)) {
      throw new AppError(
        409,
        'MANAGED_DEPLOYMENT_CONTAINER',
        'This container is managed by a blue/green deployment. Use deployment settings instead.'
      );
    }
    const bindings = (inspect?.HostConfig?.PortBindings ?? {}) as Record<
      string,
      Array<{ HostPort?: string; HostIp?: string }> | null
    >;
    return Object.entries(bindings).flatMap(([privatePort, published]) => {
      if (!published) return [];
      const [containerPortRaw, proto] = privatePort.split('/');
      if (proto && proto !== 'tcp') return [];
      const containerPort = Number(containerPortRaw);
      return published.flatMap((binding) => {
        const hostPort = Number(binding.HostPort);
        if (!Number.isFinite(hostPort) || !Number.isFinite(containerPort)) return [];
        return [
          {
            id: `${hostPort}:${containerPort}`,
            scheme: 'http' as const,
            hostPort,
            containerPort,
            label: `${hostPort} -> ${containerPort}`,
          },
        ];
      });
    });
  }

  private async getDeploymentRouteOptions(deploymentId: string): Promise<DockerHealthRouteOption[]> {
    const routes = await this.db
      .select()
      .from(dockerDeploymentRoutes)
      .where(eq(dockerDeploymentRoutes.deploymentId, deploymentId));
    return routes.map((route) => ({
      id: `${route.hostPort}:${route.containerPort}`,
      scheme: 'http' as const,
      hostPort: route.hostPort,
      containerPort: route.containerPort,
      label: `${route.hostPort} -> ${route.containerPort}`,
      isPrimary: route.isPrimary,
    }));
  }
}
