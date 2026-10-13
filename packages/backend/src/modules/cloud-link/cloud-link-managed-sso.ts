import { and, eq, lt } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { permissionGroups, settings, users } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import { assertAdminSignInRemains } from '@/modules/auth/admin-sign-in-guard.js';
import { normalizeOidcIssuer } from '@/modules/auth/auth.service.js';
import type { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import type { OidcSettingsService } from '@/modules/auth/oidc-settings.service.js';
import type { FinalizeSetupService } from '@/modules/onboarding/finalize-setup.service.js';
import {
  type GeneralSettings,
  type GeneralSettingsService,
  normalizePublicUrl,
} from '@/modules/settings/general-settings.service.js';
import type { SetupTokenPolicyService } from '@/modules/setup/setup-token-policy.js';
import { FIRST_ADMIN_CLAIM_KEY, FIRST_ADMIN_CLAIM_TTL_MS } from '@/modules/setup/setup-wizard.service.js';
import { type CloudEnrollOwner, type CloudEnrollSso, OIDC_CALLBACK_PATH } from './cloud-enroll-contract.js';

const logger = createChildLogger('CloudManagedSso');

/** Subject namespaces Opfield writes itself (see AuthService); an owner from the file can never claim them. */
const RESERVED_SUBJECT_PREFIXES = ['manual:', 'system:'];
/** General settings the managed set-up writes, and so the only ones its rollback restores. */
const GENERAL_FIELDS = ['publicUrl', 'grpcPublicTarget'] as const;

/** How the step ended: done, refused for good (the setup link flow stays), or worth another pass. */
export type ManagedSsoOutcome = 'done' | 'rejected' | 'retry';

export interface ManagedSsoInput {
  publicUrl?: string;
  sso?: CloudEnrollSso;
  owner?: CloudEnrollOwner;
}

export interface CloudManagedSsoDeps {
  db: DrizzleClient;
  oidcSettings: Pick<
    OidcSettingsService,
    'saveOpfieldAccountProvider' | 'keepOpfieldAccountClient' | 'getPublicConfig' | 'getIssuer'
  >;
  authSettings: Pick<AuthSettingsService, 'enableOidcSignIn' | 'getConfig'>;
  generalSettings: Pick<GeneralSettingsService, 'getConfig' | 'updateConfig' | 'restoreFields'>;
  setupPolicy: Pick<SetupTokenPolicyService, 'isOpfieldConfigured' | 'markSetupCompleteIn'>;
  finalizeSetup: Pick<FinalizeSetupService, 'initializeOwner'>;
  /** Drops the cached OIDC discovery of this replica. */
  invalidateOidc: () => void;
  /** After a new public URL: the gRPC and web identities, as the setup wizard refreshes them. */
  refreshIdentities?: () => Promise<void>;
  /** Ends setup sessions and the setup code once setup is complete. */
  closeSetupAccess?: () => Promise<void>;
  /** As the setup wizard finishes: the MCP server is on. */
  enableMcpServer?: () => Promise<void>;
  /** One audit entry per step; never a secret. */
  audit: (details: Record<string, unknown>) => Promise<void>;
}

/** Refused for good: the installation keeps the setup link flow. */
class Rejected extends Error {
  constructor(
    readonly reason: string,
    message: string
  ) {
    super(message);
  }
}

/** Not now: another pass decides (the wizard holds the first-admin claim, or an administrator appeared meanwhile). */
class NotNow extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redirectUriFor(origin: string): string {
  return new URL(OIDC_CALLBACK_PATH, origin).toString();
}

function validIssuer(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Rejected('issuer_invalid', 'The issuer is not an absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Rejected('issuer_invalid', 'The issuer must use https');
  }
  return url.toString();
}

/**
 * Sign-in with the Opfield account on a managed installation, from the enrolment file. On an installation without an
 * administrator it sets the public URL, configures the "Opfield account" OIDC provider, creates the owner as system
 * administrator bound to issuer + sub, and marks setup complete. The owner, the provider, sign-in and the setup marker
 * are written in one transaction: an installation is never set up without its administrator. The public URL is
 * written first and restored when the transaction fails. On an installation that has administrators (a restore or a
 * reinstall) a new client in the file replaces the client of the Opfield account provider; nobody is created. When
 * the admin removed that provider or replaced it with their own, the new client is only kept for a later return.
 */
export class CloudManagedSso {
  constructor(private readonly deps: CloudManagedSsoDeps) {}

  async apply(input: ManagedSsoInput): Promise<ManagedSsoOutcome> {
    if (!input.sso && !input.owner) return 'done';
    const secret = input.sso?.clientSecret;
    try {
      if (await this.deps.setupPolicy.isOpfieldConfigured()) return await this.replaceClient(input);
      if (!input.sso || !input.owner) {
        throw new Rejected('incomplete', 'The enrolment file needs both sso and owner to set up sign-in');
      }
      if (!input.sso.clientSecret) {
        throw new Rejected('client_secret_missing', 'The enrolment file has no client secret');
      }
      return await this.setUp(input.publicUrl, input.sso as Required<CloudEnrollSso>, input.owner);
    } catch (error) {
      const message = secret ? errorMessage(error).replaceAll(secret, '[REDACTED]') : errorMessage(error);
      if (error instanceof Rejected) {
        logger.warn('Opfield account sign-in from the enrolment file was not set up', { reason: error.reason });
        await this.deps.audit({ step: 'skipped', reason: error.reason, error: message });
        return 'rejected';
      }
      if (error instanceof NotNow) {
        logger.info('Opfield account sign-in waits for another pass', { reason: error.reason });
        return 'retry';
      }
      logger.warn('Setting up the Opfield account sign-in failed; retrying', { error: message });
      await this.deps.audit({ step: 'failed', error: message });
      return 'retry';
    }
  }

  private async setUp(
    filePublicUrl: string | undefined,
    sso: Required<CloudEnrollSso>,
    owner: CloudEnrollOwner
  ): Promise<ManagedSsoOutcome> {
    const lowerSub = owner.sub.toLowerCase();
    if (RESERVED_SUBJECT_PREFIXES.some((prefix) => lowerSub.startsWith(prefix))) {
      throw new Rejected('owner_invalid', 'The owner subject uses a reserved namespace');
    }
    const issuer = validIssuer(sso.issuer);
    let publicUrl: string | null;
    try {
      publicUrl = normalizePublicUrl(filePublicUrl);
    } catch (error) {
      throw new Rejected('public_url_invalid', errorMessage(error));
    }
    const before = await this.deps.generalSettings.getConfig();
    publicUrl ??= before.publicUrl;
    if (!publicUrl) throw new Rejected('public_url_missing', 'Neither the file nor the settings have a public URL');

    let applied: GeneralSettings | null = null;
    let ownerId: string;
    try {
      if (publicUrl !== before.publicUrl || !before.grpcPublicTarget) {
        applied = await this.deps.generalSettings.updateConfig({
          publicUrl,
          // Nodes enrol with the gRPC target; on a managed installation it is the host of its public URL.
          ...(before.grpcPublicTarget ? {} : { grpcPublicTarget: new URL(publicUrl).hostname }),
        });
        await this.deps.refreshIdentities?.();
      }
      ownerId = await this.createOwner({ issuer, sso, owner, publicUrl });
    } catch (error) {
      if (applied) await this.restoreGeneral(before, applied);
      throw error;
    } finally {
      this.deps.invalidateOidc();
    }

    if (applied) {
      await this.deps.audit({
        step: 'public_url',
        publicUrl: applied.publicUrl,
        previousPublicUrl: before.publicUrl,
        ...(before.grpcPublicTarget ? {} : { grpcPublicTarget: applied.grpcPublicTarget }),
      });
    }
    await this.deps.audit({ step: 'provider', issuer, clientId: sso.clientId, redirectUri: redirectUriFor(publicUrl) });
    await this.deps.audit({
      step: 'owner',
      userId: ownerId,
      email: owner.email,
      oidcIssuer: normalizeOidcIssuer(issuer),
      oidcSubject: owner.sub,
      group: 'system-admin',
    });
    await this.deps.audit({ step: 'setup_complete', userId: ownerId });
    logger.info('Opfield account sign-in set up from the enrolment file', { userId: ownerId });

    // Setup is complete; what follows only tidies up, as the end of the setup wizard does.
    await this.deps.closeSetupAccess?.().catch((error) => {
      logger.warn('Could not close setup access', { error: errorMessage(error) });
    });
    await this.deps.enableMcpServer?.().catch((error) => {
      logger.warn('Could not turn the MCP server on', { error: errorMessage(error) });
    });
    return 'done';
  }

  /** Owner, provider, sign-in and the setup marker in one transaction, under the wizard's first-admin claim. */
  private async createOwner(input: {
    issuer: string;
    sso: Required<CloudEnrollSso>;
    owner: CloudEnrollOwner;
    publicUrl: string;
  }): Promise<string> {
    const { owner } = input;
    return this.deps.db.transaction(async (tx) => {
      await tx
        .delete(settings)
        .where(
          and(
            eq(settings.key, FIRST_ADMIN_CLAIM_KEY),
            lt(settings.updatedAt, new Date(Date.now() - FIRST_ADMIN_CLAIM_TTL_MS))
          )
        );
      const [claimed] = await tx
        .insert(settings)
        .values({ key: FIRST_ADMIN_CLAIM_KEY, value: 'cloud-enroll-file', updatedAt: new Date() })
        .onConflictDoNothing()
        .returning({ key: settings.key });
      if (!claimed) throw new NotNow('setup_in_progress');
      if (await this.deps.setupPolicy.isOpfieldConfigured(tx)) throw new NotNow('administrator_exists');

      const [byEmail] = await tx.select({ id: users.id }).from(users).where(eq(users.email, owner.email)).limit(1);
      if (byEmail) throw new Rejected('owner_email_in_use', 'A user with the owner email already exists');
      const [bySubject] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.oidcSubject, owner.sub))
        .limit(1);
      if (bySubject) throw new Rejected('owner_subject_in_use', 'A user with the owner subject already exists');
      const [adminGroup] = await tx
        .select({ id: permissionGroups.id })
        .from(permissionGroups)
        .where(eq(permissionGroups.name, 'system-admin'))
        .limit(1);
      if (!adminGroup) throw new Error('Built-in system-admin group not found');

      try {
        await this.deps.oidcSettings.saveOpfieldAccountProvider(
          {
            issuer: input.issuer,
            clientId: input.sso.clientId,
            clientSecret: input.sso.clientSecret,
            redirectUri: redirectUriFor(input.publicUrl),
          },
          tx
        );
      } catch (error) {
        if (error instanceof AppError && error.statusCode === 400) throw new Rejected('sso_invalid', error.message);
        throw error;
      }
      await this.deps.authSettings.enableOidcSignIn(tx);
      const [created] = await tx
        .insert(users)
        .values({
          oidcSubject: owner.sub,
          oidcIssuer: normalizeOidcIssuer(input.issuer),
          authMethod: 'oidc',
          email: owner.email,
          name: owner.name?.trim() || owner.email,
          avatarUrl: null,
          groupId: adminGroup.id,
        })
        .returning({ id: users.id });
      if (!created) throw new Error('The owner was not created');
      await this.deps.finalizeSetup.initializeOwner(created.id, tx);
      await this.deps.setupPolicy.markSetupCompleteIn(tx);
      await tx.delete(settings).where(eq(settings.key, FIRST_ADMIN_CLAIM_KEY));
      return created.id;
    });
  }

  /**
   * An installation with administrators: a new client replaces the client of the Opfield account provider, or is kept
   * for a later return when the admin removed that provider or chose another one.
   */
  private async replaceClient(input: ManagedSsoInput): Promise<ManagedSsoOutcome> {
    const sso = input.sso;
    if (!sso?.clientSecret) return 'done';
    const current = await this.deps.oidcSettings.getPublicConfig();
    const issuer = validIssuer(sso.issuer);
    let origin: string | null;
    try {
      origin = normalizePublicUrl(input.publicUrl) ?? (await this.deps.generalSettings.getConfig()).publicUrl;
    } catch (error) {
      throw new Rejected('public_url_invalid', errorMessage(error));
    }
    origin ??= current.redirectUri ? new URL(current.redirectUri).origin : null;
    if (!origin) throw new Rejected('public_url_missing', 'Neither the file nor the settings have a public URL');

    if (!current.configured || !current.opfieldAccount) {
      // The admin removed the Opfield account provider or signs in with another one: that choice stays. The new
      // client is kept, so "Use Opfield account for sign-in" brings the Opfield account back with it.
      try {
        await this.deps.oidcSettings.keepOpfieldAccountClient({
          issuer,
          clientId: sso.clientId,
          clientSecret: sso.clientSecret,
          redirectUri: redirectUriFor(origin),
        });
      } catch (error) {
        if (error instanceof AppError && error.statusCode === 400) throw new Rejected('sso_invalid', error.message);
        throw error;
      }
      await this.deps.audit({
        step: 'client_kept',
        reason: current.configured ? 'another_provider' : 'no_opfield_provider',
        issuer,
        clientId: sso.clientId,
        redirectUri: redirectUriFor(origin),
      });
      logger.info('Kept the new Opfield account client; the installation keeps the sign-in its admin chose');
      return 'done';
    }

    if (normalizeOidcIssuer(issuer) !== normalizeOidcIssuer(current.issuer)) {
      // Accounts are bound to the issuer: another one must leave an administrator who can still sign in.
      try {
        await assertAdminSignInRemains(
          this.deps.db,
          { issuer },
          { methods: (await this.deps.authSettings.getConfig()).methods, issuer: current.issuer }
        );
      } catch (error) {
        if (error instanceof AppError) throw new Rejected('last_admin_sign_in', error.message);
        throw error;
      }
    }
    let result: { clientChanged: boolean };
    try {
      result = await this.deps.oidcSettings.saveOpfieldAccountProvider({
        issuer,
        clientId: sso.clientId,
        clientSecret: sso.clientSecret,
        redirectUri: redirectUriFor(origin),
      });
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 400) throw new Rejected('sso_invalid', error.message);
      throw error;
    }
    this.deps.invalidateOidc();
    if (result.clientChanged) {
      await this.deps.audit({
        step: 'client_replaced',
        issuer,
        clientId: sso.clientId,
        redirectUri: redirectUriFor(origin),
        previousIssuer: current.issuer,
        previousClientId: current.clientId,
      });
      logger.info('Replaced the client of the Opfield account provider from the enrolment file');
    }
    return 'done';
  }

  private async restoreGeneral(before: GeneralSettings, applied: GeneralSettings): Promise<void> {
    try {
      // Only what this pass wrote, and only where nothing changed it since.
      await this.deps.generalSettings.restoreFields(before, GENERAL_FIELDS, { ifUnchangedFrom: applied });
      await this.deps.refreshIdentities?.();
    } catch (error) {
      logger.error('Could not restore the public URL after the Opfield account sign-in failed', {
        error: errorMessage(error),
      });
    }
  }
}
