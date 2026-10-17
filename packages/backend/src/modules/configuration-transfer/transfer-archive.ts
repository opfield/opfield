import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { LEGACY_EXPORT_VERSION_FIELD } from '@/lib/legacy-compat.js';

/**
 * The encrypted configuration export file (.opfield-export).
 *
 * Layout:
 *   line 1  `OPFIELD-EXPORT/1`
 *   line 2  JSON header: Opfield version and schema, KDF and cipher parameters (plaintext, so an
 *           installer can read the version before it has the passphrase)
 *   frames  [u8 flags][u32 length][AES-256-GCM ciphertext][16-byte tag]
 *
 * The key comes from the passphrase through scrypt. Every frame authenticates the SHA-256 of both
 * header lines, its own index and its flags, so a changed header, reordered, dropped or appended
 * frame fails; the last frame carries the final flag and nothing may follow it. A key check in the
 * header tells a wrong passphrase apart from a damaged file.
 *
 * The decrypted content is a sequence of named parts, each a series of length-prefixed blocks
 * ended by an empty block. The first part is `manifest.json`; the last is `end.json`, listing every
 * part with its size and SHA-256.
 */

export const EXPORT_FILE_MAGIC = 'OPFIELD-EXPORT/1';
export const EXPORT_FILE_EXTENSION = '.opfield-export';
export const EXPORT_FORMAT_VERSION = 1;
export const MANIFEST_PART = 'manifest.json';
const END_PART = 'end.json';
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_PART_NAME_BYTES = 512;
const MAX_JSON_PART_BYTES = 16 * 1024 * 1024;
const TAG_BYTES = 16;
const FINAL_FLAG = 0x01;
const KEY_CHECK_LABEL = 'opfield-export/1 key check';
/** scrypt N = 2^17, r = 8: about 128 MiB and a fraction of a second per derivation. */
export const DEFAULT_KDF = { name: 'scrypt' as const, N: 131_072, r: 8, p: 1 };
const KDF_LIMITS = { maxN: 1_048_576, maxR: 16, maxP: 4 };
export const MIN_PASSPHRASE_LENGTH = 12;

export type ExportArchiveErrorCode =
  | 'NOT_AN_EXPORT'
  | 'UNSUPPORTED_FORMAT'
  | 'WRONG_PASSPHRASE'
  | 'DAMAGED'
  | 'TRUNCATED'
  | 'INVALID_CONTENT';

export class ExportArchiveError extends Error {
  constructor(
    readonly code: ExportArchiveErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ExportArchiveError';
  }
}

const damaged = () => new ExportArchiveError('DAMAGED', 'The export file is damaged or was changed after it was made');
const truncated = () =>
  new ExportArchiveError('TRUNCATED', 'The export file is incomplete: it ends before its last part');

export interface ExportHeader {
  format: number;
  createdAt: string;
  opfieldVersion: string;
  /** Tag of the last database migration the exporting Opfield applied. */
  schemaMigration: string;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: 'aes-256-gcm';
  chunkBytes: number;
  noncePrefix: string;
  keyCheck: string;
}

export interface ExportHeaderInput {
  createdAt?: string;
  opfieldVersion: string;
  schemaMigration: string;
}

interface DerivedKeys {
  encryption: Buffer;
  check: Buffer;
}

function deriveKeys(passphrase: string, kdf: ExportHeader['kdf']): Promise<DerivedKeys> {
  const salt = Buffer.from(kdf.salt, 'base64');
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase.normalize('NFC'),
      salt,
      64,
      { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 128 * kdf.N * kdf.r * kdf.p + 32 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error);
        else resolve({ encryption: key.subarray(0, 32), check: key.subarray(32, 64) });
      }
    );
  });
}

function keyCheck(keys: DerivedKeys): Buffer {
  return createHmac('sha256', keys.check).update(KEY_CHECK_LABEL).digest();
}

