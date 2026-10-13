import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { z } from 'zod';
import { container } from '@/container.js';
import { issueOneTimeLink, type OneTimeLinkKind, shellQuote, takeOneTimeLink } from '@/lib/one-time-link.js';
import { hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { User } from '@/types.js';
import { CreatePageDeploymentSchema } from '../deployments/page-deployment.schemas.js';
import {
  PAGE_UPLOAD_CHUNK_MAX_BYTES,
  PageDeploymentService,
  type PageDeployPrincipal,
} from '../deployments/page-deployment.service.js';
import { resolvePageDeploymentExpiry } from '../deployments/page-deployment-expiry.js';
import { PageProjectService } from '../page-project.service.js';
import { PageProfileService } from '../profile/page-profile.service.js';
import { PagePublicationService } from '../tags/page-publication.service.js';

/**
 * One-time upload links let an agent stream an artifact from its shell
 * (`curl --data-binary`) instead of carrying base64 through tool calls. The
 * link carries the Deployment options; the bytes are spooled, measured and
 * hashed here, and only a complete body becomes a Deployment, so an aborted
 * transfer leaves nothing behind.
 */

export const PAGE_UPLOAD_LINK_PATH = '/api/pages-upload';
const UPLOAD_LINK: OneTimeLinkKind = {
  path: PAGE_UPLOAD_LINK_PATH,
  tokenPrefix: 'opfpu_',
  cachePrefix: 'pages:upload-link:',
  ttlSeconds: 15 * 60,
  label: 'Pages upload links',
};
/** Finalize waits at most this long for the preview links to be served before returning `pending`. */
export const PAGE_LINK_WAIT_MS = 15_000;

export const CreatePageUploadLinkSchema = CreatePageDeploymentSchema.omit({
  declaredSizeBytes: true,
  sha256: true,
  idempotencyKey: true,
}).extend({
  /** Optional: when given, the streamed bytes must match it. */
  sha256: CreatePageDeploymentSchema.shape.sha256.optional(),
});
type PageUploadLinkInput = z.infer<typeof CreatePageUploadLinkSchema>;

interface PageUploadLinkGrant {
  userId: string;
  scopes: string[];
  input: PageUploadLinkInput;
}

/** Issues a one-time upload URL for `user`; the caller has checked pages:deploy on the Project. */
export async function createPageUploadLink(user: User, args: Record<string, unknown>) {
  const input = CreatePageUploadLinkSchema.parse(args);
  resolvePageDeploymentExpiry(input);
  await container.resolve(PageProjectService).get(input.projectId);
  const grant: PageUploadLinkGrant = { userId: user.id, scopes: user.scopes, input };
  const { url: uploadUrl, expiresAt } = await issueOneTimeLink(UPLOAD_LINK, grant);
  const curl = `curl -sS --fail-with-body -X PUT --data-binary`;
  return {
    uploadUrl,
    method: 'PUT',
    expiresAt,
    maxBytes: (await container.resolve(GeneralSettingsService).getConfig()).fileUploadMaxBytes,
    commands: {
      archive: `${curl} @site.tar.gz ${shellQuote(uploadUrl)}`,
      folder: `COPYFILE_DISABLE=1 tar czf - -C dist . | ${curl} @- ${shellQuote(uploadUrl)}`,
      html: `${curl} @index.html ${shellQuote(uploadUrl)}`,
    },
    usage:
      'Run one command from a shell that has the file (replace site.tar.gz, dist or index.html with your path). The link works once: the response is the finalized Deployment with its preview links. If the upload or validation fails, create a new link.',
  };
}

/** Streams the body of a one-time upload link into a new Deployment, then publishes it. */
export async function publishPageUploadLink(token: string, body: ReadableStream<Uint8Array> | null) {
  const grant = await takeOneTimeLink<PageUploadLinkGrant>(UPLOAD_LINK, token);
  if (!grant) {
    throw new AppError(404, 'PAGES_UPLOAD_LINK_INVALID', 'Upload link is invalid, expired or already used');
  }
  const { input } = grant;
  await container.resolve(LicensePolicyService).requireFeature('pages');
  await container.resolve(PageProfileService).requireEnabled();
  const user = await container.resolve(AuthService).getUserById(grant.userId);
  if (
    !user ||
    user.isBlocked ||
    !hasScopeForResource(user.scopes, 'pages:deploy', input.projectId) ||
    !hasScopeForResource(grant.scopes, 'pages:deploy', input.projectId)
  ) {
    throw new AppError(403, 'PAGE_DEPLOY_FORBIDDEN', 'Missing pages:deploy for this Project');
  }
  if (!body) throw new AppError(400, 'PAGES_UPLOAD_EMPTY', 'Send the artifact bytes as the request body');

  const maxBytes = (await container.resolve(GeneralSettingsService).getConfig()).fileUploadMaxBytes;
  const directory = await mkdtemp(join(tmpdir(), 'opfield-pages-link-'));
  const file = join(directory, 'artifact');
  try {
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.byteLength;
        if (size > maxBytes) {
          callback(
            new AppError(
              413,
              'PAGES_ARTIFACT_TOO_LARGE',
              `Artifact exceeds the Opfield file-upload limit (${maxBytes} bytes)`
            )
          );
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(body as never), meter, createWriteStream(file, { mode: 0o600 }));
    if (size === 0) throw new AppError(400, 'PAGES_UPLOAD_EMPTY', 'Send the artifact bytes as the request body');
    const sha256 = hash.digest('hex');
    if (input.sha256 && input.sha256 !== sha256) {
      throw new AppError(400, 'PAGES_UPLOAD_CHECKSUM_MISMATCH', 'Artifact SHA-256 does not match the upload link');
    }

    const principal: PageDeployPrincipal = { kind: 'user', userId: user.id, scopes: grant.scopes };
    const deployments = container.resolve(PageDeploymentService);
    const created = await deployments.create({ ...input, declaredSizeBytes: size, sha256 }, principal);
    if (!created.upload) throw new AppError(500, 'PAGES_UPLOAD_MISSING', 'Deployment upload session is unavailable');
    const uploadId = created.upload.id;
    try {
      await appendSpooledFile(file, uploadId, created.upload.offset, principal);
    } catch (error) {
      // Nothing was stored yet: cancelling deletes the Deployment with its partial bytes.
      await deployments.cancelUpload(uploadId, principal).catch(() => undefined);
      throw error;
    }
    const stored = await deployments.finalize(uploadId, principal);
    return publishStoredDeployment(stored.deployment.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function appendSpooledFile(file: string, uploadId: string, offset: number, principal: PageDeployPrincipal) {
  const deployments = container.resolve(PageDeploymentService);
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(PAGE_UPLOAD_CHUNK_MAX_BYTES);
    let position = offset;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) return;
      position = (await deployments.appendChunk(uploadId, position, buffer.subarray(0, bytesRead), principal)).offset;
    }
  } finally {
    await handle.close();
  }
}

/** Publishes a stored Deployment and returns it with its preview links, as upload finalize does. */
export async function publishStoredDeployment(deploymentId: string) {
  const deployments = container.resolve(PageDeploymentService);
  await container.resolve(PagePublicationService).markDeploymentReady(deploymentId);
  const links = await deployments.publicationLinks(deploymentId, { waitMs: PAGE_LINK_WAIT_MS });
  return { deployment: await deployments.get(deploymentId), links };
}
