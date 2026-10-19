import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { NodesService } from './nodes.service.js';

// Opt-in, disposable local PostgreSQL only (same URL as the relay removal suite). The suite applies the repository
// migrations itself and rolls its fixture back.
const databaseUrl = process.env.RELAY_REMOVAL_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('node removal with PostgreSQL foreign keys', () => {
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Local disposable test database required');
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await migrateDatabase(pool);
    } finally {
      await pool.end();
    }
  }, 120_000);

  async function inRollbackTransaction(run: (tx: any) => Promise<void>) {
    const client = new pg.Pool({ connectionString: databaseUrl });
    const db = drizzle(client, { schema });
    const rollback = new Error('rollback test fixture');
    try {
      await expect(
        db.transaction(async (tx) => {
          await run(tx);
          throw rollback;
        })
      ).rejects.toBe(rollback);
    } finally {
      await client.end();
    }
  }

  async function fixture(tx: any) {
    const [group] = await tx
      .insert(schema.permissionGroups)
      .values({ name: `test-${randomUUID()}`, scopes: [] })
      .returning();
    const [user] = await tx
      .insert(schema.users)
      .values({ oidcSubject: randomUUID(), email: `${randomUUID()}@test.local`, name: 'Test', groupId: group.id })
      .returning();
    const oldNodeId = randomUUID();
    const newNodeId = randomUUID();
    await tx.insert(schema.nodes).values([
      { id: oldNodeId, type: 'nginx', hostname: 'old', slug: oldNodeId, status: 'offline' },
      { id: newNodeId, type: 'nginx', hostname: 'new', slug: newNodeId, status: 'online' },
    ]);
    return { user, oldNodeId, newNodeId };
  }

  function nodesService(tx: unknown) {
    return new NodesService(
      tx as never,
      { log: vi.fn() } as never,
      { getNode: vi.fn() } as never,
      {} as never,
      {} as never
    );
  }

  it('removes a node whose Pages replicas were revoked by an ingress migration', async () => {
    await inRollbackTransaction(async (tx) => {
      const { user, oldNodeId, newNodeId } = await fixture(tx);
      const [project] = await tx
        .insert(schema.pageProjects)
        .values({
          name: 'site',
          slug: `site-${randomUUID().slice(0, 8)}`,
          previewHash: randomUUID().slice(0, 12),
          createdById: user.id,
          nodeId: newNodeId,
        })
        .returning();
      const [deployment] = await tx
        .insert(schema.pageDeployments)
        .values({ projectId: project.id, sequence: 1, publicSlug: randomUUID().slice(0, 16) })
        .returning();
      await tx.insert(schema.pageDeploymentReplicas).values(
        ['route', 'preview'].map((purpose) => ({
          deploymentId: deployment.id,
          nodeId: oldNodeId,
          purpose: purpose as 'route',
          referenceId: randomUUID(),
          status: 'revoked' as const,
        }))
      );
      await tx.insert(schema.pageIngressMigrations).values({
        subjectType: 'route',
        subjectId: randomUUID(),
        sourceNodeId: oldNodeId,
        targetNodeId: newNodeId,
        status: 'complete',
      });

      await nodesService(tx).remove(oldNodeId, user.id);

      expect(await tx.select().from(schema.nodes).where(eq(schema.nodes.id, oldNodeId))).toHaveLength(0);
      expect(
        await tx.select().from(schema.pageDeploymentReplicas).where(eq(schema.pageDeploymentReplicas.nodeId, oldNodeId))
      ).toHaveLength(0);
      expect(await tx.select().from(schema.nodes).where(eq(schema.nodes.id, newNodeId))).toHaveLength(1);
    });
  });

  it('refuses with a typed error while a Pages project lives on the node', async () => {
    await inRollbackTransaction(async (tx) => {
      const { user, oldNodeId } = await fixture(tx);
      await tx.insert(schema.pageProjects).values({
        name: 'site',
        slug: `site-${randomUUID().slice(0, 8)}`,
        previewHash: randomUUID().slice(0, 12),
        createdById: user.id,
        nodeId: oldNodeId,
      });

      await expect(nodesService(tx).remove(oldNodeId, user.id)).rejects.toMatchObject({
        statusCode: 409,
        code: 'NODE_HAS_PAGE_PROJECTS',
      });
    });
  });

  it('keeps finished backup runs as history without an executor', async () => {
    await inRollbackTransaction(async (tx) => {
      const { user, oldNodeId } = await fixture(tx);
      const [connection] = await tx
        .insert(schema.objectStorageConnections)
        .values({
          name: `s3-${randomUUID()}`,
          slug: `s3-${randomUUID().slice(0, 8)}`,
          provider: 'aws',
          createdById: user.id,
          encryptedConfig: 'x',
        })
        .returning();
      const [run] = await tx
        .insert(schema.backupRuns)
        .values({
          destinationId: connection.id,
          destinationBucket: 'b',
          destinationPrefix: 'p',
          timezone: 'UTC',
          executorNodeId: oldNodeId,
          direction: 'backup',
          engine: 'postgres',
          status: 'completed',
          requestFingerprint: 'x',
        })
        .returning();

      await nodesService(tx).remove(oldNodeId, user.id);

      const [kept] = await tx.select().from(schema.backupRuns).where(eq(schema.backupRuns.id, run.id));
      expect(kept.executorNodeId).toBeNull();
    });
  });
});
