import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerManagedVolumes } from '@/db/schema/index.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import { commandResultDataToBuffer } from '@/lib/command-result-data.js';
import { isMatchingUniqueConstraintViolation } from '@/lib/resource-slugs.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { configReferencedVolumeNames } from '@/services/docker-kept-volumes.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { isOpfieldInternalContainer } from './docker-internal-containers.js';
import { isOpfieldManagedDockerNetwork, isReservedOpfieldNetworkName } from './docker-internal-networks.js';
import { isDockerManagedVolumeLabelled } from './docker-managed-volume.constants.js';
import {
  assertDockerFileReadWithinLimit,
  DOCKER_FILE_READ_REQUEST_BYTES,
  DOCKER_FILE_UPLOAD_CHUNK_BYTES,
  dockerFileTransferTimeoutMs,
} from './docker-read-operations.js';

type DockerDispatchResult = { success: boolean; error?: string; detail?: string; data?: Buffer | Uint8Array | string };

export interface DockerVolumeNetworkOperationContext {
  db: DrizzleClient;
  nodeDispatch: NodeDispatchService;
  auditService: AuditService;
  eventBus?: EventBusService;
  parseResult(result: DockerDispatchResult): any;
  assertContainerMutationAllowed?(nodeId: string, containerId: string): Promise<void>;
  /** Refuses removing a network the app kill switch reconnects isolated containers to on release. */
  assertNetworkRemovable?(nodeId: string, network: { id: string; name: string }): Promise<void>;
  onNetworkCreated?(
    nodeId: string,
    networkId: string,
    folderId: string | null | undefined,
    userId: string
  ): Promise<void>;
  onNetworkRemoved?(nodeId: string, networkId: string): Promise<void>;
  onVolumeCreated?(
    nodeId: string,
    volumeName: string,
    folderId: string | null | undefined,
    userId: string
  ): Promise<void>;
  onVolumeRemoved?(nodeId: string, volumeName: string): Promise<void>;
}

interface DockerVolumeFileUploadSession {
  uploadId: string;
  nodeId: string;
  volumeName: string;
  path: string;
  totalBytes: number;
  expectedOffset: number;
  userId: string;
  expiresAt: number;
}

const volumeUploadSessions = new Map<string, DockerVolumeFileUploadSession>();
// The daemon caps a volume export archive at 512 MiB.
const DOCKER_VOLUME_EXPORT_MAX_BYTES = 512 * 1024 * 1024;
const DOCKER_VOLUME_FILE_UPLOAD_SESSION_TTL_MS = 30 * 60 * 1000;

/**
 * An expired session's temp file (up to the upload limit) would stay inside the volume: the node is told to remove
 * it. A node that is offline then removes it on the next upload into that directory.
 */
function abortExpiredVolumeUpload(
  context: DockerVolumeNetworkOperationContext,
  session: DockerVolumeFileUploadSession
) {
  void Promise.resolve()
    .then(() =>
      context.nodeDispatch.sendDockerVolumeCommand(session.nodeId, 'upload-abort', {
        name: session.volumeName,
        path: session.uploadId,
        targetPath: session.path,
      })
    )
    .catch(() => undefined);
}

function cleanupExpiredVolumeUploadSessions(context: DockerVolumeNetworkOperationContext, now = Date.now()) {
  for (const [uploadId, session] of volumeUploadSessions) {
    if (session.expiresAt <= now) {
      volumeUploadSessions.delete(uploadId);
      abortExpiredVolumeUpload(context, session);
    }
  }
}

/** Aborts the session once it expired, also when no other upload comes to clean it up. */
function scheduleVolumeUploadSessionExpiry(
  context: DockerVolumeNetworkOperationContext,
  session: DockerVolumeFileUploadSession
) {
  const timer = setTimeout(
    () => {
      if (volumeUploadSessions.get(session.uploadId) !== session) return;
      if (session.expiresAt > Date.now()) {
        scheduleVolumeUploadSessionExpiry(context, session);
        return;
      }
      volumeUploadSessions.delete(session.uploadId);
      abortExpiredVolumeUpload(context, session);
    },
    Math.max(0, session.expiresAt - Date.now()) + 1000
  );
  timer.unref?.();
}

