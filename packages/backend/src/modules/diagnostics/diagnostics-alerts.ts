import type { NotificationEvaluatorService } from '@/modules/notifications/notification-evaluator.service.js';
import { type DiagnosticsObservation, FAILING_JOB_RUNS } from './diagnostics.service.js';

const SAMPLING_MS = 60_000;
const MB = 1024 * 1024;
/** Below this many requests in a minute one failure would read as a high error rate. */
const MIN_REQUESTS_FOR_ERROR_RATE = 20;
/** A job that failed is watched this long after its last error, so its alert can resolve. */
const JOB_WATCH_MS = 60 * 60_000;

/** Hands each minute of Opfield diagnostics to the alert evaluator (category opfield). */
export function createOpfieldAlertObserver(
  evaluator: Pick<
    NotificationEvaluatorService,
    'observeOpfieldPostgres' | 'evaluateOpfieldSnapshot' | 'observeStatefulEvent'
  >
): (observation: DiagnosticsObservation) => Promise<void> {
  let composeServices = new Set<string>();

  return async ({ sample, postgres, redis, containers, jobs }) => {
    // First: the Postgres outage path works without the database, everything below needs it.
    await evaluator.observeOpfieldPostgres(postgres.status === 'ok', postgres.error);
    if (postgres.status !== 'ok') return;

    await evaluator.evaluateOpfieldSnapshot({
      host_cpu: sample.host.cpuPercent,
      host_memory: sample.host.memoryUsedPercent,
      host_disk: sample.host.diskUsedPercent,
      process_memory: Math.round(sample.process.rssBytes / MB),
      event_loop_delay: sample.process.eventLoopDelayP99Ms,
      api_error_rate: sample.requests.count >= MIN_REQUESTS_FOR_ERROR_RATE ? sample.requests.errorRatePercent : null,
      api_latency_p95: sample.requests.p95Ms,
      postgres_latency: postgres.latencyMs,
      postgres_pool_waiting: postgres.pool?.waiting ?? null,
      redis_latency: redis.latencyMs,
    });

    await evaluator.observeStatefulEvent(
      'opfield',
      redis.status === 'ok' ? 'ok' : 'redis.unavailable',
      { type: 'opfield', id: 'opfield-redis', name: 'Redis' },
      redis.error ? { error: redis.error } : {},
      ['redis.unavailable'],
      SAMPLING_MS
    );

    if (containers.available) {
      // Only the Compose stack: other Opfield-managed containers (inference core, managed ClickHouse) can be
      // stopped on purpose.
      const seen = new Set<string>();
      for (const container of containers.containers) {
        if (!container.inComposeProject) continue;
        seen.add(container.service);
        const down = container.state !== 'running' || container.health === 'unhealthy';
        await evaluator.observeStatefulEvent(
          'opfield',
          down ? 'container.unhealthy' : 'ok',
          { type: 'opfield', id: `opfield-container:${container.service}`, name: `Container ${container.service}` },
          { service: container.service, state: container.health ?? container.state },
          ['container.unhealthy'],
          SAMPLING_MS
        );
      }
      // A container that is gone reports no more; resolve what it left firing.
      for (const service of composeServices) {
        if (seen.has(service)) continue;
        await evaluator.observeStatefulEvent(
          'opfield',
          'ok',
          { type: 'opfield', id: `opfield-container:${service}`, name: `Container ${service}` },
          { service, state: 'removed' },
          ['container.unhealthy'],
          SAMPLING_MS
        );
      }
      composeServices = seen;
    }

    const now = Date.now();
    for (const job of jobs) {
      const lastError = job.lastErrorAt ? Date.parse(job.lastErrorAt) : 0;
      if (job.consecutiveFailures === 0 && now - lastError > JOB_WATCH_MS) continue;
      await evaluator.observeStatefulEvent(
        'opfield',
        job.consecutiveFailures >= FAILING_JOB_RUNS ? 'job.failing' : 'ok',
        { type: 'opfield', id: `opfield-job:${job.name}`, name: `Background job ${job.name}` },
        {
          job: job.name,
          failures_in_a_row: job.consecutiveFailures,
          ...(job.lastError ? { error: job.lastError } : {}),
        },
        ['job.failing'],
        SAMPLING_MS
      );
    }
  };
}
