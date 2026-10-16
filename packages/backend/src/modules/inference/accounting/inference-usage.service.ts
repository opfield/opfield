import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  inferenceLimitPolicies,
  inferenceLimitUsageResets,
  inferenceModelSources,
  inferencePricingSnapshots,
  inferenceProviderConnections,
  inferenceRequests,
  inferenceUsageLedger,
  inferenceUsageLifetimeTotals,
  users,
} from '@/db/schema/index.js';
import type { InferenceLimitDimension, InferenceRequestStatus } from '@/db/schema/inference-usage.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { User } from '@/types.js';
import { INFERENCE_PRICE_MISSING_WARNING } from '../inference-pricing.js';
import type { InferenceModelAccessService } from '../models/inference-model-access.service.js';
import {
  type EffectiveInferenceLimits,
  type InferenceBudgetPolicyService,
  type InferenceBudgetUsage,
  SUBSCRIPTION_CHAT_BUDGET_FRACTION,
} from './inference-budget-policy.js';
import { toInternalCredits, toPublicCreditString, toPublicCredits } from './inference-credit-units.js';
import { publishInferenceUsageChanged } from './inference-usage-events.js';

export interface InferenceLimitPolicyInput {
  enabled: boolean;
  credits5hEnabled: boolean;
  credits5h: number;
  credits7dEnabled: boolean;
  credits7d: number;
  credits30dEnabled: boolean;
  credits30d: number;
  apiMonthlyMicrodollars: number;
  billingTimezone: string;
}

const OPFIELD_SYSTEM_OIDC_SUBJECT = 'system:opfield-setup';
const SYSTEM_USAGE_WINDOW_DAYS = 30;
/** How far back requests without a price keep the admin warning up. */
export const UNPRICED_USAGE_WINDOW_DAYS = 7;

export interface UnpricedInferenceModelUsage {
  model: string;
  requests: number;
  tokens: number;
  lastRequestAt: string;
}

