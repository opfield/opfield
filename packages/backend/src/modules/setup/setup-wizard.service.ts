import { randomUUID } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { permissionGroups, settings, users } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuthService } from '@/modules/auth/auth.service.js';
import type { AuthSettingsService, LocalAuthMethods, PasswordPolicy } from '@/modules/auth/auth.settings.service.js';
import type { AuthMailService, SmtpConfigInput } from '@/modules/auth/auth-mail.service.js';
import type { LocalAuthService } from '@/modules/auth/local-auth.service.js';
import type { MfaService } from '@/modules/auth/mfa.service.js';
import type { OidcConfigInput, OidcSettingsService } from '@/modules/auth/oidc-settings.service.js';
import type { LoggingRuntimeService } from '@/modules/logging/logging-runtime.service.js';
import type { LoggingSettingsInput } from '@/modules/logging/logging-settings.service.js';
import type { McpSettingsService } from '@/modules/mcp/mcp-settings.service.js';
import { FINALIZE_SETUP_STATE_KEY, type FinalizeSetupService } from '@/modules/onboarding/finalize-setup.service.js';
import {
  type GeneralSettings,
  type GeneralSettingsService,
  normalizeHostPortTarget,
  normalizeIpPortTarget,
  normalizePublicUrl,
} from '@/modules/settings/general-settings.service.js';
import type { SetupAccessService } from './setup-access.service.js';
import { readSetupOpfieldAccountAdmin, SETUP_OPFIELD_ACCOUNT_ADMIN_KEY } from './setup-cloud-connect.js';
import type { SetupTokenPolicyService } from './setup-token-policy.js';

/**
 * The wizard's three ways for people to sign in: the Opfield account (the account portal is the OIDC provider), the
 * customer's own OIDC provider, or a password with an authenticator app (an email code may be added next to it).
 */
export type SetupSignInOption = 'opfield_account' | 'oidc' | 'password_totp';

export interface SetupAuthInput {
  option: SetupSignInOption;
  methods: Pick<LocalAuthMethods, 'oidc' | 'password' | 'emailOtp'>;
  oidc?: OidcConfigInput;
  smtp?: SmtpConfigInput;
  passwordPolicy?: Partial<PasswordPolicy>;
}

export interface SetupAdminInput {
  name: string;
  email: string;
  authMethod: 'oidc' | 'password';
  password?: string;
}

/** The administrator the wizard created, as the wizard shows it. */
export interface SetupAdministratorView {
  email: string;
  name: string | null;
  authMethod: string;
  /** An authenticator app or a passkey is set up (always false for an OIDC account: the provider handles it). */
  secondFactor: boolean;
}

/** Why the sign-in methods do not match the chosen option; null when they do. */
export function signInOptionError(input: Pick<SetupAuthInput, 'option' | 'methods'>): string | null {
  const { option, methods } = input;
  if (option === 'opfield_account' || option === 'oidc') {
    if (methods.oidc && !methods.password && !methods.emailOtp) return null;
    return option === 'opfield_account'
      ? 'Sign-in with the Opfield account uses no password or email code'
      : 'Sign-in with your OIDC provider uses no password or email code';
  }
  if (option === 'password_totp') {
    if (!methods.oidc && methods.password) return null;
    return methods.emailOtp && !methods.password
      ? 'The email code is offered only next to a password with an authenticator app'
      : 'A password with an authenticator app cannot be combined with OIDC sign-in in setup';
  }
  return 'Choose how people sign in: Opfield account, your OIDC provider, or a password with an authenticator app';
}

export interface SetupNetworkInput {
  grpcPublicTarget: string;
  grpcLocalIp: string;
}

export interface SetupApplyInput {
  publicUrl: string;
  network: SetupNetworkInput;
  auth: SetupAuthInput;
  administrator?: SetupAdminInput;
  logging: LoggingSettingsInput;
}

/** Held while the first administrator is created (by the wizard, or by a managed installation's enrolment). */
export const FIRST_ADMIN_CLAIM_KEY = 'setup:first_admin_claim';
const SETUP_WIZARD_PHASE_KEY = 'setup:wizard_phase';
const SETUP_AI_WORKSPACE_OUTCOME_KEY = 'setup:ai_workspace_outcome';
export const FIRST_ADMIN_CLAIM_TTL_MS = 10 * 60 * 1000;
const logger = createChildLogger('SetupWizard');
/** General settings the setup wizard writes, and so the only ones its rollback restores. */
const SETUP_GENERAL_SETTINGS_FIELDS = ['publicUrl', 'grpcPublicTarget', 'grpcLocalIp'] as const;

