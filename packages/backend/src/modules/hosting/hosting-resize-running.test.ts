// The schema barrel first, in its production order: the per-table modules import each other circularly.
import '@/db/schema/index.js';
import { describe, expect, it } from 'vitest';
import { advertisedHostingCapabilities, assertHostingActionPreconditions } from './hosting-action-preconditions.js';
import type { HostingRequestOptions } from './hosting-http.js';
import { hostingConfirmationExpired } from './hosting-operations.service.js';
import {
  type HostingActionRequest,
  type HostingConnection,
  type HostingResourceSnapshot,
  hostingCapabilities,
} from './hosting-provider.types.js';
import { ProxmoxHostingAdapter } from './providers/proxmox.js';

function guest(kind: 'ct' | 'vm', powerState: HostingResourceSnapshot['powerState']): HostingResourceSnapshot {
  return {
    remoteId: '101',
    kind,
    name: 'guest',
    location: 'pve',
    powerState,
    cpu: 2,
    memoryMb: 2048,
    diskGb: 10,
    addresses: [],
    incarnation: 'ctime:1',
    capabilities: hostingCapabilities({ resize: true }),
    observedAt: new Date().toISOString(),
  };
}
const target = (live: HostingResourceSnapshot) => ({
  provider: 'proxmox' as const,
  live,
  bound: [],
  canBootstrap: false,
});
const resize = (input: Partial<HostingActionRequest>): HostingActionRequest => ({ action: 'resize', ...input });

describe('resize while the guest runs', () => {
  it('lets a running container grow its disk and nothing else', () => {
    const running = guest('ct', 'running');
    expect(() => assertHostingActionPreconditions(target(running), resize({ diskGb: 20 }))).not.toThrow();
    // An unchanged CPU or memory value is not a change.
    expect(() =>
      assertHostingActionPreconditions(target(running), resize({ diskGb: 20, cpu: 2, memoryMb: 2048 }))
    ).not.toThrow();
    expect(() => assertHostingActionPreconditions(target(running), resize({ cpu: 4 }))).toThrowError(
      expect.objectContaining({ statusCode: 409, code: 'HOSTING_VM_MUST_STOP' })
    );
    expect(() =>
      assertHostingActionPreconditions(target(running), resize({ diskGb: 20, memoryMb: 4096 }))
    ).toThrowError(expect.objectContaining({ code: 'HOSTING_VM_MUST_STOP' }));
  });

  it('keeps the stop requirement for a running QEMU VM, even for a disk', () => {
    expect(() => assertHostingActionPreconditions(target(guest('vm', 'running')), resize({ diskGb: 20 }))).toThrowError(
      expect.objectContaining({ statusCode: 409, code: 'HOSTING_VM_MUST_STOP' })
    );
    expect(() =>
      assertHostingActionPreconditions(target(guest('vm', 'stopped')), resize({ diskGb: 20 }))
    ).not.toThrow();
  });

  it('refuses to shrink a disk running or not', () => {
    for (const power of ['running', 'stopped'] as const)
      expect(() => assertHostingActionPreconditions(target(guest('ct', power)), resize({ diskGb: 5 }))).toThrowError(
        expect.objectContaining({ statusCode: 400, code: 'HOSTING_DISK_SHRINK_UNSUPPORTED' })
      );
  });

  it('advertises the stop requirement and keeps the action available', () => {
    const ct = advertisedHostingCapabilities('proxmox', guest('ct', 'running')).resize;
    expect(ct).toMatchObject({ available: true, stopRequired: 'cpu_memory' });
    expect(ct.reason).toBeTruthy();
    expect(advertisedHostingCapabilities('proxmox', guest('vm', 'running')).resize.stopRequired).toBe('always');
    expect(advertisedHostingCapabilities('proxmox', guest('vm', 'stopped')).resize.stopRequired).toBeUndefined();
  });

  it('grows the disk of a running container through the Proxmox resize endpoint', async () => {
    const calls: Array<{ path: string; options?: HostingRequestOptions }> = [];
    const http = {
      async request(path: string, options?: HostingRequestOptions) {
        calls.push({ path, options });
        return { data: path.endsWith('/config') ? {} : null };
      },
    };
    const adapter = new ProxmoxHostingAdapter(
      {
        provider: 'proxmox',
        baseUrl: 'https://pve.test:8006',
        token: 'x',
        settings: { kind: 'hosting' },
      } as unknown as HostingConnection,
      http as never
    );
    const operation = await adapter.action(guest('ct', 'running'), resize({ diskGb: 20 }));
    expect(operation.status).toBe('succeeded');
    const writes = calls.filter((call) => call.options?.method === 'PUT');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      path: '/api2/json/nodes/pve/lxc/101/resize',
      options: { body: { disk: 'rootfs', size: '20G' } },
    });
    await expect(adapter.action(guest('ct', 'running'), resize({ cpu: 4 }))).rejects.toMatchObject({
      code: 'HOSTING_VM_MUST_STOP',
    });
  });
});

describe('an action nothing can confirm', () => {
  it('never sends a reboot to a stopped guest', () => {
    expect(() => assertHostingActionPreconditions(target(guest('vm', 'stopped')), { action: 'reboot' })).toThrowError(
      expect.objectContaining({ code: 'HOSTING_VM_STOPPED' })
    );
  });

  it('stops holding the VM after the confirmation window, except for teardown of a VM already gone', () => {
    const dispatchStartedAt = new Date(0);
    const row = { phase: 'unknown' as const, dispatchStartedAt, result: {} };
    expect(hostingConfirmationExpired(row, 9 * 60_000)).toBe(false);
    expect(hostingConfirmationExpired(row, 11 * 60_000)).toBe(true);
    expect(hostingConfirmationExpired({ ...row, phase: 'provisioning' }, 11 * 60_000)).toBe(false);
    expect(hostingConfirmationExpired({ ...row, result: { providerDeleted: true } }, 11 * 60_000)).toBe(false);
    // The provider said "still running" four minutes ago: the window counts from that report.
    expect(hostingConfirmationExpired({ ...row, result: { providerRunningAt: 7 * 60_000 } }, 11 * 60_000)).toBe(false);
    expect(hostingConfirmationExpired({ ...row, result: { providerRunningAt: 7 * 60_000 } }, 18 * 60_000)).toBe(true);
  });
});