@injectable()
export class InferenceUsageService {
  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly policies: InferenceBudgetPolicyService,
    private readonly audit: AuditService,
    private readonly eventBus?: EventBusService,
    private readonly modelAccess?: InferenceModelAccessService
  ) {}

  async self(user: User, now = new Date()) {
    const limits = await this.policies.effective(user.id);
    const usage = await this.policies.usage(user.id, limits, now);
    const available = limits.enabled ? await this.availableBudgetTypes(user) : { api: false, subscription: false };
    const apiConfigured = available.api && limits.apiMonthlyMicrodollars > 0;
    const configured5h = available.subscription && limits.credits5hEnabled;
    const configured7d = available.subscription && limits.credits7dEnabled;
    const configured30d = available.subscription && limits.credits30dEnabled;
    // A window that does not limit the user is reported at 0%, never as an exhausted 100%.
    return {
      measuredAt: now.toISOString(),
      enabled: limits.enabled,
      api: {
        active: true,
        configured: apiConfigured,
        percentage: apiConfigured ? percentage(usage.apiMonthlyMicrodollars, limits.apiMonthlyMicrodollars) : 0,
        recoveryAt: usage.recoveryAt.apiMonthly.toISOString(),
      },
      subscription: {
        '5h': {
          active: usage.active?.credits5h ?? true,
          configured: configured5h,
          percentage: configured5h ? subscriptionPercentage(usage.credits5h, limits.credits5h) : 0,
          recoveryAt: usage.recoveryAt.credits5h.toISOString(),
        },
        '7d': {
          active: usage.active?.credits7d ?? true,
          configured: configured7d,
          percentage: configured7d ? subscriptionPercentage(usage.credits7d, limits.credits7d) : 0,
          recoveryAt: usage.recoveryAt.credits7d.toISOString(),
        },
        '30d': {
          active: usage.active?.credits30d ?? true,
          configured: configured30d,
          percentage: configured30d ? subscriptionPercentage(usage.credits30d, limits.credits30d) : 0,
          recoveryAt: usage.recoveryAt.credits30d.toISOString(),
        },
      },
    };
  }

  async clientUsage(user: User, now = new Date()) {
    const windowStart = systemUsageWindowStart(now);
    const ledgerDay = sql<string>`to_char(date_trunc('day', ${inferenceUsageLedger.occurredAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
    const tokenTotal = sql<number>`COALESCE(SUM(${inferenceUsageLedger.uncachedInputTokens} + ${inferenceUsageLedger.cachedInputTokens} + ${inferenceUsageLedger.cacheWriteTokens} + ${inferenceUsageLedger.outputTokens} + ${inferenceUsageLedger.reasoningTokens}), 0)`;
    const [usage, lifetimeRows, removedRows, dailyRows] = await Promise.all([
      this.self(user, now),
      this.db.select({ tokens: tokenTotal }).from(inferenceUsageLedger).where(eq(inferenceUsageLedger.userId, user.id)),
      // Usage of requests that housekeeping already removed.
      this.db
        .select({ tokens: inferenceUsageLifetimeTotals.tokens })
        .from(inferenceUsageLifetimeTotals)
        .where(eq(inferenceUsageLifetimeTotals.userId, user.id)),
      this.db
        .select({ date: ledgerDay, tokens: tokenTotal })
        .from(inferenceUsageLedger)
        .where(and(eq(inferenceUsageLedger.userId, user.id), gte(inferenceUsageLedger.occurredAt, windowStart)))
        .groupBy(ledgerDay)
        .orderBy(ledgerDay),
    ]);
    return {
      ...usage,
      tokens: {
        lifetime: Number(lifetimeRows[0]?.tokens ?? 0) + Number(removedRows[0]?.tokens ?? 0),
        daily: mergeDailyTokenUsage(dailyRows, windowStart, SYSTEM_USAGE_WINDOW_DAYS),
      },
    };
  }

  private async availableBudgetTypes(user: User): Promise<{ api: boolean; subscription: boolean }> {
    if (!this.modelAccess) return { api: false, subscription: false };
    const modelIds = [...(await this.modelAccess.allowedModelIds(user))];
    if (!modelIds.length) return { api: false, subscription: false };

    const sources = await this.db
      .select({ sourceType: inferenceModelSources.sourceType })
      .from(inferenceModelSources)
      .innerJoin(inferenceProviderConnections, eq(inferenceModelSources.connectionId, inferenceProviderConnections.id))
      .where(
        and(
          inArray(inferenceModelSources.modelId, modelIds),
          eq(inferenceModelSources.enabled, true),
          eq(inferenceProviderConnections.enabled, true)
        )
      );
    return {
      api: sources.some((source) => source.sourceType === 'api'),
      subscription: sources.some((source) => source.sourceType === 'subscription'),
    };
  }

  async selfOverview(user: User) {
    return this.overview(user.id);
  }

  async adminOverview() {
    return this.overview();
  }

  private async overview(userId?: string) {
    const windowStart = systemUsageWindowStart();
    const requestDay = sql<string>`to_char(date_trunc('day', ${inferenceRequests.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
    const ledgerDay = sql<string>`to_char(date_trunc('day', ${inferenceUsageLedger.occurredAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
    const requestFilter = userId
      ? and(eq(inferenceRequests.userId, userId), gte(inferenceRequests.createdAt, windowStart))
      : gte(inferenceRequests.createdAt, windowStart);
    const ledgerFilter = userId
      ? and(eq(inferenceUsageLedger.userId, userId), gte(inferenceUsageLedger.occurredAt, windowStart))
      : gte(inferenceUsageLedger.occurredAt, windowStart);
    const [requestTotals, ledgerTotals, requestDaily, ledgerDaily] = await Promise.all([
      this.db
        .select({
          status: inferenceRequests.status,
          requests: sql<number>`COUNT(*)::int`,
          credits: sql<string>`COALESCE(SUM(${inferenceRequests.creditsCharged}), 0)`,
          apiMicrodollars: sql<number>`COALESCE(SUM(${inferenceRequests.apiMicrodollarsCharged}), 0)`,
          tokens: sql<number>`COALESCE(SUM(${inferenceRequests.uncachedInputTokens} + ${inferenceRequests.cachedInputTokens} + ${inferenceRequests.cacheWriteTokens} + ${inferenceRequests.outputTokens} + ${inferenceRequests.reasoningTokens}), 0)`,
          unpricedRequests: sql<number>`COUNT(*) FILTER (WHERE ${inferenceRequests.costUnknown})::int`,
        })
        .from(inferenceRequests)
        .where(requestFilter)
        .groupBy(inferenceRequests.status),
      this.db
        .select({
          budgetType: inferenceUsageLedger.budgetType,
          credits: sql<string>`COALESCE(SUM(${inferenceUsageLedger.credits}), 0)`,
          apiMicrodollars: sql<number>`COALESCE(SUM(${inferenceUsageLedger.apiMicrodollars}), 0)`,
          tokens: sql<number>`COALESCE(SUM(${inferenceUsageLedger.uncachedInputTokens} + ${inferenceUsageLedger.cachedInputTokens} + ${inferenceUsageLedger.cacheWriteTokens} + ${inferenceUsageLedger.outputTokens} + ${inferenceUsageLedger.reasoningTokens}), 0)`,
          unpricedTokens: sql<number>`COALESCE(SUM(${inferenceUsageLedger.uncachedInputTokens} + ${inferenceUsageLedger.cachedInputTokens} + ${inferenceUsageLedger.cacheWriteTokens} + ${inferenceUsageLedger.outputTokens} + ${inferenceUsageLedger.reasoningTokens}) FILTER (WHERE ${inferenceUsageLedger.costUnknown}), 0)`,
        })
        .from(inferenceUsageLedger)
        .where(ledgerFilter)
        .groupBy(inferenceUsageLedger.budgetType),
      this.db
        .select({
          date: requestDay,
          requests: sql<number>`COUNT(*)::int`,
        })
        .from(inferenceRequests)
        .where(requestFilter)
        .groupBy(requestDay)
        .orderBy(requestDay),
      this.db
        .select({
          date: ledgerDay,
          credits: sql<string>`COALESCE(SUM(${inferenceUsageLedger.credits}), 0)`,
          apiMicrodollars: sql<number>`COALESCE(SUM(${inferenceUsageLedger.apiMicrodollars}), 0)`,
          tokens: sql<number>`COALESCE(SUM(${inferenceUsageLedger.uncachedInputTokens} + ${inferenceUsageLedger.cachedInputTokens} + ${inferenceUsageLedger.cacheWriteTokens} + ${inferenceUsageLedger.outputTokens} + ${inferenceUsageLedger.reasoningTokens}), 0)`,
        })
        .from(inferenceUsageLedger)
        .where(ledgerFilter)
        .groupBy(ledgerDay)
        .orderBy(ledgerDay),
    ]);
    return {
      windowDays: SYSTEM_USAGE_WINDOW_DAYS,
      requestTotals: requestTotals.map((row) => ({
        ...row,
        requests: Number(row.requests),
        credits: toPublicCreditString(row.credits),
        apiMicrodollars: Number(row.apiMicrodollars),
        tokens: Number(row.tokens),
        // Requests on API sources with no price: their cost is unknown and not in apiMicrodollars.
        unpricedRequests: Number(row.unpricedRequests),
      })),
      ledgerTotals: ledgerTotals.map((row) => ({
        ...row,
        credits: toPublicCreditString(row.credits),
        apiMicrodollars: Number(row.apiMicrodollars),
        tokens: Number(row.tokens),
        unpricedTokens: Number(row.unpricedTokens),
      })),
      dailyUsage: mergeDailyUsage(requestDaily, ledgerDaily, windowStart, SYSTEM_USAGE_WINDOW_DAYS),
      ...(userId ? {} : { unpriced: await this.unpricedUsageWarning() }),
    };
  }

  /**
   * Models whose requests ran on an API source with no price in the last UNPRICED_USAGE_WINDOW_DAYS days, and whose
   * source still has no price set since: their cost is unknown and outside API budgets. A price saved after the
   * request (a new pricing snapshot, or the source replaced by a configuration save) clears the model.
   */
  async unpricedModels(now = new Date()): Promise<UnpricedInferenceModelUsage[]> {
    const since = new Date(now.getTime() - UNPRICED_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const rows = await this.db
      .select({
        model: inferenceRequests.publicModelId,
        requests: sql<number>`COUNT(*)::int`,
        tokens: sql<number>`COALESCE(SUM(${inferenceRequests.uncachedInputTokens} + ${inferenceRequests.cachedInputTokens} + ${inferenceRequests.cacheWriteTokens} + ${inferenceRequests.outputTokens} + ${inferenceRequests.reasoningTokens}), 0)`,
        lastRequestAt: sql<string>`MAX(${inferenceRequests.createdAt})`,
      })
      .from(inferenceRequests)
      .where(
        and(
          eq(inferenceRequests.costUnknown, true),
          gte(inferenceRequests.createdAt, since),
          isNotNull(inferenceRequests.sourceId),
          sql`NOT EXISTS (SELECT 1 FROM ${inferencePricingSnapshots} WHERE ${inferencePricingSnapshots.sourceId} = ${inferenceRequests.sourceId} AND ${inferencePricingSnapshots.createdAt} > ${inferenceRequests.createdAt})`
        )
      )
      .groupBy(inferenceRequests.publicModelId)
      .orderBy(asc(inferenceRequests.publicModelId));
    return rows.map((row) => ({
      model: row.model,
      requests: Number(row.requests),
      tokens: Number(row.tokens),
      lastRequestAt: new Date(row.lastRequestAt).toISOString(),
    }));
  }

  /** The admin warning for unpriced usage (system overview and MCP), or null when there is none. */
  async unpricedUsageWarning(now = new Date()) {
    const models = await this.unpricedModels(now);
    if (models.length === 0) return null;
    return {
      warning: `${INFERENCE_PRICE_MISSING_WARNING}. Requests to these models in the last ${UNPRICED_USAGE_WINDOW_DAYS} days ran without a price; set one in Settings → Inference.`,
      windowDays: UNPRICED_USAGE_WINDOW_DAYS,
      models,
    };
  }

  async users() {
    const rows = await this.db
      .select({ id: users.id, email: users.email, name: users.name, avatarUrl: users.avatarUrl })
      .from(users)
      .where(or(isNull(users.oidcSubject), ne(users.oidcSubject, OPFIELD_SYSTEM_OIDC_SUBJECT)));
    return Promise.all(
      rows.map(async (user) => {
        try {
          const limits = await this.policies.effective(user.id);
          const usage = await this.policies.usage(user.id, limits);
          return { ...user, limits: publicLimits(limits), usage: publicUsage(usage) };
        } catch {
          return { ...user, limits: null, usage: null };
        }
      })
    );
  }

  async limitUsers() {
    const rows = await this.db
      .select({ id: users.id, email: users.email, name: users.name, avatarUrl: users.avatarUrl })
      .from(users)
      .where(
        and(or(isNull(users.oidcSubject), ne(users.oidcSubject, OPFIELD_SYSTEM_OIDC_SUBJECT)), isNull(users.deletedAt))
      );
    return Promise.all(
      rows.map(async (user) => {
        try {
          return { ...user, limits: publicLimits(await this.policies.effective(user.id)), usage: null };
        } catch {
          return { ...user, limits: null, usage: null };
        }
      })
    );
  }

  async activity(
    input: {
      page?: number;
      limit?: number;
      search?: string;
      status?: InferenceRequestStatus;
      userId?: string;
      model?: string;
    } = {}
  ) {
    const page = Math.max(1, input.page ?? 1);
    const limit = Math.max(1, Math.min(100, input.limit ?? 50));
    const conditions = [];
    const search = input.search?.trim();
    if (search) {
      const pattern = `%${search.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
      conditions.push(
        or(
          ilike(users.email, pattern),
          ilike(inferenceRequests.publicModelId, pattern),
          ilike(inferenceRequests.reasoningEffort, pattern),
          ilike(inferenceRequests.operation, pattern),
          ilike(inferenceRequests.status, pattern),
          ilike(inferenceRequests.errorCode, pattern)
        )!
      );
    }
    if (input.status) conditions.push(eq(inferenceRequests.status, input.status));
    if (input.userId) conditions.push(eq(inferenceRequests.userId, input.userId));
    if (input.model) conditions.push(eq(inferenceRequests.publicModelId, input.model));
    const rows = await this.db
      .select({
        id: inferenceRequests.id,
        userId: inferenceRequests.userId,
        userName: users.name,
        userEmail: users.email,
        userAvatarUrl: users.avatarUrl,
        protocol: inferenceRequests.protocol,
        operation: inferenceRequests.operation,
        publicModelId: inferenceRequests.publicModelId,
        reasoningEffort: inferenceRequests.reasoningEffort,
        providerConnectionName: inferenceProviderConnections.name,
        providerAccountLabel: inferenceProviderConnections.accountLabel,
        budgetType: inferenceRequests.budgetType,
        status: inferenceRequests.status,
        credits: inferenceRequests.creditsCharged,
        apiMicrodollars: inferenceRequests.apiMicrodollarsCharged,
        // No price was set: apiMicrodollars is not the cost of this request.
        costUnknown: inferenceRequests.costUnknown,
        uncachedInputTokens: inferenceRequests.uncachedInputTokens,
        cachedInputTokens: inferenceRequests.cachedInputTokens,
        cacheWriteTokens: inferenceRequests.cacheWriteTokens,
        outputTokens: inferenceRequests.outputTokens,
        reasoningTokens: inferenceRequests.reasoningTokens,
        errorCode: inferenceRequests.errorCode,
        startedAt: inferenceRequests.startedAt,
        completedAt: inferenceRequests.completedAt,
      })
      .from(inferenceRequests)
      .leftJoin(users, eq(inferenceRequests.userId, users.id))
      .leftJoin(inferenceProviderConnections, eq(inferenceRequests.connectionId, inferenceProviderConnections.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(inferenceRequests.createdAt))
      .limit(limit + 1)
      .offset((page - 1) * limit);
    const hasMore = rows.length > limit;
    return {
      data: rows.slice(0, limit).map((row) => ({
        ...row,
        credits: toPublicCredits(row.credits),
        startedAt: row.startedAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
      })),
      nextPage: hasMore ? page + 1 : null,
    };
  }

  async activityFilters() {
    const [userRows, modelRows] = await Promise.all([
      this.db
        .selectDistinct({
          id: users.id,
          name: users.name,
          email: users.email,
          avatarUrl: users.avatarUrl,
        })
        .from(inferenceRequests)
        .innerJoin(users, eq(inferenceRequests.userId, users.id))
        .orderBy(asc(users.name), asc(users.email)),
      this.db
        .selectDistinct({ model: inferenceRequests.publicModelId })
        .from(inferenceRequests)
        .orderBy(asc(inferenceRequests.publicModelId)),
    ]);
    return {
      users: userRows,
      models: modelRows.map((row) => row.model),
    };
  }

  async listPolicies() {
    const rows = await this.db.select().from(inferenceLimitPolicies).orderBy(inferenceLimitPolicies.policyType);
    return rows.map((row) => ({
      ...row,
      credits5h: toPublicCreditString(row.credits5h),
      credits7d: toPublicCreditString(row.credits7d),
      credits30d: toPublicCreditString(row.credits30d),
    }));
  }

  async setDefault(userId: string, input: InferenceLimitPolicyInput) {
    validatePolicy(input);
    await this.db
      .insert(inferenceLimitPolicies)
      .values({ policyType: 'default', userId: null, ...dbPolicy(input), createdBy: userId })
      .onConflictDoUpdate({
        target: inferenceLimitPolicies.policyType,
        targetWhere: sql`${inferenceLimitPolicies.policyType} = 'default'`,
        set: { ...dbPolicy(input), updatedAt: new Date() },
      });
    const [policies] = await Promise.all([this.listPolicies(), this.changed(userId, 'default', input)]);
    publishInferenceUsageChanged(this.eventBus, { targetUserId: null, reason: 'limits' });
    return policies;
  }

  async setUser(userId: string, targetUserId: string, input: InferenceLimitPolicyInput) {
    validatePolicy(input);
    const target = await this.db.query.users.findFirst({
      where: and(eq(users.id, targetUserId), isNull(users.deletedAt)),
    });
    if (!target) throw new AppError(404, 'INFERENCE_LIMIT_USER_NOT_FOUND', 'User not found');
    await this.db
      .insert(inferenceLimitPolicies)
      .values({ policyType: 'user', userId: targetUserId, ...dbPolicy(input), createdBy: userId })
      .onConflictDoUpdate({
        target: inferenceLimitPolicies.userId,
        targetWhere: sql`${inferenceLimitPolicies.userId} IS NOT NULL`,
        set: { ...dbPolicy(input), updatedAt: new Date() },
      });
    const [policies] = await Promise.all([this.listPolicies(), this.changed(userId, targetUserId, input)]);
    publishInferenceUsageChanged(this.eventBus, { targetUserId, reason: 'limits' });
    return policies;
  }

  async removeUser(userId: string, targetUserId: string): Promise<void> {
    await this.db
      .delete(inferenceLimitPolicies)
      .where(and(eq(inferenceLimitPolicies.policyType, 'user'), eq(inferenceLimitPolicies.userId, targetUserId)));
    await this.audit.log({
      userId,
      action: 'inference.limit.delete',
      resourceType: 'inference_limit_policy',
      resourceId: targetUserId,
    });
    publishInferenceUsageChanged(this.eventBus, { targetUserId, reason: 'limits' });
  }

  async resetUserLimits(userId: string, targetUserId: string) {
    const target = await this.db.query.users.findFirst({
      where: and(eq(users.id, targetUserId), isNull(users.deletedAt)),
    });
    if (!target) throw new AppError(404, 'INFERENCE_LIMIT_USER_NOT_FOUND', 'User not found');
    const resetAt = new Date();
    const dimensions: InferenceLimitDimension[] = ['credits5h', 'credits7d', 'credits30d', 'apiMonthlyMicrodollars'];
    await this.db.transaction(async (tx) => {
      for (const dimension of dimensions) {
        const windowActive = dimension === 'apiMonthlyMicrodollars';
        await tx
          .insert(inferenceLimitUsageResets)
          .values({ userId: targetUserId, dimension, resetAt, windowActive, createdBy: userId })
          .onConflictDoUpdate({
            target: [inferenceLimitUsageResets.userId, inferenceLimitUsageResets.dimension],
            set: { resetAt, windowActive, createdBy: userId },
          });
      }
    });
    await this.audit.log({
      userId,
      action: 'inference.limit.reset',
      resourceType: 'inference_limit_policy',
      resourceId: targetUserId,
      details: { dimensions },
    });
    publishInferenceUsageChanged(this.eventBus, { targetUserId, reason: 'limits' });
    const limits = await this.policies.effective(targetUserId);
    return {
      resetAt: resetAt.toISOString(),
      usage: publicUsage(await this.policies.usage(targetUserId, limits)),
    };
  }

  private async changed(userId: string, target: string, input: InferenceLimitPolicyInput) {
    await this.audit.log({
      userId,
      action: 'inference.limit.update',
      resourceType: 'inference_limit_policy',
      resourceId: target,
      details: {
        enabled: input.enabled,
        credits5hEnabled: input.credits5hEnabled,
        credits7dEnabled: input.credits7dEnabled,
        credits30dEnabled: input.credits30dEnabled,
        billingTimezone: input.billingTimezone,
      },
    });
  }
}

function percentage(used: number, limit: number): number {
  if (limit <= 0) return used > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, (used / limit) * 100));
}

function subscriptionPercentage(used: number, limit: number): number {
  return percentage(used, limit * SUBSCRIPTION_CHAT_BUDGET_FRACTION);
}

function validatePolicy(input: InferenceLimitPolicyInput) {
  const values = [input.credits5h, input.credits7d, input.credits30d, input.apiMonthlyMicrodollars];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new AppError(400, 'INFERENCE_LIMIT_INVALID', 'Inference limits must be non-negative numbers');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: input.billingTimezone }).format();
  } catch {
    throw new AppError(400, 'INFERENCE_TIMEZONE_INVALID', 'Billing timezone is invalid');
  }
}

