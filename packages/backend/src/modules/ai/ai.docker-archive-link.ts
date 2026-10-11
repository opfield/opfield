import type { z } from 'zod';
import { container } from '@/container.js';
import { issueOneTimeLink, type OneTimeLinkKind, shellQuote, takeOneTimeLink } from '@/lib/one-time-link.js';
import { boundScopes } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { DockerManagementService } from '@/modules/docker/docker.service.js';
import { importDockerContainerArchive } from '@/modules/docker/docker-container-archive-operations.js';
import type { User } from '@/types.js';
import { prepareDockerArchiveExport } from './ai.docker-archive-export.js';
import {
  ARCHIVE_MAX_BYTES,
  assertArchiveImportAccess,
  assertArchiveResolutionSize,
  UploadBeginSchema,
} from './ai.docker-archive-transfer.js';

/**
 * One-time links for MCP archive transfer: an agent's shell streams a .gwca
 * archive to import with `curl -T`, or saves an export with `curl -o`, instead
 * of carrying base64 chunks through tool calls. A link is bound to its owner,
 * the MCP token scopes and the exact import target or export it was made for;
 * using it repeats the route checks with those scopes bounded by the owner's
 * current grants. Bytes stream straight between curl and the node through the
 * shared import/export operations, which abort and roll back on a cut stream.
 */

export const DOCKER_ARCHIVE_LINK_PATH = '/api/docker-archive-link';
const LINK_TTL_SECONDS = 15 * 60;
const UPLOAD_LINK: OneTimeLinkKind = {
  path: DOCKER_ARCHIVE_LINK_PATH,
  tokenPrefix: 'gwau_',
  cachePrefix: 'docker:archive-upload-link:',
  ttlSeconds: LINK_TTL_SECONDS,
  label: 'archive upload links',
};
const DOWNLOAD_LINK: OneTimeLinkKind = {
  ...UPLOAD_LINK,
  tokenPrefix: 'gwad_',
  cachePrefix: 'docker:archive-download-link:',
  label: 'archive download links',
};

const UploadLinkSchema = UploadBeginSchema.omit({ declaredSizeBytes: true, sha256: true });
type UploadLinkTarget = z.infer<typeof UploadLinkSchema>;

interface ArchiveLinkGrant<T> {
  userId: string;
  /** Scopes of the MCP call that made the link. */
  scopes: string[];
  target: T;
}

function linkInvalid(): AppError {
  return new AppError(404, 'DOCKER_ARCHIVE_LINK_INVALID', 'Archive link is invalid, expired or already used');
}

/** The link owner with the link's scopes bounded by their current grants. */
async function linkOwner(grant: ArchiveLinkGrant<unknown>): Promise<User> {
  const owner = await container.resolve(AuthService).getUserById(grant.userId);
  if (!owner || owner.isBlocked) throw new AppError(403, 'FORBIDDEN', 'The owner of this link can no longer use it');
  return { ...owner, scopes: boundScopes(grant.scopes, owner.scopes) };
}

/** The Docker tool access helpers report a missing scope as a plain PERMISSION_DENIED error. */
async function withRouteErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof AppError) && error instanceof Error && error.message.startsWith('PERMISSION_DENIED')) {
      throw new AppError(403, 'FORBIDDEN', error.message.replace(/^PERMISSION_DENIED:\s*/, ''));
    }
    throw error;
  }
}

/** Passes the body through unchanged and errors it once more than `maxBytes` arrive. */
export function limitArchiveBody(body: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  let size = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > maxBytes) {
          controller.error(new AppError(413, 'DOCKER_ARCHIVE_TOO_LARGE', 'Archive exceeds the MCP transfer limit'));
          return;
        }
        controller.enqueue(chunk);
      },
    })
  );
}

