import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { patchCompose, patchEnv } from '@/foundation/foundation-migrator.js';
import { normalizeHostPortTarget, normalizePublicUrl } from '@/modules/settings/general-settings.service.js';
import type { DockerService } from '@/services/docker.service.js';
import {
  ExportArchiveError,
  type ExportHeader,
  MANIFEST_PART,
  openExportArchive,
  readExportHeader,
  readJsonPart,
} from './transfer-archive.js';
import {
  type ComposeInstallation,
  detachManagedSignIn,
  dropDatabaseRollback,
  findInstallation,
  flushRedis,
  forgetCloudLink,
  openVolumeArchive,
  removeLeftoverHelpers,
  restoreDatabase,
  restoreVolume,
  rollbackDatabase,
  snapshotDatabaseForRollback,
  wipeVolume,
} from './transfer-docker.js';
import {
  CONFIGURATION_EXPORT_FORMAT,
  type ConfigurationExportManifest,
  composeVolumeName,
  ENVIRONMENT_PART,
  type PortableEnvKey,
  parsePortableEnvironment,
  RESTORE_STAGING_DIR,
  TRANSFER_VOLUMES,
  type TransferVolumeKey,
  versionMismatch,
} from './transfer-layout.js';

/**
 * Restores a configuration export into a fresh Compose installation of the same Opfield version. It
 * runs in a one-off container of the Opfield image with the Docker socket and the install directory
 * mounted: `install.sh --restore` starts it, and so does the setup wizard ("Restore from an export").
 *
 * The whole file is decrypted and checked once before anything changes. Then the app, relay,
 * registry and managed ClickHouse stop, the database and volumes are replaced, .env receives the
 * master key, and the local relay's state is cleared so it pins the restored policy key on its
 * first start. A failure after the first change puts the previous database, volumes and files back.
 */

export const RESTORED_MARKER_FILE = 'restored.json';

export interface RestoreAddress {
  publicUrl?: string | null;
  grpcPublicTarget?: string | null;
  grpcLocalIp?: string | null;
}

/** Written to gateway_data/configuration-restore/restored.json; the app applies it on its next start. */
export interface RestoredMarker {
  restoredAt: string;
  exportCreatedAt: string;
  gatewayVersion: string;
  installationId: string;
  sourcePublicUrl: string | null;
  sourceGrpcPublicTarget: string | null;
  includes: { registry: boolean; logs: boolean };
  address: RestoreAddress;
  /** The source was a managed cloud installation: the owner moved to password sign-in (see ExportSummary). */
  ownerSignIn?: 'password-link';
  license?: 'stayed-with-cloud';
  /**
   * SHA-256 of the claim the setup wizard's browser holds: the first start issues the owner's password link and
   * that browser alone fetches it once (POST /api/setup/restore/owner-link).
   */
  ownerLinkClaimHash?: string;
}

export interface RestoreStatus {
  state: 'verifying' | 'restoring' | 'starting' | 'completed' | 'failed' | 'rolled_back';
  step: string;
  updatedAt: string;
  error?: string;
  /** The export's summary once it was verified. */
  export?: ExportSummary;
}

export interface ExportSummary {
  createdAt: string;
  gatewayVersion: string;
  installationId: string;
  sourcePublicUrl: string | null;
  sourceGrpcPublicTarget: string | null;
  sourceGrpcLocalIp: string | null;
  includes: { registry: boolean; logs: boolean };
  commercial: boolean;
  parts: Array<{ name: string; bytes: number }>;
  /**
   * Set by the restore when the source was a managed cloud installation: OIDC sign-in is off and the owner sets a
   * password through the link `node dist/cli/owner-password-link.js` prints.
   */
  ownerSignIn?: 'password-link';
  /** Set with ownerSignIn: the license stayed with the cloud installation; the copy starts on Community. */
  license?: 'stayed-with-cloud';
}

