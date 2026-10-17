import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import {
  type ClickHouseSpec,
  composeDatabase,
  HostMoveCrash,
  type HostMoveHost,
  type HostMovePhase,
  hostMoveNewDir,
  type NetworkMember,
  needsHostMove,
  planHostMove,
  readHostMoveState,
  runHostMove,
  type ServiceContainer,
  scramVerifier,
} from './host-move.js';
import { databaseIdentity } from './opfield-names.js';

// A simulated Docker host: files, Compose projects, containers on networks, volumes, and the Postgres and ClickHouse
// state that lives in their volumes. Every operation that changes something counts; a test makes the host crash
// (the move process dies) before a given operation, or makes one kind of operation fail every time.

const OLD_DIR = '/opt/gateway';
const NEW_DIR = '/opt/opfield';

const INSTALL_SH = readFileSync(path.resolve(__dirname, '../../../../scripts/install.sh'), 'utf8');
const LEGACY_COMPOSE = [...INSTALL_SH.matchAll(/cat >docker-compose\.yml <<'COMPOSE'\n([\s\S]*?)\nCOMPOSE\n/g)][0]![1]!;

interface Container {
  id: string;
  name: string;
  labels: Record<string, string>;
  running: boolean;
  env: string[];
  image: string;
  binds: string[];
  restartPolicy: string;
  networks: Map<string, string[]>;
  /** Docker's HostConfig.NetworkMode: the network the container was created on (`docker run --network`). */
  networkMode?: string;
  /** Postgres or ClickHouse data volume. */
  dataVolume?: string;
  database?: { role: string; database: string };
  ports: string[];
}

interface PgState {
  roles: Set<string>;
  databases: Set<string>;
  logging: { database: string; url: string };
  passwords: Map<string, string>;
}

class FakeHost implements HostMoveHost {
  files = new Map<string, string>();
  dirs = new Set<string>(['/', '/opt', '/var', '/var/lib']);
  links = new Map<string, string>();
  containers = new Map<string, Container>();
  networks = new Set<string>();
  volumes = new Set<string>();
  pg = new Map<string, PgState>();
  ch = new Map<string, Set<string>>();
  clock = Date.parse('2026-10-13T00:00:00Z');
  operations = 0;
  crashAt: number | null = null;
  failing: ((operation: string, detail: string) => boolean) | null = null;
  finished = 0;
  logs: string[] = [];
  /** Compose projects whose app never becomes healthy. */
  unhealthy = new Set<string>();
  private nextId = 1;

  private mutate(operation: string, detail = ''): void {
    this.operations += 1;
    if (this.crashAt !== null && this.operations === this.crashAt) {
      throw new HostMoveCrash(`crash before ${operation} ${detail}`);
    }
    if (this.failing?.(operation, detail)) throw new Error(`${operation} failed: ${detail}`);
  }

  real(file: string): string {
    for (const [link, target] of this.links) {
      if (file === link) return target;
      if (file.startsWith(`${link}/`)) return `${target}${file.slice(link.length)}`;
    }
    return file;
  }

  async exists(file: string) {
    const real = this.real(file);
    return this.dirs.has(real) || this.files.has(real);
  }
  async isSymlink(file: string) {
    return this.links.has(file);
  }
  async readFile(file: string) {
    const content = this.files.get(this.real(file));
    if (content === undefined) throw new Error(`ENOENT ${file}`);
    return content;
  }
  /** File modes the move wrote (the real host sets the mode on an unchanged file too). */
  modes = new Map<string, number>();
  async writeFile(file: string, content: string, mode = 0o600) {
    const real = this.real(file);
    if (this.files.get(real) === content) {
      this.modes.set(real, mode);
      return;
    }
    this.mutate('write', file);
    if (!this.dirs.has(path.dirname(real))) throw new Error(`ENOENT dir of ${file}`);
    this.files.set(real, content);
    this.modes.set(real, mode);
  }
  async listDir(dir: string) {
    const real = this.real(dir);
    return [...new Set([...this.dirs, ...this.files.keys()])]
      .filter((entry) => entry !== real && path.dirname(entry) === real)
      .map((entry) => path.basename(entry))
      .sort();
  }
  async rename(from: string, to: string) {
    this.mutate('rename', `${from} -> ${to}`);
    const source = this.real(from);
    const target = this.real(to);
    if (this.dirs.has(target) || this.files.has(target)) throw new Error(`EEXIST ${to}`);
    const move = (value: string) =>
      value === source || value.startsWith(`${source}/`) ? `${target}${value.slice(source.length)}` : value;
    this.dirs = new Set([...this.dirs].map(move));
    this.files = new Map([...this.files].map(([key, value]) => [move(key), value]));
    this.modes = new Map([...this.modes].map(([key, value]) => [move(key), value]));
  }
  async symlink(target: string, file: string) {
    this.mutate('symlink', file);
    if (this.links.has(file) || this.dirs.has(file)) throw new Error(`EEXIST ${file}`);
    this.links.set(file, target);
  }
  async unlink(file: string) {
    this.mutate('unlink', file);
    if (this.links.delete(file)) return;
    if (!this.files.delete(this.real(file))) throw new Error(`ENOENT ${file}`);
  }
  async mkdir(dir: string) {
    const real = this.real(dir);
    if (this.dirs.has(real)) return;
    this.mutate('mkdir', dir);
    let current = real;
    while (current !== '/' && !this.dirs.has(current)) {
      this.dirs.add(current);
      current = path.dirname(current);
    }
  }
  async removeTree(dir: string) {
    this.mutate('rmtree', dir);
    const real = this.real(dir);
    this.dirs = new Set([...this.dirs].filter((value) => value !== real && !value.startsWith(`${real}/`)));
    this.files = new Map([...this.files].filter(([key]) => !key.startsWith(`${real}/`)));
  }

