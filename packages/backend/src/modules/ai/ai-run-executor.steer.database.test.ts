import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import type { User } from '@/types.js';
import type { ChatMessage, WSServerMessage } from './ai.types.js';
import { AIConversationService } from './ai-conversation.service.js';
import { AIRunExecutor } from './ai-run-executor.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;
const noop = () => undefined;

interface ExecutorInternals {
  applyRuntimeEvent(input: {
    user: User;
    run: schema.AIRun;
    event: WSServerMessage;
    assistantContent: string;
    assistantMessageWritten: boolean;
  }): Promise<{ assistantContent: string; assistantMessageWritten: boolean; done: boolean }>;
  receivePendingSteers(
    user: User,
    run: schema.AIRun,
    messages: ChatMessage[],
    signal: AbortSignal
  ): Promise<ChatMessage[]>;
}

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): a steer accepted mid-run is persisted where the run accepted it.
 * Tool calls and text from later rounds land below it in a new group, in storage and in the conversation read API.
 */
describe.skipIf(!url)('AI run steering on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'ai_steer');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('closes the current tool group at every accepted steer', async () => {
    const q = (text: string, values: unknown[] = []) => pool.query(text, values);
    const groupId = (await q(`insert into permission_groups (name) values ('steer') returning id`)).rows[0].id;
    const userId = (
      await q(`insert into users (email, name, group_id) values ('steer@example.test', 'Operator', $1) returning id`, [
        groupId,
      ])
    ).rows[0].id as string;
    const user = { id: userId } as User;
    const [conversation] = await db.insert(schema.aiConversations).values({ userId, title: 'Steered run' }).returning();
    const [prompt] = await db
      .insert(schema.aiConversationMessages)
      .values({
        conversationId: conversation.id,
        sequence: 0,
        role: 'user',
        content: 'Check the nodes',
        uiMessage: { role: 'user', content: 'Check the nodes' },
      })
      .returning();
    const [run] = await db
      .insert(schema.aiRuns)
      .values({
        conversationId: conversation.id,
        userId,
        status: 'running',
        activeMessageId: prompt.id,
        clientCommandId: 'command-run',
      })
      .returning();

    const executor = new AIRunExecutor(db, noop, noop, noop, noop) as unknown as ExecutorInternals;
    let assistantContent = '';
    const apply = async (event: WSServerMessage) => {
      ({ assistantContent } = await executor.applyRuntimeEvent({
        user,
        run,
        event,
        assistantContent,
        assistantMessageWritten: false,
      }));
    };
    const toolRound = async (callId: string) => {
      const call = { id: callId, name: 'list_nodes', arguments: {} };
      await apply({
        type: 'tool_round_start',
        requestId: run.id,
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
      await apply({ type: 'tool_call_start', requestId: run.id, ...call });
      await apply({ type: 'tool_result', requestId: run.id, id: callId, name: call.name, result: { nodes: [] } });
    };
    // Steers wait for a short debounce after their last update; an older update is accepted at once.
    const steer = async (content: string) => {
      const sentAt = new Date(Date.now() - 60_000);
      await db.insert(schema.aiConversationInputs).values({
        conversationId: conversation.id,
        targetRunId: run.id,
        userId,
        clientCommandId: `command-${randomUUID()}`,
        mode: 'steer',
        content,
        createdAt: sentAt,
        updatedAt: sentAt,
      });
      await executor.receivePendingSteers(user, run, [], new AbortController().signal);
    };

    await apply({ type: 'text_delta', requestId: run.id, content: 'Checking the nodes.' });
    await toolRound('call-1');
    await steer('Only the edge nodes');
    await toolRound('call-2');
    await steer('Skip staging');
    await apply({ type: 'text_delta', requestId: run.id, content: 'Edge nodes only.' });
    await toolRound('call-3');

    const rows = await db
      .select({ id: schema.aiConversationMessages.id, uiMessage: schema.aiConversationMessages.uiMessage })
      .from(schema.aiConversationMessages)
      .where(eq(schema.aiConversationMessages.conversationId, conversation.id))
      .orderBy(asc(schema.aiConversationMessages.sequence));
    const transcript = (messages: Array<Record<string, unknown>>) =>
      messages.map((message) =>
        message.toolGroupBoundary ? 'tools' : `${message.role}${message.steer ? ' (steer)' : ''}: ${message.content}`
      );
    const expected = [
      'user: Check the nodes',
      'assistant: Checking the nodes.',
      'tools',
      'user (steer): Only the edge nodes',
      'tools',
      'user (steer): Skip staging',
      'assistant: Edge nodes only.',
      'tools',
    ];
    expect(transcript(rows.map((row) => row.uiMessage))).toEqual(expected);

    const toolCalls = await db
      .select({
        toolCallId: schema.aiRunToolCalls.toolCallId,
        assistantMessageId: schema.aiRunToolCalls.assistantMessageId,
      })
      .from(schema.aiRunToolCalls)
      .where(eq(schema.aiRunToolCalls.runId, run.id))
      .orderBy(asc(schema.aiRunToolCalls.createdAt));
    const rowIndex = (id: string | null) => rows.findIndex((row) => row.id === id);
    expect(toolCalls.map((call) => [call.toolCallId, rowIndex(call.assistantMessageId)])).toEqual([
      ['call-1', 2],
      ['call-2', 4],
      ['call-3', 7],
    ]);

    const detail = await new AIConversationService(db).getConversation(userId, conversation.id);
    expect(transcript((detail?.messages ?? []) as Array<Record<string, unknown>>)).toEqual(expected);
  });
});
