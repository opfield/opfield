import { AppError } from '@/middleware/error-handler.js';

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

  requireEnabled(): void {
    if (!this.isEnabled()) {
      throw new AppError(503, 'LOGGING_DISABLED', 'External logging is disabled');
    }
  }

  requireAvailableForStorage(): void {
    this.requireEnabled();
    if (!this.available) {
      throw new AppError(503, 'LOGGING_UNAVAILABLE', 'External logging storage is unavailable');
    }
  }

  requireAvailableForIngest(): void {
    this.requireAvailableForStorage();
    if (this.capacityExhausted) {
      throw new AppError(
        507,
        'LOGGING_CAPACITY_EXHAUSTED',
        this.capacityReason ?? 'External logging storage capacity is exhausted'
      );
    }
  }
}
