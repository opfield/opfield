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
  ok: boolean;
  error?: string;
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

export type CloudAnswer = { id: string; ok: true; data: unknown } | { id: string; ok: false; error: string };

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

/** What the socket requests read: the installation's own host and containers. */
export interface CloudLinkProbe {
  state(): Promise<CloudStateData>;
  services(): Promise<string[]>;
  logs(service: string, options: { tail: number; sinceMs?: number }): Promise<CloudLogLine[]>;
}
