import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { relayInstances, relayPolicySigningKeys } from '@/db/schema/index.js';
import {
  LEGACY_LOCK_RELAY_POLICY_KEY_ROTATION,
  LEGACY_LOCK_RELAY_POLICY_SIGNING_BOOTSTRAP,
} from '@/lib/legacy-compat.js';
import type { CryptoService } from './crypto.service.js';
import {
  PolicyKeyRotationStallLog,
  type RotationCandidate,
  rotationParticipants,
} from './relay-policy-key-rotation.js';

const KEY_ROTATION_MS = 30 * 24 * 60 * 60 * 1000;
const KEY_OVERLAP_MS = 30 * 60 * 1000;
/**
 * How long a pending key waits for remote relays that stay in the pool but never report it.
 * Promotion keeps the previous private key for any relay that still needs it, so a relay that
 * lags past this point can still learn the new key; it just no longer holds rotation back.
 */
const REMOTE_ACKNOWLEDGEMENT_DEADLINE_MS = 24 * 60 * 60 * 1000;
/** Relays accept `validFrom` with the same leeway they give `issuedAt`. Send it early by that much. */
export const RELAY_POLICY_KEY_VALID_FROM_SKEW_MS = 5 * 60 * 1000;

type TrustCandidate = {
  kind?: string;
  policySigningKeyId: string | null;
  health: { policySigningKeyIds?: string[] } | null;
};

type PolicyKeyRecord = {
  keyId: string;
  publicKey: string;
  publicKeyFingerprint: string;
  status: string;
  activatedAt: Date | null;
  verifyUntil: Date | null;
  retiredAt: Date | null;
  hasPrivateKey: boolean;
};

function allPolicyKeysAcknowledged(
  instances: Array<{ health: { policySigningKeyIds?: string[] } | null }>,
  keyId: string
): boolean {
  return instances.every(({ health }) => health?.policySigningKeyIds?.includes(keyId));
}

function mayPromote<T extends RotationCandidate>(
  instances: T[],
  pending: { keyId: string; createdAt: Date },
  now: Date
): boolean {
  if (allPolicyKeysAcknowledged(rotationParticipants(instances), pending.keyId)) return true;
  if (now.getTime() - pending.createdAt.getTime() < REMOTE_ACKNOWLEDGEMENT_DEADLINE_MS) return false;
  // A remote relay stuck in the pool must not freeze rotation for everyone. The local relay
  // still has to acknowledge: it is the one relay every installation depends on.
  return allPolicyKeysAcknowledged(
    instances.filter((instance) => instance.kind === 'local'),
    pending.keyId
  );
}

function hasReportedTrust(instance: TrustCandidate): boolean {
  return (instance.health?.policySigningKeyIds?.length ?? 0) > 0;
}

/**
 * Keys whose private half must survive because this relay can only be reached through them.
 * A relay that reports the active key needs nothing old. A relay that reports other keys needs
 * those: they are the only signers it will accept, and the next snapshot they sign carries the
 * active key. A relay whose trust is unknown (nothing reported, or its supervisor could not reach
 * the worker) may trust any key from its enrollment key onward, so it needs all of them.
 */
function keysNeededByInstance(
  instance: TrustCandidate,
  activeKeyId: string,
  keys: Array<{ keyId: string; activatedAt: Date | null }>
): string[] {
  const reported = instance.health?.policySigningKeyIds ?? [];
  if (reported.includes(activeKeyId)) return [];
  if (reported.length > 0) return reported;
  const enrolledAt = keys.find(({ keyId }) => keyId === instance.policySigningKeyId)?.activatedAt ?? null;
  return keys
    .filter(({ activatedAt }) => activatedAt !== null && (!enrolledAt || activatedAt >= enrolledAt))
    .map(({ keyId }) => keyId);
}

/**
 * Picks the key that signs one relay's snapshot. That is the active key unless the relay has
 * reported a trust set without it; then it is the newest formerly active key the relay trusts
 * whose private key is still held. An empty report is treated as current: it is what a relay
 * sends while its enrollment key cannot be re-bootstrapped, and such a relay already trusts
 * the active key.
 */
