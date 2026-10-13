import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { Duplex, PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AttachablePath,
  encodeRecord,
  type PathEnd,
  parseFrame,
  RecordType,
  RejectCode,
  RelayResumeRegistry,
  ResumableRelayDuplex,
  type ResumePathSink,
  ResumeSession,
  ResumeSessionError,
} from '../relay-resume.js';
import type { RelayTunnelClient } from './engine.js';
import { RelayTunnelHost } from './host.js';

/** One end of an in-memory relay path. */
class MemoryPath implements AttachablePath {
  peer!: MemoryPath;
  private sink: ResumePathSink | null = null;
  private readonly backlog: Array<(sink: ResumePathSink) => void> = [];
  dead = false;
  constructor(
    readonly relayId: string,
    readonly maxFrameBytes = 16 * 1024
  ) {}
  attach(sink: ResumePathSink): void {
    this.sink = sink;
    for (const event of this.backlog.splice(0)) event(sink);
  }
  emit(event: (sink: ResumePathSink) => void): void {
    setImmediate(() => {
      if (this.sink) event(this.sink);
      else this.backlog.push(event);
    });
  }
  send(frame: Buffer): boolean {
    if (!this.dead) {
      const copy = Buffer.from(frame);
      this.peer.emit((sink) => sink.frame(copy));
    }
    return true;
  }
  close(): void {
    this.end({});
  }
  cancel(): void {
    this.end({ error: new Error('cancelled') });
  }
  private end(end: PathEnd): void {
    if (this.dead) return;
    this.dead = true;
    this.peer.emit((sink) => sink.ended(end));
  }
}

function memoryPair(relayId: string): { source: MemoryPath; target: MemoryPath } {
  const source = new MemoryPath(relayId);
  const target = new MemoryPath(relayId);
  source.peer = target;
  target.peer = source;
  return { source, target };
}

const KEY = Buffer.alloc(32, 5);

/** A resume-aware target daemon that echoes every byte and finishes when the source does. */
function acceptEcho(path: MemoryPath, sessions: Map<string, ResumeSession>): void {
  const sinkFor = (session: ResumeSession): ResumePathSink => ({
    frame: (frame) => session.pathFrame(path, frame),
    ended: (end) => session.pathEnded(path, end),
    drained: () => session.pathDrained(path),
    laneLost: () => undefined,
  });
  path.attach({
    frame: (frame) => {
      const [first, ...rest] = parseFrame(frame);
      if (first!.type === RecordType.hello) {
        const session: ResumeSession = new ResumeSession({
          role: 'target',
          routeId: 'route-1',
          sessionId: Buffer.from(first!.sessionId),
          keyId: 'v1',
          key: KEY,
          targetNonce: Buffer.alloc(16, 9),
          hooks: {
            deliver: (data) => {
              session.write(Buffer.from(data));
              return true;
            },
            peerFinished: () => session.finish(),
            writable: () => undefined,
            finAcknowledged: () => undefined,
            opened: () => undefined,
            closed: () => undefined,
          },
        });
        sessions.set(first!.sessionId.toString('hex'), session);
        path.attach(sinkFor(session));
        session.acceptHello(path, first!, rest);
        return;
      }
      const session = sessions.get(first!.sessionId.toString('hex'));
      const reject = session ? session.verifyResume(path.relayId, first!) : RejectCode.unknown;
      if (!session || reject !== null) {
        path.send(encodeRecord({ type: RecordType.resumeRej, sessionId: first!.sessionId, code: reject! }));
        return;
      }
      path.attach(sinkFor(session));
      session.acceptResume(path, first!, rest);
    },
    ended: () => undefined,
    drained: () => undefined,
    laneLost: () => undefined,
  });
}

