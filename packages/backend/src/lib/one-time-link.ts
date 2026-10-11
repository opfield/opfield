import { createHash, randomBytes } from 'node:crypto';
import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { CacheService } from '@/services/cache.service.js';

/**
 * One-time links let an agent move file bytes from its shell with curl instead
 * of carrying base64 through tool calls. A link is a random token under a
 * public path; the grant it stands for is cached under the token's hash, expires
 * with the link and is taken by the first request, whatever its outcome.
 */

export interface OneTimeLinkKind {
  /** Route prefix the token is appended to. */
  path: string;
  /** Token prefix; letters, digits and `_` only. */
  tokenPrefix: string;
  /** Cache namespace of the grants. */
  cachePrefix: string;
  ttlSeconds: number;
  /** Plural name used in errors, for example "Pages upload links". */
  label: string;
}

function cacheKey(kind: OneTimeLinkKind, token: string): string {
  return `${kind.cachePrefix}${createHash('sha256').update(token).digest('hex')}`;
}

/** Stores `grant` behind a new one-time token and returns the public URL of the link. */
export async function issueOneTimeLink<T>(
  kind: OneTimeLinkKind,
  grant: T
): Promise<{ url: string; expiresAt: string }> {
  const publicUrl = await container.resolve(GeneralSettingsService).getPublicUrl();
  if (!publicUrl) {
    throw new AppError(409, 'PUBLIC_URL_REQUIRED', `Set the Opfield public URL before creating ${kind.label}`);
  }
  const token = `${kind.tokenPrefix}${randomBytes(32).toString('base64url')}`;
  await container.resolve(CacheService).set(cacheKey(kind, token), grant, kind.ttlSeconds);
  return {
    url: new URL(`${kind.path}/${token}`, publicUrl).href,
    expiresAt: new Date(Date.now() + kind.ttlSeconds * 1000).toISOString(),
  };
}

/** Takes the grant of a link once; null for a malformed, expired or already used token. */
export async function takeOneTimeLink<T>(kind: OneTimeLinkKind, token: string): Promise<T | null> {
  if (!new RegExp(`^${kind.tokenPrefix}[A-Za-z0-9_-]{43}$`).test(token)) return null;
  return container.resolve(CacheService).take<T>(cacheKey(kind, token));
}

/** Quotes a value for a POSIX shell command line. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
