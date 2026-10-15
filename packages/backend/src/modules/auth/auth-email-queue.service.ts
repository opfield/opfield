import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { Job, Queue, QueueEvents, UnrecoverableError, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { createChildLogger } from '@/lib/logger.js';
import type { CryptoService } from '@/services/crypto.service.js';
import { firstShutdownReport, isShuttingDown } from '@/services/shutdown-state.js';
import type { AuthEmailInput } from './auth-email.templates.js';
import { CloudMailRefusedError } from './auth-mail-cloud.js';

const logger = createChildLogger('AuthEmailQueue');
const AUTH_EMAIL_QUEUE_NAME = 'auth-email-delivery';
/**
 * How long close waits for BullMQ. At a host shutdown dockerd stops Redis together with the app, and BullMQ's close
 * then waits for Redis to come back (the shutdown held its whole budget, O-R1); after this the connections are dropped.
 */
export const AUTH_EMAIL_QUEUE_CLOSE_WAIT_MS = 3_000;

export type SecurityAuthEmailInput = Exclude<AuthEmailInput, { kind: 'smtp_configuration' }>;

/** A queued email failed for good (every attempt, or a refusal no retry can change). */
export class AuthEmailDeliveryError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'AuthEmailDeliveryError';
  }
}

/** A per-user rate-limit slot (a Redis sorted-set member) the email holds; a delivery that fails for good gives it back. */
export interface AuthEmailRateSlot {
  key: string;
  member: string;
}

interface AuthEmailDelivery {
  recipient: string;
  input: SecurityAuthEmailInput;
  rateSlot?: AuthEmailRateSlot;
  /** One key per email, the same on every retry (cloud email sends it once); absent on jobs of older releases. */
  dedupKey?: string;
}

interface EncryptedAuthEmailJob {
  encryptedKey: string;
  encryptedDek: string;
}

