import { describe, expect, it, vi } from 'vitest';
import { OpfieldLogQueue } from './queue.js';
import type { NormalizedOpfieldLogEvent } from './types.js';

describe('OpfieldLogQueue while logging is disabled', () => {
  it('asks once, then fails batches to the fallback without sending or retrying', async () => {
    const send = vi.fn().mockResolvedValue({
      ok: false,
      retryable: true,
      rateLimited: false,
      status: 503,
      error: { code: 'LOGGING_DISABLED' },
    });
    const onFallback = vi.fn();
    const queue = new OpfieldLogQueue({
      transport: { send },
      maxBatchSize: 100,
      flushIntervalMs: 60_000,
      flushDebounceMs: 60_000,
      maxQueueSize: 1_000,
      overflow: 'drop-oldest',
      retry: { maxAttempts: 5, minDelayMs: 500, maxDelayMs: 30_000, jitter: false },
      onFallback,
    });
    for (let index = 0; index < 250; index += 1) {
      queue.enqueue({ message: `log ${index}` } as NormalizedOpfieldLogEvent);
    }

    await queue.close();
    // One request, no retry; every log reached the fallback as refused.
    expect(send).toHaveBeenCalledOnce();
    expect(onFallback.mock.calls.flatMap(([logs]) => logs)).toHaveLength(250);
    expect(onFallback.mock.calls.every(([, failure]) => failure.reason === 'permanent_failure')).toBe(true);
  });
});
