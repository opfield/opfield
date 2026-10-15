import { DockerBuildService } from './docker-build.service.js';
import { DockerBuildQuery } from './docker-build-query.js';
import { DockerBuildRolloutService } from './docker-build-rollout.service.js';
import { DockerBuildRunnerService } from './docker-build-runner.service.js';

const constructors = { DockerBuildService, DockerBuildRunnerService, DockerBuildRolloutService, DockerBuildQuery };
export type DockerBuildConstructors = typeof constructors;

import { and, asc, desc, eq, ilike, inArray, isNotNull, lt, ne, or, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  dockerArtifactPins,
  dockerBuildArtifacts,
  dockerBuildBatches,
  dockerBuildLogChunks,
  dockerBuilds,
  dockerComposeOperations,
  dockerComposeProjects,
  dockerContainerFolderAssignments,
  dockerDeployments,
  dockerSourceBindings,
  integrationConnectors,
  nodeFolders,
  nodes,
  pageProjects,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';

import { resolveAutomaticDeployAuthority } from './automatic-deploy-authority.js';
import { DockerManagementService } from './docker.service.js';
import { DockerAccessResourceService } from './docker-access-resource.service.js';
import {
  ACTIVE_BUILD_STATUSES,
  assertSupportedDockerBuildResourcePolicy,
  BUILD_LOG_CHUNK_MAX_BYTES,
  BUILD_LOG_TOTAL_MAX_BYTES,
  canTransitionDockerBuild,
  DEFAULT_BUILD_LEASE_MS,
  dockerBuildLimits,
  evaluateDockerArtifactPolicy,
  expiredDockerBuildDisposition,
  orderBuildersLikeNodeList,
  parseDockerBuildProgress,
  parseDockerBuildScanSummary,
  readBuilderNodeSettings,
  readDockerBuildRolloutProgress,
  redactDockerBuildLog,
  TERMINAL_BUILD_STATUSES,
  WORKER_ACTIVE_BUILD_STATUSES,
} from './docker-build-policy.js';
import { runAsDockerBuildRollout } from './docker-build-rollout-guard.js';
import { startContainer } from './docker-container-lifecycle-operations.js';
import { assertDockerCreationAccess } from './docker-creation-access.js';
import { assertContainerSourceTargetNotOwned } from './docker-source-target-owner.js';
import { inspectStoppedOnRequest } from './docker-stop-intent.js';

const loggerDockerBuildService = createChildLogger('DockerBuildService');
const loggerDockerBuildRunner = createChildLogger('DockerBuildRunner');
export const dockerBuildCommercialRuntime = {
  constructors,
  and,
  asc,
  eq,
  inArray,
  lt,
  ne,
  or,
  sql,
  dockerBuildBatches,
  dockerBuilds,
  dockerSourceBindings,
  createChildLogger,
  AppError,
  DockerAccessResourceService,
  ACTIVE_BUILD_STATUSES,
  assertSupportedDockerBuildResourcePolicy,
  canTransitionDockerBuild,
  DEFAULT_BUILD_LEASE_MS,
  expiredDockerBuildDisposition,
  parseDockerBuildProgress,
  parseDockerBuildScanSummary,
  readDockerBuildRolloutProgress,
  TERMINAL_BUILD_STATUSES,
  dockerBuildLimits,
  evaluateDockerArtifactPolicy,
  redactDockerBuildLog,
  isNotNull,
  nodeFolders,
  nodes,
  orderBuildersLikeNodeList,
  readBuilderNodeSettings,
  WORKER_ACTIVE_BUILD_STATUSES,
  desc,
  dockerArtifactPins,
  dockerBuildArtifacts,
  dockerDeployments,
  assertDockerCreationAccess,
  ilike,
  dockerComposeProjects,
  dockerComposeOperations,
  integrationConnectors,
  pageProjects,
  dockerBuildLogChunks,
  BUILD_LOG_CHUNK_MAX_BYTES,
  BUILD_LOG_TOTAL_MAX_BYTES,
  dockerContainerFolderAssignments,

  PgDialect,
  DockerManagementService,
  startContainer,
  runAsDockerBuildRollout,
  loggerDockerBuildService,
  loggerDockerBuildRunner,
  resolveAutomaticDeployAuthority,
  inspectStoppedOnRequest,
  assertContainerSourceTargetNotOwned,
};
