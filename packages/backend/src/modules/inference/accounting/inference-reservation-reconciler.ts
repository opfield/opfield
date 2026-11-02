import { and, eq, inArray, lt } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { inferenceRequestAttempts, inferenceRequests, inferenceUsageLedger } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { InferenceBudgetLockService } from './inference-budget-lock.service.js';
import type { InferenceBudgetReservationService } from './inference-budget-reservation.service.js';

const logger = createChildLogger('InferenceReservationReconciler');
const RESERVATION_MAX_AGE_MS = 15 * 60_000;

@injectable()
export class InferenceReservationReconciler {
  private timer: NodeJS.Timeout | null = null;
  private activeReconcile: Promise<void> | null = null;

  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly reservations: InferenceBudgetReservationService,
    private readonly locks: InferenceBudgetLockService
  ) {}

  start(): void {
    if (this.timer) return;
    this.runReconcile('Initial inference reservation reconciliation failed');
    this.timer = setInterval(() => {
      this.runReconcile('Inference reservation reconciliation failed');
    }, 60_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.activeReconcile;
  }

  private runReconcile(message: string): void {
    if (this.activeReconcile) return;
    const active = this.reconcile()
      .catch((error) => {
        logger.warn(message, { error });
      })
      .finally(() => {
        if (this.activeReconcile === active) this.activeReconcile = null;
      });
    this.activeReconcile = active;
  }

  async reconcile(now = new Date()): Promise<void> {
    const expiredBefore = new Date(now.getTime() - RESERVATION_MAX_AGE_MS);
    const expired = await this.db
      .select()
      .from(inferenceRequests)
      .where(
        and(inArray(inferenceRequests.status, ['reserved', 'running']), lt(inferenceRequests.startedAt, expiredBefore))
      );
    for (const request of expired) {
      if (!request.userId) continue;
      try {
        await this.locks.withUserLock(request.userId, async (database) => {
          // A core attempt holds its own reservation; only the legacy engine reserves under the request id.
          const attempts = await database
            .select({ reservationId: inferenceRequestAttempts.reservationId })
            .from(inferenceRequestAttempts)
            .where(
              and(
                eq(inferenceRequestAttempts.requestId, request.id),
                inArray(inferenceRequestAttempts.status, ['pending', 'running'])
              )
            );
          const held = [request.id, ...attempts.flatMap(({ reservationId }) => reservationId ?? [])];
          for (const id of held) {
            if (await this.reservations.isActive({ id, userId: request.userId! })) return;
          }
          const [row] = await database
            .update(inferenceRequests)
            .set({
              status: 'failed',
              errorCode: 'reservation_expired',
              estimatedUsage: request.status === 'running',
              completedAt: now,
            })
            .where(
              and(eq(inferenceRequests.id, request.id), inArray(inferenceRequests.status, ['reserved', 'running']))
            )
            .returning({ id: inferenceRequests.id });
          if (!row) return;
          await database
            .update(inferenceRequestAttempts)
            .set({ status: 'failed', errorCode: 'reservation_expired', completedAt: now })
            .where(
              and(
                eq(inferenceRequestAttempts.requestId, request.id),
                inArray(inferenceRequestAttempts.status, ['pending', 'running'])
              )
            );
          if (request.status === 'running' && request.budgetType) {
            await database.insert(inferenceUsageLedger).values({
              requestId: request.id,
              userId: request.userId,
              entryType: 'settlement',
              budgetType: request.budgetType,
              credits: request.budgetType === 'subscription' ? request.creditsCharged : '0',
              apiMicrodollars: request.budgetType === 'api' ? request.apiMicrodollarsCharged : 0,
              uncachedInputTokens: request.uncachedInputTokens,
              cachedInputTokens: request.cachedInputTokens,
              cacheWriteTokens: request.cacheWriteTokens,
              outputTokens: request.outputTokens,
              reasoningTokens: request.reasoningTokens,
              reason: 'orphan_conservative_settlement',
              occurredAt: request.startedAt,
              snapshot: {
                priceVersion: request.priceVersion,
                serviceTier: request.serviceTier,
                modelMultiplier: request.modelMultiplier,
                burnMultiplier: request.burnMultiplier,
                serviceTierMultiplier: request.serviceTierMultiplier,
                sourceId: request.sourceId,
                connectionId: request.connectionId,
              },
            });
          }
          await this.reservations.release({ id: request.id, userId: request.userId! });
        });
      } catch (error) {
        logger.warn('Failed to reconcile expired inference reservation', { requestId: request.id, error });
      }
    }
  }
}
