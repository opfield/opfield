import { EventEmitter } from 'node:events';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { NotificationEvaluatorService } from '@/modules/notifications/notification-evaluator.service.js';
import type { CacheService } from '@/services/cache.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { DatabaseConnectionService, DatabaseHealthStatus, DatabaseType } from './databases.service.js';
import type { ManagedDatabaseService } from './managed-databases.service.js';
export interface DatabaseMetricSnapshot {
  timestamp: string;
  databaseId: string;
  type: DatabaseType;
  name: string;
  status: DatabaseHealthStatus;
  responseMs: number;
  metrics: Record<string, number | null>;
}
export class DatabaseMonitoringService extends EventEmitter {
  constructor(
    _databaseService: DatabaseConnectionService,
    _cacheService: CacheService | null,
    _managedDatabaseService?: ManagedDatabaseService | undefined
  ) {
    super();
  }
  setEvaluator(_evaluator: NotificationEvaluatorService): void {}
  setEventBus(_eventBus: EventBusService): void {}
  start(): void {}
  async getHistory(_databaseId: string): Promise<DatabaseMetricSnapshot[]> {
    return commercialModuleUnavailable();
  }
  /**
   * Overview series for app monitoring: per database, samples over `range` (oldest first, any spacing; the caller
   * buckets them), each with the metrics of getHistory (database_size_bytes, total_connections, max_connections,
   * transaction_rate, ...). Implemented by the commercial core.
   */
  async getOverviewSeries(
    _databaseIds: readonly string[],
    _range: '1h' | '24h'
  ): Promise<Record<string, DatabaseMetricSnapshot[]>> {
    return commercialModuleUnavailable();
  }
  registerClient(_databaseId: string): void {
    commercialModuleUnavailable();
  }
  unregisterClient(_databaseId: string): void {}
  destroy(): void {}
}
