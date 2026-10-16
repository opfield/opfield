import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { inferenceTokens } from './inference-auth.js';
import { inferenceModelSources, inferenceModels, inferencePricingSnapshots } from './inference-models.js';
import { inferenceProviderConnections } from './inference-providers.js';
import { users } from './users.js';

export type InferenceProtocol = 'responses' | 'chat_completions' | 'messages' | 'images' | 'search' | 'realtime';
export type InferenceRequestStatus = 'reserved' | 'running' | 'completed' | 'failed' | 'cancelled';
export type InferenceAttemptStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type InferenceBudgetType = 'subscription' | 'api';
export type InferenceLedgerEntryType = 'settlement' | 'adjustment';
export type InferenceQuotaStatus = 'fresh' | 'stale' | 'unavailable';
export type InferenceLimitDimension = 'credits5h' | 'credits7d' | 'credits30d' | 'apiMonthlyMicrodollars';

const usageColumns = {
  uncachedInputTokens: bigint('uncached_input_tokens', { mode: 'number' }).notNull().default(0),
  cachedInputTokens: bigint('cached_input_tokens', { mode: 'number' }).notNull().default(0),
  cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull().default(0),
  outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
  reasoningTokens: bigint('reasoning_tokens', { mode: 'number' }).notNull().default(0),
};

export const inferenceRequests = pgTable(
  'inference_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    tokenId: uuid('token_id').references(() => inferenceTokens.id, { onDelete: 'set null' }),
    modelId: uuid('model_id').references(() => inferenceModels.id, { onDelete: 'set null' }),
    sourceId: uuid('source_id').references(() => inferenceModelSources.id, { onDelete: 'set null' }),
    connectionId: uuid('connection_id').references(() => inferenceProviderConnections.id, { onDelete: 'set null' }),
    pricingSnapshotId: uuid('pricing_snapshot_id').references(() => inferencePricingSnapshots.id, {
      onDelete: 'set null',
    }),
    idempotencyKeyHash: text('idempotency_key_hash'),
    affinityKeyHash: text('affinity_key_hash'),
    protocol: varchar('protocol', { length: 32 }).$type<InferenceProtocol>().notNull(),
    operation: varchar('operation', { length: 64 }).notNull(),
    publicModelId: text('public_model_id').notNull(),
    upstreamModelId: text('upstream_model_id'),
    reasoningEffort: varchar('reasoning_effort', { length: 32 }),
    budgetType: varchar('budget_type', { length: 16 }).$type<InferenceBudgetType>(),
    status: varchar('status', { length: 16 }).$type<InferenceRequestStatus>().notNull().default('reserved'),
    isCompaction: boolean('is_compaction').notNull().default(false),
    estimatedUsage: boolean('estimated_usage').notNull().default(false),
    priceVersion: varchar('price_version', { length: 80 }),
    serviceTier: varchar('service_tier', { length: 32 }),
    modelMultiplier: numeric('model_multiplier', { precision: 20, scale: 6 }),
    burnMultiplier: numeric('burn_multiplier', { precision: 20, scale: 6 }),
    serviceTierMultiplier: numeric('service_tier_multiplier', { precision: 20, scale: 6 }).notNull().default('1'),
    // Fixed per-call component used while the core attempt is being admitted.
    // Keep it separate from apiMicrodollarsCharged, which is the settled
    // request aggregate exposed by usage APIs.
    fixedApiMicrodollars: bigint('fixed_api_microdollars', { mode: 'number' }).notNull().default(0),
    creditsCharged: numeric('credits_charged', { precision: 24, scale: 6 }).notNull().default('0'),
    apiMicrodollarsCharged: bigint('api_microdollars_charged', { mode: 'number' }).notNull().default(0),
    // An API request whose source had no price set: it ran, its tokens count, but its cost is unknown (not $0) and
    // it is outside API budget enforcement.
    costUnknown: boolean('cost_unknown').notNull().default(false),
    ...usageColumns,
    responseStatus: integer('response_status'),
    errorCode: varchar('error_code', { length: 128 }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('inference_requests_user_idempotency_unique')
      .on(table.userId, table.idempotencyKeyHash)
      .where(sql`${table.idempotencyKeyHash} IS NOT NULL`),
    index('inference_requests_user_created_idx').on(table.userId, table.createdAt),
    index('inference_requests_status_idx').on(table.status, table.startedAt),
    index('inference_requests_model_created_idx').on(table.modelId, table.createdAt),
    check(
      'inference_requests_charges_nonnegative',
      sql`${table.creditsCharged} >= 0 AND ${table.apiMicrodollarsCharged} >= 0 AND ${table.serviceTierMultiplier} > 0`
    ),
  ]
);