function selectSigningKey(records: PolicyKeyRecord[], activeKeyId: string, reported: string[]): string {
  if (reported.length === 0 || reported.includes(activeKeyId)) return activeKeyId;
  const candidates = records
    .filter(
      (record) =>
        record.keyId !== activeKeyId &&
        record.status !== 'pending' &&
        record.activatedAt !== null &&
        record.hasPrivateKey &&
        reported.includes(record.keyId)
    )
    .sort((left, right) => (right.activatedAt?.getTime() ?? 0) - (left.activatedAt?.getTime() ?? 0));
  return candidates[0]?.keyId ?? activeKeyId;
}

/**
 * Whether Opfield can still sign a snapshot that a relay with this trust set accepts: the set
 * holds the active key, or a formerly active key whose private half Opfield still holds. False
 * is the lockout no signed rotation can repair (the relay trusts only destroyed keys, for example
 * after its relay.db was restored from an old backup). Null when the set is unknown.
 */
function trustIsSignable(records: PolicyKeyRecord[], reported: string[]): boolean | null {
  if (reported.length === 0) return null;
  const active = records.find((record) => record.status === 'active');
  if (active && reported.includes(active.keyId)) return true;
  return records.some(
    (record) =>
      reported.includes(record.keyId) &&
      record.status !== 'pending' &&
      record.activatedAt !== null &&
      record.hasPrivateKey
  );
}

function publishedKey(
  record: PolicyKeyRecord,
  status: RelayPublishedPolicyKey['status'],
  verifyUntil: Date | null
): RelayPublishedPolicyKey {
  return {
    keyId: record.keyId,
    publicKey: Buffer.from(record.publicKey, 'base64'),
    fingerprint: record.publicKeyFingerprint,
    status,
    activatedAt: record.activatedAt,
    verifyUntil,
  };
}

/**
 * The trust set one relay receives. Every relay gets the published keys. A lagging relay also
 * gets the old key that signs its snapshot, kept valid long enough to verify it again before
 * its next report. Every relay also keeps its enrollment key as verification-only: supervisors
 * re-bootstrap that key on every health loop, and a relay refuses it once it has left trust.
 * Pinning an existing key checks only its material, never its validity window, so an expired
 * entry is enough and cannot sign anything.
 */
function planInstancePolicyKeys(
  records: PolicyKeyRecord[],
  instance: TrustCandidate,
  now: Date,
  reportedOverride?: string[]
): { signingKeyId: string; keys: RelayPublishedPolicyKey[] } {
  const active = records.find((record) => record.status === 'active');
  if (!active) throw new Error('Relay policy signing key is not initialized');
  const byId = new Map(records.map((record) => [record.keyId, record]));
  const keys = new Map<string, RelayPublishedPolicyKey>();
  for (const record of records) {
    if (record.status === 'pending' || record.status === 'active' || record.status === 'verification_only') {
      keys.set(record.keyId, publishedKey(record, record.status, record.verifyUntil));
    }
  }
  const reported = reportedOverride ?? instance.health?.policySigningKeyIds ?? [];
  const signingKeyId = selectSigningKey(records, active.keyId, reported);
  const signer = byId.get(signingKeyId);
  if (signer && signingKeyId !== active.keyId) {
    const minimum = now.getTime() + KEY_OVERLAP_MS;
    const verifyUntil = new Date(Math.max(signer.verifyUntil?.getTime() ?? 0, minimum));
    keys.set(signingKeyId, publishedKey(signer, 'verification_only', verifyUntil));
  }
  const enrollment = instance.policySigningKeyId ? byId.get(instance.policySigningKeyId) : undefined;
  if (enrollment && !keys.has(enrollment.keyId) && enrollment.status !== 'pending') {
    // Never publish a zero (unbounded) window for a key that no longer signs.
    const verifyUntil = enrollment.verifyUntil ?? enrollment.retiredAt ?? now;
    keys.set(enrollment.keyId, publishedKey(enrollment, 'verification_only', verifyUntil));
  }
  return {
    signingKeyId,
    keys: [...keys.values()].sort((left, right) => left.keyId.localeCompare(right.keyId)),
  };
}

