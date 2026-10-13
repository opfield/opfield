import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { oauthAccessTokens, oauthClients, oauthRefreshTokens } from '@/db/schema/index.js';
import { expandFolderScopes } from '@/lib/folder-scopes.js';
import { canonicalizeInboundScopes, canonicalizeScopes, isValidInboundScope } from '@/lib/scopes.js';
import { isClientIpAllowed, isTokenExpired, type TokenRequestContext } from '@/lib/token-limits.js';
import { TOKEN_PREFIXES } from '@/lib/token-prefixes.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { resolveLiveUser } from '@/modules/auth/live-session-user.js';
import type { User } from '@/types.js';
import type { OAuthTokenRequest } from './oauth.schemas.js';

const ACCESS_TOKEN_TTL_SECONDS = 900;
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

export type OAuthTokenResponse = {
  access_token: string;
  token_type: 'Bearer';
  scope: string;
  expires_in?: number;
  refresh_token?: string;
};

type IssuedTokens = {
  refreshTokenId: string | null;
  response: OAuthTokenResponse;
};

type OAuthClientRecord = {
  clientId: string;
  clientName: string;
  clientUri: string | null;
  logoUri: string | null;
};

type OAuthTokenLifecycleDeps = {
  db: DrizzleClient;
  auditService: AuditService;
  getApiResourceUrl: () => string;
  getMcpResourceUrl: () => string;
  getClient: (clientId: string) => Promise<OAuthClientRecord | undefined>;
  isSupportedResource: (resource: string) => boolean;
  assertResourceAllowed: (user: User, resource: string) => void;
  grantScopes: (user: User, resource: string, requestedScopes: string[]) => string[];
};

/**
 * Record that a client was granted a code or token. Housekeeping never purges a
 * registration that was ever granted; a failure here must not fail the grant.
 */
export async function markOAuthClientGranted(db: Pick<DrizzleClient, 'update'>, clientId: string): Promise<void> {
  try {
    await db.update(oauthClients).set({ lastGrantAt: new Date() }).where(eq(oauthClients.clientId, clientId));
  } catch {
    // Best effort: the grant itself already succeeded.
  }
}

