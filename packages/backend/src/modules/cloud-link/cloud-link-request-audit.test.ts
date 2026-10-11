import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudRequestAudit } from './cloud-link.types.js';
import { CloudRequestAuditCoalescer } from './cloud-link-request-audit.js';

const read = (requestId: string, type = 'state', service?: string, ok = true): CloudRequestAudit => ({
  requestId,
  type,
  ...(service ? { service } : {}),
  ok,
  ...(ok ? {} : { error: 'failed' }),
  resultBytes: 100,
  durationMs: 5,
});

describe('cloud request audit coalescing', () => {
  afterEach(() => vi.useRealTimers());

  it('writes the first read, counts identical reads and writes their summary when the window closes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T10:00:00Z'));
    const written: CloudRequestAudit[] = [];
    const coalescer = new CloudRequestAuditCoalescer(async (_agent, audit) => {
      written.push(audit);
    });

    coalescer.record('a', read('r1'));
    vi.setSystemTime(new Date('2026-10-11T10:01:00Z'));
    coalescer.record('a', read('r2'));
    vi.setSystemTime(new Date('2026-10-11T10:02:00Z'));
    coalescer.record('a', read('r3'));
    coalescer.record('a', read('r4', 'logs', 'app'));
    coalescer.record('a', read('r5', 'state', undefined, false));
    expect(written.map((audit) => audit.requestId)).toEqual(['r1', 'r4', 'r5']);
    expect(coalescer.live()).toEqual([
      { openedBy: 'r1', repeats: 2, lastAt: '2026-10-11T10:02:00.000Z', repeatBytes: 200 },
    ]);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(written.at(-1)).toMatchObject({
      requestId: 'r3',
      type: 'state',
      ok: true,
      resultBytes: 200,
      summary: {
        count: 2,
        firstAt: '2026-10-11T10:01:00.000Z',
        lastAt: '2026-10-11T10:02:00.000Z',
        openedBy: 'r1',
        firstRequestId: 'r2',
        lastRequestId: 'r3',
      },
    });
    expect(written).toHaveLength(4);
    expect(coalescer.live()).toEqual([]);

    coalescer.record('a', read('r6'));
    expect(written.at(-1)?.requestId).toBe('r6');
  });

  it('writes the open summaries when the socket stops or Gateway shuts down', async () => {
    const written: CloudRequestAudit[] = [];
    const coalescer = new CloudRequestAuditCoalescer(async (_agent, audit) => {
      written.push(audit);
    });
    coalescer.record('a', read('r1', 'logs', 'relay'));
    coalescer.record('a', read('r2', 'logs', 'relay'));
    coalescer.record('a', read('r3', 'logs', 'app'));
    await coalescer.flush();
    expect(written.map((audit) => [audit.requestId, audit.summary?.count ?? 1])).toEqual([
      ['r1', 1],
      ['r3', 1],
      ['r2', 1],
    ]);
    expect(written[2]?.summary?.openedBy).toBe('r1');
    await coalescer.flush();
    expect(written).toHaveLength(3);
  });

  it('never coalesces actions', async () => {
    const written: CloudRequestAudit[] = [];
    const coalescer = new CloudRequestAuditCoalescer(async (_agent, audit) => {
      written.push(audit);
    });
    for (const id of ['a1', 'a2', 'a3']) coalescer.record('a', read(id, 'node-token'));
    coalescer.record('a', read('u1', 'update-status'));
    coalescer.record('a', read('u2', 'update-status'));
    await coalescer.flush();
    expect(written.map((audit) => audit.requestId)).toEqual(['a1', 'a2', 'a3', 'u1', 'u2']);
    expect(written.at(-1)?.summary?.count).toBe(1);
  });
});
