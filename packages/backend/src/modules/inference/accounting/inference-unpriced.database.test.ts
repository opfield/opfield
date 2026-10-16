import 'reflect-metadata';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Redis } from 'ioredis';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { type InferenceCoreAdmissionRequest, OPFIELD_CORE_CONTRACT_ID } from '../core/inference-core.contract.js';
import { admitEdgeChatAttempt, settleEdgeChatAttempt } from '../core/inference-core-edge-chat.js';
import { INFERENCE_PRICE_MISSING_WARNING } from '../inference-pricing.js';
import { InferenceModelService } from '../models/inference-model.service.js';
import { InferenceProviderRegistry } from '../providers/inference-provider.registry.js';
import { InferenceBudgetLockService } from './inference-budget-lock.service.js';
import { InferenceBudgetPolicyService } from './inference-budget-policy.js';
import { InferenceBudgetReservationService } from './inference-budget-reservation.service.js';
import { InferenceCoreAccountingService } from './inference-core-accounting.service.js';
import { InferenceUsageService } from './inference-usage.service.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;
const redisUrl = process.env.OPFIELD_TEST_REDIS_URL;

type SourceRow = typeof schema.inferenceModelSources.$inferSelect;

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL and OPFIELD_TEST_REDIS_URL): an API source without a price serves
 * requests on both admission paths (core admission on opfield.5+, edge admission for older cores). The request,
 * attempt and ledger rows record the tokens and an unknown cost, API budgets neither refuse nor count it, and the
 * admin warning lists the model.
 */
