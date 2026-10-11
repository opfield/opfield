import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { AppMember } from './app-members.service.js';
import {
  AppPromotionService,
  containerRolloutError,
  diffDocuments,
  displayImage,
  parseImageReference,
  pickRepoDigest,
  type RunningImage,
} from './app-promotion.service.js';
import { pairingName, pairMembers } from './app-promotion-pairing.js';

const staging = { slug: 'staging', name: 'staging' };
const live = { slug: 'live', name: 'live' };

function member(type: AppMember['type'], name: string, environmentId: string, nodeId = 'n1'): AppMember {
  return { type, id: type === 'container' ? name : `${type}-${name}`, name, environmentId, nodeIds: [nodeId], nodeId };
}

describe('Promotion pairing', () => {
  it.each([
    ['shop-help-staging', staging, 'shop-help'],
    ['shop-help', staging, 'shop-help'],
    ['Shop-API-Staging', staging, 'shop-api'],
    ['staging', staging, 'staging'],
    ['shop-live', live, 'shop'],
  ])('%s in %o pairs as %s', (name, env, expected) => {
    expect(pairingName(name, env)).toBe(expected);
  });

  it('pairs by name or name without the environment suffix and lists the rest', () => {
    const source = [
      member('container', 'shop-api-staging', 's'),
      member('deployment', 'shop-web', 's'),
      member('pages', 'shop-help-staging', 's'),
      member('compose', 'search', 's'),
      member('container', 'debug-tools', 's'),
      member('database', 'orders', 's'),
    ];
    const target = [
      member('container', 'shop-api', 't', 'n2'),
      member('deployment', 'shop-web-live', 't'),
      member('pages', 'shop-help', 't'),
      member('deployment', 'search', 't'),
      member('database', 'orders', 't'),
    ];
    const { pairs, unpaired } = pairMembers(source, target, staging, live);
    expect(pairs.map((pair) => [pair.type, pair.source.name, pair.target.name])).toEqual([
      ['container', 'shop-api-staging', 'shop-api'],
      ['deployment', 'shop-web', 'shop-web-live'],
      ['pages', 'shop-help-staging', 'shop-help'],
    ]);
    expect(pairs[0]!.pairKey).toBe('container:shop-api-staging->n2/shop-api');
    expect(unpaired).toEqual([
      expect.objectContaining({ name: 'search', reason: 'type_differs' }),
      expect.objectContaining({ name: 'debug-tools', reason: 'not_in_target' }),
    ]);
  });

  it('pairs with neither of two candidates for one name', () => {
    const { pairs, unpaired } = pairMembers(
      [member('container', 'api-staging', 's')],
      [member('container', 'api', 't', 'n1'), member('container', 'api-live', 't', 'n2')],
      staging,
      live
    );
    expect(pairs).toEqual([]);
    expect(unpaired).toEqual([expect.objectContaining({ reason: 'ambiguous' })]);
  });
});

describe('What runs', () => {
  it('splits references into repository, tag and digest', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(parseImageReference(`registry.example.com:5000/shop/web:3.5.0@${digest}`)).toEqual({
      repository: 'registry.example.com:5000/shop/web',
      tag: '3.5.0',
      digest,
    });
    expect(parseImageReference('nginx')).toEqual({ repository: 'nginx', tag: null, digest: null });
    expect(parseImageReference('localhost:5000/app')).toEqual({
      repository: 'localhost:5000/app',
      tag: null,
      digest: null,
    });
  });

  it('picks the repo digest of the running repository', () => {
    const digests = ['ghcr.io/acme/other@sha256:1', 'nginx@sha256:2'];
    expect(pickRepoDigest(digests, 'nginx')).toBe('nginx@sha256:2');
    expect(pickRepoDigest(digests, 'docker.io/library/nginx')).toBe('nginx@sha256:2');
    expect(pickRepoDigest(digests, 'unknown')).toBe('ghcr.io/acme/other@sha256:1');
    expect(pickRepoDigest([], 'nginx')).toBeNull();
  });

  it('shows images with a short digest', () => {
    const image: RunningImage = {
      image: `shop/web:3.5.0@sha256:4f1c${'0'.repeat(56)}9a2e`,
      digest: `sha256:4f1c${'0'.repeat(56)}9a2e`,
      repository: 'shop/web',
      tag: '3.5.0',
      internal: false,
      localOnly: false,
      imageId: null,
      nodeId: 'n1',
      build: null,
    };
    expect(displayImage(image)).toBe('shop/web:3.5.0 · sha256:4f1c…9a2e');
  });
});

