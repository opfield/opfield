import { randomBytes } from 'node:crypto';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { ClientIdentity, RelayTunnelCandidate, SignedRelayGrant } from '../relay-control.client.js';
import type {
  AttachablePath,
  MigrationTrigger,
  RelayResumeRegistry,
  RelayResumeStatsSnapshot,
  ResumableRelayDuplex,
  ResumeDialer,
} from '../relay-resume.js';
import type {
  RemotePath,
  StreamView,
  WireCandidate,
  WireDialResult,
  WireGrant,
  WireIdentity,
  WireOpen,
  WireResumeConfig,
  WorkerLog,
} from './protocol.js';
import { asBuffer, type RpcPort } from './rpc.js';

/** What the engine needs of RelayControlClient: its tunnel side (the broker channels, RSv1 and the registry). */
export interface RelayTunnelClient {
  readonly resumeRegistry: RelayResumeRegistry;
  openTunnel(grant: SignedRelayGrant, timeoutMs?: number): Promise<Duplex>;
  openCandidateTunnel(candidate: RelayTunnelCandidate, timeoutMs?: number): Promise<Duplex>;
  openLocalResumePath(grant: SignedRelayGrant, relayId: string, timeoutMs?: number): Promise<AttachablePath>;
  openCandidateResumePath(
    candidate: RelayTunnelCandidate & { relayInstanceId: string },
    timeoutMs?: number
  ): Promise<AttachablePath>;
  openResumableTunnel(
    config: {
      routeId: string;
      keyId: string;
      key: Buffer;
      halfCloseTimeoutMs?: number;
      onEvent?: (event: string, detail?: Record<string, unknown>) => void;
    },
    dial: ResumeDialer
  ): Promise<Duplex>;
  trackLegacyTunnel(tunnel: Duplex, relayInstanceId?: string): Duplex;
  migrateResumableTunnels(relayInstanceId: string, deadlineUnixMs?: number): number;
  relayResumeStats(): RelayResumeStatsSnapshot;
  probeCandidate(candidate: RelayTunnelCandidate, timeoutMs?: number): Promise<void>;
  reconnectIfDown?(): boolean;
  setTunnelIdentity?(identity: ClientIdentity): void;
  close?(): void;
}

/** A path a dialer opened and no stream claimed within this long is cancelled. */
const UNCLAIMED_PATH_MS = 60_000;
/** A bridge slot (a Duplex for the main thread) whose connection did not arrive within this long ends its tunnel. */
const BRIDGE_CONNECT_MS = 30_000;
const BRIDGE_TOKEN_BYTES = 16;
const STATS_INTERVAL_MS = 1_000;

/** The connection a tunnel was meant for went away while it opened (code `slot_gone`: not a tunnel failure). */
function connectionGone(): Error {
  return Object.assign(new Error('Opfield tunnel connection is gone'), { code: 'slot_gone' });
}

/**
 * One connection of Gateway's own: a loopback socket (a database driver's or the S3 client's connection to an
 * endpoint, or the main thread's bridge connection) and the relay tunnel the main thread chose for it.
 */
