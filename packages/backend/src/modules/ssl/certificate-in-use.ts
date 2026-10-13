import { AppError } from '@/middleware/error-handler.js';

/** `proxy_hosts.ssl_certificate_id` references its certificate with ON DELETE RESTRICT. */
export const PROXY_HOST_SSL_CERTIFICATE_FK = 'proxy_hosts_ssl_certificate_id_ssl_certificates_id_fk';

/**
 * A certificate a proxy host still names cannot be deleted: the database
 * refuses it (restrict_violation, or foreign_key_violation from an older
 * NO ACTION constraint), including for a host assigned after the service's
 * own reference check. Maps that refusal to the same 409 as the check; any
 * other error is rethrown unchanged.
 */
export function rethrowCertificateInUse(error: unknown): never {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 6 && current && typeof current === 'object' && !seen.has(current); depth += 1) {
    seen.add(current);
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (
      (candidate.code === '23001' || candidate.code === '23503') &&
      candidate.constraint === PROXY_HOST_SSL_CERTIFICATE_FK
    ) {
      throw new AppError(409, 'CERT_IN_USE', 'Certificate is in use by routes');
    }
    current = candidate.cause;
  }
  throw error;
}
