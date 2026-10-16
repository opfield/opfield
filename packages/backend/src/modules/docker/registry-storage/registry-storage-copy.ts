import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { registryObjectKey } from '@/foundation/registry-storage.js';
import { type RegistryS3Client, S3_SINGLE_PUT_LIMIT_BYTES } from './s3-client.js';

/**
 * Copies the registry's data between its volume and an S3 bucket. Both storage drivers keep the same layout under
 * `docker/registry/v2` (blobs by digest, then repository links), so a file copy moves every image, tag and
 * rollback image as it is. Unfinished uploads (`_uploads`) are not copied.
 */

export const REGISTRY_DATA_PATH = 'docker/registry/v2';
/** Written into the bucket folder before the copy: a retry may write into a folder Opfield filled before. */
export const REGISTRY_COPY_MARKER = 'opfield-registry.json';
const IMPORT_DIR = '.opfield-storage-import';
const PREVIOUS_DIR = '.opfield-storage-previous';
const COPY_CONCURRENCY = 4;
const BLOB_DATA_PATTERN = /^blobs\/sha256\/[a-f0-9]{2}\/([a-f0-9]{64})\/data$/;

export interface RegistryCopyResult {
  files: number;
  bytes: number;
}

export interface RegistryBucketProbe {
  /** The folder already holds registry data. */
  hasRegistryData: boolean;
  /** That data was copied by Opfield (a switch that did not finish, or an earlier S3 period). */
  copiedByOpfield: boolean;
}

/** Writes, reads back and deletes a probe object; then checks what the folder already holds. */
export async function probeRegistryBucket(
  client: RegistryS3Client,
  rootDirectory: string
): Promise<RegistryBucketProbe> {
  const key = registryObjectKey(rootDirectory, `opfield-probe-${randomUUID()}`);
  const content = Buffer.from(`Opfield registry storage probe ${new Date().toISOString()}\n`);
  await client.putObject(key, content);
  try {
    const read = await client.getObjectBuffer(key, 4096);
    if (!read.equals(content)) throw new Error(`S3 probe on ${client.describe()} read back different content`);
  } finally {
    await client.deleteObject(key);
  }
  const hasRegistryData = await client.hasObjectsUnder(registryObjectKey(rootDirectory, `${REGISTRY_DATA_PATH}/`));
  const copiedByOpfield =
    hasRegistryData && (await client.headObject(registryObjectKey(rootDirectory, REGISTRY_COPY_MARKER)));
  return { hasRegistryData, copiedByOpfield };
}

/** Bytes the registry keeps in the bucket folder: the sizes of its objects, listed page by page. */
export async function registryBucketUsedBytes(client: RegistryS3Client, rootDirectory: string): Promise<number> {
  let bytes = 0;
  for await (const entry of client.listObjects(registryObjectKey(rootDirectory, `${REGISTRY_DATA_PATH}/`))) {
    bytes += Number.isFinite(entry.size) ? entry.size : 0;
  }
  return bytes;
}

async function listFiles(root: string, relative = ''): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const files: string[] = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === '_uploads') continue;
      files.push(...(await listFiles(root, child)));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files;
}

async function fileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function runLimited<T>(items: readonly T[], worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed: unknown = null;
  const lanes = Array.from({ length: Math.min(COPY_CONCURRENCY, items.length) }, async () => {
    while (next < items.length && failed === null) {
      const item = items[next++]!;
      try {
        await worker(item);
      } catch (error) {
        failed ??= error;
      }
    }
  });
  await Promise.all(lanes);
  if (failed !== null) throw failed;
}

/**
 * Copies the volume's registry data into the bucket folder: blobs first, then the repository links, so an
 * interrupted copy leaves no repository that points at a missing layer.
 */
