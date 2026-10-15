import { posix } from 'node:path';
import { commandText, type EffectiveCommand } from './ai.console-commands.js';
import { has, type Parsed, parseOptions, resolvePath, optionSet as set, values } from './ai.console-options.js';
import { commandBaseName, type ShellWord } from './ai.console-shell.js';
import { protectedStateWrites } from './ai.console-state-paths.js';

/**
 * What a console command would change among the Docker objects of a node, or in the state the node's daemons keep,
 * read from its command line only. Whether those objects are Opfield-managed is decided by the caller against the
 * node's inventory; read-only commands (ps, inspect, logs, stats, images, ...) produce nothing.
 */
export type ConsoleMutationKind = 'container' | 'run' | 'network' | 'volume' | 'prune' | 'compose' | 'state_path';

export interface ConsoleMutation {
  kind: ConsoleMutationKind;
  /** The CLI verb as typed (`rm`, `container rm`, `compose up`, `network connect`), or the file tool. */
  verb: string;
  command: string;
  /** Containers named on the command line (names, IDs or ID prefixes). */
  containers: string[];
  networks: string[];
  volumes: string[];
  /** Host ports a `run`/`create` publishes. */
  ports: number[];
  /** `run`/`create --name`, and the new name of a `rename`. */
  name: string | null;
  /** Compose project the command acts on; null when it cannot be told. */
  project: string | null;
  /** state_path: the protected path written or removed. */
  path: string | null;
  /** Some targets are only known at run time (`$VAR`, `$(...)`, globs, xargs, `--all`). */
  unresolved: boolean;
}

const DOCKER_CLIS = new Set(['docker', 'podman', 'nerdctl', 'com.docker.cli']);
const COMPOSE_CLIS = new Set(['docker-compose', 'podman-compose']);

const GLOBAL_VALUE_OPTIONS = set(
  '-H',
  '--host',
  '-c',
  '--context',
  '--config',
  '-l',
  '--log-level',
  '--tlscacert',
  '--tlscert',
  '--tlskey',
  '--url',
  '--connection',
  '--identity',
  '--root',
  '--runroot',
  '--storage-driver',
  '--storage-opt',
  '--cgroup-manager',
  '--events-backend',
  '--runtime',
  '--namespace',
  '-n',
  '--address',
  '-a',
  '--snapshotter',
  '--cni-path',
  '--cni-netconfpath',
  '--data-root'
);

const CONTAINER_VERB_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
  rm: set('-t', '--time', '--cidfile', '--depend'),
  stop: set('-t', '--time', '--timeout', '-s', '--signal', '--cidfile'),
  restart: set('-t', '--time', '--timeout', '-s', '--signal', '--cidfile'),
  kill: set('-s', '--signal', '--cidfile'),
  start: set('--detach-keys', '--checkpoint', '--checkpoint-dir', '--filter'),
  pause: set('--cidfile'),
  unpause: set('--cidfile'),
  rename: set(),
  update: set(
    '--blkio-weight',
    '--cpu-period',
    '--cpu-quota',
    '--cpu-rt-period',
    '--cpu-rt-runtime',
    '-c',
    '--cpu-shares',
    '--cpus',
    '--cpuset-cpus',
    '--cpuset-mems',
    '-m',
    '--memory',
    '--memory-reservation',
    '--memory-swap',
    '--pids-limit',
    '--restart',
    '--kernel-memory'
  ),
};
const CONTAINER_VERB_ALIASES: Record<string, string> = { remove: 'rm' };

const RUN_VALUE_OPTIONS = set(
  ...'-a -c -e -h -l -m -p -u -v -w'.split(' '),
  ...(
    'attach add-host annotation blkio-weight blkio-weight-device cap-add cap-drop cgroup-parent ' +
    'cgroupns cidfile cpu-period cpu-quota cpu-rt-period cpu-rt-runtime cpu-shares cpus cpuset-cpus ' +
    'cpuset-mems detach-keys device device-cgroup-rule device-read-bps device-read-iops ' +
    'device-write-bps device-write-iops dns dns-option dns-search domainname entrypoint env env-file ' +
    'expose gpus group-add health-cmd health-interval health-retries health-start-period ' +
    'health-start-interval health-timeout hostname ip ip6 ipc isolation kernel-memory label ' +
    'label-file link link-local-ip log-driver log-opt mac-address memory memory-reservation ' +
    'memory-swap memory-swappiness mount name network net network-alias net-alias oom-score-adj pid ' +
    'pids-limit platform publish pull restart runtime security-opt shm-size stop-signal stop-timeout ' +
    'storage-opt sysctl tmpfs ulimit user userns uts volume volume-driver volumes-from workdir pod ' +
    'arch os variant'
  )
    .split(' ')
    .map((name) => `--${name}`)
);

const COMPOSE_VALUE_OPTIONS = set(
  '-p',
  '--project-name',
  '-f',
  '--file',
  '--project-directory',
  '--env-file',
  '--profile',
  '--ansi',
  '--parallel',
  '--progress'
);
const COMPOSE_MUTATING = set(
  'up',
  'down',
  'rm',
  'restart',
  'stop',
  'start',
  'kill',
  'pause',
  'unpause',
  'pull',
  'create',
  'run',
  'scale',
  'watch'
);

