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
  | 'managed_storage'
  | 'app'
  | 'backup'
  | 'domain'
  | 'pki'
  | 'inference'
  | 'relay_pool'
  | 'docker_availability';

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
  /** What the rule's scope picks, plural and lower case ("routes", "app environments"). */
  resourceLabel: string;
  /** False when the category has no resources to pick (the rule always covers everything). */
  scopable?: boolean;
  /**
   * The view scopes a rule author needs to cover every resource of the category (all of them). A rule scoped to
   * picked resources needs view of each instead (see notification-rule-access.ts).
   */
  viewScopes: string[];
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

/**
 * Request metrics of a route over the last minute of its access log (summed over the nodes serving it). A share is
 * measured once the minute has at least ROUTE_SHARE_MIN_REQUESTS requests; with fewer it counts as 0 %, so one failed
 * request on an idle route does not alert and an alert resolves once traffic stops.
 */
export const ROUTE_TRAFFIC_METRICS: MetricDefinition[] = [
  {
    id: 'error_5xx_percent',
    label: '5xx Responses (%)',
    unit: '%',
    defaultOperator: '>=',
    defaultValue: 10,
    defaultDurationSeconds: 60,
  },
  {
    id: 'error_4xx_percent',
    label: '4xx Responses (%)',
    unit: '%',
    defaultOperator: '>=',
    defaultValue: 50,
    defaultDurationSeconds: 300,
  },
  {
    id: 'requests_per_second',
    label: 'Requests per Second',
    unit: 'req/s',
    defaultOperator: '>',
    defaultValue: 100,
    defaultDurationSeconds: 300,
  },
  {
    id: 'latency_p95_ms',
    label: 'Response Time p95 (ms)',
    unit: 'ms',
    defaultOperator: '>',
    defaultValue: 1000,
    defaultDurationSeconds: 300,
  },
];

/** Requests a minute needs before its 4xx/5xx share counts; see ROUTE_TRAFFIC_METRICS. */
export const ROUTE_SHARE_MIN_REQUESTS = 10;

/**
 * metricTarget of a node disk rule that watches every data disk of the node: each mount except Opfield's own disk
 * images of managed databases, storage and volumes (sized on purpose, with their own metrics). Each disk fires and
 * resolves on its own. The built-in rules "Node disk almost full" and "Node disk full" use it.
 */
export const NODE_DATA_DISKS_TARGET = '@data';

/** The data disk of a managed Postgres or key-value store (its disk image, as its node reports it). */
const MANAGED_DATABASE_DISK_METRIC: MetricDefinition = {
  id: 'managed_disk_pct',
  label: 'Data Disk Usage (%)',
  unit: '%',
  defaultOperator: '>',
  defaultValue: 85,
};

/** Container metrics of a managed database (CPU and memory of its container, as its node reports them). */
const MANAGED_DATABASE_METRICS: MetricDefinition[] = [
  {
    id: 'managed_cpu_percent',
    label: 'Container CPU Usage (%)',
    unit: '%',
    defaultOperator: '>',
    defaultValue: 90,
    defaultDurationSeconds: 300,
  },
  {
    id: 'managed_memory_pct',
    label: 'Container Memory (% of Limit)',
    unit: '%',
    defaultOperator: '>',
    defaultValue: 90,
    defaultDurationSeconds: 300,
  },
];

