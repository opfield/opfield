/**
 * The Proxmox VE hosting integration: apps-1, apps-2 and storage-1 run as
 * guests of the "Lab cluster"; two more guests are discovered but not enrolled.
 * Uuid seeds: 1500–1569.
 */
import { HttpResponse, http } from "msw";
import type {
  HostingCapability,
  HostingCatalog,
  HostingConnector,
  HostingFirewallView,
  HostingNodeBinding,
  HostingNodeProjection,
  HostingOperation,
  HostingResource,
  HostingSnapshotsView,
  HostingVmSnapshot,
} from "@/types/hosting";
import { ok } from "../../handlers";
import { nodeBySlug } from "../nodes";
import { ago, uuid } from "../time";

const apps1 = nodeBySlug("apps-1")!;
const apps2 = nodeBySlug("apps-2")!;
const storage1 = nodeBySlug("storage-1")!;

export const labCluster: HostingConnector = {
  id: uuid(1500),
  provider: "proxmox",
  name: "Lab cluster",
  baseUrl: "https://pve.example.com:8006",
  enabled: true,
  tokenLast4: "7c2e",
  settings: {
    kind: "hosting",
    autoSyncEnabled: true,
    autoSyncIntervalSeconds: 300,
    resourceIds: [],
    adoptionNodeIds: [],
    adoptionEnabled: true,
    tokenId: "gateway@pve!provisioning",
    clusterId: "lab",
    proxmoxHost: "pve-1",
    proxmox: {
      nodes: ["pve-1", "pve-2"],
      storage: "local-zfs",
      imageStorage: "local",
      bridge: "vmbr0",
      network: "static",
      gateway: "10.20.0.1",
      subnet: "10.20.0.0/24",
      vmidRange: "1100-1199",
      ipRange: "10.20.0.100-10.20.0.199",
      vlan: null,
      dnsServers: ["10.20.0.1"],
      searchDomain: "lab.example.com",
      firewall: true,
      maxCpu: 16,
      maxMemoryMb: 65_536,
      maxDiskGb: 1_000,
    },
  },
  hasCustomCa: true,
  certificateFingerprint:
    "4F:1A:9C:22:7B:E0:31:5D:8A:6C:0F:93:B2:47:D1:E8:65:0B:3C:9A:72:E4:18:5F:A0:6D:C3:29:84:1B:F7:52",
  capabilities: { create: true, snapshots: true, firewall: true, resize: true, adoption: true },
  syncStatus: "success",
  syncLastError: null,
  testedAt: ago(3, "h"),
  syncedAt: ago(4, "m"),
  createdAt: ago(190, "d"),
};

/** A second account whose API token expired: it shows the sync warning. */
export const burstAccount: HostingConnector = {
  id: uuid(1501),
  provider: "hetzner",
  name: "Burst capacity",
  baseUrl: "https://api.hetzner.cloud",
  enabled: true,
  tokenLast4: "91d0",
  settings: {
    kind: "hosting",
    autoSyncEnabled: true,
    autoSyncIntervalSeconds: 900,
    resourceIds: [],
    adoptionNodeIds: [],
    adoptionEnabled: false,
    defaultLocation: "fsn1",
  },
  hasCustomCa: false,
  certificateFingerprint: null,
  capabilities: { create: true, snapshots: true, resize: true, finance: false },
  syncStatus: "error",
  syncLastError: "401 Unauthorized: the API token was revoked",
  testedAt: ago(2, "d"),
  syncedAt: ago(2, "d"),
  createdAt: ago(75, "d"),
};

const yes: HostingCapability = { available: true };
const unsupported = (reason: string): HostingCapability => ({
  available: false,
  reason,
  reasonCode: "unsupported",
});

function capabilities(running: boolean): HostingResource["capabilities"] {
  return {
    start: running ? { available: false, reason: "The VM is already running." } : yes,
    shutdown: running ? yes : { available: false, reason: "The VM is stopped." },
    reboot: running ? yes : { available: false, reason: "The VM is stopped." },
    resize: yes,
    delete: yes,
    recover: running ? yes : { available: false, reason: "The VM is stopped." },
    create: yes,
    finance: unsupported("Proxmox VE has no billing."),
    topup: unsupported("Proxmox VE has no billing."),
    guestIdentity: yes,
    bootstrap: yes,
  };
}