function frameNonce(prefix: Buffer, index: bigint): Buffer {
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0, 0, 4);
  nonce.writeBigUInt64BE(index, 4);
  return nonce;
}

function frameAad(headerDigest: Buffer, index: bigint, flags: number): Buffer {
  const aad = Buffer.alloc(headerDigest.length + 9);
  headerDigest.copy(aad, 0);
  aad.writeBigUInt64BE(index, headerDigest.length);
  aad.writeUInt8(flags, headerDigest.length + 8);
  return aad;
}

export function validatePassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.normalize('NFC').length < MIN_PASSPHRASE_LENGTH) {
    throw new ExportArchiveError(
      'INVALID_CONTENT',
      `The passphrase must have at least ${MIN_PASSPHRASE_LENGTH} characters`
    );
  }
}

/** Reads exact byte counts from a stream of buffers. */
class ByteReader {
  private current: Buffer = Buffer.alloc(0);
  private offset = 0;
  private ended = false;

  constructor(private readonly source: AsyncIterator<Buffer>) {}

  private async fill(): Promise<boolean> {
    while (this.offset >= this.current.length) {
      if (this.ended) return false;
      const next = await this.source.next();
      if (next.done) {
        this.ended = true;
        return false;
      }
      this.current = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      this.offset = 0;
    }
    return true;
  }

  /** Up to `max` bytes (at least one), or null at the end. */
  async readSome(max: number): Promise<Buffer | null> {
    if (!(await this.fill())) return null;
    const take = Math.min(max, this.current.length - this.offset);
    const slice = this.current.subarray(this.offset, this.offset + take);
    this.offset += take;
    return slice;
  }

  /** Exactly `length` bytes; `onShort` decides the error when the stream ends first. */
  async readExact(length: number, onShort: () => Error): Promise<Buffer> {
    if (length === 0) return Buffer.alloc(0);
    const parts: Buffer[] = [];
    let remaining = length;
    while (remaining > 0) {
      const chunk = await this.readSome(remaining);
      if (!chunk) throw onShort();
      parts.push(chunk);
      remaining -= chunk.length;
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts, length);
  }

  /** Bytes up to and including the next newline, at most `max`. */
  async readLine(max: number, onShort: () => Error): Promise<Buffer> {
    const parts: Buffer[] = [];
    let length = 0;
    for (;;) {
      if (!(await this.fill())) throw onShort();
      const newline = this.current.indexOf(0x0a, this.offset);
      const end = newline === -1 ? this.current.length : newline + 1;
      const slice = this.current.subarray(this.offset, end);
      this.offset = end;
      parts.push(slice);
      length += slice.length;
      if (length > max) throw onShort();
      if (newline !== -1) return Buffer.concat(parts, length);
    }
  }

  async atEnd(): Promise<boolean> {
    return !(await this.fill());
  }
}