function getVolumeUploadSession(context: DockerVolumeNetworkOperationContext, uploadId: string) {
  cleanupExpiredVolumeUploadSessions(context);
  const session = volumeUploadSessions.get(uploadId);
  if (!session) {
    throw new AppError(404, 'UPLOAD_NOT_FOUND', 'Upload session not found or expired');
  }
  return session;
}

function assertVolumeUploadSessionScope(session: DockerVolumeFileUploadSession, nodeId: string, volumeName: string) {
  if (session.nodeId !== nodeId || session.volumeName !== volumeName) {
    throw new AppError(404, 'UPLOAD_NOT_FOUND', 'Upload session not found or expired');
  }
}

function fileParentPath(path: string) {
  const normalized = path.replace(/\/+$/, '');
  if (!normalized || normalized === '/') return '/';
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

function publishVolumeFileChanged(
  context: DockerVolumeNetworkOperationContext,
  payload: {
    nodeId: string;
    volumeName: string;
    action: 'created' | 'updated' | 'deleted' | 'moved';
    path?: string;
    kind?: 'file' | 'directory';
    fromPath?: string;
    toPath?: string;
  }
) {
  context.eventBus?.publish('docker.volume.file.changed', {
    ...payload,
    parentPath: payload.path ? fileParentPath(payload.path) : undefined,
    fromParentPath: payload.fromPath ? fileParentPath(payload.fromPath) : undefined,
    toParentPath: payload.toPath ? fileParentPath(payload.toPath) : undefined,
  });
}

export async function listVolumes(context: DockerVolumeNetworkOperationContext, nodeId: string) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'list');
  const volumes = context.parseResult(result);
  if (!Array.isArray(volumes)) return volumes;

  const [managedRows, containerResult] = await Promise.all([
    context.db
      .select({ volumeName: dockerManagedVolumes.volumeName })
      .from(dockerManagedVolumes)
      .where(eq(dockerManagedVolumes.nodeId, nodeId)),
    context.nodeDispatch.sendDockerContainerCommand(nodeId, 'list'),
  ]);
  const managedNames = new Set(managedRows.map((row) => row.volumeName));
  const containers = context.parseResult(containerResult);
  const userVisibleContainerNames = new Set(
    (Array.isArray(containers) ? containers : [])
      .filter((container) => !isOpfieldInternalContainer(container))
      .map((container) => String(container.name ?? container.Name ?? '').replace(/^\/+/, ''))
      .filter(Boolean)
  );

  const visible: Record<string, any>[] = volumes.flatMap((volume: Record<string, any>) => {
    const name = String(volume.Name ?? volume.name ?? '');
    if (!name) return [];
    const usedBy = Array.isArray(volume.UsedBy ?? volume.usedBy) ? (volume.UsedBy ?? volume.usedBy) : [];
    const managed = managedNames.has(name);
    if (!managed && !usedBy.some((containerName: string) => userVisibleContainerNames.has(containerName))) return [];
    const eligibility = volumeAdoptionEligibility(volume);
    return [
      {
        ...volume,
        managementState: managed ? 'managed' : 'legacy',
        adoptable: !managed && eligibility.adoptable,
        adoptionReason: managed ? undefined : eligibility.reason,
      },
    ];
  });
  const returnedNames = new Set(visible.map((volume: Record<string, any>) => String(volume.Name ?? volume.name ?? '')));
  for (const row of managedRows) {
    if (returnedNames.has(row.volumeName)) continue;
    visible.push({
      Name: row.volumeName,
      Driver: 'local',
      Scope: 'local',
      UsedBy: [],
      managementState: 'managed',
      adoptable: false,
      availability: 'unavailable',
    });
  }
  return visible;
}

