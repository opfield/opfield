import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OFFICIAL_IMAGE_REPOSITORIES } from '@/config/vendor-urls.js';
import { relayInstances, relayPoolUpdateRuns, relayPoolUpdateSteps } from '@/db/schema/index.js';
import type { TrustedGatewayUpdateArtifact, TrustedRelayUpdateArtifact } from '@/lib/update-artifact-trust.js';
import {
  DOCKER_COMPOSE_CLI_IMAGE_REF,
  imageRepositoryFromRef,
  isGatewayCompatibleWithRelayUpdate,
  isGatewayReleaseTag,
  isRelayReleaseTag,
  isRelayTooOldForGatewayUpdate,
  isStaleRelayWorkerVersionError,
  relayRecreateStopTimeoutSeconds,
  selectLatestGatewayRelease,
  selectLatestRelayRelease,
  UpdateService,
} from './update.service.js';

describe('relayRecreateStopTimeoutSeconds', () => {
  it('stops a relay without a bounded drain after 2 s instead of waiting for Docker to kill it', () => {
    expect(relayRecreateStopTimeoutSeconds('v2.10.1')).toBe(2);
    expect(relayRecreateStopTimeoutSeconds('v2.10.2-rc.9')).toBe(2);
    expect(relayRecreateStopTimeoutSeconds('v2.11.0-rc.4')).toBe(2);
  });

  it('lets a relay with a bounded drain finish it on its own', () => {
    expect(relayRecreateStopTimeoutSeconds('v2.11.0-rc.7')).toBe(10);
    expect(relayRecreateStopTimeoutSeconds('v2.11.0-rc.19')).toBe(10);
    expect(relayRecreateStopTimeoutSeconds('v2.11.0')).toBe(10);
  });

  it('keeps Docker default when the running relay version is unknown', () => {
    expect(relayRecreateStopTimeoutSeconds(undefined)).toBe(10);
    expect(relayRecreateStopTimeoutSeconds('dev')).toBe(10);
  });
});

describe('isStaleRelayWorkerVersionError', () => {
  const reported =
    'relay worker did not become ready after update: worker did not become ready before deadline: worker reported version v2.11.0-rc.43, expected v2.11.1-rc.1';

  it('recognises a worker update that left the previous worker running', () => {
    expect(isStaleRelayWorkerVersionError(new Error(reported), 'v2.11.1-rc.1')).toBe(true);
    expect(isStaleRelayWorkerVersionError(new Error(reported), '2.11.1-rc.1')).toBe(true);
  });

  it('ignores other failures and mismatches with another target', () => {
    expect(isStaleRelayWorkerVersionError(new Error(reported), 'v2.11.1')).toBe(false);
    expect(isStaleRelayWorkerVersionError(new Error('checksum mismatch'), 'v2.11.1-rc.1')).toBe(false);
    expect(
      isStaleRelayWorkerVersionError(
        new Error('worker reported version v2.11.1-rc.1, expected v2.11.1-rc.1'),
        'v2.11.1-rc.1'
      )
    ).toBe(false);
  });
});

describe('UpdateService release selection', () => {
  it('passes the persisted Preview channel to Gateway and Relay resolution', async () => {
    const db = {
      insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate: vi.fn() })) })),
      delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })),
    };
    const generalSettings = { getConfig: vi.fn().mockResolvedValue({ updateChannel: 'preview' }) };
    const service = new UpdateService(
      db as never,
      makeDockerService() as never,
      {
        APP_VERSION: 'v2.9.15',
        RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
        GATEWAY_RELAY_BUILD_VERSION: 'v2.9.12',
      } as never,
      undefined,
      generalSettings as never
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await service.checkForUpdates();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(
        expect.arrayContaining([
          'https://updates.thesqlabs.com/gateway/releases?component=gateway&current=v2.9.15&channel=preview',
          'https://updates.thesqlabs.com/gateway/releases?component=relay&current=v2.9.12&channel=preview',
        ])
      );
      expect(db.delete).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('builds provider-neutral Gateway and Relay manifest URLs when configured', () => {
    const service = new UpdateService(
      {} as never,
      makeDockerService() as never,
      {
        APP_VERSION: 'v2.9.10',
        GITLAB_API_URL: 'https://gitlab.wiolett.net',
        GITLAB_PROJECT_PATH: 'wiolett/gateway',
        ARTIFACT_BASE_URL: 'https://updates.thesqlabs.com/gateway/',
      } as never
    );

    expect(service.getGatewayManifestUrl('2.9.11')).toBe(
      'https://updates.thesqlabs.com/gateway/gateway/v2.9.11/gateway-image.update.json'
    );
    expect(service.getRelayManifestUrl('2.9.11')).toBe(
      'https://updates.thesqlabs.com/gateway/relay/v2.9.11-relay/relay-image.update.json'
    );
  });

  it('reads GitHub-style release notes from the update facade', async () => {
    const service = new UpdateService(
      {} as never,
      makeDockerService() as never,
      {
        APP_VERSION: 'v2.9.10',
        GITLAB_API_URL: 'https://gitlab.wiolett.net',
        GITLAB_PROJECT_PATH: 'wiolett/gateway',
        RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
      } as never
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json([{ tag_name: 'v2.9.10', body: 'Release notes' }]));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(service.getReleaseNotes('v2.9.10')).resolves.toBe('Release notes');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe('isGatewayReleaseTag', () => {
    it('accepts plain gateway tags', () => {
      expect(isGatewayReleaseTag('v2.1.2')).toBe(true);
      expect(isGatewayReleaseTag('2.1.2')).toBe(true);
    });

    it('rejects daemon-suffixed tags', () => {
      expect(isGatewayReleaseTag('v2.1.1-docker')).toBe(false);
      expect(isGatewayReleaseTag('v2.1.1-nginx')).toBe(false);
      expect(isGatewayReleaseTag('v2.1.1-monitoring')).toBe(false);
      expect(isGatewayReleaseTag('v2.1.1-relay')).toBe(false);
    });
  });

  it('selects relay releases independently from Gateway and daemon tags', () => {
    expect(isRelayReleaseTag('v2.2.0-relay')).toBe(true);
    expect(
      selectLatestRelayRelease([
        { tag_name: 'v2.2.0', description: '', _links: { self: '' } },
        { tag_name: 'v2.1.0-relay', description: '', _links: { self: '' } },
        { tag_name: 'v2.2.0-relay', description: '', _links: { self: '' } },
      ])?.tag_name
    ).toBe('v2.2.0-relay');
  });

  describe('selectLatestGatewayRelease', () => {
    it('ignores daemon release tags and selects the latest plain gateway tag', () => {
      const latest = selectLatestGatewayRelease([
        {
          tag_name: 'v2.1.1-docker',
          description: 'docker',
          _links: { self: 'docker' },
        },
        {
          tag_name: 'v2.1.2',
          description: 'gateway',
          _links: { self: 'gateway' },
        },
        {
          tag_name: 'v2.1.1-monitoring',
          description: 'monitoring',
          _links: { self: 'monitoring' },
        },
      ]);

      expect(latest?.tag_name).toBe('v2.1.2');
    });

    it('returns null when only daemon tags exist', () => {
      const latest = selectLatestGatewayRelease([
        {
          tag_name: 'v2.1.1-docker',
          description: 'docker',
          _links: { self: 'docker' },
        },
        {
          tag_name: 'v2.1.1-nginx',
          description: 'nginx',
          _links: { self: 'nginx' },
        },
      ]);

      expect(latest).toBeNull();
    });
  });

  describe('isRelayTooOldForGatewayUpdate', () => {
    it('allows Gateway updates while Relay is less than two minor versions behind', () => {
      expect(isRelayTooOldForGatewayUpdate('v2.6.12', 'v2.6.13')).toBe(false);
      expect(isRelayTooOldForGatewayUpdate('v2.5.9', 'v2.6.0')).toBe(false);
    });

    it('blocks Gateway updates when Relay is at least two minor versions behind', () => {
      expect(isRelayTooOldForGatewayUpdate('v2.4.12', 'v2.6.0')).toBe(true);
      expect(isRelayTooOldForGatewayUpdate('v2.9.0', 'v3.0.0')).toBe(true);
    });

    it('does not block unverifiable local versions', () => {
      expect(isRelayTooOldForGatewayUpdate('dev', 'v2.7.0')).toBe(false);
    });
  });

  describe('isGatewayCompatibleWithRelayUpdate', () => {
    it('allows independent Relay patches when their declared Gateway floor is satisfied', () => {
      expect(isGatewayCompatibleWithRelayUpdate('v2.7.6', 'v2.7.6')).toBe(true);
      expect(isGatewayCompatibleWithRelayUpdate('v2.7.6', 'v2.7.5')).toBe(true);
      expect(isGatewayCompatibleWithRelayUpdate('v2.7.5', 'v2.7.6')).toBe(false);
    });
  });

  it('hides a cached Relay update until the Gateway compatibility floor is met', async () => {
    const rows = [
      { key: 'update:relay:latest_version', value: 'v2.4.3' },
      { key: 'update:relay:min_gateway_version', value: 'v2.4.3' },
    ];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn().mockResolvedValue(rows) })),
      })),
    } as any;
    const service = new UpdateService(
      db,
      makeDockerService() as never,
      {
        APP_VERSION: 'v2.4.2',
        RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
        ARTIFACT_BASE_URL: 'https://updates.thesqlabs.com/gateway',
        GATEWAY_RELAY_BUILD_VERSION: 'v2.4.1',
      } as never
    );

    expect((await service.getCachedStatus()).relay.updateAvailable).toBe(false);
    rows[1]!.value = 'v2.4.2';
    expect((await service.getCachedStatus()).relay.updateAvailable).toBe(true);
  });

  it('hides cached Gateway and Relay release candidates immediately after switching back to Stable', async () => {
    const rows = [
      { key: 'update:latest_version', value: 'v2.5.0-rc.2' },
      { key: 'update:release_notes', value: 'Preview notes' },
      { key: 'update:release_url', value: 'https://example.com/gateway-rc' },
      { key: 'update:relay:latest_version', value: 'v2.5.0-rc.3' },
      { key: 'update:relay:release_notes', value: 'Relay preview notes' },
      { key: 'update:relay:release_url', value: 'https://example.com/relay-rc' },
      { key: 'update:relay:min_gateway_version', value: 'v2.4.0' },
    ];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn().mockResolvedValue(rows) })),
      })),
    } as never;
    const service = new UpdateService(
      db,
      makeDockerService() as never,
      {
        APP_VERSION: 'v2.4.0',
        RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
        GATEWAY_RELAY_BUILD_VERSION: 'v2.4.0',
      } as never,
      undefined,
      { getConfig: vi.fn().mockResolvedValue({ updateChannel: 'stable' }) } as never
    );

    await expect(service.getCachedStatus()).resolves.toMatchObject({
      latestVersion: null,
      updateAvailable: false,
      releaseNotes: null,
      releaseUrl: null,
      relay: {
        latestVersion: null,
        updateAvailable: false,
        releaseNotes: null,
        releaseUrl: null,
      },
    });
  });
});

