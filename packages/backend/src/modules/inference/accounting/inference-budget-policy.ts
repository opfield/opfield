import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import { inferenceLimitPolicies, inferenceLimitUsageResets, inferenceUsageLedger } from '@/db/schema/index.js';
import type { InferenceLimitPolicy } from '@/db/schema/inference-models.js';
import { tokenPricingForInputTokens } from '../inference-pricing.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import { toInternalCredits } from './inference-credit-units.js';

export const SUBSCRIPTION_WINDOWS = {
  '5h': 5 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
} as const;

const SUBSCRIPTION_LIMIT_WINDOWS = [
  { dimension: 'credits5h', enabled: 'credits5hEnabled', durationMs: SUBSCRIPTION_WINDOWS['5h'] },
  { dimension: 'credits7d', enabled: 'credits7dEnabled', durationMs: SUBSCRIPTION_WINDOWS['7d'] },
  { dimension: 'credits30d', enabled: 'credits30dEnabled', durationMs: SUBSCRIPTION_WINDOWS['30d'] },
] as const;

/** Personal subscription credit limits are spendable through their full configured value. */
export const SUBSCRIPTION_CHAT_BUDGET_FRACTION = 1;
/** A turn admitted with a positive balance may settle at most one visible credit over its window limit. */
export const SUBSCRIPTION_ADMISSION_OVERAGE_CREDITS = toInternalCredits(1);

export interface EffectiveInferenceLimits {
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

export interface InferenceBudgetUsage {
  credits5h: number;
  credits7d: number;
  credits30d: number;
  apiMonthlyMicrodollars: number;
  active?: { credits5h: boolean; credits7d: boolean; credits30d: boolean; apiMonthly: boolean };
  recoveryAt: { credits5h: Date; credits7d: Date; credits30d: Date; apiMonthly: Date };
}

const UNCONFIGURED_LIMITS: EffectiveInferenceLimits = {
  enabled: false,
  credits5hEnabled: false,
  credits5h: 0,
  credits7dEnabled: false,
  credits7d: 0,
  credits30dEnabled: false,
  credits30d: 0,
  apiMonthlyMicrodollars: 0,
  billingTimezone: 'UTC',
};

@injectable()
export class InferenceBudgetPolicyService {
  constructor(@inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient) {}

  async effective(userId: string, database: DrizzleExecutor = this.db): Promise<EffectiveInferenceLimits> {
    const rows = await database
      .select()
      .from(inferenceLimitPolicies)
      .where(
        sql`${inferenceLimitPolicies.policyType} = 'default' OR (${inferenceLimitPolicies.policyType} = 'user' AND ${inferenceLimitPolicies.userId} = ${userId})`
      )
      .orderBy(desc(inferenceLimitPolicies.policyType));
    const defaultPolicy = rows.find((row) => row.policyType === 'default');
    const userPolicy = rows.find((row) => row.policyType === 'user');
    const policy = userPolicy ?? defaultPolicy;
    // An Opfield can have Inference enabled before an administrator configures
    // a default policy (notably older guided setups). Treat that as disabled
    // access instead of an infrastructure failure, so status and setup APIs
    // stay available to repair the configuration.
    if (!policy) return { ...UNCONFIGURED_LIMITS };
    return effectiveLimits(policy, userPolicy ? defaultPolicy : undefined);
  }

