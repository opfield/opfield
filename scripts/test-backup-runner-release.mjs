// Disposable release smoke: resolve the default from the built Opfield image,
// then execute that exact runner against real PostgreSQL and S3, without overrides.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

const [opfieldImage, expectedRunner] = process.argv.slice(2);
if (!opfieldImage || !expectedRunner) throw new Error('Usage: test-backup-runner-release.mjs OPFIELD_IMAGE RUNNER_DIGEST');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 180_000 }).trim();
const runner = docker('run', '--rm', '-e', 'BACKUP_RUNNER_IMAGE=', '--entrypoint', 'node', opfieldImage,
  '--input-type=module', '-e', "import { resolveBackupRunnerImage } from './dist/config/backup-runner-image.js'; console.log(resolveBackupRunnerImage(process.env.BACKUP_RUNNER_IMAGE));");
assert.equal(runner, expectedRunner, 'empty legacy Compose override must resolve the bundled runner');
assert.match(runner, /^[^\s@]+@sha256:[0-9a-f]{64}$/);
// Storage nodes have no CI registry credentials. Do not ship a private runner
// merely because the authenticated build runner can pull it successfully.
if (runner.startsWith('ghcr.io/')) {
  const [repository, digest] = runner.slice('ghcr.io/'.length).split('@');
  const response = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${repository}:pull`)}`, { signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, 'backup runner must be anonymously pullable');
  const { token } = await response.json();
  const manifest = await fetch(`https://ghcr.io/v2/${repository}/manifests/${digest}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' },
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(manifest.ok, 'public backup runner index must be available');
  const bytes = Buffer.from(await manifest.arrayBuffer());
  assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, digest);
  const index = JSON.parse(bytes);
  for (const architecture of ['amd64', 'arm64']) {
    assert.ok(index.manifests?.some(entry => entry.platform?.os === 'linux' && entry.platform?.architecture === architecture), `runner is missing linux/${architecture}`);
  }
}

const prefix = `gateway-backup-smoke-${randomUUID().slice(0, 8)}`;
const pg = `${prefix}-pg`, s3 = `${prefix}-s3`;
const configVolume = `${prefix}-config`, workVolume = `${prefix}-work`;
const fixture = mkdtempSync(join(tmpdir(), 'gateway-backup-smoke-'));
const postgresImage = readFileSync(new URL('../packages/daemons/backup-runner/Dockerfile', import.meta.url), 'utf8').match(/^FROM (\S+)/m)?.[1];
// The disposable S3 fixture must not depend on the private managed-storage catalog. MinIO withdrew its public
// images, so the fixture is SeaweedFS 4.47 pinned by digest in the third-party mirror list. Prefer the GHCR
// mirror (same digest); fall back to the upstream source while the mirror does not exist yet.
const mirrorList = JSON.parse(readFileSync(new URL('../config/third-party-images.json', import.meta.url), 'utf8'));
const seaweedfs = mirrorList.images.find(image => image.name === 'seaweedfs' && image.tag === '4.47');
const s3Digest = seaweedfs?.source.match(/@(sha256:[0-9a-f]{64})$/)?.[1];
assert.ok(s3Digest, 'SeaweedFS 4.47 must be digest-pinned in config/third-party-images.json');
function pullFixture(candidates) {
  for (const image of candidates) {
    const pulled = spawnSync('docker', ['pull', '--quiet', image], { encoding: 'utf8', timeout: 300_000 });
    if (pulled.status === 0) return image;
    console.warn(`Fixture image ${image} is unavailable (${(pulled.stderr || String(pulled.error)).trim().split('\n')[0]}); trying the next source`);
  }
  throw new Error(`No fixture image source is available: ${candidates.join(', ')}`);
}
const s3Image = pullFixture([`${mirrorList.mirrorRepository}/seaweedfs@${s3Digest}`, seaweedfs.source]);
assert.ok(postgresImage && s3Image.endsWith(`@${s3Digest}`), 'use the repository-pinned fixture images');
const password = randomUUID();
const resources = { containers: [], volumes: [], network: false };
const mount = (name, target, readonly = false) => ['--mount', `type=volume,src=${name},dst=${target}${readonly ? ',readonly' : ''}`];
async function ready(probe) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { probe(); return; } catch { await setTimeout(500); }
  }
  throw new Error('Backup smoke fixture did not become ready');
}
const sql = (database, statement) => docker('exec', pg, 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-Atqc', statement);
const storageEnv = [
  '-e', 'RCLONE_CONFIG_TARGET_TYPE=s3', '-e', 'RCLONE_CONFIG_TARGET_PROVIDER=Minio',
  '-e', `RCLONE_CONFIG_TARGET_ENDPOINT=http://${s3}:9000`,
  '-e', 'RCLONE_CONFIG_TARGET_ACCESS_KEY_ID=smoke', '-e', `RCLONE_CONFIG_TARGET_SECRET_ACCESS_KEY=${password}`,
  '-e', 'RCLONE_CONFIG_TARGET_FORCE_PATH_STYLE=true',
];
function execute(config, operation, shouldFail = false) {
  writeFileSync(join(fixture, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  docker('run', '--rm', '--network', 'none', '--user', '0', '--entrypoint', 'sh',
    '--mount', `type=bind,src=${fixture},dst=/input,readonly`,
    ...mount(configVolume, '/config'), ...mount(workVolume, '/work'), runner,
    '-c', 'cp /input/config.json /config/config.json && chown 65532:65532 /config/config.json /work && chmod 600 /config/config.json');
  const result = spawnSync('docker', ['run', '--rm', '--network', prefix, '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--memory=512m', '--cpus=1',
    ...mount(configVolume, '/run/gateway-backup', true), ...mount(workVolume, '/work'), runner, operation],
    { encoding: 'utf8', timeout: 120_000 });
  if (result.error) throw result.error;
  const payload = JSON.parse(docker('run', '--rm', '--network', 'none', '--entrypoint', 'cat',
    ...mount(workVolume, '/work', true), runner, '/work/result.json'));
  assert.equal(result.status, shouldFail ? 1 : 0, JSON.stringify(payload));
  assert.equal(payload.status, shouldFail ? 'failed' : 'completed');
  return payload;
}
try {
  docker('network', 'create', '--internal', prefix); resources.network = true;
  for (const volume of [configVolume, workVolume]) {
    docker('volume', 'create', volume); resources.volumes.push(volume);
  }
  docker('run', '-d', '--name', pg, '--network', prefix, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', postgresImage);
  resources.containers.push(pg);
  // One S3 identity "smoke" with the random password; the secret stays in the environment, not the command line.
  const s3Config = `{"identities":[{"name":"smoke","credentials":[{"accessKey":"smoke","secretKey":"'"$S3_SECRET"'"}],"actions":["Admin","Read","Write","List","Tagging"]}]}`;
  docker('run', '-d', '--name', s3, '--network', prefix, '-e', `S3_SECRET=${password}`, '--entrypoint', 'sh', s3Image, '-c',
    `printf '%s' '${s3Config}' > /tmp/s3.json && exec weed server -dir=/data -s3 -s3.port=9000 -s3.config=/tmp/s3.json`);
  resources.containers.push(s3);
  await ready(() => sql('postgres', 'SELECT 1'));
  await ready(() => docker('run', '--rm', '--network', prefix, ...storageEnv, '--entrypoint', 'rclone', runner, 'mkdir', 'target:backups'));
  sql('postgres', 'CREATE DATABASE source'); sql('postgres', 'CREATE DATABASE target');
  sql('source', "CREATE TABLE items AS SELECT n AS id, md5(n::text) AS value FROM generate_series(1,100) AS n");
  const config = {
    runId: randomUUID(), version: 1, direction: 'backup', engine: 'postgres', toolImage: runner,
    source: { connectionId: 'smoke-source', host: pg, port: 5432, username: 'postgres', database: 'source', tls: false },
    destination: { connectionId: 'smoke-storage', provider: 's3', endpoint: `http://${s3}:9000`, bucket: 'backups', prefix: 'smoke', accessKeyId: 'smoke', secretAccessKey: password, forcePathStyle: true },
    limits: { timeoutSeconds: 120, workspaceBytes: 1073741824, cpuCores: 1, memoryMb: 512 },
  };
  execute(config, 'preflight');
  const backup = execute(config, 'backup');
  assert.ok(backup.manifest?.artifactKeys?.length > 0);
  const restore = { ...config, runId: randomUUID(), direction: 'restore', restoreArtifact: backup.manifest,
    restoreTarget: { ...config.source, database: 'target' } };
  execute(restore, 'preflight'); execute(restore, 'restore');
  const checksum = "SELECT count(*) || ':' || md5(string_agg(id::text || value, ',' ORDER BY id)) FROM items";
  assert.equal(sql('target', checksum), sql('source', checksum));
  const rejected = execute(restore, 'restore', true);
  assert.match(rejected.error, /empty/i);
  console.log(JSON.stringify({ bundledRunner: runner, override: 'empty', postgresS3Roundtrip: 'passed', rows: 100, nonemptyRestore: 'rejected' }));
} finally {
  const cleanupErrors = [];
  for (const name of resources.containers.reverse()) {
    const result = spawnSync('docker', ['rm', '-fv', name], { encoding: 'utf8', timeout: 30_000 });
    if (result.status !== 0) cleanupErrors.push(`container ${name}`);
  }
  for (const name of resources.volumes) {
    const result = spawnSync('docker', ['volume', 'rm', name], { encoding: 'utf8', timeout: 30_000 });
    if (result.status !== 0) cleanupErrors.push(`volume ${name}`);
  }
  if (resources.network) {
    const result = spawnSync('docker', ['network', 'rm', prefix], { encoding: 'utf8', timeout: 30_000 });
    if (result.status !== 0) cleanupErrors.push(`network ${prefix}`);
  }
  rmSync(fixture, { recursive: true, force: true });
  if (cleanupErrors.length) throw new Error(`Cleanup failed: ${cleanupErrors.join(', ')}`);
}
