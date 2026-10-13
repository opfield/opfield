/**
 * Resumable relay streams (RSv1), the TypeScript port of packages/daemons/shared/relayresume.
 *
 * A session layer carried inside relay TunnelData payloads between the two endpoints, so a stream moves to another
 * relay (or to the same relay after a restart) without the local side noticing. Relays are unchanged: they see
 * ordinary Data frames. The wire format, MAC transcripts and key derivation are frozen in
 * packages/daemons/shared/relayresume/doc.go; proto/testdata/relay-resume-v1.json holds the normative vectors.
 *
 * Opfield is only ever a source (it opens tunnels). The target role is here for the simulator and interop tests.
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { Duplex } from 'node:stream';

export const RELAY_RESUME_CAPABILITY = 'relay_stream_resume_v1';

export const RESUME_VERSION = 1;
export const RESUME_MAGIC = Buffer.from('GWRS', 'latin1');
export const MAC_LEN = 16;
export const SESSION_ID_LEN = 16;
export const NONCE_LEN = 16;
export const KEY_LEN = 32;
export const MAX_KEY_ID_LEN = 64;
export const MAX_REASON_LEN = 255;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MIN_PATH_FRAME_BYTES = 256;
/** Type byte plus a 10-byte uvarint ack. */
export const MAX_RECORD_HEADER = 11;
const TRANSCRIPT_DOMAIN = 'gw-relay-resume/v1';

export const RecordType = {
  data: 0x01,
  ack: 0x02,
  fin: 0x03,
  rst: 0x04,
  close: 0x05,
  hello: 0x10,
  helloAck: 0x11,
  resume: 0x12,
  resumeAck: 0x13,
  resumeRej: 0x14,
  migrateReq: 0x15,
} as const;

export const RejectCode = { unknown: 1, finished: 2, reset: 3, unauthorized: 4, staleEpoch: 5 } as const;

export const RstCode = {
  protocol: 1,
  local: 2,
  suspendTimeout: 3,
  idle: 4,
  halfCloseIdle: 5,
  revoked: 6,
  aborted: 7,
  resumeRejected: 8,
  legacyPeer: 9,
  windowViolation: 10,
} as const;

/** MIGRATE_REQ reasons. `lane`: the target replaced the connection under the path; open a new path on the same relay. */
export const MigrateReason = { drain: 1, goaway: 2, lane: 3 } as const;

/** A stream starts at 1 MiB, or at FALLBACK_WINDOW, then MIN_WINDOW, when the process budget is short. */
export const INITIAL_WINDOW = 1024 * 1024;
export const FALLBACK_WINDOW = 256 * 1024;
export const MIN_WINDOW = 64 * 1024;
/** The largest window towards a peer that does not announce the window extension (every release before it). */
export const MAX_WINDOW = 4 * 1024 * 1024;
/**
 * The largest window towards a peer that announces the window extension: a stream through a far relay needs a
 * window of its whole round trip (both relay legs).
 */
export const MAX_EXTENDED_WINDOW = 32 * 1024 * 1024;
/** The bit a session sets in every window it announces (HELLO, HELLO_ACK, ACK): it takes MAX_EXTENDED_WINDOW. */
export const WINDOW_EXTENSION = 1;
/**
 * The bit a session sets in every window it announces: it takes MIGRATE_REQ `lane` (a new path on the same relay).
 * Targets send `lane` only to sources that announce it.
 */
export const LANE_MIGRATION = 2;
export const DEFAULT_PROCESS_BUDGET = 256 * 1024 * 1024;
export const DELAYED_ACK_MS = 20;

export const FIRST_RECORD_TIMEOUT_MS = 1_000;
export const OPEN_TIMEOUT_MS = 5_000;
export const RESUME_ACK_TIMEOUT_MS = 5_000;
export const HELLO_ACK_TIMEOUT_MS = 10_000;
export const PLANNED_BUDGET_MS = 30_000;
export const UNPLANNED_BUDGET_MS = 55_000;
export const UNPLANNED_BACKOFF_MIN_MS = 250;
export const UNPLANNED_BACKOFF_MAX_MS = 2_000;
export const TARGET_SUSPEND_TIMEOUT_MS = 60_000;
export const TOMBSTONE_TTL_MS = 120_000;
export const LEGACY_LATCH_MS = 10 * 60_000;
export const PROXY_HALF_CLOSE_TIMEOUT_MS = 30_000;
export const CLOSE_LINGER_TIMEOUT_MS = 10_000;
export const DRAIN_DEADLINE_MARGIN_MS = 15_000;
export const MAX_MIGRATIONS_IN_FLIGHT = 32;
export const DEFAULT_DRAIN_SPREAD_MS = 60_000;

const U64_MAX = (1n << 64n) - 1n;

// ---------------------------------------------------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------------------------------------------------

export class MalformedRecordError extends Error {
  constructor(detail = 'malformed record') {
    super(`relayresume: ${detail}`);
  }
}

/** One decoded record. Only the fields of its type are meaningful. Payload and reason alias the parsed frame. */
export interface ResumeRecord {
  type: number;
  /** DATA, ACK, FIN */
  ack: bigint;
  /** ACK, HELLO, HELLO_ACK */
  wnd: bigint;
  /** DATA */
  payload: Buffer;
  /** RST, RESUME_REJ, MIGRATE_REQ (reason) */
  code: number;
  /** RST */
  reason: Buffer;
  /** HELLO, RESUME */
  version: number;
  /** HELLO, RESUME */
  keyId: string;
  sessionId: Buffer;
  /** HELLO_ACK */
  nonce: Buffer;
  /** RESUME, RESUME_ACK */
  epoch: bigint;
  /** RESUME, RESUME_ACK */
  rcvNxt: bigint;
  /** RESUME_ACK */
  sendFrom: bigint;
  /** HELLO, HELLO_ACK, RESUME, RESUME_ACK */
  mac: Buffer;
}

const EMPTY = Buffer.alloc(0);
const ZERO_ID = Buffer.alloc(SESSION_ID_LEN);
const ZERO_MAC = Buffer.alloc(MAC_LEN);

export function emptyRecord(type: number): ResumeRecord {
  return {
    type,
    ack: 0n,
    wnd: 0n,
    payload: EMPTY,
    code: 0,
    reason: EMPTY,
    version: 0,
    keyId: '',
    sessionId: ZERO_ID,
    nonce: ZERO_ID,
    epoch: 0n,
    rcvNxt: 0n,
    sendFrom: 0n,
    mac: ZERO_MAC,
  };
}

class Reader {
  constructor(
    readonly buffer: Buffer,
    public offset: number
  ) {}

  get remaining(): number {
    return this.buffer.length - this.offset;
  }

  /** Minimal unsigned LEB128, at most 10 bytes and 64 bits. */
  uvarint(): bigint {
    const buffer = this.buffer;
    // Up to 4 bytes (28 bits) stay in a number; longer values continue in a bigint.
    let small = 0;
    let big: bigint | null = null;
    for (let i = 0; i < 10 && this.offset + i < buffer.length; i++) {
      const b = buffer[this.offset + i]!;
      if (i === 9 && b > 1) throw new MalformedRecordError('uvarint over 64 bits');
      const part = b & 0x7f;
      if (i < 4) small += part * 2 ** (7 * i);
      else {
        big ??= BigInt(small);
        big |= BigInt(part) << BigInt(7 * i);
      }
      if (b < 0x80) {
        if (b === 0 && i > 0) throw new MalformedRecordError('non-minimal uvarint');
        this.offset += i + 1;
        return big ?? BigInt(small);
      }
    }
    throw new MalformedRecordError('truncated uvarint');
  }