export const ALERT_CATEGORIES: CategoryDefinition[] = [
  {
    id: 'hosting_vm',
    label: 'Hosting VM',
    resourceLabel: 'hosting VMs',
    viewScopes: ['hosting:resources:view'],
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
    resourceLabel: 'hosting accounts',
    viewScopes: ['integrations:hosting:view'],
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
    resourceLabel: 'nodes',
    viewScopes: ['nodes:details'],
    metrics: [
      { id: 'cpu', label: 'CPU Usage (%)', unit: '%', defaultOperator: '>', defaultValue: 90 },
      { id: 'memory', label: 'Memory Usage (%)', unit: '%', defaultOperator: '>', defaultValue: 90 },
      { id: 'disk', label: 'Disk Usage (%)', unit: '%', defaultOperator: '>', defaultValue: 85 },
      // The disk for managed databases and storage: what its instances use, what their images may still take, and
      // the reserve, as a share of its size. Over 100 the disk is oversubscribed: the instances fill it before they
      // reach their sizes, and new instances and disk grows there are refused.
      {
        id: 'managed_disk_promised_pct',
        label: 'Managed Instances Disk Promised (%)',
        unit: '%',
        defaultOperator: '>',
        defaultValue: 100,
      },
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
      { name: '{{details.mount}}', description: 'Mount point of the disk (disk rules), such as / or /var/lib/docker' },
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
    resourceLabel: 'containers',
    viewScopes: ['docker:containers:view'],
    metrics: [
      { id: 'cpu', label: 'CPU Usage (%)', unit: '%', defaultOperator: '>', defaultValue: 90 },
      { id: 'memory', label: 'Memory Usage (%)', unit: '%', defaultOperator: '>', defaultValue: 90 },
      // Containers with Opfield's default rotation stay under 150 MB, so this
      // catches workloads whose logs are unbounded.
      { id: 'log_size', label: 'Log Size (MB)', unit: 'MB', defaultOperator: '>', defaultValue: 1024 },
      // Docker restarts (restart policy, crashes) in the last hour, from the container's inspect.
      {
        id: 'restarts_per_hour',
        label: 'Restarts in the Last Hour',
        unit: 'restarts',
        defaultOperator: '>=',
        defaultValue: 3,
      },
    ],
    events: [
      { id: 'stopped', label: 'Container Stopped', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'started', label: 'Container Started', defaultSeverity: 'info' },
      // A managed container removed, created under its name or renamed by something other than Opfield.
      { id: 'changed_outside', label: 'Changed Outside Opfield', defaultSeverity: 'warning' },
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
      { name: '{{details.change}}', description: 'removed, created or renamed (changed_outside)' },
      { name: '{{metric.name}}', description: 'Metric name (cpu, memory, log_size, restarts_per_hour)' },
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
    resourceLabel: 'build sources',
    viewScopes: ['docker:containers:view'],
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
    resourceLabel: 'Compose projects',
    viewScopes: ['docker:compose:view'],
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
    label: 'Route',
    resourceLabel: 'routes',
    viewScopes: ['proxy:view'],
    metrics: ROUTE_TRAFFIC_METRICS,
    events: [
      { id: 'health.offline', label: 'Health Offline', defaultSeverity: 'critical', supportsThreshold: true },
      { id: 'health.degraded', label: 'Health Degraded', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'health.online', label: 'Health Online', defaultSeverity: 'info', supportsThreshold: true, recovery: true },
      { id: 'maintenance.active', label: 'Maintenance Active', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'created', label: 'Route Created', defaultSeverity: 'info' },
      { id: 'deleted', label: 'Route Deleted', defaultSeverity: 'info' },
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
      { name: '{{resource.id}}', description: 'Route ID' },
      { name: '{{resource.key}}', description: 'Internal alert resource key' },
      { name: '{{metric.name}}', description: 'Request metric (5xx or 4xx share, requests per second, p95)' },
      { name: '{{metric.value}}', description: 'Current metric value' },
      { name: '{{metric.threshold}}', description: 'Configured threshold' },
      { name: '{{metric.operator}}', description: 'Comparison operator' },
      { name: '{{details.requests}}', description: 'Requests in the last minute (request metrics)' },
      { name: '{{details.errors_5xx}}', description: '5xx responses in the last minute (request metrics)' },
      { name: '{{fired.duration}}', description: 'How long the alert lasted, such as 3m 37s' },
      { name: '{{health.status}}', description: 'Health status' },
      { name: '{{event.name}}', description: 'Event pattern/name' },
      { name: '{{state.current}}', description: 'Current state for stateful events' },
    ],
  },
  {
    id: 'pages',
    label: 'Pages',
    resourceLabel: 'Pages projects',
    viewScopes: ['pages:view'],
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
    resourceLabel: 'Opfield components',
    viewScopes: ['settings:opfield:view'],
    scopable: false,
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
        id: 'housekeeping.stale',
        label: 'Housekeeping Not Running',
        defaultSeverity: 'warning',
        supportsThreshold: true,
      },
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
      { name: '{{details.last_success_at}}', description: 'Last successful housekeeping run (housekeeping.stale)' },
      { name: '{{details.targets}}', description: 'Hosts Opfield could not reach (outbound.unavailable)' },
    ],
  },
  {
    id: 'logging',
    label: 'Logging',
    resourceLabel: 'logging environments',
    viewScopes: ['logs:environments:view'],
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
    resourceLabel: 'connectors',
    viewScopes: ['integrations:gitlab:view', 'integrations:cloudflare:view'],
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
    resourceLabel: 'certificates',
    viewScopes: ['ssl:cert:view'],
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
    resourceLabel: 'permission groups',
    viewScopes: ['admin:groups'],
    scopable: false,
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
    resourceLabel: 'Postgres databases',
    viewScopes: ['databases:view'],
    metrics: [
      { id: 'latency_ms', label: 'Latency (ms)', unit: 'ms', defaultOperator: '>', defaultValue: 1000 },
      {
        id: 'active_connections_pct',
        label: 'Active Connections (% of Max)',
        unit: '%',
        defaultOperator: '>',
        defaultValue: 90,
      },
      {
        id: 'total_connections_pct',
        label: 'Open Connections (% of Max)',
        unit: '%',
        defaultOperator: '>',
        defaultValue: 90,
      },
      {
        id: 'long_running_queries',
        label: 'Long-Running Queries',
        unit: 'queries',
        defaultOperator: '>',
        defaultValue: 0,
        defaultDurationSeconds: 300,
      },
      {
        id: 'database_size_mb',
        label: 'Database Size (MB)',
        unit: 'MB',
        defaultOperator: '>',
        defaultValue: 1024,
      },
      MANAGED_DATABASE_DISK_METRIC,
      ...MANAGED_DATABASE_METRICS,
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
    resourceLabel: 'ClickHouse databases',
    viewScopes: ['databases:view'],
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
      ...MANAGED_DATABASE_METRICS,
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
    resourceLabel: 'key-value stores',
    viewScopes: ['databases:view'],
    metrics: [
      { id: 'latency_ms', label: 'Latency (ms)', unit: 'ms', defaultOperator: '>', defaultValue: 1000 },
      { id: 'memory_pct', label: 'Memory Usage (% of maxmemory)', unit: '%', defaultOperator: '>', defaultValue: 90 },
      MANAGED_DATABASE_DISK_METRIC,
      ...MANAGED_DATABASE_METRICS,
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
    resourceLabel: 'storages',
    viewScopes: ['storage:view'],
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
  {
    // One alert per app environment, keyed `<app id>:<environment id>`: a rule scoped to an app covers all its
    // environments. Health is the one the Apps list shows; request metrics are summed over the environment's routes.
    id: 'app',
    label: 'App',
    resourceLabel: 'apps or environments',
    viewScopes: ['apps:view'],
    metrics: [
      {
        ...ROUTE_TRAFFIC_METRICS[0]!,
        label: '5xx Responses Over Its Routes (%)',
      },
      { ...ROUTE_TRAFFIC_METRICS[2]!, label: 'Requests per Second Over Its Routes' },
    ],
    events: [
      { id: 'health.failing', label: 'Environment Failing', defaultSeverity: 'critical', supportsThreshold: true },
      {
        id: 'health.degraded',
        label: 'Environment Degraded or Failing',
        defaultSeverity: 'warning',
        supportsThreshold: true,
      },
      {
        id: 'health.healthy',
        label: 'Environment Healthy Again',
        defaultSeverity: 'info',
        supportsThreshold: true,
        recovery: true,
      },
      { id: 'kill_switch.on', label: 'Kill Switch On', defaultSeverity: 'critical', supportsThreshold: true },
      { id: 'shutdown.active', label: 'Environment Shut Down', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'maintenance.active', label: 'Maintenance On', defaultSeverity: 'info', supportsThreshold: true },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'App and environment, such as "Shop · production"' },
      { name: '{{resource.id}}', description: 'Environment ID' },
      { name: '{{resource.key}}', description: 'Internal alert resource key (app ID:environment ID)' },
      { name: '{{state.current}}', description: 'Current state, such as health.degraded' },
      { name: '{{details.app}}', description: 'App name' },
      { name: '{{details.environment}}', description: 'Environment name' },
      { name: '{{details.failing}}', description: 'Failing resources of the environment (health events)' },
      { name: '{{details.degraded}}', description: 'Degraded resources of the environment (health events)' },
      { name: '{{details.requests}}', description: 'Requests in the last minute over its routes (request metrics)' },
      { name: '{{details.errors_5xx}}', description: '5xx responses in the last minute (request metrics)' },
      { name: '{{metric.value}}', description: 'Current metric value' },
      { name: '{{metric.threshold}}', description: 'Configured threshold' },
      { name: '{{fired.duration}}', description: 'How long the alert lasted, such as 3m 37s' },
    ],
  },
  {
    // Scheduled database backups (backup policies), checked every minute. Keyed `<database id>:<policy id>`: a rule
    // scoped to a database covers each of its policies.
    id: 'backup',
    label: 'Backup',
    resourceLabel: 'databases',
    viewScopes: ['databases:backups:view'],
    metrics: [
      {
        id: 'hours_since_last_backup',
        label: 'Hours Since Last Successful Backup',
        unit: 'h',
        defaultOperator: '>',
        defaultValue: 26,
      },
    ],
    events: [
      { id: 'backup.failed', label: 'Last Backup Failed', defaultSeverity: 'critical', supportsThreshold: true },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Database name and backup destination' },
      { name: '{{resource.id}}', description: 'Database connection ID' },
      { name: '{{details.policy_id}}', description: 'Backup policy ID' },
      { name: '{{details.last_success_at}}', description: 'When the last backup succeeded' },
      { name: '{{details.last_error}}', description: 'Why the last backup failed (backup.failed)' },
      { name: '{{metric.value}}', description: 'Hours since the last successful backup' },
      { name: '{{metric.threshold}}', description: 'Configured threshold' },
    ],
  },
  {
    // DNS of domains, as the domain DNS check last saw it.
    id: 'domain',
    label: 'Domain',
    resourceLabel: 'domains',
    viewScopes: ['domains:view'],
    metrics: [],
    events: [
      {
        id: 'dns.not_pointing',
        label: 'DNS Not Pointing to Opfield',
        defaultSeverity: 'warning',
        supportsThreshold: true,
      },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Domain' },
      { name: '{{resource.id}}', description: 'Domain ID' },
      { name: '{{details.dns_status}}', description: 'DNS check result' },
    ],
  },
  {
    // Internal PKI, checked every minute: active CAs (keyed by CA id) and active certificates they issued (keyed
    // `<CA id>:<certificate id>`, so a rule scoped to a CA covers it and what it issued). Certificates Opfield renews
    // itself (managed storage and database TLS) alert through "Managed Service Certificate Renewal Failed" instead.
    id: 'pki',
    label: 'Internal PKI',
    resourceLabel: 'CAs or certificates',
    viewScopes: ['pki:ca:view', 'pki:cert:view'],
    metrics: [
      {
        id: 'days_until_expiry',
        label: 'Days Until Expiry',
        unit: 'days',
        defaultOperator: '<=',
        defaultValue: 30,
        defaultDurationSeconds: 0,
        defaultResolveAfterSeconds: 0,
      },
    ],
    events: [],
    variables: [
      { name: '{{resource.name}}', description: 'CA or certificate common name' },
      { name: '{{resource.id}}', description: 'CA or certificate ID' },
      { name: '{{details.kind}}', description: 'ca or certificate' },
      { name: '{{details.expires_at}}', description: 'Expiry time' },
      { name: '{{details.ca}}', description: 'Issuing CA (certificates)' },
      { name: '{{metric.value}}', description: 'Days until expiry' },
      { name: '{{metric.threshold}}', description: 'Configured threshold' },
    ],
  },
  {
    // Inference, checked every minute: each provider connection (its id) and the inference core (`inference-core`).
    id: 'inference',
    label: 'Inference',
    resourceLabel: 'provider connections',
    viewScopes: ['inference:providers:view'],
    metrics: [],
    events: [
      {
        id: 'provider.unavailable',
        label: 'Provider Connection Unavailable or Out of Quota',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      {
        id: 'provider.quota_low',
        label: 'Provider Quota Below 10%',
        defaultSeverity: 'warning',
        supportsThreshold: true,
      },
      {
        id: 'provider.reauth_required',
        label: 'Provider Needs Sign-In Again',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      { id: 'core.unhealthy', label: 'Inference Core Unhealthy', defaultSeverity: 'critical', supportsThreshold: true },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Provider connection name, or "Inference core"' },
      { name: '{{resource.id}}', description: 'Provider connection ID, or inference-core' },
      { name: '{{details.status}}', description: 'Connection status or core state' },
      { name: '{{details.provider}}', description: 'Provider of the connection' },
      { name: '{{details.reason}}', description: 'Why the connection or core is not healthy' },
    ],
  },
  {
    // The relay pool, checked every minute: relays (their instance id) and the pool (`pool:<pool id>`).
    id: 'relay_pool',
    label: 'Relay Pool',
    resourceLabel: 'relays',
    viewScopes: ['settings:opfield:view'],
    metrics: [],
    events: [
      { id: 'member.offline', label: 'Relay Offline or Failing', defaultSeverity: 'critical', supportsThreshold: true },
      {
        id: 'member.unreachable',
        label: 'Relay Unreachable by Nodes',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
      { id: 'pool.degraded', label: 'Relay Pool Degraded', defaultSeverity: 'warning', supportsThreshold: true },
      { id: 'update.failed', label: 'Relay Pool Update Failed', defaultSeverity: 'critical', supportsThreshold: true },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Relay name, or the pool' },
      { name: '{{resource.id}}', description: 'Relay instance ID, or pool:<pool id>' },
      { name: '{{details.state}}', description: 'Relay state (member.offline)' },
      { name: '{{details.reason}}', description: 'Last reported problem' },
      { name: '{{details.ready}}', description: 'Ready relays (pool.degraded)' },
      { name: '{{details.total}}', description: 'Relays of the pool not draining (pool.degraded)' },
      { name: '{{details.error}}', description: 'Why the update failed (update.failed)' },
    ],
  },
  {
    // Docker Availability policies (a container, deployment or Compose project on several nodes), checked every minute.
    id: 'docker_availability',
    label: 'Docker Availability',
    resourceLabel: 'availability workloads',
    viewScopes: ['docker:containers:view'],
    metrics: [],
    events: [
      { id: 'failover.completed', label: 'Failover Happened', defaultSeverity: 'warning' },
      { id: 'failover.failed', label: 'Failover Failed', defaultSeverity: 'critical' },
      { id: 'failback.completed', label: 'Moved Back to the Preferred Node', defaultSeverity: 'info' },
      {
        id: 'policy.degraded',
        label: 'Fewer Replicas Than Wanted (Cannot Fail Over)',
        defaultSeverity: 'warning',
        supportsThreshold: true,
      },
      {
        id: 'policy.unavailable',
        label: 'Workload Unavailable',
        defaultSeverity: 'critical',
        supportsThreshold: true,
      },
    ],
    variables: [
      { name: '{{resource.name}}', description: 'Workload name' },
      { name: '{{resource.id}}', description: 'Availability policy ID' },
      { name: '{{details.kind}}', description: 'container, deployment or compose' },
      { name: '{{details.status}}', description: 'Availability status' },
      { name: '{{details.error}}', description: 'Last error' },
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

/** Why a rule's metric or event is not in its category's catalog, or null when it is. */
export function catalogMismatch(rule: {
  type?: string | null;
  category?: string | null;
  metric?: string | null;
  eventPattern?: string | null;
}): string | null {
  const category = CATEGORY_MAP.get(rule.category as AlertCategory);
  if (!category) return `Unknown alert category ${rule.category}`;
  if (rule.type === 'threshold') {
    if (category.metrics.some((metric) => metric.id === rule.metric)) return null;
    return category.metrics.length === 0
      ? `${category.label} alerts have no metrics; use an event rule`
      : `${category.label} has no metric ${rule.metric}; use one of ${category.metrics.map((metric) => metric.id).join(', ')}`;
  }
  if (rule.type === 'event') {
    if (category.events.some((event) => event.id === rule.eventPattern)) return null;
    return category.events.length === 0
      ? `${category.label} alerts have no events; use a threshold rule`
      : `${category.label} has no event ${rule.eventPattern}; use one of ${category.events.map((event) => event.id).join(', ')}`;
  }
  return null;
}
