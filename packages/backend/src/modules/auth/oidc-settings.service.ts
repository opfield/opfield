import { eq } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import { settings } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { CryptoService } from '@/services/crypto.service.js';

const OIDC_SETTING_KEY = 'auth:oidc';
/**
 * The Opfield account client the cloud gave this installation, kept apart from the provider: the admin may edit or
 * remove the provider and bring the Opfield account back later. A restored copy forgets it with the cloud link.
 */
export const OPFIELD_ACCOUNT_CLIENT_KEY = 'cloud:opfield_account_client';
/** Marks the provider a managed installation's provisioning configured: sign-in with the Opfield account. */
export const OPFIELD_ACCOUNT_OIDC_SOURCE = 'opfield-account';
export const OPFIELD_ACCOUNT_DISPLAY_NAME = 'Opfield account';
const DISPLAY_NAME_MAX_LENGTH = 64;

interface EncryptedSecret {
  encryptedKey: string;
  encryptedDek: string;
}

export interface StoredOidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: EncryptedSecret;
  redirectUri: string;
  scopes: string;
  /** Name on the sign-in button ("Sign in with <name>"); null shows "Sign in with SSO". */
  displayName?: string | null;
  /** Set on the provider the managed installation's provisioning configured (the Opfield account). */
  source?: typeof OPFIELD_ACCOUNT_OIDC_SOURCE;
  /**
   * Set instead of `source` on an Opfield account provider kept after the cloud link ended or moved to another
   * account, because no administrator could sign in without it: it signs in as before, but is no longer the cloud's.
   */
  detachedOpfieldAccount?: OpfieldAccountDetachReason;
}

export type OpfieldAccountDetachReason = 'cloud_disconnected' | 'account_switched';

export interface OidcConfigInput {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes?: string;
  /** Omitted keeps the stored name; null or empty clears it. */
  displayName?: string | null;
}

export interface OidcRuntimeConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  displayName: string | null;
  opfieldAccount: boolean;
  detachedOpfieldAccount: OpfieldAccountDetachReason | null;
}

export interface LegacyOidcEnvironment {
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_REDIRECT_URI?: string;
  OIDC_SCOPES: string;
}

export interface OidcPublicConfig {
  configured: boolean;
  issuer: string | null;
  clientId: string | null;
  clientSecretLast4: string | null;
  redirectUri: string | null;
  scopes: string;
  displayName: string | null;
  /** The provider is the Opfield account the managed installation was provisioned with. */
  opfieldAccount: boolean;
  /** An Opfield account provider kept after the cloud link ended or switched accounts (see StoredOidcConfig). */
  detachedOpfieldAccount: OpfieldAccountDetachReason | null;
}

