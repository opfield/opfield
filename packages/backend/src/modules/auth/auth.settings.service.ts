import { and, count, eq, isNull, not, or } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import { permissionGroups, settings, type UserAuthMethod, userPasskeys, users } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';

const GATEWAY_SYSTEM_OIDC_SUBJECT = 'system:gateway-setup';

const AUTH_SETTINGS_DEFAULTS = {
  'auth:oidc_auto_create_users': true,
  'auth:oidc_require_verified_email': false,
  'auth:oauth_extended_callback_compatibility': false,
  'auth:mfa_existing_session_grace_period_days': 3,
  'auth:methods': { oidc: true, password: false, emailOtp: false, passkeyLogin: false },
  'auth:password_policy': {
    minLength: 12,
    maxLength: 72,
    requireUppercase: false,
    requireLowercase: false,
    requireDigit: false,
    requireSymbol: false,
  },
} as const;

export interface LocalAuthMethods {
  oidc: boolean;
  password: boolean;
  emailOtp: boolean;
  passkeyLogin: boolean;
}

export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
}

export interface AuthProvisioningSettings {
  oidcAutoCreateUsers: boolean;
  oidcDefaultGroupId: string;
  oidcRequireVerifiedEmail: boolean;
  oauthExtendedCallbackCompatibility: boolean;
  mfaExistingSessionGracePeriodDays: number;
  methods: LocalAuthMethods;
  passwordPolicy: PasswordPolicy;
}

export class AuthSettingsService {
  constructor(private readonly db: DrizzleClient) {}

  async getConfig(): Promise<AuthProvisioningSettings> {
    const autoCreateUsers = await this.getSetting<boolean>(
      'auth:oidc_auto_create_users',
      AUTH_SETTINGS_DEFAULTS['auth:oidc_auto_create_users']
    );

    const defaultGroupId = await this.resolveDefaultGroupId();
    const requireVerifiedEmail = await this.getSetting<boolean>(
      'auth:oidc_require_verified_email',
      AUTH_SETTINGS_DEFAULTS['auth:oidc_require_verified_email']
    );
    const oauthExtendedCallbackCompatibility = await this.getSetting<boolean>(
      'auth:oauth_extended_callback_compatibility',
      AUTH_SETTINGS_DEFAULTS['auth:oauth_extended_callback_compatibility']
    );
    const mfaExistingSessionGracePeriodDays = await this.getSetting<number>(
      'auth:mfa_existing_session_grace_period_days',
      AUTH_SETTINGS_DEFAULTS['auth:mfa_existing_session_grace_period_days']
    );
    const methods = await this.getSetting<LocalAuthMethods>('auth:methods', AUTH_SETTINGS_DEFAULTS['auth:methods']);
    const passwordPolicy = await this.getSetting<PasswordPolicy>(
      'auth:password_policy',
      AUTH_SETTINGS_DEFAULTS['auth:password_policy']
    );

    return {
      oidcAutoCreateUsers: autoCreateUsers,
      oidcDefaultGroupId: defaultGroupId,
      oidcRequireVerifiedEmail: requireVerifiedEmail,
      oauthExtendedCallbackCompatibility,
      mfaExistingSessionGracePeriodDays,
      methods,
      passwordPolicy,
    };
  }

