import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { apiTokens } from '@/db/schema/index.js';
import { expandFolderScopes } from '@/lib/folder-scopes.js';
import { createChildLogger } from '@/lib/logger.js';
import { boundScopes, hasScope as permissionHasScope, withDelegableCleanupAdditions } from '@/lib/permissions.js';
import { canonicalizeInboundScopes, canonicalizeScopes, isApiTokenScope } from '@/lib/scopes.js';
import {
  isClientIpAllowed,
  isTokenExpired,
  normalizeAllowedIps,
  parseTokenExpiry,
  type TokenRequestContext,
} from '@/lib/token-limits.js';
import { TOKEN_PREFIXES } from '@/lib/token-prefixes.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { getAuditRequestContext } from '@/modules/audit/audit-request-context.js';
import { resolveLiveUser } from '@/modules/auth/live-session-user.js';
import { apiTokenChangedChannel } from '@/modules/auth/user-resource-events.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { User } from '@/types.js';
import {
  assertTokenRegistryAccessAllowed,
  hasRegistryAccess,
  isLegacyRegistryScope,
  mergeRegistryAccess,
  splitRegistryScopes,
  type TokenRegistryAccess,
  tokenRegistryAccess,
} from './token-registry-access.js';
import type { CreateTokenInput, UpdateTokenInput } from './tokens.schemas.js';

const logger = createChildLogger('TokensService');

/**
 * Defense in depth for paths that do not go through the token routes (for
 * example AI tools): an impersonated request must never mint or widen a
 * long-lived credential for the impersonated user.
 */
function assertNotImpersonatedRequest(): void {
  if (getAuditRequestContext()?.impersonation) {
    throw new AppError(
      403,
      'IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN',
      'API tokens cannot be managed while impersonating'
    );
  }
}

