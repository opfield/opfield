import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { EnvironmentSettings } from '@/modules/settings/environment-settings.schemas.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { CreateLoggingEnvironmentInput, UpdateLoggingEnvironmentInput } from './logging.schemas.js';
import type { LoggingClickHouseService } from './logging-clickhouse.service.js';
import type { LoggingEnvironmentView } from './logging-storage.types.js';
export class LoggingEnvironmentService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(
    _db: DrizzleClient,
    _auditService: AuditService,
    _storage?: Pick<LoggingClickHouseService, 'deleteEnvironmentLogs'> | undefined,
    _getLimits?: () => EnvironmentSettings['loggingIngest']
  ) {}
  setEventBus(_eventBus: EventBusService): void {}
  setLicensePolicyService(_service: LicensePolicyService): void {}
  async list(_query?: {
    search?: string;
    allowedIds?: string[];
    appId?: string | null;
    excludeAppMembers?: boolean;
  }): Promise<LoggingEnvironmentView[]> {
    return [];
  }
  async get(_id: string): Promise<LoggingEnvironmentView> {
    return commercialModuleUnavailable();
  }
  async getBySlug(_slug: string): Promise<LoggingEnvironmentView> {
    return commercialModuleUnavailable();
  }
  async create(_input: CreateLoggingEnvironmentInput, _userId: string): Promise<LoggingEnvironmentView> {
    return commercialModuleUnavailable();
  }
  async update(_id: string, _input: UpdateLoggingEnvironmentInput, _userId: string): Promise<LoggingEnvironmentView> {
    return commercialModuleUnavailable();
  }
  async delete(_id: string, _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async getEnabledForToken(_environmentId: string): Promise<LoggingEnvironmentView | null> {
    return commercialModuleUnavailable();
  }
}
