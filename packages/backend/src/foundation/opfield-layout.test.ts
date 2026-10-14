import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { dockerLogDefaultsFromEnv, patchCompose, runFoundationMigrations } from './foundation-migrator.js';
import { toOpfieldLayout } from './opfield-layout.js';
import {
  applyComposeVocabulary,
  isOpfieldComposeLayout,
  relayBinary,
  renameLegacyEnvFileKeys,
} from './opfield-names.js';

const INSTALL_SH = readFileSync(path.resolve(__dirname, '../../../../scripts/install.sh'), 'utf8');
const [LEGACY_COMPOSE, OPFIELD_COMPOSE] = [
  ...INSTALL_SH.matchAll(/cat >docker-compose\.yml <<'COMPOSE'\n([\s\S]*?)\nCOMPOSE\n/g),
].map((match) => `${match[1]}\n`);
const EXISTING = new Set(
  ['gateway_data', 'relay_identity', 'relay_state', 'registry_data', 'registry_auth'].map((key) =>
    key === 'gateway_data' ? 'gateway_gateway_data' : `gateway_gateway_${key}`
  )
);
EXISTING.add('gateway_postgres_data');
EXISTING.add('gateway_redis_data');

type Compose = {
  name?: string;
  services: Record<
    string,
    { environment?: Record<string, string>; volumes?: string[]; healthcheck?: { test: unknown } }
  >;
  volumes: Record<string, { name?: string; external?: boolean } | null>;
};
const parse = (content: string) => parseDocument(content).toJS() as Compose;

describe('the Opfield layout of an installation made before 2.12.1', () => {
  const moved = toOpfieldLayout({
    compose: LEGACY_COMPOSE!,
    env: 'GATEWAY_IMAGE_REF=a\nGATEWAY_RELAY_BUILD_VERSION=v2.12.1\nDB_PASSWORD=p\nSANDBOX_RUNNER_WORKSPACE_DIR=/var/lib/gateway/sandbox-workspaces\n',
    currentProject: 'gateway',
    existingVolumes: EXISTING,
    renameCommercialDir: false,
  });

  it('matches what install.sh writes for a fresh installation, with the earlier volumes bound by name', () => {
    const fresh = parse(OPFIELD_COMPOSE!);
    const result = parse(moved.compose);
    expect(result.name).toBe('opfield');
    expect(Object.keys(result.services).sort()).toEqual(Object.keys(fresh.services).sort());
    for (const service of Object.keys(fresh.services)) {
      expect(result.services[service]!.volumes, service).toEqual(fresh.services[service]!.volumes);
      expect(result.services[service]!.healthcheck, service).toEqual(fresh.services[service]!.healthcheck);
    }
    expect(result.services.app!.environment).toEqual(fresh.services.app!.environment);
    expect(result.services.postgres!.environment).toEqual(fresh.services.postgres!.environment);
    expect(result.services.registry!.environment).toEqual(fresh.services.registry!.environment);
    expect(Object.keys(result.volumes)).toEqual(Object.keys(fresh.volumes));
    expect(result.volumes.app_data).toEqual({ name: 'gateway_gateway_data', external: true });
    expect(result.volumes.postgres_data).toEqual({ name: 'gateway_postgres_data', external: true });
    expect(moved.volumes.map((volume) => `${volume.key}>${volume.newKey}`)).toContain(
      'gateway_relay_state>relay_state'
    );
    expect(moved.compose).not.toMatch(/GATEWAY_|com\.wiolett|gateway-internal-registry|Gateway-managed|Run Gateway/);
  });

  it('moves the settings and the sandbox directory of .env', () => {
    expect(moved.env).toBe(
      'OPFIELD_IMAGE_REF=a\nOPFIELD_RELAY_BUILD_VERSION=v2.12.1\nDB_PASSWORD=p\nSANDBOX_RUNNER_WORKSPACE_DIR=/var/lib/opfield/sandbox-workspaces\n'
    );
    expect(moved.sandboxWorkspaceDir).toBe('/var/lib/opfield/sandbox-workspaces');
  });

  it('is stable when applied again and when the migrator of a later update patches it', () => {
    const again = toOpfieldLayout({
      compose: moved.compose,
      env: moved.env,
      currentProject: 'opfield',
      existingVolumes: EXISTING,
      renameCommercialDir: false,
    });
    expect(again.compose).toBe(moved.compose);
    const patched = patchCompose(moved.compose, true, { commercialDirName: '.opfield-commercial' });
    expect(isOpfieldComposeLayout(patched)).toBe(true);
    expect(patched).toContain('- relay_identity:/var/lib/gateway-relay');
    expect(patched).toContain('REGISTRY_AUTH_TOKEN_SERVICE: opfield-internal-registry');
    expect(patched).toContain('OPFIELD_REGISTRY_TOKEN_SERVICE: opfield-internal-registry');
    expect(patched).toContain('- ./.opfield-commercial:/var/lib/gateway/commercial:ro');
    expect(patched).not.toMatch(/^ {2}gateway_\w+:/m);
    expect(patchCompose(patched, true, { commercialDirName: '.opfield-commercial' })).toBe(patched);
    expect(parseDocument(patched).errors).toEqual([]);
  });

  it('keeps a fresh Opfield Compose file in its layout through later updates', () => {
    const patched = patchCompose(OPFIELD_COMPOSE!);
    expect(parseDocument(patched).errors).toEqual([]);
    expect(patched).not.toMatch(/gateway_data|gateway-internal-registry|GATEWAY_/);
    expect(patchCompose(patched)).toBe(patched);
  });
});

