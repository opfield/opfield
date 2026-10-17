import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  isSafeDatabaseIdentifier,
  LEGACY_DATABASE,
  LEGACY_DATABASE_ROLE,
  LEGACY_MANAGED_CLICKHOUSE_LABEL,
  LEGACY_MANAGED_CLICKHOUSE_OWNER_LABEL,
  MANAGED_CLICKHOUSE_LABEL,
  MANAGED_CLICKHOUSE_OWNER_LABEL,
} from '@/foundation/opfield-names.js';
import {
  LEGACY_APP_DATA_DIR,
  LEGACY_CONFIGURATION_TRANSFER_LABEL,
  LEGACY_UPDATE_ATTEMPT_KEY,
} from '@/lib/legacy-compat.js';
import type { DockerService } from '@/services/docker.service.js';
import { composeVolumeName, DATABASE_DUMP_FILE, type TransferVolumeKey } from './transfer-layout.js';

/**
 * Docker operations of a configuration export and restore. Everything goes through the Docker API
 * of the host: the database through pg_dump/pg_restore in the Compose postgres container, volumes
 * through helper containers that only mount them (Docker's archive API reads and writes their files,
 * keeping owners and modes).
 */

const HELPER_LABEL = 'net.opfield.configuration-transfer';
// legacy-name: helpers a release before 2.12.1 left behind carry this label; only cleaned up.
const LEGACY_HELPER_LABEL = LEGACY_CONFIGURATION_TRANSFER_LABEL;
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
  /** Role and database the app uses: `opfield` in the Opfield layout, LEGACY_INSTALL_DIR_NAME in the earlier one. */
  database: { role: string; name: string };
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
  const managedClickHouse = [
    ...(await docker.listContainersByLabel(`${MANAGED_CLICKHOUSE_LABEL}=clickhouse`)),
    // legacy-name: a local ClickHouse created before 2.12.1.
    ...(await docker.listContainersByLabel(`${LEGACY_MANAGED_CLICKHOUSE_LABEL}=clickhouse`)),
  ].find(
    (container) =>
      (container.Labels?.[MANAGED_CLICKHOUSE_OWNER_LABEL] ??
        container.Labels?.[LEGACY_MANAGED_CLICKHOUSE_OWNER_LABEL]) === project
  );
  const clickHouseVolume = managedClickHouse
    ? ((await docker.inspectContainerDetails(managedClickHouse.Id))?.Mounts?.find(
        (mount) => mount.Destination === '/var/lib/clickhouse' && mount.Type === 'volume'
      )?.Name ?? composeVolumeName(project, 'clickhouse_data'))
    : null;
  return {
    project,
    helperImage,
    app: byService('app')?.Id ?? null,
    relay: byService('relay')?.Id ?? null,
    registry: byService('registry')?.Id ?? null,
    postgres: postgres.Id,
    database: await postgresIdentity(docker, postgres.Id),
    redis: byService('redis')?.Id ?? null,
    clickhouse:
      managedClickHouse && clickHouseVolume
        ? { id: managedClickHouse.Id, running: managedClickHouse.State === 'running', volume: clickHouseVolume }
        : null,
  };
}

/** The role and database the postgres container was created with (both layouts set them in its environment). */
async function postgresIdentity(docker: DockerService, postgresId: string): Promise<{ role: string; name: string }> {
  const env = (await docker.inspectContainerDetails(postgresId))?.Config.Env ?? [];
  const value = (key: string) => env.find((entry) => entry.startsWith(`${key}=`))?.slice(key.length + 1);
  const role = value('POSTGRES_USER') || LEGACY_DATABASE_ROLE;
  const name = value('POSTGRES_DB') || role || LEGACY_DATABASE;
  if (!isSafeDatabaseIdentifier(role) || !isSafeDatabaseIdentifier(name)) {
    throw new Error(`Unsupported database role or name: ${role}/${name}`);
  }
  return { role, name };
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
  for (const label of [HELPER_LABEL, LEGACY_HELPER_LABEL]) {
    for (const helper of await docker.listContainersByLabel(`${label}=${project}`)) {
      await docker.removeContainer(helper.Id).catch(() => {});
    }
  }
}

