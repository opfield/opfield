import { z } from 'zod';
import { container } from '@/container.js';
import {
  appRoute,
  createdJson,
  jsonBody,
  OpfieldOpenAPIHono,
  okJson,
  UnknownDataResponseSchema,
} from '@/lib/openapi.js';
import { authMiddleware, rejectImpersonation, requireScopeForResource } from '@/modules/auth/auth.middleware.js';
import { requireLicenseFeature, requireLicenseFeatureForRequest } from '@/modules/license/license-policy.middleware.js';
import { PageDeploymentListQuerySchema } from './deployments/page-deployment.schemas.js';
import { PageDeploymentService } from './deployments/page-deployment.service.js';
import { requirePagesEnabledForMutation } from './profile/page-enabled.middleware.js';
import { PageRetentionService } from './retention/page-retention.service.js';
import {
  PageRuntimeConfigTagParamSchema,
  ResetPageRuntimeConfigSchema,
  SavePageRuntimeConfigSchema,
} from './runtime-config/page-runtime-config.schemas.js';
import { PageRuntimeConfigService } from './runtime-config/page-runtime-config.service.js';
import { PagePublicationService } from './tags/page-publication.service.js';
import { MovePageTagSchema, PageTagParamSchema } from './tags/page-tag.schemas.js';
import { PageTagService } from './tags/page-tag.service.js';
import { CreatePageDeployTokenSchema } from './tokens/page-deploy-token.schemas.js';
import { PageDeployTokenService } from './tokens/page-deploy-token.service.js';
export const pageManagementRouteRuntime = {
  OpenAPIHono: OpfieldOpenAPIHono,
  z,
  container,
  appRoute,
  createdJson,
  jsonBody,
  okJson,
  UnknownDataResponseSchema,
  authMiddleware,
  rejectImpersonation,
  requireScopeForResource,
  requireLicenseFeature,
  requireLicenseFeatureForRequest,
  PageDeploymentListQuerySchema,
  PageDeploymentService,
  requirePagesEnabledForMutation,
  PageRetentionService,
  PageRuntimeConfigTagParamSchema,
  ResetPageRuntimeConfigSchema,
  SavePageRuntimeConfigSchema,
  PageRuntimeConfigService,
  PagePublicationService,
  MovePageTagSchema,
  PageTagParamSchema,
  PageTagService,
  CreatePageDeployTokenSchema,
  PageDeployTokenService,
};
