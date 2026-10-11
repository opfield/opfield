import { describe, expect, it, vi } from 'vitest';
import { nodes, relayInstances, relayPoolUpdateRuns, relayPoolUpdateSteps } from '@/db/schema/index.js';
import type { TrustedRelayUpdateArtifact } from '@/lib/update-artifact-trust.js';
import { UpdateService, updateCommandFailure } from './update.service.js';

const IMAGE_REF = `registry.example.com/wiolett/gateway/relay@sha256:${'a'.repeat(64)}`;
const REFUSAL =
  'refused: this node runs in protected mode and accepts no update to an older release (v2.4.3 is older than the running v2.4.4)';

function relayArtifact(): TrustedRelayUpdateArtifact {
  const secureLinkConnectorImage = `registry.example.com/wiolett/gateway/secure-link-connector@sha256:${'c'.repeat(64)}`;
  return {
    imageRef: IMAGE_REF,
    digest: `sha256:${'a'.repeat(64)}`,
    buildVersion: 'v2.4.3',
    protocolMajor: 1,
    minGatewayVersion: 'v2.4.2',
    secureLinkConnectorImage,
    signedManifest: 'signed-relay',
    payload: {
      kind: 'relay-image',
      version: 'v2.4.3',
      tag: 'v2.4.3-relay',
      image: 'registry.example.com/wiolett/gateway/relay',
      digest: `sha256:${'a'.repeat(64)}`,
      imageRef: IMAGE_REF,
      protocolMajor: 1,
      minGatewayVersion: 'v2.4.2',
      secureLinkConnectorImage,
      createdAt: '2026-06-30T00:00:00.000Z',
    },
  };
}

/** A Relay Pool run on one connected remote relay whose supervisor answers its update command. */
function poolWithProtectedRelay() {
  const state = { run: 'updating', terminalError: null as string | null };
  const step = { id: 'step-remote', relayInstanceId: 'remote', state: 'pending', sequence: 0, error: null as unknown };
  const instance = {
    id: 'remote',
    kind: 'remote',
    poolId: 'system',
    nodeId: 'relay-node',
    state: 'ready',
    buildVersion: 'v2.4.4',
    manualDrainStartedAt: null,
    health: { activeTunnels: 0, admissionState: 'draining' },
  };
  const rowsFor = (table: unknown) => {
    if (table === relayPoolUpdateRuns) {
      return [
        {
          id: 'run-1',
          state: state.run,
          targetArtifact: { version: 'v2.4.3' },
          startedAt: new Date('2026-10-01T10:00:00Z'),
          updatedAt: new Date('2026-10-01T10:00:00Z'),
          terminalError: state.terminalError,
        },
      ];
    }
    // A failed step no longer holds its relay (the resume after the failure checks that).
    if (table === relayPoolUpdateSteps) return step.state === 'failed' ? [] : [step];
    if (table === relayInstances) return [instance];
    // The supervisor keeps running its release: it refused the update.
    if (table === nodes) return [{ status: 'online', daemonVersion: 'v2.4.4', lastSeenAt: new Date() }];
    return [];
  };
  const chain = (rows: () => unknown[]) => {
    const query = Promise.resolve().then(rows) as Promise<unknown[]> & Record<string, unknown>;
    for (const method of ['where', 'orderBy', 'limit', 'innerJoin']) query[method] = () => query;
    return query;
  };
  const select = () => ({ from: (table: unknown) => chain(() => rowsFor(table)) });
  const update = (table: unknown) => ({
    set: (values: { state?: string; error?: unknown; terminalError?: string | null }) => {
      if (table === relayPoolUpdateRuns && values.state) {
        state.run = values.state;
        if (values.terminalError !== undefined) state.terminalError = values.terminalError;
      }
      if (table === relayPoolUpdateSteps && values.state) {
        step.state = values.state;
        step.error = values.error;
      }
      const query = Promise.resolve(undefined) as Promise<undefined> & Record<string, () => unknown>;
      query.where = () => query;
      query.returning = async () => [];
      return query;
    },
  });
  const tx = { execute: vi.fn().mockResolvedValue(undefined), select, update };
  const db = {
    select,
    update,
    insert: vi.fn(() => ({ values: () => ({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) }) })),
    transaction: vi.fn(async (write: (executor: typeof tx) => Promise<unknown>) => write(tx)),
  };
  const service = new UpdateService(
    db as never,
    {} as never,
    {
      APP_VERSION: 'v2.4.2',
      COMPOSE_PROJECT_DIR: '/srv/gateway',
      RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
      GATEWAY_RELAY_IMAGE_REF: IMAGE_REF,
      GATEWAY_RELAY_BUILD_VERSION: 'v2.4.3',
      GATEWAY_RELAY_PROTOCOL_MAJOR: 1,
    } as never,
    {
      setMaintenance: vi.fn().mockResolvedValue(undefined),
      setExpectedArtifact: vi.fn(),
      updateSecureLinkConnectorImage: vi.fn().mockResolvedValue(undefined),
      probeNow: vi.fn().mockResolvedValue(undefined),
    } as never
  );
  service.setAuditLog({ log: vi.fn().mockResolvedValue(true) });
  const runtime = {
    isRelayConnected: vi.fn(() => true),
    drainInstance: vi.fn().mockResolvedValue(undefined),
    forceDisconnectInstance: vi.fn().mockResolvedValue(undefined),
    localRelayTakeoverBlocker: vi.fn().mockResolvedValue(null),
    prepareWorkerUpdate: vi.fn(),
    dispatchWorkerUpdate: vi.fn(),
    prepareSupervisorUpdate: vi.fn().mockResolvedValue({ payload: { version: 'v2.4.3' } }),
    // The node accepts the command and answers it with the refusal right away.
    dispatchSupervisorUpdate: vi.fn(async () => ({
      failed: updateCommandFailure(Promise.resolve({ success: false, error: REFUSAL })),
    })),
  };
  service.setRelayPoolUpdateRuntime(runtime);
  return { service, runtime, state, step };
}

