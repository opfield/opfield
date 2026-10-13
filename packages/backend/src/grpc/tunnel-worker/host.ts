import net from 'node:net';
import { MessageChannel, Worker } from 'node:worker_threads';
import type {
  ClientIdentity,
  RelayControlClient,
  RelayTunnelCandidate,
  SignedRelayGrant,
} from '../relay-control.client.js';
import {
  type MigrationTrigger,
  RelayResumeRegistry,
  type RelayResumeStatsSnapshot,
  ResumeSessionError,
  type ResumeTimers,
  realTimers,
} from '../relay-resume.js';
import { RelayTunnelEngine } from './engine.js';
import type {
  RemotePath,
  StreamView,
  TunnelWorkerData,
  WireDialResult,
  WireOpen,
  WireResumeConfig,
  WorkerLog,
} from './protocol.js';
import { RpcError, type RpcErrorShape, RpcPort } from './rpc.js';

export type { RemotePath } from './protocol.js';

/** One of Opfield's resumable streams as the returner sees it (it lives in the tunnel worker). */
export interface OpfieldStream {
  readonly routeId: string;
  readonly relayId: string | null;
  readonly movable: boolean;
  readonly lastMoveAt: number;
  /** A planned move; `fromRelayId`: the relay it leaves, the move is dropped once the stream is elsewhere. */
  migrate(trigger: MigrationTrigger, fromRelayId?: string | null): Promise<void>;
}

/** What OpfieldRelayPaths needs of the streams: list them, pace moves, its clock. */
export interface OpfieldStreamRegistry {
  liveSessions(): Iterable<OpfieldStream> | Promise<Iterable<OpfieldStream>>;
  schedule(task: () => Promise<unknown>): void;
  readonly timers: ResumeTimers;
}

export type OpenedRemotePath = { path: RemotePath; keyId?: string; key?: Buffer };
export type RemoteDialer = (avoidRelayId: string | null) => Promise<OpenedRemotePath>;
export type TunnelOpen =
  | { kind: 'local'; grant: SignedRelayGrant; relayId: string }
  | { kind: 'candidate'; candidate: RelayTunnelCandidate & { relayInstanceId: string } };

export interface RelayTunnelHostOptions {
  log?: (entry: WorkerLog) => void;
}

const EMPTY_STATS: RelayResumeStatsSnapshot = {
  sessions: { resumable: 0, legacy: 0 },
  byRelay: {},
  suspended: 0,
  unackedBytes: 0,
  migrations: {},
  migrationStallMs: { p50: 0, p95: 0 },
  retransmittedBytes: 0,
  windowBlockedMs: 0,
};

const RESTART_MIN_MS = 500;
const RESTART_MAX_MS = 30_000;

function reviveError(shape: RpcErrorShape): Error {
  if (shape.name === 'ResumeSessionError') {
    const error = new ResumeSessionError(
      shape.message,
      shape.code as ResumeSessionError['code'],
      shape.rstCode
    ) as ResumeSessionError & { latchKeyId?: string };
    if (shape.latchKeyId !== undefined) error.latchKeyId = shape.latchKeyId;
    return error;
  }
  return new RpcError(shape);
}

function wireOpen(open: TunnelOpen): WireOpen {
  return open.kind === 'local'
    ? { kind: 'local', grant: open.grant, relayId: open.relayId }
    : {
        kind: 'candidate',
        candidate: {
          addresses: open.candidate.addresses,
          port: open.candidate.port,
          certificateIdentity: open.candidate.certificateIdentity,
          certificateFingerprint: open.candidate.certificateFingerprint,
          grant: open.candidate.grant,
          relayInstanceId: open.candidate.relayInstanceId,
        },
      };
}

interface Runner {
  rpc: RpcPort;
  stop(): Promise<void>;
}

/**
 * The main thread's side of Opfield's tunnel worker: starts it (again after a crash), and offers the tunnel
 * operations RelayPolicyService orchestrates — loopback endpoints, relay paths, resumable and raw tunnels bound to a
 * connection, probes, drains — plus the stream counts and the legacy latch, without any tunnel byte on this thread.
 */
export class RelayTunnelHost {
  private runner: Runner | null = null;
  private readonly dials = new Map<number, RemoteDialer>();
  private nextDialId = 1;
  private stats: RelayResumeStatsSnapshot = EMPTY_STATS;
  /** The legacy latch lives here: the main thread decides between resumable and raw streams. */
  private readonly latch = new RelayResumeRegistry();
  private acceptHandler: ((key: string, slotId: string) => void) | null = null;
  private readonly resetHandlers = new Set<() => void>();
  private restartDelay = RESTART_MIN_MS;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly unsubscribe: Array<() => void> = [];

  private constructor(
    private readonly start: (host: RelayTunnelHost) => Runner,
    private readonly options: RelayTunnelHostOptions
  ) {
    this.runner = start(this);
  }

