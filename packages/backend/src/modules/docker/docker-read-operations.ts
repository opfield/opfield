import { randomUUID } from 'node:crypto';
import { commandResultDataToBuffer } from '@/lib/command-result-data.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { DOCKER_LOG_TAIL_MAX } from './docker.schemas.js';

type DockerDispatchResult = { success: boolean; error?: string; detail?: string; data?: Buffer | Uint8Array | string };

export interface DockerReadOperationContext {
  nodeDispatch: NodeDispatchService;
  auditService: AuditService;
  eventBus?: EventBusService;
  parseResult(result: DockerDispatchResult): any;
}

type DockerFileChangedAction = 'created' | 'updated' | 'deleted' | 'moved';

function fileParentPath(path: string) {
  const normalized = path.replace(/\/+$/, '');
  if (!normalized || normalized === '/') return '/';
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

function publishFileChanged(
  context: DockerReadOperationContext,
  payload: {
    nodeId: string;
    containerId: string;
    action: DockerFileChangedAction;
    path: string;
    kind?: 'file' | 'directory' | 'unknown';
    fromPath?: string;
    toPath?: string;
    fromParentPath?: string;
    toParentPath?: string;
  }
) {
  context.eventBus?.publish('docker.file.changed', {
    ...payload,
    parentPath: fileParentPath(payload.path),
  });
}

export const DOCKER_FILE_READ_MAX_BYTES = 100 * 1024 * 1024;
export const DOCKER_FILE_UPLOAD_CHUNK_BYTES = 50 * 1024 * 1024;
// Daemons read up to maxBytes and stop, so asking for one extra byte tells an oversized file apart from one
// that is exactly at the limit. This works with every daemon version, no protocol change needed.
export const DOCKER_FILE_READ_REQUEST_BYTES = DOCKER_FILE_READ_MAX_BYTES + 1;

const DOCKER_FILE_TRANSFER_BASE_TIMEOUT_MS = 30_000;
// Conservative node link throughput floor (~2 Mbit/s) used to size the dispatch timeout for file payloads.
const DOCKER_FILE_TRANSFER_MIN_BYTES_PER_SECOND = 256 * 1024;
const DOCKER_FILE_TRANSFER_MAX_TIMEOUT_MS = 10 * 60 * 1000;

/** Dispatch timeout for a file command that moves `bytes` between Opfield and a node. */
export function dockerFileTransferTimeoutMs(bytes: number) {
  const transferMs = Math.ceil((Math.max(0, bytes) / DOCKER_FILE_TRANSFER_MIN_BYTES_PER_SECOND) * 1000);
  return Math.min(DOCKER_FILE_TRANSFER_BASE_TIMEOUT_MS + transferMs, DOCKER_FILE_TRANSFER_MAX_TIMEOUT_MS);
}

function contentByteLength(content: string | Buffer | undefined) {
  if (content == null) return 0;
  return Buffer.isBuffer(content) ? content.byteLength : Buffer.byteLength(content);
}

/** Rejects file reads that came back larger than the read limit instead of returning truncated content. */
export function assertDockerFileReadWithinLimit(data: Buffer) {
  if (data.byteLength > DOCKER_FILE_READ_MAX_BYTES) {
    throw new AppError(
      413,
      'FILE_TOO_LARGE',
      `File is larger than the ${DOCKER_FILE_READ_MAX_BYTES / (1024 * 1024)} MB read limit`
    );
  }
}

export interface DockerFileUploadSession {
  uploadId: string;
  nodeId: string;
  containerId: string;
  path: string;
  totalBytes: number;
  expectedOffset: number;
  userId: string;
  expiresAt: number;
}

const uploadSessions = new Map<string, DockerFileUploadSession>();
const DOCKER_FILE_UPLOAD_SESSION_TTL_MS = 30 * 60 * 1000;

/**
 * An expired session's temp file (up to the upload limit) would stay inside the container: the node is told to
 * remove it. A node that is offline then removes it on the next upload into that directory.
 */
function abortExpiredUpload(context: DockerReadOperationContext, session: DockerFileUploadSession) {
  void Promise.resolve()
    .then(() =>
      context.nodeDispatch.sendDockerFileCommand(session.nodeId, 'upload-abort', {
        containerId: session.containerId,
        path: session.uploadId,
        targetPath: session.path,
      })
    )
    .catch(() => undefined);
}

function cleanupExpiredUploadSessions(context: DockerReadOperationContext, now = Date.now()) {
  for (const [uploadId, session] of uploadSessions) {
    if (session.expiresAt <= now) {
      uploadSessions.delete(uploadId);
      abortExpiredUpload(context, session);
    }
  }
}

/** Aborts the session once it expired, also when no other upload comes to clean it up. */
function scheduleUploadSessionExpiry(context: DockerReadOperationContext, session: DockerFileUploadSession) {
  const timer = setTimeout(
    () => {
      if (uploadSessions.get(session.uploadId) !== session) return;
      if (session.expiresAt > Date.now()) {
        scheduleUploadSessionExpiry(context, session);
        return;
      }
      uploadSessions.delete(session.uploadId);
      abortExpiredUpload(context, session);
    },
    Math.max(0, session.expiresAt - Date.now()) + 1000
  );
  timer.unref?.();
}

function getUploadSession(context: DockerReadOperationContext, uploadId: string) {
  cleanupExpiredUploadSessions(context);
  const session = uploadSessions.get(uploadId);
  if (!session) {
    throw new AppError(404, 'UPLOAD_NOT_FOUND', 'Upload session not found or expired');
  }
  return session;
}

function assertUploadSessionScope(session: DockerFileUploadSession, nodeId: string, containerId: string) {
  if (session.nodeId !== nodeId || session.containerId !== containerId) {
    throw new AppError(404, 'UPLOAD_NOT_FOUND', 'Upload session not found or expired');
  }
}

export async function getContainerLogs(
  context: DockerReadOperationContext,
  nodeId: string,
  containerId: string,
  tail: number,
  timestamps: boolean
) {
  const tailLines = Math.min(Math.max(Math.trunc(tail || 100), 1), DOCKER_LOG_TAIL_MAX);
  const result = await context.nodeDispatch.sendDockerLogsCommand(nodeId, containerId, {
    tailLines,
    timestamps,
  });
  return context.parseResult(result);
}

export async function getContainerStats(context: DockerReadOperationContext, nodeId: string, containerId: string) {
  const result = await context.nodeDispatch.sendDockerContainerCommand(nodeId, 'stats', { containerId });
  return context.parseResult(result);
}

export async function getContainerTop(context: DockerReadOperationContext, nodeId: string, containerId: string) {
  const result = await context.nodeDispatch.sendDockerContainerCommand(nodeId, 'top', { containerId });
  return context.parseResult(result);
}

export async function listDirectory(
  context: DockerReadOperationContext,
  nodeId: string,
  containerId: string,
  path: string
) {
  const result = await context.nodeDispatch.sendDockerFileCommand(nodeId, 'list', { containerId, path });
  return context.parseResult(result);
}

export async function readFile(context: DockerReadOperationContext, nodeId: string, containerId: string, path: string) {
  const result = await context.nodeDispatch.sendDockerFileCommand(
    nodeId,
    'read',
    {
      containerId,
      path,
      maxBytes: DOCKER_FILE_READ_REQUEST_BYTES,
    },
    dockerFileTransferTimeoutMs(DOCKER_FILE_READ_REQUEST_BYTES)
  );
  if (!result.success) {
    return context.parseResult(result);
  }
  const data = commandResultDataToBuffer(result.data);
  if (data.byteLength === 0 && result.detail) {
    throw new AppError(
      409,
      'DOCKER_DAEMON_PROTOCOL_MISMATCH',
      'Docker daemon returned a legacy file payload. Update and restart the Docker daemon.'
    );
  }
  assertDockerFileReadWithinLimit(data);
  return data;
}

export async function writeFile(
  context: DockerReadOperationContext,
  nodeId: string,
  containerId: string,
  path: string,
  content: string | Buffer,
  userId: string
) {
  const result = await context.nodeDispatch.sendDockerFileCommand(
    nodeId,
    'write',
    {
      containerId,
      path,
      content,
    },
    dockerFileTransferTimeoutMs(contentByteLength(content))
  );
  context.parseResult(result);
  await context.auditService.log({
    action: 'docker.file.write',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, path },
  });
  publishFileChanged(context, { nodeId, containerId, action: 'updated', path, kind: 'file' });
}

