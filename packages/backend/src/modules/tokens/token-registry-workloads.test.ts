import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
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

  it('finds no workload for a repository Opfield did not create', async () => {
    const service = new RegistryRepositoryWorkloadService(queuedDb([[]]));
    expect(await service.workloads('tenant/app')).toEqual([]);
  });
});
