import { calculateRetryDelayMs, sleep } from './retry.js';
import type { OpfieldTransport } from './transport.js';
import type {
  NormalizedOpfieldLogEvent,
  OpfieldLog,
  OpfieldLogDropReason,
  OpfieldLogFailureInfo,
  OpfieldLogFailureReason,
  OpfieldRetryOptions,
} from './types.js';

export interface OpfieldLogQueueOptions {
  transport: OpfieldTransport;
  maxBatchSize: number;
  flushIntervalMs: number;
  flushDebounceMs: number;
  maxQueueSize: number;
  overflow: 'drop-oldest' | 'drop-newest';
  retry: Required<OpfieldRetryOptions>;
  onError?: (error: unknown, logs?: readonly OpfieldLog[], failure?: OpfieldLogFailureInfo) => void;
  onDrop?: (log: OpfieldLog, reason: OpfieldLogDropReason) => void;
  onFallback?: (logs: readonly OpfieldLog[], failure: OpfieldLogFailureInfo) => void | Promise<void>;
}

/** How long the queue sends nothing after Opfield answered that logging is disabled there. */
export const LOGGING_DISABLED_PAUSE_MS = 60_000;

export class OpfieldLogQueue {
  private readonly events: NormalizedOpfieldLogEvent[] = [];
  private debounceTimer: NodeJS.Timeout | undefined;
  private intervalTimer: NodeJS.Timeout | undefined;
  private flushInFlight: Promise<void> | undefined;
  private closed = false;
  /** Set while logging is disabled on the Opfield: batches fail at once with this refusal instead of being sent. */
  private pause: { until: number; error: unknown; status?: number } | undefined;

  constructor(private readonly options: OpfieldLogQueueOptions) {
    this.intervalTimer = setInterval(() => {
      void this.flush();
    }, options.flushIntervalMs);
    this.intervalTimer.unref?.();
  }

  enqueue(event: NormalizedOpfieldLogEvent): void {
    if (this.closed) {
      this.options.onDrop?.(event, 'closed');
      return;
    }

    if (this.events.length >= this.options.maxQueueSize) {
      if (this.options.overflow === 'drop-oldest') {
        const dropped = this.events.shift();
        if (dropped) this.options.onDrop?.(dropped, 'queue_full');
      } else {
        this.options.onDrop?.(event, 'queue_full');
        return;
      }
    }

    this.events.push(event);

    if (this.events.length >= this.options.maxBatchSize) {
      this.scheduleFlush(0);
      return;
    }

    this.scheduleFlush(this.options.flushDebounceMs);
  }

  async flush(): Promise<void> {
    if (this.flushInFlight) return this.flushInFlight;
    this.clearDebounceTimer();
    this.flushInFlight = this.flushLoop().finally(() => {
      this.flushInFlight = undefined;
    });
    return this.flushInFlight;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearDebounceTimer();
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.intervalTimer = undefined;
    await this.flush();
  }

  private scheduleFlush(delayMs: number): void {
    this.clearDebounceTimer();
    this.debounceTimer = setTimeout(() => {
      void this.flush();
    }, delayMs);
    this.debounceTimer.unref?.();
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
  }

  private async flushLoop(): Promise<void> {
    while (this.events.length > 0) {
      const batch = this.events.splice(0, this.options.maxBatchSize);
      const pause = this.pause && Date.now() < this.pause.until ? this.pause : undefined;
      // Logging stays off until an administrator turns it on: fail the batch (onError, onFallback) without asking.
      if (pause) await this.handleDeliveryFailure(batch, 'permanent_failure', pause.error, pause.status);
      else await this.sendWithRetry(batch);
    }
  }

  private async sendWithRetry(batch: NormalizedOpfieldLogEvent[]): Promise<void> {
    for (let attempt = 1; attempt <= this.options.retry.maxAttempts; attempt += 1) {
      const result = await this.options.transport.send(batch);
      if (result.ok) return;

      // Retrying cannot help while logging is disabled, and every retry held up flush and close: refuse for a while.
      if (isLoggingDisabled(result.error)) {
        this.pause = { until: Date.now() + LOGGING_DISABLED_PAUSE_MS, error: result.error, status: result.status };
        await this.handleDeliveryFailure(batch, 'permanent_failure', result.error, result.status);
        return;
      }

      if (!result.retryable) {
        await this.handleDeliveryFailure(batch, 'permanent_failure', result.error, result.status);
        return;
      }

      if (attempt >= this.options.retry.maxAttempts) {
        await this.handleDeliveryFailure(batch, 'retry_exhausted', result.error, result.status);
        return;
      }

      const delayMs =
        result.retryAfterMs ??
        calculateRetryDelayMs({
          attempt,
          minDelayMs: this.options.retry.minDelayMs,
          maxDelayMs: this.options.retry.maxDelayMs,
          jitter: this.options.retry.jitter,
        });
      await sleep(delayMs);
    }
  }

  private dropBatch(batch: NormalizedOpfieldLogEvent[], reason: OpfieldLogDropReason): void {
    for (const event of batch) this.options.onDrop?.(event, reason);
  }

  private async handleDeliveryFailure(
    batch: NormalizedOpfieldLogEvent[],
    reason: OpfieldLogFailureReason,
    error: unknown,
    status: number | undefined
  ): Promise<void> {
    const logs = [...batch];
    const failure: OpfieldLogFailureInfo = {
      reason,
      error,
      status,
    };
    this.dropBatch(batch, reason);
    this.options.onError?.(error, logs, failure);
    if (!this.options.onFallback) return;

    try {
      await this.options.onFallback(logs, failure);
    } catch (fallbackError) {
      this.options.onError?.(fallbackError, logs, failure);
    }
  }
}

function isLoggingDisabled(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && (payload as { code?: unknown }).code === 'LOGGING_DISABLED';
}
