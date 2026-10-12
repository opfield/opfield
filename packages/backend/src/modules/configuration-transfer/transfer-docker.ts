import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { DockerService } from '@/services/docker.service.js';
import { composeVolumeName, DATABASE_DUMP_FILE, type TransferVolumeKey } from './transfer-layout.js';

/**
 * Docker operations of a configuration export and restore. Everything goes through the Docker API
 * of the host: the database through pg_dump/pg_restore in the Compose postgres container, volumes
 * through helper containers that only mount them (Docker's archive API reads and writes their files,
 * keeping owners and modes).
 */

const HELPER_LABEL = 'com.wiolett.gateway.configuration-transfer';
const MOUNT_BASE = '/opfield-transfer';
const CLICKHOUSE_SNAPSHOT_DIR = '.opfield-export-snapshot';

export interface ComposeInstallation {
  project: string;
  /** Image ID the helpers run (the Opfield image: it has a shell and busybox tools). */
  helperImage: string;
  app: string | null;
  relay: string | null;
  registry: string | null;
  postgres: string;
  redis: string | null;
  clickhouse: { id: string; running: boolean; volume: string } | null;
}

function serviceOf(labels: Record<string, string> | undefined): string | undefined {
  return labels?.['com.docker.compose.service'];
}

/** The containers of one Compose installation, found by their Compose and Opfield labels. */
export async function findInstallation(
  docker: DockerService,
  project: string,
  helperImage: string
): Promise<ComposeInstallation> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(project)) throw new Error(`Invalid Compose project name: ${project}`);
  const containers = await docker.listContainersByLabel(`com.docker.compose.project=${project}`);
  const byService = (service: string) =>
    containers.find((container) => serviceOf(container.Labels) === service && container.State !== 'removing') ?? null;
  const postgres = byService('postgres');
  if (!postgres) throw new Error(`The postgres service of the Compose project ${project} was not found`);
  const managedClickHouse = (await docker.listContainersByLabel('net.wiolett.gateway.managed=clickhouse')).find(
    (container) => container.Labels?.['net.wiolett.gateway.owner'] === project
  );
  return {
    project,
    helperImage,
    app: byService('app')?.Id ?? null,
    relay: byService('relay')?.Id ?? null,
    registry: byService('registry')?.Id ?? null,
    postgres: postgres.Id,
    redis: byService('redis')?.Id ?? null,
    clickhouse: managedClickHouse
      ? {
          id: managedClickHouse.Id,
          running: managedClickHouse.State === 'running',
          volume: composeVolumeName(project, 'clickhouse_data'),
        }
      : null,
  };
}

async function execChecked(docker: DockerService, containerId: string, command: string[], what: string) {
  const result = await docker.execInContainer(containerId, command);
  if (result.exitCode !== 0) {
    throw new Error(`${what} failed (exit ${result.exitCode}): ${result.output.trim().slice(-2000)}`);
  }
  return result.output;
}

async function createHelper(
  docker: DockerService,
  installation: Pick<ComposeInstallation, 'helperImage' | 'project'>,
  binds: string[],
  command: string[] = ['true']
): Promise<string> {
  return docker.createContainer(
    {
      Image: installation.helperImage,
      Cmd: command,
      Labels: { [HELPER_LABEL]: installation.project },
      HostConfig: { Binds: binds, NetworkMode: 'none' },
    },
    `${installation.project}-transfer-${randomBytes(4).toString('hex')}`
  );
}

/** Removes helpers a crashed export or restore left behind. */
export async function removeLeftoverHelpers(docker: DockerService, project: string): Promise<void> {
  for (const helper of await docker.listContainersByLabel(`${HELPER_LABEL}=${project}`)) {
    await docker.removeContainer(helper.Id).catch(() => {});
  }
}

/** Opens a tar stream of the wrapped content; `close` removes what the stream needed. */
export interface TransferStream {
  stream: Readable;
  /** Name of the top directory (or file) in the tar stream. */
  root: string;
  close(): Promise<void>;
}

