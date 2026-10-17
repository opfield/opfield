import { beforeEach, describe, expect, it, vi } from 'vitest';
import { relayInstances, relayPoolUpdateRuns, relayPoolUpdateSteps } from '@/db/schema/index.js';
import type { TrustedRelayUpdateArtifact } from '@/lib/update-artifact-trust.js';
import { waitForLocalRelayEvacuation } from './relay-local-takeover.js';
import { UpdateService } from './update.service.js';

vi.mock('./relay-local-takeover.js', () => ({
  waitForLocalRelayEvacuation: vi.fn(),
  localServiceEndpointIds: vi.fn(async () => new Set(['endpoint-registry'])),
  drainingTunnels: vi.fn(() => 0),
}));

const MIGRATED = {
  exitCode: 0,
  output:
    '{"ok":true,"changedFiles":[],"backupDir":"/host/.opfield-foundation-backups/test","sandboxWorkspaceDir":"/var/lib/gateway/sandbox-workspaces"}',
};
const IN_FLIGHT = ['draining', 'updating', 'verifying', 'rolling_back'];

/** A Relay Pool run with the local relay left as its last step, and a remote relay that may take its workloads. */
function localStepPool(
  blocker: string | null,
  options: { resumable?: boolean; relayDrainDeadlineAt?: Date; reports?: () => any[] } = {}
) {
  const state = {
    run: 'updating',
    step: 'pending',
    stepError: null as string | null,
    drainDeadlineAt: null as Date | null,
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
          terminalError: null,
        },
      ];
    }
    if (table === relayPoolUpdateSteps) {
      return [{ id: 'step-local', relayInstanceId: 'local', state: state.step, sequence: 0 }];
    }
    if (table === relayInstances) {
      return [
        {
          id: 'local',
          kind: 'local',
          poolId: 'system',
          displayName: 'Local relay',
          state: 'draining',
          health: { admissionState: 'draining' },
          drainDeadlineAt: options.relayDrainDeadlineAt ?? null,
        },
      ];
    }
    return [];
  };
  // The steps an unfinished run holds in flight (isRelayInstanceHeldByUnfinishedRun joins steps and runs).
  const heldRows = () =>
    IN_FLIGHT.includes(state.step) && !['complete', 'failed'].includes(state.run) ? [{ id: 'step-local' }] : [];
  const chain = (rows: () => unknown[]) => {
    const query = Promise.resolve().then(rows) as Promise<unknown[]> & Record<string, unknown>;
    for (const method of ['where', 'orderBy', 'limit']) query[method] = () => query;
    return query;
  };
  const select = () => ({
    from: (table: unknown) => {
      const query = chain(() => rowsFor(table));
      query.innerJoin = () => chain(heldRows);
      return query;
    },
  });
  const update = (table: unknown) => ({
    set: (values: { state?: string; error?: string | null; drainDeadlineAt?: Date }) => {
      if (table === relayPoolUpdateRuns && values.state) state.run = values.state;
      if (table === relayPoolUpdateSteps && values.state) {
        state.step = values.state;
        if ('error' in values) state.stepError = values.error ?? null;
        if (values.drainDeadlineAt) state.drainDeadlineAt = values.drainDeadlineAt;
      }
      const query = Promise.resolve(undefined) as Promise<undefined> & Record<string, () => unknown>;
      query.where = () => query;
      query.returning = async () => [{ id: 'run-1', relayInstanceId: 'local', drainDeadlineAt: state.drainDeadlineAt }];
      return query;
    },
  });
  const tx = { execute: vi.fn().mockResolvedValue(undefined), select, update };
  // The routes through the relay (relayInstanceFullyResumable): all resumable, or one raw.
  const selectDistinct = () => {
    const query: Record<string, unknown> = {};
    for (const method of ['from', 'innerJoin']) query[method] = () => query;
    query.where = async () => [
      { routeId: 'route-1', resumeState: 'on' },
      { routeId: 'route-2', resumeState: options.resumable ? 'on' : 'off' },
    ];
    return query;
  };
  const db = {
    select,
    selectDistinct,
    update,
    insert: vi.fn(() => ({ values: () => ({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) }) })),
    transaction: vi.fn(async (write: (executor: typeof tx) => Promise<unknown>) => write(tx)),
  };
  const dockerService = {
    inspectSelf: vi.fn().mockResolvedValue({
      Config: {
        Image: 'registry.example.com/opfield/opfield:v2.4.2',
        Labels: {
          'com.docker.compose.project.working_dir': '/srv/gateway',
          'com.docker.compose.project': 'gateway',
        },
      },
    }),
    pullImageRef: vi.fn().mockResolvedValue(undefined),
    runOneShot: vi.fn().mockResolvedValue(MIGRATED),
  };
  const relayRuntime = {
    setMaintenance: vi.fn().mockResolvedValue(undefined),
    setExpectedArtifact: vi.fn(),
    updateSecureLinkConnectorImage: vi.fn().mockResolvedValue(undefined),
    probeNow: vi.fn().mockResolvedValue(undefined),
  };
  const service = new UpdateService(
    db as never,
    dockerService as never,
    {
      APP_VERSION: 'v2.4.2',
      COMPOSE_PROJECT_DIR: '/srv/gateway',
      RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
      OPFIELD_RELAY_IMAGE_REF: `registry.example.com/opfield/opfield/relay@sha256:${'b'.repeat(64)}`,
      OPFIELD_RELAY_BUILD_VERSION: 'v2.4.2',
      OPFIELD_RELAY_PROTOCOL_MAJOR: 1,
    } as never,
    relayRuntime as never
  );
  service.setAuditLog({ log: vi.fn().mockResolvedValue(true) });
  const runtime = {
    drainInstance: vi.fn().mockResolvedValue(undefined),
    forceDisconnectInstance: vi.fn().mockResolvedValue(undefined),
    localRelayTakeoverBlocker: vi.fn().mockResolvedValue(blocker),
    prepareWorkerUpdate: vi.fn(),
    dispatchWorkerUpdate: vi.fn(),
    prepareSupervisorUpdate: vi.fn(),
    dispatchSupervisorUpdate: vi.fn(),
    ...(options.reports ? { relayStreamReports: options.reports } : {}),
  };
  service.setRelayPoolUpdateRuntime(runtime);
  const internals = service as unknown as Record<string, (...args: any[]) => any>;
  const drainWait = vi.spyOn(internals, 'waitForRelayInstanceDrain').mockResolvedValue(true);
  const verify = vi.spyOn(internals, 'waitForRelayInstanceVersion').mockResolvedValue(undefined);
  return { service, dockerService, runtime, state, drainWait, verify };
}

