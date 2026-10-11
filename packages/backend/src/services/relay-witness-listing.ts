import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  managedAvailabilitySets,
  managedAvailabilityWitnesses,
  managedDatabaseInstances,
  managedStorageClusters,
} from '@/db/schema/index.js';

/** One availability witness a relay hosts, as the relay list shows it. */
export interface RelayWitnessListing {
  id: string;
  setId: string;
  ownerKind: string;
  ownerId: string;
  /** The database or storage the set belongs to. */
  ownerName: string | null;
  /** lease: a lease voter (no process); keeper: a ClickHouse Keeper witness process. */
  kind: string;
  /** active | standby */
  role: string;
  /** running | standby | removed: what Gateway wants. */
  desiredState: string;
  /** What the relay reported (fetching, staged, running, error, refused, …), else Gateway's status (pending, ready, error). */
  state: string;
  version: string | null;
  error: string | null;
}

/** The availability witnesses on each relay (removed ones left out), keyed by relay instance id. */
export async function listRelayWitnesses(db: DrizzleClient): Promise<Map<string, RelayWitnessListing[]>> {
  const rows = await db
    .select({
      id: managedAvailabilityWitnesses.id,
      relayInstanceId: managedAvailabilityWitnesses.relayInstanceId,
      setId: managedAvailabilityWitnesses.setId,
      ownerKind: managedAvailabilitySets.ownerKind,
      ownerId: managedAvailabilitySets.ownerId,
      purpose: managedAvailabilityWitnesses.purpose,
      role: managedAvailabilityWitnesses.role,
      desiredState: managedAvailabilityWitnesses.desiredState,
      status: managedAvailabilityWitnesses.status,
      observedState: managedAvailabilityWitnesses.observedState,
      version: managedAvailabilityWitnesses.artifactVersion,
      lastError: managedAvailabilityWitnesses.lastError,
    })
    .from(managedAvailabilityWitnesses)
    .innerJoin(managedAvailabilitySets, eq(managedAvailabilitySets.id, managedAvailabilityWitnesses.setId))
    .where(
      and(
        isNotNull(managedAvailabilityWitnesses.relayInstanceId),
        ne(managedAvailabilityWitnesses.desiredState, 'removed')
      )
    );
  if (rows.length === 0) return new Map();
  const databaseIds = rows.filter((row) => row.ownerKind === 'managed_database').map((row) => row.ownerId);
  const storageIds = rows.filter((row) => row.ownerKind === 'managed_storage').map((row) => row.ownerId);
  const names = new Map<string, string>();
  if (databaseIds.length > 0) {
    const databases = await db
      .select({ id: managedDatabaseInstances.id, name: managedDatabaseInstances.name })
      .from(managedDatabaseInstances)
      .where(inArray(managedDatabaseInstances.id, databaseIds));
    for (const row of databases) names.set(row.id, row.name);
  }
  if (storageIds.length > 0) {
    const storages = await db
      .select({ id: managedStorageClusters.id, name: managedStorageClusters.name })
      .from(managedStorageClusters)
      .where(inArray(managedStorageClusters.id, storageIds));
    for (const row of storages) names.set(row.id, row.name);
  }
  const byRelay = new Map<string, RelayWitnessListing[]>();
  for (const row of rows) {
    if (!row.relayInstanceId) continue;
    const list = byRelay.get(row.relayInstanceId) ?? [];
    list.push({
      id: row.id,
      setId: row.setId,
      ownerKind: row.ownerKind,
      ownerId: row.ownerId,
      ownerName: names.get(row.ownerId) ?? null,
      kind: row.purpose,
      role: row.role,
      desiredState: row.desiredState,
      state: row.observedState ?? row.status,
      version: row.version,
      error: row.lastError,
    });
    byRelay.set(row.relayInstanceId, list);
  }
  return byRelay;
}