  private byProject(project: string, service?: string) {
    return [...this.containers.values()].filter(
      (item) =>
        item.labels['com.docker.compose.project'] === project &&
        (service === undefined || item.labels['com.docker.compose.service'] === service)
    );
  }

  async compose(target: { project: string; dir: string; file: string; envFile?: string }, args: string[]) {
    const doc = parseDocument(await this.readFile(target.file));
    if (doc.errors.length) throw new Error(`invalid compose: ${doc.errors[0]!.message}`);
    const spec = doc.toJS() as {
      services: Record<
        string,
        { environment?: Record<string, string> | string[]; volumes?: string[]; ports?: string[] }
      >;
      volumes?: Record<string, { name?: string; external?: boolean } | null>;
    };
    if (args[0] === 'config') return;
    this.mutate('compose', `${target.project} ${args.join(' ')}`);
    const network = `${target.project}_default`;
    this.networks.add(network);
    const only = args.filter((arg) => !arg.startsWith('--'));
    const services = only.slice(1).length ? only.slice(1) : Object.keys(spec.services);
    const start = !args.includes('--no-start');
    const volumeName = (key: string) => {
      const declared = spec.volumes?.[key];
      const name = declared?.name ?? `${target.project}_${key}`;
      if (!this.volumes.has(name)) {
        if (declared?.external) throw new Error(`external volume ${name} not found`);
        this.volumes.add(name);
      }
      return name;
    };
    for (const service of services) {
      const definition = spec.services[service];
      if (!definition) throw new Error(`no such service ${service}`);
      let container = this.byProject(target.project, service)[0];
      if (!container) {
        const env = Array.isArray(definition.environment)
          ? definition.environment
          : Object.entries(definition.environment ?? {}).map(([key, value]) => `${key}=${value}`);
        const value = (key: string) => env.find((entry) => entry.startsWith(`${key}=`))?.slice(key.length + 1);
        const dataMount = (definition.volumes ?? []).find((entry) => /^(\w+):\/var\/lib\/postgresql\/data/.test(entry));
        container = {
          id: `c${this.nextId++}`,
          name: `${target.project}-${service}-1`,
          labels: {
            'com.docker.compose.project': target.project,
            'com.docker.compose.service': service,
            'com.docker.compose.project.working_dir': target.dir,
          },
          running: false,
          env,
          image: service,
          binds: [],
          restartPolicy: 'unless-stopped',
          networks: new Map([[network, [service]]]),
          ports: definition.ports ?? [],
          ...(dataMount ? { dataVolume: volumeName(dataMount.split(':')[0]!) } : {}),
          ...(service === 'app' ? { database: databaseIdentity(value('DATABASE_URL')) ?? undefined } : {}),
        };
        for (const entry of definition.volumes ?? []) {
          const key = entry.split(':')[0]!;
          if (spec.volumes && key in spec.volumes) volumeName(key);
        }
        this.containers.set(container.id, container);
      }
      if (start && !container.running) {
        for (const port of container.ports) {
          const taken = [...this.containers.values()].some(
            (other) => other !== container && other.running && other.ports.includes(port)
          );
          if (taken) throw new Error(`port ${port} is already allocated`);
        }
        container.running = true;
      }
    }
  }

  private view(item: Container): ServiceContainer {
    return {
      id: item.id,
      name: item.name,
      running: item.running,
      health: this.health(item),
      labels: { ...item.labels },
    };
  }

  private health(item: Container): string {
    if (!item.running) return 'exited';
    if (item.labels['com.docker.compose.service'] !== 'app') return 'healthy';
    const project = item.labels['com.docker.compose.project']!;
    if (this.unhealthy.has(project)) return 'unhealthy';
    const postgres = this.byProject(project, 'postgres')[0];
    const state = postgres?.dataVolume ? this.pg.get(postgres.dataVolume) : undefined;
    const ok =
      postgres?.running &&
      state &&
      item.database &&
      state.roles.has(item.database.role) &&
      state.databases.has(item.database.database);
    return ok ? 'healthy' : 'unhealthy';
  }

  async projectContainers(project: string) {
    return this.byProject(project).map((item) => this.view(item));
  }
  async containerByName(name: string) {
    const item = [...this.containers.values()].find((entry) => entry.name === name || entry.id === name);
    return item ? this.view(item) : null;
  }
  private get(id: string) {
    const item = this.containers.get(id) ?? [...this.containers.values()].find((entry) => entry.name === id);
    if (!item) throw new Error(`no such container ${id}`);
    return item;
  }

