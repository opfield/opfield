import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activatePreviousCommercialRelease, installCommercialRelease } from './install.js';
import { loadCommercialPackage, sha256 } from './loader.js';

const key = generateKeyPairSync('ed25519');
const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' });
const dirs: string[] = [];
const code = 'module.exports.default = { apiVersion: 1, register: () => ({}) };';

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(patch: Record<string, unknown> = {}, entry = code) {
  const root = await mkdtemp(join(tmpdir(), 'opfield-edition-'));
  dirs.push(root);
  const files = [
    { path: 'backend/index.cjs', sha256: sha256(Buffer.from(entry)), size: Buffer.byteLength(entry) },
    { path: 'frontend/app.js', sha256: sha256(Buffer.from('ui')), size: 2 },
  ];
  const payload = Buffer.from(
    JSON.stringify({
      kind: 'opfield-commercial',
      version: '0.1.0',
      hostVersion: 'dev',
      hostApiVersion: 1,
      backendEntry: 'backend/index.cjs',
      files,
      ...patch,
    })
  );
  const signed = JSON.stringify({
    schemaVersion: 1,
    keyId: 'wiolett-update-v1',
    payload: payload.toString('base64url'),
    signature: sign(null, payload, key.privateKey).toString('base64url'),
  });
  const releaseId = sha256(Buffer.from(signed));
  const release = join(root, 'releases', releaseId);
  await mkdir(join(release, 'backend'), { recursive: true });
  await mkdir(join(release, 'frontend'));
  await writeFile(join(release, 'manifest.json'), signed);
  await writeFile(join(release, 'backend/index.cjs'), entry);
  await writeFile(join(release, 'frontend/app.js'), 'ui');
  await writeFile(join(root, 'active.json'), JSON.stringify({ releaseId }));
  return { root, release, releaseId };
}

describe('commercial artifact loading', () => {
  it('does not expose compiled private source in initialization errors', async () => {
    const { root } = await fixture({}, 'const PRIVATE_SOURCE_SENTINEL = ;');
    const error = await loadCommercialPackage({ directory: root, hostVersion: 'dev', publicKey }).catch(
      (reason) => reason
    );
    expect(error.message).toBe('Commercial backend initialization failed');
    expect(error.stack).not.toContain('PRIVATE_SOURCE_SENTINEL');
    expect(error.stack).not.toContain('data:text');
  });

  it('uses a release identifier rather than source bytes in runtime stacks', async () => {
    const source =
      'const PRIVATE_SOURCE_SENTINEL = 1; module.exports.default = {apiVersion:1, register(){throw new Error("operation failed")}}';
    const { root, releaseId } = await fixture({}, source);
    const loaded = await loadCommercialPackage({ directory: root, hostVersion: 'dev', publicKey });
    let error: unknown;
    try {
      loaded!.module.register({} as never);
    } catch (reason) {
      error = reason;
    }
    expect((error as Error).stack).toContain(`opfield-commercial/${releaseId}/backend/index.cjs`);
    expect((error as Error).stack).not.toContain('PRIVATE_SOURCE_SENTINEL');
    expect((error as Error).stack).not.toContain('data:text');
  });

  it('starts without a private package and never imports code', async () => {
    const { root } = await fixture();
    await rm(join(root, 'active.json'));
    const executeModule = vi.fn();
    await expect(
      loadCommercialPackage({ directory: root, hostVersion: 'dev', publicKey, executeModule })
    ).resolves.toBeNull();
    expect(executeModule).not.toHaveBeenCalled();
  });

  it('loads a signed matching package from verified bytes', async () => {
    const { root, releaseId } = await fixture();
    const loaded = await loadCommercialPackage({ directory: root, hostVersion: 'dev', publicKey });
    expect(loaded?.releaseId).toBe(releaseId);
    expect(loaded?.module.apiVersion).toBe(1);
    expect(typeof loaded?.module.register).toBe('function');
  });

  it.each([
    { hostVersion: 'another-release' },
    { hostApiVersion: 2 },
    { files: [{ path: 'backend/../../escape.mjs', sha256: 'a'.repeat(64), size: 1 }] },
    { files: [] },
  ])('rejects incompatible or invalid signed metadata before import: %j', async (patch) => {
    const { root } = await fixture(patch);
    const executeModule = vi.fn();
    await expect(
      loadCommercialPackage({ directory: root, hostVersion: 'dev', publicKey, executeModule })
    ).rejects.toThrow();
    expect(executeModule).not.toHaveBeenCalled();
  });

  it.each(['backend/index.cjs', 'frontend/app.js'])('verifies all package files before executing: %s', async (path) => {
    const { root, release } = await fixture();
    await writeFile(join(release, path), 'tampered');
    const executeModule = vi.fn();
    await expect(
      loadCommercialPackage({ directory: root, hostVersion: 'dev', publicKey, executeModule })
    ).rejects.toThrow();
    expect(executeModule).not.toHaveBeenCalled();
  });

  it('does not execute a replaced manifest even when its release pointer is updated', async () => {
    const { root } = await fixture();
    const wrongKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
    const executeModule = vi.fn();
    await expect(
      loadCommercialPackage({ directory: root, hostVersion: 'dev', publicKey: wrongKey, executeModule })
    ).rejects.toThrow();
    expect(executeModule).not.toHaveBeenCalled();
  });

  it('rejects symlinked artifacts and malformed pointers', async () => {
    const { root, release } = await fixture();
    await rm(join(release, 'frontend/app.js'));
    await symlink(join(release, 'backend/index.cjs'), join(release, 'frontend/app.js'));
    const executeModule = vi.fn();
    await expect(
      loadCommercialPackage({ directory: root, hostVersion: 'dev', publicKey, executeModule })
    ).rejects.toThrow();
    await writeFile(join(root, 'active.json'), JSON.stringify({ releaseId: '../../outside' }));
    await expect(
      loadCommercialPackage({ directory: root, hostVersion: 'dev', publicKey, executeModule })
    ).rejects.toThrow();
    expect(executeModule).not.toHaveBeenCalled();
  });

  it('rejects an installed release whose manifest no longer matches its directory', async () => {
    const { root, release } = await fixture();
    const manifest = await readFile(join(release, 'manifest.json'), 'utf8');
    await writeFile(join(release, 'manifest.json'), `${manifest}\n`);
    const executeModule = vi.fn();
    await expect(
      loadCommercialPackage({ directory: root, hostVersion: 'dev', publicKey, executeModule })
    ).rejects.toThrow('identity mismatch');
    expect(executeModule).not.toHaveBeenCalled();
  });

  it('does not re-read executable bytes after verifying their checksum', async () => {
    const { root, release } = await fixture();
    const executeModule = vi.fn(async (bytes: Buffer) => {
      await writeFile(join(release, 'backend/index.cjs'), 'throw new Error("replaced")');
      expect(bytes.toString()).toBe(code);
      return { default: { apiVersion: 1, register: () => ({}) } };
    });
    await expect(
      loadCommercialPackage({ directory: root, hostVersion: 'dev', publicKey, executeModule })
    ).resolves.toBeTruthy();
  });
});

