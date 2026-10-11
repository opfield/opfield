import { desc, eq } from 'drizzle-orm';
import { injectable } from 'tsyringe';
import type { DrizzleClient } from '@/db/client.js';
import { type InferenceCoreOperationRow, inferenceCoreOperations } from '@/db/schema/inference-core.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type {
  InferenceCoreOperationKind,
  InferenceCoreOperationPhase,
  InferenceCoreOperationProgress,
} from './inference-core.contract.js';

const logger = createChildLogger('InferenceCoreOperationService');

/** Realtime channel for browser lifecycle updates (status DTO payloads). */
export const INFERENCE_CORE_CHANGED_CHANNEL = 'inference.core.changed';

/**
 * Persisted lifecycle operations for the managed core. Every operation row is
 * written BEFORE the first Docker mutation it describes, so a Gateway restart
 * can always recover "what was in flight" from the database. At most one
 * operation runs at a time (enforced by the partial unique index).
 */
@injectable()
export class InferenceCoreOperationService {
  constructor(private readonly db: DrizzleClient) {}

  async begin(
    kind: InferenceCoreOperationKind,
    fields: {
      phase: InferenceCoreOperationPhase;
      fromVersion?: string | null;
      toVersion?: string | null;
      fromDigest?: string | null;
      toDigest?: string | null;
    }
  ): Promise<InferenceCoreOperationRow> {
    try {
      const [row] = await this.db
        .insert(inferenceCoreOperations)
        .values({
          kind,
          phase: fields.phase,
          status: 'running',
          fromVersion: fields.fromVersion ?? null,
          toVersion: fields.toVersion ?? null,
          fromDigest: fields.fromDigest ?? null,
          toDigest: fields.toDigest ?? null,
        })
        .returning();
      return row;
    } catch (error) {
      if (error instanceof Error && /inference_core_operations_running_unique/.test(error.message)) {
        throw new AppError(409, 'CORE_OPERATION_IN_PROGRESS', 'Another inference core operation is already running');
      }
      throw error;
    }
  }

  async updatePhase(
    id: string,
    phase: InferenceCoreOperationPhase,
    progress?: InferenceCoreOperationProgress | null
  ): Promise<void> {
    await this.db
      .update(inferenceCoreOperations)
      .set({
        phase,
        ...(progress !== undefined ? { progress } : {}),
        heartbeatAt: new Date(),
      })
      .where(eq(inferenceCoreOperations.id, id));
  }

  /** Cheap liveness touch for long phases without a phase/progress change. */
  async heartbeat(id: string): Promise<void> {
    await this.db
      .update(inferenceCoreOperations)
      .set({ heartbeatAt: new Date() })
      .where(eq(inferenceCoreOperations.id, id));
  }

  async succeed(id: string): Promise<void> {
    await this.db
      .update(inferenceCoreOperations)
      .set({ status: 'succeeded', finishedAt: new Date(), heartbeatAt: new Date() })
      .where(eq(inferenceCoreOperations.id, id));
  }

  async fail(id: string, error: string): Promise<void> {
    await this.db
      .update(inferenceCoreOperations)
      .set({ status: 'failed', error, finishedAt: new Date(), heartbeatAt: new Date() })
      .where(eq(inferenceCoreOperations.id, id));
  }

  /** The currently running operation, if any. */
  async current(): Promise<InferenceCoreOperationRow | null> {
    const rows = await this.db
      .select()
      .from(inferenceCoreOperations)
      .where(eq(inferenceCoreOperations.status, 'running'))
      .limit(1);
    return rows[0] ?? null;
  }

  async listRecent(limit = 10): Promise<InferenceCoreOperationRow[]> {
    return this.db.select().from(inferenceCoreOperations).orderBy(desc(inferenceCoreOperations.createdAt)).limit(limit);
  }

  /**
   * Startup recovery: a still-"running" row means the Gateway process died
   * mid-operation. Mark it failed so the runtime can reconcile from observed
   * Docker state instead of trusting a dead operation.
   */
  async failInterrupted(): Promise<number> {
    const interrupted = await this.db
      .update(inferenceCoreOperations)
      .set({
        status: 'failed',
        error: 'Operation was interrupted by an Opfield restart',
        finishedAt: new Date(),
        heartbeatAt: new Date(),
      })
      .where(eq(inferenceCoreOperations.status, 'running'))
      .returning({ id: inferenceCoreOperations.id });
    if (interrupted.length > 0) {
      logger.warn('Marked interrupted core operations as failed', { count: interrupted.length });
    }
    return interrupted.length;
  }
}
