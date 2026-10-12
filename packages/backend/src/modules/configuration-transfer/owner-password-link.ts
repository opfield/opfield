import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { settings, users } from '@/db/schema/index.js';
import { issuePasswordSetupLink } from '@/modules/auth/local-auth.service.js';
import { FINALIZE_SETUP_STATE_KEY } from '@/modules/onboarding/finalize-setup.service.js';
import type { CacheService } from '@/services/cache.service.js';

/** Long enough to finish reading the installer output and open the console on the new host. */
export const OWNER_PASSWORD_LINK_TTL_SECONDS = 24 * 60 * 60;

export interface OwnerPasswordLink {
  email: string;
  url: string;
  expiresAt: string;
}

/**
 * A one-time link that sets the password of the installation owner, for a copy restored from a managed cloud
 * installation (the restore moved the owner to password sign-in). Refuses an owner who does not sign in with a
 * password, so it never opens a second way into an account that uses another method.
 */
export async function issueOwnerPasswordLink(
  db: DrizzleClient,
  cache: Pick<CacheService, 'set'>,
  publicUrl: string,
  now: () => number = Date.now
): Promise<OwnerPasswordLink> {
  const [state] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, FINALIZE_SETUP_STATE_KEY))
    .limit(1);
  const ownerUserId = (state?.value as { ownerUserId?: unknown } | undefined)?.ownerUserId;
  if (typeof ownerUserId !== 'string') throw new Error('This installation has no owner recorded');
  const owner = await db.query.users.findFirst({
    where: eq(users.id, ownerUserId),
    columns: { id: true, email: true, authMethod: true, isBlocked: true },
  });
  if (!owner) throw new Error('The owner of this installation no longer exists');
  if (owner.isBlocked) throw new Error('The owner of this installation is blocked');
  if (owner.authMethod !== 'password') {
    throw new Error('The owner does not sign in with a password; no password link is issued');
  }
  const url = await issuePasswordSetupLink(cache, owner.id, publicUrl, OWNER_PASSWORD_LINK_TTL_SECONDS);
  return {
    email: owner.email,
    url,
    expiresAt: new Date(now() + OWNER_PASSWORD_LINK_TTL_SECONDS * 1000).toISOString(),
  };
}
