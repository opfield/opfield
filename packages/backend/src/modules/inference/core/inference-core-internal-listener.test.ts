import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { INFERENCE_CORE_CALLBACK_PATHS } from './inference-core.contract.js';
import { inferenceCoreInternalRoutes } from './inference-core-internal.routes.js';
import { inferenceCoreListenHosts } from './inference-core-internal-listener.js';

const entry = (address: string, family: 'IPv4' | 'IPv6', internal = false) =>
  ({ address, family, internal, netmask: '', mac: '', cidr: null }) as never;

describe('core callback listener addresses', () => {
  it('binds the container addresses of every attached network, never the wildcard', () => {
    const hosts = inferenceCoreListenHosts({
      inContainer: true,
      interfaces: {
        lo: [entry('127.0.0.1', 'IPv4', true), entry('::1', 'IPv6', true)],
        eth0: [entry('172.18.0.5', 'IPv4'), entry('fe80::1', 'IPv6')],
        eth1: [entry('10.9.0.2', 'IPv4'), entry('fd00::2', 'IPv6')],
      },
    });
    expect(hosts).toEqual(['172.18.0.5', '10.9.0.2', 'fd00::2']);
    expect(hosts).not.toContain('0.0.0.0');
  });

  it('stays on loopback outside a container, where no core can run', () => {
    expect(
      inferenceCoreListenHosts({ inContainer: false, interfaces: { eth0: [entry('192.168.1.10', 'IPv4')] } })
    ).toEqual(['127.0.0.1']);
  });

  it('falls back to loopback in a container without a network', () => {
    expect(
      inferenceCoreListenHosts({ inContainer: true, interfaces: { lo: [entry('127.0.0.1', 'IPv4', true)] } })
    ).toEqual(['127.0.0.1']);
  });

  it('pins the address an operator names', () => {
    expect(inferenceCoreListenHosts({ override: ' 10.0.0.7 ', inContainer: false, interfaces: {} })).toEqual([
      '10.0.0.7',
    ]);
  });
});

describe('core callback body size', () => {
  it('refuses a body above 1 MiB before the signature is read', async () => {
    const response = await inferenceCoreInternalRoutes.request(INFERENCE_CORE_CALLBACK_PATHS.settlement, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024) },
      body: 'x'.repeat(2 * 1024 * 1024),
    });
    expect(response.status).toBe(413);
  });
});
