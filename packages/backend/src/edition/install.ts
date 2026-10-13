import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { verifyCommercialRelease } from './loader.js';
import { COMMERCIAL_RELEASE_ID } from './manifest.js';

/** Stage and verify the complete package before changing the active pointer.
 * Activation takes effect on restart; this does not execute migrations or restart Opfield.
 */
export async function installCommercialRelease(options: {
  source: string;
  directory: string;
  hostVersion: string;
  publicKey?: string | Buffer;
}): Promise<{ releaseId: string; previousReleaseId: string | null; restartRequired: true }> {
  const root = resolve(options.directory);
  await mkdir(root, { recursive: true });
  if (!(await lstat(root)).isDirectory()) throw new Error('Commercial installation root must be a real directory');
  const lock = join(root, '.install.lock');
  await mkdir(lock); // Concurrent installers must not overwrite each other's pointers.
  let staging: string | undefined;
  try {
    const candidate = await verifyCommercialRelease(resolve(options.source), options.hostVersion, options.publicKey);
    const releases = join(root, 'releases');
    await mkdir(releases, { recursive: true });
    if (!(await lstat(releases)).isDirectory()) throw new Error('Commercial releases must be a real directory');
    staging = await mkdtemp(join(releases, '.staged-'));
    await copyFile(join(options.source, 'manifest.json'), join(staging, 'manifest.json'));
    for (const file of candidate.manifest.files) {
      const target = join(staging, file.path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(options.source, file.path), target);
    }
    const staged = await verifyCommercialRelease(staging, options.hostVersion, options.publicKey);
    if (staged.releaseId !== candidate.releaseId) throw new Error('Commercial package changed during installation');
    const destination = join(releases, candidate.releaseId);
    try {
      await rename(staging, destination);
      staging = undefined;
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      const installed = await verifyCommercialRelease(destination, options.hostVersion, options.publicKey);
      if (installed.releaseId !== candidate.releaseId) throw new Error('Existing commercial release is corrupt');
    }
    const previousReleaseId = await readPointer(root, 'active.json');
    if (previousReleaseId !== candidate.releaseId) {
      if (previousReleaseId) await writePointer(root, 'previous.json', previousReleaseId);
      await writePointer(root, 'active.json', candidate.releaseId);
    }
    return { releaseId: candidate.releaseId, previousReleaseId, restartRequired: true };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true });
  }
}

/** Explicit rollback only; no database/schema rollback or deletion of releases. */
export async function activatePreviousCommercialRelease(options: {
  directory: string;
  hostVersion: string;
  publicKey?: string | Buffer;
}): Promise<{ releaseId: string; restartRequired: true }> {
  const root = resolve(options.directory);
  const previous = await readPointer(root, 'previous.json');
  if (!previous) throw new Error('No previous commercial release is available');
  const result = await installCommercialRelease({ ...options, source: join(root, 'releases', previous) });
  return { releaseId: result.releaseId, restartRequired: true };
}

async function readPointer(root: string, name: string): Promise<string | null> {
  let json: string;
  try {
    const path = join(root, name);
    if (!(await lstat(path)).isFile()) throw new Error('Commercial release pointer must be a regular file');
    json = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const value = JSON.parse(json);
  if (!value || typeof value.releaseId !== 'string' || !COMMERCIAL_RELEASE_ID.test(value.releaseId)) {
    throw new Error('Commercial release pointer is invalid');
  }
  return value.releaseId;
}

async function writePointer(root: string, name: string, releaseId: string): Promise<void> {
  const staging = join(root, `.${name}-${randomUUID()}`);
  try {
    await writeFile(staging, `${JSON.stringify({ releaseId })}\n`, { flag: 'wx', mode: 0o600 });
    await rename(staging, join(root, name));
  } finally {
    await rm(staging, { force: true });
  }
}