  async usage(
    userId: string,
    limits: EffectiveInferenceLimits,
    now = new Date(),
    database: DrizzleExecutor = this.db,
    options: { startSubscriptionWindows?: boolean } = {}
  ): Promise<InferenceBudgetUsage> {
    const resetRows = await database
      .select({
        dimension: inferenceLimitUsageResets.dimension,
        resetAt: inferenceLimitUsageResets.resetAt,
        windowActive: inferenceLimitUsageResets.windowActive,
      })
      .from(inferenceLimitUsageResets)
      .where(eq(inferenceLimitUsageResets.userId, userId));
    const resets = new Map(resetRows.map((row) => [row.dimension, row]));
    const legacyStarts = new Map(
      await Promise.all(
        SUBSCRIPTION_LIMIT_WINDOWS.map(async (window) => {
          const reset = resets.get(window.dimension);
          const active = reset?.windowActive && activeUsageWindow(now, reset.resetAt, window.durationMs);
          // An expired persisted window may have been left behind by the old
          // disabled-limit path. Recover only entries after that window ended;
          // an explicit reset instead fences recovery at its reset timestamp.
          // The walk reads the whole ledger only for a window with no persisted reset at all, which exists until the
          // user's first admission persists every window; after that `since` bounds it to entries after the window.
          const since = reset?.windowActive ? new Date(reset.resetAt.getTime() + window.durationMs) : reset?.resetAt;
          return [
            window.dimension,
            active ? null : await legacyUsageWindowStart(database, userId, now, window.durationMs, since),
          ] as const;
        })
      )
    );
    if (options.startSubscriptionWindows) {
      for (const window of SUBSCRIPTION_LIMIT_WINDOWS) {
        // Switches gate admission only; every subscription window tracks usage.
        const reset = resets.get(window.dimension);
        const active = currentUsageWindow(now, reset, legacyStarts.get(window.dimension), window.durationMs);
        if (reset?.windowActive && active?.start.getTime() === reset.resetAt.getTime()) continue;
        const resetAt = active?.start ?? now;
        await database
          .insert(inferenceLimitUsageResets)
          .values({ userId, dimension: window.dimension, resetAt, windowActive: true, createdBy: null })
          .onConflictDoUpdate({
            target: [inferenceLimitUsageResets.userId, inferenceLimitUsageResets.dimension],
            set: { resetAt, windowActive: true, createdBy: null },
          });
        resets.set(window.dimension, {
          dimension: window.dimension,
          resetAt,
          windowActive: true,
        });
      }
    }
    const apiReset = resets.get('apiMonthlyMicrodollars')?.resetAt;
    const month = apiReset
      ? anchoredCalendarMonthWindow(now, apiReset, limits.billingTimezone)
      : calendarMonthWindow(now, limits.billingTimezone);
    const subscriptionWindows = {
      credits5h: currentUsageWindow(
        now,
        resets.get('credits5h'),
        legacyStarts.get('credits5h'),
        SUBSCRIPTION_WINDOWS['5h']
      ),
      credits7d: currentUsageWindow(
        now,
        resets.get('credits7d'),
        legacyStarts.get('credits7d'),
        SUBSCRIPTION_WINDOWS['7d']
      ),
      credits30d: currentUsageWindow(
        now,
        resets.get('credits30d'),
        legacyStarts.get('credits30d'),
        SUBSCRIPTION_WINDOWS['30d']
      ),
    };
    // Only the open windows are summed: bound the scan to them so its cost follows recent usage, not the ledger's age.
    const subscriptionScanStart = new Date(
      Math.min(
        now.getTime(),
        ...Object.values(subscriptionWindows).flatMap((window) => (window ? [window.start.getTime()] : []))
      )
    );
    const [subscriptionResult, apiRow] = await Promise.all([
      database.execute(
        sql<{
          credits_5h: string;
          credits_7d: string;
          credits_30d: string;
        }>`
          SELECT
            COALESCE(SUM(${inferenceUsageLedger.credits}) FILTER (
              WHERE ${inferenceUsageLedger.occurredAt} >= ${subscriptionWindows.credits5h?.start ?? now}
                AND ${inferenceUsageLedger.occurredAt} < ${subscriptionWindows.credits5h?.end ?? now}
            ), 0)::text AS credits_5h,
            COALESCE(SUM(${inferenceUsageLedger.credits}) FILTER (
              WHERE ${inferenceUsageLedger.occurredAt} >= ${subscriptionWindows.credits7d?.start ?? now}
                AND ${inferenceUsageLedger.occurredAt} < ${subscriptionWindows.credits7d?.end ?? now}
            ), 0)::text AS credits_7d,
            COALESCE(SUM(${inferenceUsageLedger.credits}) FILTER (
              WHERE ${inferenceUsageLedger.occurredAt} >= ${subscriptionWindows.credits30d?.start ?? now}
                AND ${inferenceUsageLedger.occurredAt} < ${subscriptionWindows.credits30d?.end ?? now}
            ), 0)::text AS credits_30d
          FROM ${inferenceUsageLedger}
          WHERE
            ${inferenceUsageLedger.userId} = ${userId}
            AND ${inferenceUsageLedger.budgetType} = 'subscription'
            AND ${inferenceUsageLedger.occurredAt} >= ${subscriptionScanStart}
        `
      ),
      database
        .select({ value: sql<number>`COALESCE(SUM(${inferenceUsageLedger.apiMicrodollars}), 0)` })
        .from(inferenceUsageLedger)
        .where(
          and(
            eq(inferenceUsageLedger.userId, userId),
            eq(inferenceUsageLedger.budgetType, 'api'),
            gte(inferenceUsageLedger.occurredAt, month.start)
          )
        ),
    ]);
    const subscriptionRow = subscriptionResult.rows[0] as
      | { credits_5h: string; credits_7d: string; credits_30d: string }
      | undefined;
    return {
      credits5h: Number(subscriptionRow?.credits_5h ?? 0),
      credits7d: Number(subscriptionRow?.credits_7d ?? 0),
      credits30d: Number(subscriptionRow?.credits_30d ?? 0),
      apiMonthlyMicrodollars: Number(apiRow[0]?.value ?? 0),
      active: {
        credits5h: subscriptionWindows.credits5h !== null,
        credits7d: subscriptionWindows.credits7d !== null,
        credits30d: subscriptionWindows.credits30d !== null,
        apiMonthly: true,
      },
      recoveryAt: {
        credits5h: subscriptionWindows.credits5h?.end ?? now,
        credits7d: subscriptionWindows.credits7d?.end ?? now,
        credits30d: subscriptionWindows.credits30d?.end ?? now,
        apiMonthly: month.end,
      },
    };
  }
}

function currentUsageWindow(
  now: Date,
  reset: { resetAt: Date; windowActive: boolean } | undefined,
  legacyStart: Date | null | undefined,
  durationMs: number
): { start: Date; end: Date } | null {
  const persisted = reset?.windowActive ? activeUsageWindow(now, reset.resetAt, durationMs) : null;
  return persisted ?? activeUsageWindow(now, legacyStart ?? undefined, durationMs);
}

async function legacyUsageWindowStart(
  database: DrizzleExecutor,
  userId: string,
  now: Date,
  durationMs: number,
  since?: Date
): Promise<Date | null> {
  const result = await database.execute(
    sql<{ started_at: Date | string | null }>`
      WITH RECURSIVE ordered_entries AS (
        SELECT
          ${inferenceUsageLedger.occurredAt} AS occurred_at,
          ROW_NUMBER() OVER (ORDER BY ${inferenceUsageLedger.occurredAt}, ${inferenceUsageLedger.id}) AS sequence
        FROM ${inferenceUsageLedger}
        WHERE
          ${inferenceUsageLedger.userId} = ${userId}
          AND ${inferenceUsageLedger.budgetType} = 'subscription'
          AND ${inferenceUsageLedger.occurredAt} <= ${now}
          AND ${since ? sql`${inferenceUsageLedger.occurredAt} >= ${since}` : sql`TRUE`}
      ),
      window_starts AS (
        SELECT occurred_at AS started_at, sequence
        FROM ordered_entries
        WHERE sequence = 1
        UNION ALL
        SELECT next_entry.occurred_at, next_entry.sequence
        FROM window_starts current_window
        CROSS JOIN LATERAL (
          SELECT occurred_at, sequence
          FROM ordered_entries
          WHERE occurred_at >= current_window.started_at + (${durationMs} * INTERVAL '1 millisecond')
          ORDER BY occurred_at, sequence
          LIMIT 1
        ) next_entry
      )
      SELECT started_at
      FROM window_starts
      ORDER BY started_at DESC
      LIMIT 1
    `
  );
  const startedAt = (result.rows[0] as { started_at: Date | string | null } | undefined)?.started_at;
  return startedAt ? new Date(startedAt) : null;
}

function activeUsageWindow(
  now: Date,
  startedAt: Date | undefined,
  durationMs: number
): { start: Date; end: Date } | null {
  if (!startedAt || startedAt > now) return null;
  const end = new Date(startedAt.getTime() + durationMs);
  return end > now ? { start: startedAt, end } : null;
}

function effectiveLimits(policy: InferenceLimitPolicy, defaultPolicy?: InferenceLimitPolicy): EffectiveInferenceLimits {
  return {
    enabled: policy.enabled,
    credits5hEnabled: policy.credits5hEnabled && (defaultPolicy?.credits5hEnabled ?? true),
    credits5h: Number(policy.credits5h),
    credits7dEnabled: policy.credits7dEnabled && (defaultPolicy?.credits7dEnabled ?? true),
    credits7d: Number(policy.credits7d),
    credits30dEnabled: policy.credits30dEnabled && (defaultPolicy?.credits30dEnabled ?? true),
    credits30d: Number(policy.credits30d),
    apiMonthlyMicrodollars: policy.apiMonthlyMicrodollars,
    billingTimezone: policy.billingTimezone,
  };
}

export function dynamicBurnMultiplier(
  windows: Array<{ dimension: string; remainingFraction: number | null; resetAt: Date | null; validUntil: Date }>,
  now = new Date(),
  isCompaction = false
): number {
  if (isCompaction) return 1;
  if (windows.length === 0) return 1;
  let worst = 1;
  for (const window of windows) {
    if (window.validUntil.getTime() <= now.getTime()) return 8;
    const remaining = window.remainingFraction;
    if (remaining === null || remaining <= 0) return 8;
    const duration = quotaWindowDuration(window.dimension);
    const timeFraction = window.resetAt
      ? Math.max(0, Math.min(1, (window.resetAt.getTime() - now.getTime()) / duration))
      : 1;
    worst = Math.max(worst, timeFraction / remaining, 0.3 / remaining);
  }
  return Math.min(8, worst);
}

export function subscriptionCredits(
  totalTokens: number,
  modelMultiplier: number,
  burnMultiplier: number,
  serviceTierMultiplier = 1
): number {
  return (Math.max(0, totalTokens) / 1000) * modelMultiplier * burnMultiplier * serviceTierMultiplier;
}

const SUBSCRIPTION_CACHE_READ_WEIGHT = 0.1;
const SUBSCRIPTION_CACHE_WRITE_WEIGHT = 1.25;

function inputTokenClasses(usage: { inputTokens: number; cachedInputTokens: number; cacheWriteTokens: number }): {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
} {
  const inputTokens = Math.max(0, usage.inputTokens);
  const cachedInputTokens = Math.max(0, usage.cachedInputTokens);
  const cacheWriteTokens = Math.max(0, usage.cacheWriteTokens);
  if (cachedInputTokens + cacheWriteTokens > inputTokens) {
    return { uncachedInputTokens: inputTokens, cachedInputTokens: 0, cacheWriteTokens: 0 };
  }
  return {
    uncachedInputTokens: inputTokens - cachedInputTokens - cacheWriteTokens,
    cachedInputTokens,
    cacheWriteTokens,
  };
}

export function subscriptionCreditsForUsage(
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  },
  modelMultiplier: number,
  burnMultiplier: number,
  serviceTierMultiplier = 1
): number {
  const input = inputTokenClasses(usage);
  const weightedTokens =
    input.uncachedInputTokens +
    input.cachedInputTokens * SUBSCRIPTION_CACHE_READ_WEIGHT +
    input.cacheWriteTokens * SUBSCRIPTION_CACHE_WRITE_WEIGHT +
    Math.max(0, usage.outputTokens) +
    Math.max(0, usage.reasoningTokens);
  return subscriptionCredits(weightedTokens, modelMultiplier, burnMultiplier, serviceTierMultiplier);
}

