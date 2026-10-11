import { EventEmitter } from 'node:events';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { CacheService } from '@/services/cache.service.js';
import type { ManagedStorageMetricsProvider } from './managed-storage-metrics-provider.js';
import type {
  ObjectStorageConnectionView,
  ObjectStorageHealthStatus,
  ObjectStorageService,
} from './object-storage.service.js';
export interface StorageMetricSnapshot {
  timestamp: string;
  storageId: string;
  provider: string;
  name: string;
  status: ObjectStorageHealthStatus;
  responseMs: number;
  metrics: Record<string, number | null>;
}
export class ObjectStorageMonitoringService extends EventEmitter {
  constructor(
    _storageService: ObjectStorageService,
    _cacheService: CacheService | null,
    _managedMetrics?: ManagedStorageMetricsProvider | undefined
  ) {
    super();
  }
  async getHistory(_storageId: string): Promise<StorageMetricSnapshot[]> {
    return commercialModuleUnavailable();
  }
  async getInitialHistory(_connection: ObjectStorageConnectionView): Promise<StorageMetricSnapshot[]> {
    return commercialModuleUnavailable();
  }
  /**
   * Overview series for app monitoring: per storage connection, samples over `range` (oldest first, any spacing),
   * each with the metrics of getHistory (bucket_count, disk_used_bytes, disk_total_bytes, network_rx_bytes,
   * network_tx_bytes, object_count when known). Implemented by the commercial core.
   */
  async getOverviewSeries(
    _storageIds: readonly string[],
    _range: '1h' | '24h'
  ): Promise<Record<string, StorageMetricSnapshot[]>> {
    return commercialModuleUnavailable();
  }
  registerClient(_storageId: string): void {
    commercialModuleUnavailable();
  }
  unregisterClient(_storageId: string): void {}
  destroy(): void {}
}
