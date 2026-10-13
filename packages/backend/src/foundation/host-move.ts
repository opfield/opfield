import { createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { COMMERCIAL_HOST_DIR, LEGACY_COMMERCIAL_HOST_DIR } from '@/edition/prepare-update.js';
import { toOpfieldLayout } from './opfield-layout.js';
import {
  databaseIdentity,
  FOUNDATION_BACKUPS_DIR,
  isOpfieldComposeLayout,
  isSafeDatabaseIdentifier,
  LEGACY_CLICKHOUSE_ALIAS,
  LEGACY_DATABASE,
  LEGACY_DATABASE_ROLE,
  LEGACY_FOUNDATION_BACKUPS_DIR,
  LEGACY_INSTALL_DIR_NAME,
  LEGACY_LOGS_DATABASE,
  LEGACY_MANAGED_CLICKHOUSE_LABEL,
  LEGACY_MANAGED_CLICKHOUSE_OWNER_LABEL,
  MANAGED_CLICKHOUSE_LABEL,
  MANAGED_CLICKHOUSE_OWNER_LABEL,
  OPFIELD_CLICKHOUSE_ALIAS,
  OPFIELD_COMPOSE_PROJECT,
  OPFIELD_DATABASE,
  OPFIELD_DATABASE_ROLE,
  OPFIELD_INSTALL_DIR_NAME,
  OPFIELD_LOGS_DATABASE,
} from './opfield-names.js';

/**
 * The host move: an installation made before 2.12.1 (/opt/gateway, Compose project `gateway`, database and role
 * `gateway`) gets the Opfield layout (/opt/opfield, project `opfield`, database and role `opfield`). Docker volumes keep
 * their names. It runs after an update to 2.12.1 has settled (the earlier version's rollback can no longer start), in
 * its own container that Docker restarts after a crash or reboot, and it resumes from the step it recorded.
 *
 * Every step is idempotent and checks the host before it changes anything. A step that keeps failing, or a move that
 * was interrupted too often, goes back: the same steps in reverse restore the earlier layout. Either way the
 * installation ends in one layout, never in a mix. Secure Links through the local relay stop once, from removing the
 * old stack until the new relay is up (tens of seconds); the control plane stops from the app stop until the end.
 */

export const HOST_MOVE_DIR = '.opfield-host-move';
const STATE_FILE = 'state.json';
const STAGED_COMPOSE = 'docker-compose.yml';
const STAGED_ENV = 'env';
const LEGACY_FILES_DIR = 'legacy';
/** Name of the container that runs the move; Docker refuses a second one with the same name. */
export const HOST_MOVE_CONTAINER_NAME = 'opfield-host-move';
/** Superuser that exists only while the database role is renamed: a session cannot rename its own role. */
const TEMPORARY_ROLE = 'opfield_move';
const LOGGING_SETTINGS_KEY = 'logging:clickhouse';
/** Process runs that may resume a forward move; one more interruption sends it back. */
export const MAX_FORWARD_RUNS = 3;
/** Process runs that may resume going back before the move gives up and waits for an operator. */
export const MAX_BACK_RUNS = 6;
const FORWARD_STEP_ATTEMPTS = 3;
const BACK_STEP_ATTEMPTS = 5;
const VERIFY_TIMEOUT_MS = 5 * 60_000;
const VERIFY_INTERVAL_MS = 2_000;

export type HostMovePhase =
  | 'planned'
  | 'app_stopped'
  | 'database_renamed'
  | 'logs_renamed'
  | 'stack_removed'
  | 'dir_moved'
  | 'files_written'
  | 'stack_started'
  | 'verified'
  | 'done'
  | 'back_started'
  | 'back_stack_removed'
  | 'back_files_restored'
  | 'back_dir_moved'
  | 'back_database_renamed'
  | 'back_stack_started'
  | 'rolled_back'
  | 'failed';

export const TERMINAL_HOST_MOVE_PHASES: readonly HostMovePhase[] = ['done', 'rolled_back', 'failed'];

export interface ClickHouseSpec {
  name: string;
  image: string;
  env: string[];
  labels: Record<string, string>;
  binds: string[];
  restartPolicy: string;
  logConfig: { Type: string; Config?: Record<string, string> } | null;
  aliases: string[];
  running: boolean;
}

export interface AttachedContainer {
  id: string;
  name: string;
  aliases: string[];
  /**
   * The earlier network is the container's own network mode (`docker run --network gateway_default`). Docker refuses to
   * connect such a container anywhere, or to start it, once that network is gone, so it stays on it.
   */
  pinned?: boolean;
}

export interface HostMovePlan {
  oldDir: string;
  newDir: string;
  oldProject: string;
  newProject: string;
  oldNetwork: string;
  newNetwork: string;
  oldDatabase: string;
  oldRole: string;
  newDatabase: string;
  newRole: string;
  renameCommercialDir: boolean;
  clickhouse: ClickHouseSpec | null;
  attached: AttachedContainer[];
}

export interface HostMoveState {
  version: 1;
  id: string;
  phase: HostMovePhase;
  startedAt: string;
  updatedAt: string;
  /** Process runs that worked on the forward move. */
  runs: number;
  /** Process runs that worked on going back. */
  backRuns: number;
  /** Set once the move changed the host (the app was stopped); before that, going back has nothing to undo. */
  changed: boolean;
  /** The ClickHouse database was renamed (the recreated container then creates the Opfield one). */
  logsRenamed: boolean;
  error: string | null;
  plan: HostMovePlan;
}

export interface ServiceContainer {
  id: string;
  name: string;
  running: boolean;
  /** Docker health, or the state for a container without a healthcheck. */
  health: string;
  labels: Record<string, string>;
}

export interface NetworkMember {
  id: string;
  name: string;
  aliases: string[];
  labels: Record<string, string>;
  /** HostConfig.NetworkMode: the network the container was created on. */
  networkMode: string;
}

/** What the move needs from the host; foundation/host-move-host.ts implements it with Docker and the filesystem. */
export interface HostMoveHost {
  exists(file: string): Promise<boolean>;
  isSymlink(file: string): Promise<boolean>;
  readFile(file: string): Promise<string>;
  /** Atomic write. */
  writeFile(file: string, content: string, mode?: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  symlink(target: string, file: string): Promise<void>;
  unlink(file: string): Promise<void>;
  mkdir(dir: string, mode?: number): Promise<void>;
  /** Names in a directory; empty when it does not exist. */
  listDir(dir: string): Promise<string[]>;
  removeTree(dir: string): Promise<void>;
  /** Docker Compose in the project directory; throws when it fails. */
  compose(target: { project: string; dir: string; file: string; envFile?: string }, args: string[]): Promise<void>;
  projectContainers(project: string): Promise<ServiceContainer[]>;
  containerByName(name: string): Promise<ServiceContainer | null>;
  exec(containerId: string, command: string[]): Promise<{ exitCode: number; output: string }>;
  stopContainer(id: string, timeoutSeconds: number): Promise<void>;
  startContainer(id: string): Promise<void>;
  removeContainer(id: string): Promise<void>;
  createContainer(spec: ClickHouseSpec, network: string): Promise<string>;
  clickHouseSpec(id: string): Promise<ClickHouseSpec>;
  networkMembers(network: string): Promise<NetworkMember[]>;
  connectNetwork(network: string, containerId: string, aliases: string[]): Promise<void>;
  disconnectNetwork(network: string, containerId: string): Promise<void>;
  removeNetwork(network: string): Promise<void>;
  volumeNames(): Promise<Set<string>>;
  /** Stops Docker from restarting the move container once the move reached its end. */
  finish(): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  log(level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void;
}

export interface HostMoveTarget {
  /** Compose directory of the installation as the app sees it. */
  dir: string;
  /** Compose project the installation runs under. */
  project: string;
  /** Docker network of the app container (the project's default network). */
  network: string;
}

/** Where an installation in `dir` moves to: a sibling `opfield` for `…/gateway`, otherwise it stays. */
export function hostMoveNewDir(dir: string): string {
  return path.basename(dir) === LEGACY_INSTALL_DIR_NAME ? path.join(path.dirname(dir), OPFIELD_INSTALL_DIR_NAME) : dir;
}

/** Whether the installation still has (part of) the earlier layout. */
export function needsHostMove(input: { dir: string; project: string; compose: string }): boolean {
  return (
    path.basename(input.dir) === LEGACY_INSTALL_DIR_NAME ||
    input.project !== OPFIELD_COMPOSE_PROJECT ||
    !isOpfieldComposeLayout(input.compose) ||
    composeDatabase(input.compose).database !== OPFIELD_DATABASE
  );
}

/** Database role and name the app of docker-compose.yml connects as; the legacy names when it does not say. */
export function composeDatabase(compose: string): { role: string; database: string } {
  const url = /DATABASE_URL\s*[:=]\s*["']?(postgres(?:ql)?:\/\/[^"'\s]+)/.exec(compose)?.[1];
  const identity = databaseIdentity(url?.replace(/\$\{[^}]*\}/g, 'x'));
  return identity ?? { role: LEGACY_DATABASE_ROLE, database: LEGACY_DATABASE };
}

function stateDirs(plan: Pick<HostMovePlan, 'oldDir' | 'newDir'>): string[] {
  return [...new Set([plan.newDir, plan.oldDir])].map((dir) => path.join(dir, HOST_MOVE_DIR));
}

/** The recorded move of an installation, wherever its directory is now. */
export async function readHostMoveState(
  host: Pick<HostMoveHost, 'exists' | 'readFile'>,
  dirs: { oldDir: string; newDir: string }
): Promise<HostMoveState | null> {
  for (const dir of stateDirs(dirs)) {
    const file = path.join(dir, STATE_FILE);
    if (!(await host.exists(file))) continue;
    const parsed = JSON.parse(await host.readFile(file)) as HostMoveState;
    if (parsed?.version !== 1 || !parsed.plan) throw new Error(`Unreadable host move state: ${file}`);
    return parsed;
  }
  return null;
}

/** The directory of the installation now: the moved one, or the earlier one. */
async function currentDir(host: HostMoveHost, plan: HostMovePlan): Promise<string> {
  if (plan.newDir !== plan.oldDir && (await host.exists(plan.newDir))) return plan.newDir;
  return plan.oldDir;
}

async function writeState(host: HostMoveHost, state: HostMoveState): Promise<void> {
  state.updatedAt = host.now().toISOString();
  const dir = path.join(await currentDir(host, state.plan), HOST_MOVE_DIR);
  await host.writeFile(path.join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

/**
 * Plans the move and stages the Opfield files next to the running installation. Changes nothing the installation
 * uses; returns null when it already has the Opfield layout.
 */
export async function planHostMove(host: HostMoveHost, target: HostMoveTarget): Promise<HostMoveState | null> {
  const oldDir = target.dir;
  const compose = await host.readFile(path.join(oldDir, 'docker-compose.yml'));
  const env = await host.readFile(path.join(oldDir, '.env'));
  if (!needsHostMove({ dir: oldDir, project: target.project, compose })) return null;
  // Only an installer-managed installation moves: one that builds its app here (a source checkout) never does.
  const app = (parseDocument(compose).toJS() as { services?: { app?: { build?: unknown } } } | null)?.services?.app;
  if (!app || app.build !== undefined) {
    throw new Error(
      'docker-compose.yml is not an installer-managed Opfield installation (no app image); it stays as it is'
    );
  }

  let newDir = hostMoveNewDir(oldDir);
  if (newDir !== oldDir && (await host.exists(newDir))) {
    host.log('warn', 'The Opfield directory exists already; the installation keeps its directory', { newDir });
    newDir = oldDir;
  }
  const database = composeDatabase(compose);
  if (!isSafeDatabaseIdentifier(database.role) || !isSafeDatabaseIdentifier(database.database)) {
    throw new Error(`Unsupported database role or name in docker-compose.yml: ${database.role}/${database.database}`);
  }
  const renameCommercialDir =
    (await host.exists(path.join(oldDir, LEGACY_COMMERCIAL_HOST_DIR))) &&
    !(await host.exists(path.join(oldDir, COMMERCIAL_HOST_DIR)));
  const layout = toOpfieldLayout({
    compose,
    env,
    currentProject: target.project,
    existingVolumes: await host.volumeNames(),
    renameCommercialDir,
  });

  const projectContainerIds = new Set((await host.projectContainers(target.project)).map((item) => item.id));
  const clickhouse = await findClickHouse(host, target.project);
  const attached = (await host.networkMembers(target.network))
    .filter((member) => !projectContainerIds.has(member.id) && member.name !== clickhouse?.container.name)
    .filter((member) => member.labels['com.docker.compose.project'] !== target.project)
    .filter((member) => member.name !== HOST_MOVE_CONTAINER_NAME)
    .map(({ id, name, aliases, networkMode }) => ({
      id,
      name,
      aliases,
      ...(networkMode === target.network ? { pinned: true } : {}),
    }));

  const staging = path.join(oldDir, HOST_MOVE_DIR);
  await host.mkdir(staging, 0o700);
  await host.mkdir(path.join(staging, LEGACY_FILES_DIR), 0o700);
  await host.writeFile(path.join(staging, LEGACY_FILES_DIR, 'docker-compose.yml'), compose, 0o600);
  await host.writeFile(path.join(staging, LEGACY_FILES_DIR, '.env'), env, 0o600);
  await host.writeFile(path.join(staging, STAGED_COMPOSE), layout.compose, 0o600);
  await host.writeFile(path.join(staging, STAGED_ENV), layout.env, 0o600);
  // Refuse a plan Compose would not run, before anything stops.
  await host.compose(
    {
      project: OPFIELD_COMPOSE_PROJECT,
      dir: oldDir,
      file: path.join(staging, STAGED_COMPOSE),
      envFile: path.join(staging, STAGED_ENV),
    },
    ['config', '--quiet']
  );

  const now = host.now().toISOString();
  const state: HostMoveState = {
    version: 1,
    id: randomUUID(),
    phase: 'planned',
    startedAt: now,
    updatedAt: now,
    runs: 0,
    backRuns: 0,
    changed: false,
    logsRenamed: false,
    error: null,
    plan: {
      oldDir,
      newDir,
      oldProject: target.project,
      newProject: OPFIELD_COMPOSE_PROJECT,
      oldNetwork: target.network,
      newNetwork: `${OPFIELD_COMPOSE_PROJECT}_default`,
      oldDatabase: database.database,
      oldRole: database.role,
      newDatabase: OPFIELD_DATABASE,
      newRole: OPFIELD_DATABASE_ROLE,
      renameCommercialDir,
      clickhouse: clickhouse?.spec ?? null,
      attached,
    },
  };
  await writeState(host, state);
  host.log('info', 'Planned the move to the Opfield layout', {
    from: oldDir,
    to: newDir,
    project: `${target.project} -> ${OPFIELD_COMPOSE_PROJECT}`,
    volumes: layout.volumes.map((volume) => `${volume.key} -> ${volume.newKey} (${volume.physical})`),
  });
  return state;
}

async function findClickHouse(
  host: HostMoveHost,
  project: string
): Promise<{ container: ServiceContainer; spec: ClickHouseSpec } | null> {
  const name = `${project.replace(/[^a-zA-Z0-9_.-]/g, '-')}-clickhouse`;
  const container = await host.containerByName(name);
  if (!container) return null;
  const managed =
    container.labels[MANAGED_CLICKHOUSE_LABEL] === 'clickhouse' ||
    container.labels[LEGACY_MANAGED_CLICKHOUSE_LABEL] === 'clickhouse';
  if (!managed) return null;
  return { container, spec: await host.clickHouseSpec(container.id) };
}

interface Step {
  phase: HostMovePhase;
  run(host: HostMoveHost, state: HostMoveState): Promise<void>;
}

const FORWARD_STEPS: Step[] = [
  { phase: 'app_stopped', run: stopApp },
  { phase: 'database_renamed', run: renameDatabase },
  { phase: 'logs_renamed', run: renameLogsDatabase },
  { phase: 'stack_removed', run: removeOldStack },
  { phase: 'dir_moved', run: moveDirectory },
  { phase: 'files_written', run: writeOpfieldFiles },
  { phase: 'stack_started', run: startOpfieldStack },
  { phase: 'verified', run: verifyOpfieldStack },
];

const BACK_STEPS: Step[] = [
  { phase: 'back_stack_removed', run: removeOpfieldStack },
  { phase: 'back_files_restored', run: restoreLegacyFiles },
  { phase: 'back_dir_moved', run: moveDirectoryBack },
  { phase: 'back_database_renamed', run: renameDatabaseBack },
  { phase: 'back_stack_started', run: startLegacyStack },
];

/**
 * Runs or resumes the move recorded in `state` until it is done, rolled back or failed. Throws when a run must stop
 * early (Docker restarts the move container, which resumes from the recorded step).
 */
export async function runHostMove(host: HostMoveHost, state: HostMoveState): Promise<HostMovePhase> {
  if (TERMINAL_HOST_MOVE_PHASES.includes(state.phase)) {
    await host.finish();
    return state.phase;
  }
  if (isBackPhase(state.phase)) return goBack(host, state, null);

  state.runs += 1;
  await writeState(host, state);
  if (state.runs > MAX_FORWARD_RUNS) {
    return goBack(host, state, `The move was interrupted ${state.runs - 1} times`);
  }
  host.log('info', 'Moving the installation to the Opfield layout', { phase: state.phase, run: state.runs });
  const start = FORWARD_STEPS.findIndex((step) => step.phase === state.phase) + 1;
  for (const step of FORWARD_STEPS.slice(start)) {
    if (step.phase === 'app_stopped' && !state.changed) {
      state.changed = true;
      await writeState(host, state);
    }
    const error = await attempt(host, step, state, FORWARD_STEP_ATTEMPTS, 5_000);
    if (error) return goBack(host, state, `${step.phase}: ${error}`);
    state.phase = step.phase;
    await writeState(host, state);
    host.log('info', `Host move step completed: ${step.phase}`);
  }
  await cleanupStaging(host, state);
  state.phase = 'done';
  await writeState(host, state);
  host.log('info', 'The installation runs in the Opfield layout', {
    dir: state.plan.newDir,
    project: state.plan.newProject,
  });
  await host.finish();
  return 'done';
}

async function attempt(
  host: HostMoveHost,
  step: Step,
  state: HostMoveState,
  attempts: number,
  delayMs: number
): Promise<string | null> {
  let last = '';
  for (let index = 1; index <= attempts; index += 1) {
    try {
      await step.run(host, state);
      return null;
    } catch (error) {
      if (error instanceof HostMoveCrash) throw error;
      last = error instanceof Error ? error.message : String(error);
      host.log('warn', `Host move step failed: ${step.phase}`, { attempt: index, error: last });
      if (index < attempts) await host.sleep(delayMs);
    }
  }
  return last;
}

function isBackPhase(phase: HostMovePhase): boolean {
  return phase.startsWith('back_');
}

async function goBack(host: HostMoveHost, state: HostMoveState, reason: string | null): Promise<HostMovePhase> {
  if (reason) {
    state.error = reason;
    host.log('error', 'The move to the Opfield layout failed; restoring the earlier layout', { reason });
  }
  if (!state.changed) {
    // Nothing on the host changed: the installation runs as before.
    await cleanupStaging(host, state);
    state.phase = 'rolled_back';
    await writeState(host, state);
    await host.finish();
    return 'rolled_back';
  }
  if (!isBackPhase(state.phase)) state.phase = 'back_started';
  state.backRuns += 1;
  await writeState(host, state);
  if (state.backRuns > MAX_BACK_RUNS) {
    state.phase = 'failed';
    await writeState(host, state);
    host.log('error', 'Restoring the earlier layout failed repeatedly; see the operations guide (host move)', {
      error: state.error,
    });
    await host.finish();
    return 'failed';
  }
  const start = BACK_STEPS.findIndex((step) => step.phase === state.phase) + 1;
  for (const step of BACK_STEPS.slice(start)) {
    const error = await attempt(host, step, state, BACK_STEP_ATTEMPTS, 10_000);
    // A run that cannot finish going back ends here; the next run resumes this step.
    if (error) throw new Error(`Going back failed at ${step.phase}: ${error}`);
    state.phase = step.phase;
    await writeState(host, state);
    host.log('info', `Host move back step completed: ${step.phase}`);
  }
  await verifyStack(host, state.plan.oldProject, await currentDir(host, state.plan));
  await cleanupStaging(host, state);
  state.phase = 'rolled_back';
  await writeState(host, state);
  host.log('warn', 'The installation runs in its earlier layout again', { dir: state.plan.oldDir });
  await host.finish();
  return 'rolled_back';
}

/** Thrown by test hosts to simulate a crash: never caught by the step retry. */
export class HostMoveCrash extends Error {}

async function cleanupStaging(host: HostMoveHost, state: HostMoveState): Promise<void> {
  const dir = path.join(await currentDir(host, state.plan), HOST_MOVE_DIR);
  for (const file of [STAGED_COMPOSE, STAGED_ENV]) {
    const target = path.join(dir, file);
    if (await host.exists(target)) await host.unlink(target);
  }
}

// ── Forward steps ───────────────────────────────────────────────────────────────────────────────────────────────

async function serviceContainer(host: HostMoveHost, project: string, service: string) {
  return (
    (await host.projectContainers(project)).find(
      (container) => container.labels['com.docker.compose.service'] === service
    ) ?? null
  );
}

async function stopApp(host: HostMoveHost, state: HostMoveState): Promise<void> {
  const app = await serviceContainer(host, state.plan.oldProject, 'app');
  // The app drains its own work for up to 60 seconds (stop_grace_period).
  if (app?.running) await host.stopContainer(app.id, 60);
}

async function postgresContainer(host: HostMoveHost, project: string): Promise<ServiceContainer> {
  const postgres = await serviceContainer(host, project, 'postgres');
  if (!postgres) throw new Error(`The postgres container of the Compose project ${project} was not found`);
  if (!postgres.running) await host.startContainer(postgres.id);
  return postgres;
}

async function psql(
  host: HostMoveHost,
  postgresId: string,
  role: string,
  sql: string,
  database = 'postgres'
): Promise<string> {
  const result = await host.exec(postgresId, [
    'psql',
    '-X',
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    role,
    '-d',
    database,
    '-c',
    sql,
  ]);
  if (result.exitCode !== 0) throw new Error(`psql as ${role} failed: ${result.output.trim().slice(-500)}`);
  return result.output;
}

async function waitForPostgres(host: HostMoveHost, postgresId: string, roles: string[]): Promise<string> {
  const deadline = host.now().getTime() + 120_000;
  for (;;) {
    for (const role of roles) {
      const result = await host.exec(postgresId, ['pg_isready', '-U', role, '-d', 'postgres']);
      if (result.exitCode === 0) {
        // pg_isready does not check the role; a query does.
        const probe = await host.exec(postgresId, [
          'psql',
          '-X',
          '-At',
          '-U',
          role,
          '-d',
          'postgres',
          '-c',
          'SELECT 1',
        ]);
        if (probe.exitCode === 0) return role;
      }
    }
    if (host.now().getTime() > deadline) throw new Error('PostgreSQL did not accept connections');
    await host.sleep(2_000);
  }
}

function quoteList(names: string[]): string {
  return names.map((name) => `'${name}'`).join(', ');
}

/** The SCRAM-SHA-256 verifier of a password, so the plain password never appears in a command. */
export function scramVerifier(password: string, salt = randomBytes(16)): string {
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/**
 * Renames the database and its owner role from `from` to `to` (both directions use it). A role cannot rename itself,
 * so a temporary superuser does it. The password is set again: renaming clears an MD5 password.
 */
async function renameDatabaseIdentity(
  host: HostMoveHost,
  state: HostMoveState,
  project: string,
  from: { role: string; database: string },
  to: { role: string; database: string }
): Promise<void> {
  const postgres = await postgresContainer(host, project);
  const connectAs = await waitForPostgres(host, postgres.id, [from.role, to.role, TEMPORARY_ROLE]);
  const roles = (
    await psql(
      host,
      postgres.id,
      connectAs,
      `SELECT rolname FROM pg_roles WHERE rolname IN (${quoteList([from.role, to.role, TEMPORARY_ROLE])})`
    )
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const databases = (
    await psql(
      host,
      postgres.id,
      connectAs,
      `SELECT datname FROM pg_database WHERE datname IN (${quoteList([from.database, to.database])})`
    )
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const renameDatabase =
    from.database !== to.database && databases.includes(from.database) && !databases.includes(to.database);
  const renameRole = from.role !== to.role && roles.includes(from.role) && !roles.includes(to.role);
  // The temporary role exists only between the first rename and the end of this step: a run that left it resumes.
  const unfinished = roles.includes(TEMPORARY_ROLE);
  if (from.database !== to.database && databases.includes(from.database) && databases.includes(to.database)) {
    throw new Error(`Both databases ${from.database} and ${to.database} exist; refusing to choose one`);
  }
  if (from.role !== to.role && roles.includes(from.role) && roles.includes(to.role)) {
    throw new Error(`Both roles ${from.role} and ${to.role} exist; refusing to choose one`);
  }
  if (!renameDatabase && !renameRole && !unfinished) return;
  if (!unfinished) {
    await psql(host, postgres.id, connectAs, `CREATE ROLE ${TEMPORARY_ROLE} SUPERUSER LOGIN`);
  }
  if (renameDatabase) {
    await psql(
      host,
      postgres.id,
      TEMPORARY_ROLE,
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${from.database}' AND pid <> pg_backend_pid()`
    );
    await psql(host, postgres.id, TEMPORARY_ROLE, `ALTER DATABASE ${from.database} RENAME TO ${to.database}`);
  }
  if (renameRole) {
    await psql(
      host,
      postgres.id,
      TEMPORARY_ROLE,
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${from.role}'`
    );
    await psql(host, postgres.id, TEMPORARY_ROLE, `ALTER ROLE ${from.role} RENAME TO ${to.role}`);
  }
  // Renaming a role clears an MD5 password; the verifier keeps the app's DB_PASSWORD working either way.
  const password = await databasePassword(host, state);
  if (password) {
    await psql(host, postgres.id, TEMPORARY_ROLE, `ALTER ROLE ${to.role} PASSWORD '${scramVerifier(password)}'`);
  }
  await psql(host, postgres.id, to.role, `DROP ROLE IF EXISTS ${TEMPORARY_ROLE}`);
}

async function databasePassword(host: HostMoveHost, state: HostMoveState): Promise<string | null> {
  const dir = await currentDir(host, state.plan);
  for (const file of [path.join(dir, HOST_MOVE_DIR, LEGACY_FILES_DIR, '.env'), path.join(dir, '.env')]) {
    if (!(await host.exists(file))) continue;
    const value = /^DB_PASSWORD=(.*)$/m.exec(await host.readFile(file))?.[1]?.trim();
    if (value) return value;
  }
  return null;
}

async function renameDatabase(host: HostMoveHost, state: HostMoveState): Promise<void> {
  const { plan } = state;
  await renameDatabaseIdentity(
    host,
    state,
    plan.oldProject,
    { role: plan.oldRole, database: plan.oldDatabase },
    { role: plan.newRole, database: plan.newDatabase }
  );
}

async function clickHouseQuery(host: HostMoveHost, containerId: string, sql: string): Promise<string> {
  const result = await host.exec(containerId, ['clickhouse-client', '--query', sql]);
  if (result.exitCode !== 0) throw new Error(`ClickHouse query failed: ${result.output.trim().slice(-500)}`);
  return result.output;
}

async function renameLogsDatabaseOn(
  host: HostMoveHost,
  containerId: string,
  from: string,
  to: string
): Promise<boolean> {
  const present = (
    await clickHouseQuery(
      host,
      containerId,
      `SELECT name FROM system.databases WHERE name IN (${quoteList([from, to])}) FORMAT TSV`
    )
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (present.includes(from) && !present.includes(to)) {
    await clickHouseQuery(host, containerId, `RENAME DATABASE ${from} TO ${to}`);
    return true;
  }
  return present.includes(to) && !present.includes(from);
}

function loggingSettingsSql(fromDatabase: string, toDatabase: string, fromHost: string, toHost: string): string {
  return [
    'BEGIN;',
    `UPDATE settings SET value = jsonb_set(value::jsonb, '{database}', to_jsonb('${toDatabase}'::text)) WHERE key = '${LOGGING_SETTINGS_KEY}' AND value->>'database' = '${fromDatabase}';`,
    `UPDATE settings SET value = jsonb_set(value::jsonb, '{url}', to_jsonb(replace(value->>'url', '//${fromHost}:', '//${toHost}:'))) WHERE key = '${LOGGING_SETTINGS_KEY}' AND value->>'url' LIKE '%//${fromHost}:%';`,
    'COMMIT;',
  ].join(' ');
}

async function renameLogsDatabase(host: HostMoveHost, state: HostMoveState): Promise<void> {
  const spec = state.plan.clickhouse;
  if (!spec) return;
  const container = await host.containerByName(spec.name);
  // A stopped ClickHouse (logging off or external) keeps its database name; its settings keep it as well.
  if (!container?.running) return;
  const renamed = await renameLogsDatabaseOn(host, container.id, LEGACY_LOGS_DATABASE, OPFIELD_LOGS_DATABASE);
  if (!renamed) return;
  const postgres = await postgresContainer(host, state.plan.oldProject);
  await psql(
    host,
    postgres.id,
    state.plan.newRole,
    loggingSettingsSql(LEGACY_LOGS_DATABASE, OPFIELD_LOGS_DATABASE, LEGACY_CLICKHOUSE_ALIAS, OPFIELD_CLICKHOUSE_ALIAS),
    state.plan.newDatabase
  );
  state.logsRenamed = true;
}

async function removeProjectContainers(host: HostMoveHost, project: string): Promise<void> {
  const containers = await host.projectContainers(project);
  // The relay drains for at most 5 s; Postgres shuts down after its clients.
  for (const service of ['relay', 'registry', 'app']) {
    for (const container of containers.filter((item) => item.labels['com.docker.compose.service'] === service)) {
      if (container.running) await host.stopContainer(container.id, 10);
    }
  }
  for (const container of containers) {
    if (container.running) await host.stopContainer(container.id, 75);
    await host.removeContainer(container.id);
  }
}

async function detachAttached(host: HostMoveHost, network: string, attached: AttachedContainer[]): Promise<void> {
  const members = new Set((await host.networkMembers(network)).map((member) => member.id));
  for (const container of attached) {
    if (members.has(container.id)) await host.disconnectNetwork(network, container.id);
  }
}

async function attachAttached(host: HostMoveHost, network: string, attached: AttachedContainer[]): Promise<void> {
  const members = new Set((await host.networkMembers(network)).map((member) => member.id));
  for (const container of attached) {
    if (members.has(container.id)) continue;
    const exists = await host.containerByName(container.name);
    if (!exists) continue;
    await host.connectNetwork(network, exists.id, container.aliases);
  }
}

async function removeOldStack(host: HostMoveHost, state: HostMoveState): Promise<void> {
  const { plan } = state;
  await detachAttached(
    host,
    plan.oldNetwork,
    plan.attached.filter((container) => !container.pinned)
  );
  if (plan.clickhouse) {
    const container = await host.containerByName(plan.clickhouse.name);
    if (container) {
      if (container.running) await host.stopContainer(container.id, 30);
      await host.removeContainer(container.id);
    }
  }
  // From here Secure Links through the local relay are down until the new relay is up.
  await removeProjectContainers(host, plan.oldProject);
  // legacy-name: the earlier project network stays while a container created on it exists — remove once none does
  if (!(await pinnedContainerExists(host, plan.attached))) await host.removeNetwork(plan.oldNetwork);
}

async function pinnedContainerExists(host: HostMoveHost, attached: AttachedContainer[]): Promise<boolean> {
  for (const container of attached) {
    if (container.pinned && (await host.containerByName(container.name))) return true;
  }
  return false;
}

async function moveDirectory(host: HostMoveHost, state: HostMoveState): Promise<void> {
  const { plan } = state;
  if (plan.newDir !== plan.oldDir) {
    const oldIsDir = (await host.exists(plan.oldDir)) && !(await host.isSymlink(plan.oldDir));
    if (oldIsDir && !(await host.exists(plan.newDir))) await host.rename(plan.oldDir, plan.newDir);
    if (!(await host.exists(plan.newDir))) throw new Error(`${plan.newDir} is missing after the move`);
    // Scripts and habits that still use the earlier path keep working.
    if (!(await host.exists(plan.oldDir)) && !(await host.isSymlink(plan.oldDir))) {
      await host.symlink(plan.newDir, plan.oldDir);
    }
  }
  if (plan.renameCommercialDir) {
    const legacy = path.join(plan.newDir, LEGACY_COMMERCIAL_HOST_DIR);
    const current = path.join(plan.newDir, COMMERCIAL_HOST_DIR);
    if ((await host.exists(legacy)) && !(await host.exists(current))) await host.rename(legacy, current);
  }
  await foldLegacyBackups(host, plan.newDir);
}

/**
 * Moves the backups that updates before 2.12.1 kept under the earlier name (LEGACY_FOUNDATION_BACKUPS_DIR) into
 * FOUNDATION_BACKUPS_DIR, one entry at a time with a rename, so a crash leaves every backup in one of the two and the
 * next run finishes it. The backups stay in the Opfield directory if the move goes back: the app of this release reads
 * only that one. An entry whose name the Opfield directory has already gets a suffix; the earlier directory goes once
 * it is empty.
 */
async function foldLegacyBackups(host: HostMoveHost, dir: string): Promise<void> {
  // legacy-name: `.gateway-foundation-backups` of updates before 2.12.1 — remove once every installation reports the
  // Opfield layout.
  const legacy = path.join(dir, LEGACY_FOUNDATION_BACKUPS_DIR);
  const current = path.join(dir, FOUNDATION_BACKUPS_DIR);
  if (!(await host.exists(legacy)) || (await host.isSymlink(legacy))) return;
  if (!(await host.exists(current))) {
    await host.rename(legacy, current);
    return;
  }
  let kept = 0;
  for (const name of await host.listDir(legacy)) {
    const target = [path.join(current, name), path.join(current, `${name}.earlier`)];
    const free = (await host.exists(target[0] as string))
      ? (await host.exists(target[1] as string))
        ? null
        : target[1]
      : target[0];
    if (!free) {
      kept += 1;
      continue;
    }
    await host.rename(path.join(legacy, name), free);
  }
  if (kept === 0 && (await host.listDir(legacy)).length === 0) await host.removeTree(legacy);
  else if (kept > 0)
    host.log('warn', 'Some earlier backups keep their directory: their names are taken', { legacy, kept });
}

async function writeOpfieldFiles(host: HostMoveHost, state: HostMoveState): Promise<void> {
  const dir = state.plan.newDir;
  const staging = path.join(dir, HOST_MOVE_DIR);
  const compose = await host.readFile(path.join(staging, STAGED_COMPOSE));
  const env = await host.readFile(path.join(staging, STAGED_ENV));
  // Root only, as the installer writes both: they carry the installation's secrets.
  await host.writeFile(path.join(dir, 'docker-compose.yml'), compose, 0o600);
  await host.writeFile(path.join(dir, '.env'), env, 0o600);
  const sandbox = /^SANDBOX_RUNNER_WORKSPACE_DIR=(\/.+)$/m.exec(env)?.[1];
  if (sandbox) await host.mkdir(sandbox, 0o700);
}

function opfieldClickHouseSpec(state: HostMoveState, spec: ClickHouseSpec): ClickHouseSpec {
  const labels = { ...spec.labels };
  delete labels[LEGACY_MANAGED_CLICKHOUSE_LABEL];
  delete labels[LEGACY_MANAGED_CLICKHOUSE_OWNER_LABEL];
  labels[MANAGED_CLICKHOUSE_LABEL] = 'clickhouse';
  labels[MANAGED_CLICKHOUSE_OWNER_LABEL] = state.plan.newProject;
  return {
    ...spec,
    name: `${state.plan.newProject}-clickhouse`,
    labels,
    env: spec.env.map((entry) =>
      state.logsRenamed && entry === `CLICKHOUSE_DB=${LEGACY_LOGS_DATABASE}`
        ? `CLICKHOUSE_DB=${OPFIELD_LOGS_DATABASE}`
        : entry
    ),
    aliases: state.logsRenamed
      ? [OPFIELD_CLICKHOUSE_ALIAS]
      : // legacy-name: the earlier alias while the logging settings still name it (ClickHouse was stopped).
        [OPFIELD_CLICKHOUSE_ALIAS, LEGACY_CLICKHOUSE_ALIAS],
  };
}

async function ensureClickHouse(host: HostMoveHost, spec: ClickHouseSpec, network: string): Promise<void> {
  let container = await host.containerByName(spec.name);
  if (!container) {
    await host.createContainer(spec, network);
    container = await host.containerByName(spec.name);
  }
  if (container && spec.running && !container.running) await host.startContainer(container.id);
}

async function startOpfieldStack(host: HostMoveHost, state: HostMoveState): Promise<void> {
  const { plan } = state;
  const target = { project: plan.newProject, dir: plan.newDir, file: path.join(plan.newDir, 'docker-compose.yml') };
  // Containers and the network first: ClickHouse joins before the app looks for it.
  await host.compose(target, ['up', '--detach', '--no-start']);
  if (plan.clickhouse) await ensureClickHouse(host, opfieldClickHouseSpec(state, plan.clickhouse), plan.newNetwork);
  await attachAttached(host, plan.newNetwork, plan.attached);
  await host.compose(target, ['up', '--detach']);
}

async function verifyStack(host: HostMoveHost, project: string, dir: string): Promise<void> {
  const deadline = host.now().getTime() + VERIFY_TIMEOUT_MS;
  let last = 'no containers';
  for (;;) {
    const containers = await host.projectContainers(project);
    const service = (name: string) =>
      containers.find((container) => container.labels['com.docker.compose.service'] === name) ?? null;
    const app = service('app');
    const relay = service('relay');
    const required = ['app', 'postgres', 'redis', 'relay', 'registry']
      .map((name) => service(name))
      .filter((container): container is ServiceContainer => container !== null);
    const unhealthy = required.filter(
      (container) => !container.running || !['healthy', 'running'].includes(container.health)
    );
    if (!app) last = 'the app container is missing';
    else if (unhealthy.length > 0) last = `not healthy yet: ${unhealthy.map((item) => item.name).join(', ')}`;
    else if (app.labels['com.docker.compose.project.working_dir'] !== dir) {
      last = `the app runs from ${app.labels['com.docker.compose.project.working_dir']}, expected ${dir}`;
    } else if (relay && !(await relayReachable(host, app.id))) last = 'the app cannot reach the relay';
    else return;
    if (host.now().getTime() > deadline) throw new Error(`The ${project} stack did not become healthy: ${last}`);
    await host.sleep(VERIFY_INTERVAL_MS);
  }
}

async function relayReachable(host: HostMoveHost, appId: string): Promise<boolean> {
  const result = await host.exec(appId, [
    'node',
    '-e',
    'const net=require("node:net");const socket=net.connect(9443,"relay",()=>{socket.end();process.exit(0)});socket.setTimeout(3000,()=>{socket.destroy();process.exit(1)});socket.on("error",()=>process.exit(1));',
  ]);
  return result.exitCode === 0;
}

async function verifyOpfieldStack(host: HostMoveHost, state: HostMoveState): Promise<void> {
  await verifyStack(host, state.plan.newProject, state.plan.newDir);
}

// ── Back steps ──────────────────────────────────────────────────────────────────────────────────────────────────

async function removeOpfieldStack(host: HostMoveHost, state: HostMoveState): Promise<void> {
  const { plan } = state;
  await detachAttached(host, plan.newNetwork, plan.attached);
  if (plan.clickhouse) {
    const created = await host.containerByName(opfieldClickHouseSpec(state, plan.clickhouse).name);
    if (created && created.name !== plan.clickhouse.name) {
      if (created.running) await host.stopContainer(created.id, 30);
      await host.removeContainer(created.id);
    }
  }
  await removeProjectContainers(host, plan.newProject);
  if (plan.newNetwork !== plan.oldNetwork) await host.removeNetwork(plan.newNetwork);
  // The earlier project, when it differs, may still run (the move stopped only its app before it failed).
  if (plan.oldProject !== plan.newProject) {
    const app = await serviceContainer(host, plan.oldProject, 'app');
    if (app?.running) await host.stopContainer(app.id, 60);
  }
}

async function restoreLegacyFiles(host: HostMoveHost, state: HostMoveState): Promise<void> {
  const dir = await currentDir(host, state.plan);
  const legacy = path.join(dir, HOST_MOVE_DIR, LEGACY_FILES_DIR);
  await host.writeFile(
    path.join(dir, 'docker-compose.yml'),
    await host.readFile(path.join(legacy, 'docker-compose.yml')),
    0o600
  );
  await host.writeFile(path.join(dir, '.env'), await host.readFile(path.join(legacy, '.env')), 0o600);
}

async function moveDirectoryBack(host: HostMoveHost, state: HostMoveState): Promise<void> {
  const { plan } = state;
  if (plan.renameCommercialDir) {
    const dir = await currentDir(host, plan);
    const legacy = path.join(dir, LEGACY_COMMERCIAL_HOST_DIR);
    const current = path.join(dir, COMMERCIAL_HOST_DIR);
    if ((await host.exists(current)) && !(await host.exists(legacy))) await host.rename(current, legacy);
  }
  if (plan.newDir === plan.oldDir) return;
  if (await host.isSymlink(plan.oldDir)) await host.unlink(plan.oldDir);
  if ((await host.exists(plan.newDir)) && !(await host.exists(plan.oldDir)))
    await host.rename(plan.newDir, plan.oldDir);
  if (!(await host.exists(plan.oldDir))) throw new Error(`${plan.oldDir} is missing after moving back`);
}

async function renameDatabaseBack(host: HostMoveHost, state: HostMoveState): Promise<void> {
  const { plan } = state;
  const target = { project: plan.oldProject, dir: plan.oldDir, file: path.join(plan.oldDir, 'docker-compose.yml') };
  // The earlier stack may be gone (the move removed it): Compose brings back its network and database.
  await host.compose(target, ['up', '--detach', 'postgres']);
  await renameDatabaseIdentity(
    host,
    state,
    plan.oldProject,
    { role: plan.newRole, database: plan.newDatabase },
    { role: plan.oldRole, database: plan.oldDatabase }
  );
  if (!plan.clickhouse) return;
  await ensureClickHouse(host, { ...plan.clickhouse, running: true }, plan.oldNetwork);
  const container = await host.containerByName(plan.clickhouse.name);
  if (container?.running && state.logsRenamed) {
    await renameLogsDatabaseOn(host, container.id, OPFIELD_LOGS_DATABASE, LEGACY_LOGS_DATABASE);
    const postgres = await postgresContainer(host, plan.oldProject);
    await psql(
      host,
      postgres.id,
      plan.oldRole,
      loggingSettingsSql(
        OPFIELD_LOGS_DATABASE,
        LEGACY_LOGS_DATABASE,
        OPFIELD_CLICKHOUSE_ALIAS,
        LEGACY_CLICKHOUSE_ALIAS
      ),
      plan.oldDatabase
    );
    state.logsRenamed = false;
  }
  if (container && !plan.clickhouse.running && container.running) await host.stopContainer(container.id, 30);
}

async function startLegacyStack(host: HostMoveHost, state: HostMoveState): Promise<void> {
  const { plan } = state;
  const target = { project: plan.oldProject, dir: plan.oldDir, file: path.join(plan.oldDir, 'docker-compose.yml') };
  await host.compose(target, ['up', '--detach']);
  await attachAttached(host, plan.oldNetwork, plan.attached);
}
