import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { container } from '@/container.js';
import { getClientIpForContext } from '@/lib/request-ip.js';
import { API_TOKEN_SCOPES, MCP_TOKEN_SCOPES } from '@/lib/scopes.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  assertNotImpersonating,
  authMiddleware,
  optionalAuthMiddleware,
  sessionOnly,
} from '@/modules/auth/auth.middleware.js';
import { getPublicAuthMethods } from '@/modules/auth/public-auth-methods.js';
import { isDemoMode } from '@/modules/demo/demo-mode.js';
import type { AppEnv } from '@/types.js';
import {
  OAuthAuthorizationScopesSchema,
  OAuthAuthorizeQuerySchema,
  OAuthClientRegistrationSchema,
  OAuthConsentDecisionSchema,
  OAuthRevocationRequestSchema,
  OAuthTokenRequestSchema,
} from './oauth.schemas.js';
import { OAuthService } from './oauth.service.js';

export const oauthRoutes = new Hono<AppEnv>();
export const oauthMetadataRoutes = new Hono<AppEnv>();

const disableOAuthInDemo = async (c: Context<AppEnv>, next: () => Promise<void>) => {
  if (isDemoMode()) return c.json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
  await next();
};

oauthRoutes.use('*', disableOAuthInDemo);
oauthMetadataRoutes.use('*', disableOAuthInDemo);

function oauthService() {
  return container.resolve(OAuthService);
}

