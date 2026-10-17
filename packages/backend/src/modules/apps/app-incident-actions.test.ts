import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import type { AppIncidentItem } from '@/db/schema/index.js';
import { ManagedDatabaseBindingService } from '@/modules/databases/managed-database-bindings.service.js';
import { DockerManagementService } from '@/modules/docker/docker.service.js';
import { DockerSnapshotReconciler } from '@/modules/docker/docker-snapshot-reconciler.service.js';
import {
  DELETED_WHILE_SHUT_DOWN,
  DefaultAppIncidentActions,
  networkRestoreNotes,
  splitGoneNetworks,
} from './app-incident-actions.js';
import type { AppIncidentConsumerEnv } from './app-incident-consumer-env.js';
import type { NetworkRestoreResult } from './app-network-isolation.js';
import { LEGACY_DATABASE_LINK_NETWORK_PREFIX } from '@/lib/legacy-compat.js';

const CONTEXT = { incidentId: 'incident-1', userId: 'user-1' };

function item(overrides: Partial<AppIncidentItem>): AppIncidentItem {
  return {
    id: 'item-1',
    incidentId: 'incident-1',
    itemKind: 'container_network',
    itemKey: 'container:n1:api',
    phase: 40,
    ref: { nodeId: 'n1', name: 'api' },
    priorState: null,
    status: 'applied',
    attempts: 1,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function restoreResult(overrides: Partial<NetworkRestoreResult> = {}): NetworkRestoreResult {
  return { restored: [], gone: [], failed: [], networkModeGone: null, fallbackNetwork: null, ...overrides };
}

/** A database answering every `select … limit` with `rows`. */
function db(rows: unknown[] = []) {
  const chain = { from: () => chain, where: () => chain, orderBy: () => chain, limit: async () => rows };
  return { select: () => chain };
}

/** Actions over fakes: a Docker service, network isolation and the consumer variables of the incident's bindings. */
function setup(
  options: { rows?: unknown[]; restore?: NetworkRestoreResult; leftByGoneBindings?: string[]; envs?: string[][] } = {}
) {
  // Each inspect answers the next environment; the last one stays.
  const envs = [...(options.envs ?? [['MODE=production']])];
  let lastEnv: string[] = [];
  const docker = {
    inspectContainer: vi.fn(async () => {
      lastEnv = envs.shift() ?? lastEnv;
      return { Id: 'runtime-1', State: { Running: true, Status: 'running' }, Config: { Env: lastEnv } };
    }),
    updateContainerEnv: vi.fn(async () => ({ taskId: 'task-1' })),
    getContainerTransition: vi.fn().mockReturnValueOnce('updating').mockReturnValue(undefined),
    startContainer: vi.fn(),
  };
  container.registerInstance(DockerManagementService, docker as unknown as DockerManagementService);
  const snapshots = { refreshContainerNow: vi.fn(async () => undefined) };
  container.registerInstance(DockerSnapshotReconciler, snapshots as unknown as DockerSnapshotReconciler);
  const network = {
    restore: vi.fn(async () => options.restore ?? restoreResult()),
    isolate: vi.fn(async () => ({
      networkMode: 'bridge',
      endpoints: [{ networkId: 'id-bridge', networkName: 'bridge' }],
    })),
  };
  const consumerEnv = {
    record: vi.fn(async () => ({ consumer: { nodeId: 'n1', name: 'api', env: ['REDIS_URL'] } })),
    leftByGoneBindings: vi.fn(async () => options.leftByGoneBindings ?? []),
  };
  const maintenance = { applyModes: vi.fn(async () => undefined) };
  const actions = new DefaultAppIncidentActions(
    db(options.rows) as never,
    maintenance as never,
    network as never,
    consumerEnv as unknown as AppIncidentConsumerEnv
  );
  (actions as unknown as { envRecreateWait: { timeoutMs: number; pollMs: number } }).envRecreateWait = {
    timeoutMs: 1_000,
    pollMs: 1,
  };
  return { actions, docker, network, consumerEnv, maintenance, snapshots };
}

const ISOLATED = item({
  priorState: {
    networkMode: `${LEGACY_DATABASE_LINK_NETWORK_PREFIX}fbde43aa00000000`,
    endpoints: [
      { networkId: 'id-db', networkName: `${LEGACY_DATABASE_LINK_NETWORK_PREFIX}fbde43aa00000000` },
      { networkId: 'id-bridge', networkName: 'bridge' },
    ],
  },
});

afterEach(() => {
  container.reset();
});

describe('Kill switch release of a container', () => {
  it('counts a network removed meanwhile as gone, says so and never fails the item for it', async () => {
    const { actions, network } = setup({
      restore: restoreResult({
        restored: ['bridge'],
        gone: [`${LEGACY_DATABASE_LINK_NETWORK_PREFIX}fbde43aa00000000`],
        networkModeGone: `${LEGACY_DATABASE_LINK_NETWORK_PREFIX}fbde43aa00000000`,
      }),
    });
    await expect(actions.restore(ISOLATED, CONTEXT)).resolves.toEqual({
      status: 'restored',
      detail:
        `Skipped network ${LEGACY_DATABASE_LINK_NETWORK_PREFIX}fbde43aa00000000: it no longer exists. ` +
        `Primary network ${LEGACY_DATABASE_LINK_NETWORK_PREFIX}fbde43aa00000000 is gone; the container keeps its other networks`,
    });
    const endpoints = (ISOLATED.priorState as { endpoints: unknown }).endpoints;
    expect(network.restore).toHaveBeenCalledWith('n1', 'api', endpoints);
  });

  it('names the network a container whose primary network is gone was put on', async () => {
    const { actions } = setup({
      restore: restoreResult({
        gone: [`${LEGACY_DATABASE_LINK_NETWORK_PREFIX}fbde43aa00000000`],
        networkModeGone: `${LEGACY_DATABASE_LINK_NETWORK_PREFIX}fbde43aa00000000`,
        fallbackNetwork: 'bridge',
      }),
    });
    const outcome = await actions.restore(ISOLATED, CONTEXT);
    expect(outcome).toMatchObject({ status: 'restored' });
    expect((outcome as { detail?: string }).detail).toContain(
      `Primary network ${LEGACY_DATABASE_LINK_NETWORK_PREFIX}fbde43aa00000000 is gone, so the container is on bridge now`
    );
  });

  it('treats a missing network an older daemon reports as failed as gone, and fails on a real error', async () => {
    const legacy = setup({
      restore: restoreResult({
        restored: ['bridge'],
        failed: [
          {
            networkName: `${LEGACY_DATABASE_LINK_NETWORK_PREFIX}fbde43aa00000000`,
            networkId: 'id-db',
            error: 'Error response from daemon: network id-db not found',
          },
        ],
      }),
    });
    await expect(legacy.actions.restore(ISOLATED, CONTEXT)).resolves.toMatchObject({ status: 'restored' });

    const broken = setup({
      restore: restoreResult({
        failed: [{ networkName: 'bridge', networkId: 'id-bridge', error: 'endpoint is busy' }],
      }),
    });
    await expect(broken.actions.restore(ISOLATED, CONTEXT)).rejects.toThrow(
      'Networks not restored: bridge: endpoint is busy'
    );
  });

  it('is gone when the container no longer exists', async () => {
    const { actions, docker, network } = setup();
    const missing = Object.assign(new Error('No such container: api'), { statusCode: 404 });
    docker.inspectContainer.mockRejectedValueOnce(missing);
    await expect(actions.restore(ISOLATED, CONTEXT)).resolves.toEqual({ status: 'gone' });
    expect(network.restore).not.toHaveBeenCalled();
  });

  it('removes the variables a binding removed meanwhile left on the container, as its removal does', async () => {
    const { actions, docker, consumerEnv } = setup({
      restore: restoreResult({ restored: ['bridge'] }),
      leftByGoneBindings: ['REDIS_URL', 'REDIS_HOST'],
      envs: [
        ['MODE=production', 'REDIS_URL=redis://u:p@db-fbde43aa00000000:6379'],
        ['MODE=production', 'REDIS_URL=redis://u:p@db-fbde43aa00000000:6379'],
        ['MODE=production'],
      ],
    });
    await expect(actions.restore(ISOLATED, CONTEXT)).resolves.toEqual({
      status: 'restored',
      detail: 'Removed REDIS_URL left by removed bindings',
    });
    expect(consumerEnv.leftByGoneBindings).toHaveBeenCalledWith('incident-1', 'n1', 'api');
    expect(docker.updateContainerEnv).toHaveBeenCalledWith('n1', 'api', undefined, ['REDIS_URL'], 'user-1');
  });

  it('keeps the item retried while the left-over variables are still on the container', async () => {
    const { actions } = setup({
      leftByGoneBindings: ['REDIS_URL'],
      envs: [['REDIS_URL=redis://old']],
    });
    await expect(actions.restore(item({ priorState: { endpoints: [] } }), CONTEXT)).rejects.toThrow(
      'Variables of removed bindings not removed yet: REDIS_URL'
    );
  });

  it('touches no environment when no removed binding left anything', async () => {
    const { actions, docker } = setup({ restore: restoreResult({ restored: ['bridge'] }) });
    await expect(actions.restore(ISOLATED, CONTEXT)).resolves.toEqual({ status: 'restored' });
    expect(docker.updateContainerEnv).not.toHaveBeenCalled();
  });
});

describe('Container snapshot after isolation and release', () => {
  it('reads a released container back at once, so its detail shows the restored networks', async () => {
    const { actions, network, snapshots } = setup({ restore: restoreResult({ restored: ['bridge'] }) });
    await expect(actions.restore(ISOLATED, CONTEXT)).resolves.toEqual({ status: 'restored' });
    expect(snapshots.refreshContainerNow).toHaveBeenCalledWith('n1', ['api', 'runtime-1']);
    expect(snapshots.refreshContainerNow.mock.invocationCallOrder[0]).toBeGreaterThan(
      network.restore.mock.invocationCallOrder[0]!
    );
  });

  it('reads back the networks a partial restore put back before the item fails', async () => {
    const { actions, snapshots } = setup({
      restore: restoreResult({
        restored: [`${LEGACY_DATABASE_LINK_NETWORK_PREFIX}fbde43aa00000000`],
        failed: [{ networkName: 'bridge', networkId: 'id-bridge', error: 'endpoint is busy' }],
      }),
    });
    await expect(actions.restore(ISOLATED, CONTEXT)).rejects.toThrow('Networks not restored');
    expect(snapshots.refreshContainerNow).toHaveBeenCalledWith('n1', ['api', 'runtime-1']);
  });

  it('reads an isolated container back at once, so its detail shows no networks', async () => {
    const { actions, network, snapshots } = setup();
    const isolating = item({ status: 'pending', priorState: null });
    await expect(actions.apply(isolating, CONTEXT)).resolves.toMatchObject({ status: 'applied' });
    expect(network.isolate).toHaveBeenCalledWith('n1', 'api');
    expect(snapshots.refreshContainerNow).toHaveBeenCalledWith('n1', ['api', 'runtime-1']);
  });

  it('still restores when the read-back is not available', async () => {
    const { actions, snapshots } = setup({ restore: restoreResult({ restored: ['bridge'] }) });
    snapshots.refreshContainerNow.mockRejectedValueOnce(new Error('snapshot store down'));
    await expect(actions.restore(ISOLATED, CONTEXT)).resolves.toEqual({ status: 'restored' });
  });
});

describe('Kill switch release of other items', () => {
  it('is gone for a route overlay whose route was deleted', async () => {
    const { actions, maintenance } = setup({ rows: [] });
    const overlay = item({ itemKind: 'route_overlay', ref: { routeId: 'r1' }, priorState: null });
    await expect(actions.restore(overlay, CONTEXT)).resolves.toEqual({ status: 'gone' });
    expect(maintenance.applyModes).not.toHaveBeenCalled();
  });

  it('is gone for a binding removed between the check and the resume', async () => {
    const { actions } = setup({ rows: [{ desiredState: 'suspended' }] });
    container.registerInstance(ManagedDatabaseBindingService, {
      resumeFromIncident: vi.fn(async () => false),
    } as unknown as ManagedDatabaseBindingService);
    const prior = { desiredState: 'active' };
    const binding = item({ itemKind: 'database_binding', ref: { bindingId: 'b1' }, priorState: prior });
    await expect(actions.restore(binding, CONTEXT)).resolves.toEqual({ status: 'gone' });
  });

  it('records the consumer container and variables of a binding when it applies', async () => {
    const { actions, consumerEnv } = setup();
    container.registerInstance(ManagedDatabaseBindingService, {
      suspendForIncident: vi.fn(async () => ({ desiredState: 'active' })),
    } as unknown as ManagedDatabaseBindingService);
    const binding = item({ itemKind: 'database_binding', ref: { bindingId: 'b1' }, status: 'pending' });
    await expect(actions.apply(binding, CONTEXT)).resolves.toEqual({
      status: 'applied',
      priorState: { desiredState: 'active', consumer: { nodeId: 'n1', name: 'api', env: ['REDIS_URL'] } },
    });
    expect(consumerEnv.record).toHaveBeenCalledWith('database_binding', 'b1');
  });
});

describe('Start after a shutdown, with members changed while it was shut down', () => {
  const STOPPED = item({
    itemKind: 'container_stop',
    itemKey: 'container:n1:api',
    phase: 20,
    ref: { nodeId: 'n1', name: 'api', label: 'api' },
    priorState: { state: 'running', containerId: 'runtime-1' },
  });
  const missing = () => Object.assign(new Error('No such container'), { statusCode: 404 });
  const exited = (id: string, name: string) => ({
    Id: id,
    Name: `/${name}`,
    State: { Running: false, Status: 'exited' },
  });

  it('records the runtime ID of a container it stops', async () => {
    const { actions, docker } = setup();
    (docker as any).stopContainer = vi.fn();
    await expect(actions.apply({ ...STOPPED, priorState: null, status: 'pending' }, CONTEXT)).resolves.toEqual({
      status: 'applied',
      priorState: { state: 'running', containerId: 'runtime-1' },
    });
  });

  it('starts a container recreated under its name as the same container', async () => {
    const { actions, docker } = setup();
    docker.inspectContainer.mockResolvedValueOnce(exited('runtime-2', 'api') as never);
    await expect(actions.restore(STOPPED, CONTEXT)).resolves.toEqual({ status: 'restored' });
    expect(docker.startContainer).toHaveBeenCalledWith('n1', 'api', 'user-1', { appIncident: true });
  });

  it('finds a container renamed meanwhile by its runtime ID and starts it', async () => {
    const { actions, docker } = setup();
    docker.inspectContainer
      .mockRejectedValueOnce(missing())
      .mockResolvedValueOnce(exited('runtime-1', 'api-old') as never);
    await expect(actions.restore(STOPPED, CONTEXT)).resolves.toEqual({
      status: 'restored',
      detail: 'Renamed to api-old while the app was shut down',
    });
    expect(docker.inspectContainer).toHaveBeenLastCalledWith('n1', 'runtime-1');
    expect(docker.startContainer).toHaveBeenCalledWith('n1', 'runtime-1', 'user-1', { appIncident: true });
  });

  it('follows a container migrated meanwhile to its new node', async () => {
    const { actions, docker } = setup({ rows: [{ targetNodeId: 'n2', cutoverAt: new Date(Date.now() + 1_000) }] });
    docker.inspectContainer.mockResolvedValueOnce(exited('runtime-9', 'api') as never);
    await expect(actions.restore(STOPPED, CONTEXT)).resolves.toEqual({
      status: 'restored',
      detail: 'Migrated to another node while the app was shut down',
    });
    expect(docker.inspectContainer).toHaveBeenCalledWith('n2', 'api');
    expect(docker.startContainer).toHaveBeenCalledWith('n2', 'api', 'user-1', { appIncident: true });
  });

  it('skips a container deleted meanwhile and says so', async () => {
    const { actions, docker } = setup();
    docker.inspectContainer.mockRejectedValueOnce(missing()).mockRejectedValueOnce(missing());
    await expect(actions.restore(STOPPED, CONTEXT)).resolves.toEqual({
      status: 'gone',
      detail: DELETED_WHILE_SHUT_DOWN,
    });
    expect(docker.startContainer).not.toHaveBeenCalled();
  });

  it('skips a deployment, Compose project, database or storage deleted meanwhile and says so', async () => {
    const { actions } = setup({ rows: [] });
    const stopped = [
      item({ itemKind: 'deployment_stop', ref: { deploymentId: 'd1' }, priorState: { status: 'ready' } }),
      item({ itemKind: 'compose_stop', ref: { projectId: 'p1' }, priorState: { status: 'running' } }),
      item({ itemKind: 'database_pause', ref: { databaseId: 'db1' }, priorState: { status: 'ready' } }),
      item({ itemKind: 'storage_pause', ref: { storageId: 's1' }, priorState: { status: 'ready' } }),
    ];
    for (const entry of stopped) {
      await expect(actions.restore(entry, CONTEXT)).resolves.toEqual({
        status: 'gone',
        detail: DELETED_WHILE_SHUT_DOWN,
      });
    }
  });
});

describe('Network restore notes', () => {
  it('splits gone networks from failures and words the detail', () => {
    const split = splitGoneNetworks(
      restoreResult({
        gone: ['a'],
        failed: [
          { networkName: 'b', networkId: 'id-b', error: 'Error: No such network: b' },
          { networkName: '', networkId: 'id-c', error: 'network id-c not found' },
          { networkName: 'd', networkId: 'id-d', error: 'permission denied' },
        ],
      })
    );
    expect(split.gone).toEqual(['a', 'b', 'id-c']);
    expect(split.failed.map((failure) => failure.networkName)).toEqual(['d']);
    expect(networkRestoreNotes(split.gone, restoreResult())).toEqual([
      'Skipped networks that no longer exist: a, b, id-c',
    ]);
    expect(networkRestoreNotes([], restoreResult())).toEqual([]);
  });
});
