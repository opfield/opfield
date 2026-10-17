import { z } from 'zod';
import { container } from '@/container.js';
import { sanitizeFilename } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import { ContainerArchiveExportQuerySchema } from '@/modules/docker/docker.schemas.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import { hasDockerResourceScope } from '@/modules/docker/docker-access-resource.service.js';
import {
  assertDockerContainerArchiveContentAccess,
  assertDockerContainerArchiveExportAllowed,
  openDockerContainerArchiveExport,
} from '@/modules/docker/docker-container-archive-operations.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { User } from '@/types.js';
import { ensureDockerContainerScopes, requiredToolString } from './ai.docker-tool-access.js';

/**
 * Export checks shared by the MCP archive download (base64 chunks) and its
 * one-time download link: the same scopes, license and refusals as
 * GET /containers/:id/archive and GET /volumes/:name/export, checked before
 * anything is read from the node.
 */

export type DockerArchiveExportAccess =
  | { kind: 'container'; nodeId: string; resourceId: string; scopes: string[] }
  | { kind: 'volume'; nodeId: string; volumeName: string };

export interface OpenedDockerArchive {
  filename: string;
  source: () => Promise<ReadableStream<Uint8Array> | Buffer>;
}

export interface PreparedDockerArchiveExport {
  access: DockerArchiveExportAccess;
  /** Arguments that identify this export, to repeat the checks later. */
  args: Record<string, unknown>;
  /** Filename for a client that saves the archive before it is opened. */
  suggestedFilename: string;
  open: () => Promise<OpenedDockerArchive>;
}

export async function prepareDockerArchiveExport(
  dockerService: DockerManagementService,
  user: User,
  args: Record<string, unknown>
): Promise<PreparedDockerArchiveExport> {
  const kind = z.enum(['container', 'volume']).parse(args.kind);
  const nodeId = requiredToolString(args.nodeId, 'nodeId');
  if (kind === 'volume') {
    const volumeName = requiredToolString(args.volumeName, 'volumeName');
    // GET /volumes/:name/export holds docker:volumes:export and requires a user-visible volume.
    if (!hasDockerResourceScope(user.scopes, 'docker:volumes:export', nodeId, volumeName)) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: docker:volumes:export:${nodeId}/${volumeName}`);
    }
    await dockerService.assertUserVolumeVisible(nodeId, volumeName);
    const filename = `${sanitizeFilename(volumeName)}.tar.gz`;
    return {
      access: { kind, nodeId, volumeName },
      args: { kind, nodeId, volumeName },
      suggestedFilename: filename,
      open: async () => ({ filename, source: () => dockerService.exportVolume(nodeId, volumeName) }),
    };
  }

  const containerId = requiredToolString(args.containerId, 'containerId');
  // GET /containers/:id/archive holds docker:containers:export for the container.
  const inspected = await ensureDockerContainerScopes(
    dockerService,
    user,
    ['docker:containers:export'],
    nodeId,
    containerId
  );
  // LICENSE ENFORCEMENT: Archive operations are Personal entitlements under the project license/TOS.
  await container.resolve(LicensePolicyService).requireFeature('container-export');
  const query = ContainerArchiveExportQuerySchema.parse({
    imageMode: args.imageMode,
    includeWritableLayer: args.includeWritableLayer,
    includeEnvironment: args.includeEnvironment,
    includeSecrets: args.includeSecrets,
  });
  // Refused before a transfer slot, spool directory or one-time link exists; the shared export re-checks it.
  assertDockerContainerArchiveExportAllowed(nodeId, containerId, inspected);
  assertDockerContainerArchiveContentAccess(nodeId, inspected, query, user.scopes);
  return {
    access: {
      kind,
      nodeId,
      resourceId: String(inspected?.scopeResourceId ?? ''),
      scopes: [
        'docker:containers:export',
        ...(query.imageMode === 'portable' ? ['docker:containers:files:read'] : []),
        ...(query.includeEnvironment ? ['docker:containers:environment'] : []),
        ...(query.includeSecrets ? ['docker:containers:secrets'] : []),
      ],
    },
    args: { kind, nodeId, containerId, ...query },
    suggestedFilename: `${sanitizeFilename(String(inspected?.Name ?? containerId).replace(/^\/+/, '')) || 'container'}.ofca`,
    open: async () => {
      const archive = await openDockerContainerArchiveExport({
        nodeId,
        containerId,
        query,
        actorScopes: user.scopes,
        userId: user.id,
      });
      return { filename: archive.filename, source: async () => archive.stream };
    },
  };
}

/** Whether `user` still holds every scope the prepared export needed; a transfer never grants access. */
export function holdsDockerArchiveExportAccess(user: User, access: DockerArchiveExportAccess): boolean {
  return access.kind === 'container'
    ? access.scopes.every((scope) => hasDockerResourceScope(user.scopes, scope, access.nodeId, access.resourceId))
    : hasDockerResourceScope(user.scopes, 'docker:volumes:export', access.nodeId, access.volumeName);
}
