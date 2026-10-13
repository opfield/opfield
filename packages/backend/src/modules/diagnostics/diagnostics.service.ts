import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { opfieldDiagnosticsSamples, settings } from '@/db/schema/index.js';
import { LEGACY_MANAGED_SERVICE_LABEL, MANAGED_SERVICE_LABEL } from '@/foundation/opfield-names.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { RedisClient } from '@/services/cache.service.js';
import type { DockerContainerListItem, DockerService } from '@/services/docker.service.js';
import type { OpfieldLifecycleService } from '@/services/opfield-lifecycle.service.js';
import type { SchedulerJobStats, SchedulerService } from '@/services/scheduler.service.js';
import {
  type LogEntry,
  type LogFilter,
  type LogLevel,
  matchesLogFilter,
  parseLogLine,
  parseTimeArgument,
  redactText,
} from './diagnostics-logs.js';
import { type HostReading, type ProcessReading, readDisk, SystemReader } from './diagnostics-system.js';
import type { PostgresDetails, PostgresProbe, PostgresProbeResult } from './postgres-probe.js';
import { type RequestSummary, type RouteSummary, requestStats } from './request-stats.js';

const logger = createChildLogger('OpfieldDiagnostics');

const MINUTE_MS = 60_000;
const HISTORY_RETENTION_MS = 48 * 60 * MINUTE_MS;
const DEFAULT_HISTORY_RANGE_MS = 6 * 60 * MINUTE_MS;
const MAX_HISTORY_POINTS = 120;
const PENDING_SAMPLE_LIMIT = 120;
const PRUNE_INTERVAL_MS = 60 * MINUTE_MS;
const REDIS_TIMEOUT_MS = 2_000;
const DOCKER_TIMEOUT_MS = 5_000;
const LOG_SCAN_LIMIT = 20_000;
const DEFAULT_LOG_LIMIT = 200;
const MAX_LOG_LIMIT = 1_000;
const DEFAULT_LOG_WINDOW_MS = 60 * MINUTE_MS;
const DATA_PATHS = ['/var/lib/gateway', process.cwd()];
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
const UPDATE_ATTEMPT_KEY = 'update:gateway:attempt';
const DOCKER_TIMESTAMP_PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s?(.*)$/;
/** A job counts as failing after this many failed runs in a row. */
export const FAILING_JOB_RUNS = 3;

export const DEFAULT_HISTORY_METRICS = [
  'host.cpuPercent',
  'host.memoryUsedPercent',
  'host.diskUsedPercent',
  'host.loadPerCpu',
  'process.cpuPercent',
  'process.rssBytes',
  'process.eventLoopDelayP99Ms',
  'requests.count',
  'requests.errorRatePercent',
  'requests.p95Ms',
  'postgres.up',
  'postgres.latencyMs',
  'postgres.poolWaiting',
  'redis.up',
  'redis.latencyMs',
] as const;

export interface StackContainer {
  service: string;
  /** Part of Opfield's Compose project, not a container Opfield started on its own. */
  inComposeProject: boolean;
  name: string;
  id: string;
  image: string;
  state: string;
  health: string | null;
  restartCount: number | null;
  startedAt: string | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
}

export interface ContainersReading {
  available: boolean;
  reason?: string;
  project: string | null;
  containers: StackContainer[];
}

export interface RedisReading {
  status: 'ok' | 'unavailable';
  latencyMs: number | null;
  error?: string;
  version?: string;
  uptimeSeconds?: number;
  usedMemoryBytes?: number;
  maxMemoryBytes?: number;
  connectedClients?: number;
  blockedClients?: number;
  opsPerSecond?: number;
  evictedKeys?: number;
  keys?: number;
}

export interface PostgresReading extends PostgresProbeResult {
  pool: { total: number; idle: number; waiting: number; max: number } | null;
}

export interface DiagnosticsSnapshot {
  collectedAt: string;
  opfield: {
    version: string;
    lifecycleState: string;
    processStartedAt: string;
    dockerHost: {
      name?: string;
      dockerVersion?: string;
      operatingSystem?: string;
      cpus?: number;
      memoryBytes?: number;
    } | null;
  };
  host: HostReading | { error: string };
  process: ProcessReading;
  requests: { lastMinute: RequestSummary; last15Minutes: RequestSummary };
  postgres: PostgresReading & { details?: PostgresDetails; detailsError?: string };
  redis: RedisReading;
  containers: ContainersReading;
  jobs: { total: number; running: string[]; failing: SchedulerJobStats[] };
  lastSampleAt: string | null;
}

