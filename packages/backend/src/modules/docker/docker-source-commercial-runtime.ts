import { and, asc, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { getEnv } from '@/config/env.js';
import {
  dockerAccessResources,
  dockerBuildSecrets,
  dockerBuilds,
  dockerComposeProjects,
  dockerDeployments,
  dockerEnvVars,
  dockerSecrets,
  dockerSourceBindings,
  dockerSourceWebhookDeliveries,
  integrationConnectors,
  pageProjects,
} from '@/db/schema/index.js';
import { grantCreatedResourcePermissions } from '@/lib/created-resource-permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { requireConfiguredLicensePolicy } from '@/modules/license/license-policy.service.js';

import { DockerAccessResourceService } from './docker-access-resource.service.js';
import { DockerBuildCommitShaSchema, DockerSourceResourceCreateSchema } from './docker-build.schemas.js';

export const dockerSourceCommercialRuntime = {
  and,
  asc,
  desc,
  eq,
  isNull,
  lt,
  or,
  sql,
  dockerAccessResources,
  dockerBuildSecrets,
  dockerBuilds,
  dockerComposeProjects,
  dockerDeployments,
  dockerSecrets,
  dockerSourceBindings,
  integrationConnectors,
  pageProjects,
  grantCreatedResourcePermissions,
  AppError,
  requireConfiguredLicensePolicy,

  DockerAccessResourceService,
  DockerSourceResourceCreateSchema,
  getEnv,
  dockerSourceWebhookDeliveries,
  DockerBuildCommitShaSchema,
  dockerEnvVars,
};