// A Compose interpolation placeholder, kept literal in the YAML.
const VAR = ['$', '{LOG_LEVEL}'].join('');

describe('Compose promotion', () => {
  const service = new AppPromotionService({} as never, {} as never, {} as never, {} as never, {} as never);
  const digest = `sha256:${'b'.repeat(64)}`;
  const running = (repository: string): RunningImage => ({
    image: `${repository}@${digest}`,
    digest,
    repository,
    tag: null,
    internal: repository.startsWith('127.0.0.1:5443/'),
    localOnly: false,
    imageId: null,
    nodeId: 'n1',
    build: null,
  });

  it('pins every running service image by digest, drops build sections and keeps variables as written', () => {
    const yaml = [
      'services:',
      '  api:',
      '    build: ./api',
      '    environment:',
      `      LOG_LEVEL: ${VAR}`,
      '  db:',
      '    image: postgres:16',
      '  idle:',
      '    image: busybox',
    ].join('\n');
    const pinned = parseYaml(
      service.pinComposeYaml(
        yaml,
        new Map([
          ['api', running('127.0.0.1:5443/shop/api')],
          ['db', running('postgres')],
        ])
      )
    );
    expect(pinned.services.api).toEqual({
      image: `127.0.0.1:5443/shop/api@${digest}`,
      environment: { LOG_LEVEL: VAR },
    });
    expect(pinned.services.db.image).toBe(`postgres@${digest}`);
    expect(pinned.services.idle.image).toBe('busybox');
  });

  it('lists path-level changes between two documents', () => {
    expect(
      diffDocuments(
        { services: { indexer: { environment: { BATCH_SIZE: '500' }, image: 'a' } } },
        { services: { indexer: { environment: { BATCH_SIZE: '1000', MODE: 'x' }, image: 'a' } } }
      )
    ).toEqual([
      { path: 'services.indexer.environment.BATCH_SIZE', from: '500', to: '1000' },
      { path: 'services.indexer.environment.MODE', from: null, to: 'x' },
    ]);
  });
});

describe('Container rollout', () => {
  const ten = 10 * 60_000;

  it('succeeds only on a finished recreate task', () => {
    expect(containerRolloutError({ status: 'succeeded' }, 'api', ten)).toBe(null);
    expect(containerRolloutError({ status: 'completed' }, 'api', ten)).toBe(null);
  });

  it('fails with the task error, on a task still running after the wait, and on a missing task', () => {
    expect(containerRolloutError({ status: 'failed', error: 'pull access denied' }, 'api', ten)).toMatchObject({
      code: 'PROMOTION_RECREATE_FAILED',
      message: 'Recreating api failed: pull access denied',
    });
    expect(containerRolloutError({ status: 'running', progress: 'Pulling image' }, 'api', ten)).toMatchObject({
      code: 'PROMOTION_RECREATE_TIMEOUT',
      message: 'api was not recreated within 10 min (Pulling image)',
    });
    expect(containerRolloutError({ status: 'pending' }, 'api', ten)?.code).toBe('PROMOTION_RECREATE_TIMEOUT');
    expect(containerRolloutError(null, 'api', ten)?.code).toBe('PROMOTION_RECREATE_UNKNOWN');
  });
});
