import * as acme from 'acme-client';
import { createChildLogger } from '@/lib/logger.js';
import { x509 } from '@/lib/x509.js';
import { AppError } from '@/middleware/error-handler.js';

const logger = createChildLogger('ACMEService');

export function dns01RecordNameForDomain(domain: string): string {
  const normalized = domain.startsWith('*.') ? domain.slice(2) : domain;
  return `_acme-challenge.${normalized}`;
}

/**
 * The local check that a challenge is in place before the CA is asked to validate it. acme-client retries it for about
 * three minutes by default, which held the request open that long for a name the CA can never reach.
 */
const SELF_CHECK_BACKOFF = { backoffAttempts: 3, backoffMin: 2000, backoffMax: 4000 } as const;
const SELF_CHECK_TIMEOUT_MS = 30_000;

type ChallengeCheckArgs = Parameters<acme.Client['verifyChallenge']>;

export interface ACMEServiceOptions {
  /** ACME directory used instead of Let's Encrypt (production or staging), e.g. a test CA. */
  directoryUrl?: string;
}

export class ACMEService {
  constructor(private readonly options: ACMEServiceOptions = {}) {}

  /** Set by bootstrap to resolve and deploy HTTP-01 challenges through Domain ingress affinity. */
  onHttp01Preflight?: (domains: string[]) => Promise<void>;
  onChallengeCreate?: (token: string, content: string, domain: string) => Promise<void>;
  onChallengeRemove?: (token: string, domain: string) => Promise<void>;

  private getAcmeEmail(contactEmail?: string): string {
    const email = contactEmail?.trim();
    if (!email) {
      throw new AppError(
        400,
        'ACME_CONTACT_EMAIL_MISSING',
        'A contact email is required for ACME certificate issuance'
      );
    }
    return email;
  }

  private async createAccount(client: acme.Client, contactEmail?: string): Promise<void> {
    const email = this.getAcmeEmail(contactEmail);
    try {
      await client.createAccount({
        termsOfServiceAgreed: true,
        contact: [`mailto:${email}`],
      });
    } catch (error) {
      const providerMessage = error instanceof Error ? error.message : 'Unknown ACME provider error';
      throw new AppError(
        400,
        'ACME_CONTACT_EMAIL_REJECTED',
        `ACME provider rejected contact email "${email}": ${providerMessage}`
      );
    }
  }

  /**
   * Request a certificate via HTTP-01 challenge (fully automatic).
   */
  requestCertHTTP01(...args: Parameters<ACMEService['orderHTTP01']>): ReturnType<ACMEService['orderHTTP01']> {
    return this.issuing(args[0], () => this.orderHTTP01(...args));
  }

  /**
   * Start DNS-01 challenge — returns records user must create.
   * Does NOT verify yet; user must create TXT records first.
   */
  requestCertDNS01Start(...args: Parameters<ACMEService['startDNS01']>): ReturnType<ACMEService['startDNS01']> {
    return this.issuing(args[0], () => this.startDNS01(...args));
  }

  /**
   * Complete DNS-01 challenge after user creates TXT records.
   */
  requestCertDNS01Verify(...args: Parameters<ACMEService['completeDNS01']>): ReturnType<ACMEService['completeDNS01']> {
    return this.issuing(args[2], () => this.completeDNS01(...args));
  }

