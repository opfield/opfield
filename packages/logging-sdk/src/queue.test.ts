import { describe, expect, it, vi } from 'vitest';
import { OpfieldLogQueue } from './queue.js';
import type { NormalizedOpfieldLogEvent } from './types.js';

describe('OpfieldLogQueue while logging is disabled', () => {
  it('stops sending after the first refusal and drops what is left on close', async () => {
    const send = vi.fn().mockResolvedValue({
      ok: false,
      retryable: false,
      rateLimited: false,
      status: 409,
      error: { code: 'LOGGING_DISABLED' },
    });
    const onDrop = vi.fn();
    const queue = new OpfieldLogQueue({
      transport: { send },
      maxBatchSize: 100,
      flushIntervalMs: 60_000,
      flushDebounceMs: 60_000,
      maxQueueSize: 1_000,
      overflow: 'drop-oldest',
      retry: { maxAttempts: 5, minDelayMs: 500, maxDelayMs: 30_000, jitter: false },
      onDrop,
    });
    for (let index = 0; index < 250; index += 1)
      queue.enqueue({ message: `log ${index}` } as NormalizedOpfieldLogEvent);

    await queue.flush();
    await queue.flush();
    // One refused batch, no retry and no further batches while paused.
    expect(send).toHaveBeenCalledOnce();

    await queue.close();
    expect(send).toHaveBeenCalledOnce();
    expect(onDrop.mock.calls.filter(([, reason]) => reason === 'closed')).toHaveLength(150);
  });
});
