import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { installCommercialRelease } from './install.js';
import { sha256, verifyCommercialRelease } from './loader.js';
import { COMMERCIAL_RELEASE_ID, verifyCommercialManifest } from './manifest.js';

export type CommercialUpdateGrant =
  | { edition: 'community' }
  | { edition: 'commercial'; signedManifest: string; readFile(path: string, releaseId: string): Promise<Response> };

export interface PreparedCommercialUpdate {
  schemaVersion: 1;
  hostVersion: string;
  edition: 'community' | 'commercial';
  releaseId: string | null;
}

export function commercialVersionKey(version: string): string {
  if (!/^v?\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version)) throw new Error('Invalid commercial host version');
  return version;
}

export function commercialHostRoot(hostDir: string): string {
  return join(hostDir, '.gateway-commercial');
}

/** Runs while the old Gateway is alive. Never changes its active image/core pair. */
export async function prepareCommercialUpdate(options: {
  hostDir: string;
  hostVersion: string;
  authorize(version: string, host: { privateCoreInstalled: boolean }): Promise<CommercialUpdateGrant>;
  publicKey?: string | Buffer;
}): Promise<PreparedCommercialUpdate> {
  const version = commercialVersionKey(options.hostVersion);
  const root = commercialHostRoot(options.hostDir);
  // Authorization must precede even a cached-release lookup or download.
  const grant = await options.authorize(version, { privateCoreInstalled: await hasPrivateCore(root) });
  await ensureDirectory(root);
  await ensureDirectory(join(root, 'versions'));
  await ensureDirectory(join(root, 'prepared'));
  let staging: string | undefined;
  let releaseId: string | null = null;
  try {
    if (grant.edition === 'commercial') {
      const manifest = verifyCommercialManifest(grant.signedManifest, version, options.publicKey);
      if (manifest.files.reduce((total, file) => total + file.size, 0) > 1024 ** 3)
        throw new Error('Commercial package exceeds total size limit');
      releaseId = sha256(Buffer.from(grant.signedManifest));
      const versionDirectory = join(root, 'versions', version);
      await ensureDirectory(versionDirectory);
      const existing = await readExistingVersion(versionDirectory);
      if (existing && existing !== releaseId)
        throw new Error('An Opfield version cannot be rebound to a different private core');
      if (existing) {
        const cached = await verifyCommercialRelease(
          join(versionDirectory, 'releases', existing),
          version,
          options.publicKey
        );
        if (cached.releaseId !== releaseId) throw new Error('Cached private core verification failed');
      } else {
        staging = await mkdtemp(join(root, '.download-'));
        await writeFile(join(staging, 'manifest.json'), grant.signedManifest, { mode: 0o600, flag: 'wx' });
        for (const artifact of manifest.files) {
          const response = await grant.readFile(artifact.path, releaseId);
          if (!response.ok || !response.body) throw new Error('Commercial artifact download failed');
          const file = join(staging, artifact.path);
          await mkdir(dirname(file), { recursive: true, mode: 0o700 });
          const handle = await open(file, 'wx', 0o600);
          const reader = response.body.getReader();
          let size = 0;
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              size += chunk.value.byteLength;
              if (size > artifact.size) throw new Error('Commercial artifact exceeds signed size');
              await handle.writeFile(chunk.value);
            }
            if (size !== artifact.size) throw new Error('Commercial artifact is incomplete');
          } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
            await handle.close();
          }
        }
        // Full signature/hash/size verification without importing candidate code.
        const installed = await installCommercialRelease({
          source: staging,
          directory: versionDirectory,
          hostVersion: version,
          publicKey: options.publicKey,
        });
        if (installed.releaseId !== releaseId) throw new Error('Prepared commercial release identity mismatch');
      }
    }
    const prepared: PreparedCommercialUpdate = {
      schemaVersion: 1,
      hostVersion: version,
      edition: grant.edition,
      releaseId,
    };
    const target = join(root, 'prepared', `${version}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(prepared)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    return prepared;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

/** Foundation migration is network-free and accepts only a complete local pair. */
export async function readPreparedCommercialUpdate(
  hostDir: string,
  hostVersion: string,
  publicKey?: string | Buffer
): Promise<PreparedCommercialUpdate> {
  const version = commercialVersionKey(hostVersion);
  const root = commercialHostRoot(hostDir);
  const file = join(root, 'prepared', `${version}.json`);
  if (!(await lstat(file)).isFile()) throw new Error('Prepared commercial receipt must be a regular file');
  const prepared = JSON.parse(await readFile(file, 'utf8')) as PreparedCommercialUpdate;
  if (
    prepared.schemaVersion !== 1 ||
    prepared.hostVersion !== version ||
    !['community', 'commercial'].includes(prepared.edition)
  )
    throw new Error('Invalid prepared commercial receipt');
  if (prepared.edition === 'community') {
    if (prepared.releaseId !== null) throw new Error('Invalid Community receipt');
  } else {
    if (!prepared.releaseId || !COMMERCIAL_RELEASE_ID.test(prepared.releaseId))
      throw new Error('Invalid prepared core identity');
    const directory = join(root, 'versions', version);
    const activePath = join(directory, 'active.json');
    if (!(await lstat(activePath)).isFile()) throw new Error('Invalid prepared core pointer');
    const active = JSON.parse(await readFile(activePath, 'utf8'));
    if (active.releaseId !== prepared.releaseId) throw new Error('Prepared core changed before migration');
    const verified = await verifyCommercialRelease(join(directory, 'releases', prepared.releaseId), version, publicKey);
    if (verified.releaseId !== prepared.releaseId) throw new Error('Prepared core verification failed');
  }
  return prepared;
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) throw new Error('Commercial update directory must not be a symlink');
}

/** Any version pointer means this host ran or prepared a private core; an unreadable one counts too. */
async function hasPrivateCore(root: string): Promise<boolean> {
  let versions: Dirent[];
  try {
    versions = await readdir(join(root, 'versions'), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  for (const version of versions) {
    if (!version.isDirectory()) continue;
    if (await readExistingVersion(join(root, 'versions', version.name)).catch(() => 'unreadable')) return true;
  }
  return false;
}

async function readExistingVersion(directory: string): Promise<string | null> {
  const file = join(directory, 'active.json');
  let stat: import('node:fs').Stats;
  try {
    stat = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.size > 4096) throw new Error('Invalid existing version pointer');
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (typeof value.releaseId !== 'string' || !COMMERCIAL_RELEASE_ID.test(value.releaseId))
    throw new Error('Invalid existing version pointer');
  return value.releaseId;
}