  fixed(length: number): Buffer {
    if (this.remaining < length) throw new MalformedRecordError('truncated record');
    const out = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  byte(): number {
    if (this.remaining < 1) throw new MalformedRecordError('truncated record');
    return this.buffer[this.offset++]!;
  }

  magic(): number {
    const magic = this.fixed(RESUME_MAGIC.length);
    if (!magic.equals(RESUME_MAGIC)) throw new MalformedRecordError('bad magic');
    const version = this.byte();
    if (version !== RESUME_VERSION) throw new MalformedRecordError('unknown version');
    return version;
  }

  keyId(): string {
    const length = this.byte();
    if (length < 1 || length > MAX_KEY_ID_LEN) throw new MalformedRecordError('bad key id length');
    return this.fixed(length).toString('latin1');
  }
}

/** Decodes the record at `offset` of frame; returns it and the offset after it. A DATA record ends the frame. */
export function parseRecord(frame: Buffer, offset = 0): { record: ResumeRecord; next: number } {
  if (offset >= frame.length) throw new MalformedRecordError('empty frame');
  const reader = new Reader(frame, offset + 1);
  const record = emptyRecord(frame[offset]!);
  switch (record.type) {
    case RecordType.data:
      record.ack = reader.uvarint();
      if (reader.remaining === 0) throw new MalformedRecordError('empty DATA payload');
      record.payload = frame.subarray(reader.offset);
      return { record, next: frame.length };
    case RecordType.ack:
      record.ack = reader.uvarint();
      record.wnd = reader.uvarint();
      break;
    case RecordType.fin:
      record.ack = reader.uvarint();
      break;
    case RecordType.rst: {
      record.code = reader.byte();
      record.reason = reader.fixed(reader.byte());
      break;
    }
    case RecordType.close:
      break;
    case RecordType.hello:
      record.version = reader.magic();
      record.keyId = reader.keyId();
      record.sessionId = reader.fixed(SESSION_ID_LEN);
      record.wnd = reader.uvarint();
      record.mac = reader.fixed(MAC_LEN);
      break;
    case RecordType.helloAck:
      record.sessionId = reader.fixed(SESSION_ID_LEN);
      record.nonce = reader.fixed(NONCE_LEN);
      record.wnd = reader.uvarint();
      record.mac = reader.fixed(MAC_LEN);
      break;
    case RecordType.resume:
      record.version = reader.magic();
      record.sessionId = reader.fixed(SESSION_ID_LEN);
      record.epoch = reader.uvarint();
      record.rcvNxt = reader.uvarint();
      record.keyId = reader.keyId();
      record.mac = reader.fixed(MAC_LEN);
      break;
    case RecordType.resumeAck:
      record.sessionId = reader.fixed(SESSION_ID_LEN);
      record.epoch = reader.uvarint();
      record.rcvNxt = reader.uvarint();
      record.sendFrom = reader.uvarint();
      record.mac = reader.fixed(MAC_LEN);
      break;
    case RecordType.resumeRej:
      record.sessionId = reader.fixed(SESSION_ID_LEN);
      record.code = reader.byte();
      break;
    case RecordType.migrateReq:
      record.code = reader.byte();
      break;
    default:
      throw new MalformedRecordError(`unknown record type 0x${record.type.toString(16).padStart(2, '0')}`);
  }
  return { record, next: reader.offset };
}

/** Decodes every record of a frame. */
export function parseFrame(frame: Buffer): ResumeRecord[] {
  if (frame.length === 0) throw new MalformedRecordError('empty frame');
  const records: ResumeRecord[] = [];
  let offset = 0;
  while (offset < frame.length) {
    const { record, next } = parseRecord(frame, offset);
    records.push(record);
    offset = next;
  }
  return records;
}

export function uvarintLength(value: number | bigint): number {
  let v = BigInt(value);
  let n = 1;
  while (v >= 0x80n) {
    v >>= 7n;
    n++;
  }
  return n;
}

function pushUvarint(out: number[], value: number | bigint): void {
  if (typeof value === 'number' && value < 2 ** 31) {
    let v = value;
    while (v >= 0x80) {
      out.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(v);
    return;
  }
  let v = BigInt(value);
  if (v < 0n || v > U64_MAX) throw new MalformedRecordError('uvarint out of range');
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
}

function pushBytes(out: number[], bytes: Buffer, length?: number): void {
  if (length !== undefined && bytes.length !== length) throw new MalformedRecordError('bad fixed field length');
  for (const b of bytes) out.push(b);
}

function pushKeyId(out: number[], keyId: string): void {
  const bytes = Buffer.from(keyId, 'latin1');
  if (bytes.length < 1 || bytes.length > MAX_KEY_ID_LEN) throw new MalformedRecordError('bad key id length');
  out.push(bytes.length);
  pushBytes(out, bytes);
}

/** Encodes one record. Fails for a record that would not parse back. */
export function encodeRecord(record: Partial<ResumeRecord> & { type: number }): Buffer {
  const out: number[] = [record.type];
  switch (record.type) {
    case RecordType.data: {
      const payload = record.payload ?? EMPTY;
      if (payload.length === 0) throw new MalformedRecordError('empty DATA payload');
      pushUvarint(out, record.ack ?? 0n);
      return Buffer.concat([Buffer.from(out), payload]);
    }
    case RecordType.ack:
      pushUvarint(out, record.ack ?? 0n);
      pushUvarint(out, record.wnd ?? 0n);
      break;
    case RecordType.fin:
      pushUvarint(out, record.ack ?? 0n);
      break;
    case RecordType.rst: {
      const reason = record.reason ?? EMPTY;
      if (reason.length > MAX_REASON_LEN) throw new MalformedRecordError('RST reason too long');
      out.push(record.code ?? 0, reason.length);
      pushBytes(out, reason);
      break;
    }
    case RecordType.close:
      break;
    case RecordType.hello:
      pushBytes(out, RESUME_MAGIC);
      out.push(RESUME_VERSION);
      pushKeyId(out, record.keyId ?? '');
      pushBytes(out, record.sessionId ?? ZERO_ID, SESSION_ID_LEN);
      pushUvarint(out, record.wnd ?? 0n);
      pushBytes(out, record.mac ?? ZERO_MAC, MAC_LEN);
      break;
    case RecordType.helloAck:
      pushBytes(out, record.sessionId ?? ZERO_ID, SESSION_ID_LEN);
      pushBytes(out, record.nonce ?? ZERO_ID, NONCE_LEN);
      pushUvarint(out, record.wnd ?? 0n);
      pushBytes(out, record.mac ?? ZERO_MAC, MAC_LEN);
      break;
    case RecordType.resume:
      pushBytes(out, RESUME_MAGIC);
      out.push(RESUME_VERSION);
      pushBytes(out, record.sessionId ?? ZERO_ID, SESSION_ID_LEN);
      pushUvarint(out, record.epoch ?? 0n);
      pushUvarint(out, record.rcvNxt ?? 0n);
      pushKeyId(out, record.keyId ?? '');
      pushBytes(out, record.mac ?? ZERO_MAC, MAC_LEN);
      break;
    case RecordType.resumeAck:
      pushBytes(out, record.sessionId ?? ZERO_ID, SESSION_ID_LEN);
      pushUvarint(out, record.epoch ?? 0n);
      pushUvarint(out, record.rcvNxt ?? 0n);
      pushUvarint(out, record.sendFrom ?? 0n);
      pushBytes(out, record.mac ?? ZERO_MAC, MAC_LEN);
      break;
    case RecordType.resumeRej:
      pushBytes(out, record.sessionId ?? ZERO_ID, SESSION_ID_LEN);
      out.push(record.code ?? 0);
      break;
    case RecordType.migrateReq:
      out.push(record.code ?? 0);
      break;
    default:
      throw new MalformedRecordError(`unknown record type 0x${record.type.toString(16).padStart(2, '0')}`);
  }
  return Buffer.from(out);
}

/** DATA header (type and ack); the payload follows it in the same frame. */
export function encodeDataHeader(ack: number): Buffer {
  const out: number[] = [RecordType.data];
  pushUvarint(out, ack);
  return Buffer.from(out);
}

// ---------------------------------------------------------------------------------------------------------------------
// MACs and route keys
// ---------------------------------------------------------------------------------------------------------------------

/** What every MAC of a path is bound to. */
export interface PathMacContext {
  routeId: string;
  /** path_relay_instance_id */
  relayId: string;
  keyId: string;
  key: Buffer;
  sessionId: Buffer;
  /** Zero until HELLO_ACK. */
  targetNonce: Buffer;
}

function str(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const out = Buffer.allocUnsafe(2 + bytes.length);
  out.writeUInt16BE(bytes.length, 0);
  bytes.copy(out, 2);
  return out;
}

function u64(value: number | bigint): Buffer {
  const out = Buffer.allocUnsafe(8);
  out.writeBigUInt64BE(BigInt(value), 0);
  return out;
}

function transcriptPrefix(context: PathMacContext, label: string): Buffer[] {
  return [
    str(TRANSCRIPT_DOMAIN),
    str(label),
    str(context.routeId),
    str(context.relayId),
    str(context.keyId),
    context.sessionId,
  ];
}

export function helloTranscript(context: PathMacContext, wnd: number | bigint): Buffer {
  return Buffer.concat([...transcriptPrefix(context, 'hello'), u64(wnd)]);
}

export function helloAckTranscript(
  context: PathMacContext,
  helloMac: Buffer,
  nonce: Buffer,
  wnd: number | bigint
): Buffer {
  return Buffer.concat([...transcriptPrefix(context, 'hello_ack'), helloMac, nonce, u64(wnd)]);
}

export function resumeTranscript(context: PathMacContext, epoch: number | bigint, rcvNxt: number | bigint): Buffer {
  return Buffer.concat([...transcriptPrefix(context, 'resume'), context.targetNonce, u64(epoch), u64(rcvNxt)]);
}

export function resumeAckTranscript(
  context: PathMacContext,
  epoch: number | bigint,
  rcvNxt: number | bigint,
  sendFrom: number | bigint,
  resumeMac: Buffer
): Buffer {
  return Buffer.concat([
    ...transcriptPrefix(context, 'resume_ack'),
    context.targetNonce,
    u64(epoch),
    u64(rcvNxt),
    u64(sendFrom),
    resumeMac,
  ]);
}

/** HMAC-SHA256(key, transcript) truncated to MAC_LEN bytes. */
export function computeMac(key: Buffer, transcript: Buffer): Buffer {
  return createHmac('sha256', key).update(transcript).digest().subarray(0, MAC_LEN);
}

export function verifyMac(key: Buffer, transcript: Buffer, mac: Buffer): boolean {
  return mac.length === MAC_LEN && timingSafeEqual(computeMac(key, transcript), mac);
}

/** HKDF info of a route key: domain ‖ str(route_id) ‖ u64be(key_version). */
export function routeKeyInfo(routeId: string, keyVersion: number | bigint): Buffer {
  return Buffer.concat([Buffer.from(TRANSCRIPT_DOMAIN, 'latin1'), str(routeId), u64(keyVersion)]);
}

/** Opfield's route resume key: HKDF-SHA256(ikm = resume secret, salt = empty, info), 32 bytes. */
export function deriveRouteKey(secret: Buffer, routeId: string, keyVersion: number | bigint): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), routeKeyInfo(routeId, keyVersion), KEY_LEN));
}

