import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { getEnv } from '@/config/env.js';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { oauthAuthorizationCodes, oauthClients } from '@/db/schema/index.js';
import { boundScopes, hasScope, isScopeSubset, withDelegableCleanupAdditions } from '@/lib/permissions.js';
import {
  canonicalizeInboundScopes,
  canonicalizeScopes,
  extractBaseScope,
  isApiTokenScope,
  isMcpTokenScope,
  MANUAL_APPROVAL_SCOPE_SET,
  withoutManualApprovalScopes,
} from '@/lib/scopes.js';
import { delegatedScopeIssue } from '@/lib/scopes-schemas.js';
import { OAUTH_CLIENT_ID_PREFIX, TOKEN_PREFIXES } from '@/lib/token-prefixes.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import { resolveLiveUser } from '@/modules/auth/live-session-user.js';
import { oauthAuthorizationChangedChannel } from '@/modules/auth/user-resource-events.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { CacheService } from '@/services/cache.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { User } from '@/types.js';
import type { OAuthAuthorizeQuery, OAuthClientRegistrationInput, OAuthTokenRequest } from './oauth.schemas.js';
import { hashSecret, markOAuthClientGranted, OAuthTokenLifecycle, randomSecret } from './oauth-token-lifecycle.js';

const CONSENT_PREFIX = 'oauth:consent:';
const CONSENT_TTL_SECONDS = 600;
const AUTH_CODE_TTL_SECONDS = 300;

type PendingConsent = {
  id: string;
  userId: string;
  clientId: string;
  clientName: string;
  clientUri: string | null;
  logoUri: string | null;
  redirectUri: string;
  redirectUriIsExternal: boolean;
  state?: string;
  requestedScopes: string[];
  grantableScopes: string[];
  unavailableScopes: string[];
  manualApprovalScopes: string[];
  codeChallenge: string;
  resource: string;
  expiresAt: number;
};

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function parseScopeString(scope: string | undefined): string[] {
  if (!scope?.trim()) return [];
  return [...new Set(scope.trim().split(/\s+/).filter(Boolean))];
}

function assertGrantableScopes(scopes: string[]): void {
  const invalid = scopes.filter((scope) => !isApiTokenScope(scope));
  if (invalid.length > 0) {
    throw new AppError(400, 'INVALID_SCOPE', `Scopes are not grantable: ${invalid.join(', ')}`);
  }
}

function stripNonDelegableMcpScope(scopes: string[]): string[] {
  return scopes.filter((scope) => scope !== 'mcp:use');
}

function getManualApprovalScopes(scopes: string[]): string[] {
  return scopes.filter((scope) => MANUAL_APPROVAL_SCOPE_SET.has(extractBaseScope(scope))).sort();
}

function publicMetadata(input: OAuthClientRegistrationInput): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== '' && value !== null)
  );
}

export function isLoopbackRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isLoopbackHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  return isLoopbackHost && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
}

export function isExternalRedirectUri(uri: string): boolean {
  return !isLoopbackRedirectUri(uri);
}

function assertRedirectUriAllowed(uri: string, extendedCompatibility: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new AppError(400, 'INVALID_REDIRECT_URI', 'Invalid redirect URI');
  }

  if (isLoopbackRedirectUri(uri)) return;
  if (extendedCompatibility && parsed.protocol === 'https:') return;
  throw new AppError(
    400,
    'INVALID_REDIRECT_URI',
    extendedCompatibility
      ? 'Redirect URI must use HTTPS or loopback HTTP'
      : 'OAuth dynamic registration allows only loopback callback URLs unless extended compatibility is enabled'
  );
}

