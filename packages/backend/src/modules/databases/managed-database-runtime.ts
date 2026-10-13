import { and, asc, desc, eq, inArray, isNotNull, isNull, like, ne, or, sql } from 'drizzle-orm';
import {
  auditLog,
  databaseConnections,
  managedAvailabilityMembers,
  managedAvailabilitySets,
  managedAvailabilityWitnesses,
  managedDatabaseBindingPlacements,
  managedDatabaseBindings,
  managedDatabaseInstances,
  managedStorageBindings,
  nodes,
  relayInstances,
} from '@/db/schema/index.js';
import { grantCreatedResourcePermissions } from '@/lib/created-resource-permissions.js';
import { createChildLogger } from '@/lib/logger.js';
import { hasScope } from '@/lib/permissions.js';
import { transactionWithScopeCleanup } from '@/lib/resource-scope-cleanup.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { appsHostRuntime } from '@/modules/apps/apps-host-runtime.js';
import { decodeComposeServiceTarget } from '@/modules/docker/compose/compose-managed-bindings.js';
import { assertDockerResourceScope } from '@/modules/docker/docker-access.middleware.js';
import { resolveBindingTargetContainerIdentity } from '@/modules/docker/docker-binding-target-identity.js';
import { isOpfieldInternalContainer } from '@/modules/docker/docker-internal-containers.js';
import { requireConfiguredLicensePolicy } from '@/modules/license/license-policy.service.js';
import { currentWitnessVersion } from '@/modules/managed-workloads/witness-catalog.js';
import {
  KEEPER_MAX_MEMBER_INDEX,
  keeperLoopbackHost,
  memberInterserverPort,
  memberKeeperPort,
  memberKeeperServerId,
} from '@/services/clickhouse-keeper-addressing.js';
import { allocateWitnessPorts } from '@/services/relay-witness.service.js';
import { relayMayHostWitnesses } from '@/services/relay-witness-hosting.js';

const loggerManagedDatabaseService = createChildLogger('ManagedDatabaseService');
const loggerManagedDatabaseBindings = createChildLogger('ManagedDatabaseBindings');
const loggerManagedDatabaseBindingIdentityRuntime = createChildLogger('ManagedDatabaseBindingIdentityRuntime');
const loggerManagedDatabaseAvailability = createChildLogger('ManagedDatabaseAvailability');

export type { managedDatabaseInstances } from '@/db/schema/index.js';
export type { LicensePolicyService } from '@/modules/license/license-policy.service.js';

import { ManagedDatabaseBindingService } from './managed-database-bindings.service.js';
import { ManagedDatabaseTunnelProxy } from './managed-database-tunnel-proxy.js';
import { ManagedDatabaseService } from './managed-databases.service.js';
export const managedDatabaseConstructors = {
  ManagedDatabaseService,
  ManagedDatabaseBindingService,
  ManagedDatabaseTunnelProxy,
};
export type ManagedDatabaseConstructors = typeof managedDatabaseConstructors;
export const managedDatabaseRuntime = {
  /** Apps: node allowlist guard, `app` field and list filters (see apps-host-runtime.ts). */
  apps: appsHostRuntime,
  constructors: managedDatabaseConstructors,
  createChildLogger,
  loggerManagedDatabaseService,
  and,
  eq,
  isNotNull,
  isNull,
  databaseConnections,
  managedDatabaseBindings,
  managedDatabaseInstances,
  grantCreatedResourcePermissions,
  transactionWithScopeCleanup,
  writeWithAllocatedSlug,
  requireConfiguredLicensePolicy,
  asc,
  nodes,
  sql,
  inArray,
  like,
  managedDatabaseBindingPlacements,
  managedStorageBindings,
  hasScope,
  loggerManagedDatabaseBindings,
  isOpfieldInternalContainer,
  loggerManagedDatabaseBindingIdentityRuntime,
  // The workload check of links (ManagedDatabaseBindingService.assertTargetAccess).
  decodeComposeServiceTarget,
  assertDockerResourceScope,
  resolveBindingTargetContainerIdentity,
  // Database availability sets (commercial control plane, databases/availability).
  managedAvailabilitySets,
  managedAvailabilityMembers,
  managedAvailabilityWitnesses,
  relayInstances,
  auditLog,
  ne,
  or,
  desc,
  loggerManagedDatabaseAvailability,
  // ClickHouse availability: Keeper addressing and witness hosting (engine-clickhouse.ts, keeper-witness.ts).
  clickHouseKeeperAddressing: {
    KEEPER_MAX_MEMBER_INDEX,
    keeperLoopbackHost,
    memberKeeperServerId,
    memberKeeperPort,
    memberInterserverPort,
  },
  availabilityWitnessHosting: { currentWitnessVersion, relayMayHostWitnesses, allocateWitnessPorts },
};