export async function createFile(
  context: DockerReadOperationContext,
  nodeId: string,
  containerId: string,
  path: string,
  content: string | Buffer | undefined,
  userId: string
) {
  const result = await context.nodeDispatch.sendDockerFileCommand(
    nodeId,
    'create-file',
    {
      containerId,
      path,
      content: content ?? '',
    },
    dockerFileTransferTimeoutMs(contentByteLength(content))
  );
  context.parseResult(result);
  await context.auditService.log({
    action: 'docker.file.create',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, path },
  });
  publishFileChanged(context, { nodeId, containerId, action: 'created', path, kind: 'file' });
}

export async function initFileUpload(
  context: DockerReadOperationContext,
  nodeId: string,
  containerId: string,
  path: string,
  totalBytes: number,
  userId: string,
  uploadId = randomUUID()
) {
  cleanupExpiredUploadSessions(context);
  const result = await context.nodeDispatch.sendDockerFileCommand(nodeId, 'upload-init', {
    containerId,
    path: uploadId,
    targetPath: path,
    maxBytes: totalBytes,
  });
  context.parseResult(result);
  const session: DockerFileUploadSession = {
    uploadId,
    nodeId,
    containerId,
    path,
    totalBytes,
    expectedOffset: 0,
    userId,
    expiresAt: Date.now() + DOCKER_FILE_UPLOAD_SESSION_TTL_MS,
  };
  uploadSessions.set(uploadId, session);
  scheduleUploadSessionExpiry(context, session);
  return { uploadId, chunkSize: DOCKER_FILE_UPLOAD_CHUNK_BYTES };
}

