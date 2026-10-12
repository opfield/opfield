import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import { assertAdminSignInRemains } from '@/modules/auth/admin-sign-in-guard.js';
import { AuthService, normalizeOidcIssuer } from '@/modules/auth/auth.service.js';
import { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import { normalizeUrl, OidcSettingsService } from '@/modules/auth/oidc-settings.service.js';
import { EventBusService } from '@/services/event-bus.service.js';
import { CloudLinkService } from './cloud-link.service.js';
import type { CloudSignInDetachReason, CloudSsoClient as CloudSsoClientInput } from './cloud-link.types.js';

const logger = createChildLogger('CloudSsoClient');

export interface CloudSsoClientDeps {
  db: DrizzleClient;
  oidcSettings: Pick<
    OidcSettingsService,
    | 'getPublicConfig'
    | 'getOpfieldAccountClient'
    | 'saveOpfieldAccountProvider'
    | 'keepOpfieldAccountClient'
    | 'forgetOpfieldAccountClient'
    | 'removeConfig'
    | 'markOpfieldAccountDetached'
  >;
  authSettings: Pick<AuthSettingsService, 'getConfig' | 'enableOidcSignIn' | 'updateConfig'>;
  cloud: Pick<
    CloudLinkService,
    'managedByCloud' | 'pendingSsoClientRequest' | 'clearSsoClientRequest' | 'recordManagedSso'
  >;
  /** Drops the cached OIDC discovery of this replica. */
  invalidateOidc: () => void;
  /** Tells open Settings pages that sign-in changed. */
  configChanged?: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidClient(message: string): AppError {
  return new AppError(400, 'INVALID_SSO_CLIENT', message);
}

/**
 * The Opfield account sign-in client the cloud account hands over the link. A self-hosted installation asks for one
 * (Use Opfield account for sign-in puts `ssoClientRequest` in the hello); the account answers with an sso-client
 * request, which is taken only while that request is pending and for the same redirect URI. A managed installation
 * also takes a client it did not ask for, as its enrolment file does: it replaces the client of the Opfield account
 * provider, or is kept for a later return while the admin uses another provider. When the cloud link ends, the kept
 * client is forgotten and the Opfield account provider removed, unless no administrator could sign in without it.
 */
export class CloudSsoClient {
  constructor(private readonly deps: CloudSsoClientDeps) {}

  async accept(input: CloudSsoClientInput): Promise<{ saved: true; applied: boolean }> {
    let issuer: string;
    let redirectUri: string;
    try {
      issuer = normalizeUrl(input.issuer, 'OIDC issuer');
      redirectUri = normalizeUrl(input.redirectUri, 'OIDC redirect URI');
    } catch (error) {
      throw invalidClient(errorMessage(error));
    }
    const client = { issuer, clientId: input.clientId.trim(), clientSecret: input.clientSecret.trim(), redirectUri };
    if (!client.clientId || !client.clientSecret) throw invalidClient('The client needs a client ID and a secret');

    const [pending, managed] = await Promise.all([
      this.deps.cloud.pendingSsoClientRequest(),
      this.deps.cloud.managedByCloud(),
    ]);
    if (pending) {
      let requested: string;
      try {
        requested = normalizeUrl(pending.redirectUri, 'OIDC redirect URI');
      } catch {
        requested = pending.redirectUri;
      }
      if (requested !== redirectUri) {
        throw new AppError(
          409,
          'SSO_CLIENT_NOT_REQUESTED',
          `This installation asked for a sign-in client for ${pending.redirectUri}, not ${redirectUri}`
        );
      }
    } else if (!managed) {
      throw new AppError(409, 'SSO_CLIENT_NOT_REQUESTED', 'This installation did not ask for a sign-in client');
    }

    const current = await this.deps.oidcSettings.getPublicConfig();
    // Asked for: the Opfield account becomes the provider and OIDC sign-in is on. Not asked for (managed): as the
    // enrolment file does, only an Opfield account provider in use is replaced.
    const switchProvider = pending !== null || current.opfieldAccount;
    let applied = false;
    let keptReason: string | null = switchProvider ? null : current.configured ? 'another_provider' : 'no_provider';
    if (switchProvider) {
      try {
        await assertAdminSignInRemains(
          this.deps.db,
          { issuer, ...(pending ? { methods: { oidc: true } } : {}) },
          { methods: (await this.deps.authSettings.getConfig()).methods, issuer: current.issuer }
        );
        await this.deps.db.transaction(async (tx) => {
          await this.deps.oidcSettings.saveOpfieldAccountProvider(client, tx);
          if (pending) await this.deps.authSettings.enableOidcSignIn(tx);
        });
        applied = true;
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'LAST_ADMIN_SIGN_IN') throw error;
        // The client is kept; Use Opfield account for sign-in tells the admin what to fix first.
        keptReason = 'last_admin_sign_in';
      }
    }
    if (!applied) await this.deps.oidcSettings.keepOpfieldAccountClient(client);
    if (pending) await this.deps.cloud.clearSsoClientRequest();
    this.deps.invalidateOidc();
    await this.deps.cloud.recordManagedSso({
      step: applied ? 'client_received' : 'client_kept',
      source: 'cloud-link',
      requested: pending !== null,
      issuer,
      clientId: client.clientId,
      redirectUri,
      ...(keptReason ? { reason: keptReason } : {}),
    });
    logger.info('Took the Opfield account sign-in client from the cloud account', { applied });
    this.deps.configChanged?.();
    return { saved: true, applied };
  }

  /**
   * The cloud link ended or moved to another account: the kept client is forgotten and the Opfield account provider on it is removed with OIDC
   * sign-in turned off, unless no administrator could sign in then; the provider stays and the audit says why.
   */
  async detach(reason: CloudSignInDetachReason = 'cloud_disconnected'): Promise<void> {
    const client = await this.deps.oidcSettings.getOpfieldAccountClient();
    await this.deps.oidcSettings.forgetOpfieldAccountClient();
    if (!client) return;
    const provider = await this.deps.oidcSettings.getPublicConfig();
    const inUse =
      provider.configured &&
      provider.opfieldAccount &&
      provider.clientId === client.clientId &&
      provider.issuer !== null &&
      normalizeOidcIssuer(provider.issuer) === normalizeOidcIssuer(client.issuer);
    if (!inUse) {
      await this.deps.cloud.recordManagedSso({ step: 'client_forgotten', reason });
      this.deps.configChanged?.();
      return;
    }
    try {
      const { methods } = await this.deps.authSettings.getConfig();
      await assertAdminSignInRemains(
        this.deps.db,
        { issuer: null, methods: { oidc: false } },
        { methods, issuer: provider.issuer }
      );
      if (methods.oidc) await this.deps.authSettings.updateConfig({ methods: { oidc: false } });
      await this.deps.oidcSettings.removeConfig({ keepCloudClient: false });
      this.deps.invalidateOidc();
      await this.deps.cloud.recordManagedSso({
        step: 'provider_removed',
        reason,
        clientId: client.clientId,
      });
      logger.info('Removed the Opfield account sign-in provider: the cloud link ended');
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      // LAST_ADMIN_SIGN_IN, or no sign-in method would be left: the provider stays until an admin changes sign-in,
      // no longer as the cloud's (no rotation, Use Opfield account asks the current account for a client).
      await this.deps.oidcSettings.markOpfieldAccountDetached(reason);
      this.deps.invalidateOidc();
      await this.deps.cloud.recordManagedSso({
        step: 'provider_kept',
        reason,
        clientId: client.clientId,
        warning:
          'The Opfield account provider stays because no administrator could sign in without it. Give an administrator another sign-in method, then remove it in Settings > Authentication.',
        errorCode: error.code,
      });
      logger.warn('Kept the Opfield account sign-in provider after the cloud link ended: it is the only admin sign-in');
    }
    this.deps.configChanged?.();
  }
}

/** The service as the running installation wires it. */
export function createCloudSsoClient(): CloudSsoClient {
  return new CloudSsoClient({
    db: container.resolve<DrizzleClient>(TOKENS.DrizzleClient),
    oidcSettings: container.resolve(OidcSettingsService),
    authSettings: container.resolve(AuthSettingsService),
    cloud: container.resolve(CloudLinkService),
    invalidateOidc: () => container.resolve(AuthService).invalidateOidcConfiguration(),
    configChanged: () =>
      container.resolve(EventBusService).publish('system.config.changed', { action: 'opfield_account_sign_in' }),
  });
}
