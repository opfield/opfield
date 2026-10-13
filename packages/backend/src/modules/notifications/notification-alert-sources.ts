import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  appEnvironments,
  appIncidents,
  apps,
  backupPolicies,
  backupRuns,
  databaseConnections,
  domains,
  proxyHosts,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { resolveIngressNodesForMany } from '@/modules/ingress-groups/ingress-nodes.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import type { MetricSnapshot, NotificationEvaluatorService } from './notification-evaluator.service.js';
import { type RouteTrafficSample, routeTrafficMetrics } from './notification-metrics.js';

const logger = createChildLogger('AlertSources');

/** How often the sources are read; request metrics cover the minute before each reading. */
export const ALERT_SOURCES_INTERVAL_MS = 30_000;
/** App states, container restarts, backups and domains are read every other tick. */
const SLOW_SOURCES_EVERY = 2;
const TRAFFIC_WINDOW_SECONDS = 60;
const TRAFFIC_TAIL_LINES = 5_000;
const TRAFFIC_CONCURRENCY = 4;
const HOUR_MS = 60 * 60 * 1000;
const OPEN_INCIDENT_STATES = ['applying', 'active', 'releasing'] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids of a rule scope that can name a row (rule scopes are free strings). */
function uuids(ids: Iterable<string>): string[] {
  return [...ids].filter((id) => UUID_PATTERN.test(id));
}

/** Scopes under which every app member counts, as for an administrator (the Apps list health of all resources). */
export const APP_ALERT_HEALTH_SCOPES = [
  'proxy:view',
  'databases:view',
  'storage:view',
  'pages:view',
  'docker:compose:view',
  'docker:containers:view',
] as const;

type Evaluator = Pick<
  NotificationEvaluatorService,
  | 'evaluateMetricSnapshots'
  | 'evaluateContainerMetric'
  | 'observeStatefulEvent'
  | 'hasEnabledRules'
  | 'enabledRuleScopes'
>;

type Dispatch = {
  isNodeConnected(nodeId: string | null): boolean;
  requestTrafficStats(
    nodeId: string,
    tailLines?: number,
    options?: { hostId?: string; windowSeconds?: number }
  ): Promise<{ success: boolean; detail?: string }>;
};

interface AppMemberLike {
  type: string;
  id: string;
  environmentId: string;
}

export interface AlertSourceDeps {
  db: DrizzleClient;
  evaluator: Evaluator;
  dispatch: Dispatch;
  registry: Pick<NodeRegistryService, 'getNodesByType'>;
  /** Members of app environments (no visibility filter). */
  appMembers?: () => { listMembers(environmentIds: readonly string[]): Promise<AppMemberLike[]> } | null;
  /** The Apps list health of environments. */
  appHealth?: () => {
    summarizeEnvironments(
      scopes: readonly string[],
      environmentIds: readonly string[]
    ): Promise<Map<string, { health: string; failing: number; degraded: number }>>;
  } | null;
  /** Cached container inspects of a node by container name (Docker snapshot details). */
  containerDetails?: (nodeId: string) => Promise<Record<string, { data?: unknown } | undefined>>;
}

/** Docker RestartCount and runtime id from a cached inspect. */
export function restartReading(data: unknown): { runtimeId: string; restartCount: number } | null {
  const record = (data ?? {}) as Record<string, unknown>;
  const count = record.RestartCount ?? record.restartCount;
  const runtimeId = record.Id ?? record.id;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || typeof runtimeId !== 'string') return null;
  return { runtimeId, restartCount: count };
}

/** Restarts within the last hour from readings of one container (oldest first); a new runtime starts over. */
export function restartsInLastHour(
  readings: ReadonlyArray<{ at: number; runtimeId: string; restartCount: number }>,
  now: number
): number {
  const latest = readings.at(-1);
  if (!latest) return 0;
  const sameRuntime = readings.filter(
    (reading) => reading.runtimeId === latest.runtimeId && now - reading.at <= HOUR_MS
  );
  // The oldest reading of this runtime within the hour is the baseline; restarts before it are not counted.
  const baseline = sameRuntime[0] ?? latest;
  return Math.max(0, latest.restartCount - baseline.restartCount);
}

