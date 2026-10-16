import { and, eq } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { certificateAuthorities, certificates, pkiRevokedSerials } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { CacheService } from '@/services/cache.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { CAService } from './ca.service.js';

const logger = createChildLogger('OCSPService');

// OCSP is disabled by design: issued certificates name no OCSP responder (CRL distribution points only) and a CA
// refuses an OCSP URL (OCSP_DISABLED). The expected state, not a fault: stated once per start, at info.
logger.info('OCSP responder is disabled; certificates rely on CRLs and OCSP requests are answered INTERNAL_ERROR');

const OCSP_CACHE_PREFIX = 'ocsp:';

// OCSP response status codes
const OCSP_RESPONSE_STATUS = {
  SUCCESSFUL: 0,
  MALFORMED_REQUEST: 1,
  INTERNAL_ERROR: 2,
  UNAUTHORIZED: 6,
} as const;

@injectable()
export class OCSPService {
  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly cryptoService: CryptoService,
    private readonly caService: CAService,
    private readonly cacheService: CacheService
  ) {}

  /**
   * Handle an OCSP request. For now, returns a basic signed OCSP response.
   * Full ASN.1 OCSP parsing/building would use @peculiar/asn1-ocsp.
   * This is a simplified implementation that responds with the certificate status.
   */
  async handleOCSPRequest(caId: string, _requestBody: Buffer): Promise<Buffer> {
    try {
      // For a full implementation, we'd parse the OCSP request using @peculiar/asn1-ocsp
      // and extract the serial number being queried. For now, return a basic response
      // indicating the service is available.

      // This is a placeholder that returns a minimal OCSP response
      // A full implementation would:
      // 1. Parse OCSPRequest ASN.1 structure
      // 2. Extract CertID (serial number)
      // 3. Look up certificate status
      // 4. Build and sign OCSPResponse

      logger.debug('OCSP request answered INTERNAL_ERROR: the OCSP responder is disabled', { caId });

      // Return a "tryLater" response for now
      return this.buildMinimalOCSPResponse(OCSP_RESPONSE_STATUS.INTERNAL_ERROR);
    } catch (error) {
      logger.error('OCSP request handling failed', { caId, error });
      return this.buildMinimalOCSPResponse(OCSP_RESPONSE_STATUS.INTERNAL_ERROR);
    }
  }

  /**
   * Check certificate status by serial number (used for API-based status checks).
   */
  async getCertificateStatus(
    caId: string,
    serialNumber: string
  ): Promise<{
    status: 'good' | 'revoked' | 'unknown';
    revokedAt?: Date;
    revocationReason?: string;
  }> {
    const cert = await this.db.query.certificates.findFirst({
      where: and(eq(certificates.caId, caId), eq(certificates.serialNumber, serialNumber)),
    });

    if (!cert) {
      // A revoked certificate deleted before it expired is still revoked (pki-revoked-serials.ts).
      const [deleted] = await this.db
        .select()
        .from(pkiRevokedSerials)
        .where(and(eq(pkiRevokedSerials.caId, caId), eq(pkiRevokedSerials.serialNumber, serialNumber)))
        .limit(1);
      if (deleted) {
        return {
          status: 'revoked',
          revokedAt: deleted.revokedAt,
          revocationReason: deleted.revocationReason || undefined,
        };
      }
      return { status: 'unknown' };
    }

    if (cert.status === 'revoked') {
      return {
        status: 'revoked',
        revokedAt: cert.revokedAt || undefined,
        revocationReason: cert.revocationReason || undefined,
      };
    }

    if (cert.status === 'expired' || cert.notAfter < new Date()) {
      return { status: 'revoked', revokedAt: cert.notAfter, revocationReason: 'expired' };
    }

    return { status: 'good' };
  }

  async generateOCSPResponderCert(caId: string): Promise<void> {
    // Generate a delegated OCSP signing certificate for the CA
    // This cert is used to sign OCSP responses without exposing the CA key
    const { ca } = await this.caService.getCASigningMaterials(caId);

    const { privateKeyPem } = this.cryptoService.generateKeyPair(ca.keyAlgorithm);

    const notAfter = new Date();
    notAfter.setFullYear(notAfter.getFullYear() + 1); // OCSP responder cert valid for 1 year

    // Encrypt OCSP responder key
    const encrypted = this.cryptoService.encryptPrivateKey(privateKeyPem);

    // TODO: Build OCSP responder certificate with id-kp-OCSPSigning EKU
    // For now, store the key material
    await this.db
      .update(certificateAuthorities)
      .set({
        encryptedOcspKey: encrypted.encryptedPrivateKey,
        encryptedOcspDek: encrypted.encryptedDek,
        ocspDekIv: encrypted.dekIv,
        updatedAt: new Date(),
      })
      .where(eq(certificateAuthorities.id, caId));

    logger.info('Generated OCSP responder key material', { caId });
  }

  async invalidateCache(caId: string, serialNumber: string): Promise<void> {
    await this.cacheService.delete(`${OCSP_CACHE_PREFIX}${caId}:${serialNumber}`);
  }

  private buildMinimalOCSPResponse(status: number): Buffer {
    // Build a minimal OCSPResponse with just the responseStatus
    // OCSPResponse ::= SEQUENCE { responseStatus ENUMERATED }
    const statusByte = Buffer.from([status]);
    const enumerated = Buffer.concat([
      Buffer.from([0x0a, 0x01]), // ENUMERATED tag + length 1
      statusByte,
    ]);
    const sequence = Buffer.concat([
      Buffer.from([0x30, enumerated.length]), // SEQUENCE tag + length
      enumerated,
    ]);
    return sequence;
  }
}
