import { and, desc, eq, gt, gte, inArray, lt, or, type SQL, sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleTransaction } from '@/db/client.js';
import {
  appEnvironments,
  backupPolicies,
  certificateAuthorities,
  certificates,
  databaseConnections,
  dockerAccessResources,
  dockerAvailabilityPolicies,
  domains,
  loggingEnvironments,
  nodes,
  notificationAlertRules,
  notificationAlertStates,
  notificationDeliveryLog,
  proxyHosts,
  relayInstances,
  sslCertificates,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { HostingAccountObservation } from '@/modules/hosting/hosting-observations.service.js';
import { resolveIngressNodesForMany } from '@/modules/ingress-groups/ingress-nodes.js';
import { recordNodeCapacitySample } from '@/modules/monitoring/dashboard-attention.js';
import { effectiveMaintenance } from '@/modules/proxy/effective-maintenance.js';
import type { CacheService, RedisClient } from '@/services/cache.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import {
  EVENT_BUS_MAPPINGS,
  evaluateThreshold,
  evaluateWindowRatio,
  eventSupportsThreshold,
  extractMetricFromDatabaseSnapshot,
  extractMetricFromHealthReport,
  extractMetricFromStorageSnapshot,
  isPerDeviceNodeMetric,
  type Severity,
  type WindowProbeSample,
} from './notification.constants.js';
import type { NotificationAlertRuleService } from './notification-alert-rule.service.js';
import { DOCKER_ENGINE_UNAVAILABLE_METRIC, isRecoveryEvent } from './notification-catalog.js';
import {
  type DispatchResult,
  type DispatchWebhook,
  type NotificationDispatcherService,
  OPEN_DELIVERY_STATUSES,
} from './notification-dispatcher.service.js';
import { type FoldedUnder, foldedUnder } from './notification-folding.js';
import { defaultResolveMessage, resolveTemplateOf } from './notification-resolve-messages.js';
import {
  buildNotificationTemplateContext,
  type NotificationEvent,
  type NotificationTemplateContextInput,
  type NotificationTemplateResource,
  renderTemplate,
} from './notification-templates.js';
import type { NotificationWebhookService } from './notification-webhook.service.js';
import { OPFIELD_OUTBOUND_RESOURCE_ID } from './opfield-outbound-monitor.js';

/** Consecutive reports a default node CPU, memory or disk rule must breach before it fires. */
export const NODE_METRIC_SUSTAINED_REPORTS = 3;
const SUSTAINED_NODE_METRICS = new Set(['cpu', 'memory', 'disk']);

const logger = createChildLogger('NotificationEvaluator');

const METRIC_BUFFER_TTL = 1800;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOGGING_RATIO_SAMPLING_MS = 5 * 60 * 1000;
const STATE_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;
const STATE_MAINTENANCE_DEBOUNCE_MS = 2_000;
const RESOLVED_STATE_RETENTION_MS = 30 * DAY_MS;
const RESOLVED_STATE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const HOSTING_CATEGORIES = new Set(['hosting_account', 'hosting_vm']);
/** Rule fields that decide which resources/metric a firing state belongs to. */
const RULE_SOURCE_KEYS = ['type', 'category', 'metric', 'metricTarget', 'eventPattern'] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** After a Redis error, alert windows stay in memory this long before Redis is tried again. */
const MEMORY_PROBE_RETRY_MS = 60_000;
const MEMORY_PROBE_SAMPLE_LIMIT = 1_000;
const OPFIELD_SAMPLING_MS = 60_000;
/** A held state is observed again this long after a rule's window can be covered by it. */
const HELD_STATE_SLACK_MS = 1_000;
/** Route alerts explained by a parent that resolved this recently are held, see foldingParent. */
const FOLD_GRACE_MS = 2 * 60_000;
/**
 * A parent that fires folds the alerts already firing that its outage explains: those that fired at most this long
 * before the parent's own window began (a route's probe or a container's check can notice a node's outage before the
 * node alert's window is covered). An alert that fired earlier has another cause and stays on its own (stand rc.9,
 * F-2: a container alert that fired 47 min before its node dropped was folded and resolved as "back online").
 */
const FOLD_LEAD_MS = 2 * 60_000;
/** Route health events that fold under a parent alert. */
const FOLDABLE_ROUTE_EVENTS = ['health.offline', 'health.degraded'] as const;

function isFoldableRouteRule(rule: { category?: string; eventPattern?: string | null }): boolean {
  return rule.category === 'proxy' && FOLDABLE_ROUTE_EVENTS.includes(rule.eventPattern as never);
}

/** Container and deployment health events that fold under their node's down alert, as route alerts do. */
const FOLDABLE_CONTAINER_EVENTS = ['health.offline', 'health.degraded'] as const;
const CONTAINER_ALERT_RESOURCE_TYPES = ['docker_container', 'docker_deployment'];

function isFoldableContainerAlert(rule: { category?: string; eventPattern?: string | null }, resourceType: string) {
  return (
    rule.category === 'container' &&
    FOLDABLE_CONTAINER_EVENTS.includes(rule.eventPattern as never) &&
    CONTAINER_ALERT_RESOURCE_TYPES.includes(resourceType)
  );
}

/** The kind of parent a rule's alerts are, if route alerts fold under them. */
function foldingParentKind(rule: { category?: string; eventPattern?: string | null }): FoldedUnder['kind'] | null {
  if (rule.category === 'node' && rule.eventPattern === 'offline') return 'node';
  if (rule.category === 'opfield' && rule.eventPattern === 'outbound.unavailable') return 'opfield_outbound';
  return null;
}

/** Resource keys of Opfield's own alerts (category opfield). */
export const OPFIELD_RESOURCE_ID = 'opfield';
export const OPFIELD_POSTGRES_RESOURCE_ID = 'opfield-postgres';

/** Outage starts further back than this before the firing are not the same outage. */
const MAX_OUTAGE_LEAD_MS = 15 * 60_000;

/**
 * When the outage an alert reports began: the source's own start (`details.outage_since`, the relay's first failed
 * probe) when it came with the firing, else the firing. A relay alert fires 5–10 s into the outage (stand rc.8, O-1).
 */
export function outageStart(context: unknown, firedAt: Date): Date {
  const since = (context as { details?: { outage_since?: unknown } } | null)?.details?.outage_since;
  const start = typeof since === 'string' ? Date.parse(since) : Number.NaN;
  const fired = firedAt.getTime();
  return Number.isFinite(start) && start <= fired && fired - start <= MAX_OUTAGE_LEAD_MS ? new Date(start) : firedAt;
}

/** Seconds from firing until the resource got back (backSince), or until now when that is not known. */
export function alertDurationSeconds(firedAt: Date, backSince?: number | null, now = Date.now()): number {
  const end = backSince != null && backSince >= firedAt.getTime() && backSince <= now ? backSince : now;
  return Math.max(0, Math.round((end - firedAt.getTime()) / 1000));
}

/** Samples (oldest first) from windowStart on, plus the newest one before it: the state the window starts in. */
function withWindowAnchor(samples: WindowProbeSample[], windowStart: number): WindowProbeSample[] {
  let anchor = 0;
  samples.forEach((sample, index) => {
    if (sample.timestamp < windowStart) anchor = index;
  });
  return samples.slice(anchor);
}

interface PostgresOutageAlert {
  rule: any;
  firedAt: number;
  event: NotificationEvent;
  details: TemplateDetails;
  sends: Array<{ webhook: DispatchWebhook; result: DispatchResult; sentAt: Date }>;
}

/** A Postgres outage seen by Opfield diagnostics, with the alerts sent for it outside the database. */
interface PostgresOutage {
  startedAt: number;
  /** When Postgres answered again; null while it is still down. */
  backSince: number | null;
  error: string | null;
  fired: Map<string, PostgresOutageAlert>;
}

type AlertStateRow = typeof notificationAlertStates.$inferSelect;

/** What list_alerts shows of a fired alert: the resource's name and the message notified, cut to their columns. */
function alertStateLabels(
  resourceName: string | null | undefined,
  message: string | null | undefined
): { resourceName: string | null; message: string | null } {
  return {
    resourceName: resourceName ? String(resourceName).slice(0, 255) : null,
    message: message ? String(message).slice(0, 4000) : null,
  };
}
/**
 * The message of a rule without its own template. A threshold rule says what crossed the limit
 * ("cpu 41.5 >= 0 for 60 s"), not only the rule and resource names.
 */
export function defaultFiredMessage(
  rule: { name: string; type?: string },
  resourceName: string,
  details: { metric?: { name?: string; value?: number; threshold?: number; operator?: string; duration?: number } }
): string {
  const metric = details.metric;
  if (rule.type !== 'threshold' || !metric?.name || typeof metric.value !== 'number') {
    return `${rule.name}: ${resourceName}`;
  }
  const value = Number.isInteger(metric.value) ? String(metric.value) : metric.value.toFixed(1);
  const limit = metric.operator && metric.threshold !== undefined ? ` ${metric.operator} ${metric.threshold}` : '';
  const sustained = metric.duration ? ` for ${metric.duration} s` : '';
  return `${rule.name}: ${resourceName}: ${metric.name} is ${value} (rule${limit}${sustained})`;
}

type ResourceKind =
  | 'node'
  | 'proxy'
  | 'certificate'
  | 'database'
  | 'logging'
  | 'app_environment'
  | 'backup_policy'
  | 'domain'
  | 'pki_ca'
  | 'pki_certificate'
  | 'relay_instance'
  | 'availability_policy';

/** One reading of a resource's metrics for a category's threshold rules (see evaluateMetricSnapshot). */
export interface MetricSnapshot {
  /** The alert key: the resource id, or `<parent id>:<id>` where rules may be scoped to either. */
  key: string;
  /** The resource's own id ({{resource.id}}). */
  id: string;
  name: string;
  metrics: Record<string, number | null>;
  /** Scalar values for {{details.*}}. */
  details?: Record<string, string | number | boolean | null>;
}

/** A disk several enrolled nodes report: the key of its one alert and the names of the nodes. */
type SharedDisk = { key: string; names: string };
/** A node that has not reported a disk for this long no longer shares it (deleted, moved, or offline). */
const DISK_SHARER_FRESH_MS = 5 * 60_000;

type TemplateDetails = Partial<
  Pick<
    NotificationTemplateContextInput,
    | 'metric'
    | 'node'
    | 'health'
    | 'certificate'
    | 'state'
    | 'event'
    | 'operation'
    | 'failure'
    | 'details'
    | 'fired'
    | 'resolution'
  >
> & { resourceId?: string | null };

/** Certificate statuses whose expiry is still monitored (same set as ExpiryAlertJob). */
export const CERTIFICATE_EXPIRY_MONITORED_STATUSES = ['active', 'error', 'expired'] as const;

export class NotificationEvaluatorService {
  private eventBus?: EventBusService;
  private redis: RedisClient | null = null;
  private loggingEnvironmentService?: {
    list(): Promise<Array<{ id: string; name: string; enabled: boolean }>>;
  };
  private loggingClickHouseService?: {
    getFacets(
      environmentId: string,
      range?: { from?: string; to?: string }
    ): Promise<{ severities: Array<{ severity: string; count: number }> }>;
  };
  private unsubscribers: Array<() => void> = [];
  private readonly activeHandlers = new Set<Promise<void>>();
  /** States of sources that publish only on change, observed again when rule windows can be covered. */
  private readonly heldStates = new Map<string, { timers: Array<ReturnType<typeof setTimeout>> }>();
  private stopped = false;
  private readonly activeDeliveries = new Set<Promise<void>>();
  private maintenanceInterval: ReturnType<typeof setInterval> | null = null;
  private maintenanceDebounce: ReturnType<typeof setTimeout> | null = null;
  private maintenanceRun: Promise<void> | null = null;
  private lastResolvedStatePrune = 0;
  private readonly hostingEventChains = new Map<string, Promise<void>>();
  private hostingRuleBarrier: Promise<void> = Promise.resolve();

  /** Probe windows kept in memory while Redis cannot take them; a Redis outage is itself an alert. */
  private readonly memoryProbeOutcomes = new Map<string, WindowProbeSample[]>();
  /** Recovery alerts (see isRecoveryEvent) whose resource left the recovery state, when Redis cannot keep them. */
  private readonly memoryRecoveryArmed = new Set<string>();
  private memoryProbesUntil = 0;
  /** Rules and webhooks for postgres.unavailable, copied while Postgres answers, used while it does not. */
  private postgresOutageTargets: Array<{ rule: any; webhooks: DispatchWebhook[] }> = [];
  private postgresOutage: PostgresOutage | null = null;

  private thresholdRulesCache: any[] = [];
  private eventRulesCache: any[] = [];
  private lastRuleCacheRefresh = 0;
  private readonly RULE_CACHE_TTL = 30_000;

  /** Consecutive breaching reports per node metric rule and resource; see sustainedNodeMetricBreach. */
  private readonly nodeMetricBreachStreaks = new Map<string, number>();

  constructor(
    private db: DrizzleClient,
    private ruleService: NotificationAlertRuleService,
    private webhookService: NotificationWebhookService,
    private dispatcherService: NotificationDispatcherService,
    cacheService: CacheService | null,
    private nodeRegistry: NodeRegistryService
  ) {
    this.redis = cacheService?.getClient() ?? null;
  }

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  setLoggingServices(
    environmentService: { list(): Promise<Array<{ id: string; name: string; enabled: boolean }>> },
    clickHouseService: {
      getFacets(
        environmentId: string,
        range?: { from?: string; to?: string }
      ): Promise<{ severities: Array<{ severity: string; count: number }> }>;
    }
  ): void {
    this.loggingEnvironmentService = environmentService;
    this.loggingClickHouseService = clickHouseService;
  }

