import { AppError } from '@/middleware/error-handler.js';

/**
 * How long a log producer waits before it retries a batch the ingest refused. It equals the SDK's longest own retry
 * delay, so a producer's flush and close take no longer than before while logging stays off or unavailable.
 */
export const LOGGING_INGEST_RETRY_AFTER_SECONDS = 30;

interface LoggingConfigurationSource {
  isConfigured(): boolean;
}

export class LoggingFeatureService {
  private available = false;
  private unavailableReason: string | null = null;
  private capacityExhausted = false;
  private capacityReason: string | null = null;

  constructor(private readonly source: LoggingConfigurationSource) {}

  isEnabled(): boolean {
    return this.source.isConfigured();
  }

  isAvailable(): boolean {
    return this.isEnabled() && this.available;
  }

  markAvailable(): void {
    this.available = true;
    this.unavailableReason = null;
  }

  markUnavailable(reason: string): void {
    this.available = false;
    this.unavailableReason = reason;
  }

  markCapacityAvailable(): void {
    this.capacityExhausted = false;
    this.capacityReason = null;
  }

  markCapacityExhausted(reason: string): void {
    this.capacityExhausted = true;
    this.capacityReason = reason;
  }

  getStatus(): {
    enabled: boolean;
    available: boolean;
    unavailableReason: string | null;
    capacityExhausted: boolean;
    capacityReason: string | null;
  } {
    return {
      enabled: this.isEnabled(),
      available: this.isAvailable(),
      unavailableReason: this.unavailableReason,
      capacityExhausted: this.capacityExhausted,
      capacityReason: this.capacityReason,
    };
  }

  requireEnabled(details?: unknown): void {
    if (!this.isEnabled()) {
      throw new AppError(503, 'LOGGING_DISABLED', 'External logging is disabled', details);
    }
  }

  requireAvailableForStorage(details?: unknown): void {
    this.requireEnabled(details);
    if (!this.available) {
      throw new AppError(503, 'LOGGING_UNAVAILABLE', 'External logging storage is unavailable', details);
    }
  }

  requireAvailableForIngest(): void {
    // Producers keep sending while ingest is refused: have them back off instead of retrying every batch at once.
    const backOff = { retryAfterSeconds: LOGGING_INGEST_RETRY_AFTER_SECONDS };
    this.requireAvailableForStorage(backOff);
    if (this.capacityExhausted) {
      throw new AppError(
        507,
        'LOGGING_CAPACITY_EXHAUSTED',
        this.capacityReason ?? 'External logging storage capacity is exhausted',
        backOff
      );
    }
  }
}