interface Slot {
  id: string;
  socket: net.Socket | null;
  tunnel: Duplex | null;
  dead: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface Endpoint {
  server: net.Server;
  sockets: Set<net.Socket>;
}

function grantOf(grant: WireGrant): SignedRelayGrant {
  return { keyId: grant.keyId, payload: asBuffer(grant.payload), signature: asBuffer(grant.signature) };
}

function candidateOf(candidate: WireCandidate): RelayTunnelCandidate & { relayInstanceId: string } {
  return {
    addresses: [...candidate.addresses],
    port: candidate.port,
    certificateIdentity: candidate.certificateIdentity,
    certificateFingerprint: candidate.certificateFingerprint,
    grant: grantOf(candidate.grant),
    relayInstanceId: candidate.relayInstanceId,
  };
}

/**
 * The data plane of Gateway's own Secure Link tunnels, run in the tunnel worker: the relay lane channels (grpc-js,
 * TLS), RSv1 sessions and the loopback listeners the database drivers and the S3 client connect to, so their bytes
 * never touch the main thread. The main thread decides every placement (assignments, relay order, resumable or raw)
 * and tells the engine what to open; the engine reports accepted connections, dials and stats.
 */
export class RelayTunnelEngine {
  private readonly endpoints = new Map<string, Endpoint>();
  private readonly slots = new Map<string, Slot>();
  private readonly paths = new Map<string, { path: AttachablePath; timer: ReturnType<typeof setTimeout> }>();
  private readonly streamIds = new WeakMap<ResumableRelayDuplex, number>();
  private readonly streamsById = new Map<number, WeakRef<ResumableRelayDuplex>>();
  private nextStreamId = 1;
  private nextSlotId = 1;
  private nextPathId = 1;
  private bridge: Promise<number> | null = null;
  private bridgeServer: net.Server | null = null;
  private readonly statsTimer: ReturnType<typeof setInterval>;
  private lastStats = '';
  private stopped = false;

  constructor(
    private readonly rpc: RpcPort,
    private readonly client: RelayTunnelClient,
    /** The worker's own client is closed at shutdown; the main thread's (in-thread engine) is not. */
    private readonly ownsClient = true
  ) {
    rpc.handle('endpoint.create', ({ key }: { key: string }) => this.createEndpoint(key));
    rpc.handle('endpoint.dispose', ({ key }: { key: string }) => this.disposeEndpoint(key));
    rpc.handle('path.open', (open: WireOpen) => this.openPath(open));
    rpc.handle('slot.create', () => this.createBridgeSlot());
    rpc.handle('slot.resumable', (args: { slotId: string; config: WireResumeConfig; dialId: number }) =>
      this.bindResumable(args.slotId, args.config, args.dialId)
    );
    rpc.handle('slot.raw', ({ slotId, open }: { slotId: string; open: WireOpen }) => this.bindRaw(slotId, open));
    rpc.handle('slot.fail', ({ slotId, message }: { slotId: string; message: string }) =>
      this.failSlot(slotId, message)
    );
    rpc.handle('bridge.port', () => this.bridgePort());
    rpc.handle('probe', (open: WireOpen) => this.probe(open));
    rpc.handle('streams.drain', ({ relayId, deadlineUnixMs }: { relayId: string; deadlineUnixMs: number }) =>
      this.client.migrateResumableTunnels(relayId, deadlineUnixMs)
    );
    rpc.handle('streams.list', () => this.listStreams());
    rpc.handle(
      'streams.migrate',
      ({ id, trigger, fromRelayId }: { id: number; trigger: MigrationTrigger; fromRelayId?: string | null }) =>
        this.migrateStream(id, trigger, fromRelayId)
    );
    rpc.handle('stats', () => this.client.relayResumeStats());
    rpc.handle('identity', (identity: WireIdentity) => {
      this.client.setTunnelIdentity?.({
        privateKey: asBuffer(identity.privateKey),
        certificate: asBuffer(identity.certificate),
      });
    });
    rpc.handle('reconnect', () => this.client.reconnectIfDown?.() ?? false);
    rpc.handle('shutdown', () => this.shutdown());
    this.statsTimer = setInterval(() => this.pushStats(), STATS_INTERVAL_MS);
    this.statsTimer.unref?.();
  }

  /** Counts for the open connections (tests, diagnostics). */
  get openConnections(): number {
    return this.slots.size;
  }

  private log(level: WorkerLog['level'], message: string, meta?: Record<string, unknown>): void {
    this.rpc.emit('log', { level, message, meta } satisfies WorkerLog);
  }