/**
 * Per-volume user operations must apply the same visibility as listVolumes:
 * Opfield's own volumes (used only by Opfield-internal containers) are not
 * user resources, even for callers with broad volume scopes.
 */
export async function assertUserVolumeVisible(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string
) {
  const [managed] = await context.db
    .select({ volumeName: dockerManagedVolumes.volumeName })
    .from(dockerManagedVolumes)
    .where(and(eq(dockerManagedVolumes.nodeId, nodeId), eq(dockerManagedVolumes.volumeName, name)))
    .limit(1);
  if (managed) return;
  const visible = await listVolumes(context, nodeId);
  if (Array.isArray(visible) && visible.some((volume) => String(volume?.Name ?? volume?.name ?? '') === name)) return;
  throw new AppError(404, 'VOLUME_NOT_FOUND', 'Volume not found');
}

export async function inspectVolume(context: DockerVolumeNetworkOperationContext, nodeId: string, name: string) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'inspect', { name });
  const volume = context.parseResult(result);
  const [managed] = await context.db
    .select({ volumeName: dockerManagedVolumes.volumeName })
    .from(dockerManagedVolumes)
    .where(and(eq(dockerManagedVolumes.nodeId, nodeId), eq(dockerManagedVolumes.volumeName, name)))
    .limit(1);
  const eligibility = volumeAdoptionEligibility(volume);
  return {
    ...volume,
    managementState: managed ? 'managed' : 'legacy',
    adoptable: !managed && eligibility.adoptable,
    adoptionReason: managed ? undefined : eligibility.reason,
  };
}

function volumeAdoptionEligibility(volume: Record<string, any>): { adoptable: boolean; reason?: string } {
  const driver = String(volume?.Driver ?? volume?.driver ?? '');
  const scope = String(volume?.Scope ?? volume?.scope ?? '');
  const options = volume?.Options ?? volume?.options ?? {};
  if (driver !== 'local') return { adoptable: false, reason: 'Only local Docker volumes can be managed' };
  if (scope !== 'local') return { adoptable: false, reason: 'Only node-local volumes can be managed' };
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).length > 0) {
    return { adoptable: false, reason: 'Volumes with driver options cannot be managed' };
  }
  return { adoptable: true };
}

export async function listVolumeFiles(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  path: string
) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'list-files', { name, path });
  return context.parseResult(result);
}

export async function exportVolume(context: DockerVolumeNetworkOperationContext, nodeId: string, name: string) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(
    nodeId,
    'export',
    { name },
    dockerFileTransferTimeoutMs(DOCKER_VOLUME_EXPORT_MAX_BYTES)
  );
  if (!result.success) return context.parseResult(result);
  const data = commandResultDataToBuffer(result.data);
  if (data.byteLength === 0 && result.detail) {
    throw new AppError(
      409,
      'DOCKER_DAEMON_PROTOCOL_MISMATCH',
      'Docker daemon returned a legacy volume export payload. Update and restart the Docker daemon.'
    );
  }
  return data;
}

export async function readVolumeFile(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  path: string
) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(
    nodeId,
    'read-file',
    {
      name,
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
      'Docker daemon returned a legacy volume file payload. Update and restart the Docker daemon.'
    );
  }
  assertDockerFileReadWithinLimit(data);
  return data;
}

export async function writeVolumeFile(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  path: string,
  content: string | Buffer,
  userId: string
) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(
    nodeId,
    'write-file',
    { name, path, content },
    dockerFileTransferTimeoutMs(Buffer.byteLength(content))
  );
  context.parseResult(result);
  await context.auditService.log({
    action: 'docker.volume.file.write',
    userId,
    resourceType: 'docker-volume',
    resourceId: name,
    details: { nodeId, path },
  });
  publishVolumeFileChanged(context, { nodeId, volumeName: name, action: 'updated', path, kind: 'file' });
}

