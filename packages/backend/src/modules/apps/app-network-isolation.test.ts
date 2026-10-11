import { describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import type { CommandResult } from '@/grpc/generated/types.js';
import { AppError } from '@/middleware/error-handler.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import {
  AppNetworkIsolation,
  DOCKER_NETWORK_ISOLATION_CAPABILITY,
  type IsolatedEndpoint,
} from './app-network-isolation.js';

const NO_NODE = Symbol('no node');

function fakeDb(capabilities: unknown): DrizzleClient {
  const rows = capabilities === NO_NODE ? [] : [{ capabilities }];
  const chain = { from: () => chain, where: () => chain, limit: async () => rows };
  return { select: () => chain } as unknown as DrizzleClient;
}

function commandResult(partial: Partial<CommandResult>): CommandResult {
  return { commandId: 'c1', success: true, error: '', detail: '', data: Buffer.alloc(0), ...partial };
}

function setup(
  result: Partial<CommandResult>,
  capabilities: unknown = { capabilities: [DOCKER_NETWORK_ISOLATION_CAPABILITY] }
) {
  const dispatch = {
    isolateContainerNetworks: vi.fn(async () => commandResult(result)),
    restoreContainerNetworks: vi.fn(async () => commandResult(result)),
  };
  const isolation = new AppNetworkIsolation(fakeDb(capabilities), dispatch as unknown as NodeDispatchService);
  return { isolation, dispatch };
}

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

const daemonEndpoint = {
  networkId: 'id-app',
  networkName: 'app-net',
  aliases: ['api'],
  ipv4Address: '172.20.0.5',
  ipv6Address: '',
  linkLocalIps: [],
  links: ['db:database'],
  driverOpts: { 'com.example.opt': '1' },
  macAddress: '',
  gwPriority: 10,
};

const endpoint: IsolatedEndpoint = {
  networkId: 'id-app',
  networkName: 'app-net',
  aliases: ['api'],
  ipv4Address: '172.20.0.5',
  ipv6Address: null,
  linkLocalIps: [],
  links: ['db:database'],
  driverOpts: { 'com.example.opt': '1' },
  macAddress: null,
  gwPriority: 10,
};

describe('app network isolation', () => {
  it('reports the capability from the node record', async () => {
    expect(await setup({}).isolation.supports('n1')).toBe(true);
    expect(await setup({}, { capabilities: ['docker_deployments_v1'] }).isolation.supports('n1')).toBe(false);
    expect(await setup({}, NO_NODE).isolation.supports('n1')).toBe(false);
  });

  it('refuses nodes without the capability before dispatching', async () => {
    const { isolation, dispatch } = setup({}, { capabilities: [] });
    const error = await appError(isolation.isolate('n1', 'app'));
    expect([error.statusCode, error.code, error.message]).toEqual([
      409,
      'NODE_UPDATE_REQUIRED',
      'Update the node to isolate containers',
    ]);
    expect((await appError(isolation.restore('n1', 'app', [endpoint]))).code).toBe('NODE_UPDATE_REQUIRED');
    expect(dispatch.isolateContainerNetworks).not.toHaveBeenCalled();
    expect(dispatch.restoreContainerNetworks).not.toHaveBeenCalled();
  });

  it('parses and normalizes the isolate detail', async () => {
    const { isolation, dispatch } = setup({
      detail: JSON.stringify({ networkMode: 'app-net', endpoints: [daemonEndpoint, { networkName: 'bridge' }] }),
    });
    const result = await isolation.isolate('n1', 'app');
    expect(dispatch.isolateContainerNetworks).toHaveBeenCalledWith('n1', 'app');
    expect(result.networkMode).toBe('app-net');
    expect(result.endpoints[0]).toEqual(endpoint);
    expect(result.endpoints[1]).toEqual({
      networkId: '',
      networkName: 'bridge',
      aliases: [],
      ipv4Address: null,
      ipv6Address: null,
      linkLocalIps: [],
      links: [],
      driverOpts: {},
      macAddress: null,
      gwPriority: null,
    });
  });

  it('maps daemon errors', async () => {
    const host = await appError(
      setup({ success: false, error: 'HOST_NETWORK: container app uses the host network mode' }).isolation.isolate(
        'n1',
        'app'
      )
    );
    expect([host.statusCode, host.code, host.message]).toEqual([
      409,
      'HOST_NETWORK',
      'container app uses the host network mode',
    ]);
    const failed = await appError(
      setup({ success: false, error: 'disconnect refused' }).isolation.isolate('n1', 'app')
    );
    expect([failed.statusCode, failed.code, failed.message]).toEqual([
      502,
      'NETWORK_ISOLATION_FAILED',
      'disconnect refused',
    ]);
    const invalid = await appError(setup({ detail: 'not json' }).isolation.isolate('n1', 'app'));
    expect(invalid.code).toBe('NETWORK_ISOLATION_FAILED');
  });

  it('sends the daemon wire shape on restore and returns per-network results', async () => {
    const { isolation, dispatch } = setup({
      detail: JSON.stringify({
        restored: ['app-net'],
        failed: [{ networkName: 'gone', networkId: 'id-gone', error: 'network gone not found' }],
      }),
    });
    const result = await isolation.restore('n1', 'app', [endpoint]);
    expect(dispatch.restoreContainerNetworks).toHaveBeenCalledWith('n1', 'app', [daemonEndpoint]);
    expect(result).toEqual({
      restored: ['app-net'],
      failed: [{ networkName: 'gone', networkId: 'id-gone', error: 'network gone not found' }],
    });
    const failed = await appError(
      setup({ success: false, error: 'No such container: app' }).isolation.restore('n1', 'app', [])
    );
    expect([failed.statusCode, failed.code]).toEqual([502, 'NETWORK_RESTORE_FAILED']);
  });
});