/** A raw tunnel whose far end echoes. */
function echoTunnel(): Duplex {
  const inbound = new PassThrough();
  return new Duplex({
    read() {
      const chunk = inbound.read();
      if (chunk) this.push(chunk);
      else inbound.once('readable', () => this._read(0));
    },
    write(chunk, _encoding, callback) {
      inbound.write(chunk);
      callback();
    },
    final(callback) {
      inbound.end();
      inbound.once('end', () => this.push(null));
      callback();
    },
  });
}

function fakeClient(options: { legacyTarget?: boolean } = {}) {
  const registry = new RelayResumeRegistry();
  const sessions = new Map<string, ResumeSession>();
  const opened: Array<{ kind: string; relayId: string }> = [];
  const client: RelayTunnelClient = {
    resumeRegistry: registry,
    openTunnel: async () => echoTunnel(),
    openCandidateTunnel: async () => echoTunnel(),
    openLocalResumePath: async (_grant, relayId) => {
      opened.push({ kind: 'local', relayId });
      const pair = memoryPair(relayId);
      if (options.legacyTarget) {
        pair.target.attach({
          frame: () => pair.target.send(Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n')),
          ended: () => undefined,
          drained: () => undefined,
          laneLost: () => undefined,
        });
      } else {
        acceptEcho(pair.target, sessions);
      }
      return pair.source;
    },
    openCandidateResumePath: async (candidate) => {
      opened.push({ kind: 'candidate', relayId: candidate.relayInstanceId });
      const pair = memoryPair(candidate.relayInstanceId);
      acceptEcho(pair.target, sessions);
      return pair.source;
    },
    openResumableTunnel: (config, dial) => ResumableRelayDuplex.open({ ...config, dial, registry }),
    trackLegacyTunnel: (tunnel, relayId = 'local') => {
      registry.countLegacy(1, relayId);
      tunnel.once('close', () => registry.countLegacy(-1, relayId));
      return tunnel;
    },
    migrateResumableTunnels: (relayId, deadline) => registry.drainRelay(relayId, deadline),
    relayResumeStats: () => registry.snapshot(),
    probeCandidate: async () => undefined,
  };
  return { client, registry, opened };
}

const grant = { keyId: 'g1', payload: Buffer.from('payload'), signature: Buffer.from('signature') };
const config = { routeId: 'route-1', keyId: 'v1', key: KEY, halfCloseTimeoutMs: 0 };

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => resolve(socket));
    socket.once('error', reject);
  });
}

/**
 * Writes `data` and collects as many bytes back (the endpoints, like the proxies before them, do not keep a half-closed
 * connection open), then closes.
 */
async function roundTrip(socket: net.Socket, data: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  const done = new Promise<void>((resolve, reject) => {
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.length;
      if (received >= data.length) resolve();
    });
    socket.once('close', () => reject(new Error(`closed after ${received} bytes`)));
    socket.once('error', reject);
  });
  socket.write(data);
  await done;
  socket.destroy();
  return Buffer.concat(chunks);
}

const hosts: RelayTunnelHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});

function newHost(client: RelayTunnelClient): RelayTunnelHost {
  const host = RelayTunnelHost.inThread(client);
  hosts.push(host);
  return host;
}