/** What the enrolment of a managed installation sets: the account portal's issuer and this installation's client. */
export interface OpfieldAccountProviderInput {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface StoredOpfieldAccountClient {
  issuer: string;
  clientId: string;
  clientSecret: EncryptedSecret;
  redirectUri: string;
}

/** The provider is the cloud's client: marked as the Opfield account and on the kept issuer and client ID. */
function isCloudClient(provider: StoredOidcConfig | null, client: { issuer: string; clientId: string }): boolean {
  return (
    provider?.source === OPFIELD_ACCOUNT_OIDC_SOURCE &&
    provider.issuer === client.issuer &&
    provider.clientId === client.clientId
  );
}

export class OidcSettingsService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService: CryptoService
  ) {}

  async getRuntimeConfig(): Promise<OidcRuntimeConfig | null> {
    const stored = await this.getStoredConfig();
    if (!stored) return null;
    return {
      issuer: stored.issuer,
      clientId: stored.clientId,
      clientSecret: this.cryptoService.decryptString(stored.clientSecret),
      redirectUri: stored.redirectUri,
      scopes: stored.scopes,
      displayName: stored.displayName ?? null,
      opfieldAccount: stored.source === OPFIELD_ACCOUNT_OIDC_SOURCE,
      detachedOpfieldAccount: stored.detachedOpfieldAccount ?? null,
    };
  }

  async getPublicConfig(): Promise<OidcPublicConfig> {
    const runtime = await this.getRuntimeConfig();
    return runtime
      ? {
          configured: true,
          issuer: runtime.issuer,
          clientId: runtime.clientId,
          clientSecretLast4: runtime.clientSecret.slice(-4) || null,
          redirectUri: runtime.redirectUri,
          scopes: runtime.scopes,
          displayName: runtime.displayName,
          opfieldAccount: runtime.opfieldAccount,
          detachedOpfieldAccount: runtime.detachedOpfieldAccount,
        }
      : {
          configured: false,
          issuer: null,
          clientId: null,
          clientSecretLast4: null,
          redirectUri: null,
          scopes: 'openid email profile',
          displayName: null,
          opfieldAccount: false,
          detachedOpfieldAccount: null,
        };
  }

  /** The stored issuer, normalized as configured; null when OIDC is not configured. */
  async getIssuer(): Promise<string | null> {
    return (await this.getStoredConfig())?.issuer ?? null;
  }

  async saveConfig(input: OidcConfigInput): Promise<OidcPublicConfig> {
    const previous = await this.getStoredConfig();
    const issuer = normalizeUrl(input.issuer, 'OIDC issuer');
    const redirectUri = normalizeUrl(input.redirectUri, 'OIDC redirect URI');
    const clientId = input.clientId.trim();
    const scopes = normalizeScopes(input.scopes);
    const clientSecret = input.clientSecret?.trim()
      ? this.cryptoService.encryptString(input.clientSecret.trim())
      : previous?.clientSecret;
    if (!clientId) throw invalidOidcConfig('OIDC client ID is required');
    if (!clientSecret) throw invalidOidcConfig('OIDC client secret is required');
    const displayName =
      input.displayName === undefined ? (previous?.displayName ?? null) : normalizeDisplayName(input.displayName);
    // The provider stays the Opfield account while it keeps the account portal's issuer and the cloud's client; another
    // issuer or client is the customer's own SSO.
    const source =
      previous?.source && previous.issuer === issuer && previous.clientId === clientId ? previous.source : undefined;
    await this.keepCloudClientOf(previous);

    const stored: StoredOidcConfig = {
      issuer,
      clientId,
      clientSecret,
      redirectUri,
      scopes,
      ...(displayName ? { displayName } : {}),
      ...(source ? { source } : {}),
    };
    await this.setStoredConfig(stored);
    return this.getPublicConfig();
  }

  /**
   * Configures (or replaces the client of) the Opfield account provider of a managed installation. A name the admin
   * gave the provider is kept. Runs in the caller's transaction when one is given.
   */
  async saveOpfieldAccountProvider(
    input: OpfieldAccountProviderInput,
    executor: DrizzleExecutor = this.db
  ): Promise<{ replaced: boolean; clientChanged: boolean }> {
    const previous = await this.getStoredConfig(executor);
    const issuer = normalizeUrl(input.issuer, 'OIDC issuer');
    const redirectUri = normalizeUrl(input.redirectUri, 'OIDC redirect URI');
    const clientId = input.clientId.trim();
    const secret = input.clientSecret.trim();
    if (!clientId) throw invalidOidcConfig('OIDC client ID is required');
    if (!secret) throw invalidOidcConfig('OIDC client secret is required');
    const wasOpfield = previous?.source === OPFIELD_ACCOUNT_OIDC_SOURCE;
    const clientSecret = this.cryptoService.encryptString(secret);
    const stored: StoredOidcConfig = {
      issuer,
      clientId,
      clientSecret,
      redirectUri,
      scopes: wasOpfield ? previous.scopes : normalizeScopes(undefined),
      displayName: (wasOpfield ? previous.displayName : null) || OPFIELD_ACCOUNT_DISPLAY_NAME,
      source: OPFIELD_ACCOUNT_OIDC_SOURCE,
    };
    await this.setStoredConfig(stored, executor);
    await this.setKeptClient({ issuer, clientId, clientSecret, redirectUri }, executor);
    return {
      replaced: previous !== null,
      clientChanged:
        !previous ||
        previous.issuer !== issuer ||
        previous.clientId !== clientId ||
        previous.redirectUri !== redirectUri ||
        this.cryptoService.decryptString(previous.clientSecret) !== secret,
    };
  }

  /**
   * Keeps a new Opfield account client (a reinstall delivered one) without touching the provider the admin chose, so
   * the Opfield account can be brought back with it.
   */
  async keepOpfieldAccountClient(input: OpfieldAccountProviderInput): Promise<void> {
    const clientId = input.clientId.trim();
    const secret = input.clientSecret.trim();
    if (!clientId) throw invalidOidcConfig('OIDC client ID is required');
    if (!secret) throw invalidOidcConfig('OIDC client secret is required');
    await this.setKeptClient({
      issuer: normalizeUrl(input.issuer, 'OIDC issuer'),
      clientId,
      clientSecret: this.cryptoService.encryptString(secret),
      redirectUri: normalizeUrl(input.redirectUri, 'OIDC redirect URI'),
    });
  }

  /**
   * The Opfield account client the cloud gave this installation: the kept one, or the provider's own on an
   * installation provisioned before the client was kept apart. Null on an installation the cloud gave no client.
   */
  async getOpfieldAccountClient(executor: DrizzleExecutor = this.db): Promise<OpfieldAccountProviderInput | null> {
    const kept = await this.getKeptClient(executor);
    if (kept) return { ...kept, clientSecret: this.cryptoService.decryptString(kept.clientSecret) };
    const provider = await this.getStoredConfig(executor);
    if (provider?.source !== OPFIELD_ACCOUNT_OIDC_SOURCE) return null;
    return {
      issuer: provider.issuer,
      clientId: provider.clientId,
      clientSecret: this.cryptoService.decryptString(provider.clientSecret),
      redirectUri: provider.redirectUri,
    };
  }

  /** Brings the Opfield account provider back with the client the cloud gave this installation. */
  async restoreOpfieldAccountProvider(): Promise<OidcPublicConfig> {
    const client = await this.getOpfieldAccountClient();
    if (!client) {
      throw new AppError(
        409,
        'OPFIELD_ACCOUNT_CLIENT_MISSING',
        'Opfield Cloud has not given this installation a sign-in client for the Opfield account'
      );
    }
    await this.saveOpfieldAccountProvider(client);
    return this.getPublicConfig();
  }

  /**
   * Removes the OIDC provider; the Opfield account client the cloud gave stays kept for a later return unless
   * `keepCloudClient` is false (the cloud link ended).
   */
  async removeConfig(options: { keepCloudClient?: boolean } = {}): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (options.keepCloudClient !== false) await this.keepCloudClientOf(await this.getStoredConfig(tx), tx);
      await tx.delete(settings).where(eq(settings.key, OIDC_SETTING_KEY));
    });
  }

  /** Whether the cloud gave this installation a client and it is kept (not only inferred from the provider). */
  async hasKeptOpfieldAccountClient(): Promise<boolean> {
    return (await this.getKeptClient()) !== null;
  }

  /**
   * Keeps the Opfield account provider signing in as it does, but no longer as the cloud's (the cloud link ended or
   * moved to another account while no administrator could sign in without it).
   */
  async markOpfieldAccountDetached(reason: OpfieldAccountDetachReason): Promise<void> {
    const provider = await this.getStoredConfig();
    if (!provider) return;
    const { source: _source, ...rest } = provider;
    await this.setStoredConfig({ ...rest, detachedOpfieldAccount: reason });
  }

  /** Forgets the kept Opfield account client (the cloud link ended); the provider is left as it is. */
  async forgetOpfieldAccountClient(): Promise<void> {
    await this.db.delete(settings).where(eq(settings.key, OPFIELD_ACCOUNT_CLIENT_KEY));
  }

  /**
   * A new client secret from the account portal for the Opfield account client. Stored only while the provider is
   * still that client: after the admin removed it or switched to another client the request is refused and nothing
   * changes, so the portal keeps the secret this installation still holds.
   */
  async rotateOpfieldAccountSecret(clientSecret: string): Promise<void> {
    const secret = clientSecret.trim();
    if (!secret) throw invalidOidcConfig('OIDC client secret is required');
    await this.db.transaction(async (tx) => {
      const provider = await this.getStoredConfig(tx);
      const kept = await this.getKeptClient(tx);
      if (!provider || !isCloudClient(provider, kept ?? provider)) {
        throw new AppError(
          409,
          'OPFIELD_ACCOUNT_PROVIDER_MISSING',
          'Sign-in with the Opfield account is not in use on this installation; the new client secret was not stored'
        );
      }
      const encrypted = this.cryptoService.encryptString(secret);
      await this.setStoredConfig({ ...provider, clientSecret: encrypted }, tx);
      await this.setKeptClient(
        {
          issuer: provider.issuer,
          clientId: provider.clientId,
          clientSecret: encrypted,
          redirectUri: kept?.redirectUri ?? provider.redirectUri,
        },
        tx
      );
    });
  }

  async importLegacyEnv(env: LegacyOidcEnvironment): Promise<boolean> {
    if (await this.getStoredConfig()) return false;
    if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET || !env.OIDC_REDIRECT_URI) return false;
    await this.saveConfig({
      issuer: env.OIDC_ISSUER,
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
      redirectUri: env.OIDC_REDIRECT_URI,
      scopes: env.OIDC_SCOPES,
    });
    return true;
  }

  async snapshotConfig(): Promise<StoredOidcConfig | null> {
    return this.getStoredConfig();
  }

  async restoreConfig(snapshot: StoredOidcConfig | null): Promise<void> {
    if (snapshot) {
      await this.setStoredConfig(snapshot);
      return;
    }
    await this.db.delete(settings).where(eq(settings.key, OIDC_SETTING_KEY));
  }

  private async getStoredConfig(executor: DrizzleExecutor = this.db): Promise<StoredOidcConfig | null> {
    const [row] = await executor
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, OIDC_SETTING_KEY))
      .limit(1);
    return (row?.value as StoredOidcConfig | undefined) ?? null;
  }

  /** Before the provider changes: an Opfield account provider not kept apart yet is kept as the cloud's client. */
  private async keepCloudClientOf(previous: StoredOidcConfig | null, executor: DrizzleExecutor = this.db) {
    if (previous?.source !== OPFIELD_ACCOUNT_OIDC_SOURCE || (await this.getKeptClient(executor))) return;
    await this.setKeptClient(
      {
        issuer: previous.issuer,
        clientId: previous.clientId,
        clientSecret: previous.clientSecret,
        redirectUri: previous.redirectUri,
      },
      executor
    );
  }

  private async getKeptClient(executor: DrizzleExecutor = this.db): Promise<StoredOpfieldAccountClient | null> {
    const [row] = await executor
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, OPFIELD_ACCOUNT_CLIENT_KEY))
      .limit(1);
    return (row?.value as StoredOpfieldAccountClient | undefined) ?? null;
  }

  private async setKeptClient(value: StoredOpfieldAccountClient, executor: DrizzleExecutor = this.db): Promise<void> {
    await executor
      .insert(settings)
      .values({ key: OPFIELD_ACCOUNT_CLIENT_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  }

  private async setStoredConfig(value: StoredOidcConfig, executor: DrizzleExecutor = this.db): Promise<void> {
    await executor
      .insert(settings)
      .values({ key: OIDC_SETTING_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  }
}

function invalidOidcConfig(message: string): AppError {
  return new AppError(400, 'OIDC_CONFIG_INVALID', message);
}

export function normalizeUrl(value: string, label: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw invalidOidcConfig(`${label} must be a valid absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalidOidcConfig(`${label} must use http or https`);
  return url.toString();
}

function normalizeDisplayName(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return null;
  if (trimmed.length > DISPLAY_NAME_MAX_LENGTH) {
    throw invalidOidcConfig(`OIDC display name must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`);
  }
  return trimmed;
}

export function normalizeScopes(value: string | undefined): string {
  const scopes = [
    ...new Set(
      (value ?? 'openid email profile')
        .split(/\s+/)
        .map((scope) => scope.trim())
        .filter(Boolean)
    ),
  ];
  if (!scopes.includes('openid')) throw invalidOidcConfig('OIDC scopes must include openid');
  return scopes.join(' ');
}
