import { generateKeyPairSync, sign } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runFoundationMigrations } from '@/foundation/foundation-migrator.js';
import { loadCommercialPackage, sha256 } from './loader.js';
import {
  type CommercialUpdateGrant,
  commercialHostRoot,
  prepareCommercialUpdate,
  pruneCommercialVersions,
  readPreparedCommercialUpdate,
} from './prepare-update.js';

const key = generateKeyPairSync('ed25519');
const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' });
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function host() {
  const root = await mkdtemp(join(tmpdir(), 'gateway-core-update-'));
  roots.push(root);
  return root;
}
function release(version: string, code = 'module.exports.default={apiVersion:1,register(){return {}}}') {
  const files = { 'backend/index.cjs': code, 'frontend/paid.js': '/* paid interface */' };
  const payload = Buffer.from(
    JSON.stringify({
      kind: 'gateway-commercial',
      version,
      hostVersion: version,
      hostApiVersion: 1,
      backendEntry: 'backend/index.cjs',
      files: Object.entries(files).map(([path, contents]) => ({
        path,
        size: Buffer.byteLength(contents),
        sha256: sha256(Buffer.from(contents)),
      })),
    })
  );
  const signedManifest = JSON.stringify({
    schemaVersion: 1,
    keyId: 'wiolett-update-v1',
    payload: payload.toString('base64url'),
    signature: sign(null, payload, key.privateKey).toString('base64url'),
  });
  const read = vi.fn(async (path: string) => new Response(files[path as keyof typeof files]));
  const grant: CommercialUpdateGrant = { edition: 'commercial', signedManifest, readFile: read };
  return { grant, read };
}

