import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { hasScopeBase } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  ContainerArchiveImportQuerySchema,
  ContainerArchiveResolutionSchema,
} from '@/modules/docker/docker.schemas.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import { importDockerContainerArchive } from '@/modules/docker/docker-container-archive-operations.js';
import { assertDockerCreationAccess } from '@/modules/docker/docker-creation-access.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { assertNodeAllowsServiceCreation } from '@/modules/nodes/service-creation-lock.js';
import type { User } from '@/types.js';
import {
  type DockerArchiveExportAccess,
  holdsDockerArchiveExportAccess,
  type OpenedDockerArchive,
  prepareDockerArchiveExport,
} from './ai.docker-archive-export.js';
import { requiredToolString } from './ai.docker-tool-access.js';

/**
 * MCP carries container and volume archives in bounded base64 chunks. Bytes
 * are spooled privately on Opfield; only a verified spool reaches the
 * shared import/export operations the REST routes use. Files larger than a
 * few chunks go through one-time links instead (ai.docker-archive-link.ts).
 */

export const DOCKER_ARCHIVE_TRANSFER_CHUNK_BYTES = 1024 * 1024;
const SESSION_TTL_MS = 60 * 60 * 1000;
export const ARCHIVE_MAX_BYTES = 32 * 1024 ** 3;
/** Disk budget shared by upload reservations and bytes already spooled for downloads. */
const SPOOL_BYTES_MAX = 64 * 1024 ** 3;
const ACTIVE_SESSIONS_MAX = 16;
const ACTIVE_SESSIONS_PER_USER_MAX = 4;
const RESOLUTION_JSON_MAX_BYTES = 32 * 1024;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SPOOL_FILE = 'archive';
/** A spool directory no session owns is removed once it was not written for this long (sessions expire after 1 h). */
const ORPHANED_SPOOL_AGE_MS = 2 * SESSION_TTL_MS;
const PROCESS_STARTED_AT = Date.now();
const USE_LINK = 'to send a file from disk, use operation "link" and stream it with curl';

