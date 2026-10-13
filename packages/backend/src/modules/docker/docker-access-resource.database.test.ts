import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { DockerAccessResourceService } from './docker-access-resource.service.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;
const runtime = (digit: string) => digit.repeat(64);

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): a container keeps its access identity, and the grants on it, across a
 * Opfield recreate whose task ended before anyone saw the replacement (no transition, no watcher), and a lagging
 * snapshot that still lists the replaced runtime cannot take the identity back. A container nobody recreated under
 * the same name still gets a new identity without the previous one's grants.
 */
describe.skipIf(!url)('container access identity across Opfield recreates', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let nodeId = '';
  let groupId = '';
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  const groupScopes = async () =>
    (await q('select scopes from permission_groups where id = $1', [groupId])).rows[0].scopes as string[];
  const identityRuntime = async (id: string) =>
    (await q('select runtime_id from docker_access_resources where id = $1', [id])).rows[0]?.runtime_id as
      | string
      | undefined;

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'docker_access_identity');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    const suffix = randomUUID().slice(0, 8);
    nodeId = (await q(`insert into nodes (hostname, slug) values ($1, $1) returning id`, [`node-${suffix}`])).rows[0]
      .id;
  });

  async function grantedContainer(service: DockerAccessResourceService) {
    const identity = await service.ensureContainer(nodeId, 'app', runtime('a'));
    groupId = (
      await q(`insert into permission_groups (name, scopes) values ($1, $2) returning id`, [
        `grants-${randomUUID().slice(0, 8)}`,
        JSON.stringify([`docker:containers:view:${nodeId}/${identity}`]),
      ])
    ).rows[0].id;
    return identity;
  }

  async function recreateTask(containerName: string, replacedRuntime: string, type = 'update') {
    await q(
      `insert into docker_tasks (node_id, container_id, container_name, type, status, completed_at)
       values ($1, $2, $3, $4, 'succeeded', now())`,
      [nodeId, replacedRuntime, containerName, type]
    );
  }

  it('keeps the identity when the recreate ended before its replacement was seen', async () => {
    const service = new DockerAccessResourceService(db);
    const identity = await grantedContainer(service);
    await recreateTask('app', runtime('a'));

    // The operation's transition is gone: a snapshot shows the replacement without the preserve flag.
    expect(await service.ensureContainer(nodeId, 'app', runtime('b'))).toBe(identity);
    expect(await identityRuntime(identity)).toBe(runtime('b'));
    // A lagging snapshot still lists the replaced runtime: it cannot take the identity back.
    expect(await service.ensureContainer(nodeId, 'app', runtime('a'))).toBe(identity);
    expect(await identityRuntime(identity)).toBe(runtime('b'));
    expect(service.cachedContainerResourceId(nodeId, { runtimeId: runtime('b') })).toBe(identity);
    // A second recreate (an env change after an image update) chains the same way.
    await recreateTask('app', runtime('b'), 'recreate');
    expect(await service.ensureContainer(nodeId, 'app', runtime('c'))).toBe(identity);
    expect(await service.ensureContainer(nodeId, 'app', runtime('b'))).toBe(identity);
    expect(await identityRuntime(identity)).toBe(runtime('c'));

    expect(await groupScopes()).toEqual([`docker:containers:view:${nodeId}/${identity}`]);
  });

  it('gives a container nobody recreated under the name a new identity without the grants', async () => {
    const service = new DockerAccessResourceService(db);
    const identity = await grantedContainer(service);
    // A recreate of another container does not vouch for this one.
    await recreateTask('other', runtime('a'));

    const next = await service.ensureContainer(nodeId, 'app', runtime('d'));

    expect(next).not.toBe(identity);
    expect(await identityRuntime(next)).toBe(runtime('d'));
    expect(await groupScopes()).toEqual([]);
  });

  it('does not let an old recreate vouch for a later replacement', async () => {
    const service = new DockerAccessResourceService(db);
    const identity = await grantedContainer(service);
    await q(
      `insert into docker_tasks (node_id, container_id, container_name, type, status, created_at, completed_at)
       values ($1, $2, 'app', 'update', 'succeeded', now() - interval '2 hours', now() - interval '2 hours')`,
      [nodeId, runtime('a')]
    );

    expect(await service.ensureContainer(nodeId, 'app', runtime('e'))).not.toBe(identity);
    expect(await groupScopes()).toEqual([]);
  });
});
