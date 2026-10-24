export type HostingProvider = "hostkey" | "digitalocean" | "hetzner" | "cloudblast" | "proxmox";

/** CPU types a Proxmox profile may give its VMs (backend PROXMOX_CPU_TYPES); host is the default. */
export const PROXMOX_CPU_TYPES = [
  "host",
  "max",
  "x86-64-v2",
  "x86-64-v2-AES",
  "x86-64-v3",
  "x86-64-v4",
  "kvm64",
  "qemu64",
] as const;
export type ProxmoxCpuType = (typeof PROXMOX_CPU_TYPES)[number];
export type HostingRole =
  | "nginx"
  | "docker"
  | "builder"
  | "databases"
  | "storage"
  | "monitoring"
  | "relay";
export type HostingAction = "start" | "shutdown" | "reboot" | "resize" | "delete" | "recover";
export type HostingSnapshotAction = "snapshot_create" | "snapshot_delete" | "snapshot_restore";
export type HostingVmSnapshotStatus = "pending" | "ready" | "failed" | "deleting" | "deleted";
export interface HostingVmSnapshot {
  id: string;
  entityId: string;
  status: HostingVmSnapshotStatus;
  providerSnapshotId: string | null;
  operationId: string | null;
  error: string | null;
  includeRam: boolean;
  revision: string;
  name: string;
  createdAt: string | null;
  fingerprint: string;
  sizeGb: number | null;
  minDiskGb: number | null;
  ready: boolean;
  layoutId?: string;
  folderId?: string | null;
  sortOrder?: number;
  monthlyCost?: {
    amount: string;
    currency: string;
    estimated: true;
    tax: "net" | "gross" | "unspecified";
  } | null;
  storageRate?: {
    amount: string;
    currency: string;
    unit: "GB-month";
    source: "provider-api" | "published-rate";
  } | null;
}
export interface HostingSnapshotInput {
  action: HostingSnapshotAction;
  idempotencyKey: string;
  expectedIncarnation: string;
  name?: string;
  includeRam?: boolean;
  snapshotEntityId?: string;
  snapshotId?: string;
  snapshotFingerprint?: string;
  confirmed: true;
}
export type HostingSnapshotEventOperation = Pick<
  HostingOperation,
  "id" | "action" | "phase" | "errorMessage" | "updatedAt"
