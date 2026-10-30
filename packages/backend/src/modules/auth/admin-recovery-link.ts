import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import { permissionGroups, settings, users } from '@/db/schema/index.js';
import { FINALIZE_SETUP_STATE_KEY } from '@/modules/onboarding/finalize-setup.service.js';
import type { CacheService } from '@/services/cache.service.js';
import { issueAdminRecoveryToken } from './local-auth.service.js';

/** Short: the link signs in without the administrator's provider or second factor. */
export const ADMIN_RECOVERY_LINK_TTL_SECONDS = 30 * 60;
/** The page that takes the link (the frontend's RecoverySignIn). */
export const ADMIN_RECOVERY_PATH = '/recovery-sign-in';
/** Where the administrator lands after a recovery sign-in, to fix their sign-in. */
export const ADMIN_RECOVERY_LANDING = '/profile#security';

export interface AdminRecoveryLink {
  email: string;
  url: string;
  expiresAt: string;
}

interface RecoveryAccount {
  id: string;
  email: string;
  isBlocked: boolean;
  deletedAt: Date | null;
  oidcSubject: string | null;
}

async function ownerUserId(db: DrizzleClient): Promise<string | null> {
  const [state] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, FINALIZE_SETUP_STATE_KEY))
    .limit(1);
  const id = (state?.value as { ownerUserId?: unknown } | undefined)?.ownerUserId;
  return typeof id === 'string' && id ? id : null;
}

/** Whether the user is an active system administrator (the built-in system account never is). */
export async function isActiveSystemAdmin(db: DrizzleExecutor, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(permissionGroups, eq(permissionGroups.name, 'system-admin'))
    .where(
      and(
        eq(users.id, userId),
        isNull(users.deletedAt),
        eq(users.isBlocked, false),
        or(isNull(users.oidcSubject), sql`${users.oidcSubject} NOT LIKE 'system:%'`),
        or(eq(users.groupId, permissionGroups.id), sql`${permissionGroups.id} = any(${users.additionalGroupIds})`)
      )
    )
    .limit(1);
  return Boolean(row);
}

/**
 * A one-time link (30 minutes, used once, only its hash stored) that signs a system administrator in without their
 * usual provider or second factor, for an administrator locked out of their own sign-in. Default: the owner of the
 * installation; `email` picks another system administrator. Printed by cli/admin-recovery-link on the host only.
 */
export async function issueAdminRecoveryLink(
  db: DrizzleClient,
  cache: Pick<CacheService, 'set'>,
  publicUrl: string,
  options: { email?: string } = {},
  now: () => number = Date.now
): Promise<AdminRecoveryLink> {
  const columns = { id: true, email: true, isBlocked: true, deletedAt: true, oidcSubject: true } as const;
  let account: RecoveryAccount | undefined;
  const email = options.email?.trim().toLowerCase();
  if (email) {
    account = await db.query.users.findFirst({ where: eq(users.email, email), columns });
    if (!account) throw new Error(`No account with the email ${email}`);
  } else {
    const ownerId = await ownerUserId(db);
    if (!ownerId) throw new Error('This installation has no owner recorded; name an administrator with --email');
    account = await db.query.users.findFirst({ where: eq(users.id, ownerId), columns });
    if (!account)
      throw new Error('The owner of this installation no longer exists; name an administrator with --email');
  }
  if (account.oidcSubject?.startsWith('system:')) throw new Error('The built-in system account cannot sign in');
  if (account.deletedAt) throw new Error(`${account.email} is deleted`);
  if (account.isBlocked) throw new Error(`${account.email} is blocked`);
  if (!(await isActiveSystemAdmin(db, account.id))) {
    throw new Error(
      `${account.email} is not a system administrator; recovery links are only for system administrators`
    );
  }
  const token = await issueAdminRecoveryToken(cache, account.id, ADMIN_RECOVERY_LINK_TTL_SECONDS);
  const url = new URL(ADMIN_RECOVERY_PATH, publicUrl);
  url.searchParams.set('token', token);
  return {
    email: account.email,
    url: url.toString(),
    expiresAt: new Date(now() + ADMIN_RECOVERY_LINK_TTL_SECONDS * 1000).toISOString(),
  };
}
