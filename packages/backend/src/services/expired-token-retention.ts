import { and, count, isNotNull, lt } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { apiTokens, inferenceTokens } from '@/db/schema/index.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { apiTokenChangedChannel, inferenceTokenChangedChannel } from '@/modules/auth/user-resource-events.js';
import type { EventBusService } from './event-bus.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days an expired API or inference token stays listed (as Expired) before housekeeping removes it. */
export const DEFAULT_EXPIRED_TOKEN_RETENTION_DAYS = 7;

/** Tokens that expired before this moment are removed; 0 days removes every expired token. */
export function expiredTokenCutoff(retentionDays: number, now = new Date()): Date {
  return new Date(now.getTime() - Math.max(0, retentionDays) * DAY_MS);
}

/** Expired API and inference tokens past the retention period. */
export async function countExpiredTokens(db: DrizzleClient, retentionDays: number, now = new Date()) {
  const cutoff = expiredTokenCutoff(retentionDays, now);
  const [[api], [inference]] = await Promise.all([
    db
      .select({ value: count() })
      .from(apiTokens)
      .where(and(isNotNull(apiTokens.expiresAt), lt(apiTokens.expiresAt, cutoff))),
    db
      .select({ value: count() })
      .from(inferenceTokens)
      .where(and(isNotNull(inferenceTokens.expiresAt), lt(inferenceTokens.expiresAt, cutoff))),
  ]);
  return Number(api?.value ?? 0) + Number(inference?.value ?? 0);
}

/**
 * Removes API and inference tokens that expired more than `retentionDays` ago. Each removal is a system entry in the
 * audit log (the token's create, update and revoke entries stay there too); usage records keep their numbers and lose
 * only the link to the removed inference token.
 */
export async function purgeExpiredTokens(
  db: DrizzleClient,
  retentionDays: number,
  deps: { auditService?: Pick<AuditService, 'log'>; eventBus?: Pick<EventBusService, 'publish'> } = {},
  now = new Date()
) {
  const { auditService, eventBus } = deps;
  const cutoff = expiredTokenCutoff(retentionDays, now);
  const [removedApi, removedInference] = await Promise.all([
    db
      .delete(apiTokens)
      .where(and(isNotNull(apiTokens.expiresAt), lt(apiTokens.expiresAt, cutoff)))
      .returning({
        id: apiTokens.id,
        userId: apiTokens.userId,
        name: apiTokens.name,
        tokenPrefix: apiTokens.tokenPrefix,
        expiresAt: apiTokens.expiresAt,
      }),
    db
      .delete(inferenceTokens)
      .where(and(isNotNull(inferenceTokens.expiresAt), lt(inferenceTokens.expiresAt, cutoff)))
      .returning({
        id: inferenceTokens.id,
        userId: inferenceTokens.userId,
        name: inferenceTokens.name,
        tokenPrefix: inferenceTokens.tokenPrefix,
        expiresAt: inferenceTokens.expiresAt,
      }),
  ]);
  const entries = [
    ...removedApi.map((token) => ({
      token,
      action: 'api_token.remove_expired',
      resourceType: 'api-token',
      channel: apiTokenChangedChannel(token.userId),
    })),
    ...removedInference.map((token) => ({
      token,
      action: 'inference_token.remove_expired',
      resourceType: 'inference-token',
      channel: inferenceTokenChangedChannel(token.userId),
    })),
  ];
  for (const { token, action, resourceType, channel } of entries) {
    eventBus?.publish(channel, { action: 'revoke', id: token.id, userId: token.userId });
    await auditService
      ?.log({
        userId: null,
        action,
        resourceType,
        resourceId: token.id,
        details: {
          name: token.name,
          tokenPrefix: token.tokenPrefix,
          ownerUserId: token.userId,
          expiresAt: token.expiresAt?.toISOString() ?? null,
          retentionDays,
        },
      })
      .catch(() => undefined);
  }
  return { api: removedApi.length, inference: removedInference.length, total: entries.length };
}
