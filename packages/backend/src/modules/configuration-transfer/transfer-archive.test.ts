import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  ExportArchiveError,
  ExportArchiveWriter,
  MANIFEST_PART,
  openExportArchive,
  readExportHeader,
  readJsonPart,
} from './transfer-archive.js';
import { LEGACY_EXPORT_VERSION_FIELD, LEGACY_VOLUME_APP_DATA } from '@/lib/legacy-compat.js';

const FAST_KDF = { name: 'scrypt' as const, N: 16_384, r: 8, p: 1 };
const PASSPHRASE = 'correct horse battery staple';

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function makeArchive(parts: Array<[string, Buffer]>, chunkBytes = 1024): Promise<Buffer> {
  const writer = await ExportArchiveWriter.create(
    PASSPHRASE,
    { opfieldVersion: 'v2.12.0', schemaMigration: '0300_test' },
    { kdf: FAST_KDF, chunkBytes }
  );
  const done = collect(writer.output);
  await writer.addJsonPart(MANIFEST_PART, { hello: 'world' });
  for (const [name, data] of parts) {
    // Stream sources arrive in uneven chunks.
    const pieces = [data.subarray(0, 7), data.subarray(7, 3000), data.subarray(3000)];
    await writer.addPart(name, Readable.from(pieces.filter((piece) => piece.length > 0)));
  }
  await writer.finish();
  return done;
}

async function readAll(file: Buffer, passphrase = PASSPHRASE): Promise<Map<string, Buffer>> {
  const archive = await openExportArchive(Readable.from([file]), passphrase);
  const result = new Map<string, Buffer>();
  for await (const part of archive.parts()) result.set(part.name, await collect(part.stream));
  return result;
}

async function errorCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof ExportArchiveError ? error.code : `other: ${(error as Error).message}`;
  }
  return 'no error';
}

describe('configuration export archive', () => {
  const database = randomBytes(10_000);
  const volume = randomBytes(5_123);

  it('round-trips every part and keeps the version readable without the passphrase', async () => {
    const file = await makeArchive([
      ['database.tar', database],
      [`volume/${LEGACY_VOLUME_APP_DATA}.tar`, volume],
      ['empty', Buffer.alloc(0)],
    ]);
    const header = await readExportHeader(Readable.from([file]));
    expect(header.opfieldVersion).toBe('v2.12.0');
    expect(header.schemaMigration).toBe('0300_test');
    // The header of an export made before 2.12.1 names its version the earlier version field.
    const lines = file.toString('latin1').split('\n');
    const legacyHeader = JSON.stringify(
      Object.fromEntries(
        Object.entries(JSON.parse(lines[1]!)).map(([key, value]) => [
          key === 'opfieldVersion' ? LEGACY_EXPORT_VERSION_FIELD : key,
          value,
        ])
      )
    );
    const legacy = Buffer.from([lines[0], legacyHeader, ...lines.slice(2)].join('\n'), 'latin1');
    expect((await readExportHeader(Readable.from([legacy]))).opfieldVersion).toBe('v2.12.0');
    expect(file.toString('utf8', 0, 17)).toBe('OPFIELD-EXPORT/1\n');
    const parts = await readAll(file);
    expect([...parts.keys()]).toEqual([MANIFEST_PART, 'database.tar', `volume/${LEGACY_VOLUME_APP_DATA}.tar`, 'empty']);
    expect(JSON.parse(parts.get(MANIFEST_PART)!.toString())).toEqual({ hello: 'world' });
    expect(parts.get('database.tar')!.equals(database)).toBe(true);
    expect(parts.get(`volume/${LEGACY_VOLUME_APP_DATA}.tar`)!.equals(volume)).toBe(true);
    expect(parts.get('empty')!.length).toBe(0);
    // Nothing of the content is readable in the file.
    expect(file.includes(database.subarray(100, 132))).toBe(false);
    expect(file.includes(Buffer.from('hello'))).toBe(false);
  });

  it('skips unread parts and reads JSON parts', async () => {
    const file = await makeArchive([['database.tar', database]]);
    const archive = await openExportArchive(Readable.from([file]), PASSPHRASE);
    const names: string[] = [];
    for await (const part of archive.parts()) {
      names.push(part.name);
      if (part.name === MANIFEST_PART) expect(await readJsonPart(part)).toEqual({ hello: 'world' });
    }
    expect(names).toEqual([MANIFEST_PART, 'database.tar']);
  });

  it('refuses a wrong passphrase before reading any part', async () => {
    const file = await makeArchive([['database.tar', database]]);
    expect(await errorCode(() => openExportArchive(Readable.from([file]), 'not the passphrase at all'))).toBe(
      'WRONG_PASSPHRASE'
    );
  });

  it('finds a changed byte anywhere in the encrypted content', async () => {
    const file = await makeArchive([['database.tar', database]]);
    const headerEnd = file.indexOf(0x0a, 17) + 1;
    for (const offset of [headerEnd + 3, headerEnd + 2000, file.length - 5]) {
      const tampered = Buffer.from(file);
      tampered[offset]! ^= 0x01;
      expect(await errorCode(() => readAll(tampered))).toBe('DAMAGED');
    }
  });

  it('finds a changed header', async () => {
    const file = await makeArchive([['database.tar', database]]);
    const text = file.toString('latin1');
    const tampered = Buffer.from(text.replace('"v2.12.0"', '"v2.12.1"'), 'latin1');
    expect(await errorCode(() => readAll(tampered))).toBe('DAMAGED');
  });

  it('finds a truncated file, trailing data and dropped frames', async () => {
    const file = await makeArchive([['database.tar', database]]);
    expect(await errorCode(() => readAll(file.subarray(0, file.length - 100)))).toBe('TRUNCATED');
    expect(await errorCode(() => readAll(Buffer.concat([file, Buffer.from('x')])))).toBe('DAMAGED');
    // Drop the second frame (frames are 5 + chunkBytes + 16 bytes long here).
    const headerEnd = file.indexOf(0x0a, 17) + 1;
    const frame = 5 + 1024 + 16;
    const dropped = Buffer.concat([file.subarray(0, headerEnd + frame), file.subarray(headerEnd + 2 * frame)]);
    expect(await errorCode(() => readAll(dropped))).toBe('DAMAGED');
  });

  it('rejects files that are not exports and short passphrases', async () => {
    expect(await errorCode(() => readExportHeader(Readable.from([Buffer.from('PK\u0003\u0004 zip')])))).toBe(
      'NOT_AN_EXPORT'
    );
    expect(
      await errorCode(() =>
        ExportArchiveWriter.create('short', { opfieldVersion: 'v1', schemaMigration: 'x' }, { kdf: FAST_KDF })
      )
    ).toBe('INVALID_CONTENT');
  });

  it('stops a stream source as soon as the reader of the output stops', async () => {
    const writer = await ExportArchiveWriter.create(
      PASSPHRASE,
      { opfieldVersion: 'v2.12.0', schemaMigration: 'x' },
      { kdf: FAST_KDF, chunkBytes: 1024 }
    );
    await writer.addJsonPart(MANIFEST_PART, {});
    writer.output.destroy();
    await expect(writer.addPart('big', Readable.from([randomBytes(64 * 1024 * 1024)]))).rejects.toThrow();
  });
});
