import { container } from '@/container.js';
import { getResourceScopedIds, hasScope, hasScopeForResource } from '@/lib/permissions.js';
import { sanitizeFilename } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import {
  CreateIntermediateCASchema,
  CreateRootCASchema,
  ExportCAKeySchema,
  RevokeCASchema,
  UpdateCASchema,
} from '@/modules/pki/ca.schemas.js';
import type { CAService } from '@/modules/pki/ca.service.js';
import { ExportService } from '@/modules/pki/export.service.js';
import { CAFolderService } from '@/modules/pki/pki-folders.service.js';
import type { User } from '@/types.js';
import { caTypeRevokeScope, caViewScope } from './ai.service-helpers.js';

export const PKI_CA_TOOL_NAMES = new Set([
  'list_cas',
  'get_ca',
  'create_root_ca',
  'create_intermediate_ca',
  'delete_ca',
  'manage_ca',
]);

export interface PkiCaToolContext {
  caService: CAService;
  auditService?: Pick<AuditService, 'log'>;
}

export async function executePkiCaTool(
  context: PkiCaToolContext,
  user: User,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const a = args as any;
  const includeSystem = hasScope(user.scopes, 'admin:details:certificates');

  switch (toolName) {
    case 'list_cas': {
      // Mirrors GET /cas: system CAs need admin:details:certificates, and a CA
      // is listed for pki:ca:view (broad or on that CA) or a per-CA issue grant.
      const showSystem = a.showSystem === true;
      if (showSystem && !includeSystem) {
        throw new AppError(403, 'FORBIDDEN', 'Missing required scope: admin:details:certificates');
      }
      const issuableCaIds = new Set(getResourceScopedIds(user.scopes, 'pki:cert:issue'));
      return (await context.caService.getCATree(showSystem)).filter(
        (ca: { id: string; type: string }) => hasScope(user.scopes, caViewScope(ca.id)) || issuableCaIds.has(ca.id)
      );
    }
    case 'get_ca': {
      const ca = await context.caService.getCA(a.caId, { includeSystem });
      if (!hasScope(user.scopes, caViewScope(ca.id))) {
        throw new Error(`PERMISSION_DENIED: Missing required scope ${caViewScope(ca.id)}`);
      }
      return ca;
    }
    case 'create_root_ca': {
      const rootCaInput = CreateRootCASchema.parse(args);
      await container.resolve(CAFolderService).assertRootCreateFolder(user.scopes, rootCaInput.folderId);
      return context.caService.createRootCA(rootCaInput, user.id);
    }
    case 'create_intermediate_ca': {
      const intCaInput = CreateIntermediateCASchema.parse(args);
      await container.resolve(CAFolderService).assertIntermediateCreateFolder(a.parentCaId, intCaInput.folderId);
      return context.caService.createIntermediateCA(a.parentCaId, intCaInput, user.id);
    }
    case 'delete_ca': {
      await requireCaRevokeScope(context, user, a.caId, includeSystem);
      const deleted = await context.caService.deleteCA(a.caId, user.id);
      return { success: true, ...(deleted ?? {}) };
    }
    case 'manage_ca':
      return manageCa(context, user, a, includeSystem);
    default:
      throw new Error(`Unsupported PKI CA tool: ${toolName}`);
  }
}

async function manageCa(context: PkiCaToolContext, user: User, a: Record<string, any>, includeSystem: boolean) {
  if (a.operation === 'update') {
    // PUT /cas/{id} requires pki:ca:edit (broad or on that CA) for every CA type.
    requireCaScope(user, 'pki:ca:edit', String(a.caId ?? ''));
    return context.caService.updateCA(
      a.caId,
      UpdateCASchema.parse({
        crlDistributionUrl: a.crlDistributionUrl,
        caIssuersUrl: a.caIssuersUrl,
        maxValidityDays: a.maxValidityDays,
      }),
      user.id
    );
  }
  if (a.operation === 'revoke') {
    const { reason } = RevokeCASchema.parse({ reason: a.reason });
    await requireCaRevokeScope(context, user, a.caId, includeSystem);
    await context.caService.revokeCA(a.caId, reason, user.id);
    return { success: true, message: 'CA revoked' };
  }
  if (a.operation === 'export_key') {
    // Mirrors POST /cas/{id}/export-key: PKCS#12 of the CA key and certificate, audited as ca.export_key.
    requireCaScope(user, 'pki:ca:export', String(a.caId ?? ''));
    const { passphrase } = ExportCAKeySchema.parse({ passphrase: a.passphrase });
    const { ca, privateKeyPem } = await context.caService.getCASigningMaterials(a.caId);
    const p12 = await container.resolve(ExportService).exportCAKey(privateKeyPem, ca.certificatePem, passphrase);
    await context.auditService?.log({
      userId: user.id,
      action: 'ca.export_key',
      resourceType: 'ca',
      resourceId: a.caId,
    });
    return {
      format: 'pkcs12',
      filename: `${sanitizeFilename(ca.commonName)}.p12`,
      contentBase64: Buffer.from(p12).toString('base64'),
    };
  }
  throw new Error(`Unsupported CA operation: ${String(a.operation)}`);
}

async function requireCaRevokeScope(context: PkiCaToolContext, user: User, caId: string, includeSystem: boolean) {
  const ca = await context.caService.getCA(caId, { includeSystem });
  const requiredScope = caTypeRevokeScope(ca.type);
  if (!hasScope(user.scopes, requiredScope)) {
    throw new Error(`PERMISSION_DENIED: Missing required scope ${requiredScope}`);
  }
}

function requireCaScope(user: User, baseScope: string, caId: string) {
  if (!hasScopeForResource(user.scopes, baseScope, caId)) {
    throw new Error(`PERMISSION_DENIED: Missing required scope ${baseScope}:${caId}`);
  }
}
