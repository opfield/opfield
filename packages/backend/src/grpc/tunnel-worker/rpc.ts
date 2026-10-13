/**
 * Requests, replies and notices between Gateway's main thread and its tunnel worker over one MessagePort. Control
 * only: tunnel bytes never cross it (the loopback listeners and the relay channels both live in the worker).
 */

export interface RpcPortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  off?(event: 'message', listener: (message: unknown) => void): unknown;
  close?(): void;
  unref?(): void;
}

type Message =
  | { t: 'req'; id: number; op: string; args: unknown }
  | { t: 'res'; id: number; ok: true; value: unknown }
  | { t: 'res'; id: number; ok: false; error: RpcErrorShape }
  | { t: 'evt'; op: string; args: unknown };

/** An error as it crosses the port: what callers on the other side look at. */
export interface RpcErrorShape {
  name: string;
  message: string;
  code?: string | number;
  rstCode?: number;
  /** ResumeSessionError 'legacy_peer': the key id the route is latched with. */
  latchKeyId?: string;
}

export class RpcError extends Error {
  readonly code?: string | number;
  constructor(shape: RpcErrorShape) {
    super(shape.message);
    this.name = shape.name || 'Error';
    if (shape.code !== undefined) this.code = shape.code;
  }
}

export function toErrorShape(error: unknown): RpcErrorShape {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
  const shape: RpcErrorShape = { name: error.constructor?.name || error.name, message: error.message };
  const extra = error as { code?: unknown; rstCode?: unknown; latchKeyId?: unknown };
  if (typeof extra.code === 'string' || typeof extra.code === 'number') shape.code = extra.code;
  if (typeof extra.rstCode === 'number') shape.rstCode = extra.rstCode;
  if (typeof extra.latchKeyId === 'string') shape.latchKeyId = extra.latchKeyId;
  return shape;
}

type Handler = (args: any) => unknown;

export class RpcPort {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void }>();
  private readonly handlers = new Map<string, Handler>();
  private readonly listeners = new Map<string, Handler>();
  private closed = false;
  private readonly onMessage = (message: unknown) => this.receive(message as Message);

  constructor(
    private readonly port: RpcPortLike,
    /** Builds the error a failed request rejects with (the host turns RSv1 errors back into ResumeSessionError). */
    private readonly reviveError: (shape: RpcErrorShape) => Error = (shape) => new RpcError(shape)
  ) {
    port.on('message', this.onMessage);
  }

  /** Answers requests named `op`. */
  handle(op: string, handler: Handler): void {
    this.handlers.set(op, handler);
  }

  /** Receives notices named `op`. */
  listen(op: string, listener: Handler): void {
    this.listeners.set(op, listener);
  }

  call<T = unknown>(op: string, args?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Opfield tunnel worker is not running'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.port.postMessage({ t: 'req', id, op, args } satisfies Message);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  emit(op: string, args?: unknown): void {
    if (this.closed) return;
    try {
      this.port.postMessage({ t: 'evt', op, args } satisfies Message);
    } catch {
      // The other side is gone.
    }
  }

  /** Fails every request still waiting (the other side exited) and stops listening. */
  close(reason = 'Opfield tunnel worker stopped'): void {
    if (this.closed) return;
    this.closed = true;
    this.port.off?.('message', this.onMessage);
    for (const { reject } of this.pending.values()) reject(new Error(reason));
    this.pending.clear();
  }

  private receive(message: Message): void {
    if (!message || typeof message !== 'object') return;
    if (message.t === 'res') {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.ok) waiter.resolve(message.value);
      else waiter.reject(this.reviveError(message.error));
      return;
    }
    if (message.t === 'evt') {
      try {
        this.listeners.get(message.op)?.(message.args);
      } catch {
        // A notice has no one to answer.
      }
      return;
    }
    if (message.t === 'req') void this.answer(message.id, message.op, message.args);
  }

  private async answer(id: number, op: string, args: unknown): Promise<void> {
    const handler = this.handlers.get(op);
    let reply: Message;
    try {
      if (!handler) throw new Error(`Unknown tunnel worker request ${op}`);
      reply = { t: 'res', id, ok: true, value: await handler(args) };
    } catch (error) {
      reply = { t: 'res', id, ok: false, error: toErrorShape(error) };
    }
    if (this.closed) return;
    try {
      this.port.postMessage(reply);
    } catch {
      // The other side is gone.
    }
  }
}

/** A Buffer over bytes that crossed the port (structured clone turns Buffers into plain Uint8Arrays). */
export function asBuffer(value: Uint8Array | Buffer): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
