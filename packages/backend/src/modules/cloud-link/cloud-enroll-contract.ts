/**
 * Contract between the provisioning of a managed installation (the account portal, through cloud-init) and Gateway.
 * Documented for the portal in .workflow/impl/cloud-sso.md; keep both in step.
 *
 * The provisioning leaves `/var/lib/gateway/cloud-enroll.json` (inside the app container) with:
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

/** Gateway's OIDC callback, relative to the public URL. The portal registers `<publicUrl><OIDC_CALLBACK_PATH>`. */
export const OIDC_CALLBACK_PATH = '/auth/callback';

/** The OIDC client of this installation at the account portal. `clientSecret` is removed from the file once used. */
export interface CloudEnrollSso {
  issuer: string;
  clientId: string;
  /** Absent once Gateway stored it (encrypted) and removed it from the file. */
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

/** `/var/lib/gateway/cloud-enroll.json` as the portal writes it. */
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

/** Portal request (over the cloud link socket) that hands over a new client secret; managed installations only. */
export const CLOUD_SSO_SECRET_REQUEST = 'sso-secret';
export interface CloudSsoSecretRequestParams {
  clientSecret: string;
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
