import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getResourceScopedIds, hasScope, hasScopeForResource } from '@/lib/permissions.js';
import { sanitizeFilename } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import { requireOpfieldFeature } from '@/middleware/feature-flags.js';
import { requireUuidParam } from '@/middleware/uuid-param.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { authMiddleware, requireScopeBase, requireScopeForResource } from '@/modules/auth/auth.middleware.js';
import { requireLicenseFeature, requireLicenseFeatureForRequest } from '@/modules/license/license-policy.middleware.js';
import { pkiCertificateFolderRouteDocs } from '@/modules/resource-folders/resource-folder.docs.js';
import { registerResourceFolderRoutes } from '@/modules/resource-folders/resource-folder.routes.js';
import { CAService } from './ca.service.js';
import {
  certificateChainRoute,
  deleteCertificateRoute,
  exportCertificateRoute,
  getCertificateRoute,
  issueCertificateFromCSRRoute,
  issueCertificateRoute,
  listCertificatesRoute,
  revokeCertificateRoute,
} from './cert.docs.js';
import {
  CertificateListQuerySchema,
  ExportCertificateQuerySchema,
  IssueCertFromCSRSchema,
  IssueCertificateSchema,
  RevokeCertificateSchema,
} from './cert.schemas.js';
import { CertService } from './cert.service.js';
import { CRLService } from './crl.service.js';
import { ExportService } from './export.service.js';
import { OCSPService } from './ocsp.service.js';
import { CertificateFolderService } from './pki-folders.service.js';
export const certRouteRuntime = {
  /** CertService.revokeCertificate republishes the issuing CA's CRL itself. */
  revokeCertificatePublishesCrl: true as const,
  OpenAPIHono,
  container,
  openApiValidationHook,
  getResourceScopedIds,
  hasScope,
  hasScopeForResource,
  sanitizeFilename,
  AppError,
  requireOpfieldFeature,
  AuditService,
  authMiddleware,
  requireScopeBase,
  requireScopeForResource,
  requireLicenseFeature,
  requireLicenseFeatureForRequest,
  CAService,
  certificateChainRoute,
  exportCertificateRoute,
  getCertificateRoute,
  issueCertificateFromCSRRoute,
  issueCertificateRoute,
  listCertificatesRoute,
  revokeCertificateRoute,
  deleteCertificateRoute,
  CertificateListQuerySchema,
  ExportCertificateQuerySchema,
  IssueCertFromCSRSchema,
  IssueCertificateSchema,
  RevokeCertificateSchema,
  CertService,
  CRLService,
  ExportService,
  OCSPService,
  CertificateFolderService,
  pkiCertificateFolderRouteDocs,
  registerResourceFolderRoutes,
  /** 404 for a non-UUID `/{id}` (a literal segment would otherwise reach the uuid column). */
  requireUuidParam,
};
