import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as protoLoader from '@grpc/proto-loader';
import { describe, expect, it, vi } from 'vitest';
import type { OpfieldCommand } from '@/grpc/generated/types.js';
import { NodeDispatchService } from './node-dispatch.service.js';
import { SET_PEER_ENDPOINT_KIND, SET_PEER_ROUTE_KIND } from './relay-managed-availability.js';
import type { RelayGrantBundle } from './relay-policy.service.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/** The bytes the docker daemon's grant store is tested with (availability_set_grants_wire_test.go). */
const vectorPath = resolve(root, 'proto/testdata/relay-grant-set-paths-v1.json');

const SET = '11111111-1111-4111-8111-111111111111';
const POLICY = '22222222-2222-4222-8222-222222222222';
const DATABASE = '33333333-3333-4333-8333-333333333333';
const PRIMARY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COPY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const grant = { keyId: 'k1', payload: Buffer.from('payload'), signature: Buffer.from('signature') };
const target = (memberId: string, rank: number, port?: string) => ({
  setId: SET,
  memberId,
  candidateId: `node-${memberId.slice(0, 4)}`,
  leasePolicyId: POLICY,
  rank,
  ownerKind: 'managed_database',
  ownerId: DATABASE,
  ...(port ? { portName: port, primaryPort: port === 'pg-repl' && memberId === PRIMARY } : {}),
});

/** A copy's bundle: its peer endpoint, its peer routes to the primary's replication port, and a link to the set. */
const bundle: RelayGrantBundle = {
  revision: '7',
  generatedAtUnixMs: '1800000000000',
  grants: [
    {
      role: 'endpoint',
      ownerKind: SET_PEER_ENDPOINT_KIND,
      ownerId: `${COPY}:pg-repl`,
      endpointId: 'ep-copy',
      grant,
      schemaVersion: 2,
      leaseTarget: target(COPY, 1, 'pg-repl'),
    },
    {
      role: 'connect',
      ownerKind: SET_PEER_ROUTE_KIND,
      ownerId: `${COPY}>${PRIMARY}:pg-repl`,
      routeId: 'route-peer',
      targetEndpointId: 'ep-primary',
      grant,
      schemaVersion: 2,
      candidates: [],
      leaseTarget: target(PRIMARY, 0, 'pg-repl'),
    },
    {
      role: 'connect',
      ownerKind: 'managed_database_link',
      ownerId: 'link-1',
      routeId: 'route-link-primary',
      targetEndpointId: 'ep-client-primary',
      grant,
      schemaVersion: 2,
      leaseGroup: [
        {
          routeId: 'route-link-primary',
          targetEndpointId: 'ep-client-primary',
          grant,
          target: target(PRIMARY, 0),
          schemaVersion: 2,
        },
        {
          routeId: 'route-link-copy',
          targetEndpointId: 'ep-client-copy',
          grant,
          target: target(COPY, 1),
          schemaVersion: 2,
        },
      ],
    },
  ],
};

function commandStream() {
  const definition = protoLoader.loadSync(resolve(root, 'proto/opfield/v1/nginx-daemon.proto'), {
    keepCase: false,
    longs: String,
    enums: String,
    bytes: Buffer,
    defaults: true,
    oneofs: true,
  });
  return (definition['opfield.v1.NodeControl'] as Record<string, protoLoader.MethodDefinition<unknown, unknown>>)
    .CommandStream!;
}

describe('relay grant bundles on the wire', () => {
  it('carry the lease target and lease group of set paths to the daemon', async () => {
    const sendCommand = vi.fn(async (_nodeId: string, _command: Partial<OpfieldCommand>) => ({ success: true }));
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ capabilities: { capabilities: ['generic_relay_tunnel_v1'] } }] }),
        }),
      }),
    };
    const dispatch = new NodeDispatchService({ sendCommand } as never, db as never);
    await dispatch.sendRelayGrantBundle('node-copy', bundle);
    const command = sendCommand.mock.calls[0]![1];

    // The command as the gRPC stream encodes it, and as a daemon decodes it.
    const stream = commandStream();
    const bytes = stream.responseSerialize(command);
    const decoded = stream.responseDeserialize(bytes) as OpfieldCommand;
    const grants = decoded.syncRelayGrants!.grants;
    expect(grants[0]!.leaseTarget).toMatchObject({
      setId: SET,
      memberId: COPY,
      portName: 'pg-repl',
      leasePolicyId: POLICY,
    });
    expect(grants[1]!.leaseTarget).toMatchObject({ memberId: PRIMARY, portName: 'pg-repl', primaryPort: true });
    expect(grants[2]!.leaseGroup?.map((route) => [route.routeId, route.target.memberId])).toEqual([
      ['route-link-primary', PRIMARY],
      ['route-link-copy', COPY],
    ]);

    const encoded = Buffer.from(bytes).toString('base64');
    if (process.env.UPDATE_RELAY_GRANT_VECTORS === '1') {
      writeFileSync(
        vectorPath,
        `${JSON.stringify(
          {
            comment:
              'An OpfieldCommand with a relay grant bundle of availability set paths as Opfield sends it (relay-grant-wire.test.ts); the docker daemon decodes it into its grant store (availability_set_grants_wire_test.go). UPDATE_RELAY_GRANT_VECTORS=1 rewrites it.',
            opfieldCommandBase64: encoded,
          },
          null,
          2
        )}\n`
      );
    }
    expect(JSON.parse(readFileSync(vectorPath, 'utf8')).opfieldCommandBase64).toBe(encoded);
  });
});