describe('the relay binary', () => {
  it('names /opfield-relay only for a relay image that has it', () => {
    expect(relayBinary('v2.12.0')).toBe('/gateway-relay');
    expect(relayBinary('v2.12.1-rc.2')).toBe('/gateway-relay');
    expect(relayBinary('v2.12.1')).toBe('/opfield-relay');
    expect(relayBinary('dev')).toBe('/gateway-relay');
    expect(relayBinary(null)).toBe('/gateway-relay');
    const compose = patchCompose(LEGACY_COMPOSE!, false, { relayBuildVersion: 'v2.12.1' });
    expect(compose).toContain('entrypoint: ["/opfield-relay"]');
    expect(compose).toContain('test: ["CMD", "/opfield-relay", "healthcheck"]');
    expect(patchCompose(compose, false, { relayBuildVersion: 'v2.12.0' })).toContain('entrypoint: ["/gateway-relay"]');
  });
});

describe('Opfield names in the files of an installation', () => {
  it('renames the GATEWAY_ settings of .env; an OPFIELD_ value wins', () => {
    expect(renameLegacyEnvFileKeys('# keep\nGATEWAY_A=1\nOPFIELD_B=new\nGATEWAY_B=old\nOTHER=x\n')).toBe(
      '# keep\nOPFIELD_A=1\nOPFIELD_B=new\nOTHER=x\n'
    );
  });

  it('renames references to GATEWAY_* keys inside .env values, also in a .env renamed before', () => {
    expect(renameLegacyEnvFileKeys('GATEWAY_VERSION=v1\nAPP_VERSION=${GATEWAY_VERSION}\nX=$GATEWAY_IMAGE:y\n')).toBe(
      'OPFIELD_VERSION=v1\nAPP_VERSION=${OPFIELD_VERSION}\nX=$OPFIELD_IMAGE:y\n'
    );
    expect(renameLegacyEnvFileKeys('OPFIELD_VERSION=v1\nAPP_VERSION=${GATEWAY_VERSION}\n')).toBe(
      'OPFIELD_VERSION=v1\nAPP_VERSION=${OPFIELD_VERSION}\n'
    );
  });

  it('renames variables, labels and markers of docker-compose.yml, not its Docker objects', () => {
    const renamed = applyComposeVocabulary(
      [
        '    image: ${GATEWAY_IMAGE_REF:-x}',
        '      - GATEWAY_RELAY_TARGET=relay:9443',
        '      GATEWAY_RELAY_REQUIRED: "true"',
        '      - GATEWAY_LOCAL_HOSTS',
        '      com.wiolett.gateway.managed-service: app',
        '      # gateway-managed:start sandbox-workspace',
        '      - gateway_data:/var/lib/gateway',
        '      DATABASE_URL: postgres://gateway:${DB_PASSWORD}@postgres:5432/gateway',
      ].join('\n')
    );
    expect(renamed).toBe(
      [
        '    image: ${OPFIELD_IMAGE_REF:-x}',
        '      - OPFIELD_RELAY_TARGET=relay:9443',
        '      OPFIELD_RELAY_REQUIRED: "true"',
        '      - OPFIELD_LOCAL_HOSTS',
        '      net.opfield.managed-service: app',
        '      # opfield-managed:start sandbox-workspace',
        '      - gateway_data:/var/lib/gateway',
        '      DATABASE_URL: postgres://gateway:${DB_PASSWORD}@postgres:5432/gateway',
      ].join('\n')
    );
  });

  it('reads the Docker logging defaults an updating 2.12.0 passes under the earlier names', () => {
    expect(
      dockerLogDefaultsFromEnv({ GATEWAY_DOCKER_LOG_DRIVER: 'json-file', GATEWAY_DOCKER_LOG_OPTS: 'none' })
    ).toEqual({
      driver: 'json-file',
      logOpts: 'none',
    });
    expect(
      dockerLogDefaultsFromEnv({ OPFIELD_DOCKER_LOG_DRIVER: 'local', GATEWAY_DOCKER_LOG_DRIVER: 'json-file' })?.driver
    ).toBe('local');
  });
});