  private pushStats(): void {
    let stats: RelayResumeStatsSnapshot;
    try {
      stats = this.client.relayResumeStats();
    } catch {
      return;
    }
    const encoded = JSON.stringify(stats);
    if (encoded === this.lastStats) return;
    this.lastStats = encoded;
    this.rpc.emit('stats', stats);
  }

  // -- Loopback endpoints ----------------------------------------------------------------------------------------

  /**
   * A loopback-only listener for one managed database lane or storage cluster: each connection waits paused until
   * the main thread opened its tunnel (accept notice → slot.resumable / slot.raw) or gave up (slot.fail).
   */
  private async createEndpoint(key: string): Promise<{ port: number }> {
    if (this.endpoints.has(key)) this.disposeEndpoint(key);
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      // A failed tunnel open is a normal transient condition while a node reconnects: consume the error here.
      socket.on('error', () => {});
      socket.pause();
      const slot: Slot = { id: String(this.nextSlotId++), socket, tunnel: null, dead: false };
      this.slots.set(slot.id, slot);
      socket.once('close', () => {
        if (!slot.tunnel) this.dropSlot(slot);
      });
      this.rpc.emit('accept', { key, slotId: slot.id });
    });
    server.on('error', () => {});
    server.unref();
    const endpoint = { server, sockets };
    this.endpoints.set(key, endpoint);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Opfield tunnel listener did not expose a TCP endpoint');
    }
    if (this.endpoints.get(key) !== endpoint) {
      server.close();
      throw new Error('Opfield tunnel listener was disposed before it became ready');
    }
    return { port: address.port };
  }

  private disposeEndpoint(key: string): void {
    const endpoint = this.endpoints.get(key);
    if (!endpoint) return;
    this.endpoints.delete(key);
    for (const socket of endpoint.sockets) socket.destroy();
    if (endpoint.server.listening) endpoint.server.close();
  }

  // -- Bridge: a tunnel for the main thread (RelayPolicyService.openOpfieldTunnel's Duplex) ------------------------

  private createBridgeSlot(): { slotId: string } {
    const slot: Slot = { id: randomBytes(BRIDGE_TOKEN_BYTES).toString('hex'), socket: null, tunnel: null, dead: false };
    this.slots.set(slot.id, slot);
    slot.timer = setTimeout(() => {
      if (!slot.socket) this.dropSlot(slot);
    }, BRIDGE_CONNECT_MS);
    slot.timer.unref?.();
    return { slotId: slot.id };
  }

  /** One loopback listener for bridge connections: the first 16 bytes name the slot. */
  private bridgePort(): Promise<{ port: number }> {
    this.bridge ??= new Promise<number>((resolve, reject) => {
      const server = net.createServer((socket) => this.acceptBridge(socket));
      server.on('error', () => {});
      server.unref();
      this.bridgeServer = server;
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') reject(new Error('Opfield tunnel bridge has no TCP endpoint'));
        else resolve(address.port);
      });
    }).catch((error) => {
      this.bridge = null;
      throw error;
    });
    return this.bridge.then((port) => ({ port }));
  }

  private acceptBridge(socket: net.Socket): void {
    socket.on('error', () => {});
    let head: Buffer = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), 10_000);
    timer.unref?.();
    const onData = (chunk: Buffer) => {
      head = head.length ? Buffer.concat([head, chunk]) : chunk;
      if (head.length < BRIDGE_TOKEN_BYTES) return;
      socket.off('data', onData);
      socket.pause();
      clearTimeout(timer);
      const slot = this.slots.get(head.subarray(0, BRIDGE_TOKEN_BYTES).toString('hex'));
      if (!slot || slot.socket || slot.dead) {
        socket.destroy();
        return;
      }
      const rest = head.subarray(BRIDGE_TOKEN_BYTES);
      if (rest.length) socket.unshift(rest);
      if (slot.timer) clearTimeout(slot.timer);
      slot.socket = socket;
      socket.once('close', () => {
        if (!slot.tunnel) this.dropSlot(slot);
      });
      if (slot.tunnel) this.pipe(slot);
    };
    socket.on('data', onData);
  }

  // -- Tunnels ---------------------------------------------------------------------------------------------------

  private slot(slotId: string): Slot {
    const slot = this.slots.get(slotId);
    if (!slot || slot.dead) throw connectionGone();
    return slot;
  }

  private async openPath(open: WireOpen): Promise<RemotePath> {
    const path =
      open.kind === 'local'
        ? await this.client.openLocalResumePath(grantOf(open.grant), open.relayId)
        : await this.client.openCandidateResumePath(candidateOf(open.candidate));
    if (this.stopped) {
      path.cancel();
      throw new Error('Opfield tunnel worker stopped');
    }
    const pathId = String(this.nextPathId++);
    const timer = setTimeout(() => {
      if (this.paths.get(pathId)?.path !== path) return;
      this.paths.delete(pathId);
      path.cancel();
    }, UNCLAIMED_PATH_MS);
    timer.unref?.();
    this.paths.set(pathId, { path, timer });
    return { pathId, relayId: path.relayId };
  }

  private takePath(pathId: string): AttachablePath {
    const entry = this.paths.get(pathId);
    if (!entry) throw new Error('The relay path is gone');
    this.paths.delete(pathId);
    clearTimeout(entry.timer);
    return entry.path;
  }

  /**
   * Opens a resumable stream for the slot: every path comes from the main thread's dial (assignment, relay order),
   * which asks this engine to open it (path.open) and names it back.
   */
  private async bindResumable(slotId: string, config: WireResumeConfig, dialId: number): Promise<void> {
    this.slot(slotId);
    let firstKeyId: string | undefined;
    let dials = 0;
    const dial: ResumeDialer = async (avoidRelayId) => {
      const result = await this.rpc.call<WireDialResult>('dial', { dialId, avoidRelayId });
      const path = this.takePath(result.pathId);
      if (dials++ === 0) firstKeyId = result.keyId;
      return result.keyId && result.key ? { path, keyId: result.keyId, key: asBuffer(result.key) } : { path };
    };
    let tunnel: Duplex;
    try {
      tunnel = await this.client.openResumableTunnel(
        {
          routeId: config.routeId,
          keyId: config.keyId,
          key: asBuffer(config.key),
          ...(config.halfCloseTimeoutMs !== undefined ? { halfCloseTimeoutMs: config.halfCloseTimeoutMs } : {}),
          // Where Gateway's own streams go is checked in every Relay Pool update and relay outage: each move is logged.
          onEvent: (event, detail) => {
            if (event === 'migration')
              this.log('info', 'Opfield relay stream moved', { routeId: config.routeId, ...detail });
          },
        },
        dial
      );
    } catch (error) {
      this.rpc.emit('released', { dialId });
      if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'legacy_peer') {
        (error as { latchKeyId?: string }).latchKeyId = firstKeyId ?? config.keyId;
      }
      throw error;
    }
    tunnel.once('close', () => this.rpc.emit('released', { dialId }));
    this.noteStream(tunnel as ResumableRelayDuplex);
    this.attachTunnel(slotId, tunnel);
  }

  private async bindRaw(slotId: string, open: WireOpen): Promise<void> {
    this.slot(slotId);
    const tunnel =
      open.kind === 'local'
        ? await this.client.openTunnel(grantOf(open.grant))
        : await this.client.openCandidateTunnel(candidateOf(open.candidate));
    const relayId = open.kind === 'local' ? open.relayId : open.candidate.relayInstanceId;
    this.attachTunnel(slotId, this.client.trackLegacyTunnel(tunnel, relayId));
  }

  private attachTunnel(slotId: string, tunnel: Duplex): void {
    const slot = this.slots.get(slotId);
    if (!slot || slot.dead || this.stopped) {
      // The connection went away while its tunnel opened.
      tunnel.destroy();
      if (!slot || slot.dead) throw connectionGone();
      return;
    }
    slot.tunnel = tunnel;
    tunnel.once('close', () => this.forget(slot));
    if (slot.socket) {
      this.pipe(slot);
      return;
    }
    // A bridge slot: the main thread connects next.
    tunnel.on('error', () => {});
  }

  /** As the managed tunnel proxies did: bytes both ways, an error on either side closes both. */
  private pipe(slot: Slot): void {
    const socket = slot.socket!;
    const tunnel = slot.tunnel!;
    const closePeer = () => {
      if (!tunnel.destroyed) tunnel.destroy();
      if (!socket.destroyed) socket.destroy();
    };
    socket.once('error', closePeer);
    tunnel.once('error', closePeer);
    socket.once('close', () => this.forget(slot));
    socket.pipe(tunnel).pipe(socket);
    socket.resume();
  }

  private failSlot(slotId: string, message: string): void {
    const slot = this.slots.get(slotId);
    if (!slot) return;
    slot.dead = true;
    this.slots.delete(slotId);
    if (slot.timer) clearTimeout(slot.timer);
    slot.socket?.destroy(new Error(message || 'Opfield tunnel failed'));
    slot.tunnel?.destroy();
  }

  private dropSlot(slot: Slot): void {
    slot.dead = true;
    this.slots.delete(slot.id);
    if (slot.timer) clearTimeout(slot.timer);
    slot.socket?.destroy();
    slot.tunnel?.destroy();
  }

  /** The connection finished (either side closed): the slot is no longer tracked. */
  private forget(slot: Slot): void {
    if ((slot.socket && !slot.socket.destroyed) || (slot.tunnel && !slot.tunnel.destroyed)) return;
    slot.dead = true;
    this.slots.delete(slot.id);
    if (slot.timer) clearTimeout(slot.timer);
  }

  private async probe(open: WireOpen): Promise<void> {
    if (open.kind === 'candidate') {
      await this.client.probeCandidate(candidateOf(open.candidate));
      return;
    }
    const tunnel = await this.client.openTunnel(grantOf(open.grant));
    tunnel.destroy();
  }

  // -- Resumable streams for the main thread's returner ------------------------------------------------------------

  private noteStream(stream: ResumableRelayDuplex): number {
    let id = this.streamIds.get(stream);
    if (id === undefined) {
      id = this.nextStreamId++;
      this.streamIds.set(stream, id);
      this.streamsById.set(id, new WeakRef(stream));
      stream.once('close', () => this.streamsById.delete(id!));
    }
    return id;
  }

  private listStreams(): StreamView[] {
    return this.client.resumeRegistry.liveSessions().map((stream) => ({
      id: this.noteStream(stream),
      routeId: stream.routeId,
      relayId: stream.relayId,
      movable: stream.movable,
      lastMoveAt: stream.lastMoveAt,
    }));
  }

  private migrateStream(id: number, trigger: MigrationTrigger, fromRelayId?: string | null): void {
    const stream = this.streamsById.get(id)?.deref();
    if (!stream) return;
    this.client.resumeRegistry.schedule(() => stream.migrate(trigger, fromRelayId));
  }

  // -- Lifecycle ---------------------------------------------------------------------------------------------------

  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.statsTimer);
    for (const key of [...this.endpoints.keys()]) this.disposeEndpoint(key);
    for (const slot of [...this.slots.values()]) this.dropSlot(slot);
    for (const [pathId, entry] of this.paths) {
      this.paths.delete(pathId);
      clearTimeout(entry.timer);
      entry.path.cancel();
    }
    if (this.bridgeServer?.listening) this.bridgeServer.close();
    if (!this.ownsClient) return;
    try {
      this.client.close?.();
    } catch (error) {
      this.log('debug', 'Opfield tunnel worker channels did not close cleanly', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
