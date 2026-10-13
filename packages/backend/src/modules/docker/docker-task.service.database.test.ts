import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { CryptoService } from '@/services/crypto.service.js';
import { listNodeLongTasks } from '@/services/node-long-tasks.js';
import { updateContainer, updateContainerEnv } from './docker-container-mutation-operations.js';
import { DAEMON_ERROR, fakeDockerNode, opfieldProcess } from './docker-env-follow-ups.test-helpers.js';
import { DockerEnvironmentService } from './docker-environment.service.js';
import { DETACHED_TASK_PROGRESS, DockerTaskService } from './docker-task.service.js';
import { DockerTaskReconciler } from './docker-task-reconciler.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): a Gateway restart keeps the Docker tasks a node may still run
 * (they have tracking) active, so a daemon update waiting for the node's tasks still sees them, and settles them
 * later; a task without tracking fails as before (F-1).
 */
describe.skipIf(!url)('Docker tasks across a Gateway restart', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let nodeId = '';

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'docker_task_tracking');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema }) as unknown as DrizzleClient;
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    const suffix = randomUUID().slice(0, 8);
    nodeId = (await pool.query(`insert into nodes (hostname, slug) values ($1, $1) returning id`, [`node-${suffix}`]))
      .rows[0].id;
  });

  it('keeps a tracked pull for the update wait and fails an untracked task', async () => {
    const service = new DockerTaskService(db);
    const pull = await service.create({ nodeId, containerName: 'pytorch/pytorch:2.5.1', type: 'pull' });
    await service.update(pull.id, { status: 'running' });
    await service.track(
      pull.id,
      { kind: 'pull', imageRef: 'pytorch/pytorch:2.5.1', deadlineAt: new Date(Date.now() + 600_000).toISOString() },
      'cmd-1'
    );
    const untracked = await service.create({ nodeId, containerName: 'app', type: 'start' });
    await service.update(untracked.id, { status: 'running' });

    // The next Gateway process starts.
    const restarted = new DockerTaskService(db);
    expect(await restarted.detachActiveTasksOnStartup()).toEqual({ detached: 1, failed: 1 });

    const kept = await restarted.get(pull.id);
    expect(kept).toMatchObject({ status: 'running', progress: DETACHED_TASK_PROGRESS });
    expect(kept.detachedAt).toBeInstanceOf(Date);
    // The API does not show what Gateway keeps to settle the task.
    expect(kept).not.toHaveProperty('tracking');
    expect(kept).not.toHaveProperty('commandId');
    expect(await restarted.get(untracked.id)).toMatchObject({
      status: 'failed',
      error: 'Task tracking interrupted by backend restart',
    });

    // A daemon update dispatched now waits for the pull.
    expect(await listNodeLongTasks(db, nodeId)).toEqual([
      { kind: 'docker_task', id: pull.id, label: 'Image pull pytorch/pytorch:2.5.1' },
    ]);

    const detached = await restarted.listDetached(nodeId);
    expect(detached.map((task) => [task.id, task.commandId, task.tracking?.kind])).toEqual([
      [pull.id, 'cmd-1', 'pull'],
    ]);

    expect(await restarted.settle(pull.id, { status: 'succeeded', progress: 'Pulled pytorch/pytorch:2.5.1' })).toBe(
      true
    );
    expect(await restarted.get(pull.id)).toMatchObject({ status: 'succeeded', detachedAt: null });
    // Settled once: a second outcome does not overwrite it.
    expect(await restarted.settle(pull.id, { status: 'failed', error: 'late' })).toBe(false);
    expect(await listNodeLongTasks(db, nodeId)).toEqual([]);
    expect(await restarted.listDetached(nodeId)).toEqual([]);
  });

  it('detaches a tracked task whose node dropped, and fails one without tracking', async () => {
    const service = new DockerTaskService(db);
    const stop = await service.create({ nodeId, containerName: 'app', type: 'stop' });
    await service.update(stop.id, { status: 'running' });
    await service.track(stop.id, {
      kind: 'state',
      containerId: 'c1',
      expect: 'exited',
      progress: 'Container stopped',
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(await service.detach(stop.id, 'Docker node disconnected during container operation')).toBe(true);
    expect(await service.get(stop.id)).toMatchObject({ status: 'running' });

    const other = await service.create({ nodeId, containerName: 'app', type: 'kill' });
    await service.update(other.id, { status: 'running' });
    expect(await service.detach(other.id, 'Docker node disconnected during container operation')).toBe(false);
    expect(await service.get(other.id)).toMatchObject({
      status: 'failed',
      error: 'Docker node disconnected during container operation',
    });

    // A second restart keeps the time Gateway first lost track of it.
    const firstDetachedAt = (await service.get(stop.id)).detachedAt;
    await new DockerTaskService(db).detachActiveTasksOnStartup();
    expect((await service.get(stop.id)).detachedAt).toEqual(firstDetachedAt);
  });
});

