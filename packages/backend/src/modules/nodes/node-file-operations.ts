import { randomUUID } from 'node:crypto';
import { commandResultDataToBuffer } from '@/lib/command-result-data.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import {
  assertDockerFileReadWithinLimit,
  DOCKER_FILE_READ_REQUEST_BYTES,
  DOCKER_FILE_UPLOAD_CHUNK_BYTES,
  dockerFileTransferTimeoutMs,
} from '@/modules/docker/docker-read-operations.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';

type NodeDispatchResult = { success: boolean; error?: string; detail?: string; data?: Buffer | Uint8Array | string };

export interface NodeFileOperationContext {
  nodeDispatch: NodeDispatchService;
  auditService: AuditService;
  eventBus?: EventBusService;
  parseResult(result: NodeDispatchResult): any;
}

type NodeFileChangedAction = 'created' | 'updated' | 'deleted' | 'moved';

interface NodeFileUploadSession {
  uploadId: string;
  nodeId: string;
  path: string;
  totalBytes: number;
  expectedOffset: number;
  userId: string;
  expiresAt: number;
}

function contentByteLength(content: string | Buffer | undefined) {
  if (content == null) return 0;
  return Buffer.isBuffer(content) ? content.byteLength : Buffer.byteLength(content);
}

const uploadSessions = new Map<string, NodeFileUploadSession>();
const NODE_FILE_UPLOAD_SESSION_TTL_MS = 30 * 60 * 1000;

function cleanupExpiredUploadSessions(now = Date.now()) {
  for (const [uploadId, session] of uploadSessions) {
    if (session.expiresAt <= now) {
      uploadSessions.delete(uploadId);
    }
  }
}

function getUploadSession(uploadId: string) {
  cleanupExpiredUploadSessions();
  const session = uploadSessions.get(uploadId);
  if (!session) {
    throw new AppError(404, 'UPLOAD_NOT_FOUND', 'Upload session not found or expired');
  }
  return session;
}

function assertUploadSessionScope(session: NodeFileUploadSession, nodeId: string) {
  if (session.nodeId !== nodeId) {
    throw new AppError(404, 'UPLOAD_NOT_FOUND', 'Upload session not found or expired');
  }
}