export async function createVolumeFile(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  path: string,
  content: string | Buffer,
  userId: string
) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(
    nodeId,
    'create-file',
    { name, path, content },
    dockerFileTransferTimeoutMs(Buffer.byteLength(content))
  );
  context.parseResult(result);
  await context.auditService.log({
    action: 'docker.volume.file.create',
    userId,
    resourceType: 'docker-volume',
    resourceId: name,
    details: { nodeId, path },
  });
  publishVolumeFileChanged(context, { nodeId, volumeName: name, action: 'created', path, kind: 'file' });
}

export async function initVolumeFileUpload(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  path: string,
  totalBytes: number,
  userId: string,
  uploadId = randomUUID()
) {
  cleanupExpiredVolumeUploadSessions(context);
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'upload-init', {
    name,
    path: uploadId,
    targetPath: path,
    maxBytes: totalBytes,
  });
  context.parseResult(result);
  const session: DockerVolumeFileUploadSession = {
    uploadId,
    nodeId,
    volumeName: name,
    path,
    totalBytes,
    expectedOffset: 0,
    userId,
    expiresAt: Date.now() + DOCKER_VOLUME_FILE_UPLOAD_SESSION_TTL_MS,
  };
  volumeUploadSessions.set(uploadId, session);
  scheduleVolumeUploadSessionExpiry(context, session);
  return { uploadId, chunkSize: DOCKER_FILE_UPLOAD_CHUNK_BYTES };
}

export async function appendVolumeFileUploadChunk(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  uploadId: string,
  offset: number,
  content: Buffer
) {
  const session = getVolumeUploadSession(context, uploadId);
  assertVolumeUploadSessionScope(session, nodeId, name);
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
  const result = await context.nodeDispatch.sendDockerVolumeCommand(
    session.nodeId,
    'upload-chunk',
    {
      name: session.volumeName,
      path: uploadId,
      targetPath: session.path,
      maxBytes: offset,
      content,
    },
    dockerFileTransferTimeoutMs(content.byteLength)
  );
  context.parseResult(result);
  session.expectedOffset += content.length;
  session.expiresAt = Date.now() + DOCKER_VOLUME_FILE_UPLOAD_SESSION_TTL_MS;
  return { receivedBytes: session.expectedOffset, totalBytes: session.totalBytes };
}

export async function completeVolumeFileUpload(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  uploadId: string,
  path: string,
  totalBytes: number
) {
  const session = getVolumeUploadSession(context, uploadId);
  assertVolumeUploadSessionScope(session, nodeId, name);
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
  const result = await context.nodeDispatch.sendDockerVolumeCommand(session.nodeId, 'upload-complete', {
    name: session.volumeName,
    path: uploadId,
    targetPath: session.path,
    maxBytes: totalBytes,
  });
  context.parseResult(result);
  volumeUploadSessions.delete(uploadId);
  await context.auditService.log({
    action: 'docker.volume.file.create',
    userId: session.userId,
    resourceType: 'docker-volume',
    resourceId: session.volumeName,
    details: { nodeId: session.nodeId, path: session.path },
  });
  publishVolumeFileChanged(context, {
    nodeId: session.nodeId,
    volumeName: session.volumeName,
    action: 'created',
    path: session.path,
    kind: 'file',
  });
}

export async function abortVolumeFileUpload(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  uploadId: string
) {
  const session = volumeUploadSessions.get(uploadId);
  if (!session) return;
  assertVolumeUploadSessionScope(session, nodeId, name);
  volumeUploadSessions.delete(uploadId);
  const result = await context.nodeDispatch.sendDockerVolumeCommand(session.nodeId, 'upload-abort', {
    name: session.volumeName,
    path: uploadId,
    targetPath: session.path,
  });
  context.parseResult(result);
}

export async function createVolumeDirectory(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  path: string,
  userId: string
) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'create-dir', { name, path });
  context.parseResult(result);
  await context.auditService.log({
    action: 'docker.volume.file.create_directory',
    userId,
    resourceType: 'docker-volume',
    resourceId: name,
    details: { nodeId, path },
  });
  publishVolumeFileChanged(context, { nodeId, volumeName: name, action: 'created', path, kind: 'directory' });
}