  private async orderHTTP01(
    domains: string[],
    staging?: boolean,
    contactEmail?: string,
    /** Reuses this ACME account instead of registering a new one (repeated orders stay within account limits). */
    accountKeyPem?: string
  ): Promise<{
    certificatePem: string;
    privateKeyPem: string;
    chainPem: string;
    notBefore: Date;
    notAfter: Date;
    accountKey: string;
  }> {
    logger.info('Requesting ACME cert via HTTP-01', { domains });

    await this.onHttp01Preflight?.(domains);

    // 1. Create account key
    const accountKey = accountKeyPem ? Buffer.from(accountKeyPem) : await acme.crypto.createPrivateKey();

    // 2. Create ACME client
    const client = new acme.Client({
      directoryUrl: this.getDirectoryUrl(staging),
      accountKey,
    });

    await this.createAccount(client, contactEmail);

    // 3. Create order
    const order = await client.createOrder({
      identifiers: domains.map((d) => ({ type: 'dns' as const, value: d })),
    });

    // 4. Process authorizations
    const authorizations = await client.getAuthorizations(order);
    const challengeCleanups: string[] = [];

    try {
      for (const authz of authorizations) {
        const challenge = authz.challenges.find((c) => c.type === 'http-01');
        if (!challenge) {
          throw new Error(`No HTTP-01 challenge found for ${authz.identifier.value}`);
        }

        // 5. Write challenge token
        const keyAuthorization = await client.getChallengeKeyAuthorization(challenge);

        if (!/^[A-Za-z0-9_-]+$/.test(challenge.token)) {
          throw new Error('Invalid ACME challenge token format');
        }

        // Challenge file is deployed to nginx node via the daemon
        // The caller (SSLService) must deploy the challenge before calling this method
        // or pass a challengeCreateFn. For now, we use a callback if provided.
        if (this.onChallengeCreate) {
          await this.onChallengeCreate(challenge.token, keyAuthorization, authz.identifier.value);
          challengeCleanups.push(challenge.token);
        }

        logger.debug('Challenge token written', { domain: authz.identifier.value, token: challenge.token });

        // 6. Verify and complete challenge
        await this.selfCheck(accountKey, staging, authz, challenge);
        await client.completeChallenge(challenge);
        await client.waitForValidStatus(challenge);
      }

      // 7. Finalize order with CSR
      const [key, csr] = await acme.crypto.createCsr({
        commonName: domains[0],
        altNames: domains,
      });

      const finalized = await client.finalizeOrder(order, csr);
      const certPem = await client.getCertificate(finalized);

      // 8. Parse certificate to extract dates
      const { notBefore, notAfter } = this.parseCertDates(certPem);

      // 9. Split cert and chain
      const { certificate, chain } = this.splitCertChain(certPem);

      logger.info('ACME HTTP-01 certificate obtained', { domains, notAfter });

      return {
        certificatePem: certificate,
        privateKeyPem: key.toString(),
        chainPem: chain,
        notBefore,
        notAfter,
        accountKey: accountKey.toString(),
      };
    } finally {
      // 10. Clean up challenge tokens via daemon
      for (const token of challengeCleanups) {
        try {
          if (this.onChallengeRemove) {
            const authorization = authorizations.find((authz) =>
              authz.challenges.some((challenge) => challenge.type === 'http-01' && challenge.token === token)
            );
            await this.onChallengeRemove(token, authorization?.identifier.value ?? domains[0]!);
          }
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  private async startDNS01(
    domains: string[],
    staging?: boolean,
    contactEmail?: string
  ): Promise<{
    accountKey: string;
    orderUrl: string;
    challenges: Array<{
      domain: string;
      recordName: string;
      recordValue: string;
    }>;
  }> {
    logger.info('Starting ACME DNS-01 challenge', { domains });

    // 1. Create account key
    const accountKey = await acme.crypto.createPrivateKey();

    // 2. Create ACME client
    const client = new acme.Client({
      directoryUrl: this.getDirectoryUrl(staging),
      accountKey,
    });

    await this.createAccount(client, contactEmail);

    // 3. Create order
    const order = await client.createOrder({
      identifiers: domains.map((d) => ({ type: 'dns' as const, value: d })),
    });

    // 4. Get DNS-01 challenges
    const authorizations = await client.getAuthorizations(order);
    const challenges: Array<{
      domain: string;
      recordName: string;
      recordValue: string;
    }> = [];

    for (const authz of authorizations) {
      const challenge = authz.challenges.find((c) => c.type === 'dns-01');
      if (!challenge) {
        throw new Error(`No DNS-01 challenge found for ${authz.identifier.value}`);
      }

      const keyAuthorization = await client.getChallengeKeyAuthorization(challenge);

      challenges.push({
        domain: authz.identifier.value,
        recordName: dns01RecordNameForDomain(authz.identifier.value),
        recordValue: keyAuthorization,
      });
    }

    logger.info('DNS-01 challenges prepared', { domains, challengeCount: challenges.length });

    return {
      accountKey: accountKey.toString(),
      orderUrl: order.url,
      challenges,
    };
  }

  private async completeDNS01(
    accountKeyPem: string,
    orderUrl: string,
    domains: string[],
    staging?: boolean,
    contactEmail?: string
  ): Promise<{
    certificatePem: string;
    privateKeyPem: string;
    chainPem: string;
    notBefore: Date;
    notAfter: Date;
  }> {
    logger.info('Completing ACME DNS-01 verification', { domains });

    // 1. Recreate ACME client with saved account key
    const accountKey = Buffer.from(accountKeyPem);
    const client = new acme.Client({
      directoryUrl: this.getDirectoryUrl(staging),
      accountKey,
    });

    await this.createAccount(client, contactEmail);

    // 2. Get existing order
    const order = await client.getOrder({ url: orderUrl } as any);

    // 3. Verify challenges
    const authorizations = await client.getAuthorizations(order);

    for (const authz of authorizations) {
      const challenge = authz.challenges.find((c) => c.type === 'dns-01');
      if (!challenge) {
        throw new Error(`No DNS-01 challenge found for ${authz.identifier.value}`);
      }

      await this.selfCheck(accountKey, staging, authz, challenge);
      await client.completeChallenge(challenge);
      await client.waitForValidStatus(challenge);
    }

    // 4. Finalize order with CSR
    const [key, csr] = await acme.crypto.createCsr({
      commonName: domains[0],
      altNames: domains,
    });

    const finalized = await client.finalizeOrder(order, csr);
    const certPem = await client.getCertificate(finalized);

    // 5. Parse certificate dates
    const { notBefore, notAfter } = this.parseCertDates(certPem);

    // 6. Split cert and chain
    const { certificate, chain } = this.splitCertChain(certPem);

    logger.info('ACME DNS-01 certificate obtained', { domains, notAfter });

    return {
      certificatePem: certificate,
      privateKeyPem: key.toString(),
      chainPem: chain,
      notBefore,
      notAfter,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Errors of the CA or of the challenge flow reach the caller with a code and the reason, not as a bare 500. */
  private async issuing<T>(domains: string[], run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AppError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn('ACME certificate request failed', { domains, error: reason });
      throw new AppError(
        400,
        'ACME_ISSUANCE_FAILED',
        `Certificate for ${domains.join(', ')} was not issued: ${reason}`
      );
    }
  }

  /** Checks the challenge is in place, as the CA will see it, within a short budget. */
  private async selfCheck(
    accountKey: Buffer,
    staging: boolean | undefined,
    authz: ChallengeCheckArgs[0],
    challenge: ChallengeCheckArgs[1]
  ): Promise<void> {
    const checker = new acme.Client({ directoryUrl: this.getDirectoryUrl(staging), accountKey, ...SELF_CHECK_BACKOFF });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        checker.verifyChallenge(authz, challenge),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`no answer within ${SELF_CHECK_TIMEOUT_MS / 1000} s`)),
            SELF_CHECK_TIMEOUT_MS
          );
        }),
      ]);
    } catch (error) {
      const name = authz.identifier.value;
      const reason = error instanceof Error ? error.message : String(error);
      throw new AppError(
        400,
        'ACME_CHALLENGE_NOT_REACHABLE',
        challenge.type === 'dns-01'
          ? `The TXT record ${dns01RecordNameForDomain(name)} is not visible yet: ${reason}`
          : `${name} does not serve its ACME challenge at http://${name}/.well-known/acme-challenge/ (${reason}). The name must resolve to a public address of an ingress node that answers on port 80.`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private getDirectoryUrl(staging?: boolean): string {
    if (this.options.directoryUrl) return this.options.directoryUrl;
    return staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production;
  }

  /**
   * Parse notBefore/notAfter from a PEM certificate using @peculiar/x509.
   */
  private parseCertDates(certPem: string): { notBefore: Date; notAfter: Date } {
    // Extract the first certificate from the PEM bundle
    const match = certPem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/);
    if (!match) {
      throw new Error('Failed to parse certificate PEM');
    }

    const cert = new x509.X509Certificate(match[0]);
    return {
      notBefore: cert.notBefore,
      notAfter: cert.notAfter,
    };
  }

  /**
   * Split a full-chain PEM into the leaf certificate and the chain.
   */
  private splitCertChain(fullChainPem: string): { certificate: string; chain: string } {
    const certs = fullChainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (!certs || certs.length === 0) {
      throw new Error('No certificates found in PEM');
    }

    const certificate = certs[0];
    const chain = certs.slice(1).join('\n');

    return { certificate, chain };
  }
}
