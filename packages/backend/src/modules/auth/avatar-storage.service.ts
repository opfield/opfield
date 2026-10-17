import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { and, eq, like } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { users } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';

const logger = createChildLogger('AvatarStorageService');
const PRODUCTION_STORAGE_DIR = '/var/lib/opfield/avatars';
const AVATAR_URL_PREFIX = '/auth/avatars/';
const AVATAR_FILE = /^[0-9a-f-]{36}\.(png|jpe?g|webp)$/i;

export const MAX_AVATAR_UPLOAD_BYTES = 1024 * 1024;
export const AVATAR_UPLOAD_BODY_MAX_BYTES = MAX_AVATAR_UPLOAD_BYTES + 256 * 1024;

type AvatarMediaType = 'image/png' | 'image/jpeg' | 'image/webp';

interface AvatarAsset {
  bytes: Buffer;
  mediaType: AvatarMediaType;
}

export function resolveAvatarStorageDir(nodeEnvironment: string | undefined, temporaryDirectory = os.tmpdir()): string {
  return nodeEnvironment === 'production' ? PRODUCTION_STORAGE_DIR : join(temporaryDirectory, 'opfield-avatars');
}

export function isStoredAvatarUrl(value: string | null | undefined): boolean {
  return value?.startsWith(AVATAR_URL_PREFIX) === true;
}

function detectAvatarMediaType(bytes: Buffer): AvatarMediaType | null {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    bytes.includes(Buffer.from('IEND'))
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  ) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 20 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function extensionFor(mediaType: AvatarMediaType): string {
  return mediaType === 'image/png' ? 'png' : mediaType === 'image/jpeg' ? 'jpg' : 'webp';
}

/** What the image is, for error messages: user avatars and app logos share this storage. */
export type StoredImageSubject = 'Avatar' | 'Logo';

function assertAvatarBytes(
  bytes: Buffer,
  declaredMediaType?: string,
  subject: StoredImageSubject = 'Avatar'
): AvatarMediaType {
  if (bytes.length === 0) throw new AppError(400, 'AVATAR_EMPTY', `${subject} image is empty`);
  if (bytes.length > MAX_AVATAR_UPLOAD_BYTES) {
    throw new AppError(413, 'AVATAR_TOO_LARGE', `${subject} image must be 1 MiB or smaller`);
  }
  const detected = detectAvatarMediaType(bytes);
  if (!detected) {
    throw new AppError(400, 'AVATAR_FORMAT_INVALID', `${subject} must be a valid PNG, JPEG, or WebP image`);
  }
  if (declaredMediaType && declaredMediaType !== detected) {
    throw new AppError(400, 'AVATAR_MEDIA_TYPE_MISMATCH', `${subject} media type does not match the file contents`);
  }
  return detected;
}

function decodeLegacyDataUrl(value: string): { bytes: Buffer; mediaType: AvatarMediaType } | null {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) return null;
  const bytes = Buffer.from(match[2], 'base64');
  const mediaType = assertAvatarBytes(bytes, match[1]);
  return { bytes, mediaType };
}

export class AvatarStorageService {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  async store(file: File, subject: StoredImageSubject = 'Avatar'): Promise<string> {
    const bytes = Buffer.from(await file.arrayBuffer());
    const mediaType = assertAvatarBytes(bytes, file.type, subject);
    return this.storeBytes(bytes, mediaType);
  }

  async read(filename: string): Promise<AvatarAsset> {
    const match = AVATAR_FILE.exec(filename);
    if (!match) throw new AppError(404, 'AVATAR_NOT_FOUND', 'Avatar not found');
    try {
      const bytes = await readFile(join(this.root, filename));
      const mediaType =
        match[1].toLowerCase() === 'png'
          ? 'image/png'
          : match[1].toLowerCase() === 'webp'
            ? 'image/webp'
            : 'image/jpeg';
      return { bytes, mediaType };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AppError(404, 'AVATAR_NOT_FOUND', 'Avatar not found');
      }
      throw error;
    }
  }

  async removeByUrl(avatarUrl: string | null | undefined): Promise<void> {
    if (!avatarUrl || !isStoredAvatarUrl(avatarUrl)) return;
    const filename = avatarUrl.slice(AVATAR_URL_PREFIX.length);
    if (!AVATAR_FILE.test(filename)) return;
    await rm(join(this.root, filename), { force: true });
  }

  async migrateLegacyDataUrls(db: DrizzleClient): Promise<number> {
    const legacyUsers = await db
      .select({ id: users.id, avatarUrl: users.avatarUrl })
      .from(users)
      .where(like(users.avatarUrl, 'data:image/%'));
    let migrated = 0;
    for (const user of legacyUsers) {
      if (!user.avatarUrl) continue;
      try {
        const decoded = decodeLegacyDataUrl(user.avatarUrl);
        if (!decoded) continue;
        const nextUrl = await this.storeBytes(decoded.bytes, decoded.mediaType);
        const updated = await db
          .update(users)
          .set({ avatarUrl: nextUrl, updatedAt: new Date() })
          .where(and(eq(users.id, user.id), eq(users.avatarUrl, user.avatarUrl)))
          .returning({ id: users.id });
        if (updated.length === 0) {
          await this.removeByUrl(nextUrl);
          continue;
        }
        migrated += 1;
      } catch (error) {
        logger.warn('Failed to migrate legacy avatar data URL', { userId: user.id, error });
      }
    }
    if (migrated > 0) logger.info('Migrated legacy user avatars to file storage', { migrated });
    return migrated;
  }

  private async storeBytes(bytes: Buffer, mediaType: AvatarMediaType): Promise<string> {
    const filename = `${randomUUID()}.${extensionFor(mediaType)}`;
    const target = join(this.root, filename);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return `${AVATAR_URL_PREFIX}${filename}`;
  }
}
