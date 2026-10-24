import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { nodeFolders } from './node-folders.js';

export const nodeTypeEnum = pgEnum('node_type', [
  'nginx',
  'monitoring',
  'docker',
  'builder',
  'databases',
  'storage',
  'relay',
]);
export const nodeStatusEnum = pgEnum('node_status', ['pending', 'online', 'offline', 'error']);

export interface NodeCapabilities {
  nginxVersion?: string;
  dockerVersion?: string;
  configDir?: string;
  daemonType?: string;
  /** The daemon config on the node turned the host console off (`console.enabled: false`). */
  nodeConsoleDisabled?: boolean;
  /** The daemon config on the node turned host file access off (`files.enabled: false`). */
  nodeFilesDisabled?: boolean;
  /** The daemon config sets `console.user` to another user, which the daemon cannot switch to without root. */
  nodeConsoleUserUnavailable?: boolean;
  /** The version of the launcher process the daemon runs under; absent while the launcher predates reporting it. */
  launcherVersion?: string;
  dockerRuntimeStatus?: {
    state: 'healthy' | 'installable' | 'unsupported' | 'unknown' | 'installing' | 'failed';
    installedVersion?: string;
    targetVersion?: string;
    reasonCode?: string;
    message?: string;
    checkedAt: string;
    remoteInstallable: boolean;
    localInstallCommand?: string;
    step?:
      | 'preparing'
      | 'downloading'
      | 'verifying_download'
      | 'installing_binaries'
      | 'configuring_docker'
      | 'restarting_docker'
      | 'verifying_runtime';
    progressPercent?: number;
  };
  [key: string]: unknown;
}

export interface NodeGpuDevice {
  id: string;
  vendor: string;
  model: string;
  pciAddress: string;
  renderNode: string;
  deviceIndex: number;
  attachable: boolean;
  unavailableReason: string;
  partitioned: boolean;
  availableMetrics: string[];
  utilizationPercent?: number;
  memoryTotalBytes?: number;
  memoryUsedBytes?: number;
  temperatureCelsius?: number;
  powerWatts?: number;
  powerLimitWatts?: number;
  throttled?: boolean;
  eccCorrectedErrors?: number;
  eccUncorrectedErrors?: number;
  health?: string;
}

/** Whether a node's Docker Engine can start containers (HealthReport.docker_engine_health). */
export interface NodeDockerEngineHealth {
  available: boolean;
  /** The part that does not answer: dockerd or containerd; absent while available. */
  component?: string;
  /** What fails, as one sentence; absent while available. */
  problem?: string;
  checkedAt?: string;
  /** Since when it has been unavailable; absent while available. */
  unavailableSince?: string;
}