describe('the foundation migrator on an installation made before 2.12.1', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });

  it('renames the settings and keeps what the earlier release’s rollback and the running stack need', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'opfield-migrator-'));
    await writeFile(
      path.join(dir, '.env'),
      `GATEWAY_IMAGE_REF=old\nGATEWAY_RELAY_IMAGE_REF=relay@sha256:${'a'.repeat(64)}\nGATEWAY_REGISTRY_HTTP_SECRET=s\nDB_PASSWORD=p\n`
    );
    await writeFile(path.join(dir, 'docker-compose.yml'), LEGACY_COMPOSE!);
    await mkdir(path.join(dir, '.gateway-commercial'));
    const result = await runFoundationMigrations({
      hostDir: dir,
      targetVersion: 'v2.12.1',
      imageRef: 'new',
      commercial: { schemaVersion: 1, hostVersion: 'v2.12.1', edition: 'community', releaseId: null },
    });
    expect(result.backupDir).toContain('.opfield-foundation-backups');
    const env = await readFile(path.join(dir, '.env'), 'utf8');
    expect(env).not.toMatch(/^GATEWAY_/m);
    expect(env).toContain('OPFIELD_IMAGE_REF=new');
    expect(env).toContain('OPFIELD_REGISTRY_HTTP_SECRET=s');
    const compose = await readFile(path.join(dir, 'docker-compose.yml'), 'utf8');
    expect(compose).not.toMatch(/GATEWAY_|com\.wiolett|# gateway-managed/);
    // Until the host move: project, volumes, database and registry audience as the running stack has them.
    expect(isOpfieldComposeLayout(compose)).toBe(false);
    expect(compose).toContain('- gateway_data:/var/lib/gateway');
    expect(compose).toContain('DATABASE_URL: postgres://gateway:${DB_PASSWORD}@postgres:5432/gateway');
    expect(compose).toContain('REGISTRY_AUTH_TOKEN_SERVICE: gateway-internal-registry');
    expect(compose).not.toContain('OPFIELD_REGISTRY_TOKEN_SERVICE');
    expect(compose).toContain('- ./.gateway-commercial:/var/lib/gateway/commercial:ro');
    expect(compose).toContain('${SANDBOX_RUNNER_WORKSPACE_DIR:-/var/lib/gateway/sandbox-workspaces}');
    expect(parseDocument(compose).errors).toEqual([]);
  });

  it('mounts the Opfield commercial directory where no earlier one exists', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'opfield-migrator-'));
    await writeFile(path.join(dir, '.env'), `OPFIELD_RELAY_IMAGE_REF=relay@sha256:${'a'.repeat(64)}\n`);
    await writeFile(path.join(dir, 'docker-compose.yml'), OPFIELD_COMPOSE!);
    await runFoundationMigrations({
      hostDir: dir,
      targetVersion: 'v2.12.2',
      imageRef: 'new',
      commercial: { schemaVersion: 1, hostVersion: 'v2.12.2', edition: 'community', releaseId: null },
    });
    const compose = await readFile(path.join(dir, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('- ./.opfield-commercial:/var/lib/gateway/commercial:ro');
    expect(compose).toContain('- app_data:/var/lib/gateway');
  });
});
