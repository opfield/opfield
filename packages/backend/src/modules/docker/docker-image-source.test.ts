import { describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import {
  parseInternalImageReference,
  resolveDockerImageOrigins,
  withDockerImageSources,
} from './docker-image-source.js';
import { LEGACY_REGISTRY_NAMESPACE } from '@/lib/legacy-compat.js';

const DIGEST = `sha256:${'b'.repeat(64)}`;
const COPY_DIGEST = `sha256:${'c'.repeat(64)}`;
const BINDING = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const BUILT = `127.0.0.1:5443/${LEGACY_REGISTRY_NAMESPACE}/builds/${BINDING}@${DIGEST}`;

/** A query builder that answers each `select()` with the next prepared row set, whatever the chain. */
function fakeDb(results: unknown[][]): DrizzleClient {
  const queue = [...results];
  const chain = (rows: unknown[]): any =>
    new Proxy(
      {},
      {
        get: (_target, property) =>
          property === 'then' ? (resolve: (value: unknown) => void) => resolve(rows) : () => chain(rows),
      }
    );
  return { select: () => chain(queue.shift() ?? []) } as unknown as DrizzleClient;
}

describe('parseInternalImageReference', () => {
  it('splits an internal reference into repository and digest', () => {
    expect(parseInternalImageReference(BUILT)).toEqual({ repository: `${LEGACY_REGISTRY_NAMESPACE}/builds/${BINDING}`, digest: DIGEST });
    expect(parseInternalImageReference(`127.0.0.1:5443/${LEGACY_REGISTRY_NAMESPACE}/availability/abc:image`)).toEqual({
      repository: `${LEGACY_REGISTRY_NAMESPACE}/availability/abc`,
      digest: null,
    });
  });

  it('ignores any other image', () => {
    expect(parseInternalImageReference('nginx:1.27')).toBeNull();
    expect(parseInternalImageReference(`ghcr.io/acme/web@${DIGEST}`)).toBeNull();
    expect(parseInternalImageReference(null)).toBeNull();
  });
});

describe('resolveDockerImageOrigins', () => {
  it('names the Git repository, branch and commit of a built image', async () => {
    const db = fakeDb([
      [
        {
          registryRepository: `${LEGACY_REGISTRY_NAMESPACE}/builds/${BINDING}`,
          digest: DIGEST,
          sourceImageReference: null,
          repositoryFullPath: 'acme/shop-api',
          ref: 'refs/heads/main',
          commitSha: 'abcdef0123456789',
        },
      ],
    ]);
    const origins = await resolveDockerImageOrigins([BUILT, 'nginx:1.27'], db);
    expect(origins.get(BUILT)).toEqual({
      source: { repositoryFullPath: 'acme/shop-api', branch: 'main', commitSha: 'abcdef0123456789' },
    });
    expect(origins.has('nginx:1.27')).toBe(false);
  });

  it('follows a promotion copy to the build it copied', async () => {
    const copy = `127.0.0.1:5443/${LEGACY_REGISTRY_NAMESPACE}/promotion/0011223344556677/1700000000@${COPY_DIGEST}`;
    const db = fakeDb([
      [
        {
          registryRepository: `${LEGACY_REGISTRY_NAMESPACE}/promotion/0011223344556677/1700000000`,
          digest: COPY_DIGEST,
          sourceImageReference: BUILT,
          repositoryFullPath: null,
          ref: null,
          commitSha: null,
        },
      ],
      [
        {
          registryRepository: `${LEGACY_REGISTRY_NAMESPACE}/builds/${BINDING}`,
          digest: DIGEST,
          sourceImageReference: null,
          repositoryFullPath: 'acme/shop-api',
          ref: 'main',
          commitSha: 'abcdef0123456789',
        },
      ],
    ]);
    const origins = await resolveDockerImageOrigins([copy], db);
    expect(origins.get(copy)).toEqual({
      source: { repositoryFullPath: 'acme/shop-api', branch: 'main', commitSha: 'abcdef0123456789' },
    });
  });

  it('answers an Availability mirror of a public image with that image', async () => {
    const mirror = `127.0.0.1:5443/${LEGACY_REGISTRY_NAMESPACE}/availability/policy-1:image`;
    const db = fakeDb([
      [
        {
          registryRepository: `${LEGACY_REGISTRY_NAMESPACE}/availability/policy-1`,
          digest: COPY_DIGEST,
          sourceImageReference: 'ghcr.io/acme/web:1.4.2',
          repositoryFullPath: null,
          ref: null,
          commitSha: null,
        },
      ],
    ]);
    expect((await resolveDockerImageOrigins([mirror], db)).get(mirror)).toEqual({ image: 'ghcr.io/acme/web:1.4.2' });
  });

  it('falls back to the source binding when the build artifact is gone', async () => {
    const db = fakeDb([[], [{ id: BINDING, repositoryFullPath: 'acme/shop-api', branch: 'main' }]]);
    expect((await resolveDockerImageOrigins([BUILT], db)).get(BUILT)).toEqual({
      source: { repositoryFullPath: 'acme/shop-api', branch: 'main', commitSha: null },
    });
  });
});

describe('withDockerImageSources', () => {
  it('keeps the source a row already carries and never fails the list without a database', async () => {
    const pending = {
      name: 'api',
      image: '',
      source: { repositoryFullPath: 'acme/api', branch: null, commitSha: null },
    };
    const plain = { name: 'web', image: 'nginx:1.27' };
    const rows = await withDockerImageSources<Record<string, any>>([pending, plain]);
    expect(rows[0]).toMatchObject({ source: pending.source, sourceImage: null });
    expect(rows[1]).toMatchObject({ source: null, sourceImage: null });
  });
});