describe('private core update preparation', () => {
  it('checks entitlement before download and never executes the candidate', async () => {
    const hostDir = await host(),
      version = 'v3.0.0-rc.1';
    const source = release(version, 'throw new Error("must not execute during preparation")');
    const authorize = vi.fn(async () => source.grant);
    await prepareCommercialUpdate({ hostDir, hostVersion: version, authorize, publicKey });
    expect(authorize.mock.invocationCallOrder[0]).toBeLessThan(source.read.mock.invocationCallOrder[0]);
    expect(source.read).toHaveBeenCalledTimes(2);
    expect(await readPreparedCommercialUpdate(hostDir, version, publicKey)).toMatchObject({
      edition: 'commercial',
      hostVersion: version,
    });
    // Cached bytes still require online admission and full verification.
    await prepareCommercialUpdate({ hostDir, hostVersion: version, authorize, publicKey });
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(source.read).toHaveBeenCalledTimes(2);
    // The admission learns whether the host already holds a private core it must not lose.
    expect(authorize.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { privateCoreInstalled: false },
      { privateCoreInstalled: true },
    ]);
  });

  it('does not prepare or touch host configuration when license validation fails', async () => {
    const hostDir = await host();
    await writeFile(join(hostDir, '.env'), 'CURRENT=old\n');
    await expect(
      prepareCommercialUpdate({
        hostDir,
        hostVersion: 'v3.0.0-rc.1',
        publicKey,
        authorize: async () => {
          throw new Error('revoked');
        },
      })
    ).rejects.toThrow('revoked');
    expect(await readdir(hostDir)).toEqual(['.env']);
    expect(await readFile(join(hostDir, '.env'), 'utf8')).toBe('CURRENT=old\n');
  });

  it.each([
    'tamper',
    'truncated',
    'unavailable',
    'wrong-version',
    'bad-signature',
  ])('fails before activation for %s', async (failure) => {
    const hostDir = await host(),
      version = 'v3.0.0-rc.2';
    const source = release(failure === 'wrong-version' ? 'v3.0.0-rc.9' : version);
    if (source.grant.edition !== 'commercial') throw new Error('test fixture');
    if (failure === 'bad-signature')
      source.grant.signedManifest = source.grant.signedManifest.replace('wiolett-update-v1', 'untrusted');
    if (failure === 'tamper') {
      const originalRead = source.read.getMockImplementation()!;
      source.read.mockImplementation(
        async (path) => new Response('x'.repeat((await (await originalRead(path)).text()).length))
      );
    }
    if (failure === 'truncated') source.read.mockImplementation(async () => new Response('x'));
    if (failure === 'unavailable') source.read.mockImplementation(async () => new Response('denied', { status: 403 }));
    await expect(
      prepareCommercialUpdate({ hostDir, hostVersion: version, authorize: async () => source.grant, publicKey })
    ).rejects.toThrow();
    await expect(readPreparedCommercialUpdate(hostDir, version, publicKey)).rejects.toThrow();
    expect((await readdir(commercialHostRoot(hostDir))).some((name) => name.startsWith('.download-'))).toBe(false);
    if (['bad-signature', 'wrong-version'].includes(failure)) expect(source.read).not.toHaveBeenCalled();
  });

  it('keeps the previous image/core pair across a subsequent update and foundation rollback', async () => {
    const hostDir = await host(),
      oldVersion = 'v3.0.0-rc.1',
      nextVersion = 'v3.0.0-rc.2';
    const first = release(oldVersion),
      second = release(nextVersion);
    const old = await prepareCommercialUpdate({
      hostDir,
      hostVersion: oldVersion,
      authorize: async () => first.grant,
      publicKey,
    });
    await writeFile(
      join(hostDir, '.env'),
      `GATEWAY_RELAY_IMAGE_REF=relay@sha256:${'a'.repeat(64)}\nGATEWAY_IMAGE_REF=old-image\nGATEWAY_COMMERCIAL_DIR=/var/lib/gateway/commercial/versions/${oldVersion}\n`
    );
    await writeFile(
      join(hostDir, 'docker-compose.yml'),
      'services:\n  app:\n    image: old-image\n    env_file: .env\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n'
    );
    const before = await readFile(join(hostDir, '.env'), 'utf8');
    const prepared = await prepareCommercialUpdate({
      hostDir,
      hostVersion: nextVersion,
      authorize: async () => second.grant,
      publicKey,
    });
    expect(await readFile(join(hostDir, '.env'), 'utf8')).toBe(before);
    expect(await readPreparedCommercialUpdate(hostDir, oldVersion, publicKey)).toEqual(old);
    const result = await runFoundationMigrations({
      hostDir,
      targetVersion: nextVersion,
      imageRef: 'new-image',
      commercial: prepared,
      sandboxWorkspaceDir: join(hostDir, 'workspaces'),
    });
    expect(await readFile(join(hostDir, '.env'), 'utf8')).toContain(`/versions/${nextVersion}`);
    // A fresh directory gets the Opfield commercial directory, and Compose mounts the directory the core went to.
    expect(await readFile(join(hostDir, 'docker-compose.yml'), 'utf8')).toContain(
      './.opfield-commercial:/var/lib/gateway/commercial:ro'
    );
    await copyFile(join(result.backupDir!, '.env'), join(hostDir, '.env'));
    await copyFile(join(result.backupDir!, 'docker-compose.yml'), join(hostDir, 'docker-compose.yml'));
    expect(await readFile(join(hostDir, '.env'), 'utf8')).toBe(before);
    const loaded = await loadCommercialPackage({
      directory: join(commercialHostRoot(hostDir), 'versions', oldVersion),
      hostVersion: oldVersion,
      publicKey,
    });
    expect(loaded?.releaseId).toBe(old.releaseId);
  });

  it('rejects mutation of a published version and post-download tampering', async () => {
    const hostDir = await host(),
      version = 'v3.0.0-rc.1',
      source = release(version);
    const prepared = await prepareCommercialUpdate({
      hostDir,
      hostVersion: version,
      authorize: async () => source.grant,
      publicKey,
    });
    await expect(
      prepareCommercialUpdate({
        hostDir,
        hostVersion: version,
        authorize: async () => release(version, 'different').grant,
        publicKey,
      })
    ).rejects.toThrow('rebound');
    const file = join(
      commercialHostRoot(hostDir),
      'versions',
      version,
      'releases',
      prepared.releaseId!,
      'frontend/paid.js'
    );
    await writeFile(file, 'changed');
    await expect(readPreparedCommercialUpdate(hostDir, version, publicKey)).rejects.toThrow();
  });

  it('prepares Community without downloading a private artifact', async () => {
    const hostDir = await host(),
      hostVersion = 'v3.0.0-rc.1';
    const authorize = vi.fn(async (): Promise<CommercialUpdateGrant> => ({ edition: 'community' }));
    await prepareCommercialUpdate({ hostDir, hostVersion, authorize, publicKey });
    expect(await readPreparedCommercialUpdate(hostDir, hostVersion, publicKey)).toMatchObject({
      edition: 'community',
      releaseId: null,
    });
    // A Community receipt is not a private core: the next update may still go without the license server.
    await prepareCommercialUpdate({ hostDir, hostVersion: 'v3.0.0-rc.2', authorize, publicKey });
    expect(authorize.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { privateCoreInstalled: false },
      { privateCoreInstalled: false },
    ]);
  });

  it('keeps only the prepared, running, newer and one spare private core', async () => {
    const hostDir = await host();
    const root = join(hostDir, '.opfield-commercial');
    const versions = ['v2.12.0', 'v2.12.1', 'v2.12.2', 'v2.12.3-rc.1', 'v2.12.3', 'v2.12.4'];
    for (const [index, version] of versions.entries()) {
      await mkdir(join(root, 'versions', version, 'releases'), { recursive: true });
      await mkdir(join(root, 'prepared'), { recursive: true });
      await writeFile(join(root, 'prepared', `${version}.json`), '{}');
      const at = new Date(Date.now() - (versions.length - index) * 60_000);
      await utimes(join(root, 'prepared', `${version}.json`), at, at);
    }
    const oldStage = join(root, 'versions', 'v2.12.3', 'releases', '.staged-1');
    const oldDownload = join(root, '.download-1');
    const freshDownload = join(root, '.download-2');
    for (const dir of [oldStage, oldDownload, freshDownload]) await mkdir(dir, { recursive: true });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(oldStage, old, old);
    await utimes(oldDownload, old, old);
    await writeFile(join(hostDir, '.env'), 'OPFIELD_COMMERCIAL_DIR=/var/lib/gateway/commercial/versions/v2.12.1\n');

    const removed = await pruneCommercialVersions(root, hostDir, 'v2.12.3');

    // v2.12.3 prepared, v2.12.1 running, v2.12.4 newer, v2.12.3-rc.1 the most recent spare.
    expect(removed.sort()).toEqual(['v2.12.0', 'v2.12.2']);
    expect((await readdir(join(root, 'versions'))).sort()).toEqual(['v2.12.1', 'v2.12.3', 'v2.12.3-rc.1', 'v2.12.4']);
    expect((await readdir(join(root, 'prepared'))).sort()).toEqual([
      'v2.12.1.json',
      'v2.12.3-rc.1.json',
      'v2.12.3.json',
      'v2.12.4.json',
    ]);
    expect(await readdir(join(root, 'versions', 'v2.12.3', 'releases'))).toEqual([]);
    expect((await readdir(root)).filter((name) => name.startsWith('.download-'))).toEqual(['.download-2']);
  });
});
