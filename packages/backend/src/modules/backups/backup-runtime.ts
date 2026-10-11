import { OpenAPIHono, z } from '@hono/zod-openapi';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import cron from 'node-cron';
import { resolveBackupRunnerImage } from '@/config/backup-runner-image.js';
import { container } from '@/container.js';
import {
  backupPolicies,
  backupRunNodeLeases,
  backupRuns,
  databaseConnections,
  managedDatabaseInstances,
  managedStorageAccessKeys,
  managedStorageBindings,
  managedStorageClusters,
  nodes,
  objectStorageConnections,
  storageCopyJobs,
} from '@/db/schema/index.js';
import {
  appRoute,
  createdJson,
  IdParamSchema,
  jsonBody,
  okJson,
  openApiValidationHook,
  UnknownDataResponseSchema,
} from '@/lib/openapi.js';
import { hasScope, hasScopeForCreation, hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { appsHostRuntime } from '@/modules/apps/apps-host-runtime.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { authMiddleware, requireScopeForResource } from '@/modules/auth/auth.middleware.js';
import { resolveLiveUser } from '@/modules/auth/live-session-user.js';
import { DatabaseFolderService } from '@/modules/databases/database-folders.service.js';
import { CreateManagedDatabaseSchema } from '@/modules/databases/databases.schemas.js';
import { DatabaseConnectionService } from '@/modules/databases/databases.service.js';
import { ManagedDatabaseService } from '@/modules/databases/managed-databases.service.js';
import { ObjectStorageService } from '@/modules/object-storage/object-storage.service.js';
import { StartStorageCopyJobSchema, StorageCopyJobListQuerySchema } from '@/modules/storage/storage-copy.schemas.js';
import { StorageCopyService } from '@/modules/storage/storage-copy.service.js';
import { STORAGE_COPY_CAPABILITY } from '@/modules/storage/storage-copy.types.js';
import { findFrozenManagedStorage, storageWritesFrozenError } from '@/modules/storage/storage-write-freeze.js';
import { CryptoService } from '@/services/crypto.service.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { StorageCAService } from '@/services/storage-ca.service.js';
import { SystemCertificateRenewalService } from '@/services/system-certificate-renewal.service.js';
import { BackupService } from './backups.service.js';

/** Existing host instances and DTO constructors shared with the private backup domain. */
export const backupRuntime = {
  /** Apps: node allowlist guard, `app` field and list filters (see apps-host-runtime.ts). */
  apps: appsHostRuntime,
  OpenAPIHono,
  z,
  and,
  asc,
  desc,
  eq,
  inArray,
  or,
  sql,
  cron,
  container,
  backupPolicies,
  backupRunNodeLeases,
  backupRuns,
  databaseConnections,
  managedDatabaseInstances,
  nodes,
  objectStorageConnections,
  storageCopyJobs,
  managedStorageClusters,
  managedStorageBindings,
  managedStorageAccessKeys,
  appRoute,
  createdJson,
  IdParamSchema,
  jsonBody,
  okJson,
  openApiValidationHook,
  UnknownDataResponseSchema,
  hasScope,
  hasScopeForCreation,
  hasScopeForResource,
  AppError,
  authMiddleware,
  requireScopeForResource,
  resolveLiveUser,
  CreateManagedDatabaseSchema,
  DatabaseFolderService,
  BackupService,
  DatabaseConnectionService,
  ManagedDatabaseService,
  ObjectStorageService,
  AuditService,
  CryptoService,
  NodeDispatchService,
  StorageCAService,
  SystemCertificateRenewalService,
  resolveBackupRunnerImage,
  StorageCopyService,
  STORAGE_COPY_CAPABILITY,
  findFrozenManagedStorage,
  storageWritesFrozenError,
  StartStorageCopyJobSchema,
  StorageCopyJobListQuerySchema,
};
