import { AppError } from '@/middleware/error-handler.js';
import type { AuthService } from '@/modules/auth/auth.service.js';

const MOUNTS_SCOPE = 'docker:containers:mounts';

/**
 * The account an automatic deployment acts for when it gives a workload with host bind mounts a new image: whoever
 * last saved what drives the automation. For a Git source that is `docker_source_bindings.updated_by_id`, for a
 * webhook `docker_webhooks.updated_by_id`. New code gets the same host access, so the deployment runs only while that
 * account holds docker:containers:mounts on the workload, read from its current permissions when the deployment runs.
 */
export interface AutomaticDeployAuthority {
  /** The configuring account, when one is recorded and still exists. */
  user: { id: string; label: string } | null;
  /** Why no account can authorize the deployment: none recorded or it no longer exists, or it is blocked. */
  unavailable: 'unknown' | 'inactive' | null;
  scopes: string[];
}

export async function resolveAutomaticDeployAuthority(
  auth: Pick<AuthService, 'getUserById'> | undefined,
  source: { updatedById?: string | null }
): Promise<AutomaticDeployAuthority> {
  const user = source.updatedById ? await auth?.getUserById(source.updatedById) : null;
  if (!user || user.isDeleted) return { user: null, unavailable: 'unknown', scopes: [] };
  const identity = { id: user.id, label: user.name ? `${user.name} (${user.email})` : user.email };
  if (user.isBlocked) return { user: identity, unavailable: 'inactive', scopes: [] };
  return { user: identity, unavailable: null, scopes: user.scopes };
}

/**
 * The refusal of a webhook call that would give a workload with host bind mounts a new image while the account that
 * last saved the webhook cannot authorize it. `error` is the mount guard's refusal; anything else yields null.
 */
export function webhookDeployMountsRefusal(
  error: unknown,
  authority: AutomaticDeployAuthority,
  workload: string,
  kind: 'update' | 'deployment'
): AppError | null {
  if ((error as { code?: unknown } | null)?.code !== 'MISSING_DOCKER_MOUNTS_SCOPE') return null;
  const reason =
    authority.unavailable === 'unknown'
      ? 'Opfield cannot tell whose permissions the webhook uses: it was saved before Opfield recorded that, or the account that last saved it no longer exists'
      : authority.unavailable === 'inactive'
        ? `the account that last saved the webhook, ${authority.user!.label}, is blocked`
        : `${authority.user!.label}, who last saved the webhook and whose permissions webhook calls use, does not hold ${MOUNTS_SCOPE} on it`;
  const fix =
    authority.unavailable === null
      ? `Grant ${MOUNTS_SCOPE} on this workload to ${authority.user!.label}, or save the webhook again as a user who holds it.`
      : `Save the webhook again (configure it, or regenerate its URL) as a user who holds ${MOUNTS_SCOPE} on this workload.`;
  return new AppError(
    403,
    'MISSING_DOCKER_MOUNTS_SCOPE',
    `Webhook ${kind} refused: ${workload} has host bind mounts, so running a new image on it needs ${MOUNTS_SCOPE}, and ${reason}. ${fix}`
  );
}
