import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { requireUuidParam } from '@/middleware/uuid-param.js';
import {
  authMiddleware,
  rejectImpersonation,
  requireAnyScopeBase,
  requireScope,
  sessionOnly,
} from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { AccessIdentityProviderService } from './access-identity-providers.service.js';
import { AccessServiceTokenService } from './access-service-tokens.service.js';
import { AccessSessionService } from './access-sessions.service.js';
import {
  createAccessIdentityProviderRoute,
  createAccessServiceTokenRoute,
  deleteAccessIdentityProviderRoute,
  deleteAccessServiceTokenRoute,
  getAccessIdentityProviderRoute,
  getAccessServiceTokenRoute,
  getAccessSettingsRoute,
  listAccessIdentityProvidersRoute,
  listAccessServiceTokensRoute,
  listAccessSessionsRoute,
  revokeAccessSessionRoute,
  updateAccessIdentityProviderRoute,
  updateAccessServiceTokenRoute,
  updateAccessSettingsRoute,
} from './access-signin.docs.js';
import {
  AccessSessionListQuerySchema,
  AccessSignInSettingsUpdateSchema,
  CreateAccessIdentityProviderSchema,
  CreateAccessServiceTokenSchema,
  UpdateAccessIdentityProviderSchema,
  UpdateAccessServiceTokenSchema,
} from './access-signin.schemas.js';
import { AccessSignInSettingsService } from './access-signin-settings.service.js';

const settings = () => container.resolve(AccessSignInSettingsService);
const providers = () => container.resolve(AccessIdentityProviderService);
const tokens = () => container.resolve(AccessServiceTokenService);
const sessions = () => container.resolve(AccessSessionService);

// Sign-in settings and identity providers decide who can sign in anywhere: admin:system. Service tokens and sessions
// are access list credentials: acl:edit. Anyone who views access lists reads providers and tokens (the list dialog
// offers them as sign-in methods and rule values); secrets are never part of a read.
const readProviders = () => requireAnyScopeBase('admin:system', 'acl:view');
const readTokens = () => requireAnyScopeBase('acl:edit', 'acl:view');

export const accessSettingsRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
accessSettingsRoutes.use('*', authMiddleware);

accessSettingsRoutes.openapi({ ...getAccessSettingsRoute, middleware: requireScope('admin:system') }, async (c) =>
  c.json({ data: await settings().getView() })
);

accessSettingsRoutes.openapi({ ...updateAccessSettingsRoute, middleware: requireScope('admin:system') }, async (c) => {
  const input = AccessSignInSettingsUpdateSchema.parse(await c.req.json());
  const user = c.get('user')!;
  const data = await settings().update(input, { userId: user.id, scopes: c.get('effectiveScopes') ?? [] });
  return c.json({ data });
});

export const accessIdentityProviderRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
accessIdentityProviderRoutes.use('*', authMiddleware);
const providerId = requireUuidParam('id', 'ACCESS_IDENTITY_PROVIDER_NOT_FOUND', 'Identity provider not found');

accessIdentityProviderRoutes.openapi({ ...listAccessIdentityProvidersRoute, middleware: readProviders() }, async (c) =>
  c.json({ data: await providers().list() })
);

accessIdentityProviderRoutes.openapi(
  { ...getAccessIdentityProviderRoute, middleware: providerId(readProviders()) },
  async (c) => c.json({ data: await providers().get(c.req.param('id')!) })
);

accessIdentityProviderRoutes.openapi(
  { ...createAccessIdentityProviderRoute, middleware: requireScope('admin:system') },
  async (c) => {
    const input = CreateAccessIdentityProviderSchema.parse(await c.req.json());
    return c.json({ data: await providers().create(input, c.get('user')!.id) }, 201);
  }
);

accessIdentityProviderRoutes.openapi(
  { ...updateAccessIdentityProviderRoute, middleware: providerId(requireScope('admin:system')) },
  async (c) => {
    const input = UpdateAccessIdentityProviderSchema.parse(await c.req.json());
    return c.json({ data: await providers().update(c.req.param('id')!, input, c.get('user')!.id) });
  }
);

accessIdentityProviderRoutes.openapi(
  { ...deleteAccessIdentityProviderRoute, middleware: providerId(requireScope('admin:system')) },
  async (c) => {
    await providers().delete(c.req.param('id')!, c.get('user')!.id);
    return c.body(null, 204);
  }
);

export const accessServiceTokenRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
accessServiceTokenRoutes.use('*', authMiddleware);
// A token mints no lasting credential: a service token secret would outlive the API or OAuth token's expiry, IP
// allowlist and revocation, so service tokens are created and changed from a browser session, never impersonating.
accessServiceTokenRoutes.on('POST', '/', sessionOnly, rejectImpersonation);
accessServiceTokenRoutes.on('PUT', '/:id', sessionOnly, rejectImpersonation);
const tokenId = requireUuidParam('id', 'ACCESS_SERVICE_TOKEN_NOT_FOUND', 'Service token not found');

accessServiceTokenRoutes.openapi({ ...listAccessServiceTokensRoute, middleware: readTokens() }, async (c) =>
  c.json({ data: await tokens().list() })
);

accessServiceTokenRoutes.openapi({ ...getAccessServiceTokenRoute, middleware: tokenId(readTokens()) }, async (c) =>
  c.json({ data: await tokens().get(c.req.param('id')!) })
);

accessServiceTokenRoutes.openapi(
  { ...createAccessServiceTokenRoute, middleware: requireScope('acl:edit') },
  async (c) => {
    const input = CreateAccessServiceTokenSchema.parse(await c.req.json());
    return c.json({ data: await tokens().create(input, c.get('user')!.id) }, 201);
  }
);

accessServiceTokenRoutes.openapi(
  { ...updateAccessServiceTokenRoute, middleware: tokenId(requireScope('acl:edit')) },
  async (c) => {
    const input = UpdateAccessServiceTokenSchema.parse(await c.req.json());
    return c.json({ data: await tokens().update(c.req.param('id')!, input, c.get('user')!.id) });
  }
);

accessServiceTokenRoutes.openapi(
  { ...deleteAccessServiceTokenRoute, middleware: tokenId(requireScope('acl:edit')) },
  async (c) => {
    await tokens().delete(c.req.param('id')!, c.get('user')!.id);
    return c.body(null, 204);
  }
);

export const accessSessionRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
accessSessionRoutes.use('*', authMiddleware);
const sessionId = requireUuidParam('id', 'ACCESS_SESSION_NOT_FOUND', 'Access session not found');

accessSessionRoutes.openapi({ ...listAccessSessionsRoute, middleware: requireScope('acl:edit') }, async (c) => {
  const query = AccessSessionListQuerySchema.parse(c.req.query());
  return c.json(await sessions().list(query));
});

accessSessionRoutes.openapi(
  { ...revokeAccessSessionRoute, middleware: sessionId(requireScope('acl:edit')) },
  async (c) => {
    await sessions().revoke(c.req.param('id')!, c.get('user')!.id);
    return c.json({ data: { success: true } });
  }
);