export const UploadBeginSchema = z.object({
  nodeId: z.string().uuid(),
  name: ContainerArchiveImportQuerySchema.shape.name,
  folderId: ContainerArchiveImportQuerySchema.shape.folderId,
  resolution: ContainerArchiveResolutionSchema.default({}),
  declaredSizeBytes: z.number().int().min(1).max(ARCHIVE_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

type UploadState = 'open' | 'finalizing' | 'completed' | 'aborted';
type DownloadState = 'preparing' | 'ready' | 'failed';

interface UploadSession {
  id: string;
  userId: string;
  nodeId: string;
  name: string;
  folderId?: string;
  resolution: z.infer<typeof ContainerArchiveResolutionSchema>;
  declaredSizeBytes: number;
  sha256: string;
  directory: string | null;
  offset: number;
  expiresAt: number;
  state: UploadState;
  result?: { containerId: string; containerName: string; imageId: string };
}

interface DownloadSession {
  id: string;
  userId: string;
  access: DockerArchiveExportAccess;
  filename: string;
  directory: string;
  state: DownloadState;
  sizeBytes: number;
  sha256: string | null;
  error: { code: string; message: string } | null;
  expiresAt: number;
  abort: AbortController;
}

function transferNotFound(): AppError {
  // Transfer IDs never grant access; a foreign ID looks like a missing one.
  return new AppError(404, 'DOCKER_ARCHIVE_TRANSFER_NOT_FOUND', 'Archive transfer session not found');
}

function decodeChunk(value: unknown): Buffer {
  if (typeof value !== 'string' || !CANONICAL_BASE64.test(value)) {
    throw new AppError(400, 'DOCKER_ARCHIVE_CHUNK_INVALID', `Chunk must use canonical base64 encoding; ${USE_LINK}`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength > DOCKER_ARCHIVE_TRANSFER_CHUNK_BYTES) {
    throw new AppError(400, 'DOCKER_ARCHIVE_CHUNK_INVALID', `Chunk must contain 1 byte to 1 MiB; ${USE_LINK}`);
  }
  return bytes;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new AppError(400, 'INVALID_AI_TOOL_ARGUMENT', `${name} must be a non-negative integer`);
  }
  return value;
}

export function assertArchiveResolutionSize(resolution: z.infer<typeof ContainerArchiveResolutionSchema>) {
  if (Buffer.byteLength(JSON.stringify(resolution), 'utf8') > RESOLUTION_JSON_MAX_BYTES) {
    throw new AppError(400, 'OFCA_RESOLUTION_INVALID', 'Archive import resolution is invalid');
  }
}

/** POST /containers/archive entry checks: create scope, license, destination access and node creation lock. */
export async function assertArchiveImportAccess(user: User, nodeId: string, folderId: string | undefined) {
  if (!hasScopeBase(user.scopes, 'docker:containers:create')) {
    throw new AppError(403, 'FORBIDDEN', 'Missing required scope: docker:containers:create');
  }
  // LICENSE ENFORCEMENT: Archive operations are Personal entitlements under the project license/TOS.
  await container.resolve(LicensePolicyService).requireFeature('container-export');
  const db = container.resolve<DrizzleClient>(TOKENS.DrizzleClient);
  await assertDockerCreationAccess(db, user.scopes, 'docker:containers:create', nodeId, folderId);
  await assertNodeAllowsServiceCreation(db, nodeId, 'docker');
}

export class DockerArchiveTransferStore {
  private readonly uploads = new Map<string, UploadSession>();
  private readonly downloads = new Map<string, DownloadSession>();
  private readonly busy = new Set<string>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly root = join(tmpdir(), 'opfield-docker-archive-mcp')) {}

  async upload(user: User, args: Record<string, unknown>) {
    const operation = z.enum(['begin', 'chunk', 'status', 'finalize', 'abort']).parse(args.operation);
    if (operation === 'begin') return this.beginUpload(user, UploadBeginSchema.parse(args));
    const session = this.uploads.get(requiredToolString(args.uploadId, 'uploadId'));
    if (!session || session.userId !== user.id) throw transferNotFound();
    if (!hasScopeBase(user.scopes, 'docker:containers:create')) throw transferNotFound();
    return this.withSession(session.id, async () => {
      if (operation === 'status') return this.uploadView(session);
      if (operation === 'abort') {
        if (session.state === 'completed') {
          throw new AppError(409, 'DOCKER_ARCHIVE_IMPORT_COMPLETED', 'The archive was already imported');
        }
        session.state = 'aborted';
        await this.removeUploadSpool(session);
        this.uploads.delete(session.id);
        return this.uploadView(session);
      }
      if (operation === 'finalize' && session.state === 'completed') return this.uploadView(session);
      if (session.state !== 'open' || !session.directory) {
        throw new AppError(409, 'DOCKER_ARCHIVE_UPLOAD_NOT_OPEN', 'Archive upload is not open');
      }
      if (session.expiresAt <= Date.now()) {
        await this.removeUploadSpool(session);
        this.uploads.delete(session.id);
        throw new AppError(410, 'DOCKER_ARCHIVE_UPLOAD_EXPIRED', 'Archive upload expired; begin a new upload');
      }
      session.expiresAt = Date.now() + SESSION_TTL_MS;
      if (operation === 'chunk') return this.appendUpload(session, args);
      return this.finalizeUpload(user, session);
    });
  }

  async download(dockerService: DockerManagementService, user: User, args: Record<string, unknown>) {
    const operation = z.enum(['begin', 'status', 'chunk', 'close']).parse(args.operation);
    if (operation === 'begin') return this.beginDownload(dockerService, user, args);
    const session = this.downloads.get(requiredToolString(args.downloadId, 'downloadId'));
    if (!session || session.userId !== user.id) throw transferNotFound();
    if (!holdsDockerArchiveExportAccess(user, session.access)) throw transferNotFound();
    return this.withSession(session.id, async () => {
      if (operation === 'status') return this.downloadView(session);
      if (operation === 'close') {
        this.downloads.delete(session.id);
        session.abort.abort();
        await rm(session.directory, { recursive: true, force: true });
        return { ...this.downloadView(session), status: 'closed' };
      }
      if (session.state !== 'ready') {
        throw new AppError(409, 'DOCKER_ARCHIVE_NOT_READY', `Archive is ${session.state}; poll status until ready`);
      }
      session.expiresAt = Date.now() + SESSION_TTL_MS;
      return this.readDownloadChunk(session, args);
    });
  }

  dispose() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  private async withSession<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) {
      throw new AppError(409, 'DOCKER_ARCHIVE_TRANSFER_BUSY', 'Another call for this archive transfer is in progress');
    }
    this.busy.add(id);
    try {
      return await operation();
    } finally {
      this.busy.delete(id);
    }
  }

  private reserveSlot(userId: string, uploadBytes = 0) {
    const active = [
      ...[...this.uploads.values()].filter((session) => session.directory !== null),
      ...this.downloads.values(),
    ];
    const spooled = this.spooledBytes();
    if (
      active.length >= ACTIVE_SESSIONS_MAX ||
      active.filter((session) => session.userId === userId).length >= ACTIVE_SESSIONS_PER_USER_MAX ||
      (uploadBytes > 0 ? spooled + uploadBytes > SPOOL_BYTES_MAX : spooled >= SPOOL_BYTES_MAX)
    ) {
      throw new AppError(
        429,
        'DOCKER_ARCHIVE_TRANSFER_CAPACITY',
        'Too many archive transfers in progress; finish or abort unused transfers'
      );
    }
  }

  /** Upload reservations plus the bytes downloads have written so far. */
  private spooledBytes(): number {
    const uploads = [...this.uploads.values()]
      .filter((session) => session.directory !== null)
      .reduce((total, session) => total + session.declaredSizeBytes, 0);
    const downloads = [...this.downloads.values()].reduce((total, session) => total + session.sizeBytes, 0);
    return uploads + downloads;
  }

  private assertSpoolCapacity(extraBytes: number) {
    if (this.spooledBytes() + extraBytes > SPOOL_BYTES_MAX) {
      throw new AppError(
        507,
        'DOCKER_ARCHIVE_TRANSFER_SPOOL_FULL',
        'The Opfield archive transfer spool is full; finish or abort other transfers and retry'
      );
    }
  }

  private async createSpoolDirectory() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.startSweep();
    return mkdtemp(join(this.root, 'transfer-'));
  }

  private async beginUpload(user: User, input: z.infer<typeof UploadBeginSchema>) {
    assertArchiveResolutionSize(input.resolution);
    await assertArchiveImportAccess(user, input.nodeId, input.folderId);
    this.reserveSlot(user.id, input.declaredSizeBytes);
    const session: UploadSession = {
      id: randomUUID(),
      userId: user.id,
      nodeId: input.nodeId,
      name: input.name,
      folderId: input.folderId,
      resolution: input.resolution,
      declaredSizeBytes: input.declaredSizeBytes,
      sha256: input.sha256,
      directory: '',
      offset: 0,
      expiresAt: Date.now() + SESSION_TTL_MS,
      state: 'open',
    };
    this.uploads.set(session.id, session);
    try {
      session.directory = await this.createSpoolDirectory();
      const file = await open(join(session.directory, SPOOL_FILE), 'wx', 0o600);
      await file.close();
    } catch (error) {
      await this.removeUploadSpool(session);
      this.uploads.delete(session.id);
      throw error;
    }
    return this.uploadView(session);
  }

  private async appendUpload(session: UploadSession, args: Record<string, unknown>) {
    const offset = nonNegativeInteger(args.offset, 'offset');
    const bytes = decodeChunk(args.contentBase64);
    if (offset !== session.offset) {
      throw new AppError(409, 'DOCKER_ARCHIVE_OFFSET_MISMATCH', 'Upload offset does not match', {
        expectedOffset: session.offset,
      });
    }
    if (offset + bytes.byteLength > session.declaredSizeBytes) {
      throw new AppError(400, 'DOCKER_ARCHIVE_SIZE_EXCEEDED', 'Chunk exceeds the declared archive size');
    }
    const file = await open(join(session.directory!, SPOOL_FILE), 'r+');
    try {
      let written = 0;
      while (written < bytes.byteLength) {
        const result = await file.write(bytes, written, bytes.byteLength - written, offset + written);
        if (result.bytesWritten === 0) throw new Error('Archive spool write made no progress');
        written += result.bytesWritten;
      }
      await file.sync();
      session.offset += bytes.byteLength;
    } catch (error) {
      await file.truncate(offset);
      throw error;
    } finally {
      await file.close();
    }
    return this.uploadView(session);
  }

  private async finalizeUpload(user: User, session: UploadSession) {
    if (session.offset !== session.declaredSizeBytes) {
      throw new AppError(409, 'DOCKER_ARCHIVE_UPLOAD_INCOMPLETE', 'Archive upload is incomplete', {
        expectedOffset: session.offset,
      });
    }
    const path = join(session.directory!, SPOOL_FILE);
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    if (hash.digest('hex') !== session.sha256) {
      throw new AppError(400, 'DOCKER_ARCHIVE_HASH_MISMATCH', 'Archive SHA-256 does not match');
    }
    // Access is re-checked with the caller's current grants before anything reaches the node.
    await assertArchiveImportAccess(user, session.nodeId, session.folderId);
    session.state = 'finalizing';
    const body = createReadStream(path);
    try {
      session.result = await importDockerContainerArchive({
        nodeId: session.nodeId,
        name: session.name,
        folderId: session.folderId,
        resolution: session.resolution,
        body: Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>,
        actorScopes: user.scopes,
        userId: user.id,
      });
    } catch (error) {
      // The import rolls back its own partial state; the verified spool stays for a retry until it expires.
      session.state = 'open';
      throw error;
    } finally {
      body.destroy();
    }
    session.state = 'completed';
    await this.removeUploadSpool(session).catch(() => undefined);
    return this.uploadView(session);
  }

  private async beginDownload(dockerService: DockerManagementService, user: User, args: Record<string, unknown>) {
    const { access, open: openArchive } = await prepareDockerArchiveExport(dockerService, user, args);
    this.reserveSlot(user.id);
    const session: DownloadSession = {
      id: randomUUID(),
      userId: user.id,
      access,
      filename: '',
      directory: '',
      state: 'preparing',
      sizeBytes: 0,
      sha256: null,
      error: null,
      expiresAt: Date.now() + SESSION_TTL_MS,
      abort: new AbortController(),
    };
    this.downloads.set(session.id, session);
    let opened: OpenedDockerArchive;
    try {
      session.directory = await this.createSpoolDirectory();
      opened = await openArchive();
    } catch (error) {
      this.downloads.delete(session.id);
      if (session.directory) await rm(session.directory, { recursive: true, force: true });
      throw error;
    }
    session.filename = opened.filename;
    void this.spoolDownload(session, opened.source);
    return this.downloadView(session);
  }

  private async spoolDownload(session: DownloadSession, source: OpenedDockerArchive['source']): Promise<void> {
    const path = join(session.directory, SPOOL_FILE);
    const hash = createHash('sha256');
    let size = 0;
    try {
      const data = await source();
      if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
        const bytes = Buffer.from(data);
        if (bytes.byteLength > ARCHIVE_MAX_BYTES) {
          throw new AppError(413, 'DOCKER_ARCHIVE_TOO_LARGE', 'Archive exceeds the MCP transfer limit');
        }
        this.assertSpoolCapacity(bytes.byteLength);
        await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
        hash.update(bytes);
        size = bytes.byteLength;
      } else {
        const assertSpoolCapacity = (extraBytes: number) => this.assertSpoolCapacity(extraBytes);
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.byteLength;
            if (size > ARCHIVE_MAX_BYTES) {
              callback(new AppError(413, 'DOCKER_ARCHIVE_TOO_LARGE', 'Archive exceeds the MCP transfer limit'));
              return;
            }
            try {
              assertSpoolCapacity(chunk.byteLength);
            } catch (error) {
              callback(error as Error);
              return;
            }
            // Counted while spooling so concurrent transfers see the bytes already on disk.
            session.sizeBytes = size;
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(data as Parameters<typeof Readable.fromWeb>[0]),
          meter,
          createWriteStream(path, { mode: 0o600, flags: 'wx' }),
          { signal: session.abort.signal }
        );
      }
      session.sizeBytes = size;
      session.sha256 = hash.digest('hex');
      session.state = 'ready';
    } catch (error) {
      session.state = 'failed';
      session.sizeBytes = 0;
      session.error =
        error instanceof AppError
          ? { code: error.code, message: error.message }
          : { code: 'DOCKER_ARCHIVE_EXPORT_FAILED', message: 'Archive export failed' };
      await rm(path, { force: true }).catch(() => undefined);
    }
    if (!this.downloads.has(session.id)) await rm(session.directory, { recursive: true, force: true });
  }

  private async readDownloadChunk(session: DownloadSession, args: Record<string, unknown>) {
    const offset = nonNegativeInteger(args.offset ?? 0, 'offset');
    const requested = args.length === undefined ? DOCKER_ARCHIVE_TRANSFER_CHUNK_BYTES : args.length;
    const length = Math.min(nonNegativeInteger(requested, 'length'), DOCKER_ARCHIVE_TRANSFER_CHUNK_BYTES);
    if (offset > session.sizeBytes) {
      throw new AppError(400, 'DOCKER_ARCHIVE_OFFSET_INVALID', 'Offset is beyond the end of the archive');
    }
    const buffer = Buffer.alloc(Math.min(length, session.sizeBytes - offset));
    const file = await open(join(session.directory, SPOOL_FILE), 'r');
    let bytesRead = 0;
    try {
      while (bytesRead < buffer.byteLength) {
        const result = await file.read(buffer, bytesRead, buffer.byteLength - bytesRead, offset + bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
    } finally {
      await file.close();
    }
    return {
      downloadId: session.id,
      offset,
      bytes: bytesRead,
      nextOffset: offset + bytesRead,
      eof: offset + bytesRead >= session.sizeBytes,
      sizeBytes: session.sizeBytes,
      sha256: session.sha256,
      contentBase64: buffer.subarray(0, bytesRead).toString('base64'),
    };
  }

  private uploadView(session: UploadSession) {
    return {
      uploadId: session.id,
      nodeId: session.nodeId,
      name: session.name,
      offset: session.offset,
      declaredSizeBytes: session.declaredSizeBytes,
      status: session.state,
      expiresAt: new Date(session.expiresAt).toISOString(),
      maxChunkBytes: DOCKER_ARCHIVE_TRANSFER_CHUNK_BYTES,
      ...(session.result ? { container: session.result } : {}),
    };
  }

  private downloadView(session: DownloadSession) {
    return {
      downloadId: session.id,
      kind: session.access.kind,
      nodeId: session.access.nodeId,
      filename: session.filename,
      status: session.state,
      sizeBytes: session.state === 'ready' ? session.sizeBytes : null,
      sha256: session.sha256,
      error: session.error,
      expiresAt: new Date(session.expiresAt).toISOString(),
      maxChunkBytes: DOCKER_ARCHIVE_TRANSFER_CHUNK_BYTES,
    };
  }

  private async removeUploadSpool(session: UploadSession) {
    if (!session.directory) {
      session.directory = null;
      return;
    }
    const directory = session.directory;
    session.directory = null;
    await rm(directory, { recursive: true, force: true });
  }

  private startSweep() {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch(() => undefined);
    }, 60_000);
    this.sweepTimer.unref?.();
  }

  async sweep(now = Date.now()) {
    for (const session of [...this.uploads.values()]) {
      if (this.busy.has(session.id) || session.expiresAt > now) continue;
      this.uploads.delete(session.id);
      await this.removeUploadSpool(session);
    }
    for (const session of [...this.downloads.values()]) {
      if (this.busy.has(session.id) || session.expiresAt > now) continue;
      this.downloads.delete(session.id);
      session.abort.abort();
      await rm(session.directory, { recursive: true, force: true });
    }
    if (this.uploads.size === 0 && this.downloads.size === 0) this.dispose();
  }

  /**
   * Spool directories no live session owns: sessions live in memory, so a restart or crash during a transfer left
   * their bytes (up to 32 GiB each) in the spool for good. Removes `transfer-*` directories of no current session that
   * were last written more than ORPHANED_SPOOL_AGE_MS ago. Returns what was removed.
   */
  async sweepOrphanedSpools(now = Date.now()): Promise<{ removed: number; bytes: number }> {
    const owned = new Set<string>();
    for (const session of this.uploads.values()) if (session.directory) owned.add(session.directory);
    for (const session of this.downloads.values()) owned.add(session.directory);
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return { removed: 0, bytes: 0 };
    }
    let removed = 0;
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.startsWith('transfer-')) continue;
      const directory = join(this.root, entry);
      if (owned.has(directory)) continue;
      try {
        const info = await stat(directory);
        const file = await stat(join(directory, SPOOL_FILE)).catch(() => null);
        const lastWrite = Math.max(info.mtimeMs, file?.mtimeMs ?? 0);
        // This process wrote nothing before it started: anything older belongs to a session it never had.
        if (!info.isDirectory() || (lastWrite >= PROCESS_STARTED_AT && now - lastWrite < ORPHANED_SPOOL_AGE_MS))
          continue;
        bytes += file?.size ?? 0;
        await rm(directory, { recursive: true, force: true });
        removed += 1;
      } catch {
        // Gone already, or unreadable: the next sweep tries again.
      }
    }
    return { removed, bytes };
  }
}

let defaultStore: DockerArchiveTransferStore | undefined;

export function dockerArchiveTransferStore(): DockerArchiveTransferStore {
  defaultStore ??= new DockerArchiveTransferStore();
  return defaultStore;
}