  /** The data plane in a worker thread (production). */
  static inWorker(client: RelayControlClient, options: RelayTunnelHostOptions = {}): RelayTunnelHost {
    const host = new RelayTunnelHost((self) => self.spawn(client), options);
    host.unsubscribe.push(
      client.onIdentityChange((identity: ClientIdentity) => {
        void host.runner?.rpc.call('identity', identity).catch(() => undefined);
      }),
      client.onReconnect(() => {
        void host.runner?.rpc.call('reconnect').catch(() => undefined);
      })
    );
    return host;
  }

  /** The same engine on this thread over a MessageChannel (tests; a client without a worker). */
  static inThread(client: ConstructorParameters<typeof RelayTunnelEngine>[1], options: RelayTunnelHostOptions = {}) {
    return new RelayTunnelHost((self) => {
      const channel = new MessageChannel();
      const engine = new RelayTunnelEngine(new RpcPort(channel.port2), client, false);
      const rpc = self.connect(channel.port1);
      channel.port1.unref();
      channel.port2.unref();
      return {
        rpc,
        stop: async () => {
          engine.shutdown();
          rpc.close();
          channel.port1.close();
        },
      };
    }, options);
  }

  private connect(port: ConstructorParameters<typeof RpcPort>[0]): RpcPort {
    const rpc = new RpcPort(port, reviveError);
    rpc.listen('accept', ({ key, slotId }: { key: string; slotId: string }) => {
      if (this.acceptHandler) this.acceptHandler(key, slotId);
      else void rpc.call('slot.fail', { slotId, message: 'Opfield relay is unavailable' }).catch(() => undefined);
    });
    rpc.listen('released', ({ dialId }: { dialId: number }) => this.dials.delete(dialId));
    rpc.listen('stats', (stats: RelayResumeStatsSnapshot) => {
      this.stats = stats;
    });
    rpc.listen('log', (entry: WorkerLog) => this.options.log?.(entry));
    rpc.handle('dial', async ({ dialId, avoidRelayId }: { dialId: number; avoidRelayId: string | null }) => {
      const dial = this.dials.get(dialId);
      if (!dial) throw new Error('The relay stream is gone');
      const opened = await dial(avoidRelayId);
      const result: WireDialResult = { pathId: opened.path.pathId };
      if (opened.keyId && opened.key) {
        result.keyId = opened.keyId;
        result.key = opened.key;
      }
      return result;
    });
    return rpc;
  }