export interface NodeHealthReport {
  nginxRunning: boolean;
  configValid: boolean;
  nginxUptimeSeconds: number;
  workerCount: number;
  nginxVersion: string;
  cpuPercent: number;
  memoryBytes: number;
  diskFreeBytes: number;
  /** promisedPercent: share of the storage root's disk promised to managed instances, over 100 when oversubscribed. */
  managedStorageCapacity?: { storageRoot: string; availableBytes: number; promisedPercent?: number };
  timestamp: number;
  // System
  loadAverage1m: number;
  loadAverage5m: number;
  loadAverage15m: number;
  systemMemoryTotalBytes: number;
  systemMemoryUsedBytes: number;
  systemMemoryAvailableBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  systemUptimeSeconds: number;
  openFileDescriptors: number;
  maxFileDescriptors: number;
  // Disk
  diskMounts: Array<{
    mountPoint: string;
    filesystem: string;
    device: string;
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usagePercent: number;
    /** root, docker_root, opfield_state, managed_image or data; absent from daemons before 2.12.3. */
    role?: string;
    /**
     * The filesystem behind the mount, the same for every node enrolled on one host that sees it: one disk alert
     * names every such node. Absent from daemons before 2.12.3.
     */
    diskId?: string;
  }>;
  diskReadBytes: number;
  diskWriteBytes: number;
  // Network
  networkInterfaces: Array<{
    name: string;
    rxBytes: number;
    txBytes: number;
    rxPackets: number;
    txPackets: number;
    rxErrors: number;
    txErrors: number;
    ipAddresses?: string[];
  }>;
  localIpAddresses: string[];
  publicIpAddresses?: string[];
  // Nginx
  nginxRssBytes: number;
  errorRate4xx: number;
  errorRate5xx: number;
  // Physical GPU inventory. Optional telemetry fields are only present when
  // the daemon explicitly reports the corresponding available metric.
  gpuDevices?: NodeGpuDevice[];
  // Smoothed round trip from this node to each relay it measured recently.
  relayLatencies?: Array<{ relayInstanceId: string; rttMs: number; failingMs?: number }>;
  // Nginx daemons with ingress groups (ingress_group_v1): what the reserved health endpoint answers.
  ingressHealth?: NodeIngressHealth;
  // Docker daemons with managed_link_runtime_v1: the connections of the managed links whose workloads the node runs.
  // Absent when the node has none.
  managedLinks?: NodeManagedLinkReport[];
  // Daemons with relay_stream_resume_v1: their relay stream sessions (RSv1).
  relayStreams?: NodeRelayStreamReport;
  // Docker and nginx daemons: the connections an update keeps and cuts now, and what the last update did.
  updateConnections?: NodeUpdateConnectionsReport;
  // Nginx daemons: a problem of the host's nginx service that only root can fix, as one sentence ending with the
  // command that fixes it. Absent when there is none.
  nginxServiceProblem?: string;
  // Docker daemons of 2.12.3 and later (not build workers): whether the node's Docker Engine can start containers
  // (dockerd and its containerd both answer). Absent from older daemons.
  dockerEngine?: NodeDockerEngineHealth;
  // Daemons of 2.12.1 and later: objects on the node still under their pre-Opfield names, by kind. Absent when none.
  legacyNames?: Record<string, number>;
  // Docker daemons that report it (HealthReport.lease_watchdog_version): the version of the node's lease watchdog,
  // which updates on its own schedule. Absent when the daemon does not report it.
  leaseWatchdogVersion?: string;
  // Nginx daemons with nginx_log_budget_v1: the nginx logs the daemon bounds (route logs and the default
  // access/error logs, live and rotated). Absent for older daemons.
  nginxLogs?: NodeNginxLogUsage;
  // Daemons of 2.12.3 and later on hosts with OpenSSH host keys: their SHA256 fingerprints. An SSH connector pinned to
  // one of them is refused, whatever address reaches the node. Absent when the host has none.
  sshHostKeyFingerprints?: string[];
  // Nginx daemons that upgrade the host's nginx themselves: where that upgrade stands. Absent from older daemons.
  nginxUpgrade?: NodeNginxUpgrade;
  // Nginx nodes whose nginx is older than NGINX_MINIMUM_VERSION: one sentence ending with what to do. Absent while
  // nginx is current.
  nginxVersionNotice?: string;
}

/** The nginx daemon's upgrade of the host's nginx to the nginx.org stable package (HealthReport.nginx_upgrade). */
export interface NodeNginxUpgrade {
  /** current, deferred, upgrading, failed, manual or unknown. */
  state: string;
  minimumVersion: string;
  /** direct (daemon runs as root), helper (installer's root helper) or manual. */
  mode: string;
  detail: string;
  /** The root command an operator runs when the daemon cannot upgrade nginx itself; empty otherwise. */
  command: string;
  /** Unix seconds; 0 when never. */
  lastAttemptAt: number;
  upgradedAt: number;
  previousVersion: string;
}

/** The nginx logs of one nginx node as its log budget last measured them. */
export interface NodeNginxLogUsage {
  bytes: number;
  files: number;
  /** Unix seconds of the oldest file; 0 when there is none. */
  oldestUnix: number;
  budgetBytes: number;
  maxFileBytes: number;
  /** 0: no age limit. */
  retentionDays: number;
}