export function apiMicrodollars(
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  },
  pricing: {
    inputMicrodollarsPerMillion: number | null;
    cachedInputMicrodollarsPerMillion: number | null;
    cacheWriteMicrodollarsPerMillion: number | null;
    outputMicrodollarsPerMillion: number | null;
    reasoningMicrodollarsPerMillion: number | null;
    otherUnitPrices?: Record<string, number>;
  }
): number {
  const effectivePricing = tokenPricingForInputTokens(usage.inputTokens, pricing);
  if (effectivePricing.inputMicrodollarsPerMillion === null || effectivePricing.outputMicrodollarsPerMillion === null) {
    throw new InferenceProtocolError(503, 'pricing_unavailable', 'API pricing is unavailable');
  }
  const input = inputTokenClasses(usage);
  const cost =
    input.uncachedInputTokens * effectivePricing.inputMicrodollarsPerMillion +
    input.cachedInputTokens *
      (effectivePricing.cachedInputMicrodollarsPerMillion ?? effectivePricing.inputMicrodollarsPerMillion) +
    input.cacheWriteTokens *
      (effectivePricing.cacheWriteMicrodollarsPerMillion ?? effectivePricing.inputMicrodollarsPerMillion) +
    usage.outputTokens * effectivePricing.outputMicrodollarsPerMillion +
    usage.reasoningTokens *
      (effectivePricing.reasoningMicrodollarsPerMillion ?? effectivePricing.outputMicrodollarsPerMillion);
  return Math.ceil(cost / 1_000_000);
}

