import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dockerBuilds, nodes } from '@/db/schema/index.js';
import { HousekeepingService } from '@/services/housekeeping.service.js';
import {
  DockerImageCleanupService,
  REPLACED_IMAGE_GRACE_MS,
  UNUSED_IMAGE_MIN_AGE_MS,
} from './docker-image-cleanup.service.js';
import {
  imageProtectionKeys,
  imageRetentionDigestKey,
  imageRetentionRepository,
  isToolImageRepository,
} from './docker-image-retention.js';
import type { ImageRetentionContext, ImageUnusedSince } from './docker-image-retention-store.js';

const REGISTRY = '127.0.0.1:5443';
const digestOf = (id: string) => `sha256:${createHash('sha256').update(id).digest('hex')}`;
const buildRef = (repository: string, id: string) => `${REGISTRY}/gateway/builds/${repository}@${digestOf(id)}`;

type FakeImage = Record<string, any>;
type FakeContainer = { id: string; name: string; image: string; imageId: string; labels?: Record<string, string> };

/** A build image as a node lists it after a pull by digest: no tag, one digest reference. */
function buildImage(repository: string, id: string, created: number, size = 1_550_000_000): FakeImage {
  return {
    Id: `sha256:${id}`,
    RepoTags: [],
    RepoDigests: [buildRef(repository, id)],
    Created: created,
    Size: size,
    Containers: 0,
  };
}

/** A registry image pulled by tag: the tag and its digest. */
function taggedImage(reference: string, id: string, created: number, size = 100): FakeImage {
  const repository = reference.slice(0, reference.lastIndexOf(':'));
  return {
    Id: `sha256:${id}`,
    RepoTags: [reference],
    RepoDigests: [`${repository}@${digestOf(id)}`],
    Created: created,
    Size: size,
    Containers: 0,
  };
}

/** An image whose tag moved on (a re-pull of a mutable tag): only its digest names it. */
function digestOnlyImage(repository: string, id: string, created: number, size = 100): FakeImage {
  return {
    Id: `sha256:${id}`,
    RepoTags: [],
    RepoDigests: [`${repository}@${digestOf(id)}`],
    Created: created,
    Size: size,
    Containers: 0,
  };
}

function runOn(images: FakeImage[], id: string, name: string, labels?: Record<string, string>): FakeContainer {
  const image = images.find((candidate) => candidate.Id === `sha256:${id}`)!;
  image.Containers += 1;
  return { id: `ctr-${name}`, name, image: image.RepoTags[0] ?? image.RepoDigests[0], imageId: image.Id, labels };
}

/** A node's Docker as the daemon answers it: removal without force is refused while a container uses the image. */
class FakeNode {
  removed: string[] = [];
  constructor(
    public images: FakeImage[],
    public containers: FakeContainer[] | null
  ) {}
  async remove(imageId: string) {
    const image = this.images.find((candidate) => candidate.Id === imageId);
    if (!image) throw new Error('No such image');
    if (image.Containers > 0) throw new Error('conflict: image is being used by a container');
    this.images = this.images.filter((candidate) => candidate !== image);
    this.removed.push(imageId);
  }
}

function fakeDocker(nodesById: Record<string, FakeNode>) {
  return {
    listAllImages: vi.fn(async (nodeId: string) => nodesById[nodeId]!.images.map((image) => ({ ...image }))),
    listNodeContainers: vi.fn(async (nodeId: string) => {
      const containers = nodesById[nodeId]!.containers;
      if (!containers) throw new Error('container list failed');
      return containers;
    }),
    removeUnusedImage: vi.fn(async (nodeId: string, imageId: string) => nodesById[nodeId]!.remove(imageId)),
  };
}

/** Answers each query by its table; filters are not evaluated, so each test passes the rows its query should see. */
function fakeDb(rows: Map<unknown, unknown[]> = new Map()) {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const result = rows.get(table) ?? [];
          return Object.assign(Promise.resolve(result), {
            limit: async (count: number) => result.slice(0, count),
          });
        },
      }),
    }),
  };
}

