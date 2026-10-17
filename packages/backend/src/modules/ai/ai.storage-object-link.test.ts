import 'reflect-metadata';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { ObjectStorageService } from '@/modules/object-storage/object-storage.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { CacheService } from '@/services/cache.service.js';
import type { User } from '@/types.js';
import { createStorageObjectDownloadLink } from './ai.storage-object-link.js';
import { storageObjectLinkRoutes } from './ai.storage-object-link.routes.js';

const STORAGE = '33333333-3333-4333-8333-333333333333';
const READ = `storage:objects:read:${STORAGE}`;
const CONTENT = Buffer.alloc(3 * 1024 * 1024, 7);
const ARGS = { storageId: STORAGE, bucket: 'exports', key: 'reports/2026/q3 report.bin' };

const app = new Hono().route('/', storageObjectLinkRoutes);
app.onError((error, c) => {
  const { statusCode = 500, code } = error as AppError;
  return c.json({ code }, statusCode as 403);
});

afterEach(() => container.reset());

function userWith(scopes: string[]): User {
  return { id: 'user-1', isBlocked: false, scopes } as User;
}

function registerServices(owner: User) {
  const cache = new Map<string, unknown>();
  const set = vi.fn(async (key: string, value: unknown) => void cache.set(key, value));
  container.registerInstance(CacheService, {
    set,
    take: vi.fn(async (key: string) => {
      const value = cache.get(key) ?? null;
      cache.delete(key);
      return value;
    }),
  } as unknown as CacheService);
  container.registerInstance(GeneralSettingsService, {
    getPublicUrl: vi.fn().mockResolvedValue('https://opfield.example'),
  } as unknown as GeneralSettingsService);
  const getUserById = vi.fn().mockResolvedValue(owner);
  container.registerInstance(AuthService, { getUserById } as unknown as AuthService);
  const storage = {
    headObject: vi
      .fn()
      .mockResolvedValue({ contentLength: CONTENT.byteLength, contentType: 'application/octet-stream' }),
    getObjectStream: vi.fn(async () => ({
      body: Readable.from([CONTENT]),
      contentType: 'application/octet-stream',
      contentLength: CONTENT.byteLength,
    })),
  };
  container.registerInstance(ObjectStorageService, storage as unknown as ObjectStorageService);
  return { storage, set, getUserById };
}

function linkPath(url: string): string {
  return new URL(url).pathname.replace('/api/storage-object-link', '');
}

describe('download_storage_object link', () => {
  it('streams an object larger than read_object allows, once', async () => {
    const user = userWith([READ]);
    const { storage } = registerServices(user);

    const link = await createStorageObjectDownloadLink(user, ARGS);
    expect(link).toMatchObject({ method: 'GET', sizeBytes: CONTENT.byteLength, filename: 'q3 report.bin' });
    expect(link.downloadUrl).toMatch(/^https:\/\/gateway\.example\/api\/storage-object-link\/opfsd_/);
    expect(link.commands.download).toBe(`curl -fsS -o 'q3 report.bin' '${link.downloadUrl}'`);
    expect(storage.headObject).toHaveBeenCalledWith(STORAGE, 'exports', 'reports/2026/q3 report.bin');

    // A probe does not use up the link.
    expect((await app.request(linkPath(link.downloadUrl), { method: 'HEAD' })).status).toBe(405);

    const response = await app.request(linkPath(link.downloadUrl));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(CONTENT.byteLength));
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="q3 report.bin"; filename*=UTF-8''q3%20report.bin`
    );
    expect(Buffer.from(await response.arrayBuffer()).equals(CONTENT)).toBe(true);

    const again = await app.request(linkPath(link.downloadUrl));
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ code: 'STORAGE_DOWNLOAD_LINK_INVALID' });
  });

  it('needs storage:objects:read on the connection to make a link', async () => {
    const user = userWith(['storage:objects:read:44444444-4444-4444-8444-444444444444']);
    const { storage, set } = registerServices(user);

    await expect(createStorageObjectDownloadLink(user, ARGS)).rejects.toMatchObject({
      statusCode: 403,
      message: `Missing required scope: ${READ}`,
    });
    expect(storage.headObject).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('makes no link for a missing object', async () => {
    const user = userWith([READ]);
    const { storage, set } = registerServices(user);
    storage.headObject.mockRejectedValue(new AppError(404, 'STORAGE_NOT_FOUND', 'The bucket or object does not exist'));

    await expect(createStorageObjectDownloadLink(user, ARGS)).rejects.toMatchObject({ code: 'STORAGE_NOT_FOUND' });
    expect(set).not.toHaveBeenCalled();
  });

  it('checks the owner grants again when the link is used', async () => {
    const user = userWith([READ]);
    const { storage, getUserById } = registerServices(user);
    const link = await createStorageObjectDownloadLink(user, ARGS);
    getUserById.mockResolvedValue(userWith([]));

    const response = await app.request(linkPath(link.downloadUrl));
    expect(response.status).toBe(403);
    expect(storage.getObjectStream).not.toHaveBeenCalled();
  });
});
