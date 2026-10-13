import type { HostingFirewallAdapter } from './hosting-firewall.types.js';
import type { HostingSnapshotAction, HostingSnapshotAdapter } from './hosting-snapshot.types.js';
/** Hosting adapters contain provider IO only; authorization and durable intents live in services. */
export const HOSTING_PROVIDERS = ['hostkey', 'digitalocean', 'hetzner', 'cloudblast', 'proxmox'] as const;
export type HostingProvider = (typeof HOSTING_PROVIDERS)[number];
export type HostingResourceKind = 'vm' | 'ct';
export type HostingRole = 'nginx' | 'docker' | 'builder' | 'databases' | 'storage' | 'monitoring' | 'relay';
export type HostingPowerState = 'running' | 'stopped' | 'starting' | 'stopping' | 'unknown';
export type HostingAction = 'start' | 'shutdown' | 'reboot' | 'resize' | 'delete' | 'recover';
export type HostingOperationAction = HostingAction | HostingSnapshotAction | 'create' | 'install' | 'topup';
export type HostingOperationPhase =
  | 'pending'
  | 'dispatching'
  | 'provisioning'
  | 'configuring'
  | 'installing'
  | 'enrolling'
  | 'awaiting_payment'
  | 'reconciling'
  | 'ready'
  | 'failed'
  | 'unknown';

export interface HostingSettings {
  kind: 'hosting';
  autoSyncEnabled: boolean;
  autoSyncIntervalSeconds: number;
  /** Resource IDs restrict inventory and mutations; empty means all visible resources. */
  resourceIds: string[];
  /** Node scope for background adoption, captured by an authorized administrator. */
  adoptionNodeIds: string[];
  adoptionEnabled: boolean;
  tokenId?: string;
  caCertificate?: string;
  certificateFingerprint?: string;
  /** Explicit cluster identity for Proxmox; stable across endpoint aliases. */
  clusterId?: string;
  /** Selected physical PVE node, including inventory-only connectors. */
  proxmoxHost?: string;
  defaultLocation?: string;
  defaultSize?: string;
  defaultImage?: string;
  proxmox?: HostingProxmoxProfile;
}

export interface HostingProxmoxProfile {
  nodes: string[];
  /** Legacy accepted operations only; new profiles use canonical images. */
  templateId?: number;
  templateNode?: string;
  storage: string;
  imageStorage?: string;
  seedStorage?: string;
  bridge: string;
  pool?: string;
  /** Operator acknowledgement, combined with clone-time checks. Never mutate the template. */
  cleanTemplate?: boolean;
  network: 'dhcp' | 'static';
  gateway?: string;
  subnet?: string;
  vmidRange?: string;
  ipRange?: string;
  /** Null explicitly configures the untagged network. Undefined preserves legacy template settings. */
  vlan?: number | null;
  dnsServers?: string[];
  searchDomain?: string;
  mtu?: number;
  firewall?: boolean;
  defaultCpu?: number;
  defaultMemoryMb?: number;
  defaultDiskGb?: number;
  maxCpu?: number;
  maxMemoryMb?: number;
  maxDiskGb?: number;
}

export interface HostingProxmoxDiscovery {
  hosts: Array<{ id: string; name: string }>;
  templates: Array<{ id: string; name: string; host: string; ready: boolean; reason?: string; diskGb?: number }>;
  storages: Array<{ id: string; name: string; host: string; content?: string[] }>;
  bridges: Array<{ id: string; name: string; host: string }>;
  clusterName?: string;
  usedVmids: number[];
  /** Internal allocation evidence; the setup endpoint intentionally omits it. */
  usedIps?: string[];
}

export interface HostingConnection {
  provider: HostingProvider;
  baseUrl: string;
  token: string;
  settings: HostingSettings;
  /** Operation runner fences every request, including the final mutation after catalog reads. */
  beforeRequest?: () => Promise<void>;
}

export interface HostingCapability {
  available: boolean;
  reason?: string;
  reasonCode?: 'permission_denied' | 'temporarily_unavailable' | 'unsupported';
}
export type HostingCapabilities = Record<
  HostingAction | 'create' | 'finance' | 'topup' | 'guestIdentity' | 'bootstrap',
  HostingCapability
