import { and, asc, desc, eq, inArray, isNotNull, isNull, like, ne, sql } from 'drizzle-orm';
import { DEVELOPMENT_SECURE_LINK_CONNECTOR_IMAGE } from '@/config/env.js';
import {
  auditLog,
  managedAvailabilityMembers,
  managedAvailabilitySets,
  managedAvailabilityWitnesses,
  managedDatabaseBindings,
  managedStorageBindings,
  relayInstances,
} from '@/db/schema/index.js';
import {
  managedStorageAccessKeys,
  managedStorageClusterMembers,
  managedStorageClusters,
} from '@/db/schema/managed-storage.js';
import { nodes } from '@/db/schema/nodes.js';
import { objectStorageConnections } from '@/db/schema/object-storage.js';
import { proxyAdditionalSecureLinks } from '@/db/schema/proxy-additional-secure-links.js';
import { grantCreatedResourcePermissions } from '@/lib/created-resource-permissions.js';
import { createChildLogger } from '@/lib/logger.js';
import { transactionWithScopeCleanup } from '@/lib/resource-scope-cleanup.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { isGatewayInternalContainer } from '@/modules/docker/docker-internal-containers.js';
import { requireConfiguredLicensePolicy } from '@/modules/license/license-policy.service.js';
import {
  assertStorageHasNoBackupReferences,
  forgetStorageBackupHistory,
  rehomeStorageBackupHistory,
} from '@/modules/object-storage/storage-backup-references.js';
import { relayMayHostWitnesses } from '@/services/relay-witness-hosting.js';

const loggerManagedStorage = createChildLogger('ManagedStorage');
const loggerManagedStorageTunnelProxy = createChildLogger('ManagedStorageTunnelProxy');
const loggerManagedStorageBindings = createChildLogger('ManagedStorageBindings');

export type { ManagedStorageBindingRow, StorageBindingEnvironment } from '@/db/schema/index.js';
export type { ManagedStorageClusterMemberRow, ManagedStorageClusterRow } from '@/db/schema/managed-storage.js';
export type { LicensePolicyService } from '@/modules/license/license-policy.service.js';

import { ManagedStorageMetricsProvider } from '@/modules/object-storage/managed-storage-metrics-provider.js';
import { ManagedStorageService } from './managed-storage.service.js';
import { ManagedStorageBindingsService } from './managed-storage-bindings.service.js';
import { ManagedStorageTunnelProxy } from './managed-storage-tunnel-proxy.js';
import { StorageClusterMemberStore } from './storage-cluster-member-store.js';
import { StorageWorkloadDispatch } from './storage-workload-dispatch.js';
import { StorageWorkloadProvider } from './storage-workload-provider.js';
import { StorageWorkloadStore } from './storage-workload-store.js';
import { backupWritesTo } from './storage-write-freeze.js';
export const managedStorageConstructors = {
  ManagedStorageMetricsProvider,
  ManagedStorageService,
  ManagedStorageTunnelProxy,
  StorageClusterMemberStore,
  ManagedStorageBindingsService,
  StorageWorkloadProvider,
  StorageWorkloadStore,
  StorageWorkloadDispatch,
};
export type ManagedStorageConstructors = typeof managedStorageConstructors;
export const managedStorageRuntime = {
  constructors: managedStorageConstructors,
  and,
  asc,
  eq,
  isNull,
  ne,
  managedStorageAccessKeys,
  managedStorageClusters,
  nodes,
  objectStorageConnections,
  proxyAdditionalSecureLinks,
  createChildLogger,
  writeWithAllocatedSlug,
  requireConfiguredLicensePolicy,
  assertStorageHasNoBackupReferences,
  forgetStorageBackupHistory,
  loggerManagedStorage,
  loggerManagedStorageTunnelProxy,
  managedStorageClusterMembers,
  DEVELOPMENT_SECURE_LINK_CONNECTOR_IMAGE,
  managedDatabaseBindings,
  managedStorageBindings,
  isGatewayInternalContainer,
  loggerManagedStorageBindings,
  grantCreatedResourcePermissions,
  transactionWithScopeCleanup,
  isNotNull,
  inArray,
  rehomeStorageBackupHistory,
  backupWritesTo,
  // Storage availability sets (commercial storage/availability).
  desc,
  like,
  sql,
  auditLog,
  managedAvailabilitySets,
  managedAvailabilityMembers,
  managedAvailabilityWitnesses,
  relayInstances,
  relayMayHostWitnesses,
};