function dbPolicy(input: InferenceLimitPolicyInput) {
  return {
    enabled: input.enabled,
    credits5hEnabled: input.credits5hEnabled,
    credits5h: String(toInternalCredits(input.credits5h)),
    credits7dEnabled: input.credits7dEnabled,
    credits7d: String(toInternalCredits(input.credits7d)),
    credits30dEnabled: input.credits30dEnabled,
    credits30d: String(toInternalCredits(input.credits30d)),
    apiMonthlyMicrodollars: input.apiMonthlyMicrodollars,
    billingTimezone: input.billingTimezone,
  };
}

function publicLimits(limits: EffectiveInferenceLimits): EffectiveInferenceLimits {
  return {
    ...limits,
    credits5h: toPublicCredits(limits.credits5h),
    credits7d: toPublicCredits(limits.credits7d),
    credits30d: toPublicCredits(limits.credits30d),
  };
}

function publicUsage(usage: InferenceBudgetUsage): InferenceBudgetUsage {
  return {
    ...usage,
    credits5h: toPublicCredits(usage.credits5h),
    credits7d: toPublicCredits(usage.credits7d),
    credits30d: toPublicCredits(usage.credits30d),
  };
}

function systemUsageWindowStart(now = new Date()): Date {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (SYSTEM_USAGE_WINDOW_DAYS - 1));
  return start;
}

