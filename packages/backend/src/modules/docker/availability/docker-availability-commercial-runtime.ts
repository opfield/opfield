import { appsHostRuntime } from '@/modules/apps/apps-host-runtime.js';
import { DockerAvailabilityService } from './docker-availability.service.js';

const constructors = { DockerAvailabilityService };
export type DockerAvailabilityConstructors = typeof constructors;

import type { DrizzleClient } from '@/db/client.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { ManagedDatabaseBindingService } from '@/modules/databases/managed-database-bindings.service.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { ProxySecureLinkService } from '@/modules/proxy/proxy-secure-link.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import type { RelayRegistryService } from '@/services/relay-registry.service.js';
import type { DockerManagementService } from '../docker.service.js';
import type { DockerEnvironmentService } from '../docker-environment.service.js';
import type { DockerInternalRegistryService } from '../docker-registry-internal.service.js';
import type { DockerSecretService } from '../docker-secret.service.js';
import type { AvailabilityLeaseService } from './lease/availability-lease.service.js';
export interface DockerAvailabilitySetup {
  db: DrizzleClient;
  nodes: NodeRegistryService;
  license: LicensePolicyService;
  audit: AuditService;
  events: EventBusService;
  dispatch: NodeDispatchService;
  docker: DockerManagementService;
  environment: DockerEnvironmentService;
  secrets: DockerSecretService;
  registry: DockerInternalRegistryService;
  relay?: RelayRegistryService;
  bindings: ManagedDatabaseBindingService;
  proxy: ProxyService;
  secureLinks?: ProxySecureLinkService;
  workloads: DockerWorkloadResolverService;
  /** Data-plane lease host: lease mode per policy, holders, planned handoffs, partition mode (T6 contract). */
  lease?: AvailabilityLeaseService;
}

import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  dockerArtifactPins,
  dockerAvailabilityOperations,
  dockerAvailabilityPlacements,
  dockerAvailabilityPolicies,
  dockerBuildArtifacts,
  dockerBuilds,
  dockerComposeProjects,
  dockerComposeRevisions,
  dockerDeploymentReleases,
  dockerDeploymentRoutes,
  dockerDeploymentSlots,
  dockerDeployments,
  nodes,
  proxyAdditionalRoutes,
  proxyAdditionalSecureLinks,
  proxyHosts,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  dockerAvailabilityWorkloadFolderId,
  missingDockerAvailabilityCandidateScopes,
} from '@/modules/docker/availability/docker-availability-permissions.js';
import { DockerWorkloadResolverService } from '@/modules/docker/availability/docker-workload-resolver.service.js';
import { encodeComposeServiceTarget } from '@/modules/docker/compose/compose-managed-bindings.js';
import { hasDockerResourceScope } from '@/modules/docker/docker-access-resource.service.js';
import { registryRuntimeReferences } from '@/modules/docker/docker-registry-maintenance.js';
import { EventBusService } from '@/services/event-bus.service.js';
import { AVAILABILITY_LEASE_CAPABILITY } from './lease/lease-constants.js';
import { availabilityStandbyCount } from './lease/lease-gating.js';

const loggerDockerAvailabilityService = createChildLogger('DockerAvailabilityService');
export const dockerAvailabilityCommercialRuntime = {
  /** Apps: node allowlist guard, `app` field and list filters (see apps-host-runtime.ts). */
  apps: appsHostRuntime,
  constructors,
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
  dockerArtifactPins,
  dockerAvailabilityOperations,
  dockerAvailabilityPlacements,
  dockerAvailabilityPolicies,
  dockerBuildArtifacts,
  dockerComposeProjects,
  dockerComposeRevisions,
  dockerDeploymentReleases,
  dockerDeploymentSlots,
  dockerDeployments,
  nodes,
  createChildLogger,
  AppError,
  hasDockerResourceScope,
  encodeComposeServiceTarget,
  DockerWorkloadResolverService,
  dockerDeploymentRoutes,
  notInArray,
  dockerBuilds,
  registryRuntimeReferences,
  proxyAdditionalRoutes,
  proxyAdditionalSecureLinks,
  proxyHosts,
  hasScope,
  EventBusService,
  PgDialect,
  loggerDockerAvailabilityService,
  dockerAvailabilityWorkloadFolderId,
  missingDockerAvailabilityCandidateScopes,
  AVAILABILITY_LEASE_CAPABILITY,
  availabilityStandbyCount,
};
