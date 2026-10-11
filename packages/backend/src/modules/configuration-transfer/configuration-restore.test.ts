import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { RestoreError, singleFileTar, verifyExport } from './configuration-restore.js';
import { withDefaultPort } from './gateway-move.service.js';
import { ExportArchiveError, ExportArchiveWriter, MANIFEST_PART } from './transfer-archive.js';
import {
  type ConfigurationExportManifest,
  DATABASE_DUMP_FILE,
  DATABASE_PART,
  ENVIRONMENT_PART,
  exportFileName,
  parsePortableEnvironment,
  portableEnvironment,
  versionMismatch,
  volumePartName,
} from './transfer-layout.js';

const FAST_KDF = { name: 'scrypt' as const, N: 16_384, r: 8, p: 1 };
const PASSPHRASE = 'moving day passphrase';
const CURRENT = { gatewayVersion: 'v2.12.0', schemaMigration: '0241_backup_run_source' };
const MASTER_KEY = randomBytes(32).toString('hex');
const work = mkdtempSync(join(tmpdir(), 'configuration-restore-'));

function manifest(overrides: Partial<ConfigurationExportManifest> = {}): ConfigurationExportManifest {
  return {
    format: 1,
    createdAt: '2026-10-11T12:00:00.000Z',
    gatewayVersion: CURRENT.gatewayVersion,
    schemaMigration: CURRENT.schemaMigration,
    installationId: '7c1f6c2e-2a8f-4c62-9a43-0d8a2f2b1c11',
    source: {
      publicUrl: 'https://old.example.com',
      grpcPublicTarget: 'old.example.com:9443',
      grpcLocalIp: null,
      composeProject: 'gateway',
    },
    includes: { registry: false, logs: false },
    commercialDir: null,
    database: { part: DATABASE_PART, file: DATABASE_DUMP_FILE },
    volumes: [{ key: 'gateway_data', part: volumePartName('gateway_data'), root: 'gateway_data' }],
    commercial: null,
    environmentPart: ENVIRONMENT_PART,
    ...overrides,
  };
}

async function exportFile(
  name: string,
  options: { header?: Partial<typeof CURRENT>; manifest?: ConfigurationExportManifest; skipVolume?: boolean } = {}
): Promise<string> {
  const header = { ...CURRENT, ...options.header };
  const writer = await ExportArchiveWriter.create(PASSPHRASE, header, { kdf: FAST_KDF, chunkBytes: 4096 });
  const chunks: Buffer[] = [];
  writer.output.on('data', (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise((resolve) => writer.output.on('end', resolve));
  await writer.addJsonPart(MANIFEST_PART, options.manifest ?? { ...manifest(), ...header });
  await writer.addJsonPart(ENVIRONMENT_PART, { PKI_MASTER_KEY: MASTER_KEY });
  await writer.addPart(DATABASE_PART, Readable.from([randomBytes(20_000)]));
  if (!options.skipVolume) await writer.addPart(volumePartName('gateway_data'), Readable.from([randomBytes(9_000)]));
  await writer.finish();
  await ended;
  const path = join(work, name);
  writeFileSync(path, Buffer.concat(chunks));
  return path;
}

async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ExportArchiveError || error instanceof RestoreError) return error.code;
    return `other: ${(error as Error).message}`;
  }
  return 'none';
}

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('restoring a configuration export', () => {
  it('verifies a complete export and returns its manifest, environment and part sizes', async () => {
    const path = await exportFile('good.opfield-export');
    let progress = 0;
    const verified = await verifyExport(path, PASSPHRASE, CURRENT, (bytes) => {
      progress = bytes;
    });
    expect(verified.environment.PKI_MASTER_KEY).toBe(MASTER_KEY);
    expect(verified.summary.sourcePublicUrl).toBe('https://old.example.com');
    expect(verified.summary.parts.map((part) => part.name)).toEqual([
      MANIFEST_PART,
      ENVIRONMENT_PART,
      DATABASE_PART,
      volumePartName('gateway_data'),
    ]);
    expect(verified.summary.parts.find((part) => part.name === DATABASE_PART)?.bytes).toBe(20_000);
    expect(progress).toBe(readFileSync(path).length);
  });

  it('refuses a wrong passphrase', async () => {
    const path = await exportFile('passphrase.opfield-export');
    expect(await failure(() => verifyExport(path, 'another passphrase entirely', CURRENT))).toBe('WRONG_PASSPHRASE');
  });

  it('refuses a changed file before anything is restored', async () => {
    const path = await exportFile('tampered.opfield-export');
    const bytes = readFileSync(path);
    bytes[bytes.length - 3000]! ^= 0x40;
    writeFileSync(path, bytes);
    expect(await failure(() => verifyExport(path, PASSPHRASE, CURRENT))).toBe('DAMAGED');
    const truncated = join(work, 'truncated.opfield-export');
    writeFileSync(truncated, readFileSync(await exportFile('whole.opfield-export')).subarray(0, 9000));
    expect(await failure(() => verifyExport(truncated, PASSPHRASE, CURRENT))).toBe('TRUNCATED');
  });

  it('refuses another Opfield version or schema with a clear message', async () => {
    const path = await exportFile('older.opfield-export', { header: { gatewayVersion: 'v2.11.4' } });
    const error = await verifyExport(path, PASSPHRASE, CURRENT).catch((caught: unknown) => caught as RestoreError);
    expect(error).toBeInstanceOf(RestoreError);
    expect((error as RestoreError).code).toBe('VERSION_MISMATCH');
    expect((error as RestoreError).message).toContain('made by Opfield v2.11.4');
    expect((error as RestoreError).message).toContain('runs v2.12.0');
    const schema = await exportFile('schema.opfield-export', {
      header: { schemaMigration: '0240_managed_availability' },
    });
    expect(await failure(() => verifyExport(schema, PASSPHRASE, CURRENT))).toBe('VERSION_MISMATCH');
  });

  it('refuses an export whose manifest names a part it does not carry', async () => {
    const path = await exportFile('missing.opfield-export', { skipVolume: true });
    expect(await failure(() => verifyExport(path, PASSPHRASE, CURRENT))).toBe('INVALID_EXPORT');
  });

  it('refuses a manifest with unsafe names', async () => {
    const path = await exportFile('unsafe.opfield-export', {
      manifest: manifest({ volumes: [{ key: 'gateway_data', part: volumePartName('gateway_data'), root: '..' }] }),
    });
    expect(await failure(() => verifyExport(path, PASSPHRASE, CURRENT))).toBe('INVALID_EXPORT');
  });
});