/** Input the administrator can correct: 400 with the message the wizard shows. */
function invalidSetup(message: string): AppError {
  return new AppError(400, 'SETUP_INVALID', message);
}

/** The general settings normalizers reject bad input with a plain Error. */
function setupInput<T>(normalize: () => T): T {
  try {
    return normalize();
  } catch (error) {
    throw error instanceof Error ? invalidSetup(error.message) : error;
  }
}

function administratorExists(message: string): AppError {
  return new AppError(409, 'SETUP_ADMINISTRATOR_EXISTS', message);
}

function configurationRequired(message: string): AppError {
  return new AppError(409, 'SETUP_CONFIGURATION_REQUIRED', message);
}

export class SetupWizardService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly policy: SetupTokenPolicyService,
    private readonly access: SetupAccessService,
    private readonly generalSettings: GeneralSettingsService,
    private readonly authSettings: AuthSettingsService,
    private readonly oidcSettings: OidcSettingsService,
    private readonly authMail: AuthMailService,
    private readonly authService: AuthService,
    private readonly localAuth: LocalAuthService,
    private readonly finalizeSetup: FinalizeSetupService,
    private readonly mcpSettings: McpSettingsService,
    private readonly mfa: Pick<MfaService, 'beginTotpSetup' | 'confirmTotpSetup' | 'requiresLocalMfa'>,
    private readonly refreshGrpcIdentity?: () => Promise<void>,
    private readonly refreshWebIdentity?: () => Promise<void>
  ) {}

  async configureGeneral(
    publicUrl: string,
    network: SetupNetworkInput,
    onApplied?: (general: GeneralSettings) => void
  ) {
    const general = await this.generalSettings.updateConfig({
      publicUrl,
      grpcPublicTarget: network.grpcPublicTarget,
      grpcLocalIp: network.grpcLocalIp || null,
    });
    onApplied?.(general);
    await Promise.all([this.refreshGrpcIdentity?.(), this.refreshWebIdentity?.()]);
    return general;
  }

  async configureAuth(input: SetupAuthInput) {
    const optionError = signInOptionError(input);
    if (optionError) throw invalidSetup(optionError);
    if (input.option === 'opfield_account') {
      // The account portal handed the client over the cloud link (see SetupCloudConnect); nothing is entered here.
      const provider = await this.oidcSettings.getPublicConfig();
      if (!provider.configured || !provider.opfieldAccount) {
        throw invalidSetup(
          'The Opfield account sign-in client has not arrived yet. Connect the Opfield account first.'
        );
      }
    } else if (input.option === 'oidc') {
      if (input.oidc) {
        await this.oidcSettings.saveConfig(input.oidc);
        this.authService.invalidateOidcConfiguration();
      } else if ((await this.oidcSettings.getPublicConfig()).opfieldAccount) {
        throw invalidSetup('Enter your OIDC provider: the Opfield account is configured as the provider now');
      }
    }
    if (input.methods.oidc && !(await this.oidcSettings.getPublicConfig()).configured) {
      throw invalidSetup('OIDC must be configured before enabling OIDC sign-in');
    }

    if (input.smtp) {
      await this.authMail.verifyAndSaveConfig(input.smtp);
    }
    // A password with an authenticator app needs no SMTP (the admin recovery command replaces a reset email); the
    // email code does.
    if (input.methods.emailOtp) {
      const smtp = await this.authMail.getPublicConfig();
      if (!smtp.verifiedAt) throw invalidSetup('SMTP must be configured and verified for email code sign-in');
    }

    return this.authSettings.updateConfig({
      methods: { ...input.methods, passkeyLogin: false },
      passwordPolicy: input.passwordPolicy,
    });
  }

  async apply(input: SetupApplyInput, loggingRuntime: LoggingRuntimeService) {
    const administratorCreated = await this.validateApply(input);
    const [generalSnapshot, authSnapshot, oidcSnapshot, smtpSnapshot, loggingSnapshot] = await Promise.all([
      this.generalSettings.getConfig(),
      this.authSettings.getConfig(),
      this.oidcSettings.snapshotConfig(),
      this.authMail.snapshotConfig(),
      loggingRuntime.snapshot(),
    ]);
    let createdAdministratorId: string | null = null;
    const applied: { general: GeneralSettings | null } = { general: null };

    try {
      await this.configureGeneral(input.publicUrl, input.network, (general) => {
        applied.general = general;
      });
      await this.configureAuth(input.auth);
      // Keeping structured logging off changes nothing, and Community has no logging runtime to call.
      if (input.logging.mode !== 'disabled' || loggingSnapshot.mode !== 'disabled') {
        await loggingRuntime.update(input.logging);
      }
      if (!administratorCreated) {
        createdAdministratorId = (await this.createAdministrator(await this.applyAdministrator(input))).id;
      }
      if (input.auth.option === 'password_totp') await this.requireAdminSecondFactor();
      await this.setPhase('ai_workspace');
      return { status: 'ready_for_ai' as const };
    } catch (error) {
      const rollbackFailures: unknown[] = [];
      const rollback = async (task: () => Promise<unknown>) => {
        try {
          await task();
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      };
      const administratorIdToRollback = createdAdministratorId;
      if (administratorIdToRollback) {
        await rollback(() => this.rollbackAdministrator(administratorIdToRollback));
      }
      await rollback(() => loggingRuntime.restore(loggingSnapshot));
      await rollback(() => this.authSettings.updateConfig(authSnapshot));
      await rollback(() => this.oidcSettings.restoreConfig(oidcSnapshot));
      await rollback(() => this.authMail.restoreConfig(smtpSnapshot));
      const generalToRollback = applied.general;
      if (generalToRollback) {
        await rollback(async () => {
          // Undo only the fields setup wrote, and only where nothing changed them since, so a
          // concurrent settings save is not overwritten by the whole pre-setup snapshot.
          await this.generalSettings.restoreFields(generalSnapshot, SETUP_GENERAL_SETTINGS_FIELDS, {
            ifUnchangedFrom: generalToRollback,
          });
          await Promise.all([this.refreshGrpcIdentity?.(), this.refreshWebIdentity?.()]);
        });
      }
      if (rollbackFailures.length > 0) {
        logger.error('Setup apply rollback was incomplete', {
          failures: rollbackFailures.map((rollbackError) =>
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          ),
        });
      }
      this.authService.invalidateOidcConfiguration();
      throw error;
    }
  }

  /**
   * Password with an authenticator app: the administrator is created with their password before the wizard goes on,
   * so the authenticator app can be enrolled for that account (see beginAdministratorTotp).
   */
  async createPasswordAdministrator(
    auth: SetupAuthInput,
    administrator: { name: string; email: string; password: string }
  ): Promise<SetupAdministratorView> {
    if (auth.option !== 'password_totp') {
      throw invalidSetup('Only the password with an authenticator app option creates the administrator here');
    }
    if (await this.policy.isOpfieldConfigured()) {
      throw administratorExists('The first administrator has already been created');
    }
    await this.configureAuth(auth);
    await this.createAdministrator({ ...administrator, authMethod: 'password' });
    return (await this.administratorView())!;
  }

  /** The QR secret of the administrator's authenticator app; only for the password administrator the wizard made. */
  async beginAdministratorTotp(): Promise<{ secret: string; uri: string }> {
    const owner = await this.passwordOwner();
    return this.mfa.beginTotpSetup(owner.id, owner.email);
  }

  /**
   * Confirms the authenticator app with a code and returns the recovery codes (shown once). From then on the
   * administrators' group requires a second factor.
   */
  async confirmAdministratorTotp(code: string): Promise<string[]> {
    const owner = await this.passwordOwner();
    const recoveryCodes = await this.mfa.confirmTotpSetup(owner.id, code);
    await this.requireAdminSecondFactor();
    return recoveryCodes;
  }

  /** The administrator the wizard created (the owner); null before one exists. */
  async administratorView(): Promise<SetupAdministratorView | null> {
    const owner = await this.owner();
    if (!owner) return null;
    return {
      email: owner.email,
      name: owner.name,
      authMethod: owner.authMethod,
      secondFactor: owner.authMethod !== 'oidc' && (await this.mfa.requiresLocalMfa(owner.id)),
    };
  }

  async createAdministrator(input: SetupAdminInput) {
    if (await this.policy.isOpfieldConfigured()) {
      throw administratorExists('The first administrator has already been created');
    }

    const methods = (await this.authSettings.getConfig()).methods;
    const methodEnabled = input.authMethod === 'oidc' ? methods.oidc : methods.password;
    if (!methodEnabled) throw invalidSetup('The selected administrator authentication method is not enabled');
    if (input.authMethod === 'password' && !input.password) throw invalidSetup('Password is required');
    if (input.authMethod === 'password') await this.localAuth.validateInitialPasswordForSetup(input.password!);

    const claim = randomUUID();
    await this.db
      .delete(settings)
      .where(
        and(
          eq(settings.key, FIRST_ADMIN_CLAIM_KEY),
          lt(settings.updatedAt, new Date(Date.now() - FIRST_ADMIN_CLAIM_TTL_MS))
        )
      );
    const [claimed] = await this.db
      .insert(settings)
      .values({ key: FIRST_ADMIN_CLAIM_KEY, value: claim, updatedAt: new Date() })
      .onConflictDoNothing()
      .returning({ key: settings.key });
    if (!claimed) throw administratorExists('The first administrator is already being created');

    let createdUserId: string | null = null;
    try {
      // Re-check after obtaining the database-backed singleton claim. This
      // closes the race between multiple app processes receiving setup calls.
      if (await this.policy.isOpfieldConfigured()) {
        throw administratorExists('The first administrator has already been created');
      }

      const adminGroup = await this.db.query.permissionGroups.findFirst({
        where: eq(permissionGroups.name, 'system-admin'),
      });
      if (!adminGroup) throw new Error('Built-in system-admin group not found');

      const user = await this.authService.createUser({
        name: input.name,
        email: input.email,
        groupId: adminGroup.id,
        authMethod: input.authMethod,
      });
      createdUserId = user.id;
      if (input.authMethod === 'password') {
        await this.localAuth.setInitialPasswordForSetup(user.id, input.password!);
      }
      await this.finalizeSetup.initializeOwner(user.id);
      return user;
    } catch (error) {
      if (createdUserId)
        await this.db
          .delete(users)
          .where(eq(users.id, createdUserId))
          .catch(() => {});
      if (createdUserId) await this.finalizeSetup.clearOwner(createdUserId).catch(() => {});
      await this.db
        .delete(settings)
        .where(and(eq(settings.key, FIRST_ADMIN_CLAIM_KEY), eq(settings.value, claim)))
        .catch(() => {});
      throw error;
    }
  }

  async getPhase(): Promise<'configuration' | 'ai_workspace'> {
    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, SETUP_WIZARD_PHASE_KEY))
      .limit(1);
    return row?.value === 'ai_workspace' ? 'ai_workspace' : 'configuration';
  }

  async completeAIWorkspace(outcome: {
    status: 'configured' | 'skipped';
    configuredVia?: 'direct' | 'opfield_inference';
  }): Promise<void> {
    if (!(await this.generalSettings.getPublicUrl())) {
      throw configurationRequired('Opfield public URL has not been configured');
    }
    if (!(await this.policy.isOpfieldConfigured()))
      throw configurationRequired('Create the first administrator before completing setup');
    if ((await this.getPhase()) !== 'ai_workspace')
      throw configurationRequired('Apply Opfield setup before configuring AI Workspace');
    const methods = (await this.authSettings.getConfig()).methods;
    if (!methods.oidc && !methods.password && !methods.emailOtp) {
      throw configurationRequired('Configure at least one authentication method before completing setup');
    }
    await this.db
      .insert(settings)
      .values({ key: SETUP_AI_WORKSPACE_OUTCOME_KEY, value: outcome, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: outcome, updatedAt: new Date() },
      });
    await this.finalizeSetup.applySetupAIWorkspaceOutcomeForOwner(outcome.status);
    await this.mcpSettings.updateConfig({ serverEnabled: true });
    await this.policy.markSetupComplete();
    await Promise.allSettled([
      this.access.invalidate(),
      this.db.delete(settings).where(eq(settings.key, FIRST_ADMIN_CLAIM_KEY)),
      this.db.delete(settings).where(eq(settings.key, SETUP_OPFIELD_ACCOUNT_ADMIN_KEY)),
    ]);
  }

  /** The administrators' permission group requires a second factor (password sign-in only; OIDC is the provider's). */
  private async requireAdminSecondFactor(): Promise<void> {
    await this.db
      .update(permissionGroups)
      .set({ require2fa: true, updatedAt: new Date() })
      .where(eq(permissionGroups.name, 'system-admin'));
  }

  /** Who apply creates as the first administrator for the chosen sign-in option. */
  private async applyAdministrator(input: SetupApplyInput): Promise<SetupAdminInput> {
    if (input.auth.option === 'opfield_account') {
      const admin = await readSetupOpfieldAccountAdmin(this.db);
      if (!admin)
        throw invalidSetup('Connect the Opfield account first: the person who connects it becomes the administrator');
      // Bound to the account on their first Opfield account sign-in with this verified email (as any OIDC admin).
      return { name: admin.name ?? admin.email, email: admin.email, authMethod: 'oidc' };
    }
    return input.administrator!;
  }

  private async owner(): Promise<{ id: string; email: string; name: string | null; authMethod: string } | null> {
    const [state] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, FINALIZE_SETUP_STATE_KEY))
      .limit(1);
    const ownerUserId = (state?.value as { ownerUserId?: unknown } | undefined)?.ownerUserId;
    if (typeof ownerUserId !== 'string') return null;
    const owner = await this.db.query.users.findFirst({
      where: eq(users.id, ownerUserId),
      columns: { id: true, email: true, name: true, authMethod: true },
    });
    return owner ?? null;
  }

  private async passwordOwner(): Promise<{ id: string; email: string }> {
    const owner = await this.owner();
    if (!owner || owner.authMethod !== 'password') {
      throw configurationRequired('Create the administrator with a password first');
    }
    return owner;
  }

  private async setPhase(phase: 'configuration' | 'ai_workspace'): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key: SETUP_WIZARD_PHASE_KEY, value: phase, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: phase, updatedAt: new Date() },
      });
  }

  private async rollbackAdministrator(userId: string): Promise<void> {
    await this.db.delete(users).where(eq(users.id, userId));
    await this.db.delete(settings).where(eq(settings.key, FIRST_ADMIN_CLAIM_KEY));
    await this.finalizeSetup.clearOwner(userId);
  }

  private async validateApply(input: SetupApplyInput): Promise<boolean> {
    if (!setupInput(() => normalizePublicUrl(input.publicUrl))) throw invalidSetup('Opfield public URL is required');
    if (!setupInput(() => normalizeHostPortTarget(input.network.grpcPublicTarget))) {
      throw invalidSetup('Opfield gRPC public target is required');
    }
    setupInput(() => normalizeIpPortTarget(input.network.grpcLocalIp));
    const optionError = signInOptionError(input.auth);
    if (optionError) throw invalidSetup(optionError);
    const option = input.auth.option;

    const administratorCreated = await this.policy.isOpfieldConfigured();
    if (!administratorCreated) {
      if (option === 'password_totp') {
        throw configurationRequired('Create the administrator and set up their authenticator app before applying');
      }
      if (option === 'opfield_account' && !(await readSetupOpfieldAccountAdmin(this.db))) {
        throw invalidSetup('Connect the Opfield account first: the person who connects it becomes the administrator');
      }
      if (option === 'oidc') {
        if (!input.administrator) throw invalidSetup('First administrator details are required');
        if (input.administrator.authMethod !== 'oidc') {
          throw invalidSetup('The administrator signs in with your OIDC provider');
        }
      }
    } else {
      const owner = await this.owner();
      if (owner?.authMethod === 'password') {
        if (option !== 'password_totp') {
          throw invalidSetup(
            'The administrator was created with a password: keep the password with an authenticator app'
          );
        }
        if (!(await this.mfa.requiresLocalMfa(owner.id))) {
          throw configurationRequired("Set up the administrator's authenticator app before applying");
        }
      } else if (owner?.authMethod === 'oidc' && option === 'password_totp') {
        throw invalidSetup('The administrator was created for OIDC sign-in: keep an OIDC option');
      }
    }

    if (option === 'oidc' && !input.auth.oidc && !(await this.oidcSettings.getPublicConfig()).configured) {
      throw invalidSetup('OIDC configuration is required');
    }
    if (input.auth.methods.emailOtp && !input.auth.smtp && !(await this.authMail.getPublicConfig()).configured) {
      throw invalidSetup('SMTP configuration is required');
    }
    return administratorCreated;
  }
}
