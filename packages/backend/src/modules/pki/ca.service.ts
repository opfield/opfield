import crypto from 'node:crypto';
import { and, count, eq, gt, max } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { certificateAuthorities, certificates, pkiRevokedSerials } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { transactionWithScopeCleanup } from '@/lib/resource-scope-cleanup.js';
import { x509 } from '@/lib/x509.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { CreateIntermediateCAInput, CreateRootCAInput } from './ca.schemas.js';
import { rootFolderId, withRootFolders } from './ca-folder-placement.js';

const logger = createChildLogger('CAService');

type CARow = typeof certificateAuthorities.$inferSelect;

/** Publishes CRLs for CAService; implemented by CRLService, which attaches itself. */
export interface CAServiceCrlPublisher {
  generateCRL(caId: string, options?: { allowSystem?: boolean; allowInactive?: boolean }): Promise<Buffer>;
  invalidateCache(caId: string): Promise<void>;
}

/** Strip key material and the stored CRL blob before a CA row leaves the service. */
type CASecretField =
  | 'encryptedPrivateKey'
  | 'encryptedDek'
  | 'dekIv'
  | 'encryptedOcspKey'
  | 'encryptedOcspDek'
  | 'ocspDekIv'
  | 'lastCrlDer';

export function sanitizeCA<T extends Partial<CARow>>(ca: T): Omit<T, CASecretField> {
  const {
    encryptedPrivateKey: _encryptedPrivateKey,
    encryptedDek: _encryptedDek,
    dekIv: _dekIv,
    encryptedOcspKey: _encryptedOcspKey,
    encryptedOcspDek: _encryptedOcspDek,
    ocspDekIv: _ocspDekIv,
    lastCrlDer: _lastCrlDer,
    ...rest
  } = ca;
  return rest;
}