export const inferenceRequestAttempts = pgTable(
  'inference_request_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => inferenceRequests.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    sourceId: uuid('source_id').references(() => inferenceModelSources.id, { onDelete: 'set null' }),
    connectionId: uuid('connection_id').references(() => inferenceProviderConnections.id, { onDelete: 'set null' }),
    status: varchar('status', { length: 16 }).$type<InferenceAttemptStatus>().notNull().default('pending'),
    // Lineage for core-executed attempts. core_attempt_id is generated by the
    // OpenCodex core and makes settlement delivery idempotent; the parent
    // reference attributes retries, compaction, and subagents to their root.
    coreAttemptId: text('core_attempt_id'),
    parentCoreAttemptId: text('parent_core_attempt_id'),
    attemptKind: varchar('attempt_kind', { length: 16 }).notNull().default('root'),
    upstreamStatus: integer('upstream_status'),
    // The output cap admitted with the first allow decision; replayed verbatim
    // on idempotent admission redelivery so the contract stays deterministic.
    admittedMaxOutputTokens: integer('admitted_max_output_tokens'),
    budgetType: varchar('budget_type', { length: 16 }).$type<InferenceBudgetType>(),
    pricingSnapshotId: uuid('pricing_snapshot_id').references(() => inferencePricingSnapshots.id, {
      onDelete: 'set null',
    }),
    priceVersion: varchar('price_version', { length: 80 }),
    modelMultiplier: numeric('model_multiplier', { precision: 20, scale: 6 }),
    burnMultiplier: numeric('burn_multiplier', { precision: 20, scale: 6 }),
    serviceTierMultiplier: numeric('service_tier_multiplier', { precision: 20, scale: 6 }).notNull().default('1'),
    fixedApiMicrodollars: bigint('fixed_api_microdollars', { mode: 'number' }).notNull().default(0),
    reservedApiMicrodollars: bigint('reserved_api_microdollars', { mode: 'number' }).notNull().default(0),
    // Admitted on an API source with no price set (see inference_requests.cost_unknown).
    costUnknown: boolean('cost_unknown').notNull().default(false),
    reservationId: text('reservation_id'),
    errorCode: varchar('error_code', { length: 128 }),
    emittedOutput: boolean('emitted_output').notNull().default(false),
    // NULL preserves unknown identity for attempts settled before this field existed.
    usageEstimated: boolean('usage_estimated'),
    latencyMs: integer('latency_ms'),
    ...usageColumns,
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('inference_attempts_request_sequence_unique').on(table.requestId, table.sequence),
    uniqueIndex('inference_attempts_core_attempt_unique')
      .on(table.coreAttemptId)
      .where(sql`${table.coreAttemptId} IS NOT NULL`),
    index('inference_attempts_connection_started_idx').on(table.connectionId, table.startedAt),
    check(
      'inference_attempts_accounting_nonnegative',
      sql`${table.fixedApiMicrodollars} >= 0 AND ${table.reservedApiMicrodollars} >= 0 AND ${table.serviceTierMultiplier} > 0`
    ),
  ]
);