export function routeKeyId(keyVersion: number | bigint): string {
  return `v${BigInt(keyVersion).toString(10)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Session engine
// ---------------------------------------------------------------------------------------------------------------------

/** Timers, injectable so the simulator runs on a virtual clock. */
export interface ResumeTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: ResumeTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * One relay tunnel stream (after Ready) the session runs over. Frames are TunnelData payloads. The owner reports
 * inbound frames and the end of the stream through the session's path methods.
 */
export interface ResumePathHandle {
  readonly relayId: string;
  /** A path through the local relay, on Opfield's own host (its lane lost is a lane move, see attach). */
  readonly local?: boolean;
  readonly maxFrameBytes: number;
  /** Writes one TunnelData payload; false asks the session to wait for pathDrained(). */
  send(frame: Buffer): boolean;
  /** Ends the stream cleanly (relay Close frame). */
  close(): void;
  /** Aborts the stream. */
  cancel(): void;
}

/** Why a path ended: `terminal` keeps today's semantics (relay idle timeout, a relay Error frame). */
export interface PathEnd {
  error?: Error;
  terminal?: boolean;
}

export class ResumeSessionError extends Error {
  constructor(
    message: string,
    readonly code: 'protocol' | 'reset' | 'rejected' | 'legacy_peer' | 'suspend_timeout' | 'terminal' | 'aborted',
    readonly rstCode?: number
  ) {
    super(message);
  }
}

export interface ResumeSessionHooks {
  /** Inbound bytes for the local side; false: the local side is full, stop inbound until readResumed(). */
  deliver(data: Buffer): boolean;
  /** The peer's FIN reached the local side (deliver no more). */
  peerFinished(): void;
  /** The send window opened again after write() returned false. */
  writable(): void;
  /** Every byte written and the FIN were acknowledged. */
  finAcknowledged(): void;
  /** The handshake finished on the first path. */
  opened(): void;
  /** The session ended; no error after a full CLOSE exchange. */
  closed(error?: ResumeSessionError): void;
  /** Source: the current path broke; find another and call resume(). */
  suspended?(reason: string): void;
  /** Source: the target asked to migrate (MIGRATE_REQ). */
  migrateRequested?(reason: number): void;
}

/** Process-wide budget for window growth beyond the floor. */
export class WindowBudget {
  private used = 0;
  constructor(readonly limit = DEFAULT_PROCESS_BUDGET) {}
  tryTake(bytes: number): boolean {
    if (this.used + bytes > this.limit) return false;
    this.used += bytes;
    return true;
  }
  release(bytes: number): void {
    this.used = Math.max(0, this.used - bytes);
  }
  get inUse(): number {
    return this.used;
  }
}

export const defaultWindowBudget = new WindowBudget();

export interface ResumeSessionOptions {
  role: 'source' | 'target';
  routeId: string;
  sessionId: Buffer;
  /** Source: the route key and its id. Target: set from the HELLO by acceptHello(). */
  keyId: string;
  key: Buffer;
  hooks: ResumeSessionHooks;
  timers?: ResumeTimers;
  budget?: WindowBudget;
  initialWindow?: number;
  /** Proxy routes: reset after this long without traffic once the peer finished. 0: off. */
  halfCloseTimeoutMs?: number;
  /** Target only: the per-process nonce. */
  targetNonce?: Buffer;
  /** Stats sink. */
  stats?: ResumeStats;
}

export interface ResumeStats {
  retransmittedBytes: number;
  windowBlockedMs: number;
}

interface PathState {
  handle: ResumePathHandle;
  /** Absolute offset of the next byte this side sends on the path. */
  sndOffset: number;
  /** Absolute offset of the next byte the peer sends on the path. */
  rcvOffset: number;
  /** Waiting for pathDrained(). */
  blocked: boolean;
  alive: boolean;
}

type SessionState = 'hello' | 'open' | 'suspended' | 'closing' | 'closed';

interface PendingResume {
  path: PathState;
  epoch: number;
  mac: Buffer;
  planned: boolean;
  timer: unknown;
  settle: (result: ResumeResult) => void;
}

export type ResumeResult = 'resumed' | 'failed' | 'rejected' | 'closed';

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
/** Received but undelivered bytes beyond this mean the peer ignored its window (as relayresume). */
const MAX_RECEIVE_QUEUE = 2 * (MAX_EXTENDED_WINDOW + MAX_FRAME_BYTES);

function safeNumber(value: bigint): number {
  if (value > MAX_SAFE) throw new ResumeSessionError('offset out of range', 'protocol', RstCode.protocol);
  return Number(value);
}

/**
 * One resumable stream: offsets, acks, the bounded retransmit buffer, FIN/RST/CLOSE and the path swap. It is driven
 * by callbacks only (no timers beyond delayed acks and handshake deadlines), so the simulator can run it on a
 * virtual clock.
 */
export class ResumeSession {
  readonly role: 'source' | 'target';
  readonly routeId: string;
  readonly sessionId: Buffer;
  private keyId: string;
  private key: Buffer;
  private readonly hooks: ResumeSessionHooks;
  private readonly timers: ResumeTimers;
  private readonly budget: WindowBudget;
  private readonly stats?: ResumeStats;
  private readonly halfCloseTimeoutMs: number;

  private state: SessionState = 'hello';
  private current: PathState | null = null;
  /** Source: the path RESUME went out on. */
  private pending: PendingResume | null = null;
  /**
   * Source: a planned move the target refused because it reset the stream meanwhile. Its RST travels on the old
   * path, which the refusal overtook; the stream hears that path out before it counts as cut (stand rc.6 O-3).
   */
  private refusal: { settle: (result: ResumeResult) => void; code: number; timer: unknown } | null = null;
  private targetNonce: Buffer;
  private epoch = 0;
  private helloMac: Buffer = ZERO_MAC;
  private helloTimer: unknown = null;

  // Send side.
  private sndUna = 0;
  private sndNxt = 0;
  private readonly retained: Buffer[] = [];
  /** Absolute offset of retained[0]. */
  private retainedOffset = 0;
  private finOffset = -1;
  private finAcked = false;
  private window: number;
  private sendStopped = false;
  private windowBlockedSince = -1;
  private ackedSinceGrowth = 0;
  /**
   * The peer announced the window extension (an odd window) since the stream last resumed: the window may exceed
   * MAX_WINDOW. A resume forgets it (another process, perhaps an older release, may answer there).
   */
  private peerExtended = false;
  /**
   * The window's round trip (send to the peer's delivery ack): one timed offset at a time; minRtt is the shortest on
   * the current path, bdp the largest bandwidth-delay product measured there. A window above MAX_WINDOW grows only
   * while it is below twice that: on a short path, or while the bytes only wait in a queue, more window would not move
   * them faster. An offset sent while nothing else was on the way (rttClean: the peer acknowledged everything, the
   * stream paused) waited in no queue this stream filled: its round trip is the path's own and replaces minRtt even
   * when longer (the path's round trip can grow under a stream; a minRtt kept from before scaled every later sample
   * down, and the window never grew to the longer path). A stream moving bulk data always has bytes on the way, so a
   * queue it builds never counts as the path.
   */
  private rttOffset = -1;
  private rttAt = 0;
  private rttDelivered = 0;
  private rttClean = false;
  private rttFloor = 0;
  private minRtt = -1;
  private bdp = 0;

  // Receive side.
  /** In-order bytes received (and the peer's FIN unit), queued or delivered: RESUME and RESUME_ACK carry it. */
  private rcvNxt = 0;
  /** Bytes handed to the local side (and the FIN unit): every ack carries it. */
  private delivered = 0;
  private readonly recvQueue: Buffer[] = [];
  private recvQueued = 0;
  private localFull = false;
  private peerFinOffset = -1;
  private peerFinished = false;
  private lastAckSent = 0;
  private peerWindow = INITIAL_WINDOW;
  private ackTimer: unknown = null;
  private halfCloseTimer: unknown = null;
  private closeTimer: unknown = null;
  private closeSent = false;
  private closeOnPath: PathState | null = null;
  private closeReceived = false;

  constructor(options: ResumeSessionOptions) {
    if (options.sessionId.length !== SESSION_ID_LEN) throw new Error('session id must be 16 bytes');
    this.role = options.role;
    this.routeId = options.routeId;
    this.sessionId = options.sessionId;
    this.keyId = options.keyId;
    this.key = options.key;
    this.hooks = options.hooks;
    this.timers = options.timers ?? realTimers;
    this.budget = options.budget ?? defaultWindowBudget;
    this.stats = options.stats;
    this.halfCloseTimeoutMs = options.halfCloseTimeoutMs ?? 0;
    this.targetNonce = options.targetNonce ?? ZERO_ID;
    const initial = Math.max(MIN_WINDOW, Math.min(MAX_EXTENDED_WINDOW, options.initialWindow ?? INITIAL_WINDOW));
    this.window = MIN_WINDOW;
    for (const target of [initial, Math.min(initial, FALLBACK_WINDOW)]) {
      if (target > MIN_WINDOW && this.budget.tryTake(target - MIN_WINDOW)) {
        this.window = target;
        break;
      }
    }
  }

  get isOpen(): boolean {
    return this.state === 'open' && !this.refusal;
  }
  get isClosed(): boolean {
    return this.state === 'closed';
  }
  get isSuspended(): boolean {
    return this.state === 'suspended';
  }
  get migrating(): boolean {
    return this.pending !== null;
  }
  get currentRelayId(): string | null {
    return this.current?.alive ? this.current.handle.relayId : null;
  }
  get unackedBytes(): number {
    return this.sndNxt - this.sndUna;
  }
  get sendWindow(): number {
    return this.window;
  }
  /** The window the session sends with: within MAX_WINDOW unless the peer announced the window extension. */
  get effectiveWindow(): number {
    return this.peerExtended ? this.window : Math.min(this.window, MAX_WINDOW);
  }
  get peerAnnouncedExtension(): boolean {
    return this.peerExtended;
  }
  get receivedOffset(): number {
    return this.rcvNxt;
  }
  get sentOffset(): number {
    return this.sndNxt;
  }
  /** Both directions finished and acknowledged. */
  get complete(): boolean {
    return this.finAcked && this.peerFinished;
  }
  get currentEpoch(): number {
    return this.epoch;
  }

  // -- Source handshake ------------------------------------------------------------------------------------------

  /** Source: starts the session on its first path with a HELLO. */
  startSource(handle: ResumePathHandle, helloTimeoutMs = HELLO_ACK_TIMEOUT_MS): void {
    if (this.role !== 'source' || this.current) throw new Error('startSource on a started session');
    this.current = this.newPath(handle, 0, 0);
    const context = this.macContext(handle.relayId);
    this.helloMac = computeMac(this.key, helloTranscript(context, this.announcedWindow()));
    this.helloTimer = this.timers.setTimeout(() => {
      this.helloTimer = null;
      // An old target forwards the HELLO to its backend and never answers it.
      if (this.state === 'hello') this.legacyPeer('no HELLO_ACK from the target');
    }, helloTimeoutMs);
    this.rawSend(
      this.current,
      encodeRecord({
        type: RecordType.hello,
        keyId: this.keyId,
        sessionId: this.sessionId,
        wnd: this.announcedWindow(),
        mac: this.helloMac,
      })
    );
  }

  // -- Target handshake (simulator, interop) ---------------------------------------------------------------------

  /** Target: answers a verified HELLO on its first path; `rest` holds the records after the HELLO. */
  acceptHello(handle: ResumePathHandle, hello: ResumeRecord, rest: ResumeRecord[]): void {
    if (this.role !== 'target' || this.current) throw new Error('acceptHello on a started session');
    this.current = this.newPath(handle, 0, 0);
    this.state = 'open';
    this.notePeerWindow(hello.wnd);
    this.helloMac = hello.mac;
    const context = this.macContext(handle.relayId);
    const wnd = this.announcedWindow();
    const mac = computeMac(this.key, helloAckTranscript(context, hello.mac, this.targetNonce, wnd));
    this.rawSend(
      this.current,
      encodeRecord({ type: RecordType.helloAck, sessionId: this.sessionId, nonce: this.targetNonce, wnd, mac })
    );
    this.hooks.opened();
    this.processRecords(this.current, rest);
  }

  /** Target: verifies a RESUME for this session; the caller already matched the session id and route. */
  verifyResume(relayId: string, resume: ResumeRecord): number | null {
    const keys: Array<[string, Buffer]> = [[this.keyId, this.key]];
    const key = keys.find(([id]) => id === resume.keyId)?.[1];
    if (!key) return RejectCode.unauthorized;
    const context = { ...this.macContext(relayId), key, keyId: resume.keyId };
    if (!verifyMac(key, resumeTranscript(context, resume.epoch, resume.rcvNxt), resume.mac)) {
      return RejectCode.unauthorized;
    }
    if (this.state === 'closed') return RejectCode.finished;
    if (resume.epoch <= BigInt(this.epoch)) return RejectCode.staleEpoch;
    return null;
  }

  /** Target: moves to the path a verified RESUME arrived on and answers RESUME_ACK. */
  acceptResume(handle: ResumePathHandle, resume: ResumeRecord, rest: ResumeRecord[]): void {
    if (this.role !== 'target') throw new Error('acceptResume on a source');
    const sendFrom = safeNumber(resume.rcvNxt);
    if (sendFrom < this.sndUna || sendFrom > this.sndNxt) {
      this.abort(RstCode.protocol, 'resume offset out of range');
      return;
    }
    // Stop the old path first: rcv_nxt is final for it.
    const old = this.current;
    if (old && old !== null) this.retirePath(old, true);
    this.epoch = safeNumber(resume.epoch);
    const path = this.newPath(handle, sendFrom, this.rcvNxt);
    this.current = path;
    this.newPathTiming();
    this.applyAck(sendFrom, false);
    this.cancelSuspendTimer();
    this.state = this.closeSent ? 'closing' : 'open';
    const context = this.macContext(handle.relayId);
    const mac = computeMac(this.key, resumeAckTranscript(context, resume.epoch, this.rcvNxt, sendFrom, resume.mac));
    this.rawSend(
      path,
      encodeRecord({
        type: RecordType.resumeAck,
        sessionId: this.sessionId,
        epoch: resume.epoch,
        rcvNxt: BigInt(this.rcvNxt),
        sendFrom: resume.rcvNxt,
        mac,
      })
    );
    this.lastAckSent = Math.max(this.lastAckSent, this.delivered);
    this.sendStopped = false;
    this.retransmit(path);
    this.processRecords(path, rest);
    // The source's window counts from what reached this side's socket (as relayresume does): tell it at once.
    this.maybeAck(true, true);
  }

  /** Target: asks the source to move (its relay is draining or got GOAWAY). */
  requestMigration(reason: number): void {
    if (this.role !== 'target' || !this.current?.alive || this.state !== 'open') return;
    this.rawSend(this.current, encodeRecord({ type: RecordType.migrateReq, code: reason }));
  }

  // -- Source migration ------------------------------------------------------------------------------------------

  /**
   * Source: moves the session to `handle` (a fresh tunnel on another relay, or the same relay back). Planned: the
   * current path keeps delivering inbound data until the target answers; on failure the session stays on it.
   */
  resume(handle: ResumePathHandle, timeoutMs = RESUME_ACK_TIMEOUT_MS): Promise<ResumeResult> {
    if (this.role !== 'source') throw new Error('resume on a target');
    if (this.state === 'closed' || this.state === 'hello' || this.refusal) {
      handle.cancel();
      return Promise.resolve('closed');
    }
    if (this.pending) {
      handle.cancel();
      return Promise.resolve('failed');
    }
    const planned = this.state !== 'suspended' && !!this.current?.alive;
    // Stop sending everything on the old path, so the target's snd_una never passes RESUME.rcv_nxt.
    this.sendStopped = true;
    this.cancelAckTimer();
    this.epoch += 1;
    const path = this.newPath(handle, -1, -1);
    const context = this.macContext(handle.relayId);
    const mac = computeMac(this.key, resumeTranscript(context, this.epoch, this.rcvNxt));
    return new Promise<ResumeResult>((settle) => {
      const pending: PendingResume = {
        path,
        epoch: this.epoch,
        mac,
        planned,
        timer: null,
        settle,
      };
      pending.timer = this.timers.setTimeout(() => this.failResume(pending, 'failed'), timeoutMs);
      this.pending = pending;
      this.rawSend(
        path,
        encodeRecord({
          type: RecordType.resume,
          sessionId: this.sessionId,
          epoch: BigInt(this.epoch),
          rcvNxt: BigInt(this.rcvNxt),
          keyId: this.keyId,
          mac,
        })
      );
    });
  }

  private failResume(pending: PendingResume, result: ResumeResult): void {
    if (this.pending !== pending) return;
    this.pending = null;
    this.timers.clearTimeout(pending.timer);
    this.retirePath(pending.path, true);
    if (this.state !== 'closed' && this.state !== 'suspended') {
      if (this.current?.alive) {
        // Planned: stay on the current path.
        this.sendStopped = false;
        this.flush();
        this.sendCloseIfDue();
        this.maybeAck();
      } else {
        this.suspend('relay path ended during a migration');
      }
    } else if (this.state === 'suspended' && pending.planned) {
      // The old path died while a planned move was in flight and the move failed too: start recovering.
      this.hooks.suspended?.('relay path ended during a migration');
    }
    pending.settle(result);
  }

  private completeResume(pending: PendingResume, ack: ResumeRecord, rest: ResumeRecord[]): void {
    const context = this.macContext(pending.path.handle.relayId);
    const valid =
      ack.sessionId.equals(this.sessionId) &&
      ack.epoch === BigInt(pending.epoch) &&
      ack.sendFrom <= BigInt(this.rcvNxt) &&
      verifyMac(this.key, resumeAckTranscript(context, ack.epoch, ack.rcvNxt, ack.sendFrom, pending.mac), ack.mac);
    if (!valid) {
      this.failResume(pending, 'failed');
      return;
    }
    const targetRcvNxt = safeNumber(ack.rcvNxt);
    if (targetRcvNxt < this.sndUna || targetRcvNxt > this.sndNxt) {
      this.pending = null;
      this.timers.clearTimeout(pending.timer);
      this.abort(RstCode.protocol, 'resume ack offset out of range');
      pending.settle('closed');
      return;
    }
    this.pending = null;
    this.timers.clearTimeout(pending.timer);
    const old = this.current;
    if (old && old !== pending.path) this.retirePath(old, true);
    const path = pending.path;
    path.rcvOffset = safeNumber(ack.sendFrom);
    path.sndOffset = targetRcvNxt;
    this.current = path;
    this.newPathTiming();
    this.applyAck(targetRcvNxt, false);
    if (this.state === 'suspended') this.state = this.closeSent ? 'closing' : 'open';
    this.sendStopped = false;
    this.retransmit(path);
    this.sendCloseIfDue();
    pending.settle('resumed');
    this.processRecords(path, rest);
    // The target's window counts from what reached this side's socket (as relayresume does): tell it at once.
    this.maybeAck(true, true);
  }

  // -- Local side ------------------------------------------------------------------------------------------------

  /** Queues local bytes. Returns false when the window is full: wait for hooks.writable(). */
  write(data: Buffer): boolean {
    if (this.state === 'closed') throw new ResumeSessionError('session is closed', 'aborted');
    if (this.finOffset >= 0) throw new Error('write after finish');
    if (data.length === 0) return this.windowOpen();
    this.retained.push(data);
    this.sndNxt += data.length;
    this.touchHalfClose();
    this.flush();
    const open = this.windowOpen();
    if (!open && this.windowBlockedSince < 0) this.windowBlockedSince = this.timers.now();
    return open;
  }

  /** The local side reached EOF: sends FIN after the data. */
  finish(): void {
    if (this.state === 'closed' || this.finOffset >= 0) return;
    this.finOffset = this.sndNxt;
    this.sndNxt += 1;
    this.flush();
  }

  /** The local side reads again after deliver() returned false. */
  readResumed(): void {
    if (!this.localFull) return;
    this.localFull = false;
    this.drainReceived();
  }

  /** Resets the stream: RST on the current path when it is alive, then closes. */
  abort(code: number = RstCode.aborted, reason = ''): void {
    if (this.state === 'closed') return;
    const path = this.current;
    if (path?.alive && !this.pendingOnly()) {
      path.blocked = false;
      this.rawSend(path, encodeRecord({ type: RecordType.rst, code, reason: Buffer.from(reason).subarray(0, 255) }));
    }
    this.terminate(new ResumeSessionError(reason || `reset (${code})`, 'aborted', code), true);
  }

  // -- Path events -----------------------------------------------------------------------------------------------

  /** An inbound TunnelData payload on `handle`. */
  pathFrame(handle: ResumePathHandle, frame: Buffer): void {
    const path = this.pathOf(handle);
    if (!path || this.state === 'closed') return;
    let records: ResumeRecord[];
    try {
      records = parseFrame(frame);
    } catch {
      if (this.state === 'hello') this.legacyPeer('first target record is not a HELLO_ACK');
      else this.abort(RstCode.protocol, 'malformed record');
      return;
    }
    if (this.state === 'hello' && path === this.current) {
      this.handleHelloAck(path, records);
      return;
    }
    if (this.pending?.path === path) {
      const [first, ...rest] = records;
      if (first?.type === RecordType.resumeAck) {
        this.completeResume(this.pending, first, rest);
        return;
      }
      if (first?.type === RecordType.resumeRej) {
        this.handleReject(this.pending, first);
        return;
      }
      if (first?.type === RecordType.rst) {
        this.handleRecords(path, [first]);
        return;
      }
      this.failResume(this.pending, 'failed');
      return;
    }
    this.processRecords(path, records);
  }

  /** The tunnel stream behind `handle` ended (or failed). */
  pathEnded(handle: ResumePathHandle, end: PathEnd = {}): void {
    const path = this.pathOf(handle);
    if (!path) return;
    path.alive = false;
    if (this.state === 'closed') return;
    if (this.pending?.path === path) {
      this.failResume(this.pending, 'failed');
      return;
    }
    if (path !== this.current) return;
    if (this.refusal) {
      // The old path ended without telling how the target ended the stream.
      this.endRefused();
      return;
    }
    if (this.pending) {
      // The target let go of the old path for the RESUME in flight; its answer decides.
      if (this.state !== 'hello') this.state = 'suspended';
      return;
    }
    if (this.state === 'hello') {
      // Not resumable before HELLO_ACK: cut.
      this.terminate(
        new ResumeSessionError(end.error?.message ?? 'relay tunnel ended before HELLO_ACK', 'terminal'),
        true
      );
      return;
    }
    if (end.terminal) {
      this.terminate(new ResumeSessionError(end.error?.message ?? 'relay tunnel ended', 'terminal'), false);
      return;
    }
    // Also while CLOSE is in flight: the target may not have it yet, so resume and send it again (or learn
    // RESUME_REJ finished); the close linger bounds this.
    this.suspend(end.error?.message ?? 'relay path ended');
  }

  /** The path accepts writes again. */
  pathDrained(handle: ResumePathHandle): void {
    const path = this.pathOf(handle);
    if (!path) return;
    path.blocked = false;
    if (path === this.current) {
      this.flush();
      this.maybeAck();
    }
  }

  // -- Internals -------------------------------------------------------------------------------------------------

  private handleHelloAck(path: PathState, records: ResumeRecord[]): void {
    const [first, ...rest] = records;
    if (first?.type !== RecordType.helloAck || !first.sessionId.equals(this.sessionId)) {
      this.legacyPeer();
      return;
    }
    const context = this.macContext(path.handle.relayId);
    if (!verifyMac(this.key, helloAckTranscript(context, this.helloMac, first.nonce, first.wnd), first.mac)) {
      this.legacyPeer();
      return;
    }
    if (this.helloTimer) this.timers.clearTimeout(this.helloTimer);
    this.helloTimer = null;
    this.targetNonce = Buffer.from(first.nonce);
    this.notePeerWindow(first.wnd);
    this.state = 'open';
    this.hooks.opened();
    this.flush();
    this.processRecords(path, rest);
  }

  /** The target is not resume-aware: reset this stream; the opener latches the route legacy. */
  private legacyPeer(reason = 'peer is not resume-aware'): void {
    if (this.state === 'closed') return;
    const path = this.current;
    if (path?.alive) {
      path.blocked = false;
      this.rawSend(path, encodeRecord({ type: RecordType.rst, code: RstCode.legacyPeer, reason: Buffer.from(reason) }));
    }
    this.terminate(new ResumeSessionError(reason, 'legacy_peer', RstCode.legacyPeer), true);
  }

  private handleReject(pending: PendingResume, reject: ResumeRecord): void {
    this.pending = null;
    this.timers.clearTimeout(pending.timer);
    this.retirePath(pending.path, true);
    if (this.complete) {
      // Both directions were complete: the stream had closed and only the CLOSE exchange was missing; nothing was
      // lost, whatever the target answers.
      pending.settle('closed');
      this.terminate(undefined, true);
      return;
    }
    if (reject.code === RejectCode.reset && pending.planned && this.current?.alive) {
      // A planned move: the target reset the stream meanwhile (its local connection ended) and sent its RST, after
      // its last acks, on the old path, which this answer overtook. The old path tells how the stream ended.
      const timer = this.timers.setTimeout(() => this.endRefused(), RESUME_ACK_TIMEOUT_MS);
      this.refusal = { settle: pending.settle, code: reject.code, timer };
      return;
    }
    pending.settle('rejected');
    this.terminate(new ResumeSessionError(`resume refused (${reject.code})`, 'rejected', reject.code), true);
  }

  /** A refused planned move whose old path told nothing (in time): the stream could not move. */
  private endRefused(): void {
    const refusal = this.refusal;
    if (!refusal || this.state === 'closed') return;
    this.terminate(new ResumeSessionError(`resume refused (${refusal.code})`, 'rejected', refusal.code), true);
  }

  private processRecords(path: PathState, records: ResumeRecord[]): void {
    try {
      this.handleRecords(path, records);
    } catch (error) {
      if (this.state === 'closed') return;
      const code = error instanceof ResumeSessionError && error.rstCode ? error.rstCode : RstCode.protocol;
      this.abort(code, error instanceof Error ? error.message : 'protocol error');
    }
  }

  private handleRecords(path: PathState, records: ResumeRecord[]): void {
    for (const record of records) {
      if (this.state === 'closed' || !path.alive) return;
      switch (record.type) {
        case RecordType.data: {
          this.onAck(record.ack);
          this.onData(path, record.payload);
          break;
        }
        case RecordType.ack:
          this.notePeerWindow(record.wnd);
          this.onAck(record.ack);
          break;
        case RecordType.fin:
          this.onAck(record.ack);
          this.onFin(path);
          break;
        case RecordType.rst:
          this.terminate(
            new ResumeSessionError(
              `peer reset the stream (${record.code}${record.reason.length ? `: ${record.reason.toString('utf8')}` : ''})`,
              'reset',
              record.code
            ),
            true
          );
          return;
        case RecordType.close:
          this.onClose(path);
          return;
        case RecordType.migrateReq:
          if (this.role === 'source') this.hooks.migrateRequested?.(record.code);
          break;
        default:
          throw new ResumeSessionError('unexpected handshake record', 'protocol', RstCode.protocol);
      }
    }
  }

  private onData(path: PathState, payload: Buffer): void {
    const offset = path.rcvOffset;
    path.rcvOffset += payload.length;
    if (this.peerFinOffset >= 0 && offset >= this.peerFinOffset) {
      throw new ResumeSessionError('data after FIN', 'protocol', RstCode.protocol);
    }
    if (offset > this.rcvNxt) throw new ResumeSessionError('data beyond rcv_nxt', 'protocol', RstCode.protocol);
    const end = offset + payload.length;
    if (end <= this.rcvNxt) return;
    const fresh = offset < this.rcvNxt ? payload.subarray(this.rcvNxt - offset) : payload;
    this.rcvNxt = end;
    this.recvQueue.push(fresh);
    this.recvQueued += fresh.length;
    // The peer may not run past its window: acks only report delivered bytes.
    if (this.recvQueued > MAX_RECEIVE_QUEUE) {
      throw new ResumeSessionError('peer exceeded its window', 'protocol', RstCode.windowViolation);
    }
    this.touchHalfClose();
    this.drainReceived();
  }

  private onFin(path: PathState): void {
    const offset = path.rcvOffset;
    path.rcvOffset += 1;
    if (offset > this.rcvNxt) throw new ResumeSessionError('FIN beyond rcv_nxt', 'protocol', RstCode.protocol);
    if (offset < this.rcvNxt) return;
    this.peerFinOffset = offset;
    this.rcvNxt = offset + 1;
    this.drainReceived();
  }

  /** Hands queued bytes (then the FIN) to the local side while it takes them. */
  private drainReceived(): void {
    let progressed = false;
    while (this.recvQueue.length && !this.localFull && this.state !== 'closed') {
      const chunk = this.recvQueue.shift()!;
      this.recvQueued -= chunk.length;
      this.delivered += chunk.length;
      progressed = true;
      if (!this.hooks.deliver(chunk)) this.localFull = true;
    }
    if (this.state === 'closed') return;
    if (!this.recvQueue.length && this.peerFinOffset >= 0 && !this.peerFinished) {
      this.delivered = this.peerFinOffset + 1;
      this.peerFinished = true;
      this.hooks.peerFinished();
      this.maybeAck(true);
      this.startHalfClose();
      if (this.closeReceived) this.terminate(undefined, true);
      else this.maybeClose();
      return;
    }
    if (progressed) this.maybeAck();
  }

  private onAck(value: bigint): void {
    const ack = safeNumber(value);
    if (ack > this.sndNxt) throw new ResumeSessionError('ack beyond snd_nxt', 'protocol', RstCode.protocol);
    if (this.rttOffset >= 0 && ack >= this.rttOffset) {
      this.sampleRtt(this.timers.now() - this.rttAt, ack - Math.min(this.rttDelivered, ack), this.rttClean);
      this.rttOffset = -1;
    }
    this.applyAck(ack, true);
    // The window moved: what it held back leaves now.
    this.flush();
  }

  /** peerAck: the peer's ack (bytes handed to its socket), not what a resume says it received. */
  private applyAck(ack: number, peerAck: boolean): void {
    if (ack <= this.sndUna) return;
    const freed = ack - this.sndUna;
    const wasBlocked = !this.windowOpen();
    this.release(ack);
    if (this.finOffset >= 0 && ack > this.finOffset && !this.finAcked) {
      this.finAcked = true;
      this.hooks.finAcknowledged();
      this.maybeClose();
    }
    if (wasBlocked) {
      if (peerAck) {
        this.ackedSinceGrowth += freed;
        // Window-blocked while a whole window came back: up to MAX_WINDOW as before the window extension, beyond it
        // while the window is below twice the measured bandwidth-delay product (and the peer takes it).
        const limit = this.peerExtended ? MAX_EXTENDED_WINDOW : MAX_WINDOW;
        if (this.ackedSinceGrowth >= this.window && this.window < limit) {
          if (this.window < MAX_WINDOW || this.window < 2 * this.bdp) {
            this.growWindow(Math.min(this.window, limit - this.window));
          }
          this.ackedSinceGrowth = 0;
        }
      }
      if (this.windowOpen()) {
        if (this.windowBlockedSince >= 0 && this.stats) {
          this.stats.windowBlockedMs += this.timers.now() - this.windowBlockedSince;
        }
        this.windowBlockedSince = -1;
        if (this.finOffset < 0 && this.state !== 'closed') this.hooks.writable();
      }
    }
  }

  /**
   * Drops retained bytes below `ack` that the current path sent. The peer may acknowledge bytes this path did not
   * carry yet (a planned move keeps receiving on the path it leaves, and the window holds back the retransmission on
   * the new one); a path's offsets are implicit, so it still carries them, and they stay until it did.
   */
  private release(ack: number): void {
    if (ack > this.sndUna) this.sndUna = ack;
    let free = this.sndUna;
    const path = this.current;
    if (path?.alive && path.sndOffset >= 0 && path.sndOffset < free) free = path.sndOffset;
    const dataEnd = this.finOffset >= 0 ? Math.min(free, this.finOffset) : free;
    while (this.retained.length) {
      const head = this.retained[0]!;
      const end = this.retainedOffset + head.length;
      if (end <= dataEnd) {
        this.retained.shift();
        this.retainedOffset = end;
      } else {
        if (dataEnd > this.retainedOffset) {
          this.retained[0] = head.subarray(dataEnd - this.retainedOffset);
          this.retainedOffset = dataEnd;
        }
        break;
      }
    }
  }

  private windowOpen(): boolean {
    return this.sndNxt - this.sndUna < this.effectiveWindow;
  }

  /** The window as this side announces it: with the extension and lane migration bits. */
  private announcedWindow(): bigint {
    return BigInt(this.window) | BigInt(WINDOW_EXTENSION) | BigInt(LANE_MIGRATION);
  }

  private notePeerWindow(wnd: bigint): void {
    this.peerExtended = (wnd & BigInt(WINDOW_EXTENSION)) !== 0n;
    this.peerWindow = clampWindow(wnd);
  }

  /** A timed round trip and what the peer delivered meanwhile; clean: see rttClean. */
  private sampleRtt(rtt: number, delivered: number, clean: boolean): void {
    const value = Math.max(rtt, 0.001);
    if (this.minRtt < 0 || value < this.minRtt || clean) this.minRtt = value;
    this.bdp = Math.max(this.bdp, Math.floor((delivered * this.minRtt) / value));
  }

  /** A resume: the peer's extension and the last path's round trip are unknown again. */
  private newPathTiming(): void {
    this.peerExtended = false;
    this.rttOffset = -1;
    this.minRtt = -1;
    this.bdp = 0;
    this.rttFloor = this.sndNxt;
  }

  private growWindow(bytes: number): void {
    if (bytes <= 0) return;
    if (!this.budget.tryTake(bytes)) return;
    this.window += bytes;
  }

  /** Sends [path.sndOffset, sndNxt) on the current path as far as it accepts. */
  private flush(): void {
    const path = this.current;
    if (!path?.alive || path.blocked || this.sendStopped) return;
    if (this.state !== 'open' && this.state !== 'closing') return;
    const maxPayload = Math.min(path.handle.maxFrameBytes, MAX_FRAME_BYTES) - MAX_RECORD_HEADER;
    // At most the effective window beyond what the peer acknowledged: a retransmission after a resume leaves as
    // acks come (the peer there may be an older release, which resets a stream that queues too much).
    const limit = this.sndUna + this.effectiveWindow;
    while (path.sndOffset < this.sndNxt && !path.blocked) {
      if (this.finOffset >= 0 && path.sndOffset === this.finOffset) {
        this.lastAckSent = this.delivered;
        this.cancelAckTimer();
        path.sndOffset += 1;
        this.rawSend(path, encodeRecord({ type: RecordType.fin, ack: BigInt(this.delivered) }));
        continue;
      }
      if (path.sndOffset >= limit) break;
      const chunk = this.sliceRetained(path.sndOffset, maxPayload);
      if (!chunk.length) break;
      if (path.sndOffset >= this.rttFloor) {
        // A clean offset replaces one still timed from before the pause: that one's round trip may span a change of
        // the path.
        const clean = path.sndOffset <= this.sndUna;
        if (this.rttOffset < 0 || (clean && !this.rttClean)) {
          this.rttOffset = path.sndOffset + chunk.length;
          this.rttAt = this.timers.now();
          this.rttDelivered = this.sndUna;
          this.rttClean = clean;
        }
      }
      path.sndOffset += chunk.length;
      this.lastAckSent = this.delivered;
      this.cancelAckTimer();
      this.rawSend(path, Buffer.concat([encodeDataHeader(this.delivered), chunk]));
    }
    if (this.retainedOffset < this.sndUna) this.release(this.sndUna);
  }

  /** Resends everything the peer has not received on a fresh path. */
  private retransmit(path: PathState): void {
    const before = path.sndOffset;
    this.flush();
    if (this.stats) this.stats.retransmittedBytes += Math.max(0, Math.min(path.sndOffset, this.sndNxt) - before);
  }

  /** Up to `max` retained bytes starting at absolute `offset` (not crossing the FIN). */
  private sliceRetained(offset: number, max: number): Buffer {
    if (offset < this.retainedOffset)
      throw new Error(`relayresume: resend below snd_una (${offset} < ${this.retainedOffset})`);
    let position = this.retainedOffset;
    for (const chunk of this.retained) {
      const end = position + chunk.length;
      if (offset < end) {
        const start = offset - position;
        return chunk.subarray(start, Math.min(chunk.length, start + max));
      }
      position = end;
    }
    return EMPTY;
  }

  /** announce: send the ack even when nothing was delivered since the last one (after a resume). */
  private maybeAck(immediate = false, announce = false): void {
    const path = this.current;
    if (!path?.alive || this.sendStopped || path.blocked) return;
    if (this.state !== 'open' && this.state !== 'closing') return;
    const unacked = this.delivered - this.lastAckSent;
    if (unacked <= 0 && !announce) return;
    if (immediate || unacked >= Math.max(1, Math.floor(this.peerWindow / 4))) {
      this.sendAck(path);
      return;
    }
    if (this.ackTimer === null) {
      this.ackTimer = this.timers.setTimeout(() => {
        this.ackTimer = null;
        const live = this.current;
        if (live?.alive && !this.sendStopped && !live.blocked && this.delivered > this.lastAckSent) this.sendAck(live);
      }, DELAYED_ACK_MS);
    }
  }

  private sendAck(path: PathState): void {
    this.cancelAckTimer();
    this.lastAckSent = this.delivered;
    this.rawSend(
      path,
      encodeRecord({ type: RecordType.ack, ack: BigInt(this.delivered), wnd: this.announcedWindow() })
    );
  }

  private cancelAckTimer(): void {
    if (this.ackTimer !== null) this.timers.clearTimeout(this.ackTimer);
    this.ackTimer = null;
  }

  private maybeClose(): void {
    if (!this.complete || this.role !== 'source' || this.closeSent) return;
    this.closeSent = true;
    this.state = this.state === 'suspended' ? 'suspended' : 'closing';
    this.sendCloseIfDue();
    this.closeTimer = this.timers.setTimeout(() => {
      this.closeTimer = null;
      // Both directions finished: a missing CLOSE echo only delays cleanup.
      this.terminate(undefined, true);
    }, CLOSE_LINGER_TIMEOUT_MS);
  }

  /** Source: CLOSE goes out once on every path the session settles on after both directions finished. */
  private sendCloseIfDue(): void {
    const path = this.current;
    if (!this.closeSent || !path?.alive || this.sendStopped || this.closeOnPath === path) return;
    this.closeOnPath = path;
    // The ack of the peer's FIN goes first: the target checks both FINs on CLOSE.
    if (this.delivered > this.lastAckSent) this.sendAck(path);
    this.rawSend(path, encodeRecord({ type: RecordType.close }));
  }

  private onClose(path: PathState): void {
    if (this.role === 'source') {
      if (!this.complete) throw new ResumeSessionError('CLOSE before both FINs', 'protocol', RstCode.protocol);
      this.terminate(undefined, true);
      return;
    }
    // Target: RESUME_ACK counts queued bytes as received, so the source may close while the local side still
    // drains them; the session ends once they and the FIN are delivered.
    if (!this.finAcked || this.peerFinOffset < 0) {
      throw new ResumeSessionError('CLOSE before both FINs', 'protocol', RstCode.protocol);
    }
    this.rawSend(path, encodeRecord({ type: RecordType.close }));
    this.closeReceived = true;
    this.retirePath(path, false);
    if (this.peerFinished) this.terminate(undefined, true);
  }

  private startHalfClose(): void {
    if (this.halfCloseTimeoutMs <= 0 || this.finOffset >= 0) return;
    this.touchHalfClose();
  }

  private touchHalfClose(): void {
    if (this.halfCloseTimeoutMs <= 0 || !this.peerFinished || this.finAcked) return;
    if (this.halfCloseTimer !== null) this.timers.clearTimeout(this.halfCloseTimer);
    this.halfCloseTimer = this.timers.setTimeout(() => {
      this.halfCloseTimer = null;
      if (!this.complete) this.abort(RstCode.halfCloseIdle, 'half-closed stream idle');
    }, this.halfCloseTimeoutMs);
  }

  private suspendTimer: unknown = null;

  private suspend(reason: string): void {
    this.state = 'suspended';
    this.sendStopped = true;
    this.cancelAckTimer();
    if (this.role === 'target') {
      this.suspendTimer = this.timers.setTimeout(() => {
        this.suspendTimer = null;
        if (this.state === 'suspended') {
          this.terminate(
            new ResumeSessionError('no path came back in time', 'suspend_timeout', RstCode.suspendTimeout),
            false
          );
        }
      }, TARGET_SUSPEND_TIMEOUT_MS);
      return;
    }
    this.hooks.suspended?.(reason);
  }

  private cancelSuspendTimer(): void {
    if (this.suspendTimer !== null) this.timers.clearTimeout(this.suspendTimer);
    this.suspendTimer = null;
  }

  private terminate(error: ResumeSessionError | undefined, closePaths: boolean): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    for (const timer of [this.ackTimer, this.helloTimer, this.halfCloseTimer, this.closeTimer, this.suspendTimer]) {
      if (timer !== null) this.timers.clearTimeout(timer);
    }
    this.ackTimer = this.helloTimer = this.halfCloseTimer = this.closeTimer = this.suspendTimer = null;
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      this.timers.clearTimeout(pending.timer);
      this.retirePath(pending.path, true);
      pending.settle('closed');
    }
    const refusal = this.refusal;
    this.refusal = null;
    if (refusal) {
      this.timers.clearTimeout(refusal.timer);
      // The peer's RST (or a clean end) arrived on the old path: the stream ended, it was not cut.
      refusal.settle(error?.code === 'rejected' ? 'rejected' : 'closed');
    }
    if (this.current) {
      if (closePaths && this.current.alive) {
        this.current.alive = false;
        if (error) this.current.handle.cancel();
        else this.current.handle.close();
      }
      this.current.alive = false;
    }
    this.budget.release(this.window - MIN_WINDOW);
    this.window = MIN_WINDOW;
    this.retained.length = 0;
    this.recvQueue.length = 0;
    this.recvQueued = 0;
    this.hooks.closed(error);
  }

  private retirePath(path: PathState, cancel: boolean): void {
    if (!path.alive) return;
    path.alive = false;
    if (cancel) path.handle.cancel();
    else path.handle.close();
  }

  private newPath(handle: ResumePathHandle, sndOffset: number, rcvOffset: number): PathState {
    if (handle.maxFrameBytes < MIN_PATH_FRAME_BYTES) throw new Error('relay path frame limit is too small');
    const path: PathState = { handle, sndOffset, rcvOffset, blocked: false, alive: true };
    return path;
  }

  private pathOf(handle: ResumePathHandle): PathState | null {
    if (this.current?.handle === handle && this.current.alive) return this.current;
    if (this.pending?.path.handle === handle && this.pending.path.alive) return this.pending.path;
    return null;
  }

  private pendingOnly(): boolean {
    return this.state === 'suspended';
  }

  private rawSend(path: PathState, frame: Buffer): void {
    if (!path.alive) return;
    if (!path.handle.send(frame)) path.blocked = true;
  }

  private macContext(relayId: string): PathMacContext {
    return {
      routeId: this.routeId,
      relayId,
      keyId: this.keyId,
      key: this.key,
      sessionId: this.sessionId,
      targetNonce: this.targetNonce,
    };
  }

  /** Target: key ring lookup happens before the session exists; acceptHello() fixes the key. */
  setKey(keyId: string, key: Buffer): void {
    this.keyId = keyId;
    this.key = key;
  }
}

function clampWindow(announced: bigint): number {
  const value = announced & ~BigInt(WINDOW_EXTENSION | LANE_MIGRATION);
  if (value < BigInt(MIN_WINDOW)) return MIN_WINDOW;
  if (value > BigInt(MAX_EXTENDED_WINDOW)) return MAX_EXTENDED_WINDOW;
  return Number(value);
}

export function newSessionId(): Buffer {
  return randomBytes(SESSION_ID_LEN);
}

export function newTargetNonce(): Buffer {
  return randomBytes(NONCE_LEN);
}

// ---------------------------------------------------------------------------------------------------------------------
// Source streams: the Duplex the proxies use, the migration controller and the process registry
// ---------------------------------------------------------------------------------------------------------------------

/** Where a path reports its events; set once by the session owner. */
export interface ResumePathSink {
  frame(frame: Buffer): void;
  ended(end: PathEnd): void;
  drained(): void;
  /** The lane under the path stopped taking new streams (GOAWAY): move while it still carries this one. */
  laneLost(): void;
}

/** A path a dialer opened; it buffers events until attach(). */
export interface AttachablePath extends ResumePathHandle {
  attach(sink: ResumePathSink): void;
}

export interface OpenedResumePath {
  path: AttachablePath;
  /** The route key current when the path was opened (rotation): RESUME uses the latest one. */
  keyId?: string;
  key?: Buffer;
}

/**
 * Opens a fresh tunnel for the route on the best active candidate. `avoidRelayId` names the relay a planned
 * migration leaves; a dialer must not return a path through it. Failures throw.
 */
export type ResumeDialer = (avoidRelayId: string | null) => Promise<OpenedResumePath>;

export type MigrationTrigger = 'drain' | 'goaway' | 'path_failure' | 'target_hint' | 'lane' | 'return';
export type MigrationResult = 'ok' | 'no_relay' | 'rejected' | 'resume_rejected' | 'timeout';

export interface RelayResumeStatsSnapshot {
  sessions: { resumable: number; legacy: number };
  /** Open streams per relay instance id (a suspended resumable stream counts under no relay). */
  byRelay: Record<string, { resumable: number; legacy: number }>;
  suspended: number;
  unackedBytes: number;
  migrations: Record<string, number>;
  migrationStallMs: { p50: number; p95: number };
  retransmittedBytes: number;
  windowBlockedMs: number;
}

/**
 * One per process: live resumable sessions by relay, drain pacing (at most 32 migrations in flight, spread up to the
 * drain deadline), the legacy latch and telemetry. Mirrors relayresume.Manager.
 */
export class RelayResumeRegistry {
  private readonly sessions = new Set<ResumableRelayDuplex>();
  private readonly legacyUntil = new Map<string, { until: number; keyId: string }>();
  private legacyStreams = 0;
  private readonly legacyByRelay = new Map<string, number>();
  private readonly migrations = new Map<string, number>();
  private readonly stalls: number[] = [];
  readonly stats: ResumeStats = { retransmittedBytes: 0, windowBlockedMs: 0 };
  private inFlight = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    readonly timers: ResumeTimers = realTimers,
    readonly budget: WindowBudget = defaultWindowBudget
  ) {}

  add(session: ResumableRelayDuplex): void {
    this.sessions.add(session);
  }

  remove(session: ResumableRelayDuplex): void {
    this.sessions.delete(session);
  }

  /** The live sessions, for the return to the nearest relay (opfield-relay-paths). */
  liveSessions(): ResumableRelayDuplex[] {
    return [...this.sessions];
  }

  /** A legacy (raw) stream through `relayId` opened or closed. */
  countLegacy(delta: 1 | -1, relayId = ''): void {
    this.legacyStreams = Math.max(0, this.legacyStreams + delta);
    if (!relayId) return;
    const count = Math.max(0, (this.legacyByRelay.get(relayId) ?? 0) + delta);
    if (count) this.legacyByRelay.set(relayId, count);
    else this.legacyByRelay.delete(relayId);
  }

  /**
   * The route is latched to raw streams. A key id other than the one that latched it ends the latch: Opfield gives a
   * route a new key version every time it turns resumable streams back on, so its targets are resume-aware again.
   */
  isLegacy(routeId: string, keyId?: string): boolean {
    const latch = this.legacyUntil.get(routeId);
    if (latch === undefined) return false;
    if (latch.until > this.timers.now() && (keyId === undefined || keyId === latch.keyId)) return true;
    this.legacyUntil.delete(routeId);
    return false;
  }

  /** The route's target answered a HELLO signed with keyId with something else: raw streams for LEGACY_LATCH_MS. */
  markLegacy(routeId: string, keyId = ''): void {
    this.legacyUntil.set(routeId, { until: this.timers.now() + LEGACY_LATCH_MS, keyId });
  }

  /**
   * The relay is draining (its candidate turned draining or vanished): move every session on it, spread uniformly
   * until the deadline (unix ms) but over at most DEFAULT_DRAIN_SPREAD_MS (0: within a second).
   */
  drainRelay(relayId: string, deadlineUnixMs = 0): number {
    const now = this.timers.now();
    // A long drain grace is for raw streams that cannot move: resumable ones leave within DEFAULT_DRAIN_SPREAD_MS,
    // so a forced end of the drain finds none (as relayresume paces).
    const spread = deadlineUnixMs > now ? Math.min(deadlineUnixMs - now, DEFAULT_DRAIN_SPREAD_MS) : 1_000;
    const affected = [...this.sessions].filter((session) => session.relayId === relayId);
    affected.forEach((session, index) => {
      const delay = affected.length > 1 ? Math.floor((spread * index) / affected.length) : 0;
      const jitter = delay > 0 ? Math.floor(Math.random() * Math.min(250, delay)) : 0;
      // Bound to the draining relay: a stream that left it before its turn (a target's hint moved it) stays put.
      this.timers.setTimeout(() => this.schedule(() => session.migrate('drain', relayId)), Math.max(0, delay - jitter));
    });
    return affected.length;
  }

  /** The lane to the relay got GOAWAY: move its sessions now. */
  relayLost(relayId: string): number {
    const affected = [...this.sessions].filter((session) => session.relayId === relayId);
    for (const session of affected) this.schedule(() => session.migrate('goaway', relayId));
    return affected.length;
  }

  /** Runs `task` within the in-flight limit. */
  schedule(task: () => Promise<unknown>): void {
    const run = () => {
      this.inFlight++;
      task()
        .catch(() => undefined)
        .finally(() => {
          this.inFlight--;
          this.queue.shift()?.();
        });
    };
    if (this.inFlight < MAX_MIGRATIONS_IN_FLIGHT) run();
    else this.queue.push(run);
  }

  recordMigration(trigger: MigrationTrigger, result: MigrationResult, stallMs?: number): void {
    const key = `${trigger}:${result}`;
    this.migrations.set(key, (this.migrations.get(key) ?? 0) + 1);
    if (stallMs !== undefined) {
      this.stalls.push(stallMs);
      if (this.stalls.length > 512) this.stalls.shift();
    }
  }

  snapshot(): RelayResumeStatsSnapshot {
    const sorted = [...this.stalls].sort((a, b) => a - b);
    const pick = (q: number) =>
      sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0;
    let suspended = 0;
    let unacked = 0;
    const byRelay: Record<string, { resumable: number; legacy: number }> = {};
    const relayEntry = (relayId: string) => (byRelay[relayId] ??= { resumable: 0, legacy: 0 });
    for (const session of this.sessions) {
      if (session.suspended) suspended++;
      unacked += session.unackedBytes;
      const relayId = session.relayId;
      if (relayId) relayEntry(relayId).resumable++;
    }
    for (const [relayId, count] of this.legacyByRelay) relayEntry(relayId).legacy += count;
    return {
      sessions: { resumable: this.sessions.size, legacy: this.legacyStreams },
      byRelay,
      suspended,
      unackedBytes: unacked,
      migrations: Object.fromEntries(this.migrations),
      migrationStallMs: { p50: pick(0.5), p95: pick(0.95) },
      retransmittedBytes: this.stats.retransmittedBytes,
      windowBlockedMs: this.stats.windowBlockedMs,
    };
  }
}

export const relayResumeRegistry = new RelayResumeRegistry();

export interface ResumableRelayDuplexOptions {
  routeId: string;
  keyId: string;
  key: Buffer;
  halfCloseTimeoutMs?: number;
  dial: ResumeDialer;
  registry?: RelayResumeRegistry;
  timers?: ResumeTimers;
  sessionId?: Buffer;
  helloTimeoutMs?: number;
  resumeAckTimeoutMs?: number;
  plannedBudgetMs?: number;
  unplannedBudgetMs?: number;
  /** Diagnostics. */
  onEvent?: (event: string, detail?: Record<string, unknown>) => void;
}

/**
 * The local side of a resumable source stream: a Duplex like the raw RelayTunnelDuplex, carried by a ResumeSession
 * that moves between relay paths on drain, GOAWAY, path failure or a target hint.
 */
export class ResumableRelayDuplex extends Duplex {
  private readonly session: ResumeSession;
  private readonly registry: RelayResumeRegistry;
  private readonly timers: ResumeTimers;
  private readonly options: ResumableRelayDuplexOptions;
  private pendingWrite: (() => void) | null = null;
  private pendingFinal: ((error?: Error | null) => void) | null = null;
  private openWaiters: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private migration: Promise<void> | null = null;
  private recoverRequested = false;
  private deferred: { trigger: MigrationTrigger; relayId: string } | null = null;
  /** The relay of the current path, and of the path that failed last (tried last when recovering). */
  private lastRelayId: string | null = null;
  private lostRelayId: string | null = null;
  private suspendedAt = -1;
  private closedError: ResumeSessionError | undefined;
  private sessionClosed = false;
  /** When the stream opened or last moved to another path: a stream that just moved stays a while. */
  private movedAt: number;

  private constructor(options: ResumableRelayDuplexOptions) {
    super({ allowHalfOpen: true });
    this.options = options;
    this.registry = options.registry ?? relayResumeRegistry;
    this.timers = options.timers ?? this.registry.timers;
    this.movedAt = this.timers.now();
    this.session = new ResumeSession({
      role: 'source',
      routeId: options.routeId,
      sessionId: options.sessionId ?? newSessionId(),
      keyId: options.keyId,
      key: options.key,
      timers: this.timers,
      budget: this.registry.budget,
      stats: this.registry.stats,
      halfCloseTimeoutMs: options.halfCloseTimeoutMs,
      hooks: {
        deliver: (data) => this.push(data),
        peerFinished: () => this.push(null),
        writable: () => {
          const callback = this.pendingWrite;
          this.pendingWrite = null;
          callback?.();
        },
        finAcknowledged: () => {
          const callback = this.pendingFinal;
          this.pendingFinal = null;
          callback?.();
        },
        opened: () => {
          this.openWaiters?.resolve();
          this.openWaiters = null;
        },
        closed: (error) => this.onSessionClosed(error),
        suspended: () => this.requestRecover(),
        migrateRequested: (reason) => {
          const trigger: MigrationTrigger = reason === MigrateReason.lane ? 'lane' : 'target_hint';
          const from = this.session.currentRelayId;
          this.registry.schedule(() => this.migrate(trigger, from));
        },
      },
    });
  }

  /**
   * Opens the first path and runs the HELLO handshake. Rejects with ResumeSessionError code 'legacy_peer' when the
   * target is not resume-aware (the caller latches the route and opens a raw tunnel).
   */
  static async open(options: ResumableRelayDuplexOptions): Promise<ResumableRelayDuplex> {
    const duplex = new ResumableRelayDuplex(options);
    const first = await options.dial(null);
    if (first.keyId && first.key) duplex.session.setKey(first.keyId, first.key);
    const opened = new Promise<void>((resolve, reject) => {
      duplex.openWaiters = { resolve, reject };
    });
    duplex.attach(first.path);
    duplex.lastRelayId = first.path.relayId;
    // Registered from the HELLO on: a drain notice during the handshake waits for it (see migrate).
    duplex.registry.add(duplex);
    duplex.session.startSource(first.path, options.helloTimeoutMs ?? HELLO_ACK_TIMEOUT_MS);
    try {
      await opened;
    } catch (error) {
      if (error instanceof ResumeSessionError && error.code === 'legacy_peer') {
        duplex.registry.markLegacy(options.routeId, first.keyId ?? options.keyId);
      }
      duplex.destroy();
      throw error;
    }
    duplex.runDeferred();
    return duplex;
  }

  get relayId(): string | null {
    return this.session.currentRelayId;
  }
  get routeId(): string {
    return this.options.routeId;
  }
  /** Open on a path and not moving: a planned move may start. */
  get movable(): boolean {
    return !this.sessionClosed && !this.migration && this.session.isOpen && !this.session.isSuspended;
  }
  get lastMoveAt(): number {
    return this.movedAt;
  }
  get suspended(): boolean {
    return this.session.isSuspended;
  }
  get unackedBytes(): number {
    return this.session.unackedBytes;
  }
  /** For tests and diagnostics. */
  get resumeSession(): ResumeSession {
    return this.session;
  }

  private attach(path: AttachablePath): void {
    path.attach({
      frame: (frame) => this.session.pathFrame(path, frame),
      ended: (end) => this.session.pathEnded(path, end),
      drained: () => this.session.pathDrained(path),
      laneLost: () => {
        if (this.session.currentRelayId === path.relayId) {
          // The local relay runs on Opfield's host: a lost lane to it (its channel replaced at Opfield's start) is that
          // connection, not the relay, so the stream opens a new path on the best relay, the local one included. Moved
          // off it, two streams sat on the 60-ms relay for ~26 s after an Opfield restart until the return (stand
          // rc.11, O-4). A local relay that is really going down does not open, and the next relay takes the stream.
          const trigger = path.local ? 'lane' : 'goaway';
          this.registry.schedule(() => this.migrate(trigger, path.relayId));
        }
      },
    });
  }

  /**
   * Planned move off the current relay; stays on it when no other path answers within the budget. A `lane` move opens
   * a new path on the best relay, the current one included; a `return` moves to the best relay and stays when that is
   * the current one.
   *
   * `fromRelayId` is the relay the move was asked to leave (a drain, a GOAWAY, a target's hint, the returner's
   * judgement): a stream no longer on it has moved already and stays where it is (relayresume plannedMove.stale).
   * Without that a drain move paced for later left whichever relay the stream had moved to meanwhile: the local relay's
   * drain sent Opfield's streams that a target's hint had already moved to the 60-ms relay on to the 300-ms one
   * (stand rc.9, F-2).
   */
  migrate(trigger: MigrationTrigger, fromRelayId?: string | null): Promise<void> {
    if (this.sessionClosed) return Promise.resolve();
    if (fromRelayId && this.session.currentRelayId !== fromRelayId) return this.migration ?? Promise.resolve();
    if (this.migration || !this.session.isOpen) {
      // The handshake or another move is running: keep the request for when the stream can move, unless it
      // has left this relay by then.
      const relayId = fromRelayId ?? this.session.currentRelayId;
      if (relayId) this.deferred = { trigger, relayId };
      return this.migration ?? Promise.resolve();
    }
    const run = this.runPlanned(trigger).finally(() => {
      this.migration = null;
      if (this.recoverRequested || this.session.isSuspended) this.requestRecover();
      else this.runDeferred();
    });
    this.migration = run;
    return run;
  }

  /** Starts a move requested while the stream could not move, if it still runs through that relay. */
  private runDeferred(): void {
    const deferred = this.deferred;
    if (!deferred || this.migration || this.sessionClosed || !this.session.isOpen) return;
    this.deferred = null;
    if (this.session.currentRelayId === deferred.relayId) void this.migrate(deferred.trigger, deferred.relayId);
  }

  private requestRecover(): void {
    if (this.sessionClosed) return;
    if (this.lastRelayId) this.lostRelayId = this.lastRelayId;
    if (this.suspendedAt < 0) this.suspendedAt = this.timers.now();
    if (this.migration) {
      this.recoverRequested = true;
      return;
    }
    this.recoverRequested = false;
    const run = this.runRecover().finally(() => {
      this.migration = null;
      this.runDeferred();
    });
    this.migration = run;
  }

  private async runPlanned(trigger: MigrationTrigger): Promise<void> {
    const startedAt = this.timers.now();
    const current = this.session.currentRelayId;
    // A lane move opens a new path on the same relay (the target's connection under the path was replaced) and a
    // return goes to the best relay, so neither avoids one: a return whose nearer relay does not open stays where it
    // is instead of going to the next relay in line, a farther one. Every other planned move leaves the current relay.
    const avoid = trigger === 'lane' || trigger === 'return' ? null : current;
    let opened: OpenedResumePath;
    try {
      opened = await withTimeout(
        this.options.dial(avoid),
        this.options.plannedBudgetMs ?? PLANNED_BUDGET_MS,
        this.timers
      );
    } catch {
      this.registry.recordMigration(trigger, 'no_relay');
      return;
    }
    if (this.sessionClosed) {
      opened.path.cancel();
      return;
    }
    if (avoid && opened.path.relayId === avoid) {
      // Only the relay being left answered: stay on the current path.
      opened.path.cancel();
      this.registry.recordMigration(trigger, 'no_relay');
      return;
    }
    if (trigger === 'return' && opened.path.relayId === current) {
      // The best relay is the one the stream is on: it stays, and no move happened (relayresume ErrStay).
      opened.path.cancel();
      return;
    }
    const result = await this.resumeOn(opened);
    const outcome = migrationOutcome(result);
    // A lane move is housekeeping: no stall a user would see is recorded for it (as relayresume counts it).
    const stall = outcome === 'ok' && trigger !== 'lane' ? this.timers.now() - startedAt : undefined;
    this.registry.recordMigration(trigger, outcome, stall);
    this.options.onEvent?.('migration', { trigger, result: outcome, from: current, relayId: opened.path.relayId });
  }

  private async runRecover(): Promise<void> {
    const budget = this.options.unplannedBudgetMs ?? UNPLANNED_BUDGET_MS;
    const deadline = (this.suspendedAt >= 0 ? this.suspendedAt : this.timers.now()) + budget;
    let backoff = UNPLANNED_BACKOFF_MIN_MS;
    while (!this.sessionClosed && this.session.isSuspended) {
      if (this.timers.now() >= deadline) {
        this.registry.recordMigration('path_failure', 'timeout');
        this.session.abort(RstCode.suspendTimeout, 'no relay path came back in time');
        return;
      }
      let opened: OpenedResumePath | null = null;
      try {
        // The relay whose path just failed is tried last: its lane may still look up and cost a whole open timeout.
        opened = await withTimeout(
          this.options.dial(this.lostRelayId),
          Math.max(1, deadline - this.timers.now()),
          this.timers
        );
      } catch {
        opened = null;
      }
      if (this.sessionClosed) {
        opened?.path.cancel();
        return;
      }
      if (opened) {
        const result = await this.resumeOn(opened);
        if (result === 'resumed') {
          const stall = this.suspendedAt >= 0 ? this.timers.now() - this.suspendedAt : 0;
          this.suspendedAt = -1;
          this.registry.recordMigration('path_failure', 'ok', stall);
          this.options.onEvent?.('migration', {
            trigger: 'path_failure',
            result: 'ok',
            from: this.lostRelayId,
            relayId: opened.path.relayId,
          });
          return;
        }
        if (result === 'rejected' || result === 'closed') {
          this.registry.recordMigration('path_failure', migrationOutcome(result));
          return;
        }
      }
      await sleep(Math.min(backoff, Math.max(0, deadline - this.timers.now())), this.timers);
      backoff = Math.min(UNPLANNED_BACKOFF_MAX_MS, backoff * 2);
    }
  }

  private async resumeOn(opened: OpenedResumePath): Promise<ResumeResult> {
    if (opened.keyId && opened.key) this.session.setKey(opened.keyId, opened.key);
    this.attach(opened.path);
    const result = await this.session.resume(opened.path, this.options.resumeAckTimeoutMs ?? RESUME_ACK_TIMEOUT_MS);
    if (result === 'resumed') {
      this.lastRelayId = opened.path.relayId;
      this.movedAt = this.timers.now();
    }
    return result;
  }

  private onSessionClosed(error?: ResumeSessionError): void {
    this.sessionClosed = true;
    this.closedError = error;
    this.registry.remove(this);
    if (this.openWaiters) {
      this.openWaiters.reject(error ?? new ResumeSessionError('relay stream closed during the handshake', 'aborted'));
      this.openWaiters = null;
      return;
    }
    if (error) {
      this.destroy(error);
      return;
    }
    // A clean CLOSE exchange: both directions already ended.
    const pendingFinal = this.pendingFinal;
    this.pendingFinal = null;
    pendingFinal?.();
  }

  _read(): void {
    this.session.readResumed();
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.sessionClosed) {
      callback(this.closedError ?? new Error('Relay stream is closed'));
      return;
    }
    try {
      if (this.session.write(Buffer.from(chunk))) callback();
      else this.pendingWrite = () => callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error('Relay write failed'));
    }
  }

  _final(callback: (error?: Error | null) => void): void {
    if (this.sessionClosed) {
      callback(this.closedError ?? null);
      return;
    }
    this.pendingFinal = callback;
    this.session.finish();
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.registry.remove(this);
    if (!this.sessionClosed && !this.session.complete) this.session.abort(RstCode.aborted, 'local side closed');
    const pendingWrite = this.pendingWrite;
    this.pendingWrite = null;
    pendingWrite?.();
    callback(error);
  }
}

function migrationOutcome(result: ResumeResult): MigrationResult {
  switch (result) {
    case 'resumed':
      return 'ok';
    case 'rejected':
      return 'resume_rejected';
    case 'closed':
      return 'rejected';
    default:
      return 'timeout';
  }
}

function sleep(ms: number, timers: ResumeTimers): Promise<void> {
  return new Promise((resolve) => {
    timers.setTimeout(resolve, ms);
  });
}

function withTimeout<T extends { path: AttachablePath }>(
  promise: Promise<T>,
  ms: number,
  timers: ResumeTimers
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = timers.setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('relay path open timed out'));
    }, ms);
    promise.then(
      (value) => {
        if (done) {
          value.path.cancel();
          return;
        }
        done = true;
        timers.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (done) return;
        done = true;
        timers.clearTimeout(timer);
        reject(error);
      }
    );
  });
}
