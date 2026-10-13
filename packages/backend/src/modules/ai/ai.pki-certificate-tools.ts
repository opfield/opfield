import { container } from '@/container.js';
import { hasScope, hasScopeForResource } from '@/lib/permissions.js';
import { sanitizeFilename } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { CAService } from '@/modules/pki/ca.service.js';
import {
  CertificateListQuerySchema,
  ExportCertificateQuerySchema,
  IssueCertFromCSRSchema,
  IssueCertificateSchema,
  RevokeCertificateSchema,
} from '@/modules/pki/cert.schemas.js';
import type { CertService } from '@/modules/pki/cert.service.js';
import { ExportService } from '@/modules/pki/export.service.js';
import { CertificateFolderService } from '@/modules/pki/pki-folders.service.js';
import { SystemCertificateLifecycleService } from '@/services/system-certificate-lifecycle.service.js';
import type { User } from '@/types.js';
import { agentPage, agentPageLimit, allowedResourceIdsForScopes } from './ai.service-helpers.js';

export const PKI_CERTIFICATE_TOOL_NAMES = new Set([
  'list_certificates',
  'get_certificate',
  'issue_certificate',
  'revoke_certificate',
  'manage_certificate',
  'audit_system_pki_leaves',
]);

export interface PkiCertificateToolContext {
  caService: CAService;
  certService: CertService;
  auditService?: Pick<AuditService, 'log'>;
  ensureToolScope(user: User, scope: string): void;
  ensureToolScopeForResource(user: User, baseScope: string, resourceId: string): void;
}

const PRIVATE_KEY_FORMATS = new Set(['private-key', 'pem-bundle', 'pkcs12', 'jks']);

export async function executePkiCertificateTool(
  context: PkiCertificateToolContext,
  user: User,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const a = args as any;
  const includeSystem = hasScope(user.scopes, 'admin:details:certificates');

  switch (toolName) {
    case 'audit_system_pki_leaves': {
      context.ensureToolScope(user, 'pki:cert:view');
      context.ensureToolScope(user, 'admin:details:certificates');
      return container
        .resolve(SystemCertificateLifecycleService)
        .auditSystemLeaves(typeof a.caId === 'string' ? a.caId : undefined);
    }
    case 'list_certificates': {
      const query = CertificateListQuerySchema.parse({
        caId: a.caId,
        status: a.status,
        type: a.type,
        search: a.search,
        showSystem: a.showSystem === true ? 'true' : undefined,
        page: agentPage(a.page),
        limit: agentPageLimit(a.limit),
        sortBy: a.sortBy,
        sortOrder: a.sortOrder,
      });
      if (query.showSystem) context.ensureToolScope(user, 'admin:details:certificates');
      return context.certService.listCertificates(query, {
        allowedIds: allowedResourceIdsForScopes(user.scopes, 'pki:cert:view'),
      });
    }
    case 'get_certificate':
      return context.certService.getCertificate(a.certificateId, { includeSystem });
    case 'issue_certificate': {
      const certInput = IssueCertificateSchema.parse(args);
      requireIssueScope(user, certInput.caId);
      await container.resolve(CertificateFolderService).assertCreateFolder(user.scopes, certInput.folderId);
      const result = await context.certService.issueCertificate(certInput, user.id);
      return {
        certificate: result.certificate,
        message:
          'Certificate issued successfully. Private key was generated; export it with manage_certificate (format private-key, pem-bundle, pkcs12, or jks) when needed.',
      };
    }
    case 'revoke_certificate': {
      const { reason } = RevokeCertificateSchema.parse({ reason: a.reason });
      // CertService.revokeCertificate republishes the issuing CA's CRL itself.
      await context.certService.revokeCertificate(a.certificateId, reason, user.id);
      return { success: true, message: 'Certificate revoked.' };
    }
    case 'manage_certificate': {
      if (a.operation === 'issue_from_csr') {
        const input = IssueCertFromCSRSchema.parse(args);
        requireIssueScope(user, input.caId);
        await container.resolve(CertificateFolderService).assertCreateFolder(user.scopes, input.folderId);
        return context.certService.issueCertificateFromCSR(input, user.id);
      }
      if (a.operation === 'chain') {
        context.ensureToolScopeForResource(user, 'pki:cert:view', String(a.certificateId));
        const cert = await context.certService.getCertificate(a.certificateId, { includeSystem });
        const chainPems: string[] = [];
        let currentCaId: string | null = cert.caId;
        while (currentCaId) {
          const ca = await context.caService.getCA(currentCaId, { includeSystem });
          chainPems.push(ca.certificatePem);
          currentCaId = ca.parentId;
        }
        return { certificatePem: cert.certificatePem, chainPem: [cert.certificatePem, ...chainPems].join('\n') };
      }
      if (a.operation === 'export') {
        context.ensureToolScopeForResource(user, 'pki:cert:export', String(a.certificateId));
        return exportCertificate(context, user, String(a.certificateId), includeSystem, args);
      }
      throw new Error(`Unsupported certificate operation: ${String(a.operation)}`);
    }
    default:
      throw new Error(`Unsupported PKI certificate tool: ${toolName}`);
  }
}

