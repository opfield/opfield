import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { INFERENCE_CORE_CALLBACK_PATHS } from './inference-core.contract.js';
import { inferenceCoreInternalRoutes } from './inference-core-internal.routes.js';
import { inferenceCoreListenHosts, startCoreListeners } from './inference-core-internal-listener.js';

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

describe('starting the core callback listeners', () => {
  it('skips an address that cannot be bound and serves on the others', async () => {
    const skipped: string[] = [];
    const result = await startCoreListeners(
      ['172.18.0.5', '10.9.0.2'],
      async (host) => {
        if (host === '172.18.0.5') throw new Error('EADDRNOTAVAIL');
        return { host };
      },
      (host) => skipped.push(host)
    );
    expect(result).toEqual({ servers: [{ host: '10.9.0.2' }], hosts: ['10.9.0.2'] });
    expect(skipped).toEqual(['172.18.0.5']);
  });

  it('fails startup when no address binds', async () => {
    const skipped: string[] = [];
    await expect(
      startCoreListeners(
        ['172.18.0.5', '10.9.0.2'],
        async () => {
          throw new Error('EADDRINUSE');
        },
        (host) => skipped.push(host)
      )
    ).rejects.toThrow('EADDRINUSE');
    expect(skipped).toEqual(['172.18.0.5', '10.9.0.2']);
  });
});
