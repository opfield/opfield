import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dockerBuilds, dockerImageCleanupSettings, nodes } from '@/db/schema/index.js';
import { HousekeepingService } from '@/services/housekeeping.service.js';
import { DockerImageCleanupService } from './docker-image-cleanup.service.js';
import { imageRetentionDigestKey, imageRetentionRepository } from './docker-image-retention.js';

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

function runOn(images: FakeImage[], id: string, name: string, labels?: Record<string, string>): FakeContainer {
  const image = images.find((candidate) => candidate.Id === `sha256:${id}`)!;
  image.Containers += 1;
  return { id: `ctr-${name}`, name, image: image.RepoDigests[0], imageId: image.Id, labels };
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
    listAllContainers: vi.fn(async (nodeId: string) => {
      const containers = nodesById[nodeId]!.containers;
      if (!containers) throw new Error('container list failed');
      return containers;
    }),
    removeUnusedImage: vi.fn(async (nodeId: string, imageId: string) => nodesById[nodeId]!.remove(imageId)),
  };
}

/** Answers each query by its table; filters are not evaluated, so each test passes the rows its query should see. */
function fakeDb(rows: Map<unknown, unknown[]>) {
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
  containerName?: string;
  deploymentId?: string;
  enabled?: boolean;
  retentionCount?: number;
}) {
  return {
    id: `setting-${input.containerName ?? input.deploymentId}`,
    nodeId: 'node-1',
    targetType: input.targetType,
    containerName: input.containerName ?? null,
    deploymentId: input.deploymentId ?? null,
    enabled: input.enabled ?? true,
    retentionCount: input.retentionCount ?? 2,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const ids = (node: FakeNode) => node.images.map((image) => image.Id.replace('sha256:', '')).sort();
const range = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);

afterEach(() => {
  vi.useRealTimers();
});

describe('imageRetentionRepository', () => {
  it('gives a build image the same repository from any registry address, by digest or tag', () => {
    expect(imageRetentionRepository(buildRef('src-rin', 'a'))).toBe('gateway/builds/src-rin');
    expect(imageRetentionRepository('registry.internal:5000/gateway/builds/src-rin:build-1')).toBe(
      'gateway/builds/src-rin'
    );
    expect(imageRetentionRepository('gateway/builds/src/web@sha256:' + 'a'.repeat(64))).toBe('gateway/builds/src/web');
    expect(imageRetentionRepository('nginx:1.27')).toBe('docker.io/library/nginx');
    expect(imageRetentionRepository(`sha256:${'b'.repeat(64)}`)).toBeNull();
  });
});

describe('DockerImageCleanupService on build images', () => {
  it('reproduces the production node: 22 digest-only builds of one container, a build rollout leaves 2', async () => {
    vi.useFakeTimers();
    const images = range('rin', 22).map((id, index) => buildImage('src-rin', id, index + 1));
    // The two newest builds failed readiness and were rolled back: the container runs rin-20.
    const node = new FakeNode(images, []);
    node.containers = [runOn(images, 'rin-20', 'rin')];
    const docker = fakeDocker({ 'node-1': node });
    const service = new DockerImageCleanupService(
      fakeDb(
        new Map([[dockerImageCleanupSettings, [cleanupSetting({ targetType: 'container', containerName: 'rin' })]]])
      ) as never,
      docker as never
    );

    const cleanup = service.scheduleCleanupForContainer('node-1', 'rin', buildRef('src-rin', 'rin-20'));
    await vi.advanceTimersByTimeAsync(5000);
    await cleanup;

    // The running build and the newest other one to roll back to.
    expect(ids(node)).toEqual(['rin-20', 'rin-22']);
    expect(node.removed).toHaveLength(20);
    expect(docker.removeUnusedImage).not.toHaveBeenCalledWith('node-1', 'sha256:rin-20', null);
  });

  it('keeps the rollback build the internal registry keeps instead of a newer failed one', async () => {
    vi.useFakeTimers();
    const images = range('rin', 22).map((id, index) => buildImage('src-rin', id, index + 1));
    const node = new FakeNode(images, []);
    node.containers = [runOn(images, 'rin-20', 'rin')];
    const service = new DockerImageCleanupService(
      fakeDb(new Map([[dockerImageCleanupSettings, []]])) as never,
      fakeDocker({ 'node-1': node }) as never
    );
    service.setProtectedDigestsProvider(
      async () =>
        new Set(['rin-20', 'rin-19'].map((id) => imageRetentionDigestKey('gateway/builds/src-rin', digestOf(id))))
    );

    const cleanup = service.scheduleCleanupForContainer('node-1', 'rin', buildRef('src-rin', 'rin-20'));
    await vi.advanceTimersByTimeAsync(5000);
    await cleanup;

    expect(ids(node)).toEqual(['rin-19', 'rin-20']);
  });

  it('keeps both blue/green slot images and one rollback image of a deployment', async () => {
    const images = range('web', 6).map((id, index) => buildImage('src-web', id, index + 1));
    const node = new FakeNode(images, []);
    const labels = { 'wiolett.gateway.deployment.id': 'dep-1' };
    node.containers = [runOn(images, 'web-6', 'web-blue', labels), runOn(images, 'web-5', 'web-green', labels)];
    const service = new DockerImageCleanupService(
      fakeDb(
        new Map([[dockerImageCleanupSettings, [cleanupSetting({ targetType: 'deployment', deploymentId: 'dep-1' })]]])
      ) as never,
      fakeDocker({ 'node-1': node }) as never
    );

    await service.enforceNode('node-1');

    expect(ids(node)).toEqual(['web-4', 'web-5', 'web-6']);
  });

  it('cleans each Compose service of the applied source on every Docker node and leaves other sources alone', async () => {
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
    const service = new DockerImageCleanupService(
      fakeDb(
        new Map<unknown, unknown[]>([
          [nodes, [{ id: 'node-1' }, { id: 'node-2' }]],
          [dockerImageCleanupSettings, []],
        ])
      ) as never,
      fakeDocker({ 'node-1': node1, 'node-2': node2 }) as never
    );

    service.sourceApplied('src');
    await (service as unknown as { sourceQueue: Promise<void> }).sourceQueue;

    expect(ids(node1)).toEqual(['other-1', 'other-2', 'other-3', 'other-4', 'web-4', 'web-5', 'worker-3', 'worker-4']);
    expect(ids(node2)).toEqual(['web-4', 'web-5']);
  });

  it('cleans the finished build source on every node', async () => {
    const images = range('rin', 5).map((id, index) => buildImage('src-rin', id, index + 1));
    const node = new FakeNode(images, []);
    node.containers = [runOn(images, 'rin-5', 'rin')];
    const service = new DockerImageCleanupService(
      fakeDb(
        new Map<unknown, unknown[]>([
          [dockerBuilds, [{ sourceBindingId: 'src-rin' }]],
          [nodes, [{ id: 'node-1' }]],
          [dockerImageCleanupSettings, []],
        ])
      ) as never,
      fakeDocker({ 'node-1': node }) as never
    );

    service.buildFinished('build-5');
    await (service as unknown as { sourceQueue: Promise<void> }).sourceQueue;

    expect(ids(node)).toEqual(['rin-4', 'rin-5']);
  });

  it('never selects an image a container uses, running or stopped, and skips one Docker refuses', async () => {
    const images = range('api', 6).map((id, index) => buildImage('src-api', id, index + 1));
    const node = new FakeNode(images, []);
    // A stopped copy still runs the oldest build.
    node.containers = [runOn(images, 'api-6', 'api'), runOn(images, 'api-1', 'api-copy')];
    const docker = fakeDocker({ 'node-1': node });
    // A container created from api-3 between the list and the removal: Docker refuses it, the rest goes on.
    docker.removeUnusedImage.mockImplementation(async (_nodeId: string, imageId: string) => {
      if (imageId === 'sha256:api-3') throw new Error('conflict: image is being used by a container');
      return node.remove(imageId);
    });
    const service = new DockerImageCleanupService(
      fakeDb(new Map([[dockerImageCleanupSettings, []]])) as never,
      docker as never
    );

    const result = await service.enforceNode('node-1');

    expect(result.candidates.map((candidate) => candidate.id).sort()).toEqual([
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
    const off = new DockerImageCleanupService(
      fakeDb(
        new Map([
          [
            dockerImageCleanupSettings,
            [cleanupSetting({ targetType: 'container', containerName: 'rin', enabled: false })],
          ],
        ])
      ) as never,
      fakeDocker({ 'node-1': node }) as never
    );
    await off.enforceNode('node-1');
    expect(node.removed).toEqual([]);

    const blind = new FakeNode(
      range('rin', 4).map((id, index) => buildImage('src-rin', id, index + 1)),
      null
    );
    const service = new DockerImageCleanupService(
      fakeDb(new Map([[dockerImageCleanupSettings, []]])) as never,
      fakeDocker({ 'node-1': blind }) as never
    );
    await expect(service.enforceNode('node-1')).rejects.toThrow('container list failed');
    expect(blind.removed).toEqual([]);
  });
});

describe('Housekeeping Docker Images over nodes', () => {
  it('applies the build image rule and removes dangling images on every online Docker node', async () => {
    const node1Images = range('rin', 22).map((id, index) => buildImage('src-rin', id, index + 1));
    const node1 = new FakeNode(node1Images, []);
    node1.containers = [runOn(node1Images, 'rin-22', 'rin')];
    node1.images.push(
      { Id: 'sha256:dangling', RepoTags: ['<none>:<none>'], RepoDigests: [], Created: 1, Size: 5, Containers: 0 },
      { Id: 'sha256:parent', RepoTags: [], RepoDigests: [], Created: 1, Size: 7, Containers: 0 },
      { Id: 'sha256:child', ParentId: 'sha256:parent', RepoTags: ['acme/tool:1'], Created: 2, Size: 9, Containers: 0 },
      {
        Id: 'sha256:pinned',
        RepoTags: [],
        RepoDigests: ['postgres@sha256:' + 'c'.repeat(64)],
        Created: 1,
        Containers: 0,
      }
    );
    const node2Images = range('rin', 3).map((id, index) => buildImage('src-rin', id, index + 20));
    const node2 = new FakeNode(node2Images, []);
    node2.containers = [runOn(node2Images, 'rin-3', 'rin')];
    const offline = new FakeNode(
      range('rin', 3).map((id, index) => buildImage('src-rin', id, index + 1)),
      null
    );
    const cleanup = new DockerImageCleanupService(
      fakeDb(
        new Map<unknown, unknown[]>([
          [nodes, [{ id: 'node-1' }, { id: 'node-2' }, { id: 'node-3' }]],
          [dockerImageCleanupSettings, []],
        ])
      ) as never,
      fakeDocker({ 'node-1': node1, 'node-2': node2, 'node-3': offline }) as never
    );
    const housekeeping = new HousekeepingService(
      {} as never,
      { inspectSelf: vi.fn().mockRejectedValue(new Error('no local Docker')) } as never,
      {} as never,
      {} as never
    );
    housekeeping.setImageCleanupService(cleanup);

    await expect((housekeeping as any).getDockerImageStats()).resolves.toEqual({
      oldImageCount: 20 + 1 + 1,
      reclaimableBytes: 21 * 1_550_000_000 + 5,
    });
    expect(node1.removed).toEqual([]);

    await expect((housekeeping as any).pruneDockerImages()).resolves.toEqual({
      itemsCleaned: 22,
      spaceFreedBytes: 21 * 1_550_000_000 + 5,
    });
    expect(ids(node1)).toEqual(['child', 'parent', 'pinned', 'rin-21', 'rin-22']);
    expect(ids(node2)).toEqual(['rin-2', 'rin-3']);
    expect(offline.removed).toEqual([]);
  });
});