  private spawn(client: RelayControlClient): Runner {
    const settings = client.tunnelClientSettings();
    const data: TunnelWorkerData = {
      target: settings.target,
      systemCaPath: settings.systemCaPath,
      identity: settings.identity,
    };
    // The build runs the compiled entry next to this file; development (tsx, tests) registers tsx in the worker first.
    const worker = import.meta.url.endsWith('.ts')
      ? new Worker(
          `import('tsx/esm/api').then(({ register }) => { register(); return import(${JSON.stringify(
            new URL('./worker.ts', import.meta.url).href
          )}); });`,
          { eval: true, workerData: data, name: 'opfield-tunnels' }
        )
      : new Worker(new URL('./worker.js', import.meta.url), { workerData: data, name: 'opfield-tunnels' });
    worker.unref();
    const rpc = this.connect(worker);
    let stopping = false;
    rpc.listen('ready', () => {
      this.restartDelay = RESTART_MIN_MS;
      this.options.log?.({
        level: 'info',
        message: 'Opfield tunnel worker started',
        meta: { threadId: worker.threadId },
      });
    });
    worker.on('error', (error) => {
      this.options.log?.({
        level: 'error',
        message: 'Opfield tunnel worker failed',
        meta: { error: error instanceof Error ? error.message : String(error) },
      });
    });
    worker.once('exit', (code) => {
      rpc.close('Opfield tunnel worker exited');
      if (stopping || this.closed) return;
      this.options.log?.({
        level: 'error',
        message: 'Opfield tunnel worker exited; starting it again',
        meta: { code },
      });
      this.reset();
      this.runner = null;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (!this.closed) this.runner = this.start(this);
      }, this.restartDelay);
      this.restartTimer.unref?.();
      this.restartDelay = Math.min(RESTART_MAX_MS, this.restartDelay * 2);
    });
    return {
      rpc,
      stop: async () => {
        stopping = true;
        await rpc.call('shutdown').catch(() => undefined);
        rpc.close();
        await worker.terminate().catch(() => undefined);
      },
    };
  }

  /** The worker restarted: its endpoints, connections and streams are gone. */
  private reset(): void {
    this.dials.clear();
    this.stats = EMPTY_STATS;
    for (const handler of this.resetHandlers) {
      try {
        handler();
      } catch {
        // Every owner forgets its endpoints on its own.
      }
    }
  }

  private rpc(): RpcPort {
    if (!this.runner) throw new Error('Opfield tunnel worker is restarting');
    return this.runner.rpc;
  }

  private call<T>(op: string, args?: unknown): Promise<T> {
    try {
      return this.rpc().call<T>(op, args);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Called for every connection to an endpoint; the handler binds a tunnel to the slot or fails it. */
  onAccept(handler: (key: string, slotId: string) => void): void {
    this.acceptHandler = handler;
  }

  /** Called when the worker restarted (endpoints must be created again). */
  onReset(handler: () => void): void {
    this.resetHandlers.add(handler);
  }

  async createEndpoint(key: string): Promise<number> {
    return (await this.call<{ port: number }>('endpoint.create', { key })).port;
  }

  async disposeEndpoint(key: string): Promise<void> {
    await this.call('endpoint.dispose', { key }).catch(() => undefined);
  }

  openLocalResumePath(grant: SignedRelayGrant, relayId: string): Promise<RemotePath> {
    return this.call<RemotePath>('path.open', wireOpen({ kind: 'local', grant, relayId }));
  }

  openCandidateResumePath(candidate: RelayTunnelCandidate & { relayInstanceId: string }): Promise<RemotePath> {
    return this.call<RemotePath>('path.open', wireOpen({ kind: 'candidate', candidate }));
  }

  /**
   * Opens a resumable stream for the connection in `slotId`; every path comes from `dial`. Rejects with a
   * ResumeSessionError 'legacy_peer' (and latches the route) when the target is not resume-aware.
   */
  async bindResumable(
    slotId: string,
    config: { routeId: string; keyId: string; key: Buffer; halfCloseTimeoutMs?: number },
    dial: RemoteDialer
  ): Promise<void> {
    const dialId = this.nextDialId++;
    this.dials.set(dialId, dial);
    const wire: WireResumeConfig = { routeId: config.routeId, keyId: config.keyId, key: config.key };
    if (config.halfCloseTimeoutMs !== undefined) wire.halfCloseTimeoutMs = config.halfCloseTimeoutMs;
    try {
      await this.call('slot.resumable', { slotId, config: wire, dialId });
    } catch (error) {
      this.dials.delete(dialId);
      if (error instanceof ResumeSessionError && error.code === 'legacy_peer') {
        this.latch.markLegacy(config.routeId, (error as { latchKeyId?: string }).latchKeyId ?? config.keyId);
      }
      throw error;
    }
  }

  /** Opens a raw tunnel for the connection in `slotId`. */
  async bindRaw(slotId: string, open: TunnelOpen): Promise<void> {
    await this.call('slot.raw', { slotId, open: wireOpen(open) });
  }

  /** Ends the connection in `slotId`: no tunnel opens for it. */
  failSlot(slotId: string, message: string): void {
    void this.call('slot.fail', { slotId, message }).catch(() => undefined);
  }

  /** A slot for a tunnel the main thread reads itself (connectSlot after a tunnel was bound). */
  async createSlot(): Promise<string> {
    return (await this.call<{ slotId: string }>('slot.create')).slotId;
  }

  /** The main thread's end of a bridge slot's tunnel: a loopback connection to the worker. */
  async connectSlot(slotId: string): Promise<net.Socket> {
    const { port } = await this.call<{ port: number }>('bridge.port');
    return new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.setNoDelay(true);
      const fail = (error: Error) => reject(error);
      socket.once('error', fail);
      socket.once('connect', () => {
        socket.off('error', fail);
        socket.write(Buffer.from(slotId, 'hex'));
        resolve(socket);
      });
    });
  }

  probe(open: TunnelOpen): Promise<void> {
    return this.call('probe', wireOpen(open));
  }

  /** The route is latched to raw streams (see RelayResumeRegistry.isLegacy). */
  isResumeLegacy(routeId: string, keyId?: string): boolean {
    return this.latch.isLegacy(routeId, keyId);
  }

  /** Moves the worker's resumable streams off a draining relay; returns how many it carried at the last count. */
  migrateResumableTunnels(relayInstanceId: string, deadlineUnixMs = 0): number {
    void this.call('streams.drain', { relayId: relayInstanceId, deadlineUnixMs }).catch(() => undefined);
    return this.stats.byRelay[relayInstanceId]?.resumable ?? 0;
  }

  /** Telemetry for Opfield's own relayed streams, as the worker reported it last (at most a second old). */
  relayResumeStats(): RelayResumeStatsSnapshot {
    return this.stats;
  }

  /** The worker's telemetry now. */
  freshRelayResumeStats(): Promise<RelayResumeStatsSnapshot> {
    return this.call<RelayResumeStatsSnapshot>('stats');
  }

  readonly streams: OpfieldStreamRegistry = {
    timers: realTimers,
    // The worker paces moves itself (at most 32 in flight).
    schedule: (task) => {
      void task().catch(() => undefined);
    },
    liveSessions: async () => {
      const views = await this.call<StreamView[]>('streams.list');
      return views.map((view) => ({
        routeId: view.routeId,
        relayId: view.relayId,
        movable: view.movable,
        lastMoveAt: view.lastMoveAt,
        migrate: async (trigger: MigrationTrigger, fromRelayId?: string | null) => {
          await this.call('streams.migrate', { id: view.id, trigger, fromRelayId: fromRelayId ?? null });
        },
      }));
    },
  };

  /** Stops the worker: listeners close, connections and streams end. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const runner = this.runner;
    this.runner = null;
    await runner?.stop();
  }
}