describe('imageRepositoryFromRef', () => {
  it('removes a mutable tag after a registry port', () => {
    expect(imageRepositoryFromRef('registry.example.com:5050/wiolett/gateway:v2.3.0')).toBe(
      'registry.example.com:5050/wiolett/gateway'
    );
  });

  it('removes a digest from an immutable image reference', () => {
    expect(imageRepositoryFromRef('registry.example.com/wiolett/gateway@sha256:abc')).toBe(
      'registry.example.com/wiolett/gateway'
    );
  });

  it('keeps untagged image references unchanged', () => {
    expect(imageRepositoryFromRef('registry.example.com/wiolett/gateway')).toBe('registry.example.com/wiolett/gateway');
  });
});

describe('UpdateService foundation migration', () => {
  it('prevents concurrent module activation and Gateway updates from modifying the same installation', async () => {
    const dockerService = makeDockerService();
    let rejectPull!: (reason: Error) => void;
    const waiting = new Promise<void>((_, reject) => {
      rejectPull = reject;
    });
    dockerService.pullImageRef.mockImplementationOnce(() => waiting);
    const service = makeUpdateService(dockerService);
    const artifact = makeArtifact('registry.example.com/wiolett/gateway@sha256:new');
    const first = service.performUpdate('v2.4.3', artifact);
    const failed = expect(first).rejects.toThrow('download interrupted');
    await vi.waitFor(() => expect(dockerService.pullImageRef).toHaveBeenCalledOnce());
    await expect(service.performUpdate('v2.4.3', artifact)).rejects.toMatchObject({ code: 'UPDATE_IN_PROGRESS' });
    expect(dockerService.runOneShot).not.toHaveBeenCalled();
    rejectPull(new Error('download interrupted'));
    await failed;
    await service.performUpdate('v2.4.3', artifact);
    expect(dockerService.runDetached).toHaveBeenCalledOnce();
  });
  it('never migrates or replaces the running app when target-image license/core preparation fails', async () => {
    const dockerService = makeDockerService();
    dockerService.runOneShot.mockResolvedValueOnce({ exitCode: 0, output: '' }).mockResolvedValueOnce({
      exitCode: 1,
      output: 'Private core signature verification failed',
    });
    await expect(
      makeUpdateService(dockerService).performUpdate(
        'v2.4.3',
        makeArtifact('registry.example.com/wiolett/gateway@sha256:new')
      )
    ).rejects.toThrow('Private core signature verification failed');
    // Backup, the failed preparation, and restoring the untouched .env.
    expect(dockerService.runOneShot).toHaveBeenCalledTimes(3);
    expect(dockerService.runOneShot).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ Env: [expect.stringMatching(PRE_UPDATE_BACKUP_ENV)] })
    );
    expect(dockerService.runDetached).not.toHaveBeenCalled();
  });
  it('tells the foundation migrator the host Docker logging defaults', async () => {
    const dockerService = {
      ...makeDockerService(),
      getDaemonInfo: vi.fn().mockResolvedValue({ LoggingDriver: 'json-file' }),
    };
    dockerService.inspectSelf.mockResolvedValue({
      Config: {
        Image: 'registry.example.com/wiolett/gateway:v2.4.2',
        Labels: {
          'com.docker.compose.project.working_dir': '/srv/gateway',
          'com.docker.compose.project': 'gateway',
        },
      },
      HostConfig: { LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '5' } } },
    } as never);
    const artifact = makeArtifact('registry.example.com/wiolett/gateway@sha256:new');

    await makeUpdateService(dockerService).performUpdate('v2.4.3', artifact);

    expect(dockerService.runOneShot).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        Cmd: expect.arrayContaining(['dist/foundation-migrator.js']),
        Env: ['GATEWAY_DOCKER_LOG_DRIVER=json-file', 'GATEWAY_DOCKER_LOG_OPTS=set'],
      })
    );
  });

  it('runs foundation migrations from the target image before validating and recreating compose', async () => {
    const dockerService = makeDockerService();
    const service = makeUpdateService(dockerService);
    const artifact = makeArtifact('registry.example.com/wiolett/gateway@sha256:new');

    await service.performUpdate('v2.4.3', artifact);

    expect(dockerService.pullImageRef).toHaveBeenNthCalledWith(1, artifact.imageRef);
    expect(dockerService.pullImageRef).toHaveBeenNthCalledWith(2, DOCKER_COMPOSE_CLI_IMAGE_REF);
    expect(dockerService.runOneShot).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        Image: DOCKER_COMPOSE_CLI_IMAGE_REF,
        Cmd: ['sh', '-c', expect.stringContaining('cp -p /host/.env "$backup/.env"')],
        Env: [expect.stringMatching(/^FOUNDATION_BACKUP_DIR=\/host\/\.gateway-foundation-backups\/pre-update-/)],
        HostConfig: { Binds: ['/srv/gateway:/host'] },
      })
    );
    expect(dockerService.runOneShot).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        Image: artifact.imageRef,
        Cmd: ['node', 'dist/cli/migrate-legacy-settings.js', '/host'],
        Env: expect.not.arrayContaining([
          expect.stringMatching(/^OIDC_/),
          expect.stringMatching(/^CLICKHOUSE_/),
          expect.stringMatching(/^APP_URL=/),
        ]),
        HostConfig: expect.objectContaining({ Binds: ['/srv/gateway:/host'] }),
      })
    );
    expect(dockerService.runOneShot).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        Image: artifact.imageRef,
        Cmd: [
          'node',
          'dist/foundation-migrator.js',
          '--host-dir',
          '/host',
          '--target-version',
          'v2.4.3',
          '--image-ref',
          artifact.imageRef,
        ],
        HostConfig: expect.objectContaining({
          Binds: expect.arrayContaining([
            '/srv/gateway:/host',
            '/var/lib/gateway/sandbox-workspaces:/var/lib/gateway/sandbox-workspaces',
          ]),
        }),
      })
    );
    expect(dockerService.runOneShot).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        Image: artifact.imageRef,
        Cmd: ['sh', '-c', 'set -eu\nmkdir -p "$SANDBOX_WORKSPACE_DIR"\nchmod 700 "$SANDBOX_WORKSPACE_DIR"'],
        Env: ['SANDBOX_WORKSPACE_DIR=/var/lib/gateway/sandbox-workspaces'],
        HostConfig: expect.objectContaining({
          Binds: ['/var/lib/gateway/sandbox-workspaces:/var/lib/gateway/sandbox-workspaces'],
        }),
      })
    );
    expect(dockerService.runOneShot).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        Cmd: [
          'docker',
          'compose',
          '--project-name',
          'gateway',
          '-f',
          '/project/docker-compose.yml',
          'config',
          '--quiet',
        ],
      })
    );
    expect(dockerService.runDetached).toHaveBeenCalledWith(
      expect.objectContaining({
        Cmd: ['sh', '-c', expect.stringContaining('compose up -d --force-recreate app')],
        // The sidecar restores the files as they were before the legacy settings migration.
        Env: [
          expect.stringMatching(
            /^FOUNDATION_BACKUP_DIR=\/srv\/gateway\/\.gateway-foundation-backups\/pre-update-[\w.-]+$/
          ),
        ],
        HostConfig: {
          Binds: ['/srv/gateway:/srv/gateway', '/var/run/docker.sock:/var/run/docker.sock'],
        },
      })
    );
    const sidecarCommand = dockerService.runDetached.mock.calls[0]?.[0]?.Cmd?.[2];
    if (typeof sidecarCommand !== 'string') throw new Error('Update sidecar command was not recorded');
    expect(sidecarCommand).toContain('docker inspect --format');
    expect(sidecarCommand).toContain('rollback');
    expect(sidecarCommand).toContain('trap on_exit EXIT');
    expect(sidecarCommand).toContain(
      'compose() { docker compose --project-name gateway --project-directory /srv/gateway -f /srv/gateway/docker-compose.yml "$@"; }'
    );
    expect(sidecarCommand).toContain('cp -p "$FOUNDATION_BACKUP_DIR/.env" /srv/gateway/.env');
    expect(sidecarCommand).toContain('service_exists() { compose config --services | grep -qx "$1"; }');
    expect(sidecarCommand).toContain('ensure_foundation_services()');
    expect(sidecarCommand).toContain('for service in $(compose config --services); do');
    expect(sidecarCommand).toContain('[ "$service" = app ] && continue');
    expect(sidecarCommand).toContain('compose up -d --no-recreate "$service"');
    expect(sidecarCommand).toContain('registry_ready()');
    expect(sidecarCommand).toContain('sleep 2\nensure_foundation_services\n');
    // The snapshot is taken before the target app can apply its migrations.
    expect(sidecarCommand.indexOf('snapshot_database || exit 1')).toBeGreaterThan(-1);
    expect(sidecarCommand.indexOf('snapshot_database || exit 1')).toBeLessThan(
      sidecarCommand.indexOf('compose up -d --no-deps --force-recreate app')
    );
    expect(sidecarCommand).toContain('GATEWAY_DB_DUMP="$FOUNDATION_BACKUP_DIR/gateway-db.dump"');
    expect(sidecarCommand).toContain("SELECT pg_database_size('gateway')");
    expect(sidecarCommand).toContain('df -Pk "$FOUNDATION_BACKUP_DIR"');
    expect(sidecarCommand).toContain(
      'compose exec -T postgres pg_dump --format=custom --create --no-password -U gateway -d gateway > "$GATEWAY_DB_DUMP"'
    );
    expect(sidecarCommand).toContain('chmod 600 "$GATEWAY_DB_DUMP"');
    expect(sidecarCommand).toContain(
      'for old_dump in /srv/gateway/.gateway-foundation-backups/pre-update-*/gateway-db.dump; do'
    );
    // The rollback restores the snapshot once postgres is ready, before the previous app starts.
    const rollbackBody = sidecarCommand.slice(
      sidecarCommand.indexOf('rollback() {'),
      sidecarCommand.indexOf('on_exit() {')
    );
    expect(rollbackBody.indexOf('pg_isready')).toBeLessThan(rollbackBody.indexOf('restore_database_snapshot'));
    expect(rollbackBody.indexOf('restore_database_snapshot')).toBeLessThan(rollbackBody.indexOf('compose up -d app'));
    expect(sidecarCommand).toContain("-d postgres -c 'DROP DATABASE IF EXISTS gateway WITH (FORCE)'");
    expect(sidecarCommand).toContain(
      'compose exec -T postgres pg_restore --create --exit-on-error --no-password -U gateway -d postgres < "$GATEWAY_DB_DUMP"'
    );
    expect(sidecarCommand).toContain('if [ "$code" -eq 0 ]; then rm -f "$GATEWAY_DB_DUMP" || true; fi');
    expect(sidecarCommand).toContain('relay_reachable && registry_ready');
    expect(sidecarCommand).toContain('compose stop app');
    expect(sidecarCommand).not.toContain('compose stop app relay');
    expect(sidecarCommand).toContain(
      'if [ "$rollback_has_relay" -eq 1 ]; then\n    compose up -d --no-deps app\n  else\n    compose up -d app\n  fi'
    );
    expect(sidecarCommand).toContain(
      'if service_exists relay; then\n  compose up -d --no-deps --force-recreate app\nelse\n  compose up -d --force-recreate app\nfi'
    );
    expect(sidecarCommand).toContain('relay_reachable()');
    expect(sidecarCommand).toContain('net.connect(9443,"relay"');
    expect(sidecarCommand).toContain('relay_networks="$(docker inspect');
    expect(sidecarCommand).toContain('relay_public_port="$(docker port "$relay_id" 9443/tcp)"');
    expect(sidecarCommand).toContain('[ "$app_working_dir" = /srv/gateway ]');
    expect(sidecarCommand).not.toContain(
      'if [ "$app_health" = unhealthy ] || [ "$relay_health" = unhealthy ]; then break; fi'
    );
    expect(sidecarCommand).toContain('CREATE OR REPLACE VIEW "public"."gateway_relay_bindings_v1"');
    const syntax = spawnSync('/bin/sh', ['-n'], { input: sidecarCommand, encoding: 'utf8' });
    expect(syntax.stderr).toBe('');
    expect(syntax.status).toBe(0);
  });

  it('updates relay without recreating the Gateway app', async () => {
    const dockerService = makeDockerService();
    const relayRuntime = {
      setMaintenance: vi.fn().mockResolvedValue(undefined),
      setExpectedArtifact: vi.fn(),
      updateSecureLinkConnectorImage: vi.fn().mockResolvedValue(undefined),
      probeNow: vi.fn().mockResolvedValue(undefined),
    };
    const service = makeUpdateService(dockerService, relayRuntime);
    const relay = makeRelayArtifact();

    await service.performRelayUpdate('v2.4.3', relay);

    expect(dockerService.pullImageRef).toHaveBeenNthCalledWith(1, relay.imageRef);
    expect(dockerService.pullImageRef).toHaveBeenNthCalledWith(2, DOCKER_COMPOSE_CLI_IMAGE_REF);
    const updateCommand = dockerService.runOneShot.mock.calls[2]?.[0]?.Cmd?.[2];
    // v2.4.2 predates the relay's bounded drain: it would hang until Docker's 10 s kill (C-3).
    expect(updateCommand).toContain('compose up -d --no-deps --force-recreate --timeout 2 relay');
    expect(updateCommand).not.toContain('force-recreate app');
    expect(dockerService.runDetached).not.toHaveBeenCalled();
    expect(relayRuntime.setMaintenance).toHaveBeenNthCalledWith(1, true);
    expect(relayRuntime.setMaintenance).toHaveBeenLastCalledWith(false);
    expect(relayRuntime.setExpectedArtifact).toHaveBeenCalledWith(
      relay.imageRef,
      relay.buildVersion,
      relay.protocolMajor
    );
    expect(dockerService.runOneShot).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        Cmd: expect.arrayContaining(['--secure-link-connector-image', relay.secureLinkConnectorImage]),
      })
    );
    expect(relayRuntime.updateSecureLinkConnectorImage).toHaveBeenCalledWith(relay.secureLinkConnectorImage);
    expect(relayRuntime.probeNow).toHaveBeenCalled();
  });

  it('creates the Relay Pool update run and steps atomically under the rebalance lock', async () => {
    const events: string[] = [];
    const poolInstances = [
      { id: 'remote', kind: 'remote', state: 'ready', faultDomainId: 'remote-host', buildVersion: 'v2.4.2' },
      { id: 'local', kind: 'local', state: 'ready', faultDomainId: 'gateway', buildVersion: 'v2.4.2' },
    ];
    const selections = [[], poolInstances];
    const selectedTables: unknown[] = [];
    const query = (rows: unknown[]) => {
      const result = Promise.resolve(rows) as Promise<unknown[]> & Record<string, () => unknown>;
      result.from = (table?: unknown) => {
        selectedTables.push(table);
        return result;
      };
      for (const method of ['where', 'orderBy', 'limit']) result[method] = () => result;
      return result;
    };
    const steps: unknown[] = [];
    const tx = {
      execute: vi.fn(async () => {
        events.push('lock');
      }),
      select: vi.fn(() => {
        events.push(selections.length === 2 ? 'read-runs' : 'read-instances');
        return query(selections.shift() ?? []);
      }),
      insert: vi.fn((table: unknown) => {
        if (table === relayPoolUpdateRuns) {
          events.push('insert-run');
          return {
            values: () => ({ returning: async () => [{ id: 'run-1', targetArtifact: { version: 'v2.4.3' } }] }),
          };
        }
        expect(table).toBe(relayPoolUpdateSteps);
        events.push('insert-steps');
        return {
          values: async (values: unknown[]) => {
            steps.push(...values);
          },
        };
      }),
    };
    const db = {
      transaction: vi.fn(async (write: (executor: typeof tx) => Promise<unknown>) => write(tx)),
    };
    const service = new UpdateService(
      db as never,
      makeDockerService() as never,
      {
        APP_VERSION: 'v2.4.2',
        RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
      } as never
    );

    const run = await (
      service as unknown as {
        ensureRelayPoolUpdateRun: (version: string, artifact: TrustedRelayUpdateArtifact) => Promise<{ id: string }>;
      }
    ).ensureRelayPoolUpdateRun('v2.4.3', makeRelayArtifact());

    expect(run.id).toBe('run-1');
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(events).toEqual(['lock', 'read-runs', 'read-instances', 'insert-run', 'insert-steps']);
    expect(steps).toMatchObject([
      { runId: 'run-1', relayInstanceId: 'remote', sequence: 0 },
      { runId: 'run-1', relayInstanceId: 'local', sequence: 1 },
    ]);
    expect(tx.select).toHaveBeenCalledTimes(2);
    expect(selectedTables).toEqual([relayPoolUpdateRuns, relayInstances]);
    expect(tx.insert).toHaveBeenNthCalledWith(1, relayPoolUpdateRuns);
    expect(tx.insert).toHaveBeenNthCalledWith(2, relayPoolUpdateSteps);
  });

  it('allows a signed Relay migration from the running registry to an allow-listed GHCR repository', async () => {
    const dockerService = makeDockerService();
    const service = makeUpdateService(dockerService, undefined, {
      GATEWAY_UPDATE_IMAGE_REPOSITORIES: 'ghcr.io/the-square-labs/gateway',
    });
    const relay = makeRelayArtifact();
    const relayImage = 'ghcr.io/the-square-labs/gateway/relay';
    relay.imageRef = `${relayImage}@${relay.digest}`;
    relay.payload.image = relayImage;
    relay.payload.imageRef = relay.imageRef;

    await service.performRelayUpdate('v2.4.3', relay);

    expect(dockerService.pullImageRef).toHaveBeenNthCalledWith(1, relay.imageRef);
  });

  it('accepts signed Relay images from both official repositories by default', async () => {
    for (const repository of OFFICIAL_IMAGE_REPOSITORIES) {
      const dockerService = makeDockerService();
      const service = makeUpdateService(dockerService, undefined, {
        GATEWAY_UPDATE_IMAGE_REPOSITORIES: OFFICIAL_IMAGE_REPOSITORIES.join(','),
      });
      const relay = makeRelayArtifact();
      relay.imageRef = `${repository}/relay@${relay.digest}`;
      relay.payload.image = `${repository}/relay`;
      relay.payload.imageRef = relay.imageRef;

      await service.performRelayUpdate('v2.4.3', relay);

      expect(dockerService.pullImageRef).toHaveBeenNthCalledWith(1, relay.imageRef);
    }
  });

  it('rejects a signed Relay artifact outside the configured repository allowlist', async () => {
    const dockerService = makeDockerService();
    const service = makeUpdateService(dockerService, undefined, {
      GATEWAY_UPDATE_IMAGE_REPOSITORIES: 'ghcr.io/the-square-labs/gateway',
    });
    const relay = makeRelayArtifact();
    const relayImage = 'ghcr.io/untrusted/gateway/relay';
    relay.imageRef = `${relayImage}@${relay.digest}`;
    relay.payload.image = relayImage;
    relay.payload.imageRef = relay.imageRef;

    await expect(service.performRelayUpdate('v2.4.3', relay)).rejects.toThrow(
      'Signed relay artifact does not match the requested release'
    );
    expect(dockerService.pullImageRef).not.toHaveBeenCalled();
  });

  it('keeps the Relay update operation on the server', () => {
    const service = makeUpdateService(makeDockerService());

    service.startRelayUpdate('v2.6.13');
    expect((service as unknown as { relayUpdateOperation: unknown }).relayUpdateOperation).toMatchObject({
      status: 'updating',
      targetVersion: 'v2.6.13',
      error: null,
    });

    expect(() => service.startRelayUpdate('v2.6.14')).toThrow('already in progress');
    service.completeRelayUpdate();
    expect((service as unknown as { relayUpdateOperation: unknown }).relayUpdateOperation).toBeNull();
  });

  it('does not recreate the app when migrated compose validation fails', async () => {
    const dockerService = makeDockerService();
    dockerService.runOneShot
      .mockResolvedValueOnce({ exitCode: 0, output: '' })
      .mockResolvedValueOnce({ exitCode: 0, output: '{"ok":true}' })
      .mockResolvedValueOnce({
        exitCode: 0,
        output:
          '{"ok":true,"changedFiles":["docker-compose.yml"],"backupDir":"/host/.gateway-foundation-backups/test","sandboxWorkspaceDir":"/var/lib/gateway/sandbox-workspaces"}',
      })
      .mockResolvedValueOnce({ exitCode: 0, output: '' })
      .mockResolvedValueOnce({ exitCode: 1, output: 'bad compose' })
      .mockResolvedValueOnce({ exitCode: 0, output: '' });
    const service = makeUpdateService(dockerService);

    await expect(
      service.performUpdate('v2.4.3', makeArtifact('registry.example.com/wiolett/gateway:v2.4.3'))
    ).rejects.toThrow('Migrated docker-compose.yml failed validation');

    expect(dockerService.runOneShot).toHaveBeenNthCalledWith(
      6,
      expect.objectContaining({
        Image: 'registry.example.com/wiolett/gateway:v2.4.3',
        Env: [expect.stringMatching(PRE_UPDATE_BACKUP_ENV)],
      })
    );
    expect(dockerService.runDetached).not.toHaveBeenCalled();
  });

  it('does not propagate a legacy database connector image through the foundation migration', async () => {
    const dockerService = makeDockerService();
    const service = makeUpdateService(dockerService);
    const connectorImage = 'registry.example.com/wiolett/gateway/database-connector@sha256:connector-digest';

    await service.performUpdate(
      'v2.4.3',
      makeArtifact('registry.example.com/wiolett/gateway:v2.4.3', undefined, connectorImage)
    );

    const command = dockerService.runOneShot.mock.calls[2]?.[0]?.Cmd ?? [];
    expect(command).not.toContain('--database-connector-image');
    expect(command).not.toContain(connectorImage);
  });

  it('persists the verified Secure Link connector image through the foundation migration', async () => {
    const dockerService = makeDockerService();
    const service = makeUpdateService(dockerService);
    const connectorImage = 'registry.example.com/wiolett/gateway/secure-link-connector@sha256:connector-digest';

    await service.performUpdate('v2.4.3', makeArtifact('registry.example.com/wiolett/gateway:v2.4.3', connectorImage));

    expect(dockerService.runOneShot).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        Cmd: expect.arrayContaining(['--secure-link-connector-image', connectorImage]),
      })
    );
  });

  it('allows a signed migration from the running registry to an allow-listed GHCR repository', async () => {
    const dockerService = makeDockerService();
    const service = makeUpdateService(dockerService, undefined, {
      GATEWAY_UPDATE_IMAGE_REPOSITORIES: 'ghcr.io/the-square-labs/gateway',
    });
    const artifact = makeArtifact(`ghcr.io/the-square-labs/gateway@sha256:${'c'.repeat(64)}`);
    artifact.payload.image = 'ghcr.io/the-square-labs/gateway';

    await service.performUpdate('v2.4.3', artifact);

    expect(dockerService.pullImageRef).toHaveBeenCalledWith(artifact.imageRef);
  });

  it('updates an install running the earlier repository to a release signed for either official repository', async () => {
    for (const repository of OFFICIAL_IMAGE_REPOSITORIES) {
      const dockerService = makeDockerService();
      dockerService.inspectSelf.mockResolvedValue({
        Config: {
          Image: 'ghcr.io/the-square-labs/gateway:v2.11.5',
          Labels: {
            'com.docker.compose.project.working_dir': '/srv/gateway',
            'com.docker.compose.project': 'gateway',
          },
        },
      });
      const service = makeUpdateService(dockerService, undefined, {
        GATEWAY_UPDATE_IMAGE_REPOSITORIES: OFFICIAL_IMAGE_REPOSITORIES.join(','),
      });
      const artifact = makeArtifact(`${repository}@sha256:${'c'.repeat(64)}`);
      artifact.payload.image = repository;

      await service.performUpdate('v2.4.3', artifact);

      expect(dockerService.pullImageRef).toHaveBeenCalledWith(artifact.imageRef);
    }
  });

  it('still refuses a signed Gateway image outside the official repositories', async () => {
    const dockerService = makeDockerService();
    const service = makeUpdateService(dockerService, undefined, {
      GATEWAY_UPDATE_IMAGE_REPOSITORIES: OFFICIAL_IMAGE_REPOSITORIES.join(','),
    });
    const artifact = makeArtifact(`ghcr.io/opfield/other@sha256:${'c'.repeat(64)}`);
    artifact.payload.image = 'ghcr.io/opfield/other';

    await expect(service.performUpdate('v2.4.3', artifact)).rejects.toThrow(
      'is not an allowed Gateway image repository'
    );
    expect(dockerService.pullImageRef).not.toHaveBeenCalled();
  });

  it('prepares a custom sandbox workspace directory from the migrator output', async () => {
    const dockerService = makeDockerService();
    dockerService.runOneShot
      .mockResolvedValueOnce({ exitCode: 0, output: '' })
      .mockResolvedValueOnce({ exitCode: 0, output: '{"ok":true}' })
      .mockResolvedValueOnce({
        exitCode: 0,
        output:
          '{"ok":true,"changedFiles":[".env","docker-compose.yml"],"backupDir":"/host/.gateway-foundation-backups/test","sandboxWorkspaceDir":"/srv/gateway-workspaces"}',
      });
    const service = makeUpdateService(dockerService);
    const artifact = makeArtifact('registry.example.com/wiolett/gateway:v2.4.3');

    await service.performUpdate('v2.4.3', artifact);

    expect(dockerService.runOneShot).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        Env: ['SANDBOX_WORKSPACE_DIR=/srv/gateway-workspaces'],
        HostConfig: { Binds: ['/srv/gateway-workspaces:/srv/gateway-workspaces'] },
      })
    );
  });
});