function emptyMutation(kind: ConsoleMutationKind, verb: string, command: EffectiveCommand): ConsoleMutation {
  return {
    kind,
    verb,
    command: commandText(command),
    containers: [],
    networks: [],
    volumes: [],
    ports: [],
    name: null,
    project: null,
    path: null,
    unresolved: command.extraArgs,
  };
}

/** Host ports of a `-p`/`--publish` value: `8080:80`, `0.0.0.0:8080:80/tcp`, `[::1]:80-81:80-81`, `published=8080`. */
export function publishedHostPorts(value: string): number[] {
  let spec = value.trim();
  if (spec.includes('=')) {
    const published = /(?:^|,)published=([0-9-]+)/.exec(spec);
    spec = published ? `${published[1]}:0` : '';
  }
  spec = spec.replace(/\/[a-z]+$/i, '');
  if (spec.startsWith('[')) spec = spec.slice(spec.indexOf(']') + 1).replace(/^:/, '');
  const parts = spec.split(':');
  if (parts.length < 2) return [];
  const host = parts[parts.length - 2];
  const range = /^(\d+)(?:-(\d+))?$/.exec(host);
  if (!range) return [];
  const first = Number(range[1]);
  const last = Math.min(Number(range[2] ?? range[1]), first + 1024);
  const ports: number[] = [];
  for (let port = first; port <= last && port <= 65535; port++) if (port > 0) ports.push(port);
  return ports;
}

/** Named volume of a `-v` or `--mount` value (bind mounts and anonymous volumes have none). */
export function namedVolume(value: string, mount: boolean): string | null {
  if (mount) {
    const fields = new Map(
      value.split(',').map((field) => {
        const eq = field.indexOf('=');
        return eq < 0 ? [field, ''] : [field.slice(0, eq), field.slice(eq + 1)];
      })
    );
    const type = fields.get('type') ?? 'volume';
    const source = fields.get('source') ?? fields.get('src') ?? '';
    return type === 'volume' && source ? source : null;
  }
  const colon = value.indexOf(':');
  if (colon <= 0) return null;
  const source = value.slice(0, colon);
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(source) ? source : null;
}

function composeProjectName(value: string): string | null {
  const name = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[^a-z0-9]+/, '');
  return name || null;
}

function composeProject(parsed: Parsed, command: EffectiveCommand, dynamicOption: boolean): string | null {
  if (dynamicOption) return null;
  const explicit = values(parsed, '-p', '--project-name').at(-1);
  if (explicit) return composeProjectName(explicit);
  if (command.env.COMPOSE_PROJECT_NAME) return composeProjectName(command.env.COMPOSE_PROJECT_NAME);
  const directory = values(parsed, '--project-directory').at(-1);
  if (directory) {
    const resolved = resolvePath(command.cwd, directory);
    return resolved ? composeProjectName(posix.basename(resolved)) : null;
  }
  const file = values(parsed, '-f', '--file').at(0) ?? command.env.COMPOSE_FILE?.split(':')[0];
  if (file && file !== '-') {
    const resolved = resolvePath(command.cwd, file);
    if (resolved) return composeProjectName(posix.basename(posix.dirname(resolved)));
    if (!file.includes('/')) return command.cwd ? composeProjectName(posix.basename(command.cwd)) : null;
    return composeProjectName(posix.basename(posix.dirname(file)));
  }
  return command.cwd ? composeProjectName(posix.basename(command.cwd)) : null;
}

function composeMutation(list: ShellWord[], command: EffectiveCommand, verbPrefix: string): ConsoleMutation | null {
  const index = list.findIndex((word, i) => {
    if (word.text.startsWith('-')) return false;
    const previous = list[i - 1]?.text ?? '';
    return !(COMPOSE_VALUE_OPTIONS.has(previous) && !previous.includes('='));
  });
  if (index < 0) return null;
  const subcommand = list[index].text;
  if (!COMPOSE_MUTATING.has(subcommand)) return null;
  const head = list.slice(0, index);
  const parsed = parseOptions(head, COMPOSE_VALUE_OPTIONS);
  const mutation = emptyMutation('compose', `${verbPrefix}${subcommand}`, command);
  mutation.project = composeProject(
    parsed,
    command,
    head.some((word) => word.dynamic)
  );
  mutation.unresolved ||= mutation.project === null;
  return mutation;
}

function runMutation(verb: string, list: ShellWord[], command: EffectiveCommand): ConsoleMutation {
  const parsed = parseOptions(list, RUN_VALUE_OPTIONS, true);
  const mutation = emptyMutation('run', verb, command);
  const name = values(parsed, '--name').at(-1);
  mutation.name = name ?? null;
  mutation.ports = values(parsed, '-p', '--publish').flatMap(publishedHostPorts);
  mutation.volumes = [
    ...values(parsed, '-v', '--volume').map((value) => namedVolume(value, false)),
    ...values(parsed, '--mount').map((value) => namedVolume(value, true)),
  ].filter((value): value is string => !!value);
  mutation.containers = values(parsed, '--volumes-from').map((value) => value.split(':')[0]);
  mutation.unresolved ||= list.slice(0, list.length - parsed.rest.length).some((word) => word.dynamic);
  return mutation;
}

