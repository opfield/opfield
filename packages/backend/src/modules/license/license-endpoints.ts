import { eq } from 'drizzle-orm';
import type { Env } from '@/config/env.js';
import {
  LEGACY_UPDATES_BASE_URLS,
  LICENSE_ENDPOINTS_DOCUMENT,
  LICENSE_SERVICE_URLS,
  UPDATES_BASE_URL,
} from '@/config/vendor-urls.js';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/settings.js';
import { createChildLogger } from '@/lib/logger.js';
import {
  UPDATE_SIGNING_PUBLIC_KEY_PEM,
  UpdateArtifactTrustError,
  verifySignedPayload,
} from '@/lib/update-artifact-trust.js';

const logger = createChildLogger('LicenseEndpoints');

/**
 * Where the license service answers. Every license call tries these addresses in order and stays with the last one
 * that answered:
 *
 * 1. LICENSE_SERVICE_URL, the administrator's override (comma-separated);
 * 2. the endpoints document: a list signed with the update signing key and published with the release feed
 *    (`<update host>/license-endpoints.json`), fetched on start and daily, the last valid one kept in the database;
 * 3. the built-in addresses (LICENSE_SERVICE_URLS).
 *
 * A document is used only while its signature verifies and it has not expired; an older document never replaces a
 * newer one. Nothing about an installation (its id, token or key) depends on the address that answered.
 */
export const LICENSE_ENDPOINTS_KIND = 'license-endpoints';
export const LICENSE_ENDPOINTS_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

const SETTINGS_KEY = 'license:service_endpoints_document';
const MAX_DOCUMENT_BYTES = 64 * 1024;
const MAX_ENDPOINTS = 16;
const MAX_VALIDITY_MS = 400 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 15 * 60 * 1000;
const DOCUMENT_FETCH_TIMEOUT_MS = 10_000;
/** Copies that do not refresh the document themselves pick up the one another copy stored at most this late. */
const STORED_DOCUMENT_RELOAD_MS = 60 * 60 * 1000;

type Fetcher = typeof fetch;

export interface LicenseEndpointsDocument {
  endpoints: string[];
  issuedAt: string;
  expiresAt: string;
}

interface LicenseEndpointsPayload {
  kind?: unknown;
  endpoints?: unknown;
  issuedAt?: unknown;
  expiresAt?: unknown;
}

interface StoredDocument {
  signed: string;
  document: LicenseEndpointsDocument;
}

