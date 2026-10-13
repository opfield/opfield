import { createPrivateKey, X509Certificate } from 'node:crypto';
import {
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  X509Certificate as PeculiarX509Certificate,
} from '@peculiar/x509';

/**
 * Gateway's own TLS leaves (the gRPC and web listeners and the local relay service identities)
 * are issued for 365 days and renewed this long before they expire: at start-up, and while
 * Gateway runs by OpfieldIdentityRenewalService, which also hot-reloads them.
 */
export const OPFIELD_IDENTITY_RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The gRPC listener certificate's last week. Enrollment commands pin its fingerprint and stay
 * valid for up to seven days, so start-up renews it only this late, and running renewal waits
 * until this point while enrollment tokens are outstanding.
 */
export const OPFIELD_GRPC_CERTIFICATE_FINAL_RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;

export function validateGrpcServerCertificate(
  certificatePem: string | Buffer,
  privateKeyPem: string | Buffer,
  caPem: string | null | undefined
): void {
  if (!caPem) {
    throw new Error('Opfield system CA certificate is unavailable');
  }

  try {
    const cert = new X509Certificate(certificatePem);
    const ca = new X509Certificate(caPem);
    if (!cert.checkIssued(ca) || !cert.verify(ca.publicKey)) {
      throw new Error('certificate is not signed by the Opfield system CA');
    }
    if (!cert.checkPrivateKey(createPrivateKey(privateKeyPem))) {
      throw new Error('private key does not match certificate');
    }
    const parsedCert = new PeculiarX509Certificate(certificatePem.toString());
    const basicConstraints = parsedCert.getExtension(BasicConstraintsExtension);
    if (cert.ca || basicConstraints?.ca) {
      throw new Error('certificate must be an end-entity TLS server certificate');
    }
    const extKeyUsage = parsedCert.getExtension(ExtendedKeyUsageExtension);
    if (!extKeyUsage?.usages.includes(ExtendedKeyUsage.serverAuth)) {
      throw new Error('certificate must allow TLS server authentication');
    }

    const now = Date.now();
    const validFrom = Date.parse(cert.validFrom);
    const validTo = Date.parse(cert.validTo);
    if (Number.isFinite(validFrom) && now < validFrom) {
      throw new Error('certificate is not valid yet');
    }
    if (Number.isFinite(validTo) && now > validTo) {
      throw new Error('certificate is expired');
    }
  } catch (error) {
    throw new Error(`Invalid gRPC TLS certificate: ${(error as Error).message}`);
  }
}
