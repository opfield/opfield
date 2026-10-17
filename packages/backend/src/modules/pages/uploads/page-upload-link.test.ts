import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { CacheService } from '@/services/cache.service.js';
import type { User } from '@/types.js';
import { PageDeploymentService } from '../deployments/page-deployment.service.js';
import { PageProjectService } from '../page-project.service.js';
import { PageProfileService } from '../profile/page-profile.service.js';
import { PagePublicationService } from '../tags/page-publication.service.js';
import { createPageUploadLink, publishPageUploadLink } from './page-upload-link.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const user = { id: 'user-1', isBlocked: false, scopes: [`pages:deploy:${PROJECT_ID}`] } as User;

function registerServices(maxBytes = 1024) {
  const cache = new Map<string, unknown>();
  container.registerInstance(CacheService, {
    set: vi.fn(async (key: string, value: unknown) => void cache.set(key, value)),
    take: vi.fn(async (key: string) => {
      const value = cache.get(key) ?? null;
      cache.delete(key);
      return value;
    }),
  } as unknown as CacheService);
  container.registerInstance(GeneralSettingsService, {
    getPublicUrl: vi.fn().mockResolvedValue('https://opfield.example'),
    getConfig: vi.fn().mockResolvedValue({ fileUploadMaxBytes: maxBytes }),
  } as unknown as GeneralSettingsService);
  container.registerInstance(PageProjectService, {
    get: vi.fn().mockResolvedValue({ id: PROJECT_ID }),
  } as unknown as PageProjectService);
  container.registerInstance(LicensePolicyService, {
    requireFeature: vi.fn().mockResolvedValue(undefined),
  } as unknown as LicensePolicyService);
  container.registerInstance(PageProfileService, {
    requireEnabled: vi.fn().mockResolvedValue(undefined),
  } as unknown as PageProfileService);
  container.registerInstance(AuthService, { getUserById: vi.fn().mockResolvedValue(user) } as unknown as AuthService);
  container.registerInstance(PagePublicationService, {
    markDeploymentReady: vi.fn().mockResolvedValue(undefined),
  } as unknown as PagePublicationService);
  const deployments = {
    create: vi.fn().mockResolvedValue({ deployment: { id: 'deployment-1' }, upload: { id: 'upload-1', offset: 0 } }),
    appendChunk: vi.fn(async (_id: string, offset: number, bytes: Uint8Array) => ({ offset: offset + bytes.length })),
    finalize: vi.fn().mockResolvedValue({ deployment: { id: 'deployment-1' } }),
    cancelUpload: vi.fn().mockResolvedValue({ cancelled: true }),
    publicationLinks: vi.fn().mockResolvedValue({ preview: { status: 'ready' }, tag: null, latest: null }),
    get: vi.fn().mockResolvedValue({ id: 'deployment-1', status: 'ready' }),
  };
  container.registerInstance(PageDeploymentService, deployments as unknown as PageDeploymentService);
  return deployments;
}

function body(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

async function linkToken(args: Record<string, unknown> = {}) {
  const link = await createPageUploadLink(user, { projectId: PROJECT_ID, tag: 'demo', ...args });
  expect(link.uploadUrl).toMatch(/^https:\/\/opfield\.example\/api\/pages-upload\/opfpu_/);
  expect(link.commands.folder).toContain(`tar czf - -C dist . | curl`);
  return link.uploadUrl.split('/').at(-1) as string;
}

afterEach(() => container.reset());

describe('Pages upload links', () => {
  it('turns one streamed body into a published Deployment and works only once', async () => {
    const deployments = registerServices();
    const token = await linkToken();
    const artifact = Buffer.from('artifact bytes');

    const result = await publishPageUploadLink(token, body(artifact));

    expect(deployments.create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        tag: 'demo',
        declaredSizeBytes: artifact.length,
        sha256: createHash('sha256').update(artifact).digest('hex'),
      }),
      expect.objectContaining({ kind: 'user', userId: 'user-1' })
    );
    expect(deployments.appendChunk).toHaveBeenCalledWith('upload-1', 0, expect.any(Buffer), expect.anything());
    expect(deployments.finalize).toHaveBeenCalledWith('upload-1', expect.anything());
    expect(result).toMatchObject({ deployment: { id: 'deployment-1', status: 'ready' } });
    await expect(publishPageUploadLink(token, body(artifact))).rejects.toMatchObject({
      code: 'PAGES_UPLOAD_LINK_INVALID',
    });
  });

  it('cancels the Deployment when its bytes cannot be stored', async () => {
    const deployments = registerServices();
    deployments.appendChunk.mockRejectedValueOnce(new Error('disk full'));
    const token = await linkToken();

    await expect(publishPageUploadLink(token, body(Buffer.from('artifact')))).rejects.toThrow('disk full');
    expect(deployments.cancelUpload).toHaveBeenCalledWith('upload-1', expect.anything());
    expect(deployments.finalize).not.toHaveBeenCalled();
  });

  it('refuses a body over the file-upload limit before creating a Deployment', async () => {
    const deployments = registerServices(4);
    const token = await linkToken();

    await expect(publishPageUploadLink(token, body(Buffer.from('too large')))).rejects.toMatchObject({
      code: 'PAGES_ARTIFACT_TOO_LARGE',
    });
    expect(deployments.create).not.toHaveBeenCalled();
  });
});
