/**
 * Content behind the managed `backups` storage tabs: health and metric
 * history, its TLS certificate, buckets and objects, IAM keys and one text
 * object for the file window. Seeds 4200–4299.
 */
import type {
  ManagedCertificateStatus,
  ManagedStorageAccessKey,
  ObjectStorageBucket,
  ObjectStorageHealthEntry,
  ObjectStorageListing,
  ObjectStorageMetricSnapshot,
  ObjectStorageObject,
} from "@/types";
import { ago, agoMs, ahead, uuid } from "../time";
import { backupsStorage } from "./storage";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

/** Health checks every five minutes over the last day, one slow spell mid-morning. */
export const backupsHealthHistory: ObjectStorageHealthEntry[] = Array.from(
  { length: 288 },
  (_, index) => {
    const minutesAgo = (288 - index) * 5;
    const slow = minutesAgo <= 400 && minutesAgo >= 385;
    return {
      ts: ago(minutesAgo, "m"),
      status: slow ? "degraded" : "online",
      responseMs: slow ? 1_720 : 11 + ((index * 7) % 6),
      ...(slow ? { slow: true } : {}),
    };
  }
);

/** One hour of per-minute samples of the SeaweedFS cluster. */
export function backupsMonitoringHistory(): ObjectStorageMetricSnapshot[] {
  return Array.from({ length: 60 }, (_, index) => {
    const wave = Math.sin(index / 6);
    return {
      timestamp: new Date(agoMs(60 - index, "m")).toISOString(),
      storageId: backupsStorage.id,
      provider: "seaweedfs",
      name: backupsStorage.name,
      status: "online",
      responseMs: 12 + (index % 4),
      metrics: {
        latency_ms: 12 + (index % 4) + Math.max(0, wave * 3),
        bucket_count: 4,
        cpu_pct: 6 + wave * 3 + (index % 3),
        memory_used_bytes: (612 + wave * 40) * MiB,
        memory_limit_bytes: 2 * GiB,
        disk_used_bytes: 211 * GiB + index * 40 * MiB,
        disk_total_bytes: 500 * GiB,
        swap_used_bytes: 0,
        swap_total_bytes: 0,
        network_rx_bytes: Math.round((3.2 + Math.abs(wave) * 2.4) * MiB),
        network_tx_bytes: Math.round((0.8 + Math.abs(wave) * 0.6) * MiB),
      },
    };
  });
}

export const backupsCertificate: ManagedCertificateStatus = {
  ownerType: "managed_storage",
  ownerId: backupsStorage.managed!.id,
  certificate: {
    id: uuid(4201),
    serialNumber: "2b:90:4e:c1:18:7a:6f:03",
    notBefore: ago(44, "d"),
    notAfter: ahead(46, "d"),
    daysRemaining: 46,
    sans: ["198.51.100.16", "backups.storage-1.internal"],
  },
  renewal: {
    state: "idle",
    reason: null,
    due: false,
    dueReason: null,
    urgent: false,
    hotReloadSupported: true,
    skipReason: null,
    attempts: 0,
    lastAttemptAt: ago(44, "d"),
    nextAttemptAt: null,
    deliveredAt: ago(44, "d"),
    lastSuccessAt: ago(44, "d"),
    lastError: null,
    lastMethod: "hot_reload",
    lastRestarted: false,
    pendingSerial: null,
  },
};

export const backupsBuckets: ObjectStorageBucket[] = [
  { name: "db-backups", creationDate: ago(170, "d") },
  { name: "volume-snapshots", creationDate: ago(160, "d") },
  { name: "pages-artifacts", creationDate: ago(90, "d") },
  { name: "exports", creationDate: ago(40, "d") },
];

function object(key: string, size: number, minutesAgo: number): ObjectStorageObject {
  return {
    key,
    size,
    lastModified: ago(minutesAgo, "m"),
    etag: `"${uuid(4210 + key.length + (size % 97))
      .replace(/-/g, "")
      .slice(0, 32)}"`,
    storageClass: "STANDARD",
  };
}

/** The db-backups bucket: one folder per database plus the retention README. */
const dbBackupsTree: Record<string, ObjectStorageListing> = {
  "": {
    prefixes: ["analytics/", "orders-db/", "sessions/"],
    objects: [
      object("README.md", 1_184, 60 * 24 * 40),
      object("retention-policy.json", 412, 60 * 24 * 12),
    ],
    nextContinuationToken: null,
    isTruncated: false,
  },
  "orders-db/": {
    prefixes: ["orders-db/nightly/", "orders-db/pre-release/"],
    objects: [],
    nextContinuationToken: null,
    isTruncated: false,
  },
  "orders-db/nightly/": {
    prefixes: [],
    objects: [0, 1, 3, 4].map((daysAgo, index) =>
      object(
        `orders-db/nightly/orders-db-${new Date(agoMs(daysAgo, "d")).toISOString().slice(0, 10)}.dump`,
        Math.round((1_412 + index * 9) * MiB),
        daysAgo * 24 * 60 + 300
      )
    ),
    nextContinuationToken: null,
    isTruncated: false,
  },
};

export function backupsListing(bucket: string, prefix: string): ObjectStorageListing {
  if (bucket === "db-backups" && dbBackupsTree[prefix]) return dbBackupsTree[prefix];
  return { prefixes: [], objects: [], nextContinuationToken: null, isTruncated: false };
}

export const backupsReadme = `# db-backups

Nightly logical backups written by the Opfield backup runner on storage-1.

- One folder per database (\`orders-db/\`, \`analytics/\`, \`sessions/\`).
- Nightly dumps are kept for 14 days; pre-release snapshots for 5 runs.
- Restores run from the database's Backups tab; never edit dumps in place.

Questions: #platform on the example.com chat.
`;

export const backupsAccessKeys: ManagedStorageAccessKey[] = [
  {
    accessKeyId: "GWBACKUPRUNNER01EXAMPLE",
    name: "backup-runner",
    access: "read-write",
    buckets: ["db-backups", "volume-snapshots"],
    expiresAt: null,
    createdAt: ago(160, "d"),
  },
  {
    accessKeyId: "GWPAGESDEPLOY002EXAMPLE",
    name: "pages-deploy",
    access: "read-write",
    buckets: ["pages-artifacts"],
    expiresAt: null,
    createdAt: ago(88, "d"),
  },
  {
    accessKeyId: "GWREPORTINGRO003EXAMPLE",
    name: "reporting-readonly",
    access: "read-only",
    buckets: ["exports"],
    expiresAt: ahead(64, "d"),
    createdAt: ago(26, "d"),
  },
  {
    accessKeyId: "GWPARTNERSYNC04EXAMPLE",
    name: "partner-sync",
    access: "read-write",
    buckets: ["exports"],
    expiresAt: ahead(6, "d"),
    createdAt: ago(84, "d"),
  },
  {
    accessKeyId: "GWLEGACYADMIN05EXAMPLE",
    name: null,
    access: null,
    buckets: [],
    expiresAt: null,
    createdAt: ago(170, "d"),
  },
];
