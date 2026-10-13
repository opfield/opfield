import { and, asc, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import {
  containerLinkPlacements,
  containerLinks,
  dockerAvailabilityLeaseState,
  dockerAvailabilityPlacements,
  dockerAvailabilityPolicies,
  dockerDeploymentRoutes,
  dockerDeployments,
  nodes,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { isOpfieldInternalContainer } from '@/modules/docker/docker-internal-containers.js';
import { requireConfiguredLicensePolicy } from '@/modules/license/license-policy.service.js';
import { SECURE_LINK_EGRESS_CAPABILITY } from '@/services/secure-link-egress-status.js';
import { ContainerLinksService } from './container-links.service.js';

const loggerContainerLinks = createChildLogger('ContainerLinks');

export type { ContainerLinkPlacementRow, ContainerLinkRow } from '@/db/schema/container-links.js';
export type { LicensePolicyService } from '@/modules/license/license-policy.service.js';

/** Host objects the private container links implementation uses (it bundles none of the host's runtime). */
export const containerLinksRuntime = {
  ContainerLinksService,
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  ne,
  or,
  sql,
  containerLinks,
  containerLinkPlacements,
  dockerAvailabilityLeaseState,
  dockerAvailabilityPlacements,
  dockerAvailabilityPolicies,
  dockerDeploymentRoutes,
  dockerDeployments,
  nodes,
  loggerContainerLinks,
  isOpfieldInternalContainer,
  requireConfiguredLicensePolicy,
  SECURE_LINK_EGRESS_CAPABILITY,
};
