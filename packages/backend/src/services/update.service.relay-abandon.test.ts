import { describe, expect, it, vi } from 'vitest';
import { relayInstances, relayPoolUpdateRuns, relayPoolUpdateSteps } from '@/db/schema/index.js';
import {
  LEGACY_INSTALL_DIR_NAME,
  LEGACY_MIN_VERSION_FIELD,
  LEGACY_THESQLABS_UPDATES_BASE_URL,
} from '@/lib/legacy-compat.js';
import type { TrustedRelayUpdateArtifact } from '@/lib/update-artifact-trust.js';
import { UpdateService } from './update.service.js';

const MIGRATED = {
  exitCode: 0,
  output: `{"ok":true,"changedFiles":[],"backupDir":"/host/.opfield-foundation-backups/test","sandboxWorkspaceDir":"/var/lib/${LEGACY_INSTALL_DIR_NAME}/sandbox-workspaces"}`,
};

/** A Relay Pool whose run has one step left: the local relay, as the last step of every run. */
function localStepPool() {
  const state = { run: 'updating', step: 'pending' };
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
    if (table === relayInstances) return [{ id: 'local', kind: 'local', poolId: 'system' }];
    return [];
  };
  const select = () => ({
    from: (table: unknown) => {
      const query = Promise.resolve(rowsFor(table)) as Promise<unknown[]> & Record<string, () => unknown>;
      for (const method of ['where', 'orderBy', 'limit']) query[method] = () => query;
      return query;
    },
  });
  const update = (table: unknown) => ({
    set: (values: { state?: string }) => {
      if (table === relayPoolUpdateRuns && values.state) state.run = values.state;
      if (table === relayPoolUpdateSteps && values.state) state.step = values.state;
      const query = Promise.resolve(undefined) as Promise<undefined> & Record<string, () => unknown>;
      query.where = () => query;
      query.returning = async () => [{ id: 'run-1', relayInstanceId: 'local', drainDeadlineAt: null }];
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
  const dockerService = {
    inspectSelf: vi.fn().mockResolvedValue({
      Config: {
        Image: 'registry.example.com/opfield/opfield:v2.4.2',
        Labels: {
          'com.docker.compose.project.working_dir': '/srv/opfield',
          'com.docker.compose.project': `${LEGACY_INSTALL_DIR_NAME}`,
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
      COMPOSE_PROJECT_DIR: '/srv/opfield',
      RELEASES_API_URL: `${LEGACY_THESQLABS_UPDATES_BASE_URL}/releases`,
      OPFIELD_RELAY_IMAGE_REF: `registry.example.com/opfield/opfield/relay@sha256:${'b'.repeat(64)}`,
      OPFIELD_RELAY_BUILD_VERSION: 'v2.4.2',
      OPFIELD_RELAY_PROTOCOL_MAJOR: 1,
    } as never,
    relayRuntime as never
  );
  service.setAuditLog({ log: vi.fn().mockResolvedValue(true) });
  service.setRelayPoolUpdateRuntime({
    drainInstance: vi.fn(),
    forceDisconnectInstance: vi.fn(),
    prepareWorkerUpdate: vi.fn(),
    dispatchWorkerUpdate: vi.fn(),
    prepareSupervisorUpdate: vi.fn(),
    dispatchSupervisorUpdate: vi.fn(),
  } as never);
  return { service, dockerService, state };
}

function relayArtifact(): TrustedRelayUpdateArtifact {
  const imageRef = `registry.example.com/opfield/opfield/relay@sha256:${'a'.repeat(64)}`;
  const secureLinkConnectorImage = `registry.example.com/opfield/opfield/secure-link-connector@sha256:${'c'.repeat(64)}`;
  return {
    imageRef,
    digest: `sha256:${'a'.repeat(64)}`,
    buildVersion: 'v2.4.3',
    protocolMajor: 1,
    minOpfieldVersion: 'v2.4.2',
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
      [LEGACY_MIN_VERSION_FIELD]: 'v2.4.2',
      secureLinkConnectorImage,
      createdAt: '2026-06-30T00:00:00.000Z',
    },
  };
}

function durableOperation(service: UpdateService) {
  return (
    service as unknown as { getDurableRelayOperation(): Promise<Record<string, unknown>> }
  ).getDurableRelayOperation();
}

describe('Abandoning the local relay step of a Relay Pool update', () => {
  it('is refused once the local relay update began, and the run records that the pool was updated', async () => {
    const { service, dockerService, state } = localStepPool();
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

    await expect(durableOperation(service)).resolves.toMatchObject({ abandonable: false, runState: 'updating' });
    await expect(service.abandonRelayUpdate('admin-1')).rejects.toMatchObject({ code: 'RELAY_UPDATE_COMMITTED' });
    expect(state).toEqual({ run: 'updating', step: 'updating' });

    finishMigration();
    await update;

    expect(state).toEqual({ run: 'complete', step: 'ready' });
  });

  it('stops the update when abandoned before the local relay is touched', async () => {
    const { service, dockerService, state } = localStepPool();
    let finishPull!: () => void;
    dockerService.pullImageRef.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishPull = resolve;
        })
    );
    service.startRelayUpdate('v2.4.3');
    const update = service.performRelayUpdate('v2.4.3', relayArtifact(), 'admin-1');
    const abandoned = expect(update).rejects.toThrow('The Relay Pool update was abandoned');
    await vi.waitFor(() => expect(dockerService.pullImageRef).toHaveBeenCalledOnce());

    await expect(service.abandonRelayUpdate('admin-1')).resolves.toEqual({ targetVersion: 'v2.4.3' });
    finishPull();
    await abandoned;

    // The installation was never rewritten nor the relay recreated: the pool stays on its version and can update again.
    expect(dockerService.runOneShot).not.toHaveBeenCalled();
    expect(state.run).toBe('failed');
  });
});
