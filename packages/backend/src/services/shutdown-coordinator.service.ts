import { randomUUID } from 'node:crypto';
import { createChildLogger } from '@/lib/logger.js';
import type { GeneralShutdownSettings } from '@/modules/settings/general-settings.service.js';
import type { OpfieldLifecycleService } from './opfield-lifecycle.service.js';

const logger = createChildLogger('ShutdownCoordinator');

/** Ordinary requests and short operations get this long before running orchestration is left to recovery. */
export const RESUMABLE_WORK_GRACE_MS = 2_000;
const RESUMABLE_WORK_POLL_MS = 250;

export interface ShutdownHooks {
  freezeStatusPage: () => Promise<void>;
  quiesce: () => Promise<void>;
  drainUserWork: (deadline: number) => Promise<void>;
  /**
   * Waits for running orchestration work (deployments, Availability, Compose,
   * rollouts, migrations) within the user drain deadline and returns how many
   * operations still run at the deadline. Durable recovery resumes those.
   */
  drainOrchestration: (deadline: number) => Promise<number>;
  /** Names of shutdown work that has not settled yet; logged when a drain phase times out. */
  pendingWork?: () => string[];
  /**
   * Whether all that still runs is orchestration that durable recovery resumes after the restart, with the user
   * requests that wait for it: then the stop does not wait for it.
   */
  resumableWorkOnly?: () => Promise<boolean>;
  /** Leaves the running orchestration to recovery: it can no longer record anything (see acceptedOperations). */
  abandonResumableWork?: () => void;
  forceCloseUserWork: () => Promise<void> | void;
  closeLogging: (deadline: number) => Promise<void>;
  closeHttp: (deadline: number) => Promise<void>;
  finalize: (deadline: number) => Promise<void>;
  closeApplicationLogger: (deadline: number) => Promise<void>;
}

export interface ShutdownCoordinatorOptions {
  lifecycle: OpfieldLifecycleService;
  getSettings: () => GeneralShutdownSettings;
  hooks: ShutdownHooks;
  exit?: (code: number) => void;
  now?: () => number;
}

export class ShutdownCoordinator {
  private shutdownPromise: Promise<void> | null = null;

  constructor(private readonly options: ShutdownCoordinatorOptions) {}

  request(signal: NodeJS.Signals): Promise<void> {
    if (this.shutdownPromise) {
      logger.error('Forced shutdown after repeated signal', { signal });
      this.options.exit?.(1);
      return this.shutdownPromise;
    }
    this.shutdownPromise = this.run(signal);
    return this.shutdownPromise;
  }

