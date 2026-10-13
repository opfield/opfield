import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import {
  composeLoggingEligibility,
  dockerLogDefaultsEnv,
  dockerLogDefaultsFromEnv,
  hostDockerLogDefaults,
  patchCompose,
  patchEnv,
  runFoundationMigrations,
} from './foundation-migrator.js';

const BOUNDED = { boundedLogging: true };

const OLD_COMPOSE = `services:
  app:
    image: \${GATEWAY_IMAGE}:\${GATEWAY_VERSION}
    restart: unless-stopped
    env_file: .env
    mem_limit: 1g
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./docker-compose.yml:/app/docker-compose.yml:ro
    depends_on:
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:3000/health"]

  redis:
    image: redis:7-alpine
`;
const DOLLAR = '$';
const EXPECTED_IMAGE_LINE = `image: ${DOLLAR}{OPFIELD_IMAGE_REF}`;
const EXPECTED_SANDBOX_VOLUME =
  `      - ${DOLLAR}{SANDBOX_RUNNER_WORKSPACE_DIR:-/var/lib/gateway/sandbox-workspaces}:` +
  `${DOLLAR}{SANDBOX_RUNNER_WORKSPACE_DIR:-/var/lib/gateway/sandbox-workspaces}`;
const BUILD_ONLY_APP_COMPOSE = `services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./docker-compose.yml:/app/docker-compose.yml:ro
`;

