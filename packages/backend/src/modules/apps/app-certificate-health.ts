import { inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { sslCertificates } from '@/db/schema/index.js';
import { getEnvironmentSettingsSnapshot } from '@/modules/settings/environment-settings.service.js';
import type { AppHealth } from './apps.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WARNING_DAYS = 14;

/** A certificate member's state; `reason` says why it is not healthy. */
export interface CertificateMemberHealth {
  health: AppHealth | 'none';
  reason?: string;
}

export interface CertificateHealthRow {
  status: string | null;
  notAfter: Date | null;
  renewalFailureCount: number | null;
}

/**
 * A TLS certificate member: expired (or never issued after an error) fails; a failed renewal, an expiry within the
 * warning window (Settings, PKI expiry warning days) or an issuance still pending degrades it; else healthy.
 */
export function certificateMemberHealth(
  cert: CertificateHealthRow | null | undefined,
  warningDays: number,
  now = Date.now()
): CertificateMemberHealth {
  if (!cert) return { health: 'none' };
  const expiresAt = cert.notAfter?.getTime() ?? null;
  if (cert.status === 'expired' || (expiresAt !== null && expiresAt <= now)) {
    return { health: 'failing', reason: 'The certificate expired' };
  }
  if (cert.status === 'error' && expiresAt === null) return { health: 'failing', reason: 'Issuing it failed' };
  if (cert.status === 'pending') return { health: 'degraded', reason: 'Not issued yet' };
  if ((cert.renewalFailureCount ?? 0) > 0 || cert.status === 'error') {
    return { health: 'degraded', reason: 'Its renewal failed' };
  }
  if (expiresAt !== null && expiresAt - now <= warningDays * DAY_MS) {
    const days = Math.max(0, Math.ceil((expiresAt - now) / DAY_MS));
    return { health: 'degraded', reason: `It expires in ${days} ${days === 1 ? 'day' : 'days'}` };
  }
  return { health: 'healthy' };
}

function warningWindowDays(): number {
  try {
    return getEnvironmentSettingsSnapshot().pkiDefaults.expiryWarningDays ?? DEFAULT_WARNING_DAYS;
  } catch {
    return DEFAULT_WARNING_DAYS;
  }
}

/** Health of certificate members by certificate id, in one query (kept apart from the member health of workloads). */
export async function certificateMemberHealths(
  db: DrizzleClient,
  certificateIds: readonly string[],
  now = Date.now()
): Promise<Map<string, CertificateMemberHealth>> {
  const ids = [...new Set(certificateIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: sslCertificates.id,
      status: sslCertificates.status,
      notAfter: sslCertificates.notAfter,
      renewalFailureCount: sslCertificates.renewalFailureCount,
    })
    .from(sslCertificates)
    .where(inArray(sslCertificates.id, ids));
  const warningDays = warningWindowDays();
  return new Map(rows.map((row) => [row.id, certificateMemberHealth(row, warningDays, now)]));
}