function relayArtifact(): TrustedRelayUpdateArtifact {
  const imageRef = `registry.example.com/opfield/opfield/relay@sha256:${'a'.repeat(64)}`;
  const secureLinkConnectorImage = `registry.example.com/opfield/opfield/secure-link-connector@sha256:${'c'.repeat(64)}`;
  return {
    imageRef,
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
      image: 'registry.example.com/opfield/opfield/relay',
      digest: `sha256:${'a'.repeat(64)}`,
      imageRef,
      protocolMajor: 1,
      minGatewayVersion: 'v2.4.2',
      secureLinkConnectorImage,
      createdAt: '2026-06-30T00:00:00.000Z',
    },
  };
}

describe('The local relay step of a Relay Pool update', () => {
  beforeEach(() => {
    vi.mocked(waitForLocalRelayEvacuation).mockReset().mockResolvedValue(true);
  });

  it('drains the local relay while another relay carries its workloads, recreates it, verifies and resumes it', async () => {
    const { service, dockerService, runtime, state, verify, drainWait } = localStepPool(null);
    const events: string[] = [];
    runtime.drainInstance.mockImplementation(
      async (_id: string, _user: string, enabled: boolean) => void events.push(enabled ? 'drain' : 'resume')
    );
    vi.mocked(waitForLocalRelayEvacuation).mockImplementation(async () => {
      events.push('workloads moved');
      return true;
    });
    dockerService.runOneShot.mockImplementation(async () => {
      events.push('recreate');
      return MIGRATED;
    });
    verify.mockImplementation(async () => void events.push('verified'));

    await service.performRelayUpdate('v2.4.3', relayArtifact(), 'admin-1');

    expect(runtime.localRelayTakeoverBlocker).toHaveBeenCalledWith('local');
    expect(events.slice(0, 2)).toEqual(['drain', 'workloads moved']);
    expect(events.slice(-2)).toEqual(['verified', 'resume']);
    expect(runtime.drainInstance).toHaveBeenNthCalledWith(1, 'local', 'admin-1', true);
    expect(runtime.drainInstance).toHaveBeenLastCalledWith('local', 'admin-1', false);
    expect(verify).toHaveBeenCalledWith('local', 'v2.4.3', expect.any(AbortSignal));
    // The internal registry stays on the local relay and keeps being served: its tunnels need not end.
    const kept = new Set(['endpoint-registry']);
    expect(drainWait).toHaveBeenCalledWith('local', 30 * 60_000, expect.any(AbortSignal), kept);
    expect(state).toMatchObject({ run: 'complete', step: 'ready', stepError: null });
    expect(state.drainDeadlineAt).toBeInstanceOf(Date);
  });

  it('drains the local relay only once the placement with the relay updated before is active, and settles it after the run (stand rc.8, F-2)', async () => {
    const { service, runtime } = localStepPool(null);
    const events: string[] = [];
    const settlePlacement = vi.fn(async () => void events.push('placement settled'));
    service.setRelayPoolUpdateRuntime({ ...runtime, settlePlacement });
    runtime.drainInstance.mockImplementation(
      async (_id: string, _user: string, enabled: boolean) => void events.push(enabled ? 'drain' : 'resume')
    );

    await service.performRelayUpdate('v2.4.3', relayArtifact(), 'admin-1');

    expect(events).toEqual(['placement settled', 'drain', 'resume', 'placement settled']);
    expect(settlePlacement).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it('disconnects the local relay streams left after the drain grace before it recreates the relay', async () => {
    const { service, dockerService, runtime, drainWait } = localStepPool(null);
    drainWait.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    await service.performRelayUpdate('v2.4.3', relayArtifact(), 'admin-1');

    expect(runtime.forceDisconnectInstance).toHaveBeenCalledWith('local', 'admin-1');
    expect(runtime.forceDisconnectInstance.mock.invocationCallOrder[0]).toBeLessThan(
      dockerService.runOneShot.mock.invocationCallOrder[0]
    );
    expect(runtime.drainInstance).toHaveBeenLastCalledWith('local', 'admin-1', false);
  });

  it('recreates the local relay at once and records why its sessions dropped when no other relay can take over', async () => {
    const { service, dockerService, runtime, state } = localStepPool(
      'no other relay was ready to take its workloads over'
    );

    await service.performRelayUpdate('v2.4.3', relayArtifact(), 'admin-1');

    expect(runtime.drainInstance).not.toHaveBeenCalled();
    expect(dockerService.runOneShot).toHaveBeenCalled();
    expect(state).toMatchObject({ run: 'complete', step: 'ready' });
    expect(state.stepError).toBe(
      'Sessions through the local relay were interrupted once while it was recreated: no other relay was ready to take its workloads over.'
    );
  });

  it('resumes the local relay and recreates it as before when its workloads cannot move', async () => {
    const { service, runtime, state, drainWait } = localStepPool(null);
    vi.mocked(waitForLocalRelayEvacuation).mockResolvedValue(false);

    await service.performRelayUpdate('v2.4.3', relayArtifact(), 'admin-1');

    expect(runtime.drainInstance.mock.calls).toEqual([
      ['local', 'admin-1', true],
      ['local', 'admin-1', false],
    ]);
    expect(drainWait).not.toHaveBeenCalled();
    expect(state.stepError).toContain('its workloads could not be moved to another relay');
  });

  it('can be abandoned while the local relay drains, which puts the relay back into service', async () => {
    const { service, dockerService, runtime, state, drainWait } = localStepPool(null);
    drainWait.mockImplementation(
      (_id: string, _timeout: number, signal: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('The Relay Pool update was abandoned')))
        )
    );
    service.startRelayUpdate('v2.4.3');
    const update = service.performRelayUpdate('v2.4.3', relayArtifact(), 'admin-1');
    const abandoned = expect(update).rejects.toThrow('The Relay Pool update was abandoned');
    await vi.waitFor(() => expect(drainWait).toHaveBeenCalled());

    await expect(service.abandonRelayUpdate('admin-1')).resolves.toEqual({ targetVersion: 'v2.4.3' });
    await abandoned;

    expect(dockerService.runOneShot).not.toHaveBeenCalled();
    expect(state.run).toBe('failed');
    await vi.waitFor(() => expect(runtime.drainInstance).toHaveBeenCalledWith('local', 'admin-1', false));
  });

  it('refuses to abandon once the drained local relay is being recreated', async () => {
    const { service, dockerService, runtime, state } = localStepPool(null);
    let finishMigration!: () => void;
    dockerService.runOneShot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishMigration = () => resolve(MIGRATED);
        })
    );
    service.startRelayUpdate('v2.4.3');
    const update = service.performRelayUpdate('v2.4.3', relayArtifact(), 'admin-1');
    await vi.waitFor(() => expect(dockerService.runOneShot).toHaveBeenCalledOnce());

    await expect(service.abandonRelayUpdate('admin-1')).rejects.toMatchObject({ code: 'RELAY_UPDATE_COMMITTED' });

    finishMigration();
    await update;
    expect(state).toMatchObject({ run: 'complete', step: 'ready' });
    expect(runtime.drainInstance).toHaveBeenLastCalledWith('local', 'admin-1', false);
  });

  it('gives a relay whose streams all resume a short drain and records what moved', async () => {
    let moved = 10;
    const reports = () => [
      {
        nodeId: 'node-1',
        report: {
          migrationsOkTotal: moved,
          cutTotal: 0,
          byRelay: [{ relayInstanceId: 'local', resumable: 3, legacy: 0 }],
        },
      },
    ];
    const relayDrainDeadlineAt = new Date(Date.now() + 2 * 60_000);
    const { service, runtime, state, drainWait } = localStepPool(null, {
      resumable: true,
      relayDrainDeadlineAt,
      reports,
    });
    runtime.drainInstance.mockImplementation(async (_id: string, _user: string, enabled: boolean) => {
      if (!enabled) moved = 13;
    });

    await service.performRelayUpdate('v2.4.3', relayArtifact(), 'admin-1');

    const graceMs = drainWait.mock.calls[0]![1] as number;
    expect(graceMs).toBeGreaterThan(60_000);
    expect(graceMs).toBeLessThanOrEqual(2 * 60_000);
    expect(state.stepError).toBe('3 streams moved to other relays, none cut.');
  });

  it('counts only the streams through the drained relay, not moves between other relays (stand 2.12 N-3)', async () => {
    let moved = 10;
    const reports = () => [
      {
        nodeId: 'node-1',
        report: {
          migrationsOkTotal: moved,
          cutTotal: 0,
          byRelay: [
            { relayInstanceId: 'local', resumable: 1, legacy: 0 },
            { relayInstanceId: 'relay-uk', resumable: 90, legacy: 0 },
          ],
        },
      },
    ];
    const { service, runtime, state } = localStepPool(null, {
      resumable: true,
      relayDrainDeadlineAt: new Date(Date.now() + 2 * 60_000),
      reports,
    });
    // A placement change re-paths 90 streams between the other relays while the local relay drains.
    runtime.drainInstance.mockImplementation(async (_id: string, _user: string, enabled: boolean) => {
      if (!enabled) moved = 101;
    });

    await service.performRelayUpdate('v2.4.3', relayArtifact(), 'admin-1');

    expect(state.stepError).toBe('1 stream moved to other relays, none cut.');
  });

  it('notes that resumable streams paused when the local relay is recreated without another relay', async () => {
    const reports = () => [
      {
        nodeId: 'node-1',
        report: { migrationsOkTotal: 0, cutTotal: 0, byRelay: [{ relayInstanceId: 'local', resumable: 2, legacy: 0 }] },
      },
    ];
    const { service, state } = localStepPool('no other relay was ready to take its workloads over', {
      resumable: true,
      reports,
    });

    await service.performRelayUpdate('v2.4.3', relayArtifact(), 'admin-1');

    expect(state.stepError).toMatch(
      /^Streams through the local relay paused for \d+ s while it was recreated \(no other relay was ready to take its workloads over\)\.$/
    );
  });

  it('keeps the interruption note while some route through the local relay is raw', async () => {
    const reports = () => [{ nodeId: 'node-1', report: { migrationsOkTotal: 0, cutTotal: 0, byRelay: [] } }];
    const { service, state } = localStepPool('no other relay was ready to take its workloads over', { reports });

    await service.performRelayUpdate('v2.4.3', relayArtifact(), 'admin-1');

    expect(state.stepError).toContain('Sessions through the local relay were interrupted once');
  });
});
