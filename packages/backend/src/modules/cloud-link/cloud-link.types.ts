/** Code alphabet of the account portal: A–Z without I and O, digits 2–9. */
export const CLOUD_CODE_ALPHABET = /^[A-HJ-NP-Z2-9]{8}$/;
export const CLOUD_ENROLL_TIMEOUT_MS = 15_000;
export const CLOUD_DISCONNECT_TIMEOUT_MS = 10_000;
/** Reconnect backoff: 1 s doubling up to 60 s, with jitter. */
export const CLOUD_BACKOFF_BASE_MS = 1_000;
export const CLOUD_BACKOFF_MAX_MS = 60_000;
/** The portal pings every 25 s; a socket without a ping or message for this long is considered dead. */
export const CLOUD_SOCKET_IDLE_TIMEOUT_MS = 70_000;
/** The portal waits 15 s per request; answer a little earlier so the answer still arrives. */
export const CLOUD_REQUEST_TIMEOUT_MS = 14_000;
export const CLOUD_MAX_CONCURRENT_REQUESTS = 8;
export const CLOUD_LOG_TAIL_MAX = 2_000;
export const CLOUD_LOG_TAIL_DEFAULT = 300;
export const CLOUD_LOG_LINE_MAX_CHARS = 8_000;

export interface EncryptedCloudSecret {
  encryptedKey: string;
  encryptedDek: string;
}

/** The enrolment as stored in settings; the secret is encrypted at rest. */
export interface StoredCloudEnrollment {
  agentId: string;
  secret: EncryptedCloudSecret;
  portalUrl: string;
  accountEmail: string;
  enrolledAt: string;
  /** Enrolled automatically from the provisioning file of a managed cloud VM. */
  managed?: boolean;
}

/** The admin's "Allow remote management" switch; reset whenever the enrolment changes. */
export interface StoredRemoteManagement {
  enabled: boolean;
  changedAt: string;
  changedBy: string | null;
  /** The agent the switch was turned on for. */
  agentId: string;
}

/** Left behind when the account revoked the agent (a 401 on the socket). */
export interface StoredCloudDisconnect {
  accountEmail: string | null;
  portalUrl: string;
  disconnectedAt: string;
  reason: string;
}

export interface CloudCredentials {
  agentId: string;
  secret: string;
  portalUrl: string;
}

export type CloudSocketState = 'connecting' | 'online' | 'reconnecting';

export interface CloudSocketStatus {
  state: CloudSocketState;
  since: string;
  lastError: string | null;
  /** Agent the state belongs to, so a state of a replaced enrolment is not shown. */
  agentId: string;
}

export type CloudLinkState = 'not_connected' | 'connected' | 'disconnected_by_account';

export interface CloudLinkStatusView {
  state: CloudLinkState;
  /** The enrolled portal, or the configured one while not connected. */
  portalUrl: string;
  accountEmail: string | null;
  connectedSince: string | null;
  socket: { state: CloudSocketState; since: string | null; lastError: string | null } | null;
  disconnectedAt: string | null;
  disconnectedReason: string | null;
  /** Connected only: who may run privileged requests (node tokens, updates, setup codes). */
  remoteManagement: CloudRemoteManagement | null;
  /** The latest portal requests the link served (connected only), newest first. */
  recentRequests: CloudRequestSummary[];
}

/** What the audit log keeps of one portal request (details of a `cloud.request` entry). */
export interface CloudRequestAudit {
  requestId: string;
  type: string;
  service?: string;
  tail?: number;
  since?: string;
  /** `name` of a node-token request, `version` of an update request. */
  name?: string;
  version?: string;
  /** `kind` of a node-token request. */
  kind?: string;
  ok: boolean;
  error?: string;
  /** Machine-readable reason of a refusal, such as REMOTE_MANAGEMENT_OFF. */
  errorCode?: string;
  /** Size of the JSON answer sent back, in bytes (all repeats together in a summary). */
  resultBytes: number;
  durationMs?: number;
  /** On the entry of a first read: identical reads in this window are counted, not written one by one. */
  coalescingWindowMs?: number;
  /** A summary of the identical successful reads that followed a first read within its window. */
  summary?: {
    count: number;
    firstAt: string;
    lastAt: string;
    windowStartedAt: string;
    /** Request id of the first read, which has its own entry. */
    openedBy: string;
    firstRequestId: string;
    lastRequestId: string;
  };
}

export interface CloudRequestSummary {
  at: string;
  type: string;
  service: string | null;
  ok: boolean;
  error: string | null;
  resultBytes: number | null;
  /** Reads this entry stands for: 1, or the repeats a summary counted (plus those still counting on the first read). */
  count: number;
  /** The latest read the entry covers, when it covers more than one. */
  lastAt: string | null;
}

export interface CloudDisconnectResult extends CloudLinkStatusView {
  /** Set when the account could not confirm the disconnect; the link was forgotten here anyway. */
  warning?: string;
}