function cleanupSetting(input: {
  targetType: 'container' | 'deployment';
  nodeId?: string;
  containerName?: string;
  deploymentId?: string;
  enabled?: boolean;
  retentionCount?: number;
}) {
  return {
    id: `setting-${input.containerName ?? input.deploymentId}`,
    nodeId: input.nodeId ?? 'node-1',
    targetType: input.targetType,
    containerName: input.containerName ?? null,
    deploymentId: input.deploymentId ?? null,
    enabled: input.enabled ?? true,
    retentionCount: input.retentionCount ?? 2,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** Opfield's records as the cleanup reads them, and the per-node tracking it keeps. */
function fakeStore(context: Partial<ImageRetentionContext> = {}) {
  const tracking = new Map<string, ImageUnusedSince>();
  return {
    tracking,
    context: vi.fn(async () => ({
      settings: [],
      protectedKeys: new Set<string>(),
      // Every source the tests' build repositories name exists unless a test says otherwise.
      sourceBindings: new Map(
        ['src-rin', 'src', 'other', 'src-web', 'src-api'].map((id) => [
          id,
          { targetKind: 'container', nodeId: 'node-1', containerName: id, deploymentId: null },
        ])
      ),
      availabilityOwners: new Map(),
      ...context,
    })),
    unusedSince: vi.fn(async (nodeId: string) => ({ ...(tracking.get(nodeId) ?? {}) })),
    saveUnusedSince: vi.fn(async (nodeId: string, state: ImageUnusedSince) => {
      tracking.set(nodeId, { ...state });
    }),
  };
}

/** A clock the test moves. */
function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function cleanupService(input: {
  nodes: Record<string, FakeNode>;
  store?: ReturnType<typeof fakeStore>;
  db?: ReturnType<typeof fakeDb>;
  time?: ReturnType<typeof clock>;
}) {
  const docker = fakeDocker(input.nodes);
  const store = input.store ?? fakeStore();
  const time = input.time ?? clock();
  const service = new DockerImageCleanupService(
    (input.db ?? fakeDb()) as never,
    docker as never,
    store as never,
    time.now
  );
  return { service, docker, store, time };
}

/** A cleanup, and another once `waitMs` passed: images found removable at the first go at the second. */
async function enforceAcross(
  service: DockerImageCleanupService,
  time: ReturnType<typeof clock>,
  waitMs: number,
  nodeId = 'node-1'
) {
  const first = await service.enforceNode(nodeId);
  time.advance(waitMs + 20_000);
  const second = await service.enforceNode(nodeId);
  return { first, second };
}

const ids = (node: FakeNode) => node.images.map((image) => image.Id.replace('sha256:', '')).sort();
const range = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);

afterEach(() => {
  vi.useRealTimers();
});

describe('image references', () => {
  it('gives an internal registry image the same repository from any registry address, by digest or tag', () => {
    expect(imageRetentionRepository(buildRef('src-rin', 'a'))).toBe('gateway/builds/src-rin');
    expect(imageRetentionRepository('registry.internal:5000/gateway/builds/src-rin:build-1')).toBe(
      'gateway/builds/src-rin'
    );
    expect(imageRetentionRepository('gateway/builds/src/web@sha256:' + 'a'.repeat(64))).toBe('gateway/builds/src/web');
    expect(imageRetentionRepository(`${REGISTRY}/gateway/availability/policy-1/1/3:image`)).toBe(
      'gateway/availability/policy-1/1/3'
    );
    expect(imageRetentionRepository('nginx:1.27')).toBe('docker.io/library/nginx');
    expect(imageRetentionRepository('ghcr.io/opfield/opfield/relay:v2.12.3')).toBe('ghcr.io/opfield/opfield/relay');
    expect(imageRetentionRepository(`sha256:${'b'.repeat(64)}`)).toBeNull();
  });

  it('matches a record naming an image in any form Docker lists it', () => {
    const digest = `sha256:${'c'.repeat(64)}`;
    expect(imageProtectionKeys('postgres:16')).toEqual(imageProtectionKeys('docker.io/library/postgres:16'));
    expect(imageProtectionKeys(`postgres:16@${digest}`)).toEqual([
      'docker.io/library/postgres:16',
      `docker.io/library/postgres@${digest}`,
    ]);
    expect(imageProtectionKeys(`${REGISTRY}/gateway/builds/src@${digest}`)).toEqual([`gateway/builds/src@${digest}`]);
  });

  it('knows the tools Opfield runs now and then, and nothing else by that name', () => {
    expect(isToolImageRepository('docker.io/docker/compose-bin')).toBe(true);
    expect(isToolImageRepository('ghcr.io/the-square-labs/gateway/compose-bin')).toBe(true);
    expect(isToolImageRepository('docker.io/library/busybox')).toBe(true);
    expect(isToolImageRepository('ghcr.io/opfield/opfield/backup-runner')).toBe(true);
    expect(isToolImageRepository('docker.io/myorg/busybox')).toBe(false);
    expect(isToolImageRepository('docker.io/library/postgres')).toBe(false);
  });
});

describe('DockerImageCleanupService on build images', () => {
  it('reproduces the production node: 22 digest-only builds of one container, a build rollout leaves 2', async () => {
    vi.useFakeTimers();
    const images = range('rin', 22).map((id, index) => buildImage('src-rin', id, index + 1));
    // The two newest builds failed readiness and were rolled back: the container runs rin-20.
    const node = new FakeNode(images, []);
    node.containers = [runOn(images, 'rin-20', 'rin')];
    const store = fakeStore({ settings: [cleanupSetting({ targetType: 'container', containerName: 'rin' })] });
    const docker = fakeDocker({ 'node-1': node });
    const service = new DockerImageCleanupService(
      fakeDb(new Map([[dockerBuilds, []]])) as never,
      docker as never,
      store as never
    );

    const cleanup = service.scheduleCleanupForContainer('node-1', 'rin', buildRef('src-rin', 'rin-20'));
    await vi.advanceTimersByTimeAsync(5000);
    await cleanup;
    // Found removable: they go once the grace passed, at the follow-up the cleanup scheduled.
    expect(node.removed).toEqual([]);
    await vi.advanceTimersByTimeAsync(REPLACED_IMAGE_GRACE_MS + 2000);

    // The running build and the newest other one to roll back to.
    expect(ids(node)).toEqual(['rin-20', 'rin-22']);
    expect(node.removed).toHaveLength(20);
    expect(docker.removeUnusedImage).not.toHaveBeenCalledWith('node-1', 'sha256:rin-20', null);
  });

  it('keeps the rollback build the internal registry keeps instead of a newer failed one', async () => {
    const images = range('rin', 22).map((id, index) => buildImage('src-rin', id, index + 1));
    const node = new FakeNode(images, []);
    node.containers = [runOn(images, 'rin-20', 'rin')];
    const { service, time } = cleanupService({ nodes: { 'node-1': node } });
    service.setProtectedDigestsProvider(
      async () =>
        new Set(['rin-20', 'rin-19'].map((id) => imageRetentionDigestKey('gateway/builds/src-rin', digestOf(id))))
    );

    await enforceAcross(service, time, REPLACED_IMAGE_GRACE_MS);

    expect(ids(node)).toEqual(['rin-19', 'rin-20']);
  });

  it('keeps both blue/green slot images and the deployment setting, read from net.opfield labels too', async () => {
    const images = range('web', 7).map((id, index) => buildImage('src-web', id, index + 1));
    const node = new FakeNode(images, []);
    const labels = { 'net.opfield.deployment.managed': 'true', 'net.opfield.deployment.id': 'dep-1' };
    node.containers = [runOn(images, 'web-7', 'web-blue', labels), runOn(images, 'web-6', 'web-green', labels)];
    const store = fakeStore({
      settings: [cleanupSetting({ targetType: 'deployment', deploymentId: 'dep-1', retentionCount: 3 })],
    });
    const { service, time } = cleanupService({ nodes: { 'node-1': node }, store });

    await enforceAcross(service, time, REPLACED_IMAGE_GRACE_MS);

    // Both slots and two to roll back to.
    expect(ids(node)).toEqual(['web-4', 'web-5', 'web-6', 'web-7']);
  });

  it('leaves a deployment with cleanup off alone on a node with net.opfield labels', async () => {
    const images = range('web', 5).map((id, index) => buildImage('src-web', id, index + 1));
    const node = new FakeNode(images, []);
    node.containers = [runOn(images, 'web-5', 'web-blue', { 'net.opfield.deployment.id': 'dep-1' })];
    const store = fakeStore({
      settings: [cleanupSetting({ targetType: 'deployment', deploymentId: 'dep-1', enabled: false })],
    });
    const { service, time } = cleanupService({ nodes: { 'node-1': node }, store });

    await enforceAcross(service, time, UNUSED_IMAGE_MIN_AGE_MS);

    expect(node.removed).toEqual([]);
  });

  it('cleans each Compose service of the applied source on every Docker node and leaves other sources alone', async () => {
    vi.useFakeTimers();
    const node1Images = [
      ...range('web', 5).map((id, index) => buildImage('src/web', id, index + 1)),
      ...range('worker', 4).map((id, index) => buildImage('src/worker', id, index + 1)),
      ...range('other', 4).map((id, index) => buildImage('other', id, index + 1)),
    ];
    const node1 = new FakeNode(node1Images, []);
    node1.containers = [runOn(node1Images, 'web-5', 'src-web-1'), runOn(node1Images, 'worker-3', 'src-worker-1')];
    // An Availability replica of the web service on another node.
    const node2Images = range('web', 5).map((id, index) => buildImage('src/web', id, index + 1));
    const node2 = new FakeNode(node2Images, []);
    node2.containers = [runOn(node2Images, 'web-5', 'src-web-1')];
    const { service } = cleanupService({
      nodes: { 'node-1': node1, 'node-2': node2 },
      db: fakeDb(new Map<unknown, unknown[]>([[nodes, [{ id: 'node-1' }, { id: 'node-2' }]]])),
      time: { now: () => Date.now(), advance: () => {} },
    });

    service.sourceApplied('src');
    await (service as unknown as { sourceQueue: Promise<void> }).sourceQueue;
    await vi.advanceTimersByTimeAsync(REPLACED_IMAGE_GRACE_MS + 2000);

    expect(ids(node1)).toEqual(['other-1', 'other-2', 'other-3', 'other-4', 'web-4', 'web-5', 'worker-3', 'worker-4']);
    expect(ids(node2)).toEqual(['web-4', 'web-5']);
  });

  it('cleans the finished build source on every node', async () => {
    vi.useFakeTimers();
    const images = range('rin', 5).map((id, index) => buildImage('src-rin', id, index + 1));
    const node = new FakeNode(images, []);
    node.containers = [runOn(images, 'rin-5', 'rin')];
    const { service } = cleanupService({
      nodes: { 'node-1': node },
      db: fakeDb(
        new Map<unknown, unknown[]>([
          [dockerBuilds, [{ sourceBindingId: 'src-rin' }]],
          [nodes, [{ id: 'node-1' }]],
        ])
      ),
      time: { now: () => Date.now(), advance: () => {} },
    });

    service.buildFinished('build-5');
    await (service as unknown as { sourceQueue: Promise<void> }).sourceQueue;
    await vi.advanceTimersByTimeAsync(REPLACED_IMAGE_GRACE_MS + 2000);

    expect(ids(node)).toEqual(['rin-4', 'rin-5']);
  });

  it('never selects an image a container uses, running or stopped, and skips one Docker refuses', async () => {
    const images = range('api', 6).map((id, index) => buildImage('src-api', id, index + 1));
    const node = new FakeNode(images, []);
    // A stopped copy still runs the oldest build.
    node.containers = [runOn(images, 'api-6', 'api'), runOn(images, 'api-1', 'api-copy')];
    const { service, docker, time } = cleanupService({ nodes: { 'node-1': node } });
    // A container created from api-3 between the list and the removal: Docker refuses it, the rest goes on.
    docker.removeUnusedImage.mockImplementation(async (_nodeId: string, imageId: string) => {
      if (imageId === 'sha256:api-3') throw new Error('conflict: image is being used by a container');
      return node.remove(imageId);
    });

    const { first, second } = await enforceAcross(service, time, REPLACED_IMAGE_GRACE_MS);

    expect(first.candidates).toEqual([]);
    expect(first.waiting.map((candidate) => candidate.id).sort()).toEqual([
      'sha256:api-2',
      'sha256:api-3',
      'sha256:api-4',
    ]);
    expect(second.candidates.map((candidate) => candidate.id).sort()).toEqual([
      'sha256:api-2',
      'sha256:api-3',
      'sha256:api-4',
    ]);
    expect(ids(node)).toEqual(['api-1', 'api-3', 'api-5', 'api-6']);
    expect(docker.removeUnusedImage).not.toHaveBeenCalledWith('node-1', 'sha256:api-1', expect.anything());
    expect(docker.removeUnusedImage).not.toHaveBeenCalledWith('node-1', 'sha256:api-6', expect.anything());
  });

  it('leaves a repository alone when its container has cleanup off, and a node whose containers it cannot list', async () => {
    const images = range('rin', 4).map((id, index) => buildImage('src-rin', id, index + 1));
    const node = new FakeNode(images, []);
    node.containers = [runOn(images, 'rin-4', 'rin')];
    const off = cleanupService({
      nodes: { 'node-1': node },
      store: fakeStore({
        settings: [cleanupSetting({ targetType: 'container', containerName: 'rin', enabled: false })],
      }),
    });
    await enforceAcross(off.service, off.time, UNUSED_IMAGE_MIN_AGE_MS);
    expect(node.removed).toEqual([]);

    const blind = new FakeNode(
      range('rin', 4).map((id, index) => buildImage('src-rin', id, index + 1)),
      null
    );
    const { service } = cleanupService({ nodes: { 'node-1': blind } });
    await expect(service.enforceNode('node-1')).rejects.toThrow('container list failed');
    expect(blind.removed).toEqual([]);
  });

  it('honours every owner of a repository: cleanup off on one container keeps the images of the others too', async () => {
    const images = [
      taggedImage('myorg/app:v4', 'v4', 4),
      taggedImage('myorg/app:v3', 'v3', 3),
      taggedImage('myorg/app:v2', 'v2', 2),
      taggedImage('myorg/app:v1', 'v1', 1),
    ];
    const node = new FakeNode(images, []);
    node.containers = [runOn(images, 'v4', 'a'), runOn(images, 'v3', 'b')];
    const store = fakeStore({
      settings: [
        cleanupSetting({ targetType: 'container', containerName: 'a' }),
        cleanupSetting({ targetType: 'container', containerName: 'b', enabled: false }),
      ],
    });
    const { service, time } = cleanupService({ nodes: { 'node-1': node }, store });

    await enforceAcross(service, time, UNUSED_IMAGE_MIN_AGE_MS);

    expect(node.removed).toEqual([]);
  });

  it('keeps the largest count of the owners of a repository', async () => {
    const images = range('v', 6).map((id, index) => taggedImage(`myorg/app:${id}`, id, index + 1));
    const node = new FakeNode(images, []);
    node.containers = [runOn(images, 'v-6', 'a'), runOn(images, 'v-5', 'b')];
    const store = fakeStore({
      settings: [
        cleanupSetting({ targetType: 'container', containerName: 'a' }),
        cleanupSetting({ targetType: 'container', containerName: 'b', retentionCount: 3 }),
      ],
    });
    const { service, time } = cleanupService({ nodes: { 'node-1': node }, store });

    await enforceAcross(service, time, REPLACED_IMAGE_GRACE_MS);

    expect(ids(node)).toEqual(['v-3', 'v-4', 'v-5', 'v-6']);
  });

  it("applies an Availability copy's workload setting on the copy's node", async () => {
    const images = range('rin', 5).map((id, index) => buildImage('src-rin', id, index + 1));
    const node2 = new FakeNode(images, []);
    node2.containers = [runOn(images, 'rin-5', 'opfav-rin', { 'net.opfield.availability.policy': 'policy-1' })];
    const store = fakeStore({
      settings: [cleanupSetting({ targetType: 'container', nodeId: 'node-1', containerName: 'rin', enabled: false })],
      availabilityOwners: new Map([['policy-1', { nodeId: 'node-1', containerName: 'rin', deploymentId: null }]]),
    });
    const { service, time } = cleanupService({ nodes: { 'node-2': node2 }, store });

    await enforceAcross(service, time, UNUSED_IMAGE_MIN_AGE_MS, 'node-2');

    expect(node2.removed).toEqual([]);
  });

  it('removes the builds of a deleted source once unused for the minimum age, and keeps 2 of a live source', async () => {
    const images = [
      ...range('gone', 3).map((id, index) => buildImage('src-gone', id, index + 1)),
      ...range('rin', 4).map((id, index) => buildImage('src-rin', id, index + 1)),
    ];
    const node = new FakeNode(images, []);
    const { service, time } = cleanupService({ nodes: { 'node-1': node } });

    const early = await enforceAcross(service, time, REPLACED_IMAGE_GRACE_MS);
    // The live source's builds nothing on this node runs: its setting (default 2, the newest stays to roll back to).
    expect(early.second.candidates.map((candidate) => candidate.id).sort()).toEqual([
      'sha256:rin-1',
      'sha256:rin-2',
      'sha256:rin-3',
    ]);
    expect(ids(node)).toEqual(['gone-1', 'gone-2', 'gone-3', 'rin-4']);

    time.advance(UNUSED_IMAGE_MIN_AGE_MS);
    await service.enforceNode('node-1');
    expect(ids(node)).toEqual(['rin-4']);
  });
});

describe('DockerImageCleanupService on other images', () => {
  it('removes images nothing runs or names once unused for the minimum age, and keeps those records name', async () => {
    const images = [
      // A removed container's image, and an earlier tag of a Compose service.
      taggedImage('myorg/removed:v1', 'removed', 1),
      taggedImage('myorg/web:sha-2', 'web-2', 2),
      taggedImage('myorg/web:sha-1', 'web-1', 1),
      taggedImage('myorg/web:sha-3', 'web-3', 3),
      // A superseded engine pulled by digest and a re-pulled mutable tag.
      digestOnlyImage('ghcr.io/the-square-labs/gateway/postgres', 'pg-old', 1),
      digestOnlyImage('docker.io/library/nginx', 'nginx-old', 1),
      // A deployment names this one in its config (a rollout about to create its container).
      taggedImage('redis:7', 'redis', 1),
      // Tools: the newest stays.
      digestOnlyImage('docker.io/docker/compose-bin', 'compose-old', 1),
      digestOnlyImage('docker.io/docker/compose-bin', 'compose-new', 2),
      // A connector image has its own rule.
      taggedImage('ghcr.io/opfield/opfield/secure-link-connector:v1', 'connector-old', 1),
      // An Availability copy the registry still holds.
      { ...digestOnlyImage(`${REGISTRY}/gateway/availability/policy-1/1/4`, 'mirror', 1) },
      { Id: 'sha256:dangling', RepoTags: ['<none>:<none>'], RepoDigests: [], Created: 1, Size: 5, Containers: 0 },
    ];
    const node = new FakeNode(images, []);
    node.containers = [runOn(images, 'web-3', 'web-web-1')];
    const mirrorDigest = digestOf('mirror');
    const store = fakeStore({
      protectedKeys: new Set([
        ...imageProtectionKeys('docker.io/library/redis:7'),
        imageRetentionDigestKey('gateway/availability/policy-1/1/4', mirrorDigest),
      ]),
    });
    const { service, time } = cleanupService({ nodes: { 'node-1': node }, store });

    const { second } = await enforceAcross(service, time, REPLACED_IMAGE_GRACE_MS);
    // The Compose service's older tag beyond its rollback image went with the grace; the rest waits.
    expect(second.candidates.map((candidate) => candidate.id)).toEqual(['sha256:web-1']);
    expect(second.waiting.map((candidate) => candidate.id).sort()).toEqual([
      'sha256:compose-old',
      'sha256:dangling',
      'sha256:nginx-old',
      'sha256:pg-old',
      'sha256:removed',
    ]);

    time.advance(UNUSED_IMAGE_MIN_AGE_MS);
    await service.enforceNode('node-1');
    expect(ids(node)).toEqual(['compose-new', 'connector-old', 'mirror', 'redis', 'web-2', 'web-3']);
  });

  it('restarts the wait of an image that was used again', async () => {
    const images = [taggedImage('myorg/removed:v1', 'removed', 1)];
    const node = new FakeNode(images, []);
    const { service, time, store } = cleanupService({ nodes: { 'node-1': node } });

    await service.enforceNode('node-1');
    expect(Object.keys(store.tracking.get('node-1') ?? {})).toEqual(['sha256:removed']);
    time.advance(UNUSED_IMAGE_MIN_AGE_MS - 60_000);
    // A container was created from it, and removed again an hour later.
    node.containers = [runOn(images, 'removed', 'again')];
    await service.enforceNode('node-1');
    expect(store.tracking.get('node-1')).toEqual({});
    node.containers = [];
    images[0]!.Containers = 0;
    time.advance(60 * 60_000);
    await service.enforceNode('node-1');
    time.advance(60_000);
    await service.enforceNode('node-1');
    expect(node.removed).toEqual([]);
  });

  it('keeps an image another repository still keeps (one image, two names)', async () => {
    const shared = {
      Id: 'sha256:shared',
      RepoTags: ['python:3.12-alpine', `${REGISTRY}/gateway/availability/policy-2/1/2:image`],
      RepoDigests: [],
      Created: 1,
      Size: 10,
      Containers: 0,
    };
    const node = new FakeNode([shared], []);
    const store = fakeStore({ protectedKeys: new Set(['gateway/availability/policy-2/1/2:image']) });
    const { service, time } = cleanupService({ nodes: { 'node-1': node }, store });

    await enforceAcross(service, time, UNUSED_IMAGE_MIN_AGE_MS);

    expect(node.removed).toEqual([]);
  });
});

describe('Housekeeping Docker Images over nodes', () => {
  it('counts every old image in the stats and removes those past their wait on every online Docker node', async () => {
    const node1Images = range('rin', 22).map((id, index) => buildImage('src-rin', id, index + 1));
    const node1 = new FakeNode(node1Images, []);
    node1.containers = [runOn(node1Images, 'rin-22', 'rin')];
    node1.images.push(
      { Id: 'sha256:dangling', RepoTags: ['<none>:<none>'], RepoDigests: [], Created: 1, Size: 5, Containers: 0 },
      { Id: 'sha256:parent', RepoTags: [], RepoDigests: [], Created: 1, Size: 7, Containers: 0 },
      { Id: 'sha256:child', ParentId: 'sha256:parent', RepoTags: ['acme/tool:1'], Created: 2, Size: 9, Containers: 0 }
    );
    const node2Images = range('rin', 3).map((id, index) => buildImage('src-rin', id, index + 20));
    const node2 = new FakeNode(node2Images, []);
    node2.containers = [runOn(node2Images, 'rin-3', 'rin')];
    const offline = new FakeNode(
      range('rin', 3).map((id, index) => buildImage('src-rin', id, index + 1)),
      null
    );
    const time = clock();
    const { service: cleanup } = cleanupService({
      nodes: { 'node-1': node1, 'node-2': node2, 'node-3': offline },
      db: fakeDb(new Map<unknown, unknown[]>([[nodes, [{ id: 'node-1' }, { id: 'node-2' }, { id: 'node-3' }]]])),
      time,
    });
    const housekeeping = new HousekeepingService(
      {} as never,
      { inspectSelf: vi.fn().mockRejectedValue(new Error('no local Docker')) } as never,
      {} as never,
      {} as never
    );
    housekeeping.setImageCleanupService(cleanup);

    // 20 old builds and the dangling image on node 1 (the user's unused acme/tool image too), 1 build on node 2.
    const stats = await (housekeeping as any).getDockerImageStats();
    expect(stats).toMatchObject({
      oldImageCount: 20 + 1 + 1 + 1,
      reclaimableBytes: 21 * 1_550_000_000 + 5 + 9,
      opfieldHost: { count: 0, bytes: 0 },
      connectors: { count: 0, bytes: 0 },
    });
    // Per node (X-O-16): nothing is due yet, everything waits; the node that does not answer says so.
    expect(
      stats.nodes.map((node: any) => [node.nodeId, node.removableNow.count, node.waiting.count, Boolean(node.error)])
    ).toEqual([
      ['node-1', 0, 22, false],
      ['node-2', 0, 1, false],
      ['node-3', 0, 0, true],
    ]);
    expect(stats.nodes[0].waiting.nextRemovableAt).toEqual(expect.any(String));
    expect(node1.removed).toEqual([]);

    time.advance(UNUSED_IMAGE_MIN_AGE_MS);
    await expect((housekeeping as any).pruneDockerImages()).resolves.toEqual({
      itemsCleaned: 23,
      spaceFreedBytes: 21 * 1_550_000_000 + 5 + 9,
    });
    expect(ids(node1)).toEqual(['parent', 'rin-21', 'rin-22']);
    expect(ids(node2)).toEqual(['rin-2', 'rin-3']);
    expect(offline.removed).toEqual([]);
  });
});
