import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import type { OidcSettingsService } from '@/modules/auth/oidc-settings.service.js';
import { OIDC_CALLBACK_PATH } from '@/modules/cloud-link/cloud-enroll-contract.js';
import {
  type CloudEnrollIssuer,
  CloudLinkRequestError,
  type CloudLinkService,
  cloudPkceChallenge,
} from '@/modules/cloud-link/cloud-link.service.js';
import { normalizePublicUrl } from '@/modules/settings/general-settings.service.js';
import type { CacheService } from '@/services/cache.service.js';

/** The account portal page that lets a signed-in user connect an installation and sends them back with a code. */
export const CLOUD_CONNECT_PORTAL_PATH = '/connect-installation';
/** Where the portal sends the browser back, relative to the wizard's public URL. */
export const SETUP_CLOUD_CALLBACK_PATH = '/setup/cloud-callback';
/** The portal user who connected the installation from the wizard: setup makes them the first administrator. */
export const SETUP_OPFIELD_ACCOUNT_ADMIN_KEY = 'setup:opfield_account_admin';
export const SETUP_CLOUD_CONNECT_TTL_SECONDS = 10 * 60;
const STATE_PREFIX = 'setup:cloud_connect:';
const PORTAL_PROBE_TIMEOUT_MS = 5_000;

interface PendingCloudConnect {
  /** sha256 of the setup session the connect started in. */
  setupSession: string;
  codeVerifier: string;
  publicUrl: string;
}

export interface SetupOpfieldAccountAdmin {
  email: string;
  name: string | null;
}

export interface SetupCloudConnectView {
  connected: boolean;
  accountEmail: string | null;
  /** Who becomes the first administrator; null until the installation is connected from the wizard. */
  administrator: SetupOpfieldAccountAdmin | null;
  /** The Opfield account sign-in client: issued (ready), asked for and not here yet (requested), or not asked for. */
  signInClient: 'ready' | 'requested' | 'none';
  requestedAt: string | null;
}

export interface SetupCloudConnectDeps {
  db: DrizzleClient;
  cache: Pick<CacheService, 'set' | 'take'>;
  cloud: Pick<
    CloudLinkService,
    | 'configuredPortalUrl'
    | 'connectWithIssuer'
    | 'requestSsoClient'
    | 'pendingSsoClientRequest'
    | 'getStatus'
    | 'helloChanged'
    | 'cancelSsoClientRequest'
    | 'disconnect'
  >;
  oidcSettings: Pick<OidcSettingsService, 'getPublicConfig'>;
  authSettings: Pick<AuthSettingsService, 'getConfig'>;
  installationName: () => string;
  fetcher?: typeof fetch;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function setupPublicUrl(value: string): string {
  let normalized: string | null;
  try {
    normalized = normalizePublicUrl(value);
  } catch (error) {
    throw new AppError(400, 'SETUP_INVALID', error instanceof Error ? error.message : String(error));
  }
  if (!normalized) throw new AppError(400, 'SETUP_INVALID', 'Opfield public URL is required');
  return normalized;
}

/** The browser's origin for return_uri: http(s), no credentials, path, query or fragment (an origin, nothing else). */
export function setupReturnOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new AppError(400, 'SETUP_INVALID', 'The return address must be an http or https origin');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '' && url.pathname !== '/') ||
    value.trim().replace(/\/$/, '') !== url.origin
  ) {
    throw new AppError(400, 'SETUP_INVALID', 'The return address must be an http or https origin');
  }
  return url.origin;
}

function portalUnreachable(portalUrl: string): AppError {
  return new AppError(
    502,
    'CLOUD_PORTAL_UNAVAILABLE',
    `This server cannot reach the Opfield account at ${new URL(portalUrl).origin}. Allow outbound HTTPS from this server to it, or choose another sign-in option.`
  );
}

/** A cloud link failure as the wizard shows it: an unreachable portal is said plainly. */
export function setupCloudError(error: unknown, portalUrl: string): unknown {
  if (!(error instanceof CloudLinkRequestError)) return error;
  if (error.code === 'CLOUD_PORTAL_UNAVAILABLE') return portalUnreachable(portalUrl);
  return new AppError(error.status, error.code, error.message);
}

/**
 * "Opfield account" in the setup wizard: the browser goes to the account portal with a state and a PKCE code
 * challenge, comes back to /setup/cloud-callback with a connect code, and the installation enrols with it (and the
 * verifier only it holds), then asks the account for its Opfield account sign-in client exactly as Settings >
 * Authentication does. The portal user who connected it becomes the first administrator.
 */
export class SetupCloudConnect {
  constructor(private readonly deps: SetupCloudConnectDeps) {}

  /** The portal URL the browser goes to; refuses at once when this server cannot reach the portal. */
  async start(
    setupSessionId: string,
    publicUrlInput: string,
    returnOriginInput?: string
  ): Promise<{ url: string; expiresAt: string }> {
    const publicUrl = setupPublicUrl(publicUrlInput);
    // The portal sends the browser back to the address it is on, so a wizard opened on a LAN IP returns to its own
    // setup session; the sign-in client is still registered for the public URL.
    const returnOrigin = returnOriginInput ? setupReturnOrigin(returnOriginInput) : publicUrl;
    const portalUrl = this.deps.cloud.configuredPortalUrl;
    await this.probePortal(portalUrl);
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    await this.deps.cache.set<PendingCloudConnect>(
      `${STATE_PREFIX}${sha256(state)}`,
      { setupSession: sha256(setupSessionId), codeVerifier, publicUrl },
      SETUP_CLOUD_CONNECT_TTL_SECONDS
    );
    const url = new URL(`${portalUrl}${CLOUD_CONNECT_PORTAL_PATH}`);
    url.searchParams.set('return_uri', new URL(SETUP_CLOUD_CALLBACK_PATH, returnOrigin).toString());
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', cloudPkceChallenge(codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('name', this.deps.installationName());
    return {
      url: url.toString(),
      expiresAt: new Date(Date.now() + SETUP_CLOUD_CONNECT_TTL_SECONDS * 1000).toISOString(),
    };
  }