export async function copyVolumeToBucket(
  volumeRoot: string,
  client: RegistryS3Client,
  rootDirectory: string,
  log: (message: string) => void = () => undefined
): Promise<RegistryCopyResult> {
  const dataRoot = path.join(volumeRoot, REGISTRY_DATA_PATH);
  const files = await listFiles(dataRoot);
  const ordered = [
    ...files.filter((file) => file.startsWith('blobs/')),
    ...files.filter((file) => !file.startsWith('blobs/')),
  ];
  await client.putObject(
    registryObjectKey(rootDirectory, REGISTRY_COPY_MARKER),
    Buffer.from(`${JSON.stringify({ copiedAt: new Date().toISOString(), from: 'registry volume' })}\n`)
  );
  let copied = 0;
  let bytes = 0;
  await runLimited(ordered, async (file) => {
    const filePath = path.join(dataRoot, file);
    const { size } = await fs.stat(filePath);
    if (size > S3_SINGLE_PUT_LIMIT_BYTES) {
      throw new Error(`${file} is larger than 5 GiB, which a single S3 upload cannot take`);
    }
    // A layer's file name is its SHA-256: S3 checks the upload against it.
    const sha256 = BLOB_DATA_PATTERN.exec(file)?.[1] ?? (await fileSha256(filePath));
    await client.putObject(registryObjectKey(rootDirectory, `${REGISTRY_DATA_PATH}/${file}`), {
      stream: createReadStream(filePath),
      length: size,
      sha256,
    });
    copied += 1;
    bytes += size;
    if (copied % 500 === 0) log(`Copied ${copied} of ${ordered.length} files`);
  });
  return { files: copied, bytes };
}

function verifyingTransform(expected: string | null, label: string): Transform {
  const hash = createHash('sha256');
  return new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk as Buffer);
      callback(null, chunk);
    },
    flush(callback) {
      const actual = hash.digest('hex');
      callback(expected && actual !== expected ? new Error(`${label} does not match its digest`) : null);
    },
  });
}

/** Removes what an interrupted copy onto the volume left beside the registry data. */
export async function removeImportLeftovers(volumeRoot: string): Promise<void> {
  await fs.rm(path.join(volumeRoot, IMPORT_DIR), { recursive: true, force: true });
  await fs.rm(path.join(volumeRoot, PREVIOUS_DIR), { recursive: true, force: true });
}

/**
 * Copies the bucket folder's registry data onto the volume. It lands in a side folder first and replaces the
 * volume's registry data only when every object arrived, so a failed copy leaves the volume as it was.
 */
export async function copyBucketToVolume(
  volumeRoot: string,
  client: RegistryS3Client,
  rootDirectory: string,
  log: (message: string) => void = () => undefined
): Promise<RegistryCopyResult> {
  const importRoot = path.join(volumeRoot, IMPORT_DIR);
  const previousRoot = path.join(volumeRoot, PREVIOUS_DIR);
  await fs.rm(importRoot, { recursive: true, force: true });
  await fs.rm(previousRoot, { recursive: true, force: true });
  const prefix = registryObjectKey(rootDirectory, `${REGISTRY_DATA_PATH}/`);
  const objects: Array<{ key: string; relative: string }> = [];
  for await (const entry of client.listObjects(prefix)) {
    const relative = entry.key.slice(prefix.length);
    if (!relative || relative.endsWith('/') || relative.split('/').some((part) => part === '..' || part === ''))
      continue;
    if (relative.split('/').includes('_uploads')) continue;
    objects.push({ key: entry.key, relative });
  }
  let copied = 0;
  let bytes = 0;
  try {
    await runLimited(objects, async ({ key, relative }) => {
      const target = path.join(importRoot, REGISTRY_DATA_PATH, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const response = await client.getObject(key);
      let size = 0;
      const counter = new Transform({
        transform(chunk, _encoding, callback) {
          size += (chunk as Buffer).length;
          callback(null, chunk);
        },
      });
      await pipeline(
        response,
        verifyingTransform(BLOB_DATA_PATTERN.exec(relative)?.[1] ?? null, relative),
        counter,
        createWriteStream(target)
      );
      copied += 1;
      bytes += size;
      if (copied % 500 === 0) log(`Copied ${copied} of ${objects.length} objects`);
    });
    const current = path.join(volumeRoot, 'docker');
    const hadCurrent = await fs
      .stat(current)
      .then(() => true)
      .catch(() => false);
    await fs.mkdir(path.join(importRoot, 'docker'), { recursive: true });
    if (hadCurrent) await fs.rename(current, previousRoot);
    try {
      await fs.rename(path.join(importRoot, 'docker'), current);
    } catch (error) {
      if (hadCurrent) await fs.rename(previousRoot, current).catch(() => undefined);
      throw error;
    }
  } finally {
    await fs.rm(importRoot, { recursive: true, force: true });
  }
  await fs.rm(previousRoot, { recursive: true, force: true });
  return { files: copied, bytes };
}