function fileParentPath(path: string) {
  const normalized = path.replace(/\/+$/, '');
  if (!normalized || normalized === '/') return '/';
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

function publishNodeFileChanged(
  context: NodeFileOperationContext,
  payload: {
    nodeId: string;
    action: NodeFileChangedAction;
    path: string;
    kind?: 'file' | 'directory' | 'unknown';
    fromPath?: string;
    toPath?: string;
  }
) {
  context.eventBus?.publish('node.file.changed', {
    ...payload,
    parentPath: fileParentPath(payload.path),
    fromParentPath: payload.fromPath ? fileParentPath(payload.fromPath) : undefined,
    toParentPath: payload.toPath ? fileParentPath(payload.toPath) : undefined,
  });
}

/**
 * `userId`: the user browsing through the API or an agent, recorded in the audit log like writes are (a node file can
 * be any host file, keys included). Opfield's own reads (host inventory) pass none.
 */
export async function listNodeFiles(context: NodeFileOperationContext, nodeId: string, path: string, userId?: string) {
  const result = await context.nodeDispatch.sendNodeFileCommand(nodeId, 'list', { path });
  const data = context.parseResult(result);
  if (userId) {
    await context.auditService.log({
      action: 'node.file.list',
      userId,
      resourceType: 'node',
      resourceId: nodeId,
      details: { path },
    });
  }
  return data;
}

export async function readNodeFile(context: NodeFileOperationContext, nodeId: string, path: string, userId?: string) {
  // One byte over the limit tells an oversized file apart from one exactly at it (any daemon version).
  const result = await context.nodeDispatch.sendNodeFileCommand(
    nodeId,
    'read',
    { path, maxBytes: DOCKER_FILE_READ_REQUEST_BYTES },
    dockerFileTransferTimeoutMs(DOCKER_FILE_READ_REQUEST_BYTES)
  );
  if (!result.success) {
    return context.parseResult(result);
  }
  const data = commandResultDataToBuffer(result.data);
  assertDockerFileReadWithinLimit(data);
  if (userId) {
    await context.auditService.log({
      action: 'node.file.read',
      userId,
      resourceType: 'node',
      resourceId: nodeId,
      details: { path, bytes: data.byteLength },
    });
  }
  return data;
}

export async function writeNodeFile(
  context: NodeFileOperationContext,
  nodeId: string,
  path: string,
  content: string | Buffer,
  userId: string
) {
  const result = await context.nodeDispatch.sendNodeFileCommand(
    nodeId,
    'write',
    { path, content },
    dockerFileTransferTimeoutMs(contentByteLength(content))
  );
  context.parseResult(result);
  await context.auditService.log({
    action: 'node.file.write',
    userId,
    resourceType: 'node',
    resourceId: nodeId,
    details: { path },
  });
  publishNodeFileChanged(context, { nodeId, action: 'updated', path, kind: 'file' });
}

export async function createNodeFile(
  context: NodeFileOperationContext,
  nodeId: string,
  path: string,
  content: string | Buffer | undefined,
  userId: string
) {
  const result = await context.nodeDispatch.sendNodeFileCommand(
    nodeId,
    'create-file',
    { path, content: content ?? '' },
    dockerFileTransferTimeoutMs(contentByteLength(content))
  );
  context.parseResult(result);
  await context.auditService.log({
    action: 'node.file.create',
    userId,
    resourceType: 'node',
    resourceId: nodeId,
    details: { path },
  });
  publishNodeFileChanged(context, { nodeId, action: 'created', path, kind: 'file' });
}

export async function initNodeFileUpload(
  context: NodeFileOperationContext,
  nodeId: string,
  path: string,
  totalBytes: number,
  userId: string,
  uploadId = randomUUID()
) {
  cleanupExpiredUploadSessions();
  const result = await context.nodeDispatch.sendNodeFileCommand(nodeId, 'upload-init', {
    path: uploadId,
    targetPath: path,
    maxBytes: totalBytes,
  });
  context.parseResult(result);
  uploadSessions.set(uploadId, {
    uploadId,
    nodeId,
    path,
    totalBytes,
    expectedOffset: 0,
    userId,
    expiresAt: Date.now() + NODE_FILE_UPLOAD_SESSION_TTL_MS,
  });
  return { uploadId, chunkSize: DOCKER_FILE_UPLOAD_CHUNK_BYTES };
}

export async function appendNodeFileUploadChunk(
  context: NodeFileOperationContext,
  nodeId: string,
  uploadId: string,
  offset: number,
  content: Buffer
) {
  const session = getUploadSession(uploadId);
  assertUploadSessionScope(session, nodeId);
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
  const result = await context.nodeDispatch.sendNodeFileCommand(
    session.nodeId,
    'upload-chunk',
    { path: uploadId, targetPath: session.path, maxBytes: offset, content },
    dockerFileTransferTimeoutMs(content.byteLength)
  );
  context.parseResult(result);
  session.expectedOffset += content.length;
  session.expiresAt = Date.now() + NODE_FILE_UPLOAD_SESSION_TTL_MS;
  return { receivedBytes: session.expectedOffset, totalBytes: session.totalBytes };
}

export async function completeNodeFileUpload(
  context: NodeFileOperationContext,
  nodeId: string,
  uploadId: string,
  path: string,
  totalBytes: number
) {
  const session = getUploadSession(uploadId);
  assertUploadSessionScope(session, nodeId);
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
  const result = await context.nodeDispatch.sendNodeFileCommand(session.nodeId, 'upload-complete', {
    path: uploadId,
    targetPath: session.path,
    maxBytes: totalBytes,
  });
  context.parseResult(result);
  uploadSessions.delete(uploadId);
  await context.auditService.log({
    action: 'node.file.create',
    userId: session.userId,
    resourceType: 'node',
    resourceId: session.nodeId,
    details: { path: session.path },
  });
  publishNodeFileChanged(context, { nodeId: session.nodeId, action: 'created', path: session.path, kind: 'file' });
}

export async function abortNodeFileUpload(context: NodeFileOperationContext, nodeId: string, uploadId: string) {
  const session = uploadSessions.get(uploadId);
  if (!session) return;
  assertUploadSessionScope(session, nodeId);
  uploadSessions.delete(uploadId);
  const result = await context.nodeDispatch.sendNodeFileCommand(session.nodeId, 'upload-abort', {
    path: uploadId,
    targetPath: session.path,
  });
  context.parseResult(result);
}

export async function createNodeDirectory(
  context: NodeFileOperationContext,
  nodeId: string,
  path: string,
  userId: string
) {
  const result = await context.nodeDispatch.sendNodeFileCommand(nodeId, 'create-dir', { path });
  context.parseResult(result);
  await context.auditService.log({
    action: 'node.file.create_directory',
    userId,
    resourceType: 'node',
    resourceId: nodeId,
    details: { path },
  });
  publishNodeFileChanged(context, { nodeId, action: 'created', path, kind: 'directory' });
}

export async function deleteNodeFile(context: NodeFileOperationContext, nodeId: string, path: string, userId: string) {
  const result = await context.nodeDispatch.sendNodeFileCommand(nodeId, 'delete', { path });
  context.parseResult(result);
  await context.auditService.log({
    action: 'node.file.delete',
    userId,
    resourceType: 'node',
    resourceId: nodeId,
    details: { path },
  });
  publishNodeFileChanged(context, { nodeId, action: 'deleted', path, kind: 'unknown' });
}

export async function moveNodeFile(
  context: NodeFileOperationContext,
  nodeId: string,
  fromPath: string,
  toPath: string,
  userId: string
) {
  const result = await context.nodeDispatch.sendNodeFileCommand(nodeId, 'move', {
    path: fromPath,
    targetPath: toPath,
  });
  context.parseResult(result);
  await context.auditService.log({
    action: 'node.file.move',
    userId,
    resourceType: 'node',
    resourceId: nodeId,
    details: { fromPath, toPath },
  });
  publishNodeFileChanged(context, {
    nodeId,
    action: 'moved',
    path: toPath,
    kind: 'unknown',
    fromPath,
    toPath,
  });
}