/** A request from the portal over the socket. */
export interface CloudRequest {
  id: string;
  type: string;
  params: Record<string, unknown>;
}

export type CloudAnswer =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: string; code?: string };

/** Request kinds that act on the installation; they need remote management (see CloudLinkAccess). */
export const CLOUD_PRIVILEGED_REQUEST_TYPES: ReadonlySet<string> = new Set([
  'node-token',
  'update',
  'setup-link',
  'sso-secret',
]);
/** Privileged kinds only a managed cloud VM answers; "Allow remote management" does not open them. */
export const CLOUD_MANAGED_ONLY_REQUEST_TYPES: ReadonlySet<string> = new Set(['sso-secret']);
export const NOT_MANAGED_BY_CLOUD = {
  code: 'NOT_MANAGED_BY_CLOUD',
  error: 'Only an installation managed by the cloud accepts this request',
} as const;
export const REMOTE_MANAGEMENT_OFF = {
  code: 'REMOTE_MANAGEMENT_OFF',
  error: 'Remote management is off on this installation',
} as const;

/** Whether the cloud account may run privileged requests: a managed cloud VM, or the admin allowed it. */
export interface CloudLinkAccess {
  privilegedAllowed(): Promise<boolean>;
  /** A managed cloud VM (enrolled from its provisioning file). */
  managedByCloud(): Promise<boolean>;
}

export interface CloudRemoteManagement {
  /** Enrolled automatically as a managed cloud VM: always managed by the cloud. */
  managed: boolean;
  /** The admin's "Allow remote management" switch (off by default). */
  enabled: boolean;
}

export interface CloudServiceState {
  name: string;
  state: string;
  health: string | null;
  startedAt: string | null;
}

export interface CloudStateData {
  hostname: string;
  uptimeSeconds: number;
  version: string;
  cpu: { cores: number; usage: number };
  load: [number, number, number];
  memory: { totalBytes: number; usedBytes: number };
  disk: { path: string; totalBytes: number; usedBytes: number } | null;
  services: CloudServiceState[];
  /** Why `services` is empty when the installation's containers cannot be listed. */
  servicesError?: string;
}

export interface CloudLogLine {
  t: string;
  stream: 'stdout' | 'stderr';
  line: string;
}

/** Node types Nodes → Add node offers, by their identifiers. */
export const CLOUD_NODE_KINDS = ['nginx', 'docker', 'builder', 'storage', 'monitoring', 'relay'] as const;
export type CloudNodeKind = (typeof CLOUD_NODE_KINDS)[number];
export const DEFAULT_CLOUD_NODE_KIND: CloudNodeKind = 'nginx';
export const DEFAULT_RELAY_SERVICE_PORT = 9443;

/** The kind a node-token request names; `databases` is the former name of `storage`, as Add node reads it. */
export function resolveCloudNodeKind(kind: unknown): CloudNodeKind | null {
  if (kind === undefined || kind === null || kind === '') return DEFAULT_CLOUD_NODE_KIND;
  if (typeof kind !== 'string') return null;
  const value = kind.trim().toLowerCase();
  if (value === 'databases') return 'storage';
  return (CLOUD_NODE_KINDS as readonly string[]).includes(value) ? (value as CloudNodeKind) : null;
}

/** What the cloud account may do over the link besides reading. */
export interface CloudLinkActions {
  /** A new first-admin setup code; fails with "already set up" once an admin exists. */
  setupLink(): Promise<{ code: string; expiresAt: string }>;
  /** A one-time node enrolment token and the install command, as Nodes → Add node produces. */
  nodeToken(options: {
    name?: string;
    kind?: string;
    /** Relay only: the address and port it advertises, as Add node asks for them. */
    address?: string;
    port?: number;
  }): Promise<{ token: string; expiresAt: string; command: string; nodeId: string; kind: CloudNodeKind }>;
  updateStatus(): Promise<{
    current: string;
    latest: string | null;
    channel: string;
    available: boolean;
    updating: boolean;
  }>;
  /** Starts the same update as Settings → Update now (default: the latest version). */
  update(version?: string): Promise<{ started: true; version: string }>;
  /** Stores (encrypted) a new client secret of the Opfield account sign-in provider; answers once saved. */
  ssoSecret(clientSecret: string): Promise<{ saved: true }>;
}

/** Request kinds that only read; identical successful reads share one audit entry. Actions never do. */
export const CLOUD_READ_REQUEST_TYPES: ReadonlySet<string> = new Set(['state', 'logs', 'services', 'update-status']);

/** What the socket requests read and do: the installation's own host, containers and the actions above. */
export interface CloudLinkProbe extends CloudLinkActions {
  state(): Promise<CloudStateData>;
  services(): Promise<string[]>;
  logs(service: string, options: { tail: number; sinceMs?: number }): Promise<CloudLogLine[]>;
}
