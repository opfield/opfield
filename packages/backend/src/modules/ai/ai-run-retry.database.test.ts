import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { InferenceProtocolError } from '@/modules/inference/protocol/inference-protocol.error.js';
import type { User } from '@/types.js';
import type { WSServerMessage } from './ai.types.js';
import { AIConversationService } from './ai-conversation.service.js';
import { describeModelCallError } from './ai-model-call-retry.js';
import { AIRunService } from './ai-run.service.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;

interface ExecutorInternals {
  applyRuntimeEvent(input: {
    user: User;
    run: schema.AIRun;
    event: WSServerMessage;
    assistantContent: string;
    assistantMessageWritten: boolean;
  }): Promise<{ assistantContent: string; assistantMessageWritten: boolean; done: boolean }>;
}

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): a run that used tools over several model calls fails on a
 * provider 5xx; Retry returns to the user message by the id the chat shows and sends it again, and the new
 * run finishes. This is the sequence that left Retry dead on production (2026-10-13).
 */
describe.skipIf(!url)('AI Retry after a provider failure on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'ai_retry');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('resends the user message and the next run completes', async () => {
    const q = (text: string, values: unknown[] = []) => pool.query(text, values);
    const groupId = (await q(`insert into permission_groups (name) values ('retry') returning id`)).rows[0].id;
    const userId = (
      await q(`insert into users (email, name, group_id) values ('retry@example.test', 'Operator', $1) returning id`, [
        groupId,
      ])
    ).rows[0].id as string;
    const user = { id: userId } as User;
    const runs = new AIRunService(db);
    const conversations = new AIConversationService(db);
    const executor = (runs as unknown as { executor: ExecutorInternals }).executor;
    const prompt = 'Remove the unused images on every node';

    const startRun = async (clientCommandId: string, conversationId?: string) => {
      const started = await runs.startUserRun({
        conversationId: conversationId ?? null,
        userId,
        title: 'Image cleanup',
        userMessage: { role: 'user', content: prompt, attachments: [] },
        clientCommandId,
      });
      const [run] = await db
        .update(schema.aiRuns)
        .set({ status: 'running' })
        .where(eq(schema.aiRuns.id, started.run.id))
        .returning();
      let assistantContent = '';
      let assistantMessageWritten = false;
      const apply = async (event: WSServerMessage) => {
        const result = await executor.applyRuntimeEvent({
          user,
          run,
          event,
          assistantContent,
          assistantMessageWritten,
        });
        ({ assistantContent, assistantMessageWritten } = result);
        return result;
      };
      return { run, conversationId: started.conversationId, apply };
    };
    const toolRound = async (apply: (event: WSServerMessage) => Promise<unknown>, runId: string, callId: string) => {
      const call = { id: callId, name: 'list_docker_images', arguments: {} };
      await apply({
        type: 'tool_round_start',
        requestId: runId,
        roundId: randomUUID(),
        calls: [
          {
            ...call,
            position: 0,
            gate: 'immediate',
            classification: 'read',
            approvalPolicy: 'auto_approved',
            requiredScopes: [],
          },
        ],
        providerMessages: [],
      });
      await apply({ type: 'tool_call_start', requestId: runId, ...call });
      await apply({ type: 'tool_result', requestId: runId, id: callId, name: call.name, result: { images: [] } });
    };

    // The first run: two model calls ask for tools, the third model call fails upstream after three tries.
    const first = await startRun('command-1');
    await toolRound(first.apply, first.run.id, 'call-1');
    await toolRound(first.apply, first.run.id, 'call-2');
    const providerFailure = new InferenceProtocolError(
      502,
      'upstream_server_error',
      'Upstream inference request failed',
      {
        provider: 'Anthropic',
        attempts: 3,
      }
    );
    const failed = await first.apply({
      type: 'error',
      requestId: first.run.id,
      message: describeModelCallError(providerFailure),
    });
    expect(failed.done).toBe(true);

    const [failedRun] = await db.select().from(schema.aiRuns).where(eq(schema.aiRuns.id, first.run.id));
    expect(failedRun.status).toBe('failed');

    // The chat shows the error line with Retry, and the user message under its stored id.
    const detail = await conversations.getConversation(userId, first.conversationId);
    const shown = (detail?.messages ?? []) as Array<Record<string, unknown>>;
    expect(shown.at(-1)).toMatchObject({
      content: '**Error:** Anthropic returned a server error. Opfield tried 3 times.',
      localOnly: true,
      runError: true,
    });
    const userMessage = shown.find((message) => message.role === 'user');
    expect(userMessage?.id).toBe(first.run.activeMessageId);

    // A client-side id is refused as unknown instead of failing the request.
    expect(await conversations.rollbackToMessage(userId, first.conversationId, 'starting:command-1:user')).toBeNull();

    // Retry: the route stops any active run, returns to the user message and the client sends it again.
    await runs.stopActiveRunForRollback({ conversationId: first.conversationId, userId });
    const rollback = await conversations.rollbackToMessage(userId, first.conversationId, String(userMessage?.id));
    expect(rollback?.message).toMatchObject({ role: 'user', content: prompt });
    expect(rollback?.conversation.messages).toEqual([]);

    const second = await startRun('command-2', first.conversationId);
    await toolRound(second.apply, second.run.id, 'call-3');
    await second.apply({ type: 'text_delta', requestId: second.run.id, content: 'Removed 3 unused images.' });
    const done = await second.apply({ type: 'done', requestId: second.run.id });
    expect(done.done).toBe(true);

    const [completedRun] = await db.select().from(schema.aiRuns).where(eq(schema.aiRuns.id, second.run.id));
    expect(completedRun.status).toBe('completed');
    const rows = await db
      .select({ uiMessage: schema.aiConversationMessages.uiMessage })
      .from(schema.aiConversationMessages)
      .where(eq(schema.aiConversationMessages.conversationId, first.conversationId))
      .orderBy(asc(schema.aiConversationMessages.sequence));
    expect(
      rows.map(({ uiMessage }) => (uiMessage.toolGroupBoundary ? 'tools' : `${uiMessage.role}: ${uiMessage.content}`))
    ).toEqual(['user: Remove the unused images on every node', 'tools', 'assistant: Removed 3 unused images.']);
  });
});