/**
 * The key ids to store from a relay status report. A report without key ids, or from a relay
 * that is offline or failing, says nothing about what the relay trusts: its supervisor sends
 * that when it cannot reach its worker. Such a report keeps the previously stored ids, so the
 * keys the relay depends on are not mistaken for unneeded ones.
 */
export function reportedPolicySigningKeyIds(
  previous: string[] | undefined,
  reported: string[] | undefined,
  state: string
): string[] {
  const ids = reported ?? [];
  const uninformative = ids.length === 0 || state === 'offline' || state === 'error';
  if (uninformative && previous && previous.length > 0) return previous;
  return ids;
}

export interface RelayPolicyTrustAnchor {
  keyId: string;
  publicKey: Buffer;
  fingerprint: string;
}

export interface RelayPublishedPolicyKey extends RelayPolicyTrustAnchor {
  status: 'pending' | 'active' | 'verification_only';
  activatedAt: Date | null;
  verifyUntil: Date | null;
}

export class RelayPolicySigningKeyService {
  private retainedKeyIds?: () => Promise<string[]>;
  private readonly rotationStalls = new PolicyKeyRotationStallLog();

  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService: CryptoService
  ) {}

  /** Keys another signer still needs, such as the availability lease signing key (A14); never destroyed. */
  setRetainedKeyIds(provider: () => Promise<string[]>): void {
    this.retainedKeyIds = provider;
  }

  async ensureInitialized(): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${LEGACY_LOCK_RELAY_POLICY_SIGNING_BOOTSTRAP}))`);
      const [active] = await tx
        .select({ id: relayPolicySigningKeys.id })
        .from(relayPolicySigningKeys)
        .where(eq(relayPolicySigningKeys.status, 'active'))
        .limit(1);
      if (active) return;
      const generated = this.generateKey();
      await tx.insert(relayPolicySigningKeys).values({
        ...generated,
        status: 'active',
        activatedAt: new Date(),
      });
    });
  }

  async getEnrollmentTrust(): Promise<RelayPolicyTrustAnchor> {
    const [active] = await this.db
      .select()
      .from(relayPolicySigningKeys)
      .where(eq(relayPolicySigningKeys.status, 'active'))
      .limit(1);
    if (!active) throw new Error('Relay policy signing key is not initialized');
    return {
      keyId: active.keyId,
      publicKey: Buffer.from(active.publicKey, 'base64'),
      fingerprint: active.publicKeyFingerprint,
    };
  }

  /**
   * The signer and trust set for one relay's snapshot. `reportedKeyIds` overrides the stored
   * report when the caller has fresher health, as the local sync path does.
   */
  async resolveInstancePolicyKeys(
    instance: TrustCandidate,
    now = new Date(),
    reportedKeyIds?: string[]
  ): Promise<{ signingKeyId: string; keys: RelayPublishedPolicyKey[] }> {
    return planInstancePolicyKeys(await this.loadKeyRecords(), instance, now, reportedKeyIds);
  }

  /** For each reported trust set: can Opfield still sign for it (see trustIsSignable)? */
  async assessReportedTrust(reportedSets: string[][]): Promise<Array<boolean | null>> {
    if (reportedSets.every((reported) => reported.length === 0)) return reportedSets.map(() => null);
    const records = await this.loadKeyRecords();
    return reportedSets.map((reported) => trustIsSignable(records, reported));
  }

  private loadKeyRecords(): Promise<PolicyKeyRecord[]> {
    return this.db
      .select({
        keyId: relayPolicySigningKeys.keyId,
        publicKey: relayPolicySigningKeys.publicKey,
        publicKeyFingerprint: relayPolicySigningKeys.publicKeyFingerprint,
        status: relayPolicySigningKeys.status,
        activatedAt: relayPolicySigningKeys.activatedAt,
        verifyUntil: relayPolicySigningKeys.verifyUntil,
        retiredAt: relayPolicySigningKeys.retiredAt,
        hasPrivateKey: sql<boolean>`(${relayPolicySigningKeys.encryptedPrivateKey} is not null and ${relayPolicySigningKeys.encryptedDek} is not null)`,
      })
      .from(relayPolicySigningKeys);
  }

  /** Signs with the active key, or with `keyId` when a lagging relay needs an older signer. */
  async signPayload(payload: Buffer, keyId?: string): Promise<{ signingKeyId: string; signature: Buffer }> {
    const [signer] = await this.db
      .select()
      .from(relayPolicySigningKeys)
      .where(
        and(
          keyId ? eq(relayPolicySigningKeys.keyId, keyId) : eq(relayPolicySigningKeys.status, 'active'),
          sql`${relayPolicySigningKeys.encryptedPrivateKey} is not null`,
          sql`${relayPolicySigningKeys.encryptedDek} is not null`
        )
      )
      .limit(1);
    if (!signer?.encryptedPrivateKey || !signer.encryptedDek) {
      throw new Error(
        keyId
          ? `Relay policy signing private key ${keyId} is unavailable`
          : 'Active relay policy signing private key is unavailable'
      );
    }
    const privateKeyPem = this.cryptoService.decryptPrivateKey({
      encryptedPrivateKey: signer.encryptedPrivateKey,
      encryptedDek: signer.encryptedDek,
      dekIv: '',
    });
    return {
      signingKeyId: signer.keyId,
      signature: sign(null, payload, createPrivateKey(privateKeyPem)),
    };
  }

  async beginRotationIfDue(now = new Date()): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${LEGACY_LOCK_RELAY_POLICY_KEY_ROTATION}))`);
      const [pending] = await tx
        .select({ keyId: relayPolicySigningKeys.keyId })
        .from(relayPolicySigningKeys)
        .where(eq(relayPolicySigningKeys.status, 'pending'))
        .limit(1);
      if (pending) return pending.keyId;
      const [active] = await tx
        .select({ activatedAt: relayPolicySigningKeys.activatedAt })
        .from(relayPolicySigningKeys)
        .where(eq(relayPolicySigningKeys.status, 'active'))
        .limit(1);
      if (!active?.activatedAt || now.getTime() - active.activatedAt.getTime() < KEY_ROTATION_MS) return null;
      const generated = this.generateKey();
      await tx.insert(relayPolicySigningKeys).values({ ...generated, status: 'pending' });
      return generated.keyId;
    });
  }

  async promoteAcknowledgedPending(now = new Date()): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${LEGACY_LOCK_RELAY_POLICY_KEY_ROTATION}))`);
      const [pending] = await tx
        .select({
          id: relayPolicySigningKeys.id,
          keyId: relayPolicySigningKeys.keyId,
          createdAt: relayPolicySigningKeys.createdAt,
        })
        .from(relayPolicySigningKeys)
        .where(eq(relayPolicySigningKeys.status, 'pending'))
        .limit(1);
      if (!pending) return false;
      const instances = await tx
        .select({
          id: relayInstances.id,
          nodeId: relayInstances.nodeId,
          kind: relayInstances.kind,
          state: relayInstances.state,
          health: relayInstances.health,
        })
        .from(relayInstances);
      if (!mayPromote(instances, pending, now)) {
        this.rotationStalls.report(instances, pending, now);
        return false;
      }
      // The previous key keeps its private half: relays that were away during the rotation can
      // learn the new key only from a snapshot it signs. destroyUnneededPrivateKeys drops it once
      // no enrolled relay still depends on it.
      await tx
        .update(relayPolicySigningKeys)
        .set({ status: 'verification_only', verifyUntil: new Date(now.getTime() + KEY_OVERLAP_MS) })
        .where(eq(relayPolicySigningKeys.status, 'active'));
      await tx
        .update(relayPolicySigningKeys)
        .set({ status: 'active', activatedAt: now })
        .where(eq(relayPolicySigningKeys.id, pending.id));
      return true;
    });
  }

  /**
   * Destroys old private keys that no enrolled relay needs any more. A relay stops needing an
   * old key once it reports the active key, or when an admin removes it from the pool. Nothing
   * is destroyed while any relay's trust is unknown: a destroyed key cannot be brought back, and
   * a relay that depended on it would be locked out for good.
   */
  async destroyUnneededPrivateKeys(now = new Date()): Promise<boolean> {
    const retained = new Set(this.retainedKeyIds ? await this.retainedKeyIds() : []);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${LEGACY_LOCK_RELAY_POLICY_KEY_ROTATION}))`);
      const [active] = await tx
        .select({ keyId: relayPolicySigningKeys.keyId })
        .from(relayPolicySigningKeys)
        .where(eq(relayPolicySigningKeys.status, 'active'))
        .limit(1);
      if (!active) return false;
      const keys = await tx
        .select({
          id: relayPolicySigningKeys.id,
          keyId: relayPolicySigningKeys.keyId,
          status: relayPolicySigningKeys.status,
          activatedAt: relayPolicySigningKeys.activatedAt,
          hasPrivateKey: sql<boolean>`(${relayPolicySigningKeys.encryptedPrivateKey} is not null or ${relayPolicySigningKeys.encryptedDek} is not null)`,
        })
        .from(relayPolicySigningKeys);
      const held = keys.filter(
        ({ status, hasPrivateKey }) => hasPrivateKey && (status === 'verification_only' || status === 'retired')
      );
      if (held.length === 0) return false;
      const instances = await tx
        .select({
          kind: relayInstances.kind,
          policySigningKeyId: relayInstances.policySigningKeyId,
          health: relayInstances.health,
        })
        .from(relayInstances);
      if (!instances.every(hasReportedTrust)) return false;
      const needed = new Set(instances.flatMap((instance) => keysNeededByInstance(instance, active.keyId, keys)));
      const destroy = held.filter(({ keyId }) => !needed.has(keyId) && !retained.has(keyId)).map(({ id }) => id);
      if (destroy.length === 0) return false;
      await tx
        .update(relayPolicySigningKeys)
        .set({ encryptedPrivateKey: null, encryptedDek: null, privateKeyDestroyedAt: now })
        .where(inArray(relayPolicySigningKeys.id, destroy));
      return true;
    });
  }

  async retireExpiredVerificationKeys(now = new Date()): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${LEGACY_LOCK_RELAY_POLICY_KEY_ROTATION}))`);
      const retired = await tx
        .update(relayPolicySigningKeys)
        .set({ status: 'retired', retiredAt: now })
        .where(
          and(eq(relayPolicySigningKeys.status, 'verification_only'), lte(relayPolicySigningKeys.verifyUntil, now))
        )
        .returning({ id: relayPolicySigningKeys.id });
      return retired.length > 0;
    });
  }

  private generateKey() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' });
    if (!jwk.x) throw new Error('Generated relay policy Ed25519 public key is missing x coordinate');
    const rawPublicKey = Buffer.from(jwk.x, 'base64url');
    const encrypted = this.cryptoService.encryptPrivateKey(
      privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    );
    return {
      keyId: randomUUID(),
      publicKey: rawPublicKey.toString('base64'),
      publicKeyFingerprint: `sha256:${createHash('sha256').update(rawPublicKey).digest('hex')}`,
      encryptedPrivateKey: encrypted.encryptedPrivateKey,
      encryptedDek: encrypted.encryptedDek,
    };
  }
}

export const relayPolicySigningKeyInternals = {
  allPolicyKeysAcknowledged,
  keysNeededByInstance,
  mayPromote,
  planInstancePolicyKeys,
  rotationParticipants,
  selectSigningKey,
  trustIsSignable,
  KEY_OVERLAP_MS,
  REMOTE_ACKNOWLEDGEMENT_DEADLINE_MS,
};
