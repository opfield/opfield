import { describe, expect, it } from 'vitest';
import { keeperLoopbackHost } from './clickhouse-keeper-addressing.js';
import { planNodeKeeperWitnesses } from './node-keeper-witness.service.js';

describe('Keeper witness containers on docker nodes', () => {
  it('runs each witness on its stored raft port with its routes to the members', () => {
    const setId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const host = keeperLoopbackHost(setId);
    const specs = planNodeKeeperWitnesses(
      [{ id: 'w1', setId, nodeId: 'n1', keeperServerId: 1001, relayLocalPort: 39433, artifactVersion: '25.8.28.1' }],
      new Map([
        [
          'w1',
          {
            raftHost: host,
            peers: [
              { serverId: 1, host, port: 39501, routeId: 'route-a', assignmentGeneration: '0' },
              { serverId: 2, host, port: 39502, routeId: '', assignmentGeneration: '0' },
            ],
          },
        ],
      ])
    );
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      id: 'w1',
      kind: 'clickhouse_keeper',
      role: 'active',
      serverId: 1001,
      clientPort: 39432,
      raftPort: 39433,
      raftHost: host,
    });
    // A member without a route yet is left out until its route exists.
    expect(specs[0]!.peers.map((peer) => peer.routeId)).toEqual(['route-a']);
    expect(specs[0]!.artifact.version).toBe('25.8.28.1');
  });
});