/**
 * The connections across an update of a docker or nginx daemon. With daemon_stream_handover_v1 the daemon hands its
 * relay stream sessions over to the next process; what it cannot hand over is cut, by class (an open set: raw_stream,
 * postgres_tls, registry, backup, no_handover, service_restart, handshake, over_limit, resume_failed, busy,
 * idle_closed, local_closed, connector_retired, ...). In a last update, `uncounted` stands for every connection of the
 * node: the update handed nothing over and no daemon counted what it cut, because the daemon updated from (or the one
 * a rollback put back) cannot hand connections over (2.11.3 and earlier; Opfield records it), or the daemon it left
 * (2.11.4-rc.7 or earlier) did not count them.
 */
export interface NodeUpdateConnectionsReport {
  /**
   * An update now hands connections over (the running launcher keeps them). False, with the connections under
   * service_restart, when the update would restart the whole service for a newer launcher.
   */
  handoverAvailable: boolean;
  /** Live connections an update now would keep. */
  kept: number;
  /** Live connections an update now would cut, by class. */
  cut: Record<string, number>;
  /** The last update of the daemon, once its counts are final. */
  lastUpdate?: NodeUpdateConnectionResult;
}

/** What one update of the daemon did to the connections it carried. */
export interface NodeUpdateConnectionResult {
  fromVersion: string;
  toVersion: string;
  startedAtUnixMs: number;
  /** When the counts became final; identifies the report. */
  finishedAtUnixMs: number;
  /** The update handed connections over (live handover). */
  handover: boolean;
  handedOver: number;
  kept: number;
  cut: Record<string, number>;
  pauseP50Ms: number;
  pauseP99Ms: number;
  pauseMaxMs: number;
}

/** A daemon's relay stream sessions (RSv1). Totals count since the daemon started. */
export interface NodeRelayStreamReport {
  resumableSessions: number;
  legacySessions: number;
  suspendedSessions: number;
  migrationsOkTotal: number;
  migrationsFailedTotal: number;
  /** Resumable streams that ended abnormally: no relay to move to, resume refused, timeout. */
  cutTotal: number;
  retransmittedBytesTotal: number;
  unackedBytes: number;
  migrationStallP50Ms: number;
  migrationStallP95Ms: number;
  /** Target side: resumes the daemon refused. */
  resumeRefusedTotal: number;
  /**
   * Relay lane connections the daemon replaced because their TCP state collapsed or learned a much shorter round trip
   * (since the daemon started), and the resumable streams it moved off them (not migrations). Older daemons: 0.
   */
  laneRotationsTotal: number;
  laneMovesTotal: number;
  /** Open sessions per relay they currently run through. */
  byRelay: Array<{ relayInstanceId: string; resumable: number; legacy: number }>;
}

/**
 * One managed database or storage link as the node that runs its workloads reports it. The node's host listener (the
 * storage connector socket for a storage link) is the link's single gate, whichever relay carries a connection.
 */
export interface NodeManagedLinkReport {
  /** managed_database_binding, managed_storage_binding or container_link. */
  ownerKind: string;
  /** The binding id; an Availability placement id for a placement's link. */
  ownerId: string;
  activeConnections: number;
  /** The session limit Opfield signed into the link's grant. */
  connectionLimit: number;
  /** Connections the node refused at the link's or the node's limit since its daemon started. */
  rejectedTotal: number;
  lastRejectionReason: string | null;
  lastRejectedAt: string | null;
  /** Sessions a relay opened for the link and the bytes it carried through the node since its daemon started. */
  openedTotal: number;
  sourceToTargetBytes: number;
  targetToSourceBytes: number;
  /** Sessions of openedTotal that ended on the node (same-node ones included); 0 from a daemon that does not count them. */
  completedTotal?: number;
}