@injectable()
export class OAuthService {
  private readonly tokenLifecycle: OAuthTokenLifecycle;
  private eventBus?: EventBusService;

  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly cacheService: CacheService,
    private readonly auditService: AuditService,
    private readonly authSettingsService: AuthSettingsService,
    private readonly generalSettingsService?: GeneralSettingsService
  ) {
    this.tokenLifecycle = new OAuthTokenLifecycle({
      db: this.db,
      auditService: this.auditService,
      getApiResourceUrl: () => this.getApiResourceUrl(),
      getMcpResourceUrl: () => this.getMcpResourceUrl(),
      getClient: (clientId) => this.getClient(clientId),
      isSupportedResource: (resource) => this.isSupportedResource(resource),
      assertResourceAllowed: (user, resource) => this.assertResourceAllowed(user, resource),
      grantScopes: (user, resource, requestedScopes) => this.grantScopes(user, resource, requestedScopes),
    });
  }

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
  }

  getIssuerUrl(): string {
    return new URL(this.publicUrl()).origin;
  }

  getMcpResourceUrl(): string {
    return new URL('/api/mcp', this.publicUrl()).href;
  }

  getApiResourceUrl(): string {
    return new URL('/api', this.publicUrl()).href;
  }

  getProtectedResourceMetadataUrl(): string {
    return new URL('/.well-known/oauth-protected-resource/api/mcp', this.publicUrl()).href;
  }

  private publicUrl(): string {
    return this.generalSettingsService?.getCachedPublicUrl() ?? getEnv().APP_URL;
  }

  isSupportedResource(resource: string): boolean {
    return resource === this.getApiResourceUrl() || resource === this.getMcpResourceUrl();
  }

  private isMcpResource(resource: string): boolean {
    return resource === this.getMcpResourceUrl();
  }

  assertResourceAllowed(user: User, resource: string): void {
    if (this.isMcpResource(resource) && !hasScope(user.scopes, 'mcp:use')) {
      throw new AppError(403, 'MCP_NOT_ALLOWED', 'Your account is not allowed to use MCP');
    }
  }

  grantScopes(user: User, resource: string, requestedScopes: string[]): string[] {
    const granted = canonicalizeScopes(boundScopes(requestedScopes, user.scopes));
    return granted.filter((scope) => (this.isMcpResource(resource) ? isMcpTokenScope(scope) : isApiTokenScope(scope)));
  }

  async registerClient(input: OAuthClientRegistrationInput) {
    const oauthExtendedCallbackCompatibility = await this.authSettingsService.getOAuthExtendedCallbackCompatibility();
    for (const uri of input.redirect_uris) assertRedirectUriAllowed(uri, oauthExtendedCallbackCompatibility);

    const clientId = `${OAUTH_CLIENT_ID_PREFIX}${randomBytes(18).toString('base64url')}`;
    const clientName = input.client_name?.trim() || 'OAuth Client';
    const [client] = await this.db
      .insert(oauthClients)
      .values({
        clientId,
        clientName,
        clientUri: input.client_uri ?? null,
        logoUri: input.logo_uri || null,
        redirectUris: input.redirect_uris,
        rawMetadata: publicMetadata(input),
      })
      .returning();

    await this.auditService.log({
      userId: null,
      action: 'oauth.client_register',
      resourceType: 'oauth-client',
      resourceId: client.clientId,
      details: { clientName, redirectUris: input.redirect_uris },
    });

    return {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: client.redirectUris,
      client_name: client.clientName,
      client_uri: client.clientUri ?? undefined,
      logo_uri: client.logoUri ?? undefined,
    };
  }

  async getClient(clientId: string) {
    return this.db.query.oauthClients.findFirst({ where: eq(oauthClients.clientId, clientId) });
  }

  async createConsentRequest(user: User, query: OAuthAuthorizeQuery): Promise<PendingConsent> {
    const client = await this.getClient(query.client_id);
    if (!client) throw new AppError(400, 'INVALID_CLIENT', 'Unknown OAuth client');
    if (!client.redirectUris.includes(query.redirect_uri)) {
      throw new AppError(400, 'INVALID_REDIRECT_URI', 'Redirect URI is not registered for this client');
    }
    const oauthExtendedCallbackCompatibility = await this.authSettingsService.getOAuthExtendedCallbackCompatibility();
    assertRedirectUriAllowed(query.redirect_uri, oauthExtendedCallbackCompatibility);

    const rawRequestedScopes = parseScopeString(query.scope);
    const requestedMcpAccess = rawRequestedScopes.includes('mcp:use');
    const delegableRequestedScopes = stripNonDelegableMcpScope(rawRequestedScopes);
    if (delegableRequestedScopes.length === 0) {
      throw new AppError(400, 'INVALID_SCOPE', 'At least one OAuth scope is required');
    }

    const invalidScopes = delegableRequestedScopes.filter((scope) => delegatedScopeIssue(scope) !== null);
    if (invalidScopes.length > 0) {
      throw new AppError(400, 'INVALID_SCOPE', `Scopes are not recognized: ${invalidScopes.join(', ')}`);
    }

    // Clients keep sending retired scope names for a while; rewrite them to the current catalog. The
    // migration 0200 additions the user can delegate are offered too (the consent screen can untick them).
    const rewrittenScopes = canonicalizeInboundScopes(delegableRequestedScopes);
    if (rewrittenScopes.length === 0) {
      throw new AppError(400, 'INVALID_SCOPE', 'None of the requested OAuth scopes exist any more');
    }
    const requestedScopes = withDelegableCleanupAdditions(rewrittenScopes, user.scopes);
    const resource = query.resource ?? (requestedMcpAccess ? this.getMcpResourceUrl() : this.getApiResourceUrl());
    if (!this.isSupportedResource(resource)) {
      throw new AppError(400, 'INVALID_TARGET', 'OAuth authorization is not available for this resource');
    }
    this.assertResourceAllowed(user, resource);

    const grantableScopes = this.grantScopes(user, resource, requestedScopes);
    const unavailableScopes = requestedScopes.filter((scope) => !grantableScopes.includes(scope));

    const pending: PendingConsent = {
      id: randomBytes(18).toString('base64url'),
      userId: user.id,
      clientId: client.clientId,
      clientName: client.clientName,
      clientUri: client.clientUri,
      logoUri: client.logoUri,
      redirectUri: query.redirect_uri,
      redirectUriIsExternal: isExternalRedirectUri(query.redirect_uri),
      state: query.state,
      requestedScopes,
      grantableScopes,
      unavailableScopes,
      manualApprovalScopes: getManualApprovalScopes(grantableScopes),
      codeChallenge: query.code_challenge,
      resource,
      expiresAt: Date.now() + CONSENT_TTL_SECONDS * 1000,
    };

    await this.cacheService.set(`${CONSENT_PREFIX}${pending.id}`, pending, CONSENT_TTL_SECONDS);
    return pending;
  }

  async getConsentRequest(requestId: string, user: User): Promise<PendingConsent> {
    const pending = await this.cacheService.get<PendingConsent>(`${CONSENT_PREFIX}${requestId}`);
    if (!pending || pending.expiresAt < Date.now()) {
      throw new AppError(404, 'OAUTH_REQUEST_EXPIRED', 'OAuth authorization request expired');
    }
    if (pending.userId !== user.id) {
      throw new AppError(403, 'OAUTH_REQUEST_USER_MISMATCH', 'This OAuth request belongs to another account');
    }

    const oauthExtendedCallbackCompatibility = await this.authSettingsService.getOAuthExtendedCallbackCompatibility();
    assertRedirectUriAllowed(pending.redirectUri, oauthExtendedCallbackCompatibility);

    this.assertResourceAllowed(user, pending.resource);
    const grantableScopes = this.grantScopes(user, pending.resource, pending.requestedScopes);
    const unavailableScopes = pending.requestedScopes.filter((scope) => !grantableScopes.includes(scope));

    return {
      ...pending,
      redirectUriIsExternal: pending.redirectUriIsExternal ?? isExternalRedirectUri(pending.redirectUri),
      grantableScopes,
      unavailableScopes,
      manualApprovalScopes: getManualApprovalScopes(grantableScopes),
    };
  }

  async approveConsent(requestId: string, user: User, selectedScopes?: string[]): Promise<string> {
    const pending = await this.getConsentRequest(requestId, user);
    const scopes =
      selectedScopes === undefined
        ? canonicalizeScopes(withoutManualApprovalScopes(pending.grantableScopes))
        : canonicalizeInboundScopes(selectedScopes);
    assertGrantableScopes(scopes);
    if (!isScopeSubset(scopes, pending.grantableScopes)) {
      throw new AppError(403, 'SCOPE_NOT_ALLOWED', 'Selected scopes exceed the current user permissions');
    }
    if (scopes.length === 0) {
      throw new AppError(403, 'SCOPE_NOT_ALLOWED', 'At least one scope must be selected');
    }

    await this.claimConsentRequest(requestId, pending);

    const code = randomSecret(TOKEN_PREFIXES.oauthCode);
    const [record] = await this.db
      .insert(oauthAuthorizationCodes)
      .values({
        codeHash: hashSecret(code),
        clientId: pending.clientId,
        userId: user.id,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        requestedScopes: pending.requestedScopes,
        scopes,
        resource: pending.resource,
        expiresAt: new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000),
      })
      .returning();
    await markOAuthClientGranted(this.db, pending.clientId);
    await this.auditService.log({
      userId: user.id,
      action: 'oauth.authorize',
      resourceType: 'oauth-client',
      resourceId: pending.clientId,
      details: { codeId: record.id, clientName: pending.clientName, requestedScopes: pending.requestedScopes, scopes },
    });

    const redirect = new URL(pending.redirectUri);
    redirect.searchParams.set('code', code);
    if (pending.state) redirect.searchParams.set('state', pending.state);
    return redirect.href;
  }

  async denyConsent(requestId: string, user: User): Promise<string> {
    const pending = await this.getConsentRequest(requestId, user);
    await this.claimConsentRequest(requestId, pending);
    await this.auditService.log({
      userId: user.id,
      action: 'oauth.deny',
      resourceType: 'oauth-client',
      resourceId: pending.clientId,
      details: { clientName: pending.clientName, requestedScopes: pending.requestedScopes },
    });

    const redirect = new URL(pending.redirectUri);
    redirect.searchParams.set('error', 'access_denied');
    if (pending.state) redirect.searchParams.set('state', pending.state);
    return redirect.href;
  }

  private async claimConsentRequest(requestId: string, expected: PendingConsent): Promise<void> {
    const claimed = await this.cacheService.take<PendingConsent>(`${CONSENT_PREFIX}${requestId}`);
    if (!claimed || claimed.id !== expected.id || claimed.userId !== expected.userId) {
      throw new AppError(404, 'OAUTH_REQUEST_EXPIRED', 'OAuth authorization request expired');
    }
  }

  async exchangeToken(input: OAuthTokenRequest) {
    if (input.grant_type === 'authorization_code') return this.exchangeAuthorizationCode(input);
    return this.tokenLifecycle.exchangeRefreshToken(input);
  }

  private async exchangeAuthorizationCode(input: OAuthTokenRequest) {
    if (!input.code || !input.redirect_uri || !input.code_verifier) {
      throw new AppError(400, 'INVALID_REQUEST', 'Authorization code, redirect URI, and code verifier are required');
    }

    const code = await this.db.query.oauthAuthorizationCodes.findFirst({
      where: eq(oauthAuthorizationCodes.codeHash, hashSecret(input.code)),
    });
    if (!code || code.clientId !== input.client_id || code.redirectUri !== input.redirect_uri || code.usedAt) {
      throw new AppError(400, 'INVALID_GRANT', 'Invalid authorization code');
    }
    if (code.expiresAt.getTime() < Date.now()) throw new AppError(400, 'INVALID_GRANT', 'Authorization code expired');
    if (input.resource && input.resource !== (code.resource ?? this.getApiResourceUrl())) {
      throw new AppError(400, 'INVALID_TARGET', 'Resource does not match the authorization grant');
    }
    if (pkceChallenge(input.code_verifier) !== code.codeChallenge) {
      throw new AppError(400, 'INVALID_GRANT', 'Invalid PKCE verifier');
    }

    const user = await resolveLiveUser(this.db, code.userId);
    if (!user || user.isBlocked) throw new AppError(400, 'INVALID_GRANT', 'User is no longer active');
    const resource = code.resource ?? this.getApiResourceUrl();
    this.assertResourceAllowed(user, resource);
    const scopes = this.grantScopes(user, resource, code.scopes);
    if (scopes.length === 0) throw new AppError(400, 'INVALID_GRANT', 'User can no longer grant these scopes');

    const [usedCode] = await this.db
      .update(oauthAuthorizationCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(oauthAuthorizationCodes.id, code.id), isNull(oauthAuthorizationCodes.usedAt)))
      .returning({ id: oauthAuthorizationCodes.id });
    if (!usedCode) throw new AppError(400, 'INVALID_GRANT', 'Authorization code already used');

    const issued = await this.tokenLifecycle.issueTokens({
      clientId: code.clientId,
      userId: code.userId,
      scopes,
      resource,
    });
    return issued.response;
  }

  async validateAccessToken(rawToken: string, options: { resource?: string } = {}) {
    return this.tokenLifecycle.validateAccessToken(rawToken, options);
  }

  async revokeToken(rawToken: string, clientId?: string): Promise<void> {
    return this.tokenLifecycle.revokeToken(rawToken, clientId);
  }

  async listUserAuthorizations(userId: string) {
    return this.tokenLifecycle.listUserAuthorizations(userId);
  }

  async revokeUserAuthorization(userId: string, authorizationId: string): Promise<void> {
    const { clientId, resource } = await this.tokenLifecycle.revokeUserAuthorization(userId, authorizationId);
    this.eventBus?.publish(oauthAuthorizationChangedChannel(userId), {
      action: 'revoke',
      clientId,
      resource,
      userId,
    });
  }

  async updateUserAuthorizationScopes(user: User, authorizationId: string, requestedScopes: string[]) {
    const authorization = await this.tokenLifecycle.updateUserAuthorizationScopes(
      user,
      authorizationId,
      requestedScopes
    );
    this.eventBus?.publish(oauthAuthorizationChangedChannel(user.id), {
      action: 'update',
      clientId: authorization?.clientId,
      resource: authorization?.resource,
      userId: user.id,
    });
    return authorization;
  }
}
