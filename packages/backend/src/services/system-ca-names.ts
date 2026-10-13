import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { certificateAuthorities } from '@/db/schema/index.js';

export type SystemCaPurpose = 'node-mtls' | 'database-tls' | 'storage-tls';

/**
 * Names of the system CAs. A new installation issues its CAs with these common names. An existing CA keeps its
 * certificate (and subject) untouched: renaming it would mean a new CA every node, relay and client must trust anew.
 * Only the name shown in the UI changes.
 */
export const SYSTEM_CA_COMMON_NAMES: Readonly<Record<SystemCaPurpose, string>> = {
  'node-mtls': 'Opfield Node CA',
  'database-tls': 'Opfield Database CA',
  'storage-tls': 'Opfield Storage CA',
};

// legacy-name: the common names of system CAs created before 2.12.1; their certificates keep them (owner decision:
// existing CAs are not rotated), so this list stays as long as such a CA may be in use.
const LEGACY_SYSTEM_CA_COMMON_NAMES: Readonly<Record<SystemCaPurpose, string>> = {
  'node-mtls': 'Gateway Node CA',
  'database-tls': 'Gateway Database CA',
  'storage-tls': 'Gateway Storage CA',
};

/** Shows a system CA made before 2.12.1 under its Opfield name. Idempotent; a renamed CA is left alone. */
export async function renameLegacySystemCa(db: DrizzleClient, id: string, purpose: SystemCaPurpose): Promise<void> {
  await db
    .update(certificateAuthorities)
    .set({ commonName: SYSTEM_CA_COMMON_NAMES[purpose] })
    .where(
      and(
        eq(certificateAuthorities.id, id),
        eq(certificateAuthorities.commonName, LEGACY_SYSTEM_CA_COMMON_NAMES[purpose])
      )
    );
}