/** One minute of Opfield's own state, as stored for the 48-hour history. Numbers only, so they average. */
export interface DiagnosticsSample {
  minute: string;
  host: {
    cpuPercent: number | null;
    memoryUsedPercent: number | null;
    memoryAvailableBytes: number | null;
    load1: number | null;
    loadPerCpu: number | null;
    diskUsedPercent: number | null;
    diskFreeBytes: number | null;
  };
  process: {
    cpuPercent: number | null;
    rssBytes: number;
    heapUsedBytes: number;
    eventLoopUtilizationPercent: number | null;
    eventLoopDelayP99Ms: number | null;
    eventLoopDelayMaxMs: number | null;
  };
  requests: Omit<RequestSummary, 'from' | 'to'>;
  postgres: {
    up: 0 | 1;
    latencyMs: number | null;
    poolTotal: number | null;
    poolIdle: number | null;
    poolWaiting: number | null;
  };
  redis: {
    up: 0 | 1;
    latencyMs: number | null;
    usedMemoryBytes: number | null;
    connectedClients: number | null;
    opsPerSecond: number | null;
  };
  containers: Record<
    string,
    {
      running: 0 | 1;
      healthy: 0 | 1 | null;
      restartCount: number | null;
      cpuPercent: number | null;
      memoryBytes: number | null;
    }
  >;
  jobs: { failing: number };
}

/** What the minute sampler hands to alerting, besides the stored sample. */
export interface DiagnosticsObservation {
  sample: DiagnosticsSample;
  postgres: PostgresReading;
  redis: RedisReading;
  containers: ContainersReading;
  jobs: SchedulerJobStats[];
}

export interface LogsQuery extends LogFilter {
  source?: string;
  since?: string | number;
  until?: string | number;
  limit?: number;
}

export interface LogsResult {
  source: string;
  container: string;
  from: string | null;
  to: string | null;
  scannedLines: number;
  /** The scan hit its line limit: older matching lines may exist; narrow the time window. */
  scanLimitReached: boolean;
  entries: LogEntry[];
}

export interface HistoryQuery {
  from?: string | number;
  to?: string | number;
  metrics?: string[];
  stepMinutes?: number;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function parseRedisInfo(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator > 0 && !line.startsWith('#')) values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
}

function numberOf(values: Map<string, string>, key: string): number | undefined {
  const value = Number(values.get(key));
  return Number.isFinite(value) ? value : undefined;
}

function containerName(item: DockerContainerListItem): string {
  return (item.Names[0] ?? item.Id).replace(/^\//, '');
}

function serviceOf(item: DockerContainerListItem): string {
  return (
    item.Labels?.[COMPOSE_SERVICE_LABEL] ??
    item.Labels?.[MANAGED_SERVICE_LABEL] ??
    item.Labels?.[LEGACY_MANAGED_SERVICE_LABEL] ??
    containerName(item)
  );
}

function numberAt(sample: unknown, path: string): number | null {
  let value: unknown = sample;
  for (const part of path.split('.')) {
    if (value === null || typeof value !== 'object') return null;
    value = (value as Record<string, unknown>)[part];
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numericPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof item === 'number') return [path];
    return numericPaths(item, path);
  });
}

export class DiagnosticsService {
  private readonly system: SystemReader;
  private readonly processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  private pendingSamples: DiagnosticsSample[] = [];
  private lastSample: DiagnosticsSample | null = null;
  private lastPruneAt = 0;
  private observer: ((observation: DiagnosticsObservation) => Promise<void>) | null = null;

  constructor(
    private readonly db: DrizzleClient,
    private readonly redis: RedisClient | null,
    private readonly docker: DockerService,
    private readonly scheduler: SchedulerService,
    private readonly lifecycle: OpfieldLifecycleService,
    private readonly postgresProbe: PostgresProbe,
    private readonly appVersion: string
  ) {
    this.system = new SystemReader(DATA_PATHS[0] ?? process.cwd());
  }

