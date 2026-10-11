import { and, eq, isNull, notLike, or, sql } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleExecutor } from '@/db/client.js';
import { permissionGroups, type UserAuthMethod, users } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { normalizeOidcIssuer } from './auth.service.js';
import { AuthSettingsService, type LocalAuthMethods } from './auth.settings.service.js';
import { OidcSettingsService } from './oidc-settings.service.js';

type SignInMethods = Pick<LocalAuthMethods, 'oidc' | 'password' | 'emailOtp'>;

export interface SignInState {
  methods: SignInMethods;
  /** The configured OIDC issuer; null when OIDC is not configured. */
  issuer: string | null;
}

interface AdminAccount {
  authMethod: UserAuthMethod;
  oidcIssuer: string | null;
}

/** Whether an administrator can still sign in under these settings. */
export function adminCanSignIn(admin: AdminAccount, state: SignInState): boolean {
  switch (admin.authMethod) {
    case 'password':
      return state.methods.password;
    case 'email_otp':
      return state.methods.emailOtp;
    case 'oidc':
      // An account bound to an issuer signs in only through it; one not bound yet is bound on its next sign-in.
      return (
        state.methods.oidc &&
        state.issuer !== null &&
        (admin.oidcIssuer === null || normalizeOidcIssuer(admin.oidcIssuer) === normalizeOidcIssuer(state.issuer))
      );
    default:
      return false;
  }
}

/** Active system administrators (not deleted or blocked; the built-in system account cannot sign in). */
export async function activeSystemAdmins(db: DrizzleExecutor): Promise<AdminAccount[]> {
  return db
    .select({ authMethod: users.authMethod, oidcIssuer: users.oidcIssuer })
    .from(users)
    .innerJoin(permissionGroups, eq(permissionGroups.name, 'system-admin'))
    .where(
      and(
        isNull(users.deletedAt),
        eq(users.isBlocked, false),
        or(isNull(users.oidcSubject), notLike(users.oidcSubject, 'system:%')),
        or(eq(users.groupId, permissionGroups.id), sql`${permissionGroups.id} = any(${users.additionalGroupIds})`)
      )
    );
}

/**
 * Refuses an OIDC provider change after which no administrator could sign in, e.g. replacing the Opfield account
 * provider of a managed installation while its owner is the only administrator. A state in which nobody could sign in
 * already is not made worse, so it is not refused.
 */
export async function assertAdminSignInRemains(
  db: DrizzleExecutor,
  change: { issuer?: string | null; methods?: Partial<SignInMethods> },
  current?: SignInState
): Promise<void> {
  const before = current ?? (await currentSignInState());
  const { methods, issuer } = before;
  const after: SignInState = {
    methods: { ...methods, ...stripUndefined(change.methods) },
    issuer: change.issuer === undefined ? issuer : change.issuer,
  };
  const admins = await activeSystemAdmins(db);
  if (!admins.some((admin) => adminCanSignIn(admin, before))) return;
  if (admins.some((admin) => adminCanSignIn(admin, after))) return;
  throw new AppError(
    409,
    'LAST_ADMIN_SIGN_IN',
    'No administrator could sign in after this change. Give another administrator a sign-in method that stays available first.'
  );
}

async function currentSignInState(): Promise<SignInState> {
  const [{ methods }, issuer] = await Promise.all([
    container.resolve(AuthSettingsService).getConfig(),
    container.resolve(OidcSettingsService).getIssuer(),
  ]);
  return { methods, issuer };
}

function stripUndefined(methods: Partial<SignInMethods> | undefined): Partial<SignInMethods> {
  return Object.fromEntries(Object.entries(methods ?? {}).filter(([, value]) => typeof value === 'boolean'));
}