function closeOnce(close: () => Promise<void>): () => Promise<void> {
  let closing: Promise<void> | null = null;
  return () => {
    closing ??= close().catch(() => {});
    return closing;
  };
}

/** The database as a custom-format pg_dump (with --create), in a tar stream with one file. */
export async function openDatabaseDump(
  docker: DockerService,
  installation: ComposeInstallation
): Promise<TransferStream> {
  const path = `/tmp/${DATABASE_DUMP_FILE}`;
  const close = closeOnce(async () => {
    await docker.execInContainer(installation.postgres, ['rm', '-f', path]);
  });
  try {
    // A consistent snapshot of the running database; nothing stops.
    await execChecked(
      docker,
      installation.postgres,
      [
        'sh',
        '-c',
        `umask 077 && rm -f ${path} && pg_dump --format=custom --create --no-password -U gateway -d gateway -f ${path} && pg_restore --list ${path} >/dev/null`,
      ],
      'Database dump'
    );
    const stream = await docker.openContainerArchive(installation.postgres, path);
    stream.once('close', () => void close());
    return { stream, root: DATABASE_DUMP_FILE, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Size of the gateway database in bytes. */
export async function databaseSize(docker: DockerService, installation: ComposeInstallation): Promise<number> {
  const output = await execChecked(
    docker,
    installation.postgres,
    ['psql', '-X', '-At', '-U', 'gateway', '-d', 'gateway', '-c', "SELECT pg_database_size('gateway')"],
    'Database size'
  );
  const bytes = Number(output.trim().split('\n').at(-1));
  return Number.isSafeInteger(bytes) ? bytes : 0;
}

/** Bytes a volume holds, measured by a helper. */
export async function volumeSize(
  docker: DockerService,
  installation: Pick<ComposeInstallation, 'helperImage' | 'project'>,
  volume: string
): Promise<number | null> {
  if (!(await docker.inspectVolume(volume))) return null;
  const result = await docker.runOneShot({
    Image: installation.helperImage,
    Cmd: ['sh', '-c', 'du -sk /measure | cut -f1'],
    Labels: { [HELPER_LABEL]: installation.project },
    HostConfig: { Binds: [`${volume}:/measure:ro`], NetworkMode: 'none' },
  });
  const kibibytes = Number(result.output.trim().split('\n').at(-1));
  return result.exitCode === 0 && Number.isSafeInteger(kibibytes) ? kibibytes * 1024 : null;
}

/** A whole volume as a tar stream rooted at `key`. */
export async function openVolumeArchive(
  docker: DockerService,
  installation: Pick<ComposeInstallation, 'helperImage' | 'project'>,
  volume: string,
  key: TransferVolumeKey
): Promise<TransferStream> {
  const helper = await createHelper(docker, installation, [`${volume}:${MOUNT_BASE}/${key}:ro`]);
  const close = closeOnce(() => docker.removeContainer(helper));
  try {
    const stream = await docker.openContainerArchive(helper, `${MOUNT_BASE}/${key}`);
    stream.once('close', () => void close());
    return { stream, root: key, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * The managed ClickHouse volume at one instant. ClickHouse is paused only while its files are
 * hard-linked into a snapshot directory on the same volume (seconds); the snapshot is then read
 * while ClickHouse runs, and removed afterwards. Data parts never change in place, so the links
 * keep the paused state.
 */
export async function openClickHouseSnapshot(
  docker: DockerService,
  installation: ComposeInstallation
): Promise<TransferStream> {
  const clickhouse = installation.clickhouse;
  if (!clickhouse) throw new Error('Opfield-managed ClickHouse was not found');
  const helper = await createHelper(
    docker,
    installation,
    [`${clickhouse.volume}:${MOUNT_BASE}/clickhouse`],
    ['sleep', '86400']
  );
  const snapshot = `${MOUNT_BASE}/clickhouse/${CLICKHOUSE_SNAPSHOT_DIR}`;
  const close = closeOnce(async () => {
    await docker.execInContainer(helper, ['rm', '-rf', snapshot]).catch(() => {});
    await docker.removeContainer(helper);
  });
  try {
    await docker.startContainer(helper);
    await execChecked(docker, helper, ['rm', '-rf', snapshot], 'Old log snapshot cleanup');
    let paused = false;
    try {
      if (clickhouse.running) {
        await docker.pauseContainer(clickhouse.id);
        paused = true;
      }
      await execChecked(
        docker,
        helper,
        [
          'sh',
          '-c',
          `set -e; cd ${MOUNT_BASE}/clickhouse; mkdir ${CLICKHOUSE_SNAPSHOT_DIR}; for entry in * .[!.]*; do [ -e "$entry" ] || continue; [ "$entry" = ${CLICKHOUSE_SNAPSHOT_DIR} ] && continue; cp -al "$entry" ${CLICKHOUSE_SNAPSHOT_DIR}/; done`,
        ],
        'Log snapshot'
      );
    } finally {
      if (paused) await docker.unpauseContainer(clickhouse.id);
    }
    const stream = await docker.openContainerArchive(helper, snapshot);
    stream.once('close', () => void close());
    return { stream, root: CLICKHOUSE_SNAPSHOT_DIR, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** The commercial core directory the app has mounted, as a tar stream rooted at `commercial`. */
export async function openCommercialArchive(docker: DockerService, appContainer: string): Promise<TransferStream> {
  const stream = await docker.openContainerArchive(appContainer, '/var/lib/gateway/commercial');
  return { stream, root: 'commercial', close: async () => {} };
}

// ── Restore ─────────────────────────────────────────────────────────

async function ensureVolume(docker: DockerService, project: string, volume: string, key: TransferVolumeKey) {
  if (await docker.inspectVolume(volume)) return;
  // Compose adopts a volume carrying its project and volume labels; the ClickHouse volume is the app's own.
  await docker.createVolume(
    volume,
    key === 'clickhouse_data' ? {} : { 'com.docker.compose.project': project, 'com.docker.compose.volume': key }
  );
}

/** Empties a volume, keeping the top-level entries named in `keep`. */
export async function wipeVolume(
  docker: DockerService,
  installation: Pick<ComposeInstallation, 'helperImage' | 'project'>,
  volume: string,
  keep: string[] = []
): Promise<void> {
  for (const name of keep) if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error(`Invalid entry name ${name}`);
  const keepTests = keep.map((name) => `! -name ${name}`).join(' ');
  const result = await docker.runOneShot({
    Image: installation.helperImage,
    Cmd: ['sh', '-c', `find /target -mindepth 1 -maxdepth 1 ${keepTests} -exec rm -rf {} +`],
    Labels: { [HELPER_LABEL]: installation.project },
    HostConfig: { Binds: [`${volume}:/target`], NetworkMode: 'none' },
  });
  if (result.exitCode !== 0) throw new Error(`Emptying volume ${volume} failed: ${result.output.trim().slice(-2000)}`);
}

/**
 * Replaces a volume's content with a tar stream rooted at `root` (as an export wrote it). The volume
 * is created when it does not exist yet and emptied first (except `keep`).
 */
export async function restoreVolume(
  docker: DockerService,
  installation: Pick<ComposeInstallation, 'helperImage' | 'project'>,
  key: TransferVolumeKey,
  volume: string,
  root: string,
  content: Readable,
  keep: string[] = []
): Promise<void> {
  if (!/^[a-zA-Z0-9._-]+$/.test(root) || root === '.' || root === '..') throw new Error(`Invalid volume root ${root}`);
  await ensureVolume(docker, installation.project, volume, key);
  await wipeVolume(docker, installation, volume, keep);
  const helper = await createHelper(docker, installation, [`${volume}:${MOUNT_BASE}/${root}`]);
  try {
    await docker.putContainerArchiveStream(helper, MOUNT_BASE, content);
  } finally {
    await docker.removeContainer(helper).catch(() => {});
  }
}

const ROLLBACK_DUMP = '/tmp/opfield-restore-previous.dump';

/** Keeps the current database inside the postgres container until the restore succeeded. */
export async function snapshotDatabaseForRollback(docker: DockerService, installation: ComposeInstallation) {
  await execChecked(
    docker,
    installation.postgres,
    [
      'sh',
      '-c',
      `umask 077 && rm -f ${ROLLBACK_DUMP} && pg_dump --format=custom --create --no-password -U gateway -d gateway -f ${ROLLBACK_DUMP}`,
    ],
    'Snapshot of the current database'
  );
}

async function replaceDatabase(docker: DockerService, installation: ComposeInstallation, dumpPath: string) {
  await execChecked(
    docker,
    installation.postgres,
    [
      'psql',
      '-X',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'gateway',
      '-d',
      'postgres',
      '-c',
      'DROP DATABASE IF EXISTS gateway WITH (FORCE)',
    ],
    'Dropping the current database'
  );
  await execChecked(
    docker,
    installation.postgres,
    ['pg_restore', '--create', '--exit-on-error', '--no-password', '-U', 'gateway', '-d', 'postgres', dumpPath],
    'Database restore'
  );
}

/** Replaces the gateway database with the dump in `content` (a tar with the dump file). */
export async function restoreDatabase(
  docker: DockerService,
  installation: ComposeInstallation,
  content: Readable,
  dumpFile: string
): Promise<void> {
  if (!/^[a-zA-Z0-9._-]+$/.test(dumpFile)) throw new Error('Invalid database dump name');
  const path = `/tmp/${dumpFile}`;
  await docker.execInContainer(installation.postgres, ['rm', '-f', path]);
  try {
    await docker.putContainerArchiveStream(installation.postgres, '/tmp', content);
    await execChecked(docker, installation.postgres, ['pg_restore', '--list', path], 'Reading the exported database');
    await replaceDatabase(docker, installation, path);
  } finally {
    await docker.execInContainer(installation.postgres, ['rm', '-f', path]).catch(() => {});
  }
}

/**
 * Settings a restored copy must not keep: the cloud link belongs to the installation the export was taken from (its
 * agent and secret, remote management, a disconnect notice). Kept, both would share one agent and the copy would
 * read as a managed cloud VM.
 */
export const RESTORE_FORGOTTEN_SETTINGS = [
  'cloud:enrollment',
  'cloud:remote_management',
  'cloud:disconnected',
] as const;

/** Drops {@link RESTORE_FORGOTTEN_SETTINGS} from the restored database; the export itself keeps them. */
export async function forgetCloudLink(docker: DockerService, installation: ComposeInstallation): Promise<void> {
  const keys = RESTORE_FORGOTTEN_SETTINGS.map((key) => `'${key}'`).join(', ');
  await execChecked(
    docker,
    installation.postgres,
    [
      'psql',
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'gateway',
      '-d',
      'gateway',
      '-c',
      `DELETE FROM settings WHERE key IN (${keys})`,
    ],
    'Forgetting the cloud account link'
  );
}

export async function rollbackDatabase(docker: DockerService, installation: ComposeInstallation): Promise<void> {
  await replaceDatabase(docker, installation, ROLLBACK_DUMP);
}

export async function dropDatabaseRollback(docker: DockerService, installation: ComposeInstallation): Promise<void> {
  await docker.execInContainer(installation.postgres, ['rm', '-f', ROLLBACK_DUMP]).catch(() => {});
}

/** Sign-in sessions, queues and caches of the replaced installation. */
export async function flushRedis(docker: DockerService, installation: ComposeInstallation): Promise<void> {
  if (!installation.redis) return;
  await execChecked(docker, installation.redis, ['redis-cli', 'FLUSHALL'], 'Clearing Redis');
}