  /** Alerting receives every minute sample through this callback. */
  setObserver(observer: (observation: DiagnosticsObservation) => Promise<void>): void {
    this.observer = observer;
  }

  stop(): void {
    this.system.stop();
  }

  // ── Readings ─────────────────────────────────────────────────────

  async snapshot(): Promise<DiagnosticsSnapshot> {
    const now = Date.now();
    const minute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    const [host, processReading, postgres, details, redis, containers, dockerHost] = await Promise.all([
      this.readHost(false),
      this.system.readProcess(false),
      this.readPostgres(),
      this.postgresProbe.details().then(
        (value) => ({ value }),
        (error: unknown) => ({ error: errorMessage(error) })
      ),
      this.readRedis(true),
      this.readContainers(),
      this.readDockerHost(),
    ]);
    const jobs = this.scheduler.getJobStats();
    return {
      collectedAt: new Date(now).toISOString(),
      opfield: {
        version: this.appVersion,
        lifecycleState: this.lifecycle.getState(),
        processStartedAt: this.processStartedAt,
        dockerHost,
      },
      host,
      process: processReading,
      requests: {
        lastMinute: requestStats.summarize(minute - MINUTE_MS, minute),
        last15Minutes: requestStats.summarize(minute - 15 * MINUTE_MS, minute + MINUTE_MS),
      },
      postgres: {
        ...postgres,
        ...('value' in details ? { details: details.value } : { detailsError: details.error }),
      },
      redis,
      containers,
      jobs: {
        total: jobs.length,
        running: jobs.filter((job) => job.running).map((job) => job.name),
        failing: jobs.filter((job) => job.consecutiveFailures > 0),
      },
      lastSampleAt: this.lastSample?.minute ?? null,
    };
  }

