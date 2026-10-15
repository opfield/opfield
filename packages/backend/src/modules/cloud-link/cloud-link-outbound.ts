import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';

/** How long the installation waits for the account to answer one of its own requests. */
export const CLOUD_OUTBOUND_REQUEST_TIMEOUT_MS = 15_000;
const MAX_PENDING = 64;
const MAX_ANSWER_ID_LENGTH = 200;

/** The account's answer to a request the installation sent (such as mail). */
export type CloudPortalAnswer =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: string; code?: string; retryAt?: string };

/** The socket is not open (the link is down or held by another replica). */
export class CloudLinkOfflineError extends Error {
  constructor(message = 'The cloud link is offline') {
    super(message);
    this.name = 'CloudLinkOfflineError';
  }
}

/** A text frame as the answer to an installation request: an id and ok, and no type; null for anything else. */
export function parseCloudAnswer(text: string): CloudPortalAnswer | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  if ('type' in frame && frame.type !== undefined && frame.type !== null) return null;
  const { id, ok } = frame;
  if (typeof id !== 'string' || !id || id.length > MAX_ANSWER_ID_LENGTH || typeof ok !== 'boolean') return null;
  if (ok) return { id, ok: true, data: frame.data ?? null };
  return {
    id,
    ok: false,
    error: typeof frame.error === 'string' ? frame.error.slice(0, 1000) : 'The account refused the request',
    ...(typeof frame.code === 'string' && frame.code ? { code: frame.code.slice(0, 64) } : {}),
    ...(typeof frame.retryAt === 'string' && frame.retryAt ? { retryAt: frame.retryAt.slice(0, 64) } : {}),
  };
}

interface Pending {
  socket: WebSocket;
  timer: ReturnType<typeof setTimeout>;
  resolve: (answer: CloudPortalAnswer) => void;
  reject: (error: Error) => void;
}

/**
 * Requests the installation sends the account on its socket (`{id, type, params}`), each waiting for the answer
 * frame with the same id. They fail at once when the socket is not open or closes, and after the timeout.
 */
export class CloudOutboundRequests {
  private readonly pending = new Map<string, Pending>();
  private sequence = 0;

  send(
    socket: WebSocket | null,
    type: string,
    params: Record<string, unknown>,
    timeoutMs = CLOUD_OUTBOUND_REQUEST_TIMEOUT_MS
  ): Promise<CloudPortalAnswer> {
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new CloudLinkOfflineError());
    if (this.pending.size >= MAX_PENDING) {
      return Promise.reject(new Error('Too many requests are waiting for the cloud account'));
    }
    this.sequence += 1;
    const id = `i${this.sequence.toString(36)}-${randomBytes(6).toString('hex')}`;
    return new Promise<CloudPortalAnswer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The cloud account did not answer in time'));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { socket, timer, resolve, reject });
      socket.send(JSON.stringify({ id, type, params }), (error) => {
        if (!error) return;
        this.settle(id, () => reject(new CloudLinkOfflineError(`The cloud link could not send: ${error.message}`)));
      });
    });
  }

  /** Resolves the request an answer frame belongs to; false when none waits for it. */
  answer(answer: CloudPortalAnswer): boolean {
    return this.settle(answer.id, (pending) => pending.resolve(answer));
  }

  /** Fails what waits on this socket (or on every socket): it closed. */
  failAll(socket: WebSocket | null, reason: string): void {
    for (const [id, pending] of this.pending) {
      if (socket && pending.socket !== socket) continue;
      this.settle(id, () => pending.reject(new CloudLinkOfflineError(reason)));
    }
  }

  private settle(id: string, finish: (pending: Pending) => void): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    finish(pending);
    return true;
  }
}