/** What an nginx daemon's `/.well-known/opfield-ingress-health` endpoint answered when it last reported. */
export interface NodeIngressHealth {
  serving: boolean;
  reason: string;
  configGeneration: number;
  nginxRunning: boolean;
  configApplied: boolean;
  secureLinkSources: number;
  usableRelayTransports: number;
  checkedAt: string | null;
}

export interface NodeStatsReport {
  activeConnections: number;
  accepts: number;
  handled: number;
  requests: number;
  reading: number;
  writing: number;
  waiting: number;
  timestamp: number;
}

export const nodes = pgTable(
  'nodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: nodeTypeEnum('type').notNull().default('nginx'),
    hostname: varchar('hostname', { length: 255 }).notNull(),
    displayName: varchar('display_name', { length: 255 }),
    slug: varchar('slug', { length: 60 }).notNull(),
    appearanceColor: varchar('appearance_color', { length: 32 }),
    serviceAddresses: text('service_addresses').array().notNull().default([]),
    serviceAddress: varchar('service_address', { length: 255 }),
    secondaryServiceAddress: varchar('secondary_service_address', { length: 255 }),
    status: nodeStatusEnum('status').notNull().default('pending'),
    serviceCreationLocked: boolean('service_creation_locked').notNull().default(false),

    // Enrollment
    enrollmentTokenSelector: varchar('enrollment_token_selector', { length: 32 }),
    enrollmentTokenHash: varchar('enrollment_token_hash', { length: 255 }),
    // NULL keeps a legacy token without an expiry; new tokens always set it.
    enrollmentTokenExpiresAt: timestamp('enrollment_token_expires_at', { withTimezone: true }),
    certificateSerial: varchar('certificate_serial', { length: 255 }),
    certificateFingerprint: varchar('certificate_fingerprint', { length: 71 }),
    certificateExpiresAt: timestamp('certificate_expires_at', { withTimezone: true }),
    // A renewed client certificate is staged here until the daemon first
    // registers with it; only then does it replace the current certificate.
    pendingCertificateSerial: varchar('pending_certificate_serial', { length: 255 }),
    pendingCertificateFingerprint: varchar('pending_certificate_fingerprint', { length: 71 }),
    pendingCertificateExpiresAt: timestamp('pending_certificate_expires_at', { withTimezone: true }),

    // Stable opaque identity of the physical host. Colocated daemon roles have
    // distinct node identities but share this value for fault-domain accounting.
    hostIdentityId: uuid('host_identity_id'),

    // Daemon info
    daemonVersion: varchar('daemon_version', { length: 50 }),
    osInfo: varchar('os_info', { length: 255 }),
    configVersionHash: varchar('config_version_hash', { length: 64 }),

    // Type-specific capabilities (e.g. { nginxVersion, configDir })
    capabilities: jsonb('capabilities').$type<NodeCapabilities>().default({}),

    // Latest reports
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lastHealthReport: jsonb('last_health_report').$type<NodeHealthReport>(),
    lastStatsReport: jsonb('last_stats_report').$type<NodeStatsReport>(),

    // Health history: timestamped status entries (same format as proxy hosts)
    healthHistory: jsonb('health_history').$type<Array<{ ts: string; status: string }>>().default([]),

    // Extensible metadata
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),

    // Folder / organization
    folderId: uuid('folder_id').references(() => nodeFolders.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    typeIdx: index('node_type_idx').on(table.type),
    statusIdx: index('node_status_idx').on(table.status),
    hostnameIdx: index('node_hostname_idx').on(table.hostname),
    enrollmentTokenSelectorIdx: index('node_enrollment_token_selector_idx').on(table.enrollmentTokenSelector),
    hostIdentityIdx: index('node_host_identity_idx').on(table.hostIdentityId),
    folderIdx: index('node_folder_idx').on(table.folderId),
    slugUnique: unique('nodes_slug_unique').on(table.slug),
  })
);
