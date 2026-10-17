import { spawn } from 'node:child_process';
import { createPrivateKey, createPublicKey, randomBytes, verify, webcrypto, X509Certificate } from 'node:crypto';
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import * as x509 from '@peculiar/x509';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase, migrationsFolder } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { certificateAuthorities, permissionGroups, settings, users } from '@/db/schema/index.js';
import { LEGACY_INSTALL_DIR_NAME } from '@/lib/legacy-compat.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { CAService } from '@/modules/pki/ca.service.js';
import { CryptoService } from '@/services/crypto.service.js';
import { RelayPolicySigningKeyService } from '@/services/relay-policy-signing-key.service.js';
import { SystemCAService } from '@/services/system-ca.service.js';
import { verifyExport } from './configuration-restore.js';
import { ExportArchiveWriter, MANIFEST_PART, openExportArchive } from './transfer-archive.js';
import {
  type ConfigurationExportManifest,
  currentSchemaMigration,
  DATABASE_DUMP_FILE,
  DATABASE_PART,
  ENVIRONMENT_PART,
  portableEnvironment,
} from './transfer-layout.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;
const PG_DUMP = process.env.PG_DUMP_BIN || 'pg_dump';
const PG_RESTORE = process.env.PG_RESTORE_BIN || 'pg_restore';
const PASSPHRASE = 'round trip passphrase';
const SECRET_KEY = 'test:configuration-transfer-secret';

function databaseUrl(suffix: string): string {
  const own = new URL(url!);
  own.pathname = `${own.pathname}_${suffix}`;
  return own.toString();
}

