import { container } from '@/container.js';
import { grantCreatedResourcePermissions } from '@/lib/created-resource-permissions.js';
import { hasScopeBase, hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  CreateDomainSchema,
  DeleteDomainSchema,
  DomainIngressMigrationSchema,
  DomainListQuerySchema,
  IssueDomainCertificateSchema,
  PreviewDomainSchema,
  ResolveCloudflareMigrationSchema,
  UpdateDomainSchema,
} from '@/modules/domains/domain.schemas.js';
import type { DomainsService } from '@/modules/domains/domain.service.js';
import {
  domainNginxNodeOptionsForScopes,
  resolveDomainCreationNginxNodeId,
} from '@/modules/domains/domain-creation-access.js';
import { DomainFolderService } from '@/modules/domains/domain-folders.service.js';
import {
  assertCanPreviewDomainDestination,
  assertDomainCreationOnGroup,
  assertDomainPlacementAccess,
} from '@/modules/ingress-groups/ingress-group-operations.js';
import { SSLService } from '@/modules/ssl/ssl.service.js';
import { SSLCertificateFolderService } from '@/modules/ssl/ssl-certificate-folders.service.js';
import type { User } from '@/types.js';
import { agentPage, agentPageLimit, allowedResourceIdsForScopes } from './ai.service-helpers.js';

export const DOMAIN_TOOL_NAMES = new Set(['list_domains', 'create_domain', 'delete_domain', 'manage_domain']);

export interface DomainToolContext {
  domainsService: DomainsService;
  ensureToolScopeForResource(user: User, baseScope: string, resourceId: string): void;
}

export async function executeDomainTool(
  context: DomainToolContext,
  user: User,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const a = args as any;

  switch (toolName) {
    case 'list_domains':
      return context.domainsService.listDomains(
        DomainListQuerySchema.parse({
          search: a.search,
          dnsStatus: a.dnsStatus,
          excludeAppMembers: a.excludeAppMembers === true ? 'true' : undefined,
          appId: typeof a.appId === 'string' && a.appId ? a.appId : undefined,
          page: agentPage(a.page),
          limit: agentPageLimit(a.limit),
        }),
        { allowedIds: allowedResourceIdsForScopes(user.scopes, 'domains:view') }
      );
    case 'create_domain': {
      const request = CreateDomainSchema.parse({
        domain: a.domain,
        dnsProvider: a.dnsProvider,
        description: a.description,
        folderId: a.folderId,
        ttl: a.ttl,
        proxied: a.proxied,
        overwriteDns: a.overwriteDns,
        nginxNodeId: a.nginxNodeId,
        ingressGroupId: a.ingressGroupId,
      });
      // Like POST /domains: a node-limited creator that omits nginxNodeId gets its only granted node.
      const nginxNodeId = await resolveDomainCreationNginxNodeId(user.scopes, request, () =>
        context.domainsService.getNginxNodeOptions()
      );
      const input = nginxNodeId && !request.ingressGroupId ? { ...request, nginxNodeId } : request;
      if (input.ingressGroupId) {
        // A domain on an ingress group is served by every member.
        await assertDomainCreationOnGroup(user.scopes, input.ingressGroupId, input.folderId);
      } else if (!hasScopeForCreation(user.scopes, 'domains:create', input.folderId, input.nginxNodeId)) {
        throw new AppError(403, 'FORBIDDEN', 'Missing domains:create permission for the selected destination');
      }
      await container.resolve(DomainFolderService).assertFolderExists(input.folderId);
      return context.domainsService.createDomain(input, user.id);
    }
    case 'delete_domain':
      await context.domainsService.deleteDomain(
        a.domainId,
        user.id,
        DeleteDomainSchema.parse({ deleteDns: typeof a.deleteDns === 'boolean' ? a.deleteDns : undefined })
      );
      return { success: true };
    case 'manage_domain':
      return manageDomain(context, user, a);
    default:
      throw new Error(`Unsupported domain tool: ${toolName}`);
  }
}

