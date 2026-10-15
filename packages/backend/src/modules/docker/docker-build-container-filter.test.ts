import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { containerBuildSourceBindingId } from './docker-build-container-filter.js';

const NODE = '44444444-4444-4444-8444-444444444444';

function db(rows: Array<{ id: string }>) {
  const chain = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => rows),
  };
  return chain;
}

describe('build list filtered by container name', () => {
  it('matches the Git source of the container, a container its first build has not created included', async () => {
    // The binding is found by its target name alone: no Docker container needs to exist.
    await expect(containerBuildSourceBindingId(NODE, 'rc1-vulna', db([{ id: 'source-1' }]) as never)).resolves.toBe(
      'source-1'
    );
    await expect(containerBuildSourceBindingId(NODE, 'other', db([]) as never)).resolves.toBeNull();
  });

  it('needs the node, since container names are per node', async () => {
    await expect(containerBuildSourceBindingId(undefined, 'rc1-vulna', db([]) as never)).rejects.toMatchObject({
      statusCode: 400,
      code: 'NODE_ID_REQUIRED',
    });
  });
});