/** An address as license calls append paths to it: no trailing slash, query, fragment or credentials. */
export function normalizeLicenseEndpoint(value: string, protocols: readonly string[] = ['https:']): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (!protocols.includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** The signature and contents of an endpoints document, without its validity period. */
function parseLicenseEndpointsDocument(
  signed: string,
  publicKey: string | Buffer = UPDATE_SIGNING_PUBLIC_KEY_PEM
): LicenseEndpointsDocument {
  if (signed.length > MAX_DOCUMENT_BYTES) throw new UpdateArtifactTrustError('License endpoints document is too large');
  const payload = verifySignedPayload<LicenseEndpointsPayload>(signed, publicKey);
  if (!payload || typeof payload !== 'object' || payload.kind !== LICENSE_ENDPOINTS_KIND)
    throw new UpdateArtifactTrustError('Signed document is not a license endpoints document');
  if (!Array.isArray(payload.endpoints) || payload.endpoints.length === 0 || payload.endpoints.length > MAX_ENDPOINTS)
    throw new UpdateArtifactTrustError('License endpoints document lists no valid endpoints');
  const endpoints = payload.endpoints.map((entry) =>
    typeof entry === 'string' ? normalizeLicenseEndpoint(entry) : null
  );
  if (endpoints.some((entry) => entry === null))
    throw new UpdateArtifactTrustError('License endpoints document lists an endpoint that is not an https URL');
  const issuedAt = typeof payload.issuedAt === 'string' ? Date.parse(payload.issuedAt) : Number.NaN;
  const expiresAt = typeof payload.expiresAt === 'string' ? Date.parse(payload.expiresAt) : Number.NaN;
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt)
    throw new UpdateArtifactTrustError('License endpoints document has no valid validity period');
  if (expiresAt - issuedAt > MAX_VALIDITY_MS)
    throw new UpdateArtifactTrustError('License endpoints document is valid for too long');
  return {
    endpoints: [...new Set(endpoints as string[])],
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

function isCurrent(document: LicenseEndpointsDocument, now: Date): boolean {
  return (
    Date.parse(document.issuedAt) <= now.getTime() + MAX_CLOCK_SKEW_MS && Date.parse(document.expiresAt) > now.getTime()
  );
}

/**
 * Verifies a signed endpoints document for use now. Unsigned, tampered, foreign-kind, expired and not yet issued
 * documents are rejected.
 */
export function verifyLicenseEndpointsDocument(
  signed: string,
  now: Date = new Date(),
  publicKey: string | Buffer = UPDATE_SIGNING_PUBLIC_KEY_PEM
): LicenseEndpointsDocument {
  const document = parseLicenseEndpointsDocument(signed, publicKey);
  if (Date.parse(document.issuedAt) > now.getTime() + MAX_CLOCK_SKEW_MS)
    throw new UpdateArtifactTrustError('License endpoints document is not issued yet');
  if (Date.parse(document.expiresAt) <= now.getTime())
    throw new UpdateArtifactTrustError('License endpoints document has expired');
  return document;
}

/** The administrator's override: comma-separated http(s) addresses; invalid entries are ignored. */
function overrideEndpoints(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => normalizeLicenseEndpoint(entry, ['https:', 'http:']))
    .filter((entry): entry is string => entry !== null);
}

export interface LicenseServiceEndpointsOptions {
  publicKey?: string | Buffer;
  now?: () => Date;
}

export class LicenseServiceEndpoints {
  private stored: StoredDocument | null = null;
  private loadedAt = 0;
  private loading: Promise<void> | null = null;
  private refreshing: Promise<boolean> | null = null;
  private preferred: string | null = null;

  constructor(
    private readonly db: DrizzleClient,
    private readonly env: Partial<Pick<Env, 'LICENSE_SERVICE_URL' | 'ARTIFACT_BASE_URL'>>,
    private readonly fetcher: Fetcher = fetch,
    private readonly options: LicenseServiceEndpointsOptions = {}
  ) {}

  /** Every address to try, in order: the one that answered last first, then override, document, built-in. */
  async list(): Promise<string[]> {
    await this.load();
    return this.ordered();
  }

  /** The address license calls go to first. */
  current(): string {
    return this.ordered()[0] ?? LICENSE_SERVICE_URLS[0]!;
  }

  /** Records the address that answered, so the next calls start there. */
  markAnswered(endpoint: string): void {
    if (this.preferred === endpoint) return;
    if (this.preferred) logger.info('License service answered on another address', { endpoint });
    this.preferred = endpoint;
  }

  /**
   * Fetches the endpoints document from the update hosts and keeps it when it verifies and is not older than the one
   * kept. Returns whether a valid document is in force afterwards. Never throws.
   */
  refresh(): Promise<boolean> {
    if (!this.refreshing) {
      this.refreshing = this.refreshNow()
        .catch((error) => {
          logger.warn('License endpoints refresh failed', { error: error instanceof Error ? error.message : error });
          return false;
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    return this.refreshing;
  }

  private async refreshNow(): Promise<boolean> {
    await this.load(true);
    const now = this.now();
    for (const url of this.documentUrls()) {
      let signed: string;
      try {
        const response = await this.fetcher(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(DOCUMENT_FETCH_TIMEOUT_MS),
        });
        if (!response.ok) continue;
        signed = await response.text();
      } catch {
        continue;
      }
      let document: LicenseEndpointsDocument;
      try {
        document = verifyLicenseEndpointsDocument(signed, now, this.options.publicKey);
      } catch (error) {
        logger.warn('Rejected a license endpoints document', {
          url,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const kept = this.stored?.document;
      if (kept && Date.parse(document.issuedAt) < Date.parse(kept.issuedAt)) {
        logger.warn('Ignored a license endpoints document older than the one in force', { url });
        continue;
      }
      if (this.stored?.signed !== signed) {
        await this.db
          .insert(settings)
          .values({ key: SETTINGS_KEY, value: { signed }, updatedAt: new Date() })
          .onConflictDoUpdate({ target: settings.key, set: { value: { signed }, updatedAt: new Date() } });
        this.stored = { signed, document };
        logger.info('License endpoints updated', { endpoints: document.endpoints, expiresAt: document.expiresAt });
      }
      return true;
    }
    return this.stored !== null && isCurrent(this.stored.document, now);
  }

  private ordered(): string[] {
    const document = this.stored && isCurrent(this.stored.document, this.now()) ? this.stored.document.endpoints : [];
    const ordered = [
      ...new Set([...overrideEndpoints(this.env.LICENSE_SERVICE_URL), ...document, ...LICENSE_SERVICE_URLS]),
    ];
    const preferred = this.preferred;
    if (!preferred || !ordered.includes(preferred)) return ordered;
    return [preferred, ...ordered.filter((endpoint) => endpoint !== preferred)];
  }

  private documentUrls(): string[] {
    const bases = [this.env.ARTIFACT_BASE_URL, UPDATES_BASE_URL, ...LEGACY_UPDATES_BASE_URLS]
      .filter((base): base is string => typeof base === 'string' && base.length > 0)
      .map((base) => base.replace(/\/+$/, ''));
    return [...new Set(bases)].map((base) => `${base}/${LICENSE_ENDPOINTS_DOCUMENT}`);
  }

  private async load(force = false): Promise<void> {
    if (!force && Date.now() - this.loadedAt < STORED_DOCUMENT_RELOAD_MS) return;
    if (!this.loading) {
      this.loading = this.loadNow().finally(() => {
        this.loading = null;
      });
    }
    await this.loading;
  }

  private async loadNow(): Promise<void> {
    try {
      const [row] = await this.db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).limit(1);
      const signed = (row?.value as { signed?: unknown } | undefined)?.signed;
      if (typeof signed === 'string' && signed !== this.stored?.signed) {
        try {
          // The validity period is checked where the document is used, so an expired one is kept but not used.
          this.stored = { signed, document: parseLicenseEndpointsDocument(signed, this.options.publicKey) };
        } catch (error) {
          logger.warn('Ignored a stored license endpoints document', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.loadedAt = Date.now();
    } catch (error) {
      // The database being unavailable never blocks a license call: the built-in addresses still work.
      logger.warn('Could not read the stored license endpoints document', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}