export async function appendFileUploadChunk(
  context: DockerReadOperationContext,
  nodeId: string,
  containerId: string,
  uploadId: string,
  offset: number,
  content: Buffer
) {
  const session = getUploadSession(context, uploadId);
  assertUploadSessionScope(session, nodeId, containerId);
  if (offset !== session.expectedOffset) {
    throw new AppError(
      409,
      'UPLOAD_OFFSET_MISMATCH',
      `Unexpected upload offset: expected ${session.expectedOffset}, received ${offset}`
    );
  }
  if (content.length > DOCKER_FILE_UPLOAD_CHUNK_BYTES) {
    throw new AppError(413, 'UPLOAD_CHUNK_TOO_LARGE', 'Upload chunk is too large');
  }
  if (session.expectedOffset + content.length > session.totalBytes) {
    throw new AppError(400, 'UPLOAD_SIZE_EXCEEDED', 'Upload chunk exceeds declared file size');
  }
  const result = await context.nodeDispatch.sendDockerFileCommand(
    session.nodeId,
    'upload-chunk',
    {
      containerId: session.containerId,
      path: uploadId,
      targetPath: session.path,
      maxBytes: offset,
      content,
    },
    dockerFileTransferTimeoutMs(content.byteLength)
  );
  context.parseResult(result);
  session.expectedOffset += content.length;
  session.expiresAt = Date.now() + DOCKER_FILE_UPLOAD_SESSION_TTL_MS;
  return { receivedBytes: session.expectedOffset, totalBytes: session.totalBytes };
}

export async function completeFileUpload(
  context: DockerReadOperationContext,
  nodeId: string,
  containerId: string,
  uploadId: string,
  path: string,
  totalBytes: number
) {
  const session = getUploadSession(context, uploadId);
  assertUploadSessionScope(session, nodeId, containerId);
  if (path !== session.path || totalBytes !== session.totalBytes) {
    throw new AppError(400, 'UPLOAD_MISMATCH', 'Upload completion does not match upload session');
  }
  if (session.expectedOffset !== session.totalBytes) {
    throw new AppError(
      409,
      'UPLOAD_INCOMPLETE',
      `Upload is incomplete: received ${session.expectedOffset} of ${session.totalBytes} bytes`
    );
  }
  const result = await context.nodeDispatch.sendDockerFileCommand(session.nodeId, 'upload-complete', {
    containerId: session.containerId,
    path: uploadId,
    targetPath: session.path,
    maxBytes: totalBytes,
  });
  context.parseResult(result);
  uploadSessions.delete(uploadId);
  await context.auditService.log({
    action: 'docker.file.create',
    userId: session.userId,
    resourceType: 'docker-container',
    resourceId: session.containerId,
    details: { nodeId: session.nodeId, path: session.path },
  });
  publishFileChanged(context, {
    nodeId: session.nodeId,
    containerId: session.containerId,
    action: 'created',
    path: session.path,
    kind: 'file',
  });
}

export async function abortFileUpload(
  context: DockerReadOperationContext,
  nodeId: string,
  containerId: string,
  uploadId: string
) {
  const session = uploadSessions.get(uploadId);
  if (!session) return;
  assertUploadSessionScope(session, nodeId, containerId);
  uploadSessions.delete(uploadId);
  const result = await context.nodeDispatch.sendDockerFileCommand(session.nodeId, 'upload-abort', {
    containerId: session.containerId,
    path: uploadId,
    targetPath: session.path,
  });
  context.parseResult(result);
}

export async function createDirectory(
  context: DockerReadOperationContext,
  nodeId: string,
  containerId: string,
  path: string,
  userId: string
) {
  const result = await context.nodeDispatch.sendDockerFileCommand(nodeId, 'create-dir', {
    containerId,
    path,
  });
  context.parseResult(result);
  await context.auditService.log({
    action: 'docker.file.create_directory',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, path },
  });
  publishFileChanged(context, { nodeId, containerId, action: 'created', path, kind: 'directory' });
}

export async function deleteFile(
  context: DockerReadOperationContext,
  nodeId: string,
  containerId: string,
  path: string,
  userId: string
) {
  const result = await context.nodeDispatch.sendDockerFileCommand(nodeId, 'delete', {
    containerId,
    path,
  });
  context.parseResult(result);
  await context.auditService.log({
    action: 'docker.file.delete',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, path },
  });
  publishFileChanged(context, { nodeId, containerId, action: 'deleted', path, kind: 'unknown' });
}

export async function moveFile(
  context: DockerReadOperationContext,
  nodeId: string,
  containerId: string,
  fromPath: string,
  toPath: string,
  userId: string
) {
  const result = await context.nodeDispatch.sendDockerFileCommand(nodeId, 'move', {
    containerId,
    path: fromPath,
    targetPath: toPath,
  });
  context.parseResult(result);
  await context.auditService.log({
    action: 'docker.file.move',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, fromPath, toPath },
  });
  publishFileChanged(context, {
    nodeId,
    containerId,
    action: 'moved',
    path: toPath,
    kind: 'unknown',
    fromPath,
    toPath,
    fromParentPath: fileParentPath(fromPath),
    toParentPath: fileParentPath(toPath),
  });
}
