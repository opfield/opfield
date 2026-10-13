import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { and, eq, lte, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { relayGrantSigningKeys, relayInstances, relayPolicyState, relayPools } from '@/db/schema/index.js';
import type { RelayInstanceCapabilities } from '@/db/schema/relay.js';
import { createChildLogger } from '@/lib/logger.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import {
  effectiveRelayGrantTtlHours,
  LEGACY_RELAY_POLICY_LEASE_SECONDS,
  LONG_POLICY_LEASE_CAPABILITY,
  RELAY_LEASE_EXPIRY_CLOCK_SKEW_MS,
} from '@/modules/settings/general-settings.service.js';
import type { CryptoService } from './crypto.service.js';
import { bumpRelayPolicyRevision } from './relay-policy-reconciler.js';

const logger = createChildLogger('RelayGrantKeyService');
const POLICY_ID = 'current';
const KEY_ROTATION_MS = 7 * 24 * 60 * 60 * 1000;
const PUBLIC_KEY_RETENTION_MS = 48 * 60 * 60 * 1000 + 5 * 60 * 1000;
/** A grant this long-lived would already be rejected by the relay itself; see grant.MaxTTL in packages/relay/internal/grant/grant.go. */
const RELAY_RUNTIME_GRANT_MAX_TTL_MS = 240 * 60 * 60 * 1000;
/**
 * How long a pending grant key is published before it is even considered for activation. Remote
 * relays learn it from policy snapshots, which Opfield keeps pushing every 30 seconds while it is
 * reachable, so a relay that is currently online sees the pending key almost immediately; this is
 * only a floor so a relay that briefly dropped and reconnects also has time to get it. Activation
 * additionally waits on `everyInstanceAcknowledgedOrLeaseElapsed` (see below), which is what
 * actually protects a relay isolated for longer than this.
 */
export const GRANT_KEY_PUBLICATION_MS = 20 * 60 * 1000;

interface PendingKey {
  id: string;
  createdAt: Date;
  /** The first pool snapshot revision that carries this key; null on a pre-migration row. */
  publishedAtRevision: number | null;
}

interface InstanceAcknowledgement {
  appliedPolicyRevision: number | null;
  capabilities: RelayInstanceCapabilities | null;
}

