/** Notification severity, category, metric, event, and template-variable catalog. */

// ── Severity ──────────────────────────────────────────────────────────

export type Severity = 'info' | 'warning' | 'critical';

export const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

export function severityMeetsMinimum(actual: Severity, minimum: Severity): boolean {
  return SEVERITY_ORDER[actual] >= SEVERITY_ORDER[minimum];
}

export const SEVERITY_EMOJI: Record<Severity, string> = {
  info: '\u2139\uFE0F',
  warning: '\u26A0\uFE0F',
  critical: '\uD83D\uDEA8',
};

export const SEVERITY_COLOR: Record<Severity, number> = {
  info: 3447003,
  warning: 16776960,
  critical: 15158332,
};

// ── Alert Categories ──────────────────────────────────────────────────

export type AlertCategory =
  | 'hosting_vm'
  | 'hosting_account'
  | 'node'
  | 'container'
  | 'build'
  | 'compose'
  | 'proxy'
  | 'pages'
  | 'opfield'
  | 'logging'
  | 'integration'
  | 'certificate'
  | 'security'
  | 'database_postgres'
  | 'database_clickhouse'
  | 'database_redis'
  | 'managed_storage';

export interface MetricDefinition {
  id: string;
  label: string;
  unit: string;
  defaultOperator: string;
  defaultValue: number;
  defaultDurationSeconds?: number;
  defaultResolveAfterSeconds?: number;
}

export interface EventDefinition {
  id: string;
  label: string;
  defaultSeverity: Severity;
  supportsThreshold?: boolean;
  /**
   * A recovery state (back online): its alert is sent once when the state begins and closes quietly when the state
   * ends (going offline is not a recovery that "cleared"), so it has no resolve message.
   */
  recovery?: boolean;
}

export interface CategoryDefinition {
  id: AlertCategory;
  label: string;
  metrics: MetricDefinition[];
  events: EventDefinition[];
  /** Variables available in message templates for this category */
  variables: Array<{ name: string; description: string }>;
}

const GPU_NODE_METRIC_IDS = new Set([
  'gpu_utilization_percent',
  'gpu_memory_used_percent',
  'gpu_temperature_celsius',
  'gpu_power_percent_of_limit',
  'gpu_throttled',
  'gpu_health_degraded',
  'gpu_ecc_corrected_errors',
  'gpu_ecc_uncorrected_errors',
]);

/** Node metrics which maintain one alert state per physical GPU device. */
export function isPerDeviceNodeMetric(metric: string): boolean {
  return GPU_NODE_METRIC_IDS.has(metric);
}

/**
 * Availability of a managed database or managed storage on several servers (one set): failovers and switches, the set
 * state (degraded, no automatic failover, restored) and member, sync and witness events. Events the servers queued
 * while Opfield was down arrive late; `{{details.occurred_at}}` is when they happened.
 */
const AVAILABILITY_EVENTS: EventDefinition[] = [
  { id: 'availability.failover', label: 'Failover Happened', defaultSeverity: 'warning' },
  { id: 'availability.switchover', label: 'Primary Switched', defaultSeverity: 'info' },
  {
    id: 'availability.forced_promotion',
    label: 'Copy Made Primary With Possible Data Loss',
    defaultSeverity: 'critical',
  },
  { id: 'availability.degraded', label: 'Availability Degraded', defaultSeverity: 'warning', supportsThreshold: true },
  {
    id: 'availability.no_failover',
    label: 'No Automatic Failover Possible',
    defaultSeverity: 'critical',
    supportsThreshold: true,
  },
  {
    id: 'availability.restored',
    label: 'Availability Restored',
    defaultSeverity: 'info',
    supportsThreshold: true,
    recovery: true,
  },
  { id: 'availability.member_offline', label: 'Server Not Reporting', defaultSeverity: 'warning' },
  { id: 'availability.sync_degraded', label: 'Copy No Longer Synchronous', defaultSeverity: 'warning' },
  { id: 'availability.sync_far', label: 'Synchronous Servers Now Far Apart', defaultSeverity: 'warning' },
  { id: 'availability.witness_lost', label: 'Witness Lost', defaultSeverity: 'warning' },
  { id: 'availability.witness_moved', label: 'Witness Moved', defaultSeverity: 'info' },
  { id: 'availability.fenced', label: 'Server Stopped Taking Writes', defaultSeverity: 'warning' },
  { id: 'availability.rejoined', label: 'Copy Rejoined', defaultSeverity: 'info' },
  { id: 'availability.rebuilt', label: 'Copy Rebuilt', defaultSeverity: 'info' },
  { id: 'availability.cancelled_sync_wait', label: 'Commit Wait Cancelled By Client', defaultSeverity: 'warning' },
];

