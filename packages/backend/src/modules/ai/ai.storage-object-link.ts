import { Readable } from 'node:stream';
import { z } from 'zod';
import { container } from '@/container.js';
import { issueOneTimeLink, type OneTimeLinkKind, shellQuote, takeOneTimeLink } from '@/lib/one-time-link.js';
import { boundScopes, hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { ObjectMetadataQuerySchema } from '@/modules/object-storage/object-storage.schemas.js';
import { ObjectStorageService } from '@/modules/object-storage/object-storage.service.js';
import type { User } from '@/types.js';

/**
 * One-time download links for MCP: an agent's shell saves an object of any size with `curl -o`, where read_object
 * stops at 1 MiB and private managed storage refuses presigned URLs. A link is bound to its owner, the MCP token
 * scopes and one object; using it checks storage:objects:read again with those scopes bounded by the owner's
 * current grants, then streams the object through Gateway as GET /api/object-storage/{id}/objects/download does.
 */

export const STORAGE_OBJECT_LINK_PATH = '/api/storage-object-link';
const DOWNLOAD_LINK: OneTimeLinkKind = {
  path: STORAGE_OBJECT_LINK_PATH,
  tokenPrefix: 'opfsd_',
  cachePrefix: 'storage:object-download-link:',
  ttlSeconds: 15 * 60,
  label: 'storage download links',
};
const READ_SCOPE = 'storage:objects:read';

const DownloadLinkSchema = ObjectMetadataQuerySchema.extend({ storageId: z.string().uuid() });
type DownloadTarget = z.infer<typeof DownloadLinkSchema>;

interface StorageObjectLinkGrant {
  userId: string;
  /** Scopes of the MCP call that made the link. */
  scopes: string[];
  target: DownloadTarget;
}

function requireObjectRead(scopes: readonly string[], storageId: string): void {
  if (!hasScope(scopes, `${READ_SCOPE}:${storageId}`)) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${READ_SCOPE}:${storageId}`);
  }
}

/** The last segment of the key, safe as a file name and a header value; `download` when it has none. */
function objectFileName(key: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters would break the header and the shell command.
  const name = (key.split('/').pop() ?? '').replace(/[\u0000-\u001f\u007f"\\]/g, '');
  return name === '' || name === '.' || name === '..' || name === '-' ? 'download' : name;
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** download_storage_object: the object must exist and be readable; then a one-time download URL. */
export async function createStorageObjectDownloadLink(user: User, args: Record<string, unknown>) {
  const target = DownloadLinkSchema.parse(args);
  requireObjectRead(user.scopes, target.storageId);
  const metadata = await container
    .resolve(ObjectStorageService)
    .headObject(target.storageId, target.bucket, target.key);
  const grant: StorageObjectLinkGrant = { userId: user.id, scopes: user.scopes, target };
  const { url, expiresAt } = await issueOneTimeLink(DOWNLOAD_LINK, grant);
  const filename = objectFileName(target.key);
  return {
    downloadUrl: url,
    method: 'GET',
    expiresAt,
    storageId: target.storageId,
    bucket: target.bucket,
    key: target.key,
    sizeBytes: metadata.contentLength,
    contentType: metadata.contentType,
    filename,
    commands: { download: `curl -fsS -o ${shellQuote(filename)} ${shellQuote(url)}` },
    usage:
      'Run the command from the shell that should keep the object (change the file name if needed). The link works once and streams the object through Opfield. If curl exits non-zero the file is incomplete: delete it and create a new link.',
  };
}

/** Streams the object of a one-time download link. */
export async function openStorageObjectDownloadLink(token: string): Promise<Response> {
  const grant = await takeOneTimeLink<StorageObjectLinkGrant>(DOWNLOAD_LINK, token);
  if (!grant) {
    throw new AppError(404, 'STORAGE_DOWNLOAD_LINK_INVALID', 'Download link is invalid, expired or already used');
  }
  const owner = await container.resolve(AuthService).getUserById(grant.userId);
  if (!owner || owner.isBlocked) throw new AppError(403, 'FORBIDDEN', 'The owner of this link can no longer use it');
  const { storageId, bucket, key } = grant.target;
  requireObjectRead(boundScopes(grant.scopes, owner.scopes), storageId);
  const { body, contentType, contentLength } = await container
    .resolve(ObjectStorageService)
    .getObjectStream(storageId, bucket, key);
  const headers: Record<string, string> = {
    'Content-Type': contentType ?? 'application/octet-stream',
    'Content-Disposition': contentDisposition(objectFileName(key)),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (contentLength != null) headers['Content-Length'] = String(contentLength);
  return new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, { headers });
}