describe.skipIf(!url || !redisUrl)('inference requests on an API source without a price', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let redis: Redis;
  let accounting: InferenceCoreAccountingService;
  let usageService: InferenceUsageService;
  let models: InferenceModelService;
  let userId = '';
  let connection: typeof schema.inferenceProviderConnections.$inferSelect;
  let pricedModel: typeof schema.inferenceModels.$inferSelect;
  let unpricedModel: typeof schema.inferenceModels.$inferSelect;
  let pricedSource: SourceRow;
  let unpricedSource: SourceRow;

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'inference_unpriced');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema }) as unknown as DrizzleClient;
    redis = new Redis(redisUrl!, { lazyConnect: false, maxRetriesPerRequest: 1 });
    const policies = new InferenceBudgetPolicyService(db);
    const reservations = new InferenceBudgetReservationService(redis);
    accounting = new InferenceCoreAccountingService(
      db,
      policies,
      reservations,
      new InferenceBudgetLockService(db),
      undefined,
      redis
    );
    usageService = new InferenceUsageService(db, policies, { log: async () => true } as never);
    models = new InferenceModelService(
      db,
      new InferenceProviderRegistry(),
      {} as never,
      { log: async () => true } as never,
      policies
    );

    const group = (await pool.query(`insert into permission_groups (name) values ('unpriced') returning id`)).rows[0]
      .id;
    userId = (
      await pool.query(
        `insert into users (email, name, group_id) values ('unpriced@example.test', 'U', $1) returning id`,
        [group]
      )
    ).rows[0].id;
    // A user with a small monthly API budget; the connection has its own small monthly cap.
    await db.insert(schema.inferenceLimitPolicies).values({
      policyType: 'user',
      userId,
      credits5h: '0',
      credits7d: '0',
      credits30d: '0',
      credits5hEnabled: false,
      credits7dEnabled: false,
      credits30dEnabled: false,
      apiMonthlyMicrodollars: 1_000,
    });
    [connection] = await db
      .insert(schema.inferenceProviderConnections)
      .values({
        providerId: 'openrouter',
        name: 'OpenRouter',
        authType: 'api_key',
        baseUrl: 'https://openrouter.ai/api/v1',
        status: 'healthy',
        apiMonthlyLimitMicrodollars: 2_000,
      })
      .returning();
    const model = (publicId: string) => ({
      publicId,
      displayName: publicId,
      contextWindow: 128_000,
      maxInputTokens: 128_000,
      autoCompactTokenLimit: 100_000,
      enabled: true,
    });
    [pricedModel] = await db.insert(schema.inferenceModels).values(model('priced-model')).returning();
    [unpricedModel] = await db.insert(schema.inferenceModels).values(model('unpriced-model')).returning();
    const source = (modelId: string, upstream: string) => ({
      modelId,
      connectionId: connection.id,
      upstreamModelId: upstream,
      coreAccountId: `core-${connection.id}`,
      coreModelId: upstream,
      sourceType: 'api' as const,
    });
    [pricedSource] = await db
      .insert(schema.inferenceModelSources)
      .values(source(pricedModel.id, 'vendor/priced'))
      .returning();
    [unpricedSource] = await db
      .insert(schema.inferenceModelSources)
      .values(source(unpricedModel.id, 'vendor/unpriced'))
      .returning();
    // $1 per million input and output tokens; the unpriced source has no snapshot at all.
    await db.insert(schema.inferencePricingSnapshots).values({
      sourceId: pricedSource.id,
      version: 'test-1',
      inputMicrodollarsPerMillion: 1_000_000,
      outputMicrodollarsPerMillion: 1_000_000,
      source: 'manual',
    });
  }, 180_000);

  afterAll(async () => {
    await redis?.flushdb().catch(() => undefined);
    redis?.disconnect();
    await database?.drop();
  });

  const newRequest = (model: typeof pricedModel, source: SourceRow) =>
    accounting.createCoreRequest({
      userId,
      tokenId: null,
      protocol: 'chat_completions',
      operation: 'chat_completions',
      model,
      source,
      connection,
    });

  const admission = (requestId: string, attemptId: string, source: SourceRow): InferenceCoreAdmissionRequest => ({
    contractId: OPFIELD_CORE_CONTRACT_ID,
    rootRequestId: requestId,
    attemptId,
    parentAttemptId: null,
    attemptKind: 'root' as const,
    coreAccountId: source.coreAccountId!,
    coreModelId: source.coreModelId!,
    sourceType: 'api' as const,
    operation: 'chat_completions',
    estimate: { inputTokens: 10, maxOutputTokens: 10 },
    occurredAt: new Date().toISOString(),
  });

  const settle = (requestId: string, attemptId: string, source: SourceRow, inputTokens: number) =>
    accounting.settleCoreAttempt({
      contractId: OPFIELD_CORE_CONTRACT_ID,
      rootRequestId: requestId,
      attemptId,
      parentAttemptId: null,
      attemptKind: 'root',
      terminalStatus: 'completed',
      coreAccountId: source.coreAccountId!,
      coreModelId: source.coreModelId!,
      sourceType: 'api',
      upstreamStatus: 200,
      errorCode: null,
      usage: {
        uncachedInputTokens: inputTokens,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 40,
        reasoningTokens: 0,
      },
      usageEstimated: false,
      emittedOutput: true,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

  const requestRow = async (id: string) =>
    (await db.query.inferenceRequests.findFirst({ where: eq(schema.inferenceRequests.id, id) }))!;
  const ledgerRows = async (id: string) =>
    db.query.inferenceUsageLedger.findMany({ where: eq(schema.inferenceUsageLedger.requestId, id) });

  it('lets a priced request exhaust the API budget, which then refuses the next priced one', async () => {
    const { requestId } = await newRequest(pricedModel, pricedSource);
    await expect(accounting.admitCoreAttempt(admission(requestId, 'att_priced_1', pricedSource))).resolves.toEqual({
      decision: 'allow',
    });
    // One million input tokens at $1 per million: far past the $0.001 user budget and the connection cap.
    await settle(requestId, 'att_priced_1', pricedSource, 1_000_000);
    await accounting.finalizeCoreRequest(requestId, 'completed');
    const row = await requestRow(requestId);
    expect(row).toMatchObject({ costUnknown: false, uncachedInputTokens: 1_000_000 });
    expect(row.apiMicrodollarsCharged).toBeGreaterThan(1_000);

    // The connection's monthly cap refuses first; without it, the user's own API budget does.
    const next = await newRequest(pricedModel, pricedSource);
    await expect(
      accounting.admitCoreAttempt(admission(next.requestId, 'att_priced_2', pricedSource))
    ).resolves.toMatchObject({ decision: 'deny', reason: 'budget_exceeded' });
    expect(await accounting.admissionDenial(next.requestId)).toMatchObject({ code: 'provider_api_budget_exhausted' });
    await db
      .update(schema.inferenceProviderConnections)
      .set({ apiMonthlyLimitMicrodollars: null })
      .where(eq(schema.inferenceProviderConnections.id, connection.id));
    const refused = await accounting.admitCoreAttempt(admission(next.requestId, 'att_priced_3', pricedSource));
    expect(refused).toMatchObject({ decision: 'deny', reason: 'budget_exceeded' });
    await db
      .update(schema.inferenceProviderConnections)
      .set({ apiMonthlyLimitMicrodollars: 2_000 })
      .where(eq(schema.inferenceProviderConnections.id, connection.id));
    await accounting.finalizeCoreRequest(next.requestId, 'failed');
  });

  it('admits an unpriced request through core admission and records its tokens with an unknown cost', async () => {
    const { requestId } = await newRequest(unpricedModel, unpricedSource);
    await expect(accounting.admitCoreAttempt(admission(requestId, 'att_unpriced_1', unpricedSource))).resolves.toEqual({
      decision: 'allow',
    });
    expect((await requestRow(requestId)).costUnknown).toBe(true);
    // The proxy may finalize before the core's settlement arrives; the request stays marked meanwhile.
    await accounting.finalizeCoreRequest(requestId, 'completed');
    expect((await requestRow(requestId)).costUnknown).toBe(true);
    await settle(requestId, 'att_unpriced_1', unpricedSource, 1_200);

    const row = await requestRow(requestId);
    expect(row).toMatchObject({
      status: 'completed',
      budgetType: 'api',
      costUnknown: true,
      apiMicrodollarsCharged: 0,
      uncachedInputTokens: 1_200,
      outputTokens: 40,
      pricingSnapshotId: null,
    });
    const ledger = await ledgerRows(requestId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ costUnknown: true, apiMicrodollars: 0, uncachedInputTokens: 1_200 });
    expect(ledger[0]!.snapshot).toMatchObject({ priceMissing: true });
    const attempt = await db.query.inferenceRequestAttempts.findFirst({
      where: eq(schema.inferenceRequestAttempts.requestId, requestId),
    });
    expect(attempt).toMatchObject({ costUnknown: true, reservedApiMicrodollars: 0, status: 'completed' });
  });

  it('admits an unpriced request through edge admission (older cores) the same way', async () => {
    const { requestId } = await newRequest(unpricedModel, unpricedSource);
    const attempt = await admitEdgeChatAttempt(accounting, {
      rootRequestId: requestId,
      coreAccountId: unpricedSource.coreAccountId!,
      coreModelId: unpricedSource.coreModelId!,
      sourceType: 'api',
      estimate: { inputTokens: 10, maxOutputTokens: 10 },
    });
    await settleEdgeChatAttempt(db, accounting, attempt, 'completed', {
      usage: {
        uncachedInputTokens: 300,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 7,
        reasoningTokens: 0,
      },
      emittedOutput: true,
    });
    await accounting.finalizeCoreRequest(requestId, 'completed');
    expect(await requestRow(requestId)).toMatchObject({
      status: 'completed',
      costUnknown: true,
      apiMicrodollarsCharged: 0,
      uncachedInputTokens: 300,
      outputTokens: 7,
    });
    expect(await ledgerRows(requestId)).toMatchObject([{ costUnknown: true, apiMicrodollars: 0 }]);
  });

  it('keeps unpriced requests out of the API budget the priced ones exhausted', async () => {
    const usage = await new InferenceBudgetPolicyService(db).usage(
      userId,
      await new InferenceBudgetPolicyService(db).effective(userId)
    );
    const pricedSpend = (
      await pool.query(
        `select coalesce(sum(api_microdollars), 0)::bigint as spend from inference_usage_ledger where user_id = $1 and not cost_unknown`,
        [userId]
      )
    ).rows[0].spend;
    expect(usage.apiMonthlyMicrodollars).toBe(Number(pricedSpend));
  });

  it('shows the unknown cost in activity and warns administrators in the overview and model list', async () => {
    const activity = await usageService.activity({ model: 'unpriced-model' });
    expect(activity.data.length).toBeGreaterThanOrEqual(2);
    expect(activity.data.every((row) => row.costUnknown && row.apiMicrodollars === 0)).toBe(true);
    const pricedActivity = await usageService.activity({ model: 'priced-model', status: 'completed' });
    expect(pricedActivity.data[0]?.costUnknown).toBe(false);

    const overview = await usageService.adminOverview();
    expect(overview.unpriced?.warning).toContain(INFERENCE_PRICE_MISSING_WARNING);
    expect(overview.unpriced?.models).toEqual([expect.objectContaining({ model: 'unpriced-model', requests: 2 })]);
    expect(overview.requestTotals.reduce((sum, row) => sum + row.unpricedRequests, 0)).toBe(2);
    expect(overview.ledgerTotals.find((row) => row.budgetType === 'api')?.unpricedTokens).toBe(1_200 + 40 + 300 + 7);

    const listed = await models.listAdmin();
    const unpriced = listed.find((model) => model.publicId === 'unpriced-model')!;
    expect(unpriced).toMatchObject({ unpricedSources: 1, priceWarning: INFERENCE_PRICE_MISSING_WARNING });
    expect(unpriced.sources[0]).toMatchObject({ priceMissing: true, pricing: null });
    expect(listed.find((model) => model.publicId === 'priced-model')).toMatchObject({
      unpricedSources: 0,
      priceWarning: null,
    });
  });

  it('clears the warning once the model has a price', async () => {
    await db.insert(schema.inferencePricingSnapshots).values({
      sourceId: unpricedSource.id,
      version: 'test-2',
      inputMicrodollarsPerMillion: 500_000,
      outputMicrodollarsPerMillion: 500_000,
      source: 'manual',
    });
    expect(await usageService.unpricedModels()).toEqual([]);
    expect((await usageService.adminOverview()).unpriced).toBeNull();
    const listed = await models.listAdmin();
    expect(listed.find((model) => model.publicId === 'unpriced-model')).toMatchObject({ priceWarning: null });
  });
});