export function calendarMonthWindow(now: Date, timezone: string): { start: Date; end: Date } {
  const local = localParts(now, timezone);
  const start = zonedDateToUtc(local.year, local.month, 1, timezone);
  const nextYear = local.month === 12 ? local.year + 1 : local.year;
  const nextMonth = local.month === 12 ? 1 : local.month + 1;
  return { start, end: zonedDateToUtc(nextYear, nextMonth, 1, timezone) };
}

function anchoredCalendarMonthWindow(now: Date, anchor: Date, timezone: string): { start: Date; end: Date } {
  const anchorParts = localParts(anchor, timezone);
  const nowParts = localParts(now, timezone);
  let offset = (nowParts.year - anchorParts.year) * 12 + nowParts.month - anchorParts.month;
  let start = shiftedLocalMonth(anchorParts, offset, timezone);
  if (start > now) {
    offset -= 1;
    start = shiftedLocalMonth(anchorParts, offset, timezone);
  }
  return { start, end: shiftedLocalMonth(anchorParts, offset + 1, timezone) };
}

function shiftedLocalMonth(parts: ReturnType<typeof localParts>, offset: number, timezone: string): Date {
  const monthIndex = parts.year * 12 + (parts.month - 1) + offset;
  const year = Math.floor(monthIndex / 12);
  const month = (((monthIndex % 12) + 12) % 12) + 1;
  const day = Math.min(parts.day, new Date(Date.UTC(year, month, 0)).getUTCDate());
  return zonedDateToUtc(year, month, day, timezone, parts.hour, parts.minute, parts.second);
}

export function quotaWindowDuration(dimension: string): number {
  if (dimension.startsWith('5h')) return SUBSCRIPTION_WINDOWS['5h'];
  if (dimension.startsWith('7d')) return SUBSCRIPTION_WINDOWS['7d'];
  if (dimension.startsWith('30d')) return SUBSCRIPTION_WINDOWS['30d'];
  return SUBSCRIPTION_WINDOWS['30d'];
}

function localParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function zonedDateToUtc(
  year: number,
  month: number,
  day: number,
  timezone: string,
  hour = 0,
  minute = 0,
  second = 0
): Date {
  let candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  for (let index = 0; index < 3; index += 1) {
    const actual = localParts(candidate, timezone);
    const desired = Date.UTC(year, month - 1, day, hour, minute, second);
    const rendered = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    candidate = new Date(candidate.getTime() + desired - rendered);
  }
  return candidate;
}

export const __testOnly = { effectiveLimits, activeUsageWindow, apiMicrodollars, subscriptionCreditsForUsage };
