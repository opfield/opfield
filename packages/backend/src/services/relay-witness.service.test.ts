import { describe, expect, it, vi } from 'vitest';
import type { WitnessArtifact } from '@/grpc/generated/types.js';
import {
  allocateWitnessPorts,
  planRelayWitnesses,
  RELAY_DIAL_ROUTE_CAPABILITY,
  RELAY_LOCAL_ENDPOINTS_CAPABILITY,
  RELAY_LOCAL_PORT_MAX,
  RELAY_LOCAL_PORT_MIN,
  type RelayWitnessRelay,
  type RelayWitnessRow,
  RelayWitnessService,
  witnessRowStatus,
} from './relay-witness.service.js';

const SHA = 'a'.repeat(64);

function relay(overrides: Partial<RelayWitnessRelay> = {}): RelayWitnessRelay {
  return {
    id: 'relay-1',
    nodeId: 'node-relay-1',
    witnessHostingAllowed: true,
    witnessHostingLocal: 'allowed',
    features: ['relay_witness_v1', RELAY_LOCAL_ENDPOINTS_CAPABILITY, RELAY_DIAL_ROUTE_CAPABILITY],
    architecture: 'amd64',
    ...overrides,
  };
}

function witness(id: string, overrides: Partial<RelayWitnessRow> = {}): RelayWitnessRow {
  return {
    id,
    setId: 'set-1',
    purpose: 'keeper',
    hostKind: 'relay',
    role: 'active',
    desiredState: 'running',
    keeperServerId: 3,
    artifactVersion: '25.3.6',
    artifactSha256: `sha256:${SHA}`,
    createdAt: new Date('2026-10-11T00:00:00Z'),
    leasePolicyId: 'policy-1',
    ...overrides,
  };
}

const artifact: WitnessArtifact = {
  version: '25.3.6',
  downloadUrl: 'https://updates.example/gateway/witness-clickhouse-keeper/v2.12.0/keeper',
  sha256: SHA,
  signedManifest: '{}',
  component: 'witness-clickhouse-keeper',
};

describe('relay witness desired state', () => {
  it('runs keeper witnesses of an allowed relay with stable relay-local ports', () => {
    const rows = [
      witness('w-active'),
      witness('w-standby', { role: 'standby', createdAt: new Date('2026-10-11T00:01:00Z') }),
      witness('w-lease', { purpose: 'lease', keeperServerId: null }),
      witness('w-removed', { desiredState: 'removed' }),
      witness('w-node', { hostKind: 'node' }),
    ];
    const artifacts = new Map(rows.map((row) => [row.id, artifact]));
    const plan = planRelayWitnesses(relay(), rows, artifacts, new Map());
    expect(plan.refused).toEqual([]);
    expect(plan.specs.map((spec) => [spec.id, spec.role])).toEqual([
      ['w-active', 'active'],
      ['w-standby', 'standby'],
    ]);
    for (const spec of plan.specs) {
      expect(spec.kind).toBe('clickhouse_keeper');
      expect(spec.clientPort).toBeGreaterThanOrEqual(RELAY_LOCAL_PORT_MIN);
      expect(spec.raftPort).toBe(spec.clientPort + 1);
      expect(spec.raftPort).toBeLessThanOrEqual(RELAY_LOCAL_PORT_MAX);
      expect(spec.leasePolicyId).toBe('policy-1');
    }
    expect(plan.specs[0].clientPort).not.toBe(plan.specs[1].clientPort);
    // Another witness joining keeps the ports of the existing ones.
    const later = planRelayWitnesses(
      relay(),
      [...rows, witness('w-new', { createdAt: new Date('2026-10-11T01:00:00Z') })],
      new Map([...artifacts, ['w-new', artifact]]),
      new Map()
    );
    for (const spec of plan.specs) {
      expect(later.specs.find((next) => next.id === spec.id)?.clientPort).toBe(spec.clientPort);
    }
  });

  it.each([
    ['admin flag off', { witnessHostingAllowed: false }, 'not allowed'],
    ['protected without opt-in', { witnessHostingLocal: 'protected_needs_opt_in' }, 'protected'],
    ['older supervisor', { witnessHostingLocal: null }, 'update the relay'],
    ['worker without relay-local endpoints', { features: ['relay_witness_v1', RELAY_DIAL_ROUTE_CAPABILITY] }, 'update'],
  ] as const)('refuses a relay: %s', (_name, overrides, reason) => {
    const plan = planRelayWitnesses(
      relay(overrides as Partial<RelayWitnessRelay>),
      [witness('w1')],
      new Map([['w1', artifact]]),
      new Map()
    );
    expect(plan.specs).toEqual([]);
    expect(plan.refused).toEqual([{ id: 'w1', reason: expect.stringContaining(reason) }]);
  });

  it('refuses a witness without a matching artifact', () => {
    const missing = planRelayWitnesses(relay(), [witness('w1')], new Map([['w1', null]]), new Map());
    expect(missing.refused[0].reason).toContain('no signed witness artifact');
    const mismatch = planRelayWitnesses(
      relay(),
      [witness('w1', { artifactSha256: `sha256:${'b'.repeat(64)}` })],
      new Map([['w1', artifact]]),
      new Map()
    );
    expect(mismatch.refused[0].reason).toContain('sha256');
  });

  it('allocates at most one pair per witness inside the range', () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      id: `w-${index}`,
      createdAt: new Date(1_800_000_000_000 + index),
    }));
    const ports = allocateWitnessPorts(many);
    expect(ports.size).toBe(50);
    const used = new Set([...ports.values()].map((pair) => pair.clientPort));
    expect(used.size).toBe(50);
  });

  it('keeps a stored raft port (it is in the Keeper cluster configuration) and renders the set loopback host', () => {
    const older = witness('w-older', { createdAt: new Date('2026-10-10T00:00:00Z') });
    const placed = witness('w-placed', { relayLocalPort: 39433 });
    const ports = allocateWitnessPorts([older, placed]);
    expect(ports.get('w-placed')).toEqual({ clientPort: 39432, raftPort: 39433 });
    expect(ports.get('w-older')?.raftPort).not.toBe(39433);
    const plan = planRelayWitnesses(
      relay(),
      [older, placed],
      new Map([
        ['w-older', artifact],
        ['w-placed', artifact],
      ]),
      new Map(),
      new Map([['w-placed', '127.12.34.1']])
    );
    const spec = plan.specs.find((entry) => entry.id === 'w-placed');
    expect(spec?.raftPort).toBe(39433);
    expect(spec?.raftHost).toBe('127.12.34.1');
    expect(plan.specs.find((entry) => entry.id === 'w-older')?.raftHost).toBe('');
  });
});