export interface RestoreOptions {
  archivePath: string;
  passphrase: string;
  /** The install directory as this process sees it (holds .env and docker-compose.yml). */
  hostDir: string;
  /** The same directory as the Docker host sees it, for the Compose helper. */
  hostPath: string;
  project: string;
  helperImage: string;
  composeCliImage: string;
  address: RestoreAddress;
  /** Recreate the services at the end (the setup wizard); the installer starts them itself. */
  start: boolean;
  /** Restore over an installation whose setup is complete. */
  replaceConfigured?: boolean;
  /**
   * The archive was uploaded into gateway_data (setup wizard): the target is a fresh installation,
   * so gateway_data is not copied for a rollback (a rollback empties it, keeping the upload).
   */
  archiveInGatewayData?: boolean;
  /** Where to report progress (the wizard reads it). */
  statusFile?: string;
  /** SHA-256 hex of the wizard browser's owner-link claim (see RestoredMarker.ownerLinkClaimHash). */
  ownerLinkClaimHash?: string;
  current: { gatewayVersion: string; schemaMigration: string };
  log?: (line: string) => void;
}

export class RestoreError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = 'RestoreError';
  }
}

async function writeStatus(options: RestoreOptions, status: Omit<RestoreStatus, 'updatedAt'>) {
  options.log?.(`${status.state}: ${status.step}${status.error ? ` (${status.error})` : ''}`);
  if (!options.statusFile) return;
  const temporary = `${options.statusFile}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...status, updatedAt: new Date().toISOString() }), { mode: 0o600 });
  await rename(temporary, options.statusFile);
}

function archiveStream(path: string): Readable {
  return createReadStream(path, { highWaterMark: 1024 * 1024 });
}

export async function inspectExportFile(path: string): Promise<ExportHeader> {
  return readExportHeader(archiveStream(path));
}

/**
 * Decrypts the whole file once and checks every frame, the part list and the manifest. Returns the
 * manifest and the environment; throws ExportArchiveError (wrong passphrase, damaged, truncated) or
 * RestoreError (version mismatch, invalid manifest).
 */
export async function verifyExport(
  path: string,
  passphrase: string,
  current: { gatewayVersion: string; schemaMigration: string },
  onProgress?: (bytes: number) => void
): Promise<{
  header: ExportHeader;
  manifest: ConfigurationExportManifest;
  environment: Partial<Record<PortableEnvKey, string>>;
  summary: ExportSummary;
}> {
  const input = archiveStream(path);
  let read = 0;
  input.on('data', (chunk) => {
    read += chunk.length;
    onProgress?.(read);
  });
  const archive = await openExportArchive(input, passphrase);
  const mismatch = versionMismatch(archive.header, current);
  if (mismatch) {
    input.destroy();
    throw new RestoreError(mismatch, 'VERSION_MISMATCH');
  }
  let manifest: ConfigurationExportManifest | null = null;
  let environment: Partial<Record<PortableEnvKey, string>> | null = null;
  const parts: Array<{ name: string; bytes: number }> = [];
  for await (const part of archive.parts()) {
    if (part.name === MANIFEST_PART) {
      manifest = await readJsonPart<ConfigurationExportManifest>(part);
      validateManifest(manifest, archive.header);
      parts.push({ name: part.name, bytes: 0 });
      continue;
    }
    if (part.name === ENVIRONMENT_PART) {
      try {
        environment = parsePortableEnvironment(await readJsonPart(part));
      } catch (error) {
        throw new RestoreError((error as Error).message, 'INVALID_EXPORT');
      }
      parts.push({ name: part.name, bytes: 0 });
      continue;
    }
    let bytes = 0;
    for await (const chunk of part.stream) bytes += (chunk as Buffer).length;
    parts.push({ name: part.name, bytes });
  }
  if (!manifest || !environment) throw new RestoreError('The export has no manifest or environment', 'INVALID_EXPORT');
  const expected = [
    manifest.database.part,
    ...manifest.volumes.map((volume) => volume.part),
    ...(manifest.commercial ? [manifest.commercial.part] : []),
  ];
  for (const name of expected) {
    if (!parts.some((part) => part.name === name)) {
      throw new RestoreError(`The export misses its part ${name}`, 'INVALID_EXPORT');
    }
  }
  return {
    header: archive.header,
    manifest,
    environment,
    summary: {
      createdAt: manifest.createdAt,
      gatewayVersion: manifest.gatewayVersion,
      installationId: manifest.installationId,
      sourcePublicUrl: manifest.source.publicUrl,
      sourceGrpcPublicTarget: manifest.source.grpcPublicTarget,
      sourceGrpcLocalIp: manifest.source.grpcLocalIp,
      includes: manifest.includes,
      commercial: Boolean(manifest.commercial),
      parts,
    },
  };
}

const SAFE_NAME = /^[a-zA-Z0-9._-]+$/;

function validateManifest(manifest: ConfigurationExportManifest, header: ExportHeader): void {
  const invalid = (detail: string) => new RestoreError(`The export manifest is invalid: ${detail}`, 'INVALID_EXPORT');
  if (!manifest || manifest.format !== CONFIGURATION_EXPORT_FORMAT) throw invalid('unknown format');
  if (manifest.gatewayVersion !== header.gatewayVersion || manifest.schemaMigration !== header.schemaMigration) {
    throw invalid('the version does not match the file header');
  }
  if (!manifest.database || !SAFE_NAME.test(manifest.database.file)) throw invalid('database');
  const keys = new Set(TRANSFER_VOLUMES.map((volume) => volume.key));
  for (const volume of manifest.volumes ?? []) {
    if (!keys.has(volume.key) || !SAFE_NAME.test(volume.root) || volume.root === '.' || volume.root === '..') {
      throw invalid(`volume ${String(volume.key)}`);
    }
  }
  if (manifest.commercial && (manifest.commercial.root !== 'commercial' || !manifest.commercialDir)) {
    throw invalid('commercial core');
  }
  if (manifest.commercialDir && !/^\/var\/lib\/gateway\/commercial\/[a-zA-Z0-9._/-]+$/.test(manifest.commercialDir)) {
    throw invalid('commercial core directory');
  }
}

function normalizeAddress(address: RestoreAddress): RestoreAddress {
  const result: RestoreAddress = {};
  try {
    if (address.publicUrl) result.publicUrl = normalizePublicUrl(address.publicUrl);
    if (address.grpcPublicTarget) result.grpcPublicTarget = normalizeHostPortTarget(address.grpcPublicTarget);
    if (address.grpcLocalIp !== undefined) result.grpcLocalIp = address.grpcLocalIp || null;
  } catch (error) {
    throw new RestoreError((error as Error).message, 'INVALID_ADDRESS');
  }
  return result;
}

/** A tar stream with one regular file (ustar), for small files written into volumes. */
export function singleFileTar(name: string, content: Buffer, mode = 0o600): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error('Tar entry name too long');
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'utf8');
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write(
    `${Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, '0')}\0`,
    136,
    12,
    'ascii'
  );
  header.write('        ', 148, 8, 'ascii');
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512, 0);
  return Buffer.concat([header, content, padding, Buffer.alloc(1024, 0)]);
}

async function isSetupComplete(docker: DockerService, installation: ComposeInstallation): Promise<boolean> {
  const result = await docker.execInContainer(installation.postgres, [
    'psql',
    '-X',
    '-At',
    '-U',
    'gateway',
    '-d',
    'gateway',
    '-c',
    "SELECT count(*) FROM settings WHERE key = 'setup:completed_at'",
  ]);
  // A database without the settings table (never migrated) counts as fresh.
  return result.exitCode === 0 && result.output.trim().split('\n').at(-1) === '1';
}

async function extractTarInto(stream: Readable, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const child = spawn('tar', ['-x', '-p', '-f', '-', '-C', directory], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
  await pipeline(stream, child.stdin);
  const code = await exited;
  if (code !== 0) throw new Error(`Extracting into ${directory} failed: ${stderr.trim()}`);
}

interface Rollback {
  database: boolean;
  volumes: Array<{ key: TransferVolumeKey; volume: string; file: string | null }>;
  files: Array<{ path: string; backup: string | null }>;
  commercial: { path: string; backup: string | null } | null;
  stopped: string[];
}

async function backupFile(path: string, backupDir: string, rollback: Rollback): Promise<void> {
  if (rollback.files.some((file) => file.path === path)) return;
  try {
    await stat(path);
  } catch {
    rollback.files.push({ path, backup: null });
    return;
  }
  const backup = join(backupDir, path.split('/').at(-1)!);
  await copyFile(path, backup);
  rollback.files.push({ path, backup });
}

/** Restores an export. Resolves when the installation holds the export (and was restarted when `start`). */
export async function restoreExport(docker: DockerService, options: RestoreOptions): Promise<ExportSummary> {
  const address = normalizeAddress(options.address);
  await writeStatus(options, { state: 'verifying', step: 'Checking the export' });
  const verified = await verifyExport(options.archivePath, options.passphrase, options.current);
  const { manifest, environment, summary } = verified;
  await writeStatus(options, { state: 'verifying', step: 'The export is complete and unchanged', export: summary });

  const installation = await findInstallation(docker, options.project, options.helperImage);
  if (!options.replaceConfigured && (await isSetupComplete(docker, installation))) {
    throw new RestoreError(
      'This installation is already set up. A restore replaces everything in it: restore into a fresh installation, or pass --replace-existing.',
      'INSTALLATION_CONFIGURED'
    );
  }
  await removeLeftoverHelpers(docker, options.project);

  const workDir = join(options.hostDir, '.opfield-restore');
  const backupDir = join(workDir, `backup-${Date.now()}`);
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const rollback: Rollback = { database: false, volumes: [], files: [], commercial: null, stopped: [] };

  const step = (text: string) => writeStatus(options, { state: 'restoring', step: text, export: summary });
  try {
    // Nothing may write to the database or the volumes while they are replaced.
    for (const id of [installation.app, installation.relay, installation.registry, installation.clickhouse?.id]) {
      if (!id) continue;
      const details = await docker.inspectContainerDetails(id);
      if (details?.State.Running) {
        await step('Stopping Opfield services');
        await docker.stopContainer(id, 60);
        rollback.stopped.push(id);
      }
    }

    await step('Keeping a copy of the current database');
    await snapshotDatabaseForRollback(docker, installation);
    rollback.database = true;

    const volumeName = (key: TransferVolumeKey) => composeVolumeName(options.project, key);
    const replaced: TransferVolumeKey[] = [...manifest.volumes.map((volume) => volume.key), 'gateway_relay_state'];
    for (const key of replaced) {
      const volume = volumeName(key);
      if (!(await docker.inspectVolume(volume)) || (key === 'gateway_data' && options.archiveInGatewayData)) {
        rollback.volumes.push({ key, volume, file: null });
        continue;
      }
      const file = join(backupDir, `${volume}.tar`);
      const transfer = await openVolumeArchive(docker, installation, volume, key);
      try {
        await pipeline(transfer.stream, createWriteStream(file, { mode: 0o600 }));
      } finally {
        await transfer.close();
      }
      rollback.volumes.push({ key, volume, file });
    }

    const archive = await openExportArchive(archiveStream(options.archivePath), options.passphrase);
    for await (const part of archive.parts()) {
      if (part.name === manifest.database.part) {
        await step('Restoring the database');
        await restoreDatabase(docker, installation, part.stream, manifest.database.file);
        // The copy is not the installation the cloud account linked (or manages); a managed source's owner gets a
        // password instead of the cloud's sign-in.
        if (await detachManagedSignIn(docker, installation)) {
          summary.ownerSignIn = 'password-link';
          summary.license = 'stayed-with-cloud';
        }
        await forgetCloudLink(docker, installation);
        continue;
      }
      const volume = manifest.volumes.find((entry) => entry.part === part.name);
      if (volume) {
        await step(`Restoring ${TRANSFER_VOLUMES.find((spec) => spec.key === volume.key)?.description ?? volume.key}`);
        await restoreVolume(
          docker,
          installation,
          volume.key,
          volumeName(volume.key),
          volume.root,
          part.stream,
          volume.key === 'gateway_data' ? [RESTORE_STAGING_DIR] : []
        );
        continue;
      }
      if (manifest.commercial && part.name === manifest.commercial.part) {
        await step('Restoring the commercial core');
        const target = join(options.hostDir, '.gateway-commercial');
        const extractDir = join(workDir, 'commercial-extract');
        await rm(extractDir, { recursive: true, force: true });
        await extractTarInto(part.stream, extractDir);
        let backup: string | null = null;
        try {
          await stat(target);
          backup = join(backupDir, 'gateway-commercial');
          await rename(target, backup);
        } catch {
          backup = null;
        }
        rollback.commercial = { path: target, backup };
        await rename(join(extractDir, manifest.commercial.root), target);
        await rm(extractDir, { recursive: true, force: true });
        continue;
      }
      await part.skip();
    }

    await step('Clearing the local relay state');
    await wipeVolume(docker, installation, volumeName('gateway_relay_state'));

    await step('Writing the master key and settings to .env');
    const envPath = join(options.hostDir, '.env');
    const composePath = join(options.hostDir, 'docker-compose.yml');
    await backupFile(envPath, backupDir, rollback);
    await backupFile(composePath, backupDir, rollback);
    const envValues: Record<string, string> = { ...(environment as Record<string, string>) };
    if (manifest.commercialDir) envValues.GATEWAY_COMMERCIAL_DIR = manifest.commercialDir;
    const envContent = await readFile(envPath, 'utf8');
    await writeAtomic(envPath, patchEnv(envContent, envValues).content);
    if (manifest.commercial) {
      const composeContent = await readFile(composePath, 'utf8');
      await writeAtomic(composePath, patchCompose(composeContent, true));
    }

    await step('Recording the restore for the next start');
    const marker: RestoredMarker = {
      restoredAt: new Date().toISOString(),
      exportCreatedAt: manifest.createdAt,
      gatewayVersion: manifest.gatewayVersion,
      installationId: manifest.installationId,
      sourcePublicUrl: manifest.source.publicUrl,
      sourceGrpcPublicTarget: manifest.source.grpcPublicTarget,
      includes: manifest.includes,
      address,
      ...(summary.ownerSignIn ? { ownerSignIn: summary.ownerSignIn } : {}),
      ...(summary.license ? { license: summary.license } : {}),
      ...(summary.ownerSignIn && options.ownerLinkClaimHash ? { ownerLinkClaimHash: options.ownerLinkClaimHash } : {}),
    };
    await writeMarker(docker, installation, volumeName('gateway_data'), marker);
    await flushRedis(docker, installation);
    await dropDatabaseRollback(docker, installation);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeStatus(options, {
      state: 'restoring',
      step: 'Putting the previous state back',
      error: message,
      export: summary,
    });
    const rollbackError = await undo(docker, installation, rollback).catch((undoError: unknown) => undoError as Error);
    await writeStatus(options, {
      state: rollbackError ? 'failed' : 'rolled_back',
      step: rollbackError
        ? `The restore failed and putting the previous state back failed too: ${rollbackError.message}`
        : 'The restore failed; the installation is as it was before',
      error: message,
      export: summary,
    });
    throw error;
  }

  await rm(workDir, { recursive: true, force: true }).catch(() => {});
  if (options.start) {
    await writeStatus(options, { state: 'starting', step: 'Starting Opfield', export: summary });
    await composeUp(docker, options);
  }
  await writeStatus(options, { state: 'completed', step: 'Restored', export: summary });
  return summary;
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.opfield-restore.tmp`;
  const mode = (await stat(path).catch(() => null))?.mode ?? 0o600;
  await writeFile(temporary, content, { mode: mode & 0o777 });
  await rename(temporary, path);
}