describe('UpdateService update sidecar database snapshot', () => {
  // Stands in for the Docker CLI: records every call, answers what the sidecar reads.
  const FAKE_DOCKER = String.raw`#!/bin/sh
if [ "$1" = compose ]; then
  shift 7
  echo "compose $*" >> "$FAKE_LOG"
  case "$*" in
    "config --services") printf 'app\nrelay\nregistry\npostgres\nredis\n' ;;
    "ps -q "*) echo "$3-id" ;;
    *"--force-recreate app") [ "$FAKE_TARGET_APP" = healthy ] || exit 1 ;;
    *"pg_database_size"*) echo "$FAKE_DB_BYTES" ;;
    *" pg_dump "*)
      [ "$FAKE_DUMP" != fail ] || exit 1
      [ "$FAKE_DUMP" = empty ] || printf 'PGDMP-fake-archive' ;;
    *" pg_restore --list") cat > /dev/null ;;
    *" pg_restore --create "*) cat > /dev/null; [ "$FAKE_RESTORE" = ok ] || exit 1 ;;
    *"DROP DATABASE"*) [ "$FAKE_DROP" = ok ] || exit 1 ;;
  esac
  exit 0
fi
echo "docker $*" >> "$FAKE_LOG"
case "$*" in
  *working_dir*) echo "$FAKE_COMPOSE_DIR" ;;
  *Networks*) echo 1 ;;
  inspect*) echo healthy ;;
  port*) echo 0.0.0.0:9443 ;;
esac
`;
  const FAKE_DF = `#!/bin/sh
echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'
echo "/dev/fake 999999999 1 $FAKE_FREE_KB 1% /"
`;
  const GIB_BYTES = 1024 * 1024 * 1024;
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Generates the sidecar script for a real update and runs it against the fakes. */
  async function runSidecar(
    options: {
      freeKb?: number;
      dump?: 'ok' | 'fail' | 'empty';
      targetApp?: 'healthy' | 'fail';
      drop?: 'ok' | 'fail';
      restore?: 'ok' | 'fail';
      prepare?: (composeDir: string, backupDir: string) => void;
    } = {}
  ) {
    const composeDir = mkdtempSync(join(tmpdir(), 'gateway-update-'));
    dirs.push(composeDir);
    const bin = join(composeDir, 'fake-bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
    writeFileSync(join(bin, 'df'), FAKE_DF, { mode: 0o755 });
    writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const dockerService = makeDockerService();
    await makeUpdateService(dockerService, undefined, { COMPOSE_PROJECT_DIR: composeDir }).performUpdate(
      'v2.4.3',
      makeArtifact('registry.example.com/wiolett/gateway@sha256:new')
    );
    const sidecar = dockerService.runDetached.mock.calls[0]?.[0] as { Cmd: string[]; Env: string[] } | undefined;
    const script = sidecar?.Cmd[2];
    const backupDir = sidecar?.Env[0]?.replace(/^FOUNDATION_BACKUP_DIR=/, '');
    if (!script || !backupDir) throw new Error('Update sidecar was not launched');
    mkdirSync(backupDir, { recursive: true });
    options.prepare?.(composeDir, backupDir);

    const log = join(composeDir, 'docker-calls.log');
    const result = spawnSync('/bin/sh', ['-c', script], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        FOUNDATION_BACKUP_DIR: backupDir,
        FAKE_LOG: log,
        FAKE_COMPOSE_DIR: composeDir,
        FAKE_DB_BYTES: String(GIB_BYTES),
        FAKE_FREE_KB: String(options.freeKb ?? 10 * 1024 * 1024),
        FAKE_DUMP: options.dump ?? 'ok',
        FAKE_TARGET_APP: options.targetApp ?? 'healthy',
        FAKE_DROP: options.drop ?? 'ok',
        FAKE_RESTORE: options.restore ?? 'ok',
      },
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    const at = (fragment: string) => calls.findIndex((call) => call.includes(fragment));
    return { ...result, calls, at, composeDir, dump: join(backupDir, 'gateway-db.dump') };
  }

  it('snapshots the database before the target app starts and removes the snapshot once it is healthy', async () => {
    const run = await runSidecar();

    expect(run.status).toBe(0);
    expect(run.at('pg_database_size')).toBeGreaterThan(-1);
    expect(run.at('pg_database_size')).toBeLessThan(run.at(' pg_dump --format=custom --create '));
    expect(run.at(' pg_dump ')).toBeLessThan(run.at(' pg_restore --list'));
    expect(run.at(' pg_restore --list')).toBeLessThan(run.at('--force-recreate app'));
    expect(run.at('DROP DATABASE')).toBe(-1);
    expect(run.at('pg_restore --create')).toBe(-1);
    expect(existsSync(run.dump)).toBe(false);
  });

  it('stops the update before replacing the app when the snapshot does not fit on the disk', async () => {
    const run = await runSidecar({ freeKb: 1024 * 1024 });

    expect(run.status).toBe(1);
    // 1 GiB database + 10% + 256 MiB margin.
    expect(run.stderr).toMatch(/needs 1382 MiB free in \S+pre-update-\S+, but only 1024 MiB are free/);
    expect(run.at(' pg_dump ')).toBe(-1);
    expect(run.at('--force-recreate app')).toBe(-1);
    // Nothing migrated: the rollback only brings the previous app back.
    expect(run.at('DROP DATABASE')).toBe(-1);
    expect(run.calls).toContain('compose up -d --no-deps app');
  });

  it.each(['fail', 'empty'] as const)('stops the update before replacing the app when the dump is %s', async (dump) => {
    const run = await runSidecar({ dump });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Gateway update stopped before replacing the app');
    expect(run.at('--force-recreate app')).toBe(-1);
    expect(run.at('DROP DATABASE')).toBe(-1);
    expect(existsSync(run.dump)).toBe(false);
  });

  it('restores the snapshot before the previous app starts when the update rolls back', async () => {
    const run = await runSidecar({
      targetApp: 'fail',
      prepare: (composeDir, backupDir) => {
        writeFileSync(join(backupDir, '.env'), 'GATEWAY_IMAGE_REF=previous\n');
        writeFileSync(join(composeDir, '.env'), 'GATEWAY_IMAGE_REF=target\n');
      },
    });

    expect(run.status).toBe(1);
    expect(readFileSync(join(run.composeDir, '.env'), 'utf8')).toBe('GATEWAY_IMAGE_REF=previous\n');
    const recreate = run.at('--force-recreate app');
    const ready = run.at('pg_isready');
    const drop = run.at('-d postgres -c DROP DATABASE IF EXISTS gateway WITH (FORCE)');
    const restore = run.at('pg_restore --create --exit-on-error --no-password -U gateway -d postgres');
    expect(recreate).toBeGreaterThan(-1);
    expect(recreate).toBeLessThan(ready);
    expect(ready).toBeLessThan(drop);
    // Every other service is stopped first so nothing holds or reopens a connection.
    for (const service of ['relay', 'registry', 'redis']) {
      expect(run.at(`compose stop ${service}`)).toBeGreaterThan(ready);
      expect(run.at(`compose stop ${service}`)).toBeLessThan(drop);
    }
    expect(run.at('compose stop postgres')).toBe(-1);
    expect(drop).toBeLessThan(restore);
    expect(restore).toBeLessThan(run.at('CREATE OR REPLACE VIEW'));
    expect(restore).toBeLessThan(run.calls.indexOf('compose up -d --no-deps app'));
    expect(run.stdout).toContain('Restored the gateway database from the pre-update snapshot');
    expect(existsSync(run.dump)).toBe(false);
  });

  it('keeps the snapshot and leaves Gateway stopped when the restore fails after the drop', async () => {
    const run = await runSidecar({ targetApp: 'fail', restore: 'fail' });

    expect(run.status).not.toBe(0);
    expect(run.at('pg_restore --create')).toBeGreaterThan(run.at('DROP DATABASE'));
    expect(run.stderr).toContain(`Gateway is left stopped. The pre-update snapshot is kept at ${run.dump}`);
    expect(run.calls).not.toContain('compose up -d --no-deps app');
    expect(existsSync(run.dump)).toBe(true);
    expect(statSync(run.dump).mode & 0o777).toBe(0o600);
  });

  it('keeps the snapshot and brings the previous app back when the migrated database cannot be dropped', async () => {
    const run = await runSidecar({ targetApp: 'fail', drop: 'fail' });

    expect(run.status).toBe(1);
    expect(run.at('pg_restore --create')).toBe(-1);
    expect(run.stderr).toContain(`was NOT restored and keeps the changes of the failed update`);
    expect(run.calls).toContain('compose up -d --no-deps app');
    expect(existsSync(run.dump)).toBe(true);
  });

  it('removes database snapshots of earlier updates after a week', async () => {
    const days = (count: number) => (Date.now() - count * 24 * 60 * 60_000) / 1000;
    const run = await runSidecar({
      prepare: (composeDir) => {
        for (const [name, age] of [
          ['pre-update-old', 10],
          ['pre-update-recent', 1],
        ] as const) {
          const dir = join(composeDir, '.gateway-foundation-backups', name);
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'gateway-db.dump'), 'PGDMP');
          utimesSync(join(dir, 'gateway-db.dump'), days(age), days(age));
        }
      },
    });

    expect(run.status).toBe(0);
    const backups = join(run.composeDir, '.gateway-foundation-backups');
    expect(existsSync(join(backups, 'pre-update-old', 'gateway-db.dump'))).toBe(false);
    expect(existsSync(join(backups, 'pre-update-recent', 'gateway-db.dump'))).toBe(true);
  });
});