/** upload_docker_container_archive link: the same checks as begin, then a one-time import URL. */
export async function createDockerArchiveUploadLink(user: User, args: Record<string, unknown>) {
  const target = UploadLinkSchema.parse(args);
  assertArchiveResolutionSize(target.resolution);
  await assertArchiveImportAccess(user, target.nodeId, target.folderId);
  const grant: ArchiveLinkGrant<UploadLinkTarget> = { userId: user.id, scopes: user.scopes, target };
  const { url, expiresAt } = await issueOneTimeLink(UPLOAD_LINK, grant);
  return {
    uploadUrl: url,
    method: 'PUT',
    expiresAt,
    maxBytes: ARCHIVE_MAX_BYTES,
    nodeId: target.nodeId,
    name: target.name,
    commands: { file: `curl -sS --fail-with-body -T container.gwca ${shellQuote(url)}` },
    usage:
      'Run the command from a shell that has the archive (replace container.gwca with its path). Only an Opfield container archive (.gwca) is accepted, not a folder or a plain tar. The link works once: the response is { data: { container } } with the new, stopped container. A failed or interrupted transfer imports nothing; create a new link to retry.',
  };
}

/** Streams the body of a one-time upload link into the shared container archive import. */
export async function importDockerArchiveUploadLink(token: string, body: ReadableStream<Uint8Array> | null) {
  const grant = await takeOneTimeLink<ArchiveLinkGrant<UploadLinkTarget>>(UPLOAD_LINK, token);
  if (!grant) throw linkInvalid();
  const user = await linkOwner(grant);
  const { target } = grant;
  // POST /containers/archive entry checks, with the current grants, before anything reaches the node.
  await assertArchiveImportAccess(user, target.nodeId, target.folderId);
  if (!body) throw new AppError(400, 'GWCA_EMPTY', 'Container archive body is required');
  const imported = await importDockerContainerArchive({
    nodeId: target.nodeId,
    name: target.name,
    folderId: target.folderId,
    resolution: target.resolution,
    body: limitArchiveBody(body, ARCHIVE_MAX_BYTES),
    actorScopes: user.scopes,
    userId: user.id,
  });
  return { container: imported };
}

/** download_docker_archive link: the same checks as begin, then a one-time download URL. */
export async function createDockerArchiveDownloadLink(
  dockerService: DockerManagementService,
  user: User,
  args: Record<string, unknown>
) {
  const prepared = await prepareDockerArchiveExport(dockerService, user, args);
  const grant: ArchiveLinkGrant<Record<string, unknown>> = {
    userId: user.id,
    scopes: user.scopes,
    target: prepared.args,
  };
  const { url, expiresAt } = await issueOneTimeLink(DOWNLOAD_LINK, grant);
  const filename = prepared.suggestedFilename;
  return {
    downloadUrl: url,
    method: 'GET',
    expiresAt,
    kind: prepared.access.kind,
    nodeId: prepared.access.nodeId,
    filename,
    commands: { download: `curl -fsS -o ${shellQuote(filename)} ${shellQuote(url)}` },
    usage:
      'Run the command from the shell that should keep the archive. The link works once and streams the archive from the node. If curl exits non-zero the file is incomplete: delete it and create a new link. An archive that includes secrets is itself a secret.',
  };
}

/** Streams the archive of a one-time download link from the node. */
export async function openDockerArchiveDownloadLink(token: string): Promise<Response> {
  const grant = await takeOneTimeLink<ArchiveLinkGrant<Record<string, unknown>>>(DOWNLOAD_LINK, token);
  if (!grant) throw linkInvalid();
  const user = await linkOwner(grant);
  const dockerService = container.resolve(DockerManagementService);
  const prepared = await withRouteErrors(() => prepareDockerArchiveExport(dockerService, user, grant.target));
  const archive = await prepared.open();
  const data = await archive.source();
  return new Response(Buffer.isBuffer(data) ? new Uint8Array(data) : data, {
    headers: {
      'Content-Type': prepared.access.kind === 'container' ? 'application/vnd.wiolett.gwca' : 'application/gzip',
      'Content-Disposition': `attachment; filename="${archive.filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
