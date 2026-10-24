import { describe, expect, it, vi } from 'vitest';
import { acquireHostingFirewallLock, lockHostingFirewalls } from './hosting-firewall-lock.js';

function tx(execute: (call: number) => unknown, active: unknown[] = []) {
  let call = 0;
  return {
    execute: vi.fn(async () => execute(call++)),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => active }) }) }),
  } as never;
}

describe('hosting firewall lock', () => {
  it('waits for a running synchronization instead of refusing at once', async () => {
    const executor = tx((call) => (call === 0 ? { rows: [{ value: '0' }] } : { rows: [] }));
    await acquireHostingFirewallLock(executor, 'res-1', 30_000);
    // current lock_timeout, set it, the blocking lock, restore it
    expect((executor as { execute: ReturnType<typeof vi.fn> }).execute).toHaveBeenCalledTimes(4);
  });

  it('answers 409 HOSTING_FIREWALL_BUSY when the wait ends', async () => {
    const executor = tx((call) => {
      if (call === 0) return { rows: [{ value: '0' }] };
      if (call === 2) throw Object.assign(new Error('Failed query'), { cause: { code: '55P03' } });
      return { rows: [] };
    });
    await expect(acquireHostingFirewallLock(executor, 'res-1', 1_000)).rejects.toMatchObject({
      statusCode: 409,
      code: 'HOSTING_FIREWALL_BUSY',
    });
    const now = tx(() => ({ rows: [{ acquired: false }] }));
    await expect(acquireHostingFirewallLock(now, 'res-1', 0)).rejects.toMatchObject({ code: 'HOSTING_FIREWALL_BUSY' });
  });

  it('lets a deletion pass pending firewall changes, not other changes', async () => {
    const execute = (call: number) => (call % 4 === 0 ? { rows: [{ value: '0' }] } : { rows: [] });
    await expect(
      lockHostingFirewalls(tx(execute, [{ id: 'res-1' }]), ['res-1'], { deleting: true })
    ).resolves.toBeUndefined();
    await expect(lockHostingFirewalls(tx(execute, [{ id: 'res-1' }]), ['res-1'])).rejects.toMatchObject({
      code: 'HOSTING_FIREWALL_BUSY',
    });
  });
});
