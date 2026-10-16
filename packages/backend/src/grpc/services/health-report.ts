import type {
  NodeManagedLinkReport,
  NodeRelayStreamReport,
  NodeUpdateConnectionResult,
  NodeUpdateConnectionsReport,
} from '@/db/schema/nodes.js';

const managedStorageRootFilesystem = 'gateway-managed-storage-root';

type DecodedHealthDiskMount = {
  mountPoint: string;
  filesystem: string;
  device: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usagePercent: number;
  /** What the mount holds (root, docker_root, opfield_state, managed_image, data); absent from older daemons. */
  role?: string;
};

type ManagedStorageCapacity = {
  storageRoot: string;
  availableBytes: number;
  /**
   * The disk's space promised to managed instances (what they use, what their images may still take, and the reserve)
   * as a share of its size: over 100 while the disk is oversubscribed. Absent from daemons before 2.12.3, which cap it
   * at 100.
   */
  promisedPercent?: number;
};

export function decodeHealthDiskMounts(rawMounts: unknown): {
  diskMounts: DecodedHealthDiskMount[];
  managedStorageCapacity?: ManagedStorageCapacity;
} {
  const diskMounts: DecodedHealthDiskMount[] = [];
  let managedStorageCapacity: ManagedStorageCapacity | undefined;

  for (const mount of Array.isArray(rawMounts) ? rawMounts : []) {
    const value = mount as Record<string, unknown>;
    const mountPoint = typeof value.mountPoint === 'string' ? value.mountPoint : '';
    const filesystem = typeof value.filesystem === 'string' ? value.filesystem : '';
    if (filesystem === managedStorageRootFilesystem) {
      const availableBytes = Number(value.freeBytes ?? 0);
      if (!managedStorageCapacity && mountPoint && Number.isFinite(availableBytes) && availableBytes >= 0) {
        const promisedPercent = Number(value.usagePercent ?? Number.NaN);
        managedStorageCapacity = {
          storageRoot: mountPoint,
          availableBytes,
          ...(Number.isFinite(promisedPercent) && Number(value.totalBytes ?? 0) > 0 ? { promisedPercent } : {}),
        };
      }
      continue;
    }
    const role = typeof value.role === 'string' ? value.role : '';
    diskMounts.push({
      mountPoint,
      filesystem,
      device: typeof value.device === 'string' ? value.device : '',
      totalBytes: Number(value.totalBytes ?? 0),
      usedBytes: Number(value.usedBytes ?? 0),
      freeBytes: Number(value.freeBytes ?? 0),
      usagePercent: Number(value.usagePercent ?? 0),
      ...(role ? { role } : {}),
    });
  }

  return managedStorageCapacity ? { diskMounts, managedStorageCapacity } : { diskMounts };
}

/**
 * Relay round trips of a daemon health report, in milliseconds; 0 (unknown) for a relay the daemon
 * has failed to reach for longer than it keeps a round trip. Absent when the daemon measured none,
 * so reports of nodes without relays keep their shape.
 */
export function relayLatencyHealth(rawSamples: unknown): {
  relayLatencies?: Array<{ relayInstanceId: string; rttMs: number; failingMs?: number }>;
} {
  const relayLatencies = (Array.isArray(rawSamples) ? rawSamples : []).flatMap((sample) => {
    const relayInstanceId = (sample as { relayInstanceId?: unknown })?.relayInstanceId;
    const micros = Number((sample as { rttMicros?: unknown })?.rttMicros ?? 0);
    // How long the daemon has failed to reach the relay (daemons that report it); absent while it reaches it.
    const failingMs = Number((sample as { failingMs?: unknown })?.failingMs ?? 0);
    const failing = Number.isFinite(failingMs) && failingMs > 0;
    const measured = Number.isFinite(micros) && micros > 0;
    // A relay the daemon keeps failing to reach has no recent round trip (0, unknown): it is still reported.
    if (typeof relayInstanceId !== 'string' || !relayInstanceId || (!measured && !failing)) return [];
    return [
      {
        relayInstanceId,
        rttMs: measured ? Math.round(micros) / 1000 : 0,
        ...(failing ? { failingMs: Math.trunc(failingMs) } : {}),
      },
    ];
  });
  return relayLatencies.length ? { relayLatencies } : {};
}

// Container links too: dropping them made their runtime show zero connections, sessions and bytes over the relay's.
const MANAGED_LINK_OWNER_KINDS = new Set(['managed_database_binding', 'managed_storage_binding', 'container_link']);

/**
 * The managed links of a docker daemon health report (managed_link_runtime_v1). Absent when the node reported none,
 * so reports of other nodes keep their shape.
 */
