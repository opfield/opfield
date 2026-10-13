import { LocalClickHouseService } from './local-clickhouse.service.js';
import { LoggingClickHouseService } from './logging-clickhouse.service.js';
import { LoggingEnvironmentService } from './logging-environment.service.js';
import { LoggingIngestService } from './logging-ingest.service.js';
import { LoggingMaintenanceService } from './logging-maintenance.service.js';
import { LoggingMetadataService } from './logging-metadata.service.js';
import { LoggingRateLimitService } from './logging-rate-limit.service.js';
import { LoggingRuntimeService } from './logging-runtime.service.js';
import { LoggingSchemaService } from './logging-schema.service.js';
import { LoggingSearchService } from './logging-search.service.js';
import { LoggingTokenService } from './logging-token.service.js';
import { LoggingValidationService } from './logging-validation.service.js';

const constructors = {
  LoggingClickHouseService,
  LocalClickHouseService,
  LoggingRuntimeService,
  LoggingMaintenanceService,
  LoggingEnvironmentService,
  LoggingTokenService,
  LoggingSchemaService,
  LoggingValidationService,
  LoggingRateLimitService,
  LoggingMetadataService,
  LoggingIngestService,
  LoggingSearchService,
};
export type LoggingConstructors = typeof constructors;

import { createClient } from '@clickhouse/client';
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { loggingEnvironments, loggingIngestTokens, loggingMetadata, loggingSchemas } from '@/db/schema/index.js';
import { grantCreatedResourcePermissions } from '@/lib/created-resource-permissions.js';
import { createChildLogger, logger } from '@/lib/logger.js';
import { RATE_LIMIT_REDIS_TIMEOUT_MS, withRateLimitRedisTimeout } from '@/lib/rate-limit-timeout.js';
import { transactionWithScopeCleanup } from '@/lib/resource-scope-cleanup.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { AppError } from '@/middleware/error-handler.js';
import { appsHostRuntime } from '@/modules/apps/apps-host-runtime.js';
import {
  hasConfiguredLicenseFeatureForExistingRuntime,
  requireConfiguredLicensePolicy,
} from '@/modules/license/license-policy.service.js';
import { LoggingEventSchema } from '@/modules/logging/logging.schemas.js';
import { LoggingFeatureService } from '@/modules/logging/logging-feature.service.js';
import { SEVERITY_NUMBER } from '@/modules/logging/logging-storage.types.js';
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  getEnvironmentSettingsSnapshot,
} from '@/modules/settings/environment-settings.service.js';

const loggerLoggingClickHouse = createChildLogger('LoggingClickHouse');
const loggerLocalClickHouse = createChildLogger('LocalClickHouse');
const loggerLoggingMaintenance = createChildLogger('LoggingMaintenance');
const loggerLoggingRateLimit = createChildLogger('LoggingRateLimit');
export const loggingCommercialRuntime = {
  constructors,
  createClient,
  createChildLogger,
  AppError,
  hasConfiguredLicenseFeatureForExistingRuntime,
  requireConfiguredLicensePolicy,
  and,
  asc,
  eq,
  ilike,
  inArray,
  or,
  loggingEnvironments,
  loggingSchemas,
  grantCreatedResourcePermissions,
  transactionWithScopeCleanup,
  writeWithAllocatedSlug,
  getEnvironmentSettingsSnapshot,
  desc,
  loggingIngestTokens,
  LoggingEventSchema,
  SEVERITY_NUMBER,
  withRateLimitRedisTimeout,
  sql,
  loggingMetadata,
  logger,
  LoggingFeatureService,
  DEFAULT_ENVIRONMENT_SETTINGS,
  RATE_LIMIT_REDIS_TIMEOUT_MS,
  loggerLoggingClickHouse,
  loggerLocalClickHouse,
  loggerLoggingMaintenance,
  loggerLoggingRateLimit,
  apps: appsHostRuntime,
};