const SECRET = 's3cret-value';
const NEW_SECRET = 'n3w-secret-value';
const STORED = { APP_MODE: 'mode-one', API_KEY: SECRET };
const OLD_ENV = ['APP_MODE=mode-one', `API_KEY=${SECRET}`];
const NEW_IMAGE_ENV = ['APP_MODE=mode-two', `API_KEY=${SECRET}`];

const replaceTracking: schema.DockerTaskTracking = {
  kind: 'replace',
  containerName: 'api',
  oldContainerId: 'c1',
  expectedState: 'running',
  progress: 'Container updated',
  deadlineAt: new Date(Date.now() + 60_000).toISOString(),
};

const sealed = {
  containerName: 'api',
  restoreEnvAfterFailedUpdate: true,
  sealed: { encryptedKey: 'a', encryptedDek: 'b' },
} satisfies schema.DockerTaskFollowUps;

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): an update's or recreate's env follow-ups are kept sealed with its task
 * until they ran once, and still run after a Gateway restart once the node settled the task.
 */
describe.skipIf(!url)('Env follow-ups of Docker tasks across a Gateway restart', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let nodeId = '';
  const crypto = new CryptoService(randomBytes(32).toString('hex'));
  const followUpsText = async (taskId: string) =>
    (await pool.query('select follow_ups::text as kept from docker_tasks where id = $1', [taskId])).rows[0].kept as
      | string
      | null;

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'docker_task_follow_ups');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema }) as unknown as DrizzleClient;
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    const suffix = randomUUID().slice(0, 8);
    nodeId = (await pool.query(`insert into nodes (hostname, slug) values ($1, $1) returning id`, [`node-${suffix}`]))
      .rows[0].id;
    // Only the watches' polling is faked: they must not run past the restart, PostgreSQL's own timers must.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  async function runAcrossRestart(
    run: (ctx: Parameters<typeof updateContainer>[0]) => Promise<{ taskId?: string }>,
    outcome: 'succeeded' | 'failed'
  ) {
    const environment = new DockerEnvironmentService(db, crypto);
    await environment.replace(nodeId, 'api', STORED);
    const node = fakeDockerNode(OLD_ENV, NEW_IMAGE_ENV);
    const first = opfieldProcess(node, new DockerTaskService(db), environment, nodeId);
    const { taskId } = await run(first.ctx);
    // The watch records the task's tracking right after it starts.
    for (let attempt = 0; attempt < 100; attempt++) {
      const row = (await pool.query('select tracking is not null as tracked from docker_tasks where id = $1', [taskId]))
        .rows[0];
      if (row?.tracked) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // Gateway restarts: the watch is gone; the next process keeps the task, and what it owes, sealed.
    vi.clearAllTimers();
    const restarted = new DockerTaskService(db);
    await restarted.detachActiveTasksOnStartup();
    const kept = await followUpsText(taskId!);
    expect(kept).not.toBeNull();
    for (const plain of [SECRET, NEW_SECRET, 'API_KEY', 'APP_MODE', 'mode-one']) expect(kept).not.toContain(plain);
    // The API does not show it.
    expect(await restarted.get(taskId!)).not.toHaveProperty('followUps');

    node.finish(outcome);
    const next = opfieldProcess(node, restarted, new DockerEnvironmentService(db, crypto), nodeId);
    await new DockerTaskReconciler(
      () => next.reconcileContext,
      () => true
    ).sweep();
    expect(await followUpsText(taskId!)).toBeNull();
    return { task: await restarted.get(taskId!), stored: await environment.getDecryptedMap(nodeId, 'api') };
  }

  it('reconciles the stored env after an image update the node finished after the restart', async () => {
    const { task, stored } = await runAcrossRestart(
      (ctx) => updateContainer(ctx, nodeId, 'api', { tag: '2' }, 'user-1'),
      'succeeded'
    );
    expect(task).toMatchObject({ status: 'succeeded' });
    expect(stored).toEqual({ APP_MODE: 'mode-two', API_KEY: SECRET });
  });

  it('restores the stored env after an env update the node failed after the restart', async () => {
    const { task, stored } = await runAcrossRestart(
      (ctx) => updateContainerEnv(ctx, nodeId, 'api', { API_KEY: NEW_SECRET }, undefined, 'user-1'),
      'failed'
    );
    expect(task).toMatchObject({ status: 'failed', error: DAEMON_ERROR });
    expect(stored).toEqual(STORED);
  });

  it.each([
    ['the node got the update and failed it', 'lost', 'failed', 'pull access denied for app:2'],
    [
      'the update never reached the node',
      'never-sent',
      undefined,
      'The update did not run on the node: its daemon restarted or never received it',
    ],
  ] as const)('puts back the stored env when Gateway restarted before the daemon answered and %s', async (_case, answer, outcome, error) => {
    const environment = new DockerEnvironmentService(db, crypto);
    await environment.replace(nodeId, 'api', STORED);
    const node = fakeDockerNode(OLD_ENV, NEW_IMAGE_ENV, { answer });
    const first = opfieldProcess(node, new DockerTaskService(db), environment, nodeId);
    void updateContainerEnv(first.ctx, nodeId, 'api', { API_KEY: NEW_SECRET }, undefined, 'user-1');
    // Gateway dies while it waits for the daemon's answer, after it saved the env.
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await environment.getDecryptedMap(nodeId, 'api')).API_KEY === NEW_SECRET) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const taskId = (await pool.query('select id from docker_tasks where node_id = $1', [nodeId])).rows[0].id as string;

    const restarted = new DockerTaskService(db);
    await restarted.detachActiveTasksOnStartup();
    const kept = (
      await pool.query('select command_id, tracking, follow_ups::text as sealed from docker_tasks where id = $1', [
        taskId,
      ])
    ).rows[0];
    expect(kept.command_id).toBeTruthy();
    expect(kept.tracking).toMatchObject({ kind: 'replace', beforeAnswer: true });
    for (const plain of [SECRET, NEW_SECRET, 'API_KEY', 'APP_MODE', 'mode-one'])
      expect(kept.sealed).not.toContain(plain);

    if (outcome) node.finish(outcome);
    const next = opfieldProcess(node, restarted, new DockerEnvironmentService(db, crypto), nodeId);
    await new DockerTaskReconciler(
      () => next.reconcileContext,
      () => true
    ).sweep();
    expect(await restarted.get(taskId)).toMatchObject({ status: 'failed', error });
    expect(await followUpsText(taskId)).toBeNull();
    expect(await environment.getDecryptedMap(nodeId, 'api')).toEqual(STORED);
  });

  it('gives what a task owes to one taker only, and nothing once the task ended', async () => {
    const service = new DockerTaskService(db);
    const task = await service.create({ nodeId, containerName: 'api', type: 'update' });
    await service.track(task.id, replaceTracking, 'cmd-1', sealed);
    const takers = await Promise.all([1, 2, 3, 4].map(() => new DockerTaskService(db).takeFollowUps(task.id)));
    expect(takers.filter((taken) => taken !== null)).toEqual([sealed]);
    expect(await service.takeFollowUps(task.id)).toBeNull();

    await service.update(task.id, { status: 'succeeded', completedAt: new Date() });
    expect(await service.takeFollowUps(task.id)).toBeNull();
    expect(await followUpsText(task.id)).toBeNull();
  });

  it('drops what a task owes once the task ends, however it ends', async () => {
    const service = new DockerTaskService(db);
    const owing = async (type: string, tracked = true) => {
      const task = await service.create({ nodeId, containerName: 'api', type });
      if (tracked) await service.track(task.id, replaceTracking, undefined, sealed);
      else await pool.query('update docker_tasks set follow_ups = $2 where id = $1', [task.id, sealed]);
      return task.id;
    };

    const settled = await owing('update');
    await service.settle(settled, { status: 'failed', error: 'Timed out' });
    const failed = await owing('update');
    await service.update(failed, { status: 'failed', error: 'Timed out', completedAt: new Date() });
    const cancelled = await owing('recreate');
    await service.forceCancel(cancelled);
    const untracked = await owing('recreate', false);
    const stale = await owing('update');
    await pool.query(`update docker_tasks set created_at = now() - interval '2 hours' where id = $1`, [stale]);
    const kept = await owing('update');

    expect(await new DockerTaskService(db).detachActiveTasksOnStartup()).toMatchObject({ failed: 1 });
    await service.markStaleActiveTasksFailed();
    for (const id of [settled, failed, cancelled, untracked, stale]) expect(await followUpsText(id)).toBeNull();
    // The task still under way keeps it.
    expect(await followUpsText(kept)).not.toBeNull();

    // A row a release that does not know the column ended keeps it; the next sweep drops it.
    await pool.query(`update docker_tasks set status = 'failed', completed_at = now() where id = $1`, [kept]);
    expect(await followUpsText(kept)).not.toBeNull();
    expect(await service.expireFollowUps()).toBe(1);
    expect(await followUpsText(kept)).toBeNull();
  });
});