export function managedLinkHealth(rawLinks: unknown): { managedLinks?: NodeManagedLinkReport[] } {
  const managedLinks = (Array.isArray(rawLinks) ? rawLinks : []).flatMap((raw): NodeManagedLinkReport[] => {
    const value = (raw ?? {}) as Record<string, unknown>;
    const ownerKind = typeof value.ownerKind === 'string' ? value.ownerKind : '';
    const ownerId = typeof value.ownerId === 'string' ? value.ownerId : '';
    if (!MANAGED_LINK_OWNER_KINDS.has(ownerKind) || !ownerId) return [];
    const count = (field: unknown) => {
      const parsed = Number(field ?? 0);
      return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
    };
    const lastRejectedAtMs = count(value.lastRejectedAtUnixMs);
    const lastRejectionReason = typeof value.lastRejectionReason === 'string' ? value.lastRejectionReason : '';
    return [
      {
        ownerKind,
        ownerId,
        activeConnections: count(value.activeConnections),
        connectionLimit: count(value.connectionLimit),
        rejectedTotal: count(value.rejectedTotal),
        lastRejectionReason: lastRejectionReason || null,
        lastRejectedAt: lastRejectedAtMs > 0 ? new Date(lastRejectedAtMs).toISOString() : null,
        openedTotal: count(value.openedTotal),
        sourceToTargetBytes: count(value.sourceToTargetBytes),
        targetToSourceBytes: count(value.targetToSourceBytes),
        completedTotal: count(value.completedTotal),
      },
    ];
  });
  return managedLinks.length ? { managedLinks } : {};
}

/**
 * The relay stream sessions of a daemon health report (relay_stream_resume_v1, RSv1). Absent when the daemon does not
 * report them, so reports of older daemons keep their shape.
 */
export function relayStreamHealth(raw: unknown): { relayStreams?: NodeRelayStreamReport } {
  if (!raw || typeof raw !== 'object') return {};
  const value = raw as Record<string, unknown>;
  const count = (field: unknown) => {
    const parsed = Number(field ?? 0);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
  };
  const byRelay = (Array.isArray(value.byRelay) ? value.byRelay : []).flatMap((entry) => {
    const relay = (entry ?? {}) as Record<string, unknown>;
    const relayInstanceId = typeof relay.relayInstanceId === 'string' ? relay.relayInstanceId : '';
    if (!relayInstanceId) return [];
    return [{ relayInstanceId, resumable: count(relay.resumable), legacy: count(relay.legacy) }];
  });
  return {
    relayStreams: {
      resumableSessions: count(value.resumableSessions),
      legacySessions: count(value.legacySessions),
      suspendedSessions: count(value.suspendedSessions),
      migrationsOkTotal: count(value.migrationsOkTotal),
      migrationsFailedTotal: count(value.migrationsFailedTotal),
      cutTotal: count(value.cutTotal),
      retransmittedBytesTotal: count(value.retransmittedBytesTotal),
      unackedBytes: count(value.unackedBytes),
      migrationStallP50Ms: count(value.migrationStallP50Ms),
      migrationStallP95Ms: count(value.migrationStallP95Ms),
      resumeRefusedTotal: count(value.resumeRefusedTotal),
      laneRotationsTotal: count(value.laneRotationsTotal),
      laneMovesTotal: count(value.laneMovesTotal),
      byRelay,
    },
  };
}

function healthCount(field: unknown): number {
  const parsed = Number(field ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

/** Connections by cut class; classes are an open set, empty and zero entries are dropped. */
function cutByClass(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const cut: Record<string, number> = {};
  for (const [connectionClass, value] of Object.entries(raw as Record<string, unknown>)) {
    const count = healthCount(value);
    if (connectionClass && count > 0) cut[connectionClass] = count;
  }
  return cut;
}

function updateConnectionResult(raw: unknown): NodeUpdateConnectionResult | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const toVersion = typeof value.toVersion === 'string' ? value.toVersion : '';
  const finishedAtUnixMs = healthCount(value.finishedAtUnixMs);
  if (!toVersion || finishedAtUnixMs === 0) return undefined;
  return {
    fromVersion: typeof value.fromVersion === 'string' ? value.fromVersion : '',
    toVersion,
    startedAtUnixMs: healthCount(value.startedAtUnixMs),
    finishedAtUnixMs,
    handover: value.handover === true,
    handedOver: healthCount(value.handedOver),
    kept: healthCount(value.kept),
    cut: cutByClass(value.cut),
    pauseP50Ms: healthCount(value.pauseP50Ms),
    pauseP99Ms: healthCount(value.pauseP99Ms),
    pauseMaxMs: healthCount(value.pauseMaxMs),
  };
}

/**
 * What an update of a docker or nginx daemon keeps and cuts (HealthReport.update_connections). Absent when the daemon
 * does not report it, so reports of older daemons keep their shape.
 */
export function updateConnectionsHealth(raw: unknown): { updateConnections?: NodeUpdateConnectionsReport } {
  if (!raw || typeof raw !== 'object') return {};
  const value = raw as Record<string, unknown>;
  const lastUpdate = updateConnectionResult(value.lastUpdate);
  return {
    updateConnections: {
      handoverAvailable: value.handoverAvailable === true,
      kept: healthCount(value.kept),
      cut: cutByClass(value.cut),
      ...(lastUpdate ? { lastUpdate } : {}),
    },
  };
}
