import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { inferenceTokens } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { hasScope } from '@/lib/permissions.js';
import {
  isClientIpAllowed,
  isTokenExpired,
  normalizeAllowedIps,
  parseTokenExpiry,
  type TokenRequestContext,
} from '@/lib/token-limits.js';
import { hasTokenPrefix, TOKEN_PREFIXES } from '@/lib/token-prefixes.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { getAuditRequestContext } from '@/modules/audit/audit-request-context.js';
import { resolveLiveUser } from '@/modules/auth/live-session-user.js';
import { inferenceTokenChangedChannel } from '@/modules/auth/user-resource-events.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { User } from '@/types.js';
import type { CreateInferenceTokenInput, UpdateInferenceTokenInput } from './inference.schemas.js';

const logger = createChildLogger('InferenceTokenService');

function hashInferenceToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function serializeToken(token: typeof inferenceTokens.$inferSelect) {
  return {
    id: token.id,
    name: token.name,
    tokenPrefix: token.tokenPrefix,
    status: token.revokedAt ? ('revoked' as const) : ('active' as const),
    expiresAt: token.expiresAt?.toISOString() ?? null,
    expired: isTokenExpired(token.expiresAt),
    allowedIps: token.allowedIps ?? [],
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    revokedAt: token.revokedAt?.toISOString() ?? null,
    createdAt: token.createdAt.toISOString(),
  };
}

@injectable()
export class InferenceTokenService {
  private eventBus?: EventBusService;

  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly auditService: AuditService
  ) {}

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
  }

  async createToken(userId: string, input: CreateInferenceTokenInput) {
    // Covers AI-tool issuance too: impersonation must not mint lasting credentials.
    if (getAuditRequestContext()?.impersonation) {
      throw new AppError(
        403,
        'IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN',
        'Inference tokens cannot be created while impersonating'
      );
    }
    const expiresAt = parseTokenExpiry(input.expiresAt) ?? null;
    const allowedIps = normalizeAllowedIps(input.allowedIps);
    const raw = `${TOKEN_PREFIXES.inference}${randomBytes(32).toString('hex')}`;
    const [token] = await this.db
      .insert(inferenceTokens)
      .values({
        userId,
        name: input.name.trim(),
        tokenHash: hashInferenceToken(raw),
        tokenPrefix: raw.slice(0, 12),
        expiresAt,
        allowedIps,
      })
      .returning();

    logger.info('Created inference token', { tokenId: token.id, userId });
    await this.auditService.log({
      userId,
      action: 'inference_token.create',
      resourceType: 'inference-token',
      resourceId: token.id,
      details: {
        name: token.name,
        tokenPrefix: token.tokenPrefix,
        expiresAt: expiresAt?.toISOString() ?? null,
        allowedIps,
      },
    });
    this.eventBus?.publish(inferenceTokenChangedChannel(userId), { action: 'create', id: token.id, userId });

    return { ...serializeToken(token), token: raw };
  }

  async listTokens(userId: string) {
    const tokens = await this.db.query.inferenceTokens.findMany({
      where: eq(inferenceTokens.userId, userId),
      orderBy: [desc(inferenceTokens.createdAt)],
    });
    return tokens.map(serializeToken);
  }

  /** Renames a token or changes its expiry and allowed addresses (an expired token can get a new expiry). */
  async updateToken(userId: string, tokenId: string, input: UpdateInferenceTokenInput) {
    if (getAuditRequestContext()?.impersonation) {
      throw new AppError(
        403,
        'IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN',
        'Inference tokens cannot be changed while impersonating'
      );
    }
    const token = await this.db.query.inferenceTokens.findFirst({
      where: and(
        eq(inferenceTokens.id, tokenId),
        eq(inferenceTokens.userId, userId),
        isNull(inferenceTokens.revokedAt)
      ),
    });
    if (!token) throw new AppError(404, 'INFERENCE_TOKEN_NOT_FOUND', 'Inference token not found');

    const patch: Partial<typeof inferenceTokens.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name.trim();
    const expiresAt = parseTokenExpiry(input.expiresAt);
    if (expiresAt !== undefined) patch.expiresAt = expiresAt;
    if (input.allowedIps !== undefined) patch.allowedIps = normalizeAllowedIps(input.allowedIps);
    const [updated] = await this.db
      .update(inferenceTokens)
      .set(patch)
      .where(and(eq(inferenceTokens.id, token.id), isNull(inferenceTokens.revokedAt)))
      .returning();
    if (!updated) throw new AppError(404, 'INFERENCE_TOKEN_NOT_FOUND', 'Inference token not found');

    await this.auditService.log({
      userId,
      action: 'inference_token.update',
      resourceType: 'inference-token',
      resourceId: token.id,
      details: {
        name: updated.name,
        tokenPrefix: token.tokenPrefix,
        ...(patch.name !== undefined && patch.name !== token.name ? { previousName: token.name } : {}),
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
    this.eventBus?.publish(inferenceTokenChangedChannel(userId), { action: 'update', id: token.id, userId });
    return serializeToken(updated);
  }

  async revokeToken(userId: string, tokenId: string): Promise<void> {
    const token = await this.db.query.inferenceTokens.findFirst({
      where: and(
        eq(inferenceTokens.id, tokenId),
        eq(inferenceTokens.userId, userId),
        isNull(inferenceTokens.revokedAt)
      ),
    });
    if (!token) throw new AppError(404, 'INFERENCE_TOKEN_NOT_FOUND', 'Inference token not found');

    const revokedAt = new Date();
    await this.db.update(inferenceTokens).set({ revokedAt }).where(eq(inferenceTokens.id, token.id));
    logger.info('Revoked inference token', { tokenId: token.id, userId });
    await this.auditService.log({
      userId,
      action: 'inference_token.revoke',
      resourceType: 'inference-token',
      resourceId: token.id,
      details: { name: token.name, tokenPrefix: token.tokenPrefix },
    });
    this.eventBus?.publish(inferenceTokenChangedChannel(userId), { action: 'revoke', id: token.id, userId });
  }

  /**
   * The owner of a raw token used by a request from `context.clientIp`, or null. An expired token, or one limited to
   * other addresses, is refused like a revoked one.
   */
  async validateToken(
    rawToken: string,
    context: TokenRequestContext = {}
  ): Promise<{ user: User; tokenId: string; tokenPrefix: string } | null> {
    if (!hasTokenPrefix(rawToken, 'inference')) return null;

    const token = await this.db.query.inferenceTokens.findFirst({
      where: and(eq(inferenceTokens.tokenHash, hashInferenceToken(rawToken)), isNull(inferenceTokens.revokedAt)),
    });
    if (!token) return null;
    if (isTokenExpired(token.expiresAt)) return null;
    if (!isClientIpAllowed(token.allowedIps, context.clientIp)) return null;

    const user = await resolveLiveUser(this.db, token.userId);
    if (!user || user.isBlocked || !hasScope(user.scopes, 'feat:ai:use')) return null;

    this.db
      .update(inferenceTokens)
      .set({ lastUsedAt: new Date() })
      .where(and(eq(inferenceTokens.id, token.id), isNull(inferenceTokens.revokedAt)))
      .execute()
      .catch((error) => logger.error('Failed to update inference token lastUsedAt', { tokenId: token.id, error }));

    return { user, tokenId: token.id, tokenPrefix: token.tokenPrefix };
  }
}

export const __testOnly = { hashInferenceToken };
