import { describe, expect, it, vi } from 'vitest';
import { OpfieldLifecycleService } from './opfield-lifecycle.service.js';
import { RESUMABLE_WORK_GRACE_MS, ShutdownCoordinator, type ShutdownHooks } from './shutdown-coordinator.service.js';

const never = () => new Promise<never>(() => undefined);

function stop(hooks: Partial<ShutdownHooks>, userRequestDrainSeconds = 30) {
  const lifecycle = new OpfieldLifecycleService();
  // A synchronous deploy request in flight: it ends only when its orchestration does.
  vi.spyOn(lifecycle, 'getActiveCount').mockImplementation((trafficClass) => (trafficClass === 'user' ? 1 : 0));
  vi.spyOn(lifecycle, 'waitForZero').mockImplementation(async (trafficClass) =>
    trafficClass === 'user' ? never() : true
  );
  vi.spyOn(lifecycle, 'forceClose');
  const exited = new Promise<{ code: number; afterMs: number }>((resolve) => {
    const startedAt = Date.now();
    const coordinator = new ShutdownCoordinator({
      lifecycle,
      getSettings: () => ({ userRequestDrainSeconds, structuredLogDrainSeconds: 5, finalizationTimeoutSeconds: 10 }),
      hooks: {
        freezeStatusPage: async () => undefined,
        quiesce: async () => undefined,
        drainUserWork: never,
        drainOrchestration: never,
        forceCloseUserWork: async () => undefined,
        closeLogging: async () => undefined,
        closeHttp: async () => undefined,
        finalize: async () => undefined,
        closeApplicationLogger: async () => undefined,
        ...hooks,
      },
      exit: (code) => resolve({ code, afterMs: Date.now() - startedAt }),
    });
    void coordinator.request('SIGTERM');
  });
  return { lifecycle, exited };
}

describe('ShutdownCoordinator with running orchestration', () => {
  it('stops in seconds when only resumable orchestration and the request waiting for it remain', async () => {
    const abandonResumableWork = vi.fn();
    const { lifecycle, exited } = stop({ resumableWorkOnly: async () => true, abandonResumableWork });

    const { code, afterMs } = await exited;

    expect(code).toBe(0);
    expect(afterMs).toBeGreaterThanOrEqual(RESUMABLE_WORK_GRACE_MS - 50);
    expect(afterMs).toBeLessThan(RESUMABLE_WORK_GRACE_MS + 1_500);
    expect(abandonResumableWork).toHaveBeenCalledTimes(1);
    // The request waiting for the deploy is closed at once instead of at the drain deadline.
    expect(lifecycle.forceClose).toHaveBeenCalledWith('user');
  });

  it('keeps waiting for other user work up to the drain deadline', async () => {
    const abandonResumableWork = vi.fn();
    const { exited } = stop({ resumableWorkOnly: async () => false, abandonResumableWork }, 3);

    const { code, afterMs } = await exited;

    expect(code).toBe(0);
    expect(afterMs).toBeGreaterThanOrEqual(2_900);
    expect(abandonResumableWork).not.toHaveBeenCalled();
  });
});