export class RelayGrantKeyService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService: CryptoService,
    private readonly settings: Pick<GeneralSettingsService, 'getConfig'>
  ) {}

  async ensureInitialized(): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-policy-bootstrap'))`);
      await tx
        .insert(relayPolicyState)
        .values({ id: POLICY_ID, gatewayInstanceId: randomUUID(), revision: 0 })
        .onConflictDoNothing();
      const [active] = await tx
        .select({ id: relayGrantSigningKeys.id })
        .from(relayGrantSigningKeys)
        .where(eq(relayGrantSigningKeys.status, 'active'))
        .limit(1);
      if (!active) {
        await this.insertKey(tx, 'active', new Date(), null);
        await bumpRelayPolicyRevision(tx);
      }
    });
  }

  async rotateIfDue(
    now: Date,
    syncSnapshot: () => Promise<number>,
    refreshGrants: () => Promise<void>
  ): Promise<boolean> {
    const pending: PendingKey | null = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-signing-key-rotation'))`);
      const [existingPending] = await tx
        .select({
          id: relayGrantSigningKeys.id,
          createdAt: relayGrantSigningKeys.createdAt,
          publishedAtRevision: relayGrantSigningKeys.publishedAtRevision,
        })
        .from(relayGrantSigningKeys)
        .where(eq(relayGrantSigningKeys.status, 'pending'))
        .limit(1);
      if (existingPending) return existingPending;

      const [active] = await tx
        .select({ activatedAt: relayGrantSigningKeys.activatedAt })
        .from(relayGrantSigningKeys)
        .where(eq(relayGrantSigningKeys.status, 'active'))
        .limit(1);
      if (!active?.activatedAt || now.getTime() - active.activatedAt.getTime() < KEY_ROTATION_MS) return null;

      // Relays report the pool snapshot revision they applied, which runs ahead of the global one
      // (lease refreshes advance only the pool), so the gate needs a pool revision. The bump waits
      // out every snapshot build still holding the policy state on the previous revision; every
      // build after this commits carries the key and takes a pool revision above today's highest
      // and above the new global one (which a legacy snapshot reports as its own).
      await bumpRelayPolicyRevision(tx);
      const [[pool], [state]] = await Promise.all([
        tx.select({ revision: sql<string | number | null>`max(${relayPools.desiredPolicyRevision})` }).from(relayPools),
        tx
          .select({ revision: relayPolicyState.revision })
          .from(relayPolicyState)
          .where(eq(relayPolicyState.id, POLICY_ID))
          .limit(1),
      ]);
      const publishedAtRevision = Math.max(Number(pool?.revision ?? 0) + 1, Number(state?.revision ?? 0));
      const [created] = await this.insertKey(tx, 'pending', null, publishedAtRevision);
      return { id: created.id, createdAt: now, publishedAtRevision };
    });

    if (!pending) {
      if (await this.retireExpiredVerificationKeys(now)) await syncSnapshot();
      return false;
    }

    const pendingId = pending.id;
    await syncSnapshot();
    if (now.getTime() - pending.createdAt.getTime() < GRANT_KEY_PUBLICATION_MS) return false;

    const settings = await this.settings.getConfig();
    if (!(await this.everyInstanceAcknowledgedOrLeaseElapsed(pending, now, settings.relayPolicyLeaseHours))) {
      return false;
    }

    const verifyUntilMs = this.retiredKeyVerifyUntilMs(now, settings);

    const activated = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-signing-key-rotation'))`);
      const [pending] = await tx
        .select({ status: relayGrantSigningKeys.status })
        .from(relayGrantSigningKeys)
        .where(eq(relayGrantSigningKeys.id, pendingId))
        .limit(1);
      if (pending?.status !== 'pending') return false;

      const verifyUntil = new Date(verifyUntilMs);
      await tx
        .update(relayGrantSigningKeys)
        .set({
          status: 'verification_only',
          verifyUntil,
          encryptedPrivateKey: null,
          encryptedDek: null,
          privateKeyDestroyedAt: now,
        })
        .where(eq(relayGrantSigningKeys.status, 'active'));
      await tx
        .update(relayGrantSigningKeys)
        .set({ status: 'active', activatedAt: now })
        .where(eq(relayGrantSigningKeys.id, pendingId));
      return true;
    });
    if (activated) {
      logger.info('Rotated relay grant signing key', { pendingId });
      await refreshGrants().catch((error) => {
        logger.warn('Relay signing key rotated; some daemon grants will refresh on reconnect or retry', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return activated;
  }

  /**
   * A pending key may sign only once every enrolled relay instance is provably past the point
   * where it could still be admitting on a policy that predates the key: either it already
   * applied a revision at or after the one that first published the key, or enough time has
   * passed since that publication that even a relay running on its longest possible lease
   * (relayPolicyLeaseHours for a long-lease-capable instance, the legacy 15 minutes otherwise)
   * plus clock skew must have expired that lease and stopped admitting. Without this, an
   * instance isolated for longer than GRANT_KEY_PUBLICATION_MS but still inside its own lease
   * would still be serving on the pre-rotation key set and would refuse every grant the new key
   * signs once it reconnects.
   */
  private async everyInstanceAcknowledgedOrLeaseElapsed(
    pending: PendingKey,
    now: Date,
    relayPolicyLeaseHours: number
  ): Promise<boolean> {
    const instances = await this.db
      .select({
        appliedPolicyRevision: relayInstances.appliedPolicyRevision,
        capabilities: relayInstances.capabilities,
      })
      .from(relayInstances);
    return this.allInstancesReady(instances, pending, now, relayPolicyLeaseHours);
  }

  /**
   * The retired key must stay verifiable for at least as long as the longest grant that could
   * still be outstanding when it retires: effectiveRelayGrantTtlHours is exactly that bound for a
   * long-lease-capable instance, and the 48h05m floor covers a legacy-capped grant. Clamped below
   * grant.MaxTTL (see RELAY_RUNTIME_GRANT_MAX_TTL_MS) so this can never ask a relay to trust a key
   * for longer than the relay itself would ever accept a grant for.
   */
  private retiredKeyVerifyUntilMs(
    now: Date,
    settings: { relayGrantTtlHours: number; relayPolicyLeaseHours: number }
  ): number {
    const candidateMs = Math.max(
      PUBLIC_KEY_RETENTION_MS,
      effectiveRelayGrantTtlHours(settings.relayGrantTtlHours, settings.relayPolicyLeaseHours) * 60 * 60 * 1000 +
        5 * 60 * 1000
    );
    return Math.min(now.getTime() + candidateMs, now.getTime() + RELAY_RUNTIME_GRANT_MAX_TTL_MS - 5 * 60 * 1000);
  }

  private allInstancesReady(
    instances: InstanceAcknowledgement[],
    pending: PendingKey,
    now: Date,
    relayPolicyLeaseHours: number
  ): boolean {
    const publishedAtRevision = pending.publishedAtRevision ?? 0;
    return instances.every((instance) => {
      const applied = Number(instance.appliedPolicyRevision ?? 0);
      if (Number.isSafeInteger(applied) && applied >= publishedAtRevision) return true;
      const features = instance.capabilities?.features;
      const longLeaseCapable = Array.isArray(features) && features.includes(LONG_POLICY_LEASE_CAPABILITY);
      const leaseMs = longLeaseCapable
        ? relayPolicyLeaseHours * 60 * 60 * 1000
        : LEGACY_RELAY_POLICY_LEASE_SECONDS * 1000;
      return now.getTime() - pending.createdAt.getTime() >= leaseMs + RELAY_LEASE_EXPIRY_CLOCK_SKEW_MS;
    });
  }

  private async insertKey(
    tx: any,
    status: 'pending' | 'active',
    activatedAt: Date | null,
    publishedAtRevision: number | null
  ) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' });
    if (!jwk.x) throw new Error('Generated Ed25519 public key is missing x coordinate');
    const publicKeyRaw = Buffer.from(jwk.x, 'base64url');
    const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const encrypted = this.cryptoService.encryptPrivateKey(privateKeyPem);
    return tx
      .insert(relayGrantSigningKeys)
      .values({
        keyId: randomUUID(),
        publicKey: publicKeyRaw.toString('base64'),
        encryptedPrivateKey: encrypted.encryptedPrivateKey,
        encryptedDek: encrypted.encryptedDek,
        status,
        activatedAt,
        publishedAtRevision,
      })
      .returning({ id: relayGrantSigningKeys.id });
  }

  private async retireExpiredVerificationKeys(now: Date): Promise<boolean> {
    const retiredCount = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-signing-key-rotation'))`);
      const retired = await tx
        .update(relayGrantSigningKeys)
        .set({ status: 'retired', retiredAt: now })
        .where(and(eq(relayGrantSigningKeys.status, 'verification_only'), lte(relayGrantSigningKeys.verifyUntil, now)))
        .returning({ id: relayGrantSigningKeys.id });
      if (retired.length) await bumpRelayPolicyRevision(tx);
      return retired.length;
    });
    return retiredCount > 0;
  }
}