  async exec(id: string, command: string[]) {
    const item = this.get(id);
    if (!item.running) return { exitCode: 1, output: 'container is not running' };
    if (command[0] === 'pg_isready') return { exitCode: 0, output: '' };
    if (command[0] === 'psql') return this.psql(item, command);
    if (command[0] === 'clickhouse-client') return this.clickhouse(item, command.at(-1)!);
    if (command[0] === 'node') {
      const relay = this.byProject(item.labels['com.docker.compose.project']!, 'relay')[0];
      return { exitCode: relay?.running ? 0 : 1, output: '' };
    }
    throw new Error(`unexpected exec ${command.join(' ')}`);
  }

  private psql(item: Container, command: string[]) {
    const state = this.pg.get(item.dataVolume!)!;
    const role = command[command.indexOf('-U') + 1]!;
    const database = command[command.indexOf('-d') + 1]!;
    const sql = command.at(-1)!;
    if (!state.roles.has(role)) return { exitCode: 2, output: `FATAL: role "${role}" does not exist` };
    if (database !== 'postgres' && !state.databases.has(database)) {
      return { exitCode: 2, output: `FATAL: database "${database}" does not exist` };
    }
    const list = (values: Set<string>) => {
      const wanted = [...sql.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
      return { exitCode: 0, output: wanted.filter((value) => values.has(value)).join('\n') };
    };
    if (sql === 'SELECT 1') return { exitCode: 0, output: '1' };
    if (sql.startsWith('SELECT rolname')) return list(state.roles);
    if (sql.startsWith('SELECT datname')) return list(state.databases);
    if (sql.startsWith('SELECT pg_terminate_backend')) return { exitCode: 0, output: '' };
    this.mutate('sql', sql.slice(0, 40));
    let match = /^CREATE ROLE (\w+) SUPERUSER LOGIN$/.exec(sql);
    if (match) {
      if (state.roles.has(match[1]!)) return { exitCode: 1, output: 'role exists' };
      state.roles.add(match[1]!);
      return { exitCode: 0, output: '' };
    }
    match = /^ALTER DATABASE (\w+) RENAME TO (\w+)$/.exec(sql);
    if (match) {
      if (match[1] === database || !state.databases.has(match[1]!) || state.databases.has(match[2]!)) {
        return { exitCode: 1, output: 'cannot rename database' };
      }
      state.databases.delete(match[1]!);
      state.databases.add(match[2]!);
      return { exitCode: 0, output: '' };
    }
    match = /^ALTER ROLE (\w+) RENAME TO (\w+)$/.exec(sql);
    if (match) {
      if (match[1] === role || !state.roles.has(match[1]!) || state.roles.has(match[2]!)) {
        return { exitCode: 1, output: 'cannot rename role' };
      }
      state.roles.delete(match[1]!);
      state.roles.add(match[2]!);
      return { exitCode: 0, output: '' };
    }
    match = /^ALTER ROLE (\w+) PASSWORD '(.+)'$/.exec(sql);
    if (match) {
      state.passwords.set(match[1]!, match[2]!);
      return { exitCode: 0, output: '' };
    }
    match = /^DROP ROLE IF EXISTS (\w+)$/.exec(sql);
    if (match) {
      if (match[1] === role) return { exitCode: 1, output: 'current user cannot be dropped' };
      state.roles.delete(match[1]!);
      return { exitCode: 0, output: '' };
    }
    if (sql.startsWith('BEGIN; UPDATE settings')) {
      const to = /to_jsonb\('(\w+)'::text\)\) WHERE key = 'logging:clickhouse' AND value->>'database' = '(\w+)'/.exec(
        sql
      )!;
      if (state.logging.database === to[2]) state.logging.database = to[1]!;
      const hosts = /replace\(value->>'url', '\/\/([\w-]+):', '\/\/([\w-]+):'\)/.exec(sql)!;
      state.logging.url = state.logging.url.replace(`//${hosts[1]}:`, `//${hosts[2]}:`);
      return { exitCode: 0, output: '' };
    }
    throw new Error(`unexpected SQL ${sql}`);
  }