  private async run(signal: NodeJS.Signals): Promise<void> {
    const shutdownId = randomUUID();
    const startedAt = this.now();
    const settings = { ...this.options.getSettings() };
    const userDeadline = startedAt + settings.userRequestDrainSeconds * 1000;
    const logDeadline = userDeadline + settings.structuredLogDrainSeconds * 1000;
    const hardDeadline = logDeadline + settings.finalizationTimeoutSeconds * 1000;
    const watchdog = setTimeout(
      () => {
        logger.error('Graceful shutdown hard deadline exceeded', {
          shutdownId,
          signal,
          hardDeadline,
          pendingWork: this.options.hooks.pendingWork?.() ?? [],
        });
        this.options.exit?.(1);
      },
      Math.max(0, hardDeadline - this.now())
    );

    logger.info('Graceful shutdown started', { shutdownId, signal, settings });
    try {
      this.options.lifecycle.transition('draining_user');
      const userPhaseStartedAt = this.now();
      logger.info('Graceful shutdown phase started', { shutdownId, phase: 'draining_user' });
      const orchestration: { remaining: number | null } = { remaining: null };
      const drained = Promise.allSettled([
        this.options.hooks.freezeStatusPage(),
        this.options.hooks.quiesce(),
        this.options.lifecycle.waitForZero('user', userDeadline),
        this.options.hooks.drainUserWork(userDeadline),
        this.options.hooks.drainOrchestration(userDeadline).then((remaining) => {
          orchestration.remaining = remaining;
        }),
      ]).then(() => 'drained' as const);
      const resumable = { stop: false };
      const outcome = await untilDeadlineWith(
        Promise.race([drained, this.untilOnlyResumableWork(userDeadline, resumable)]),
        userDeadline,
        () => this.now()
      );
      resumable.stop = true;
      const userPhaseCompleted = outcome !== null;
      if (outcome === 'resumable') {
        logger.info('Only orchestration that recovery resumes is still running; the stop does not wait for it', {
          shutdownId,
          activeRequests: this.options.lifecycle.getActiveCount('user'),
        });
        this.options.hooks.abandonResumableWork?.();
      } else if (!userPhaseCompleted) {
        logger.warn('User drain deadline reached with shutdown work still running', {
          shutdownId,
          pendingWork: this.options.hooks.pendingWork?.() ?? [],
        });
      }
      if (outcome !== 'resumable' && orchestration.remaining !== 0) {
        logger.warn('Orchestration operations still run at the user drain deadline; recovery resumes them', {
          shutdownId,
          operations: orchestration.remaining,
        });
      }
      if (this.options.lifecycle.getActiveCount('user') > 0) {
        logger.warn('User drain deadline reached', {
          shutdownId,
          activeRequests: this.options.lifecycle.getActiveCount('user'),
        });
      }
      this.options.lifecycle.forceClose('user');
      await untilDeadline(
        Promise.resolve(this.options.hooks.forceCloseUserWork()).then(() => undefined),
        userDeadline,
        () => this.now()
      );
      logger.info('Graceful shutdown phase completed', {
        shutdownId,
        phase: 'draining_user',
        durationMs: this.now() - userPhaseStartedAt,
        timedOut: !userPhaseCompleted,
      });

      this.options.lifecycle.transition('draining_logs');
      const logPhaseStartedAt = this.now();
      logger.info('Graceful shutdown phase started', { shutdownId, phase: 'draining_logs' });
      const logRequestsDrained = await this.options.lifecycle.waitForZero('structured_logs', logDeadline);
      if (this.options.lifecycle.getActiveCount('structured_logs') > 0) {
        logger.warn('Structured log drain deadline reached', {
          shutdownId,
          activeRequests: this.options.lifecycle.getActiveCount('structured_logs'),
        });
        this.options.lifecycle.forceClose('structured_logs');
      }
      const loggingClosed = await untilDeadline(this.options.hooks.closeLogging(logDeadline), logDeadline, () =>
        this.now()
      );
      logger.info('Graceful shutdown phase completed', {
        shutdownId,
        phase: 'draining_logs',
        durationMs: this.now() - logPhaseStartedAt,
        timedOut: !logRequestsDrained || !loggingClosed,
      });

      this.options.lifecycle.transition('terminating');
      const finalPhaseStartedAt = this.now();
      logger.info('Graceful shutdown phase started', { shutdownId, phase: 'terminating' });
      if (!(await untilDeadline(this.options.hooks.closeHttp(hardDeadline), hardDeadline, () => this.now()))) {
        throw new Error('HTTP shutdown exceeded the graceful shutdown hard deadline');
      }
      if (!(await untilDeadline(this.options.hooks.finalize(hardDeadline), hardDeadline, () => this.now()))) {
        throw new Error('Finalization exceeded the graceful shutdown hard deadline');
      }
      logger.info('Graceful shutdown phase completed', {
        shutdownId,
        phase: 'terminating',
        durationMs: this.now() - finalPhaseStartedAt,
        timedOut: false,
      });

      logger.info('Graceful shutdown completed', { shutdownId, durationMs: this.now() - startedAt });
      const loggerClosed = await untilDeadline(
        this.options.hooks.closeApplicationLogger(hardDeadline),
        hardDeadline,
        () => this.now()
      );
      clearTimeout(watchdog);
      this.options.exit?.(loggerClosed ? 0 : 1);
    } catch (error) {
      logger.error('Graceful shutdown failed', { shutdownId, error });
      await untilDeadline(this.options.hooks.closeApplicationLogger(hardDeadline), hardDeadline, () =>
        this.now()
      ).catch(() => false);
      clearTimeout(watchdog);
      this.options.exit?.(1);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Resolves once only resumable orchestration (and the requests waiting for it) is left, after a short grace. */
  private async untilOnlyResumableWork(deadline: number, state: { stop: boolean }): Promise<'resumable'> {
    const check = this.options.hooks.resumableWorkOnly;
    const graceEnd = this.now() + RESUMABLE_WORK_GRACE_MS;
    for (;;) {
      const wakeAt = this.now() < graceEnd ? graceEnd : this.now() + RESUMABLE_WORK_POLL_MS;
      await sleep(Math.max(0, Math.min(wakeAt, deadline) - this.now()));
      if (state.stop || !check || this.now() >= deadline) return new Promise<never>(() => undefined);
      if (await check().catch(() => false)) return 'resumable';
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function untilDeadlineWith<T>(promise: Promise<T>, deadline: number, now: () => number): Promise<T | null> {
  const remainingMs = Math.max(0, deadline - now());
  if (remainingMs === 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    promise,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), remainingMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return result;
}

async function untilDeadline(promise: Promise<void>, deadline: number, now: () => number): Promise<boolean> {
  const remainingMs = Math.max(0, deadline - now());
  if (remainingMs === 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let completed = false;
  await Promise.race([
    promise.then(() => {
      completed = true;
    }),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, remainingMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return completed;
}

export function waitForShutdownTasks(
  tasks: Promise<unknown>[],
  deadline: number,
  now: () => number = Date.now
): Promise<boolean> {
  return untilDeadline(
    Promise.allSettled(tasks).then(() => undefined),
    deadline,
    now
  );
}