describe('configuration export layout', () => {
  it('exports the master key and set tunables, and nothing host specific', () => {
    const values = portableEnvironment({
      PKI_MASTER_KEY: MASTER_KEY,
      DB_PASSWORD: 'secret',
      PUBLIC_IPV4: '203.0.113.5',
      DNS_RESOLVERS: '9.9.9.9',
      GITHUB_OAUTH_CLIENT_ID: 'Ov23likbDL1gM8asWzfC',
    });
    expect(values).toEqual({ PKI_MASTER_KEY: MASTER_KEY, DNS_RESOLVERS: '9.9.9.9' });
    expect(() => portableEnvironment({})).toThrow(/PKI_MASTER_KEY/);
  });

  it('accepts only known, single-line environment values from an export', () => {
    expect(parsePortableEnvironment({ PKI_MASTER_KEY: MASTER_KEY, DB_PASSWORD: 'x' })).toEqual({
      PKI_MASTER_KEY: MASTER_KEY,
    });
    expect(() => parsePortableEnvironment({ PKI_MASTER_KEY: MASTER_KEY, DNS_RESOLVERS: '1.1.1.1\nX=1' })).toThrow();
    expect(() => parsePortableEnvironment({ PKI_MASTER_KEY: 'short' })).toThrow(/PKI_MASTER_KEY/);
  });

  it('names versions and files plainly', () => {
    expect(versionMismatch(CURRENT, CURRENT)).toBeNull();
    expect(exportFileName('https://gw.example.com', new Date('2026-10-11T08:05:00Z'))).toBe(
      'gw.example.com-20261011-0805.opfield-export'
    );
    expect(withDefaultPort('gw.example.com')).toBe('gw.example.com:9443');
    expect(withDefaultPort('203.0.113.5:443')).toBe('203.0.113.5:443');
    expect(withDefaultPort('2001:db8::1')).toBe('[2001:db8::1]:9443');
    expect(withDefaultPort('[2001:db8::1]:9000')).toBe('[2001:db8::1]:9000');
  });

  it('writes a single-file tar that tar reads', () => {
    const path = join(work, 'marker.tar');
    writeFileSync(path, singleFileTar('gateway_data/configuration-restore/restored.json', Buffer.from('{"a":1}')));
    const listing = execFileSync('tar', ['-tvf', path], { encoding: 'utf8' });
    expect(listing).toContain('gateway_data/configuration-restore/restored.json');
    const content = execFileSync('tar', ['-xOf', path], { encoding: 'utf8' });
    expect(content).toBe('{"a":1}');
  });
});