function containerMutation(base: string, label: string, list: ShellWord[], command: EffectiveCommand): ConsoleMutation {
  const parsed = parseOptions(list, CONTAINER_VERB_VALUE_OPTIONS[base] ?? set());
  const mutation = emptyMutation('container', label, command);
  const targets = base === 'rename' ? parsed.positionals.slice(0, 1) : parsed.positionals;
  mutation.containers = targets.map((word) => word.text);
  if (base === 'rename') mutation.name = parsed.positionals[1]?.text ?? null;
  // podman and nerdctl act on every container with --all, and on the newest with --latest (start -a attaches).
  const bulk = base === 'start' ? has(parsed, '--all', '--latest') : has(parsed, '-a', '--all', '--latest');
  mutation.unresolved ||= targets.some((word) => word.dynamic) || bulk;
  return mutation;
}

function networkMutation(verb: string, list: ShellWord[], command: EffectiveCommand): ConsoleMutation | null {
  if (verb === 'prune') return emptyMutation('prune', 'network prune', command);
  const parsed = parseOptions(
    list,
    set('--alias', '--driver-opt', '--ip', '--ip6', '--link', '--link-local-ip', '--filter')
  );
  const mutation = emptyMutation('network', `network ${verb}`, command);
  if (verb === 'connect' || verb === 'disconnect') {
    mutation.networks = parsed.positionals.slice(0, 1).map((word) => word.text);
    mutation.containers = parsed.positionals.slice(1, 2).map((word) => word.text);
  } else if (verb === 'rm' || verb === 'remove') {
    mutation.networks = parsed.positionals.map((word) => word.text);
  } else {
    return null;
  }
  mutation.unresolved ||= parsed.positionals.some((word) => word.dynamic);
  return mutation;
}

function volumeMutation(verb: string, list: ShellWord[], command: EffectiveCommand): ConsoleMutation | null {
  if (verb === 'prune') return emptyMutation('prune', 'volume prune', command);
  if (verb !== 'rm' && verb !== 'remove') return null;
  const parsed = parseOptions(list, set());
  const mutation = emptyMutation('volume', `volume ${verb}`, command);
  mutation.volumes = parsed.positionals.map((word) => word.text);
  mutation.unresolved ||= parsed.positionals.some((word) => word.dynamic) || has(parsed, '-a', '--all');
  return mutation;
}

function dockerMutation(command: EffectiveCommand): ConsoleMutation | null {
  const program = commandBaseName(command.argv[0]);
  if (COMPOSE_CLIS.has(program)) return composeMutation(command.argv.slice(1), command, 'compose ');
  if (!DOCKER_CLIS.has(program)) return null;
  const list = command.argv.slice(1);
  let index = 0;
  while (index < list.length && list[index].text.startsWith('-')) {
    const text = list[index].text;
    index += !text.includes('=') && GLOBAL_VALUE_OPTIONS.has(text) ? 2 : 1;
  }
  const word = list[index];
  if (!word || word.dynamic) return null;
  const sub = word.text;
  const rest = list.slice(index + 1);
  const object = ['container', 'network', 'volume', 'system', 'compose', 'pod'].includes(sub) ? sub : null;
  if (sub === 'compose') return composeMutation(rest, command, 'compose ');
  const verbWord = object ? rest[0] : word;
  if (!verbWord) return null;
  const verb = verbWord.text;
  const args = object ? rest.slice(1) : rest;
  if (object === 'network') return networkMutation(verb, args, command);
  if (object === 'volume') return volumeMutation(verb, args, command);
  if (object === 'system') return verb === 'prune' ? emptyMutation('prune', 'system prune', command) : null;
  if (object === 'pod') return null;
  const label = object ? `container ${verb}` : verb;
  if (verb === 'prune' && object === 'container') return emptyMutation('prune', label, command);
  if (verb === 'run' || verb === 'create') return runMutation(label, args, command);
  const base = CONTAINER_VERB_ALIASES[verb] ?? verb;
  if (Object.hasOwn(CONTAINER_VERB_VALUE_OPTIONS, base)) return containerMutation(base, label, args, command);
  return null;
}

/** The changes to Docker objects and daemon state that the given programs would make. */
export function consoleMutations(commands: readonly EffectiveCommand[]): ConsoleMutation[] {
  const out: ConsoleMutation[] = [];
  for (const command of commands) {
    const docker = command.argv.length > 0 ? dockerMutation(command) : null;
    if (docker) out.push(docker);
    for (const { verb, path } of protectedStateWrites(command)) {
      out.push({ ...emptyMutation('state_path', verb, command), path });
    }
  }
  return out;
}