function sourceIterator(input: Readable | AsyncIterable<Buffer>): AsyncIterator<Buffer> {
  return (input as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
}

function parseHeader(json: string): ExportHeader {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ExportArchiveError('NOT_AN_EXPORT', 'This file is not an Opfield configuration export');
  }
  const header = value as Partial<ExportHeader> & { [LEGACY_EXPORT_VERSION_FIELD]?: unknown };
  // legacy-name: the earlier version field — the header field of exports made before 2.12.1 (read to name their version).
  if (header && typeof header === 'object' && header.opfieldVersion === undefined) {
    const legacyVersion = header[LEGACY_EXPORT_VERSION_FIELD];
    if (typeof legacyVersion === 'string') header.opfieldVersion = legacyVersion;
    delete header[LEGACY_EXPORT_VERSION_FIELD];
  }
  if (!header || typeof header !== 'object' || header.format !== EXPORT_FORMAT_VERSION) {
    throw new ExportArchiveError(
      'UNSUPPORTED_FORMAT',
      'This export was made in a format this Opfield version does not read'
    );
  }
  const kdf = header.kdf;
  const valid =
    typeof header.createdAt === 'string' &&
    typeof header.opfieldVersion === 'string' &&
    typeof header.schemaMigration === 'string' &&
    header.cipher === 'aes-256-gcm' &&
    Number.isSafeInteger(header.chunkBytes) &&
    header.chunkBytes! > 0 &&
    header.chunkBytes! <= MAX_CHUNK_BYTES &&
    typeof header.noncePrefix === 'string' &&
    Buffer.from(header.noncePrefix, 'base64').length === 4 &&
    typeof header.keyCheck === 'string' &&
    Buffer.from(header.keyCheck, 'base64').length === 32 &&
    kdf?.name === 'scrypt' &&
    Number.isSafeInteger(kdf.N) &&
    kdf.N >= 16_384 &&
    kdf.N <= KDF_LIMITS.maxN &&
    (kdf.N & (kdf.N - 1)) === 0 &&
    Number.isSafeInteger(kdf.r) &&
    kdf.r >= 1 &&
    kdf.r <= KDF_LIMITS.maxR &&
    Number.isSafeInteger(kdf.p) &&
    kdf.p >= 1 &&
    kdf.p <= KDF_LIMITS.maxP &&
    typeof kdf.salt === 'string' &&
    Buffer.from(kdf.salt, 'base64').length >= 16;
  if (!valid) throw new ExportArchiveError('NOT_AN_EXPORT', 'The export file header is invalid');
  return header as ExportHeader;
}

async function readHeaderLines(reader: ByteReader): Promise<{ header: ExportHeader; digest: Buffer }> {
  const notExport = () => new ExportArchiveError('NOT_AN_EXPORT', 'This file is not an Opfield configuration export');
  const magic = await reader.readLine(EXPORT_FILE_MAGIC.length + 1, notExport);
  if (magic.toString('utf8') !== `${EXPORT_FILE_MAGIC}\n`) throw notExport();
  const json = await reader.readLine(MAX_HEADER_BYTES, notExport);
  const header = parseHeader(json.toString('utf8'));
  const digest = createHash('sha256').update(magic).update(json).digest();
  return { header, digest };
}

/** The plaintext header of an export file, without its passphrase. */
export async function readExportHeader(input: Readable | AsyncIterable<Buffer>): Promise<ExportHeader> {
  const reader = new ByteReader(sourceIterator(input));
  return (await readHeaderLines(reader)).header;
}

/** Decrypts the frames of an export; yields plaintext and throws on any authentication failure. */
async function* decryptFrames(
  reader: ByteReader,
  header: ExportHeader,
  digest: Buffer,
  keys: DerivedKeys
): AsyncGenerator<Buffer> {
  const prefix = Buffer.from(header.noncePrefix, 'base64');
  let index = 0n;
  for (;;) {
    const frameHead = await reader.readExact(5, truncated);
    const flags = frameHead.readUInt8(0);
    const length = frameHead.readUInt32BE(1);
    if ((flags & ~FINAL_FLAG) !== 0 || length > header.chunkBytes) throw damaged();
    const body = await reader.readExact(length + TAG_BYTES, truncated);
    const decipher = createDecipheriv('aes-256-gcm', keys.encryption, frameNonce(prefix, index));
    decipher.setAAD(frameAad(digest, index, flags));
    decipher.setAuthTag(body.subarray(length));
    let plaintext: Buffer;
    try {
      plaintext = Buffer.concat([decipher.update(body.subarray(0, length)), decipher.final()]);
    } catch {
      throw damaged();
    }
    index += 1n;
    if (plaintext.length > 0) yield plaintext;
    if (flags & FINAL_FLAG) {
      if (!(await reader.atEnd())) throw damaged();
      return;
    }
  }
}

export interface ExportPartSummary {
  name: string;
  bytes: number;
  sha256: string;
}

export interface ExportArchivePart {
  name: string;
  /** The part's bytes; read it to the end (or call skip) before asking for the next part. */
  stream: Readable;
  /** Reads and discards the rest of the part. */
  skip(): Promise<void>;
}