function oauthError(error: string, description: string, status = 400) {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function oauthBrowserErrorUrl(code: string, message: string): string {
  const url = new URL('/oauth/error', oauthService().getIssuerUrl());
  url.searchParams.set('code', code);
  url.searchParams.set('message', message);
  return url.href;
}

function oauthClientErrorRedirectUrl(redirectUri: string, error: string, description: string, state?: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  return url.href;
}

function supportedScopes(resource?: string) {
  const service = oauthService();
  if (resource === service.getMcpResourceUrl()) return MCP_TOKEN_SCOPES;
  return API_TOKEN_SCOPES.filter((scope) => resource !== service.getApiResourceUrl() || scope !== 'mcp:use');
}

function resourceInfo(resource: string) {
  const service = oauthService();
  if (resource === service.getMcpResourceUrl()) {
    return {
      resource,
      name: 'Opfield MCP',
      description: 'Remote MCP access for AI and MCP clients.',
    };
  }
  return {
    resource,
    name: 'Opfield API',
    description: 'REST API access for CLI and external applications.',
  };
}

function authorizationServerMetadata(resource?: string) {
  const service = oauthService();
  const issuer = service.getIssuerUrl();
  const authorizationEndpoint =
    resource === service.getMcpResourceUrl()
      ? new URL('/api/oauth/authorize/api/mcp', issuer).href
      : new URL('/api/oauth/authorize', issuer).href;
  const grantTypesSupported =
    resource === service.getMcpResourceUrl() ? ['authorization_code'] : ['authorization_code', 'refresh_token'];
  return {
    issuer,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: new URL('/api/oauth/token', issuer).href,
    registration_endpoint: new URL('/api/oauth/register', issuer).href,
    revocation_endpoint: new URL('/api/oauth/revoke', issuer).href,
    scopes_supported: supportedScopes(resource),
    response_types_supported: ['code'],
    grant_types_supported: grantTypesSupported,
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
  };
}

oauthMetadataRoutes.get('/oauth-protected-resource', (c) => {
  const service = oauthService();
  return c.json({
    resource: service.getApiResourceUrl(),
    authorization_servers: [service.getIssuerUrl()],
    scopes_supported: supportedScopes(service.getApiResourceUrl()),
    bearer_methods_supported: ['header'],
    resource_name: 'Opfield API',
  });
});

oauthMetadataRoutes.get('/oauth-protected-resource/api', (c) => {
  const service = oauthService();
  return c.json({
    resource: service.getApiResourceUrl(),
    authorization_servers: [service.getIssuerUrl()],
    scopes_supported: supportedScopes(service.getApiResourceUrl()),
    bearer_methods_supported: ['header'],
    resource_name: 'Opfield API',
  });
});

oauthMetadataRoutes.get('/oauth-protected-resource/api/mcp', (c) => {
  const service = oauthService();
  return c.json({
    resource: service.getMcpResourceUrl(),
    authorization_servers: [service.getIssuerUrl()],
    scopes_supported: supportedScopes(service.getMcpResourceUrl()),
    bearer_methods_supported: ['header'],
    resource_name: 'Opfield MCP',
  });
});

oauthMetadataRoutes.get('/oauth-authorization-server', (c) => {
  const resource = c.req.path.startsWith('/api/mcp/.well-known') ? oauthService().getMcpResourceUrl() : undefined;
  return c.json(authorizationServerMetadata(resource));
});

oauthMetadataRoutes.get('/oauth-authorization-server/api/mcp', (c) => {
  return c.json(authorizationServerMetadata(oauthService().getMcpResourceUrl()));
});

oauthMetadataRoutes.get('/openid-configuration', (c) => {
  const resource = c.req.path.startsWith('/api/mcp/.well-known') ? oauthService().getMcpResourceUrl() : undefined;
  return c.json(authorizationServerMetadata(resource));
});

oauthMetadataRoutes.get('/openid-configuration/api/mcp', (c) => {
  return c.json(authorizationServerMetadata(oauthService().getMcpResourceUrl()));
});

oauthRoutes.post('/register', async (c) => {
  const rawBody = await c.req.json();
  const input = OAuthClientRegistrationSchema.parse(rawBody);
  return c.json(await oauthService().registerClient(input), 201);
});

/**
 * Send a signed-out browser to sign in and come back to this authorization
 * request. `/auth/login` only speaks OIDC, so it is used only when OIDC is the
 * sole interactive method; every other install goes through the login page,
 * which offers every enabled method and forwards `return_to` itself.
 */
export async function oauthLoginRedirectUrl(requestUrl: string): Promise<string> {
  const issuer = oauthService().getIssuerUrl();
  const request = new URL(requestUrl);
  const returnTo = new URL(`${request.pathname}${request.search}`, issuer).href;
  const methods = await getPublicAuthMethods().catch(() => null);
  const oidcOnly = Boolean(methods?.oidc && !methods.password && !methods.emailOtp && !methods.passkeyLogin);
  const loginUrl = new URL(oidcOnly ? '/auth/login' : '/login', issuer);
  loginUrl.searchParams.set('return_to', returnTo);
  return loginUrl.href;
}

async function handleAuthorize(c: Context<AppEnv>, defaultResource?: string) {
  const parsedQuery = OAuthAuthorizeQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsedQuery.success) {
    return c.redirect(oauthBrowserErrorUrl('INVALID_REQUEST', 'Invalid OAuth authorization request'), 302);
  }

  const query = parsedQuery.data;
  if (defaultResource && !query.resource) query.resource = defaultResource;
  const user = c.get('user');
  if (!user || c.get('authType') !== 'session') {
    return c.redirect(await oauthLoginRedirectUrl(c.req.url), 302);
  }
  if (user.isBlocked) return c.redirect(oauthBrowserErrorUrl('ACCOUNT_BLOCKED', 'Account is blocked'), 302);
  if (c.get('impersonation')) {
    return c.redirect(
      oauthBrowserErrorUrl(
        'IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN',
        'OAuth authorization is unavailable while impersonating'
      ),
      302
    );
  }

  let pending: Awaited<ReturnType<OAuthService['createConsentRequest']>>;
  try {
    pending = await oauthService().createConsentRequest(user, query);
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === 'INVALID_SCOPE') {
        return c.redirect(
          oauthClientErrorRedirectUrl(query.redirect_uri, 'invalid_scope', error.message, query.state),
          302
        );
      }
      return c.redirect(oauthBrowserErrorUrl(error.code, error.message), 302);
    }
    throw error;
  }
  const consentUrl = new URL('/oauth/consent', oauthService().getIssuerUrl());
  consentUrl.searchParams.set('request', pending.id);
  return c.redirect(consentUrl.href, 302);
}

oauthRoutes.get('/authorize/api/mcp', optionalAuthMiddleware, async (c) => {
  return handleAuthorize(c, oauthService().getMcpResourceUrl());
});

oauthRoutes.get('/authorize', optionalAuthMiddleware, async (c) => {
  return handleAuthorize(c);
});

