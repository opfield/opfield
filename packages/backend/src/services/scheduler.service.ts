import cron, { type ScheduledTask } from 'node-cron';
import { createChildLogger } from '@/lib/logger.js';

const logger = createChildLogger('SchedulerService');

/**
 * A scheduled task. The scheduler always passes a signal that aborts when it stops (Opfield
 * shutdown); a task that holds a long external session must end it on abort so shutdown does not
 * wait for it. The parameter is optional so wrappers may still call a task without one.
 */
export type SchedulerTask = (signal?: AbortSignal) => Promise<void>;

interface ScheduledJob {
  name: string;
  schedule: string; // cron expression
  task: SchedulerTask;
  handle?: ScheduledTask;
}

interface IntervalJob {
  name: string;
  intervalMs: number;
  task: SchedulerTask;
  handle?: ReturnType<typeof setInterval>;
}

/** How a background job has been doing since Opfield started. */
export interface SchedulerJobStats {
  name: string;
  /** Cron expression, or "every <n>ms" for an interval job. */
  schedule: string;
  running: boolean;
  runs: number;
  failures: number;
  consecutiveFailures: number;
  /** Runs skipped because the previous run of the same job had not finished. */
  skippedOverlaps: number;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastDurationMs: number | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

const MAX_JOB_ERROR_LENGTH = 500;

export class SchedulerService {
  private jobs: ScheduledJob[] = [];
  private intervals: IntervalJob[] = [];
  private activeTasks = new Set<Promise<void>>();
  private activeTaskNames = new Set<string>();
  private running = false;
  private stopController = new AbortController();
  private readonly stats = new Map<string, SchedulerJobStats>();

  register(name: string, schedule: string, task: SchedulerTask): void {
    this.jobs.push({ name, schedule, task });
  }

  registerInterval(name: string, intervalMs: number, task: SchedulerTask): void {
    this.intervals.push({ name, intervalMs, task });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.stopController.signal.aborted) this.stopController = new AbortController();
    for (const job of this.jobs) {
      logger.info(`Starting scheduled job: ${job.name} (${job.schedule})`);
      job.handle = cron.schedule(job.schedule, () => this.runTask('Job', job.name, job.task));
    }

    for (const interval of this.intervals) {
      logger.info(`Starting interval job: ${interval.name} (every ${interval.intervalMs}ms)`);
      interval.handle = setInterval(
        () => this.runTask('Interval job', interval.name, interval.task),
        interval.intervalMs
      );
    }
  }

  updateSchedule(name: string, newCron: string): void {
    const job = this.jobs.find((j) => j.name === name);
    if (!job) return;
    job.handle?.destroy();
    job.handle = undefined;
    job.schedule = newCron;
    if (this.running) job.handle = cron.schedule(newCron, () => this.runTask('Job', job.name, job.task));
    logger.info(`Updated schedule for ${name}: ${newCron}`);
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const job of this.jobs) {
      job.handle?.destroy();
      job.handle = undefined;
      logger.info(`Stopped job: ${job.name}`);
    }

    for (const interval of this.intervals) {
      if (interval.handle) {
        clearInterval(interval.handle);
        interval.handle = undefined;
      }
      logger.info(`Stopped interval job: ${interval.name}`);
    }
    this.stopController.abort();
    if (this.activeTaskNames.size > 0) {
      logger.info('Waiting for running scheduled jobs', { jobs: [...this.activeTaskNames] });
    }
    await Promise.allSettled([...this.activeTasks]);
  }

  /** Run statistics of every registered job, including jobs that have not run yet. */
  getJobStats(): SchedulerJobStats[] {
    return [
      ...this.jobs.map((job) => ({ ...this.jobStats(job.name, job.schedule) })),
      ...this.intervals.map((interval) => ({ ...this.jobStats(interval.name, `every ${interval.intervalMs}ms`) })),
    ];
  }

  private jobStats(name: string, schedule: string): SchedulerJobStats {
    let stats = this.stats.get(name);
    if (!stats) {
      stats = {
        name,
        schedule,
        running: false,
        runs: 0,
        failures: 0,
        consecutiveFailures: 0,
        skippedOverlaps: 0,
        lastStartedAt: null,
        lastFinishedAt: null,
        lastDurationMs: null,
        lastSuccessAt: null,
        lastError: null,
        lastErrorAt: null,
      };
      this.stats.set(name, stats);
    }
    stats.schedule = schedule;
    return stats;
  }

  private runTask(kind: string, name: string, task: SchedulerTask): void {
    if (!this.running) return;
    const stats = this.jobStats(name, this.scheduleOf(name));
    if (this.activeTaskNames.has(name)) {
      stats.skippedOverlaps += 1;
      logger.debug(`Skipping overlapping ${kind.toLowerCase()}: ${name}`);
      return;
    }
    logger.debug(`Running ${kind.toLowerCase()}: ${name}`);
    this.activeTaskNames.add(name);
    const startedAt = Date.now();
    stats.running = true;
    stats.runs += 1;
    stats.lastStartedAt = new Date(startedAt).toISOString();
    const signal = this.stopController.signal;
    const promise = Promise.resolve()
      .then(() => task(signal))
      .then(() => {
        stats.consecutiveFailures = 0;
        stats.lastSuccessAt = new Date().toISOString();
      })
      .catch((error) => {
        stats.failures += 1;
        stats.consecutiveFailures += 1;
        stats.lastError = (error instanceof Error ? error.message : String(error)).slice(0, MAX_JOB_ERROR_LENGTH);
        stats.lastErrorAt = new Date().toISOString();
        logger.error(`${kind} ${name} failed`, { error });
      })
      .finally(() => {
        stats.running = false;
        stats.lastFinishedAt = new Date().toISOString();
        stats.lastDurationMs = Date.now() - startedAt;
        this.activeTaskNames.delete(name);
        this.activeTasks.delete(promise);
      });
    this.activeTasks.add(promise);
  }

  private scheduleOf(name: string): string {
    const job = this.jobs.find((candidate) => candidate.name === name);
    if (job) return job.schedule;
    const interval = this.intervals.find((candidate) => candidate.name === name);
    return interval ? `every ${interval.intervalMs}ms` : '';
  }
}