export function hashSecret(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function randomSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

function stripNonDelegableMcpScope(scopes: string[]): string[] {
  return scopes.filter((scope) => scope !== 'mcp:use');
}

function resourceWhere(
  table: typeof oauthAccessTokens | typeof oauthRefreshTokens,
  resource: string,
  apiResource: string
) {
  return resource === apiResource
    ? or(isNull(table.resource), eq(table.resource, resource))
    : eq(table.resource, resource);
}

function activeAccessTokenWhere(now: Date) {
  return or(isNull(oauthAccessTokens.expiresAt), gt(oauthAccessTokens.expiresAt, now));
}

/** What the owner may change on a grant besides its scopes; undefined keeps the current value. */
export interface OAuthGrantLimitsUpdate {
  scopes?: string[];
  /** The grant's expiry: no token of it works after this moment; null removes the limit. */
  grantExpiresAt?: Date | null;
  /** Canonical addresses or CIDR ranges (lib/token-limits.ts normalizeAllowedIps); empty allows any address. */
  allowedIps?: string[];
}

/** A token of a grant is no longer valid: its own expiry or the grant's expiry passed. */
function grantTokenExpired(token: { expiresAt: Date | null; grantExpiresAt: Date | null }, now = Date.now()) {
  return isTokenExpired(token.expiresAt, now) || isTokenExpired(token.grantExpiresAt, now);
}

export class OAuthTokenLifecycle {
  constructor(private readonly deps: OAuthTokenLifecycleDeps) {}

  private isMcpResource(resource: string): boolean {
    return resource === this.deps.getMcpResourceUrl();
  }

  async exchangeRefreshToken(input: OAuthTokenRequest, context: TokenRequestContext = {}): Promise<OAuthTokenResponse> {
    if (!input.refresh_token) throw new AppError(400, 'INVALID_REQUEST', 'Refresh token is required');
    const existing = await this.deps.db.query.oauthRefreshTokens.findFirst({
      where: eq(oauthRefreshTokens.tokenHash, hashSecret(input.refresh_token)),
    });
    if (
      !existing ||
      existing.clientId !== input.client_id ||
      existing.expiresAt.getTime() < Date.now() ||
      isTokenExpired(existing.grantExpiresAt)
    ) {
      throw new AppError(400, 'INVALID_GRANT', 'Invalid refresh token');
    }
    // The grant's address limit covers the refresh too: a token stolen elsewhere cannot be renewed.
    if (!isClientIpAllowed(existing.allowedIps, context.clientIp)) {
      throw new AppError(400, 'INVALID_GRANT', 'Invalid refresh token');
    }
    if (existing.revokedAt || existing.replacedByTokenId) {
      await this.revokeRefreshTokenFamily(existing);
      throw new AppError(400, 'INVALID_GRANT', 'Invalid refresh token');
    }
    if (input.resource && input.resource !== (existing.resource ?? this.deps.getApiResourceUrl())) {
      throw new AppError(400, 'INVALID_TARGET', 'Resource does not match the refresh token');
    }

    const user = await resolveLiveUser(this.deps.db, existing.userId);
    if (!user || user.isBlocked) throw new AppError(400, 'INVALID_GRANT', 'User is no longer active');

    const resource = existing.resource ?? this.deps.getApiResourceUrl();
    this.deps.assertResourceAllowed(user, resource);
    const scopes = this.deps.grantScopes(user, resource, existing.scopes);
    if (scopes.length === 0) throw new AppError(400, 'INVALID_GRANT', 'User can no longer grant these scopes');

    const issued = await this.deps.db
      .transaction(async (tx) => {
        const now = new Date();
        const [rotatedToken] = await tx
          .update(oauthRefreshTokens)
          .set({ revokedAt: now })
          .where(
            and(
              eq(oauthRefreshTokens.id, existing.id),
              isNull(oauthRefreshTokens.revokedAt),
              isNull(oauthRefreshTokens.replacedByTokenId)
            )
          )
          .returning({ id: oauthRefreshTokens.id });
        if (!rotatedToken) {
          throw new AppError(400, 'REFRESH_TOKEN_REPLAY', 'Refresh token already used');
        }

        const issuedTokens = await this.issueTokens(
          {
            clientId: existing.clientId,
            userId: existing.userId,
            scopes,
            resource,
            grantExpiresAt: existing.grantExpiresAt,
            allowedIps: existing.allowedIps ?? [],
          },
          tx
        );
        await tx
          .update(oauthRefreshTokens)
          .set({ replacedByTokenId: issuedTokens.refreshTokenId })
          .where(eq(oauthRefreshTokens.id, existing.id));
        return issuedTokens;
      })
      .catch(async (error) => {
        if (error instanceof AppError && error.code === 'REFRESH_TOKEN_REPLAY') {
          await this.revokeRefreshTokenFamily(existing);
          throw new AppError(400, 'INVALID_GRANT', 'Refresh token already used');
        }
        throw error;
      });

    return issued.response;
  }

  async issueTokens(
    input: {
      clientId: string;
      userId: string;
      scopes: string[];
      resource: string;
      /** Limits of the grant a refresh renews; a new consent has none. */
      grantExpiresAt?: Date | null;
      allowedIps?: string[];
    },
    db: Pick<DrizzleClient, 'insert'> = this.deps.db
  ): Promise<IssuedTokens> {
    const accessToken = randomSecret(TOKEN_PREFIXES.oauthAccess);
    const now = Date.now();
    const scopes = canonicalizeScopes(input.scopes);
    const limits = { grantExpiresAt: input.grantExpiresAt ?? null, allowedIps: input.allowedIps ?? [] };
    if (this.isMcpResource(input.resource)) {
      // Accepted MCP design: access-only, long-lived bearer token. MCP clients do
      // not use refresh-token rotation during normal operation; explicit
      // authorization/token revocation is the lifecycle boundary.
      await db.insert(oauthAccessTokens).values({
        tokenHash: hashSecret(accessToken),
        tokenPrefix: accessToken.slice(0, 12),
        clientId: input.clientId,
        userId: input.userId,
        refreshTokenId: null,
        scopes,
        resource: input.resource,
        expiresAt: null,
        ...limits,
      });
      await markOAuthClientGranted(this.deps.db, input.clientId);

      return {
        refreshTokenId: null,
        response: {
          access_token: accessToken,
          token_type: 'Bearer',
          scope: scopes.join(' '),
        },
      };
    }

    const refreshToken = randomSecret(TOKEN_PREFIXES.oauthRefresh);
    const [refresh] = await db
      .insert(oauthRefreshTokens)
      .values({
        tokenHash: hashSecret(refreshToken),
        tokenPrefix: refreshToken.slice(0, 12),
        clientId: input.clientId,
        userId: input.userId,
        scopes,
        resource: input.resource,
        expiresAt: new Date(now + REFRESH_TOKEN_TTL_SECONDS * 1000),
        ...limits,
      })
      .returning();
    await db.insert(oauthAccessTokens).values({
      tokenHash: hashSecret(accessToken),
      tokenPrefix: accessToken.slice(0, 12),
      clientId: input.clientId,
      userId: input.userId,
      refreshTokenId: refresh.id,
      scopes,
      resource: input.resource,
      expiresAt: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000),
      ...limits,
    });
    await markOAuthClientGranted(this.deps.db, input.clientId);

    return {
      refreshTokenId: refresh.id,
      response: {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        scope: scopes.join(' '),
        refresh_token: refreshToken,
      },
    };
  }

  async validateAccessToken(rawToken: string, options: { resource?: string } & TokenRequestContext = {}) {
    const token = await this.deps.db.query.oauthAccessTokens.findFirst({
      where: and(eq(oauthAccessTokens.tokenHash, hashSecret(rawToken)), isNull(oauthAccessTokens.revokedAt)),
    });
    if (!token || grantTokenExpired(token)) return null;
    if (options.resource && (token.resource ?? this.deps.getApiResourceUrl()) !== options.resource) return null;
    // A grant limited to addresses is refused from any other one, like a revoked token.
    if (!isClientIpAllowed(token.allowedIps, options.clientIp)) return null;

    const user = await resolveLiveUser(this.deps.db, token.userId);
    if (!user || user.isBlocked) return null;
    const resource = token.resource ?? this.deps.getApiResourceUrl();
    this.deps.assertResourceAllowed(user, resource);
    // Expand the grant's own folder and node targets before bounding by the owner's expanded scopes, and
    // never expand afterwards: a grant can never reach resources its owner cannot.
    const scopes = this.deps.grantScopes(user, resource, await expandFolderScopes(this.deps.db, token.scopes));
    if (scopes.length === 0) return null;

    this.deps.db
      .update(oauthAccessTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(oauthAccessTokens.id, token.id))
      .execute()
      .catch(() => {});

    return {
      // The owner's live scopes travel with the caller: Git repository checks require both (User.accountScopes).
      user: { ...user, accountScopes: user.scopes },
      scopes,
      tokenId: token.id,
      tokenPrefix: token.tokenPrefix,
      clientId: token.clientId,
    };
  }

  async revokeToken(rawToken: string, clientId?: string): Promise<void> {
    const tokenHash = hashSecret(rawToken);
    const now = new Date();
    const accessWhere = clientId
      ? and(eq(oauthAccessTokens.tokenHash, tokenHash), eq(oauthAccessTokens.clientId, clientId))
      : eq(oauthAccessTokens.tokenHash, tokenHash);
    const refreshWhere = clientId
      ? and(eq(oauthRefreshTokens.tokenHash, tokenHash), eq(oauthRefreshTokens.clientId, clientId))
      : eq(oauthRefreshTokens.tokenHash, tokenHash);
    const revokedRefreshTokens = await this.deps.db
      .update(oauthRefreshTokens)
      .set({ revokedAt: now })
      .where(refreshWhere)
      .returning({
        id: oauthRefreshTokens.id,
        clientId: oauthRefreshTokens.clientId,
        userId: oauthRefreshTokens.userId,
        resource: oauthRefreshTokens.resource,
      });
    const accessRevocations = [this.deps.db.update(oauthAccessTokens).set({ revokedAt: now }).where(accessWhere)];
    if (revokedRefreshTokens.length > 0) {
      await Promise.all(revokedRefreshTokens.map((token) => this.revokeRefreshTokenFamily(token, now)));
    }
    await Promise.all(accessRevocations);
  }

  /**
   * One grant per consent: an MCP access token on its own, or a refresh token chain (every rotation of one consent)
   * with the access tokens it issued. A grant's id is its first token's id, so it stays the same across rotations.
   * Grants of the same client are kept apart: editing or revoking one never touches another.
   */
  private async loadGrants(userId: string, now = new Date()) {
    const [allRefreshTokens, accessTokens, user] = await Promise.all([
      this.deps.db.query.oauthRefreshTokens.findMany({ where: eq(oauthRefreshTokens.userId, userId) }),
      this.deps.db.query.oauthAccessTokens.findMany({
        where: and(
          eq(oauthAccessTokens.userId, userId),
          isNull(oauthAccessTokens.revokedAt),
          activeAccessTokenWhere(now)
        ),
      }),
      resolveLiveUser(this.deps.db, userId),
    ]);
    const parentOf = new Map<string, string>();
    for (const token of allRefreshTokens) {
      if (token.replacedByTokenId) parentOf.set(token.replacedByTokenId, token.id);
    }
    const rootOf = (id: string) => {
      let current = id;
      const seen = new Set<string>();
      while (parentOf.has(current) && !seen.has(current)) {
        seen.add(current);
        current = parentOf.get(current)!;
      }
      return current;
    };

    const apiResource = this.deps.getApiResourceUrl();
    type Grant = {
      id: string;
      clientId: string;
      resource: string;
      scopes: Set<string>;
      refreshTokenIds: string[];
      accessTokenIds: string[];
      createdAt: Date;
      expiresAt: Date | null;
      grantExpiresAt: Date | null;
      allowedIps: string[];
      /** Creation time of the token the limits were read from: the newest token's limits win. */
      limitsFrom: Date;
      lastUsedAt: Date | null;
      activeAccessTokens: number;
      activeRefreshTokens: number;
    };
    const grants = new Map<string, Grant>();
    const ensure = (id: string, clientId: string, resource: string, createdAt: Date) => {
      let grant = grants.get(id);
      if (!grant) {
        grant = {
          id,
          clientId,
          resource,
          scopes: new Set(),
          refreshTokenIds: [],
          accessTokenIds: [],
          createdAt,
          expiresAt: null,
          grantExpiresAt: null,
          allowedIps: [],
          limitsFrom: new Date(0),
          lastUsedAt: null,
          activeAccessTokens: 0,
          activeRefreshTokens: 0,
        };
        grants.set(id, grant);
      }
      if (createdAt < grant.createdAt) grant.createdAt = createdAt;
      return grant;
    };
    const grantedScopes = (resource: string, scopes: string[] | null) =>
      user ? this.deps.grantScopes(user, resource, scopes ?? []) : [];

    const chainCreatedAt = new Map(allRefreshTokens.map((token) => [token.id, token.createdAt]));
    // The tokens of one grant carry the same limits (set together by updateUserAuthorization).
    const takeLimits = (
      grant: Grant,
      token: { grantExpiresAt: Date | null; allowedIps: string[] | null; createdAt: Date }
    ) => {
      if (token.createdAt < grant.limitsFrom) return;
      grant.limitsFrom = token.createdAt;
      grant.grantExpiresAt = token.grantExpiresAt;
      grant.allowedIps = token.allowedIps ?? [];
    };
    const nowMs = now.getTime();
    for (const token of allRefreshTokens) {
      if (token.revokedAt || token.expiresAt <= now || isTokenExpired(token.grantExpiresAt, nowMs)) continue;
      const root = rootOf(token.id);
      const resource = token.resource ?? apiResource;
      const grant = ensure(root, token.clientId, resource, chainCreatedAt.get(root) ?? token.createdAt);
      for (const scope of grantedScopes(resource, token.scopes)) grant.scopes.add(scope);
      grant.refreshTokenIds.push(token.id);
      grant.activeRefreshTokens += 1;
      if (!grant.expiresAt || token.expiresAt > grant.expiresAt) grant.expiresAt = token.expiresAt;
      takeLimits(grant, token);
    }
    for (const token of accessTokens) {
      if (isTokenExpired(token.grantExpiresAt, nowMs)) continue;
      const resource = token.resource ?? apiResource;
      const id = token.refreshTokenId ? rootOf(token.refreshTokenId) : token.id;
      const grant = ensure(id, token.clientId, resource, chainCreatedAt.get(id) ?? token.createdAt);
      for (const scope of grantedScopes(resource, token.scopes)) grant.scopes.add(scope);
      grant.accessTokenIds.push(token.id);
      grant.activeAccessTokens += 1;
      if (token.expiresAt && (!grant.expiresAt || token.expiresAt > grant.expiresAt)) grant.expiresAt = token.expiresAt;
      if (token.lastUsedAt && (!grant.lastUsedAt || token.lastUsedAt > grant.lastUsedAt)) {
        grant.lastUsedAt = token.lastUsedAt;
      }
      takeLimits(grant, token);
    }
    // A grant ends at its own expiry when that comes first (an MCP grant has no other).
    for (const grant of grants.values()) {
      if (grant.grantExpiresAt && (!grant.expiresAt || grant.grantExpiresAt < grant.expiresAt)) {
        grant.expiresAt = grant.grantExpiresAt;
      }
    }
    return grants;
  }

  async listUserAuthorizations(userId: string) {
    const grants = await this.loadGrants(userId);
    if (grants.size === 0) return [];
    const clientIds = [...new Set([...grants.values()].map((grant) => grant.clientId))];
    const clients = await this.deps.db.query.oauthClients.findMany({
      where: inArray(oauthClients.clientId, clientIds),
    });
    const clientById = new Map(clients.map((client) => [client.clientId, client]));

    return [...grants.values()]
      .map((grant) => {
        const client = clientById.get(grant.clientId);
        return {
          id: grant.id,
          clientId: grant.clientId,
          clientName: client?.clientName ?? 'Unknown OAuth Client',
          clientUri: client?.clientUri ?? null,
          logoUri: client?.logoUri ?? null,
          scopes: canonicalizeScopes([...grant.scopes]),
          resource: grant.resource,
          resources: [grant.resource],
          activeAccessTokens: grant.activeAccessTokens,
          activeRefreshTokens: grant.activeRefreshTokens,
          createdAt: grant.createdAt.toISOString(),
          lastUsedAt: grant.lastUsedAt?.toISOString() ?? null,
          expiresAt: grant.expiresAt?.toISOString() ?? null,
          /** The expiry the owner set on the grant (null: none); expiresAt is when it really ends. */
          grantExpiresAt: grant.grantExpiresAt?.toISOString() ?? null,
          allowedIps: grant.allowedIps,
        };
      })
      .sort((a, b) => {
        const aTime = Date.parse(a.lastUsedAt ?? a.createdAt);
        const bTime = Date.parse(b.lastUsedAt ?? b.createdAt);
        return bTime - aTime;
      });
  }

  private async findGrant(userId: string, grantId: string) {
    const grant = (await this.loadGrants(userId)).get(grantId);
    if (!grant) throw new AppError(404, 'OAUTH_AUTHORIZATION_NOT_FOUND', 'OAuth authorization not found');
    return grant;
  }

  async revokeUserAuthorization(userId: string, grantId: string): Promise<{ clientId: string; resource: string }> {
    const grant = await this.findGrant(userId, grantId);
    const client = await this.deps.getClient(grant.clientId);
    const now = new Date();
    await Promise.all([
      grant.accessTokenIds.length
        ? this.deps.db
            .update(oauthAccessTokens)
            .set({ revokedAt: now })
            .where(and(eq(oauthAccessTokens.userId, userId), inArray(oauthAccessTokens.id, grant.accessTokenIds)))
        : null,
      grant.refreshTokenIds.length
        ? this.deps.db
            .update(oauthRefreshTokens)
            .set({ revokedAt: now })
            .where(and(eq(oauthRefreshTokens.userId, userId), inArray(oauthRefreshTokens.id, grant.refreshTokenIds)))
        : null,
      // Access tokens issued by this chain that the list did not load (none are live, but keep the chain closed).
      grant.refreshTokenIds.length
        ? this.deps.db
            .update(oauthAccessTokens)
            .set({ revokedAt: now })
            .where(
              and(
                eq(oauthAccessTokens.userId, userId),
                inArray(oauthAccessTokens.refreshTokenId, grant.refreshTokenIds),
                isNull(oauthAccessTokens.revokedAt)
              )
            )
        : null,
    ]);
    await this.deps.auditService.log({
      userId,
      action: 'oauth.authorization_revoke',
      resourceType: 'oauth-client',
      resourceId: grant.clientId,
      details: {
        clientName: client?.clientName ?? 'Unknown OAuth Client',
        resource: grant.resource,
        authorizationId: grant.id,
      },
    });
    return { clientId: grant.clientId, resource: grant.resource };
  }

  async updateUserAuthorizationScopes(user: User, grantId: string, requestedScopes: string[]) {
    return this.updateUserAuthorization(user, grantId, { scopes: requestedScopes });
  }

  /** Changes a grant's scopes, expiry and allowed addresses; every token of the grant gets them. */
  async updateUserAuthorization(user: User, grantId: string, update: OAuthGrantLimitsUpdate) {
    const grant = await this.findGrant(user.id, grantId);
    const client = await this.deps.getClient(grant.clientId);
    if (!client) throw new AppError(404, 'OAUTH_CLIENT_NOT_FOUND', 'OAuth client not found');
    const resource = grant.resource;
    if (!this.deps.isSupportedResource(resource)) {
      throw new AppError(400, 'INVALID_TARGET', 'OAuth authorization is not available for this resource');
    }

    const patch: { scopes?: string[]; grantExpiresAt?: Date | null; allowedIps?: string[] } = {};
    if (update.scopes !== undefined) {
      const requestedScopes = update.scopes;
      // Retired scope names from older clients are rewritten to the current catalog.
      const canonicalRequestedScopes = canonicalizeInboundScopes(stripNonDelegableMcpScope(requestedScopes));
      if (canonicalRequestedScopes.length === 0) {
        throw new AppError(400, 'INVALID_SCOPE', 'At least one scope is required');
      }

      const invalidScopes = requestedScopes.filter((scope) => !isValidInboundScope(scope));
      if (invalidScopes.length > 0) {
        throw new AppError(400, 'INVALID_SCOPE', `Scopes are not recognized: ${invalidScopes.join(', ')}`);
      }

      this.deps.assertResourceAllowed(user, resource);
      const scopes = this.deps.grantScopes(user, resource, canonicalRequestedScopes);
      if (scopes.length === 0) {
        throw new AppError(400, 'INVALID_SCOPE', `No selected scopes are grantable for resource ${resource}`);
      }
      patch.scopes = scopes;
    }
    if (update.grantExpiresAt !== undefined) patch.grantExpiresAt = update.grantExpiresAt;
    if (update.allowedIps !== undefined) patch.allowedIps = update.allowedIps;
    if (Object.keys(patch).length === 0) {
      throw new AppError(400, 'INVALID_REQUEST', 'Nothing to update');
    }

    // Only this grant's tokens change; other grants of the same client keep their own scopes and limits.
    await Promise.all([
      grant.refreshTokenIds.length
        ? this.deps.db
            .update(oauthRefreshTokens)
            .set(patch)
            .where(and(eq(oauthRefreshTokens.userId, user.id), inArray(oauthRefreshTokens.id, grant.refreshTokenIds)))
        : null,
      grant.accessTokenIds.length
        ? this.deps.db
            .update(oauthAccessTokens)
            .set(patch)
            .where(and(eq(oauthAccessTokens.userId, user.id), inArray(oauthAccessTokens.id, grant.accessTokenIds)))
        : null,
    ]);

    await this.deps.auditService.log({
      userId: user.id,
      action: 'oauth.authorization_update',
      resourceType: 'oauth-client',
      resourceId: grant.clientId,
      details: {
        clientName: client.clientName,
        resource,
        authorizationId: grant.id,
        ...(patch.scopes !== undefined ? { scopes: patch.scopes } : {}),
        ...(patch.grantExpiresAt !== undefined
          ? {
              previousExpiresAt: grant.grantExpiresAt?.toISOString() ?? null,
              expiresAt: patch.grantExpiresAt?.toISOString() ?? null,
            }
          : {}),
        ...(patch.allowedIps !== undefined
          ? { previousAllowedIps: grant.allowedIps, allowedIps: patch.allowedIps }
          : {}),
      },
    });

    const [authorization] = (await this.listUserAuthorizations(user.id)).filter((item) => item.id === grant.id);
    return authorization;
  }

  private async revokeRefreshTokenFamily(
    seed: { id: string; clientId: string; userId: string; resource: string | null },
    now = new Date()
  ): Promise<string[]> {
    const apiResource = this.deps.getApiResourceUrl();
    const familyTokens = await this.deps.db.query.oauthRefreshTokens.findMany({
      where: and(
        eq(oauthRefreshTokens.clientId, seed.clientId),
        eq(oauthRefreshTokens.userId, seed.userId),
        resourceWhere(oauthRefreshTokens, seed.resource ?? apiResource, apiResource)
      ),
    });
    const family = new Set<string>([seed.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const token of familyTokens) {
        if (family.has(token.id) || (token.replacedByTokenId && family.has(token.replacedByTokenId))) {
          if (!family.has(token.id)) {
            family.add(token.id);
            changed = true;
          }
          if (token.replacedByTokenId && !family.has(token.replacedByTokenId)) {
            family.add(token.replacedByTokenId);
            changed = true;
          }
        }
      }
    }

    const ids = [...family];
    await Promise.all([
      this.deps.db.update(oauthRefreshTokens).set({ revokedAt: now }).where(inArray(oauthRefreshTokens.id, ids)),
      this.deps.db
        .update(oauthAccessTokens)
        .set({ revokedAt: now })
        .where(inArray(oauthAccessTokens.refreshTokenId, ids)),
    ]);
    return ids;
  }
}