/** The expiry and address limits of a token as the API shows them. */
function serializeTokenLimits(token: { expiresAt: Date | null; allowedIps: string[] | null }) {
  return {
    expiresAt: token.expiresAt?.toISOString() ?? null,
    expired: isTokenExpired(token.expiresAt),
    allowedIps: token.allowedIps ?? [],
  };
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Turn client-supplied token scopes into the stored set: retired names are rewritten, and a new token
 * also receives the migration 0200 additions its owner can delegate, unless the client asks for exactly
 * its scopes (the token dialog does). A list that ends up empty (only removed scopes) is rejected rather
 * than minting a token without scopes.
 */
export function resolveRequestedTokenScopes(
  requested: readonly string[],
  ownerScopes: readonly string[],
  purpose: 'create' | 'update',
  { exact = false }: { exact?: boolean } = {}
): string[] {
  const canonical = canonicalizeInboundScopes(requested);
  // An empty list is a registry-only token (CreateTokenSchema requires registry access then).
  if (canonical.length === 0 && requested.length > 0) {
    throw new AppError(400, 'INVALID_SCOPE', 'None of the requested scopes exist any more');
  }
  return purpose === 'create' && !exact ? withDelegableCleanupAdditions(canonical, ownerScopes) : canonical;
}

/**
 * Check the internal registry access a client asks a token for (its registryAccess and any legacy registry scopes in
 * its scope list) against the owner's scopes, and return the scopes to bound by the owner's grants: the legacy
 * registry scopes are a token attribute now, which the owner need not hold.
 */
export function authorizeRequestedRegistryAccess(
  input: { scopes?: readonly string[]; registryAccess?: TokenRegistryAccess },
  ownerScopes: string[]
): string[] {
  const split = splitRegistryScopes(input.scopes ?? []);
  assertTokenRegistryAccessAllowed(mergeRegistryAccess(input.registryAccess, split.registryAccess), ownerScopes);
  return split.scopes;
}

function assertTokenNotEmpty(scopes: readonly string[], registryAccess: TokenRegistryAccess): void {
  if (scopes.length === 0 && !hasRegistryAccess(registryAccess)) {
    throw new AppError(400, 'INVALID_SCOPE', 'A token needs at least one scope or registry access');
  }
}

@injectable()
export class TokensService {
  private eventBus?: EventBusService;

  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly auditService: AuditService
  ) {}

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
  }

  async createToken(userId: string, input: CreateTokenInput) {
    assertNotImpersonatedRequest();
    const raw = `${TOKEN_PREFIXES.api}${randomBytes(32).toString('hex')}`;
    const tokenHash = hashToken(raw);
    const tokenPrefix = raw.slice(0, 10);
    // Legacy registry scopes in the request become the token's registry access.
    const requested = splitRegistryScopes(canonicalizeScopes(input.scopes).filter(isApiTokenScope));
    const scopes = requested.scopes;
    const registryAccess = mergeRegistryAccess(input.registryAccess, requested.registryAccess);
    assertTokenNotEmpty(scopes, registryAccess);
    const expiresAt = parseTokenExpiry(input.expiresAt) ?? null;
    const allowedIps = normalizeAllowedIps(input.allowedIps);

    const [token] = await this.db
      .insert(apiTokens)
      .values({
        userId,
        name: input.name,
        tokenHash,
        tokenPrefix,
        scopes,
        registryAccess,
        expiresAt,
        allowedIps,
      })
      .returning();

    logger.info('Created API token', { tokenId: token.id, userId, scopes, registryAccess });
    await this.auditService.log({
      userId,
      action: 'api_token.create',
      resourceType: 'api-token',
      resourceId: token.id,
      details: {
        name: token.name,
        scopes: token.scopes,
        registryAccess,
        expiresAt: expiresAt?.toISOString() ?? null,
        allowedIps,
      },
    });
    this.eventBus?.publish(apiTokenChangedChannel(userId), { action: 'create', id: token.id, userId });

    return {
      id: token.id,
      name: token.name,
      tokenPrefix: token.tokenPrefix,
      scopes: token.scopes.filter(isApiTokenScope),
      registryAccess,
      ...serializeTokenLimits(token),
      lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
      createdAt: token.createdAt.toISOString(),
      token: raw,
    };
  }

  async listTokens(userId: string) {
    const [tokens, user] = await Promise.all([
      this.db.query.apiTokens.findMany({
        where: eq(apiTokens.userId, userId),
      }),
      resolveLiveUser(this.db, userId),
    ]);
    const ownerScopes = user?.scopes ?? [];

    return tokens.map((t) => ({
      id: t.id,
      name: t.name,
      tokenPrefix: t.tokenPrefix,
      // Legacy registry scopes are shown as the token's registry access.
      scopes: canonicalizeScopes(boundScopes(t.scopes, ownerScopes)).filter(
        (scope) => isApiTokenScope(scope) && !isLegacyRegistryScope(scope)
      ),
      registryAccess: tokenRegistryAccess(t),
      ...serializeTokenLimits(t),
      lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
    }));
  }

  async renameToken(userId: string, tokenId: string, name: string): Promise<void> {
    await this.updateToken(userId, tokenId, { name });
  }

  async updateToken(userId: string, tokenId: string, input: UpdateTokenInput): Promise<void> {
    assertNotImpersonatedRequest();
    const token = await this.db.query.apiTokens.findFirst({
      where: and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId)),
    });
    if (!token) throw new AppError(404, 'TOKEN_NOT_FOUND', 'Token not found');
    const patch: Partial<typeof apiTokens.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    const expiresAt = parseTokenExpiry(input.expiresAt);
    if (expiresAt !== undefined) patch.expiresAt = expiresAt;
    if (input.allowedIps !== undefined) patch.allowedIps = normalizeAllowedIps(input.allowedIps);
    const storedLegacy = (token.scopes ?? []).some(isLegacyRegistryScope);
    let requestedRegistryAccess: TokenRegistryAccess = {};
    if (input.scopes !== undefined) {
      const requested = splitRegistryScopes(canonicalizeScopes(input.scopes).filter(isApiTokenScope));
      patch.scopes = requested.scopes;
      requestedRegistryAccess = requested.registryAccess;
    } else if (input.registryAccess !== undefined && storedLegacy) {
      patch.scopes = token.scopes.filter((scope) => !isLegacyRegistryScope(scope));
    }
    // registryAccess replaces the token's access. New scopes drop the legacy registry scopes stored with the token,
    // which keep counting by moving into the attribute.
    if (
      input.registryAccess !== undefined ||
      (input.scopes !== undefined && (storedLegacy || hasRegistryAccess(requestedRegistryAccess)))
    ) {
      patch.registryAccess = mergeRegistryAccess(
        input.registryAccess ?? tokenRegistryAccess(token),
        requestedRegistryAccess
      );
    }
    assertTokenNotEmpty(
      (patch.scopes ?? token.scopes ?? []).filter((scope) => !isLegacyRegistryScope(scope)),
      patch.registryAccess ?? tokenRegistryAccess(token)
    );
    await this.db.update(apiTokens).set(patch).where(eq(apiTokens.id, tokenId));
    const changed =
      input.scopes !== undefined ||
      input.registryAccess !== undefined ||
      patch.expiresAt !== undefined ||
      patch.allowedIps !== undefined;
    await this.auditService.log({
      userId,
      action: changed ? 'api_token.update' : 'api_token.rename',
      resourceType: 'api-token',
      resourceId: tokenId,
      details: {
        name: input.name ?? token.name,
        ...(patch.scopes !== undefined ? { previousScopes: token.scopes, scopes: patch.scopes } : {}),
        ...(patch.registryAccess !== undefined
          ? { previousRegistryAccess: tokenRegistryAccess(token), registryAccess: patch.registryAccess }
          : {}),
        ...(patch.expiresAt !== undefined
          ? {
              previousExpiresAt: token.expiresAt?.toISOString() ?? null,
              expiresAt: patch.expiresAt?.toISOString() ?? null,
            }
          : {}),
        ...(patch.allowedIps !== undefined
          ? { previousAllowedIps: token.allowedIps ?? [], allowedIps: patch.allowedIps }
          : {}),
      },
    });
    this.eventBus?.publish(apiTokenChangedChannel(userId), { action: 'update', id: tokenId, userId });
  }

  async revokeToken(userId: string, tokenId: string): Promise<void> {
    const token = await this.db.query.apiTokens.findFirst({
      where: and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId)),
    });

    if (!token) {
      throw new AppError(404, 'TOKEN_NOT_FOUND', 'Token not found');
    }

    await this.db.delete(apiTokens).where(eq(apiTokens.id, tokenId));
    logger.info('Revoked API token', { tokenId, userId });
    await this.auditService.log({
      userId,
      action: 'api_token.revoke',
      resourceType: 'api-token',
      resourceId: tokenId,
      details: { name: token.name, scopes: token.scopes },
    });
    this.eventBus?.publish(apiTokenChangedChannel(userId), { action: 'revoke', id: tokenId, userId });
  }

  /**
   * The owner and scopes of a raw token used by a request from `context.clientIp`, or null. An expired token, or one
   * limited to other addresses, is refused like a revoked one.
   */
  async validateToken(
    rawToken: string,
    context: TokenRequestContext = {}
  ): Promise<{
    user: User;
    scopes: string[];
    registryAccess: TokenRegistryAccess;
    tokenId: string;
    tokenPrefix: string;
  } | null> {
    const tokenHash = hashToken(rawToken);

    const token = await this.db.query.apiTokens.findFirst({
      where: eq(apiTokens.tokenHash, tokenHash),
    });

    if (!token) return null;
    if (isTokenExpired(token.expiresAt)) return null;
    if (!isClientIpAllowed(token.allowedIps, context.clientIp)) return null;

    this.db
      .update(apiTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiTokens.id, token.id))
      .execute()
      .catch((err) => logger.error('Failed to update lastUsedAt', { err }));

    const user = await resolveLiveUser(this.db, token.userId);

    if (!user) return null;
    if (user.isBlocked) return null;

    // Expand the token's own folder and node grants first, then bound them by the owner's expanded
    // scopes: a bounded folder grant is never expanded afterwards, so a token can never reach resources
    // its owner cannot (for example through a destination-only creation grant).
    const tokenScopes = await expandFolderScopes(this.db, (token.scopes || []).filter(isApiTokenScope));
    const scopes = canonicalizeScopes(boundScopes(tokenScopes, user.scopes).filter(isApiTokenScope));
    return {
      // The owner's live scopes travel with the caller: Git repository checks require both (User.accountScopes).
      user: { ...user, accountScopes: user.scopes },
      scopes,
      // Bounded by the owner's live scopes where it is used (docker-registry-auth.routes.ts).
      registryAccess: tokenRegistryAccess(token),
      tokenId: token.id,
      tokenPrefix: token.tokenPrefix,
    };
  }

  /**
   * Check if scopes grant a required permission.
   * Supports hierarchical matching: 'cert:issue' grants 'cert:issue:ca-123'
   */
  static hasScope(scopes: string[], requiredScope: string): boolean {
    return permissionHasScope(scopes, requiredScope);
  }
}
