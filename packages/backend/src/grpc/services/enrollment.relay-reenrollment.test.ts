import bcrypt from 'bcryptjs';
import { describe, expect, it, vi } from 'vitest';
import { nodes, relayInstances } from '@/db/schema/index.js';
import { createNodeEnrollmentToken } from '@/modules/nodes/node-enrollment-token.js';
import { createEnrollmentHandlers } from './enrollment.js';

const nodeId = '11111111-1111-4111-8111-111111111111';
const relayHostIdentityId = '22222222-2222-4222-8222-222222222222';
const otherHostIdentityId = '44444444-4444-4444-8444-444444444444';
const instanceId = '33333333-3333-4333-8333-333333333333';
const leakingError = new Error(
  'Failed query: update "relay_instances" set "fault_domain_id" = $1 params: 44444444-4444-4444-8444-444444444444,sha256:abc'
);

function makeDeps(db: any) {
  const commandStream = { end: vi.fn(), destroy: vi.fn(), getPeer: () => '127.0.0.1:12345' };
  return {
    db,
    registry: { getNode: vi.fn(() => ({ commandStream })), deregister: vi.fn(async () => undefined) },
    systemCA: {
      issueNodeCert: vi.fn(async () => {
        throw leakingError;
      }),
      issueRelayServerCert: vi.fn(async () => {
        throw leakingError;
      }),
    },
    relayPolicy: {
      getPolicyEnrollmentTrust: vi.fn(async () => ({ keyId: 'k', publicKey: Buffer.alloc(32), fingerprint: 'f' })),
      refreshNodeIdentity: vi.fn(async () => undefined),
      refreshAllNodeGrantsIfDue: vi.fn(async () => undefined),
    },
    auditService: { log: vi.fn(async () => undefined) },
  } as any;
}

/** An enrolled relay whose re-enrollment token is `token`, found by the second (re-enrollment) lookup. */
async function makeRelayDb(token: { token: string; selector: string }) {
  const relayNode = {
    id: nodeId,
    type: 'relay',
    status: 'offline',
    certificateSerial: 'old01',
    hostIdentityId: relayHostIdentityId,
    enrollmentTokenSelector: token.selector,
    enrollmentTokenHash: await bcrypt.hash(token.token, 4),
  };
  const instance = {
    id: instanceId,
    nodeId,
    poolId: 'system',
    faultDomainId: relayHostIdentityId,
    advertisedAddresses: ['relay.example.test'],
  };
  let nodeLookups = 0;
  return {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === relayInstances) return [instance];
            if (table !== nodes) return [];
            nodeLookups += 1;
            return nodeLookups === 1 ? [] : [relayNode];
          },
        }),
      }),
    })),
    insert: vi.fn(),
    update: vi.fn(),
  } as any;
}

function relayEnrollCall(token: string, hostIdentityId: string) {
  return {
    request: {
      token,
      hostname: 'relay-host',
      daemonVersion: '1.2.3',
      osInfo: 'linux/amd64',
      nginxVersion: '',
      daemonType: 'relay',
      hostIdentityId,
    },
  } as any;
}

describe('Enroll relay re-enrollment host binding', () => {
  it("refuses another host's use of a relay's re-enrollment token without changing anything", async () => {
    const token = createNodeEnrollmentToken();
    const db = await makeRelayDb(token);
    const deps = makeDeps(db);
    const callback = vi.fn();

    await createEnrollmentHandlers(deps).Enroll(relayEnrollCall(token.token, otherHostIdentityId), callback);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({ code: 16, message: 'Invalid enrollment token' });
    // Nothing issued, written or consumed: the token stays valid for the relay's own host.
    expect(deps.systemCA.issueRelayServerCert).not.toHaveBeenCalled();
    expect(deps.systemCA.issueNodeCert).not.toHaveBeenCalled();
    expect(deps.relayPolicy.getPolicyEnrollmentTrust).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(deps.auditService.log).not.toHaveBeenCalled();
  });

  it('lets the relay re-enroll from its own host', async () => {
    const token = createNodeEnrollmentToken();
    const deps = makeDeps(await makeRelayDb(token));
    const callback = vi.fn();

    await createEnrollmentHandlers(deps).Enroll(relayEnrollCall(token.token, relayHostIdentityId), callback);

    expect(deps.systemCA.issueRelayServerCert).toHaveBeenCalledWith(instanceId, ['relay.example.test']);
  });
});