@injectable()
export class CAService {
  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly cryptoService: CryptoService,
    private readonly auditService: AuditService
  ) {}

  private eventBus?: EventBusService;
  private crlPublisher?: CAServiceCrlPublisher;
  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }
  setCrlPublisher(publisher: CAServiceCrlPublisher) {
    this.crlPublisher = publisher;
  }

  /**
   * Regenerate and cache a CA's CRL. A revocation is durable before this
   * runs, so a publication failure only drops the cached copy (the next
   * request regenerates it) instead of failing the revocation.
   */
  async publishCRL(caId: string, options?: { allowSystem?: boolean; allowInactive?: boolean }): Promise<boolean> {
    if (!this.crlPublisher) return false;
    try {
      await this.crlPublisher.generateCRL(caId, options);
      return true;
    } catch (error) {
      logger.error('CRL publication failed after revocation', {
        caId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.crlPublisher.invalidateCache(caId).catch(() => undefined);
      return false;
    }
  }
  private emitCa(id: string, action: 'created' | 'updated' | 'revoked' | 'deleted', type: 'root' | 'intermediate') {
    this.eventBus?.publish('ca.changed', { id, action, type });
  }

  async createRootCA(input: CreateRootCAInput, userId: string) {
    const serialNumber = this.cryptoService.generateSerialNumber();

    // Generate key pair
    const { publicKeyPem, privateKeyPem } = this.cryptoService.generateKeyPair(input.keyAlgorithm);

    // Calculate validity
    const notBefore = new Date();
    const notAfter = new Date();
    notAfter.setFullYear(notAfter.getFullYear() + input.validityYears);

    // Import keys for @peculiar/x509
    const algorithm = this.getAlgorithm(input.keyAlgorithm);
    const keys = await this.importKeyPair(publicKeyPem, privateKeyPem, algorithm);

    // Build self-signed certificate
    const extensions: x509.Extension[] = [
      new x509.BasicConstraintsExtension(true, input.pathLengthConstraint, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ];

    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber,
      name: `CN=${input.commonName}`,
      notBefore,
      notAfter,
      keys,
      signingAlgorithm: algorithm,
      extensions,
    });

    const certificatePem = cert.toString('pem');
    const subjectDn = `CN=${input.commonName}`;

    // Encrypt private key
    const encrypted = this.cryptoService.encryptPrivateKey(privateKeyPem);

    // Store in database
    const [ca] = await this.db
      .insert(certificateAuthorities)
      .values({
        type: 'root',
        commonName: input.commonName,
        keyAlgorithm: input.keyAlgorithm,
        serialNumber,
        encryptedPrivateKey: encrypted.encryptedPrivateKey,
        encryptedDek: encrypted.encryptedDek,
        dekIv: encrypted.dekIv,
        certificatePem,
        subjectDn,
        issuerDn: subjectDn, // self-signed
        pathLengthConstraint: input.pathLengthConstraint ?? null,
        maxValidityDays: input.maxValidityDays,
        notBefore,
        notAfter,
        createdById: userId,
        folderId: input.folderId ?? null,
      })
      .returning();

    await this.auditService.log({
      userId,
      action: 'ca.create',
      resourceType: 'ca',
      resourceId: ca.id,
      details: { type: 'root', commonName: input.commonName, keyAlgorithm: input.keyAlgorithm },
    });

    logger.info('Created root CA', { caId: ca.id, cn: input.commonName });
    this.emitCa(ca.id, 'created', ca.type);
    return sanitizeCA(ca);
  }

  async createIntermediateCA(parentId: string, input: CreateIntermediateCAInput, userId: string) {
    const parent = await this.db.query.certificateAuthorities.findFirst({
      where: eq(certificateAuthorities.id, parentId),
    });

    if (!parent) throw new AppError(404, 'CA_NOT_FOUND', 'Parent CA not found');
    if (parent.isSystem) throw new AppError(403, 'SYSTEM_CA', 'System CAs are read-only');
    if (parent.status !== 'active') throw new AppError(400, 'CA_NOT_ACTIVE', 'Parent CA is not active');

    // Validate path length constraint
    if (parent.pathLengthConstraint !== null && parent.pathLengthConstraint <= 0) {
      throw new AppError(
        400,
        'PATH_LENGTH_EXCEEDED',
        'Parent CA path length constraint does not allow more intermediate CAs'
      );
    }

    const serialNumber = this.cryptoService.generateSerialNumber();
    const { publicKeyPem, privateKeyPem } = this.cryptoService.generateKeyPair(input.keyAlgorithm);

    const notBefore = new Date();
    const notAfter = new Date();
    notAfter.setFullYear(notAfter.getFullYear() + input.validityYears);

    // Ensure intermediate validity doesn't exceed parent
    if (notAfter > parent.notAfter) {
      notAfter.setTime(parent.notAfter.getTime());
    }

    const algorithm = this.getAlgorithm(input.keyAlgorithm);
    const subjectKeys = await this.importKeyPair(publicKeyPem, privateKeyPem, algorithm);

    // Decrypt parent's private key for signing
    const parentPrivateKeyPem = this.cryptoService.decryptPrivateKey({
      encryptedPrivateKey: parent.encryptedPrivateKey,
      encryptedDek: parent.encryptedDek,
      dekIv: parent.dekIv,
    });

    const parentAlgorithm = this.getAlgorithm(parent.keyAlgorithm);
    const parentKeys = await this.importKeyPair(parent.certificatePem, parentPrivateKeyPem, parentAlgorithm, true);

    // Calculate child pathLength
    const childPathLength =
      input.pathLengthConstraint ??
      (parent.pathLengthConstraint !== null ? parent.pathLengthConstraint - 1 : undefined);

    const extensions: x509.Extension[] = [
      new x509.BasicConstraintsExtension(true, childPathLength, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(subjectKeys.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(parentKeys.publicKey),
    ];

    const cert = await x509.X509CertificateGenerator.create({
      serialNumber,
      subject: `CN=${input.commonName}`,
      issuer: parent.subjectDn,
      notBefore,
      notAfter,
      publicKey: subjectKeys.publicKey,
      signingKey: parentKeys.privateKey,
      signingAlgorithm: parentAlgorithm,
      extensions,
    });

    const certificatePem = cert.toString('pem');
    const subjectDn = `CN=${input.commonName}`;
    const encrypted = this.cryptoService.encryptPrivateKey(privateKeyPem);

    const [ca] = await this.db
      .insert(certificateAuthorities)
      .values({
        parentId,
        type: 'intermediate',
        commonName: input.commonName,
        keyAlgorithm: input.keyAlgorithm,
        serialNumber,
        encryptedPrivateKey: encrypted.encryptedPrivateKey,
        encryptedDek: encrypted.encryptedDek,
        dekIv: encrypted.dekIv,
        certificatePem,
        subjectDn,
        issuerDn: parent.subjectDn,
        pathLengthConstraint: childPathLength ?? null,
        maxValidityDays: input.maxValidityDays,
        notBefore,
        notAfter,
        createdById: userId,
      })
      .returning();

    await this.auditService.log({
      userId,
      action: 'ca.create',
      resourceType: 'ca',
      resourceId: ca.id,
      details: { type: 'intermediate', parentId, commonName: input.commonName },
    });

    logger.info('Created intermediate CA', { caId: ca.id, parentId, cn: input.commonName });
    this.emitCa(ca.id, 'created', ca.type);
    return sanitizeCA(ca);
  }

  async getCATree(showSystem = false) {
    const allCAs = await this.db.query.certificateAuthorities.findMany({
      where: showSystem ? undefined : (ca, { eq, not }) => not(eq(ca.isSystem, true)),
      orderBy: (ca, { asc }) => [asc(ca.createdAt)],
    });

    // Count certificates per CA
    const certCounts = await this.db
      .select({ caId: certificates.caId, count: count() })
      .from(certificates)
      .groupBy(certificates.caId);

    const countMap = new Map(certCounts.map((c) => [c.caId, Number(c.count)]));

    return withRootFolders(
      allCAs.map((ca) => ({
        ...sanitizeCA(ca),
        certCount: countMap.get(ca.id) || 0,
      }))
    );
  }

  async getCA(id: string, options?: { includeSystem?: boolean }) {
    const ca = await this.db.query.certificateAuthorities.findFirst({
      where: eq(certificateAuthorities.id, id),
    });

    if (!ca) throw new AppError(404, 'CA_NOT_FOUND', 'Certificate Authority not found');
    if (ca.isSystem && !options?.includeSystem) {
      throw new AppError(404, 'CA_NOT_FOUND', 'Certificate Authority not found');
    }

    const [{ count: certCount }] = await this.db
      .select({ count: count() })
      .from(certificates)
      .where(eq(certificates.caId, id));

    return {
      ...sanitizeCA(ca),
      folderId: await rootFolderId(this.db, ca),
      certCount: Number(certCount),
    };
  }

  async updateCA(
    id: string,
    input: {
      crlDistributionUrl?: string | null;
      ocspResponderUrl?: string | null;
      caIssuersUrl?: string | null;
      maxValidityDays?: number;
    },
    userId: string
  ) {
    const ca = await this.db.query.certificateAuthorities.findFirst({
      where: eq(certificateAuthorities.id, id),
    });
    if (!ca) throw new AppError(404, 'CA_NOT_FOUND', 'Certificate Authority not found');
    if (ca.isSystem) throw new AppError(403, 'SYSTEM_CA', 'System CAs are read-only');
    if (input.ocspResponderUrl) {
      throw new AppError(400, 'OCSP_DISABLED', 'OCSP responder is currently disabled');
    }

    const { ocspResponderUrl: _ocspResponderUrl, ...updates } = input;

    await this.db
      .update(certificateAuthorities)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(certificateAuthorities.id, id))
      .returning();

    await this.auditService.log({
      userId,
      action: 'ca.update',
      resourceType: 'ca',
      resourceId: id,
      details: { changes: Object.keys(updates) },
    });

    this.emitCa(id, 'updated', ca.type);
    return this.getCA(id);
  }

  async revokeCA(id: string, reason: string, userId: string, _depth = 0) {
    if (_depth > 10) {
      throw new AppError(400, 'CA_CHAIN_TOO_DEEP', 'CA revocation chain exceeds maximum depth');
    }
    const ca = await this.db.query.certificateAuthorities.findFirst({
      where: eq(certificateAuthorities.id, id),
    });

    if (!ca) throw new AppError(404, 'CA_NOT_FOUND', 'CA not found');
    if (ca.isSystem) throw new AppError(403, 'SYSTEM_CA', 'System CAs cannot be revoked');
    if (ca.status !== 'active') throw new AppError(400, 'CA_NOT_ACTIVE', 'CA is already revoked or expired');

    // Flip the status first so no new certificate is issued under this CA
    // while its final CRL is assembled.
    await this.db
      .update(certificateAuthorities)
      .set({ status: 'revoked', revokedAt: new Date(), revocationReason: reason, updatedAt: new Date() })
      .where(eq(certificateAuthorities.id, id));

    // Revoke all child CAs
    const children = await this.db.query.certificateAuthorities.findMany({
      where: and(eq(certificateAuthorities.parentId, id), eq(certificateAuthorities.status, 'active')),
    });
    for (const child of children) {
      await this.revokeCA(child.id, 'caCompromise', userId, _depth + 1);
    }

    // Revoke all certificates issued by this CA
    await this.db
      .update(certificates)
      .set({ status: 'revoked', revokedAt: new Date(), revocationReason: 'caCompromise', updatedAt: new Date() })
      .where(and(eq(certificates.caId, id), eq(certificates.status, 'active')));

    // Publish this CA's final CRL (its leaves and child CAs are revoked now);
    // it keeps being served after revocation. The parent then lists this CA.
    await this.publishCRL(id, { allowInactive: true });
    if (_depth === 0 && ca.parentId) {
      await this.publishCRL(ca.parentId);
    }

    await this.auditService.log({
      userId,
      action: 'ca.revoke',
      resourceType: 'ca',
      resourceId: id,
      details: { reason },
    });

    logger.info('Revoked CA', { caId: id, reason });
    this.emitCa(id, 'revoked', ca.type);
  }

  async deleteCA(id: string, userId: string) {
    const ca = await this.db.query.certificateAuthorities.findFirst({
      where: eq(certificateAuthorities.id, id),
    });

    if (!ca) throw new AppError(404, 'CA_NOT_FOUND', 'CA not found');
    if (ca.isSystem) throw new AppError(403, 'SYSTEM_CA', 'System CAs cannot be deleted');

    const [{ count: certCount }] = await this.db
      .select({ count: count() })
      .from(certificates)
      .where(eq(certificates.caId, id));

    if (Number(certCount) > 0) {
      throw new AppError(400, 'CA_HAS_CERTIFICATES', 'Cannot delete CA that has issued certificates');
    }

    const childCAs = await this.db.query.certificateAuthorities.findMany({
      where: eq(certificateAuthorities.parentId, id),
    });

    if (childCAs.length > 0) {
      throw new AppError(400, 'CA_HAS_CHILDREN', 'Cannot delete CA that has child CAs');
    }

    // Revoked certificates deleted before they expired stay on this CA's CRL (keptOnCrlUntil). The CRL belongs to
    // the CA, so deleting the CA ends it and those entries with it; the answer says so.
    const [kept] = await this.db
      .select({ count: count(), until: max(pkiRevokedSerials.notAfter) })
      .from(pkiRevokedSerials)
      .where(and(eq(pkiRevokedSerials.caId, id), gt(pkiRevokedSerials.notAfter, new Date())));
    const droppedFromCrl = Number(kept?.count ?? 0);

    await transactionWithScopeCleanup(this.db, (tx) =>
      tx.delete(certificateAuthorities).where(eq(certificateAuthorities.id, id))
    );

    await this.auditService.log({
      userId,
      action: 'ca.delete',
      resourceType: 'ca',
      resourceId: id,
      ...(droppedFromCrl > 0 ? { details: { droppedFromCrl, crlWouldListUntil: kept?.until ?? null } } : {}),
    });
    this.emitCa(id, 'deleted', ca.type);
    return {
      deleted: true as const,
      droppedFromCrl,
      ...(droppedFromCrl > 0
        ? {
            note: `The CA's CRL is gone with it, so the ${droppedFromCrl} revoked certificate(s) it still listed (until ${(kept?.until as Date).toISOString()}) are on no CRL now. Remove this CA from every trust store, or clients that still trust it accept those certificates.`,
          }
        : {}),
    };
  }

  /**
   * Get CA's decrypted signing key — internal use only. `allowInactive`
   * exists only for CRL signing: a revoked CA publishes a final CRL, but
   * never issues or exports anything.
   */
  async getCASigningMaterials(caId: string, options?: { allowSystem?: boolean; allowInactive?: boolean }) {
    const ca = await this.db.query.certificateAuthorities.findFirst({
      where: eq(certificateAuthorities.id, caId),
    });

    if (!ca) throw new AppError(404, 'CA_NOT_FOUND', 'CA not found');
    if (ca.isSystem && !options?.allowSystem) {
      throw new AppError(403, 'SYSTEM_CA', 'System CAs are read-only');
    }
    if (ca.status !== 'active' && !options?.allowInactive) {
      throw new AppError(400, 'CA_NOT_ACTIVE', 'CA is not active');
    }

    const privateKeyPem = this.cryptoService.decryptPrivateKey({
      encryptedPrivateKey: ca.encryptedPrivateKey,
      encryptedDek: ca.encryptedDek,
      dekIv: ca.dekIv,
    });

    return { ca, privateKeyPem };
  }

  // --- Helpers ---

  getAlgorithm(keyAlgorithm: string): EcdsaParams | RsaHashedKeyAlgorithm {
    switch (keyAlgorithm) {
      case 'rsa-2048':
        return { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
      case 'rsa-4096':
        return { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' };
      case 'ecdsa-p256':
        return { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as any;
      case 'ecdsa-p384':
        return { name: 'ECDSA', namedCurve: 'P-384', hash: 'SHA-384' } as any;
      default:
        throw new Error(`Unsupported algorithm: ${keyAlgorithm}`);
    }
  }

  async importKeyPair(
    publicPemOrCert: string,
    privateKeyPem: string,
    algorithm: any,
    isCert = false
  ): Promise<{ publicKey: CryptoKey; privateKey: CryptoKey }> {
    let publicKey: CryptoKey;

    if (isCert) {
      // Extract public key from certificate
      const cert = new x509.X509Certificate(publicPemOrCert);
      publicKey = await cert.publicKey.export(algorithm, ['verify']);
    } else {
      publicKey = await crypto.webcrypto.subtle.importKey(
        'spki',
        this.pemToBuffer(publicPemOrCert, 'PUBLIC KEY'),
        algorithm,
        true,
        ['verify']
      );
    }

    const privateKey = await crypto.webcrypto.subtle.importKey(
      'pkcs8',
      this.pemToBuffer(privateKeyPem, 'PRIVATE KEY'),
      algorithm,
      true,
      ['sign']
    );

    return { publicKey, privateKey };
  }

  private pemToBuffer(pem: string, label: string): ArrayBuffer {
    const base64 = pem.replace(`-----BEGIN ${label}-----`, '').replace(`-----END ${label}-----`, '').replace(/\s/g, '');
    const binary = Buffer.from(base64, 'base64');
    return binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength);
  }
}