>;
export type HostingSnapshotChangedEvent = {
  resourceId: string;
  incarnation: string;
  snapshot: HostingVmSnapshot;
  operation?: HostingSnapshotEventOperation | null;
};
export interface HostingSnapshotsView {
  busy?: boolean;
  readModel?: {
    refreshStatus: "never" | "refreshing" | "success" | "error";
    availability: string;
    lastError: string | null;
    observedAt: string | null;
  };
  resourceId: string;
  incarnation: string;
  provider: HostingProvider;
  powerState: string;
  supported: boolean;
  reason: string | null;
  snapshots: HostingVmSnapshot[];
  operation: HostingOperation | HostingSnapshotEventOperation | null;
  canCreate: boolean;
  canDelete: boolean;
  canRestore: boolean;
  canManageFolders?: boolean;
}
export interface HostingMoney {
  amount: string;
  currency: string;
  estimated: boolean;
  period?: "hour" | "month" | "billing_period";
}
export interface HostingCapability {
  available: boolean;
  reason?: string;
  reasonCode?: "permission_denied" | "temporarily_unavailable" | "unsupported";
}
export interface HostingSettings {
  kind: "hosting";
  autoSyncEnabled: boolean;
  autoSyncIntervalSeconds: number;
  resourceIds: string[];
  adoptionNodeIds: string[];
  adoptionEnabled: boolean;
  tokenId?: string;
  caCertificate?: string;
  certificateFingerprint?: string;
  clusterId?: string;
  proxmoxHost?: string;
  defaultLocation?: string;
  defaultSize?: string;
  defaultImage?: string;
  proxmox?: {
    nodes: string[];
    storage: string;
    imageStorage?: string;
    seedStorage?: string;
    bridge: string;
    pool?: string;
    network: "dhcp" | "static";
    gateway?: string;
    subnet?: string;
    vmidRange?: string;
    ipRange?: string;
    vlan?: number | null;
    dnsServers?: string[];
    searchDomain?: string;
    mtu?: number;
    firewall?: boolean;
    /** CPU type of the VMs the profile creates; unset means host. */
    cpuType?: ProxmoxCpuType;
    maxCpu?: number;
    maxMemoryMb?: number;
    maxDiskGb?: number;
    /** @deprecated Legacy template profiles are accepted for recovery only. */
    templateId?: number;
    /** @deprecated Legacy template profiles are accepted for recovery only. */
    templateNode?: string;
    /** @deprecated Legacy template profiles are accepted for recovery only. */
    cleanTemplate?: boolean;
    /** @deprecated Legacy per-VM defaults are accepted for recovery only. */
    defaultCpu?: number;
    /** @deprecated Legacy per-VM defaults are accepted for recovery only. */
    defaultMemoryMb?: number;
    /** @deprecated Legacy per-VM defaults are accepted for recovery only. */
    defaultDiskGb?: number;
  };
}
export interface HostingDiscovery {
  hosts: Array<{ id: string; name: string }>;
  templates: Array<{
    id: string;
    name: string;
    host: string;
    ready: boolean;
    reason?: string;
    diskGb?: number;
  }>;
  storages: Array<{ id: string; name: string; host: string; content?: string[] }>;
  bridges: Array<{ id: string; name: string; host: string }>;
  clusterName?: string;
  usedVmids?: number[];
}
export interface HostingConnector {
  id: string;
  provider: HostingProvider;
  name: string;
  baseUrl: string;
  enabled: boolean;
  tokenLast4: string | null;
  settings: HostingSettings;
  hasCustomCa: boolean;
  certificateFingerprint: string | null;
  capabilities: Record<string, boolean>;
  syncStatus: string;
  syncLastError: string | null;
  testedAt: string | null;
  syncedAt: string | null;
  createdAt: string;
}
export interface HostingConnectorInput {
  provider: HostingProvider;
  name: string;
  baseUrl: string;
  token?: string;
  enabled: boolean;
  settings: HostingSettings;
}
export interface HostingResource {
  id: string;
  connectorId: string;
  remoteId: string;
  kind: "vm" | "ct";
  name: string;
  location: string;
  origin: "discovered" | "created" | "adopted";
  incarnation: string | null;
  powerState: "running" | "stopped" | "starting" | "stopping" | "unknown";
  cpu: number | null;
  memoryMb: number | null;
  diskGb: number | null;
  sizeId?: string;
  imageId?: string;
  addresses: Array<{ ip: string; mac?: string; network?: string; direct: boolean }>;
  providerUrl?: string;
  price?: HostingMoney;
  observedAt: string;
  missingSince: string | null;
  adoptionReason: string | null;
  capabilities: Record<
    HostingAction | "create" | "finance" | "topup" | "guestIdentity" | "bootstrap",
    HostingCapability
  >;
  nodes: Array<{ id: string; name: string; status: string; type: string; slug: string }>;
}
export interface HostingCatalogOption {
  id: string;
  name: string;
  locations?: string[];
  cpu?: number;
  memoryMb?: number;
  diskGb?: number;
  architecture?: "x64" | "arm64";
  operatingSystem?: { distribution: "ubuntu" | "debian" | "fedora"; version: string };
  compatibleSizes?: string[];
  supportedRoles?: HostingRole[];
  price?: HostingMoney;
  locationPrices?: Record<string, HostingMoney>;
}
export interface HostingCatalog {
  locations: HostingCatalogOption[];
  sizes: HostingCatalogOption[];
  images: HostingCatalogOption[];
  capacity?: Array<{
    id: string;
    name: string;
    online: boolean;
    memoryTotalMb: number | null;
    memoryUsedMb: number | null;
    diskTotalGb: number | null;
    diskUsedGb: number | null;
  }>;
}
export interface HostingInvoice {
  id: string;
  status: string;
  total: HostingMoney | null;
  date: string | null;
  dueDate?: string | null;
  url?: string;
  resourceIds?: string[];
}
export interface HostingAccountSummary {
  balance: HostingMoney | null;
  monthlyExpenses: HostingMoney | null;
  observedAt: string;
}
export interface HostingOperation {
  id: string;
  connectorId: string | null;
  resourceId: string | null;
  nodeId: string | null;
  node?: { id: string; name: string; type: HostingRole; location: string };
  action: HostingAction | HostingSnapshotAction | "create" | "install" | "topup";
  phase:
    | "pending"
    | "dispatching"
    | "provisioning"
    | "configuring"
    | "installing"
    | "enrolling"
    | "awaiting_payment"
    | "reconciling"
    | "ready"
    | "failed"
    | "unknown";
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  result: {
    invoice?: HostingInvoice;
    nodeId?: string;
    resourceId?: string;
    snapshotEntityId?: string;
    providerDeleted?: boolean;
  } | null;
}
export interface HostingProvisionInput {
  connectorId: string;
  folderId?: string | null;
  idempotencyKey: string;
  name: string;
  displayName?: string;
  role: HostingRole;
  location: string;
  size: string;
  image: string;
  cpu?: number;
  memoryMb?: number;
  diskGb?: number;
  ipAddress?: string;
  relayAddress?: string;
  /** Relay nodes only: the TCP port the relay listens on (9443 when omitted). */
  relayServicePort?: number;
  confirmedPrice?: { amount: string; currency: string };
  existingResourceId?: string;
  sshConnectorId?: string;
}
export interface HostingActionInput {
  confirmedPrice?: { amount: string; currency: string };
  idempotencyKey: string;
  action: HostingAction;
  expectedIncarnation: string;
  confirmed: true;
  size?: string;
  cpu?: number;
  memoryMb?: number;
  diskGb?: number;
  reason?: string;
}
export interface HostingNodeProjection {
  resourceId: string | null;
  connectorId: string | null;
  provider: HostingProvider;
  connectorName: string | null;
  remoteId: string;
  location: string;
  /** Catalog name of `location` when the provider uses opaque location IDs. */
  locationName?: string;
  origin: string;
  kind: "vm" | "ct";
  powerState: HostingResource["powerState"];
  cpu: number | null;
  memoryMb: number | null;
  diskGb: number | null;
  incarnation: string | null;
  providerUrl?: string;
  price?: HostingMoney;
  observedAt: string;
  identityConflict: boolean;
  operation?: Pick<HostingOperation, "action" | "phase"> | null;
  actions: Partial<Record<HostingAction, HostingCapability>>;
}

