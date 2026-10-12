import { eq } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import { settings } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { CryptoService } from '@/services/crypto.service.js';

const OIDC_SETTING_KEY = 'auth:oidc';
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
}

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
}

/** What the enrolment of a managed installation sets: the account portal's issuer and this installation's client. */
export interface OpfieldAccountProviderInput {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
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
    // The provider stays the Opfield account while it keeps the account portal's issuer; another issuer is the
    // customer's own SSO.
    const source = previous?.source && previous.issuer === issuer ? previous.source : undefined;

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
    const stored: StoredOidcConfig = {
      issuer,
      clientId,
      clientSecret: this.cryptoService.encryptString(secret),
      redirectUri,
      scopes: wasOpfield ? previous.scopes : normalizeScopes(undefined),
      displayName: (wasOpfield ? previous.displayName : null) || OPFIELD_ACCOUNT_DISPLAY_NAME,
      source: OPFIELD_ACCOUNT_OIDC_SOURCE,
    };
    await this.setStoredConfig(stored, executor);
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

  /** A new client secret for the Opfield account provider (sent by the account portal); refused for any other. */
  async rotateOpfieldAccountSecret(clientSecret: string): Promise<void> {
    const secret = clientSecret.trim();
    if (!secret) throw invalidOidcConfig('OIDC client secret is required');
    const previous = await this.getStoredConfig();
    if (previous?.source !== OPFIELD_ACCOUNT_OIDC_SOURCE) {
      throw new AppError(409, 'OPFIELD_ACCOUNT_PROVIDER_MISSING', 'Sign-in with the Opfield account is not configured');
    }
    await this.setStoredConfig({ ...previous, clientSecret: this.cryptoService.encryptString(secret) });
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
