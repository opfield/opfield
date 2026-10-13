import { describe, expect, it, vi } from 'vitest';
import { relayInstances, relayPoolUpdateRuns, relayPoolUpdateSteps } from '@/db/schema/index.js';
import type { TrustedRelayUpdateArtifact } from '@/lib/update-artifact-trust.js';
import { AppError } from '@/middleware/error-handler.js';
import { RELAY_UPDATE_SKIPPED_OFFLINE, UpdateService } from './update.service.js';

const IMAGE_REF = `registry.example.com/wiolett/gateway/relay@sha256:${'a'.repeat(64)}`;

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

/**
 * A Relay Pool run whose first step is a remote relay whose host died (rc.21: the run failed at once on it), then the
 * local relay, which already runs the target image.
 */
function poolWithRemote(connected: boolean) {
  const state = { run: 'updating' };
  const steps = [
    { id: 'step-remote', relayInstanceId: 'remote', state: 'pending', sequence: 0 },
    { id: 'step-local', relayInstanceId: 'local', state: 'pending', sequence: 1 },
  ];
  const instances = [
    { id: 'remote', kind: 'remote', poolId: 'system', nodeId: 'relay-node', state: 'offline', buildVersion: 'v2.4.2' },
    { id: 'local', kind: 'local', poolId: 'system', state: 'ready', buildVersion: 'v2.4.3' },
  ];
  let instanceReads = 0;
  const rowsFor = (table: unknown) => {
    if (table === relayPoolUpdateRuns) {
      return [
        {
          id: 'run-1',
          state: state.run,
          targetArtifact: { version: 'v2.4.3' },
          startedAt: new Date('2026-10-01T10:00:00Z'),
          updatedAt: new Date('2026-10-01T10:00:00Z'),
          terminalError: null,
        },
      ];
    }
    if (table === relayPoolUpdateSteps) return steps;
    // The run reads each step's relay in order.
    if (table === relayInstances) return [instances[instanceReads++ % instances.length]];
    return [];
  };
  const chain = (rows: () => unknown[]) => {
    const query = Promise.resolve().then(rows) as Promise<unknown[]> & Record<string, unknown>;
    for (const method of ['where', 'orderBy', 'limit', 'innerJoin']) query[method] = () => query;
    return query;
  };
  const select = () => ({ from: (table: unknown) => chain(() => rowsFor(table)) });
  const update = (table: unknown) => ({
    set: (values: { state?: string }) => {
      if (table === relayPoolUpdateRuns && values.state) state.run = values.state;
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
  const relayRuntime = {
    setMaintenance: vi.fn().mockResolvedValue(undefined),
    setExpectedArtifact: vi.fn(),
    updateSecureLinkConnectorImage: vi.fn().mockResolvedValue(undefined),
    probeNow: vi.fn().mockResolvedValue(undefined),
  };
  const service = new UpdateService(
    db as never,
    {} as never,
    {
      APP_VERSION: 'v2.4.2',
      COMPOSE_PROJECT_DIR: '/srv/gateway',
      RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
      // The local relay already runs the target: its step completes without a recreate.
      OPFIELD_RELAY_IMAGE_REF: IMAGE_REF,
      OPFIELD_RELAY_BUILD_VERSION: 'v2.4.3',
      OPFIELD_RELAY_PROTOCOL_MAJOR: 1,
    } as never,
    relayRuntime as never
  );
  service.setAuditLog({ log: vi.fn().mockResolvedValue(true) });
  const runtime = {
    isRelayConnected: vi.fn(() => connected),
    drainInstance: vi.fn().mockResolvedValue(undefined),
    forceDisconnectInstance: vi.fn().mockResolvedValue(undefined),
    localRelayTakeoverBlocker: vi.fn().mockResolvedValue(null),
    prepareWorkerUpdate: vi.fn(),
    dispatchWorkerUpdate: vi.fn(),
    prepareSupervisorUpdate: vi.fn(),
    dispatchSupervisorUpdate: vi.fn(),
  };
  service.setRelayPoolUpdateRuntime(runtime);
  const internals = service as unknown as Record<string, (...args: any[]) => any>;
  const skipped = vi.spyOn(internals, 'skipPoolStep');
  const stepStates = vi.spyOn(internals, 'updatePoolStep');
  return { service, runtime, state, skipped, stepStates, relayRuntime };
}

describe('a Relay Pool update with a member that is not connected', () => {
  it('skips the offline member with the reason, updates the rest and completes', async () => {
    const { service, runtime, state, skipped, stepStates, relayRuntime } = poolWithRemote(false);

    await service.performRelayUpdate('v2.4.3', relayArtifact(), 'admin-1');

    expect(runtime.isRelayConnected).toHaveBeenCalledWith('relay-node');
    expect(skipped).toHaveBeenCalledWith('step-remote');
    expect(runtime.drainInstance).not.toHaveBeenCalled();
    expect(stepStates).toHaveBeenCalledWith('step-local', 'ready', true, undefined, null);
    expect(relayRuntime.updateSecureLinkConnectorImage).toHaveBeenCalled();
    expect(state.run).toBe('complete');
    expect(RELAY_UPDATE_SKIPPED_OFFLINE).toMatch(/not connected; it is updated when it reconnects/);
  });

  it('skips a member that disconnects before its drain, without failing the run', async () => {
    const { service, runtime, state, skipped } = poolWithRemote(true);
    runtime.drainInstance.mockRejectedValueOnce(
      new AppError(409, 'RELAY_NOT_CONNECTED', 'The relay is not connected. Try again once it reconnects.')
    );

    await service.performRelayUpdate('v2.4.3', relayArtifact(), 'admin-1');

    expect(skipped).toHaveBeenCalledWith('step-remote');
    expect(state.run).toBe('complete');
  });
});
