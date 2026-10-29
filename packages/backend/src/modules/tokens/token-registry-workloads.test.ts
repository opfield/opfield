import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { DockerSnapshotService } from '@/modules/docker/docker-snapshot.service.js';
import {
  artifactOwnerWorkloadTarget,
  buildRepositorySourceBindingId,
  RegistryRepositoryWorkloadService,
  sourceBindingWorkloadTarget,
} from './token-registry-workloads.js';

const NODE = '6b1f0c1e-0000-4000-8000-000000000001';
const BINDING = '6b1f0c1e-0000-4000-8000-000000000002';
const DEPLOYMENT = '6b1f0c1e-0000-4000-8000-000000000003';
const PROJECT = '6b1f0c1e-0000-4000-8000-000000000004';

/** A database whose queries answer, in order, with the given rows. */
function queuedDb(results: unknown[][]): DrizzleClient {
  const query = () => {
    const rows = results.shift() ?? [];
    const builder: Record<string, unknown> = {
      from: () => builder,
      innerJoin: () => builder,
      where: () => builder,
      limit: () => builder,
      // biome-ignore lint/suspicious/noThenProperty: a thenable stands in for a Drizzle query
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    return builder;
  };
  return { select: query, selectDistinct: query } as unknown as DrizzleClient;
}

/** The nodes' container snapshots. */
function snapshots(containers: Record<string, Array<Record<string, unknown>>>) {
  container.registerInstance(DockerSnapshotService, {
    getList: vi.fn(async (nodeId: string) => ({ data: containers[nodeId] ?? [] })),
  } as never);
}

afterEach(() => {
  container.reset();
});

describe('registry repository workloads', () => {
  it('reads the Git source of a build repository and the owner of a kept or promoted image', () => {
    expect(buildRepositorySourceBindingId(`gateway/builds/${BINDING}`)).toBe(BINDING);
    expect(buildRepositorySourceBindingId(`gateway/builds/${BINDING}/web`)).toBe(BINDING);
    expect(buildRepositorySourceBindingId('gateway/builds/not-a-source')).toBeNull();
    expect(buildRepositorySourceBindingId('tenant/app')).toBeNull();
    expect(artifactOwnerWorkloadTarget(`container:${NODE}:web`)).toEqual({
      kind: 'container',
      nodeId: NODE,
      containerName: 'web',
    });
    expect(artifactOwnerWorkloadTarget(`deployment:${DEPLOYMENT}`)).toEqual({
      kind: 'deployment',
      deploymentId: DEPLOYMENT,
    });
    expect(artifactOwnerWorkloadTarget('availability:policy')).toBeNull();
    expect(artifactOwnerWorkloadTarget(null)).toBeNull();
    const binding = { nodeId: NODE, containerName: 'web', deploymentId: null, composeProjectId: null };
    expect(sourceBindingWorkloadTarget({ ...binding, targetKind: 'pages_project' })).toBeNull();
    expect(
      sourceBindingWorkloadTarget({ ...binding, targetKind: 'compose_project', composeProjectId: PROJECT })
    ).toEqual({ kind: 'compose_project', composeProjectId: PROJECT });
  });

  it('resolves the workloads to the node and access resource their scopes name', async () => {
    const service = new RegistryRepositoryWorkloadService(
      queuedDb([
        // Artifacts of the repository: a build of the source and a promotion copy for a deployment.
        [
          { sourceBindingId: BINDING, ownerKey: null },
          { sourceBindingId: null, ownerKey: `deployment:${DEPLOYMENT}` },
        ],
        // The source builds for a container.
        [{ targetKind: 'container', nodeId: NODE, containerName: 'web', deploymentId: null, composeProjectId: null }],
        // No deployment, slot, Compose project or Docker node runs it besides.
        [],
        [],
        [],
        [],
        // The deployment's node, then the container's access resource.
        [{ nodeId: NODE }],
        [{ id: 'resource-1' }],
      ])
    );
    expect(await service.workloads(`gateway/builds/${BINDING}`)).toEqual([
      { kind: 'containers', nodeId: NODE, resourceId: DEPLOYMENT },
      { kind: 'containers', nodeId: NODE, resourceId: 'resource-1' },
    ]);
  });

  it('finds the workloads that run an image pushed from outside', async () => {
    snapshots({
      [NODE]: [
        { name: '/api', image: '127.0.0.1:5443/team/app:latest' },
        { name: 'other', image: '127.0.0.1:5443/team/app-two:latest' },
        { name: 'public', image: 'team/app:latest' },
      ],
    });
    const service = new RegistryRepositoryWorkloadService(
      queuedDb([
        // No artifact of the repository.
        [],
        // A deployment, a blue/green slot of another one, a Compose project (LIKE prefilter hits included).
        [
          { id: DEPLOYMENT, config: { image: `127.0.0.1:5443/team/app@sha256:${'a'.repeat(64)}` } },
          { id: BINDING, config: { image: '127.0.0.1:5443/team/apps:1' } },
        ],
        [{ deploymentId: BINDING, image: '127.0.0.1:5443/team/app:2', config: null }],
        [{ id: PROJECT, model: { name: 'stack', services: { web: { image: '127.0.0.1:5443/team/app:3' } } } }],
        [{ id: NODE }],
        // Resolution: both deployments' node, the project's node, the container's access resource.
        [{ nodeId: NODE }],
        [{ nodeId: NODE }],
        [{ nodeId: NODE }],
        [{ id: 'resource-api' }],
      ])
    );
    expect(await service.workloads('team/app')).toEqual([
      { kind: 'containers', nodeId: NODE, resourceId: DEPLOYMENT },
      { kind: 'containers', nodeId: NODE, resourceId: BINDING },
      { kind: 'compose', nodeId: NODE, resourceId: PROJECT },
      { kind: 'containers', nodeId: NODE, resourceId: 'resource-api' },
    ]);
  });

  it('finds no workload for a repository nothing uses', async () => {
    snapshots({});
    const service = new RegistryRepositoryWorkloadService(queuedDb([[], [], [], [], []]));
    expect(await service.workloads('tenant/app')).toEqual([]);
  });
});
