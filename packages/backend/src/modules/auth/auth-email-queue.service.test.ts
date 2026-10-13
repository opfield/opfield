import { afterEach, describe, expect, it, vi } from 'vitest';

const bull = vi.hoisted(() => ({
  workerClose: vi.fn(),
  workerDisconnect: vi.fn(async () => undefined),
  queueClose: vi.fn(),
  queueDisconnect: vi.fn(async () => undefined),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    close = bull.queueClose;
    disconnect = bull.queueDisconnect;
  },
  Worker: class {
    close = bull.workerClose;
    disconnect = bull.workerDisconnect;
    on() {
      return this;
    }
  },
}));

const { AUTH_EMAIL_QUEUE_CLOSE_WAIT_MS, AuthEmailQueueService } = await import('./auth-email-queue.service.js');

function service() {
  const workerConnection = { disconnect: vi.fn(), quit: vi.fn(() => new Promise(() => undefined)) };
  const redis = { duplicate: () => workerConnection };
  const queue = new AuthEmailQueueService(redis as never, {} as never);
  queue.start(async () => undefined);
  return { queue, workerConnection };
}

describe('AuthEmailQueueService.close', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('does not hold the shutdown when Redis is gone (O-R1)', async () => {
    vi.useFakeTimers();
    // BullMQ waits for Redis to come back.
    bull.workerClose.mockReturnValue(new Promise(() => undefined));
    bull.queueClose.mockReturnValue(new Promise(() => undefined));
    const { queue, workerConnection } = service();
    let done = false;
    const closing = queue.close().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(AUTH_EMAIL_QUEUE_CLOSE_WAIT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(bull.workerDisconnect).toHaveBeenCalled();
    expect(bull.queueDisconnect).toHaveBeenCalled();
    expect(workerConnection.disconnect).toHaveBeenCalled();
    expect(workerConnection.quit).not.toHaveBeenCalled();
  });

  it('closes normally while Redis answers', async () => {
    bull.workerClose.mockResolvedValue(undefined);
    bull.queueClose.mockResolvedValue(undefined);
    const { queue, workerConnection } = service();
    await queue.close();
    expect(bull.workerDisconnect).not.toHaveBeenCalled();
    expect(bull.queueDisconnect).not.toHaveBeenCalled();
    expect(workerConnection.disconnect).toHaveBeenCalled();
  });
});