function mergeDailyUsage(
  requestRows: Array<{ date: string; requests: number }>,
  ledgerRows: Array<{ date: string; credits: string; apiMicrodollars: number; tokens: number }>,
  windowStart: Date,
  windowDays: number
) {
  const rows = new Map<
    string,
    { date: string; requests: number; credits: number; apiMicrodollars: number; tokens: number }
  >();
  for (let offset = 0; offset < windowDays; offset += 1) {
    const date = new Date(windowStart);
    date.setUTCDate(date.getUTCDate() + offset);
    const key = date.toISOString().slice(0, 10);
    rows.set(key, { date: key, requests: 0, credits: 0, apiMicrodollars: 0, tokens: 0 });
  }
  for (const row of requestRows) {
    const target = rows.get(row.date);
    if (target) target.requests = Number(row.requests);
  }
  for (const row of ledgerRows) {
    const target = rows.get(row.date);
    if (!target) continue;
    target.credits = toPublicCredits(row.credits);
    target.apiMicrodollars = Number(row.apiMicrodollars);
    target.tokens = Number(row.tokens);
  }
  return [...rows.values()];
}

function mergeDailyTokenUsage(
  ledgerRows: Array<{ date: string; tokens: number }>,
  windowStart: Date,
  windowDays: number
): Array<{ date: string; tokens: number }> {
  const rows = new Map<string, { date: string; tokens: number }>();
  for (let offset = 0; offset < windowDays; offset += 1) {
    const date = new Date(windowStart);
    date.setUTCDate(date.getUTCDate() + offset);
    const key = date.toISOString().slice(0, 10);
    rows.set(key, { date: key, tokens: 0 });
  }
  for (const row of ledgerRows) {
    const target = rows.get(row.date);
    if (target) target.tokens = Number(row.tokens);
  }
  return [...rows.values()];
}

export const __testOnly = {
  percentage,
  subscriptionPercentage,
  validatePolicy,
  dbPolicy,
  publicLimits,
  publicUsage,
  systemUsageWindowStart,
  mergeDailyUsage,
  mergeDailyTokenUsage,
};