  start(): void {
    this.stopped = false;
    if (!this.eventBus) {
      logger.warn('EventBus not set, evaluator will not process events');
      return;
    }

    for (const channel of Object.keys(EVENT_BUS_MAPPINGS)) {
      const unsub = this.eventBus.subscribe(channel, (payload: unknown) => {
        const hosting = channel.startsWith('hosting.')
          ? (payload as { resourceId?: string; connectorId?: string; nodeId?: string; id?: string })
          : null;
        const key = hosting ? (hosting.resourceId ?? hosting.nodeId ?? hosting.connectorId ?? hosting.id) : undefined;
        const ruleBarrier = this.hostingRuleBarrier;
        // One resource's observations must retain order while asynchronous delivery is in flight.
        const work = key
          ? (this.hostingEventChains.get(key) ?? Promise.resolve()).then(async () => {
              await ruleBarrier;
              await this.handleBusEvent(channel, payload);
            })
          : this.handleBusEvent(channel, payload);
        const active = work
          .catch((err) => {
            logger.error('Error handling event', { channel, error: err instanceof Error ? err.message : String(err) });
          })
          .finally(() => {
            this.activeHandlers.delete(active);
            if (key && this.hostingEventChains.get(key) === active) this.hostingEventChains.delete(key);
          });
        if (key) this.hostingEventChains.set(key, active);
        this.activeHandlers.add(active);
      });
      this.unsubscribers.push(unsub);
    }

    // Rule edits from any surface (UI, API, AI, MCP) publish this; clean up states they orphaned.
    this.unsubscribers.push(
      this.eventBus.subscribe('notification.alert-rule.changed', () => this.scheduleStateMaintenance())
    );
    this.maintenanceInterval = setInterval(() => void this.runStateMaintenance(), STATE_MAINTENANCE_INTERVAL_MS);
    this.maintenanceInterval.unref?.();

    logger.info('Notification evaluator started', { channels: Object.keys(EVENT_BUS_MAPPINGS).length });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    for (const { timers } of this.heldStates.values()) for (const timer of timers) clearTimeout(timer);
    this.heldStates.clear();
    if (this.maintenanceInterval) clearInterval(this.maintenanceInterval);
    if (this.maintenanceDebounce) clearTimeout(this.maintenanceDebounce);
    this.maintenanceInterval = null;
    this.maintenanceDebounce = null;
    await Promise.allSettled([...this.activeHandlers, ...(this.maintenanceRun ? [this.maintenanceRun] : [])]);
    // Queued deliveries are durable; waiting only lets in-flight sends record their outcome.
    await Promise.allSettled([...this.activeDeliveries]);
  }

  // ── Health Report Evaluation ────────────────────────────────────────

  async evaluateHealthReport(nodeId: string, healthData: any): Promise<void> {
    recordNodeCapacitySample(nodeId, healthData);
    this.recordDiskSharers(nodeId, healthData);
    const rules = await this.getThresholdRules();
    if (rules.length === 0) return;

    for (const rule of rules) {
      // Only evaluate rules matching the node category or container category
      if (rule.category !== 'node' && rule.category !== 'container') continue;

      // Check resource scope for node rules
      if (rule.category === 'node' && rule.resourceIds?.length > 0) {
        if (!rule.resourceIds.includes(nodeId)) {
          logger.debug('Skipping rule: node not in scope', { ruleId: rule.id, nodeId, scopedIds: rule.resourceIds });
          continue;
        }
      }

      const extraction = extractMetricFromHealthReport(rule.category, rule.metric, healthData, rule.metricTarget);
      if (!extraction) {
        logger.debug('No metric extraction', { ruleId: rule.id, category: rule.category, metric: rule.metric });
        continue;
      }

      for (const { resourceId, value } of extraction.values) {
        // Check resource scope for container rules
        if (rule.category === 'container' && rule.resourceIds?.length > 0) {
          if (!rule.resourceIds.includes(resourceId)) continue;
        }

        let compositeResourceId =
          rule.category === 'container' || rule.metric === 'disk' || isPerDeviceNodeMetric(rule.metric)
            ? `${nodeId}:${resourceId}`
            : nodeId;
        // A disk several enrolled nodes share (one host) alerts once, naming them all (rc.2 O-1).
        let shared: SharedDisk | null = null;
        if (rule.category === 'node' && rule.metric === 'disk') {
          const disk = await this.sharedDiskFor(rule, nodeId, healthData, resourceId);
          if (disk === 'skip') continue;
          shared = disk;
          if (shared) compositeResourceId = shared.key;
        }

        if (Number.isNaN(value)) {
          logger.warn('Skipping NaN metric value', { ruleId: rule.id, metric: rule.metric, resourceId });
          continue;
        }

        const breached = evaluateThreshold(value, rule.operator, rule.thresholdValue);
        logger.debug('Threshold check', {
          ruleId: rule.id,
          ruleName: rule.name,
          metric: rule.metric,
          value: Math.round(value * 100) / 100,
          threshold: rule.thresholdValue,
          operator: rule.operator,
          breached,
          resourceId: compositeResourceId,
        });

        await this.recordProbeOutcome(
          rule.id,
          compositeResourceId,
          breached,
          Math.max(rule.durationSeconds ?? 0, rule.resolveAfterSeconds ?? 0) * 1000
        );

        // A disk rule watches several disks of a node: {{details.mount}} names the one; a shared disk names its nodes.
        const details: TemplateDetails =
          rule.category === 'node' && rule.metric === 'disk'
            ? shared
              ? { details: { mount: resourceId, nodes: shared.names }, node: { id: nodeId, name: shared.names } }
              : { details: { mount: resourceId } }
            : rule.category === 'node' && rule.metric === DOCKER_ENGINE_UNAVAILABLE_METRIC
              ? { details: { problem: healthData.dockerEngine?.problem ?? 'the Docker Engine does not answer' } }
              : {};
        if (breached) {
          if (!this.sustainedNodeMetricBreach(rule, compositeResourceId)) continue;
          await this.handleThresholdBreach(rule, compositeResourceId, value, nodeId, resourceId, details);
        } else {
          this.nodeMetricBreachStreaks.delete(`${rule.id}:${compositeResourceId}`);
          await this.handleThresholdClear(rule, compositeResourceId, value, nodeId, resourceId, details);
        }
      }
    }
  }

  /** Nodes that recently reported each disk (by DiskMount.disk_id): nodes enrolled on one host share their disks. */
  private readonly diskSharers = new Map<string, Map<string, { mount: string; seenAt: number }>>();

  private recordDiskSharers(nodeId: string, healthData: any, now = Date.now()): void {
    const mounts: any[] = Array.isArray(healthData?.diskMounts) ? healthData.diskMounts : [];
    for (const mount of mounts) {
      const diskId = typeof mount?.diskId === 'string' ? mount.diskId : '';
      if (!diskId) continue;
      let sharers = this.diskSharers.get(diskId);
      if (!sharers) {
        sharers = new Map();
        this.diskSharers.set(diskId, sharers);
      }
      sharers.set(nodeId, { mount: String(mount.mountPoint ?? '/'), seenAt: now });
    }
    // Disks no node reported for a while (nodes deleted or moved) are forgotten.
    for (const [diskId, sharers] of this.diskSharers) {
      for (const [sharer, entry] of sharers) if (now - entry.seenAt > DISK_SHARER_FRESH_MS) sharers.delete(sharer);
      if (sharers.size === 0) this.diskSharers.delete(diskId);
    }
  }

  /**
   * The shared alert of a disk several nodes of the rule's scope report (its key and their names), 'skip' when another
   * of them evaluates it (the one with the lowest id, so two reports never race to fire it), null for a disk only this
   * node reports. A disk whose shared alert still fires stays shared until it resolves. Alerts each node raised for it
   * before it was known to be shared fold into the shared one.
   */
  private async sharedDiskFor(
    rule: any,
    nodeId: string,
    healthData: any,
    mountPoint: string
  ): Promise<SharedDisk | 'skip' | null> {
    const mounts: any[] = Array.isArray(healthData?.diskMounts) ? healthData.diskMounts : [];
    const diskId = mounts.find((mount) => (mount?.mountPoint ?? '/') === mountPoint)?.diskId;
    if (typeof diskId !== 'string' || !diskId) return null;
    const key = `disk:${diskId}`;
    const now = Date.now();
    const inScope = (id: string) => !(rule.resourceIds?.length > 0) || rule.resourceIds.includes(id);
    const sharers = [...(this.diskSharers.get(diskId) ?? new Map()).entries()]
      .filter(([id, entry]) => now - entry.seenAt <= DISK_SHARER_FRESH_MS && inScope(id))
      .sort(([left], [right]) => left.localeCompare(right));
    if (sharers.length <= 1 && !(await this.getActiveAlertState(rule.id, rule.category, key))) return null;
    if (sharers.length > 0 && sharers[0]![0] !== nodeId) return 'skip';
    const names = (sharers.length > 0 ? sharers : [[nodeId, { mount: mountPoint, seenAt: now }] as const])
      .map(([id]) => this.getNodeName(id))
      .sort((left, right) => left.localeCompare(right))
      .join(', ');
    for (const [id, entry] of sharers) {
      const own = `${id}:${entry.mount}`;
      const state = await this.getActiveAlertState(rule.id, rule.category, own);
      if (!state) continue;
      await this.resolveAlert(
        state.id,
        rule,
        rule.category,
        own,
        this.getNodeName(id),
        { details: { mount: entry.mount, nodes: names }, node: { id, name: this.getNodeName(id) } },
        { notify: false }
      );
    }
    return { key, names };
  }

  /**
   * Node CPU, memory and disk rules without a duration of their own fire only after the value held for
   * NODE_METRIC_SUSTAINED_REPORTS consecutive reports, not on one busy sample. A rule with an explicit duration keeps it.
   */
  private sustainedNodeMetricBreach(rule: any, compositeResourceId: string): boolean {
    if (rule.category !== 'node' || !SUSTAINED_NODE_METRICS.has(rule.metric) || (rule.durationSeconds ?? 0) > 0) {
      return true;
    }
    const key = `${rule.id}:${compositeResourceId}`;
    const breaches = Math.min((this.nodeMetricBreachStreaks.get(key) ?? 0) + 1, NODE_METRIC_SUSTAINED_REPORTS);
    this.nodeMetricBreachStreaks.set(key, breaches);
    return breaches >= NODE_METRIC_SUSTAINED_REPORTS;
  }

  async evaluateDatabaseSnapshot(snapshot: {
    databaseId: string;
    type: 'postgres' | 'redis' | 'clickhouse';
    name: string;
    metrics: Record<string, number | null>;
  }): Promise<void> {
    const rules = await this.getThresholdRules();
    if (rules.length === 0) return;

    const category =
      snapshot.type === 'postgres'
        ? 'database_postgres'
        : snapshot.type === 'clickhouse'
          ? 'database_clickhouse'
          : 'database_redis';

    for (const rule of rules) {
      if (rule.category !== category) continue;
      if (rule.resourceIds?.length > 0 && !rule.resourceIds.includes(snapshot.databaseId)) continue;

      const extraction = extractMetricFromDatabaseSnapshot(rule.category, rule.metric, snapshot);
      if (!extraction) continue;

      for (const { resourceId, value } of extraction.values) {
        if (Number.isNaN(value)) continue;

        const breached = evaluateThreshold(value, rule.operator, rule.thresholdValue);
        await this.recordProbeOutcome(
          rule.id,
          resourceId,
          breached,
          Math.max(rule.durationSeconds ?? 0, rule.resolveAfterSeconds ?? 0) * 1000
        );
        if (breached) {
          await this.handleThresholdBreach(rule, resourceId, value, snapshot.databaseId, snapshot.name);
        } else {
          await this.handleThresholdClear(rule, resourceId, value, snapshot.databaseId, snapshot.name);
        }
      }
    }
  }

  /** Managed storage metrics from each monitoring sample of its storage connection; the resource is the connection. */
  async evaluateStorageSnapshot(snapshot: {
    storageId: string;
    name: string;
    metrics: Record<string, number | null>;
  }): Promise<void> {
    const rules = await this.getThresholdRules();
    for (const rule of rules) {
      if (rule.category !== 'managed_storage') continue;
      if (rule.resourceIds?.length > 0 && !rule.resourceIds.includes(snapshot.storageId)) continue;
      const extraction = extractMetricFromStorageSnapshot(rule.category, rule.metric, snapshot);
      if (!extraction) continue;
      for (const { resourceId, value } of extraction.values) {
        if (Number.isNaN(value)) continue;
        const breached = evaluateThreshold(value, rule.operator, rule.thresholdValue);
        await this.recordProbeOutcome(
          rule.id,
          resourceId,
          breached,
          Math.max(rule.durationSeconds ?? 0, rule.resolveAfterSeconds ?? 0) * 1000
        );
        if (breached) {
          await this.handleThresholdBreach(rule, resourceId, value, snapshot.storageId, snapshot.name);
        } else {
          await this.handleThresholdClear(rule, resourceId, value, snapshot.storageId, snapshot.name);
        }
      }
    }
  }

  /** Opfield's own metrics from the diagnostics sampler, once a minute; the resource is Opfield itself. */
  async evaluateOpfieldSnapshot(
    metrics: Record<string, number | null>,
    /** Per metric: what the reading was taken from ({{details.*}}), e.g. host_disk: { disk }. */
    metricDetails?: Record<string, Record<string, unknown>>
  ): Promise<void> {
    const rules = await this.getThresholdRules();
    for (const rule of rules) {
      if (rule.category !== 'opfield') continue;
      if (rule.resourceIds?.length > 0 && !rule.resourceIds.includes(OPFIELD_RESOURCE_ID)) continue;
      const value = metrics[rule.metric];
      if (typeof value !== 'number' || Number.isNaN(value)) continue;

      const breached = evaluateThreshold(value, rule.operator, rule.thresholdValue);
      await this.recordProbeOutcome(
        rule.id,
        OPFIELD_RESOURCE_ID,
        breached,
        Math.max(rule.durationSeconds ?? 0, rule.resolveAfterSeconds ?? 0) * 1000,
        OPFIELD_SAMPLING_MS
      );
      const extra: TemplateDetails = metricDetails?.[rule.metric] ? { details: metricDetails[rule.metric] } : {};
      if (breached) {
        await this.handleThresholdBreach(rule, OPFIELD_RESOURCE_ID, value, OPFIELD_RESOURCE_ID, 'Opfield', extra);
      } else {
        await this.handleThresholdClear(rule, OPFIELD_RESOURCE_ID, value, OPFIELD_RESOURCE_ID, 'Opfield', extra);
      }
    }
  }