async function writeMarker(
  docker: DockerService,
  installation: ComposeInstallation,
  volume: string,
  marker: RestoredMarker
): Promise<void> {
  const helper = await docker.createContainer({
    Image: installation.helperImage,
    Cmd: ['true'],
    Labels: { 'com.wiolett.gateway.configuration-transfer': installation.project },
    HostConfig: { Binds: [`${volume}:/opfield-transfer/gateway_data`], NetworkMode: 'none' },
  });
  try {
    const tar = Buffer.concat([
      directoryTarEntry(`gateway_data/${RESTORE_STAGING_DIR}/`),
      singleFileTar(`gateway_data/${RESTORE_STAGING_DIR}/${RESTORED_MARKER_FILE}`, Buffer.from(JSON.stringify(marker))),
    ]);
    await docker.putContainerArchiveStream(helper, '/opfield-transfer', Readable.from([tar]));
  } finally {
    await docker.removeContainer(helper).catch(() => {});
  }
}

/** A ustar directory entry without the end-of-archive blocks. */
function directoryTarEntry(name: string): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'utf8');
  header.write('0000700\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write('00000000000\0', 124, 12, 'ascii');
  header.write(
    `${Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, '0')}\0`,
    136,
    12,
    'ascii'
  );
  header.write('        ', 148, 8, 'ascii');
  header.write('5', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

async function undo(docker: DockerService, installation: ComposeInstallation, rollback: Rollback): Promise<void> {
  const failures: string[] = [];
  const attempt = async (what: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      failures.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  if (rollback.database) {
    await attempt('database', async () => {
      await rollbackDatabase(docker, installation);
      await dropDatabaseRollback(docker, installation);
    });
  }
  for (const entry of rollback.volumes) {
    await attempt(`volume ${entry.volume}`, async () => {
      if (!entry.file) {
        if (await docker.inspectVolume(entry.volume)) {
          await wipeVolume(
            docker,
            installation,
            entry.volume,
            entry.key === 'gateway_data' ? [RESTORE_STAGING_DIR] : []
          );
        }
        return;
      }
      await restoreVolume(docker, installation, entry.key, entry.volume, entry.key, createReadStream(entry.file), [
        RESTORE_STAGING_DIR,
      ]);
    });
  }
  for (const file of rollback.files) {
    await attempt(file.path, async () => {
      if (file.backup) await copyFile(file.backup, file.path);
      else await rm(file.path, { force: true });
    });
  }
  if (rollback.commercial) {
    const { path, backup } = rollback.commercial;
    await attempt('commercial core', async () => {
      await rm(path, { recursive: true, force: true });
      if (backup) await rename(backup, path);
    });
  }
  for (const id of rollback.stopped) {
    await attempt(`starting ${id.slice(0, 12)}`, () => docker.startContainer(id));
  }
  if (failures.length > 0) throw new Error(failures.join('; '));
}

/** Recreates every service with the restored .env (the master key is read at container creation). */
async function composeUp(docker: DockerService, options: RestoreOptions): Promise<void> {
  if (!/^\/[a-zA-Z0-9/_.-]+$/.test(options.hostPath)) throw new Error(`Invalid install directory ${options.hostPath}`);
  const result = await docker.runOneShot({
    Image: options.composeCliImage,
    Cmd: [
      'docker',
      'compose',
      '--project-name',
      options.project,
      '--project-directory',
      options.hostPath,
      '-f',
      `${options.hostPath}/docker-compose.yml`,
      'up',
      '-d',
      '--force-recreate',
    ],
    HostConfig: { Binds: [`${options.hostPath}:${options.hostPath}`, '/var/run/docker.sock:/var/run/docker.sock'] },
  });
  if (result.exitCode !== 0) throw new Error(`Starting Opfield failed: ${result.output.trim().slice(-2000)}`);
}

/** The message a person reads for a failed restore. */
export function restoreErrorMessage(error: unknown): { code: string; message: string } {
  if (error instanceof ExportArchiveError || error instanceof RestoreError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'RESTORE_FAILED', message: error instanceof Error ? error.message : String(error) };
}
