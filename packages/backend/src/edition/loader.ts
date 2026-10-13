import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { compileFunction } from 'node:vm';
import type { CommercialModule } from './contract.js';
import { COMMERCIAL_HOST_API_VERSION } from './contract.js';
import {
  COMMERCIAL_MANIFEST_MAX_BYTES,
  COMMERCIAL_RELEASE_ID,
  type CommercialManifest,
  verifyCommercialManifest,
} from './manifest.js';

export interface LoadedCommercialPackage {
  manifest: CommercialManifest;
  releaseId: string;
  releaseDirectory: string;
  module: CommercialModule;
}

/** Also used by the installer preflight; never imports or runs candidate code. */
export async function verifyCommercialRelease(directory: string, hostVersion: string, publicKey?: string | Buffer) {
  await assertDirectory(directory);
  const signed = await readRegularFile(join(directory, 'manifest.json'), COMMERCIAL_MANIFEST_MAX_BYTES);
  const manifest = verifyCommercialManifest(signed.toString('utf8'), hostVersion, publicKey);
  let backend: Buffer | undefined;
  for (const file of manifest.files) {
    const parts = file.path.split('/');
    for (let count = 1; count < parts.length; count++) await assertDirectory(join(directory, ...parts.slice(0, count)));
    const bytes = await verifyArtifactFile(
      join(directory, file.path),
      file.size,
      file.sha256,
      file.path === manifest.backendEntry
    );
    if (bytes) backend = bytes;
  }
  if (!backend) throw new Error('Commercial backend is missing');
  return { manifest, releaseId: sha256(signed), backend };
}

export async function loadCommercialPackage(options: {
  directory: string;
  hostVersion: string;
  /** Test-only injection. Production bootstrap always uses the built-in update trust key. */
  publicKey?: string | Buffer;
  executeModule?: (bytes: Buffer, filename: string, releaseId: string) => unknown | Promise<unknown>;
}): Promise<LoadedCommercialPackage | null> {
  const root = resolve(options.directory);
  let pointer: Buffer;
  try {
    await assertDirectory(root);
    pointer = await readRegularFile(join(root, 'active.json'), 4096);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const active: unknown = JSON.parse(pointer.toString('utf8'));
  if (
    !active ||
    typeof active !== 'object' ||
    Object.keys(active).length !== 1 ||
    !('releaseId' in active) ||
    typeof active.releaseId !== 'string' ||
    !COMMERCIAL_RELEASE_ID.test(active.releaseId)
  ) {
    throw new Error('Commercial release pointer is invalid');
  }
  await assertDirectory(join(root, 'releases'));
  const directory = join(root, 'releases', active.releaseId);
  const verified = await verifyCommercialRelease(directory, options.hostVersion, options.publicKey);
  if (verified.releaseId !== active.releaseId) throw new Error('Commercial release identity mismatch');
  // Execute the verified bytes with a short diagnostic filename. data: imports
  // leak their entire encoded source in error stacks, including customer logs.
  const loaded = await (options.executeModule ?? executeVerifiedModule)(
    verified.backend,
    join(directory, verified.manifest.backendEntry),
    verified.releaseId
  );
  const module = (loaded as { default?: unknown } | null)?.default as CommercialModule | undefined;
  if (!module || module.apiVersion !== COMMERCIAL_HOST_API_VERSION || typeof module.register !== 'function') {
    throw new Error('Commercial module does not implement the host API');
  }
  return { manifest: verified.manifest, releaseId: verified.releaseId, releaseDirectory: directory, module };
}

function executeVerifiedModule(bytes: Buffer, filename: string, releaseId: string): unknown {
  const module = { exports: {} as unknown };
  const hostRequire = createRequire(filename);
  const requireBuiltin = (specifier: string) => {
    if (!isBuiltin(specifier)) throw new Error('Commercial module requested an unbundled dependency');
    return hostRequire(specifier);
  };
  // This is not a sandbox: only the already signature-verified first-party
  // package reaches this point. Shared host objects arrive through register().
  try {
    const evaluate = compileFunction(
      bytes.toString('utf8'),
      ['exports', 'require', 'module', '__filename', '__dirname'],
      {
        filename: `opfield-commercial/${releaseId}/backend/index.cjs`,
      }
    );
    evaluate(module.exports, requireBuiltin, module, filename, dirname(filename));
  } catch {
    // SyntaxError stacks may contain an entire minified source line. Never pass
    // that object/cause to the ordinary application logger or public APIs.
    throw new Error('Commercial backend initialization failed');
  }
  return module.exports;
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function assertDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Commercial paths must be real directories');
}

async function verifyArtifactFile(path: string, expectedSize: number, expectedHash: string, capture: boolean) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== expectedSize) throw new Error('Commercial artifact size or type mismatch');
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, total);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > expectedSize) throw new Error('Commercial artifact grew during verification');
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (capture) chunks.push(Buffer.from(chunk));
    }
    if (total !== expectedSize || hash.digest('hex') !== expectedHash)
      throw new Error('Commercial artifact checksum mismatch');
    return capture ? Buffer.concat(chunks) : undefined;
  } finally {
    await file.close();
  }
}

async function readRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Commercial artifact type or size is invalid');
    // Read a bounded snapshot, even if a file is concurrently replaced/grown.
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('Commercial artifact changed during verification');
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}
