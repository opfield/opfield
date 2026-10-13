import { and, count, desc, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import type { DrizzleClient, DrizzleTransaction } from '@/db/client.js';
import { auditLog, certificateAuthorities, certificates, managedDatabaseInstances, nodes } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { IssueCertificateInput } from '@/modules/pki/cert.schemas.js';
import type { CertService } from '@/modules/pki/cert.service.js';
import type { CRLService } from '@/modules/pki/crl.service.js';

const logger = createChildLogger('SystemCertificateLifecycleService');

export type SystemCertificateOwner =
  | { type: 'node'; id: string }
  | { type: 'managed_database'; id: string }
  | { type: 'managed_storage'; id: string }
  | { type: 'opfield_listener'; id: 'grpc' | 'web' }
  | { type: 'relay_node_server'; id: string }
  | { type: 'opfield_service'; id: 'app-internal-server' | 'app-relay-client' | 'relay-app-client' };

export interface SystemCertificateBindingHandle {
  onCommitted?: () => void | Promise<void>;
  onRollback?: () => void | Promise<void>;
}

export type SystemCertificateCurrentBinding = (
  tx: DrizzleTransaction,
  certificate: { id: string; serialNumber: string; notAfter: Date; certificatePem: string; privateKeyPem: string }
) => Promise<SystemCertificateBindingHandle> | Promise<void>;

export type SystemCertificatePromotionBinding = (
  tx: DrizzleTransaction,
  certificate: { id: string; serialNumber: string; notAfter: Date; certificatePem: string } | null
) => Promise<void>;

const RETIRABLE_STATES = ['current', 'superseded', 'pending'] as const;
// A staged leaf is handed out again on a retried request only while it still
// has most of its validity left; otherwise a fresh one is staged.
const PENDING_REUSE_MIN_REMAINING_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Owns the lifecycle of leaves issued by Gateway system CAs. The cleanup
 * predicate is deliberately based on explicit fields written here; a leaf
 * without this provenance is never touched automatically.
 */
/** What a system leaf needs beyond its type's defaults. */
export interface SystemLeafOptions {
  /** Extended key usages instead of the type's (e.g. serverAuth and clientAuth). */
  extKeyUsage?: readonly string[];
}

export class SystemCertificateLifecycleService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly certService: CertService,
    private readonly crlService: CRLService
  ) {}

  async issueCurrent(
    input: IssueCertificateInput,
    issuedById: string,
    owner: SystemCertificateOwner,
    bindCurrent?: SystemCertificateCurrentBinding,
    leaf: SystemLeafOptions = {}
  ) {
    await this.assertSystemCA(input.caId);

    // Start every system leaf as explicitly-owned, report-only `unknown`.
    // If the following ownership transaction fails, the old leaf remains
    // current and this new one remains visible but ineligible for automation.
    const issued = await this.certService.issueCertificate(input, issuedById, {
      allowSystem: true,
      ...(leaf.extKeyUsage ? { extKeyUsage: leaf.extKeyUsage } : {}),
      systemLifecycle: { ownerType: owner.type, ownerId: owner.id, state: 'unknown' },
    });
    const now = new Date();
    let retiredCaId: string | null = null;
    const binding = { handle: undefined as SystemCertificateBindingHandle | undefined };

    try {
      await this.db.transaction(async (tx) => {
        const [current] = await tx
          .select({ id: certificates.id, caId: certificates.caId })
          .from(certificates)
          .where(
            and(
              eq(certificates.systemOwnerType, owner.type),
              eq(certificates.systemOwnerId, owner.id),
              eq(certificates.systemLifecycleState, 'current')
            )
          )
          .limit(1);

        if (current) {
          await tx
            .update(certificates)
            .set({
              status: 'revoked',
              revokedAt: now,
              revocationReason: 'superseded',
              systemLifecycleState: 'superseded',
              systemRetiredAt: now,
              updatedAt: now,
            })
            .where(eq(certificates.id, current.id));
          await tx
            .update(certificateAuthorities)
            .set({ crlRefreshPendingAt: now, updatedAt: now })
            .where(eq(certificateAuthorities.id, current.caId));
          retiredCaId = current.caId;
        }

        if (bindCurrent) {
          binding.handle =
            (await bindCurrent(tx, {
              ...issued.certificate,
              privateKeyPem: issued.privateKeyPem,
            })) ?? undefined;
        }

        await tx
          .update(certificates)
          .set({
            systemOwnerType: owner.type,
            systemOwnerId: owner.id,
            systemLifecycleState: 'current',
            systemRetiredAt: null,
            privateKeyDestroyedAt: null,
            updatedAt: now,
          })
          .where(eq(certificates.id, issued.certificate.id));
      });
    } catch (error) {
      try {
        await binding.handle?.onRollback?.();
      } catch (rollbackError) {
        logger.error('Failed to restore listener material after lifecycle rollback', {
          certId: issued.certificate.id,
          owner,
          error: rollbackError,
        });
      }
      logger.error('Failed to bind issued system certificate; existing certificate remains current', {
        certId: issued.certificate.id,
        owner,
        error,
      });
      throw error;
    }

    try {
      await binding.handle?.onCommitted?.();
    } catch (error) {
      // The database transition is already committed; retain the valid active
      // pair and leave recovery artifacts for a later startup instead of
      // reporting a false failed issuance to the caller.
      logger.error('Failed to finalize committed system certificate material', {
        certId: issued.certificate.id,
        owner,
        error,
      });
    }
    if (retiredCaId) await this.refreshCRL(retiredCaId);
    return issued;
  }

  /**
   * Stage a replacement leaf without retiring the owner's current one. The
   * owner keeps working with its current leaf until it proves possession of
   * the staged leaf, and promotePending() then swaps them. While a staged leaf
   * is still valid it is returned again (with its key) instead of issuing
   * another, so a lost response can be retried idempotently.
   */
  async issuePending(
    input: IssueCertificateInput,
    issuedById: string,
    owner: SystemCertificateOwner,
    bindPending?: SystemCertificateCurrentBinding,
    leaf: SystemLeafOptions = {}
  ) {
    await this.assertSystemCA(input.caId);

    const reusable = await this.findReusablePending(owner, input.caId, leaf.extKeyUsage);
    if (reusable) {
      if (bindPending) {
        await this.db.transaction(async (tx) => {
          await bindPending(tx, { ...reusable.certificate, privateKeyPem: reusable.privateKeyPem });
        });
      }
      return reusable;
    }

    const issued = await this.certService.issueCertificate(input, issuedById, {
      allowSystem: true,
      ...(leaf.extKeyUsage ? { extKeyUsage: leaf.extKeyUsage } : {}),
      systemLifecycle: { ownerType: owner.type, ownerId: owner.id, state: 'unknown' },
    });
    const now = new Date();
    const retiredCaIds = new Set<string>();
    const binding = { handle: undefined as SystemCertificateBindingHandle | undefined };

    try {
      await this.db.transaction(async (tx) => {
        // Only one staged leaf per owner: an older, unusable staged leaf is
        // replaced. The current leaf is deliberately left untouched.
        const stale = await tx
          .select({ id: certificates.id, caId: certificates.caId })
          .from(certificates)
          .where(
            and(
              eq(certificates.systemOwnerType, owner.type),
              eq(certificates.systemOwnerId, owner.id),
              eq(certificates.systemLifecycleState, 'pending')
            )
          );
        if (stale.length) {
          await tx
            .update(certificates)
            .set({
              status: 'revoked',
              revokedAt: now,
              revocationReason: 'superseded',
              systemLifecycleState: 'superseded',
              systemRetiredAt: now,
              updatedAt: now,
            })
            .where(
              inArray(
                certificates.id,
                stale.map((row) => row.id)
              )
            );
          const caIds = [...new Set(stale.map((row) => row.caId))];
          await tx
            .update(certificateAuthorities)
            .set({ crlRefreshPendingAt: now, updatedAt: now })
            .where(inArray(certificateAuthorities.id, caIds));
          for (const caId of caIds) retiredCaIds.add(caId);
        }

        if (bindPending) {
          binding.handle =
            (await bindPending(tx, {
              ...issued.certificate,
              privateKeyPem: issued.privateKeyPem,
            })) ?? undefined;
        }

        await tx
          .update(certificates)
          .set({
            systemOwnerType: owner.type,
            systemOwnerId: owner.id,
            systemLifecycleState: 'pending',
            systemRetiredAt: null,
            privateKeyDestroyedAt: null,
            updatedAt: now,
          })
          .where(eq(certificates.id, issued.certificate.id));
      });
    } catch (error) {
      try {
        await binding.handle?.onRollback?.();
      } catch (rollbackError) {
        logger.error('Failed to restore material after pending lifecycle rollback', {
          certId: issued.certificate.id,
          owner,
          error: rollbackError,
        });
      }
      logger.error('Failed to stage issued system certificate; existing certificate remains current', {
        certId: issued.certificate.id,
        owner,
        error,
      });
      throw error;
    }

    try {
      await binding.handle?.onCommitted?.();
    } catch (error) {
      logger.error('Failed to finalize staged system certificate material', {
        certId: issued.certificate.id,
        owner,
        error,
      });
    }
    for (const caId of retiredCaIds) await this.refreshCRL(caId);
    return issued;
  }

  /**
   * Promote the owner's staged leaf with this serial to `current`, retiring
   * (revoking) the previous current leaf. The binding runs in the same
   * transaction and may throw to abort the swap. Returns false when no staged
   * leaf with that serial exists; the binding still runs with `null` so the
   * owner record can be reconciled.
   */
  async promotePending(
    owner: SystemCertificateOwner,
    serialNumber: string,
    bindPromoted?: SystemCertificatePromotionBinding
  ): Promise<boolean> {
    const now = new Date();
    let retiredCaId: string | null = null;
    const promoted = await this.db.transaction(async (tx) => {
      const [pending] = await tx
        .select({
          id: certificates.id,
          caId: certificates.caId,
          serialNumber: certificates.serialNumber,
          notAfter: certificates.notAfter,
          certificatePem: certificates.certificatePem,
        })
        .from(certificates)
        .where(
          and(
            eq(certificates.systemOwnerType, owner.type),
            eq(certificates.systemOwnerId, owner.id),
            eq(certificates.systemLifecycleState, 'pending'),
            eq(certificates.serialNumber, serialNumber)
          )
        )
        .limit(1);

      if (pending) {
        const [current] = await tx
          .select({ id: certificates.id, caId: certificates.caId })
          .from(certificates)
          .where(
            and(
              eq(certificates.systemOwnerType, owner.type),
              eq(certificates.systemOwnerId, owner.id),
              eq(certificates.systemLifecycleState, 'current')
            )
          )
          .limit(1);
        if (current) {
          await tx
            .update(certificates)
            .set({
              status: 'revoked',
              revokedAt: now,
              revocationReason: 'superseded',
              systemLifecycleState: 'superseded',
              systemRetiredAt: now,
              updatedAt: now,
            })
            .where(eq(certificates.id, current.id));
          await tx
            .update(certificateAuthorities)
            .set({ crlRefreshPendingAt: now, updatedAt: now })
            .where(eq(certificateAuthorities.id, current.caId));
          retiredCaId = current.caId;
        }
        await tx
          .update(certificates)
          .set({ systemLifecycleState: 'current', systemRetiredAt: null, updatedAt: now })
          .where(eq(certificates.id, pending.id));
      }

      await bindPromoted?.(
        tx,
        pending
          ? {
              id: pending.id,
              serialNumber: pending.serialNumber,
              notAfter: pending.notAfter,
              certificatePem: pending.certificatePem,
            }
          : null
      );
      return !!pending;
    });
    if (retiredCaId) await this.refreshCRL(retiredCaId);
    return promoted;
  }

  /** The owner's newest staged (pending, still active) leaf, if any. */
  async findPending(owner: SystemCertificateOwner) {
    const [pending] = await this.db
      .select()
      .from(certificates)
      .where(
        and(
          eq(certificates.systemOwnerType, owner.type),
          eq(certificates.systemOwnerId, owner.id),
          eq(certificates.systemLifecycleState, 'pending'),
          eq(certificates.status, 'active')
        )
      )
      .orderBy(desc(certificates.createdAt))
      .limit(1);
    return pending ?? null;
  }

  private async findReusablePending(owner: SystemCertificateOwner, caId: string, extKeyUsage?: readonly string[]) {
    const [pending] = await this.db
      .select()
      .from(certificates)
      .where(
        and(
          eq(certificates.systemOwnerType, owner.type),
          eq(certificates.systemOwnerId, owner.id),
          eq(certificates.systemLifecycleState, 'pending'),
          eq(certificates.status, 'active'),
          eq(certificates.caId, caId)
        )
      )
      .orderBy(desc(certificates.createdAt))
      .limit(1);
    if (!pending || pending.notAfter.getTime() - Date.now() < PENDING_REUSE_MIN_REMAINING_MS) return null;
    // A staged leaf without the usages the owner needs now is replaced, not reused.
    if (extKeyUsage && !extKeyUsage.every((usage) => (pending.extKeyUsage ?? []).includes(usage))) return null;
    const privateKeyPem = await this.certService.getCertificatePrivateKey(pending.id);
    if (!privateKeyPem) return null;
    return { certificate: pending, privateKeyPem };
  }

  /** Retire all explicitly owned leaves after a node/database was successfully deleted. */
  async retireOwner(
    owner: SystemCertificateOwner,
    reason: 'cessationOfOperation' = 'cessationOfOperation',
    transaction?: DrizzleTransaction
  ) {
    const now = new Date();
    const retire = async (tx: DrizzleTransaction) => {
      const rows = await tx
        .select({ id: certificates.id, caId: certificates.caId, status: certificates.status })
        .from(certificates)
        .where(
          and(
            eq(certificates.systemOwnerType, owner.type),
            eq(certificates.systemOwnerId, owner.id),
            inArray(certificates.systemLifecycleState, RETIRABLE_STATES)
          )
        );
      if (!rows.length) return [];

      await tx
        .update(certificates)
        .set({
          status: 'revoked',
          revokedAt: now,
          revocationReason: reason,
          systemLifecycleState: 'retired',
          systemRetiredAt: now,
          updatedAt: now,
        })
        .where(
          inArray(
            certificates.id,
            rows.map((row) => row.id)
          )
        );
      const caIds = [...new Set(rows.map((row) => row.caId))];
      await tx
        .update(certificateAuthorities)
        .set({ crlRefreshPendingAt: now, updatedAt: now })
        .where(inArray(certificateAuthorities.id, caIds));
      return caIds;
    };
    const affected = transaction ? await retire(transaction) : await this.db.transaction(retire);

    // An owner-delete transaction must commit before CRL publication; the
    // durable pending marker is retried by the caller and scheduler.
    if (!transaction) {
      for (const caId of affected) await this.refreshCRL(caId);
    }
    return affected.length;
  }

  /** Destroy private material only after the configured retention period. */
  async destroyRetiredPrivateKeys(retentionDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const now = new Date();
    const result = await this.db.transaction(async (tx) => {
      const destroyed = await tx
        .update(certificates)
        .set({
          encryptedPrivateKey: null,
          encryptedDek: null,
          dekIv: null,
          privateKeyDestroyedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            inArray(certificates.systemLifecycleState, ['superseded', 'retired']),
            lte(certificates.systemRetiredAt, cutoff),
            isNotNull(certificates.systemOwnerType),
            isNotNull(certificates.systemOwnerId),
            isNull(certificates.privateKeyDestroyedAt),
            isNotNull(certificates.encryptedPrivateKey),
            inArray(
              certificates.caId,
              this.db
                .select({ id: certificateAuthorities.id })
                .from(certificateAuthorities)
                .where(eq(certificateAuthorities.isSystem, true))
            )
          )
        )
        .returning({
          id: certificates.id,
          caId: certificates.caId,
          ownerType: certificates.systemOwnerType,
          ownerId: certificates.systemOwnerId,
          lifecycleState: certificates.systemLifecycleState,
          retiredAt: certificates.systemRetiredAt,
        });
      if (destroyed.length) {
        await tx.insert(auditLog).values(
          destroyed.map((certificate) => ({
            userId: null,
            action: 'certificate.system_private_key.destroy',
            resourceType: 'certificate',
            resourceId: certificate.id,
            details: {
              caId: certificate.caId,
              ownerType: certificate.ownerType,
              ownerId: certificate.ownerId,
              lifecycleState: certificate.lifecycleState,
              retiredAt: certificate.retiredAt?.toISOString() ?? null,
              retentionDays,
              trigger: 'housekeeping',
            },
          }))
        );
      }
      return destroyed;
    });
    return result.length;
  }

  async getPrivateKeyCleanupStats(retentionDays: number) {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const [candidates, states] = await Promise.all([
      this.db
        .select({ id: certificates.id })
        .from(certificates)
        .where(
          and(
            inArray(certificates.systemLifecycleState, ['superseded', 'retired']),
            lte(certificates.systemRetiredAt, cutoff),
            isNotNull(certificates.systemOwnerType),
            isNotNull(certificates.systemOwnerId),
            isNull(certificates.privateKeyDestroyedAt),
            isNotNull(certificates.encryptedPrivateKey),
            inArray(
              certificates.caId,
              this.db
                .select({ id: certificateAuthorities.id })
                .from(certificateAuthorities)
                .where(eq(certificateAuthorities.isSystem, true))
            )
          )
        ),
      this.db
        .select({ state: certificates.systemLifecycleState, total: count() })
        .from(certificates)
        .where(isNotNull(certificates.systemLifecycleState))
        .groupBy(certificates.systemLifecycleState),
    ]);
    const counts = new Map(states.map((row) => [row.state, Number(row.total)]));
    return {
      count: candidates.length,
      certIds: candidates.map((candidate) => candidate.id),
      currentCount: counts.get('current') ?? 0,
      supersededCount: counts.get('superseded') ?? 0,
      unknownCount: counts.get('unknown') ?? 0,
    };
  }

  /**
   * Read-only evidence report for an operator-approved Assistant audit. It
   * intentionally does not infer ownership from a CN or recommend mutation
   * for legacy `unknown` leaves.
   */
  async auditSystemLeaves(caId?: string) {
    const caRows = await this.db
      .select({
        id: certificateAuthorities.id,
        commonName: certificateAuthorities.commonName,
        purpose: certificateAuthorities.systemPurpose,
      })
      .from(certificateAuthorities)
      .where(
        caId
          ? and(eq(certificateAuthorities.isSystem, true), eq(certificateAuthorities.id, caId))
          : eq(certificateAuthorities.isSystem, true)
      );
    const caIds = caRows.map((ca) => ca.id);
    if (!caIds.length) return { cas: [], summary: { total: 0, current: 0, retired: 0, unknown: 0 } };
    const leafRows = await this.db
      .select({
        id: certificates.id,
        caId: certificates.caId,
        commonName: certificates.commonName,
        serialNumber: certificates.serialNumber,
        status: certificates.status,
        notAfter: certificates.notAfter,
        lifecycleState: certificates.systemLifecycleState,
        ownerType: certificates.systemOwnerType,
        ownerId: certificates.systemOwnerId,
        retiredAt: certificates.systemRetiredAt,
        privateKeyDestroyedAt: certificates.privateKeyDestroyedAt,
      })
      .from(certificates)
      .where(inArray(certificates.caId, caIds));
    const byCA = new Map(caRows.map((ca) => [ca.id, ca]));
    const leaves = leafRows.map((leaf) => {
      const classification =
        leaf.lifecycleState === 'current' || leaf.lifecycleState === 'pending'
          ? 'current'
          : leaf.lifecycleState === 'superseded' || leaf.lifecycleState === 'retired'
            ? 'retired'
            : 'unknown';
      return {
        ...leaf,
        ca: byCA.get(leaf.caId),
        classification,
        evidence:
          classification === 'unknown'
            ? 'No explicit lifecycle proof; never mutate automatically.'
            : `Persisted lifecycle state ${leaf.lifecycleState} with explicit owner ${leaf.ownerType}:${leaf.ownerId}.`,
      };
    });
    return {
      cas: caRows,
      leaves,
      summary: {
        total: leaves.length,
        current: leaves.filter((leaf) => leaf.classification === 'current').length,
        retired: leaves.filter((leaf) => leaf.classification === 'retired').length,
        unknown: leaves.filter((leaf) => leaf.classification === 'unknown').length,
      },
    };
  }

  /**
   * Adopt only current references that can be proven from a foreign key or a
   * node's exact stored serial. Every remaining system leaf becomes `unknown`;
   * it is visible but deliberately ineligible for automation.
   */
  async reconcileExistingSystemLeaves() {
    const [nodeCA, databaseCA] = await Promise.all([this.findSystemCA('node-mtls'), this.findSystemCA('database-tls')]);
    let adopted = 0;

    if (nodeCA) {
      const nodeRows = await this.db
        .select({ id: nodes.id, certificateSerial: nodes.certificateSerial })
        .from(nodes)
        .where(isNotNull(nodes.certificateSerial));
      for (const node of nodeRows) {
        const [certificate] = await this.db
          .select({ id: certificates.id })
          .from(certificates)
          .where(
            and(
              eq(certificates.caId, nodeCA),
              eq(certificates.serialNumber, node.certificateSerial!),
              isNull(certificates.systemLifecycleState)
            )
          )
          .limit(1);
        if (certificate && (await this.adoptCurrent(certificate.id, { type: 'node', id: node.id }))) adopted += 1;
      }
    }

    if (databaseCA) {
      const databaseRows = await this.db
        .select({ id: managedDatabaseInstances.id, certificateId: managedDatabaseInstances.certificateId })
        .from(managedDatabaseInstances)
        .where(isNotNull(managedDatabaseInstances.certificateId));
      for (const database of databaseRows) {
        const [certificate] = await this.db
          .select({ id: certificates.id })
          .from(certificates)
          .where(
            and(
              eq(certificates.id, database.certificateId!),
              eq(certificates.caId, databaseCA),
              isNull(certificates.systemLifecycleState)
            )
          )
          .limit(1);
        if (certificate && (await this.adoptCurrent(certificate.id, { type: 'managed_database', id: database.id }))) {
          adopted += 1;
        }
      }
    }

    const systemCAIds = [nodeCA, databaseCA].filter((id): id is string => !!id);
    if (!systemCAIds.length) return { adopted, unknown: 0 };
    const unknown = await this.db
      .update(certificates)
      .set({ systemLifecycleState: 'unknown', updatedAt: new Date() })
      .where(and(inArray(certificates.caId, systemCAIds), isNull(certificates.systemLifecycleState)))
      .returning({ id: certificates.id });
    return { adopted, unknown: unknown.length };
  }

  /** Retry CRL publication that failed after an otherwise durable revocation. */
  async retryPendingCRLs(): Promise<number> {
    const pending = await this.db
      .select({ id: certificateAuthorities.id })
      .from(certificateAuthorities)
      .where(and(eq(certificateAuthorities.isSystem, true), isNotNull(certificateAuthorities.crlRefreshPendingAt)));
    for (const ca of pending) await this.refreshCRL(ca.id);
    return pending.length;
  }

  private async assertSystemCA(caId: string) {
    const [ca] = await this.db
      .select({ isSystem: certificateAuthorities.isSystem })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.id, caId))
      .limit(1);
    if (!ca?.isSystem) throw new Error('System certificate lifecycle requires a system CA');
  }

  private async findSystemCA(purpose: 'node-mtls' | 'database-tls') {
    const [ca] = await this.db
      .select({ id: certificateAuthorities.id })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.systemPurpose, purpose))
      .limit(1);
    return ca?.id ?? null;
  }

  private async adoptCurrent(certificateId: string, owner: SystemCertificateOwner): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: certificates.id })
        .from(certificates)
        .where(
          and(
            eq(certificates.systemOwnerType, owner.type),
            eq(certificates.systemOwnerId, owner.id),
            eq(certificates.systemLifecycleState, 'current')
          )
        )
        .limit(1);
      if (existing) return false;
      const updated = await tx
        .update(certificates)
        .set({
          systemOwnerType: owner.type,
          systemOwnerId: owner.id,
          systemLifecycleState: 'current',
          updatedAt: new Date(),
        })
        .where(and(eq(certificates.id, certificateId), isNull(certificates.systemLifecycleState)))
        .returning({ id: certificates.id });
      return updated.length === 1;
    });
  }

  private async refreshCRL(caId: string) {
    try {
      await this.crlService.generateCRL(caId, { allowSystem: true });
      await this.db
        .update(certificateAuthorities)
        .set({ crlRefreshPendingAt: null, updatedAt: new Date() })
        .where(eq(certificateAuthorities.id, caId));
    } catch (error) {
      // The pending marker was written in the same transaction as revocation,
      // so it survives process/database retries until a later publication
      // succeeds and clears it above.
      logger.error('System certificate CRL refresh failed; pending retry remains queued', { caId, error });
    }
  }
}
