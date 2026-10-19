import { describe, expect, it, vi } from 'vitest';
import {
  dockerMigrations,
  pageDeploymentReplicas,
  pageIngressMigrations,
  pageProjects,
  pageWildcardProfiles,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { mapNodeForeignKeyViolation, NODE_REFERENCE_BLOCKERS, prepareNodeRemoval } from './node-removal-references.js';

function fakeTx(countsByTable: Map<unknown, number> = new Map()) {
  const deleted: unknown[] = [];
  const updated: unknown[] = [];
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(async () => [{ count: countsByTable.get(table) ?? 0 }]),
      })),
    })),
    delete: vi.fn((table: unknown) => {
      deleted.push(table);
      return { where: vi.fn(async () => undefined) };
    }),
    update: vi.fn((table: unknown) => {
      updated.push(table);
      return { set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) };
    }),
  };
  return { tx: tx as never, deleted, updated };
}

describe('prepareNodeRemoval', () => {
  it('drops the leftover Pages deployment replicas and finished migration history of the node', async () => {
    const { tx, deleted, updated } = fakeTx();

    await prepareNodeRemoval(tx, 'node-1');

    expect(deleted).toContain(pageDeploymentReplicas);
    expect(deleted).toContain(pageIngressMigrations);
    expect(deleted).toContain(dockerMigrations);
    expect(updated).toEqual([pageProjects, pageProjects]);
  });

  it('refuses with a typed error and changes nothing while a Pages project still lives on the node', async () => {
    const { tx, deleted, updated } = fakeTx(new Map([[pageProjects, 2]]));

    await expect(prepareNodeRemoval(tx, 'node-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'NODE_HAS_PAGE_PROJECTS',
    });
    expect(deleted).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  it('refuses with a typed error while the node serves the Pages wildcard profile', async () => {
    const { tx } = fakeTx(new Map([[pageWildcardProfiles, 1]]));

    await expect(prepareNodeRemoval(tx, 'node-1')).rejects.toMatchObject({ code: 'NODE_HAS_PAGE_WILDCARD_PROFILE' });
  });

  it('gives every blocker a readable message, never a SQL error', () => {
    for (const blocker of NODE_REFERENCE_BLOCKERS) {
      expect(blocker.code).toMatch(/^NODE_HAS_/);
      expect(blocker.message(3)).not.toMatch(/Failed query|violates|constraint/i);
    }
  });
});

describe('mapNodeForeignKeyViolation', () => {
  it('turns a wrapped foreign key violation into a readable 409', () => {
    const wrapped = Object.assign(new Error('Failed query: delete from "nodes" where "nodes"."id" = $1'), {
      cause: Object.assign(new Error('violates foreign key constraint'), {
        code: '23503',
        table: 'page_deployment_replicas',
      }),
    });

    const mapped = mapNodeForeignKeyViolation(wrapped);

    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped).toMatchObject({ statusCode: 409, code: 'NODE_IN_USE' });
    expect((mapped as AppError).message).toContain('page deployment replicas');
    expect((mapped as AppError).message).not.toContain('Failed query');
  });

  it('leaves other errors unchanged', () => {
    const error = new Error('connection lost');
    expect(mapNodeForeignKeyViolation(error)).toBe(error);
  });
});