export async function deleteVolumeFile(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  path: string,
  userId: string
) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'delete', { name, path });
  context.parseResult(result);
  await context.auditService.log({
    action: 'docker.volume.file.delete',
    userId,
    resourceType: 'docker-volume',
    resourceId: name,
    details: { nodeId, path },
  });
  publishVolumeFileChanged(context, { nodeId, volumeName: name, action: 'deleted', path });
}

export async function moveVolumeFile(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  fromPath: string,
  toPath: string,
  userId: string
) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'move', {
    name,
    path: fromPath,
    targetPath: toPath,
  });
  context.parseResult(result);
  await context.auditService.log({
    action: 'docker.volume.file.move',
    userId,
    resourceType: 'docker-volume',
    resourceId: name,
    details: { nodeId, fromPath, toPath },
  });
  publishVolumeFileChanged(context, { nodeId, volumeName: name, action: 'moved', fromPath, toPath });
}

export async function renameVolume(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  newName: string,
  userId: string
) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'rename', { name, newName });
  context.parseResult(result);
  await context.db
    .update(dockerManagedVolumes)
    .set({ volumeName: newName, updatedAt: new Date() })
    .where(and(eq(dockerManagedVolumes.nodeId, nodeId), eq(dockerManagedVolumes.volumeName, name)));
  await context.auditService.log({
    action: 'docker.volume.rename',
    userId,
    resourceType: 'docker-volume',
    resourceId: newName,
    details: { nodeId, oldName: name, name: newName },
  });
  context.eventBus?.publish('docker.volume.changed', { nodeId, name: newName, action: 'renamed', oldName: name });
}

export async function updateVolumeLabels(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  labels: Record<string, string>,
  userId: string
) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'update-labels', { name, labels });
  context.parseResult(result);
  await context.auditService.log({
    action: 'docker.volume.labels.update',
    userId,
    resourceType: 'docker-volume',
    resourceId: name,
    details: { nodeId, name },
  });
  context.eventBus?.publish('docker.volume.changed', { nodeId, name, action: 'labels-updated' });
}

export async function createVolume(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  config: { name: string; storageKind?: 'regular' | 'disk-image'; capacityBytes?: number; folderId?: string | null },
  userId: string
) {
  if (config.storageKind === 'disk-image') return commercialModuleUnavailable();
  const inventory = context.parseResult(await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'list'));
  if (!Array.isArray(inventory))
    throw new AppError(502, 'VOLUME_INVENTORY_UNAVAILABLE', 'Volume inventory is unavailable');
  if (inventory.some((volume) => String(volume.name ?? volume.Name ?? '') === config.name))
    throw new AppError(409, 'NAME_IN_USE', `A volume named "${config.name}" already exists on this node`);
  const storageKind = 'regular' as const;
  const daemonConfig = {
    name: config.name,
    ...(config.capacityBytes != null ? { capacityBytes: config.capacityBytes } : {}),
  };
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'create', daemonConfig);
  const data = context.parseResult(result);
  try {
    await context.db.insert(dockerManagedVolumes).values({
      nodeId,
      volumeName: config.name,
      origin: 'created',
      storageKind,
      capacityBytes: config.capacityBytes ?? null,
      createdById: userId,
    });
  } catch (error) {
    if (isMatchingUniqueConstraintViolation(error, 'docker_managed_volumes_pkey')) {
      throw new AppError(409, 'NAME_IN_USE', `A managed volume named "${config.name}" already exists on this node`);
    }
    throw new AppError(
      500,
      'MANAGED_VOLUME_REGISTRY_FAILED',
      `Volume "${config.name}" was created but could not be registered; its data was preserved and must be resolved from the Docker host before retrying`
    );
  }
  await context.onVolumeCreated?.(nodeId, config.name, config.folderId, userId);
  await context.auditService.log({
    action: 'docker.volume.create',
    userId,
    resourceType: 'docker-volume',
    details: {
      nodeId,
      name: config.name,
    },
  });
  context.eventBus?.publish('docker.volume.changed', { nodeId, name: config.name, action: 'created' });
  // The daemon answers a create without a body; the caller (REST, MCP) still gets the volume it created (rc.3 GO-8:
  // manage_docker_volume create answered null).
  return {
    ...(data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {}),
    name: config.name,
    nodeId,
    storageKind,
    capacityBytes: config.capacityBytes ?? null,
    managed: true,
  };
}