interface ResourceSeed {
  seed: number;
  remoteId: string;
  name: string;
  location: string;
  kind?: HostingResource["kind"];
  origin: HostingResource["origin"];
  powerState: HostingResource["powerState"];
  cpu: number;
  memoryMb: number;
  diskGb: number;
  ip: string;
  node?: typeof apps1;
  adoptionReason?: string | null;
}

function resource(seed: ResourceSeed): HostingResource {
  return {
    id: uuid(seed.seed),
    connectorId: labCluster.id,
    remoteId: seed.remoteId,
    kind: seed.kind ?? "vm",
    name: seed.name,
    location: seed.location,
    origin: seed.origin,
    incarnation: `pve-${seed.remoteId}-${seed.seed}`,
    powerState: seed.powerState,
    cpu: seed.cpu,
    memoryMb: seed.memoryMb,
    diskGb: seed.diskGb,
    addresses: [
      {
        ip: seed.ip,
        mac: `BC:24:11:0A:${seed.remoteId.slice(0, 2)}:${seed.remoteId.slice(2)}`,
        network: "vmbr0",
        direct: true,
      },
    ],
    providerUrl: `https://pve.example.com:8006/#v1:0:=qemu%2F${seed.remoteId}`,
    observedAt: ago(4, "m"),
    missingSince: null,
    adoptionReason: seed.adoptionReason ?? null,
    capabilities: capabilities(seed.powerState === "running"),
    nodes: seed.node
      ? [
          {
            id: seed.node.id,
            name: seed.node.displayName ?? seed.node.hostname,
            status: seed.node.status,
            type: seed.node.type,
            slug: seed.node.slug,
          },
        ]
      : [],
  };
}

export const hostingResources: HostingResource[] = [
  resource({
    seed: 1510,
    remoteId: "1103",
    name: "apps-1",
    location: "pve-1",
    origin: "adopted",
    powerState: "running",
    cpu: 8,
    memoryMb: 16_384,
    diskGb: 200,
    ip: "10.20.0.13",
    node: apps1,
  }),
  resource({
    seed: 1511,
    remoteId: "1104",
    name: "apps-2",
    location: "pve-2",
    origin: "created",
    powerState: "running",
    cpu: 8,
    memoryMb: 16_384,
    diskGb: 160,
    ip: "10.20.0.14",
    node: apps2,
  }),
  resource({
    seed: 1512,
    remoteId: "1106",
    name: "storage-1",
    location: "pve-2",
    kind: "ct",
    origin: "created",
    powerState: "running",
    cpu: 2,
    memoryMb: 4_096,
    diskGb: 500,
    ip: "10.20.0.16",
    node: storage1,
  }),
  resource({
    seed: 1513,
    remoteId: "1120",
    name: "ci-runner-1",
    location: "pve-1",
    origin: "discovered",
    powerState: "running",
    cpu: 4,
    memoryMb: 8_192,
    diskGb: 80,
    ip: "10.20.0.120",
    adoptionReason: "No Opfield daemon answers on this guest yet.",
  }),
  resource({
    seed: 1514,
    remoteId: "1130",
    name: "win-build-test",
    location: "pve-1",
    origin: "discovered",
    powerState: "stopped",
    cpu: 4,
    memoryMb: 8_192,
    diskGb: 120,
    ip: "10.20.0.130",
    adoptionReason: "The guest is stopped.",
  }),
];

const resourceByNode = (nodeId: string) =>
  hostingResources.find((item) => item.nodes.some((node) => node.id === nodeId));

export function hostingProjection(nodeId: string): HostingNodeProjection | null {
  const found = resourceByNode(nodeId);
  if (!found) return null;
  const { start, shutdown, reboot, resize, delete: remove, recover } = found.capabilities;
  return {
    resourceId: found.id,
    connectorId: labCluster.id,
    provider: "proxmox",
    connectorName: labCluster.name,
    remoteId: found.remoteId,
    location: found.location,
    origin: found.origin,
    kind: found.kind,
    powerState: found.powerState,
    cpu: found.cpu,
    memoryMb: found.memoryMb,
    diskGb: found.diskGb,
    incarnation: found.incarnation,
    providerUrl: found.providerUrl,
    observedAt: found.observedAt,
    identityConflict: false,
    operation: null,
    actions: { start, shutdown, reboot, resize, delete: remove, recover },
  };
}