describe('a Relay Pool update refused by a protected relay', () => {
  it('fails the step and the run with the refusal at once and resumes the relay', async () => {
    const { service, runtime, state, step } = poolWithProtectedRelay();
    const started = Date.now();

    await expect(service.performRelayUpdate('v2.4.3', relayArtifact(), 'admin-1')).rejects.toThrow(REFUSAL);

    // Not the 3 minutes of the reconnect wait.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(runtime.dispatchSupervisorUpdate).toHaveBeenCalledWith('relay-node', expect.anything());
    expect(runtime.prepareWorkerUpdate).not.toHaveBeenCalled();
    expect(step).toMatchObject({ state: 'failed', error: REFUSAL });
    expect(state).toMatchObject({ run: 'failed', terminalError: REFUSAL });
    expect(runtime.drainInstance).toHaveBeenCalledWith('remote', 'admin-1', true);
    await vi.waitFor(() => expect(runtime.drainInstance).toHaveBeenCalledWith('remote', 'admin-1', false));
  });
});

describe('updateCommandFailure', () => {
  /** What the failure says within 20 ms of the command's answer, or `pending`. */
  const failureOf = async (answer: Promise<{ success: boolean; error?: string; detail?: string }>) =>
    Promise.race([updateCommandFailure(answer), new Promise((resolve) => setTimeout(() => resolve('pending'), 20))]);

  it('gives the reason of a command that answered failure', async () => {
    await expect(failureOf(Promise.resolve({ success: false, error: REFUSAL }))).resolves.toBe(REFUSAL);
    await expect(failureOf(Promise.resolve({ success: false, detail: 'bad checksum' }))).resolves.toBe('bad checksum');
    await expect(failureOf(Promise.resolve({ success: false }))).resolves.toBe('The daemon rejected the update');
  });

  it('stays pending on success and on an uncertain answer, which the reconnect wait settles', async () => {
    await expect(failureOf(Promise.resolve({ success: true }))).resolves.toBe('pending');
    await expect(failureOf(Promise.reject(new Error('Node disconnected')))).resolves.toBe('pending');
  });
});