/**
 * Periodic sources of alerts that no event publishes: request metrics of routes and app environments (the nginx access
 * logs of the last minute), app environment states (health, kill switch, shutdown, maintenance), container restarts
 * per hour, scheduled backups and domain DNS. Each part runs only while an enabled rule needs it.
 */
export class AlertSourceMonitor {
  private ticks = 0;
  private running: Promise<void> | null = null;
  /** RestartCount readings per `<node>\0<container>`, the last hour. */
  private readonly restartReadings = new Map<string, Array<{ at: number; runtimeId: string; restartCount: number }>>();

  constructor(private readonly deps: AlertSourceDeps) {}

  tick(now = Date.now()): Promise<void> {
    if (this.running) return this.running;
    const slow = this.ticks % SLOW_SOURCES_EVERY === 0;
    this.ticks += 1;
    this.running = this.runOnce(now, slow).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async runOnce(now = Date.now(), slow = true): Promise<void> {
    const parts: Array<[string, () => Promise<void>]> = [['traffic', () => this.trafficMetrics()]];
    if (slow) {
      parts.push(
        ['app states', () => this.appStates()],
        ['container restarts', () => this.containerRestarts(now)],
        ['backups', () => this.backups(now)],
        ['domains', () => this.domainDns()]
      );
    }
    for (const [name, run] of parts) {
      try {
        await run();
      } catch (error) {
        logger.warn('Alert source failed', { source: name, error: error instanceof Error ? error.message : error });
      }
    }
  }

  // ── Request metrics of routes and app environments ──────────────────

  async trafficMetrics(): Promise<void> {
    const { evaluator } = this.deps;
    const wantsRoutes = await evaluator.hasEnabledRules('proxy', 'threshold');
    const wantsApps = await evaluator.hasEnabledRules('app', 'threshold');
    if (!wantsRoutes && !wantsApps) return;

    const routeScope = wantsRoutes ? await evaluator.enabledRuleScopes('proxy', 'threshold') : new Set<string>();
    const appRoutes = wantsApps
      ? await this.appRouteMembers(await evaluator.enabledRuleScopes('app', 'threshold'))
      : [];
    const routeIds = uuids(new Set([...(routeScope ?? []), ...appRoutes.map((member) => member.id)]));
    if (routeScope !== null && routeIds.length === 0) return;

    const hosts = await this.deps.db
      .select({
        id: proxyHosts.id,
        enabled: proxyHosts.enabled,
        domainNames: proxyHosts.domainNames,
        nodeId: proxyHosts.nodeId,
        ingressGroupId: proxyHosts.ingressGroupId,
      })
      .from(proxyHosts)
      .where(
        routeScope === null
          ? eq(proxyHosts.isSystem, false)
          : and(eq(proxyHosts.isSystem, false), inArray(proxyHosts.id, routeIds))
      );
    if (hosts.length === 0) return;
    const traffic = await this.routeTraffic(hosts);

    if (wantsRoutes) {
      const snapshots: MetricSnapshot[] = [];
      for (const host of hosts) {
        if (routeScope !== null && !routeScope.has(host.id)) continue;
        const samples = traffic.get(host.id);
        if (!samples) continue;
        snapshots.push(trafficSnapshot(host.id, host.id, host.domainNames?.[0] ?? host.id, samples));
      }
      await evaluator.evaluateMetricSnapshots('proxy', snapshots, ALERT_SOURCES_INTERVAL_MS);
    }

    if (wantsApps && appRoutes.length > 0) {
      const names = await this.environmentNames([...new Set(appRoutes.map((member) => member.environmentId))]);
      const byEnvironment = new Map<string, RouteTrafficSample[]>();
      for (const member of appRoutes) {
        const samples = traffic.get(member.id);
        if (!samples) continue;
        byEnvironment.set(member.environmentId, [...(byEnvironment.get(member.environmentId) ?? []), ...samples]);
      }
      const snapshots: MetricSnapshot[] = [];
      for (const [environmentId, samples] of byEnvironment) {
        const env = names.get(environmentId);
        if (!env) continue;
        snapshots.push(trafficSnapshot(`${env.appId}:${environmentId}`, environmentId, env.label, samples));
      }
      await evaluator.evaluateMetricSnapshots('app', snapshots, ALERT_SOURCES_INTERVAL_MS);
    }
  }

  /** The last minute of each route's access log on each node serving it; a disabled route has no traffic. */
  private async routeTraffic(
    hosts: ReadonlyArray<{ id: string; enabled: boolean; nodeId: string | null; ingressGroupId: string | null }>
  ): Promise<Map<string, RouteTrafficSample[]>> {
    const result = new Map<string, RouteTrafficSample[]>();
    const enabled = hosts.filter((host) => {
      if (!host.enabled) result.set(host.id, []);
      return host.enabled;
    });
    const nodesByHost = await resolveIngressNodesForMany(this.deps.db, enabled);
    const work = enabled.map((host) => async () => {
      const nodeIds = (nodesByHost.get(host) ?? []).filter((nodeId) => this.deps.dispatch.isNodeConnected(nodeId));
      // No node answers for the route: no reading (its node alerts say why), rather than a quiet 0 %.
      if (nodeIds.length === 0) return;
      const reports = await Promise.all(
        nodeIds.map(async (nodeId) => {
          const answer = await this.deps.dispatch
            .requestTrafficStats(nodeId, TRAFFIC_TAIL_LINES, { hostId: host.id, windowSeconds: TRAFFIC_WINDOW_SECONDS })
            .catch(() => null);
          if (!answer?.success || !answer.detail) return null;
          try {
            const parsed = JSON.parse(answer.detail) as RouteTrafficSample & { hostId?: string };
            // Older daemons ignore host_id and answer for the whole node: not this route's numbers.
            return parsed.hostId === host.id ? parsed : null;
          } catch {
            return null;
          }
        })
      );
      const samples = reports.filter((report): report is RouteTrafficSample => report !== null);
      if (samples.length > 0) result.set(host.id, samples);
    });
    for (let offset = 0; offset < work.length; offset += TRAFFIC_CONCURRENCY) {
      await Promise.all(work.slice(offset, offset + TRAFFIC_CONCURRENCY).map((run) => run()));
    }
    return result;
  }

  /** Route members of the app environments the scope covers (null: every environment). */
  private async appRouteMembers(scope: Set<string> | null): Promise<AppMemberLike[]> {
    const reader = this.deps.appMembers?.();
    if (!reader) return [];
    const envs = await this.environmentsInScope(scope);
    if (envs.length === 0) return [];
    return (await reader.listMembers(envs.map((env) => env.id))).filter((member) => member.type === 'route');
  }

  private async environmentsInScope(scope: Set<string> | null) {
    const rows = await this.deps.db
      .select({
        id: appEnvironments.id,
        appId: appEnvironments.appId,
        name: appEnvironments.name,
        appName: apps.name,
        maintenanceEnabled: appEnvironments.maintenanceEnabled,
        maintenanceOverride: apps.maintenanceOverride,
      })
      .from(appEnvironments)
      .innerJoin(apps, eq(apps.id, appEnvironments.appId));
    return scope === null ? rows : rows.filter((row) => scope.has(row.id) || scope.has(row.appId));
  }

  private async environmentNames(environmentIds: string[]) {
    if (environmentIds.length === 0) return new Map<string, { appId: string; label: string }>();
    const rows = await this.deps.db
      .select({ id: appEnvironments.id, appId: appEnvironments.appId, name: appEnvironments.name, appName: apps.name })
      .from(appEnvironments)
      .innerJoin(apps, eq(apps.id, appEnvironments.appId))
      .where(inArray(appEnvironments.id, environmentIds));
    return new Map(rows.map((row) => [row.id, { appId: row.appId, label: `${row.appName} · ${row.name}` }]));
  }

  // ── App environment states ──────────────────────────────────────────

  async appStates(): Promise<void> {
    const { evaluator } = this.deps;
    if (!(await evaluator.hasEnabledRules('app', 'event'))) return;
    const envs = await this.environmentsInScope(await evaluator.enabledRuleScopes('app', 'event'));
    if (envs.length === 0) return;
    const health =
      (await this.deps.appHealth?.()?.summarizeEnvironments(
        APP_ALERT_HEALTH_SCOPES,
        envs.map((env) => env.id)
      )) ?? new Map();
    const incidents = await this.deps.db
      .select({ environmentId: appIncidents.environmentId, kind: appIncidents.kind })
      .from(appIncidents)
      .where(
        and(
          inArray(
            appIncidents.environmentId,
            envs.map((env) => env.id)
          ),
          inArray(appIncidents.state, [...OPEN_INCIDENT_STATES])
        )
      );
    const open = new Set(incidents.map((incident) => `${incident.environmentId}:${incident.kind}`));

    for (const env of envs) {
      const resource = { type: 'app', id: `${env.appId}:${env.id}`, name: `${env.appName} · ${env.name}` };
      const summary = health.get(env.id);
      const state = summary?.health ?? 'healthy';
      const details = {
        app: env.appName,
        environment: env.name,
        health: state,
        failing: summary?.failing ?? 0,
        degraded: summary?.degraded ?? 0,
      };
      const observe = (current: string, pattern: string) =>
        evaluator.observeStatefulEvent('app', current, resource, details, [pattern], ALERT_SOURCES_INTERVAL_MS * 2);
      // Health: failing; degraded or worse; healthy (a recovery: it fires once the environment is back).
      // An environment without members (`unknown`) counts as healthy.
      await observe(state === 'failing' ? 'health.failing' : 'health.not_failing', 'health.failing');
      await observe(
        state === 'failing' || state === 'degraded' ? 'health.degraded' : 'health.not_degraded',
        'health.degraded'
      );
      await observe(
        state === 'failing' || state === 'degraded' ? 'health.unhealthy' : 'health.healthy',
        'health.healthy'
      );
      await observe(open.has(`${env.id}:isolation`) ? 'kill_switch.on' : 'kill_switch.off', 'kill_switch.on');
      await observe(open.has(`${env.id}:shutdown`) ? 'shutdown.active' : 'shutdown.inactive', 'shutdown.active');
      await observe(
        env.maintenanceEnabled || env.maintenanceOverride ? 'maintenance.active' : 'maintenance.inactive',
        'maintenance.active'
      );
    }
  }

  // ── Container restarts ──────────────────────────────────────────────

  async containerRestarts(now: number): Promise<void> {
    const { evaluator } = this.deps;
    if (
      !this.deps.containerDetails ||
      !(await evaluator.hasEnabledRules('container', 'threshold', 'restarts_per_hour'))
    ) {
      this.restartReadings.clear();
      return;
    }
    const seen = new Set<string>();
    for (const node of this.deps.registry.getNodesByType('docker')) {
      const details = await this.deps.containerDetails(node.nodeId).catch(() => ({}));
      const values: Array<{ name: string; value: number }> = [];
      for (const [name, envelope] of Object.entries(details)) {
        const reading = restartReading(envelope?.data);
        if (!reading) continue;
        const key = `${node.nodeId}\u0000${name}`;
        seen.add(key);
        const readings = [...(this.restartReadings.get(key) ?? []), { at: now, ...reading }].filter(
          (item) => now - item.at <= HOUR_MS
        );
        this.restartReadings.set(key, readings);
        values.push({ name, value: restartsInLastHour(readings, now) });
      }
      if (values.length > 0) {
        await evaluator.evaluateContainerMetric(
          node.nodeId,
          'restarts_per_hour',
          values,
          ALERT_SOURCES_INTERVAL_MS * SLOW_SOURCES_EVERY
        );
      }
    }
    for (const key of this.restartReadings.keys()) if (!seen.has(key)) this.restartReadings.delete(key);
  }

  // ── Scheduled backups ───────────────────────────────────────────────

  async backups(now: number): Promise<void> {
    const { evaluator } = this.deps;
    const wantsMetric = await evaluator.hasEnabledRules('backup', 'threshold');
    const wantsEvent = await evaluator.hasEnabledRules('backup', 'event');
    if (!wantsMetric && !wantsEvent) return;
    const policies = await this.deps.db
      .select({
        id: backupPolicies.id,
        databaseConnectionId: backupPolicies.databaseConnectionId,
        bucket: backupPolicies.bucket,
        createdAt: backupPolicies.createdAt,
        databaseName: databaseConnections.name,
      })
      .from(backupPolicies)
      .innerJoin(databaseConnections, eq(databaseConnections.id, backupPolicies.databaseConnectionId))
      // Only scheduled, enabled policies are expected to back up; a manual-only policy has no "missed" backup.
      .where(and(eq(backupPolicies.enabled, true), isNotNull(backupPolicies.schedule)));
    if (policies.length === 0) return;
    const ids = policies.map((policy) => policy.id);
    const finished = await this.deps.db
      .selectDistinctOn([backupRuns.policyId], {
        policyId: backupRuns.policyId,
        status: backupRuns.status,
        completedAt: backupRuns.completedAt,
        error: backupRuns.sanitizedError,
      })
      .from(backupRuns)
      .where(
        and(
          inArray(backupRuns.policyId, ids),
          eq(backupRuns.direction, 'backup'),
          inArray(backupRuns.status, ['completed', 'failed'])
        )
      )
      .orderBy(backupRuns.policyId, desc(backupRuns.completedAt));
    const succeeded = await this.deps.db
      .selectDistinctOn([backupRuns.policyId], { policyId: backupRuns.policyId, completedAt: backupRuns.completedAt })
      .from(backupRuns)
      .where(
        and(inArray(backupRuns.policyId, ids), eq(backupRuns.direction, 'backup'), eq(backupRuns.status, 'completed'))
      )
      .orderBy(backupRuns.policyId, desc(backupRuns.completedAt));
    const lastFinished = new Map(finished.map((run) => [run.policyId, run]));
    const lastSuccess = new Map(succeeded.map((run) => [run.policyId, run.completedAt]));

    const snapshots: MetricSnapshot[] = [];
    for (const policy of policies) {
      const key = `${policy.databaseConnectionId}:${policy.id}`;
      const name = `${policy.databaseName} → ${policy.bucket}`;
      const success = lastSuccess.get(policy.id) ?? null;
      const last = lastFinished.get(policy.id);
      const details = {
        policy_id: policy.id,
        last_success_at: success?.toISOString() ?? null,
        last_error: last?.status === 'failed' ? (last.error ?? null) : null,
      };
      // Never backed up: counted from when the policy was created.
      const since = (success ?? policy.createdAt).getTime();
      snapshots.push({
        key,
        id: policy.databaseConnectionId,
        name,
        metrics: { hours_since_last_backup: Math.max(0, (now - since) / HOUR_MS) },
        details,
      });
      if (wantsEvent) {
        await evaluator.observeStatefulEvent(
          'backup',
          last?.status === 'failed' ? 'backup.failed' : 'backup.ok',
          { type: 'backup', id: key, name },
          details,
          ['backup.failed'],
          ALERT_SOURCES_INTERVAL_MS * SLOW_SOURCES_EVERY
        );
      }
    }
    if (wantsMetric) {
      await evaluator.evaluateMetricSnapshots('backup', snapshots, ALERT_SOURCES_INTERVAL_MS * SLOW_SOURCES_EVERY);
    }
  }

  // ── Domain DNS ──────────────────────────────────────────────────────

  async domainDns(): Promise<void> {
    const { evaluator } = this.deps;
    if (!(await evaluator.hasEnabledRules('domain', 'event'))) return;
    const scope = await evaluator.enabledRuleScopes('domain', 'event');
    const ids = scope === null ? null : uuids(scope);
    if (ids?.length === 0) return;
    const rows = await this.deps.db
      .select({ id: domains.id, domain: domains.domain, dnsStatus: domains.dnsStatus })
      .from(domains)
      .where(ids === null ? undefined : inArray(domains.id, ids));
    for (const row of rows) {
      await this.deps.evaluator.observeStatefulEvent(
        'domain',
        row.dnsStatus === 'invalid' ? 'dns.not_pointing' : 'dns.ok',
        { type: 'domain', id: row.id, name: row.domain },
        { dns_status: row.dnsStatus },
        ['dns.not_pointing'],
        ALERT_SOURCES_INTERVAL_MS * SLOW_SOURCES_EVERY
      );
    }
  }
}

function trafficSnapshot(
  key: string,
  id: string,
  name: string,
  samples: readonly RouteTrafficSample[]
): MetricSnapshot {
  const metrics = routeTrafficMetrics(samples);
  return {
    key,
    id,
    name,
    metrics,
    details: {
      requests: metrics.requests ?? 0,
      errors_5xx: metrics.errors_5xx ?? 0,
      errors_4xx: metrics.errors_4xx ?? 0,
    },
  };
}
