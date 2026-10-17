/**
 * Contract between the provisioning of a managed installation (the account portal, through cloud-init) and Opfield.
 * Documented for the portal in .workflow/impl/cloud-sso.md; keep both in step.
 *
 * The provisioning leaves `cloud-enroll.json` in the app data directory (inside the app container) with:
 *
 * ```json
 * {
 *   "code": "CLD-7K3M-Q9TX",
 *   "portalUrl": "https://account.opfield.dev",
 *   "licenseKey": "WLT-GW-...",
 *   "publicUrl": "https://acme.opfield.cloud",
 *   "sso": { "issuer": "https://account.opfield.dev", "clientId": "...", "clientSecret": "..." },
 *   "owner": { "sub": "<account uuid>", "email": "owner@example.com", "name": "Ada Owner" }
 * }
 * ```
 *
 * Only `code` is required. With `sso` and `owner` on an installation without an administrator, the first start sets
 * the public URL, configures the "Opfield account" OIDC provider, creates the owner as system administrator bound to
 * issuer + sub, and marks setup complete, all or nothing. Without them the setup link flow stays as it is.
 */

/** Opfield's OIDC callback, relative to the public URL. The portal registers `<publicUrl><OIDC_CALLBACK_PATH>`. */
export const OIDC_CALLBACK_PATH = '/auth/callback';

/** The OIDC client of this installation at the account portal. `clientSecret` is removed from the file once used. */
export interface CloudEnrollSso {
  issuer: string;
  clientId: string;
  /** Absent once Opfield stored it (encrypted) and removed it from the file. */
  clientSecret?: string;
}

/** The account that owns the installation: created as its first system administrator. */
export interface CloudEnrollOwner {
  /** Stable account id at the portal (the ID token's `sub`). */
  sub: string;
  /** Taken as verified. */
  email: string;
  name?: string;
}

/** `cloud-enroll.json` in the app data directory, as the portal writes it. */
export interface CloudEnrollFileContract {
  code: string;
  portalUrl?: string;
  /** A secret: never logged or audited; the whole file is removed once settled. */
  licenseKey?: string;
  /** Origin the installation is reached at, e.g. `https://acme.opfield.cloud`. */
  publicUrl?: string;
  sso?: CloudEnrollSso;
  owner?: CloudEnrollOwner;
}

/**
 * Portal request (over the cloud link socket) that hands over a new client secret of the installation's Opfield
 * account client: a managed installation, or a self-hosted one the account gave a client (sso-client). It needs no
 * "Allow remote management". Answered ok:false with code OPFIELD_ACCOUNT_PROVIDER_MISSING, nothing stored, when the
 * account gave this installation no client or it does not sign in with it (its admin removed the provider or chose
 * another one); the portal keeps the old secret then.
 */
export const CLOUD_SSO_SECRET_REQUEST = 'sso-secret';
export interface CloudSsoSecretRequestParams {
  clientSecret: string;
}

/**
 * Use Opfield account for sign-in on an installation without a client from the cloud: every hello carries
 *
 * ```json
 * { "type": "hello", ..., "ssoClientRequest": { "redirectUri": "https://gw.example.com/auth/callback",
 *   "requestedAt": "2026-10-13T10:00:00.000Z" } }
 * ```
 *
 * until the account answers or an admin cancels it (the hello is sent again whenever it changes). The account creates
 * an OIDC client registered for that redirect URI and sends the sso-client request with `{ issuer, clientId,
 * clientSecret, redirectUri }`. It is taken only while the request is pending and for the same redirect URI (a managed
 * installation also takes a client it did not ask for, as from its enrolment file): the installation keeps the client
 * (secret encrypted), sets up the "Opfield account" provider, turns OIDC sign-in on, drops the request from the hello
 * and answers `{ saved: true, applied }` (applied false: kept only, because no administrator could sign in after the
 * switch). Refusals: SSO_CLIENT_NOT_REQUESTED, INVALID_SSO_CLIENT. It needs no "Allow remote management" and is
 * audited like every request, without the secret. When the cloud link ends (disconnect, or the account revokes the
 * agent) or the installation connects to another account (Switch account), it forgets the client and removes the
 * provider on it, unless no administrator could sign in; a pending request is dropped on Switch account.
 */
export const CLOUD_SSO_CLIENT_REQUEST = 'sso-client';
export interface CloudSsoClientRequestParams {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * The account removed people's access to this installation: removed from the team, their access to it removed, the
 * installation moved to another account, or the account suspended. Every hello carries `"ssoRevoke": true` from the
 * installations that take it (others answer "Unknown request type"). Params `{ issuer, subjects, reason }`: the portal
 * issuer as in sso-client, 1 to 500 account ids (the OIDC `sub`), and one of the reasons below. The accounts that
 * signed in here as those subjects of that issuer, whichever sign-in provider is active now, are blocked as the Opfield
 * account's: their browser sessions end on every replica, live connections close as on any block, and their API,
 * OAuth and MCP tokens are refused while blocked (not deleted). Their next sign-in through the same issuer lifts the
 * block (audited `user.opfield_account_unblock`); an administrator's block is never lifted by a sign-in, an
 * administrator's unblock lifts either, and an administrator blocking such an account makes it an administrator's
 * block. It needs no "Allow remote management", is idempotent (an account blocked already, by either, stays as it is
 * and is listed as revoked) and answers `{ revoked: [{ sub, userId }], unknown: [sub] }`; the last active system
 * administrator is never blocked and is listed in `kept: [{ sub, userId, code: "LAST_SYSTEM_ADMIN" }]` (only present
 * when not empty). Invalid params: ok:false with code INVALID_SSO_REVOKE. Audited as `cloud.sso_revoke` with the
 * reason and the accounts.
 */
export const CLOUD_SSO_REVOKE_REQUEST = 'sso-revoke';
export interface CloudSsoRevokeRequestParams {
  issuer: string;
  subjects: string[];
  reason: 'removed_from_team' | 'access_removed' | 'installation_moved' | 'account_suspended';
}

const MAX_FIELD = 2048;
const MAX_SECRET = 4096;
const MAX_SUBJECT = 255;
const MAX_EMAIL = 255;
const MAX_NAME = 255;

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

/** The `sso` object of the file; null when absent or malformed. */
export function parseCloudEnrollSso(value: unknown): CloudEnrollSso | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const issuer = text(record.issuer, MAX_FIELD);
  const clientId = text(record.clientId, MAX_FIELD);
  if (!issuer || !clientId) return null;
  const clientSecret = text(record.clientSecret, MAX_SECRET);
  return { issuer, clientId, ...(clientSecret ? { clientSecret } : {}) };
}

/** The `owner` object of the file; null when absent or malformed. */
export function parseCloudEnrollOwner(value: unknown): CloudEnrollOwner | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const sub = text(record.sub, MAX_SUBJECT);
  const email = text(record.email, MAX_EMAIL)?.toLowerCase() ?? null;
  if (!sub || !email || !/^[^\s@]+@[^\s@]+$/.test(email)) return null;
  const name = text(record.name, MAX_NAME);
  return { sub, email, ...(name ? { name } : {}) };
}
