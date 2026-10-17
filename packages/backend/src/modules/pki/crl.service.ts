import { and, eq, gt, lte, sql } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { certificateAuthorities, certificates, pkiRevokedSerials } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { x509 } from '@/lib/x509.js';
import { AppError } from '@/middleware/error-handler.js';
import { getEnvironmentSettingsSnapshot } from '@/modules/settings/environment-settings.service.js';
import type { CacheService } from '@/services/cache.service.js';
import type { CAService } from './ca.service.js';
import { crlNeedsRepublish, crlSerialHex, derPositiveInteger, CRL_NUMBER_OID } from './crl-encoding.js';

const logger = createChildLogger('CRLService');

const CRL_CACHE_PREFIX = 'crl:';
const CRL_LOCK_PREFIX = 'pki-crl:';

@injectable()
export class CRLService {
  /** Per CA: tail of the in-process generation queue. */
  private readonly generationQueues = new Map<string, Promise<void>>();
  /** Per CA: revocation snapshots taken by generations in this process. */
  private readonly snapshotsTaken = new Map<string, number>();
  /** Per CA: the last CRL this process committed and the snapshot it lists. */
  private readonly lastPublished = new Map<string, { snapshot: number; crlDer: Buffer }>();

  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly caService: CAService,
    private readonly cacheService: CacheService
  ) {
    // CAService and CertService republish CRLs after revocations through this.
    this.caService.setCrlPublisher?.(this);
  }

  /**
   * Public CRL for a user CA. System CAs are hidden from the public PKI
   * endpoints, so they are always "not found" here, whether or not an internal
   * refresh cached their CRL. The CA row is read before the cache for that
   * reason; the cache still saves the signing work.
   */
  async getCRL(caId: string): Promise<Buffer> {
    const ca = await this.db.query.certificateAuthorities.findFirst({
      where: eq(certificateAuthorities.id, caId),
      columns: { id: true, status: true, lastCrlDer: true, lastCrlAt: true, revokedAt: true, isSystem: true },
    });
    if (!ca || ca.isSystem) throw new AppError(404, 'CA_NOT_FOUND', 'CA not found');

    // A CRL stored (or cached) before the CA was revoked is not its final CRL:
    // publishing at revocation failed. Regenerate it instead of serving the
    // pre-revocation list until the CA expires.
    if (ca.status !== 'active' && ca.revokedAt && (!ca.lastCrlAt || ca.lastCrlAt < ca.revokedAt)) {
      logger.warn('Stored CRL predates CA revocation; publishing the final CRL', { caId });
      return this.generateCRL(caId, { allowInactive: true });
    }

    const cached = await this.cacheService.get<string>(`${CRL_CACHE_PREFIX}${caId}`);
    if (cached) {
      return Buffer.from(cached, 'base64');
    }

    if (ca.status !== 'active') {
      // A revoked CA keeps serving its final CRL. One revoked before final
      // CRLs were stored gets it published on first request.
      if (ca.lastCrlDer) {
        await this.cacheCrl(caId, ca.lastCrlDer);
        return Buffer.from(ca.lastCrlDer, 'base64');
      }
      return this.generateCRL(caId, { allowInactive: true });
    }

    return this.generateCRL(caId);
  }

  /**
   * Sign and publish a new CRL, or return one that already lists everything
   * this call must list.
   *
   * Generations for one CA queue in process first, so waiting callers hold no
   * pool connection, and then run under a transaction-scoped advisory lock
   * (which also fences other processes): the CRL number is taken with
   * `UPDATE ... RETURNING` and the revoked set is read inside the lock, so a
   * later CRL never lists fewer revocations than an earlier one and no two CRLs
   * share a number.
   *
   * A caller reuses the last CRL this process committed when that CRL's
   * revocation snapshot was taken after the caller started: every revocation
   * committed before the call is then in it. A burst of cache misses on the
   * public endpoint therefore signs once instead of once per request. (An
   * in-process snapshot counter decides this rather than `lastCrlAt`: a
   * millisecond timestamp cannot order a snapshot against a request that
   * started in the same millisecond.)
   *
   * The cache is written after commit, never with a CRL that rolled back.
   */
  async generateCRL(caId: string, options?: { allowSystem?: boolean; allowInactive?: boolean }): Promise<Buffer> {
    // Taken before any await: revocations committed before this call must be listed.
    const startedAfterSnapshot = this.snapshotsTaken.get(caId) ?? 0;
    const validityHours = getEnvironmentSettingsSnapshot().pkiDefaults.crlValidityHours;
    const { ca, privateKeyPem } = await this.caService.getCASigningMaterials(caId, options);

    return this.inGenerationQueue(caId, async () => {
      const latest = this.lastPublished.get(caId);
      if (latest && latest.snapshot > startedAfterSnapshot) return latest.crlDer;

      const algorithm = this.caService.getAlgorithm(ca.keyAlgorithm);
      const caKeys = await this.caService.importKeyPair(ca.certificatePem, privateKeyPem, algorithm, true);

      const published = await this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${CRL_LOCK_PREFIX}${caId}`}))`);
        const [numbered] = await tx
          .update(certificateAuthorities)
          .set({ crlNumber: sql`${certificateAuthorities.crlNumber} + 1`, updatedAt: new Date() })
          .where(eq(certificateAuthorities.id, caId))
          .returning({
            crlNumber: certificateAuthorities.crlNumber,
            status: certificateAuthorities.status,
            notAfter: certificateAuthorities.notAfter,
          });
        if (!numbered) throw new AppError(404, 'CA_NOT_FOUND', 'CA not found');
        const snapshot = (this.snapshotsTaken.get(caId) ?? 0) + 1;
        this.snapshotsTaken.set(caId, snapshot);

        // Read inside the lock: every revocation committed before this CRL's
        // number was taken is listed.
        const revokedCerts = await tx.query.certificates.findMany({
          where: and(eq(certificates.caId, caId), eq(certificates.status, 'revoked')),
          columns: {
            serialNumber: true,
            revokedAt: true,
            revocationReason: true,
          },
        });
        // A revoked certificate deleted before it expired stays listed until then (pki-revoked-serials.ts); past
        // its expiry it may leave the CRL (RFC 5280 5.1.2.6), and its row goes.
        await tx
          .delete(pkiRevokedSerials)
          .where(and(eq(pkiRevokedSerials.caId, caId), lte(pkiRevokedSerials.notAfter, new Date())));
        const deletedRevoked = await tx
          .select({ serialNumber: pkiRevokedSerials.serialNumber, revokedAt: pkiRevokedSerials.revokedAt })
          .from(pkiRevokedSerials)
          .where(and(eq(pkiRevokedSerials.caId, caId), gt(pkiRevokedSerials.notAfter, new Date())));
        // A revoked intermediate CA is a certificate this CA issued, so it belongs
        // in this CA's CRL as well.
        const revokedChildCAs = await tx.query.certificateAuthorities.findMany({
          where: and(eq(certificateAuthorities.parentId, caId), eq(certificateAuthorities.status, 'revoked')),
          columns: {
            serialNumber: true,
            revokedAt: true,
          },
        });

        // Build CRL entries
        // A certificate deleted while this runs can be read twice (row, then tombstone): list each serial once.
        const listed = new Set<string>();
        const revokedEntries = [...revokedCerts, ...deletedRevoked, ...revokedChildCAs].filter((revoked) => {
          if (listed.has(revoked.serialNumber)) return false;
          listed.add(revoked.serialNumber);
          return true;
        });
        // The generator writes the serial bytes as given: crlSerialHex keeps each one a positive DER INTEGER.
        const entries = revokedEntries.map((revoked) => ({
          serialNumber: crlSerialHex(revoked.serialNumber),
          revocationDate: revoked.revokedAt || new Date(),
        })) as unknown as x509.X509CrlEntry[];

        const thisUpdate = new Date();
        const nextUpdate = new Date();
        nextUpdate.setHours(nextUpdate.getHours() + validityHours);
        // A CA that is no longer active publishes no further CRL, so its final
        // CRL stays current until the CA itself expires.
        if (numbered.status !== 'active' && numbered.notAfter > nextUpdate) {
          nextUpdate.setTime(numbered.notAfter.getTime());
        }

        // RFC 5280 5.2: a conforming CRL carries its CRL Number and the issuer's key identifier.
        const caKeyId = new x509.X509Certificate(ca.certificatePem).getExtension(x509.SubjectKeyIdentifierExtension)?.keyId;
        const extensions: x509.Extension[] = [
          new x509.Extension(CRL_NUMBER_OID, false, derPositiveInteger(numbered.crlNumber)),
          caKeyId
            ? new x509.AuthorityKeyIdentifierExtension(caKeyId, false)
            : await x509.AuthorityKeyIdentifierExtension.create(caKeys.publicKey, false),
        ];

        const crl = await x509.X509CrlGenerator.create({
          issuer: ca.subjectDn,
          thisUpdate,
          nextUpdate,
          entries,
          extensions,
          signingKey: caKeys.privateKey,
          signingAlgorithm: algorithm,
        });

        const crlDer = Buffer.from(crl.rawData);
        const crlBase64 = crlDer.toString('base64');

        // Keep the published CRL for later serving.
        await tx
          .update(certificateAuthorities)
          .set({ lastCrlAt: new Date(), lastCrlDer: crlBase64, updatedAt: new Date() })
          .where(eq(certificateAuthorities.id, caId));

        return { crlDer, crlBase64, snapshot, crlNumber: numbered.crlNumber, entries: entries.length };
      });

      this.lastPublished.set(caId, { snapshot: published.snapshot, crlDer: published.crlDer });
      await this.cacheCommittedCrl(caId, published.crlBase64);
      logger.info('Generated CRL', { caId, entries: published.entries, crlNumber: published.crlNumber });
      return published.crlDer;
    });
  }

  /**
   * Sign again every stored CRL an older release wrote: one that lists a serial
   * as a negative number (CRL-checking clients then accepted those revoked
   * certificates) or lacks the CRL Number / Authority Key Identifier
   * extensions. Runs on startup, so an update heals every CA, system CAs and
   * revoked CAs (their final CRL) included, without a manual step.
   */
  async republishOutdatedCrls(): Promise<{ republished: number; failed: number }> {
    const stored = await this.db
      .select({
        id: certificateAuthorities.id,
        status: certificateAuthorities.status,
        lastCrlDer: certificateAuthorities.lastCrlDer,
        notAfter: certificateAuthorities.notAfter,
      })
      .from(certificateAuthorities);
    let republished = 0;
    let failed = 0;
    for (const ca of stored) {
      if (!ca.lastCrlDer || ca.notAfter <= new Date() || !crlNeedsRepublish(ca.lastCrlDer)) continue;
      try {
        await this.generateCRL(ca.id, { allowSystem: true, allowInactive: ca.status !== 'active' });
        republished++;
      } catch (error) {
        failed++;
        logger.error('Could not sign the CRL of this CA again; it is retried on the next start', { caId: ca.id, error });
      }
    }
    if (republished || failed) logger.info('Signed CRLs written by an older release again', { republished, failed });
    return { republished, failed };
  }

  /** Run CRL generations for one CA one after another in this process. */
  private inGenerationQueue<T>(caId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.generationQueues.get(caId) ?? Promise.resolve();
    const run = previous.then(
      () => task(),
      () => task()
    );
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.generationQueues.set(caId, tail);
    void tail.then(() => {
      if (this.generationQueues.get(caId) === tail) this.generationQueues.delete(caId);
    });
    return run;
  }

  /**
   * Cache a committed CRL. Generations in this process are already ordered by
   * the queue; if another process committed a newer CRL in the meantime, the
   * cache follows the stored one instead.
   */
  private async cacheCommittedCrl(caId: string, crlBase64: string): Promise<void> {
    await this.cacheCrl(caId, crlBase64);
    const [stored] = await this.db
      .select({ lastCrlDer: certificateAuthorities.lastCrlDer })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.id, caId))
      .limit(1);
    if (stored?.lastCrlDer && stored.lastCrlDer !== crlBase64) await this.cacheCrl(caId, stored.lastCrlDer);
  }

  async invalidateCache(caId: string): Promise<void> {
    await this.cacheService.delete(`${CRL_CACHE_PREFIX}${caId}`);
  }

  private async cacheCrl(caId: string, crlBase64: string): Promise<void> {
    const ttlSeconds = getEnvironmentSettingsSnapshot().pkiDefaults.crlValidityHours * 3600;
    await this.cacheService.set(`${CRL_CACHE_PREFIX}${caId}`, crlBase64, ttlSeconds);
  }
}