describe('foundation migrator patches', () => {
  it('retains an app label immediately before the managed relay marker on repeated paid upgrades', () => {
    const source = OLD_COMPOSE.replace(
      '\n  redis:',
      '\n  relay:\n    image: relay:old\n    labels:\n      com.wiolett.gateway.managed-service: relay\n\n  redis:'
    );
    const first = patchCompose(source, true);
    const second = patchCompose(first, true);
    expect(second).toBe(first);
    expect(second).toContain('    labels:\n      net.opfield.managed-service: app');
    expect(second).toContain('    expose:\n      - "9443"');
  });

  it('inherits image healthchecks on upgrades and preserves operator overrides', () => {
    const legacy = OLD_COMPOSE.replace(
      'wget -qO- http://127.0.0.1:3000/health',
      'wget --no-check-certificate -qO- https://127.0.0.1:3000/health || wget -qO- http://127.0.0.1:3000/health'
    ).replace('    healthcheck:', '    healthcheck:\n      interval: 10s\n      timeout: 5s');
    const patched = patchCompose(legacy);
    expect(patched).not.toContain('127.0.0.1:3000/health');
    expect(patched).toContain('      interval: 10s');
    expect(patched).toContain('      timeout: 5s');
    expect(patchCompose(patched)).toBe(patched);
    expect(patchCompose(OLD_COMPOSE)).not.toContain('    healthcheck:\n\n');
    const custom = OLD_COMPOSE.replace('wget -qO- http://127.0.0.1:3000/health', 'custom-probe /health');
    expect(patchCompose(custom)).toContain('custom-probe /health');
  });

  it('ensures at least sixty seconds of app stop grace', () => {
    const added = patchCompose(OLD_COMPOSE);
    expect(added).toContain('    stop_grace_period: 60s');
    expect(patchCompose(added)).toBe(added);

    const raised = patchCompose(
      OLD_COMPOSE.replace('    restart: unless-stopped', '    restart: unless-stopped\n    stop_grace_period: 30s')
    );
    expect(raised).toContain('    stop_grace_period: 60s');

    const preserved = patchCompose(
      OLD_COMPOSE.replace('    restart: unless-stopped', '    restart: unless-stopped\n    stop_grace_period: 2m')
    );
    expect(preserved).toContain('    stop_grace_period: 2m');
  });

  it("mounts the host's diagnostics files into the app once and drops the /proc/uptime mount", () => {
    const withLegacy = OLD_COMPOSE.replace(
      '      - ./docker-compose.yml:/app/docker-compose.yml:ro\n',
      '      - ./docker-compose.yml:/app/docker-compose.yml:ro\n      - /proc/uptime:/host/proc/uptime:ro\n'
    );
    const patched = patchCompose(withLegacy);
    for (const mount of [
      '/proc/meminfo:/host/proc/meminfo',
      '/proc/loadavg:/host/proc/loadavg',
      '/proc/stat:/host/proc/stat',
      '/proc/1/stat:/host/proc/1/stat',
      '/sys/fs/cgroup:/host/cgroup',
    ]) {
      expect(patched).toContain(`      - ${mount}:ro\n`);
    }
    expect(patched).not.toContain('/host/proc/uptime');
    expect(patchCompose(patched)).toBe(patched);
    const app = parseDocument(patched).toJS().services.app;
    expect(app.volumes.filter((volume: string) => /:\/host\//.test(volume))).toHaveLength(5);
  });

  it('adds the managed sandbox volume and normalizes the app image reference', () => {
    const patched = patchCompose(OLD_COMPOSE);

    expect(patched).toContain(EXPECTED_IMAGE_LINE);
    expect(patched).toContain('      # opfield-managed:start sandbox-workspace');
    expect(patched).toContain(EXPECTED_SANDBOX_VOLUME);
    expect(patched).toContain('      # opfield-managed:end sandbox-workspace');
    expect(patched).toContain('      - /var/run/docker.sock:/var/run/docker.sock\n');
    expect(patched).toContain('      - gateway_data:/var/lib/gateway');
    expect(patched).not.toContain('wget -qO- http://127.0.0.1:3000/health');
    expect(patched).toContain('\nvolumes:\n  gateway_data:');
    expect(patched).toContain(`  relay:\n    image: \${OPFIELD_RELAY_IMAGE_REF}`);
    expect(patched).toContain('    entrypoint: ["/gateway-relay"]');
    expect(patched).toContain('net.opfield.managed-service: app');
    expect(patched).toContain('gateway_relay_identity:/var/lib/gateway-relay');
    expect(patched).toContain('gateway_relay_state:/var/lib/gateway-relay/state');
    expect(patched).toContain('# opfield-managed:start registry-service');
    expect(patched).toContain(`  registry:\n    image: \${OPFIELD_REGISTRY_IMAGE_REF}`);
    expect(patched).toContain('net.opfield.managed-service: registry');
    expect(patched).toContain('REGISTRY_STORAGE_DELETE_ENABLED: "true"');
    expect(patched).not.toContain('REGISTRY_STORAGE_MAINTENANCE_UPLOADPURGING_');
    expect(patched).toContain('REGISTRY_AUTH_TOKEN_SERVICE: gateway-internal-registry');
    expect(patched).toContain('      - "5000"');
    expect(patched).toContain('gateway_registry_data:/var/lib/registry');
    expect(patched).toContain('gateway_registry_auth:/var/lib/gateway-registry-auth');
    expect(patched).toContain('gateway_registry_auth:/var/lib/gateway-registry-auth:ro');
    expect(patched).toContain('http://127.0.0.1:5001/debug/health');
    expect(patched).not.toMatch(/(?:127\.0\.0\.1:)?5000:5000/);
    expect(patched).toContain('      relay:\n        condition: service_started');
    expect(patched).not.toContain('RELAY_DATABASE_URL');
    expect(patched).not.toContain('OPFIELD_RELAY_DB_PASSWORD');
    expect(patched.match(/9443:9443/g)).toHaveLength(1);
    expect(patchCompose(patched)).toBe(patched);
  });

  it('replaces legacy relay IP targets with the Compose service DNS name', () => {
    const mappingStyle = OLD_COMPOSE.replace(
      '    env_file: .env',
      '    env_file: .env\n    environment:\n      GATEWAY_RELAY_TARGET: 172.18.0.4:9443'
    );
    const listStyle = OLD_COMPOSE.replace(
      '    env_file: .env',
      '    env_file: .env\n    environment:\n      - GATEWAY_RELAY_TARGET=172.18.0.4:9443'
    );

    for (const compose of [mappingStyle, listStyle]) {
      const patched = patchCompose(compose);
      expect(patched).toContain('OPFIELD_RELAY_TARGET: relay:9443');
      expect(patched).not.toContain('172.18.0.4:9443');
      expect(patched.match(/OPFIELD_RELAY_TARGET/g)).toHaveLength(1);
    }
  });

  it('normalizes an existing relay dependency without duplicating it', () => {
    const compose = OLD_COMPOSE.replace(
      '    depends_on:\n      redis:',
      '    depends_on:\n      relay:\n        condition: service_healthy\n      redis:'
    );

    const patched = patchCompose(compose);
    expect(patched.match(/^\s+relay:$/gm)).toHaveLength(2);
    expect(patched).toContain('      relay:\n        condition: service_started');
    expect(patched).not.toContain('condition: service_healthy\n      redis:');
    expect(patchCompose(patched)).toBe(patched);
  });

  it('replaces the pre-v2.5 build-only app definition with the pinned release image', () => {
    const patched = patchCompose(BUILD_ONLY_APP_COMPOSE);

    expect(patched).toContain(EXPECTED_IMAGE_LINE);
    expect(patched).not.toContain('    build:');
    expect(patched).not.toContain('      context: .');
    expect(patched).not.toContain('      dockerfile: Dockerfile');
  });

  it('removes migrated browser-owned settings wiring without disturbing unrelated configuration', () => {
    const compose = `${OLD_COMPOSE.replace(
      '    env_file: .env',
      `    env_file: .env
    environment:
      OIDC_ISSUER_URL: \${OIDC_ISSUER_URL}
      - OIDC_CLIENT_SECRET=\${OIDC_CLIENT_SECRET}
      CLICKHOUSE_URL: http://clickhouse:8123
      RATE_LIMIT_MAX_REQUESTS: 1200
      - LOGGING_INGEST_MAX_BODY_BYTES=1048576
      INFERENCE_BODY_MAX_BYTES: 33554432
      SESSION_EXPIRY: 2592000
      DEFAULT_CRL_VALIDITY_HOURS: 24
      ACME_EMAIL: admin@example.com
      ACME_STAGING: false
      APP_URL: \${APP_URL}
      SETUP_TOKEN: \${SETUP_TOKEN}
      OTHER_SETTING: keep-me`
    ).replace(
      '      redis:\n        condition: service_healthy',
      '      redis:\n        condition: service_healthy\n      clickhouse:\n        condition: service_healthy'
    )}

  clickhouse:
    image: clickhouse/clickhouse-server:latest
    volumes:
      - clickhouse_data:/var/lib/clickhouse

volumes:
  clickhouse_data:
  redis_data:
`;

    const patched = patchCompose(compose);

    expect(patched).not.toMatch(
      /OIDC_|CLICKHOUSE_|RATE_LIMIT_|LOGGING_INGEST_|INFERENCE_BODY_MAX_BYTES|SESSION_EXPIRY|DEFAULT_CRL_VALIDITY_HOURS|ACME_EMAIL|ACME_STAGING|APP_URL|SETUP_TOKEN/
    );
    expect(patched).not.toContain('\n  clickhouse:');
    expect(patched).not.toContain('clickhouse_data:');
    expect(patched).toContain('OTHER_SETTING: keep-me');
    expect(patched).toContain('\n  redis:\n');
    expect(patched).toContain('  redis_data:');
    expect(patched).toContain('  gateway_data:');
  });

  it('keeps an existing runtime storage mount instead of adding a managed volume', () => {
    const compose = OLD_COMPOSE.replace(
      '      - ./docker-compose.yml:/app/docker-compose.yml:ro',
      '      - /srv/gateway-state:/var/lib/gateway\n      - ./docker-compose.yml:/app/docker-compose.yml:ro'
    );

    const patched = patchCompose(compose);

    expect(patched).toContain('/srv/gateway-state:/var/lib/gateway');
    expect(patched).not.toContain('gateway_data:/var/lib/gateway');
  });

  it('replaces an existing unmarked sandbox volume instead of duplicating it', () => {
    const compose = OLD_COMPOSE.replace(
      '      - ./docker-compose.yml:/app/docker-compose.yml:ro',
      [
        '      - /var/lib/gateway/sandbox-workspaces:/var/lib/gateway/sandbox-workspaces',
        '      - ./docker-compose.yml:/app/docker-compose.yml:ro',
      ].join('\n')
    );
    const patched = patchCompose(compose);

    expect(patched.match(/sandbox-workspaces/g)).toHaveLength(2);
    expect(patched).toContain('# opfield-managed:start sandbox-workspace');
  });

  it('only patches the app service under services', () => {
    const compose = `app:
  image: unrelated/top-level:latest
  volumes:
    - ./top:/top

${OLD_COMPOSE}`;
    const patched = patchCompose(compose);

    expect(patched).toContain('app:\n  image: unrelated/top-level:latest');
    expect(patched).toContain(`    ${EXPECTED_IMAGE_LINE}`);
    expect(patched).toContain(EXPECTED_SANDBOX_VOLUME);
  });

  it('refuses malformed managed blocks', () => {
    const compose = OLD_COMPOSE.replace(
      '      - ./docker-compose.yml:/app/docker-compose.yml:ro',
      '      # gateway-managed:start sandbox-workspace\n      - ./docker-compose.yml:/app/docker-compose.yml:ro'
    );

    expect(() => patchCompose(compose)).toThrow('malformed sandbox workspace managed block');
  });

  it('refuses to replace an existing registry service that is not installer-managed', () => {
    const compose = OLD_COMPOSE.replace(
      '\n  redis:',
      '\n  registry:\n    image: example/custom-registry:latest\n\n  redis:'
    );
    expect(() => patchCompose(compose)).toThrow('existing registry service is not installer-managed');
  });

  it('bounds container logs of installer-managed services and keeps operator logging choices', () => {
    const patched = patchCompose(OLD_COMPOSE, false, BOUNDED);
    const logging = [
      '    logging:',
      '      driver: json-file',
      '      options:',
      '        max-size: "50m"',
      '        max-file: "3"',
    ].join('\n');
    // app, redis, and the canonical relay and registry blocks
    expect(patched.split(logging).length - 1).toBe(4);
    expect(patchCompose(patched, false, BOUNDED)).toBe(patched);

    const custom = OLD_COMPOSE.replace(
      '  redis:\n    image: redis:7-alpine\n',
      '  redis:\n    image: redis:7-alpine\n    logging:\n      driver: journald\n'
    );
    const customPatched = patchCompose(custom, false, BOUNDED);
    expect(customPatched).toContain('    logging:\n      driver: journald\n');
    expect(customPatched.split(logging).length - 1).toBe(3);
  });

  it('treats any logging form, merge key or extends as the operator logging choice', () => {
    const logging = '    logging:\n      driver: json-file\n';
    const variants = [
      '    logging: *default-logging\n',
      '    logging: {driver: local}\n',
      '    "logging":\n      driver: journald\n',
      '    <<: *service-defaults\n',
      '    extends:\n      service: base\n',
    ];
    for (const variant of variants) {
      const compose = `x-defaults: &service-defaults\n  restart: always\nx-logging: &default-logging\n  driver: local\n${OLD_COMPOSE.replace(
        '  redis:\n    image: redis:7-alpine\n',
        `  redis:\n    image: redis:7-alpine\n${variant}`
      )}`;
      const patched = patchCompose(compose, false, BOUNDED);
      // app plus the canonical relay and registry blocks; redis keeps the operator choice
      expect(patched.split(logging).length - 1, variant).toBe(3);
      expect(patched, variant).toContain(`  redis:\n    image: redis:7-alpine\n${variant}`);
      expect(parseDocument(patched, { uniqueKeys: true }).errors, variant).toEqual([]);
      expect(patchCompose(patched, false, BOUNDED)).toBe(patched);
    }
  });

  it('never writes a duplicate logging key, even for a form it does not recognize', () => {
    const compose = OLD_COMPOSE.replace(
      '  redis:\n    image: redis:7-alpine\n',
      '  redis:\n    image: redis:7-alpine\n    ? logging\n    : driver: local\n'
    );
    expect(parseDocument(compose, { uniqueKeys: true }).errors).toEqual([]);

    const patched = patchCompose(compose, false, BOUNDED);

    expect(parseDocument(patched, { uniqueKeys: true }).errors).toEqual([]);
  });

  it('adds no logging when the host Docker logging defaults are unknown', () => {
    const patched = patchCompose(OLD_COMPOSE);

    expect(patched).not.toContain('    logging:');
    expect(patchCompose(patched)).toBe(patched);
  });

  it('removes its own relay and registry limits when the host keeps its own logging defaults', async () => {
    const installer = await readFile(path.resolve(__dirname, '../../../../scripts/install.sh'), 'utf8');
    const start = installer.indexOf("cat >docker-compose.yml <<'COMPOSE'\n");
    const fresh = installer.slice(installer.indexOf('\n', start) + 1, installer.indexOf('\nCOMPOSE\n', start) + 1);

    const hostOwned = patchCompose(fresh, false, { boundedLogging: false });

    // app, postgres and redis already name logging in the file; relay and registry are rewritten.
    expect(hostOwned.match(/^ {4}logging:$/gm)).toHaveLength(3);
    expect(parseDocument(hostOwned, { uniqueKeys: true }).errors).toEqual([]);
    expect(patchCompose(hostOwned, false, BOUNDED).match(/^ {4}logging:$/gm)).toHaveLength(5);
  });

  it('allows bounded logging only for a json-file default without daemon log-opts', () => {
    expect(composeLoggingEligibility({ driver: 'json-file', logOpts: 'none' })).toBe(true);
    expect(composeLoggingEligibility({ driver: 'json-file', logOpts: 'set' })).toBe(false);
    expect(composeLoggingEligibility({ driver: 'journald', logOpts: null })).toBe(false);
    expect(composeLoggingEligibility({ driver: 'json-file', logOpts: null })).toBeNull();
    expect(composeLoggingEligibility(undefined)).toBeNull();
  });

  it('derives the host defaults from Docker info and the app container log configuration', () => {
    expect(hostDockerLogDefaults('json-file', { Type: 'json-file', Config: {} })).toEqual({
      driver: 'json-file',
      logOpts: 'none',
    });
    // Docker copies daemon.json log-opts into a container without logging of its own.
    expect(hostDockerLogDefaults('json-file', { Type: 'json-file', Config: { 'max-size': '10m' } })).toEqual({
      driver: 'json-file',
      logOpts: 'set',
    });
    // Opfield's own bounded logging on the app says nothing about the daemon.
    expect(
      hostDockerLogDefaults('json-file', { Type: 'json-file', Config: { 'max-size': '50m', 'max-file': '3' } })
    ).toEqual({ driver: 'json-file', logOpts: 'none' });
    expect(hostDockerLogDefaults('json-file', { Type: 'local', Config: {} })).toEqual({
      driver: 'json-file',
      logOpts: null,
    });
    expect(hostDockerLogDefaults('journald', { Type: 'journald' })).toEqual({ driver: 'journald', logOpts: null });
    expect(hostDockerLogDefaults(undefined, { Type: 'json-file' })).toBeUndefined();
  });

  it('passes the host defaults to the migrator through the environment', () => {
    const env = dockerLogDefaultsEnv({ driver: 'json-file', logOpts: 'none' });
    expect(env).toEqual(['OPFIELD_DOCKER_LOG_DRIVER=json-file', 'OPFIELD_DOCKER_LOG_OPTS=none']);
    expect(
      dockerLogDefaultsFromEnv(Object.fromEntries(env.map((entry) => entry.split('=') as [string, string])))
    ).toEqual({ driver: 'json-file', logOpts: 'none' });
    expect(dockerLogDefaultsFromEnv({})).toBeUndefined();
    expect(dockerLogDefaultsEnv(undefined)).toEqual([]);
  });

  it('leaves the installer compose logging limits as they are', async () => {
    const installer = await readFile(path.resolve(__dirname, '../../../../scripts/install.sh'), 'utf8');
    const start = installer.indexOf("cat >docker-compose.yml <<'COMPOSE'\n");
    const fresh = installer.slice(installer.indexOf('\n', start) + 1, installer.indexOf('\nCOMPOSE\n', start) + 1);
    expect(fresh.match(/^ {4}logging:$/gm)).toHaveLength(5);

    const patched = patchCompose(fresh);
    expect(patched.match(/^ {4}logging:$/gm)).toHaveLength(5);
    expect(patchCompose(patched)).toBe(patched);
  });

  it('upserts env keys without leaving duplicates', () => {
    const patched = patchEnv('OPFIELD_VERSION=v2.4.2\nOPFIELD_VERSION=old\nOTHER=value\n', {
      OPFIELD_VERSION: 'v2.4.3',
      OPFIELD_IMAGE_REF: 'registry/gateway:v2.4.3',
    }).content;

    expect(patched).toBe('OPFIELD_VERSION=v2.4.3\nOTHER=value\n\nOPFIELD_IMAGE_REF=registry/gateway:v2.4.3\n');
  });
});

describe('runFoundationMigrations', () => {
  let tempDir = '';

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  it('adds bounded Compose logging only with json-file host defaults', async () => {
    const run = async (dockerLogDefaults?: { driver: string; logOpts: 'none' | 'set' | null }) => {
      tempDir = await mkdtemp(path.join(os.tmpdir(), 'gateway-foundation-migrator-test-'));
      await writeFile(path.join(tempDir, '.env'), 'GATEWAY_VERSION=v2.4.2\n');
      await writeFile(path.join(tempDir, 'docker-compose.yml'), OLD_COMPOSE);
      await runFoundationMigrations({
        hostDir: tempDir,
        relayImageRef: `registry/gateway/relay@sha256:${'a'.repeat(64)}`,
        sandboxWorkspaceDir: path.join(tempDir, 'sandbox-workspaces'),
        dockerLogDefaults,
      });
      const compose = await readFile(path.join(tempDir, 'docker-compose.yml'), 'utf8');
      await rm(tempDir, { recursive: true, force: true });
      tempDir = '';
      return compose.match(/^ {4}logging:$/gm)?.length ?? 0;
    };

    expect(await run({ driver: 'json-file', logOpts: 'none' })).toBe(4);
    expect(await run({ driver: 'json-file', logOpts: 'set' })).toBe(0);
    expect(await run({ driver: 'journald', logOpts: null })).toBe(0);
    expect(await run(undefined)).toBe(0);
  });

  it('patches host foundation files and writes backups only when files change', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'gateway-foundation-migrator-test-'));
    await writeFile(
      path.join(tempDir, '.env'),
      'GATEWAY_VERSION=v2.4.2\nGATEWAY_RELAY_TARGET=172.18.0.4:9443\nGATEWAY_RELAY_VERSION=1\nGATEWAY_RELAY_DB_PASSWORD=legacy-secret\nRELAY_DATABASE_URL=postgres://legacy\nDATABASE_CONNECTOR_IMAGE=registry/legacy-database-connector:old\n'
    );
    await writeFile(path.join(tempDir, 'docker-compose.yml'), OLD_COMPOSE);
    const sandboxWorkspaceDir = path.join(tempDir, 'sandbox-workspaces');

    const first = await runFoundationMigrations({
      hostDir: tempDir,
      targetVersion: 'v2.4.3',
      imageRef: 'registry/gateway:v2.4.3',
      secureLinkConnectorImage: 'registry/gateway/secure-link-connector@sha256:secure-connector',
      relayBuildVersion: 'v2.4.3-relay',
      relayProtocolMajor: 1,
      relayImageRef: `registry/gateway/relay@sha256:${'a'.repeat(64)}`,
      sandboxWorkspaceDir,
    });
    const second = await runFoundationMigrations({
      hostDir: tempDir,
      targetVersion: 'v2.4.3',
      imageRef: 'registry/gateway:v2.4.3',
      secureLinkConnectorImage: 'registry/gateway/secure-link-connector@sha256:secure-connector',
      relayBuildVersion: 'v2.4.3-relay',
      relayProtocolMajor: 1,
      relayImageRef: `registry/gateway/relay@sha256:${'a'.repeat(64)}`,
      sandboxWorkspaceDir,
    });

    expect(first.changedFiles).toEqual(['.env', 'docker-compose.yml']);
    expect(first.backupDir).toContain('.opfield-foundation-backups');
    expect(second.changedFiles).toEqual([]);
    expect(second.backupDir).toBeNull();
    expect(await readFile(path.join(tempDir, '.env'), 'utf8')).toContain('OPFIELD_IMAGE_REF=registry/gateway:v2.4.3');
    expect(await readFile(path.join(tempDir, '.env'), 'utf8')).not.toContain('DATABASE_CONNECTOR_IMAGE');
    expect(await readFile(path.join(tempDir, '.env'), 'utf8')).toContain(
      'SECURE_LINK_CONNECTOR_IMAGE=registry/gateway/secure-link-connector@sha256:secure-connector'
    );
    expect(await readFile(path.join(tempDir, '.env'), 'utf8')).toContain(
      `OPFIELD_RELAY_IMAGE_REF=registry/gateway/relay@sha256:${'a'.repeat(64)}`
    );
    expect(await readFile(path.join(tempDir, '.env'), 'utf8')).toContain('OPFIELD_RELAY_TARGET=relay:9443');
    expect(await readFile(path.join(tempDir, '.env'), 'utf8')).toContain(
      'OPFIELD_REGISTRY_IMAGE_REF=ghcr.io/the-square-labs/gateway/registry@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8'
    );
    const firstRegistrySecret = /^OPFIELD_REGISTRY_HTTP_SECRET=(.+)$/m.exec(
      await readFile(path.join(tempDir, '.env'), 'utf8')
    )?.[1];
    expect(firstRegistrySecret).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(path.join(tempDir, '.env'), 'utf8')).not.toContain('172.18.0.4:9443');
    expect(await readFile(path.join(tempDir, '.env'), 'utf8')).not.toContain('OPFIELD_RELAY_DB_PASSWORD');
    expect(await readFile(path.join(tempDir, '.env'), 'utf8')).not.toContain('OPFIELD_RELAY_VERSION');
    expect(await readFile(path.join(tempDir, '.env'), 'utf8')).not.toContain('RELAY_DATABASE_URL');
    expect(await readFile(path.join(tempDir, 'docker-compose.yml'), 'utf8')).toContain(
      '# opfield-managed:start sandbox-workspace'
    );
    expect(await readFile(path.join(tempDir, 'docker-compose.yml'), 'utf8')).toContain(
      '# opfield-managed:start registry-service'
    );
    expect(await readFile(path.join(tempDir, 'docker-compose.yml'), 'utf8')).toContain(
      'gateway_registry_data:/var/lib/registry'
    );
    expect(/^OPFIELD_REGISTRY_HTTP_SECRET=(.+)$/m.exec(await readFile(path.join(tempDir, '.env'), 'utf8'))?.[1]).toBe(
      firstRegistrySecret
    );
  });

  it('keeps the relay image pinned when the signed relay digest is unchanged', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'gateway-foundation-migrator-test-'));
    await writeFile(
      path.join(tempDir, '.env'),
      `GATEWAY_RELAY_IMAGE_REF=registry/gateway/relay@sha256:${'a'.repeat(64)}\nGATEWAY_RELAY_BUILD_VERSION=v2.4.3-relay\nGATEWAY_RELAY_PROTOCOL_MAJOR=1\n`
    );
    await writeFile(path.join(tempDir, 'docker-compose.yml'), OLD_COMPOSE);

    await runFoundationMigrations({
      hostDir: tempDir,
      targetVersion: 'v2.4.4',
      imageRef: 'registry/gateway@sha256:new',
      relayBuildVersion: 'v2.4.4-relay',
      relayProtocolMajor: 1,
      relayImageRef: `registry/gateway/relay@sha256:${'a'.repeat(64)}`,
    });

    const env = await readFile(path.join(tempDir, '.env'), 'utf8');
    expect(env).toContain('OPFIELD_IMAGE_REF=registry/gateway@sha256:new');
    expect(env).toContain(`OPFIELD_RELAY_IMAGE_REF=registry/gateway/relay@sha256:${'a'.repeat(64)}`);
    expect(env).toContain('OPFIELD_RELAY_BUILD_VERSION=v2.4.3-relay');
    expect(env).not.toContain('OPFIELD_RELAY_BUILD_VERSION=v2.4.4-relay');
  });

  it('preserves all Relay metadata when a Gateway-only update omits Relay arguments', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'gateway-foundation-migrator-test-'));
    const relayImage = `registry/gateway/relay@sha256:${'a'.repeat(64)}`;
    await writeFile(
      path.join(tempDir, '.env'),
      `GATEWAY_VERSION=v2.4.3\nGATEWAY_IMAGE_REF=registry/gateway@sha256:old\nGATEWAY_RELAY_IMAGE_REF=${relayImage}\nGATEWAY_RELAY_BUILD_VERSION=v2.4.3-relay\nGATEWAY_RELAY_PROTOCOL_MAJOR=1\n`
    );
    await writeFile(path.join(tempDir, 'docker-compose.yml'), OLD_COMPOSE);

    await runFoundationMigrations({
      hostDir: tempDir,
      targetVersion: 'v2.4.4',
      imageRef: 'registry/gateway@sha256:new',
    });

    const env = await readFile(path.join(tempDir, '.env'), 'utf8');
    expect(env).toContain('OPFIELD_VERSION=v2.4.4');
    expect(env).toContain('OPFIELD_IMAGE_REF=registry/gateway@sha256:new');
    expect(env).toContain(`OPFIELD_RELAY_IMAGE_REF=${relayImage}`);
    expect(env).toContain('OPFIELD_RELAY_BUILD_VERSION=v2.4.3-relay');
    expect(env).toContain('OPFIELD_RELAY_PROTOCOL_MAJOR=1');
  });

  it('advances the relay image only when the signed relay digest changes', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'gateway-foundation-migrator-test-'));
    await writeFile(
      path.join(tempDir, '.env'),
      `GATEWAY_RELAY_IMAGE_REF=registry/gateway/relay@sha256:${'a'.repeat(64)}\n`
    );
    await writeFile(path.join(tempDir, 'docker-compose.yml'), OLD_COMPOSE);

    await runFoundationMigrations({
      hostDir: tempDir,
      imageRef: 'registry/gateway@sha256:new',
      relayBuildVersion: 'v2.4.5-relay',
      relayProtocolMajor: 1,
      relayImageRef: `registry/gateway/relay@sha256:${'b'.repeat(64)}`,
    });

    const env = await readFile(path.join(tempDir, '.env'), 'utf8');
    expect(env).toContain(`OPFIELD_RELAY_IMAGE_REF=registry/gateway/relay@sha256:${'b'.repeat(64)}`);
  });

  it('rejects an unsupported relay protocol major', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'gateway-foundation-migrator-test-'));
    await writeFile(path.join(tempDir, '.env'), '');
    await writeFile(path.join(tempDir, 'docker-compose.yml'), OLD_COMPOSE);

    await expect(
      runFoundationMigrations({
        hostDir: tempDir,
        imageRef: 'registry/gateway@sha256:new',
        relayProtocolMajor: 2,
        relayImageRef: `registry/gateway/relay@sha256:${'b'.repeat(64)}`,
      })
    ).rejects.toThrow('does not support relay protocol major 2');
  });
});