describe('commercial package installation', () => {
  it('activates a fully verified release and can explicitly roll back without touching its files', async () => {
    const first = await fixture({ version: 'first' });
    const second = await fixture({ version: 'second' });
    const target = join(first.root, 'installed');
    const options = { directory: target, hostVersion: 'dev', publicKey };
    await installCommercialRelease({ ...options, source: first.release });
    await installCommercialRelease({ ...options, source: second.release });
    expect((await loadCommercialPackage(options))?.manifest.version).toBe('second');
    await activatePreviousCommercialRelease(options);
    expect((await loadCommercialPackage(options))?.manifest.version).toBe('first');
    expect(await readFile(join(target, 'releases', second.releaseId, 'backend/index.cjs'), 'utf8')).toBe(code);
  });

  it('leaves the active release intact when a candidate is damaged', async () => {
    const first = await fixture({ version: 'working' });
    const second = await fixture({ version: 'broken' });
    const options = { directory: join(first.root, 'installed'), hostVersion: 'dev', publicKey };
    await installCommercialRelease({ ...options, source: first.release });
    await writeFile(join(second.release, 'backend/index.cjs'), 'invalid');
    await expect(installCommercialRelease({ ...options, source: second.release })).rejects.toThrow();
    expect((await loadCommercialPackage(options))?.manifest.version).toBe('working');
  });

  it('is repeatable for the same release and rejects a concurrent installer', async () => {
    const source = await fixture();
    const options = {
      directory: join(source.root, 'installed'),
      source: source.release,
      hostVersion: 'dev',
      publicKey,
    };
    await installCommercialRelease(options);
    await expect(installCommercialRelease(options)).resolves.toMatchObject({ releaseId: source.releaseId });
    await mkdir(join(options.directory, '.install.lock'));
    await expect(installCommercialRelease(options)).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await loadCommercialPackage(options))?.releaseId).toBe(source.releaseId);
  });
});
