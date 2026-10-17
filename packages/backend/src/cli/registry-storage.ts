import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pruneBackupDirectories, REGISTRY_STORAGE_BACKUP } from '@/foundation/backup-retention.js';
import { patchComposeRegistryStorage, writeFileAtomic } from '@/foundation/foundation-migrator.js';
import { FOUNDATION_BACKUPS_DIR } from '@/foundation/opfield-names.js';
import {
  applyRegistryStorageEnv,
  type RegistryS3Settings,
  registryStorageBackendFromCompose,
  registryStorageBackendFromEnv,
} from '@/foundation/registry-storage.js';
import {
  copyBucketToVolume,
  copyVolumeToBucket,
  removeImportLeftovers,
} from '@/modules/docker/registry-storage/registry-storage-copy.js';
import { RegistryS3Client } from '@/modules/docker/registry-storage/s3-client.js';

/**
 * The host side of the internal registry storage switch. Runs in a one-off container of the running Opfield image:
 *
 *   apply   --host-dir /host --backup NAME     writes the storage of OPFIELD_REGISTRY_STORAGE_TARGET into .env and
 *                                              docker-compose.yml, after copying both into backup folder NAME
 *   restore --host-dir /host --backup NAME     puts the files of that backup folder back (those it holds)
 *   status  --host-dir /host                   the storage .env selects and the one the registry block runs on
 *   sync-compose --host-dir /host              makes the registry block follow the storage .env selects
 *   clean-import   --volume /var/lib/registry  removes what an interrupted copy onto the volume left
 *   copy-to-bucket --volume /var/lib/registry  copies the registry volume into the bucket of OPFIELD_REGISTRY_STORAGE_S3
 *   copy-to-volume --volume /var/lib/registry  copies that bucket's registry data onto the volume
 *   clear-volume   --volume /var/lib/registry  removes the registry data from the volume once the bucket holds it
 *
 * Settings come in the environment, never in arguments. The last stdout line is a JSON result.
 */

const BACKUP_NAME = /^registry-storage-[0-9TZ-]+$/;

function s3SettingsFromEnv(name: string): RegistryS3Settings {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is not set`);
  const parsed = JSON.parse(raw) as RegistryS3Settings;
  if (!parsed.bucket || !parsed.region || !parsed.accessKeyId || !parsed.secretAccessKey) {
    throw new Error(`${name} is incomplete`);
  }
  return parsed;
}

function targetFromEnv(): RegistryS3Settings | null {
  const raw = process.env.OPFIELD_REGISTRY_STORAGE_TARGET;
  if (!raw) throw new Error('OPFIELD_REGISTRY_STORAGE_TARGET is not set');
  const parsed = JSON.parse(raw) as { backend: 'filesystem' | 's3' };
  if (parsed.backend === 'filesystem') return null;
  if (parsed.backend !== 's3') throw new Error('OPFIELD_REGISTRY_STORAGE_TARGET names an unknown storage');
  return s3SettingsFromEnv('OPFIELD_REGISTRY_STORAGE_S3');
}

async function apply(hostDir: string, backup: string): Promise<{ backup: string }> {
  if (!BACKUP_NAME.test(backup)) throw new Error('The backup name is invalid');
  const target = targetFromEnv();
  const envPath = path.join(hostDir, '.env');
  const composePath = path.join(hostDir, 'docker-compose.yml');
  const envContent = await fs.readFile(envPath, 'utf8');
  const composeContent = await fs.readFile(composePath, 'utf8');
  const nextEnv = applyRegistryStorageEnv(envContent, target);
  const nextCompose = patchComposeRegistryStorage(composeContent, target ? 's3' : 'filesystem');
  const backupDir = path.join(hostDir, FOUNDATION_BACKUPS_DIR, backup);
  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
  await fs.copyFile(envPath, path.join(backupDir, '.env'));
  await fs.copyFile(composePath, path.join(backupDir, 'docker-compose.yml'));
  // Earlier switches' backups (each with the .env of its time, S3 keys included): the newest three stay.
  await pruneBackupDirectories(path.dirname(backupDir), (name) => REGISTRY_STORAGE_BACKUP.test(name), {
    keep: 3,
    maxAgeDays: 0,
  });
  try {
    await writeFileAtomic(envPath, nextEnv);
    await writeFileAtomic(composePath, nextCompose);
  } catch (error) {
    await restore(hostDir, backup);
    throw error;
  }
  return { backup };
}

async function restore(hostDir: string, backup: string): Promise<{ restored: string }> {
  if (!BACKUP_NAME.test(backup)) throw new Error('The backup name is invalid');
  const backupDir = path.join(hostDir, FOUNDATION_BACKUPS_DIR, backup);
  // apply copies both files before it writes either: a file missing here was never changed.
  const restored: string[] = [];
  for (const file of ['.env', 'docker-compose.yml']) {
    const content = await fs.readFile(path.join(backupDir, file), 'utf8').catch(() => null);
    if (content === null) continue;
    await writeFileAtomic(path.join(hostDir, file), content);
    restored.push(file);
  }
  return { restored: restored.join(',') };
}

async function hostStatus(hostDir: string) {
  const env = await fs.readFile(path.join(hostDir, '.env'), 'utf8');
  const compose = await fs.readFile(path.join(hostDir, 'docker-compose.yml'), 'utf8');
  return {
    env: registryStorageBackendFromEnv(env),
    compose: registryStorageBackendFromCompose(compose.replace(/\r\n/g, '\n').split('\n')),
  };
}

async function syncCompose(hostDir: string) {
  const composePath = path.join(hostDir, 'docker-compose.yml');
  const env = await fs.readFile(path.join(hostDir, '.env'), 'utf8');
  const compose = await fs.readFile(composePath, 'utf8');
  const next = patchComposeRegistryStorage(compose, registryStorageBackendFromEnv(env));
  if (next !== compose) await writeFileAtomic(composePath, next);
  return { changed: next !== compose };
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'host-dir': { type: 'string', default: '/host' },
      volume: { type: 'string', default: '/var/lib/registry' },
      backup: { type: 'string' },
    },
  });
  const [command] = positionals;
  const log = (line: string) => process.stderr.write(`${line}\n`);
  let result: unknown;
  if (command === 'apply') result = await apply(values['host-dir']!, values.backup ?? '');
  else if (command === 'status') result = await hostStatus(values['host-dir']!);
  else if (command === 'sync-compose') result = await syncCompose(values['host-dir']!);
  else if (command === 'clean-import') {
    await removeImportLeftovers(values.volume!);
    result = { cleaned: true };
  } else if (command === 'restore') result = await restore(values['host-dir']!, values.backup ?? '');
  else if (command === 'clear-volume') {
    await fs.rm(path.join(values.volume!, 'docker'), { recursive: true, force: true });
    result = { cleared: true };
  } else if (command === 'copy-to-bucket' || command === 'copy-to-volume') {
    const settings = s3SettingsFromEnv('OPFIELD_REGISTRY_STORAGE_S3');
    const client = new RegistryS3Client(settings);
    result =
      command === 'copy-to-bucket'
        ? await copyVolumeToBucket(values.volume!, client, settings.rootDirectory, log)
        : await copyBucketToVolume(values.volume!, client, settings.rootDirectory, log);
  } else {
    throw new Error(
      'Usage: registry-storage.js apply|restore|status|sync-compose|copy-to-bucket|copy-to-volume|clear-volume|clean-import'
    );
  }
  process.stdout.write(`${JSON.stringify({ ok: true, ...(result as object) })}\n`);
}

main().catch((error) => {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`
  );
  process.exit(1);
});