export type HostingNodeBinding = Pick<
  HostingNodeProjection,
  "connectorId" | "connectorName" | "provider"
> & {
  resourceId: string | null;
  operationPhase?: HostingOperation["phase"];
  operationAction?: HostingOperation["action"];
};

export const HOSTING_PROVIDER_LABELS: Record<HostingProvider, string> = {
  hostkey: "HOSTKEY",
  digitalocean: "DigitalOcean",
  hetzner: "Hetzner Cloud",
  cloudblast: "CloudBlast",
  proxmox: "Proxmox VE",
};
export const HOSTING_API_ORIGINS: Record<HostingProvider, string> = {
  hostkey: "https://invapi.hostkey.com",
  digitalocean: "https://api.digitalocean.com",
  hetzner: "https://api.hetzner.cloud",
  cloudblast: "https://console.cloudblast.io",
  proxmox: "",
};
export const DEFAULT_HOSTING_SETTINGS: HostingSettings = {
  kind: "hosting",
  autoSyncEnabled: true,
  autoSyncIntervalSeconds: 300,
  resourceIds: [],
  adoptionNodeIds: [],
  adoptionEnabled: true,
};

export type HostingFirewallPolicy = "allow" | "deny";
export type HostingFirewallDirection = "in" | "out";
export type HostingFirewallAction = "allow" | "deny";
export type HostingFirewallProtocol = "tcp" | "udp" | "icmp";

export interface HostingFirewallRule {
  id: string;
  direction: HostingFirewallDirection;
  action: HostingFirewallAction;
  protocol: HostingFirewallProtocol;
  ports: string;
  addresses: string[];
  description: string;
}

export interface HostingFirewallConfig {
  enabled: boolean;
  inboundPolicy: HostingFirewallPolicy;
  outboundPolicy: HostingFirewallPolicy;
  rules: HostingFirewallRule[];
}

export interface HostingFirewallObservation {
  fingerprint: string;
  enabled: boolean;
  matches: boolean;
  applying: boolean;
  remoteId: string | null;
  blockers: string[];
  disableBlockers?: string[];
  observedAt: string;
}

export interface HostingFirewallUpdate {
  config: HostingFirewallConfig;
  expectedRevision: number;
  expectedFingerprint: string;
  acknowledgeConnectivityRisk: boolean;
}

export interface HostingFirewallView {
  resourceId: string;
  revision: number;
  config: HostingFirewallConfig;
  status: "loading" | "pending" | "applying" | "ready" | "failed";
  observation: HostingFirewallObservation | null;
  error: string | null;
  canEdit: boolean;
}

export interface HostingAdoptionCandidates {
  resources: Array<{
    id: string;
    remoteId: string;
    name: string;
    kind: "vm" | "ct";
    location: string;
  }>;
  nodes: Array<{
    id: string;
    hostname: string;
    displayName: string | null;
    type: string;
    status: string;
  }>;
}