export async function removeVolume(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  force: boolean,
  userId: string | null
) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'remove', { name, force });
  context.parseResult(result);
  await context.db
    .delete(dockerManagedVolumes)
    .where(and(eq(dockerManagedVolumes.nodeId, nodeId), eq(dockerManagedVolumes.volumeName, name)));
  await context.auditService.log({
    action: 'docker.volume.remove',
    userId,
    resourceType: 'docker-volume',
    resourceId: name,
    details: { nodeId },
  });
  context.eventBus?.publish('docker.volume.changed', { nodeId, name, action: 'removed' });
}

/** Docker names anonymous volumes with 64 hex characters. */
export function isAnonymousDockerVolumeName(name: string): boolean {
  return /^[a-f0-9]{64}$/i.test(name);
}

/**
 * Whether Opfield manages the volume: it has a managed-volume row (created or adopted) or carries Opfield
 * managed-volume label. Anonymous-volume cleanup must never remove such a volume.
 */
export async function isOpfieldManagedVolume(
  db: DrizzleClient,
  nodeId: string,
  name: string,
  volume?: Record<string, any> | null
): Promise<boolean> {
  const labels = volume?.Labels ?? volume?.labels;
  if (isDockerManagedVolumeLabelled(labels)) return true;
  const rows = await db
    .select({ volumeName: dockerManagedVolumes.volumeName })
    .from(dockerManagedVolumes)
    .where(and(eq(dockerManagedVolumes.nodeId, nodeId), eq(dockerManagedVolumes.volumeName, name)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Whether removal must keep the volume: Opfield manages it (isOpfieldManagedVolume) or an Opfield config names it
 * (a deployment, slot, Availability policy, source container config or active Compose revision).
 */
export async function isOpfieldKeptVolume(
  db: DrizzleClient,
  nodeId: string,
  name: string,
  volume?: Record<string, any> | null
): Promise<boolean> {
  if (await isOpfieldManagedVolume(db, nodeId, name, volume)) return true;
  return (await configReferencedVolumeNames(db)).has(name.toLowerCase());
}

/** Names of the volumes Opfield manages on a node (created or adopted). */
export async function opfieldManagedVolumeNames(db: DrizzleClient, nodeId: string): Promise<Set<string>> {
  const rows = await db
    .select({ volumeName: dockerManagedVolumes.volumeName })
    .from(dockerManagedVolumes)
    .where(eq(dockerManagedVolumes.nodeId, nodeId));
  return new Set(rows.map((row) => row.volumeName));
}

/**
 * Every volume on the node, including the ones listVolumes hides from users.
 * Only for housekeeping, which looks for orphaned anonymous volumes.
 */
export async function listAllVolumes(context: DockerVolumeNetworkOperationContext, nodeId: string) {
  return context.parseResult(await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'list'));
}

/**
 * Housekeeping removal of an anonymous volume that no container uses. Such
 * volumes are hidden from the user volume list, so the user visibility check
 * does not apply; the name and the unused state are re-checked instead.
 */
export async function removeOrphanedAnonymousVolume(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  userId: string | null
) {
  if (!isAnonymousDockerVolumeName(name)) {
    throw new AppError(409, 'VOLUME_NOT_ANONYMOUS', 'Housekeeping only removes anonymous volumes');
  }
  const volume = context.parseResult(await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'inspect', { name }));
  const usedBy = volume?.UsedBy ?? volume?.usedBy;
  if (Array.isArray(usedBy) && usedBy.length > 0) {
    throw new AppError(409, 'VOLUME_IN_USE', 'Volume is in use');
  }
  if (await isOpfieldManagedVolume(context.db, nodeId, name, volume)) {
    throw new AppError(409, 'VOLUME_MANAGED', 'Housekeeping never removes a volume managed by Opfield');
  }
  if ((await configReferencedVolumeNames(context.db)).has(name.toLowerCase())) {
    throw new AppError(409, 'VOLUME_REFERENCED', 'Housekeeping never removes a volume an Opfield config names');
  }
  // force=false: Docker still refuses a volume that a container started using meanwhile.
  await removeVolume(context, nodeId, name, false, userId);
}

export async function adoptVolume(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  name: string,
  userId: string
) {
  const result = await context.nodeDispatch.sendDockerVolumeCommand(nodeId, 'inspect', { name });
  const volume = context.parseResult(result);
  const eligibility = volumeAdoptionEligibility(volume);
  if (!eligibility.adoptable) {
    throw new AppError(409, 'VOLUME_NOT_ADOPTABLE', eligibility.reason ?? 'Volume cannot be managed');
  }
  await context.db
    .insert(dockerManagedVolumes)
    .values({ nodeId, volumeName: name, origin: 'adopted', createdById: userId })
    .onConflictDoUpdate({
      target: [dockerManagedVolumes.nodeId, dockerManagedVolumes.volumeName],
      set: { origin: 'adopted', updatedAt: new Date() },
    });
  await context.auditService.log({
    action: 'docker.volume.adopt',
    userId,
    resourceType: 'docker-volume',
    resourceId: name,
    details: { nodeId, name, copiedData: false },
  });
  context.eventBus?.publish('docker.volume.changed', { nodeId, name, action: 'adopted' });
  return { name, managementState: 'managed' as const };
}

export async function listNetworks(context: DockerVolumeNetworkOperationContext, nodeId: string) {
  const result = await context.nodeDispatch.sendDockerNetworkCommand(nodeId, 'list');
  const networks = context.parseResult(result);
  if (!Array.isArray(networks)) return networks;
  return networks.filter((network: any) => {
    const name = String(network.name ?? network.Name ?? '');
    return !isOpfieldManagedDockerNetwork(name);
  });
}

export function isBuiltInDockerNetwork(name: string) {
  return ['bridge', 'host', 'none'].includes(name);
}

interface ResolvedDockerNetwork {
  id: string;
  name: string;
}

export async function resolveNetworkIdentity(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  networkId: string
): Promise<ResolvedDockerNetwork> {
  const result = await context.nodeDispatch.sendDockerNetworkCommand(nodeId, 'list');
  const networks = context.parseResult(result);
  if (!Array.isArray(networks)) {
    throw new AppError(502, 'DOCKER_NETWORK_INVENTORY_UNAVAILABLE', 'Docker network inventory is unavailable');
  }

  const identities = networks.map((network: any) => {
    const id = String(network.id ?? network.Id ?? '');
    const name = String(network.name ?? network.Name ?? '');
    return { id, name };
  });
  const exactMatches = identities.filter(({ id, name }) => id === networkId || name === networkId);
  if (exactMatches.length === 1) return exactMatches[0]!;
  if (exactMatches.length > 1) {
    throw new AppError(409, 'DOCKER_NETWORK_AMBIGUOUS', 'Docker network identifier is ambiguous');
  }
  const prefixMatches = identities.filter(({ id }) => id.startsWith(networkId));
  if (prefixMatches.length === 1) return prefixMatches[0]!;
  if (prefixMatches.length > 1) {
    throw new AppError(409, 'DOCKER_NETWORK_AMBIGUOUS', 'Docker network identifier is ambiguous');
  }

  throw new AppError(404, 'DOCKER_NETWORK_NOT_FOUND', 'Docker network was not found');
}

export async function createNetwork(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  config: { name: string; driver: string; subnet?: string; gateway?: string; folderId?: string | null },
  userId: string
) {
  if (isReservedOpfieldNetworkName(config.name.trim())) {
    throw new AppError(
      409,
      'RESERVED_NETWORK_NAME',
      'Network names "opfield-secure-links", "opfield-db-*", "opfield-storage-*" and "opfield-link-*" are reserved for Opfield'
    );
  }
  const result = await context.nodeDispatch.sendDockerNetworkCommand(nodeId, 'create', {
    networkId: config.name,
    driver: config.driver,
    subnet: config.subnet,
    gatewayAddr: config.gateway,
  });
  const data = context.parseResult(result);
  const networkId = String(data?.id ?? data?.Id ?? '');
  if (!networkId) {
    throw new AppError(502, 'DOCKER_NETWORK_CREATE_INVALID_RESULT', 'Docker network create did not return an ID');
  }
  await context.onNetworkCreated?.(nodeId, networkId, config.folderId, userId);
  await context.auditService.log({
    action: 'docker.network.create',
    userId,
    resourceType: 'docker-network',
    details: { nodeId, name: config.name },
  });
  context.eventBus?.publish('docker.network.changed', { nodeId, name: config.name, action: 'created' });
  return data;
}

export async function removeNetwork(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  networkId: string,
  userId: string
) {
  const network = await resolveNetworkIdentity(context, nodeId, networkId);
  if (isOpfieldManagedDockerNetwork(network.name)) {
    throw new AppError(409, 'MANAGED_NETWORK', 'Opfield-managed networks cannot be removed');
  }
  if (isBuiltInDockerNetwork(network.name)) {
    throw new AppError(400, 'BUILTIN_NETWORK', 'Built-in Docker networks cannot be removed');
  }
  await context.assertNetworkRemovable?.(nodeId, network);
  const result = await context.nodeDispatch.sendDockerNetworkCommand(nodeId, 'remove', { networkId: network.id });
  context.parseResult(result);
  await context.onNetworkRemoved?.(nodeId, network.id);
  await context.auditService.log({
    action: 'docker.network.remove',
    userId,
    resourceType: 'docker-network',
    resourceId: network.id,
    details: { nodeId, networkName: network.name },
  });
  context.eventBus?.publish('docker.network.changed', { nodeId, name: network.name, action: 'removed' });
}

export async function connectContainerToNetwork(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  networkId: string,
  containerId: string,
  userId: string
) {
  const network = await resolveNetworkIdentity(context, nodeId, networkId);
  if (isOpfieldManagedDockerNetwork(network.name)) {
    throw new AppError(409, 'MANAGED_NETWORK', 'Opfield-managed networks cannot be connected manually');
  }
  await context.assertContainerMutationAllowed?.(nodeId, containerId);
  const result = await context.nodeDispatch.sendDockerNetworkCommand(nodeId, 'connect', {
    networkId: network.id,
    containerId,
  });
  context.parseResult(result);
  await context.auditService.log({
    action: 'docker.network.connect',
    userId,
    resourceType: 'docker-network',
    resourceId: network.id,
    details: { nodeId, containerId, networkName: network.name },
  });
}

export async function disconnectContainerFromNetwork(
  context: DockerVolumeNetworkOperationContext,
  nodeId: string,
  networkId: string,
  containerId: string,
  userId: string
) {
  const network = await resolveNetworkIdentity(context, nodeId, networkId);
  if (isOpfieldManagedDockerNetwork(network.name)) {
    throw new AppError(409, 'MANAGED_NETWORK', 'Opfield-managed networks cannot be disconnected manually');
  }
  if (isBuiltInDockerNetwork(network.name)) {
    throw new AppError(400, 'BUILTIN_NETWORK', 'Containers cannot be disconnected from built-in Docker networks');
  }
  await context.assertContainerMutationAllowed?.(nodeId, containerId);
  const result = await context.nodeDispatch.sendDockerNetworkCommand(nodeId, 'disconnect', {
    networkId: network.id,
    containerId,
  });
  context.parseResult(result);
  await context.auditService.log({
    action: 'docker.network.disconnect',
    userId,
    resourceType: 'docker-network',
    resourceId: network.id,
    details: { nodeId, containerId, networkName: network.name },
  });
}
