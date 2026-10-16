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
import { admitEdgeChatAttempt } from '../core/inference-core-edge-chat.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import { InferenceBudgetLockService } from './inference-budget-lock.service.js';
import { InferenceBudgetPolicyService } from './inference-budget-policy.js';
import { InferenceBudgetReservationService } from './inference-budget-reservation.service.js';
import { InferenceCoreAccountingService } from './inference-core-accounting.service.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;
const redisUrl = process.env.OPFIELD_TEST_REDIS_URL;

type SourceRow = typeof schema.inferenceModelSources.$inferSelect;
type ConnectionRow = typeof schema.inferenceProviderConnections.$inferSelect;
type ModelRow = typeof schema.inferenceModels.$inferSelect;

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL and OPFIELD_TEST_REDIS_URL): a budget refusal keeps Opfield's
 * own answer on every admission path (stand rc.2 F-10, INF-O-1), and a native Chat Completions admission
 * reserves the prompt Opfield estimated even when the core reports no input estimate (INF-O-2).
 */
describe.skipIf(!url || !redisUrl)('inference budget refusals', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let redis: Redis;
  let accounting: InferenceCoreAccountingService;
  let apiUserId = '';
  let subscriptionUserId = '';
  let apiConnection: ConnectionRow;
  let subscriptionConnection: ConnectionRow;
  let apiModel: ModelRow;
  let subscriptionModel: ModelRow;
  let apiSource: SourceRow;
  let subscriptionSource: SourceRow;

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'inference_refusal');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema }) as unknown as DrizzleClient;
    redis = new Redis(redisUrl!, { lazyConnect: false, maxRetriesPerRequest: 1 });
    accounting = new InferenceCoreAccountingService(
      db,
      new InferenceBudgetPolicyService(db),
      new InferenceBudgetReservationService(redis),
      new InferenceBudgetLockService(db),
      undefined,
      redis
    );

    const group = (await pool.query(`insert into permission_groups (name) values ('refusal') returning id`)).rows[0].id;
    const user = async (email: string) =>
      (await pool.query(`insert into users (email, name, group_id) values ($1, 'U', $2) returning id`, [email, group]))
        .rows[0].id as string;
    apiUserId = await user('api-refusal@example.test');
    subscriptionUserId = await user('sub-refusal@example.test');
    const policy = {
      policyType: 'user' as const,
      credits5h: '0',
      credits7d: '0',
      credits30d: '0',
      credits5hEnabled: false,
      credits7dEnabled: false,
      credits30dEnabled: false,
      apiMonthlyMicrodollars: 0,
    };
    // 100,000 µ$ of API budget; the subscription user has an enabled 5h window of 0 credits.
    await db.insert(schema.inferenceLimitPolicies).values([
      { ...policy, userId: apiUserId, apiMonthlyMicrodollars: 100_000 },
      { ...policy, userId: subscriptionUserId, credits5hEnabled: true },
    ]);
    const connection = (providerId: string, name: string) => ({
      providerId,
      name,
      authType: 'api_key' as const,
      baseUrl: 'https://example.test/v1',
      status: 'healthy' as const,
    });
    [apiConnection] = await db
      .insert(schema.inferenceProviderConnections)
      .values(connection('openrouter', 'API'))
      .returning();
    [subscriptionConnection] = await db
      .insert(schema.inferenceProviderConnections)
      .values(connection('zai', 'Plan'))
      .returning();
    const model = (publicId: string) => ({
      publicId,
      displayName: publicId,
      contextWindow: 128_000,
      maxInputTokens: 128_000,
      autoCompactTokenLimit: 100_000,
      enabled: true,
    });
    [apiModel] = await db.insert(schema.inferenceModels).values(model('refusal-api')).returning();
    [subscriptionModel] = await db.insert(schema.inferenceModels).values(model('refusal-plan')).returning();
    const source = (
      modelId: string,
      connectionRow: ConnectionRow,
      upstream: string,
      sourceType: 'api' | 'subscription'
    ) => ({
      modelId,
      connectionId: connectionRow.id,
      upstreamModelId: upstream,
      coreAccountId: `core-${connectionRow.id}`,
      coreModelId: upstream,
      sourceType,
    });
    [apiSource] = await db
      .insert(schema.inferenceModelSources)
      .values(source(apiModel.id, apiConnection, 'vendor/api', 'api'))
      .returning();
    [subscriptionSource] = await db
      .insert(schema.inferenceModelSources)
      .values(source(subscriptionModel.id, subscriptionConnection, 'glm-plan', 'subscription'))
      .returning();
    // $1 per million input tokens, $10 per million output tokens.
    await db.insert(schema.inferencePricingSnapshots).values({
      sourceId: apiSource.id,
      version: 'refusal-1',
      inputMicrodollarsPerMillion: 1_000_000,
      outputMicrodollarsPerMillion: 10_000_000,
      source: 'manual',
    });
  }, 180_000);

  afterAll(async () => {
    await redis?.flushdb().catch(() => undefined);
    redis?.disconnect();
    await database?.drop();
  });

  const newRequest = (
    userId: string,
    model: ModelRow,
    source: SourceRow,
    connection: ConnectionRow,
    inputTokenEstimate?: number
  ) =>
    accounting.createCoreRequest({
      userId,
      tokenId: null,
      protocol: 'chat_completions',
      operation: 'chat_completions',
      model,
      source,
      connection,
      ...(inputTokenEstimate !== undefined ? { inputTokenEstimate } : {}),
    });

  const admission = (
    requestId: string,
    attemptId: string,
    source: SourceRow,
    estimate: { inputTokens: number; maxOutputTokens: number }
  ): InferenceCoreAdmissionRequest => ({
    contractId: OPFIELD_CORE_CONTRACT_ID,
    rootRequestId: requestId,
    attemptId,
    parentAttemptId: null,
    attemptKind: 'root' as const,
    coreAccountId: source.coreAccountId!,
    coreModelId: source.coreModelId!,
    sourceType: source.sourceType,
    operation: 'chat_completions',
    estimate,
    occurredAt: new Date().toISOString(),
  });

  const requestRow = async (id: string) =>
    (await db.query.inferenceRequests.findFirst({ where: eq(schema.inferenceRequests.id, id) }))!;
  const attemptRow = async (coreAttemptId: string) =>
    (await db.query.inferenceRequestAttempts.findFirst({
      where: eq(schema.inferenceRequestAttempts.coreAttemptId, coreAttemptId),
    }))!;

  it('reserves the prompt Opfield estimated when the core reports no input estimate', async () => {
    // A ~9,000 character prompt (3,000 tokens) with max_tokens 100: 3,000 × 1 µ$ + 100 × 10 µ$.
    const { requestId } = await newRequest(apiUserId, apiModel, apiSource, apiConnection, 3_000);
    await expect(
      accounting.admitCoreAttempt(
        admission(requestId, 'att_estimate', apiSource, { inputTokens: 0, maxOutputTokens: 100 })
      )
    ).resolves.toEqual({ decision: 'allow' });
    expect((await attemptRow('att_estimate')).reservedApiMicrodollars).toBe(4_000);
    // A core that does report a larger estimate keeps it.
    const larger = await newRequest(apiUserId, apiModel, apiSource, apiConnection, 10);
    await accounting.admitCoreAttempt(
      admission(larger.requestId, 'att_estimate_core', apiSource, { inputTokens: 500, maxOutputTokens: 100 })
    );
    expect((await attemptRow('att_estimate_core')).reservedApiMicrodollars).toBe(1_500);
    await accounting.dropUnsettledAttempt(requestId, 'att_estimate');
    await accounting.dropUnsettledAttempt(larger.requestId, 'att_estimate_core');
    await accounting.finalizeCoreRequest(requestId, 'failed');
    await accounting.finalizeCoreRequest(larger.requestId, 'failed');
  });

  it('answers an exhausted API budget with the Opfield code, window and recovery time', async () => {
    const { requestId } = await newRequest(apiUserId, apiModel, apiSource, apiConnection);
    // max_tokens 20,000 reserves 200,000 µ$, more than the 100,000 µ$ budget.
    const verdict = await accounting.admitCoreAttempt(
      admission(requestId, 'att_refused', apiSource, { inputTokens: 10, maxOutputTokens: 20_000 })
    );
    expect(verdict).toMatchObject({ decision: 'deny', reason: 'budget_exceeded' });
    expect(verdict.decision === 'deny' ? verdict.retryAfterSeconds : 0).toBeGreaterThan(0);

    const denial = await accounting.admissionDenial(requestId);
    expect(denial).toBeInstanceOf(InferenceProtocolError);
    expect(denial).toMatchObject({ status: 429, code: 'api_budget_exhausted' });
    expect(denial?.details).toMatchObject({ dimension: 'monthly', recoveryAt: expect.any(String) });
    expect(Date.parse(String(denial?.details?.recoveryAt))).toBeGreaterThan(Date.now());

    // Stored as a budget refusal, not upstream_error, even when the proxy passes no error.
    await accounting.finalizeCoreRequest(requestId, 'failed');
    expect(await requestRow(requestId)).toMatchObject({ status: 'failed', errorCode: 'api_budget_exhausted' });
    expect(await accounting.admissionDenial(requestId)).toBeNull();
  });

  it('forgets a refusal once a later attempt of the same request is admitted', async () => {
    const { requestId } = await newRequest(apiUserId, apiModel, apiSource, apiConnection);
    await accounting.admitCoreAttempt(
      admission(requestId, 'att_first', apiSource, { inputTokens: 10, maxOutputTokens: 20_000 })
    );
    expect(await accounting.admissionDenial(requestId)).not.toBeNull();
    await expect(
      accounting.admitCoreAttempt(
        admission(requestId, 'att_second', apiSource, { inputTokens: 10, maxOutputTokens: 10 })
      )
    ).resolves.toEqual({ decision: 'allow' });
    expect(await accounting.admissionDenial(requestId)).toBeNull();
    expect((await requestRow(requestId)).errorCode).toBeNull();
    await accounting.dropUnsettledAttempt(requestId, 'att_second');
    await accounting.finalizeCoreRequest(requestId, 'failed');
  });

  it('throws the same refusal on the edge path older cores use', async () => {
    const { requestId } = await newRequest(apiUserId, apiModel, apiSource, apiConnection);
    const refused = admitEdgeChatAttempt(accounting, {
      rootRequestId: requestId,
      coreAccountId: apiSource.coreAccountId!,
      coreModelId: apiSource.coreModelId!,
      sourceType: 'api',
      estimate: { inputTokens: 10, maxOutputTokens: 20_000 },
    });
    await expect(refused).rejects.toMatchObject({
      status: 429,
      code: 'api_budget_exhausted',
      details: { dimension: 'monthly', recoveryAt: expect.any(String) },
    });
    await accounting.finalizeCoreRequest(requestId, 'failed', await refused.catch((error: unknown) => error));
    expect((await requestRow(requestId)).errorCode).toBe('api_budget_exhausted');
  });

  it('refuses a connection over its monthly API limit instead of failing the admission callback', async () => {
    await db
      .update(schema.inferenceProviderConnections)
      .set({ apiMonthlyLimitMicrodollars: 0 })
      .where(eq(schema.inferenceProviderConnections.id, apiConnection.id));
    const [capped] = await db
      .select()
      .from(schema.inferenceProviderConnections)
      .where(eq(schema.inferenceProviderConnections.id, apiConnection.id));
    const { requestId } = await newRequest(apiUserId, apiModel, apiSource, capped!);
    await expect(
      accounting.admitCoreAttempt(
        admission(requestId, 'att_capped', apiSource, { inputTokens: 10, maxOutputTokens: 10 })
      )
    ).resolves.toMatchObject({ decision: 'deny', reason: 'budget_exceeded' });
    expect(await accounting.admissionDenial(requestId)).toMatchObject({
      status: 429,
      code: 'provider_api_budget_exhausted',
    });
    await accounting.finalizeCoreRequest(requestId, 'failed');
    expect((await requestRow(requestId)).errorCode).toBe('provider_api_budget_exhausted');
    await db
      .update(schema.inferenceProviderConnections)
      .set({ apiMonthlyLimitMicrodollars: null })
      .where(eq(schema.inferenceProviderConnections.id, apiConnection.id));
  });

  it('names the exhausted subscription window and when it recovers', async () => {
    const { requestId } = await newRequest(
      subscriptionUserId,
      subscriptionModel,
      subscriptionSource,
      subscriptionConnection
    );
    await expect(
      accounting.admitCoreAttempt(
        admission(requestId, 'att_plan', subscriptionSource, { inputTokens: 10, maxOutputTokens: 10 })
      )
    ).resolves.toMatchObject({ decision: 'deny', reason: 'budget_exceeded' });
    expect(await accounting.admissionDenial(requestId)).toMatchObject({
      status: 429,
      code: 'subscription_budget_exhausted',
      details: { dimension: '5h', recoveryAt: expect.any(String) },
    });
    await accounting.finalizeCoreRequest(requestId, 'failed');
    expect((await requestRow(requestId)).errorCode).toBe('subscription_budget_exhausted');
  });
});
