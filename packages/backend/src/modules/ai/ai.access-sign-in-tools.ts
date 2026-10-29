import { container } from '@/container.js';
import { hasScope, hasScopeBase } from '@/lib/permissions.js';
import { AccessIdentityProviderService } from '@/modules/access-signin/access-identity-providers.service.js';
import { AccessServiceTokenService } from '@/modules/access-signin/access-service-tokens.service.js';
import { AccessSessionService } from '@/modules/access-signin/access-sessions.service.js';
import {
  AccessSessionListQuerySchema,
  AccessSignInSettingsUpdateSchema,
  CreateAccessIdentityProviderSchema,
  CreateAccessServiceTokenSchema,
  UpdateAccessIdentityProviderSchema,
  UpdateAccessServiceTokenSchema,
} from '@/modules/access-signin/access-signin.schemas.js';
import { AccessSignInSettingsService } from '@/modules/access-signin/access-signin-settings.service.js';
import type { User } from '@/types.js';
import type { AIToolDefinition } from './ai.types.js';

export const ACCESS_SIGN_IN_TOOL_NAMES = new Set(['manage_access_sign_in']);

/** Scopes that reach the tool; each operation checks its own (the same as its REST route). */
export const ACCESS_SIGN_IN_TOOL_SCOPES = ['admin:system', 'acl:edit', 'acl:view'] as const;

export const ACCESS_SIGN_IN_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'manage_access_sign_in',
    description:
      'Access list sign-in: where visitors of protected routes sign in, with which identity providers, the service tokens scripts use, and the visitor sessions. settings.get/update (admin:system): domain (null: the Opfield public URL serves the sign-in page), defaultSessionTtlSeconds (300-2592000), and the placement of the sign-in route like the status page (nodeId or ingressGroupId, sslCertificateId); a domain without placement must reach Opfield another way. identity_providers list/get (admin:system or acl:view), create/update/delete (admin:system): kind google|oidc, name, issuer (oidc), clientId, clientSecret (never returned), groupsClaim; responses carry redirectUri to register at the provider; a list offers a provider as sign-in method idp:<id>; delete is refused while a list offers it. service_tokens list/get (acl:edit or acl:view), create/update/delete (acl:edit): create returns clientId and clientSecret once (headers Opfield-Access-Client-Id / -Secret); a list admits a token through an Include rule service_token with its id. sessions list (acl:edit; search, accessListId, includeEnded, page, limit) and revoke (sessionId): a revoked session stops working on every ingress node. read_opfield_documentation topic access-sign-in explains the flow.',
    parameters: {
      type: 'object',
      properties: {
        resource: { type: 'string', enum: ['settings', 'identity_providers', 'service_tokens', 'sessions'] },
        operation: { type: 'string', enum: ['get', 'list', 'update', 'create', 'delete', 'revoke'] },
        providerId: { type: 'string', description: 'identity_providers get/update/delete' },
        tokenId: { type: 'string', description: 'service_tokens get/update/delete' },
        sessionId: { type: 'string', description: 'sessions revoke' },
        search: { type: 'string', description: 'sessions list: email, name or subject' },
        accessListId: { type: 'string', description: 'sessions list: sessions of one list (password and shared)' },
        includeEnded: { type: 'boolean', description: 'sessions list: also expired and revoked sessions' },
        page: { type: 'number' },
        limit: { type: 'number' },
        payload: { type: 'object', description: 'Create/update body matching the REST API schema' },
      },
      required: ['resource', 'operation'],
    },
    destructive: true,
    category: 'Access Lists',
    requiredScope: 'acl:view',
    invalidateStores: ['accessLists'],
  },
];

function ensure(user: User, ...scopes: string[]) {
  if (!scopes.some((scope) => hasScope(user.scopes, scope))) {
    throw new Error(`PERMISSION_DENIED: Missing required scope ${scopes.join(' or ')}`);
  }
}

function ensureRead(user: User, ...scopeBases: string[]) {
  if (!scopeBases.some((scope) => hasScopeBase(user.scopes, scope))) {
    throw new Error(`PERMISSION_DENIED: Missing required scope ${scopeBases.join(' or ')}`);
  }
}

export async function executeAccessSignInTool(
  user: User,
  _toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const resource = String(args.resource);
  const operation = String(args.operation);
  const payload = (args.payload && typeof args.payload === 'object' ? args.payload : {}) as Record<string, unknown>;

  if (resource === 'settings') {
    const settings = container.resolve(AccessSignInSettingsService);
    ensure(user, 'admin:system');
    if (operation === 'get') return settings.getView();
    if (operation === 'update') {
      return settings.update(AccessSignInSettingsUpdateSchema.parse(payload), { userId: user.id, scopes: user.scopes });
    }
  }
  if (resource === 'identity_providers') {
    const providers = container.resolve(AccessIdentityProviderService);
    if (operation === 'list' || operation === 'get') {
      ensureRead(user, 'admin:system', 'acl:view');
      return operation === 'list' ? providers.list() : providers.get(String(args.providerId));
    }
    ensure(user, 'admin:system');
    if (operation === 'create') return providers.create(CreateAccessIdentityProviderSchema.parse(payload), user.id);
    if (operation === 'update') {
      return providers.update(String(args.providerId), UpdateAccessIdentityProviderSchema.parse(payload), user.id);
    }
    if (operation === 'delete') {
      await providers.delete(String(args.providerId), user.id);
      return { success: true };
    }
  }
  if (resource === 'service_tokens') {
    const tokens = container.resolve(AccessServiceTokenService);
    if (operation === 'list' || operation === 'get') {
      ensureRead(user, 'acl:edit', 'acl:view');
      return operation === 'list' ? tokens.list() : tokens.get(String(args.tokenId));
    }
    ensure(user, 'acl:edit');
    if (operation === 'create') return tokens.create(CreateAccessServiceTokenSchema.parse(payload), user.id);
    if (operation === 'update') {
      return tokens.update(String(args.tokenId), UpdateAccessServiceTokenSchema.parse(payload), user.id);
    }
    if (operation === 'delete') {
      await tokens.delete(String(args.tokenId), user.id);
      return { success: true };
    }
  }
  if (resource === 'sessions') {
    const sessions = container.resolve(AccessSessionService);
    ensure(user, 'acl:edit');
    if (operation === 'list') {
      return sessions.list(
        AccessSessionListQuerySchema.parse({
          search: args.search,
          accessListId: args.accessListId,
          includeEnded: args.includeEnded,
          page: args.page,
          limit: args.limit,
        })
      );
    }
    if (operation === 'revoke') {
      await sessions.revoke(String(args.sessionId), user.id);
      return { success: true };
    }
  }
  throw new Error(`Unsupported access sign-in operation: ${resource}.${operation}`);
}