  /**
   * Threshold rules of one category over metric snapshots a periodic source took (route and app request metrics,
   * backups): one sample per rule and resource each time, `samplingPeriodMs` apart.
   */
  async evaluateMetricSnapshots(
    category: string,
    snapshots: readonly MetricSnapshot[],
    samplingPeriodMs: number
  ): Promise<void> {
    const rules = (await this.getThresholdRules()).filter((rule) => rule.category === category);
    for (const rule of rules) {
      for (const snapshot of snapshots) {
        if (!this.stateInRuleScope(rule, { resourceId: snapshot.key })) continue;
        const value = snapshot.metrics[rule.metric];
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        const breached = evaluateThreshold(value, rule.operator, rule.thresholdValue);
        await this.recordProbeOutcome(
          rule.id,
          snapshot.key,
          breached,
          Math.max(rule.durationSeconds ?? 0, rule.resolveAfterSeconds ?? 0) * 1000,
          samplingPeriodMs
        );
        const details: TemplateDetails = snapshot.details ? { details: snapshot.details } : {};
        if (breached) await this.handleThresholdBreach(rule, snapshot.key, value, snapshot.id, snapshot.name, details);
        else await this.handleThresholdClear(rule, snapshot.key, value, snapshot.id, snapshot.name, details);
      }
    }
  }

  /** Whether any enabled rule of the category exists (periodic sources skip their work otherwise). */
  async hasEnabledRules(category: string, type?: 'threshold' | 'event', metric?: string): Promise<boolean> {
    const rules = [
      ...(type === 'event' ? [] : await this.getThresholdRules()),
      ...(type === 'threshold' ? [] : await this.getEventRules()),
    ];
    return rules.some((rule) => rule.category === category && (!metric || rule.metric === metric));
  }

  /** Scopes of the enabled rules of a category: null when one covers every resource. */
  async enabledRuleScopes(category: string, type?: 'threshold' | 'event'): Promise<Set<string> | null> {
    const rules = [
      ...(type === 'event' ? [] : await this.getThresholdRules()),
      ...(type === 'threshold' ? [] : await this.getEventRules()),
    ].filter((rule) => rule.category === category);
    const ids = new Set<string>();
    for (const rule of rules) {
      const scope = (rule.resourceIds ?? []) as string[];
      if (scope.length === 0) return null;
      for (const id of scope) ids.add(id);
    }
    return ids;
  }

  /**
   * Container metrics read outside the health report (restarts_per_hour from the containers' inspect), keyed like the
   * health report's container metrics: `<node id>:<container name>`, scoped by container name.
   */
  async evaluateContainerMetric(
    nodeId: string,
    metric: string,
    values: ReadonlyArray<{ name: string; value: number }>,
    samplingPeriodMs: number
  ): Promise<void> {
    const rules = (await this.getThresholdRules()).filter(
      (rule) => rule.category === 'container' && rule.metric === metric
    );
    for (const rule of rules) {
      for (const { name, value } of values) {
        if (rule.resourceIds?.length > 0 && !rule.resourceIds.includes(name)) continue;
        if (!Number.isFinite(value)) continue;
        const key = `${nodeId}:${name}`;
        const breached = evaluateThreshold(value, rule.operator, rule.thresholdValue);
        await this.recordProbeOutcome(
          rule.id,
          key,
          breached,
          Math.max(rule.durationSeconds ?? 0, rule.resolveAfterSeconds ?? 0) * 1000,
          samplingPeriodMs
        );
        if (breached) await this.handleThresholdBreach(rule, key, value, nodeId, name);
        else await this.handleThresholdClear(rule, key, value, nodeId, name);
      }
    }
  }

  /**
   * Postgres reachability from Opfield diagnostics, once a minute. Rules, alert states and the delivery
   * outbox all live in Postgres, so an outage is alerted outside the database: the rules and webhooks
   * copied while it answered are used to send directly, and the alert state and delivery rows are
   * written once it answers again, together with the resolved notification.
   */
  async observeOpfieldPostgres(available: boolean, error?: string): Promise<void> {
    const now = Date.now();
    if (available) {
      await this.refreshPostgresOutageTargets().catch((refreshError: unknown) => {
        logger.debug('Could not refresh Postgres outage alert targets', {
          error: refreshError instanceof Error ? refreshError.message : String(refreshError),
        });
      });
      const outage = this.postgresOutage;
      if (!outage) return;
      outage.backSince ??= now;
      for (const [ruleId, alert] of outage.fired) {
        const resolveMs = (alert.rule.resolveAfterSeconds ?? 60) * 1000;
        if (now - outage.backSince < resolveMs) continue;
        await this.settlePostgresOutageAlert(alert, outage);
        outage.fired.delete(ruleId);
      }
      if (outage.fired.size === 0) this.postgresOutage = null;
      return;
    }

    const outage = (this.postgresOutage ??= { startedAt: now, backSince: null, error: null, fired: new Map() });
    outage.backSince = null;
    outage.error = error ?? outage.error;
    for (const { rule, webhooks } of this.postgresOutageTargets) {
      if (outage.fired.has(rule.id)) continue;
      if (now - outage.startedAt < (rule.durationSeconds ?? 0) * 1000) continue;
      const details = this.getEventTemplateDetails(
        { error: outage.error, down_since: new Date(outage.startedAt).toISOString() },
        'postgres.unavailable',
        'postgres.unavailable',
        OPFIELD_POSTGRES_RESOURCE_ID
      );
      const event = this.buildFiredEvent(rule, 'opfield', OPFIELD_POSTGRES_RESOURCE_ID, 'Postgres', details);
      const sends: PostgresOutageAlert['sends'] = [];
      for (const webhook of webhooks) {
        const sentAt = new Date();
        const result = await this.dispatcherService.send(webhook, event).catch(
          (sendError: unknown): DispatchResult => ({
            success: false,
            error: sendError instanceof Error ? sendError.message : String(sendError),
            body: '',
            responseTimeMs: 0,
          })
        );
        sends.push({ webhook, result, sentAt });
      }
      outage.fired.set(rule.id, { rule, firedAt: now, event, details, sends });
      logger.warn('Postgres is unavailable: alert sent directly to its webhooks', {
        ruleId: rule.id,
        webhooks: sends.length,
        delivered: sends.filter((send) => send.result.success).length,
      });
    }
  }

  private async refreshPostgresOutageTargets(): Promise<void> {
    const rules = (await this.getEventRules()).filter(
      (rule) =>
        rule.category === 'opfield' &&
        rule.eventPattern === 'postgres.unavailable' &&
        (!(rule.resourceIds?.length > 0) || rule.resourceIds.includes(OPFIELD_POSTGRES_RESOURCE_ID))
    );
    const webhookIds = [...new Set(rules.flatMap((rule) => (rule.webhookIds ?? []) as string[]))];
    const webhooks =
      webhookIds.length > 0
        ? (await this.webhookService.getRawByIds(webhookIds)).filter((webhook) => webhook.enabled)
        : [];
    if (webhooks.length > 0) await this.dispatcherService.primeOutboundPolicy();
    const byId = new Map(webhooks.map((webhook) => [webhook.id, webhook]));
    this.postgresOutageTargets = rules.map((rule) => ({
      rule,
      webhooks: ((rule.webhookIds ?? []) as string[]).flatMap((id) => {
        const webhook = byId.get(id);
        return webhook ? [webhook] : [];
      }),
    }));
  }

  /** Postgres answers again: record the outage alert, the deliveries already made, and notify the resolve. */
  private async settlePostgresOutageAlert(alert: PostgresOutageAlert, outage: PostgresOutage): Promise<void> {
    const details = this.getEventTemplateDetails(
      {
        ...(alert.details.details ?? {}),
        back_since: outage.backSince ? new Date(outage.backSince).toISOString() : null,
      },
      'postgres.unavailable',
      'ok',
      OPFIELD_POSTGRES_RESOURCE_ID
    );
    const resolvedEvent = this.buildResolvedEvent(
      alert.rule,
      'opfield',
      OPFIELD_POSTGRES_RESOURCE_ID,
      'Postgres',
      details
    );
    try {
      await this.commitWithDeliveries(alert.rule, resolvedEvent, async (tx) => {
        const [state] = await tx
          .insert(notificationAlertStates)
          .values({
            ruleId: alert.rule.id,
            resourceType: 'opfield',
            resourceId: OPFIELD_POSTGRES_RESOURCE_ID,
            ...alertStateLabels('Postgres', alert.event.message),
            status: 'resolved',
            severity: alert.rule.severity,
            firedAt: new Date(alert.firedAt),
            lastNotifiedAt: new Date(alert.firedAt),
            resolvedAt: new Date(),
            context: details,
          })
          .returning({ id: notificationAlertStates.id });
        for (const send of alert.sends) {
          await this.dispatcherService.recordSentDelivery(
            tx,
            send.webhook,
            alert.event,
            send.result,
            send.sentAt,
            state!.id
          );
        }
        return state!.id;
      });
      logger.info('Postgres outage alert resolved', { ruleId: alert.rule.id });
    } catch (settleError) {
      // The rule or a webhook may have been deleted meanwhile; the outage was already reported.
      logger.warn('Could not record a resolved Postgres outage alert', {
        ruleId: alert.rule.id,
        error: settleError instanceof Error ? settleError.message : String(settleError),
      });
    }
  }

  async evaluateHostingAccount(snapshot: HostingAccountObservation): Promise<void> {
    if (snapshot.syncStatus !== 'success' || !snapshot.summary) return;
    for (const rule of await this.getThresholdRules()) {
      if (rule.category !== 'hosting_account' || !['balance', 'monthly_expenses'].includes(rule.metric)) continue;
      if (rule.resourceIds?.length && !rule.resourceIds.includes(snapshot.connectorId)) continue;
      const money = rule.metric === 'balance' ? snapshot.summary.balance : snapshot.summary.monthlyExpenses;
      if (!money || money.currency !== rule.metricTarget || !/^[-+]?\d+(?:\.\d+)?$/.test(money.amount)) continue;
      const value = Number(money.amount);
      if (!Number.isFinite(value)) continue;
      const breached = evaluateThreshold(value, rule.operator, rule.thresholdValue);
      // Currency is part of the persistent alert key; an account currency change must not resolve a different currency's alert.
      const key = `${snapshot.connectorId}:${money.currency}`;
      await this.recordProbeOutcome(
        rule.id,
        key,
        breached,
        Math.max(rule.durationSeconds ?? 0, rule.resolveAfterSeconds ?? 0) * 1000
      );
      if ((breached ? rule.durationSeconds : rule.resolveAfterSeconds) > 0 && !this.redis) continue;
      const details: TemplateDetails = {
        resourceId: snapshot.connectorId,
        details: { currency: money.currency, provider: snapshot.provider, estimated: money.estimated ?? false },
      };
      if (breached) await this.handleThresholdBreach(rule, key, value, snapshot.connectorId, snapshot.name, details);
      else await this.handleThresholdClear(rule, key, value, snapshot.connectorId, snapshot.name, details);
    }
  }

