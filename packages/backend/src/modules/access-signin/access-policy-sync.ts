import { and, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { accessLists, accessServiceTokens, accessSessions, settings } from '@/db/schema/index.js';
import type { SyncAccessPolicyCommand } from '@/grpc/generated/types.js';
import { createChildLogger } from '@/lib/logger.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import { buildAccessPolicyCommand } from './access-policy-builder.js';
import type { AccessSignInSettingsService } from './access-signin-settings.service.js';
import type { AccessSigningKeyService } from './access-signing-key.service.js';

const logger = createChildLogger('AccessPolicySync');

/** nginx daemons that check access lists themselves (access socket, SyncAccessPolicyCommand). */
export const NGINX_ACCESS_AUTH_CAPABILITY = 'nginx_access_auth_v1';
const REVISION_KEY = 'access.policyRevision';
/** Changes made together (a list saved with its routes, a batch of revocations) go out as one policy. */
const DEBOUNCE_MS = 250;

export interface AccessPolicySyncRuntime {
  db: DrizzleClient;
  keys: Pick<AccessSigningKeyService, 'verificationKeys'>;
  settings: Pick<AccessSignInSettingsService, 'signInOrigin'>;
  registry: Pick<NodeRegistryService, 'getNodesByType'>;
  dispatch: Pick<NodeDispatchService, 'sendAccessPolicy'>;
}

let runtime: AccessPolicySyncRuntime | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** Builds run one at a time, so a later revision always carries the later state. */
let chain: Promise<unknown> = Promise.resolve();

export function configureAccessPolicySync(next: AccessPolicySyncRuntime | null): void {
  runtime = next;
}

/** Pushes the access policy to the nginx nodes after a change of access lists, keys, sessions or settings. */
export function scheduleAccessPolicySync(): void {
  if (!runtime || timer) return;
  timer = setTimeout(() => {
    timer = null;
    void syncAccessPolicyNow().catch((error) =>
      logger.warn('Access policy sync failed; the next change or the periodic sync retries', {
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }, DEBOUNCE_MS);
  timer.unref?.();
}

/** Builds the policy with a new revision and sends it to every connected capable nginx node. */
export async function syncAccessPolicyNow(): Promise<void> {
  const current = runtime;
  if (!current) return;
  const nodeIds = capableNodeIds(current);
  if (nodeIds.length === 0) return;
  const command = await serialized(() => buildCurrentAccessPolicy(current));
  await Promise.all(nodeIds.map((nodeId) => deliver(current, nodeId, command)));
}

/** A reconnected nginx node gets the current policy at once (it may hold none, or an old one). */
export async function syncAccessPolicyToNode(nodeId: string): Promise<void> {
  const current = runtime;
  if (!current || !capableNodeIds(current).includes(nodeId)) return;
  const command = await serialized(() => buildCurrentAccessPolicy(current));
  await deliver(current, nodeId, command);
}

function capableNodeIds(current: AccessPolicySyncRuntime): string[] {
  return current.registry
    .getNodesByType('nginx')
    .filter((node) => node.capabilities.has(NGINX_ACCESS_AUTH_CAPABILITY))
    .map((node) => node.nodeId);
}

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(work, work);
  chain = run.catch(() => undefined);
  return run;
}

async function deliver(current: AccessPolicySyncRuntime, nodeId: string, command: SyncAccessPolicyCommand) {
  try {
    const result = await current.dispatch.sendAccessPolicy(nodeId, command);
    if (result && !result.success) {
      logger.warn('Nginx node refused the access policy', { nodeId, revision: command.revision, error: result.error });
    }
  } catch (error) {
    logger.warn('Access policy delivery failed', {
      nodeId,
      revision: command.revision,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The next policy revision: above every revision issued before and never below the current time in milliseconds, so
 * it still rises after a database restore.
 */
async function nextRevision(db: DrizzleClient): Promise<number> {
  const floor = Date.now();
  const [row] = await db
    .insert(settings)
    .values({ key: REVISION_KEY, value: floor, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value: sql`to_jsonb(greatest(coalesce((${settings.value} #>> '{}')::bigint, 0) + 1, ${floor}::bigint))`,
        updatedAt: new Date(),
      },
    })
    .returning({ value: settings.value });
  const revision = Number(row?.value);
  if (!Number.isSafeInteger(revision)) throw new Error('Could not allocate an access policy revision');
  return revision;
}

/** The full current policy with a new revision. */
export async function buildCurrentAccessPolicy(current: AccessPolicySyncRuntime): Promise<SyncAccessPolicyCommand> {
  const now = new Date();
  const [keys, signInOrigin, lists, revokedSessions, serviceTokens] = await Promise.all([
    current.keys.verificationKeys(),
    current.settings.signInOrigin(),
    current.db
      .select({
        id: accessLists.id,
        signInMethods: accessLists.signInMethods,
        skipIpRanges: accessLists.skipIpRanges,
        includeRules: accessLists.includeRules,
        requireRules: accessLists.requireRules,
        excludeRules: accessLists.excludeRules,
        users: accessLists.users,
      })
      .from(accessLists),
    current.db
      .select({ id: accessSessions.id, expiresAt: accessSessions.expiresAt })
      .from(accessSessions)
      .where(and(isNotNull(accessSessions.revokedAt), gt(accessSessions.expiresAt, now))),
    current.db
      .select({
        id: accessServiceTokens.id,
        clientId: accessServiceTokens.clientId,
        secretSha256: accessServiceTokens.secretSha256,
        expiresAt: accessServiceTokens.expiresAt,
      })
      .from(accessServiceTokens)
      .where(or(isNull(accessServiceTokens.expiresAt), gt(accessServiceTokens.expiresAt, now))),
  ]);
  const revision = await nextRevision(current.db);
  return buildAccessPolicyCommand({ revision, signInOrigin, keys, lists, revokedSessions, serviceTokens, now });
}
