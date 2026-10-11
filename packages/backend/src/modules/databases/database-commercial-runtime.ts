import { createClient } from '@clickhouse/client';
import { asc, count, eq, ilike, inArray, or } from 'drizzle-orm';
import Redis from 'ioredis';
import pg from 'pg';
import { releaseLostCheckedOutClients } from '@/db/checked-out-client-errors.js';
import { databaseConnections, managedDatabaseInstances, nodes } from '@/db/schema/index.js';
import { grantCreatedResourcePermissions } from '@/lib/created-resource-permissions.js';
import { compactHealthHistory } from '@/lib/health-history.js';
import { createChildLogger } from '@/lib/logger.js';
import { transactionWithScopeCleanup } from '@/lib/resource-scope-cleanup.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { buildWhere } from '@/lib/utils.js';
import { appsHostRuntime } from '@/modules/apps/apps-host-runtime.js';
import { getEffectiveNodeServiceAddress, getEffectivePublishedNodeIP } from '@/modules/nodes/node-service-address.js';

const logger = createChildLogger('DatabaseConnectionService');

/** Pools of external databases: a connection lost while a query session holds it fails that session, not Gateway. */
class Pool extends pg.Pool {
  constructor(config?: pg.PoolConfig) {
    super(config);
    releaseLostCheckedOutClients(this);
  }
}

export type { ClickHouseClient } from '@clickhouse/client';
export type { SQL } from 'drizzle-orm';
export type { default as RedisClient } from 'ioredis';
export type { default as pg } from 'pg';
export type { DatabaseHealthEntry } from '@/db/schema/index.js';
export const databaseCommercialRuntime = {
  /** Apps: node allowlist guard, `app` field and list filters (see apps-host-runtime.ts). */
  apps: appsHostRuntime,
  asc,
  count,
  eq,
  ilike,
  inArray,
  or,
  databaseConnections,
  grantCreatedResourcePermissions,
  transactionWithScopeCleanup,
  writeWithAllocatedSlug,
  buildWhere,
  createClient,
  Redis,
  managedDatabaseInstances,
  nodes,
  compactHealthHistory,
  getEffectiveNodeServiceAddress,
  getEffectivePublishedNodeIP,
  createChildLogger,
  Pool,
  logger,
};