>;

export interface HostingMoney {
  amount: string;
  currency: string;
  estimated: boolean;
  period?: 'hour' | 'month' | 'billing_period';
}
export interface HostingAddress {
  ip: string;
  mac?: string;
  network?: string;
  /** Provider-assigned address, never an observed NAT egress address. */
  direct: boolean;
}
export interface HostingResourceSnapshot {
  remoteId: string;
  kind: HostingResourceKind;
  name: string;
  location: string;
  powerState: HostingPowerState;
  cpu: number | null;
  memoryMb: number | null;
  diskGb: number | null;
  sizeId?: string;
  imageId?: string;
  addresses: HostingAddress[];
  /** Stable incarnation proof (creation timestamp, UUID, or provider config identity). */
  incarnation: string | null;
  marker?: string;
  providerUrl?: string;
  price?: HostingMoney;
  capabilities: HostingCapabilities;
  observedAt: string;
}
export interface HostingInventory {
  resources: HostingResourceSnapshot[];
  complete: boolean;
  observedAt: string;
}
export interface HostingCatalogOption {
  id: string;
  name: string;
  locations?: string[];
  cpu?: number;
  memoryMb?: number;
  diskGb?: number;
  architecture?: 'x64' | 'arm64';
  operatingSystem?: { distribution: 'ubuntu' | 'debian' | 'fedora'; version: string };
  /** When present, only these provider sizes can use this image; empty means none. */
  compatibleSizes?: string[];
  supportedRoles?: HostingRole[];
  price?: HostingMoney;
  locationPrices?: Record<string, HostingMoney>;
}
export interface HostingCapacity {
  id: string;
  name: string;
  online: boolean;
  memoryTotalMb: number | null;
  memoryUsedMb: number | null;
  diskTotalGb: number | null;
  diskUsedGb: number | null;
}
export interface HostingCatalog {
  locations: HostingCatalogOption[];
  sizes: HostingCatalogOption[];
  images: HostingCatalogOption[];
  capacity?: HostingCapacity[];
}
export interface HostingAccount {
  /** No token-derived identities: credential rotation must not change resource ownership. */
  authority: string;
  name: string;
  capabilities: HostingCapabilities;
}
export interface HostingCreateRequest {
  name: string;
  location: string;
  size: string;
  image: string;
  marker: string;
  userData: string;
  cpu?: number;
  memoryMb?: number;
  diskGb?: number;
  ipConfig?: string;
  sshPublicKey?: string;
  /** Controller-owned history; never reuse a retired Opfield resource identity for a new VM. */
  excludedRemoteIds?: string[];
  /** Reservation chosen at intent acceptance; Proxmox verifies it with /cluster/nextid before cloning. */
  vmid?: number;
  /** Complete profile snapshot; later connector edits must not change an accepted VM. */
  proxmox?: HostingProxmoxProfile;
  /** Pinned catalog identity; no arbitrary URL is accepted. */
  role?: HostingRole;
  /** Last successfully completed provider task, restored by the operation runner only. */
  preparationStage?: 'image' | 'seed' | 'disk' | 'boot' | 'firewall' | 'network' | 'start';
  /** Runtime-only callback. Persists the exact write stage before provider IO. */
  beforePreparation?: (stage: NonNullable<HostingCreateRequest['preparationStage']>) => Promise<void>;
}
export interface HostingActionRequest {
  action: HostingAction;
  size?: string;
  cpu?: number;
  memoryMb?: number;
  diskGb?: number;
  reason?: string;
}
export interface HostingProviderOperation {
  id: string | null;
  resourceId?: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'awaiting_payment';
  error?: string;
  invoiceId?: string;
  preparationStage?: 'image' | 'seed' | 'disk' | 'boot' | 'firewall' | 'network' | 'start';
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
export interface HostingTransaction {
  id: string;
  date: string | null;
  description: string;
  amount: HostingMoney | null;
}
export interface HostingFinance {
  balance: HostingMoney | null;
  usage: HostingMoney | null;
  invoices: HostingInvoice[];
  transactions: HostingTransaction[];
  observedAt: string;
  unavailableReason?: string;
  nextCursor?: string;
}
export interface HostingAccountSummary {
  balance: HostingMoney | null;
  monthlyExpenses: HostingMoney | null;
  observedAt: string;
}

export interface HostingProviderAdapter {
  snapshots?(): HostingSnapshotAdapter;
  firewall?: HostingFirewallAdapter;
  accountSummary?(resources: HostingResourceSnapshot[]): Promise<HostingAccountSummary>;
  readonly provider: HostingProvider;
  test(): Promise<HostingAccount>;
  /** Read-only setup discovery. Only Proxmox implements this capability. */
  discover?(): Promise<HostingProxmoxDiscovery>;
  catalog(): Promise<HostingCatalog>;
  listResources(): Promise<HostingInventory>;
  getResource(remoteId: string): Promise<HostingResourceSnapshot | null>;
  validateCreate?(request: HostingCreateRequest): Promise<void>;
  create(request: HostingCreateRequest): Promise<HostingProviderOperation>;
  /** Proxmox configures the clone and starts it after the clone task completes. */
  prepare?(resource: HostingResourceSnapshot, request: HostingCreateRequest): Promise<HostingProviderOperation>;
  reconcilePreparation?(
    resource: HostingResourceSnapshot,
    request: HostingCreateRequest,
    stage: NonNullable<HostingCreateRequest['preparationStage']>,
    since: number
  ): Promise<HostingProviderOperation | null>;
  /** Remove only the operation-owned bootstrap medium after verified enrollment. */
  cleanupBootstrap?(resource: HostingResourceSnapshot, request: HostingCreateRequest): Promise<void>;
  /**
   * Rewrites the marker metadata an older release wrote on a resource it created (description,
   * label) to the current form. Metadata only, never recreates. Returns whether anything was written.
   */
  rewriteLegacyMarker?(resource: HostingResourceSnapshot): Promise<boolean>;
  /** Providers without user data: delete the one-time SSH install key registered for `marker`. Idempotent. */
  releaseInstallKey?(marker: string): Promise<{ deleted: number }>;
  action(
    resource: HostingResourceSnapshot,
    request: HostingActionRequest,
    resizeProgress?: {
      stage?: string;
      checkpoint(stage: string): Promise<void>;
    }
  ): Promise<HostingProviderOperation>;
  /** Read only. Unknown outcomes must not dispatch again. */
  operation(id: string, resourceId?: string): Promise<HostingProviderOperation>;
  finance?(cursor?: string): Promise<HostingFinance>;
  topup?(amount: string, currency: string, marker: string): Promise<HostingInvoice>;
  invoice?(id: string): Promise<HostingInvoice>;
  /** Read-only order ownership/quote validation, including already paid invoices. */
  orderInvoice?(id: string, marker: string, quote: { amount: string; currency: string }): Promise<HostingInvoice>;
  /** Read-only recovery of an already dispatched order by its exact unique marker. */
  findOrderInvoice?(marker: string): Promise<string | null>;
  /** Validates a single order invoice. Persist the attempt before the one credit mutation. */
  payOrderInvoice?(
    id: string,
    marker: string,
    quote: { amount: string; currency: string },
    beforePayment: (payment: { invoiceId: string; amount: string; currency: string }) => Promise<void>
  ): Promise<void>;
  bootstrap?(resource: HostingResourceSnapshot, script: string): Promise<HostingProviderOperation>;
  guestIdentity?(resource: HostingResourceSnapshot): Promise<string | null>;
}

export function hostingCapabilities(
  enabled: Partial<Record<keyof HostingCapabilities, boolean>>,
  reason = 'Not supported by this provider or resource'
): HostingCapabilities {
  const keys: Array<keyof HostingCapabilities> = [
    'create',
    'start',
    'shutdown',
    'reboot',
    'resize',
    'delete',
    'recover',
    'finance',
    'topup',
    'guestIdentity',
    'bootstrap',
  ];
  return Object.fromEntries(
    keys.map((key) => [key, enabled[key] ? { available: true } : { available: false, reason }])
  ) as HostingCapabilities;
}

export function isHostingProvider(value: string): value is HostingProvider {
  return HOSTING_PROVIDERS.some((provider) => provider === value);
}