describe('UpdateService orchestration gate', () => {
  const deployment = (running: number, queued = 0, expectedBy: number | null = null) => [
    { kind: 'deployment', label: 'Blue/green deployment operations', running, queued, expectedBy },
  ];

  function gatedService(readings: () => ReturnType<typeof deployment> | null) {
    const dockerService = makeDockerService();
    const service = makeUpdateService(dockerService);
    const source = {
      activeOrchestrationOperations: vi.fn(async () => readings()),
      setOrchestrationAdmissionHold: vi.fn(() => true),
    };
    const events = { publish: vi.fn() };
    service.setOrchestrationGate(source, events);
    const operation = () => (service as unknown as { gatewayUpdateOperation: unknown }).gatewayUpdateOperation;
    return { dockerService, service, source, events, operation };
  }

  afterEach(() => vi.useRealTimers());

  it('holds new orchestration work and hands off only after running operations finish', async () => {
    vi.useFakeTimers();
    let running = 1;
    const { dockerService, service, source, events, operation } = gatedService(() => deployment(running, 1));
    const update = service.performUpdate('v2.4.3', makeArtifact('registry.example.com/wiolett/gateway@sha256:new'));

    await vi.waitFor(() => expect(operation()).toMatchObject({ status: 'waiting_for_operations' }));
    expect(source.setOrchestrationAdmissionHold).toHaveBeenCalledWith(
      expect.stringContaining('Gateway is updating to v2.4.3')
    );
    expect(operation()).toMatchObject({
      targetVersion: 'v2.4.3',
      operations: [{ kind: 'deployment', label: 'Blue/green deployment operations', count: 2 }],
      waitDeadline: expect.any(String),
    });
    expect(events.publish).toHaveBeenCalledWith(
      'system.update.changed',
      expect.objectContaining({ updating: true, component: 'gateway', statusChanged: true })
    );
    // Nothing on the host changes while operations run.
    expect(dockerService.pullImageRef).toHaveBeenCalledTimes(2);
    expect(dockerService.runOneShot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dockerService.runDetached).not.toHaveBeenCalled();

    running = 0;
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() =>
      expect(operation()).toMatchObject({ status: 'waiting_for_operations', operations: [{ count: 1 }] })
    );
    // The queued drain falls due and completes too.
    source.activeOrchestrationOperations.mockResolvedValue(deployment(0, 0));
    await vi.advanceTimersByTimeAsync(2_000);
    await update;

    expect(dockerService.runDetached).toHaveBeenCalledOnce();
    expect(operation()).toMatchObject({ status: 'updating', operations: [] });
    // The hold stays until the handed-off update replaces this process.
    expect(source.setOrchestrationAdmissionHold).not.toHaveBeenCalledWith(null);
  });

  it('updates now when the operator overrides the wait', async () => {
    vi.useFakeTimers();
    const { dockerService, service } = gatedService(() => deployment(1));
    expect(service.proceedWithoutWaiting()).toBe(false);
    const update = service.performUpdate('v2.4.3', makeArtifact('registry.example.com/wiolett/gateway@sha256:new'));

    await vi.waitFor(() => expect(service.proceedWithoutWaiting()).toBe(true));
    await update;
    expect(dockerService.runDetached).toHaveBeenCalledOnce();
    expect(service.proceedWithoutWaiting()).toBe(false);
  });

  it('proceeds at the longest announced operation deadline', async () => {
    vi.useFakeTimers();
    const expectedBy = Date.now() + 20 * 60_000;
    const { dockerService, service, operation } = gatedService(() => deployment(1, 0, expectedBy));
    const update = service.performUpdate('v2.4.3', makeArtifact('registry.example.com/wiolett/gateway@sha256:new'));

    await vi.waitFor(() => expect(operation()).toMatchObject({ waitDeadline: new Date(expectedBy).toISOString() }));
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(dockerService.runOneShot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await update;
    expect(dockerService.runDetached).toHaveBeenCalledOnce();
  });

  it('accepts orchestration work again when the update fails after the wait', async () => {
    const { dockerService, service, source, operation } = gatedService(() => deployment(0));
    dockerService.runOneShot.mockResolvedValueOnce({ exitCode: 1, output: 'migration failed' });

    await expect(
      service.performUpdate('v2.4.3', makeArtifact('registry.example.com/wiolett/gateway@sha256:new'))
    ).rejects.toThrow('migration failed');
    expect(source.setOrchestrationAdmissionHold).toHaveBeenLastCalledWith(null);
    expect(operation()).toBeNull();
    expect(service.isGatewayUpdateInProgress()).toBe(false);
  });

  it('does not wait for a private core that cannot report its operations', async () => {
    const { dockerService, service } = gatedService(() => null);

    await service.performUpdate('v2.4.3', makeArtifact('registry.example.com/wiolett/gateway@sha256:new'));
    expect(dockerService.runDetached).toHaveBeenCalledOnce();
  });
});