  async updateConfig(updates: {
    oidcAutoCreateUsers?: boolean;
    oidcDefaultGroupId?: string;
    oidcRequireVerifiedEmail?: boolean;
    oauthExtendedCallbackCompatibility?: boolean;
    mfaExistingSessionGracePeriodDays?: number;
    methods?: Partial<LocalAuthMethods>;
    passwordPolicy?: Partial<PasswordPolicy>;
  }): Promise<AuthProvisioningSettings> {
    if (updates.oidcAutoCreateUsers !== undefined) {
      await this.setSetting('auth:oidc_auto_create_users', updates.oidcAutoCreateUsers);
    }

    if (updates.oidcRequireVerifiedEmail !== undefined) {
      await this.setSetting('auth:oidc_require_verified_email', updates.oidcRequireVerifiedEmail);
    }

    if (updates.oauthExtendedCallbackCompatibility !== undefined) {
      await this.setSetting('auth:oauth_extended_callback_compatibility', updates.oauthExtendedCallbackCompatibility);
    }

    if (updates.mfaExistingSessionGracePeriodDays !== undefined) {
      if (
        !Number.isInteger(updates.mfaExistingSessionGracePeriodDays) ||
        updates.mfaExistingSessionGracePeriodDays < 0 ||
        updates.mfaExistingSessionGracePeriodDays > 7
      ) {
        throw new AppError(
          400,
          'INVALID_MFA_GRACE_PERIOD',
          'MFA existing-session grace period must be an integer between 0 and 7 days'
        );
      }
      await this.setSetting('auth:mfa_existing_session_grace_period_days', updates.mfaExistingSessionGracePeriodDays);
    }

    if (updates.methods !== undefined) {
      const current = await this.getSetting<LocalAuthMethods>('auth:methods', AUTH_SETTINGS_DEFAULTS['auth:methods']);
      const next = { ...current, ...updates.methods };
      if (!next.oidc && !next.password && !next.emailOtp) {
        throw new AppError(
          409,
          'AUTH_METHOD_REQUIRED',
          'At least one primary authentication method must remain enabled'
        );
      }
      for (const [method, enabled] of Object.entries(updates.methods)) {
        if (enabled !== false) continue;
        if (method === 'passkeyLogin') {
          const [{ count: passkeyCount }] = await this.db.select({ count: count() }).from(userPasskeys);
          if (Number(passkeyCount) > 0)
            throw new AppError(409, 'AUTH_METHOD_IN_USE', 'Cannot disable passkey login while users exist');
          continue;
        }
        const authMethod: UserAuthMethod = method === 'emailOtp' ? 'email_otp' : (method as UserAuthMethod);
        const assignedUserCondition =
          authMethod === 'oidc'
            ? and(
                eq(users.authMethod, authMethod),
                or(isNull(users.oidcSubject), not(eq(users.oidcSubject, GATEWAY_SYSTEM_OIDC_SUBJECT)))
              )
            : eq(users.authMethod, authMethod);
        const [{ count: userCount }] = await this.db
          .select({ count: count() })
          .from(users)
          .where(assignedUserCondition);
        if (Number(userCount) > 0)
          throw new AppError(409, 'AUTH_METHOD_IN_USE', `Cannot disable ${method} while users are assigned to it`);
      }
      await this.setSetting('auth:methods', next);
    }

    if (updates.passwordPolicy !== undefined) {
      const current = await this.getSetting<PasswordPolicy>(
        'auth:password_policy',
        AUTH_SETTINGS_DEFAULTS['auth:password_policy']
      );
      const next = { ...current, ...updates.passwordPolicy };
      if (
        !Number.isInteger(next.minLength) ||
        !Number.isInteger(next.maxLength) ||
        next.minLength < 8 ||
        next.maxLength > 72 ||
        next.minLength > next.maxLength
      ) {
        throw new Error('Password policy must use a minimum of 8 and a maximum of 72 bytes');
      }
      await this.setSetting('auth:password_policy', next);
    }

    if (updates.oidcDefaultGroupId !== undefined) {
      const group = await this.db.query.permissionGroups.findFirst({
        where: eq(permissionGroups.id, updates.oidcDefaultGroupId),
      });
      if (!group) {
        throw new Error('Permission group not found');
      }
      await this.setSetting('auth:oidc_default_group_id', group.id);
    }

    return this.getConfig();
  }

  async getOAuthExtendedCallbackCompatibility(): Promise<boolean> {
    return this.getSetting<boolean>(
      'auth:oauth_extended_callback_compatibility',
      AUTH_SETTINGS_DEFAULTS['auth:oauth_extended_callback_compatibility']
    );
  }

  async resolveDefaultGroupId(): Promise<string> {
    const stored = await this.getSetting<string | null>('auth:oidc_default_group_id', null);
    if (stored) {
      const existing = await this.db.query.permissionGroups.findFirst({
        where: eq(permissionGroups.id, stored),
      });
      if (existing) return existing.id;
    }

    const viewerGroup = await this.db.query.permissionGroups.findFirst({
      where: eq(permissionGroups.name, 'viewer'),
    });
    if (!viewerGroup) {
      throw new Error('Built-in group "viewer" not found. Has the migration been run?');
    }

    await this.setSetting('auth:oidc_default_group_id', viewerGroup.id);
    return viewerGroup.id;
  }

  /** Turns OIDC sign-in on in the caller's transaction (a managed installation's Opfield account sign-in). */
  async enableOidcSignIn(executor: DrizzleExecutor): Promise<void> {
    const [row] = await executor.select().from(settings).where(eq(settings.key, 'auth:methods')).limit(1);
    const current = (row?.value ?? AUTH_SETTINGS_DEFAULTS['auth:methods']) as LocalAuthMethods;
    if (current.oidc) return;
    const value = { ...current, oidc: true };
    await executor
      .insert(settings)
      .values({ key: 'auth:methods', value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  }

  private async getSetting<T>(key: string, fallback: T): Promise<T> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
    return (row?.value !== undefined ? row.value : fallback) as T;
  }

  private async setSetting(key: string, value: unknown): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: new Date() },
      });
  }
}
