import 'reflect-metadata';
import '@/db/schema/index.js';
import { describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import type { InferenceBudgetLockService } from './inference-budget-lock.service.js';
import type { InferenceBudgetReservationService } from './inference-budget-reservation.service.js';
import { InferenceReservationReconciler } from './inference-reservation-reconciler.js';

const request = { id: 'request-1', userId: 'user-1', status: 'running', budgetType: 'api', startedAt: new Date(0) };

function reconciler(active: string[]) {
  const update = vi.fn(() => {
    throw new Error('a live request was written');
  });
  const rows = (result: unknown[]) => ({ from: () => ({ where: async () => result }) });
  const db = { select: () => rows([request]) } as unknown as DrizzleClient;
  const database = { select: () => rows([{ reservationId: 'request-1:attempt-1' }]), update };
  const locks = {
    withUserLock: (_userId: string, work: (tx: unknown) => Promise<void>) => work(database),
  } as unknown as InferenceBudgetLockService;
  const reservations = {
    isActive: vi.fn(async ({ id }: { id: string }) => active.includes(id)),
  } as unknown as InferenceBudgetReservationService;
  return { service: new InferenceReservationReconciler(db, reservations, locks), update };
}

describe('reservation reconciliation', () => {
  it('leaves a long request alone while its attempt still holds a reservation', async () => {
    const { service, update } = reconciler(['request-1:attempt-1']);
    await service.reconcile(new Date(60 * 60_000));
    expect(update).not.toHaveBeenCalled();
  });

  it('settles a request nothing holds any more', async () => {
    const { service, update } = reconciler([]);
    await expect(service.reconcile(new Date(60 * 60_000))).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledOnce();
  });
});
