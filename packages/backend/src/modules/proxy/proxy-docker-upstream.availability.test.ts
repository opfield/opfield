import { describe, expect, it, vi } from 'vitest';
import { ProxyDockerUpstreamService } from './proxy-docker-upstream.service.js';

/** A Drizzle stand-in whose select chains answer, in order, with the queued rows. */
function queuedDb(results: unknown[][]) {
  const queue = [...results];
  const select = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'limit', 'innerJoin', 'orderBy']) chain[method] = () => chain;
    // biome-ignore lint/suspicious/noThenProperty: the chain is awaited like a Drizzle query.
    chain.then = (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(queue.shift() ?? []).then(resolve, reject);
    return chain;
  });
  return { select } as any;
}

const dockerNode = (id: string) => ({
  id,
  type: 'docker',
  status: 'offline',
  serviceAddresses: [],
  serviceAddress: null,
  lastHealthReport: null,
});

function upstreams(results: unknown[][], snapshot: unknown[] = []) {
  const snapshots = { getList: vi.fn().mockResolvedValue({ data: snapshot, revision: 3, refreshStatus: 'ok' }) };
  // Every Docker node is offline: the origin of a failed-over workload.
  const registry = { getNode: vi.fn().mockReturnValue(undefined) };
  return new ProxyDockerUpstreamService(queuedDb(results), snapshots as any, registry as any);
}

const options = { requireAvailable: true, followAvailability: true } as const;

describe('Route targets of Availability workloads (C-1)', () => {
  it('stores the logical container when the Route names a replica runtime on another node', async () => {
    const service = upstreams([
      [], // no policy whose source is node-b/gwav-container-1
      [
        {
          policy: { id: 'policy-1', sourceNodeId: 'node-a', containerName: 'app', mode: 'failover' },
          runtimeIdentity: { containerName: 'gwav-container-1' },
        },
      ],
      [dockerNode('node-a')],
    ]);

    const resolved = await service.resolve(
      {
        upstreamKind: 'docker_container',
        dockerNodeId: 'node-b',
        dockerContainerName: 'gwav-container-1',
        dockerContainerPort: 8080,
      },
      options
    );

    expect(resolved).toMatchObject({ dockerNodeId: 'node-a', dockerContainerName: 'app', dockerContainerPort: 8080 });
  });

  it('does not take a container that only shares the workload name on a replica node for it', async () => {
    const service = upstreams([
      [],
      [
        {
          policy: { id: 'policy-1', sourceNodeId: 'node-a', containerName: 'app', mode: 'failover' },
          runtimeIdentity: { containerName: 'gwav-container-1' },
        },
      ],
      [dockerNode('node-b')],
    ]);

    await expect(
      service.resolve(
        {
          upstreamKind: 'docker_container',
          dockerNodeId: 'node-b',
          dockerContainerName: 'app',
          dockerContainerPort: 80,
        },
        options
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'DOCKER_TARGET_UNAVAILABLE' });
  });

  it('keeps requiring an online node for a container without Availability', async () => {
    const service = upstreams([[], [], [dockerNode('node-a')]]);

    await expect(
      service.resolve(
        {
          upstreamKind: 'docker_container',
          dockerNodeId: 'node-a',
          dockerContainerName: 'web',
          dockerContainerPort: 80,
        },
        options
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'DOCKER_TARGET_UNAVAILABLE' });
  });

  it('stores the logical Compose project while its origin node is down', async () => {
    const service = upstreams([
      [{ id: 'project-1', name: 'shop', nodeId: 'node-a' }],
      [{ id: 'policy-1', portableSpec: { normalizedModel: { services: { web: {}, worker: {} } } } }],
      [
        { nodeId: 'node-a', runtimeIdentity: { containers: [{ serviceName: 'web', containerName: 'shop-web-1' }] } },
        {
          nodeId: 'node-b',
          runtimeIdentity: { containers: [{ serviceName: 'web', containerName: 'gwav-compose-x-web-1' }] },
        },
      ],
      [dockerNode('node-a')],
    ]);

    const resolved = await service.resolve(
      {
        upstreamKind: 'docker_container',
        dockerNodeId: 'node-b',
        dockerComposeProjectId: 'project-1',
        dockerComposeServiceName: 'web',
        dockerContainerPort: 3000,
      },
      options
    );

    expect(resolved).toMatchObject({
      dockerNodeId: 'node-a',
      dockerContainerName: 'shop-web-1',
      dockerComposeProjectId: 'project-1',
      dockerComposeServiceName: 'web',
    });
  });

  it('refuses a Compose service the Availability project does not have', async () => {
    const service = upstreams([
      [{ id: 'project-1', name: 'shop', nodeId: 'node-a' }],
      [{ id: 'policy-1', portableSpec: { normalizedModel: { services: { web: {} } } } }],
      [],
      [dockerNode('node-a')],
    ]);

    await expect(
      service.resolve(
        {
          upstreamKind: 'docker_container',
          dockerNodeId: 'node-a',
          dockerComposeProjectId: 'project-1',
          dockerComposeServiceName: 'missing',
          dockerContainerPort: 3000,
        },
        options
      )
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('resolves an Availability Deployment while its origin node is down', async () => {
    const service = upstreams([
      [{ id: 'deployment-1', nodeId: 'node-a' }],
      [{ id: 'policy-1' }],
      [dockerNode('node-a')],
      [{ containerPort: 8080, hostPort: 31000 }],
    ]);

    const resolved = await service.resolve(
      { upstreamKind: 'docker_deployment', dockerDeploymentId: 'deployment-1', dockerContainerPort: 8080 },
      options
    );

    expect(resolved).toMatchObject({
      dockerNodeId: 'node-a',
      dockerDeploymentId: 'deployment-1',
      dockerHostPort: 31000,
    });
  });

  it('keeps requiring an online node for a Deployment without Availability', async () => {
    const service = upstreams([[{ id: 'deployment-1', nodeId: 'node-a' }], [], [dockerNode('node-a')]]);

    await expect(
      service.resolve(
        { upstreamKind: 'docker_deployment', dockerDeploymentId: 'deployment-1', dockerContainerPort: 8080 },
        options
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'DOCKER_TARGET_UNAVAILABLE' });
  });
});
