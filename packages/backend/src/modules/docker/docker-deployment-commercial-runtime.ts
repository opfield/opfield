import { appsHostRuntime } from '@/modules/apps/apps-host-runtime.js';
import { DockerComposeService } from './compose/compose.service.js';
import { DockerDeploymentService } from './docker-deployment.service.js';

const constructors = { DockerDeploymentService, DockerComposeService };
export type DockerDeploymentConstructors = typeof constructors;

import { and, desc, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  containerLinks,
  dockerComposeOperations,
  dockerComposeProjects,
  dockerComposeRevisions,
  dockerContainerFolderAssignments,
  dockerDeploymentReleases,
  dockerDeploymentRoutes,
  dockerDeploymentSlots,
  dockerDeployments,
  dockerSecrets,
  dockerSourceBindings,
  dockerWebhooks,
  managedDatabaseBindings,
  nodes,
  relayRoutes,
} from '@/db/schema/index.js';
import { grantCreatedResourcePermissions } from '@/lib/created-resource-permissions.js';
import { createChildLogger } from '@/lib/logger.js';
import { transactionWithScopeCleanup } from '@/lib/resource-scope-cleanup.js';
import { AppError } from '@/middleware/error-handler.js';
import { webhookDeployMountsRefusal } from '@/modules/docker/automatic-deploy-authority.js';
import {
  decodeComposeServiceTarget,
  encodeComposeServiceTarget,
} from '@/modules/docker/compose/compose-managed-bindings.js';

import { assertDockerCreationAccess, placeCreatedDockerResource } from '@/modules/docker/docker-creation-access.js';

import { DOCKER_DEPLOYMENT_MANAGED_LABEL, dockerDeploymentLabels } from '@/modules/docker/docker-deployment-labels.js';
import { hasDockerGpuV1Capability } from '@/modules/docker/docker-gpu-attachment.js';
import { assertManagedMountMutation } from '@/modules/docker/docker-managed-mounts.js';
import {
  assertComposeProjectNotUsedByProxy,
  assertDeploymentNotUsedByProxy,
} from '@/modules/docker/docker-proxy-link.guard.js';
import {
  assertDockerMountChangeAllowed,
  normalizeMountDefinitionsFromConfig,
} from '@/modules/docker/docker-socket-mount.guard.js';
import { requireConfiguredLicensePolicy } from '@/modules/license/license-policy.service.js';
import { assertNodeAllowsServiceCreation } from '@/modules/nodes/service-creation-lock.js';
export const dockerDeploymentCommercialRuntime = {
  /** Apps: node allowlist guard, `app` field and list filters (see apps-host-runtime.ts). */
  apps: appsHostRuntime,
  constructors,
  and,
  desc,
  eq,
  ne,
  dockerDeploymentReleases,
  dockerDeploymentRoutes,
  dockerDeploymentSlots,
  dockerDeployments,
  dockerSourceBindings,
  dockerWebhooks,
  nodes,
  grantCreatedResourcePermissions,
  transactionWithScopeCleanup,
  AppError,
  requireConfiguredLicensePolicy,
  assertNodeAllowsServiceCreation,
  assertDockerCreationAccess,
  placeCreatedDockerResource,

  DOCKER_DEPLOYMENT_MANAGED_LABEL,
  dockerDeploymentLabels,
  hasDockerGpuV1Capability,
  assertManagedMountMutation,
  assertDockerMountChangeAllowed,
  normalizeMountDefinitionsFromConfig,
  managedDatabaseBindings,
  containerLinks,
  relayRoutes,
  assertDeploymentNotUsedByProxy,
  assertComposeProjectNotUsedByProxy,
  inArray,
  lt,
  or,
  sql,
  dockerComposeOperations,
  dockerComposeProjects,
  dockerComposeRevisions,
  dockerContainerFolderAssignments,
  dockerSecrets,

  decodeComposeServiceTarget,
  encodeComposeServiceTarget,

  PgDialect,
  createChildLogger,
  webhookDeployMountsRefusal,
};