describe('RelayWitnessService.syncRelay', () => {
  it('pushes only when the desired set changed or the relay is behind', async () => {
    const dispatch = { applyRelayWitnesses: vi.fn().mockResolvedValue({ success: true, commandId: 'c', error: '' }) };
    let now = 1_800_000_000_000;
    const service = new RelayWitnessService({} as never, dispatch as never, () => now);
    let specs = [witness('w1')];
    vi.spyOn(service, 'plan').mockImplementation(async () => ({
      relay: relay(),
      ...planRelayWitnesses(relay(), specs, new Map(specs.map((row) => [row.id, artifact])), new Map()),
    }));
    await service.syncRelay('relay-1', { reportedRevision: 0, reportedWitnesses: 0 });
    expect(dispatch.applyRelayWitnesses).toHaveBeenCalledTimes(1);
    const first = dispatch.applyRelayWitnesses.mock.calls[0][1];
    expect(first.witnesses.map((spec: { id: string }) => spec.id)).toEqual(['w1']);

    await service.syncRelay('relay-1', { reportedRevision: Number(first.revision) });
    expect(dispatch.applyRelayWitnesses).toHaveBeenCalledTimes(1);

    // The relay restarted with an older set: pushed again after the retry delay.
    now += 31_000;
    await service.syncRelay('relay-1', { reportedRevision: 1 });
    expect(dispatch.applyRelayWitnesses).toHaveBeenCalledTimes(2);
    expect(Number(dispatch.applyRelayWitnesses.mock.calls[1][1].revision)).toBeGreaterThan(Number(first.revision));

    specs = [];
    await service.syncRelay('relay-1');
    expect(dispatch.applyRelayWitnesses).toHaveBeenCalledTimes(3);
    expect(dispatch.applyRelayWitnesses.mock.calls[2][1].witnesses).toEqual([]);
  });

  it('sends nothing to a relay without witnesses', async () => {
    const dispatch = { applyRelayWitnesses: vi.fn() };
    const service = new RelayWitnessService({} as never, dispatch as never);
    vi.spyOn(service, 'plan').mockResolvedValue({ relay: relay(), specs: [], refused: [] });
    await service.syncRelay('relay-1', { reportedRevision: 0, reportedWitnesses: 0 });
    expect(dispatch.applyRelayWitnesses).not.toHaveBeenCalled();
  });
});

describe('witness row status', () => {
  it('shows a Keeper witness without quorum as waiting, not failed', () => {
    expect(witnessRowStatus('running')).toBe('ready');
    expect(witnessRowStatus('starting')).toBe('waiting_quorum');
    expect(
      witnessRowStatus(
        'error',
        'witness does not answer its health check: keeper did not report its mode (no quorum yet?)'
      )
    ).toBe('waiting_quorum');
    expect(witnessRowStatus('error', 'artifact checksum mismatch')).toBe('error');
    expect(witnessRowStatus('refused')).toBe('error');
    expect(witnessRowStatus('fetching')).toBe('pending');
  });
});
