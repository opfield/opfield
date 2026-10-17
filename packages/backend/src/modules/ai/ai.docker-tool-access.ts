import { container } from '@/container.js';
import { hasScopeForResource } from '@/lib/permissions.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import { hasDockerResourceScope } from '@/modules/docker/docker-access-resource.service.js';
import { inspectUserContainer } from '@/modules/docker/docker-internal-containers.js';
import { DockerSourceService } from '@/modules/docker/docker-source.service.js';
import {
  findRemovedContainerSource,
  isMissingContainerError,
  removedContainerSourceError,
} from '@/modules/docker/docker-source-removed-container.js';
import type { User } from '@/types.js';

/** Authorization helpers shared by the Docker AI tools; they mirror the Docker route middleware. */

export function ensureToolScopeForResource(user: User, baseScope: string, resourceId: string): void {
  if (!hasScopeForResource(user.scopes, baseScope, resourceId)) {
    throw new Error(`PERMISSION_DENIED: Missing required scope ${baseScope}:${resourceId}`);
  }
}

/** Inspect once, require every scope on the container, and return the inspect data. */
export async function ensureDockerContainerScopes(
  dockerService: DockerManagementService,
  user: User,
  baseScopes: readonly string[],
  nodeId: string,
  containerId: string
): Promise<any> {
  const inspected = await inspectUserContainer(dockerService, nodeId, containerId);
  const resourceId = String(inspected?.scopeResourceId ?? '');
  if (!resourceId) throw new Error('PERMISSION_DENIED: Container authorization identity is unavailable');
  for (const baseScope of baseScopes) {
    ensureToolScopeForResource(user, baseScope, `${nodeId}/${resourceId}`);
  }
  return inspected;
}

/**
 * requireDockerContainerScope(..., { allowPendingSource: true }): a container
 * that exists only as a pending Git-source build is authorized through its
 * persisted identity; otherwise the live container identity is used.
 */
export async function ensureDockerSourceContainerScope(
  dockerService: DockerManagementService,
  user: User,
  baseScope: string,
  nodeId: string,
  containerName: string,
  options: { removedContainerSource?: 'allow' | 'refuse' } = {}
): Promise<{ removedContainer: boolean }> {
  const pending = await container.resolve(DockerSourceService).getPendingContainer(nodeId, containerName);
  if (pending) {
    if (!hasDockerResourceScope(user.scopes, baseScope, nodeId, pending.scopeResourceId)) {
      throw new Error(`PERMISSION_DENIED: Missing required scope ${baseScope}:${nodeId}/${pending.scopeResourceId}`);
    }
    return { removedContainer: false };
  }
  try {
    await ensureDockerContainerScopes(dockerService, user, [baseScope], nodeId, containerName);
    return { removedContainer: false };
  } catch (error) {
    // The Git source of a container removed outside Opfield: authorized on the removed container's identity, like
    // requireDockerContainerScope(..., { removedContainerSource }).
    const removed =
      options.removedContainerSource && isMissingContainerError(error)
        ? await findRemovedContainerSource(nodeId, containerName)
        : null;
    if (!removed) throw error;
    if (
      !hasDockerResourceScope(user.scopes, baseScope, nodeId, '') &&
      !(removed.scopeResourceId && hasDockerResourceScope(user.scopes, baseScope, nodeId, removed.scopeResourceId))
    ) {
      throw new Error(
        `PERMISSION_DENIED: Missing required scope ${baseScope}:${nodeId}${removed.scopeResourceId ? `/${removed.scopeResourceId}` : ''}`
      );
    }
    if (options.removedContainerSource === 'refuse') throw removedContainerSourceError(containerName);
    // The container is gone: its source is authorized on the removed container's identity.
    return { removedContainer: true };
  }
}

export function optionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function requiredToolString(value: unknown, name: string): string {
  const text = optionalNonEmptyString(value);
  if (!text) throw new Error(`${name} is required`);
  return text;
}

/** Copy only the arguments a REST body accepts, so schema defaults behave like the route. */
export function pickDefinedArguments(args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (args[key] !== undefined) picked[key] = args[key];
  }
  return picked;
}

const TEXT_READ_LIMIT_BYTES = 262_144;

/** Present file bytes for the model: UTF-8 by default, base64 for binary, with an optional byte window. */
export function presentFileContent(
  path: string,
  data: Buffer | Uint8Array,
  options: { encoding?: unknown; offsetBytes?: unknown; limitBytes?: unknown }
) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const offset =
    typeof options.offsetBytes === 'number' && Number.isInteger(options.offsetBytes) && options.offsetBytes > 0
      ? Math.min(options.offsetBytes, buffer.byteLength)
      : 0;
  const limit =
    typeof options.limitBytes === 'number' && Number.isInteger(options.limitBytes) && options.limitBytes > 0
      ? Math.min(options.limitBytes, TEXT_READ_LIMIT_BYTES * 4)
      : buffer.byteLength - offset;
  const slice = buffer.subarray(offset, offset + limit);
  const encoding = options.encoding === 'base64' ? 'base64' : 'utf8';
  return {
    path,
    encoding,
    content: encoding === 'base64' ? slice.toString('base64') : slice.toString('utf8'),
    sizeBytes: buffer.byteLength,
    offsetBytes: offset,
    returnedBytes: slice.byteLength,
    truncated: offset + slice.byteLength < buffer.byteLength,
  };
}

const FILE_CHUNK_MAX_BYTES = 1024 * 1024;

function decodeBase64Content(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    throw new Error('contentBase64 must be valid base64');
  }
  return bytes;
}

/** Decode a write payload given as UTF-8 `content` or binary `contentBase64`. */
export function decodeFileContent(args: Record<string, unknown>): string | Buffer {
  if (typeof args.contentBase64 === 'string') return decodeBase64Content(args.contentBase64);
  if (typeof args.content === 'string') return args.content;
  throw new Error('content or contentBase64 is required');
}

/** A resumable upload chunk: 1 byte to 1 MiB, given as `contentBase64` or UTF-8 `content`. */
export function decodeUploadChunk(args: Record<string, unknown>): Buffer {
  const content = decodeFileContent(args);
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  if (bytes.byteLength === 0 || bytes.byteLength > FILE_CHUNK_MAX_BYTES) {
    throw new Error('Upload chunks must contain 1 byte to 1 MiB');
  }
  return bytes;
}
