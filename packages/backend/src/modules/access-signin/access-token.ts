import { createPublicKey, type KeyObject, sign, verify } from 'node:crypto';

// Access tokens (contract "Access token"): `v1.<payloadB64url>.<sigB64url>`, an Ed25519 signature over the ASCII
// bytes `opfield-access-v1.<payloadB64url>`. The nginx daemon verifies host tokens with the same rules; the backend
// verifies the central session cookie of the sign-in domain.

const TOKEN_VERSION = 'v1';
const SIGNING_PREFIX = 'opfield-access-v1.';

/** The signed-in identity a token carries (`idn`). */
export interface AccessTokenIdentity {
  /** AccessSignInMethod the visitor used. */
  m: string;
  sub: string;
  em?: string;
  nm?: string;
  grp?: string[];
  /** List id, for password, basic and shared identities. */
  lst?: string;
}

export interface AccessTokenPayload {
  kid: string;
  /** access_sessions.id */
  sid: string;
  /** Host the token is valid for: lowercase, no port. */
  aud: string;
  iat: number;
  exp: number;
  idn: AccessTokenIdentity;
  non?: string;
}

/** Lowercase host without port (IPv6 literals keep their brackets). */
export function normalizeAccessHost(host: string | null | undefined): string {
  const value = (host ?? '').trim().toLowerCase();
  if (!value) return '';
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? value : value.slice(0, end + 1);
  }
  const colon = value.indexOf(':');
  return (colon === -1 ? value : value.slice(0, colon)).replace(/\.$/, '');
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A strict lowercase DNS name (labels of a-z, 0-9 and inner hyphens, 1-63 characters, at most 253 in total): no port,
 * user info, path or fragment. Only such a host ever gets a token or a callback URL.
 */
export function isAccessHostName(host: string): boolean {
  if (!host || host.length > 253) return false;
  return host.split('.').every((label) => DNS_LABEL.test(label));
}

/** A KeyObject from a raw 32-byte Ed25519 public key. */
export function ed25519PublicKeyFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
}

/** The payload with its fields in contract order and without empty optional fields. */
function canonicalPayload(payload: AccessTokenPayload): AccessTokenPayload {
  const idn: AccessTokenIdentity = { m: payload.idn.m, sub: payload.idn.sub };
  if (payload.idn.em) idn.em = payload.idn.em;
  if (payload.idn.nm) idn.nm = payload.idn.nm;
  if (payload.idn.grp?.length) idn.grp = payload.idn.grp;
  if (payload.idn.lst) idn.lst = payload.idn.lst;
  const result: AccessTokenPayload = {
    kid: payload.kid,
    sid: payload.sid,
    aud: payload.aud,
    iat: payload.iat,
    exp: payload.exp,
    idn,
  };
  if (payload.non) result.non = payload.non;
  return result;
}

export function signAccessToken(payload: AccessTokenPayload, privateKey: KeyObject): string {
  const payloadB64 = Buffer.from(JSON.stringify(canonicalPayload(payload)), 'utf8').toString('base64url');
  const signature = sign(null, Buffer.from(`${SIGNING_PREFIX}${payloadB64}`, 'ascii'), privateKey);
  return `${TOKEN_VERSION}.${payloadB64}.${signature.toString('base64url')}`;
}

export interface VerifyAccessTokenOptions {
  /** Verification keys by key id. */
  keys: ReadonlyMap<string, KeyObject>;
  /** The request host; compared with aud after normalization. */
  host: string;
  /** Unix seconds. */
  now: number;
}

function isIdentity(value: unknown): value is AccessTokenIdentity {
  if (!value || typeof value !== 'object') return false;
  const idn = value as Record<string, unknown>;
  if (typeof idn.m !== 'string' || !idn.m || typeof idn.sub !== 'string') return false;
  if (idn.em !== undefined && typeof idn.em !== 'string') return false;
  if (idn.nm !== undefined && typeof idn.nm !== 'string') return false;
  if (idn.lst !== undefined && typeof idn.lst !== 'string') return false;
  if (idn.grp !== undefined && !(Array.isArray(idn.grp) && idn.grp.every((group) => typeof group === 'string'))) {
    return false;
  }
  return true;
}

/**
 * The payload of a valid token, else null: known kid, good signature, aud equal to the host, not expired. Revocation
 * of the session (sid) is the caller's check.
 */
export function verifyAccessToken(token: string, options: VerifyAccessTokenOptions): AccessTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION || !parts[1] || !parts[2]) return null;
  const [, payloadB64, signatureB64] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(payloadB64) || !/^[A-Za-z0-9_-]+$/.test(signatureB64)) return null;
  let payload: AccessTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || typeof payload.kid !== 'string') return null;
  const key = options.keys.get(payload.kid);
  if (!key) return null;
  const signature = Buffer.from(signatureB64, 'base64url');
  if (signature.length !== 64) return null;
  if (!verify(null, Buffer.from(`${SIGNING_PREFIX}${payloadB64}`, 'ascii'), key, signature)) return null;
  if (typeof payload.sid !== 'string' || typeof payload.aud !== 'string') return null;
  if (!Number.isFinite(payload.exp) || !Number.isFinite(payload.iat) || !isIdentity(payload.idn)) return null;
  if (payload.aud !== normalizeAccessHost(options.host) || options.now >= payload.exp) return null;
  return payload;
}