export interface OpenedExportArchive {
  header: ExportHeader;
  /** Every part in order; the iterator throws when the file is damaged, truncated or inconsistent. */
  parts(): AsyncGenerator<ExportArchivePart>;
}

/**
 * Opens an export with its passphrase. A wrong passphrase fails here; damage is found while the
 * parts are read, at the latest at the end, so a caller that must not act on a damaged file reads
 * every part once before it changes anything.
 */
export async function openExportArchive(
  input: Readable | AsyncIterable<Buffer>,
  passphrase: string
): Promise<OpenedExportArchive> {
  const raw = new ByteReader(sourceIterator(input));
  const { header, digest } = await readHeaderLines(raw);
  const keys = await deriveKeys(passphrase, header.kdf);
  const expected = Buffer.from(header.keyCheck, 'base64');
  if (!timingSafeEqual(keyCheck(keys), expected)) {
    throw new ExportArchiveError('WRONG_PASSPHRASE', 'The passphrase does not open this export');
  }
  const plain = new ByteReader(decryptFrames(raw, header, digest, keys));
  let started = false;

  async function* parts(): AsyncGenerator<ExportArchivePart> {
    if (started) throw new Error('The parts of an export can be read once');
    started = true;
    const summaries: ExportPartSummary[] = [];
    let first = true;
    for (;;) {
      const nameLength = (await plain.readExact(2, truncated)).readUInt16BE(0);
      if (nameLength === 0 || nameLength > MAX_PART_NAME_BYTES) throw damaged();
      const name = (await plain.readExact(nameLength, truncated)).toString('utf8');
      if (first && name !== MANIFEST_PART)
        throw new ExportArchiveError('INVALID_CONTENT', 'The export has no manifest');
      first = false;
      if (name === END_PART) {
        const end = await readWholePart(plain);
        verifyEnd(end, summaries);
        if (!(await plain.atEnd())) throw damaged();
        return;
      }
      const hash = createHash('sha256');
      let bytes = 0;
      let blockRemaining = 0;
      let finished = false;
      let failure: unknown = null;
      // The next chunk of this part, or null after its closing empty block.
      const nextChunk = async (): Promise<Buffer | null> => {
        if (finished) return null;
        if (failure) throw failure;
        try {
          while (blockRemaining === 0) {
            blockRemaining = (await plain.readExact(4, truncated)).readUInt32BE(0);
            if (blockRemaining === 0) {
              finished = true;
              summaries.push({ name, bytes, sha256: hash.digest('hex') });
              return null;
            }
          }
          const chunk = await plain.readSome(blockRemaining);
          if (!chunk) throw truncated();
          blockRemaining -= chunk.length;
          bytes += chunk.length;
          hash.update(chunk);
          return chunk;
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      let reading = false;
      const stream = new Readable({
        highWaterMark: 1024 * 1024,
        read() {
          if (reading) return;
          reading = true;
          nextChunk().then(
            (chunk) => {
              reading = false;
              this.push(chunk);
            },
            (error) => {
              reading = false;
              this.destroy(error as Error);
            }
          );
        },
      });
      const skip = async () => {
        while (reading) await new Promise((resolve) => setImmediate(resolve));
        while ((await nextChunk()) !== null) {
          // Discarded.
        }
      };
      yield { name, stream, skip };
      if (!finished) {
        stream.destroy();
        await skip();
      }
    }
  }

  return { header, parts };
}

async function readWholePart(plain: ByteReader): Promise<Buffer> {
  const parts: Buffer[] = [];
  let total = 0;
  for (;;) {
    const length = (await plain.readExact(4, truncated)).readUInt32BE(0);
    if (length === 0) break;
    total += length;
    if (total > MAX_JSON_PART_BYTES) throw damaged();
    parts.push(await plain.readExact(length, truncated));
  }
  return Buffer.concat(parts, total);
}

function verifyEnd(end: Buffer, summaries: ExportPartSummary[]): void {
  let listed: unknown;
  try {
    listed = JSON.parse(end.toString('utf8'));
  } catch {
    throw damaged();
  }
  const parts = (listed as { parts?: ExportPartSummary[] })?.parts;
  if (!Array.isArray(parts) || parts.length !== summaries.length) throw damaged();
  parts.forEach((part, index) => {
    const actual = summaries[index]!;
    if (part.name !== actual.name || part.bytes !== actual.bytes || part.sha256 !== actual.sha256) throw damaged();
  });
}

/** Reads a whole part as JSON (manifest, environment). */
export async function readJsonPart<T>(part: ExportArchivePart): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of part.stream) {
    total += (chunk as Buffer).length;
    if (total > MAX_JSON_PART_BYTES) throw new ExportArchiveError('INVALID_CONTENT', `${part.name} is too large`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as T;
  } catch {
    throw new ExportArchiveError('INVALID_CONTENT', `${part.name} is not valid JSON`);
  }
}

/**
 * Writes an export. Parts are added one at a time; `output` carries the encrypted file and applies
 * backpressure to the part sources.
 */
export class ExportArchiveWriter {
  readonly output = new PassThrough({ highWaterMark: 4 * 1024 * 1024 });
  private readonly pending: Buffer[] = [];
  private pendingBytes = 0;
  private index = 0n;
  private readonly summaries: ExportPartSummary[] = [];
  private finished = false;
  private writtenBytes = 0;

  private constructor(
    readonly header: ExportHeader,
    private readonly headerBytes: Buffer,
    private readonly digest: Buffer,
    private readonly keys: DerivedKeys,
    private readonly prefix: Buffer
  ) {}

  static async create(
    passphrase: string,
    input: ExportHeaderInput,
    options: { kdf?: Omit<ExportHeader['kdf'], 'salt'>; chunkBytes?: number } = {}
  ): Promise<ExportArchiveWriter> {
    validatePassphrase(passphrase);
    const kdf = { ...(options.kdf ?? DEFAULT_KDF), salt: randomBytes(32).toString('base64') };
    const keys = await deriveKeys(passphrase, kdf);
    const prefix = randomBytes(4);
    const header: ExportHeader = {
      format: EXPORT_FORMAT_VERSION,
      createdAt: input.createdAt ?? new Date().toISOString(),
      opfieldVersion: input.opfieldVersion,
      schemaMigration: input.schemaMigration,
      kdf,
      cipher: 'aes-256-gcm',
      chunkBytes: options.chunkBytes ?? DEFAULT_CHUNK_BYTES,
      noncePrefix: prefix.toString('base64'),
      keyCheck: keyCheck(keys).toString('base64'),
    };
    const magic = Buffer.from(`${EXPORT_FILE_MAGIC}\n`, 'utf8');
    const json = Buffer.from(`${JSON.stringify(header)}\n`, 'utf8');
    const digest = createHash('sha256').update(magic).update(json).digest();
    const writer = new ExportArchiveWriter(header, Buffer.concat([magic, json]), digest, keys, prefix);
    return writer;
  }

  /** Bytes of the encrypted file produced so far. */
  get bytesWritten(): number {
    return this.writtenBytes;
  }

  private started = false;

  private async emit(data: Buffer): Promise<void> {
    if (!this.started) {
      this.started = true;
      this.writtenBytes += this.headerBytes.length;
      if (!this.output.write(this.headerBytes)) await this.waitDrain();
    }
    this.writtenBytes += data.length;
    if (!this.output.write(data)) await this.waitDrain();
  }

  private async waitDrain(): Promise<void> {
    if (this.output.destroyed) throw new Error('The export stream was closed');
    await Promise.race([
      once(this.output, 'drain'),
      once(this.output, 'close').then(() => {
        throw new Error('The export stream was closed');
      }),
    ]);
  }

  private async emitFrame(plaintext: Buffer, final: boolean): Promise<void> {
    const flags = final ? FINAL_FLAG : 0;
    const cipher = createCipheriv('aes-256-gcm', this.keys.encryption, frameNonce(this.prefix, this.index));
    cipher.setAAD(frameAad(this.digest, this.index, flags));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const head = Buffer.alloc(5);
    head.writeUInt8(flags, 0);
    head.writeUInt32BE(ciphertext.length, 1);
    this.index += 1n;
    await this.emit(Buffer.concat([head, ciphertext, cipher.getAuthTag()]));
  }

  private async writePlain(data: Buffer): Promise<void> {
    let offset = 0;
    while (offset < data.length) {
      const room = this.header.chunkBytes - this.pendingBytes;
      const take = Math.min(room, data.length - offset);
      this.pending.push(data.subarray(offset, offset + take));
      this.pendingBytes += take;
      offset += take;
      if (this.pendingBytes === this.header.chunkBytes) {
        const frame = Buffer.concat(this.pending, this.pendingBytes);
        this.pending.length = 0;
        this.pendingBytes = 0;
        await this.emitFrame(frame, false);
      }
    }
  }

  private async writeBlock(data: Buffer): Promise<void> {
    if (data.length === 0) return;
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    await this.writePlain(length);
    await this.writePlain(data);
  }

  /** Adds one part from a buffer or a stream of bytes; resolves with its size. */
  async addPart(name: string, source: Buffer | Readable | AsyncIterable<Buffer>): Promise<number> {
    if (this.finished) throw new Error('The export is already finished');
    const nameBytes = Buffer.from(name, 'utf8');
    if (nameBytes.length === 0 || nameBytes.length > MAX_PART_NAME_BYTES || name === END_PART) {
      throw new Error(`Invalid export part name: ${name}`);
    }
    if (this.summaries.length === 0 && name !== MANIFEST_PART) throw new Error('The manifest must be the first part');
    const head = Buffer.alloc(2);
    head.writeUInt16BE(nameBytes.length, 0);
    await this.writePlain(head);
    await this.writePlain(nameBytes);
    const hash = createHash('sha256');
    let bytes = 0;
    const chunks: AsyncIterable<Buffer> | Buffer[] = Buffer.isBuffer(source) ? [source] : source;
    for await (const raw of chunks) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      // Blocks stay below the frame size so a part never needs a whole chunk in memory twice.
      for (let offset = 0; offset < chunk.length; offset += this.header.chunkBytes) {
        const slice = chunk.subarray(offset, Math.min(chunk.length, offset + this.header.chunkBytes));
        hash.update(slice);
        bytes += slice.length;
        await this.writeBlock(slice);
      }
    }
    await this.writePlain(Buffer.alloc(4));
    this.summaries.push({ name, bytes, sha256: hash.digest('hex') });
    return bytes;
  }

  async addJsonPart(name: string, value: unknown): Promise<number> {
    return this.addPart(name, Buffer.from(JSON.stringify(value), 'utf8'));
  }

  /** Writes the closing part and the final frame, then ends `output`. */
  async finish(): Promise<void> {
    if (this.finished) return;
    if (this.summaries.length === 0) throw new Error('An export needs a manifest');
    const end = Buffer.from(JSON.stringify({ parts: this.summaries }), 'utf8');
    const nameBytes = Buffer.from(END_PART, 'utf8');
    const head = Buffer.alloc(2);
    head.writeUInt16BE(nameBytes.length, 0);
    await this.writePlain(head);
    await this.writePlain(nameBytes);
    await this.writeBlock(end);
    await this.writePlain(Buffer.alloc(4));
    this.finished = true;
    const rest = Buffer.concat(this.pending, this.pendingBytes);
    this.pending.length = 0;
    this.pendingBytes = 0;
    await this.emitFrame(rest, true);
    this.output.end();
  }

  /** Ends `output` with an error; a download then stops without a final frame and cannot be opened. */
  abort(error: Error): void {
    this.finished = true;
    this.output.destroy(error);
  }

  get parts(): readonly ExportPartSummary[] {
    return this.summaries;
  }
}
