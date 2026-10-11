import WebSocket from 'ws';
import {
  OPERATION_LEASE_PROCESS,
  type OperationLeaseHold,
  type OperationLeaseStore,
  operationLeaseKey,
} from '@/db/operation-lease.js';
import { createChildLogger } from '@/lib/logger.js';
import type { CloudLinkService } from './cloud-link.service.js';
import {
  CLOUD_BACKOFF_BASE_MS,
  CLOUD_BACKOFF_MAX_MS,
  CLOUD_MAX_CONCURRENT_REQUESTS,
  CLOUD_REQUEST_TIMEOUT_MS,
  CLOUD_SOCKET_IDLE_TIMEOUT_MS,
  type CloudAnswer,
  type CloudCredentials,
  type CloudLinkProbe,
  type CloudRequest,
  type CloudRequestAudit,
  type CloudSocketState,
  type CloudSocketStatus,
} from './cloud-link.types.js';
import { CloudRequestAuditCoalescer } from './cloud-link-request-audit.js';
import { answerCloudRequest, parseCloudRequest } from './cloud-link-requests.js';

const logger = createChildLogger('CloudLinkAgent');

/** One cloud link per installation: the replica holding this lease runs the socket. */
const LEASE_KEY = operationLeaseKey('cloud-link', 'agent');
const DEFAULT_TICK_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const MAX_INBOUND_FRAME_BYTES = 1024 * 1024;

/** Reconnect delay after `attempt` failed attempts: 1 s doubling up to 60 s, with jitter (half to the full delay). */
export function cloudBackoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(CLOUD_BACKOFF_MAX_MS, CLOUD_BACKOFF_BASE_MS * 2 ** Math.min(Math.max(0, attempt), 16));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/** `https://portal` → `wss://portal/api/cloud/agent` (a path prefix of the portal URL is kept). */
export function cloudAgentSocketUrl(portalUrl: string): string {
  const url = new URL(`${portalUrl.replace(/\/+$/, '')}/api/cloud/agent`);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  return url.toString();
}

/** The status code of a refused upgrade, from the error `ws` reports for it. */
function rejectedStatusOf(error: Error): number | null {
  const match = /Unexpected server response: (\d{3})/.exec(error.message);
  return match ? Number(match[1]) : null;
}

/** The audit details of one served request: what was asked, and how it was answered. */
export function cloudRequestAudit(
  request: CloudRequest,
  answer: CloudAnswer,
  resultBytes: number,
  durationMs: number
): CloudRequestAudit {
  const { service, tail, since } = request.params;
  return {
    requestId: request.id,
    type: request.type.slice(0, 64),
    ...(typeof service === 'string' ? { service: service.slice(0, 128) } : {}),
    ...(typeof tail === 'number' && Number.isFinite(tail) ? { tail } : {}),
    ...(typeof since === 'string' && since ? { since: since.slice(0, 64) } : {}),
    ok: answer.ok,
    ...(answer.ok ? {} : { error: answer.error.slice(0, 500) }),
    resultBytes,
    durationMs: Math.round(durationMs),
  };
}

function sameCredentials(a: CloudCredentials, b: CloudCredentials): boolean {
  return a.agentId === b.agentId && a.secret === b.secret && a.portalUrl === b.portalUrl;
}

/**
 * Keeps the installation's one outbound socket to the cloud account: elected through an operation lease so only one
 * replica holds it, reconnects with backoff, stops for good on a 401 (the account revoked the agent), and answers the
 * portal's state, logs and services requests.
 */
export class CloudLinkAgent {
  private running = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  private tickAgain = false;
  private leaseToken: string | null = null;
  private leaseHold: OperationLeaseHold | null = null;
  private socket: WebSocket | null = null;
  private credentials: CloudCredentials | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private status: CloudSocketStatus | null = null;
  private inFlight = 0;
  private unsubscribe: (() => void) | null = null;
  private readonly requestAudit: CloudRequestAuditCoalescer;