describe('Enrollment errors returned to the daemon', () => {
  it('returns a generic enrollment error and keeps the database error in the log', async () => {
    const token = createNodeEnrollmentToken();
    const deps = makeDeps(await makeRelayDb(token));
    const callback = vi.fn();

    await createEnrollmentHandlers(deps).Enroll(relayEnrollCall(token.token, relayHostIdentityId), callback);

    expect(callback).toHaveBeenCalledWith({
      code: 13,
      message: 'Enrollment failed; see the Opfield log for details',
    });
  });

  it('returns a generic renewal error and keeps the database error in the log', async () => {
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ id: nodeId, certificateSerial: 'aa01', hostname: 'node-1', status: 'online' }],
          }),
        }),
      })),
    } as any;
    const deps = makeDeps(db);
    const callback = vi.fn();
    const call = {
      request: { nodeId },
      getPeer: () => '127.0.0.1:50000',
      handler: {
        http2Stream: {
          session: {
            socket: {
              authorized: true,
              authorizationError: null,
              getPeerCertificate: () => ({ subject: { CN: nodeId }, serialNumber: 'aa01' }),
            },
          },
        },
      },
    } as any;

    await createEnrollmentHandlers(deps).RenewCertificate(call, callback);

    expect(deps.systemCA.issueNodeCert).toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({
      code: 13,
      message: 'Certificate renewal failed; see the Opfield log for details',
    });
  });
});

describe('Enroll a new relay on a host that already has one in the pool', () => {
  async function newRelayDb(sameHost: Array<{ displayName: string }>, insertError?: Error) {
    const token = createNodeEnrollmentToken();
    const pending = {
      id: nodeId,
      type: 'relay',
      status: 'pending',
      displayName: 'relay-2',
      serviceAddresses: ['relay-2.example.test'],
      enrollmentTokenSelector: token.selector,
      enrollmentTokenHash: await bcrypt.hash(token.token, 4),
    };
    let instanceLookups = 0;
    const db = {
      select: vi.fn(() => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => {
              if (table === nodes) return [pending];
              instanceLookups += 1;
              // The node's own instance first, then any relay of the pool on the same host.
              return instanceLookups === 1 ? [] : sameHost;
            },
          }),
        }),
      })),
      insert: vi.fn(() => ({
        values: () => ({
          returning: async () => {
            if (insertError) throw insertError;
            return [{ id: instanceId, nodeId, poolId: 'system', advertisedAddresses: ['relay-2.example.test'] }];
          },
        }),
      })),
      update: vi.fn(),
    } as any;
    return { db, token };
  }

  it('refuses it naming the relay to re-enroll or remove, before issuing any certificate', async () => {
    const { db, token } = await newRelayDb([{ displayName: 'relay-1' }]);
    const deps = makeDeps(db);
    const callback = vi.fn();

    await createEnrollmentHandlers(deps).Enroll(relayEnrollCall(token.token, relayHostIdentityId), callback);

    expect(callback).toHaveBeenCalledWith({
      code: 6,
      message:
        'This host already has relay "relay-1" in the Relay Pool. Re-enroll that relay (Settings > Relay > Re-enroll) or remove it first.',
    });
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(deps.systemCA.issueRelayServerCert).not.toHaveBeenCalled();
    expect(deps.systemCA.issueNodeCert).not.toHaveBeenCalled();
  });

  it('refuses it without the query when a concurrent enrollment took the host first', async () => {
    const constraintError = Object.assign(new Error('Failed query: insert into "relay_instances" params: …'), {
      cause: { constraint: 'relay_instances_pool_fault_domain_unique' },
    });
    const { db, token } = await newRelayDb([], constraintError);
    const deps = makeDeps(db);
    const callback = vi.fn();

    await createEnrollmentHandlers(deps).Enroll(relayEnrollCall(token.token, relayHostIdentityId), callback);

    expect(callback).toHaveBeenCalledWith({
      code: 6,
      message:
        'This host already has a relay in the Relay Pool. Re-enroll that relay (Settings > Relay > Re-enroll) or remove it first.',
    });
    expect(deps.systemCA.issueRelayServerCert).not.toHaveBeenCalled();
  });
});