  private clickhouse(item: Container, sql: string) {
    const databases = this.ch.get(item.dataVolume!)!;
    if (sql.startsWith('SELECT name FROM system.databases')) {
      const wanted = [...sql.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
      return { exitCode: 0, output: wanted.filter((value) => databases.has(value)).join('\n') };
    }
    this.mutate('clickhouse', sql);
    const match = /^RENAME DATABASE (\w+) TO (\w+)$/.exec(sql);
    if (!match || !databases.has(match[1]!) || databases.has(match[2]!))
      return { exitCode: 1, output: 'rename failed' };
    databases.delete(match[1]!);
    databases.add(match[2]!);
    return { exitCode: 0, output: '' };
  }

  async stopContainer(id: string) {
    this.mutate('stop', id);
    this.get(id).running = false;
  }
  async startContainer(id: string) {
    this.mutate('start', id);
    this.get(id).running = true;
  }
  async removeContainer(id: string) {
    this.mutate('remove', id);
    this.containers.delete(this.get(id).id);
  }
  async createContainer(spec: ClickHouseSpec, network: string) {
    this.mutate('create', spec.name);
    if ([...this.containers.values()].some((item) => item.name === spec.name)) throw new Error('409 name in use');
    if (!this.networks.has(network)) throw new Error(`network ${network} not found`);
    const id = `c${this.nextId++}`;
    this.containers.set(id, {
      id,
      name: spec.name,
      labels: { ...spec.labels },
      running: false,
      env: [...spec.env],
      image: spec.image,
      binds: [...spec.binds],
      restartPolicy: spec.restartPolicy,
      networks: new Map([[network, [...spec.aliases]]]),
      dataVolume: spec.binds[0]!.split(':')[0],
      ports: [],
    });
    return id;
  }
  async clickHouseSpec(id: string): Promise<ClickHouseSpec> {
    const item = this.get(id);
    return {
      name: item.name,
      image: item.image,
      env: [...item.env],
      labels: { ...item.labels },
      binds: [...item.binds],
      restartPolicy: item.restartPolicy,
      logConfig: null,
      aliases: [...item.networks.values()].flat(),
      running: item.running,
    };
  }
  async networkMembers(network: string): Promise<NetworkMember[]> {
    return [...this.containers.values()]
      .filter((item) => item.networks.has(network))
      .map((item) => ({
        id: item.id,
        name: item.name,
        aliases: [...item.networks.get(network)!],
        labels: { ...item.labels },
        networkMode: item.networkMode ?? 'default',
      }));
  }
  async connectNetwork(network: string, id: string, aliases: string[]) {
    this.mutate('connect', `${network} ${id}`);
    if (!this.networks.has(network)) throw new Error(`network ${network} not found`);
    const container = this.get(id);
    // Docker resolves the container's own network mode on connect.
    if (container.networkMode && container.networkMode !== 'default' && !this.networks.has(container.networkMode))
      throw new Error(`could not find a network matching network mode ${container.networkMode}`);
    container.networks.set(network, [...aliases]);
  }
  async disconnectNetwork(network: string, id: string) {
    this.mutate('disconnect', `${network} ${id}`);
    this.get(id).networks.delete(network);
  }
  async removeNetwork(network: string) {
    if (!this.networks.has(network)) return;
    this.mutate('rmnetwork', network);
    if ([...this.containers.values()].some((item) => item.networks.has(network))) {
      throw new Error(`network ${network} has active endpoints`);
    }
    this.networks.delete(network);
  }
  async volumeNames() {
    return new Set(this.volumes);
  }
  async finish() {
    this.finished += 1;
  }
  async sleep(ms: number) {
    this.clock += ms;
  }
  now() {
    return new Date(this.clock);
  }
  log(_level: string, message: string) {
    this.logs.push(message);
  }

  /** What the installation looks like, for comparing before and after. */
  snapshot() {
    const containers = [...this.containers.values()]
      .map((item) => ({
        name: item.name,
        running: item.running,
        labels: item.labels,
        env: item.env.filter((entry) => entry.startsWith('CLICKHOUSE_DB=')),
        networks: Object.fromEntries(item.networks),
        dataVolume: item.dataVolume,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      files: Object.fromEntries(
        [...this.files].filter(([key]) => !key.includes('/.opfield-host-move/')).sort(([a], [b]) => a.localeCompare(b))
      ),
      dirs: [...this.dirs]
        .filter((dir) => !dir.includes('.opfield-host-move') && !dir.startsWith('/var/lib/opfield'))
        .sort(),
      links: Object.fromEntries(this.links),
      containers,
      networks: [...this.networks].sort(),
      volumes: [...this.volumes].sort(),
      pg: [...this.pg].map(([volume, state]) => ({
        volume,
        roles: [...state.roles].sort(),
        databases: [...state.databases].sort(),
        logging: state.logging,
      })),
      ch: [...this.ch].map(([volume, databases]) => ({ volume, databases: [...databases].sort() })),
    };
  }
}

const LEGACY_ENV = [
  'GATEWAY_IMAGE_REF=ghcr.io/opfield/opfield@sha256:aaa',
  'DB_PASSWORD=0123456789abcdef',
  'PKI_MASTER_KEY=ff',
  'GATEWAY_VERSION=v2.12.1',
  'GATEWAY_RELAY_IMAGE_REF=ghcr.io/opfield/opfield/relay@sha256:bbb',
  'GATEWAY_REGISTRY_HTTP_SECRET=secret',
  'SANDBOX_RUNNER_WORKSPACE_DIR=/var/lib/gateway/sandbox-workspaces',
  'GATEWAY_LOCAL_HOSTS=10.0.0.5',
  '',
].join('\n');

/** An installation as 2.12.0 left it, updated to 2.12.1 (whose migrator renamed the settings already or not). */
async function legacyInstallation(): Promise<FakeHost> {
  const host = new FakeHost();
  host.dirs.add(OLD_DIR);
  host.dirs.add(`${OLD_DIR}/.gateway-commercial`);
  host.files.set(`${OLD_DIR}/.gateway-commercial/prepared.json`, '{}');
  host.files.set(`${OLD_DIR}/docker-compose.yml`, LEGACY_COMPOSE);
  host.files.set(`${OLD_DIR}/.env`, LEGACY_ENV);
  host.pg.set('gateway_postgres_data', {
    roles: new Set(['gateway']),
    databases: new Set(['gateway']),
    logging: { database: 'gateway_logs', url: 'http://gateway-clickhouse:8123/' },
    passwords: new Map(),
  });
  await host.compose({ project: 'gateway', dir: OLD_DIR, file: `${OLD_DIR}/docker-compose.yml` }, ['up', '--detach']);
  host.volumes.add('gateway_clickhouse_data');
  host.ch.set('gateway_clickhouse_data', new Set(['gateway_logs']));
  host.containers.set('ch', {
    id: 'ch',
    name: 'gateway-clickhouse',
    labels: { 'net.wiolett.gateway.managed': 'clickhouse', 'net.wiolett.gateway.owner': 'gateway' },
    running: true,
    env: ['CLICKHOUSE_DB=gateway_logs', 'CLICKHOUSE_USER=gateway'],
    image: 'clickhouse/clickhouse-server:26.2.10.10',
    binds: ['gateway_clickhouse_data:/var/lib/clickhouse'],
    restartPolicy: 'unless-stopped',
    networks: new Map([['gateway_default', ['gateway-clickhouse']]]),
    dataVolume: 'gateway_clickhouse_data',
    ports: [],
  });
  host.containers.set('sbx', {
    id: 'sbx',
    name: 'sandbox-run-1',
    labels: {},
    running: true,
    env: [],
    image: 'sandbox',
    binds: [],
    restartPolicy: 'no',
    networks: new Map([['gateway_default', ['sandbox-run']]]),
    ports: [],
  });
  host.operations = 0;
  return host;
}

/** A container someone ran with `docker run --network <legacy project>_default` (Mailpit on the e2e stand). */
function addPinnedMailpit(host: FakeHost): void {
  host.containers.set('mail', {
    id: 'mail',
    name: 'gateway-e2e-mailpit',
    labels: {},
    running: true,
    env: [],
    image: 'axllent/mailpit',
    binds: [],
    restartPolicy: 'unless-stopped',
    networks: new Map([['gateway_default', ['mailpit']]]),
    networkMode: 'gateway_default',
    ports: [],
  });
  host.operations = 0;
}

function expectPinnedMailpit(host: FakeHost, networks: string[]): void {
  const snapshot = host.snapshot();
  expect(snapshot.networks).toEqual(networks);
  expect(snapshot.containers.find((item) => item.name === 'gateway-e2e-mailpit')!.networks).toEqual(
    Object.fromEntries(networks.map((network) => [network, ['mailpit']]))
  );
}

const TARGET = { dir: OLD_DIR, project: 'gateway', network: 'gateway_default' };

/** Runs the move like Docker runs its container: a crashed run is started again until the move reaches its end. */
async function runToEnd(host: FakeHost): Promise<HostMovePhase> {
  for (let run = 0; run < 40; run += 1) {
    try {
      let state = await readHostMoveState(host, { oldDir: OLD_DIR, newDir: NEW_DIR });
      if (!state) {
        state = await planHostMove(host, TARGET);
        if (!state) return 'done';
      }
      return await runHostMove(host, state);
    } catch (error) {
      if (error instanceof HostMoveCrash) {
        host.crashAt = null;
        continue;
      }
      // A run that could not finish going back: Docker starts it again.
      if (error instanceof Error && /^Going back failed/.test(error.message)) continue;
      throw error;
    }
  }
  throw new Error('the move never reached its end');
}

function expectOpfieldLayout(host: FakeHost) {
  const snapshot = host.snapshot();
  expect(snapshot.links).toEqual({ [OLD_DIR]: NEW_DIR });
  expect(snapshot.dirs).toContain(NEW_DIR);
  expect(snapshot.dirs).toContain(`${NEW_DIR}/.opfield-commercial`);
  expect(snapshot.dirs).not.toContain(`${NEW_DIR}/.gateway-commercial`);
  const compose = snapshot.files[`${NEW_DIR}/docker-compose.yml`]!;
  expect(compose).toMatch(/^name: opfield$/m);
  expect(compose).not.toMatch(/GATEWAY_|com\.wiolett/);
  const env = snapshot.files[`${NEW_DIR}/.env`]!;
  expect(env).not.toMatch(/^GATEWAY_/m);
  expect(env).toContain('OPFIELD_IMAGE_REF=ghcr.io/opfield/opfield@sha256:aaa');
  expect(env).toContain('SANDBOX_RUNNER_WORKSPACE_DIR=/var/lib/opfield/sandbox-workspaces');
  expect(snapshot.networks).toEqual(['opfield_default']);
  const names = snapshot.containers.map((item) => item.name);
  expect(names).toEqual([
    'opfield-app-1',
    'opfield-clickhouse',
    'opfield-postgres-1',
    'opfield-redis-1',
    'opfield-registry-1',
    'opfield-relay-1',
    'sandbox-run-1',
  ]);
  expect(snapshot.containers.every((item) => item.running)).toBe(true);
  const clickhouse = snapshot.containers.find((item) => item.name === 'opfield-clickhouse')!;
  expect(clickhouse.labels).toEqual({ 'net.opfield.managed': 'clickhouse', 'net.opfield.owner': 'opfield' });
  expect(clickhouse.env).toEqual(['CLICKHOUSE_DB=opfield_logs']);
  expect(clickhouse.networks).toEqual({ opfield_default: ['opfield-clickhouse'] });
  expect(clickhouse.dataVolume).toBe('gateway_clickhouse_data');
  expect(snapshot.containers.find((item) => item.name === 'sandbox-run-1')!.networks).toEqual({
    opfield_default: ['sandbox-run'],
  });
  // Data stays in the volumes it was in.
  expect(snapshot.containers.find((item) => item.name === 'opfield-postgres-1')!.dataVolume).toBe(
    'gateway_postgres_data'
  );
  expect(snapshot.volumes.filter((volume) => volume.startsWith('opfield_'))).toEqual([]);
  expect(snapshot.pg).toEqual([
    {
      volume: 'gateway_postgres_data',
      roles: ['opfield'],
      databases: ['opfield'],
      logging: { database: 'opfield_logs', url: 'http://opfield-clickhouse:8123/' },
    },
  ]);
  expect(snapshot.ch).toEqual([{ volume: 'gateway_clickhouse_data', databases: ['opfield_logs'] }]);
}

describe('host move to the Opfield layout', () => {
  it('moves directory, project, database, ClickHouse and attached containers, keeping the volumes', async () => {
    const host = await legacyInstallation();
    expect(await runToEnd(host)).toBe('done');
    expectOpfieldLayout(host);
    expect(host.finished).toBeGreaterThan(0);
    const verifier = host.pg.get('gateway_postgres_data')!.passwords.get('opfield')!;
    expect(verifier).toMatch(/^SCRAM-SHA-256\$4096:/);
    // Nothing more to do afterwards.
    const operations = host.operations;
    expect(await runToEnd(host)).toBe('done');
    expect(host.operations).toBe(operations);
  });

  it('keeps the earlier network for a container created on it and joins it to the new one too', async () => {
    const host = await legacyInstallation();
    addPinnedMailpit(host);
    expect(await runToEnd(host)).toBe('done');
    expectPinnedMailpit(host, ['gateway_default', 'opfield_default']);
    expect(host.snapshot().containers.find((item) => item.name === 'sandbox-run-1')!.networks).toEqual({
      opfield_default: ['sandbox-run'],
    });
  });

  it('moves with a container created on the earlier network through a crash at any point', async () => {
    const reference = await legacyInstallation();
    addPinnedMailpit(reference);
    await runToEnd(reference);
    const total = reference.operations;
    for (let crashAt = 1; crashAt <= total; crashAt += 1) {
      const host = await legacyInstallation();
      addPinnedMailpit(host);
      host.crashAt = crashAt;
      expect(await runToEnd(host), `crash before operation ${crashAt}`).toBe('done');
      expectPinnedMailpit(host, ['gateway_default', 'opfield_default']);
    }
  });

  it('goes back with a container created on the earlier network still on it', async () => {
    const host = await legacyInstallation();
    addPinnedMailpit(host);
    const before = host.snapshot();
    host.failing = (operation, detail) => operation === 'compose' && detail === 'opfield up --detach';
    expect(await runToEnd(host)).toBe('rolled_back');
    host.failing = null;
    expect(host.snapshot()).toEqual(before);
  });

  it('resumes after a crash before any of its operations and still ends in the Opfield layout', async () => {
    const reference = await legacyInstallation();
    await runToEnd(reference);
    const total = reference.operations;
    expect(total).toBeGreaterThan(20);
    for (let crashAt = 1; crashAt <= total; crashAt += 1) {
      const host = await legacyInstallation();
      host.crashAt = crashAt;
      const phase = await runToEnd(host);
      expect(phase, `crash before operation ${crashAt}`).toBe('done');
      expectOpfieldLayout(host);
    }
  });

  const failures: Array<[string, (operation: string, detail: string) => boolean]> = [
    ['the database rename', (operation, detail) => operation === 'sql' && detail.startsWith('ALTER DATABASE gateway')],
    ['the ClickHouse rename', (operation, detail) => operation === 'clickhouse' && detail.includes('TO opfield_logs')],
    ['removing the old network', (operation) => operation === 'rmnetwork'],
    ['moving the directory', (operation, detail) => operation === 'rename' && detail === `${OLD_DIR} -> ${NEW_DIR}`],
    [
      'writing the new files',
      (operation, detail) => operation === 'write' && detail === `${NEW_DIR}/docker-compose.yml`,
    ],
    ['starting the new stack', (operation, detail) => operation === 'compose' && detail === 'opfield up --detach'],
    ['creating ClickHouse', (operation, detail) => operation === 'create' && detail === 'opfield-clickhouse'],
  ];

  for (const [name, failing] of failures) {
    it(`goes back to the earlier layout when ${name} keeps failing`, async () => {
      const host = await legacyInstallation();
      const before = host.snapshot();
      host.failing = failing;
      expect(await runToEnd(host)).toBe('rolled_back');
      host.failing = null;
      expect(host.snapshot()).toEqual(before);
    });
  }

  it('goes back when the new stack never becomes healthy', async () => {
    const host = await legacyInstallation();
    const before = host.snapshot();
    host.unhealthy.add('opfield');
    expect(await runToEnd(host)).toBe('rolled_back');
    expect(host.snapshot()).toEqual(before);
  });

  it('goes back when the role rename keeps failing after the database was renamed', async () => {
    const host = await legacyInstallation();
    const before = host.snapshot();
    host.failing = (operation, detail) => operation === 'sql' && detail.startsWith('ALTER ROLE gateway RENAME');
    expect(await runToEnd(host)).toBe('rolled_back');
    host.failing = null;
    expect(host.snapshot()).toEqual(before);
  });

  it('survives a crash at any point while it goes back', async () => {
    const failing = (operation: string, detail: string) => operation === 'compose' && detail === 'opfield up --detach';
    const reference = await legacyInstallation();
    const before = reference.snapshot();
    reference.failing = failing;
    await runToEnd(reference);
    const total = reference.operations;
    for (let crashAt = 1; crashAt <= total; crashAt += 1) {
      const host = await legacyInstallation();
      host.failing = failing;
      host.crashAt = crashAt;
      const phase = await runToEnd(host);
      host.failing = null;
      // Every crash counts as an interrupted run; the move ends either way, in one complete layout.
      expect(phase, `crash before operation ${crashAt}`).toBe('rolled_back');
      expect(host.snapshot(), `crash before operation ${crashAt}`).toEqual(before);
    }
  });

  it('goes back after it was interrupted too often', async () => {
    const host = await legacyInstallation();
    const before = host.snapshot();
    const state = (await planHostMove(host, TARGET))!;
    state.runs = 3;
    expect(await runHostMove(host, state)).toBe('rolled_back');
    expect(host.snapshot()).toEqual(before);
  });

  it('changes nothing when it cannot plan', async () => {
    const host = await legacyInstallation();
    const before = host.snapshot();
    host.files.set(`${OLD_DIR}/docker-compose.yml`, LEGACY_COMPOSE.replace('services:', 'services:\n  - broken'));
    await expect(planHostMove(host, TARGET)).rejects.toThrow();
    host.files.set(`${OLD_DIR}/docker-compose.yml`, LEGACY_COMPOSE);
    expect(host.snapshot()).toEqual(before);
  });

  it('never moves a source checkout that builds its app', async () => {
    const host = await legacyInstallation();
    host.files.set(
      `${OLD_DIR}/docker-compose.yml`,
      LEGACY_COMPOSE.replace('    image: ${GATEWAY_IMAGE_REF}\n', '    build: .\n')
    );
    const before = host.snapshot();
    await expect(planHostMove(host, TARGET)).rejects.toThrow(/not an installer-managed/);
    expect(host.snapshot()).toEqual(before);
  });

  it('keeps the directory when /opt/opfield exists already and still moves the rest', async () => {
    const host = await legacyInstallation();
    host.dirs.add(NEW_DIR);
    expect(await runToEnd(host)).toBe('done');
    const snapshot = host.snapshot();
    expect(snapshot.links).toEqual({});
    expect(snapshot.files[`${OLD_DIR}/docker-compose.yml`]).toMatch(/^name: opfield$/m);
    expect(
      snapshot.containers.find((item) => item.name === 'opfield-app-1')?.labels[
        'com.docker.compose.project.working_dir'
      ]
    ).toBe(OLD_DIR);
  });
});

/** Backups of earlier updates: 2.12.0's under the old name, 2.12.1's own already under the Opfield one. */
function addBackups(host: FakeHost, opfield: boolean): void {
  const legacy = `${OLD_DIR}/.gateway-foundation-backups`;
  for (const [dir, file] of [
    [`${legacy}/pre-update-a`, 'gateway-db.dump'],
    [`${legacy}/2026-10-01T00-00-00-000Z`, '.env'],
  ] as const) {
    host.dirs.add(legacy);
    host.dirs.add(dir);
    host.files.set(`${dir}/${file}`, 'earlier');
  }
  if (opfield) {
    const current = `${OLD_DIR}/.opfield-foundation-backups`;
    for (const dir of [current, `${current}/pre-update-a`, `${current}/2026-10-13T00-00-00-000Z`]) host.dirs.add(dir);
    host.files.set(`${current}/pre-update-a/opfield-db.dump`, 'current');
    host.files.set(`${current}/2026-10-13T00-00-00-000Z/docker-compose.yml`, 'current');
  }
  host.operations = 0;
}

function backupFiles(host: FakeHost): Record<string, string> {
  return Object.fromEntries(
    Object.entries(host.snapshot().files).filter(([file]) => file.includes('-foundation-backups/'))
  );
}

describe('host move: backups and file modes', () => {
  it('folds the backups of earlier updates into the Opfield backups directory through a crash at any point', async () => {
    const reference = await legacyInstallation();
    addBackups(reference, true);
    expect(await runToEnd(reference)).toBe('done');
    const total = reference.operations;
    for (let crashAt = 0; crashAt <= total; crashAt += 1) {
      const host = await legacyInstallation();
      addBackups(host, true);
      if (crashAt > 0) host.crashAt = crashAt;
      expect(await runToEnd(host), `crash before operation ${crashAt}`).toBe('done');
      expect(backupFiles(host), `crash before operation ${crashAt}`).toEqual({
        [`${NEW_DIR}/.opfield-foundation-backups/2026-10-01T00-00-00-000Z/.env`]: 'earlier',
        [`${NEW_DIR}/.opfield-foundation-backups/2026-10-13T00-00-00-000Z/docker-compose.yml`]: 'current',
        [`${NEW_DIR}/.opfield-foundation-backups/pre-update-a.earlier/gateway-db.dump`]: 'earlier',
        [`${NEW_DIR}/.opfield-foundation-backups/pre-update-a/opfield-db.dump`]: 'current',
      });
      expect(host.snapshot().dirs).not.toContain(`${NEW_DIR}/.gateway-foundation-backups`);
    }
  });

  it('renames the earlier backups directory when there is no Opfield one yet', async () => {
    const host = await legacyInstallation();
    addBackups(host, false);
    expect(await runToEnd(host)).toBe('done');
    expect(Object.keys(backupFiles(host)).sort()).toEqual([
      `${NEW_DIR}/.opfield-foundation-backups/2026-10-01T00-00-00-000Z/.env`,
      `${NEW_DIR}/.opfield-foundation-backups/pre-update-a/gateway-db.dump`,
    ]);
    expect(host.snapshot().dirs).not.toContain(`${NEW_DIR}/.gateway-foundation-backups`);
  });

  it('keeps the folded backups when the move goes back', async () => {
    const host = await legacyInstallation();
    addBackups(host, true);
    host.failing = (operation, detail) => operation === 'compose' && detail === 'opfield up --detach';
    expect(await runToEnd(host)).toBe('rolled_back');
    expect(
      Object.keys(backupFiles(host)).every((file) => file.startsWith(`${OLD_DIR}/.opfield-foundation-backups/`))
    ).toBe(true);
    expect(Object.keys(backupFiles(host))).toHaveLength(4);
  });

  it('writes docker-compose.yml and .env for root only, moving and going back', async () => {
    const moved = await legacyInstallation();
    expect(await runToEnd(moved)).toBe('done');
    expect(moved.modes.get(`${NEW_DIR}/docker-compose.yml`)).toBe(0o600);
    expect(moved.modes.get(`${NEW_DIR}/.env`)).toBe(0o600);

    const back = await legacyInstallation();
    back.failing = (operation, detail) => operation === 'compose' && detail === 'opfield up --detach';
    expect(await runToEnd(back)).toBe('rolled_back');
    expect(back.modes.get(`${OLD_DIR}/docker-compose.yml`)).toBe(0o600);
    expect(back.modes.get(`${OLD_DIR}/.env`)).toBe(0o600);
  });
});

describe('host move helpers', () => {
  it('knows which installations move and where to', () => {
    expect(hostMoveNewDir('/opt/gateway')).toBe('/opt/opfield');
    expect(hostMoveNewDir('/srv/stack')).toBe('/srv/stack');
    expect(needsHostMove({ dir: '/opt/gateway', project: 'gateway', compose: LEGACY_COMPOSE })).toBe(true);
    const opfield =
      'name: opfield\nservices:\n  app:\n    environment:\n      DATABASE_URL: postgres://opfield:${DB_PASSWORD}@postgres:5432/opfield\n';
    expect(needsHostMove({ dir: '/opt/opfield', project: 'opfield', compose: opfield })).toBe(false);
    expect(needsHostMove({ dir: '/opt/opfield', project: 'opfield', compose: LEGACY_COMPOSE })).toBe(true);
    expect(composeDatabase(LEGACY_COMPOSE)).toEqual({ role: 'gateway', database: 'gateway' });
    expect(composeDatabase(opfield)).toEqual({ role: 'opfield', database: 'opfield' });
  });

  it('writes a SCRAM-SHA-256 verifier Postgres accepts for the password', () => {
    const salt = Buffer.from('0123456789abcdef');
    const verifier = scramVerifier('secret', salt);
    const [, iterations, saltB64, storedB64, serverB64] = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(
      verifier
    )!;
    expect(iterations).toBe('4096');
    expect(Buffer.from(saltB64!, 'base64')).toEqual(salt);
    const salted = pbkdf2Sync('secret', salt, 4096, 32, 'sha256');
    const clientKey = createHmac('sha256', salted).update('Client Key').digest();
    expect(storedB64).toBe(createHash('sha256').update(clientKey).digest('base64'));
    expect(serverB64).toBe(createHmac('sha256', salted).update('Server Key').digest('base64'));
  });
});
