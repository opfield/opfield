import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { opfieldKeptVolumeNames } from './docker-kept-volumes.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;

const ADOPTED = 'a'.repeat(64);
const IN_DEPLOYMENT = 'b'.repeat(64);
const IN_SLOT = 'c'.repeat(64);
const IN_ACTIVE_COMPOSE = 'd'.repeat(64);
const IN_OLD_COMPOSE = 'e'.repeat(64);
const ADOPTED_ELSEWHERE = 'f'.repeat(64);
const DIGEST = '9'.repeat(64);

describe.skipIf(!url)('Volumes removal keeps, on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let db: DrizzleClient;

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'docker_kept_volumes');
    await migrateDatabase(database.pool);
    db = drizzle(database.pool, { schema }) as unknown as DrizzleClient;
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('keeps the volumes the user manages on the node and every one an Opfield config names', async () => {
    const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
    const node = async (name: string) =>
      (await q(`insert into nodes (type, hostname, slug) values ('docker', $1, $1) returning id`, [name])).rows[0]
        .id as string;
    const nodeId = await node('kept-a');
    const otherNodeId = await node('kept-b');
    await q(
      `insert into docker_managed_volumes (node_id, volume_name, origin) values ($1, $2, 'adopted'), ($1, 'pgdata', 'created'), ($3, $4, 'adopted')`,
      [nodeId, ADOPTED, otherNodeId, ADOPTED_ELSEWHERE]
    );
    const deploymentId = (
      await q(
        `insert into docker_deployments (node_id, name, desired_config, router_name, network_name, health_config)
         values ($1, 'web', $2, 'web-router', 'web-net', '{}') returning id`,
        [otherNodeId, JSON.stringify({ image: `app@sha256:${DIGEST}`, mounts: [`${IN_DEPLOYMENT}:/data`] })]
      )
    ).rows[0].id;
    await q(
      `insert into docker_deployment_slots (deployment_id, slot, container_name, desired_config) values ($1, 'green', 'web-green', $2)`,
      [deploymentId, JSON.stringify({ volumes: [{ source: IN_SLOT, target: '/cache' }] })]
    );
    const projectId = (
      await q(`insert into docker_compose_projects (node_id, name) values ($1, 'stack') returning id`, [nodeId])
    ).rows[0].id;
    const revision = async (number: number, volume: string) =>
      (
        await q(
          `insert into docker_compose_revisions (project_id, revision_number, source_yaml, original_yaml, normalized_model, config_digest)
           values ($1, $2, $3, $3, '{}', $4) returning id`,
          [projectId, number, `volumes:\n  data:\n    external: true\n    name: ${volume}\n`, `digest-${number}`]
        )
      ).rows[0].id;
    await revision(1, IN_OLD_COMPOSE);
    const active = await revision(2, IN_ACTIVE_COMPOSE);
    await q(`update docker_compose_projects set active_revision_id = $2 where id = $1`, [projectId, active]);

    const kept = await opfieldKeptVolumeNames(db, nodeId);

    expect([...kept].sort()).toEqual([ADOPTED, IN_DEPLOYMENT, IN_SLOT, IN_ACTIVE_COMPOSE, 'pgdata'].sort());
  });
});