  requests(minutes = 15): {
    from: string;
    overall: RequestSummary;
    perMinute: RequestSummary[];
    busiest: RouteSummary[];
    slowest: RouteSummary[];
    failing: RouteSummary[];
  } {
    const span = Math.min(60, Math.max(1, Math.floor(minutes)));
    const now = Date.now();
    const currentMinute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    const from = currentMinute - (span - 1) * MINUTE_MS;
    const routes = requestStats.routes(from);
    return {
      from: new Date(from).toISOString(),
      overall: requestStats.summarize(from, currentMinute + MINUTE_MS),
      perMinute: Array.from({ length: span }, (_, index) =>
        requestStats.summarize(from + index * MINUTE_MS, from + (index + 1) * MINUTE_MS)
      ).filter((summary) => summary.count > 0),
      busiest: routes.slice(0, 15),
      slowest: routes
        .filter((route) => route.count >= 3)
        .sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0))
        .slice(0, 10),
      failing: routes.filter((route) => route.errors5xx > 0).sort((a, b) => b.errors5xx - a.errors5xx),
    };
  }

  jobs(): SchedulerJobStats[] {
    return this.scheduler
      .getJobStats()
      .sort(
        (a, b) =>
          b.consecutiveFailures - a.consecutiveFailures ||
          Number(b.running) - Number(a.running) ||
          a.name.localeCompare(b.name)
      );
  }

  async history(query: HistoryQuery = {}): Promise<{
    from: string;
    to: string;
    stepMinutes: number;
    samples: number;
    series: Record<string, Array<{ at: string; avg: number; max: number }>>;
    availableMetrics: string[];
  }> {
    const now = Date.now();
    const to = Math.min(parseTimeArgument(query.to, now) ?? now, now);
    const from = Math.max(
      parseTimeArgument(query.from, now) ?? to - DEFAULT_HISTORY_RANGE_MS,
      now - HISTORY_RETENTION_MS
    );
    if (from >= to) throw new AppError(400, 'INVALID_RANGE', 'The history range is empty: from must be before to');
    const rangeMinutes = Math.ceil((to - from) / MINUTE_MS);
    const stepMinutes = Math.max(1, Math.floor(query.stepMinutes ?? 0) || Math.ceil(rangeMinutes / MAX_HISTORY_POINTS));
    const samples = await this.samplesBetween(from, to);
    const metrics = query.metrics?.length ? query.metrics : [...DEFAULT_HISTORY_METRICS];
    const series: Record<string, Array<{ at: string; avg: number; max: number }>> = {};
    for (const metric of metrics) {
      const buckets = new Map<number, number[]>();
      for (const sample of samples) {
        const value = numberAt(sample, metric);
        if (value === null) continue;
        const bucket = Math.floor(Date.parse(sample.minute) / (stepMinutes * MINUTE_MS)) * stepMinutes * MINUTE_MS;
        const values = buckets.get(bucket) ?? [];
        values.push(value);
        buckets.set(bucket, values);
      }
      series[metric] = [...buckets].map(([at, values]) => ({
        at: new Date(at).toISOString(),
        avg: round(values.reduce((sum, value) => sum + value, 0) / values.length, 2),
        max: round(Math.max(...values), 2),
      }));
    }
    return {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      stepMinutes,
      samples: samples.length,
      series,
      availableMetrics: numericPaths(samples.at(-1) ?? this.lastSample ?? {}).filter((path) => path !== 'minute'),
    };
  }

  async logs(query: LogsQuery): Promise<LogsResult> {
    const source = (query.source ?? 'app').trim().toLowerCase() || 'app';
    const { id, name } = await this.resolveLogContainer(source);
    const now = Date.now();
    const untilMs = parseTimeArgument(query.until, now);
    const sinceMs = parseTimeArgument(query.since, now) ?? (untilMs ?? now) - DEFAULT_LOG_WINDOW_MS;
    const limit = Math.min(MAX_LOG_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_LOG_LIMIT)));
    const filter: LogFilter = {
      ...(query.level ? { level: query.level as LogLevel } : {}),
      ...(query.text ? { text: query.text } : {}),
      ...(query.context ? { context: query.context } : {}),
      ...(query.requestId ? { requestId: query.requestId } : {}),
    };
    const filtered = Object.keys(filter).length > 0;
    const tail = filtered ? LOG_SCAN_LIMIT : limit;
    let raw: string;
    try {
      raw = await this.docker.getContainerLogs(id, {
        sinceMs,
        ...(untilMs !== undefined ? { untilMs } : {}),
        tail,
        timestamps: true,
        timeoutMs: 30_000,
      });
    } catch (error) {
      const message = errorMessage(error);
      if (/does not support reading/i.test(message)) {
        throw new AppError(
          409,
          'LOGS_NOT_READABLE',
          `Docker's logging driver for ${name} does not keep logs Docker can read back (json-file, local and journald can); read them where that driver sends them`
        );
      }
      throw new AppError(502, 'LOGS_UNAVAILABLE', `Docker could not return the logs of ${name}: ${message}`);
    }
    const lines = raw.split('\n').filter((line) => line.trim());
    const entries: LogEntry[] = [];
    for (const line of lines) {
      const entry = parseLogLine(line);
      if (entry && matchesLogFilter(entry, filter)) entries.push(entry);
    }
    return {
      source,
      container: name,
      from: new Date(sinceMs).toISOString(),
      to: untilMs !== undefined ? new Date(untilMs).toISOString() : null,
      scannedLines: lines.length,
      scanLimitReached: filtered && lines.length >= tail,
      entries: entries.slice(-limit),
    };
  }

  // ── Minute sampler ───────────────────────────────────────────────

  /** Runs once a minute: records the minute that just ended, stores it, and hands it to alerting. */
  async sampleMinute(): Promise<void> {
    const now = Date.now();
    const minuteEnd = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    const minuteStart = minuteEnd - MINUTE_MS;
    const [host, processReading, postgres, redis, containers] = await Promise.all([
      this.readHost(true),
      this.system.readProcess(true),
      this.readPostgres(),
      this.readRedis(false),
      this.readContainers(),
    ]);
    const jobs = this.scheduler.getJobStats();
    const { from: _from, to: _to, ...requests } = requestStats.summarize(minuteStart, minuteEnd);
    const hostOk = 'cpuCount' in host ? host : null;
    const sample: DiagnosticsSample = {
      minute: new Date(minuteStart).toISOString(),
      host: {
        cpuPercent: hostOk?.cpuPercent ?? null,
        memoryUsedPercent: hostOk?.memoryUsedPercent ?? null,
        memoryAvailableBytes: hostOk?.memoryAvailableBytes ?? null,
        load1: hostOk?.loadAverage[0] ?? null,
        loadPerCpu: hostOk?.loadPerCpu ?? null,
        diskUsedPercent: hostOk?.disk?.usedPercent ?? null,
        diskFreeBytes: hostOk?.disk?.freeBytes ?? null,
      },
      process: {
        cpuPercent: processReading.cpuPercent,
        rssBytes: processReading.rssBytes,
        heapUsedBytes: processReading.heapUsedBytes,
        eventLoopUtilizationPercent: processReading.eventLoop.utilizationPercent,
        eventLoopDelayP99Ms: processReading.eventLoop.delayP99Ms,
        eventLoopDelayMaxMs: processReading.eventLoop.delayMaxMs,
      },
      requests,
      postgres: {
        up: postgres.status === 'ok' ? 1 : 0,
        latencyMs: postgres.latencyMs,
        poolTotal: postgres.pool?.total ?? null,
        poolIdle: postgres.pool?.idle ?? null,
        poolWaiting: postgres.pool?.waiting ?? null,
      },
      redis: {
        up: redis.status === 'ok' ? 1 : 0,
        latencyMs: redis.latencyMs,
        usedMemoryBytes: redis.usedMemoryBytes ?? null,
        connectedClients: redis.connectedClients ?? null,
        opsPerSecond: redis.opsPerSecond ?? null,
      },
      containers: Object.fromEntries(
        containers.containers.map((container) => [
          container.service,
          {
            running: container.state === 'running' ? 1 : 0,
            healthy: container.health === null ? null : container.health === 'healthy' ? 1 : 0,
            restartCount: container.restartCount,
            cpuPercent: container.cpuPercent,
            memoryBytes: container.memoryBytes,
          },
        ])
      ),
      jobs: { failing: jobs.filter((job) => job.consecutiveFailures >= FAILING_JOB_RUNS).length },
    };
    this.lastSample = sample;
    await this.storeSample(sample);
    if (this.observer) {
      await this.observer({ sample, postgres, redis, containers, jobs }).catch((error: unknown) => {
        logger.warn('Opfield alert evaluation failed', { error: errorMessage(error) });
      });
    }
  }

  getLastSample(): DiagnosticsSample | null {
    return this.lastSample;
  }

  // ── Cloud link readers ───────────────────────────────────────────

  /** Host readings now, without starting a new CPU window (the minute sampler owns it). */
  async readHostNow(): Promise<HostReading | { error: string }> {
    return this.readHost(false);
  }

  async readDockerHostInfo(): Promise<DiagnosticsSnapshot['opfield']['dockerHost']> {
    return this.readDockerHost();
  }

  /** Opfield's own containers (its Compose project and the services it manages), one entry per service. */
  async stackServices(): Promise<
    Array<{ name: string; state: string; health: string | null; startedAt: string | null }>
  > {
    const discovered = await this.stackContainerItems();
    const byName = new Map<string, DockerContainerListItem>();
    for (const item of discovered.items) {
      const name = item.Id === discovered.selfId ? 'app' : serviceOf(item);
      if (!byName.has(name) || item.State === 'running') byName.set(name, item);
    }
    const services = await Promise.all(
      [...byName].map(async ([name, item]) => {
        const details = await withTimeout(this.docker.inspectContainer(item.Id), DOCKER_TIMEOUT_MS, 'Docker').then(
          (value) => value as typeof value & { State: { Health?: { Status?: string } } },
          () => null
        );
        return {
          name,
          state: item.State,
          health: details?.State.Health?.Status ?? null,
          startedAt: details?.State.StartedAt ?? null,
        };
      })
    );
    return services.sort((a, b) => (a.name === 'app' ? -1 : b.name === 'app' ? 1 : a.name.localeCompare(b.name)));
  }

  /**
   * The last `tail` lines one of Opfield's own containers logged, as Docker keeps them, each with its stream.
   * Secrets are redacted like every other log reading.
   */
  async containerLogLines(
    source: string,
    options: { tail: number; sinceMs?: number; maxLineChars: number }
  ): Promise<{ service: string; lines: Array<{ t: string; stream: 'stdout' | 'stderr'; line: string }> }> {
    const { id, name } = await this.resolveLogContainer(source.trim().toLowerCase());
    const read = async (stream: 'stdout' | 'stderr') => {
      try {
        const raw = await this.docker.getContainerLogs(id, {
          stdout: stream === 'stdout',
          stderr: stream === 'stderr',
          tail: options.tail,
          ...(options.sinceMs !== undefined ? { sinceMs: options.sinceMs } : {}),
          timestamps: true,
          timeoutMs: 10_000,
        });
        return raw
          .split('\n')
          .filter((line) => line.trim())
          .map((line, index) => {
            const stamped = DOCKER_TIMESTAMP_PREFIX.exec(line);
            const t = stamped?.[1] ?? '';
            const text = redactText(stamped ? (stamped[2] ?? '') : line);
            return {
              t,
              at: t ? Date.parse(t) : Number.NaN,
              index,
              stream,
              line: text.length > options.maxLineChars ? `${text.slice(0, options.maxLineChars)}…` : text,
            };
          });
      } catch (error) {
        const message = errorMessage(error);
        if (/does not support reading/i.test(message)) {
          throw new AppError(
            409,
            'LOGS_NOT_READABLE',
            `Docker's logging driver for ${name} does not keep logs Docker can read back`
          );
        }
        throw new AppError(502, 'LOGS_UNAVAILABLE', `Docker could not return the logs of ${name}: ${message}`);
      }
    };
    const [stdout, stderr] = await Promise.all([read('stdout'), read('stderr')]);
    const merged = [...stdout, ...stderr].sort(
      (a, b) =>
        (Number.isNaN(a.at) ? 0 : a.at) - (Number.isNaN(b.at) ? 0 : b.at) ||
        (a.stream === b.stream ? a.index - b.index : 0)
    );
    return {
      service: name,
      lines: merged.slice(-options.tail).map(({ t, stream, line }) => ({ t, stream, line })),
    };
  }

  private async storeSample(sample: DiagnosticsSample): Promise<void> {
    const toStore = [...this.pendingSamples, sample];
    try {
      await this.db
        .insert(opfieldDiagnosticsSamples)
        .values(
          toStore.map((item) => ({ minute: new Date(item.minute), data: item as unknown as Record<string, unknown> }))
        )
        .onConflictDoUpdate({ target: opfieldDiagnosticsSamples.minute, set: { data: sql`excluded.data` } });
      this.pendingSamples = [];
      if (Date.now() - this.lastPruneAt > PRUNE_INTERVAL_MS) {
        this.lastPruneAt = Date.now();
        await this.db
          .delete(opfieldDiagnosticsSamples)
          .where(lt(opfieldDiagnosticsSamples.minute, new Date(Date.now() - HISTORY_RETENTION_MS)));
      }
    } catch (error) {
      // Postgres may be the thing that is down: keep the minutes and write them once it is back.
      this.pendingSamples = toStore.slice(-PENDING_SAMPLE_LIMIT);
      logger.debug('Could not store a diagnostics sample yet', { error: errorMessage(error) });
    }
  }

  private async samplesBetween(from: number, to: number): Promise<DiagnosticsSample[]> {
    const rows = await this.db
      .select({ data: opfieldDiagnosticsSamples.data })
      .from(opfieldDiagnosticsSamples)
      .where(
        and(gte(opfieldDiagnosticsSamples.minute, new Date(from)), lt(opfieldDiagnosticsSamples.minute, new Date(to)))
      )
      .orderBy(asc(opfieldDiagnosticsSamples.minute));
    const byMinute = new Map<string, DiagnosticsSample>();
    for (const row of rows) {
      const sample = row.data as unknown as DiagnosticsSample;
      byMinute.set(sample.minute, sample);
    }
    for (const sample of this.pendingSamples) {
      const at = Date.parse(sample.minute);
      if (at >= from && at < to) byMinute.set(sample.minute, sample);
    }
    return [...byMinute.values()].sort((a, b) => a.minute.localeCompare(b.minute));
  }

  // ── Collectors ───────────────────────────────────────────────────

  private async readHost(reset: boolean): Promise<HostReading | { error: string }> {
    try {
      const host = await this.system.readHost(reset);
      if (host.disk) return host;
      // Outside the container (development) the data directory does not exist.
      for (const path of DATA_PATHS.slice(1)) {
        const disk = await readDisk(path);
        if (disk) return { ...host, disk };
      }
      return host;
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  private async readPostgres(): Promise<PostgresReading> {
    const probe = await this.postgresProbe.probe();
    const pool = (
      this.db as unknown as {
        $client?: { totalCount?: number; idleCount?: number; waitingCount?: number; options?: { max?: number } };
      }
    ).$client;
    return {
      ...probe,
      pool:
        pool && typeof pool.totalCount === 'number'
          ? {
              total: pool.totalCount,
              idle: pool.idleCount ?? 0,
              waiting: pool.waitingCount ?? 0,
              max: pool.options?.max ?? 0,
            }
          : null,
    };
  }

  private async readRedis(withInfo: boolean): Promise<RedisReading> {
    if (!this.redis) return { status: 'unavailable', latencyMs: null, error: 'Redis is not configured' };
    const started = performance.now();
    try {
      const pong = await withTimeout(this.redis.ping(), REDIS_TIMEOUT_MS, 'Redis');
      if (pong !== 'PONG') throw new Error(`Unexpected ping answer: ${pong}`);
      const latencyMs = round(performance.now() - started);
      const info = parseRedisInfo(await withTimeout(this.redis.info(), REDIS_TIMEOUT_MS, 'Redis'));
      const keys = /keys=(\d+)/.exec(info.get('db0') ?? '')?.[1];
      return {
        status: 'ok',
        latencyMs,
        usedMemoryBytes: numberOf(info, 'used_memory'),
        connectedClients: numberOf(info, 'connected_clients'),
        opsPerSecond: numberOf(info, 'instantaneous_ops_per_sec'),
        ...(withInfo
          ? {
              version: info.get('redis_version'),
              uptimeSeconds: numberOf(info, 'uptime_in_seconds'),
              maxMemoryBytes: numberOf(info, 'maxmemory'),
              blockedClients: numberOf(info, 'blocked_clients'),
              evictedKeys: numberOf(info, 'evicted_keys'),
              keys: keys ? Number(keys) : 0,
            }
          : {}),
      };
    } catch (error) {
      return { status: 'unavailable', latencyMs: null, error: errorMessage(error) };
    }
  }

  private async readDockerHost(): Promise<DiagnosticsSnapshot['opfield']['dockerHost']> {
    try {
      const info = (await withTimeout(this.docker.getDaemonInfo(), DOCKER_TIMEOUT_MS, 'Docker')) as {
        Name?: string;
        ServerVersion?: string;
        OperatingSystem?: string;
        NCPU?: number;
        MemTotal?: number;
      };
      return {
        name: info.Name,
        dockerVersion: info.ServerVersion,
        operatingSystem: info.OperatingSystem,
        cpus: info.NCPU,
        memoryBytes: info.MemTotal,
      };
    } catch {
      return null;
    }
  }

  private async stackContainerItems(): Promise<{
    project: string | null;
    selfId: string;
    items: DockerContainerListItem[];
  }> {
    const self = await withTimeout(this.docker.inspectSelf(), DOCKER_TIMEOUT_MS, 'Docker');
    const project = self.Config.Labels?.[COMPOSE_PROJECT_LABEL] ?? null;
    const [projectItems, managedItems, legacyManagedItems] = await Promise.all([
      project ? this.docker.listContainersByLabel(`${COMPOSE_PROJECT_LABEL}=${project}`) : Promise.resolve([]),
      this.docker.listContainersByLabel(MANAGED_SERVICE_LABEL),
      // legacy-name: services created before 2.12.1 keep their label until the host move recreates them.
      this.docker.listContainersByLabel(LEGACY_MANAGED_SERVICE_LABEL),
    ]);
    const items = new Map<string, DockerContainerListItem>();
    for (const item of [...projectItems, ...managedItems, ...legacyManagedItems]) items.set(item.Id, item);
    return { project, selfId: self.Id, items: [...items.values()] };
  }

  private async readContainers(): Promise<ContainersReading> {
    let discovered: Awaited<ReturnType<DiagnosticsService['stackContainerItems']>>;
    try {
      discovered = await this.stackContainerItems();
    } catch (error) {
      return {
        available: false,
        reason: `Opfield's containers cannot be inspected here (${errorMessage(error)}); it may not run in Docker`,
        project: null,
        containers: [],
      };
    }
    const containers = await Promise.all(
      discovered.items.map(async (item): Promise<StackContainer> => {
        const [inspect, stats] = await Promise.allSettled([
          withTimeout(this.docker.inspectContainer(item.Id), DOCKER_TIMEOUT_MS, 'Docker'),
          item.State === 'running'
            ? withTimeout(this.docker.getContainerStats(item.Id), DOCKER_TIMEOUT_MS, 'Docker')
            : Promise.reject(new Error('not running')),
        ]);
        const details =
          inspect.status === 'fulfilled'
            ? (inspect.value as typeof inspect.value & {
                RestartCount?: number;
                State: { Health?: { Status?: string } };
              })
            : null;
        let cpuPercent: number | null = null;
        let memoryBytes: number | null = null;
        let memoryLimitBytes: number | null = null;
        if (stats.status === 'fulfilled') {
          const value = stats.value;
          const cpuDelta = value.cpu_stats.cpu_usage.total_usage - value.precpu_stats.cpu_usage.total_usage;
          const systemDelta = value.cpu_stats.system_cpu_usage - value.precpu_stats.system_cpu_usage;
          if (systemDelta > 0 && cpuDelta >= 0) {
            cpuPercent = round((cpuDelta / systemDelta) * (value.cpu_stats.online_cpus || 1) * 100);
          }
          memoryBytes = Math.max(0, value.memory_stats.usage - (value.memory_stats.stats?.cache ?? 0));
          memoryLimitBytes = value.memory_stats.limit || null;
        }
        return {
          service: serviceOf(item),
          inComposeProject: !!discovered.project && item.Labels?.[COMPOSE_PROJECT_LABEL] === discovered.project,
          name: containerName(item),
          id: item.Id.slice(0, 12),
          image: item.Image,
          state: item.State,
          health: details?.State.Health?.Status ?? null,
          restartCount: details?.RestartCount ?? null,
          startedAt: details?.State.StartedAt ?? null,
          cpuPercent,
          memoryBytes,
          memoryLimitBytes,
        };
      })
    );
    return {
      available: true,
      project: discovered.project,
      containers: containers.sort((a, b) => a.service.localeCompare(b.service)),
    };
  }

  private async resolveLogContainer(source: string): Promise<{ id: string; name: string }> {
    let discovered: Awaited<ReturnType<DiagnosticsService['stackContainerItems']>>;
    try {
      discovered = await this.stackContainerItems();
    } catch (error) {
      throw new AppError(
        409,
        'LOGS_NOT_READABLE',
        `Opfield's container logs cannot be read here (${errorMessage(error)}); it may not run in Docker`
      );
    }
    if (source === 'app') return { id: discovered.selfId, name: 'app' };
    if (source === 'update') {
      const [row] = await this.db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, UPDATE_ATTEMPT_KEY))
        .limit(1);
      const sidecarId = (row?.value as { sidecarId?: unknown } | undefined)?.sidecarId;
      if (typeof sidecarId !== 'string' || !sidecarId) {
        throw new AppError(
          404,
          'LOG_SOURCE_NOT_FOUND',
          'No Opfield update run is on record, so there are no update logs to read'
        );
      }
      return { id: sidecarId, name: 'update' };
    }
    const match = discovered.items.find(
      (item) => serviceOf(item).toLowerCase() === source || containerName(item).toLowerCase() === source
    );
    if (!match) {
      const known = ['app', 'update', ...discovered.items.map(serviceOf)];
      throw new AppError(
        404,
        'LOG_SOURCE_NOT_FOUND',
        `No Opfield container is called ${source}; sources: ${[...new Set(known)].join(', ')}`
      );
    }
    return { id: match.Id, name: serviceOf(match) };
  }
}
