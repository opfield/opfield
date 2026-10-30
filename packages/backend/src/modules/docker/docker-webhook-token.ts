import { createHash, randomUUID } from 'node:crypto';
import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { CryptoService } from '@/services/crypto.service.js';

const logger = createChildLogger('DockerWebhookToken');

export const WEBHOOK_TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** SHA-256 (hex) of a webhook token; incoming webhook calls are matched by it. */
export function hashWebhookToken(token: string): string {
  return createHash('sha256').update(token.toLowerCase()).digest('hex');
}

/**
 * The stored form of a webhook token: its hash, which incoming calls are matched by, and the token encrypted with the
 * installation's secret key, so the URL can be shown again. The plaintext column stays empty.
 */
export function sealWebhookToken(token: string): { token: null; tokenHash: string; tokenEncrypted: string } {
  const normalized = token.toLowerCase();
  return {
    token: null,
    tokenHash: hashWebhookToken(normalized),
    tokenEncrypted: JSON.stringify(container.resolve(CryptoService).encryptString(normalized)),
  };
}

/** A new webhook token and the columns to store for it. */
export function issueWebhookToken(): { token: string; stored: ReturnType<typeof sealWebhookToken> } {
  const token = randomUUID();
  return { token, stored: sealWebhookToken(token) };
}

type StoredWebhookToken = { token?: string | null; tokenHash?: string | null; tokenEncrypted?: string | null };

/** The token of a stored webhook, or null when it was not kept (only its hash is stored). */
export function revealWebhookToken(row: StoredWebhookToken): string | null {
  if (row.tokenEncrypted) {
    try {
      return container.resolve(CryptoService).decryptString(JSON.parse(row.tokenEncrypted));
    } catch (error) {
      logger.warn('Webhook token cannot be decrypted', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
  // A row written by a path that stores the token in the clear (a deployment webhook issued by the commercial module).
  return row.token ?? null;
}

/**
 * A webhook as callers see it: the stored hash and ciphertext never leave the server. `token` is the token of the URL;
 * `tokenLost` is true for a webhook whose token only exists as a hash (2.13.0 kept no other copy), whose URL still
 * works but can only be shown again by regenerating it.
 */
export function presentWebhook<T extends StoredWebhookToken>(
  row: T,
  options: { reveal?: boolean } = {}
): Omit<T, 'token' | 'tokenHash' | 'tokenEncrypted'> & { token: string | null; tokenLost: boolean } {
  const { token: _token, tokenHash: _tokenHash, tokenEncrypted: _tokenEncrypted, ...rest } = row;
  const token = options.reveal === false ? null : revealWebhookToken(row);
  const tokenLost = !row.tokenEncrypted && !row.token && !!row.tokenHash;
  return { ...rest, token, tokenLost };
}
