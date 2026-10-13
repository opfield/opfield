import { z } from 'zod';
import { AppError } from '@/middleware/error-handler.js';
import { ipInCidr, isValidCidr, normalizeIp } from './ip-cidr.js';

/** Most addresses or CIDR ranges one token (or OAuth grant) may be limited to. */
export const MAX_TOKEN_ALLOWED_IPS = 20;

/** An IPv4/IPv6 address or CIDR range in its stored form ("203.0.113.10", "10.0.0.0/8"), or null. */
export function canonicalAllowedIp(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parts = trimmed.split('/');
  if (parts.length > 2) return null;
  const address = normalizeIp(parts[0]);
  if (!address) return null;
  if (parts.length === 1) return address;
  const bitsRaw = parts[1]!;
  if (!/^\d{1,3}$/.test(bitsRaw)) return null;
  const cidr = `${address}/${Number(bitsRaw)}`;
  return isValidCidr(cidr) ? cidr : null;
}

/** Allowed addresses of a token: up to 20 IPv4/IPv6 addresses or CIDR ranges; an empty list allows any address. */
export const TokenAllowedIpsSchema = z
  .array(z.string().trim().min(1).max(64))
  .max(MAX_TOKEN_ALLOWED_IPS, `Up to ${MAX_TOKEN_ALLOWED_IPS} addresses`)
  .refine((values) => values.every((value) => canonicalAllowedIp(value) !== null), {
    message: 'Every entry must be an IPv4 or IPv6 address or CIDR range',
  })
  .describe('IPv4/IPv6 addresses or CIDR ranges the token works from (up to 20). An empty list allows any address.');

/** An expiry moment: an ISO 8601 date-time in the future, or null for no expiry. */
export const TokenExpiresAtSchema = z
  .string()
  .datetime({ offset: true })
  .nullable()
  .describe('When the token stops working (ISO 8601 date-time in the future); null for no expiry.');

/** The stored list: canonical, without duplicates. Throws 400 on an invalid entry or too many. */
export function normalizeAllowedIps(values: readonly string[] | undefined | null): string[] {
  const result: string[] = [];
  for (const value of values ?? []) {
    const canonical = canonicalAllowedIp(value);
    if (!canonical) {
      throw new AppError(400, 'INVALID_ALLOWED_IP', `${value} is not an IP address or CIDR range`);
    }
    if (!result.includes(canonical)) result.push(canonical);
  }
  if (result.length > MAX_TOKEN_ALLOWED_IPS) {
    throw new AppError(400, 'INVALID_ALLOWED_IP', `Up to ${MAX_TOKEN_ALLOWED_IPS} addresses`);
  }
  return result;
}

/** The parsed expiry of a request (undefined stays undefined); a moment that has already passed is refused. */
export function parseTokenExpiry(value: string | null | undefined, now = new Date()): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw new AppError(400, 'INVALID_EXPIRY', 'expiresAt is not a date');
  if (at.getTime() <= now.getTime()) throw new AppError(400, 'INVALID_EXPIRY', 'expiresAt must be in the future');
  return at;
}

export function isTokenExpired(expiresAt: Date | null | undefined, now = Date.now()): boolean {
  return Boolean(expiresAt) && expiresAt!.getTime() <= now;
}

/**
 * Whether a request from `clientIp` may use a token limited to `allowedIps`. An empty list allows any address; with a
 * list, a request whose client address is unknown is refused.
 */
export function isClientIpAllowed(allowedIps: readonly string[] | null | undefined, clientIp: string | undefined) {
  if (!allowedIps || allowedIps.length === 0) return true;
  const ip = normalizeIp(clientIp);
  if (!ip) return false;
  return allowedIps.some((entry) => (entry.includes('/') ? ipInCidr(ip, entry) : normalizeIp(entry) === ip));
}

/** What a token check needs to know about the request. */
export interface TokenRequestContext {
  /** The client address as resolved for audit (trusted proxies only); see lib/request-ip.ts. */
  clientIp?: string;
}