/** Runs a PostgreSQL client tool, streaming stdin and/or stdout. */
function runTool(command: string, args: string[], input?: Readable): { stdout: Readable; done: Promise<void> } {
  const child = spawn(command, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr!.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  if (input) input.pipe(child.stdin!);
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr}`))));
  });
  return { stdout: child.stdout!, done };
}

const auditStub = { log: async () => true } as unknown as AuditService;

/**
 * The export carries what keeps an installation's trust: every secret decrypts with the exported
 * master key, the CA private keys still match the certificates enrolled nodes pinned, and the relay
 * policy signing key still signs what relays verify with the key they were enrolled with.
 */
describe.skipIf(!url)('configuration export round trip, on disposable PostgreSQL', () => {
  let source: Awaited<ReturnType<typeof disposableDatabase>>;
  let target: Awaited<ReturnType<typeof disposableDatabase>>;
  let sourceDb: DrizzleClient;
  let targetDb: DrizzleClient;
  const masterKey = randomBytes(32).toString('hex');
  const sourceCrypto = new CryptoService(masterKey);
  const work = mkdtempSync(join(tmpdir(), 'configuration-transfer-db-'));
  const archivePath = join(work, 'round-trip.opfield-export');
  let caCertificatePem = '';
  let policyTrust: { keyId: string; publicKey: Buffer };

  beforeAll(async () => {
    source = await disposableDatabase(url!, 'transfer_source');
    target = await disposableDatabase(url!, 'transfer_target');
    sourceDb = drizzle(source.pool, { schema }) as unknown as DrizzleClient;
    targetDb = drizzle(target.pool, { schema }) as unknown as DrizzleClient;
    await migrateDatabase(source.pool);

    // The source installation: its system user, System CA, relay policy key and an encrypted secret.
    const [group] = await sourceDb
      .insert(permissionGroups)
      .values({ name: `transfer-test-${randomBytes(4).toString('hex')}` })
      .returning({ id: permissionGroups.id });
    await sourceDb.insert(users).values({
      id: '00000000-0000-0000-0000-000000000000',
      oidcSubject: 'system:transfer-test',
      email: 'system@opfield.local',
      name: 'Opfield System',
      groupId: group!.id,
    });
    const caService = new CAService(sourceDb, sourceCrypto, auditStub);
    const systemCa = new SystemCAService(sourceDb, caService, {} as never, sourceCrypto);
    const caId = await systemCa.ensureSystemCA();
    caCertificatePem = (await systemCa.getSystemCACertPem())!;
    expect(caId).toBeTruthy();
    const policyKeys = new RelayPolicySigningKeyService(sourceDb, sourceCrypto);
    await policyKeys.ensureInitialized();
    policyTrust = await policyKeys.getEnrollmentTrust();
    await sourceDb.insert(settings).values({
      key: SECRET_KEY,
      value: sourceCrypto.encryptString('oidc-client-secret-value'),
      updatedAt: new Date(),
    });

    // Export: the same parts the app writes, with the database from pg_dump.
    const header = { opfieldVersion: 'v-test', schemaMigration: currentSchemaMigration(migrationsFolder) };
    const writer = await ExportArchiveWriter.create(PASSPHRASE, header, {
      kdf: { name: 'scrypt', N: 16_384, r: 8, p: 1 },
    });
    const chunks: Buffer[] = [];
    writer.output.on('data', (chunk: Buffer) => chunks.push(chunk));
    const ended = new Promise((resolve) => writer.output.on('end', resolve));
    const manifest: ConfigurationExportManifest = {
      format: 1,
      createdAt: new Date().toISOString(),
      ...header,
      installationId: 'b6f0b5a0-0000-4000-8000-000000000001',
      source: {
        publicUrl: 'https://old.example.com',
        grpcPublicTarget: 'old.example.com:9443',
        grpcLocalIp: null,
        composeProject: `${LEGACY_INSTALL_DIR_NAME}`,
      },
      includes: { registry: false, logs: false },
      commercialDir: null,
      database: { part: DATABASE_PART, file: DATABASE_DUMP_FILE },
      volumes: [],
      commercial: null,
      environmentPart: ENVIRONMENT_PART,
    };
    await writer.addJsonPart(MANIFEST_PART, manifest);
    await writer.addJsonPart(ENVIRONMENT_PART, portableEnvironment({ PKI_MASTER_KEY: masterKey }));
    const dump = runTool(PG_DUMP, [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      '-d',
      databaseUrl('transfer_source'),
    ]);
    await writer.addPart(DATABASE_PART, dump.stdout);
    await dump.done;
    await writer.finish();
    await ended;
    writeFileSync(archivePath, Buffer.concat(chunks));
  }, 180_000);

  afterAll(async () => {
    await source?.drop();
    await target?.drop();
    rmSync(work, { recursive: true, force: true });
  });

  it('restores into a fresh database where secrets decrypt and keys keep their trust', async () => {
    // Verify the whole file first, as a restore does, then load the database part.
    const verified = await verifyExport(archivePath, PASSPHRASE, {
      opfieldVersion: 'v-test',
      schemaMigration: currentSchemaMigration(migrationsFolder),
    });
    const archive = await openExportArchive(createReadStream(archivePath), PASSPHRASE);
    for await (const part of archive.parts()) {
      if (part.name !== DATABASE_PART) {
        await part.skip();
        continue;
      }
      const restore = runTool(
        PG_RESTORE,
        ['--exit-on-error', '--no-owner', '--no-privileges', '-d', databaseUrl('transfer_target')],
        part.stream
      );
      restore.stdout.resume();
      await restore.done;
    }
    const restoredCrypto = new CryptoService(verified.environment.PKI_MASTER_KEY!);

    // Secrets decrypt with the exported master key, and not with another one.
    const [secretRow] = await targetDb.select().from(settings).where(eq(settings.key, SECRET_KEY));
    const encrypted = secretRow!.value as { encryptedKey: string; encryptedDek: string };
    expect(restoredCrypto.decryptString(encrypted)).toBe('oidc-client-secret-value');
    expect(() => new CryptoService(randomBytes(32).toString('hex')).decryptString(encrypted)).toThrow();

    // The System CA is the one nodes pinned, and its restored private key signs leaves they accept.
    const [ca] = await targetDb
      .select()
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.systemPurpose, 'node-mtls'));
    expect(ca!.certificatePem).toBe(caCertificatePem);
    const caPrivateKeyPem = restoredCrypto.decryptPrivateKey({
      encryptedPrivateKey: ca!.encryptedPrivateKey!,
      encryptedDek: ca!.encryptedDek!,
      dekIv: ca!.dekIv ?? '',
    });
    const pinned = new X509Certificate(caCertificatePem);
    expect(pinned.checkPrivateKey(createPrivateKey(caPrivateKeyPem))).toBe(true);
    x509.cryptoProvider.set(webcrypto as never);
    const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
    const signingKey = await webcrypto.subtle.importKey(
      'pkcs8',
      createPrivateKey(caPrivateKeyPem).export({ format: 'der', type: 'pkcs8' }),
      algorithm,
      false,
      ['sign']
    );
    const leafKeys = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
    const leaf = await x509.X509CertificateGenerator.create({
      serialNumber: '01',
      subject: 'CN=restored-node',
      issuer: new x509.X509Certificate(caCertificatePem).subject,
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 3_600_000),
      signingAlgorithm: algorithm,
      publicKey: leafKeys.publicKey,
      signingKey,
    });
    expect(new X509Certificate(leaf.toString('pem')).verify(pinned.publicKey)).toBe(true);

    // The relay policy key signs what relays verify with the key they were enrolled with.
    const restoredPolicyKeys = new RelayPolicySigningKeyService(targetDb, restoredCrypto);
    const payload = Buffer.from('relay policy snapshot');
    const signed = await restoredPolicyKeys.signPayload(payload);
    expect(signed.signingKeyId).toBe(policyTrust.keyId);
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), policyTrust.publicKey]),
      format: 'der',
      type: 'spki',
    });
    expect(verify(null, payload, publicKey, signed.signature)).toBe(true);
  }, 180_000);
});
