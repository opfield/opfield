import { createHash } from 'node:crypto';
import { and, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { accessLists, accessServiceTokens, accessSessions, settings } from '@/db/schema/index.js';
import type { SyncAccessPolicyCommand } from '@/grpc/generated/types.js';
import { createChildLogger } from '@/lib/logger.js';
import { NGINX_ACCESS_AUTH_CAPABILITY } from '@/modules/proxy/nginx-access-list.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import { buildAccessPolicyCommand } from './access-policy-builder.js';
import type { AccessSigningKeyService } from './access-signing-key.service.js';

const logger = createChildLogger('AccessPolicySync');

const REVISION_KEY = 'access.policyRevision';
/** Changes made together (a list saved with its routes, a batch of revocations) go out as one policy. */
const DEBOUNCE_MS = 250;

export interface AccessPolicySyncRuntime {
  db: DrizzleClient;
  keys: Pick<AccessSigningKeyService, 'verificationKeys'>;
  registry: Pick<NodeRegistryService, 'getNodesByType'>;
  dispatch: Pick<NodeDispatchService, 'sendAccessPolicy'>;
}

let runtime: AccessPolicySyncRuntime | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** Builds run one at a time, so a later revision always carries the later state. */
let chain: Promise<unknown> = Promise.resolve();
/** Content of the policy last delivered to every capable node (without its revision). */
let deliveredContent: string | null = null;

export function configureAccessPolicySync(next: AccessPolicySyncRuntime | null): void {
  runtime = next;
  deliveredContent = null;
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

/**
 * Builds the policy with a new revision and sends it to every connected capable nginx node. `onlyIfChanged` (the
 * periodic resync) sends nothing while the content equals what every node already got.
 */
export async function syncAccessPolicyNow(options: { onlyIfChanged?: boolean } = {}): Promise<void> {
  const current = runtime;
  if (!current) return;
  const nodeIds = capableNodeIds(current);
  if (nodeIds.length === 0) return;
  const built = await serialized(async () => {
    const content = await collectAccessPolicy(current);
    const hash = accessPolicyContentHash(content);
    if (options.onlyIfChanged && hash === deliveredContent) return null;
    return { hash, command: { ...content, revision: String(await nextRevision(current.db)) } };
  });
  if (!built) return;
  const delivered = await Promise.all(nodeIds.map((nodeId) => deliver(current, nodeId, built.command)));
  // A node that missed it gets it from the next resync.
  deliveredContent = delivered.every(Boolean) ? built.hash : null;
}

/** A stable digest of the policy content; the revision is left out. */
export function accessPolicyContentHash(command: SyncAccessPolicyCommand): string {
  const { revision: _revision, ...content } = command;
  return createHash('sha256')
    .update(JSON.stringify(content, (_key, value) => (Buffer.isBuffer(value) ? value.toString('base64') : value)))
    .digest('hex');
}

/** A reconnected nginx node gets the current policy at once (it may hold none, or an old one). */
export async function syncAccessPolicyToNode(nodeId: string): Promise<void> {
  const current = runtime;
  if (!current || !capableNodeIds(current).includes(nodeId)) return;
  const command = await serialized(async () => ({
    ...(await collectAccessPolicy(current)),
    revision: String(await nextRevision(current.db)),
  }));
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

async function deliver(
  current: AccessPolicySyncRuntime,
  nodeId: string,
  command: SyncAccessPolicyCommand
): Promise<boolean> {
  try {
    const result = await current.dispatch.sendAccessPolicy(nodeId, command);
    if (result && !result.success) {
      logger.warn('Nginx node refused the access policy', { nodeId, revision: command.revision, error: result.error });
      return false;
    }
    return true;
  } catch (error) {
    logger.warn('Access policy delivery failed', {
      nodeId,
      revision: command.revision,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
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

/** The full current policy; its revision is allocated when it is sent. */
export async function collectAccessPolicy(current: AccessPolicySyncRuntime): Promise<SyncAccessPolicyCommand> {
  const now = new Date();
  const [keys, lists, revokedSessions, serviceTokens] = await Promise.all([
    current.keys.verificationKeys(),
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
  return buildAccessPolicyCommand({ revision: 0, keys, lists, revokedSessions, serviceTokens, now });
}