export const hostingBindings: Record<string, HostingNodeBinding> = Object.fromEntries(
  hostingResources.flatMap((item) =>
    item.nodes.map((node) => [
      node.id,
      {
        connectorId: labCluster.id,
        connectorName: labCluster.name,
        provider: "proxmox" as const,
        resourceId: item.id,
      },
    ])
  )
);

function operation(
  seed: number,
  target: HostingResource,
  action: HostingOperation["action"],
  createdAgo: [number, "m" | "h" | "d"],
  minutes: number,
  phase: HostingOperation["phase"] = "ready"
): HostingOperation {
  const createdAt = ago(createdAgo[0], createdAgo[1]);
  const completedAt = new Date(new Date(createdAt).getTime() + minutes * 60_000).toISOString();
  const node = target.nodes[0];
  return {
    id: uuid(seed),
    connectorId: labCluster.id,
    resourceId: target.id,
    nodeId: node?.id ?? null,
    node: node
      ? { id: node.id, name: node.name, type: node.type as "docker", location: target.location }
      : undefined,
    action,
    phase,
    errorCode: null,
    errorMessage: null,
    createdAt,
    updatedAt: phase === "ready" ? completedAt : createdAt,
    completedAt: phase === "ready" ? completedAt : null,
    result: node ? { nodeId: node.id, resourceId: target.id } : null,
  };
}

export const hostingOperations: HostingOperation[] = [
  operation(1520, hostingResources[1], "snapshot_create", [1, "d"], 2),
  operation(1521, hostingResources[0], "reboot", [6, "d"], 1),
  operation(1522, hostingResources[1], "resize", [12, "d"], 3),
  operation(1523, hostingResources[2], "create", [58, "d"], 9),
  operation(1524, hostingResources[1], "create", [64, "d"], 11),
];

export const hostingCatalog: HostingCatalog = {
  locations: [
    { id: "pve-1", name: "pve-1" },
    { id: "pve-2", name: "pve-2" },
  ],
  sizes: [{ id: "custom", name: "Custom size" }],
  images: [
    {
      id: "ubuntu-24.04",
      name: "Ubuntu 24.04 LTS (cloud image)",
      architecture: "x64",
      operatingSystem: { distribution: "ubuntu", version: "24.04" },
      supportedRoles: ["nginx", "docker", "builder", "databases", "storage", "monitoring"],
    },
    {
      id: "debian-12",
      name: "Debian 12 (cloud image)",
      architecture: "x64",
      operatingSystem: { distribution: "debian", version: "12" },
      supportedRoles: ["nginx", "docker", "builder", "databases", "storage", "monitoring"],
    },
  ],
  capacity: [
    {
      id: "pve-1",
      name: "pve-1",
      online: true,
      memoryTotalMb: 131_072,
      memoryUsedMb: 61_440,
      diskTotalGb: 3_600,
      diskUsedGb: 1_410,
    },
    {
      id: "pve-2",
      name: "pve-2",
      online: true,
      memoryTotalMb: 131_072,
      memoryUsedMb: 44_032,
      diskTotalGb: 3_600,
      diskUsedGb: 980,
    },
  ],
};

export const apps2Firewall: HostingFirewallView = {
  resourceId: hostingResources[1].id,
  revision: 4,
  config: {
    enabled: true,
    inboundPolicy: "deny",
    outboundPolicy: "allow",
    rules: [
      {
        id: "rule-ssh",
        direction: "in",
        action: "allow",
        protocol: "tcp",
        ports: "22",
        addresses: ["10.20.0.0/24"],
        description: "SSH from the management network",
      },
      {
        id: "rule-apps",
        direction: "in",
        action: "allow",
        protocol: "tcp",
        ports: "3000,8180-8181",
        addresses: ["10.20.0.11", "10.20.1.12"],
        description: "Published app ports from the Ingress nodes",
      },
      {
        id: "rule-metrics",
        direction: "in",
        action: "allow",
        protocol: "tcp",
        ports: "9100",
        addresses: ["10.20.0.17"],
        description: "node-exporter scrape from monitor-1",
      },
      {
        id: "rule-icmp",
        direction: "in",
        action: "allow",
        protocol: "icmp",
        ports: "",
        addresses: ["10.20.0.0/16"],
        description: "Ping inside the lab",
      },
      {
        id: "rule-smtp",
        direction: "out",
        action: "deny",
        protocol: "tcp",
        ports: "25",
        addresses: [],
        description: "No direct SMTP; mail goes through the relay",
      },
    ],
  },
  status: "ready",
  observation: {
    fingerprint: "fw-apps-2-r4",
    enabled: true,
    matches: true,
    applying: false,
    remoteId: "1104",
    blockers: [],
    observedAt: ago(4, "m"),
  },
  error: null,
  canEdit: true,
};

