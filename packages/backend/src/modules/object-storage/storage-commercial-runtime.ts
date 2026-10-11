import { asc, count, eq, ilike, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import { appsHostRuntime } from '@/modules/apps/apps-host-runtime.js';

export type { infer as ZodInfer } from 'zod';

import { createChildLogger } from '@/lib/logger.js';
import { hasScopeForResource } from '@/lib/permissions.js';
import { ObjectMetadataQuerySchema } from './object-storage.schemas.js';

export type { SQL } from 'drizzle-orm';

import { managedStorageClusters, objectStorageConnections } from '@/db/schema/index.js';
import { grantCreatedResourcePermissions } from '@/lib/created-resource-permissions.js';
import { compactHealthHistory } from '@/lib/health-history.js';
import { transactionWithScopeCleanup } from '@/lib/resource-scope-cleanup.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { buildWhere } from '@/lib/utils.js';
import { storageWritesFrozenError } from '@/modules/storage/storage-write-freeze.js';
import { isFileProtocolConfig, toObjectStorageConnectionView } from './object-storage-connection-view.js';
import { isStorageWarmupError, mapObjectStorageError } from './object-storage-error-mapping.js';
import { isFileProtocolProvider, resolveFileProtocolPort } from './object-storage-protocol.js';
import {
  assertStorageBucketHasNoBackupReferences,
  assertStorageHasNoBackupReferences,
  forgetOrphanedBucketBackupHistory,
  forgetStorageBackupHistory,
} from './storage-backup-references.js';

/** Shared schema and resource primitives retain the host's runtime identity. */
export const storageCommercialRuntime = {
  /** Apps: node allowlist guard, `app` field and list filters (see apps-host-runtime.ts). */
  apps: appsHostRuntime,
  z,
  createChildLogger,
  hasScopeForResource,
  ObjectMetadataQuerySchema,
  asc,
  count,
  eq,
  ilike,
  inArray,
  or,
  managedStorageClusters,
  objectStorageConnections,
  grantCreatedResourcePermissions,
  transactionWithScopeCleanup,
  compactHealthHistory,
  writeWithAllocatedSlug,
  buildWhere,
  isFileProtocolConfig,
  toObjectStorageConnectionView,
  isStorageWarmupError,
  mapObjectStorageError,
  isFileProtocolProvider,
  resolveFileProtocolPort,
  assertStorageHasNoBackupReferences,
  assertStorageBucketHasNoBackupReferences,
  forgetOrphanedBucketBackupHistory,
  forgetStorageBackupHistory,
  storageWritesFrozenError,
};
