import crypto from 'node:crypto';
import { and, asc, count, desc, eq, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { certificateAuthorities, certificates, certificateTemplates } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { buildWhere, escapeLike } from '@/lib/utils.js';
import { x509 } from '@/lib/x509.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { PaginatedResponse } from '@/types.js';
import type { CAService } from './ca.service.js';
import type { CertificateListQuery, IssueCertFromCSRInput, IssueCertificateInput } from './cert.schemas.js';

const logger = createChildLogger('CertService');

/** Strip the envelope-encrypted key before a certificate row leaves the service. */
function sanitizeCertificate<T extends { encryptedPrivateKey?: unknown; encryptedDek?: unknown; dekIv?: unknown }>(
  certificate: T
): Omit<T, 'encryptedPrivateKey' | 'encryptedDek' | 'dekIv'> {
  const {
    encryptedPrivateKey: _encryptedPrivateKey,
    encryptedDek: _encryptedDek,
    dekIv: _dekIv,
    ...rest
  } = certificate;
  return rest;
}

/** A clamped leaf shorter than this is refused: the CA is effectively at its end. */
const MIN_CLAMPED_LEAF_VALIDITY_MS = 60 * 60 * 1000;

/**
 * Resolve a leaf's notAfter against its issuing CA. A leaf that would outlive
 * the CA is either refused (VALIDITY_EXCEEDS_CA) or, when clamping applies,
 * shortened to end with the CA. System CAs always clamp: their leaves (node
 * mTLS, Gateway listeners, relays, managed storage and database TLS) must keep
 * renewing through the CA's final year instead of failing outright.
 */
export function resolveLeafNotAfter(
  requested: Date,
  ca: { notAfter: Date; isSystem?: boolean | null },
  clamp: boolean,
  now = new Date()
): { notAfter: Date; clamped: boolean } {
  if (requested.getTime() <= ca.notAfter.getTime()) return { notAfter: requested, clamped: false };
  if (!clamp && !ca.isSystem) {
    throw new AppError(
      400,
      'VALIDITY_EXCEEDS_CA',
      `Certificate validity exceeds CA validity (the CA expires on ${ca.notAfter.toISOString()}). Shorten the validity or set clampToCaValidity to end the certificate with the CA.`
    );
  }
  if (ca.notAfter.getTime() - now.getTime() < MIN_CLAMPED_LEAF_VALIDITY_MS) {
    throw new AppError(400, 'CA_EXPIRING', 'The issuing CA expires too soon to issue a certificate');
  }
  return { notAfter: new Date(ca.notAfter.getTime()), clamped: true };
}

interface IssueCertificateOptions {
  allowSystem?: boolean;
  /**
   * Internal callers only: the leaf's extended key usages instead of the type's (a managed database member presents
   * its server leaf as the replication client too: serverAuth and clientAuth).
   */
  extKeyUsage?: readonly string[];
  /** End the leaf with its CA instead of failing when the requested validity outlives the CA. */
  clampToCaValidity?: boolean;
  /**
   * Reserved for the lifecycle service. Issuing a system leaf starts as
   * report-only `unknown` until its owner swap is committed.
   */
  systemLifecycle?: {
    ownerType:
      | 'node'
      | 'managed_database'
      | 'managed_storage'
      | 'gateway_listener'
      | 'gateway_service'
      | 'relay_node_server';
    ownerId: string;
    state: 'unknown';
  };
}

// Map string key usage to @peculiar/x509 flags
const KEY_USAGE_MAP: Record<string, number> = {
  digitalSignature: x509.KeyUsageFlags.digitalSignature,
  keyEncipherment: x509.KeyUsageFlags.keyEncipherment,
  dataEncipherment: x509.KeyUsageFlags.dataEncipherment,
  keyAgreement: x509.KeyUsageFlags.keyAgreement,
  nonRepudiation: x509.KeyUsageFlags.nonRepudiation,
};

@injectable()
export class CertService {
  private eventBus?: EventBusService;

  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly cryptoService: CryptoService,
    private readonly caService: CAService,
    private readonly auditService: AuditService
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  private emitCert(id: string, caId: string, action: 'created' | 'revoked') {
    this.eventBus?.publish('cert.changed', { id, caId, action });
  }

  async issueCertificate(input: IssueCertificateInput, userId: string, options?: IssueCertificateOptions) {
    const { ca, privateKeyPem: caPrivateKeyPem } = await this.caService.getCASigningMaterials(input.caId, {
      allowSystem: options?.allowSystem,
    });

    // Validate validity
    const notBefore = new Date();
    const requestedNotAfter = new Date();
    requestedNotAfter.setDate(requestedNotAfter.getDate() + input.validityDays);

    if (input.validityDays > ca.maxValidityDays) {
      throw new AppError(400, 'VALIDITY_EXCEEDED', `Validity exceeds CA maximum of ${ca.maxValidityDays} days`);
    }
    const { notAfter, clamped } = resolveLeafNotAfter(
      requestedNotAfter,
      ca,
      Boolean(input.clampToCaValidity || options?.clampToCaValidity),
      notBefore
    );
    if (clamped) {
      logger.warn('Certificate validity clamped to the issuing CA lifetime', {
        caId: ca.id,
        cn: input.commonName,
        requestedNotAfter: requestedNotAfter.toISOString(),
        notAfter: notAfter.toISOString(),
      });
    }

    const serialNumber = this.cryptoService.generateSerialNumber();
    const { publicKeyPem, privateKeyPem } = this.cryptoService.generateKeyPair(input.keyAlgorithm);

    const caAlgorithm = this.caService.getAlgorithm(ca.keyAlgorithm);
    const leafAlgorithm = this.caService.getAlgorithm(input.keyAlgorithm);
    const caKeys = await this.caService.importKeyPair(ca.certificatePem, caPrivateKeyPem, caAlgorithm, true);
    const leafPublicKey = await crypto.webcrypto.subtle.importKey(
      'spki',
      this.pemToBuffer(publicKeyPem, 'PUBLIC KEY'),
      leafAlgorithm,
      true,
      ['verify']
    );

    // Load template if provided
    const template = input.templateId
      ? await this.db.query.certificateTemplates.findFirst({
          where: eq(certificateTemplates.id, input.templateId),
        })
      : null;

    // Resolve key usage from template or cert type fallback
    const keyUsageStrings =
      (template?.keyUsage?.length ?? 0) > 0 ? (template!.keyUsage as string[]) : this.getKeyUsageStrings(input.type);
    const keyUsageFlags = this.buildKeyUsageFlags(keyUsageStrings);

    // Resolve ext key usage from the caller, the template or the cert type fallback
    const extKeyUsageStrings = options?.extKeyUsage?.length
      ? [...options.extKeyUsage]
      : (template?.extKeyUsage?.length ?? 0) > 0
        ? (template!.extKeyUsage as string[])
        : this.getExtKeyUsageStrings(input.type);
    const extKeyUsageOids = this.resolveExtKeyUsageOids(extKeyUsageStrings);

    // Build subject DN
    const subjectDn = this.buildSubjectDn(
      input.commonName,
      input.subjectDnFields,
      template?.subjectDnFields as Record<string, string> | undefined
    );

    // Build extensions
    const extensions: x509.Extension[] = [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(keyUsageFlags, true),
      await x509.SubjectKeyIdentifierExtension.create(leafPublicKey),
      await x509.AuthorityKeyIdentifierExtension.create(caKeys.publicKey),
    ];

    // Add SAN extension
    if (input.sans.length > 0) {
      extensions.push(new x509.SubjectAlternativeNameExtension(this.buildSANs(input.sans), true));
    }

    // Add Extended Key Usage
    if (extKeyUsageOids.length > 0) {
      extensions.push(new x509.ExtendedKeyUsageExtension(extKeyUsageOids, false));
    }

    // Add template/CA-level extensions
    this.addDistributionExtensions(extensions, template ?? null, ca);
    this.addPolicyExtensions(extensions, template ?? null);
    this.addCustomExtensions(extensions, template ?? null);

    const cert = await x509.X509CertificateGenerator.create({
      serialNumber,
      subject: subjectDn,
      issuer: ca.subjectDn,
      notBefore,
      notAfter,
      publicKey: leafPublicKey,
      signingKey: caKeys.privateKey,
      signingAlgorithm: caAlgorithm,
      extensions,
    });

    const certificatePem = cert.toString('pem');
    const encrypted = this.cryptoService.encryptPrivateKey(privateKeyPem);

    const [certificate] = await this.db
      .insert(certificates)
      .values({
        caId: input.caId,
        templateId: input.templateId,
        folderId: input.folderId ?? null,
        type: input.type,
        commonName: input.commonName,
        sans: input.sans,
        serialNumber,
        certificatePem,
        encryptedPrivateKey: encrypted.encryptedPrivateKey,
        encryptedDek: encrypted.encryptedDek,
        dekIv: encrypted.dekIv,
        keyAlgorithm: input.keyAlgorithm,
        subjectDn,
        issuerDn: ca.subjectDn,
        notBefore,
        notAfter,
        serverGenerated: true,
        keyUsage: keyUsageStrings,
        extKeyUsage: extKeyUsageStrings,
        systemOwnerType: options?.systemLifecycle?.ownerType,
        systemOwnerId: options?.systemLifecycle?.ownerId,
        systemLifecycleState: options?.systemLifecycle?.state,
        issuedById: userId,
      })
      .returning();

    await this.auditService.log({
      userId,
      action: 'cert.issue',
      resourceType: 'certificate',
      resourceId: certificate.id,
      details: {
        type: input.type,
        caId: input.caId,
        cn: input.commonName,
        serverGenerated: true,
        ...(clamped ? { clampedToCaValidity: true } : {}),
      },
    });

    logger.info('Issued certificate', { certId: certificate.id, cn: input.commonName });
    this.emitCert(certificate.id, certificate.caId, 'created');

    return {
      certificate: sanitizeCertificate(certificate),
      privateKeyPem, // Returned ONCE at issuance for server-generated keys
    };
  }

  async issueCertificateFromCSR(input: IssueCertFromCSRInput, userId: string, options?: { allowSystem?: boolean }) {
    const { ca, privateKeyPem: caPrivateKeyPem } = await this.caService.getCASigningMaterials(input.caId, {
      allowSystem: options?.allowSystem,
    });

    // Parse CSR
    let csr: x509.Pkcs10CertificateRequest;
    try {
      csr = new x509.Pkcs10CertificateRequest(input.csrPem);
    } catch {
      throw new AppError(400, 'INVALID_CSR', 'Failed to parse CSR');
    }

    const csrValid = await csr.verify();
    if (!csrValid) {
      throw new AppError(400, 'INVALID_CSR_SIGNATURE', 'CSR signature verification failed');
    }

    // Extract CN from CSR subject
    const csrSubject = csr.subject;
    const cnMatch = csrSubject.match(/CN=([^,]+)/);
    const commonName = cnMatch ? cnMatch[1] : 'Unknown';

    // Use override SANs or extract from CSR
    const sans = input.overrideSans || [];

    const notBefore = new Date();
    const requestedNotAfter = new Date();
    requestedNotAfter.setDate(requestedNotAfter.getDate() + input.validityDays);

    if (input.validityDays > ca.maxValidityDays) {
      throw new AppError(400, 'VALIDITY_EXCEEDED', `Validity exceeds CA maximum of ${ca.maxValidityDays} days`);
    }
    // A leaf that outlives its CA never validates past the CA's end.
    const { notAfter, clamped } = resolveLeafNotAfter(
      requestedNotAfter,
      ca,
      Boolean(input.clampToCaValidity),
      notBefore
    );

    const serialNumber = this.cryptoService.generateSerialNumber();
    const caAlgorithm = this.caService.getAlgorithm(ca.keyAlgorithm);
    const caKeys = await this.caService.importKeyPair(ca.certificatePem, caPrivateKeyPem, caAlgorithm, true);

    // Load template if provided
    const template = input.templateId
      ? await this.db.query.certificateTemplates.findFirst({
          where: eq(certificateTemplates.id, input.templateId),
        })
      : null;

    // Resolve key usage from template or cert type fallback
    const keyUsageStrings =
      (template?.keyUsage?.length ?? 0) > 0 ? (template!.keyUsage as string[]) : this.getKeyUsageStrings(input.type);
    const keyUsageFlags = this.buildKeyUsageFlags(keyUsageStrings);

    // Resolve ext key usage from template or cert type fallback
    const extKeyUsageStrings =
      (template?.extKeyUsage?.length ?? 0) > 0
        ? (template!.extKeyUsage as string[])
        : this.getExtKeyUsageStrings(input.type);
    const extKeyUsageOids = this.resolveExtKeyUsageOids(extKeyUsageStrings);

    const subjectDn = `CN=${commonName}`;

    // Build extensions
    const extensions: x509.Extension[] = [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(keyUsageFlags, true),
      await x509.AuthorityKeyIdentifierExtension.create(caKeys.publicKey),
    ];

    if (sans.length > 0) {
      extensions.push(new x509.SubjectAlternativeNameExtension(this.buildSANs(sans), true));
    }

    if (extKeyUsageOids.length > 0) {
      extensions.push(new x509.ExtendedKeyUsageExtension(extKeyUsageOids, false));
    }

    // Add template/CA-level extensions
    this.addDistributionExtensions(extensions, template ?? null, ca);
    this.addPolicyExtensions(extensions, template ?? null);
    this.addCustomExtensions(extensions, template ?? null);

    const keyAlgorithm = ca.keyAlgorithm; // fallback

    const cert = await x509.X509CertificateGenerator.create({
      serialNumber,
      subject: subjectDn,
      issuer: ca.subjectDn,
      notBefore,
      notAfter,
      publicKey: csr.publicKey,
      signingKey: caKeys.privateKey,
      signingAlgorithm: caAlgorithm,
      extensions,
    });

    const certificatePem = cert.toString('pem');

    const [certificate] = await this.db
      .insert(certificates)
      .values({
        caId: input.caId,
        templateId: input.templateId,
        folderId: input.folderId ?? null,
        type: input.type,
        commonName,
        sans,
        serialNumber,
        certificatePem,
        keyAlgorithm,
        subjectDn,
        issuerDn: ca.subjectDn,
        notBefore,
        notAfter,
        csrPem: input.csrPem,
        serverGenerated: false,
        keyUsage: keyUsageStrings,
        extKeyUsage: extKeyUsageStrings,
        issuedById: userId,
      })
      .returning();

    await this.auditService.log({
      userId,
      action: 'cert.issue',
      resourceType: 'certificate',
      resourceId: certificate.id,
      details: {
        type: input.type,
        caId: input.caId,
        cn: commonName,
        serverGenerated: false,
        ...(clamped ? { clampedToCaValidity: true } : {}),
      },
    });

    this.emitCert(certificate.id, certificate.caId, 'created');
    return sanitizeCertificate(certificate);
  }

  async getCertificate(id: string, options?: { includeSystem?: boolean }) {
    const cert = await this.db.query.certificates.findFirst({
      where: eq(certificates.id, id),
    });

    if (!cert) throw new AppError(404, 'CERT_NOT_FOUND', 'Certificate not found');
    const [caRow] = await this.db
      .select({ isSystem: certificateAuthorities.isSystem })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.id, cert.caId))
      .limit(1);
    if (caRow?.isSystem && !options?.includeSystem) {
      throw new AppError(404, 'CERT_NOT_FOUND', 'Certificate not found');
    }

    return {
      ...cert,
      isSystem: !!caRow?.isSystem,
      encryptedPrivateKey: undefined,
      encryptedDek: undefined,
      dekIv: undefined,
    };
  }

  async listCertificates(
    params: CertificateListQuery,
    options?: { allowedIds?: string[] }
  ): Promise<PaginatedResponse<any>> {
    const conditions = [];

    if (options?.allowedIds) {
      if (options.allowedIds.length === 0) {
        return {
          data: [],
          pagination: { page: params.page, limit: params.limit, total: 0, totalPages: 0 },
        };
      }
      conditions.push(inArray(certificates.id, options.allowedIds));
    }

    if (!params.showSystem) {
      // Exclude certificates issued by the internal system CA (node mTLS certs)
      const systemCaIds = sql`(SELECT id FROM ${certificateAuthorities} WHERE is_system = true)`;
      conditions.push(sql`${certificates.caId} NOT IN ${systemCaIds}`);
    }

    if (params.caId) conditions.push(eq(certificates.caId, params.caId));
    if (params.status) conditions.push(eq(certificates.status, params.status));
    if (params.type) conditions.push(eq(certificates.type, params.type));
    if (params.search) {
      conditions.push(
        or(
          ilike(certificates.commonName, `%${escapeLike(params.search)}%`),
          ilike(certificates.serialNumber, `%${escapeLike(params.search)}%`)
        )!
      );
    }

    const where = buildWhere(conditions);

    const orderColumn =
      {
        commonName: certificates.commonName,
        createdAt: certificates.createdAt,
        notAfter: certificates.notAfter,
        type: certificates.type,
      }[params.sortBy] || certificates.createdAt;

    const orderFn = params.sortOrder === 'asc' ? asc : desc;

    const [entries, [{ count: totalCount }]] = await Promise.all([
      this.db.query.certificates.findMany({
        where: where ? () => where : undefined,
        orderBy: [orderFn(orderColumn)],
        limit: params.limit,
        offset: (params.page - 1) * params.limit,
        columns: {
          encryptedPrivateKey: false,
          encryptedDek: false,
          dekIv: false,
        },
      }),
      this.db.select({ count: count() }).from(certificates).where(where),
    ]);

    const caIds = [...new Set(entries.map((entry) => entry.caId))];
    const caRows = caIds.length
      ? await this.db
          .select({ id: certificateAuthorities.id, isSystem: certificateAuthorities.isSystem })
          .from(certificateAuthorities)
          .where(inArray(certificateAuthorities.id, caIds))
      : [];
    const caSystemMap = new Map(caRows.map((row) => [row.id, !!row.isSystem]));
    const data = entries.map((entry) => ({
      ...entry,
      isSystem: caSystemMap.get(entry.caId) ?? false,
    }));

    const total = Number(totalCount);

    return {
      data,
      pagination: {
        page: params.page,
        limit: params.limit,
        total,
        totalPages: Math.ceil(total / params.limit),
      },
    };
  }

  async revokeCertificate(id: string, reason: string, userId: string) {
    const cert = await this.db.query.certificates.findFirst({
      where: eq(certificates.id, id),
    });

    if (!cert) throw new AppError(404, 'CERT_NOT_FOUND', 'Certificate not found');
    const [caRow] = await this.db
      .select({ isSystem: certificateAuthorities.isSystem })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.id, cert.caId))
      .limit(1);
    if (caRow?.isSystem) {
      throw new AppError(403, 'SYSTEM_CERT', 'System certificates cannot be revoked');
    }
    if (cert.status !== 'active')
      throw new AppError(400, 'CERT_NOT_ACTIVE', 'Certificate is already revoked or expired');

    await this.db
      .update(certificates)
      .set({ status: 'revoked', revokedAt: new Date(), revocationReason: reason, updatedAt: new Date() })
      .where(eq(certificates.id, id));

    await this.auditService.log({
      userId,
      action: 'cert.revoke',
      resourceType: 'certificate',
      resourceId: id,
      details: { reason, caId: cert.caId },
    });

    logger.info('Revoked certificate', { certId: id, reason });
    this.emitCert(cert.id, cert.caId, 'revoked');
    // Every revocation path (REST, AI/MCP tools) republishes the CRL here.
    await this.caService.publishCRL(cert.caId);
    return cert.caId;
  }

  async getExpiringCertificates(withinDays: number) {
    const threshold = new Date();
    threshold.setDate(threshold.getDate() + withinDays);

    return this.db.query.certificates.findMany({
      where: and(eq(certificates.status, 'active'), lte(certificates.notAfter, threshold)),
      columns: {
        encryptedPrivateKey: false,
        encryptedDek: false,
        dekIv: false,
      },
    });
  }

  /**
   * Get the decrypted private key for a certificate (for export).
   * Returns null if the cert was CSR-based (server never had the key).
   */
  async getCertificatePrivateKey(id: string): Promise<string | null> {
    const cert = await this.db.query.certificates.findFirst({
      where: eq(certificates.id, id),
    });

    if (!cert?.encryptedPrivateKey || !cert.encryptedDek) return null;

    return this.cryptoService.decryptPrivateKey({
      encryptedPrivateKey: cert.encryptedPrivateKey,
      encryptedDek: cert.encryptedDek,
      dekIv: cert.dekIv || '',
    });
  }

  // --- Helpers ---

  // -----------------------------------------------------------------------
  // Key usage helpers
  // -----------------------------------------------------------------------

  private getKeyUsageStrings(certType: string): string[] {
    switch (certType) {
      case 'tls-server':
        return ['digitalSignature', 'keyEncipherment'];
      case 'tls-client':
        return ['digitalSignature'];
      case 'code-signing':
        return ['digitalSignature'];
      case 'email':
        return ['digitalSignature', 'keyEncipherment'];
      default:
        return ['digitalSignature'];
    }
  }

  private buildKeyUsageFlags(usages: string[]): number {
    let flags = 0;
    for (const u of usages) {
      if (KEY_USAGE_MAP[u]) flags |= KEY_USAGE_MAP[u];
    }
    return flags || x509.KeyUsageFlags.digitalSignature;
  }

  private getExtKeyUsageStrings(certType: string): string[] {
    switch (certType) {
      case 'tls-server':
        return ['serverAuth'];
      case 'tls-client':
        return ['clientAuth'];
      case 'code-signing':
        return ['codeSigning'];
      case 'email':
        return ['emailProtection'];
      default:
        return [];
    }
  }

  private static readonly EXT_KEY_USAGE_OID_MAP: Record<string, string> = {
    serverAuth: '1.3.6.1.5.5.7.3.1',
    clientAuth: '1.3.6.1.5.5.7.3.2',
    codeSigning: '1.3.6.1.5.5.7.3.3',
    emailProtection: '1.3.6.1.5.5.7.3.4',
    timeStamping: '1.3.6.1.5.5.7.3.8',
    ocspSigning: '1.3.6.1.5.5.7.3.9',
  };

  /** Resolve ext key usage names to OIDs, pass through raw OIDs */
  private resolveExtKeyUsageOids(usages: string[]): string[] {
    return usages.map((u) => CertService.EXT_KEY_USAGE_OID_MAP[u] || u);
  }

  // -----------------------------------------------------------------------
  // Subject DN helpers
  // -----------------------------------------------------------------------

  private buildSubjectDn(
    commonName: string,
    inputFields?: { o?: string; ou?: string; l?: string; st?: string; c?: string },
    templateFields?: Record<string, string>
  ): string {
    // Merge: input overrides template defaults
    const merged = { ...templateFields, ...inputFields };
    const parts = [`CN=${commonName}`];
    if (merged.o) parts.push(`O=${merged.o}`);
    if (merged.ou) parts.push(`OU=${merged.ou}`);
    if (merged.l) parts.push(`L=${merged.l}`);
    if (merged.st) parts.push(`ST=${merged.st}`);
    if (merged.c) parts.push(`C=${merged.c}`);
    return parts.join(', ');
  }

  // -----------------------------------------------------------------------
  // Template extension helpers
  // -----------------------------------------------------------------------

  private addDistributionExtensions(
    extensions: x509.Extension[],
    template: { crlDistributionPoints?: unknown; authorityInfoAccess?: unknown } | null,
    ca: { crlDistributionUrl?: string | null; ocspResponderUrl?: string | null; caIssuersUrl?: string | null }
  ) {
    // CRL Distribution Points: template overrides CA
    const crlUrls = (template?.crlDistributionPoints as string[] | undefined)?.length
      ? (template!.crlDistributionPoints as string[])
      : ca.crlDistributionUrl
        ? [ca.crlDistributionUrl]
        : [];

    if (crlUrls.length > 0) {
      try {
        extensions.push(new x509.CRLDistributionPointsExtension(crlUrls, false));
      } catch (err) {
        logger.warn('Failed to add CRL Distribution Points extension', { err });
      }
    }

    // Authority Info Access: merge template + CA
    const aia = template?.authorityInfoAccess as { caIssuersUrl?: string } | undefined;
    const caIssuersUrl = aia?.caIssuersUrl || ca.caIssuersUrl || null;

    if (caIssuersUrl) {
      try {
        const params: { caIssuers?: string[] } = {};
        if (caIssuersUrl) params.caIssuers = [caIssuersUrl];
        extensions.push(new x509.AuthorityInfoAccessExtension(params, false));
      } catch (err) {
        logger.warn('Failed to add AIA extension', { err });
      }
    }
  }

  private addPolicyExtensions(extensions: x509.Extension[], template: { certificatePolicies?: unknown } | null) {
    const policies = template?.certificatePolicies as { oid: string; qualifier?: string }[] | undefined;
    if (!policies?.length) return;

    try {
      const oids = policies.map((p) => p.oid);
      extensions.push(new x509.CertificatePolicyExtension(oids, false));
    } catch (err) {
      logger.warn('Failed to add Certificate Policies extension', { err });
    }
  }

  private addCustomExtensions(extensions: x509.Extension[], template: { customExtensions?: unknown } | null) {
    const custom = template?.customExtensions as { oid: string; critical: boolean; value: string }[] | undefined;
    if (!custom?.length) return;

    for (const ext of custom) {
      try {
        const derBytes = Buffer.from(ext.value, 'hex');
        extensions.push(new x509.Extension(ext.oid, ext.critical, derBytes));
      } catch (err) {
        logger.warn('Failed to add custom extension', { oid: ext.oid, err });
      }
    }
  }

  private buildSANs(sans: string[]): x509.JsonGeneralNames {
    const entries: x509.JsonGeneralNames = [];
    for (const san of sans) {
      if (san.includes('@')) {
        entries.push({ type: 'email', value: san });
      } else if (/^[\d.]+$/.test(san) || san.includes(':')) {
        entries.push({ type: 'ip', value: san });
      } else if (san.startsWith('http://') || san.startsWith('https://')) {
        entries.push({ type: 'url', value: san });
      } else {
        entries.push({ type: 'dns', value: san });
      }
    }
    return entries;
  }

  private pemToBuffer(pem: string, label: string): ArrayBuffer {
    const base64 = pem.replace(`-----BEGIN ${label}-----`, '').replace(`-----END ${label}-----`, '').replace(/\s/g, '');
    const binary = Buffer.from(base64, 'base64');
    return binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength);
  }
}
