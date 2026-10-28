import { createHash, randomUUID } from 'node:crypto';

export const WEBHOOK_TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** SHA-256 (hex) of a webhook token; the only form of it that is stored. */
export function hashWebhookToken(token: string): string {
  return createHash('sha256').update(token.toLowerCase()).digest('hex');
}

/** A new webhook token and the hash to store. The token is returned to the caller once and never kept. */
export function issueWebhookToken(): { token: string; tokenHash: string } {
  const token = randomUUID();
  return { token, tokenHash: hashWebhookToken(token) };
}

/**
 * A webhook as callers see it: the stored hash never leaves the service, and `token` is set only for the response
 * of the call that issued it (enable or regenerate); every other read has `token: null`.
 */
export function presentWebhook<T extends { token?: string | null; tokenHash?: string | null }>(
  row: T,
  issuedToken: string | null = null
): Omit<T, 'token' | 'tokenHash'> & { token: string | null } {
  const { token: _legacyToken, tokenHash: _tokenHash, ...rest } = row;
  return { ...rest, token: issuedToken };
}