/**
 * What an export that crashed or was cut off left behind, removed while no export runs: its helpers, the ClickHouse
 * hard-link snapshot (it pins every part ClickHouse merged away since, growing towards a second copy of the logs)
 * and the database dump in the Postgres container. Returns how many were found.
 */
export async function removeExportLeftovers(docker: DockerService, installation: ComposeInstallation): Promise<number> {
  let removed = 0;
  for (const label of [HELPER_LABEL, LEGACY_HELPER_LABEL]) {
    for (const helper of await docker.listContainersByLabel(`${label}=${installation.project}`)) {
      await docker.removeContainer(helper.Id).then(
        () => (removed += 1),
        () => {}
      );
    }
  }
  if (installation.clickhouse) {
    const result = await docker.runOneShot(
      {
        Image: installation.helperImage,
        Cmd: [
          'sh',
          '-c',
          `if [ -e /clickhouse/${CLICKHOUSE_SNAPSHOT_DIR} ]; then rm -rf /clickhouse/${CLICKHOUSE_SNAPSHOT_DIR} && echo removed; fi`,
        ],
        Labels: { [HELPER_LABEL]: installation.project },
        HostConfig: { Binds: [`${installation.clickhouse.volume}:/clickhouse`], NetworkMode: 'none' },
      },
      10 * 60_000
    );
    if (result.exitCode === 0 && result.output.includes('removed')) removed += 1;
  }
  const dump = await docker.execInContainer(installation.postgres, [
    'sh',
    '-c',
    `if [ -e /tmp/${DATABASE_DUMP_FILE} ]; then rm -f /tmp/${DATABASE_DUMP_FILE} && echo removed; fi`,
  ]);
  if (dump.exitCode === 0 && dump.output.includes('removed')) removed += 1;
  return removed;
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
        `umask 077 && rm -f ${path} && pg_dump --format=custom --create --no-password -U ${installation.database.role} -d ${installation.database.name} -f ${path} && pg_restore --list ${path} >/dev/null`,
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

/** Size of the Opfield database in bytes. */
export async function databaseSize(docker: DockerService, installation: ComposeInstallation): Promise<number> {
  const { role, name } = installation.database;
  const output = await execChecked(
    docker,
    installation.postgres,
    ['psql', '-X', '-At', '-U', role, '-d', name, '-c', `SELECT pg_database_size('${name}')`],
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
  /** Top directory of the tar stream (the volume's name in the export). */
  root: string
): Promise<TransferStream> {
  if (!/^[a-zA-Z0-9._-]+$/.test(root) || root === '.' || root === '..') throw new Error(`Invalid volume root ${root}`);
  const helper = await createHelper(docker, installation, [`${volume}:${MOUNT_BASE}/${root}:ro`]);
  const close = closeOnce(() => docker.removeContainer(helper));
  try {
    const stream = await docker.openContainerArchive(helper, `${MOUNT_BASE}/${root}`);
    stream.once('close', () => void close());
    return { stream, root, close };
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

/**
 * The commercial core directory the app has mounted, as a tar stream rooted at `commercial`. It is read through a
 * helper that binds the same host directory, like the volumes: Docker's archive API on the app container itself
 * remounts the app's read-only binds, which an LXC host refuses for its lxcfs files (/proc/loadavg and others).
 */
export async function openCommercialArchive(
  docker: DockerService,
  installation: Pick<ComposeInstallation, 'helperImage' | 'project'>,
  appContainer: string
): Promise<TransferStream> {
  const source = (await docker.inspectContainerDetails(appContainer))?.Mounts?.find(
    (mount) =>
      mount.Destination === '/var/lib/opfield/commercial' || mount.Destination === `${LEGACY_APP_DATA_DIR}/commercial`
  )?.Source;
  if (!source) throw new Error('The commercial core directory is not mounted into the Opfield app');
  const helper = await createHelper(docker, installation, [`${source}:${MOUNT_BASE}/commercial:ro`]);
  const close = closeOnce(() => docker.removeContainer(helper));
  try {
    const stream = await docker.openContainerArchive(helper, `${MOUNT_BASE}/commercial`);
    stream.once('close', () => void close());
    return { stream, root: 'commercial', close };
  } catch (error) {
    await close();
    throw error;
  }
}

// ── Restore ─────────────────────────────────────────────────────────

async function ensureVolume(
  docker: DockerService,
  project: string,
  volume: string,
  key: TransferVolumeKey,
  composeKey: string
) {
  if (await docker.inspectVolume(volume)) return;
  // Compose adopts a volume carrying its project and volume labels; the ClickHouse volume is the app's own.
  await docker.createVolume(
    volume,
    key === 'clickhouse_data' ? {} : { 'com.docker.compose.project': project, 'com.docker.compose.volume': composeKey }
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
  keep: string[] = [],
  /** The volume's key in docker-compose.yml, when the layout names it differently from the export. */
  composeKey: string = key
): Promise<void> {
  if (!/^[a-zA-Z0-9._-]+$/.test(root) || root === '.' || root === '..') throw new Error(`Invalid volume root ${root}`);
  await ensureVolume(docker, installation.project, volume, key, composeKey);
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
      `umask 077 && rm -f ${ROLLBACK_DUMP} && pg_dump --format=custom --create --no-password -U ${installation.database.role} -d ${installation.database.name} -f ${ROLLBACK_DUMP}`,
    ],
    'Snapshot of the current database'
  );
}

/** The database a custom-format dump made with --create recreates (`;     dbname: …` in its table of contents). */
export function dumpDatabaseName(list: string): string | null {
  return /^;\s+dbname:\s*(\S+)\s*$/m.exec(list)?.[1] ?? null;
}

async function replaceDatabase(docker: DockerService, installation: ComposeInstallation, dumpPath: string) {
  const { role, name } = installation.database;
  const psql = (sql: string) => ['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', role, '-d', 'postgres', '-c', sql];
  const dumped = dumpDatabaseName(
    await execChecked(docker, installation.postgres, ['pg_restore', '--list', dumpPath], 'Reading the database dump')
  );
  if (!dumped || !isSafeDatabaseIdentifier(dumped)) throw new Error('The database dump does not name its database');
  await execChecked(
    docker,
    installation.postgres,
    psql(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
    'Dropping the current database'
  );
  if (dumped === name) {
    await execChecked(
      docker,
      installation.postgres,
      ['pg_restore', '--create', '--exit-on-error', '--no-password', '-U', role, '-d', 'postgres', dumpPath],
      'Database restore'
    );
    return;
  }
  // A dump of the other layout (database and role LEGACY_INSTALL_DIR_NAME before the host move, `opfield` after): its objects
  // belong to this installation's role, and the database gets this installation's name.
  await execChecked(
    docker,
    installation.postgres,
    psql(`DROP DATABASE IF EXISTS ${dumped} WITH (FORCE)`),
    'Dropping a leftover database'
  );
  await execChecked(
    docker,
    installation.postgres,
    [
      'pg_restore',
      '--create',
      '--no-owner',
      '--exit-on-error',
      '--no-password',
      '-U',
      role,
      '-d',
      'postgres',
      dumpPath,
    ],
    'Database restore'
  );
  await execChecked(
    docker,
    installation.postgres,
    psql(`ALTER DATABASE ${dumped} RENAME TO ${name}`),
    'Naming the restored database'
  );
}

/** Replaces the Opfield database with the dump in `content` (a tar with the dump file). */
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
 * Sign-in and license of a copy restored from a managed cloud installation (the license stays with the cloud
 * installation, see {@link MANAGED_SOURCE_LICENSE_SETTINGS}): its Opfield account provider is bound to the cloud
 * (redirect URI on the cloud domain, client of that installation) and password sign-in is off, so the restorer would
 * be locked out. OIDC sign-in goes off, password sign-in on, and the owner signs in with a password set through a
 * one-time link (cli/owner-password-link). Users, roles and the provider's settings stay. Runs before
 * {@link forgetCloudLink}, which drops the enrolment it reads. True when the source was managed.
 */
export async function detachManagedSignIn(docker: DockerService, installation: ComposeInstallation): Promise<boolean> {
  const psql = (sql: string) => [
    'psql',
    '-X',
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    installation.database.role,
    '-d',
    installation.database.name,
    '-c',
    sql,
  ];
  const managed = await execChecked(
    docker,
    installation.postgres,
    psql("SELECT coalesce((SELECT value->>'managed' FROM settings WHERE key = 'cloud:enrollment'), 'false')"),
    'Reading the cloud link of the export'
  );
  if (managed.trim().split('\n').at(-1) !== 'true') return false;
  await execChecked(
    docker,
    installation.postgres,
    psql(MANAGED_SIGN_IN_DETACH_SQL),
    'Opening password sign-in for the owner'
  );
  return true;
}

/**
 * License state of a managed source: its key, signed state and installation registration belong to the cloud
 * installation, not to this copy. Dropped, the copy starts on Community under a new installation id and its owner
 * activates their own key. A self-hosted source keeps all of it (the same installation, moved).
 */
export const MANAGED_SOURCE_LICENSE_SETTINGS = [
  'license:key_encrypted',
  'license:cached_state_v5',
  'license:cached_state',
  'license:installation_token_encrypted',
  'license:installation_token',
  'license:registration_nonce_encrypted',
  'license:registration_nonce',
  'license:installation_id',
] as const;

/**
 * OIDC off and password on (other methods as they were), the owner on password sign-in, and the cloud
 * installation's license dropped; all or nothing.
 */
export const MANAGED_SIGN_IN_DETACH_SQL = [
  'BEGIN;',
  `DELETE FROM settings WHERE key IN (${MANAGED_SOURCE_LICENSE_SETTINGS.map((key) => `'${key}'`).join(', ')});`,
  "INSERT INTO settings (key, value, updated_at) VALUES ('auth:methods', " +
    `'{"oidc":false,"password":true,"emailOtp":false,"passkeyLogin":false}'::jsonb, now()) ` +
    `ON CONFLICT (key) DO UPDATE SET value = settings.value || '{"oidc":false,"password":true}'::jsonb, updated_at = now();`,
  "UPDATE users SET auth_method = 'password' WHERE id::text = " +
    "(SELECT value->>'ownerUserId' FROM settings WHERE key = 'onboarding:finalize_setup');",
  'COMMIT;',
].join(' ');

/**
 * Settings a restored copy must not keep: the cloud link belongs to the installation the export was taken from (its
 * agent and secret, remote management, a disconnect notice, the Opfield account sign-in client the cloud gave it or a
 * pending request for one), and the add-ons that account set (custom domain, cloud email, Opfield AI).
 * Kept, both would share one agent and the copy would read as a managed cloud VM.
 * The source's update attempt names a sidecar on the source host; kept, the copy would show its update banner.
 */
export const RESTORE_FORGOTTEN_SETTINGS = [
  'cloud:enrollment',
  'cloud:remote_management',
  'cloud:disconnected',
  'cloud:opfield_account_client',
  'cloud:sso_client_request',
  'cloud:public-alias',
  'cloud:mail',
  'cloud:inference',
  LEGACY_UPDATE_ATTEMPT_KEY,
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
      installation.database.role,
      '-d',
      installation.database.name,
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
