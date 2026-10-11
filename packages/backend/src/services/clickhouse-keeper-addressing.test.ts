import { describe, expect, it } from 'vitest';
import {
  createKeeperPeerResolver,
  keeperLoopbackHost,
  memberInterserverPort,
  memberKeeperPort,
  memberKeeperServerId,
} from './clickhouse-keeper-addressing.js';

function fakeDb(results: unknown[][]) {
  let call = 0;
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => Promise.resolve(results[call++] ?? []),
  };
  return chain as never;
}

describe('ClickHouse Keeper addressing', () => {
  it('derives one stable loopback host per set, never 127.0.0.1', () => {
    const host = keeperLoopbackHost('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(host).toMatch(/^127\.\d+\.\d+\.1$/);
    expect(host).toBe(keeperLoopbackHost('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
    expect(host).not.toBe(keeperLoopbackHost('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
    expect(host).not.toBe('127.0.0.1');
  });

  it('gives each member its Keeper id, raft port and interserver port', () => {
    expect(memberKeeperServerId(0)).toBe(1);
    expect(memberKeeperPort(0)).toBe(39501);
    expect(memberKeeperPort(1)).toBe(39502);
    expect(memberInterserverPort(1)).toBe(39001);
  });

  it('resolves the witness peers from the members and their relay-originated routes', async () => {
    const setId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const db = fakeDb([
      [
        { id: 'm-b', memberIndex: 1 },
        { id: 'm-a', memberIndex: 0 },
      ],
      [
        { id: 'route-a', ownerId: 'w1>m-a' },
        { id: 'route-b', ownerId: 'w1>m-b' },
      ],
    ]);
    const resolved = await createKeeperPeerResolver(db)({ id: 'w1', setId } as never, {} as never);
    expect(Array.isArray(resolved)).toBe(false);
    const { peers, raftHost } = resolved as { peers: unknown[]; raftHost: string };
    expect(raftHost).toBe(keeperLoopbackHost(setId));
    expect(peers).toEqual([
      { serverId: 1, host: raftHost, port: 39501, routeId: 'route-a', assignmentGeneration: '0' },
      { serverId: 2, host: raftHost, port: 39502, routeId: 'route-b', assignmentGeneration: '0' },
    ]);
  });
});
