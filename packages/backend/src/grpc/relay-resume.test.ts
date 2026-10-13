import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type AttachablePath,
  computeMac,
  DEFAULT_PROCESS_BUDGET,
  DELAYED_ACK_MS,
  deriveRouteKey,
  encodeRecord,
  FALLBACK_WINDOW,
  HELLO_ACK_TIMEOUT_MS,
  helloAckTranscript,
  helloTranscript,
  INITIAL_WINDOW,
  LEGACY_LATCH_MS,
  MAX_EXTENDED_WINDOW,
  MAX_FRAME_BYTES,
  MAX_WINDOW,
  MIN_WINDOW,
  MigrateReason,
  type PathEnd,
  type PathMacContext,
  parseFrame,
  RecordType,
  RejectCode,
  RelayResumeRegistry,
  ResumableRelayDuplex,
  type ResumePathHandle,
  type ResumePathSink,
  type ResumeRecord,
  ResumeSession,
  type ResumeSessionError,
  type ResumeTimers,
  RstCode,
  realTimers,
  resumeAckTranscript,
  resumeTranscript,
  routeKeyId,
  routeKeyInfo,
  WindowBudget,
} from './relay-resume.js';

const vectorsPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../proto/testdata/relay-resume-v1.json');
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8'));

const typeByName: Record<string, number> = {
  data: RecordType.data,
  ack: RecordType.ack,
  fin: RecordType.fin,
  rst: RecordType.rst,
  close: RecordType.close,
  hello: RecordType.hello,
  hello_ack: RecordType.helloAck,
  resume: RecordType.resume,
  resume_ack: RecordType.resumeAck,
  resume_rej: RecordType.resumeRej,
  migrate_req: RecordType.migrateReq,
};

const hex = (value: string | undefined) => Buffer.from(value ?? '', 'hex');

/** The vector's record as the codec's record type, with zero values for absent fields. */
function vectorRecord(v: Record<string, any>): Partial<ResumeRecord> & { type: number } {
  return {
    type: typeByName[v.type]!,
    ack: BigInt(v.ack ?? 0),
    wnd: BigInt(v.wnd ?? 0),
    payload: hex(v.payload_hex),
    code: v.code ?? 0,
    reason: hex(v.reason_hex),
    keyId: v.key_id ?? '',
    sessionId: v.session_id_hex ? hex(v.session_id_hex) : undefined,
    nonce: v.target_nonce_hex ? hex(v.target_nonce_hex) : undefined,
    epoch: BigInt(v.epoch ?? 0),
    rcvNxt: BigInt(v.rcv_nxt ?? 0),
    sendFrom: BigInt(v.send_from ?? 0),
    mac: v.mac_hex ? hex(v.mac_hex) : undefined,
  };
}

function expectRecord(actual: ResumeRecord, v: Record<string, any>): void {
  const want = vectorRecord(v);
  expect(actual.type).toBe(want.type);
  const hasFields: Record<number, string[]> = {
    [RecordType.data]: ['ack', 'payload'],
    [RecordType.ack]: ['ack', 'wnd'],
    [RecordType.fin]: ['ack'],
    [RecordType.rst]: ['code', 'reason'],
    [RecordType.close]: [],
    [RecordType.hello]: ['keyId', 'sessionId', 'wnd', 'mac'],
    [RecordType.helloAck]: ['sessionId', 'nonce', 'wnd', 'mac'],
    [RecordType.resume]: ['sessionId', 'epoch', 'rcvNxt', 'keyId', 'mac'],
    [RecordType.resumeAck]: ['sessionId', 'epoch', 'rcvNxt', 'sendFrom', 'mac'],
    [RecordType.resumeRej]: ['sessionId', 'code'],
    [RecordType.migrateReq]: ['code'],
  };
  for (const field of hasFields[want.type]!) {
    const got = (actual as any)[field];
    const expected = (want as any)[field];
    if (Buffer.isBuffer(got)) expect(got.toString('hex')).toBe(expected.toString('hex'));
    else expect(got).toBe(expected);
  }
}