  /**
   * Enrols with the code the portal sent back (state given: the verifier of that start is used, once) or one entered
   * by hand (no state, no verifier), keeps who connected it, and asks the account for the sign-in client.
   */
  async finish(
    setupSessionId: string,
    input: { code: string; state?: string; publicUrl?: string }
  ): Promise<SetupCloudConnectView> {
    let codeVerifier: string | undefined;
    let publicUrl: string;
    if (input.state) {
      const pending = await this.deps.cache.take<PendingCloudConnect>(`${STATE_PREFIX}${sha256(input.state)}`);
      if (!pending || pending.setupSession !== sha256(setupSessionId)) {
        throw new AppError(
          400,
          'SETUP_CLOUD_STATE_INVALID',
          'This Opfield account connection expired or was started in another setup session. Connect again.'
        );
      }
      codeVerifier = pending.codeVerifier;
      publicUrl = pending.publicUrl;
    } else {
      publicUrl = setupPublicUrl(input.publicUrl ?? '');
    }

    let issuer: CloudEnrollIssuer | null;
    try {
      ({ issuer } = await this.deps.cloud.connectWithIssuer(
        input.code,
        { userId: null },
        { source: 'setup', ...(codeVerifier ? { codeVerifier } : {}) }
      ));
    } catch (error) {
      throw setupCloudError(error, this.deps.cloud.configuredPortalUrl);
    }
    if (!issuer) {
      throw new AppError(
        502,
        'CLOUD_PORTAL_ERROR',
        'The Opfield account did not say who connected this installation, so no administrator can be set up from it'
      );
    }
    await this.deps.db
      .insert(settings)
      .values({ key: SETUP_OPFIELD_ACCOUNT_ADMIN_KEY, value: issuer, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: issuer, updatedAt: new Date() } });
    return this.requestClient(publicUrl);
  }

  /**
   * Asks the connected account for the Opfield account sign-in client of this public URL (again: the hello is sent
   * again, so a portal that missed it answers now).
   */
  async requestClient(publicUrlInput: string): Promise<SetupCloudConnectView> {
    const publicUrl = setupPublicUrl(publicUrlInput);
    const current = await this.view();
    if (current.signInClient === 'ready') return current;
    try {
      await this.deps.cloud.requestSsoClient(new URL(OIDC_CALLBACK_PATH, publicUrl).toString(), { userId: null });
    } catch (error) {
      throw setupCloudError(error, this.deps.cloud.configuredPortalUrl);
    }
    this.deps.cloud.helloChanged();
    return this.view();
  }

  /**
   * The admin chose another sign-in option after connecting: the cloud link is disconnected (which also removes the
   * Opfield account provider it gave), the pending sign-in client request and the kept administrator are dropped.
   */
  async disconnect(): Promise<SetupCloudConnectView> {
    await this.deps.cloud.cancelSsoClientRequest({ userId: null });
    try {
      await this.deps.cloud.disconnect({ userId: null });
    } catch (error) {
      throw setupCloudError(error, this.deps.cloud.configuredPortalUrl);
    }
    await this.deps.db.delete(settings).where(eq(settings.key, SETUP_OPFIELD_ACCOUNT_ADMIN_KEY));
    return this.view();
  }

  async view(): Promise<SetupCloudConnectView> {
    const [status, administrator, pending, provider, auth] = await Promise.all([
      this.deps.cloud.getStatus(),
      readSetupOpfieldAccountAdmin(this.deps.db),
      this.deps.cloud.pendingSsoClientRequest(),
      this.deps.oidcSettings.getPublicConfig(),
      this.deps.authSettings.getConfig(),
    ]);
    const connected = status.state === 'connected';
    const ready = connected && provider.configured && provider.opfieldAccount && auth.methods.oidc;
    return {
      connected,
      accountEmail: connected ? status.accountEmail : null,
      administrator: connected ? administrator : null,
      signInClient: ready ? 'ready' : pending ? 'requested' : 'none',
      requestedAt: pending?.requestedAt ?? null,
    };
  }

  /** Any HTTP answer will do: only a network failure or a timeout means this server cannot reach the portal. */
  private async probePortal(portalUrl: string): Promise<void> {
    try {
      await (this.deps.fetcher ?? fetch)(portalUrl, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(PORTAL_PROBE_TIMEOUT_MS),
      });
    } catch {
      throw portalUnreachable(portalUrl);
    }
  }
}

export async function readSetupOpfieldAccountAdmin(db: DrizzleClient): Promise<SetupOpfieldAccountAdmin | null> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, SETUP_OPFIELD_ACCOUNT_ADMIN_KEY))
    .limit(1);
  const value = row?.value as Partial<SetupOpfieldAccountAdmin> | undefined;
  if (!value || typeof value.email !== 'string' || !value.email) return null;
  return { email: value.email, name: typeof value.name === 'string' && value.name ? value.name : null };
}