/** docker_tasks as a release before migration 0231 has it (v2.11.4-rc.6, migrations through 0230). */
const previousReleaseDockerTasks = pgTable('docker_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  nodeId: uuid('node_id').notNull(),
  containerId: text('container_id'),
  containerName: text('container_name'),
  type: text('type').notNull(),
  status: text('status').notNull().default('pending'),
  progress: text('progress'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): a rollback whose database restore did not happen starts the previous
 * release on the migrated schema. It must still create, read, end and clean up its tasks there, and what this release
 * kept on a task the previous one ended is dropped once this release runs again.
 */
describe.skipIf(!url)('migration 0232 and a rollback to the release before it', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'docker_task_follow_ups_rollback');
    pool = database.pool;
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('keeps the previous release working on the migrated docker_tasks', async () => {
    await migrateDatabase(pool, '0230_database_link_connector_uncapped');
    const previous = drizzle(pool);
    const nodeId = (await pool.query(`insert into nodes (hostname, slug) values ('n1', 'n1') returning id`)).rows[0].id;
    const [before] = await previous
      .insert(previousReleaseDockerTasks)
      .values({ nodeId, containerName: 'api', type: 'update', status: 'running' })
      .returning();

    await migrateDatabase(pool);
    const columns = (
      await pool.query(
        `select is_nullable, column_default from information_schema.columns
          where table_name = 'docker_tasks' and column_name = 'follow_ups'`
      )
    ).rows;
    expect(columns).toEqual([{ is_nullable: 'YES', column_default: null }]);

    const db = drizzle(pool, { schema }) as unknown as DrizzleClient;
    const current = new DockerTaskService(db);
    expect((await current.get(before!.id)).status).toBe('running');
    await current.track(before!.id, replaceTracking, 'cmd-1', sealed);

    // The previous release starts on the migrated schema (rollback): it ends the task and creates and cleans up others.
    await previous
      .update(previousReleaseDockerTasks)
      .set({ status: 'failed', error: 'Task tracking interrupted by backend restart', completedAt: new Date() })
      .where(eq(previousReleaseDockerTasks.id, before!.id));
    const [created] = await previous
      .insert(previousReleaseDockerTasks)
      .values({ nodeId, containerName: 'api', type: 'recreate' })
      .returning();
    expect(await previous.select().from(previousReleaseDockerTasks)).toHaveLength(2);
    await previous.delete(previousReleaseDockerTasks).where(eq(previousReleaseDockerTasks.id, created!.id));

    // This release again: the next startup drops what the ended task kept.
    expect(
      (await pool.query('select follow_ups from docker_tasks where id = $1', [before!.id])).rows[0].follow_ups
    ).not.toBeNull();
    await new DockerTaskService(db).detachActiveTasksOnStartup();
    expect(
      (await pool.query('select follow_ups from docker_tasks where id = $1', [before!.id])).rows[0].follow_ups
    ).toBeNull();
    expect(await current.get(before!.id)).toMatchObject({ status: 'failed' });
  }, 60_000);
});
