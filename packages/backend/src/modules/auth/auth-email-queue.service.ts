import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { createChildLogger } from '@/lib/logger.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { AuthEmailInput } from './auth-email.templates.js';

const logger = createChildLogger('AuthEmailQueue');
const AUTH_EMAIL_QUEUE_NAME = 'auth-email-delivery';

export type SecurityAuthEmailInput = Exclude<AuthEmailInput, { kind: 'smtp_configuration' }>;

interface AuthEmailDelivery {
  recipient: string;
  input: SecurityAuthEmailInput;
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
        await deliver(delivery);
      },
      { connection: this.workerConnection as never, concurrency: 2 }
    );
    this.worker.on('error', (error) => {
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
    const payload = this.cryptoService.encryptString(JSON.stringify({ recipient, input } satisfies AuthEmailDelivery));
    await this.queue.add('deliver', payload);
  }

  async close(): Promise<void> {
    await this.worker?.close();
    this.worker = null;
    await this.queue.close();
    await this.workerConnection.quit();
  }
}