describe('UpdateService interrupted updates', () => {
  /** A drizzle-like chain resolving to `rows`; every builder method returns the chain. */
  function chain(rows: unknown[]) {
    const result = Promise.resolve(rows) as Promise<unknown[]> & Record<string, (...args: unknown[]) => unknown>;
    for (const method of ['from', 'where', 'orderBy', 'limit', 'innerJoin', 'set', 'values', 'returning']) {
      result[method] = () => result;
    }
    result.onConflictDoUpdate = () => Promise.resolve(undefined);
    return result;
  }

  function scriptedDb(selects: unknown[][], transactionUpdates: unknown[][] = []) {
    const writes: Array<{ key: string; value: any }> = [];
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      update: vi.fn(() => chain(transactionUpdates.shift() ?? [])),
    };
    const db = {
      select: vi.fn(() => chain(selects.shift() ?? [])),
      insert: vi.fn(() => ({
        values: (row: { key: string; value: unknown }) => {
          writes.push(row);
          return { onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) };
        },
      })),
      delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      transaction: vi.fn(async (write: (executor: typeof tx) => Promise<unknown>) => write(tx)),
    };
    return { db, tx, writes };
  }

  function serviceWith(db: unknown, appVersion = 'v2.4.2') {
    const service = new UpdateService(
      db as never,
      makeDockerService() as never,
      {
        APP_VERSION: appVersion,
        RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
      } as never
    );
    const events = { publish: vi.fn() };
    const audit = { log: vi.fn().mockResolvedValue(true) };
    service.setOrchestrationGate(
      { activeOrchestrationOperations: vi.fn(async () => []), setOrchestrationAdmissionHold: vi.fn(() => true) },
      events
    );
    service.setAuditLog(audit);
    return { service, events, audit };
  }

  const attempt = {
    targetVersion: 'v2.5.0',
    fromVersion: 'v2.4.2',
    startedAt: '2026-09-23T12:00:00.000Z',
    userId: 'admin-1',
    sidecarId: 'abcdef0123456789',
    failedAt: null,
    error: null,
  };

  afterEach(() => vi.useRealTimers());

  it('records the attempt and backs up .env before anything on the host changes', async () => {
    const dockerService = makeDockerService();
    const order: string[] = [];
    const service = makeUpdateService(dockerService);
    const db = (service as unknown as { db: { insert: ReturnType<typeof vi.fn> } }).db;
    db.insert.mockImplementation(() => ({
      values: (row: { key: string; value: { sidecarId?: string | null } }) => {
        order.push(`record:${row.key}:${row.value.sidecarId ?? 'none'}`);
        return { onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) };
      },
    }));
    dockerService.runOneShot.mockImplementation(async (config: { Cmd: string[] }) => {
      order.push(config.Cmd.includes('dist/cli/migrate-legacy-settings.js') ? 'legacy-settings' : config.Cmd[0]!);
      return {
        exitCode: 0,
        output:
          '{"ok":true,"changedFiles":[],"backupDir":null,"sandboxWorkspaceDir":"/var/lib/gateway/sandbox-workspaces"}',
      };
    });
    dockerService.runDetached.mockImplementation(async () => {
      order.push('sidecar');
      return 'sidecar-1';
    });

    await service.performUpdate('v2.4.3', makeArtifact('registry.example.com/wiolett/gateway@sha256:new'), 'admin-1');

    expect(order.slice(0, 3)).toEqual(['record:update:gateway:attempt:none', 'sh', 'legacy-settings']);
    expect(order.slice(-2)).toEqual(['sidecar', 'record:update:gateway:attempt:sidecar-1']);
    // Even when the foundation migration changed nothing, the rollback restores the untouched .env.
    expect(dockerService.runDetached).toHaveBeenCalledWith(
      expect.objectContaining({
        Env: [
          expect.stringMatching(/^FOUNDATION_BACKUP_DIR=\/srv\/gateway\/\.gateway-foundation-backups\/pre-update-/),
        ],
      })
    );
  });

  it('forgets the attempt when the update fails before the handoff', async () => {
    const dockerService = makeDockerService();
    dockerService.runOneShot
      .mockResolvedValueOnce({ exitCode: 0, output: '' })
      .mockResolvedValueOnce({ exitCode: 1, output: 'migration failed' });
    const service = makeUpdateService(dockerService);
    const db = (service as unknown as { db: { delete: ReturnType<typeof vi.fn> } }).db;

    await expect(
      service.performUpdate('v2.4.3', makeArtifact('registry.example.com/wiolett/gateway@sha256:new'))
    ).rejects.toThrow('migration failed');
    expect(db.delete).toHaveBeenCalledOnce();
    expect((service as unknown as { gatewayUpdateOperation: unknown }).gatewayUpdateOperation).toBeNull();
  });

  it('reports a rolled-back update as failed after the previous version restarts', async () => {
    const { db, writes } = scriptedDb([[{ key: 'update:gateway:attempt', value: attempt }], []]);
    const { service, events, audit } = serviceWith(db, 'v2.4.2');

    await service.recoverInterruptedUpdates();

    const operation = (service as unknown as { gatewayUpdateOperation: unknown }).gatewayUpdateOperation;
    expect(operation).toMatchObject({
      status: 'failed',
      targetVersion: 'v2.5.0',
      error: expect.stringContaining('rolled back'),
    });
    expect(writes).toEqual([
      expect.objectContaining({
        key: 'update:gateway:attempt',
        value: expect.objectContaining({
          failedAt: expect.any(String),
          error: expect.stringContaining('abcdef012345'),
        }),
      }),
    ]);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'admin-1',
        action: 'system.update.failed',
        details: expect.objectContaining({ targetVersion: 'v2.5.0', runningVersion: 'v2.4.2' }),
      })
    );
    expect(events.publish).toHaveBeenCalledWith(
      'system.update.changed',
      expect.objectContaining({ updating: false, component: 'gateway', error: expect.any(String) })
    );
    expect(service.isGatewayUpdateInProgress()).toBe(false);

    await expect(service.acknowledgeGatewayUpdateFailure()).resolves.toBe(true);
    expect((service as unknown as { gatewayUpdateOperation: unknown }).gatewayUpdateOperation).toBeNull();
    expect(db.delete).toHaveBeenCalledOnce();
    await expect(service.acknowledgeGatewayUpdateFailure()).resolves.toBe(false);
  });

  it('keeps the attempt, marked started, until the target version has settled', async () => {
    vi.useFakeTimers();
    const { db, writes } = scriptedDb([[{ key: 'update:gateway:attempt', value: attempt }], []]);
    const { service, audit } = serviceWith(db, 'v2.5.0');

    await service.recoverInterruptedUpdates();

    expect((service as unknown as { gatewayUpdateOperation: unknown }).gatewayUpdateOperation).toBeNull();
    // The sidecar can still roll the target back: the record must survive start-up.
    expect(db.delete).not.toHaveBeenCalled();
    expect(writes).toEqual([
      expect.objectContaining({
        key: 'update:gateway:attempt',
        value: expect.objectContaining({ targetVersion: 'v2.5.0', targetStartedAt: expect.any(String) }),
      }),
    ]);
    expect(audit.log).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(db.delete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(db.delete).toHaveBeenCalledOnce();
  });

  it('reports a rollback that happened after the target version started', async () => {
    const started = { ...attempt, targetStartedAt: '2026-09-23T12:05:00.000Z' };
    const { db, writes } = scriptedDb([[{ key: 'update:gateway:attempt', value: started }], []]);
    const { service, audit } = serviceWith(db, 'v2.4.2');

    await service.recoverInterruptedUpdates();

    expect((service as unknown as { gatewayUpdateOperation: unknown }).gatewayUpdateOperation).toMatchObject({
      status: 'failed',
      targetVersion: 'v2.5.0',
      error: expect.stringContaining('rolled back'),
    });
    expect(writes).toEqual([
      expect.objectContaining({
        key: 'update:gateway:attempt',
        value: expect.objectContaining({ failedAt: expect.any(String) }),
      }),
    ]);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'system.update.failed' }));
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('stops reporting an old failure after a day', async () => {
    const failedAt = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    const { db } = scriptedDb([
      [{ key: 'update:gateway:attempt', value: { ...attempt, failedAt, error: 'rolled back' } }],
      [],
    ]);
    const { service } = serviceWith(db, 'v2.4.2');

    await service.recoverInterruptedUpdates();

    expect((service as unknown as { gatewayUpdateOperation: unknown }).gatewayUpdateOperation).toBeNull();
    await vi.waitFor(() => expect(db.delete).toHaveBeenCalledOnce());
  });

  it('fails a Relay Pool run interrupted by a restart and resumes the relays it drained', async () => {
    vi.useFakeTimers();
    const remote = {
      id: 'remote-1',
      kind: 'remote',
      nodeId: 'node-1',
      manualDrainStartedAt: null,
      state: 'draining',
      health: { admissionState: 'draining' },
    };
    const { db, tx } = scriptedDb(
      [[], [{ id: 'run-1', targetArtifact: { version: 'v2.4.3' } }], [remote], [], [remote], []],
      [
        [{ id: 'run-1' }],
        [
          { relayInstanceId: 'remote-1', drainDeadlineAt: new Date() },
          { relayInstanceId: 'local', drainDeadlineAt: null },
        ],
      ]
    );
    const { service, audit } = serviceWith(db);
    const runtime = {
      drainInstance: vi.fn().mockRejectedValueOnce(new Error('node is not connected')).mockResolvedValue(undefined),
      forceDisconnectInstance: vi.fn(),
      prepareWorkerUpdate: vi.fn(),
      dispatchWorkerUpdate: vi.fn(),
      prepareSupervisorUpdate: vi.fn(),
      dispatchSupervisorUpdate: vi.fn(),
    };
    service.setRelayPoolUpdateRuntime(runtime);

    await service.recoverInterruptedUpdates();

    expect(tx.execute).toHaveBeenCalledOnce();
    expect(tx.update).toHaveBeenNthCalledWith(1, relayPoolUpdateRuns);
    expect(tx.update).toHaveBeenNthCalledWith(2, relayPoolUpdateSteps);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'system.relay_update.failed', resourceId: 'run-1' })
    );
    // The remote relay has not reconnected yet: the release retries.
    await vi.waitFor(() => expect(runtime.drainInstance).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(runtime.drainInstance).toHaveBeenCalledTimes(2));
    expect(runtime.drainInstance).toHaveBeenLastCalledWith('remote-1', null, false);
  });

  it('abandons a stuck Relay Pool run, stops its rollout and releases its drains', async () => {
    const remote = {
      id: 'remote-1',
      kind: 'remote',
      nodeId: 'node-1',
      manualDrainStartedAt: null,
      state: 'draining',
      health: {},
    };
    const { db } = scriptedDb(
      [[{ id: 'run-1', state: 'updating', targetArtifact: { version: 'v2.4.3' } }], [remote], []],
      [[{ id: 'run-1' }], [{ relayInstanceId: 'remote-1', drainDeadlineAt: new Date() }]]
    );
    const { service } = serviceWith(db);
    const runtime = {
      drainInstance: vi.fn().mockResolvedValue(undefined),
      forceDisconnectInstance: vi.fn(),
      prepareWorkerUpdate: vi.fn(),
      dispatchWorkerUpdate: vi.fn(),
      prepareSupervisorUpdate: vi.fn(),
      dispatchSupervisorUpdate: vi.fn(),
    };
    service.setRelayPoolUpdateRuntime(runtime);
    service.startRelayUpdate('v2.4.3');
    const rollout = new AbortController();
    (service as unknown as { relayPoolRun: AbortController }).relayPoolRun = rollout;

    await expect(service.abandonRelayUpdate('admin-1')).resolves.toEqual({ targetVersion: 'v2.4.3' });

    expect(rollout.signal.aborted).toBe(true);
    expect((service as unknown as { relayUpdateOperation: unknown }).relayUpdateOperation).toMatchObject({
      status: 'failed',
      error: 'Abandoned by an administrator',
    });
    await vi.waitFor(() => expect(runtime.drainInstance).toHaveBeenCalledWith('remote-1', 'admin-1', false));
  });

  function rolloutHarness(options: { manualDrainStartedAt?: Date | null } = {}) {
    const remote = {
      id: 'remote-1',
      kind: 'remote',
      nodeId: 'node-1',
      displayName: 'relay-1',
      manualDrainStartedAt: options.manualDrainStartedAt ?? null,
      state: 'draining',
      health: { admissionState: 'draining' },
    };
    const { db } = scriptedDb([
      [{ id: 'step-1', relayInstanceId: 'remote-1', state: 'pending', sequence: 1 }],
      [remote],
      [{ state: 'updating' }],
      // Drain release: the relay row, then no newer run holding it.
      [remote],
      [],
    ]);
    const updates: unknown[] = [];
    Object.assign(db, {
      update: vi.fn((table: unknown) => {
        updates.push(table);
        return chain([]);
      }),
    });
    const { service } = serviceWith(db);
    const runtime = {
      drainInstance: vi.fn().mockResolvedValue(undefined),
      forceDisconnectInstance: vi.fn().mockResolvedValue(undefined),
      prepareWorkerUpdate: vi.fn().mockResolvedValue({}),
      dispatchWorkerUpdate: vi.fn().mockResolvedValue(undefined),
      prepareSupervisorUpdate: vi.fn().mockResolvedValue({}),
      dispatchSupervisorUpdate: vi.fn().mockResolvedValue(undefined),
    };
    service.setRelayPoolUpdateRuntime(runtime);
    const internals = service as unknown as Record<string, (...args: any[]) => any>;
    vi.spyOn(internals, 'ensureRelayPoolUpdateRun').mockResolvedValue({ id: 'run-1' });
    vi.spyOn(internals, 'updatePoolStep').mockResolvedValue(undefined);
    vi.spyOn(internals, 'waitForRelayInstanceDrain').mockResolvedValue(true);
    vi.spyOn(internals, 'relayInstanceArchitecture').mockReturnValue('amd64');
    vi.spyOn(internals, 'isRelaySupervisorAt').mockResolvedValue(false);
    const supervisorAt = vi.spyOn(internals, 'waitForRelaySupervisorVersion').mockResolvedValue(undefined);
    const verify = vi.spyOn(internals, 'waitForRelayInstanceVersion');
    return { service, runtime, verify, supervisorAt, updates };
  }

  it('waits for the relay lease peers before draining it and for its acceptor before resuming it', async () => {
    const { service, runtime, verify } = rolloutHarness();
    const events: string[] = [];
    const awaitLeasePeers = vi.fn(async () => void events.push('lease peers settled'));
    const awaitLeaseSettled = vi.fn(async () => void events.push('relay votes again'));
    Object.assign(runtime, { awaitLeasePeers, awaitLeaseSettled });
    runtime.drainInstance.mockImplementation(
      async (_id: string, _user: string, enabled: boolean) => void events.push(enabled ? 'drain' : 'resume')
    );
    runtime.dispatchSupervisorUpdate.mockImplementation(async () => void events.push('supervisor update'));
    runtime.dispatchWorkerUpdate.mockImplementation(async () => void events.push('worker update'));
    verify.mockResolvedValue(undefined);
    const internals = service as unknown as Record<string, (...args: any[]) => any>;
    vi.spyOn(internals, 'isRemoteRelayAt').mockResolvedValue(false);
    vi.spyOn(internals, 'promoteRelayConnectorImages').mockResolvedValue(undefined);

    await service.performRelayUpdate('v2.4.3', {} as never, 'admin-1');

    expect(events).toEqual([
      'lease peers settled',
      'drain',
      'supervisor update',
      'worker update',
      'relay votes again',
      'resume',
    ]);
    expect(awaitLeasePeers).toHaveBeenCalledWith('remote-1', expect.any(AbortSignal));
    expect(awaitLeaseSettled).toHaveBeenCalledWith('remote-1', expect.any(Number), expect.any(AbortSignal));
  });

  it('disconnects the streams left after the drain grace and goes on instead of pausing', async () => {
    const { service, runtime, verify } = rolloutHarness();
    verify.mockResolvedValue(undefined);
    const internals = service as unknown as Record<string, (...args: any[]) => any>;
    vi.spyOn(internals, 'isRemoteRelayAt').mockResolvedValue(false);
    vi.spyOn(internals, 'promoteRelayConnectorImages').mockResolvedValue(undefined);
    const waitForDrain = vi.spyOn(internals, 'waitForRelayInstanceDrain');
    // A database pool keeps its streams open through the whole grace and a little after the disconnect.
    waitForDrain.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    await service.performRelayUpdate('v2.4.3', {} as never, 'admin-1');

    expect(runtime.forceDisconnectInstance).toHaveBeenCalledWith('remote-1', 'admin-1');
    expect(runtime.forceDisconnectInstance.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.dispatchWorkerUpdate.mock.invocationCallOrder[0]
    );
    // Resumed after its update: the run completed rather than pausing with the relay drained.
    expect(runtime.drainInstance).toHaveBeenLastCalledWith('remote-1', 'admin-1', false);
  });

  // Regression (v2.11.1-rc.1): a supervisor before v2.11.1 restarted the previous worker binary while it downloaded
  // the new one. The target supervisor carries out the worker update instead.
  it('updates the supervisor and waits for it to run the target before it dispatches the worker update', async () => {
    const { service, runtime, verify, supervisorAt } = rolloutHarness();
    verify.mockResolvedValue(undefined);
    const internals = service as unknown as Record<string, (...args: any[]) => any>;
    vi.spyOn(internals, 'isRemoteRelayAt').mockResolvedValue(false);
    vi.spyOn(internals, 'promoteRelayConnectorImages').mockResolvedValue(undefined);

    await service.performRelayUpdate('v2.4.3', {} as never, 'admin-1');

    expect(runtime.dispatchSupervisorUpdate).toHaveBeenCalledTimes(1);
    expect(supervisorAt).toHaveBeenCalledWith('node-1', 'v2.4.3', expect.any(AbortSignal));
    expect(runtime.dispatchSupervisorUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      supervisorAt.mock.invocationCallOrder[0]
    );
    expect(supervisorAt.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.prepareWorkerUpdate.mock.invocationCallOrder[0]
    );
    expect(runtime.dispatchWorkerUpdate).toHaveBeenCalledTimes(1);
    expect(runtime.drainInstance).toHaveBeenLastCalledWith('remote-1', 'admin-1', false);
  });

  it('goes straight to the worker when a retried run finds the supervisor on the target', async () => {
    const { service, runtime, verify } = rolloutHarness();
    verify.mockResolvedValue(undefined);
    const internals = service as unknown as Record<string, (...args: any[]) => any>;
    vi.spyOn(internals, 'isRemoteRelayAt').mockResolvedValue(false);
    vi.spyOn(internals, 'isRelaySupervisorAt').mockResolvedValue(true);
    vi.spyOn(internals, 'promoteRelayConnectorImages').mockResolvedValue(undefined);

    await service.performRelayUpdate('v2.4.3', {} as never, 'admin-1');

    expect(runtime.dispatchSupervisorUpdate).not.toHaveBeenCalled();
    expect(runtime.dispatchWorkerUpdate).toHaveBeenCalledTimes(1);
    expect(internals.updatePoolStep).toHaveBeenCalledWith('step-1', 'ready', true);
  });

  it('does not update the worker of a run abandoned while the supervisor restarts', async () => {
    const { service, runtime, supervisorAt } = rolloutHarness();
    const internals = service as unknown as Record<string, (...args: any[]) => any>;
    vi.spyOn(internals, 'isRemoteRelayAt').mockResolvedValue(false);
    supervisorAt.mockImplementation(async () => {
      (service as unknown as { relayPoolRun: AbortController }).relayPoolRun.abort();
    });

    await expect(service.performRelayUpdate('v2.4.3', {} as never, 'admin-1')).rejects.toThrow('abandoned');

    expect(runtime.dispatchWorkerUpdate).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(runtime.drainInstance).toHaveBeenLastCalledWith('remote-1', 'admin-1', false));
  });

  it('dispatches the worker update again while the previous worker keeps running', async () => {
    const { service, runtime, verify } = rolloutHarness();
    verify.mockResolvedValue(undefined);
    const internals = service as unknown as Record<string, (...args: any[]) => any>;
    vi.spyOn(internals, 'isRemoteRelayAt').mockResolvedValue(false);
    vi.spyOn(internals, 'promoteRelayConnectorImages').mockResolvedValue(undefined);
    runtime.dispatchWorkerUpdate.mockRejectedValueOnce(
      new Error('relay worker did not become ready after update: worker reported version v2.4.2, expected v2.4.3')
    );

    await service.performRelayUpdate('v2.4.3', {} as never, 'admin-1');

    expect(runtime.dispatchWorkerUpdate).toHaveBeenCalledTimes(2);
    expect(internals.updatePoolStep).toHaveBeenCalledWith('step-1', 'ready', true);
  });

  it('fails the step after a bounded number of worker updates that kept the previous worker', async () => {
    const { service, runtime } = rolloutHarness();
    const internals = service as unknown as Record<string, (...args: any[]) => any>;
    vi.spyOn(internals, 'isRemoteRelayAt').mockResolvedValue(false);
    runtime.dispatchWorkerUpdate.mockRejectedValue(
      new Error('relay worker did not become ready after update: worker reported version v2.4.2, expected v2.4.3')
    );

    await expect(service.performRelayUpdate('v2.4.3', {} as never, 'admin-1')).rejects.toThrow(
      'worker reported version v2.4.2'
    );

    expect(runtime.dispatchWorkerUpdate).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(runtime.drainInstance).toHaveBeenLastCalledWith('remote-1', 'admin-1', false));
  });

  it('does not dispatch a worker update again after another failure', async () => {
    const { service, runtime } = rolloutHarness();
    const internals = service as unknown as Record<string, (...args: any[]) => any>;
    vi.spyOn(internals, 'isRemoteRelayAt').mockResolvedValue(false);
    runtime.dispatchWorkerUpdate.mockRejectedValue(new Error('checksum mismatch'));

    await expect(service.performRelayUpdate('v2.4.3', {} as never, 'admin-1')).rejects.toThrow('checksum mismatch');

    expect(runtime.dispatchWorkerUpdate).toHaveBeenCalledTimes(1);
  });

  // Regression: a run that failed without a Gateway restart left the relay drained.
  it('resumes the relay it drained when verification times out', async () => {
    const { service, runtime, verify, updates } = rolloutHarness();
    verify.mockRejectedValue(new Error('Relay relay-1 did not report v2.4.3 in time'));

    await expect(service.performRelayUpdate('v2.4.3', {} as never, 'admin-1')).rejects.toThrow('did not report');

    expect(runtime.drainInstance).toHaveBeenNthCalledWith(1, 'remote-1', 'admin-1', true);
    expect(updates).toEqual(expect.arrayContaining([relayPoolUpdateSteps, relayPoolUpdateRuns]));
    await vi.waitFor(() => expect(runtime.drainInstance).toHaveBeenLastCalledWith('remote-1', 'admin-1', false));
  });

  it('leaves an operator drain in place when the run fails', async () => {
    const { service, runtime, verify } = rolloutHarness({ manualDrainStartedAt: new Date() });
    verify.mockRejectedValue(new Error('verify timed out'));

    await expect(service.performRelayUpdate('v2.4.3', {} as never, 'admin-1')).rejects.toThrow('verify timed out');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.drainInstance).toHaveBeenCalledTimes(1);
    expect(runtime.drainInstance).not.toHaveBeenCalledWith('remote-1', expect.anything(), false);
  });

  it('does not drain again a relay a retried run finds already updated', async () => {
    const { service, runtime } = rolloutHarness();
    const internals = service as unknown as Record<string, (...args: any[]) => any>;
    const at = vi.spyOn(internals, 'isRemoteRelayAt').mockResolvedValue(true);

    await service.performRelayUpdate('v2.4.3', {} as never, 'admin-1');

    expect(at).toHaveBeenCalledWith(expect.objectContaining({ id: 'remote-1' }), 'v2.4.3');
    expect(runtime.drainInstance).not.toHaveBeenCalled();
    expect(runtime.dispatchWorkerUpdate).not.toHaveBeenCalled();
    expect(internals.updatePoolStep).toHaveBeenCalledWith('step-1', 'ready', true);
  });

  it('still resumes the drained relay when recording the failure fails', async () => {
    const { service, runtime, verify } = rolloutHarness();
    verify.mockRejectedValue(new Error('verify timed out'));
    const db = (service as unknown as { db: { update: ReturnType<typeof vi.fn> } }).db;
    const update = db.update.getMockImplementation() as (table: unknown) => unknown;
    db.update.mockImplementation((table: unknown) => {
      if (table === relayPoolUpdateSteps) throw new Error('database connection lost');
      return update(table);
    });

    await expect(service.performRelayUpdate('v2.4.3', {} as never, 'admin-1')).rejects.toThrow();
    await vi.waitFor(() => expect(runtime.drainInstance).toHaveBeenLastCalledWith('remote-1', 'admin-1', false));
  });

  it('tells the UI which Relay Pool rollouts can still be abandoned', async () => {
    const run = (state: string) => ({
      state,
      targetArtifact: { version: 'v2.4.3' },
      startedAt: new Date('2026-09-24T10:00:00Z'),
      terminalError: state === 'paused' ? 'Relay drain is waiting for active streams' : 'verify timed out',
    });
    for (const [state, abandonable] of [
      ['paused', true],
      ['updating', true],
      ['failed', false],
    ] as const) {
      const { db } = scriptedDb([[run(state)]]);
      const { service } = serviceWith(db);
      service.setRelayPoolUpdateRuntime({} as never);
      const operation = await (
        service as unknown as { getDurableRelayOperation(): Promise<Record<string, unknown>> }
      ).getDurableRelayOperation();
      expect(operation).toMatchObject({ abandonable, runState: state });
    }
  });

  it('refuses to abandon when no Relay Pool update runs', async () => {
    const { db } = scriptedDb([[]]);
    const { service } = serviceWith(db);

    await expect(service.abandonRelayUpdate('admin-1')).rejects.toMatchObject({ code: 'RELAY_UPDATE_NOT_ACTIVE' });
  });

  it('keeps Gateway and Relay Pool updates from running at the same time', async () => {
    const { db } = scriptedDb([[{ id: 'run-1' }]]);
    const { service } = serviceWith(db);
    service.setRelayPoolUpdateRuntime({
      drainInstance: vi.fn(),
      forceDisconnectInstance: vi.fn(),
      prepareWorkerUpdate: vi.fn(),
      dispatchWorkerUpdate: vi.fn(),
      prepareSupervisorUpdate: vi.fn(),
      dispatchSupervisorUpdate: vi.fn(),
    });

    // A durable run from before a restart still counts until recovery fails it.
    await expect(service.assertGatewayUpdateAllowed()).rejects.toMatchObject({ code: 'RELAY_UPDATE_IN_PROGRESS' });

    const dockerService = makeDockerService();
    const gateway = makeUpdateService(dockerService);
    gateway.startRelayUpdate('v2.4.3');
    await expect(
      gateway.performUpdate('v2.4.3', makeArtifact('registry.example.com/wiolett/gateway@sha256:new'))
    ).rejects.toMatchObject({ code: 'RELAY_UPDATE_IN_PROGRESS' });
    expect(dockerService.pullImageRef).not.toHaveBeenCalled();
    expect(gateway.isGatewayUpdateInProgress()).toBe(false);

    const idle = makeUpdateService(makeDockerService());
    let release!: () => void;
    const pulling = new Promise<void>((resolve) => {
      release = resolve;
    });
    const idleDocker = (idle as unknown as { dockerService: ReturnType<typeof makeDockerService> }).dockerService;
    idleDocker.pullImageRef.mockImplementationOnce(() => pulling);
    const update = idle.performUpdate('v2.4.3', makeArtifact('registry.example.com/wiolett/gateway@sha256:new'));
    expect(() => idle.startRelayUpdate('v2.4.3')).toThrow(
      expect.objectContaining({ code: 'GATEWAY_UPDATE_IN_PROGRESS' })
    );
    release();
    await update;
  });
});