function snapshot(
  seed: number,
  name: string,
  daysAgo: number,
  sizeGb: number,
  extra: Partial<HostingVmSnapshot> = {}
): HostingVmSnapshot {
  return {
    id: uuid(seed),
    entityId: uuid(seed + 20),
    status: "ready",
    providerSnapshotId: name,
    operationId: null,
    error: null,
    includeRam: false,
    revision: `r${seed}`,
    name,
    createdAt: ago(daysAgo, "d"),
    fingerprint: `snap-${seed}`,
    sizeGb,
    minDiskGb: 160,
    ready: true,
    folderId: null,
    sortOrder: seed,
    monthlyCost: null,
    storageRate: null,
    ...extra,
  };
}

export const apps2Snapshots: HostingSnapshotsView = {
  busy: false,
  readModel: {
    refreshStatus: "success",
    availability: "available",
    lastError: null,
    observedAt: ago(4, "m"),
  },
  resourceId: hostingResources[1].id,
  incarnation: hostingResources[1].incarnation!,
  provider: "proxmox",
  powerState: "running",
  supported: true,
  reason: null,
  snapshots: [
    snapshot(1530, "before-stack-rc2", 1, 18.4),
    snapshot(1531, "weekly-2026-w38", 5, 17.9),
    snapshot(1532, "before-daemon-2-14", 12, 16.2, { includeRam: true }),
    snapshot(1533, "weekly-2026-w37", 12, 16.0),
    snapshot(1534, "post-install", 64, 6.8),
  ],
  operation: null,
  canCreate: true,
  canDelete: true,
  canRestore: true,
  canManageFolders: true,
};

/** Hosting endpoints of the Nodes pages. Pass before the node list/detail handlers. */
export function hostingHandlers() {
  const notFound = () => HttpResponse.json({ message: "Not found" }, { status: 404 });
  const isLab = (params: Record<string, unknown>) => params.id === labCluster.id;
  return [
    http.get("*/api/integrations/hosting", () => ok([labCluster, burstAccount])),
    http.get("*/api/integrations/hosting/:id/resources", ({ params }) =>
      isLab(params) ? ok(hostingResources) : notFound()
    ),
    http.get("*/api/integrations/hosting/:id/operations", ({ params }) =>
      isLab(params) ? ok(hostingOperations) : notFound()
    ),
    http.get("*/api/integrations/hosting/:id/catalog", ({ params }) =>
      isLab(params) ? ok(hostingCatalog) : notFound()
    ),
    // Proxmox VE has no billing: no balance and no expenses.
    http.get("*/api/integrations/hosting/:id/account-summary", ({ params }) =>
      isLab(params)
        ? ok({ balance: null, monthlyExpenses: null, observedAt: ago(4, "m") })
        : notFound()
    ),
    http.get("*/api/integrations/hosting/:id/configuration", ({ params }) =>
      isLab(params) ? ok(labCluster) : notFound()
    ),
    http.get("*/api/integrations/hosting/:id", ({ params }) =>
      isLab(params) ? ok(labCluster) : notFound()
    ),
    http.get("*/api/hosting/node-bindings", () => ok(hostingBindings)),
    http.get("*/api/hosting/nodes/:id/firewall", ({ params }) =>
      params.id === apps2.id ? ok(apps2Firewall) : notFound()
    ),
    http.get("*/api/hosting/nodes/:id", ({ params }) => ok(hostingProjection(String(params.id)))),
    http.get("*/api/hosting/resources/:id/snapshot-folders", () => ok([])),
    http.get("*/api/hosting/resources/:id/snapshots", ({ params }) =>
      params.id === hostingResources[1].id ? ok(apps2Snapshots) : notFound()
    ),
  ];
}