/** Replication metrics of a database on several servers (the worst copy; the round trip between the servers). */
const AVAILABILITY_METRICS: MetricDefinition[] = [
  {
    id: 'replication_lag_bytes',
    label: 'Replication Lag (bytes)',
    unit: 'bytes',
    defaultOperator: '>',
    defaultValue: 1_048_576,
  },
  {
    id: 'replication_lag_seconds',
    label: 'Replication Lag (seconds)',
    unit: 's',
    defaultOperator: '>',
    defaultValue: 10,
  },
  { id: 'rtt_ms', label: 'Round Trip Between Servers (ms)', unit: 'ms', defaultOperator: '>', defaultValue: 10 },
];

const AVAILABILITY_VARIABLES = [
  { name: '{{details.reason}}', description: 'Availability: why the state changed' },
  { name: '{{details.member_id}}', description: 'Availability: the server (member) concerned' },
  { name: '{{details.occurred_at}}', description: 'Availability: when it happened (also for events replayed later)' },
];

export const ALERT_CATEGORIES: CategoryDefinition[] = [
  {
    id: 'hosting_vm',
    label: 'Hosting VM',
    metrics: [],
    events: [
      ...['running', 'stopped', 'starting', 'stopping', 'unknown', 'missing'].map((state) => ({
        id: `power.${state}`,
        label: `VM ${state}`,
        defaultSeverity: state === 'running' ? ('info' as const) : ('warning' as const),
        supportsThreshold: true,
      })),
      {
        id: 'operation.failed',
        label: 'VM operation failed (including provisioning and snapshots)',
        defaultSeverity: 'critical',
      },
      { id: 'operation.ready', label: 'VM operation completed', defaultSeverity: 'info' },
      { id: 'operation.unknown', label: 'VM operation outcome needs attention', defaultSeverity: 'warning' },
      {
        id: 'firewall.failed',
        label: 'VM firewall synchronization failed',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
    ],
    variables: [
      { name: 'state.current', description: 'Observed VM power state' },
      { name: 'details.provider', description: 'Hosting provider' },
      { name: 'details.connector_id', description: 'Hosting account ID' },
      { name: 'details.remote_id', description: 'Provider VM ID' },
      { name: 'operation.kind', description: 'Provisioning, power, resize, destroy or snapshot action' },
      { name: 'operation.phase', description: 'Operation phase' },
      { name: 'details.failure_message', description: 'Safe operation error message' },
    ],
  },
  {
    id: 'hosting_account',
    label: 'Hosting account',
    metrics: [
      { id: 'balance', label: 'Account balance', unit: 'currency', defaultOperator: '<', defaultValue: 10 },
      {
        id: 'monthly_expenses',
        label: 'Estimated monthly VM expenses',
        unit: 'currency/month',
        defaultOperator: '>',
        defaultValue: 100,
      },
    ],
    events: [
      {
        id: 'sync.failed',
        label: 'Hosting synchronization failed',
        defaultSeverity: 'warning',
        supportsThreshold: true,
      },
    ],
    variables: [
      { name: 'details.currency', description: 'ISO currency of the observed amount' },
      { name: 'details.provider', description: 'Hosting provider' },
      { name: 'state.current', description: 'Account synchronization state' },
    ],
  },
  {
    id: 'node',
    label: 'Node',
    metrics: [
      { id: 'cpu', label: 'CPU Usage (%)', unit: '%', defaultOperator: '>', defaultValue: 90 },
      { id: 'memory', label: 'Memory Usage (%)', unit: '%', defaultOperator: '>', defaultValue: 90 },
      { id: 'disk', label: 'Disk Usage (%)', unit: '%', defaultOperator: '>', defaultValue: 85 },
      {
        id: 'gpu_utilization_percent',
        label: 'GPU Utilization (%)',
        unit: '%',
        defaultOperator: '>',
        defaultValue: 90,
      },
      {
        id: 'gpu_memory_used_percent',
        label: 'GPU VRAM Usage (%)',
        unit: '%',
        defaultOperator: '>',
        defaultValue: 90,
      },
      {
        id: 'gpu_temperature_celsius',
        label: 'GPU Temperature',
        unit: '°C',
        defaultOperator: '>',
        defaultValue: 85,
      },
      {
        id: 'gpu_power_percent_of_limit',
        label: 'GPU Power (% of Limit)',
        unit: '%',
        defaultOperator: '>',
        defaultValue: 95,
      },
      { id: 'gpu_throttled', label: 'GPU Throttled', unit: 'state', defaultOperator: '>=', defaultValue: 1 },
      {
        id: 'gpu_health_degraded',
        label: 'GPU Health Degraded',
        unit: 'state',
        defaultOperator: '>=',
        defaultValue: 1,
      },
      {
        id: 'gpu_ecc_corrected_errors',
        label: 'GPU Corrected ECC Errors',
        unit: 'errors',
        defaultOperator: '>',
        defaultValue: 0,
      },
      {
        id: 'gpu_ecc_uncorrected_errors',
        label: 'GPU Uncorrected ECC Errors',
        unit: 'errors',
        defaultOperator: '>',
        defaultValue: 0,
      },
    ],
    events: [
      { id: 'offline', label: 'Node Offline', defaultSeverity: 'critical', supportsThreshold: true },
      { id: 'online', label: 'Node Online', defaultSeverity: 'info', supportsThreshold: true, recovery: true },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Node hostname' },
      { name: '{{resource.id}}', description: 'Node ID' },
      { name: '{{resource.key}}', description: 'Internal alert resource key' },
      { name: '{{node.id}}', description: 'Node ID' },
      { name: '{{node.name}}', description: 'Node hostname' },
      { name: '{{metric.name}}', description: 'Metric name (CPU, memory, disk, or GPU metric)' },
      { name: '{{metric.value}}', description: 'Current metric value' },
      { name: '{{metric.threshold}}', description: 'Configured threshold' },
      { name: '{{metric.operator}}', description: 'Comparison operator' },
      { name: '{{metric.duration}}', description: 'Configured fire-after duration' },
      { name: '{{fired.at}}', description: 'When the alert started firing' },
      { name: '{{fired.duration}}', description: 'How long the alert lasted, such as 3m 37s' },
      { name: '{{fired.duration.seconds}}', description: 'How long the alert lasted, in seconds' },
    ],
  },
  {
    id: 'container',
    label: 'Container',
    metrics: [
      { id: 'cpu', label: 'CPU Usage (%)', unit: '%', defaultOperator: '>', defaultValue: 90 },
      { id: 'memory', label: 'Memory Usage (%)', unit: '%', defaultOperator: '>', defaultValue: 90 },
      // Containers with Opfield's default rotation stay under 150 MB, so this
      // catches workloads whose logs are unbounded.
      { id: 'log_size', label: 'Log Size (MB)', unit: 'MB', defaultOperator: '>', defaultValue: 1024 },
    ],
    events: [
      { id: 'stopped', label: 'Container Stopped', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'started', label: 'Container Started', defaultSeverity: 'info' },
      { id: 'exited', label: 'Container Exited', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'health.offline', label: 'Health Offline', defaultSeverity: 'critical', supportsThreshold: true },
      { id: 'health.degraded', label: 'Health Degraded', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'health.online', label: 'Health Online', defaultSeverity: 'info', supportsThreshold: true, recovery: true },
      {
        id: 'dependency.database_offline',
        label: 'Database Secure Link Offline',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      { id: 'deployment.failed', label: 'Deployment Failed', defaultSeverity: 'critical', supportsThreshold: true },
      { id: 'migration.failed', label: 'Migration Failed', defaultSeverity: 'critical' },
      {
        id: 'migration.needs_attention',
        label: 'Migration Needs Attention',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Container name' },
      { name: '{{resource.id}}', description: 'Container ID when known' },
      { name: '{{resource.key}}', description: 'Internal alert resource key' },
      { name: '{{node.id}}', description: 'Docker node ID' },
      { name: '{{node.name}}', description: 'Node hosting this container' },
      { name: '{{metric.name}}', description: 'Metric name (cpu, memory)' },
      { name: '{{metric.value}}', description: 'Current metric value' },
      { name: '{{metric.threshold}}', description: 'Configured threshold' },
      { name: '{{health.status}}', description: 'HTTP health status' },
      { name: '{{fired.at}}', description: 'When the alert started firing' },
      { name: '{{fired.duration}}', description: 'How long the alert lasted, such as 3m 37s' },
      { name: '{{fired.duration.seconds}}', description: 'How long the alert lasted, in seconds' },
    ],
  },
  {
    id: 'build',
    label: 'Docker Build',
    metrics: [],
    events: [
      { id: 'succeeded', label: 'Build Succeeded', defaultSeverity: 'info' },
      { id: 'failed', label: 'Build Failed', defaultSeverity: 'critical' },
      { id: 'cancelled', label: 'Build Cancelled', defaultSeverity: 'warning' },
      { id: 'superseded', label: 'Build Superseded', defaultSeverity: 'info' },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Build target name' },
      { name: '{{resource.id}}', description: 'Build source binding ID' },
      { name: '{{resource.key}}', description: 'Internal alert resource key' },
      { name: '{{operation.phase}}', description: 'Build status' },
      { name: '{{failure.code}}', description: 'Build failure code' },
    ],
  },
  {
    id: 'compose',
    label: 'Compose Project',
    metrics: [],
    events: [
      { id: 'operation.succeeded', label: 'Operation Succeeded', defaultSeverity: 'info' },
      { id: 'operation.failed', label: 'Operation Failed', defaultSeverity: 'critical' },
      { id: 'operation.cancelled', label: 'Operation Cancelled', defaultSeverity: 'warning' },
      { id: 'revision.activated', label: 'Revision Activated', defaultSeverity: 'info' },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Compose project name' },
      { name: '{{resource.id}}', description: 'Compose project ID' },
      { name: '{{resource.key}}', description: 'Internal alert resource key' },
      { name: '{{operation.kind}}', description: 'Compose operation kind' },
      { name: '{{operation.phase}}', description: 'Compose operation phase' },
      { name: '{{failure.code}}', description: 'Compose failure message or code' },
    ],
  },
  {
    id: 'proxy',
    label: 'Proxy Host',
    metrics: [],
    events: [
      { id: 'health.offline', label: 'Health Offline', defaultSeverity: 'critical', supportsThreshold: true },
      { id: 'health.degraded', label: 'Health Degraded', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'health.online', label: 'Health Online', defaultSeverity: 'info', supportsThreshold: true, recovery: true },
      { id: 'maintenance.active', label: 'Maintenance Active', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'created', label: 'Proxy Created', defaultSeverity: 'info' },
      { id: 'deleted', label: 'Proxy Deleted', defaultSeverity: 'info' },
      { id: 'secure_link.provisioning_failed', label: 'Secure Link Provisioning Failed', defaultSeverity: 'critical' },
      {
        id: 'secure_link.reconciliation_failed',
        label: 'Secure Link Reconciliation Failed',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Domain name(s)' },
      { name: '{{resource.id}}', description: 'Proxy host ID' },
      { name: '{{resource.key}}', description: 'Internal alert resource key' },
      { name: '{{health.status}}', description: 'Health status' },
      { name: '{{event.name}}', description: 'Event pattern/name' },
      { name: '{{state.current}}', description: 'Current state for stateful events' },
    ],
  },
  {
    id: 'pages',
    label: 'Pages',
    metrics: [],
    events: [
      { id: 'deployment.ready', label: 'Deployment Ready', defaultSeverity: 'info' },
      { id: 'deployment.failed', label: 'Deployment Failed', defaultSeverity: 'critical' },
      { id: 'publication.failed', label: 'Tag Publication Failed', defaultSeverity: 'critical' },
      { id: 'config.publication_failed', label: 'Runtime Config Publication Failed', defaultSeverity: 'critical' },
      { id: 'quota.blocked', label: 'Project Quota Blocked', defaultSeverity: 'warning', supportsThreshold: true },
      {
        id: 'profile.unavailable',
        label: 'Wildcard Profile Unavailable',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      {
        id: 'capability.missing',
        label: 'Pages Daemon Capability Missing',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      { id: 'migration.failed', label: 'Ingress Migration Failed', defaultSeverity: 'critical' },
      {
        id: 'migration.needs_attention',
        label: 'Ingress Migration Needs Attention',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      {
        id: 'cleanup.needs_attention',
        label: 'Cleanup Needs Attention',
        defaultSeverity: 'warning',
        supportsThreshold: true,
      },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Page Project name' },
      { name: '{{resource.id}}', description: 'Page Project ID' },
      { name: '{{resource.key}}', description: 'Internal alert resource key' },
      { name: '{{event.name}}', description: 'Pages event name' },
      { name: '{{state.current}}', description: 'Current Pages condition' },
      { name: '{{operation.kind}}', description: 'Deployment, publication, cleanup, or migration operation' },
      { name: '{{operation.phase}}', description: 'Current operation phase' },
      { name: '{{failure.code}}', description: 'Stable public failure code' },
      { name: '{{details.public_slug}}', description: 'Immutable Deployment public hash' },
      { name: '{{details.tag}}', description: 'Tag name' },
      { name: '{{details.quota_used_bytes}}', description: 'Current canonical storage usage' },
      { name: '{{details.quota_limit_bytes}}', description: 'Project canonical storage quota' },
    ],
  },
  {
    id: 'opfield',
    label: 'Opfield',
    // Opfield's own host, process and dependencies, sampled once a minute by Opfield diagnostics.
    metrics: [
      {
        id: 'host_cpu',
        label: 'Host CPU Usage (%)',
        unit: '%',
        defaultOperator: '>',
        defaultValue: 90,
        defaultDurationSeconds: 300,
      },
      {
        id: 'host_memory',
        label: 'Host Memory Usage (%)',
        unit: '%',
        defaultOperator: '>',
        defaultValue: 90,
        defaultDurationSeconds: 300,
      },
      { id: 'host_disk', label: 'Data Disk Usage (%)', unit: '%', defaultOperator: '>', defaultValue: 85 },
      {
        id: 'process_memory',
        label: 'Backend Memory (MB)',
        unit: 'MB',
        defaultOperator: '>',
        defaultValue: 2048,
        defaultDurationSeconds: 300,
      },
      {
        id: 'event_loop_delay',
        label: 'Event Loop Delay p99 (ms)',
        unit: 'ms',
        defaultOperator: '>',
        defaultValue: 200,
        defaultDurationSeconds: 300,
      },
      {
        id: 'api_error_rate',
        label: 'API 5xx Rate (%)',
        unit: '%',
        defaultOperator: '>',
        defaultValue: 5,
        defaultDurationSeconds: 300,
      },
      {
        id: 'api_latency_p95',
        label: 'API Latency p95 (ms)',
        unit: 'ms',
        defaultOperator: '>',
        defaultValue: 2000,
        defaultDurationSeconds: 300,
      },
      {
        id: 'postgres_latency',
        label: 'Postgres Latency (ms)',
        unit: 'ms',
        defaultOperator: '>',
        defaultValue: 500,
        defaultDurationSeconds: 300,
      },
      {
        id: 'postgres_pool_waiting',
        label: 'Queries Waiting for a Postgres Connection',
        unit: 'queries',
        defaultOperator: '>',
        defaultValue: 0,
        defaultDurationSeconds: 300,
      },
      {
        id: 'redis_latency',
        label: 'Redis Latency (ms)',
        unit: 'ms',
        defaultOperator: '>',
        defaultValue: 200,
        defaultDurationSeconds: 300,
      },
    ],
    events: [
      {
        id: 'postgres.unavailable',
        label: 'Postgres Unavailable',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      { id: 'redis.unavailable', label: 'Redis Unavailable', defaultSeverity: 'critical', supportsThreshold: true },
      {
        id: 'container.unhealthy',
        label: 'Opfield Container Down or Unhealthy',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      { id: 'job.failing', label: 'Background Job Failing', defaultSeverity: 'warning', supportsThreshold: true },
      {
        id: 'outbound.unavailable',
        label: 'Opfield Lost Outbound Connectivity',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      { id: 'relay.recovering', label: 'Relay Recovering', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'relay.unavailable', label: 'Relay Unavailable', defaultSeverity: 'critical', supportsThreshold: true },
      {
        id: 'relay.revocation_stale',
        label: 'Relay Missed Route Revocation',
        defaultSeverity: 'warning',
        supportsThreshold: true,
      },
      {
        id: 'relay.unreachable',
        label: 'Relay Unreachable by Nodes',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      {
        id: 'license.expired_grace',
        label: 'License Expired (Grace Period)',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      {
        id: 'license.unavailable',
        label: 'Paid License Unavailable',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      {
        id: 'license.validation_warning',
        label: 'License Validation Warning',
        defaultSeverity: 'warning',
        supportsThreshold: true,
      },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Opfield component name' },
      { name: '{{state.current}}', description: 'Current relay state' },
      { name: '{{failure.code}}', description: 'Stable failure code' },
      { name: '{{details.attempt}}', description: 'Recovery attempt' },
      { name: '{{details.plan}}', description: 'Effective license plan' },
      { name: '{{details.expires_at}}', description: 'License expiration time' },
      { name: '{{details.grace_until}}', description: 'License grace deadline' },
      { name: '{{metric.value}}', description: 'Measured value of an Opfield metric' },
      { name: '{{details.error}}', description: 'Why Postgres, Redis or a background job failed' },
      { name: '{{details.service}}', description: 'Opfield container service (container.unhealthy)' },
      { name: '{{details.state}}', description: 'Container state or health (container.unhealthy)' },
      { name: '{{details.job}}', description: 'Background job name (job.failing)' },
      { name: '{{details.failures_in_a_row}}', description: 'Failed runs in a row (job.failing)' },
      { name: '{{details.targets}}', description: 'Hosts Opfield could not reach (outbound.unavailable)' },
    ],
  },
  {
    id: 'logging',
    label: 'Logging',
    metrics: [
      {
        id: 'error_fatal_ratio_percent',
        label: 'Error + Fatal Ratio (%)',
        unit: '%',
        defaultOperator: '>',
        defaultValue: 10,
      },
      {
        id: 'fatal_ratio_percent',
        label: 'Fatal Ratio (%)',
        unit: '%',
        defaultOperator: '>',
        defaultValue: 1,
      },
    ],
    events: [
      { id: 'storage.pressure', label: 'Storage Pressure', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'storage.degraded', label: 'Storage Degraded', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'storage.exhausted', label: 'Storage Exhausted', defaultSeverity: 'critical', supportsThreshold: true },
      { id: 'storage.unavailable', label: 'Storage Unavailable', defaultSeverity: 'critical', supportsThreshold: true },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Logging environment or storage' },
      { name: '{{metric.name}}', description: 'Logging metric name' },
      { name: '{{metric.value}}', description: 'Current ratio' },
      { name: '{{metric.threshold}}', description: 'Configured threshold' },
      { name: '{{state.current}}', description: 'Current storage state' },
    ],
  },
  {
    id: 'integration',
    label: 'Integration',
    metrics: [],
    events: [
      { id: 'sync.failed', label: 'Connector Sync Failed', defaultSeverity: 'warning', supportsThreshold: true },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Integration connector' },
      { name: '{{state.current}}', description: 'Current connector state' },
      { name: '{{failure.code}}', description: 'Stable failure code' },
      { name: '{{details.provider}}', description: 'Connector provider' },
      { name: '{{details.failure_count}}', description: 'Consecutive failures' },
    ],
  },
  {
    id: 'certificate',
    label: 'Certificate',
    metrics: [
      {
        id: 'days_until_expiry',
        label: 'Days Until Expiry',
        unit: 'days',
        defaultOperator: '<=',
        defaultValue: 14,
        defaultDurationSeconds: 0,
        defaultResolveAfterSeconds: 0,
      },
    ],
    events: [
      { id: 'issued', label: 'Certificate Issued', defaultSeverity: 'info' },
      { id: 'renewed', label: 'Certificate Renewed', defaultSeverity: 'info' },
      { id: 'renewal_failed', label: 'Certificate Renewal Failed', defaultSeverity: 'critical' },
      { id: 'expired', label: 'Certificate Expired', defaultSeverity: 'critical' },
      {
        // Managed storage / managed database TLS certificates renewed by Opfield itself.
        id: 'internal.renewal_failed',
        label: 'Managed Service Certificate Renewal Failed',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Certificate domain(s)' },
      { name: '{{resource.id}}', description: 'Certificate ID' },
      { name: '{{resource.key}}', description: 'Internal alert resource key' },
      { name: '{{certificate.days_until_expiry}}', description: 'Days until expiry' },
      { name: '{{certificate.expiry_date}}', description: 'Expiry date' },
      { name: '{{metric.threshold}}', description: 'Configured threshold' },
      { name: '{{fired.at}}', description: 'When the alert started firing' },
      { name: '{{fired.duration}}', description: 'How long the alert lasted, such as 3m 37s' },
      { name: '{{fired.duration.seconds}}', description: 'How long the alert lasted, in seconds' },
    ],
  },
  {
    id: 'security',
    label: 'Security',
    metrics: [],
    events: [{ id: 'mfa.required', label: 'Group MFA Required', defaultSeverity: 'warning' }],
    variables: [
      { name: '{{resource.name}}', description: 'Permission group name' },
      { name: '{{resource.id}}', description: 'Permission group ID' },
      { name: '{{resource.key}}', description: 'Internal alert resource key' },
      { name: '{{event.name}}', description: 'Event pattern/name' },
    ],
  },
  {
    id: 'database_postgres',
    label: 'Database - Postgres',
    metrics: [
      { id: 'latency_ms', label: 'Latency (ms)', unit: 'ms', defaultOperator: '>', defaultValue: 1000 },
      {
        id: 'active_connections_pct',
        label: 'Active Connections (%)',
        unit: '%',
        defaultOperator: '>',
        defaultValue: 90,
      },
      {
        id: 'database_size_mb',
        label: 'Database Size (MB)',
        unit: 'MB',
        defaultOperator: '>',
        defaultValue: 1024,
      },
      ...AVAILABILITY_METRICS,
    ],
    events: [
      { id: 'created', label: 'Managed Database Created', defaultSeverity: 'info' },
      { id: 'ready', label: 'Managed Database Ready', defaultSeverity: 'info' },
      { id: 'stopped', label: 'Managed Database Stopped', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'error', label: 'Managed Database Error', defaultSeverity: 'critical', supportsThreshold: true },
      { id: 'deleted', label: 'Managed Database Deleted', defaultSeverity: 'info' },
      { id: 'health.offline', label: 'Database Offline', defaultSeverity: 'critical', supportsThreshold: true },
      { id: 'health.degraded', label: 'Database Degraded', defaultSeverity: 'warning', supportsThreshold: true },
      {
        id: 'health.online',
        label: 'Database Online',
        defaultSeverity: 'info',
        supportsThreshold: true,
        recovery: true,
      },
      {
        id: 'binding.provisioning_failed',
        label: 'Database Binding Provisioning Failed',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      {
        id: 'binding.reconciliation_failed',
        label: 'Database Binding Reconciliation Failed',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      ...AVAILABILITY_EVENTS,
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Database connection name' },
      { name: '{{resource.id}}', description: 'Database connection ID' },
      { name: '{{resource.key}}', description: 'Internal alert resource key' },
      { name: '{{metric.name}}', description: 'Metric name' },
      { name: '{{metric.value}}', description: 'Current metric value' },
      { name: '{{metric.threshold}}', description: 'Configured threshold' },
      { name: '{{metric.operator}}', description: 'Comparison operator' },
      { name: '{{health.status}}', description: 'Health status' },
      ...AVAILABILITY_VARIABLES,
    ],
  },
  {
    id: 'database_clickhouse',
    label: 'Database - ClickHouse',
    metrics: [
      { id: 'latency_ms', label: 'Latency (ms)', unit: 'ms', defaultOperator: '>', defaultValue: 1000 },
      {
        id: 'database_size_mb',
        label: 'Database Size (MB)',
        unit: 'MB',
        defaultOperator: '>',
        defaultValue: 1024,
      },
      { id: 'disk_used_pct', label: 'Disk Usage (%)', unit: '%', defaultOperator: '>', defaultValue: 90 },
      {
        id: 'disk_available_mb',
        label: 'Disk Available (MB)',
        unit: 'MB',
        defaultOperator: '<',
        defaultValue: 10_240,
      },
      { id: 'pending_mutations', label: 'Pending Mutations', unit: '', defaultOperator: '>', defaultValue: 5 },
      ...AVAILABILITY_METRICS,
    ],
    events: [
      { id: 'created', label: 'Managed Database Created', defaultSeverity: 'info' },
      { id: 'ready', label: 'Managed Database Ready', defaultSeverity: 'info' },
      { id: 'stopped', label: 'Managed Database Stopped', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'error', label: 'Managed Database Error', defaultSeverity: 'critical', supportsThreshold: true },
      { id: 'deleted', label: 'Managed Database Deleted', defaultSeverity: 'info' },
      { id: 'health.offline', label: 'Database Offline', defaultSeverity: 'critical', supportsThreshold: true },
      { id: 'health.degraded', label: 'Database Degraded', defaultSeverity: 'warning', supportsThreshold: true },
      {
        id: 'health.online',
        label: 'Database Online',
        defaultSeverity: 'info',
        supportsThreshold: true,
        recovery: true,
      },
      {
        id: 'binding.provisioning_failed',
        label: 'Database Binding Provisioning Failed',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      {
        id: 'binding.reconciliation_failed',
        label: 'Database Binding Reconciliation Failed',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      ...AVAILABILITY_EVENTS,
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Database connection name' },
      { name: '{{resource.id}}', description: 'Database connection ID' },
      { name: '{{resource.key}}', description: 'Internal alert resource key' },
      { name: '{{metric.name}}', description: 'Metric name' },
      { name: '{{metric.value}}', description: 'Current metric value' },
      { name: '{{metric.threshold}}', description: 'Configured threshold' },
      { name: '{{metric.operator}}', description: 'Comparison operator' },
      { name: '{{health.status}}', description: 'Health status' },
      ...AVAILABILITY_VARIABLES,
    ],
  },
  {
    id: 'database_redis',
    label: 'Database - Key-value',
    metrics: [
      { id: 'latency_ms', label: 'Latency (ms)', unit: 'ms', defaultOperator: '>', defaultValue: 1000 },
      { id: 'memory_pct', label: 'Memory Usage (%)', unit: '%', defaultOperator: '>', defaultValue: 90 },
      ...AVAILABILITY_METRICS,
    ],
    events: [
      { id: 'created', label: 'Managed Database Created', defaultSeverity: 'info' },
      { id: 'ready', label: 'Managed Database Ready', defaultSeverity: 'info' },
      { id: 'stopped', label: 'Managed Database Stopped', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'error', label: 'Managed Database Error', defaultSeverity: 'critical', supportsThreshold: true },
      { id: 'deleted', label: 'Managed Database Deleted', defaultSeverity: 'info' },
      { id: 'health.offline', label: 'Database Offline', defaultSeverity: 'critical', supportsThreshold: true },
      { id: 'health.degraded', label: 'Database Degraded', defaultSeverity: 'warning', supportsThreshold: true },
      {
        id: 'health.online',
        label: 'Database Online',
        defaultSeverity: 'info',
        supportsThreshold: true,
        recovery: true,
      },
      {
        id: 'binding.provisioning_failed',
        label: 'Database Binding Provisioning Failed',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      {
        id: 'binding.reconciliation_failed',
        label: 'Database Binding Reconciliation Failed',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      ...AVAILABILITY_EVENTS,
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Database connection name' },
      { name: '{{resource.id}}', description: 'Database connection ID' },
      { name: '{{resource.key}}', description: 'Internal alert resource key' },
      { name: '{{metric.name}}', description: 'Metric name' },
      { name: '{{metric.value}}', description: 'Current metric value' },
      { name: '{{metric.threshold}}', description: 'Configured threshold' },
      { name: '{{metric.operator}}', description: 'Comparison operator' },
      { name: '{{health.status}}', description: 'Health status' },
      ...AVAILABILITY_VARIABLES,
    ],
  },
  {
    id: 'managed_storage',
    label: 'Managed Storage',
    metrics: [
      // The storage disk as its node reports it (managed storage monitoring).
      { id: 'disk_used_pct', label: 'Disk Usage (%)', unit: '%', defaultOperator: '>', defaultValue: 85 },
    ],
    events: [
      // A serving storage that refuses uploads (its disk is full, or it can create no volume) until it has room again.
      { id: 'storage.full', label: 'Storage Full', defaultSeverity: 'critical', supportsThreshold: true },
      {
        id: 'storage.writable',
        label: 'Storage Takes Uploads Again',
        defaultSeverity: 'info',
        supportsThreshold: true,
        recovery: true,
      },
      ...AVAILABILITY_EVENTS,
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Storage name' },
      { name: '{{resource.id}}', description: 'Storage connection ID' },
      { name: '{{resource.key}}', description: 'Internal alert resource key' },
      { name: '{{metric.name}}', description: 'Metric name' },
      { name: '{{metric.value}}', description: 'Current metric value' },
      { name: '{{metric.threshold}}', description: 'Configured threshold' },
      { name: '{{metric.operator}}', description: 'Comparison operator' },
      ...AVAILABILITY_VARIABLES,
    ],
  },
];

/** Every category id, for schemas and tool definitions that must accept exactly the catalog. */
export const ALERT_CATEGORY_IDS = ALERT_CATEGORIES.map((category) => category.id) as [
  AlertCategory,
  ...AlertCategory[],
];

export const CATEGORY_MAP = new Map(ALERT_CATEGORIES.map((c) => [c.id, c]));

export function eventSupportsThreshold(category: AlertCategory, eventId: string): boolean {
  return CATEGORY_MAP.get(category)?.events.some((event) => event.id === eventId && event.supportsThreshold) ?? false;
}

/** Whether a rule's event is a recovery state (see EventDefinition.recovery). */
export function isRecoveryEvent(category: string | null | undefined, eventPattern: string | null | undefined): boolean {
  if (!category || !eventPattern) return false;
  return !!ALERT_CATEGORIES.find((item) => item.id === category)?.events.find((event) => event.id === eventPattern)
    ?.recovery;
}