const PRE_UPDATE_BACKUP_ENV = /^FOUNDATION_BACKUP_DIR=\/host\/\.gateway-foundation-backups\/pre-update-[\w.-]+$/;

function makeUpdateService(
  dockerService: ReturnType<typeof makeDockerService>,
  relayRuntime?: ConstructorParameters<typeof UpdateService>[3],
  envOverrides: Record<string, unknown> = {}
): UpdateService {
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) })),
    })),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
  };
  return new UpdateService(
    db as never,
    dockerService as never,
    {
      APP_VERSION: 'v2.4.2',
      COMPOSE_PROJECT_DIR: '/srv/gateway',
      RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
      ARTIFACT_BASE_URL: 'https://updates.thesqlabs.com/gateway',
      GATEWAY_RELAY_IMAGE_REF: `registry.example.com/wiolett/gateway/relay@sha256:${'b'.repeat(64)}`,
      GATEWAY_RELAY_BUILD_VERSION: 'v2.4.2',
      GATEWAY_RELAY_PROTOCOL_MAJOR: 1,
      ...envOverrides,
    } as never,
    relayRuntime
  );
}

function makeDockerService() {
  return {
    inspectSelf: vi.fn().mockResolvedValue({
      Config: {
        Image: 'registry.example.com/wiolett/gateway:v2.4.2',
        Labels: {
          'com.docker.compose.project.working_dir': '/srv/gateway',
          'com.docker.compose.project': 'gateway',
        },
      },
    }),
    pullImageRef: vi.fn().mockResolvedValue(undefined),
    runOneShot: vi.fn().mockResolvedValue({
      exitCode: 0,
      output:
        '{"ok":true,"changedFiles":[],"backupDir":"/host/.gateway-foundation-backups/test","sandboxWorkspaceDir":"/var/lib/gateway/sandbox-workspaces"}',
    }),
    runDetached: vi.fn().mockResolvedValue('sidecar-1'),
  };
}