/** Same rule as POST /certificates and /certificates/from-csr: issue on the chosen CA. */
function requireIssueScope(user: User, caId: string) {
  if (!hasScopeForResource(user.scopes, 'pki:cert:issue', caId)) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: pki:cert:issue:${caId}`);
  }
}

/**
 * Mirrors POST /certificates/{id}/export: every format, the system-CA key
 * guard, and a mandatory `cert.export_key` audit record before key material
 * leaves Opfield. Binary formats are returned base64-encoded.
 */
async function exportCertificate(
  context: PkiCertificateToolContext,
  user: User,
  certificateId: string,
  includeSystem: boolean,
  args: Record<string, unknown>
) {
  const { format, passphrase } = ExportCertificateQuerySchema.parse({
    format: args.format,
    passphrase: args.passphrase,
  });
  const cert = await context.certService.getCertificate(certificateId, { includeSystem });
  const exportService = container.resolve(ExportService);
  const filename = (suffix: string) => `${sanitizeFilename(cert.commonName)}${suffix}`;
  if (PRIVATE_KEY_FORMATS.has(format)) {
    const ca = await context.caService.getCA(cert.caId, { includeSystem: true });
    if (ca.isSystem && !hasScope(user.scopes, 'admin:system')) {
      throw new AppError(403, 'SYSTEM_CERT_KEY_EXPORT_FORBIDDEN', 'System certificate private keys cannot be exported');
    }
  }
  const recordKeyExport = async () => {
    const recorded = await context.auditService?.log({
      userId: user.id,
      action: 'cert.export_key',
      resourceType: 'certificate',
      resourceId: certificateId,
      details: { format },
    });
    if (!recorded) throw new AppError(503, 'AUDIT_UNAVAILABLE', 'Private key export requires an audit record');
  };
  const intermediateChain = async () => {
    const chainPems: string[] = [];
    let currentCaId: string | null = cert.caId;
    while (currentCaId) {
      const ca = await context.caService.getCA(currentCaId, { includeSystem });
      if (ca.type === 'intermediate') chainPems.push(ca.certificatePem);
      currentCaId = ca.parentId;
    }
    return chainPems;
  };
  const requirePrivateKey = async () => {
    const privateKey = await context.certService.getCertificatePrivateKey(certificateId);
    if (!privateKey) {
      throw new AppError(400, 'NO_PRIVATE_KEY', 'Private key not available (CSR-based certificate)');
    }
    return privateKey;
  };
  const requirePassphrase = () => {
    if (!passphrase) {
      throw new AppError(400, 'PASSPHRASE_REQUIRED', `Passphrase required for ${format.toUpperCase()} export`);
    }
    return passphrase;
  };

  switch (format) {
    case 'pem':
      return { format, filename: filename('.pem'), content: cert.certificatePem };
    case 'der':
      return {
        format,
        filename: filename('.der'),
        contentBase64: exportService.exportDER(cert.certificatePem).toString('base64'),
      };
    case 'chain': {
      const chainPems = await intermediateChain();
      if (!chainPems.length) throw new AppError(404, 'NO_INTERMEDIATE_CHAIN', 'No intermediate CA chain is available');
      return { format, filename: filename('-chain.pem'), content: exportService.exportChainPEM(chainPems) };
    }
    case 'fullchain':
      return {
        format,
        filename: filename('-fullchain.pem'),
        content: exportService.exportPEM(cert.certificatePem, await intermediateChain()),
      };
    case 'private-key': {
      const privateKey = await requirePrivateKey();
      await recordKeyExport();
      return { format, filename: filename('-private-key.pem'), content: privateKey };
    }
    case 'pem-bundle': {
      const privateKey = await requirePrivateKey();
      await recordKeyExport();
      const bundle = exportService.exportPEMBundle({
        certificatePem: cert.certificatePem,
        privateKeyPem: privateKey,
        chainPems: await intermediateChain(),
      });
      return { format, filename: filename('-pem.zip'), contentBase64: Buffer.from(bundle).toString('base64') };
    }
    case 'pkcs12': {
      const pkcs12Passphrase = requirePassphrase();
      const privateKey = await requirePrivateKey();
      await recordKeyExport();
      const p12 = await exportService.exportPKCS12(
        cert.certificatePem,
        privateKey,
        pkcs12Passphrase,
        await intermediateChain()
      );
      return { format, filename: filename('.p12'), contentBase64: Buffer.from(p12).toString('base64') };
    }
    case 'jks': {
      const jksPassphrase = requirePassphrase();
      const privateKey = await context.certService.getCertificatePrivateKey(certificateId);
      if (privateKey) await recordKeyExport();
      const jks = await exportService.exportJKS(cert.certificatePem, privateKey, jksPassphrase, cert.commonName);
      return { format, filename: filename('.jks'), contentBase64: Buffer.from(jks).toString('base64') };
    }
  }
}