describe('RSv1 vectors (proto/testdata/relay-resume-v1.json)', () => {
  it('matches the frozen constants', () => {
    const c = vectors.constants;
    expect(c.capability).toBe('relay_stream_resume_v1');
    expect(c.initial_window).toBe(INITIAL_WINDOW);
    expect(c.fallback_window).toBe(FALLBACK_WINDOW);
    expect(c.min_window).toBe(MIN_WINDOW);
    expect(c.max_window).toBe(MAX_WINDOW);
    expect(c.max_extended_window).toBe(MAX_EXTENDED_WINDOW);
    expect(c.window_extension).toBe(1);
    expect(c.max_frame_bytes).toBe(MAX_FRAME_BYTES);
    expect(c.process_budget).toBe(DEFAULT_PROCESS_BUDGET);
    expect(c.delayed_ack_ms).toBe(DELAYED_ACK_MS);
    expect(c.hello_ack_timeout_ms).toBe(HELLO_ACK_TIMEOUT_MS);
    expect(c.legacy_latch_ms).toBe(LEGACY_LATCH_MS);
    for (const [name, value] of Object.entries(c.record_types)) expect(typeByName[name]).toBe(value);
    expect(c.reject_codes).toEqual({
      unknown: RejectCode.unknown,
      finished: RejectCode.finished,
      reset: RejectCode.reset,
      unauthorized: RejectCode.unauthorized,
      stale_epoch: RejectCode.staleEpoch,
    });
    expect(c.rst_codes.legacy_peer).toBe(RstCode.legacyPeer);
    expect(c.rst_codes.window_violation).toBe(RstCode.windowViolation);
    expect(c.rst_codes.suspend_timeout).toBe(RstCode.suspendTimeout);
  });

  it('derives route keys', () => {
    for (const v of vectors.kdf) {
      expect(routeKeyInfo(v.route_id, BigInt(v.key_version)).toString('hex')).toBe(v.info_hex);
      expect(deriveRouteKey(hex(v.secret_hex), v.route_id, BigInt(v.key_version)).toString('hex')).toBe(v.key_hex);
      expect(routeKeyId(BigInt(v.key_version))).toBe(v.key_id);
    }
  });

  it('computes MAC transcripts and records', () => {
    for (const v of vectors.macs) {
      const context: PathMacContext = {
        routeId: v.route_id,
        relayId: v.relay_id,
        keyId: v.key_id,
        key: hex(v.key_hex),
        sessionId: hex(v.session_id_hex),
        targetNonce: v.target_nonce_hex ? hex(v.target_nonce_hex) : Buffer.alloc(16),
      };
      let transcript: Buffer;
      let record: Partial<ResumeRecord> & { type: number };
      switch (v.label) {
        case 'hello':
          transcript = helloTranscript(context, BigInt(v.wnd));
          record = { type: RecordType.hello, keyId: v.key_id, sessionId: context.sessionId, wnd: BigInt(v.wnd) };
          break;
        case 'hello_ack':
          transcript = helloAckTranscript(context, hex(v.hello_mac_hex), context.targetNonce, BigInt(v.wnd));
          record = {
            type: RecordType.helloAck,
            sessionId: context.sessionId,
            nonce: context.targetNonce,
            wnd: BigInt(v.wnd),
          };
          break;
        case 'resume':
          transcript = resumeTranscript(context, BigInt(v.epoch), BigInt(v.rcv_nxt));
          record = {
            type: RecordType.resume,
            sessionId: context.sessionId,
            epoch: BigInt(v.epoch),
            rcvNxt: BigInt(v.rcv_nxt),
            keyId: v.key_id,
          };
          break;
        default:
          transcript = resumeAckTranscript(
            context,
            BigInt(v.epoch),
            BigInt(v.rcv_nxt),
            BigInt(v.send_from),
            hex(v.resume_mac_hex)
          );
          record = {
            type: RecordType.resumeAck,
            sessionId: context.sessionId,
            epoch: BigInt(v.epoch),
            rcvNxt: BigInt(v.rcv_nxt),
            sendFrom: BigInt(v.send_from),
          };
      }
      expect(transcript.toString('hex'), v.name).toBe(v.transcript_hex);
      const mac = computeMac(context.key, transcript);
      expect(mac.toString('hex'), v.name).toBe(v.mac_hex);
      expect(encodeRecord({ ...record, mac }).toString('hex'), v.name).toBe(v.record_hex);
    }
  });

  it('decodes and encodes every record', () => {
    for (const v of vectors.records) {
      const records = parseFrame(hex(v.hex));
      expect(records, v.name).toHaveLength(1);
      expectRecord(records[0]!, v.record);
      expect(encodeRecord(vectorRecord(v.record)).toString('hex'), v.name).toBe(v.hex);
    }
  });

  it('decodes and encodes multi-record frames', () => {
    for (const v of vectors.frames) {
      const records = parseFrame(hex(v.hex));
      expect(records, v.name).toHaveLength(v.records.length);
      for (const [index, record] of records.entries()) expectRecord(record, v.records[index]);
      const encoded = Buffer.concat(v.records.map((record: any) => encodeRecord(vectorRecord(record))));
      expect(encoded.toString('hex'), v.name).toBe(v.hex);
    }
  });

  it('rejects every invalid frame', () => {
    for (const v of vectors.invalid) {
      expect(() => parseFrame(hex(v.hex)), `${v.name}: ${v.reason}`).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Deterministic simulator: a source and a target session over simulated relay paths on a virtual clock.
// ---------------------------------------------------------------------------------------------------------------------

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = Math.imul(seed >>> 0, 0x9e3779b1) >>> 0;
  }
  next(): number {
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  }
  int(max: number): number {
    return Math.floor(this.next() * max);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: T[]): T {
    return items[this.int(items.length)]!;
  }
}

class VirtualClock implements ResumeTimers {
  private time = 1_000_000;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  onFire?: (at: number) => void;
  now(): number {
    return this.time;
  }
  setTimeout(callback: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.time + Math.max(0, ms), callback });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  get pending(): number {
    return this.timers.size;
  }
  nextAt(): number | null {
    let at: number | null = null;
    for (const timer of this.timers.values()) if (at === null || timer.at < at) at = timer.at;
    return at;
  }
  advanceTo(at: number): void {
    this.time = Math.max(this.time, at);
  }
  /** Runs the earliest timer; false when none is left. */
  fireNext(): boolean {
    let best: [number, { at: number; callback: () => void }] | null = null;
    for (const entry of this.timers) {
      if (!best || entry[1].at < best[1].at || (entry[1].at === best[1].at && entry[0] < best[0])) best = entry;
    }
    if (!best) return false;
    this.timers.delete(best[0]);
    this.onFire?.(best[1].at);
    this.time = Math.max(this.time, best[1].at);
    best[1].callback();
    return true;
  }
}

type SimEvent = ({ kind: 'frame'; frame: Buffer } | { kind: 'end'; end: PathEnd }) & { at: number };

class SimEndpoint implements ResumePathHandle {
  peer!: SimEndpoint;
  inbound: SimEvent[] = [];
  dead = false;
  /** The relay under the path is gone: nothing sent from now on arrives. */
  severed = false;
  paused = false;
  ended = false;
  onFrame: (frame: Buffer) => void = () => undefined;
  onEnd: (end: PathEnd) => void = () => undefined;
  onDrain: () => void = () => undefined;
  lastAt = 0;
  constructor(
    readonly relayId: string,
    readonly maxFrameBytes: number,
    readonly side: 'source' | 'target',
    readonly sim: Simulator,
    readonly latencyMs: number
  ) {}
  /** In-order arrival time of the next event sent to this endpoint. */
  arrival(): number {
    this.lastAt = Math.max(this.lastAt, this.sim.clock.now() + this.latencyMs);
    return this.lastAt;
  }
  send(frame: Buffer): boolean {
    expect(frame.length).toBeGreaterThan(0);
    expect(frame.length).toBeLessThanOrEqual(this.maxFrameBytes);
    this.sim.validateFrame(this.side, frame);
    if (this.dead || this.peer.dead || this.severed) return true;
    this.peer.inbound.push({ kind: 'frame', frame: Buffer.from(frame), at: this.peer.arrival() });
    return true;
  }
  close(): void {
    this.terminate();
  }
  cancel(): void {
    this.terminate();
  }
  private terminate(): void {
    if (this.dead) return;
    this.dead = true;
    this.inbound = [];
    if (!this.peer.dead) this.peer.inbound.push({ kind: 'end', end: {}, at: this.peer.arrival() });
  }
  /** Delivers the next inbound event; false when there is none. */
  deliver(): boolean {
    if (this.dead || this.paused || !this.inbound.length) return false;
    const event = this.inbound.shift()!;
    this.sim.log(
      `${this.side}<-${this.relayId}#${this.sim.paths.findIndex((p) => p.source === this || p.target === this)} ${
        event.kind === 'frame'
          ? parseFrame(event.frame)
              .map(
                (r) =>
                  `${r.type}${r.type === 1 ? `(${r.payload.length},a${r.ack})` : r.type === 2 || r.type === 3 ? `(a${r.ack})` : ''}`
              )
              .join('+')
          : `end ${event.end.error?.message ?? ''}`
      }`
    );
    if (event.kind === 'frame') this.onFrame(event.frame);
    else {
      this.dead = true;
      this.ended = true;
      this.onEnd(event.end);
    }
    return true;
  }
}

interface SimTargetEntry {
  session: ResumeSession;
  routeOk: boolean;
}

interface Side {
  name: 'source' | 'target';
  written: Buffer[];
  writtenBytes: number;
  total: number;
  delivered: Buffer[];
  deliveredBytes: number;
  finSent: boolean;
  finDelivered: number;
  closed: boolean;
  closeError?: ResumeSessionError;
  blocked: boolean;
  readerSlow: boolean;
  session: ResumeSession | null;
}

class Simulator {
  readonly clock = new VirtualClock();
  readonly rng: Rng;
  readonly key = deriveRouteKey(Buffer.alloc(32, 7), 'route-sim', 3n);
  readonly keyId = routeKeyId(3n);
  readonly routeId = 'route-sim';
  readonly budget = new WindowBudget();
  readonly paths: Array<{ source: SimEndpoint; target: SimEndpoint }> = [];
  readonly targetNonce = Buffer.alloc(16, 0x5a);
  readonly targets = new Map<string, SimTargetEntry>();
  readonly sourceSide: Side;
  readonly targetSide: Side;
  private relaySeq = 0;
  migrations = 0;
  cuts = 0;
  recovering = false;
  sourceOpened = false;
  maxCuts: number;
  readonly sourceStream: Buffer;
  readonly targetStream: Buffer;
  readonly trace: string[] = [];
  log(line: string): void {
    this.trace.push(`${this.clock.now() - 1_000_000} ${line}`);
    if (this.trace.length > 4000) this.trace.shift();
  }

  constructor(seed: number, sizes: { source: number; target: number }) {
    this.rng = new Rng(seed);
    this.maxCuts = this.rng.int(4);
    this.sourceStream = randomStream(this.rng, sizes.source);
    this.targetStream = randomStream(this.rng, sizes.target);
    this.sourceSide = newSide('source', sizes.source);
    this.clock.onFire = (at) => this.log(`timer@${at - 1_000_000}`);
    this.targetSide = newSide('target', sizes.target);
  }

  validateFrame(_side: 'source' | 'target', frame: Buffer): void {
    // Every frame a session writes parses as RSv1 records.
    parseFrame(frame);
  }

  newPath(): { source: SimEndpoint; target: SimEndpoint } {
    const relayId = `relay-${this.relaySeq++ % 3}`;
    const maxFrame = this.rng.pick([256, 1024, 16 * 1024, MAX_FRAME_BYTES]);
    const latency = 1 + this.rng.int(30);
    const source = new SimEndpoint(relayId, maxFrame, 'source', this, latency);
    const target = new SimEndpoint(relayId, maxFrame, 'target', this, latency);
    source.peer = target;
    target.peer = source;
    const pair = { source, target };
    this.paths.push(pair);
    this.wireTarget(target);
    return pair;
  }

  /** The target daemon's first-record rule for a fresh path. */
  private wireTarget(endpoint: SimEndpoint): void {
    endpoint.onFrame = (frame) => {
      const records = parseFrame(frame);
      const [first, ...rest] = records;
      if (first?.type === RecordType.hello) {
        const context: PathMacContext = {
          routeId: this.routeId,
          relayId: endpoint.relayId,
          keyId: first.keyId,
          key: this.key,
          sessionId: first.sessionId,
          targetNonce: this.targetNonce,
        };
        expect(computeMac(this.key, helloTranscript(context, first.wnd)).equals(first.mac)).toBe(true);
        const session = this.newTargetSession(Buffer.from(first.sessionId));
        this.targets.set(first.sessionId.toString('hex'), { session, routeOk: true });
        this.bind(endpoint, session);
        session.acceptHello(endpoint, first, rest);
        return;
      }
      if (first?.type === RecordType.resume) {
        const entry = this.targets.get(first.sessionId.toString('hex'));
        const reject = entry ? entry.session.verifyResume(endpoint.relayId, first) : RejectCode.unknown;
        if (reject !== null || !entry) {
          endpoint.send(encodeRecord({ type: RecordType.resumeRej, sessionId: first.sessionId, code: reject! }));
          endpoint.close();
          return;
        }
        this.bind(endpoint, entry.session);
        entry.session.acceptResume(endpoint, first, rest);
        return;
      }
      throw new Error(`target got a first record of type ${first?.type}`);
    };
    endpoint.onEnd = () => undefined;
  }

  private bind(endpoint: SimEndpoint, session: ResumeSession): void {
    endpoint.onFrame = (frame) => session.pathFrame(endpoint, frame);
    endpoint.onEnd = (end) => session.pathEnded(endpoint, end);
  }

  private newTargetSession(sessionId: Buffer): ResumeSession {
    const side = this.targetSide;
    const session = new ResumeSession({
      role: 'target',
      routeId: this.routeId,
      sessionId,
      keyId: this.keyId,
      key: this.key,
      targetNonce: this.targetNonce,
      timers: this.clock,
      budget: this.budget,
      hooks: this.hooks(side),
    });
    side.session = session;
    return session;
  }

  hooks(side: Side) {
    return {
      deliver: (data: Buffer) => {
        expect(side.closed).toBe(false);
        expect(side.finDelivered).toBe(0);
        this.checkPrefix(side, data);
        side.delivered.push(Buffer.from(data));
        side.deliveredBytes += data.length;
        return !side.readerSlow;
      },
      peerFinished: () => {
        side.finDelivered += 1;
        const peer = side === this.sourceSide ? this.targetSide : this.sourceSide;
        expect(side.deliveredBytes).toBe(peer.total);
      },
      writable: () => {
        side.blocked = false;
      },
      finAcknowledged: () => undefined,
      opened: () => {
        if (side === this.sourceSide) this.sourceOpened = true;
      },
      closed: (error?: ResumeSessionError) => {
        side.closed = true;
        side.closeError = error;
      },
      suspended: () => this.recover(),
      migrateRequested: () => undefined,
    };
  }

  /** Each side's delivered stream stays a prefix of what the peer wrote. */
  checkPrefix(side: Side, data: Buffer): void {
    const expected = side === this.sourceSide ? this.targetStream : this.sourceStream;
    const at = side.deliveredBytes;
    if (at + data.length > expected.length || !data.equals(expected.subarray(at, at + data.length))) {
      const found = expected.indexOf(data.subarray(0, Math.min(64, data.length)));
      this.log(`BAD ${side.name} delivery len ${data.length} at ${at}, bytes match offset ${found}`);
      throw new Error(
        `${side.name} delivered bytes that are not the peer's stream at offset ${at} (found at ${found})`
      );
    }
  }

  startSource(): void {
    const side = this.sourceSide;
    const session = new ResumeSession({
      role: 'source',
      routeId: this.routeId,
      sessionId: Buffer.from(createHash('sha256').update(String(this.rng.next())).digest().subarray(0, 16)),
      keyId: this.keyId,
      key: this.key,
      timers: this.clock,
      budget: this.budget,
      initialWindow: this.rng.pick([MIN_WINDOW, INITIAL_WINDOW, MAX_WINDOW]),
      hooks: this.hooks(side),
    });
    side.session = session;
    const { source } = this.newPath();
    this.bindSource(source, session);
    session.startSource(source);
  }

  private bindSource(endpoint: SimEndpoint, session: ResumeSession): void {
    endpoint.onFrame = (frame) => session.pathFrame(endpoint, frame);
    endpoint.onEnd = (end) => session.pathEnded(endpoint, end);
  }

  /** Unplanned: the source keeps trying fresh paths with backoff. */
  recover(): void {
    if (this.recovering) return;
    this.recovering = true;
    const attempt = () => {
      const session = this.sourceSide.session!;
      if (session.isClosed || !session.isSuspended) {
        this.recovering = false;
        return;
      }
      const { source } = this.newPath();
      this.bindSource(source, session);
      session.resume(source).then((result) => {
        if (result === 'resumed' || result === 'closed' || result === 'rejected') {
          this.recovering = false;
          if (session.isSuspended) this.recover();
          return;
        }
        this.clock.setTimeout(attempt, 250);
      });
    };
    this.clock.setTimeout(attempt, 250);
  }

  /** Planned: open another path while the current one works. */
  plannedMigration(): void {
    const session = this.sourceSide.session!;
    if (!session.isOpen || session.migrating) return;
    this.migrations++;
    const { source } = this.newPath();
    this.log(`planned migration -> ${source.relayId}#${this.paths.length - 1}`);
    this.bindSource(source, session);
    void session.resume(source);
  }

  /** Cuts a random live path: in-flight frames past a random point are lost, both ends see the end. */
  cut(): void {
    // Before HELLO_ACK a stream is not resumable yet (cut as today); the simulator covers established streams.
    if (!this.sourceOpened) return;
    const live = this.paths.filter(({ source, target }) => !source.severed && (!source.dead || !target.dead));
    if (!live.length) return;
    const { source, target } = this.rng.pick(live);
    this.cuts++;
    for (const endpoint of [source, target]) {
      endpoint.severed = true;
      if (endpoint.dead) continue;
      const frames = endpoint.inbound.filter((event) => event.kind === 'frame');
      endpoint.inbound = frames.slice(0, this.rng.int(frames.length + 1));
      endpoint.inbound.push({ kind: 'end', end: { error: new Error('relay cut') }, at: endpoint.arrival() });
    }
  }

  writeSome(side: Side): void {
    const session = side.session;
    if (!session || side.closed || side.blocked || side.finSent) return;
    if (side.writtenBytes >= side.total) {
      side.finSent = true;
      session.finish();
      return;
    }
    const stream = side === this.sourceSide ? this.sourceStream : this.targetStream;
    const size = 1 + this.rng.int(this.rng.chance(0.2) ? 300_000 : 4_000);
    const chunk = stream.subarray(side.writtenBytes, Math.min(side.total, side.writtenBytes + size));
    side.writtenBytes += chunk.length;
    if (!session.write(chunk)) side.blocked = true;
    expect(session.unackedBytes).toBeLessThanOrEqual(session.sendWindow + chunk.length + 1);
  }

  /** Runs the next event in virtual time: a frame arrival or a timer. False when nothing is left. */
  advance(): boolean {
    let best: SimEndpoint | null = null;
    for (const { source, target } of this.paths) {
      for (const endpoint of [source, target]) {
        if (endpoint.dead || endpoint.paused || !endpoint.inbound.length) continue;
        if (!best || endpoint.inbound[0]!.at < best.inbound[0]!.at) best = endpoint;
      }
    }
    const timerAt = this.clock.nextAt();
    if (best && (timerAt === null || best.inbound[0]!.at <= timerAt)) {
      this.clock.advanceTo(best.inbound[0]!.at);
      best.deliver();
      return true;
    }
    return this.clock.fireNext();
  }

  toggleReader(side: Side): void {
    side.readerSlow = !side.readerSlow;
    if (!side.readerSlow) side.session?.readResumed();
  }
}

function newSide(name: 'source' | 'target', total: number): Side {
  return {
    name,
    written: [],
    writtenBytes: 0,
    total,
    delivered: [],
    deliveredBytes: 0,
    finSent: false,
    finDelivered: 0,
    closed: false,
    blocked: false,
    readerSlow: false,
    session: null,
  };
}

function randomStream(rng: Rng, size: number): Buffer {
  const out = Buffer.allocUnsafe(size + 4);
  for (let i = 0; i < size; i += 4) out.writeUInt32LE(rng.int(0x1_0000_0000), i);
  return out.subarray(0, size);
}

async function runSeed(seed: number): Promise<Simulator> {
  const rng = new Rng(seed * 7919 + 13);
  const sim = new Simulator(seed, {
    source: rng.chance(0.1) ? 0 : rng.int(rng.chance(0.2) ? 1_500_000 : 40_000),
    target: rng.chance(0.1) ? 0 : rng.int(rng.chance(0.2) ? 1_500_000 : 40_000),
  });
  sim.startSource();
  for (let step = 0; step < 200_000; step++) {
    const src = sim.sourceSide;
    const tgt = sim.targetSide;
    if (src.closed && tgt.closed) break;
    const roll = sim.rng.next();
    if (roll < 0.6) {
      if (!sim.advance()) {
        if (src.readerSlow) sim.toggleReader(src);
        if (tgt.readerSlow) sim.toggleReader(tgt);
        sim.writeSome(src);
        sim.writeSome(tgt);
      }
    } else if (roll < 0.75) sim.writeSome(src);
    else if (roll < 0.9) sim.writeSome(tgt);
    else if (roll < 0.93) sim.toggleReader(sim.rng.chance(0.5) ? src : tgt);
    else if (roll < 0.94 && sim.migrations < 4) sim.plannedMigration();
    else if (roll < 0.96 && sim.cuts < sim.maxCuts) sim.cut();
    // Let resume() promises settle before virtual time moves on.
    await Promise.resolve();
  }
  return sim;
}

describe('RSv1 session simulator', () => {
  it(
    'delivers both streams byte-exact across migrations, cuts and backpressure',
    async () => {
      const seeds = Number(process.env.RELAY_RESUME_SIM_SEEDS ?? 100);
      const first = Number(process.env.RELAY_RESUME_SIM_FIRST_SEED ?? 1);
      let cuts = 0;
      let migrations = 0;
      for (let seed = first; seed < first + seeds; seed++) {
        const sim = await runSeed(seed);
        cuts += sim.cuts;
        migrations += sim.migrations;
        const label = `seed ${seed} (cuts ${sim.cuts}, migrations ${sim.migrations})`;
        const src = sim.sourceSide;
        const tgt = sim.targetSide;
        if ((!src.closed || !tgt.closed) && process.env.RELAY_RESUME_SIM_TRACE) {
          console.log(sim.trace.slice(-120).join('\n'));
          const state = (side: Side) =>
            `${side.name}: closed=${side.closed} written=${side.writtenBytes}/${side.total} fin=${side.finSent} delivered=${side.deliveredBytes} blocked=${side.blocked} slow=${side.readerSlow} open=${side.session?.isOpen} susp=${side.session?.isSuspended} mig=${side.session?.migrating} unacked=${side.session?.unackedBytes} relay=${side.session?.currentRelayId}`;
          console.log(state(src));
          console.log(state(tgt));
          console.log(`timers=${sim.clock.pending} recovering=${sim.recovering}`);
        }
        expect(src.closed, label).toBe(true);
        expect(tgt.closed, label).toBe(true);
        if (src.closeError || tgt.closeError) {
          if (process.env.RELAY_RESUME_SIM_TRACE) console.log(sim.trace.join('\n'));
          // Only a suspend timeout may end a run early (a cut every path could not cure); never wrong bytes.
          throw new Error(`${label}: ${src.closeError?.message ?? ''} / ${tgt.closeError?.message ?? ''}`);
        }
        expect(Buffer.concat(src.delivered).equals(sim.targetStream), label).toBe(true);
        expect(Buffer.concat(tgt.delivered).equals(sim.sourceStream), label).toBe(true);
        expect(src.finDelivered, label).toBe(1);
        expect(tgt.finDelivered, label).toBe(1);
        expect(sim.budget.inUse, label).toBe(0);
      }
      // The schedule must actually exercise both kinds of moves.
      expect(cuts).toBeGreaterThan(seeds / 2);
      expect(migrations).toBeGreaterThan(seeds / 4);
    },
    Math.max(120_000, Number(process.env.RELAY_RESUME_SIM_SEEDS ?? 0) * 100)
  );

  it('refuses a replayed RESUME and a RESUME through another relay id', () => {
    const sim = new Simulator(99, { source: 10, target: 10 });
    sim.startSource();
    for (let i = 0; i < 20 && !sim.sourceSide.session!.isOpen; i++) sim.advance();
    const source = sim.sourceSide.session!;
    expect(source.isOpen).toBe(true);
    const target = sim.targetSide.session!;
    const context: PathMacContext = {
      routeId: sim.routeId,
      relayId: 'relay-x',
      keyId: sim.keyId,
      key: sim.key,
      sessionId: source.sessionId,
      targetNonce: sim.targetNonce,
    };
    const forged = (relayId: string, epoch: bigint): ResumeRecord => ({
      ...parseFrame(
        encodeRecord({
          type: RecordType.resume,
          sessionId: source.sessionId,
          epoch,
          rcvNxt: 0n,
          keyId: sim.keyId,
          mac: computeMac(sim.key, resumeTranscript({ ...context, relayId }, epoch, 0n)),
        })
      )[0]!,
    });
    expect(target.verifyResume('relay-x', forged('relay-x', 1n))).toBeNull();
    expect(target.verifyResume('relay-y', forged('relay-x', 1n))).toBe(RejectCode.unauthorized);
    expect(target.verifyResume('relay-x', forged('relay-x', 0n))).toBe(RejectCode.staleEpoch);
    const wrongKey = { ...forged('relay-x', 2n), mac: Buffer.alloc(16) };
    expect(target.verifyResume('relay-x', wrongKey)).toBe(RejectCode.unauthorized);
  });

  it('resets and reports a legacy peer whose first frame is not HELLO_ACK', () => {
    const clock = new VirtualClock();
    let closed: ResumeSessionError | undefined;
    const sent: Buffer[] = [];
    const path: ResumePathHandle = {
      relayId: 'relay-a',
      maxFrameBytes: 32 * 1024,
      send: (frame) => {
        sent.push(frame);
        return true;
      },
      close: () => undefined,
      cancel: () => undefined,
    };
    const session = new ResumeSession({
      role: 'source',
      routeId: 'route-1',
      sessionId: Buffer.alloc(16, 1),
      keyId: 'v1',
      key: Buffer.alloc(32, 2),
      timers: clock,
      budget: new WindowBudget(),
      hooks: {
        deliver: () => true,
        peerFinished: () => undefined,
        writable: () => undefined,
        finAcknowledged: () => undefined,
        opened: () => undefined,
        closed: (error) => {
          closed = error;
        },
      },
    });
    session.startSource(path);
    expect(parseFrame(sent[0]!)[0]!.type).toBe(RecordType.hello);
    // An old target with a PostgreSQL backend answers the HELLO bytes with an ErrorResponse.
    session.pathFrame(path, Buffer.from('E\0\0\0\x10SFATAL\0', 'latin1'));
    expect(closed?.code).toBe('legacy_peer');
    const rst = parseFrame(sent.at(-1)!)[0]!;
    expect(rst.type).toBe(RecordType.rst);
    expect(rst.code).toBe(RstCode.legacyPeer);
  });

  it('treats a missing HELLO_ACK as a legacy peer after the timeout', () => {
    const clock = new VirtualClock();
    let closed: ResumeSessionError | undefined;
    const path: ResumePathHandle = {
      relayId: 'relay-a',
      maxFrameBytes: 32 * 1024,
      send: () => true,
      close: () => undefined,
      cancel: () => undefined,
    };
    const session = new ResumeSession({
      role: 'source',
      routeId: 'route-1',
      sessionId: Buffer.alloc(16, 1),
      keyId: 'v1',
      key: Buffer.alloc(32, 2),
      timers: clock,
      budget: new WindowBudget(),
      hooks: {
        deliver: () => true,
        peerFinished: () => undefined,
        writable: () => undefined,
        finAcknowledged: () => undefined,
        opened: () => undefined,
        closed: (error) => {
          closed = error;
        },
      },
    });
    session.startSource(path);
    clock.fireNext();
    expect(closed?.code).toBe('legacy_peer');
  });
});

describe('RSv1 refused moves (stand rc.6 O-3)', () => {
  /** A source open through a target on the simulator, the request and its FIN delivered at the target. */
  const openWithRequest = () => {
    const sim = new Simulator(7, { source: 10, target: 10 });
    sim.startSource();
    for (let i = 0; i < 50 && !sim.sourceSide.session!.isOpen; i++) sim.advance();
    const source = sim.sourceSide.session!;
    expect(source.isOpen).toBe(true);
    source.write(sim.sourceStream);
    source.finish();
    sim.sourceSide.finSent = true;
    for (let i = 0; i < 50 && !sim.targetSide.finDelivered; i++) sim.advance();
    expect(sim.targetSide.finDelivered).toBe(1);
    return { sim, source, target: sim.targetSide.session! };
  };
  /** A planned move whose RESUME the target answers with RESUME_REJ code, ahead of anything on the old path. */
  const refuse = (source: ResumeSession, code: number) => {
    const handle: ResumePathHandle = {
      relayId: 'relay-near',
      maxFrameBytes: 32 * 1024,
      send: () => true,
      close: () => undefined,
      cancel: () => undefined,
    };
    const result = source.resume(handle);
    source.pathFrame(handle, encodeRecord({ type: RecordType.resumeRej, sessionId: source.sessionId, code }));
    return result;
  };

  it('ends a planned move the target refused after its reset as the peer reset heard on the old path', async () => {
    const { sim, source, target } = openWithRequest();
    // The target's backend left: it resets, its RST travels on the old (far) path.
    target.abort(RstCode.local, 'backend connection reset');
    const result = refuse(source, RejectCode.reset);
    expect(source.isClosed).toBe(false);
    expect(source.isOpen).toBe(false);
    for (let i = 0; i < 50 && !source.isClosed; i++) sim.advance();
    expect(sim.sourceSide.closeError?.code).toBe('reset');
    expect(await result).toBe('closed');
  });

  it('counts the refusal as cut when the old path ends without a word or stays silent', async () => {
    const ended = openWithRequest();
    const old = ended.sim.paths[0]!.source;
    const endedResult = refuse(ended.source, RejectCode.reset);
    ended.source.pathEnded(old, { error: new Error('relay gone') });
    expect(ended.sim.sourceSide.closeError?.code).toBe('rejected');
    expect(await endedResult).toBe('rejected');

    const silent = openWithRequest();
    const silentResult = refuse(silent.source, RejectCode.reset);
    // Nothing more arrives on the old path: only the refusal's deadline is left.
    silent.sim.paths[0]!.source.paused = true;
    for (let i = 0; i < 50 && !silent.source.isClosed; i++) silent.sim.advance();
    expect(silent.sim.sourceSide.closeError?.code).toBe('rejected');
    expect(await silentResult).toBe('rejected');
  });

  it('finishes a stream whose both directions were complete on any refusal', async () => {
    for (const code of [RejectCode.unknown, RejectCode.finished, RejectCode.reset]) {
      const { sim, source, target } = openWithRequest();
      target.write(sim.targetStream);
      target.finish();
      for (let i = 0; i < 50 && !sim.sourceSide.finDelivered; i++) sim.advance();
      expect(source.complete).toBe(true);
      const result = refuse(source, code);
      expect(sim.sourceSide.closed).toBe(true);
      expect(sim.sourceSide.closeError).toBeUndefined();
      expect(await result).toBe('closed');
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The Duplex over real timers: echo through a target session, with a path cut and a planned move.
// ---------------------------------------------------------------------------------------------------------------------

class MemoryPath implements AttachablePath {
  peer!: MemoryPath;
  sink: ResumePathSink | null = null;
  private backlog: Array<(sink: ResumePathSink) => void> = [];
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
    if (this.dead) return;
    setImmediate(() => {
      if (this.dead) return;
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
  end(end: PathEnd): void {
    if (this.dead) return;
    this.dead = true;
    this.peer.emit((sink) => sink.ended(end));
  }
  /** The relay dies: both ends see a non-terminal failure. */
  cut(): void {
    if (this.dead) return;
    const peer = this.peer;
    this.dead = true;
    peer.dead = true;
    const fail = (path: MemoryPath) => path.sink?.ended({ error: new Error('relay gone') });
    setImmediate(() => {
      fail(this);
      fail(peer);
    });
  }
}

/** A target daemon on memory paths that echoes every byte back and finishes when the source does. */
function echoTarget(key: Buffer, keyId: string) {
  const nonce = Buffer.alloc(16, 9);
  const sessions = new Map<string, ResumeSession>();
  const sinkFor = (path: MemoryPath, session: ResumeSession): ResumePathSink => ({
    frame: (frame) => session.pathFrame(path, frame),
    ended: (end) => session.pathEnded(path, end),
    drained: () => session.pathDrained(path),
    laneLost: () => undefined,
  });
  return {
    sessions,
    accept(path: MemoryPath) {
      path.attach({
        frame: (frame) => {
          const [first, ...rest] = parseFrame(frame);
          if (first!.type === RecordType.hello) {
            let session: ResumeSession;
            const hooks = {
              deliver: (data: Buffer) => {
                session.write(Buffer.from(data));
                return true;
              },
              peerFinished: () => session.finish(),
              writable: () => undefined,
              finAcknowledged: () => undefined,
              opened: () => undefined,
              closed: () => undefined,
            };
            session = new ResumeSession({
              role: 'target',
              routeId: 'route-echo',
              sessionId: Buffer.from(first!.sessionId),
              keyId,
              key,
              targetNonce: nonce,
              hooks,
            });
            sessions.set(first!.sessionId.toString('hex'), session);
            path.attach(sinkFor(path, session));
            session.acceptHello(path, first!, rest);
            return;
          }
          const session = sessions.get(first!.sessionId.toString('hex'));
          const reject = session ? session.verifyResume(path.relayId, first!) : RejectCode.unknown;
          if (!session || reject !== null) {
            path.send(encodeRecord({ type: RecordType.resumeRej, sessionId: first!.sessionId, code: reject! }));
            return;
          }
          path.attach(sinkFor(path, session));
          session.acceptResume(path, first!, rest);
        },
        ended: () => undefined,
        drained: () => undefined,
        laneLost: () => undefined,
      });
    },
  };
}

function memoryPair(relayId: string): { source: MemoryPath; target: MemoryPath } {
  const source = new MemoryPath(relayId);
  const target = new MemoryPath(relayId);
  source.peer = target;
  target.peer = source;
  return { source, target };
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function collect(stream: ResumableRelayDuplex): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('ResumableRelayDuplex', () => {
  it('echoes a stream byte-exact across a relay cut and a planned move', async () => {
    const key = Buffer.alloc(32, 3);
    const target = echoTarget(key, 'v1');
    const paths: MemoryPath[] = [];
    let relay = 0;
    const registry = new RelayResumeRegistry();
    const avoided: Array<string | null> = [];
    const duplex = await ResumableRelayDuplex.open({
      routeId: 'route-echo',
      keyId: 'v1',
      key,
      registry,
      dial: async (avoid) => {
        avoided.push(avoid);
        let relayId = `relay-${relay++ % 2}`;
        if (relayId === avoid) relayId = `relay-${relay++ % 2}`;
        const pair = memoryPair(relayId);
        paths.push(pair.source);
        target.accept(pair.target);
        return { path: pair.source };
      },
    });
    expect(duplex.relayId).toBe('relay-0');
    expect(registry.snapshot().byRelay).toEqual({ 'relay-0': { resumable: 1, legacy: 0 } });
    const payload = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + (i >> 9)) & 0xff;
    const received = collect(duplex);
    const writer = (async () => {
      for (let offset = 0; offset < payload.length; offset += 64 * 1024) {
        const chunk = payload.subarray(offset, offset + 64 * 1024);
        if (!duplex.write(chunk)) await new Promise((resolve) => duplex.once('drain', resolve));
        if (offset === 512 * 1024) paths[0]!.cut();
        if (offset === 1536 * 1024) {
          await new Promise((resolve) => setTimeout(resolve, 600));
          await duplex.migrate('drain');
        }
      }
      duplex.end();
    })();
    const [echoed] = await Promise.all([received, writer]);
    expect(echoed.length).toBe(payload.length);
    expect(echoed.equals(payload)).toBe(true);
    const stats = registry.snapshot();
    expect(stats.migrations['path_failure:ok']).toBe(1);
    expect(stats.migrations['drain:ok']).toBe(1);
    // First path, recovery after the cut (the lost relay tried last), planned move off relay-1.
    expect(avoided).toEqual([null, 'relay-0', 'relay-1']);
    if (!duplex.destroyed) await new Promise((resolve) => duplex.once('close', resolve));
    // The CLOSE echo ends the session shortly after the Duplex.
    for (let i = 0; i < 100 && !duplex.resumeSession.isClosed; i++) await new Promise((r) => setTimeout(r, 10));
    expect(duplex.resumeSession.isClosed).toBe(true);
    expect(registry.snapshot().sessions.resumable).toBe(0);
  }, 30_000);

  it('moves to a new path on the same relay when the target replaced its connection (lane)', async () => {
    const key = Buffer.alloc(32, 5);
    const target = echoTarget(key, 'v1');
    const registry = new RelayResumeRegistry();
    const avoided: Array<string | null> = [];
    let dials = 0;
    const duplex = await ResumableRelayDuplex.open({
      routeId: 'route-echo',
      keyId: 'v1',
      key,
      registry,
      dial: async (avoid) => {
        avoided.push(avoid);
        dials++;
        const pair = memoryPair('relay-0');
        target.accept(pair.target);
        return { path: pair.source };
      },
    });
    const received = collect(duplex);
    duplex.write(Buffer.from('before'));
    await new Promise((resolve) => setTimeout(resolve, 600));
    await duplex.migrate('lane');
    duplex.write(Buffer.from('after'));
    duplex.end();
    expect((await received).toString()).toBe('beforeafter');
    expect(dials).toBe(2);
    expect(avoided).toEqual([null, null]);
    expect(duplex.relayId).toBe('relay-0');
    expect(registry.snapshot().migrations['lane:ok']).toBe(1);
    // Housekeeping: no stall is recorded for it, as relayresume counts lane moves (rc.9 item 4).
    expect(registry.snapshot().migrationStallMs).toEqual({ p50: 0, p95: 0 });
  }, 30_000);

  it("leaves a stream where a target's hint moved it when the drain move paced for later comes (stand rc.9 F-2)", async () => {
    // The Relay Pool update drains the local relay: Opfield paces its own streams' moves over a minute. The target's
    // hint moves the stream to UK first; when its paced turn came, the drain move left UK for NL (300 ms).
    const key = Buffer.alloc(32, 6);
    const target = echoTarget(key, 'v1');
    const drainTimers: Array<() => void> = [];
    const registry = new RelayResumeRegistry({
      now: () => Date.now(),
      setTimeout: (callback) => {
        drainTimers.push(callback);
        return drainTimers.length;
      },
      clearTimeout: () => undefined,
    });
    const avoided: Array<string | null> = [];
    let first = true;
    const duplex = await ResumableRelayDuplex.open({
      routeId: 'route-echo',
      keyId: 'v1',
      key,
      registry,
      timers: realTimers,
      dial: async (avoid) => {
        avoided.push(avoid);
        // The relay order of the assignment that replaces the local relay: UK, then NL; the relay left goes last.
        const relayId = first ? 'local' : avoid === 'uk' ? 'nl' : 'uk';
        first = false;
        const pair = memoryPair(relayId);
        target.accept(pair.target);
        return { path: pair.source };
      },
    });
    const received = collect(duplex);
    duplex.write(Buffer.from('a'));
    expect(registry.drainRelay('local', Date.now() + 60_000)).toBe(1);
    // The target's candidate on the local relay drains: it asks the stream to move.
    const [targetSession] = [...target.sessions.values()];
    targetSession!.requestMigration(MigrateReason.drain);
    await waitFor(() => duplex.relayId === 'uk');
    // The paced drain move comes: the stream is no longer on the relay it was meant to leave.
    for (const fire of drainTimers.splice(0)) fire();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(duplex.relayId).toBe('uk');
    expect(avoided).toEqual([null, 'local']);
    duplex.write(Buffer.from('b'));
    duplex.end();
    expect((await received).toString()).toBe('ab');
    expect(registry.snapshot().migrations).toEqual({ 'target_hint:ok': 1 });
  }, 30_000);

  it('returns to the best relay and stays where it is when that is the current one', async () => {
    const key = Buffer.alloc(32, 7);
    const target = echoTarget(key, 'v1');
    const registry = new RelayResumeRegistry();
    const avoided: Array<string | null> = [];
    // The nearer relay does not open: the dialer's next relay is the current one, not a third, farther one.
    const order = ['uk', 'uk', 'local'];
    const paths: MemoryPath[] = [];
    const duplex = await ResumableRelayDuplex.open({
      routeId: 'route-echo',
      keyId: 'v1',
      key,
      registry,
      dial: async (avoid) => {
        avoided.push(avoid);
        const pair = memoryPair(order.shift()!);
        paths.push(pair.source);
        target.accept(pair.target);
        return { path: pair.source };
      },
    });
    const received = collect(duplex);
    duplex.write(Buffer.from('x'));
    await duplex.migrate('return', 'uk');
    expect(duplex.relayId).toBe('uk');
    expect(paths[1]!.dead).toBe(true);
    // A return judged for a relay the stream has left by now is dropped.
    await duplex.migrate('return', 'nl');
    expect(avoided).toEqual([null, null]);
    await duplex.migrate('return', 'uk');
    expect(duplex.relayId).toBe('local');
    expect(avoided).toEqual([null, null, null]);
    duplex.write(Buffer.from('y'));
    duplex.end();
    expect((await received).toString()).toBe('xy');
    // Staying is no move: only the real one is counted.
    expect(registry.snapshot().migrations).toEqual({ 'return:ok': 1 });
  }, 30_000);

  it('spreads drain moves over at most a minute whatever the drain grace', () => {
    const delays: number[] = [];
    const timers: ResumeTimers = {
      now: () => 1_000_000,
      setTimeout: (_callback, ms) => {
        delays.push(ms);
        return delays.length;
      },
      clearTimeout: () => undefined,
    };
    const registry = new RelayResumeRegistry(timers);
    for (let i = 0; i < 50; i++) registry.add({ relayId: 'relay-a', migrate: async () => undefined } as any);
    expect(registry.drainRelay('relay-a', 1_000_000 + 30 * 60_000)).toBe(50);
    expect(Math.max(...delays)).toBeLessThanOrEqual(60_000);
    expect(Math.max(...delays)).toBeGreaterThan(30_000);
    delays.length = 0;
    registry.drainRelay('relay-a', 0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(1_000);
  });

  it('keeps a drain notice that arrives during the handshake and moves once open', async () => {
    const key = Buffer.alloc(32, 4);
    const target = echoTarget(key, 'v1');
    let relay = 0;
    const registry = new RelayResumeRegistry();
    const opening = ResumableRelayDuplex.open({
      routeId: 'route-echo',
      keyId: 'v1',
      key,
      registry,
      dial: async (avoid) => {
        let relayId = `relay-${relay++ % 2}`;
        if (relayId === avoid) relayId = `relay-${relay++ % 2}`;
        const pair = memoryPair(relayId);
        // The target answers the HELLO late (a slow backend dial).
        if (relayId === 'relay-0') {
          const attach = pair.target.attach.bind(pair.target);
          let first = true;
          pair.target.attach = (sink) => {
            if (!first) return attach(sink);
            first = false;
            setTimeout(() => attach(sink), 200);
          };
        }
        target.accept(pair.target);
        return { path: pair.source };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(registry.drainRelay('relay-0')).toBe(1);
    const duplex = await opening;
    for (let i = 0; i < 200 && duplex.relayId !== 'relay-1'; i++) await new Promise((r) => setTimeout(r, 10));
    expect(duplex.relayId).toBe('relay-1');
    duplex.destroy();
  });

  it('rejects with legacy_peer and latches the route when the target is old', async () => {
    const registry = new RelayResumeRegistry();
    const open = ResumableRelayDuplex.open({
      routeId: 'route-old',
      keyId: 'v1',
      key: Buffer.alloc(32, 1),
      registry,
      dial: async () => {
        const pair = memoryPair('relay-0');
        // The old target forwards the HELLO to its backend, which answers with raw bytes.
        pair.target.attach({
          frame: () => pair.target.send(Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n')),
          ended: () => undefined,
          drained: () => undefined,
          laneLost: () => undefined,
        });
        return { path: pair.source };
      },
    });
    await expect(open).rejects.toMatchObject({ code: 'legacy_peer' });
    expect(registry.isLegacy('route-old')).toBe(true);
    expect(registry.isLegacy('route-old', 'v1')).toBe(true);
    expect(registry.isLegacy('route-other')).toBe(false);
    // Opfield turned the route back on with a new key version: the latch ends at once.
    expect(registry.isLegacy('route-old', 'v2')).toBe(false);
    expect(registry.isLegacy('route-old', 'v1')).toBe(false);
  });
});

describe('RSv1 window extension', () => {
  /**
   * A bulk upload over one path with a fixed round trip. legacyTarget: the target announces even windows, as every
   * release before the extension did. lanBytes: before the bulk upload the stream carries that much over a 1 ms round
   * trip, 256 KiB at a time (a LAN transfer the window never limits); the path's round trip then grows to rttMs.
   */
  function bulkUpload(legacyTarget: boolean, rttMs: number, bytes: number, lanBytes = 0) {
    const clock = new VirtualClock();
    const key = Buffer.alloc(32, 7);
    const routeId = 'route-wnd';
    const nonce = Buffer.alloc(16, 9);
    const events: Array<{ at: number; run: () => void }> = [];
    let pathRttMs = lanBytes > 0 ? 1 : rttMs;
    const later = (run: () => void) => events.push({ at: clock.now() + pathRttMs / 2, run });
    let target: ResumeSession | null = null;
    let peakSourceWindow = 0;
    let lanPeakWindow = 0;
    let peakQueued = 0;
    let delivered = 0;
    let blocked = false;
    const handle = (side: 'source' | 'target'): ResumePathHandle => ({
      relayId: 'relay-0',
      maxFrameBytes: MAX_FRAME_BYTES,
      send: (frame) => {
        const copy = Buffer.from(frame);
        later(() => (side === 'source' ? deliverToTarget(copy) : source.pathFrame(sourceHandle, copy)));
        return true;
      },
      close: () => undefined,
      cancel: () => undefined,
    });
    const sourceHandle = handle('source');
    const targetHandle = handle('target');
    const noHooks = {
      peerFinished: () => undefined,
      finAcknowledged: () => undefined,
      opened: () => undefined,
      closed: () => undefined,
    };
    const deliverToTarget = (frame: Buffer) => {
      if (!target) {
        const [hello, ...rest] = parseFrame(frame);
        target = new ResumeSession({
          role: 'target',
          routeId,
          sessionId: Buffer.from(hello!.sessionId),
          keyId: 'v1',
          key,
          targetNonce: nonce,
          timers: clock,
          budget: new WindowBudget(),
          hooks: {
            ...noHooks,
            deliver: (data: Buffer) => {
              delivered += data.length;
              return true;
            },
            writable: () => undefined,
          },
        });
        if (legacyTarget) {
          // Every release before the extension announces its window as is.
          const legacy = target as unknown as { announcedWindow: () => bigint; window: number };
          legacy.announcedWindow = () => BigInt(legacy.window);
        }
        target.acceptHello(targetHandle, hello!, rest);
        return;
      }
      target.pathFrame(targetHandle, frame);
    };
    const source = new ResumeSession({
      role: 'source',
      routeId,
      sessionId: Buffer.alloc(16, 3),
      keyId: 'v1',
      key,
      timers: clock,
      budget: new WindowBudget(),
      hooks: {
        ...noHooks,
        deliver: () => true,
        writable: () => {
          blocked = false;
        },
      },
    });
    source.startSource(sourceHandle);
    const chunk = Buffer.alloc(32 * 1024, 1);
    let written = 0;
    let bulkFrom = 1_000_000;
    let bulk = lanBytes === 0;
    const total = lanBytes + bytes;
    for (let step = 0; step < 2_000_000 && delivered < total; step++) {
      if (!bulk && delivered >= lanBytes && source.unackedBytes === 0) {
        // The LAN part arrived and was acknowledged; the round trip grows from here on.
        bulk = true;
        pathRttMs = rttMs;
        bulkFrom = clock.now();
      }
      // The LAN part writes the next 256 KiB once the last arrived.
      const limit = bulk ? total : Math.min(lanBytes, delivered === written ? written + 256 * 1024 : written);
      while (!blocked && written < limit) {
        written += chunk.length;
        if (!source.write(chunk)) blocked = true;
      }
      if (bulk) peakSourceWindow = Math.max(peakSourceWindow, source.effectiveWindow);
      else lanPeakWindow = Math.max(lanPeakWindow, source.effectiveWindow);
      peakQueued = Math.max(peakQueued, source.unackedBytes);
      events.sort((a, b) => a.at - b.at);
      const next = events.shift();
      const timerAt = clock.nextAt();
      if (next && (timerAt === null || next.at <= timerAt)) {
        clock.advanceTo(next.at);
        next.run();
      } else if (!clock.fireNext()) break;
    }
    return {
      delivered: delivered - lanBytes,
      peakSourceWindow,
      lanPeakWindow,
      peakQueued,
      seconds: (clock.now() - bulkFrom) / 1000,
      source,
    };
  }

  it('grows past MAX_WINDOW between two sessions that announce it', () => {
    const run = bulkUpload(false, 300, 256 * 1024 * 1024);
    expect(run.delivered).toBeGreaterThanOrEqual(256 * 1024 * 1024);
    expect(run.source.peerAnnouncedExtension).toBe(true);
    expect(run.peakSourceWindow).toBe(MAX_EXTENDED_WINDOW);
    // 256 MiB over a 300 ms round trip: well above the 4 MiB window's 14 MB/s.
    expect(256 / run.seconds).toBeGreaterThan(40);
  });

  it('takes the window a longer path needs after the round trip grew under the stream', () => {
    // Stand rc.7 F-5: a LAN transfer first, then the path's round trip grows from 1 to 300 ms. The window grew only
    // while it was below twice a bandwidth-delay product scaled to the LAN round trip of before.
    const run = bulkUpload(false, 300, 256 * 1024 * 1024, 64 * 1024 * 1024);
    expect(run.delivered).toBeGreaterThanOrEqual(256 * 1024 * 1024);
    expect(run.lanPeakWindow).toBeLessThanOrEqual(MAX_WINDOW);
    expect(run.peakSourceWindow).toBe(MAX_EXTENDED_WINDOW);
    expect(256 / run.seconds).toBeGreaterThan(40);
  });

  it('keeps a peer before the extension within MAX_WINDOW', () => {
    const run = bulkUpload(true, 300, 64 * 1024 * 1024);
    expect(run.delivered).toBeGreaterThanOrEqual(64 * 1024 * 1024);
    expect(run.source.peerAnnouncedExtension).toBe(false);
    expect(run.peakSourceWindow).toBeLessThanOrEqual(MAX_WINDOW);
    expect(run.peakQueued).toBeLessThanOrEqual(MAX_WINDOW + 32 * 1024);
  });
});