function makeArtifact(
  imageRef: string,
  secureLinkConnectorImage?: string,
  legacyDatabaseConnectorImage?: string
): TrustedGatewayUpdateArtifact {
  return {
    imageRef,
    digest: 'sha256:new',
    signedManifest: 'signed',
    payload: {
      kind: 'gateway-image',
      version: 'v2.4.3',
      tag: 'v2.4.3',
      image: 'registry.example.com/wiolett/gateway',
      digest: 'sha256:new',
      imageRef,
      ...(legacyDatabaseConnectorImage ? { databaseConnectorImage: legacyDatabaseConnectorImage } : {}),
      ...(secureLinkConnectorImage ? { secureLinkConnectorImage } : {}),
      createdAt: '2026-06-30T00:00:00.000Z',
    },
    ...(secureLinkConnectorImage ? { secureLinkConnectorImage } : {}),
  };
}

function makeRelayArtifact(): TrustedRelayUpdateArtifact {
  const imageRef = `registry.example.com/wiolett/gateway/relay@sha256:${'a'.repeat(64)}`;
  const secureLinkConnectorImage = `registry.example.com/wiolett/gateway/secure-link-connector@sha256:${'c'.repeat(64)}`;
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
      image: 'registry.example.com/wiolett/gateway/relay',
      digest: `sha256:${'a'.repeat(64)}`,
      imageRef,
      protocolMajor: 1,
      minGatewayVersion: 'v2.4.2',
      secureLinkConnectorImage,
      createdAt: '2026-06-30T00:00:00.000Z',
    },
  };
}