oauthRoutes.post('/token', async (c) => {
  const contentType = c.req.header('content-type') ?? '';
  const body = contentType.includes('application/json')
    ? await c.req.json()
    : Object.fromEntries(new URLSearchParams(await c.req.text()));
  const parsed = OAuthTokenRequestSchema.safeParse(body);
  if (!parsed.success) return oauthError('invalid_request', 'Invalid token request', 400);

  try {
    return c.json(await oauthService().exchangeToken(parsed.data, { clientIp: await getClientIpForContext(c) }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid token request';
    return oauthError(message.includes('Resource') ? 'invalid_target' : 'invalid_grant', message, 400);
  }
});

oauthRoutes.post('/revoke', async (c) => {
  const contentType = c.req.header('content-type') ?? '';
  const body = contentType.includes('application/json')
    ? await c.req.json()
    : Object.fromEntries(new URLSearchParams(await c.req.text()));
  const parsed = OAuthRevocationRequestSchema.safeParse(body);
  if (!parsed.success) return oauthError('invalid_request', 'Invalid revocation request', 400);
  await oauthService().revokeToken(parsed.data.token, parsed.data.client_id);
  return c.body(null, 200);
});

oauthRoutes.use('/authorizations', authMiddleware);
oauthRoutes.use('/authorizations', sessionOnly);
oauthRoutes.use('/authorizations/*', authMiddleware);
oauthRoutes.use('/authorizations/*', sessionOnly);

oauthRoutes.get('/authorizations', async (c) => {
  const authorizations = await oauthService().listUserAuthorizations(c.get('user')!.id);
  return c.json({ data: authorizations });
});

// One authorization is one consent (its own tokens and scopes); the id comes from GET /authorizations.
// Changing or revoking the subject's grants outlives an impersonation session, so only the subject does it.
oauthRoutes.delete('/authorizations/:authorizationId', async (c) => {
  assertNotImpersonating(c, 'OAuth authorizations cannot be changed while impersonating');
  const authorizationId = z.string().min(1).parse(c.req.param('authorizationId'));
  await oauthService().revokeUserAuthorization(c.get('user')!.id, authorizationId);
  return c.json({ success: true });
});

oauthRoutes.patch('/authorizations/:authorizationId', async (c) => {
  assertNotImpersonating(c, 'OAuth authorizations cannot be changed while impersonating');
  const authorizationId = z.string().min(1).parse(c.req.param('authorizationId'));
  const body = OAuthAuthorizationScopesSchema.parse(await c.req.json());
  const authorization = await oauthService().updateUserAuthorization(c.get('user')!, authorizationId, body);
  return c.json({ data: authorization });
});

oauthRoutes.use('/consent/*', authMiddleware);
oauthRoutes.use('/consent/*', sessionOnly);

oauthRoutes.get('/consent/:requestId', async (c) => {
  const requestId = z.string().min(1).parse(c.req.param('requestId'));
  const user = c.get('user')!;
  const pending = await oauthService().getConsentRequest(requestId, user);
  return c.json({
    requestId: pending.id,
    client: {
      id: pending.clientId,
      name: pending.clientName,
      uri: pending.clientUri,
      logoUri: pending.logoUri,
    },
    account: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
    },
    requestedScopes: pending.requestedScopes,
    grantableScopes: pending.grantableScopes,
    unavailableScopes: pending.unavailableScopes,
    manualApprovalScopes: pending.manualApprovalScopes,
    redirect: {
      uri: pending.redirectUri,
      isExternal: pending.redirectUriIsExternal,
    },
    resource: pending.resource,
    resourceInfo: resourceInfo(pending.resource),
    expiresAt: new Date(pending.expiresAt).toISOString(),
  });
});

oauthRoutes.post('/consent/:requestId/approve', async (c) => {
  assertNotImpersonating(c, 'OAuth authorization is unavailable while impersonating');
  const requestId = z.string().min(1).parse(c.req.param('requestId'));
  const input = OAuthConsentDecisionSchema.parse(await c.req.json().catch(() => ({})));
  const redirectUrl = await oauthService().approveConsent(requestId, c.get('user')!, input.scopes);
  return c.json({ redirectUrl });
});

oauthRoutes.post('/consent/:requestId/deny', async (c) => {
  const requestId = z.string().min(1).parse(c.req.param('requestId'));
  const redirectUrl = await oauthService().denyConsent(requestId, c.get('user')!);
  return c.json({ redirectUrl });
});