  constructor(
    private readonly service: CloudLinkService,
    private readonly leases: OperationLeaseStore,
    private readonly probe: CloudLinkProbe,
    private readonly options: { tickMs?: number } = {}
  ) {
    this.requestAudit = new CloudRequestAuditCoalescer((agentId, audit) => this.service.recordRequest(agentId, audit));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.service.setLocalSocketStatusReader(() => (this.leaseToken ? this.status : null));
    this.service.setLiveRequestWindowsReader(() => this.requestAudit.live());
    this.unsubscribe = this.service.onEnrollmentChanged(() => this.kick());
    this.tickTimer = setInterval(() => this.kick(), this.options.tickMs ?? DEFAULT_TICK_MS);
    this.tickTimer.unref?.();
    this.kick();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.ticking?.catch(() => undefined);
    this.closeSocket(1001, 'Gateway is stopping');
    this.credentials = null;
    this.service.setLocalSocketStatusReader(null);
    this.service.setLiveRequestWindowsReader(null);
    await this.requestAudit.flush();
    await this.releaseLease();
  }

  /** Runs a reconciliation now, or right after the one in progress. */
  private kick(): void {
    if (!this.running) return;
    if (this.ticking) {
      this.tickAgain = true;
      return;
    }
    this.ticking = this.tick()
      .catch((error) => {
        logger.warn('Cloud link reconciliation failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.ticking = null;
        if (this.tickAgain) {
          this.tickAgain = false;
          this.kick();
        }
      });
  }

  private async tick(): Promise<void> {
    const credentials = await this.service.readCredentials();
    if (!credentials || !this.running) {
      this.closeSocket(1000, 'Disconnected');
      this.credentials = null;
      this.status = null;
      await this.releaseLease();
      return;
    }
    if (!(await this.holdLease())) {
      this.closeSocket(1000, 'Another replica holds the cloud link');
      this.credentials = null;
      this.status = null;
      return;
    }
    if (!this.credentials || !sameCredentials(this.credentials, credentials)) {
      this.closeSocket(1000, 'Enrolment changed');
      this.credentials = credentials;
      this.attempt = 0;
      this.setStatus('connecting', null);
      this.connect();
    } else if (!this.socket && !this.reconnectTimer) {
      this.connect();
    }
    if (this.status) await this.service.publishSocketStatus(this.status);
  }

  private async holdLease(): Promise<boolean> {
    if (this.leaseHold && !this.leaseHold.lost) return true;
    this.leaseHold?.stop();
    this.leaseHold = null;
    this.leaseToken = null;
    const claim = await this.leases.claim(
      [LEASE_KEY],
      {},
      {
        // A restart of this same process (same host and pid) may find its own lease still live.
        replaceable: (lease) => lease.holder === OPERATION_LEASE_PROCESS,
      }
    );
    if (!claim.acquired) return false;
    this.leaseToken = claim.token;
    this.leaseHold = this.leases.hold(
      () => [LEASE_KEY],
      claim.token,
      () => {
        logger.warn('Another replica took over the cloud link');
        this.closeSocket(1000, 'Another replica holds the cloud link');
        this.credentials = null;
        this.status = null;
      },
      { since: claim.claimedAt }
    );
    return true;
  }

  private async releaseLease(): Promise<void> {
    const hold = this.leaseHold;
    const token = this.leaseToken;
    this.leaseHold = null;
    this.leaseToken = null;
    hold?.stop();
    if (token) await this.leases.release([LEASE_KEY], token).catch(() => undefined);
  }

  private setStatus(state: CloudSocketState, lastError: string | null): void {
    if (!this.credentials) return;
    const since = this.status?.state === state ? this.status.since : new Date().toISOString();
    this.status = { state, since, lastError, agentId: this.credentials.agentId };
    void this.service.publishSocketStatus(this.status);
  }

  private connect(): void {
    const credentials = this.credentials;
    if (!this.running || !credentials || this.socket) return;
    this.clearReconnect();
    let socket: WebSocket;
    try {
      socket = new WebSocket(cloudAgentSocketUrl(credentials.portalUrl), {
        headers: { Authorization: `Bearer ${credentials.agentId}.${credentials.secret}` },
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        maxPayload: MAX_INBOUND_FRAME_BYTES,
        followRedirects: false,
        perMessageDeflate: false,
      });
    } catch (error) {
      this.scheduleReconnect(error instanceof Error ? error.message : String(error));
      return;
    }
    this.socket = socket;
    let lastError: string | null = null;
    let revoked = false;

    socket.on('open', () => {
      this.attempt = 0;
      this.setStatus('online', null);
      this.armIdleTimer(socket);
      logger.info('Cloud link socket is online');
      void this.service
        .helloInfo()
        .then((hello) => this.send(socket, { type: 'hello', ...hello }))
        .catch((error) =>
          logger.warn('Could not send the cloud link hello', {
            error: error instanceof Error ? error.message : String(error),
          })
        );
    });
    socket.on('ping', () => this.armIdleTimer(socket));
    socket.on('message', (data, isBinary) => {
      this.armIdleTimer(socket);
      if (isBinary) return;
      const request = parseCloudRequest(data.toString());
      if (request) void this.handleRequest(socket, request);
    });
    socket.on('error', (error) => {
      const status = rejectedStatusOf(error);
      if (status === 401) revoked = true;
      lastError = status ? `Your cloud account refused the connection (HTTP ${status})` : error.message;
    });
    socket.on('close', (code) => {
      if (this.socket === socket) this.socket = null;
      this.clearIdleTimer();
      // The socket stopped: the repeated reads it counted are written as their summaries now.
      void this.requestAudit.flush();
      if (this.credentials?.agentId !== credentials.agentId || !this.running) return;
      if (revoked) {
        logger.warn('The cloud account refused the agent; the cloud link stops');
        this.credentials = null;
        this.status = null;
        void this.service.markDisconnectedByAccount(credentials.agentId).catch((error) =>
          logger.warn('Could not record the disconnect by the cloud account', {
            error: error instanceof Error ? error.message : String(error),
          })
        );
        return;
      }
      this.scheduleReconnect(lastError ?? `The socket closed (code ${code})`);
    });
  }

  private scheduleReconnect(reason: string): void {
    if (!this.running || !this.credentials || this.reconnectTimer) return;
    const delay = cloudBackoffDelay(this.attempt);
    this.attempt += 1;
    this.setStatus('reconnecting', reason);
    logger.debug('Cloud link reconnects', { delayMs: delay, reason });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** The portal pings every 25 s; without any frame for a while the connection is dead and is replaced. */
  private armIdleTimer(socket: WebSocket): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.socket === socket) socket.terminate();
    }, CLOUD_SOCKET_IDLE_TIMEOUT_MS);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private closeSocket(code: number, reason: string): void {
    this.clearReconnect();
    this.clearIdleTimer();
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    void this.requestAudit.flush();
    socket.removeAllListeners('close');
    socket.on('error', () => undefined);
    if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
    else socket.terminate();
  }

  private async handleRequest(socket: WebSocket, request: CloudRequest) {
    const agentId = this.credentials?.agentId;
    const startedAt = performance.now();
    let answer: CloudAnswer;
    if (this.inFlight >= CLOUD_MAX_CONCURRENT_REQUESTS) {
      answer = { id: request.id, ok: false, error: 'The installation is busy answering other requests' };
    } else {
      this.inFlight += 1;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        answer = await Promise.race<CloudAnswer>([
          answerCloudRequest(this.probe, request),
          new Promise<CloudAnswer>((resolve) => {
            timer = setTimeout(
              () => resolve({ id: request.id, ok: false, error: 'The installation did not finish reading in time' }),
              CLOUD_REQUEST_TIMEOUT_MS
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
        this.inFlight -= 1;
      }
    }
    const resultBytes = this.send(socket, answer);
    if (agentId) {
      this.requestAudit.record(agentId, cloudRequestAudit(request, answer, resultBytes, performance.now() - startedAt));
    }
  }

  /** Sends one JSON frame; returns its size in bytes (also when the socket closed meanwhile and it was not sent). */
  private send(socket: WebSocket, message: unknown): number {
    const text = JSON.stringify(message);
    const bytes = Buffer.byteLength(text);
    if (socket.readyState !== WebSocket.OPEN) return bytes;
    socket.send(text, (error) => {
      if (error) logger.debug('Could not send on the cloud link socket', { error: error.message });
    });
    return bytes;
  }
}