describe('Opfield tunnel worker engine', () => {
  it('runs a connection to an endpoint through a resumable tunnel the main thread dials', async () => {
    const { client, opened } = fakeClient();
    const host = newHost(client);
    const accepted: string[] = [];
    host.onAccept((key, slotId) => {
      accepted.push(key);
      void host.bindResumable(slotId, config, async (avoidRelayId) => {
        expect(avoidRelayId).toBeNull();
        return { path: await host.openLocalResumePath(grant, 'relay-local'), keyId: 'v1', key: KEY };
      });
    });
    const port = await host.createEndpoint('storage:cluster-1');
    const payload = randomBytes(3 * 1024 * 1024 + 17);
    const echoed = await roundTrip(await connect(port), payload);
    expect(echoed.equals(payload)).toBe(true);
    expect(accepted).toEqual(['storage:cluster-1']);
    expect(opened).toEqual([{ kind: 'local', relayId: 'relay-local' }]);
    // The connection closed: its stream finishes and leaves the counts.
    await expect.poll(async () => (await host.freshRelayResumeStats()).sessions.resumable, { timeout: 5_000 }).toBe(0);
  });

  it('lists its resumable streams and moves one on request', async () => {
    const { client, opened } = fakeClient();
    const host = newHost(client);
    let dials = 0;
    host.onAccept((_key, slotId) => {
      void host.bindResumable(slotId, config, async () =>
        dials++ === 0
          ? { path: await host.openLocalResumePath(grant, 'relay-local') }
          : {
              path: await host.openCandidateResumePath({
                addresses: ['10.0.0.2'],
                port: 7443,
                certificateIdentity: 'relay-uk',
                certificateFingerprint: 'sha256:00',
                grant,
                relayInstanceId: 'relay-uk',
              }),
            }
      );
    });
    const socket = await connect(await host.createEndpoint('database:db-1:interactive'));
    socket.write('hello');
    await new Promise((resolve) => socket.once('data', resolve));
    const [stream] = [...(await host.streams.liveSessions())];
    expect(stream).toMatchObject({ routeId: 'route-1', relayId: 'relay-local', movable: true });
    await stream!.migrate('return', 'relay-local');
    await expect
      .poll(async () => [...(await host.streams.liveSessions())][0]?.relayId, { timeout: 5_000 })
      .toBe('relay-uk');
    expect(opened.map(({ relayId }) => relayId)).toEqual(['relay-local', 'relay-uk']);
    // A move asked of the relay the stream has left by now (a drain paced for later) is dropped in the worker.
    await stream!.migrate('drain', 'relay-local');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(dials).toBe(2);
    expect([...(await host.streams.liveSessions())][0]?.relayId).toBe('relay-uk');
    const echoed = await roundTrip(socket, Buffer.from(' world'));
    expect(echoed.toString()).toBe(' world');
  });

  it('turns a target that is not resume-aware into legacy_peer and latches the route', async () => {
    const { client } = fakeClient({ legacyTarget: true });
    const host = newHost(client);
    const slotId = await host.createSlot();
    const bound = host.bindResumable(slotId, config, async () => ({
      path: await host.openLocalResumePath(grant, 'relay-local'),
    }));
    await expect(bound).rejects.toBeInstanceOf(ResumeSessionError);
    await expect(bound).rejects.toMatchObject({ code: 'legacy_peer' });
    expect(host.isResumeLegacy('route-1', 'v1')).toBe(true);
    expect(host.isResumeLegacy('route-1', 'v2')).toBe(false);
  });

  it('hands a raw tunnel to the main thread over a bridge connection', async () => {
    const { client } = fakeClient();
    const host = newHost(client);
    const slotId = await host.createSlot();
    await host.bindRaw(slotId, { kind: 'local', grant, relayId: 'relay-local' });
    const socket = await host.connectSlot(slotId);
    const payload = randomBytes(256 * 1024);
    expect((await roundTrip(socket, payload)).equals(payload)).toBe(true);
  });

  it('ends a connection whose tunnel the main thread could not open', async () => {
    const { client } = fakeClient();
    const host = newHost(client);
    host.onAccept((_key, slotId) => host.failSlot(slotId, 'Managed storage is unavailable'));
    const socket = await connect(await host.createEndpoint('storage:cluster-2'));
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
  });

  it('closes the open connections of an endpoint it disposes of', async () => {
    const { client } = fakeClient();
    const host = newHost(client);
    host.onAccept((_key, slotId) => {
      void host.bindRaw(slotId, { kind: 'local', grant, relayId: 'relay-local' });
    });
    const port = await host.createEndpoint('storage:cluster-3');
    const socket = await connect(port);
    socket.write('ping');
    await new Promise((resolve) => socket.once('data', resolve));
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    await host.disposeEndpoint('storage:cluster-3');
    await closed;
    await expect(connect(port)).rejects.toThrow();
  });
});
