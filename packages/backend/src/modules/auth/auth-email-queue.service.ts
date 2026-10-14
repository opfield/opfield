import { randomUUID } from 'node:crypto';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
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

interface AuthEmailDelivery {
  recipient: string;
  input: SecurityAuthEmailInput;
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

  constructor(
    redis: Redis,
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
    });
  }

  async enqueue(recipient: string, input: SecurityAuthEmailInput): Promise<void> {
    const payload = this.cryptoService.encryptString(
      JSON.stringify({ recipient, input, dedupKey: randomUUID() } satisfies AuthEmailDelivery)
    );
    await this.queue.add('deliver', payload);
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = await Promise.race([
      Promise.allSettled([worker?.close(), this.queue.close()]).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), AUTH_EMAIL_QUEUE_CLOSE_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!closed) {
      logger.info('Auth email queue closed without Redis');
      await Promise.allSettled([worker?.disconnect(), this.queue.disconnect()]);
    }
    // The worker's own connection: quit would wait for a Redis that is gone.
    this.workerConnection.disconnect();
  }
}