export const inferenceUsageLedger = pgTable(
  'inference_usage_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => inferenceRequests.id, { onDelete: 'restrict' }),
    attemptId: uuid('attempt_id').references(() => inferenceRequestAttempts.id, { onDelete: 'restrict' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    entryType: varchar('entry_type', { length: 16 }).$type<InferenceLedgerEntryType>().notNull(),
    budgetType: varchar('budget_type', { length: 16 }).$type<InferenceBudgetType>().notNull(),
    credits: numeric('credits', { precision: 24, scale: 6 }).notNull().default('0'),
    apiMicrodollars: bigint('api_microdollars', { mode: 'number' }).notNull().default(0),
    // The settled work had no price: api_microdollars is not its cost.
    costUnknown: boolean('cost_unknown').notNull().default(false),
    ...usageColumns,
    reason: varchar('reason', { length: 128 }),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('inference_usage_ledger_user_time_idx').on(table.userId, table.occurredAt),
    index('inference_usage_ledger_request_idx').on(table.requestId),
    uniqueIndex('inference_usage_ledger_settlement_attempt_unique')
      .on(table.attemptId)
      .where(sql`${table.entryType} = 'settlement' AND ${table.attemptId} IS NOT NULL`),
    uniqueIndex('inference_usage_ledger_settlement_legacy_unique')
      .on(table.requestId)
      .where(sql`${table.entryType} = 'settlement' AND ${table.attemptId} IS NULL`),
    check('inference_usage_ledger_values_nonnegative', sql`${table.credits} >= 0 AND ${table.apiMicrodollars} >= 0`),
  ]
);

/**
 * Usage of each user that housekeeping removed with old inference requests (see Housekeeping, Inference Usage), so
 * the lifetime figure still counts it.
 */
export const inferenceUsageLifetimeTotals = pgTable('inference_usage_lifetime_totals', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokens: bigint('tokens', { mode: 'number' }).notNull().default(0),
  credits: numeric('credits', { precision: 24, scale: 6 }).notNull().default('0'),
  apiMicrodollars: bigint('api_microdollars', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const inferenceLimitUsageResets = pgTable(
  'inference_limit_usage_resets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    dimension: varchar('dimension', { length: 32 }).$type<InferenceLimitDimension>().notNull(),
    resetAt: timestamp('reset_at', { withTimezone: true }).notNull().defaultNow(),
    windowActive: boolean('window_active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    uniqueIndex('inference_limit_usage_reset_user_dimension_unique').on(table.userId, table.dimension),
    index('inference_limit_usage_reset_user_idx').on(table.userId),
  ]
);

export const inferenceQuotaSnapshots = pgTable(
  'inference_quota_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id').references(() => inferenceProviderConnections.id, { onDelete: 'set null' }),
    dimension: varchar('dimension', { length: 128 }).notNull(),
    modelBucket: varchar('model_bucket', { length: 255 }),
    status: varchar('status', { length: 16 }).$type<InferenceQuotaStatus>().notNull(),
    remainingFraction: numeric('remaining_fraction', { precision: 12, scale: 9 }),
    remainingValue: numeric('remaining_value', { precision: 30, scale: 9 }),
    limitValue: numeric('limit_value', { precision: 30, scale: 9 }),
    resetAt: timestamp('reset_at', { withTimezone: true }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('inference_quota_connection_time_idx').on(table.connectionId, table.fetchedAt),
    index('inference_quota_validity_idx').on(table.status, table.validUntil),
    check(
      'inference_quota_fraction_range',
      sql`${table.remainingFraction} IS NULL OR (${table.remainingFraction} >= 0 AND ${table.remainingFraction} <= 1)`
    ),
  ]
);

export type InferenceRequest = typeof inferenceRequests.$inferSelect;
export type InferenceRequestAttempt = typeof inferenceRequestAttempts.$inferSelect;
export type InferenceUsageLedgerEntry = typeof inferenceUsageLedger.$inferSelect;
export type InferenceLimitUsageReset = typeof inferenceLimitUsageResets.$inferSelect;
export type InferenceQuotaSnapshot = typeof inferenceQuotaSnapshots.$inferSelect;
