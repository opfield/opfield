import { describe, expect, it, vi } from 'vitest';
import { ProxySecureLinkService } from './proxy-secure-link.service.js';

const NETWORK = 'opfield-link-df2241dc0011aabb';
const CONNECTOR = '9468a2a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8';
const STALE = `detach secure-link connector from ${NETWORK}: Error response from daemon: container ${CONNECTOR} is not connected to the network ${NETWORK}`;

function service(dispatch: Record<string, unknown>) {
  const secureLinks = new ProxySecureLinkService({} as never, dispatch as never, {} as never, 'connector@sha256:test');
  return secureLinks as unknown as {
    sendTargetSecureLinks(nodeId: string, bindings: unknown[]): Promise<{ success: boolean; error?: string }>;
  };
}

describe('secure-link set for a connector that already left a network', () => {
  it('attaches the connector again so the daemon can detach it, then sends the set again', async () => {
    const sendProxySecureLinks = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: STALE })
      .mockResolvedValueOnce({ success: true, detail: '[]' });
    const sendDockerNetworkCommand = vi.fn().mockResolvedValue({ success: true });
    const result = await service({ sendProxySecureLinks, sendDockerNetworkCommand }).sendTargetSecureLinks('node', []);
    expect(result.success).toBe(true);
    expect(sendDockerNetworkCommand).toHaveBeenCalledWith('node', 'connect', {
      networkId: NETWORK,
      containerId: CONNECTOR,
    });
    expect(sendProxySecureLinks).toHaveBeenCalledTimes(2);
  });

  it('repairs a network once and leaves any other failure to the caller', async () => {
    const sendProxySecureLinks = vi.fn().mockResolvedValue({ success: false, error: STALE });
    const sendDockerNetworkCommand = vi.fn().mockResolvedValue({ success: true });
    const result = await service({ sendProxySecureLinks, sendDockerNetworkCommand }).sendTargetSecureLinks('node', []);
    expect(result).toEqual({ success: false, error: STALE });
    expect(sendDockerNetworkCommand).toHaveBeenCalledTimes(1);

    const other = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'resolve secure-link x: target container is unavailable' });
    const connect = vi.fn();
    await service({ sendProxySecureLinks: other, sendDockerNetworkCommand: connect }).sendTargetSecureLinks('node', []);
    expect(connect).not.toHaveBeenCalled();
  });

  it('creates a removed link network for the connector to leave, then removes it again', async () => {
    const sendProxySecureLinks = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: STALE })
      .mockResolvedValueOnce({ success: true, detail: '[]' });
    let connects = 0;
    const sendDockerNetworkCommand = vi.fn(async (_node: string, action: string) => {
      if (action === 'connect' && ++connects === 1) {
        return { success: false, error: `network connect: Error response from daemon: network ${NETWORK} not found` };
      }
      return { success: true };
    });
    const result = await service({ sendProxySecureLinks, sendDockerNetworkCommand }).sendTargetSecureLinks('node', []);
    expect(result.success).toBe(true);
    expect(sendDockerNetworkCommand.mock.calls.map(([, action]) => action)).toEqual([
      'connect',
      'create',
      'connect',
      'remove',
    ]);
  });
});