async function manageDomain(context: DomainToolContext, user: User, a: Record<string, any>): Promise<unknown> {
  // Mirrors GET /domains/nginx-nodes and POST /domains/preview: any domains:create grant form (broad,
  // folder or node); the node list only offers the nodes the caller may create on.
  if (a.operation === 'list_nginx_nodes' || a.operation === 'preview') {
    if (!hasScopeBase(user.scopes, 'domains:create')) {
      throw new AppError(403, 'FORBIDDEN', 'Missing required scope: domains:create');
    }
    if (a.operation === 'list_nginx_nodes') {
      const options = await context.domainsService.getNginxNodeOptions();
      return {
        ...domainNginxNodeOptionsForScopes(options, user.scopes),
        ingressGroups: await context.domainsService.getIngressGroupOptions(user.scopes, options),
      };
    }
    const input = PreviewDomainSchema.parse({
      domain: a.domain,
      dnsProvider: a.dnsProvider,
      ttl: a.ttl,
      proxied: a.proxied,
      nginxNodeId: a.nginxNodeId,
      ingressGroupId: a.ingressGroupId,
    });
    // The preview returns node hostnames and addresses: node-only creators may preview only on nodes of their
    // grant (and must name them; every member for an ingress group), exactly like REST.
    await assertCanPreviewDomainDestination(user.scopes, input);
    return context.domainsService.previewDomain(input);
  }

  const domainId = typeof a.domainId === 'string' ? a.domainId : '';
  if (!domainId) throw new AppError(400, 'DOMAIN_ID_REQUIRED', `domainId is required for ${String(a.operation)}`);
  if (a.operation === 'get') {
    context.ensureToolScopeForResource(user, 'domains:view', domainId);
    return context.domainsService.getDomain(domainId);
  }
  if (a.operation === 'update') {
    context.ensureToolScopeForResource(user, 'domains:edit', domainId);
    const input = UpdateDomainSchema.parse({
      description: a.description,
      proxied: a.proxied,
      ingressGroupId: a.ingressGroupId,
      nginxNodeId: a.ingressGroupId === null ? a.nginxNodeId : undefined,
    });
    // Like PUT /domains/{id}: moving onto an ingress group needs domains:create on every member.
    if (input.ingressGroupId !== undefined) await assertDomainPlacementAccess(user.scopes, domainId, input);
    return context.domainsService.updateDomain(domainId, input, user.id);
  }
  if (a.operation === 'check_dns') {
    context.ensureToolScopeForResource(user, 'domains:edit', domainId);
    return context.domainsService.checkDns(domainId, { repair: a.repair !== false });
  }
  if (a.operation === 'resolve_cloudflare_migration') {
    context.ensureToolScopeForResource(user, 'domains:edit', domainId);
    const input = ResolveCloudflareMigrationSchema.parse(
      a.action === 'update_dns' ? { action: a.action, nginxNodeId: a.nginxNodeId } : { action: a.action }
    );
    return context.domainsService.resolveCloudflareMigration(domainId, input, user.id, user.scopes);
  }
  if (a.operation === 'preview_ingress_migration' || a.operation === 'migrate_ingress') {
    context.ensureToolScopeForResource(user, 'domains:edit', domainId);
    const input = DomainIngressMigrationSchema.parse({ targetNodeId: a.targetNodeId });
    return a.operation === 'preview_ingress_migration'
      ? context.domainsService.previewIngressMigration(domainId, input)
      : context.domainsService.migrateIngress(domainId, input, user.id, user.scopes);
  }
  if (a.operation === 'issue_certificate') {
    // Mirrors POST /domains/{id}/issue-cert: domain view plus ssl:cert:issue on the SSL certificate folder
    // the new certificate lands in (broad for the root).
    context.ensureToolScopeForResource(user, 'domains:view', domainId);
    const { folderId } = IssueDomainCertificateSchema.parse({ folderId: a.certificateFolderId });
    if (!hasScopeForCreation(user.scopes, 'ssl:cert:issue', folderId)) {
      throw new AppError(403, 'FORBIDDEN', 'Missing ssl:cert:issue permission for the selected certificate folder');
    }
    await container.resolve(SSLCertificateFolderService).assertFolderExists(folderId);
    const domain = await context.domainsService.getDomain(domainId);
    const cloudflare = domain.dnsProvider === 'cloudflare';
    const result = await container.resolve(SSLService).requestACMECert(
      {
        domains: [domain.domain],
        challengeType: cloudflare ? 'dns-01' : 'http-01',
        provider: 'letsencrypt',
        autoRenew: true,
        ...(cloudflare ? { dnsProvider: 'cloudflare' as const } : {}),
        folderId: folderId ?? null,
      },
      user.id,
      user.email
    );
    // Mirrors the REST route: the issuer keeps sight of the new certificate.
    await grantCreatedResourcePermissions(user.id, 'ssl:cert', result.certificate.id, { folderId: folderId ?? null });
    return result;
  }
  throw new Error(`Unsupported domain operation: ${String(a.operation)}`);
}