export class AuthEmailQueueService {
  private readonly queue: Queue<EncryptedAuthEmailJob, void, 'deliver'>;
  private readonly workerConnection: Redis;
  private worker: Worker<EncryptedAuthEmailJob> | null = null;
  private events: Promise<QueueEvents> | null = null;
  private eventsConnection: Redis | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly cryptoService: CryptoService
  ) {
    this.queue = new Queue<EncryptedAuthEmailJob, void, 'deliver'>(AUTH_EMAIL_QUEUE_NAME, {
      // BullMQ bundles its own ioredis types, while Opfield owns the runtime connection.
      connection: redis as never,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: true,
        removeOnFail: { age: 24 * 60 * 60, count: 100 },
      },
    });
    this.workerConnection = redis.duplicate({ maxRetriesPerRequest: null });
  }

  start(deliver: (delivery: AuthEmailDelivery) => Promise<void>): void {
    if (this.worker) return;
    this.worker = new Worker<EncryptedAuthEmailJob>(
      AUTH_EMAIL_QUEUE_NAME,
      async (job) => {
        const delivery = JSON.parse(
          this.cryptoService.decryptString({
            encryptedKey: job.data.encryptedKey,
            encryptedDek: job.data.encryptedDek,
          })
        ) as AuthEmailDelivery;
        try {
          await deliver(delivery);
        } catch (error) {
          // The account refused it for good (quota, invalid, unknown kind): fail now, a retry cannot change that.
          if (error instanceof CloudMailRefusedError) throw new UnrecoverableError(`${error.code}: ${error.message}`);
          throw error;
        }
      },
      { connection: this.workerConnection as never, concurrency: 2 }
    );
    this.worker.on('error', (error) => {
      if (isShuttingDown()) {
        if (firstShutdownReport('auth_email_queue')) {
          logger.info('Auth email queue lost Redis while Opfield shuts down', { error: error.message });
        }
        return;
      }
      logger.error('Auth email queue worker error', { error: error.message });
    });
    this.worker.on('failed', (job, error) => {
      logger.warn('Auth email delivery attempt failed', {
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        error: error.message,
      });
      // The email will not go out (a refusal no retry can change, or the last attempt): the slot is not spent.
      if (job && (error instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1))) {
        void this.releaseSlotOf(job.data).catch((releaseError: unknown) =>
          logger.warn('Auth email rate-limit slot could not be released', { error: errorMessage(releaseError) })
        );
      }
    });
  }

  async enqueue(recipient: string, input: SecurityAuthEmailInput, rateSlot?: AuthEmailRateSlot): Promise<void> {
    await this.queue.add('deliver', this.payload(recipient, input, rateSlot));
  }

  /**
   * Queues the email and waits up to `waitMs` for its outcome: `sent`, or `queued` when it is still on its way (it
   * keeps going). Throws AuthEmailDeliveryError when it failed for good. For actions a person waits on.
   */
  async enqueueAndWait(
    recipient: string,
    input: SecurityAuthEmailInput,
    waitMs: number,
    rateSlot?: AuthEmailRateSlot
  ): Promise<'sent' | 'queued'> {
    const events = await this.queueEvents().catch((error: unknown) => {
      logger.warn('Auth email delivery cannot be followed', { error: errorMessage(error) });
      return null;
    });
    const job = await this.queue.add('deliver', this.payload(recipient, input, rateSlot));
    if (!events || !job.id) return 'queued';
    const jobId = job.id;
    const emitter = events as unknown as EventEmitter;
    return new Promise<'sent' | 'queued'>((resolve, reject) => {
      let settled = false;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        emitter.off(`completed:${jobId}`, onCompleted);
        emitter.off(`failed:${jobId}`, onFailed);
        settle();
      };
      const onCompleted = () => finish(() => resolve('sent'));
      const onFailed = (args: { failedReason?: string }) =>
        finish(() => reject(new AuthEmailDeliveryError(args.failedReason || 'The email could not be sent')));
      const timer = setTimeout(() => finish(() => resolve('queued')), waitMs);
      emitter.on(`completed:${jobId}`, onCompleted);
      emitter.on(`failed:${jobId}`, onFailed);
      // It may have finished before the listeners: a finished job is removed on success and kept on failure.
      void job
        .getState()
        .then(async (state) => {
          if (state === 'completed' || state === 'unknown') onCompleted();
          else if (state === 'failed') onFailed({ failedReason: (await Job.fromId(this.queue, jobId))?.failedReason });
        })
        .catch(() => undefined);
    });
  }

  private payload(
    recipient: string,
    input: SecurityAuthEmailInput,
    rateSlot?: AuthEmailRateSlot
  ): EncryptedAuthEmailJob {
    return this.cryptoService.encryptString(
      JSON.stringify({ recipient, input, dedupKey: randomUUID(), rateSlot } satisfies AuthEmailDelivery)
    );
  }

  private async releaseSlotOf(data: EncryptedAuthEmailJob): Promise<void> {
    const { rateSlot } = JSON.parse(this.cryptoService.decryptString(data)) as AuthEmailDelivery;
    if (rateSlot) await this.redis.zrem(rateSlot.key, rateSlot.member);
  }

  /** The queue's events, on their own connection (blocking reads), opened on first use and kept. */
  private queueEvents(): Promise<QueueEvents> {
    if (!this.events) {
      this.eventsConnection = this.redis.duplicate({ maxRetriesPerRequest: null });
      const events = new QueueEvents(AUTH_EMAIL_QUEUE_NAME, { connection: this.eventsConnection as never });
      events.on('error', (error) => {
        if (!isShuttingDown()) logger.warn('Auth email queue events error', { error: error.message });
      });
      this.events = events.waitUntilReady().then(
        () => events,
        (error: unknown) => {
          this.events = null;
          void events.close().catch(() => undefined);
          throw error;
        }
      );
    }
    return this.events;
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    const events = this.events ? await this.events.catch(() => null) : null;
    this.events = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = await Promise.race([
      Promise.allSettled([worker?.close(), this.queue.close(), events?.close()]).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), AUTH_EMAIL_QUEUE_CLOSE_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!closed) {
      logger.info('Auth email queue closed without Redis');
      await Promise.allSettled([worker?.disconnect(), this.queue.disconnect(), events?.disconnect()]);
    }
    // The worker's and events' own connections: quit would wait for a Redis that is gone.
    this.workerConnection.disconnect();
    this.eventsConnection?.disconnect();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