  /** Serialize rule edits between old observations and new ones, not through a cache-only race. */
  async updateHostingRule<T>(previous: any, update: () => Promise<T>): Promise<T> {
    const oldBarrier = this.hostingRuleBarrier;
    const pending = [...this.hostingEventChains.values()];
    let release!: () => void;
    this.hostingRuleBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await oldBarrier;
      await Promise.allSettled(pending);
      const next = await update();
      this.invalidateRuleCache();
      await this.reconcileHostingRuleUpdate(previous, next);
      return next;
    } finally {
      release();
    }
  }

  /** Editing the source of a rule must not leave its old currency/resource firing forever. */
  async reconcileHostingRuleUpdate(previous: any, next: any): Promise<void> {
    if (!['hosting_account', 'hosting_vm'].includes(previous.category)) return;
    const keys = [
      'enabled',
      'metric',
      'metricTarget',
      'operator',
      'thresholdValue',
      'eventPattern',
      'resourceIds',
      'durationSeconds',
      'resolveAfterSeconds',
      'fireThresholdPercent',
      'resolveThresholdPercent',
    ];
    if (!keys.some((key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]))) return;
    this.invalidateRuleCache();
    const states = await this.db
      .select()
      .from(notificationAlertStates)
      .where(and(eq(notificationAlertStates.ruleId, previous.id), eq(notificationAlertStates.status, 'firing')));
    for (const state of states) {
      const resourceId = previous.category === 'hosting_account' ? state.resourceId.split(':')[0] : state.resourceId;
      await this.resolveAlert(state.id, previous, state.resourceType, state.resourceId, resourceId, {
        resourceId,
        details: { reason: 'rule_updated' },
      });
    }
  }

  /**
   * Resolve firing states a rule edit orphaned. A state that is never evaluated again (rule disabled,
   * different metric/event, resource dropped from scope) would otherwise stay firing forever and, through
   * the unique firing index, suppress every later incident for that resource.
   */
  async reconcileRuleUpdate(previous: any, next: any): Promise<void> {
    if (HOSTING_CATEGORIES.has(previous.category)) {
      await this.reconcileHostingRuleUpdate(previous, next);
      return;
    }
    const sourceChanged = RULE_SOURCE_KEYS.some(
      (key) => JSON.stringify(previous[key] ?? null) !== JSON.stringify(next[key] ?? null)
    );
    const scopeChanged = JSON.stringify(previous.resourceIds ?? []) !== JSON.stringify(next.resourceIds ?? []);
    if (next.enabled && !sourceChanged && !scopeChanged) return;
    this.invalidateRuleCache();

    const states = await this.db
      .select()
      .from(notificationAlertStates)
      .where(and(eq(notificationAlertStates.ruleId, previous.id), eq(notificationAlertStates.status, 'firing')));
    for (const state of states) {
      const reason = !next.enabled
        ? 'rule_disabled'
        : sourceChanged
          ? 'rule_updated'
          : !this.stateInRuleScope(next, state)
            ? 'out_of_scope'
            : null;
      if (reason) await this.resolveOrphanedState(state, next, reason);
    }
  }

  /**
   * Periodic and rule-change sweep over every firing state: resolves states whose rule is disabled,
   * whose resource left the rule scope, whose rule now watches a different metric/event, or whose
   * resource was deleted. Covers edits made outside the REST route (AI and MCP tools).
   */
  async reconcileStaleAlertStates(): Promise<number> {
    const rows = await this.db
      .select({ state: notificationAlertStates, rule: notificationAlertRules })
      .from(notificationAlertStates)
      .innerJoin(notificationAlertRules, eq(notificationAlertRules.id, notificationAlertStates.ruleId))
      .where(eq(notificationAlertStates.status, 'firing'));
    if (rows.length === 0) return 0;

    const missing = await this.findStatesWithDeletedResources(rows);
    let resolved = 0;
    for (const { state, rule } of rows) {
      const reason = !rule.enabled
        ? 'rule_disabled'
        : !this.stateInRuleScope(rule, state)
          ? 'out_of_scope'
          : this.stateWatchesOtherSource(rule, state)
            ? 'rule_updated'
            : missing.has(state.id)
              ? 'resource_deleted'
              : null;
      if (!reason) continue;
      await this.resolveOrphanedState(state, rule, reason);
      resolved++;
    }
    return resolved;
  }

  /**
   * Resolved rows accumulate forever otherwise (every event alert inserts one). Keep them for 30 days,
   * or longer when an event rule's cooldown still reads its newest row.
   */
  async pruneResolvedAlertStates(): Promise<void> {
    const cutoff = new Date(Date.now() - RESOLVED_STATE_RETENTION_MS);
    await this.db
      .delete(notificationAlertStates)
      .where(
        and(
          eq(notificationAlertStates.status, 'resolved'),
          lt(notificationAlertStates.resolvedAt, cutoff),
          sql`${notificationAlertStates.resolvedAt} < now() - make_interval(secs => coalesce((select ${notificationAlertRules.cooldownSeconds} from ${notificationAlertRules} where ${notificationAlertRules.id} = ${notificationAlertStates.ruleId}), 0))`
        )
      );
  }

  private scheduleStateMaintenance(): void {
    if (this.maintenanceDebounce) return;
    this.maintenanceDebounce = setTimeout(() => {
      this.maintenanceDebounce = null;
      void this.runStateMaintenance();
    }, STATE_MAINTENANCE_DEBOUNCE_MS);
    this.maintenanceDebounce.unref?.();
  }

  private runStateMaintenance(): Promise<void> {
    if (this.maintenanceRun) return this.maintenanceRun;
    this.maintenanceRun = (async () => {
      try {
        const resolved = await this.reconcileStaleAlertStates();
        if (resolved > 0) logger.info('Resolved orphaned alert states', { count: resolved });
        if (Date.now() - this.lastResolvedStatePrune >= RESOLVED_STATE_PRUNE_INTERVAL_MS) {
          this.lastResolvedStatePrune = Date.now();
          await this.pruneResolvedAlertStates();
        }
      } catch (error) {
        logger.warn('Alert state maintenance failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.maintenanceRun = null;
      }
    })();
    return this.maintenanceRun;
  }

  /** Match a state key against the rule scope; keys may be composite (node:mount, node:container, account:currency). */
  private stateInRuleScope(rule: any, state: Pick<AlertStateRow, 'resourceId'>): boolean {
    const scope = (rule.resourceIds ?? []) as string[];
    if (scope.length === 0) return true;
    const key = state.resourceId;
    const separator = key.indexOf(':');
    const candidates = separator > 0 ? [key, key.slice(0, separator), key.slice(separator + 1)] : [key];
    return candidates.some((candidate) => scope.includes(candidate));
  }

  /** The state was raised for a metric/event the rule no longer watches. */
  private stateWatchesOtherSource(rule: any, state: Pick<AlertStateRow, 'context'>): boolean {
    const context = (state.context ?? {}) as { metric?: { name?: unknown }; event?: { name?: unknown } };
    if (rule.type === 'threshold') {
      const metric = context.metric?.name;
      return typeof metric === 'string' && !!rule.metric && metric !== rule.metric;
    }
    const eventName = context.event?.name;
    return typeof eventName === 'string' && !!rule.eventPattern && eventName !== rule.eventPattern;
  }

  /**
   * The table a firing state's resource lives in, only for sources whose key is known to be that
   * table's id. Anything else is left alone: a wrong "deleted" verdict would resolve and re-fire forever.
   */
  private resourceReference(rule: any, state: AlertStateRow): { kind: ResourceKind; id: string } | null {
    const nodeId = state.resourceId.split(':')[0] ?? state.resourceId;
    const eventPattern = String(rule.eventPattern ?? '');
    const threshold = rule.type === 'threshold';
    switch (rule.category) {
      case 'node':
        // Metric states are keyed node or node:device; lifecycle states come from the node registry.
        return threshold || eventPattern === 'offline' || eventPattern === 'online'
          ? { kind: 'node', id: nodeId }
          : null;
      case 'container':
        // Metric states are keyed node:container; lifecycle states only carry the container name.
        return threshold && state.resourceId.includes(':') ? { kind: 'node', id: nodeId } : null;
      case 'proxy':
        return state.resourceType === 'proxy' &&
          (threshold || eventPattern.startsWith('health.') || eventPattern === 'maintenance.active')
          ? { kind: 'proxy', id: state.resourceId }
          : null;
      case 'app':
        // Keyed `<app id>:<environment id>`.
        return state.resourceType === 'app' && state.resourceId.includes(':')
          ? { kind: 'app_environment', id: state.resourceId.slice(state.resourceId.indexOf(':') + 1) }
          : null;
      case 'backup':
        // Keyed `<database id>:<policy id>`.
        return state.resourceType === 'backup' && state.resourceId.includes(':')
          ? { kind: 'backup_policy', id: state.resourceId.slice(state.resourceId.indexOf(':') + 1) }
          : null;
      case 'domain':
        return state.resourceType === 'domain' ? { kind: 'domain', id: state.resourceId } : null;
      case 'pki':
        // Keyed by CA id, or `<CA id>:<certificate id>`.
        return state.resourceType === 'pki'
          ? state.resourceId.includes(':')
            ? { kind: 'pki_certificate', id: state.resourceId.slice(state.resourceId.indexOf(':') + 1) }
            : { kind: 'pki_ca', id: state.resourceId }
          : null;
      case 'relay_pool':
        return state.resourceType === 'relay_pool' && !state.resourceId.startsWith('pool:')
          ? { kind: 'relay_instance', id: state.resourceId }
          : null;
      case 'docker_availability':
        return state.resourceType === 'docker_availability'
          ? { kind: 'availability_policy', id: state.resourceId }
          : null;
      case 'certificate':
        return threshold && state.resourceType === 'certificate' ? { kind: 'certificate', id: state.resourceId } : null;
      case 'database_postgres':
      case 'database_clickhouse':
      case 'database_redis':
        // Snapshot metrics and monitoring health are keyed by the database connection id.
        return (threshold && state.resourceType === rule.category) ||
          (state.resourceType === 'database' && eventPattern.startsWith('health.'))
          ? { kind: 'database', id: state.resourceId }
          : null;
      case 'logging':
        return threshold ? { kind: 'logging', id: state.resourceId } : null;
      default:
        return null;
    }
  }

  private async findStatesWithDeletedResources(rows: Array<{ state: AlertStateRow; rule: any }>): Promise<Set<string>> {
    const byKind = new Map<ResourceKind, Map<string, string[]>>();
    for (const { state, rule } of rows) {
      const ref = this.resourceReference(rule, state);
      if (!ref || !UUID_PATTERN.test(ref.id)) continue;
      const ids = byKind.get(ref.kind) ?? new Map<string, string[]>();
      ids.set(ref.id, [...(ids.get(ref.id) ?? []), state.id]);
      byKind.set(ref.kind, ids);
    }

    const missing = new Set<string>();
    for (const [kind, ids] of byKind) {
      const wanted = [...ids.keys()];
      const found = new Set((await this.findExistingResourceIds(kind, wanted)).map((row) => row.id));
      for (const id of wanted) {
        if (!found.has(id)) for (const stateId of ids.get(id) ?? []) missing.add(stateId);
      }
    }
    return missing;
  }

  private findExistingResourceIds(kind: ResourceKind, ids: string[]): Promise<Array<{ id: string }>> {
    switch (kind) {
      case 'node':
        return this.db.select({ id: nodes.id }).from(nodes).where(inArray(nodes.id, ids));
      case 'proxy':
        return this.db.select({ id: proxyHosts.id }).from(proxyHosts).where(inArray(proxyHosts.id, ids));
      case 'certificate':
        return this.db.select({ id: sslCertificates.id }).from(sslCertificates).where(inArray(sslCertificates.id, ids));
      case 'database':
        return this.db
          .select({ id: databaseConnections.id })
          .from(databaseConnections)
          .where(inArray(databaseConnections.id, ids));
      case 'logging':
        return this.db
          .select({ id: loggingEnvironments.id })
          .from(loggingEnvironments)
          .where(inArray(loggingEnvironments.id, ids));
      case 'app_environment':
        return this.db.select({ id: appEnvironments.id }).from(appEnvironments).where(inArray(appEnvironments.id, ids));
      case 'backup_policy':
        return this.db.select({ id: backupPolicies.id }).from(backupPolicies).where(inArray(backupPolicies.id, ids));
      case 'domain':
        return this.db.select({ id: domains.id }).from(domains).where(inArray(domains.id, ids));
      case 'pki_ca':
        return this.db
          .select({ id: certificateAuthorities.id })
          .from(certificateAuthorities)
          .where(inArray(certificateAuthorities.id, ids));
      case 'pki_certificate':
        return this.db.select({ id: certificates.id }).from(certificates).where(inArray(certificates.id, ids));
      case 'relay_instance':
        return this.db.select({ id: relayInstances.id }).from(relayInstances).where(inArray(relayInstances.id, ids));
      case 'availability_policy':
        return this.db
          .select({ id: dockerAvailabilityPolicies.id })
          .from(dockerAvailabilityPolicies)
          .where(inArray(dockerAvailabilityPolicies.id, ids));
    }
  }

  private async resolveOrphanedState(state: AlertStateRow, rule: any, reason: string): Promise<void> {
    const context = (state.context ?? {}) as TemplateDetails & { metric?: Record<string, unknown> };
    const firedAt = state.firedAt;
    await this.resolveAlert(
      state.id,
      rule,
      state.resourceType,
      state.resourceId,
      state.resourceId,
      {
        ...context,
        ...(context.metric ? { metric: { ...context.metric, value: null } as TemplateDetails['metric'] } : {}),
        fired: {
          at: firedAt?.toISOString() ?? null,
          duration: firedAt ? Math.round((Date.now() - firedAt.getTime()) / 1000) : 0,
        },
        resolution: { reason },
      },
      // A rule the operator switched off must not keep talking to its webhooks.
      { notify: reason !== 'rule_disabled' }
    );
  }

  async evaluateLoggingRatios(now = new Date()): Promise<void> {
    if (!this.loggingEnvironmentService || !this.loggingClickHouseService) return;
    const rules = (await this.getThresholdRules()).filter(
      (rule) =>
        rule.category === 'logging' &&
        (rule.metric === 'error_fatal_ratio_percent' || rule.metric === 'fatal_ratio_percent')
    );
    if (rules.length === 0) return;

    const environments = (await this.loggingEnvironmentService.list()).filter((environment) => environment.enabled);
    const from = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    for (const environment of environments) {
      const matchingRules = rules.filter(
        (rule) => !rule.resourceIds?.length || rule.resourceIds.includes(environment.id)
      );
      if (matchingRules.length === 0) continue;
      try {
        const facets = await this.loggingClickHouseService.getFacets(environment.id, {
          from,
          to: now.toISOString(),
        });
        const counts = new Map(facets.severities.map((item) => [item.severity, item.count]));
        const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
        if (total < 20) continue;
        const fatal = counts.get('fatal') ?? 0;
        const error = counts.get('error') ?? 0;
        for (const rule of matchingRules) {
          const value = ((rule.metric === 'fatal_ratio_percent' ? fatal : error + fatal) / total) * 100;
          const breached = evaluateThreshold(value, rule.operator, rule.thresholdValue);
          await this.recordProbeOutcome(
            rule.id,
            environment.id,
            breached,
            Math.max(rule.durationSeconds ?? 0, rule.resolveAfterSeconds ?? 0) * 1000,
            LOGGING_RATIO_SAMPLING_MS
          );
          if (breached) {
            await this.handleThresholdBreach(rule, environment.id, value, environment.id, environment.name);
          } else {
            await this.handleThresholdClear(rule, environment.id, value, environment.id, environment.name);
          }
        }
      } catch (error) {
        logger.warn('Failed to evaluate logging ratios', {
          environmentId: environment.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async evaluateCertificateExpiry(now = new Date()): Promise<void> {
    const rules = (await this.getThresholdRules()).filter(
      (rule) => rule.category === 'certificate' && rule.metric === 'days_until_expiry'
    );
    if (rules.length === 0) return;

    const certs = await this.db
      .select({
        id: sslCertificates.id,
        name: sslCertificates.name,
        domainNames: sslCertificates.domainNames,
        notAfter: sslCertificates.notAfter,
      })
      .from(sslCertificates)
      .where(inArray(sslCertificates.status, [...CERTIFICATE_EXPIRY_MONITORED_STATUSES]));

    // A certificate past notAfter is marked 'expired' (and a failed renewal 'error'); both keep
    // their expiry alert firing instead of resolving it, as ExpiryAlertJob does.
    const activeCerts = certs.filter((cert) => cert.notAfter);
    const activeCertIds = new Set(activeCerts.map((cert) => cert.id));

    for (const rule of rules) {
      const scopedIds = new Set((rule.resourceIds ?? []) as string[]);

      for (const cert of activeCerts) {
        if (scopedIds.size > 0 && !scopedIds.has(cert.id)) continue;

        const notAfter = cert.notAfter!;
        const daysUntilExpiry = Math.ceil((notAfter.getTime() - now.getTime()) / DAY_MS);
        const breached = evaluateThreshold(daysUntilExpiry, rule.operator, rule.thresholdValue);

        if (breached) {
          await this.handleCertificateThresholdBreach(rule, cert, daysUntilExpiry);
        } else {
          await this.handleCertificateThresholdClear(rule, cert, daysUntilExpiry);
        }
      }

      await this.resolveStaleCertificateStates(rule, activeCertIds);
    }
  }

  private async handleCertificateThresholdBreach(
    rule: any,
    cert: {
      id: string;
      name: string;
      domainNames: string[];
      notAfter: Date | null;
    },
    daysUntilExpiry: number
  ): Promise<void> {
    // Expiry is evaluated once a day (and on certificate changes). Fire/resolve windows shorter than a
    // day can never be covered by samples, so stored windows are ignored and the rule acts on each check.
    const existingState = await this.getActiveAlertState(rule.id, 'certificate', cert.id);
    if (existingState) return;

    await this.fireAlert(rule, 'certificate', cert.id, cert.name || cert.domainNames.join(', ') || cert.id, {
      resourceId: cert.id,
      metric: {
        name: rule.metric,
        value: daysUntilExpiry,
        threshold: rule.thresholdValue,
        operator: rule.operator,
        duration: rule.durationSeconds ?? 0,
      },
      certificate: {
        days_until_expiry: daysUntilExpiry,
        expiry_date: cert.notAfter?.toISOString() ?? null,
      },
    });
  }

  private async handleCertificateThresholdClear(
    rule: any,
    cert: {
      id: string;
      name: string;
      domainNames: string[];
      notAfter: Date | null;
    },
    daysUntilExpiry: number
  ): Promise<void> {
    const existingState = await this.getActiveAlertState(rule.id, 'certificate', cert.id);
    if (!existingState) return;

    const firedAt = existingState.firedAt;
    const firedDurationSec = firedAt ? Math.round((Date.now() - firedAt.getTime()) / 1000) : 0;

    await this.resolveAlert(
      existingState.id,
      rule,
      'certificate',
      cert.id,
      cert.name || cert.domainNames.join(', ') || cert.id,
      {
        resourceId: cert.id,
        metric: {
          name: rule.metric,
          value: daysUntilExpiry,
          threshold: rule.thresholdValue,
          operator: rule.operator,
          duration: rule.durationSeconds ?? 0,
        },
        certificate: {
          days_until_expiry: daysUntilExpiry,
          expiry_date: cert.notAfter?.toISOString() ?? null,
        },
        fired: {
          at: firedAt?.toISOString() ?? null,
          duration: firedDurationSec,
        },
      }
    );
  }

  private async resolveStaleCertificateStates(rule: any, activeCertIds: Set<string>): Promise<void> {
    const states = await this.db
      .select()
      .from(notificationAlertStates)
      .where(
        and(
          eq(notificationAlertStates.ruleId, rule.id),
          eq(notificationAlertStates.resourceType, 'certificate'),
          eq(notificationAlertStates.status, 'firing')
        )
      );
    const scopedIds = new Set((rule.resourceIds ?? []) as string[]);

    for (const state of states) {
      const stillActive = activeCertIds.has(state.resourceId);
      const stillInScope = scopedIds.size === 0 || scopedIds.has(state.resourceId);
      if (stillActive && stillInScope) continue;

      const firedAt = state.firedAt;
      const firedDurationSec = firedAt ? Math.round((Date.now() - firedAt.getTime()) / 1000) : 0;

      await this.resolveAlert(state.id, rule, 'certificate', state.resourceId, state.resourceId, {
        resourceId: state.resourceId,
        metric: {
          name: rule.metric,
          value: null,
          threshold: rule.thresholdValue,
          operator: rule.operator,
          duration: rule.durationSeconds ?? 0,
        },
        certificate: {
          days_until_expiry: null,
          expiry_date: null,
        },
        fired: {
          at: firedAt?.toISOString() ?? null,
          duration: firedDurationSec,
        },
        resolution: {
          reason: stillActive ? 'out_of_scope' : 'certificate_inactive_or_deleted',
        },
      });
    }
  }

  private async handleThresholdBreach(
    rule: any,
    compositeResourceId: string,
    currentValue: number,
    nodeId: string,
    rawResourceId: string,
    extraDetails: TemplateDetails = {}
  ): Promise<void> {
    const durationMs = (rule.durationSeconds ?? 0) * 1000;

    if (durationMs > 0 && this.redis) {
      const evaluation = await this.evaluateRatioWindow(
        rule.id,
        compositeResourceId,
        durationMs,
        rule.fireThresholdPercent ?? 100,
        'breach'
      );

      if (!evaluation?.hasCoverage) {
        logger.debug('Fire ratio window has insufficient coverage', { ruleId: rule.id, durationMs });
        return;
      }

      if (!evaluation.thresholdMet) {
        logger.debug('Fire ratio threshold not met', {
          ruleId: rule.id,
          sampleCount: evaluation.sampleCount,
          matchingSamples: evaluation.matchingSamples,
          ratioPercent: Math.round(evaluation.ratioPercent * 100) / 100,
          thresholdPercent: rule.fireThresholdPercent ?? 100,
        });
        return;
      }
    } else if (durationMs > 0 && !this.redis) {
      logger.debug('Fire ratio window skipped: no Redis', { ruleId: rule.id });
    }

    const existingState = await this.getActiveAlertState(rule.id, rule.category, compositeResourceId);

    const nodeName =
      rule.category === 'node' || rule.category === 'container'
        ? (extraDetails.node?.name ?? this.getNodeName(nodeId))
        : undefined;
    const resourceName =
      rule.category === 'node' && extraDetails.node?.name
        ? extraDetails.node.name
        : this.getThresholdResourceName(rule, nodeId, rawResourceId);
    const details: TemplateDetails = {
      ...extraDetails,
      resourceId: await this.getThresholdResourceId(rule, nodeId, rawResourceId),
      metric: {
        name: rule.metric,
        value: currentValue,
        threshold: rule.thresholdValue,
        operator: rule.operator,
        duration: rule.durationSeconds ?? 0,
      },
      node: {
        id: rule.category === 'node' || rule.category === 'container' ? nodeId : null,
        name: nodeName ?? null,
      },
    };

    if (existingState) {
      // Already notified once. The open alert follows the reading ("86% full" while the disk reached 96 % read
      // stale), without notifying again.
      await this.refreshFiringMessage(existingState, rule, compositeResourceId, resourceName, details);
      return;
    }

    await this.fireAlert(rule, rule.category, compositeResourceId, resourceName, details);
  }

  /** Rewrites the message and metric of a firing threshold alert when the reading changed what it says. */
  private async refreshFiringMessage(
    state: { id: string; message?: string | null; context?: unknown },
    rule: any,
    resourceKey: string,
    resourceName: string,
    details: TemplateDetails
  ): Promise<void> {
    details = await this.withNodeName(details);
    const event = this.buildFiredEvent(rule, rule.category, resourceKey, resourceName, details);
    const labels = alertStateLabels(resourceName, event.message);
    if (labels.message === (state.message ?? null)) return;
    const previous = (state.context && typeof state.context === 'object' ? state.context : {}) as Record<string, unknown>;
    await this.db
      .update(notificationAlertStates)
      .set({
        message: labels.message,
        context: { ...previous, metric: details.metric, ...(details.details ? { details: details.details } : {}) },
      })
      .where(and(eq(notificationAlertStates.id, state.id), eq(notificationAlertStates.status, 'firing')));
  }

  private async handleThresholdClear(
    rule: any,
    compositeResourceId: string,
    currentValue: number,
    sourceId?: string,
    rawResourceId?: string,
    extraDetails: TemplateDetails = {}
  ): Promise<void> {
    const existingState = await this.getActiveAlertState(rule.id, rule.category, compositeResourceId);
    if (!existingState) return;

    const resolveMs = (rule.resolveAfterSeconds ?? 60) * 1000;
    let backSince: number | null = null;

    if (resolveMs > 0 && this.redis) {
      const evaluation = await this.evaluateRatioWindow(
        rule.id,
        compositeResourceId,
        resolveMs,
        rule.resolveThresholdPercent ?? 100,
        'clear'
      );

      if (!evaluation?.hasCoverage) {
        logger.debug('Resolve ratio window has insufficient coverage', { ruleId: rule.id, resolveMs });
        return;
      }
      backSince = evaluation.targetSince;

      if (!evaluation.thresholdMet) {
        logger.debug('Resolve ratio threshold not met', {
          ruleId: rule.id,
          sampleCount: evaluation.sampleCount,
          matchingSamples: evaluation.matchingSamples,
          ratioPercent: Math.round(evaluation.ratioPercent * 100) / 100,
          thresholdPercent: rule.resolveThresholdPercent ?? 100,
        });
        return;
      }
    } else if (resolveMs > 0 && !this.redis) {
      logger.debug('Resolve ratio window skipped: no Redis', { ruleId: rule.id });
    }

    const firedAt = existingState.firedAt;
    const firedDurationSec = firedAt ? alertDurationSeconds(firedAt, backSince) : 0;

    const nodeName =
      rule.category === 'node' || rule.category === 'container'
        ? (extraDetails.node?.name ?? this.getNodeName(compositeResourceId.split(':')[0] || compositeResourceId))
        : undefined;
    const resourceName =
      rule.category === 'node' && extraDetails.node?.name
        ? extraDetails.node.name
        : this.getThresholdResourceName(rule, sourceId ?? compositeResourceId, rawResourceId);

    await this.resolveAlert(existingState.id, rule, rule.category, compositeResourceId, resourceName, {
      ...extraDetails,
      resourceId: await this.getThresholdResourceId(rule, sourceId, rawResourceId),
      metric: {
        name: rule.metric,
        value: currentValue,
        threshold: rule.thresholdValue,
        operator: rule.operator,
        duration: rule.durationSeconds ?? 0,
      },
      node: {
        id:
          rule.category === 'node' || rule.category === 'container'
            ? (extraDetails.node?.id ?? (compositeResourceId.split(':')[0] || null))
            : null,
        name: nodeName ?? null,
      },
      fired: {
        at: firedAt?.toISOString() ?? null,
        duration: firedDurationSec,
      },
    });
  }

  private recoveryKey(ruleId: string, resourceId: string): string {
    return `notif:recovery:armed:${ruleId}:${resourceId}`;
  }

  /** The resource left a recovery rule's state: its next return fires the rule. Kept a week. */
  private async armRecovery(ruleId: string, resourceId: string): Promise<void> {
    const key = this.recoveryKey(ruleId, resourceId);
    if (this.redis && !this.usingMemoryProbes()) {
      try {
        await this.redis.set(key, '1', 'EX', 7 * 24 * 3600);
        this.memoryRecoveryArmed.delete(key);
        return;
      } catch (error) {
        this.fallBackToMemoryProbes(error);
      }
    }
    this.memoryRecoveryArmed.add(key);
  }

  /** Whether the resource came back since it left a recovery rule's state; takes the mark, so it fires once. */
  private async takeArmedRecovery(ruleId: string, resourceId: string): Promise<boolean> {
    const key = this.recoveryKey(ruleId, resourceId);
    const inMemory = this.memoryRecoveryArmed.delete(key);
    if (this.redis && !this.usingMemoryProbes()) {
      try {
        return (await this.redis.del(key)) > 0 || inMemory;
      } catch (error) {
        this.fallBackToMemoryProbes(error);
      }
    }
    return inMemory;
  }

  private getProbeOutcomeKey(ruleId: string, compositeResourceId: string): string {
    return `notif:threshold:outcomes:${ruleId}:${compositeResourceId}`;
  }

  /**
   * Record one sample for a rule/resource. The zset is trimmed to the evaluation window but always
   * keeps the newest sample taken before it: that sample is the state at the start of the window.
   * Without it, any source sampled less often than the window (logging ratios every 5 minutes,
   * uptime checks every 2+ minutes) can never cover the window, so the rule never fires or resolves.
   */
  private async recordProbeOutcome(
    ruleId: string,
    compositeResourceId: string,
    breached: boolean,
    windowMs: number,
    samplingPeriodMs = 0
  ): Promise<void> {
    if (!this.redis) return;

    const now = Date.now();
    const redisKey = this.getProbeOutcomeKey(ruleId, compositeResourceId);
    const windowStart = now - Math.max(windowMs, 0);
    if (!this.usingMemoryProbes()) {
      try {
        await this.redis.zadd(redisKey, now, `${now}:${breached ? 1 : 0}`);

        const anchor = this.parseProbeOutcomeSamples(
          await this.redis.zrevrangebyscore(redisKey, `(${windowStart}`, '-inf', 'LIMIT', 0, 1)
        )[0];
        if (anchor) await this.redis.zremrangebyscore(redisKey, '-inf', `(${anchor.timestamp}`);

        // The anchor must survive until the next sample arrives.
        const ttlSeconds = Math.max(
          METRIC_BUFFER_TTL,
          Math.ceil((Math.max(windowMs, 0) + 2 * Math.max(samplingPeriodMs, 0)) / 1000)
        );
        await this.redis.expire(redisKey, ttlSeconds);
        this.memoryProbeOutcomes.delete(redisKey);
        return;
      } catch (error) {
        this.fallBackToMemoryProbes(error);
      }
    }
    // Same window rule as in Redis: keep the samples in the window plus the newest one before it.
    const samples = [...(this.memoryProbeOutcomes.get(redisKey) ?? []), { timestamp: now, breached }];
    this.memoryProbeOutcomes.set(redisKey, withWindowAnchor(samples, windowStart).slice(-MEMORY_PROBE_SAMPLE_LIMIT));
  }

  private usingMemoryProbes(): boolean {
    return Date.now() < this.memoryProbesUntil;
  }

  private fallBackToMemoryProbes(error: unknown): void {
    if (!this.usingMemoryProbes()) {
      logger.warn('Redis did not take an alert sample; alert windows are kept in memory for now', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.memoryProbesUntil = Date.now() + MEMORY_PROBE_RETRY_MS;
  }

  private parseProbeOutcomeSamples(samples: string[]): WindowProbeSample[] {
    return samples.flatMap((sample) => {
      const [timestampRaw, breachedRaw] = sample.split(':');
      const timestamp = Number.parseInt(timestampRaw ?? '', 10);
      if (!Number.isFinite(timestamp)) return [];
      return [{ timestamp, breached: breachedRaw === '1' }];
    });
  }

  private async evaluateRatioWindow(
    ruleId: string,
    compositeResourceId: string,
    windowMs: number,
    thresholdPercent: number,
    targetState: 'breach' | 'clear'
  ) {
    if (!this.redis) return null;

    const now = Date.now();
    const redisKey = this.getProbeOutcomeKey(ruleId, compositeResourceId);
    const windowStart = now - windowMs;
    let samples: WindowProbeSample[] | null = null;
    if (!this.usingMemoryProbes()) {
      try {
        const [inWindow, beforeWindow] = await Promise.all([
          this.redis.zrangebyscore(redisKey, windowStart, '+inf'),
          this.redis.zrevrangebyscore(redisKey, `(${windowStart}`, '-inf', 'LIMIT', 0, 1),
        ]);
        const windowSamples = this.parseProbeOutcomeSamples(inWindow).sort((a, b) => a.timestamp - b.timestamp);
        const preWindowAnchor = this.parseProbeOutcomeSamples(beforeWindow)[0];
        samples = preWindowAnchor ? [preWindowAnchor, ...windowSamples] : windowSamples;
      } catch (error) {
        this.fallBackToMemoryProbes(error);
      }
    }
    samples ??= withWindowAnchor(this.memoryProbeOutcomes.get(redisKey) ?? [], windowStart);
    // The anchor stands for the state at the window's start; a sample taken exactly then already says it. Counting
    // both held a periodic source's alert one sampling period longer than its window (the anchor still breached).
    const ordered = [...samples].sort((a, b) => a.timestamp - b.timestamp);
    if (ordered.length > 1 && ordered[0]!.timestamp < windowStart && ordered[1]!.timestamp === windowStart) {
      ordered.shift();
    }

    return evaluateWindowRatio(ordered, targetState, thresholdPercent, windowMs, now);
  }

  // ── EventBus Event Handling ─────────────────────────────────────────

  private async handleBusEvent(channel: string, payload: any): Promise<void> {
    if (channel === 'hosting.account.observed') await this.evaluateHostingAccount(payload);
    const mappings = EVENT_BUS_MAPPINGS[channel];
    if (!mappings) return;

    for (const mapping of mappings) {
      if (!mapping.match(payload)) continue;

      const resource = mapping.extractResource(payload);
      const extraData = mapping.extractData?.(payload) ?? {};

      if (mapping.stateful) {
        const currentState = mapping.stateful.currentState(payload);
        await this.observeStatefulEvent(
          mapping.category,
          currentState,
          resource,
          extraData,
          mapping.stateful.observedPatterns
        );
        if (mapping.stateful.holdsUntilNextEvent) {
          await this.holdStatefulState(
            mapping.category,
            currentState,
            resource,
            extraData,
            mapping.stateful.observedPatterns
          );
        }
        continue;
      }

      await this.emitEvent(mapping.category, mapping.eventId, resource, extraData);
    }

    if (channel === 'ssl.cert.changed') {
      await this.evaluateCertificateExpiry();
    }
  }

  /**
   * Something happened once (not a state): the event rules of the category for it fire, each at most once per
   * cooldown for the resource. Bus events and periodic sources (Docker Availability operations) both come here.
   */
  async emitEvent(
    category: string,
    eventId: string,
    resource: { type: string; id: string; name?: string },
    context: Record<string, unknown> = {}
  ): Promise<void> {
    for (const rule of await this.getEventRules()) {
      if (rule.category !== category || rule.eventPattern !== eventId) continue;
      if (!this.stateInRuleScope(rule, { resourceId: resource.id })) continue;
      // States (supportsThreshold) are observed with windows, see observeStatefulEvent.
      if (eventSupportsThreshold(rule.category, rule.eventPattern)) continue;
      // Cooldown from the last notification of the rule for the resource (events keep no firing state).
      if (await this.isEventInCooldown(rule.id, resource.type, resource.id, rule.cooldownSeconds)) continue;
      await this.fireEventAlert(
        rule,
        resource.type,
        resource.id,
        resource.name ?? resource.id,
        this.getEventTemplateDetails(context, eventId, undefined, resource.id)
      );
    }
  }

  /**
   * A source that publishes only when its state changes (the relay supervisor) sends no samples while the state
   * holds, so a rule's window stayed uncovered until the next change: a relay healthy again left its alert firing
   * until the next outage began. The state is observed again when each rule's window can be covered (fire after
   * its duration, resolve after its resolve window), unless a newer event of the source replaced it by then.
   */
  private async holdStatefulState(
    category: string,
    currentState: string,
    resource: { type: string; id: string; name?: string },
    context: Record<string, unknown>,
    observedPatterns: string[]
  ): Promise<void> {
    const key = `${category}:${resource.type}:${resource.id}`;
    const previous = this.heldStates.get(key);
    for (const timer of previous?.timers ?? []) clearTimeout(timer);
    this.heldStates.delete(key);
    const patterns = new Set(observedPatterns);
    const windows = new Set<number>();
    for (const rule of await this.getEventRules()) {
      if (rule.category !== category || !patterns.has(rule.eventPattern)) continue;
      if (!eventSupportsThreshold(rule.category, rule.eventPattern)) continue;
      if (!this.stateInRuleScope(rule, { resourceId: resource.id })) continue;
      const seconds =
        rule.eventPattern === currentState ? (rule.durationSeconds ?? 0) : (rule.resolveAfterSeconds ?? 60);
      if (seconds > 0) windows.add(seconds * 1000);
    }
    if (windows.size === 0 || this.stopped) return;
    const held = { timers: [] as Array<ReturnType<typeof setTimeout>> };
    for (const windowMs of windows) {
      const timer = setTimeout(() => {
        if (this.heldStates.get(key) !== held) return;
        const active = this.observeStatefulEvent(category, currentState, resource, context, observedPatterns)
          .catch((error) => {
            logger.error('Error observing a held state', {
              key,
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => this.activeHandlers.delete(active));
        this.activeHandlers.add(active);
      }, windowMs + HELD_STATE_SLACK_MS);
      timer.unref?.();
      held.timers.push(timer);
    }
    this.heldStates.set(key, held);
  }

  async observeStatefulEvent(
    category: string,
    currentState: string,
    resource: { type: string; id: string; name?: string },
    context: Record<string, unknown> = {},
    observedPatterns?: string[],
    /** How often this source is observed, when periodic; keeps the window anchor alive between samples. */
    samplingPeriodMs?: number
  ): Promise<void> {
    const eventRules = await this.getEventRules();
    const observedPatternSet = observedPatterns ? new Set(observedPatterns) : null;

    for (const rule of eventRules) {
      if (rule.category !== category) continue;
      if (!eventSupportsThreshold(rule.category, rule.eventPattern)) continue;
      if (observedPatternSet && !observedPatternSet.has(rule.eventPattern)) continue;
      // Keys may be composite (`<app id>:<environment id>`): a rule scoped to either part covers the resource.
      if (!this.stateInRuleScope(rule, { resourceId: resource.id })) continue;

      const active = rule.eventPattern === currentState;
      await this.recordProbeOutcome(
        rule.id,
        resource.id,
        active,
        Math.max(rule.durationSeconds ?? 0, rule.resolveAfterSeconds ?? 0) * 1000,
        samplingPeriodMs
      );

      const existingState = await this.getActiveAlertState(rule.id, resource.type, resource.id);
      // A recovery event (Node Online) is a transition: it fires when the resource comes back, not for a resource that
      // simply is online (every health report observes it, so a new rule fired for every node at once and an alert
      // that never closed blocked every later return; stand rc.8, F-5). Leaving the state arms it and closes its alert
      // quietly at once.
      const recovery = isRecoveryEvent(rule.category, rule.eventPattern);
      if (recovery && !active) {
        await this.armRecovery(rule.id, resource.id);
        if (existingState) {
          await this.resolveAlert(
            existingState.id,
            rule,
            resource.type,
            resource.id,
            resource.name,
            this.getEventTemplateDetails(context, rule.eventPattern, currentState, resource.id)
          );
        }
        continue;
      }

      if (active) {
        const durationMs = (rule.durationSeconds ?? 0) * 1000;
        if (durationMs > 0 && this.redis) {
          const evaluation = await this.evaluateRatioWindow(
            rule.id,
            resource.id,
            durationMs,
            rule.fireThresholdPercent ?? 100,
            'breach'
          );
          if (!evaluation?.hasCoverage || !evaluation.thresholdMet) continue;
        } else if (durationMs > 0 && !this.redis) {
          continue;
        }

        if (existingState) continue;
        if (recovery && !(await this.takeArmedRecovery(rule.id, resource.id))) continue;

        await this.fireAlert(
          rule,
          resource.type,
          resource.id,
          resource.name ?? resource.id,
          this.getEventTemplateDetails(context, rule.eventPattern, currentState, resource.id)
        );
        continue;
      }

      if (!existingState) continue;

      const resolveMs = (rule.resolveAfterSeconds ?? 60) * 1000;
      let backSince: number | null = null;
      if (resolveMs > 0 && this.redis) {
        const evaluation = await this.evaluateRatioWindow(
          rule.id,
          resource.id,
          resolveMs,
          rule.resolveThresholdPercent ?? 100,
          'clear'
        );
        if (!evaluation?.hasCoverage || !evaluation.thresholdMet) continue;
        backSince = evaluation.targetSince;
      } else if (resolveMs > 0 && !this.redis) {
        continue;
      }

      await this.resolveAlert(
        existingState.id,
        rule,
        resource.type,
        resource.id,
        resource.name,
        this.getEventTemplateDetails(context, rule.eventPattern, currentState, resource.id),
        { backSince }
      );
    }
  }

  async reconcileProxyMaintenance(resourceId?: string): Promise<void> {
    const eventRules = (await this.getEventRules()).filter(
      (rule) => rule.category === 'proxy' && rule.eventPattern === 'maintenance.active'
    );
    const hosts = await this.db.query.proxyHosts.findMany({
      where: resourceId
        ? and(eq(proxyHosts.id, resourceId), eq(proxyHosts.isSystem, false))
        : eq(proxyHosts.isSystem, false),
    });

    for (const host of hosts) {
      const active = host.enabled && effectiveMaintenance(host);
      await this.observeStatefulEvent(
        'proxy',
        active ? 'maintenance.active' : 'maintenance.inactive',
        { type: 'proxy', id: host.id, name: host.domainNames?.[0] ?? host.id },
        { maintenance_active: active },
        ['maintenance.active']
      );
    }

    const conditions = [
      eq(notificationAlertStates.status, 'firing'),
      eq(notificationAlertStates.resourceType, 'proxy'),
      eq(notificationAlertRules.category, 'proxy'),
    ];
    if (resourceId) conditions.push(eq(notificationAlertStates.resourceId, resourceId));
    const firingStates = await this.db
      .select({ state: notificationAlertStates, rule: notificationAlertRules })
      .from(notificationAlertStates)
      .innerJoin(notificationAlertRules, eq(notificationAlertRules.id, notificationAlertStates.ruleId))
      .where(and(...conditions));

    const hostsById = new Map(hosts.map((host) => [host.id, host]));
    const enabledRuleIds = new Set(eventRules.map((rule) => rule.id));
    for (const { state, rule } of firingStates) {
      const stateEventName = (state.context as { event?: { name?: string } } | null)?.event?.name;
      if (stateEventName !== 'maintenance.active' && rule.eventPattern !== 'maintenance.active') continue;
      const host = hostsById.get(state.resourceId);
      const scopedIds = (rule.resourceIds ?? []) as string[];
      const stale =
        !enabledRuleIds.has(rule.id) || !host || (scopedIds.length > 0 && !scopedIds.includes(state.resourceId));
      if (!stale) continue;

      await this.resolveAlert(state.id, rule, 'proxy', state.resourceId, host?.domainNames?.[0] ?? state.resourceId, {
        resourceId: state.resourceId,
        state: { current: host && effectiveMaintenance(host) ? 'maintenance.active' : 'maintenance.inactive' },
        event: { name: 'maintenance.active' },
        resolution: { reason: 'resource_inactive_deleted_or_out_of_scope' },
      });
    }
  }

  // ── Alert State Management ──────────────────────────────────────────

  /**
   * Transactional outbox: the alert state change and its webhook deliveries commit together, so a
   * restart or a failed send after commit leaves queued deliveries for the retry job instead of a
   * silently lost notification. applyStateChange returns the alert state it changed (the deliveries
   * name it), or null when the change did not apply (lost a race); so does this.
   */
  private async commitWithDeliveries(
    rule: any,
    event: NotificationEvent | null,
    applyStateChange: (tx: DrizzleTransaction) => Promise<string | null>,
    /** Only these of the rule's webhooks get the notification. */
    onlyWebhookIds?: string[]
  ): Promise<string | null> {
    const webhookIds = ((rule.webhookIds ?? []) as string[]).filter(
      (id) => !onlyWebhookIds || onlyWebhookIds.includes(id)
    );
    const webhooks =
      event && webhookIds.length > 0
        ? (await this.webhookService.getRawByIds(webhookIds)).filter((webhook) => webhook.enabled)
        : [];
    let queuedWebhookIds: string[] = [];
    const stateId = await this.db.transaction(async (tx) => {
      const changed = await applyStateChange(tx);
      if (!changed) return null;
      if (event && webhooks.length > 0) {
        queuedWebhookIds = await this.dispatcherService.enqueue(tx, webhooks, event, changed);
      }
      return changed;
    });
    if (stateId && queuedWebhookIds.length > 0) this.sendQueuedDeliveries(rule.id, queuedWebhookIds);
    return stateId;
  }

  private sendQueuedDeliveries(ruleId: string, webhookIds: string[]): void {
    const work: Promise<void> = this.dispatcherService
      .drainWebhooks(webhookIds)
      .catch((err) => {
        logger.warn('Immediate alert delivery failed; the retry job will send it', {
          ruleId,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => this.activeDeliveries.delete(work));
    this.activeDeliveries.add(work);
  }

  private async fireAlert(
    rule: any,
    resourceType: string,
    resourceKey: string,
    resourceName: string,
    details: TemplateDetails
  ): Promise<void> {
    details = await this.withNodeName(details);
    const parent = await this.foldingParent(rule, resourceType, resourceKey, details);
    if (parent === 'hold') {
      logger.debug('Route alert held: the alert explaining it resolved just now', {
        ruleId: rule.id,
        resourceId: resourceKey,
      });
      return;
    }
    const event = this.buildFiredEvent(rule, resourceType, resourceKey, resourceName, details);

    const fired = await this.commitWithDeliveries(rule, event, async (tx) => {
      // The partial unique index on firing states makes a concurrent duplicate a no-op.
      const inserted = await tx
        .insert(notificationAlertStates)
        .values({
          ruleId: rule.id,
          resourceType,
          resourceId: resourceKey,
          ...alertStateLabels(resourceName, event.message),
          status: 'firing',
          severity: rule.severity,
          context: parent ? { ...details, folded: parent } : details,
        })
        .onConflictDoNothing()
        .returning({ id: notificationAlertStates.id });
      return inserted[0]?.id ?? null;
    });
    if (!fired) return; // already firing

    this.eventBus?.publish('alert.fired', {
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      resourceType,
      resourceId: resourceKey,
    });

    if (parent) {
      logger.info('Alert fired, folded under another alert', {
        ruleId: rule.id,
        ruleName: rule.name,
        resourceType,
        resourceId: resourceKey,
        foldedUnder: parent.label,
      });
    } else {
      logger.info('Alert fired', { ruleId: rule.id, ruleName: rule.name, resourceType, resourceId: resourceKey });
    }
    const parentKind = foldingParentKind(rule);
    if (parentKind) await this.foldFiringRouteAlerts(fired, parentKind, rule, resourceKey, resourceName);
  }

  private async resolveAlert(
    stateId: string,
    rule: any,
    resourceType: string,
    resourceKey: string,
    resourceName: string | undefined,
    details: TemplateDetails,
    /** backSince: when the resource got back to normal (the start of the clear samples that resolve it). */
    options: { notify?: boolean; backSince?: number | null } = {}
  ): Promise<void> {
    details = await this.withNodeName(details);
    const [state] = await this.db
      .select({ firedAt: notificationAlertStates.firedAt, context: notificationAlertStates.context })
      .from(notificationAlertStates)
      .where(eq(notificationAlertStates.id, stateId))
      .limit(1);
    // How long the alert lasted, for the resolve message and its template ({{fired.*}}): until the resource got
    // back, not until the resolve window was covered.
    if (!details.fired && state?.firedAt) {
      details = {
        ...details,
        fired: {
          at: state.firedAt.toISOString(),
          duration: alertDurationSeconds(outageStart(state.context, state.firedAt), options.backSince),
        },
      };
    }
    const event = this.buildResolvedEvent(rule, resourceType, resourceKey, resourceName, details);
    // A folded alert resolves only where its own firing went out (or is still queued, where both are dropped).
    const onlyWebhookIds = foldedUnder(state?.context) ? await this.webhooksWithFiring(stateId) : undefined;

    // A recovery alert (Node Online) ends when its resource goes down again: that is not a recovery that cleared, so
    // the state closes without a message.
    const notify = options.notify !== false && !isRecoveryEvent(rule.category, rule.eventPattern);
    // Health reports and sweeps race on the same state: only the caller that flips it notifies.
    const resolved = await this.commitWithDeliveries(
      rule,
      notify ? event : null,
      async (tx) => {
        const rows = await tx
          .update(notificationAlertStates)
          .set({ status: 'resolved', resolvedAt: new Date() })
          .where(and(eq(notificationAlertStates.id, stateId), eq(notificationAlertStates.status, 'firing')))
          .returning({ id: notificationAlertStates.id });
        return rows[0]?.id ?? null;
      },
      onlyWebhookIds
    );
    if (!resolved) return;

    this.eventBus?.publish('alert.resolved', {
      ruleId: rule.id,
      ruleName: rule.name,
      resourceType,
      resourceId: resourceKey,
    });

    logger.info('Alert resolved', { ruleId: rule.id, ruleName: rule.name, resourceType, resourceId: resourceKey });
    if (foldingParentKind(rule)) await this.resolveFoldedAlerts(stateId);
  }

  // ── Alert folding ───────────────────────────────────────────────────
  //
  // One cause should be one alert. A route (proxy host) health alert is folded under a parent alert that explains it:
  // - the route's node is down: a node "offline" alert fires for the node serving the route (its nginx node or a
  //   member of its ingress group) or running its container upstream;
  // - Opfield lost outbound connectivity: the "outbound.unavailable" opfield alert fires and the route's failing probe
  //   was sent by Opfield itself and got no answer (DNS, connect, timeout).
  // A folded alert is recorded as usual, with context.folded naming the parent. Its firing is not sent to a webhook
  // that gets the parent's firing (the dispatcher drops it there, see supersededReason); a webhook that does not get
  // the parent still gets it. It resolves together with the parent, quietly, and its resolve goes only where its
  // firing went. A parent that fires later folds the route alerts already firing that it explains. For FOLD_GRACE_MS
  // after a parent resolves, the route alerts it explains are held (not raised), so routes coming back right after
  // their node or Opfield's connectivity do not alert; a route still down after that alerts on its own.
  // A container or deployment health alert (offline, degraded) folds the same way under the down alert of the node it
  // runs on (stand rc.8, O-4: a container alert fired for a node that was itself cut off).

  /** The parent alert a route alert folds under, 'hold' while one resolved within FOLD_GRACE_MS, or null. */
  private async foldingParent(
    rule: any,
    resourceType: string,
    resourceKey: string,
    details: TemplateDetails
  ): Promise<FoldedUnder | 'hold' | null> {
    const route = isFoldableRouteRule(rule) && resourceType === 'proxy';
    if (!route && !isFoldableContainerAlert(rule, resourceType)) return null;
    const unreachable = route && details.details?.probe_failure === 'unreachable';
    const nodeIds = route ? await this.routeNodeIds(resourceKey) : details.node?.id ? [details.node.id] : [];
    const sources: SQL[] = [];
    if (nodeIds.length > 0) {
      sources.push(
        and(
          eq(notificationAlertRules.category, 'node'),
          eq(notificationAlertRules.eventPattern, 'offline'),
          eq(notificationAlertStates.resourceType, 'node'),
          inArray(notificationAlertStates.resourceId, nodeIds)
        )!
      );
    }
    if (unreachable) {
      sources.push(
        and(
          eq(notificationAlertStates.resourceType, 'opfield'),
          eq(notificationAlertStates.resourceId, OPFIELD_OUTBOUND_RESOURCE_ID)
        )!
      );
    }
    if (sources.length === 0) return null;
    const parents = await this.db
      .select({
        id: notificationAlertStates.id,
        status: notificationAlertStates.status,
        resourceType: notificationAlertStates.resourceType,
        resourceId: notificationAlertStates.resourceId,
        ruleName: notificationAlertRules.name,
      })
      .from(notificationAlertStates)
      .innerJoin(notificationAlertRules, eq(notificationAlertRules.id, notificationAlertStates.ruleId))
      .where(
        and(
          or(...sources),
          or(
            eq(notificationAlertStates.status, 'firing'),
            gt(notificationAlertStates.resolvedAt, new Date(Date.now() - FOLD_GRACE_MS))
          )
        )
      );
    const firing = parents.find((parent) => parent.status === 'firing');
    if (firing) {
      const outbound = firing.resourceType === 'opfield';
      return {
        stateId: firing.id,
        kind: outbound ? 'opfield_outbound' : 'node',
        label: `${firing.ruleName} (${outbound ? 'Opfield' : await this.nodeNameOf(firing.resourceId)})`,
      };
    }
    return parents.length > 0 ? 'hold' : null;
  }

  /** The nodes a route depends on: its nginx node or ingress group members, and the node running its container. */
  private async routeNodeIds(proxyHostId: string): Promise<string[]> {
    if (!UUID_PATTERN.test(proxyHostId)) return [];
    const [host] = await this.db
      .select({
        nodeId: proxyHosts.nodeId,
        ingressGroupId: proxyHosts.ingressGroupId,
        dockerNodeId: proxyHosts.dockerNodeId,
      })
      .from(proxyHosts)
      .where(eq(proxyHosts.id, proxyHostId))
      .limit(1);
    if (!host) return [];
    const serving = (await resolveIngressNodesForMany(this.db, [host])).get(host) ?? [];
    return [...new Set([...serving, ...(host.dockerNodeId ? [host.dockerNodeId] : [])])];
  }

  /** A parent alert fired: fold the route alerts already firing that it explains. */
  private async foldFiringRouteAlerts(
    parentStateId: string,
    kind: FoldedUnder['kind'],
    parentRule: any,
    parentResourceKey: string,
    parentResourceName: string
  ): Promise<void> {
    const candidates = await this.db
      .select({ state: notificationAlertStates, rule: notificationAlertRules })
      .from(notificationAlertStates)
      .innerJoin(notificationAlertRules, eq(notificationAlertRules.id, notificationAlertStates.ruleId))
      .where(
        and(
          eq(notificationAlertStates.status, 'firing'),
          or(
            and(
              eq(notificationAlertStates.resourceType, 'proxy'),
              eq(notificationAlertRules.category, 'proxy'),
              inArray(notificationAlertRules.eventPattern, [...FOLDABLE_ROUTE_EVENTS])
            ),
            kind === 'node'
              ? and(
                  inArray(notificationAlertStates.resourceType, CONTAINER_ALERT_RESOURCE_TYPES),
                  eq(notificationAlertRules.category, 'container'),
                  inArray(notificationAlertRules.eventPattern, [...FOLDABLE_CONTAINER_EVENTS])
                )
              : undefined
          ),
          sql`${notificationAlertStates.context} -> 'folded' is null`,
          // Only what the parent's outage explains (FOLD_LEAD_MS); an older alert has another cause.
          gte(
            notificationAlertStates.firedAt,
            new Date(Date.now() - (parentRule.durationSeconds ?? 0) * 1000 - FOLD_LEAD_MS)
          )
        )
      );
    const folded: FoldedUnder = {
      stateId: parentStateId,
      kind,
      label: `${parentRule.name} (${kind === 'opfield_outbound' ? 'Opfield' : parentResourceName})`,
    };
    for (const { state } of candidates) {
      const context = (state.context ?? {}) as TemplateDetails;
      const explained =
        state.resourceType !== 'proxy'
          ? kind === 'node' && context.node?.id === parentResourceKey
          : kind === 'opfield_outbound'
            ? context.details?.probe_failure === 'unreachable'
            : (await this.routeNodeIds(state.resourceId)).includes(parentResourceKey);
      if (!explained) continue;
      await this.db
        .update(notificationAlertStates)
        .set({ context: { ...context, folded } })
        .where(and(eq(notificationAlertStates.id, state.id), eq(notificationAlertStates.status, 'firing')));
      logger.info('Route alert folded under an alert that fired after it', {
        stateId: state.id,
        resourceId: state.resourceId,
        foldedUnder: folded.label,
      });
    }
    // Their firings still queued for a webhook that gets the parent are dropped when the queue reaches them.
  }

  /**
   * A parent alert resolved. A folded alert whose firing went out nowhere (every webhook got the parent instead) closes
   * quietly with it: if its resource is still down, it fires on its own at its next check once the hold after the
   * parent (FOLD_GRACE_MS) ends. One whose firing a webhook did get is not claimed back: it stays firing and is
   * re-evaluated by its own checks, which resolve it (where its firing went) only once its resource is back (stand
   * rc.9, F-2: resolved with the node as "back online" while the container was still gone).
   */
  private async resolveFoldedAlerts(parentStateId: string): Promise<void> {
    const children = await this.db
      .select({ state: notificationAlertStates, rule: notificationAlertRules })
      .from(notificationAlertStates)
      .innerJoin(notificationAlertRules, eq(notificationAlertRules.id, notificationAlertStates.ruleId))
      .where(
        and(
          eq(notificationAlertStates.status, 'firing'),
          sql`${notificationAlertStates.context} -> 'folded' ->> 'stateId' = ${parentStateId}`
        )
      );
    for (const { state, rule } of children) {
      if ((await this.webhooksWithFiring(state.id)).length > 0) {
        const context = (state.context ?? {}) as TemplateDetails & { folded?: FoldedUnder };
        await this.db
          .update(notificationAlertStates)
          .set({ context: { ...context, folded: { ...context.folded!, parentResolvedAt: new Date().toISOString() } } })
          .where(and(eq(notificationAlertStates.id, state.id), eq(notificationAlertStates.status, 'firing')));
        logger.info('Folded alert stays firing after its parent resolved; its own checks resolve it', {
          stateId: state.id,
          resourceId: state.resourceId,
        });
        continue;
      }
      const [host] = UUID_PATTERN.test(state.resourceId)
        ? await this.db
            .select({ domainNames: proxyHosts.domainNames })
            .from(proxyHosts)
            .where(eq(proxyHosts.id, state.resourceId))
            .limit(1)
        : [];
      const context = (state.context ?? {}) as TemplateDetails;
      await this.resolveAlert(
        state.id,
        rule,
        state.resourceType,
        state.resourceId,
        host?.domainNames?.[0] ?? state.resourceId,
        { ...context, resourceId: state.resourceId, resolution: { reason: 'resolved_with_parent' } }
      );
    }
  }

  /** Webhooks this alert's firing went out to or is still queued for. */
  private async webhooksWithFiring(stateId: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ webhookId: notificationDeliveryLog.webhookId })
      .from(notificationDeliveryLog)
      .where(
        and(
          eq(notificationDeliveryLog.alertStateId, stateId),
          eq(notificationDeliveryLog.eventType, 'alert.fired'),
          inArray(notificationDeliveryLog.status, ['success', ...OPEN_DELIVERY_STATUSES])
        )
      );
    return rows.map((row) => row.webhookId);
  }

  /** The notification for a firing alert, with the rule's message template rendered. */
  private buildFiredEvent(
    rule: any,
    resourceType: string,
    resourceKey: string,
    resourceName: string,
    details: TemplateDetails
  ): NotificationEvent {
    const now = new Date().toISOString();
    const resource = this.buildTemplateResource(resourceType, resourceKey, resourceName, details.resourceId);
    const messageContext = this.buildAlertTemplateContext(rule, 'alert.fired', 'firing', resource, now, {
      ...details,
      fired: { ...details.fired, at: details.fired?.at ?? now },
    });
    const message = rule.messageTemplate
      ? renderTemplate(rule.messageTemplate, messageContext)
      : defaultFiredMessage(rule, resourceName, details);
    return {
      type: 'alert.fired',
      title: rule.name,
      message,
      severity: rule.severity as Severity,
      resource,
      context: { ...messageContext, notification: { ...messageContext.notification, message } },
      timestamp: now,
    };
  }

  /** The notification for a resolved alert, with the rule's resolve message rendered. */
  private buildResolvedEvent(
    rule: any,
    resourceType: string,
    resourceKey: string,
    resourceName: string | undefined,
    details: TemplateDetails
  ): NotificationEvent {
    const now = new Date().toISOString();
    const resolvedResource = this.buildTemplateResource(
      resourceType,
      resourceKey,
      resourceName ?? resourceKey,
      details.resourceId
    );
    const resolveContext = this.buildAlertTemplateContext(
      rule,
      'alert.resolved',
      'resolved',
      resolvedResource,
      now,
      details
    );
    // Never the firing message: the rule's resolve message, else Opfield's text for the rule ("... is back online").
    const resolveTemplate = resolveTemplateOf(rule);
    const resolveMessage = resolveTemplate
      ? renderTemplate(resolveTemplate, resolveContext)
      : defaultResolveMessage(rule, resolvedResource.name, details);
    return {
      type: 'alert.resolved',
      title: `Resolved: ${rule.name}`,
      message: resolveMessage,
      severity: 'info',
      resource: resolvedResource,
      context: { ...resolveContext, notification: { ...resolveContext.notification, message: resolveMessage } },
      timestamp: now,
    };
  }

  /** Fire an event-type alert — no persistent state, just cooldown tracking */
  private async fireEventAlert(
    rule: any,
    resourceType: string,
    resourceKey: string,
    resourceName: string,
    details: TemplateDetails
  ): Promise<void> {
    // Dedup guard: use Redis SET NX to prevent concurrent duplicate dispatches
    if (this.redis) {
      const lockKey = `notif:event:lock:${rule.id}:${resourceType}:${resourceKey}`;
      const acquired = await this.redis.set(lockKey, '1', 'EX', 10, 'NX');
      if (!acquired) return; // another handler is already processing this event
    }

    const now = new Date().toISOString();
    const resource = this.buildTemplateResource(
      resourceType,
      resourceKey,
      resourceName,
      details.resourceId ?? resourceKey
    );
    const messageContext = this.buildAlertTemplateContext(rule, 'alert.fired', 'firing', resource, now, details);
    const message = rule.messageTemplate
      ? renderTemplate(rule.messageTemplate, messageContext)
      : `${rule.name}: ${resourceName}`;
    const eventContext = {
      ...messageContext,
      notification: { ...messageContext.notification, message },
    };

    const event: NotificationEvent = {
      type: 'alert.fired',
      title: rule.name,
      message,
      severity: rule.severity as Severity,
      resource,
      context: eventContext,
      timestamp: now,
    };

    // Record notification time for cooldown, in the same transaction as its deliveries.
    await this.commitWithDeliveries(rule, event, async (tx) => {
      const [state] = await tx
        .insert(notificationAlertStates)
        .values({
          ruleId: rule.id,
          resourceType,
          resourceId: resourceKey,
          ...alertStateLabels(resourceName, message),
          status: 'resolved',
          severity: rule.severity,
          context: details,
          resolvedAt: new Date(),
        })
        .returning({ id: notificationAlertStates.id });
      return state?.id ?? null;
    });

    this.eventBus?.publish('alert.fired', {
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      resourceType,
      resourceId: resourceKey,
    });

    logger.info('Event alert fired', { ruleId: rule.id, ruleName: rule.name, resourceType, resourceId: resourceKey });
  }

  /** Check if an event-type alert is still in cooldown */
  private async isEventInCooldown(
    ruleId: string,
    resourceType: string,
    resourceId: string,
    cooldownSeconds: number
  ): Promise<boolean> {
    const [latest] = await this.db
      .select({ resolvedAt: notificationAlertStates.resolvedAt })
      .from(notificationAlertStates)
      .where(
        and(
          eq(notificationAlertStates.ruleId, ruleId),
          eq(notificationAlertStates.resourceType, resourceType),
          eq(notificationAlertStates.resourceId, resourceId)
        )
      )
      .orderBy(desc(notificationAlertStates.resolvedAt))
      .limit(1);

    if (!latest?.resolvedAt) return false;
    const elapsed = Date.now() - latest.resolvedAt.getTime();
    return elapsed < cooldownSeconds * 1000;
  }

  private async getActiveAlertState(ruleId: string, resourceType: string, resourceId: string) {
    const [state] = await this.db
      .select()
      .from(notificationAlertStates)
      .where(
        and(
          eq(notificationAlertStates.ruleId, ruleId),
          eq(notificationAlertStates.resourceType, resourceType),
          eq(notificationAlertStates.resourceId, resourceId),
          eq(notificationAlertStates.status, 'firing')
        )
      )
      .limit(1);
    return state ?? null;
  }

  // ── Rule Cache ──────────────────────────────────────────────────────

  private async refreshRuleCache() {
    if (Date.now() - this.lastRuleCacheRefresh > this.RULE_CACHE_TTL) {
      // Set timestamp before awaits to prevent thundering herd
      this.lastRuleCacheRefresh = Date.now();
      const [threshold, event] = await Promise.all([
        this.ruleService.getEnabledThresholdRules(),
        this.ruleService.getEnabledEventRules(),
      ]);
      this.thresholdRulesCache = threshold;
      this.eventRulesCache = event;
    }
  }

  private async getThresholdRules() {
    await this.refreshRuleCache();
    return this.thresholdRulesCache;
  }

  private async getEventRules() {
    await this.refreshRuleCache();
    return this.eventRulesCache;
  }

  invalidateRuleCache(): void {
    this.lastRuleCacheRefresh = 0;
  }

  private buildTemplateResource(
    type: string,
    key: string,
    name: string,
    id: string | null | undefined
  ): NotificationTemplateResource {
    return { type, id: id ?? null, key, name };
  }

  private buildAlertTemplateContext(
    rule: any,
    notificationType: 'alert.fired' | 'alert.resolved',
    status: 'firing' | 'resolved',
    resource: NotificationTemplateResource,
    timestamp: string,
    details: TemplateDetails
  ) {
    const { resourceId: _resourceId, ...templateDetails } = details;
    const severity = status === 'resolved' ? ('info' as Severity) : (rule.severity as Severity);
    return buildNotificationTemplateContext({
      ...templateDetails,
      notification: {
        type: notificationType,
        title: status === 'resolved' ? `Resolved: ${rule.name}` : rule.name,
        message: '',
        timestamp,
      },
      alert: {
        id: rule.id,
        name: rule.name,
        status,
        severity,
      },
      resource,
    });
  }

  private getEventTemplateDetails(
    context: Record<string, unknown>,
    eventName: string,
    currentState?: string,
    fallbackResourceId?: string
  ): TemplateDetails {
    const nodeId = typeof context.nodeId === 'string' ? context.nodeId : null;
    const explicitNodeName =
      typeof context.node_name === 'string'
        ? context.node_name
        : typeof context.hostname === 'string'
          ? context.hostname
          : null;
    const nodeName = explicitNodeName ?? (nodeId ? this.getNodeName(nodeId) : null);
    const healthStatus =
      typeof context.health_status === 'string'
        ? context.health_status
        : typeof context.healthStatus === 'string'
          ? context.healthStatus
          : null;
    const resourceId =
      typeof context.containerId === 'string'
        ? context.containerId
        : typeof fallbackResourceId === 'string'
          ? fallbackResourceId
          : null;
    const scalarDetails = Object.fromEntries(
      Object.entries(context).filter(
        ([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value)
      )
    ) as Record<string, string | number | boolean | null>;

    return {
      resourceId,
      node: {
        id: nodeId,
        name: nodeName,
      },
      health: {
        status: healthStatus,
      },
      event: {
        name: eventName,
      },
      operation: {
        kind: typeof context.operation_kind === 'string' ? context.operation_kind : null,
        phase: typeof context.operation_phase === 'string' ? context.operation_phase : null,
        trigger: typeof context.operation_trigger === 'string' ? context.operation_trigger : null,
      },
      failure: {
        code: typeof context.failure_code === 'string' ? context.failure_code : null,
      },
      details: scalarDetails,
      state: {
        current: currentState ?? null,
      },
    };
  }

  /** The node's display name, else its hostname, as the rest of Opfield names it (rc.2 DB-O-5). */
  private getNodeName(nodeId: string): string {
    const node = this.nodeRegistry.getNode(nodeId);
    return (node ? node.displayName || node.hostname : undefined) ?? nodeId;
  }

  /**
   * The node's name: from the registry while it is connected, else from the database. A node that went offline is no
   * longer in the registry, and alerts about it (a container alert folded under its down alert) named it by its id
   * (stand rc.9, O-5).
   */
  private async nodeNameOf(nodeId: string): Promise<string> {
    const connected = this.nodeRegistry.getNode(nodeId);
    const live = connected ? connected.displayName || connected.hostname : undefined;
    if (live || !UUID_PATTERN.test(nodeId)) return live ?? nodeId;
    try {
      const [row] = await this.db
        .select({ hostname: nodes.hostname, displayName: nodes.displayName })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .limit(1);
      return row?.displayName || row?.hostname || nodeId;
    } catch {
      return nodeId;
    }
  }

  /** Details whose node is named by its id (it is not connected) get its name from the database. */
  private async withNodeName(details: TemplateDetails): Promise<TemplateDetails> {
    const node = details.node;
    if (!node?.id || (node.name && node.name !== node.id)) return details;
    const name = await this.nodeNameOf(node.id);
    return name === node.name ? details : { ...details, node: { ...node, name } };
  }

  private getThresholdResourceName(rule: any, sourceId: string, rawResourceId?: string): string {
    const nodeName = rule.category === 'node' || rule.category === 'container' ? this.getNodeName(sourceId) : undefined;
    if (rule.category === 'node' && isPerDeviceNodeMetric(rule.metric) && rawResourceId) {
      return `${nodeName || sourceId} · ${rawResourceId}`;
    }
    if (rule.category === 'node') return nodeName || sourceId;
    if (rawResourceId && rawResourceId !== 'system') return rawResourceId;
    return nodeName || rawResourceId || sourceId;
  }

  private async getThresholdResourceId(rule: any, sourceId?: string, rawResourceId?: string): Promise<string | null> {
    if (!sourceId) return null;
    // A container's id is its Opfield identity (the scopeResourceId of the container API and its grants), which
    // survives recreates; the payload names it by node and name as well (`key`, `name`, `node`).
    if (rule.category === 'container') {
      if (!rawResourceId) return null;
      const [identity] = await this.db
        .select({ id: dockerAccessResources.id })
        .from(dockerAccessResources)
        .where(
          and(
            eq(dockerAccessResources.nodeId, sourceId),
            eq(dockerAccessResources.resourceType, 'container'),
            eq(dockerAccessResources.resourceKey, rawResourceId)
          )
        )
        .limit(1);
      return identity?.id ?? null;
    }
    if (
      rule.category === 'node' ||
      rule.category === 'database_postgres' ||
      rule.category === 'database_clickhouse' ||
      rule.category === 'database_redis' ||
      rule.category === 'managed_storage' ||
      rule.category === 'logging' ||
      rule.category === 'hosting_account' ||
      rule.category === 'opfield' ||
      rule.category === 'proxy' ||
      rule.category === 'app' ||
      rule.category === 'backup' ||
      rule.category === 'pki'
    ) {
      return sourceId;
    }
    return null;
  }
}
