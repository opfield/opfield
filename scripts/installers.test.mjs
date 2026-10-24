// Node installers: every one parses, defines each function before the code that runs it at the top level, and
// completes a --dry-run for each profile, as root and with --user, with the host access switches, with its settings
// from the environment, and through setup-daemon.sh for each node type; every installer prints its help. The dry runs
// use a copy of the scripts whose root check passes for any user and whose host paths are under an empty directory,
// stub commands for docker, nginx and curl, and no network; a dry run changes nothing on the host.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { LEGACY_UPDATE_KEY_ID } from '../packages/backend/src/lib/legacy-compat.ts';

// Values of scripts/legacy-compat.sh (the pre-2.12.1 names the installers still recognise), by variable name.
const LEGACY = Object.fromEntries(
  [...readFileSync(path.resolve('scripts/legacy-compat.sh'), 'utf8').matchAll(/^(LEGACY_\w+)=("([^"]*)"|\S+)/gm)].map((m) => [
    m[1],
    m[3] ?? m[2],
  ])
);
const scriptsDir = path.resolve('scripts');
const installers = (await readdir(scriptsDir)).filter((name) => /^setup-.*\.sh$/.test(name)).sort();
const linux = process.platform === 'linux';
const CERT = `sha256:${'a'.repeat(64)}`;
const VERSION = 'v2.11.1';

// Top-level functions with their definition line and the functions their bodies call, and the top-level lines that
// run (outside function bodies and heredocs) with the functions they call.
function parseShell(source) {
  const lines = source.split('\n');
  const names = new Set();
  for (const line of lines) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\(\) \{/.exec(line);
    if (match) names.add(match[1]);
  }
  const functions = new Map();
  const topLevel = [];
  let current = null;
  let heredoc = null;
  lines.forEach((line, index) => {
    if (heredoc) {
      if ((heredoc.strip ? line.replace(/^\t+/, '') : line) === heredoc.word) heredoc = null;
      return;
    }
    const definition = current ? null : /^([A-Za-z_][A-Za-z0-9_]*)\(\) \{/.exec(line);
    if (definition) {
      current = { name: definition[1], line: index, calls: new Set() };
      functions.set(current.name, current);
    } else if (current && line === '}') {
      current = null;
      return;
    }
    // A trap handler runs when the trap fires, not where it is set.
    const code = /^\s*trap\s/.test(line) ? '' : executableText(line);
    const opened = /<<(-?)\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line);
    if (opened) heredoc = { strip: opened[1] === '-', word: opened[2] };
    if (definition) return;
    const calls = [...code.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((word) => word[0]).filter((word) => names.has(word));
    if (current) for (const call of calls) current.calls.add(call);
    else if (calls.length > 0) topLevel.push({ line: index, calls });
  });
  return { functions, topLevel };
}

// The parts of a line the shell runs as commands: no comments, no single-quoted text, and of double-quoted text only
// command substitutions.
function executableText(line) {
  let out = '';
  let quote = null;
  let depth = 0;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === '\\') {
      index++;
      continue;
    }
    if (quote === '"' && depth === 0) {
      if (char === '"') quote = null;
      else if (char === '$' && line[index + 1] === '(') {
        depth = 1;
        index++;
        out += ' ';
      }
      continue;
    }
    if (depth > 0) {
      if (char === '(') depth++;
      if (char === ')') depth--;
      if (depth > 0) out += char;
      else out += ' ';
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) break;
    out += char;
  }
  return out;
}

function definedBeforeUseErrors(source) {
  const { functions, topLevel } = parseShell(source);
  const errors = [];
  for (const { line, calls } of topLevel) {
    const seen = new Set();
    const pending = [...calls];
    while (pending.length > 0) {
      const name = pending.pop();
      if (seen.has(name)) continue;
      seen.add(name);
      const fn = functions.get(name);
      if (!fn) continue;
      if (fn.line > line) errors.push(`line ${line + 1} runs ${name}, defined at line ${fn.line + 1}`);
      pending.push(...fn.calls);
    }
  }
  return errors;
}

test('every installer parses and defines its functions before the top-level code runs them', async () => {
  assert.ok(installers.length >= 6, `found ${installers.join(', ')}`);
  for (const name of installers) {
    const source = await readFile(path.join(scriptsDir, name), 'utf8');
    if (linux) {
      const parsed = spawnSync('bash', ['-n', path.join(scriptsDir, name)], { encoding: 'utf8' });
      assert.equal(parsed.status, 0, `${name}: ${parsed.stderr}`);
    }
    assert.deepEqual(definedBeforeUseErrors(source), [], name);
  }
});

let work;
let sleeper;

before(async () => {
  if (!linux) return;
  work = await mkdtemp(path.join(tmpdir(), 'opfield-installers-'));
  const bin = path.join(work, 'bin');
  const copies = path.join(work, 'scripts');
  await spawnAsync('mkdir', ['-p', bin, copies]);
  for (const name of [...installers, 'legacy-compat.sh']) {
    const source = await readFile(path.join(scriptsDir, name), 'utf8');
    // The root checks pass for the test user, and the host paths an installer reads or would write (/etc, /var, /run,
    // /usr/local) are under an empty directory, so a daemon already installed on the test host changes nothing.
    // Everything else runs as written.
    const copy = source
      .replaceAll('$EUID -ne 0', '0 -ne 0')
      .replaceAll('${EUID} -eq 0', '0 -eq 0')
      .replaceAll('"$EUID" -eq 0', '0 -eq 0')
      .replace(/(?<![\w.$/-])\/(etc|var|run|usr\/local)\//g, `${work}/host/$1/`)
      .replaceAll(`${work}/host/etc/os-release`, '/etc/os-release');
    await writeFile(path.join(copies, name), copy, { mode: 0o755 });
  }
  // A process of the --user account plays the nginx master that a non-root nginx-daemon requires.
  sleeper = spawn('sleep', ['600'], { stdio: 'ignore', detached: false });
  await writeFile(path.join(work, 'nginx.pid'), `${sleeper.pid}\n`);
  const stubs = {
    docker: `#!/bin/sh\ncase "$1" in version) echo 26.1.5 ;; info) echo ok ;; *) exit 0 ;; esac\n`,
    nginx: `#!/bin/sh\ncase "$1" in -v) echo "nginx version: nginx/1.26.3" >&2 ;; -V) echo "nginx version: nginx/1.26.3" >&2; echo "configure arguments: --pid-path=${work}/nginx.pid" >&2 ;; -T) echo "pid ${work}/nginx.pid;" ;; *) exit 0 ;; esac\n`,
    curl: '#!/bin/sh\necho "curl is stubbed: installer dry runs use no network" >&2\nexit 22\n',
  };
  for (const [name, body] of Object.entries(stubs)) {
    await writeFile(path.join(bin, name), body);
    await chmod(path.join(bin, name), 0o755);
  }
});

after(async () => {
  sleeper?.kill();
  if (work) await rm(work, { recursive: true, force: true });
});

function spawnAsync(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('close', resolve);
  });
}

function dryRun(script, args, env = {}) {
  const result = spawnSync('bash', [path.join(work, 'scripts', script), ...args, '--dry-run'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PATH: `${path.join(work, 'bin')}:${process.env.PATH}`, ...env },
    input: '',
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

const common = ['--opfield', 'gw.example.com:9443', '--token', 'gw_node_test', '--opfield-cert-sha256', CERT, '--version', VERSION];
// The relay installer installs relay releases from the Opfield names on (MIN_RELAY_VERSION) and takes --opfield options.
const RELAY_VERSION = 'v2.12.1';
const relayCommon = ['--opfield', 'gw.example.com:9443', '--token', 'gw_node_test', '--opfield-cert-sha256', CERT, '--version', RELAY_VERSION];
const switches = [[], ['--disable-console', '--disable-files']];
// The account the non-root runs use: the test user, or nobody when the test runs as root.
const nonRootUser = userInfo().uid === 0 ? 'nobody' : userInfo().username;

test('every installer completes a dry run for each profile, as root and with --user', { skip: !linux }, () => {
  const runs = [];
  for (const extra of switches) {
    for (const user of ['root', nonRootUser]) {
      runs.push(['setup-monitoring-node.sh', ['-y', ...common, '--user', user, ...extra]]);
      runs.push(['setup-docker-node.sh', ['-y', ...common, '--mode', 'docker', '--user', user, ...extra]]);
      runs.push([
        'setup-relay-node.sh',
        [...relayCommon, '--advertise-address', 'relay.example.com', ...extra],
        { OPFIELD_RELAY_RUN_USER: user },
      ]);
    }
    // A non-root nginx-daemon needs an nginx master running as its user; the stub's pid file names one of the test
    // user. Root needs a root master, which the stub cannot provide without root.
    if (userInfo().uid === 0) runs.push(['setup-node.sh', ['-y', ...common, '--nginx-mode', 'integrate', ...extra]]);
    else runs.push(['setup-node.sh', ['-y', ...common, '--nginx-mode', 'integrate', '--user', nonRootUser, ...extra]]);
    for (const mode of ['builder', 'storage', 'databases']) {
      runs.push(['setup-docker-node.sh', ['-y', ...common, '--mode', mode, ...extra]]);
    }
    runs.push(['setup-storage-node.sh', ['-y', ...common, ...extra]]);
    runs.push(['setup-database-node.sh', ['-y', ...common, ...extra]]);
  }
  for (const [script, args, env] of runs) {
    const { status, output } = dryRun(script, args, env);
    assert.equal(status, 0, `${script} ${args.join(' ')}\n${output}`);
    assert.doesNotMatch(output, /command not found/, `${script} ${args.join(' ')}\n${output}`);
    if (args.includes('--disable-console')) assert.match(output, /console\.enabled: false/, `${script}\n${output}`);
  }
});

// Protected mode is the relay machine owner's switch: --protected (or OPFIELD_RELAY_PROTECTED=1, or the legacy
// OPFIELD_RELAY_PROTECTED=1) writes it, and the installer never turns it off. Turning it off is
// `relay-supervisor protected off` on the machine.
test('the relay installer writes protected mode', { skip: !linux }, () => {
  const relayArgs = [...relayCommon, '--advertise-address', 'relay.example.com'];
  for (const [args, env] of [
    [[...relayArgs, '--protected'], {}],
    [relayArgs, { OPFIELD_RELAY_PROTECTED: '1' }],
    [relayArgs, { [`${LEGACY.LEGACY_ENV_PREFIX}RELAY_PROTECTED`]: '1' }],
  ]) {
    const { status, output } = dryRun('setup-relay-node.sh', args, env);
    assert.equal(status, 0, output);
    assert.match(output, /protected\.enabled: true/, output);
  }
  const plain = dryRun('setup-relay-node.sh', relayArgs);
  assert.equal(plain.status, 0, plain.output);
  assert.doesNotMatch(plain.output, /protected\.enabled/, plain.output);
  const source = readFileSync(path.join(scriptsDir, 'setup-relay-node.sh'), 'utf8');
  assert.match(source, /relay_protected_setting "\$RELAY_CONFIG" enabled; then PROTECTED=1/);
  assert.match(source, /--protected\) PROTECTED=1/);
});

// Each environment variable an installer documents as the equivalent of an option reaches the run: a dry run gets
// all its settings from the environment, and an invalid value is refused like the option's.
test('the installers take their settings from the environment', { skip: !linux }, () => {
  const settings = {
    OPFIELD_NODE_TOKEN: 'gw_node_test',
    OPFIELD_NODE_CERT_SHA256: CERT,
    OPFIELD_NODE_DAEMON_VERSION: VERSION,
    OPFIELD_NODE_DISABLE_CONSOLE: '1',
    OPFIELD_NODE_DISABLE_FILES: '1',
  };
  const address = { ...settings, OPFIELD_NODE_ADDRESS: 'gw.example.com:9443' };
  const hostPort = { ...settings, OPFIELD_NODE_HOST: 'gw.example.com', OPFIELD_NODE_PORT: '9443' };
  const nginxUser = userInfo().uid === 0 ? [] : ['--user', nonRootUser];
  const relayArgs = [
    ...['--opfield', 'gw.example.com:9443', '--token', 'gw_node_test', '--opfield-cert-sha256', CERT],
    ...['--advertise-address', 'relay.example.com', '--service-port', '853', '--version', RELAY_VERSION],
  ];
  const runs = [
    ['setup-monitoring-node.sh', ['-y'], address, /monitoring-daemon installed \(v2\.11\.1; dry run\)/],
    ['setup-monitoring-node.sh', ['-y'], hostPort, /files\.enabled: false/],
    [
      'setup-node.sh',
      ['-y', ...nginxUser],
      { ...hostPort, OPFIELD_NODE_NGINX_MODE: 'integrate', OPFIELD_NODE_SKIP_NGINX: '1' },
      /nginx configuration updated \(integrate mode; dry run\)/,
    ],
    [
      'setup-docker-node.sh',
      ['-y'],
      { ...address, OPFIELD_DOCKER_MODE: 'builder', OPFIELD_BUILDER_EGRESS_PROFILE: 'offline' },
      /Build Worker profile/,
    ],
    ['setup-docker-node.sh', ['-y'], { ...hostPort, OPFIELD_DOCKER_SECURE_RUNTIME: '1' }, /Secure Runtime/],
    [
      'setup-database-node.sh',
      ['-y', ...common],
      { OPFIELD_DATABASE_STORAGE_ROOT: '/srv/opfield-test' },
      /storage: \/srv\/opfield-test/,
    ],
    ['setup-database-node.sh', ['-y', ...common, '--storage-root', '/srv/gw-flag'], {}, /storage: \/srv\/gw-flag/],
    ['setup-storage-node.sh', ['-y', ...common], {}, /Database docker profile written/],
    [
      'setup-relay-node.sh',
      relayArgs,
      {
        ...settings,
        OPFIELD_RELAY_RUN_USER: nonRootUser,
        OPFIELD_RELAY_RUN_GROUP: userInfo().uid === 0 ? 'nogroup' : '',
      },
      /files\.enabled: false/,
    ],
  ];
  for (const [script, args, env, expected] of runs) {
    const { status, output } = dryRun(script, args, env);
    if (env.OPFIELD_NODE_SKIP_NGINX && /--skip-nginx requires nginx/.test(output)) {
      // A host nginx older than the minimum (or none) refuses --skip-nginx; the summary still shows the setting.
      assert.match(output, /Skip nginx:\s+yes/, `${script}\n${output}`);
      continue;
    }
    assert.equal(status, 0, `${script} ${JSON.stringify(env)}\n${output}`);
    assert.match(output, expected, `${script} ${JSON.stringify(env)}\n${output}`);
    if (env.OPFIELD_NODE_DISABLE_CONSOLE) assert.match(output, /console\.enabled: false/, `${script}\n${output}`);
  }
  const relay = dryRun('setup-relay-node.sh', relayArgs, { OPFIELD_RELAY_RUN_USER: nonRootUser });
  assert.match(relay.output, /CAP_NET_BIND_SERVICE for port 853/, relay.output);
  // The Opfield address in two parts, as options.
  const parts = ['--host', 'gw.example.com', '--port', '9443', '--no-logo'];
  const credentials = ['--token', 'gw_node_test', '--opfield-cert-sha256', CERT, '--version', VERSION];
  for (const [script, extra] of [
    ['setup-monitoring-node.sh', []],
    ['setup-docker-node.sh', ['--mode', 'docker']],
    ['setup-node.sh', ['--nginx-mode', 'integrate', ...nginxUser]],
  ]) {
    const { status, output } = dryRun(script, ['-y', ...parts, ...credentials, ...extra]);
    assert.equal(status, 0, `${script}\n${output}`);
  }

  const refused = [
    [
      'setup-docker-node.sh',
      ['-y'],
      { ...address, OPFIELD_BUILDER_EGRESS_PROFILE: 'none' },
      /Invalid --builder-egress 'none'/,
    ],
    ['setup-docker-node.sh', ['-y'], { ...address, OPFIELD_DOCKER_MODE: 'cluster' }, /Invalid --mode 'cluster'/],
    [
      'setup-docker-node.sh',
      ['-y'],
      { ...address, OPFIELD_DOCKER_MODE: 'storage', OPFIELD_DOCKER_SECURE_RUNTIME: '1' },
      /--secure-runtime applies to the docker profile only/,
    ],
    ['setup-node.sh', ['-y', ...nginxUser], { ...address, OPFIELD_NODE_NGINX_MODE: 'x' }, /Unknown nginx mode: x/],
    ['setup-database-node.sh', ['-y', ...common, '--user', nonRootUser], {}, /must run docker-daemon as root/],
    [
      'setup-relay-node.sh',
      relayArgs,
      { OPFIELD_RELAY_RUN_USER: nonRootUser, OPFIELD_RELAY_RUN_GROUP: 'opfield-no-such-group' },
      /does not exist; Relay installation stopped/,
    ],
    [
      'setup-relay-node.sh',
      relayArgs,
      { OPFIELD_RELAY_RUN_USER: 'opfield-no-such-user' },
      /does not exist; Relay installation stopped/,
    ],
  ];
  for (const [script, args, env, expected] of refused) {
    const { status, output } = dryRun(script, args, env);
    assert.notEqual(status, 0, `${script} ${JSON.stringify(env)}\n${output}`);
    assert.match(output, expected, `${script} ${JSON.stringify(env)}\n${output}`);
  }
});

// setup-daemon.sh runs the installer of each node type from a local directory and forwards the other arguments.
test('setup-daemon.sh dispatches every node type to its installer', { skip: !linux }, () => {
  const copies = path.join(work, 'scripts');
  const nginxUser = userInfo().uid === 0 ? [] : ['--user', nonRootUser];
  const types = {
    monitoring: 'setup-monitoring-node.sh',
    docker: 'setup-docker-node.sh',
    storage: 'setup-storage-node.sh',
    databases: 'setup-database-node.sh',
    nginx: 'setup-node.sh',
  };
  // setup-daemon.sh keeps --version for itself (the release of the installers), so the daemon release comes from the
  // environment.
  const args = ['-y', '--opfield', 'opfield.example.com:9443', '--token', 'opf_node_test', '--opfield-cert-sha256', CERT];
  const env = { OPFIELD_NODE_DAEMON_VERSION: VERSION };
  for (const [type, script] of Object.entries(types)) {
    const extra = type === 'nginx' ? ['--nginx-mode', 'integrate', ...nginxUser] : [];
    const viaFlag = dryRun('setup-daemon.sh', ['--type', type, '--script-dir', copies, ...args, ...extra], env);
    assert.equal(viaFlag.status, 0, `${type}\n${viaFlag.output}`);
    assert.match(viaFlag.output, new RegExp(`Running local ${script.replace('.', '\\.')}`), viaFlag.output);
    const viaEnv = dryRun('setup-daemon.sh', ['--type', type, ...args, ...extra], {
      ...env,
      OPFIELD_SETUP_SCRIPT_DIR: copies,
    });
    assert.equal(viaEnv.status, 0, `${type}\n${viaEnv.output}`);
    // legacy-name: the pre-2.12.1 name of OPFIELD_SETUP_SCRIPT_DIR in automation written before 2.12.1.
    const viaLegacyEnv = dryRun('setup-daemon.sh', ['--type', type, ...args, ...extra], {
      ...env,
      [`${LEGACY.LEGACY_ENV_PREFIX}SETUP_SCRIPT_DIR`]: copies,
    });
    assert.equal(viaLegacyEnv.status, 0, `${type}\n${viaLegacyEnv.output}`);
  }
  const unknown = dryRun('setup-daemon.sh', ['--type', 'unknown-type', '--script-dir', copies]);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.output, /Unknown daemon type: unknown-type/);
});

test('every installer prints its help', { skip: !linux }, () => {
  for (const name of [...installers, 'install.sh']) {
    const source = path.join(name === 'install.sh' ? scriptsDir : path.join(work, 'scripts'), name);
    const result = spawnSync('bash', [source, '--help'], { encoding: 'utf8', timeout: 30_000, input: '' });
    assert.equal(result.status, 0, `${name}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Usage/i, name);
  }
});

// The OpenRC services of a daemon with its own user. supervise-daemon opens the output and error logs after it
// drops to that user, so the service has to give it the files first (checkpath runs as root, before the drop); a
// daemon that goes back to root takes them back the same way.
function openrcUserServices(source) {
  const lines = source.split('\n');
  const services = [];
  lines.forEach((line, index) => {
    if (line !== '#!/sbin/openrc-run') return;
    let end = index;
    while (lines[end] !== 'UNIT') end++;
    if (lines.slice(index, end).some((entry) => entry.startsWith('command_user='))) services.push({ index, end });
  });
  return { lines, services };
}

// Renders the service the installer would write for the account, with the text the installer builds before it.
function renderOpenrcService(source, user, group) {
  const { lines, services } = openrcUserServices(source);
  assert.equal(services.length, 1);
  const [{ index, end }] = services;
  assert.match(lines[index - 1], /<<UNIT/, 'the service text follows its heredoc line');
  const prefixStart = lines.findIndex((line, at) => at < index && /^\s+local unit_runtime=/.test(line));
  const prefixEnd = lines.findIndex((line, at) => at > prefixStart && line === '    if has_systemd; then');
  const prefix = prefixStart > 0 ? lines.slice(prefixStart, prefixEnd) : [];
  const script = [
    `RUN_USER=${user}; RUN_GROUP=${group}; openrc_need="net docker"; NGINX_DAEMON_RUNTIME_DIRS=(nginx-daemon opfield-secure-links)`,
    'render() {',
    ...prefix,
    'cat <<UNIT',
    ...lines.slice(index, end),
    'UNIT',
    '}',
    'render',
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const OPENRC_OWNED_LOGS = {
  'setup-monitoring-node.sh': 'monitoring-daemon',
  'setup-docker-node.sh': 'docker-daemon',
  'setup-node.sh': 'nginx-daemon',
  'setup-relay-node.sh': 'opfield-relay-supervisor',
};

test('OpenRC services of a non-root daemon hand their log files over before the privilege drop', () => {
  for (const [script, daemon] of Object.entries(OPENRC_OWNED_LOGS)) {
    const source = readFileSync(path.join(scriptsDir, script), 'utf8');
    for (const [user, group] of [
      ['svcuser', 'svcgroup'],
      ['root', 'root'],
    ]) {
      const service = renderOpenrcService(source, user, group);
      assert.match(service, new RegExp(`^command_user="${user}:${group}"$`, 'm'), `${script}\n${service}`);
      assert.match(service, new RegExp(`^output_log="/var/log/${daemon}\\.log"$`, 'm'), script);
      assert.match(service, new RegExp(`^error_log="/var/log/${daemon}\\.err"$`, 'm'), script);
      const startPre = /^start_pre\(\) \{\n([\s\S]*?)^\}$/m.exec(service);
      assert.ok(startPre, `${script} has a start_pre\n${service}`);
      for (const log of [`${daemon}.log`, `${daemon}.err`]) {
        assert.ok(
          startPre[1].includes(`    checkpath --file --owner ${user}:${group} --mode 0640 /var/log/${log}\n`),
          `${script} gives ${log} to ${user}:${group}\n${service}`
        );
      }
    }
  }
  // A non-root nginx-daemon keeps the runtime directories it already got.
  const nginx = renderOpenrcService(readFileSync(path.join(scriptsDir, 'setup-node.sh'), 'utf8'), 'svcuser', 'svcgroup');
  assert.match(nginx, /checkpath --directory --mode 0755 --owner svcuser:svcgroup "\/run\/\${dir}"/);
  assert.match(nginx, /^capabilities="\^cap_net_bind_service"$/m);
  // No other generated OpenRC service drops privileges: the lease watchdog runs as root.
  for (const name of installers) {
    const { services } = openrcUserServices(readFileSync(path.join(scriptsDir, name), 'utf8'));
    assert.equal(services.length, name in OPENRC_OWNED_LOGS ? 1 : 0, name);
  }
});

test('an installer that cannot keep the OpenRC service up says so and shows the supervise-daemon reason', () => {
  for (const [script, daemon] of Object.entries(OPENRC_OWNED_LOGS)) {
    const source = readFileSync(path.join(scriptsDir, script), 'utf8');
    assert.match(source, /is not running; the service manager could not keep it up/, script);
    // supervise-daemon logs why it could not start the service to the system log, not to the service's own logs.
    const filter = daemon === 'opfield-relay-supervisor' ? 'opfield-relay' : daemon;
    assert.ok(source.includes(`grep -h 'supervise-daemon.*${filter}' /var/log/messages`), script);
  }
});

// A host that cannot run the Build Worker profile (it needs systemd) fails the install before the installer installs
// packages, downloads or writes anything.
test('the Build Worker host check runs before any host change', () => {
  const source = readFileSync(path.join(scriptsDir, 'setup-docker-node.sh'), 'utf8');
  const { topLevel } = parseShell(source);
  assert.match(source, /preflight_builder_host\(\) \{\n[^}]*has_systemd \|\|/);
  assert.doesNotMatch(source, /preflight_builder_runtime\(\) \{\n[^}]*has_systemd/, 'the late preflight does not own the host check');
  const firstRun = (name) => Math.min(...topLevel.filter((entry) => entry.calls.includes(name)).map((entry) => entry.line));
  const check = firstRun('preflight_builder_host');
  assert.ok(Number.isFinite(check), 'the host check runs at the top level');
  for (const change of [
    'check_dependencies',
    'ensure_docker_installed',
    'ensure_builder_system_packages',
    'prepare_run_user_switch',
    'create_directories',
    'install_daemon',
    'install_builder_runtime',
  ]) {
    assert.ok(check < firstRun(change), `the host check runs before ${change}`);
  }
});

test('a Build Worker install on a host without systemd stops before it changes anything', { skip: !linux }, () => {
  const host = path.join(work, 'host');
  const result = spawnSync('bash', [path.join(work, 'scripts', 'setup-docker-node.sh'), '-y', ...common, '--mode', 'builder'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PATH: `${path.join(work, 'bin')}:${process.env.PATH}` },
    input: '',
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /Builder nodes require systemd/, output);
  assert.doesNotMatch(output, /Installing|Downloading|Creating required directories/, output);
  assert.equal(spawnSync('test', ['-e', path.join(host, 'usr/local/bin/docker-daemon')]).status, 1);
  assert.equal(spawnSync('test', ['-e', path.join(host, 'etc/docker-daemon')]).status, 1);
});

// A top-level shell function of an installer, to run on its own.
function shellFunction(source, name) {
  const match = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm').exec(source);
  assert.ok(match, `${name} is defined`);
  return match[0];
}

function runShell(script) {
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30_000 });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

// The managed nginx.conf names the pid file the host's nginx service watches. Alpine's service watches
// /run/nginx/nginx.pid; a pid file elsewhere leaves OpenRC without a master process (the service reads "crashed" and
// cannot restart while the old master keeps its ports). Debian and Ubuntu name /run/nginx.pid in the unit.
test('managed nginx.conf names the pid file of the distribution service', { skip: !linux }, async () => {
  const source = readFileSync(path.join(scriptsDir, 'setup-node.sh'), 'utf8');
  assert.doesNotMatch(source, /^pid \/run\/nginx\.pid;$/m, 'the pid file is not hardcoded');
  assert.match(source, /^pid __NGINX_PID_FILE__;$/m);
  assert.match(source, /s\|__NGINX_PID_FILE__\|\$\(nginx_service_pid_file\)\|g/);
  const dir = await mkdtemp(path.join(tmpdir(), 'opfield-nginx-pid-'));
  try {
    const initScript = path.join(dir, 'nginx');
    const body = shellFunction(source, 'nginx_service_pid_file').replaceAll('/etc/init.d/nginx', initScript);
    const pidFile = (setup) => runShell(`${setup}\n${body}\nnginx_service_pid_file`).output.trim();
    const stubs = (systemd, systemctlOut, built) =>
      [
        `has_systemd() { return ${systemd ? 0 : 1}; }`,
        `has_openrc() { return ${systemd ? 1 : 0}; }`,
        `systemctl() { echo '${systemctlOut}'; }`,
        `nginx() { echo 'configure arguments: --prefix=/usr --pid-path=${built}' >&2; }`,
      ].join('\n');
    await writeFile(initScript, '#!/sbin/openrc-run\npidfile=/run/nginx/nginx.pid\ncommand=/usr/sbin/nginx\n');
    assert.equal(pidFile(stubs(false, '', '/run/nginx.pid')), '/run/nginx/nginx.pid');
    await writeFile(initScript, '#!/sbin/openrc-run\npidfile="/var/run/nginx.pid"\n');
    assert.equal(pidFile(stubs(false, '', '/run/nginx.pid')), '/var/run/nginx.pid');
    await writeFile(initScript, '#!/sbin/openrc-run\npidfile="${PIDFILE:-/x}"\n');
    assert.equal(pidFile(stubs(false, '', '/run/built.pid')), '/run/built.pid');
    assert.equal(pidFile(stubs(true, '/run/nginx.pid', '/run/built.pid')), '/run/nginx.pid');
    assert.equal(pidFile(stubs(true, '', '/run/built.pid')), '/run/built.pid');
    assert.equal(pidFile(stubs(true, '', '').replace(/nginx\(\) \{.*\}/, 'nginx() { :; }')), '/run/nginx.pid');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A re-run on an ingress node with Pages hostnames rewrote nginx.conf without the bucket size the daemon had added;
// nginx -t failed and the broken file stayed for the next reload. The template carries the directive, and a failed
// test puts every nginx file the run changed back as it was before the run.
test('the nginx installer keeps Pages hostnames valid and restores its files when nginx -t fails', { skip: !linux }, async () => {
  const source = readFileSync(path.join(scriptsDir, 'setup-node.sh'), 'utf8');
  const template = /cat > \/etc\/nginx\/nginx\.conf << 'EOF'\n([\s\S]*?)\nEOF/.exec(source);
  assert.ok(template, 'the managed nginx.conf template is found');
  assert.match(template[1], /^ {4}server_names_hash_bucket_size 128;$/m);
  assert.match(source, /restore_nginx_config\n\s+die "nginx config test failed/);
  const dir = await mkdtemp(path.join(tmpdir(), 'opfield-nginx-rollback-'));
  try {
    const conf = path.join(dir, 'nginx.conf');
    const site = path.join(dir, 'default.conf');
    await writeFile(conf, 'original conf\n');
    await writeFile(site, 'original site\n');
    const run = runShell(
      [
        "IFS=$'\\n\\t'",
        'log() { :; }',
        'warn() { echo "$*" >&2; }',
        'prune_older_backups() { :; }',
        shellFunction(source, 'backup_if_exists'),
        'NGINX_CONFIG_ROLLBACK=()',
        shellFunction(source, 'backup_nginx_config'),
        shellFunction(source, 'restore_nginx_config'),
        `backup_nginx_config '${conf}'`,
        `echo managed > '${conf}'`,
        `backup_nginx_config '${path.join(dir, 'missing.conf')}'`,
        `backup_nginx_config '${site}'`,
        `echo broken > '${site}'`,
        `backup_nginx_config '${conf}'`,
        `echo limits > '${conf}'`,
        'restore_nginx_config',
      ].join('\n')
    );
    assert.equal(run.status, 0, run.output);
    assert.equal(readFileSync(conf, 'utf8'), 'original conf\n');
    assert.equal(readFileSync(site, 'utf8'), 'original site\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The lines of each top-level function, ended by its closing brace outside heredocs (a heredoc may hold an init
// script's own functions).
function functionBodies(source) {
  const bodies = new Map();
  let current = null;
  let heredoc = null;
  for (const line of source.split('\n')) {
    if (heredoc) {
      if ((heredoc.strip ? line.replace(/^\t+/, '') : line) === heredoc.word) heredoc = null;
      if (current) current.push(line);
      continue;
    }
    const definition = current ? null : /^([A-Za-z_][A-Za-z0-9_]*)\(\) \{/.exec(line);
    if (definition) {
      current = [];
      bodies.set(definition[1], current);
      continue;
    }
    if (current && line === '}') {
      current = null;
      continue;
    }
    if (current) current.push(line);
    const opened = /<<(-?)\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line);
    if (opened) heredoc = { strip: opened[1] === '-', word: opened[2] };
  }
  return bodies;
}

// OpenRC checks its dependency cache against the init scripts' mtimes in whole seconds: a script written in the second
// the cache was built (a service started moments before) is missing from it at the next boot and its service never
// starts (F-4). Every function that writes an init script rebuilds the cache after its last write.
test('every installer rebuilds the OpenRC dependency cache after it writes an init script', () => {
  let writers = 0;
  for (const script of installers) {
    const source = readFileSync(path.join(scriptsDir, script), 'utf8');
    for (const [name, lines] of functionBodies(source)) {
      const lastWrite = lines.findLastIndex((line) => /\bcat\s*>\s*"?\/etc\/init\.d\//.test(line));
      if (lastWrite < 0) continue;
      writers += 1;
      assert.ok(
        lines.slice(lastWrite + 1).some((line) => /^\s*(?:!\s+command_exists rc-update \|\|\s+)?openrc_refresh_deptree\b/.test(line)),
        `${script} ${name} writes an OpenRC init script without rebuilding the dependency cache afterwards`
      );
    }
    if (/\bcat\s*>\s*"?\/etc\/init\.d\//.test(source)) {
      const helper = shellFunction(source, 'openrc_refresh_deptree');
      const run = runShell(
        [
          'LOG_FILE=/dev/null',
          'calls=$(mktemp)',
          'warn() { echo "warn $*"; }',
          'rc-update() { echo "rc-update $*" >> "$calls"; echo noise; }',
          helper,
          'openrc_refresh_deptree',
          'cat "$calls"',
          'rm -f "$calls"',
        ].join('\n')
      );
      assert.equal(run.status, 0, run.output);
      assert.equal(run.output.trim(), 'rc-update -u', `${script}: rebuilds the cache, its output goes to the log`);
      const failing = runShell(
        ['LOG_FILE=/dev/null', 'warn() { echo "warn $*"; }', 'rc-update() { return 1; }', helper, 'openrc_refresh_deptree'].join('\n')
      );
      assert.equal(failing.status, 0, failing.output);
      assert.match(failing.output, /rc-update -u/, `${script}: a failed rebuild names the command`);
    }
  }
  // docker-daemon, its lease watchdog, nginx-daemon, monitoring-daemon and the relay supervisor.
  assert.ok(writers >= 5, `found ${writers} init script writers`);
});

// A host whose package lists are stale asks the mirror for package versions it no longer has (404): the nginx.org
// repository step refreshes the lists before it installs its own dependencies.
test('the nginx.org repository step refreshes the package lists before it installs anything', () => {
  const source = readFileSync(path.join(scriptsDir, 'setup-node.sh'), 'utf8');
  const run = runShell(
    [
      'log() { :; }',
      'warn() { :; }',
      'OS_LIKE=debian',
      // The install of the repository dependencies is the last call this test needs; stop before the host changes.
      'run_apt_with_lock_retry() { echo "apt $*"; if [[ "$1" == install ]]; then exit 0; fi; }',
      shellFunction(source, 'install_nginx_stable_repo'),
      'install_nginx_stable_repo',
    ].join('\n')
  );
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.output.trim().split('\n'), [
    'apt update -qq',
    'apt install -y -qq gnupg2 ca-certificates lsb-release',
  ]);
});

// The installer secures the pid directory of Alpine's nginx service for a root nginx (the stock service gives it to the
// unprivileged nginx user on every start and reload). The service must still give the directory to the user nginx runs
// as when /etc/conf.d/nginx sets command_user, which is how docs/nodes.md prepares a non-root nginx.
test('the secured nginx OpenRC service gives the pid directory to the user nginx runs as', { skip: !linux }, async () => {
  const source = readFileSync(path.join(scriptsDir, 'setup-node.sh'), 'utf8');
  const dir = await mkdtemp(path.join(tmpdir(), 'opfield-nginx-openrc-'));
  try {
    const service = path.join(dir, 'nginx');
    const stock = [
      '#!/sbin/openrc-run',
      'pidfile=/run/nginx/nginx.pid',
      'start_pre() {',
      '\tcheckpath --directory --owner nginx:nginx ${pidfile%/*}',
      '}',
      'reload_pre() {',
      '\tcheckpath --directory --owner nginx:nginx ${pidfile%/*}',
      '}',
      '',
    ].join('\n');
    const earlier = stock.replaceAll('--owner nginx:nginx', '--mode 0755 --owner root:root');
    const body = shellFunction(source, 'ensure_nginx_openrc_pid_directory').replaceAll('/etc/init.d', dir);
    const migrate = async (content, runUser) => {
      await writeFile(service, content, { mode: 0o755 });
      const result = runShell(
        [
          source.split('\n').filter((line) => /^NGINX_OPENRC_(STOCK|EARLIER|PID_FILE)_LINE=/.test(line)).join('\n'),
          'has_openrc() { return 0; }',
          'die() { echo "$*" >&2; exit 1; }',
          'log() { :; }',
          'backup_if_exists() { :; }',
          // The service directories are root-owned and not writable by others on a host; the test files are not.
          'stat() { case "$*" in "-c %u"*) echo 0 ;; *) echo 755 ;; esac; }',
          `RUN_USER=${runUser}`,
          shellFunction(source, 'nginx_openrc_pid_file_line_missing'),
          body,
          'ensure_nginx_openrc_pid_directory',
        ].join('\n')
      );
      assert.equal(result.status, 0, result.output);
      return readFileSync(service, 'utf8');
    };
    // What the start and reload steps hand to the user nginx runs as, with and without command_user: /run/nginx, then
    // the pid file, before the service's own nginx -t (run as root) can create it.
    const owners = (content, commandUser) => {
      const lines = content.split('\n').filter((line) => line.includes('checkpath'));
      assert.equal(lines.length, 4, content);
      return lines.map((line) => {
        const result = runShell(
          [
            'checkpath() { echo "$@"; }',
            'pidfile=/run/nginx/nginx.pid',
            commandUser ? `command_user=${commandUser}` : '',
            line.trim(),
          ].join('\n')
        );
        return result.output.trim();
      });
    };
    const pair = (directory, owner) => [directory, `--file --mode 0644 --owner ${owner} /run/nginx/nginx.pid`];
    for (const [content, runUser] of [
      [stock, 'root'],
      [earlier, 'root'],
      [earlier, 'nginx'],
    ]) {
      const secured = await migrate(content, runUser);
      assert.deepEqual(owners(secured, ''), [
        ...pair('--directory --mode 0755 --owner root:root /run/nginx', 'root:root'),
        ...pair('--directory --mode 0755 --owner root:root /run/nginx', 'root:root'),
      ]);
      assert.deepEqual(owners(secured, 'nginx:nginx'), [
        ...pair('--directory --mode 0755 --owner nginx:nginx /run/nginx', 'nginx:nginx'),
        ...pair('--directory --mode 0755 --owner nginx:nginx /run/nginx', 'nginx:nginx'),
      ]);
      assert.equal(await migrate(secured, runUser), secured, 'migrating twice changes nothing');
    }
    // A non-root daemon next to the stock service leaves the operator's pid directory alone and adds the pid file.
    const nonRoot = await migrate(stock, 'nginx');
    assert.deepEqual(owners(nonRoot, 'nginx:nginx'), [
      ...pair('--directory --owner nginx:nginx /run/nginx', 'nginx:nginx'),
      ...pair('--directory --owner nginx:nginx /run/nginx', 'nginx:nginx'),
    ]);
    assert.equal(await migrate(nonRoot, 'nginx'), nonRoot, 'migrating twice changes nothing');
    // The line is the one the nginx daemon's health names when it is missing (and checks for).
    const line = /^NGINX_OPENRC_PID_FILE_LINE='(.*)'$/m.exec(source)[1];
    const daemon = readFileSync(path.resolve('packages/daemons/nginx/internal/nginx/pid_repair.go'), 'utf8');
    assert.ok(daemon.includes(`/a ${line}' /etc/init.d/nginx`), 'the daemon names the installer\'s line');

    // Alpine's own service: the pid file is the run user's before the service's nginx -t runs as root.
    const alpine = [
      '#!/sbin/openrc-run',
      '',
      'cfgfile=${cfgfile:-/etc/nginx/nginx.conf}',
      'pidfile=/run/nginx/nginx.pid',
      'command=${command:-/usr/sbin/nginx}',
      'command_args="-c $cfgfile"',
      '',
      'start_pre() {',
      '\tcheckpath --directory --mode 0755 --owner "${command_user:-root:root}" ${pidfile%/*}',
      '\t$command $command_args -t -q',
      '}',
      '',
      'reload() {',
      '\tstart_pre && start-stop-daemon --signal HUP --pidfile $pidfile',
      '}',
      '',
    ].join('\n');
    const fixed = await migrate(alpine, 'nginx');
    const started = runShell(
      [
        'checkpath() { echo "checkpath $*"; }',
        'command=nginx; command_user=nginx:nginx',
        'nginx() { echo "nginx $*"; }',
        fixed.replace(/^#!.*\n/, '').replace(/^command=.*$/m, ''),
        'start_pre',
      ].join('\n')
    );
    assert.deepEqual(started.output.trim().split('\n'), [
      'checkpath --directory --mode 0755 --owner nginx:nginx /run/nginx',
      'checkpath --file --mode 0644 --owner nginx:nginx /run/nginx/nginx.pid',
      'nginx -c /etc/nginx/nginx.conf -t -q',
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A daemon that moves to another user says so, in both directions.
test('every installer announces the switch of the run user from root and to root', { skip: !linux }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'opfield-run-user-'));
  try {
    const configs = {
      'setup-monitoring-node.sh': '/etc/monitoring-daemon',
      'setup-docker-node.sh': '/etc/docker-daemon',
      'setup-node.sh': '/etc/nginx-daemon',
      'setup-relay-node.sh': '"$RELAY_CONFIG_DIR"',
    };
    for (const [script, config] of Object.entries(configs)) {
      const source = readFileSync(path.join(scriptsDir, script), 'utf8');
      const body = shellFunction(source, 'prepare_run_user_switch')
        .replaceAll(config, path.join(dir, 'conf'))
        .replaceAll('/var/lib/', `${path.join(dir, 'lib')}/`);
      const run = (runUser, previousUid, enrolled = 1) =>
        runShell(
          [
            'log() { echo "$*"; }',
            'die() { echo "DIE $*"; exit 1; }',
            'id() { case "$1" in -u) [[ "$2" == root ]] && echo 0 || echo 4242 ;; -nu) [[ "$2" == 0 ]] && echo root || echo "user$2" ;; esac; }',
            'stop_daemon_service() { echo STOPPED; }',
            'stop_relay_supervisor() { echo STOPPED; }',
            `RELAY_STATE_DIR='${path.join(dir, 'lib', 'opfield-relay')}'`,
            `PREVIOUS_RUN_UID=${previousUid}`,
            `RUN_USER=${runUser}`,
            `EXISTING_ENROLLED=${enrolled}`,
            "ENROLL_TOKEN=''",
            'RUN_USER_SWITCH_PENDING=0',
            body,
            'prepare_run_user_switch',
            'echo "PENDING=$RUN_USER_SWITCH_PENDING"',
          ].join('\n')
        );
      // No installation yet: a fresh install does not switch anything.
      assert.doesNotMatch(run('gwsvc', 0).output, /switching/, script);
      await rm(path.join(dir, 'conf'), { recursive: true, force: true });
      runShell(`mkdir -p '${path.join(dir, 'conf')}'`);
      const toUser = run('gwsvc', 0);
      assert.equal(toUser.status, 0, `${script}\n${toUser.output}`);
      assert.match(toUser.output, /ran as root; switching it to gwsvc/, script);
      // A root daemon keeps rewriting its files as root while it runs, so it is stopped before they change owner:
      // at once, or (docker, nginx) right before the new process starts, which defers the ownership change too.
      assert.match(toUser.output, /STOPPED|PENDING=1/, `${script} stops the root daemon before the files change owner`);
      const stays = run('root', 0);
      assert.doesNotMatch(stays.output, /switching|STOPPED|PENDING=1/, `${script} stays root`);
      // Back to root from a non-root user is announced the same way.
      const toRoot = run('root', 4242);
      assert.equal(toRoot.status, 0, `${script}\n${toRoot.output}`);
      assert.match(toRoot.output, /ran as user4242; switching it to root/, script);
      // The previous user is the first owner other than root of the configuration, state or own binary directory.
      if (userInfo().uid === 0) {
        const owned = ['conf-root', 'state-user', 'own-user'].map((name) => path.join(dir, name));
        runShell(`mkdir -p ${owned.join(' ')} && chown 4242 '${owned[1]}' '${owned[2]}'`);
        const previous = (...paths) =>
          runShell(["IFS=$'\\n\\t'", shellFunction(source, 'previous_run_uid'), `previous_run_uid ${paths.join(' ')}`].join('\n'))
            .output.trim();
        assert.equal(previous(owned[0], owned[1], owned[2]), '4242', script);
        assert.equal(previous(path.join(dir, 'missing'), owned[0]), '0', script);
        await Promise.all(owned.map((entry) => rm(entry, { recursive: true, force: true })));
      }
      await rm(path.join(dir, 'conf'), { recursive: true, force: true });
    }
    // Leaving a non-root user is announced by the same function before the daemon is stopped.
    for (const script of Object.keys(configs)) {
      const source = readFileSync(path.join(scriptsDir, script), 'utf8');
      assert.match(source, /ran as \$\(id -nu "\$PREVIOUS_RUN_UID"/, script);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A Docker node needs the memory, cpu and pids cgroup controllers for its containers (the Secure Link connector sets
// all three limits). Where the root cgroup passes none down (an LXC guest with OpenRC) Docker starts, a container with
// limits does not, and the node would enroll without its connectors. The installer refuses before it enrolls.
test('the Docker installer refuses a host whose containers cannot get the cgroup controllers', { skip: !linux }, async () => {
  const source = readFileSync(path.join(scriptsDir, 'setup-docker-node.sh'), 'utf8');
  const { topLevel } = parseShell(source);
  const firstRun = (name) => Math.min(...topLevel.filter((entry) => entry.calls.includes(name)).map((entry) => entry.line));
  const check = firstRun('preflight_docker_cgroup_controllers');
  assert.ok(Number.isFinite(check), 'the check runs at the top level');
  assert.ok(firstRun('ensure_docker_installed') < check, 'after Docker is present');
  for (const later of ['install_daemon', 'enroll_daemon', 'start_daemon']) {
    assert.ok(check < firstRun(later), `before ${later}`);
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'opfield-cgroup-'));
  try {
    const body = shellFunction(source, 'preflight_docker_cgroup_controllers').replaceAll('/sys/fs/cgroup', dir);
    const write = (name, content) => runShell(`mkdir -p '${path.dirname(path.join(dir, name))}' && printf '%s\\n' '${content}' > '${path.join(dir, name)}'`);
    const check_ = (info, { DOCKER_MODE = 'docker' } = {}) =>
      runShell(
        [
          // The installer runs with IFS=$'\n\t' (set at its top); the check must not depend on the default IFS.
          "IFS=$'\\n\\t'",
          `DOCKER_MODE=${DOCKER_MODE}; LOG_FILE=/dev/null`,
          // The real docker CLI evaluates the template against moby's system.Info Go field names (CPUCfsQuota, not
          // the JSON name CpuCfsQuota); a wrong name fails the command, and the check would be skipped.
          'docker_run() { case "$*" in *"{{.CgroupVersion}} {{.CgroupDriver}} {{.MemoryLimit}} {{.PidsLimit}} {{.CPUCfsQuota}}"*) echo "' +
            info +
            '" ;; *) echo "template: cannot evaluate field" >&2; return 1 ;; esac; }',
          'warn() { echo "WARN $*"; }',
          'err() { echo "ERR $*" >&2; }',
          'die() { err "$@"; exit 1; }',
          body,
          'preflight_docker_cgroup_controllers && echo PASSED',
        ].join('\n')
      );
    const all = '2 cgroupfs true true true';
    // The controllers pass down to Docker's cgroup.
    write('docker/cgroup.controllers', 'cpu memory pids');
    assert.match(check_(all).output, /PASSED/);
    // An empty root cgroup: Docker's cgroup has none.
    write('docker/cgroup.controllers', '');
    const empty = check_(all);
    assert.equal(empty.status, 1, empty.output);
    assert.match(empty.output, /cannot give containers the cgroup controllers: cpu memory pids\./);
    assert.match(empty.output, /Alpine with OpenRC in an LXC container/);
    assert.match(empty.output, /nothing was enrolled/);
    // Only the missing one is named; the root cgroup is read when Docker has no cgroup yet.
    write('docker/cgroup.controllers', 'cpu memory');
    assert.match(check_(all).output, /controllers: pids\./);
    runShell(`rm '${path.join(dir, 'docker/cgroup.controllers')}'`);
    write('cgroup.subtree_control', 'cpuset cpu io memory pids');
    assert.match(check_(all).output, /PASSED/);
    write('cgroup.subtree_control', '');
    assert.match(check_(all).output, /controllers: cpu memory pids\./);
    // docker info says the kernel lacks a controller (cgroup v1 too); the systemd driver reads no files.
    assert.match(check_('1 cgroupfs true false true').output, /controllers: pids\./);
    assert.match(check_('2 systemd true true true').output, /PASSED/);
    // A Build Worker has no Docker.
    assert.match(check_('2 cgroupfs false false false', { DOCKER_MODE: 'builder' }).output, /PASSED/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Without -y an installer asks on the terminal. A terminal that cannot be read (no controlling terminal, or sudo's pty
// with a piped stdout, where the read fails with EIO) answers nothing, and a default must not stand in for the answer:
// an unreadable terminal used to read as "yes" to "Proceed?" and to the nginx upgrade from nginx.org.
test('a terminal that cannot be read is never answered with a default', { skip: !linux }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'opfield-tty-'));
  try {
    const answers = path.join(dir, 'answers');
    const unreadable = { missing: path.join(dir, 'no-such-tty'), 'a read error': dir };
    const helpers = {
      'setup-node.sh': ['prompt_input', 'prompt_secret', 'prompt_yes_no', 'prompt_choice'],
      'setup-docker-node.sh': ['prompt_input', 'prompt_secret', 'prompt_yes_no', 'prompt_choice'],
      'setup-monitoring-node.sh': ['prompt_input', 'prompt_secret', 'prompt_yes_no', 'prompt_choice'],
      'setup-database-node.sh': ['prompt_choice'],
    };
    for (const [script, names] of Object.entries(helpers)) {
      const source = readFileSync(path.join(scriptsDir, script), 'utf8');
      assert.doesNotMatch(source, /\[\[? -e \/dev\/tty \]\]?/, `${script} reads the terminal and checks the result`);
      assert.doesNotMatch(source, /reply="\$default"|\|\| reply=""/, script);
      const prelude = [
        'set -euo pipefail',
        'NON_INTERACTIVE=0; BRAND_MINT=""; NC=""; BOLD=""; GRAY=""; TERM=dumb',
        'err() { echo "ERR $*" >&2; }',
        'die() { err "$@"; exit 1; }',
        shellFunction(source, 'refuse_unanswered_prompt'),
        ...names.map((name) => shellFunction(source, name)),
      ];
      const calls = {
        // The installers assign the answer in a plain assignment, where set -e stops them when the helper fails.
        prompt_input: 'answer=$(prompt_input "Host" "default-host"); echo "got=${answer}"',
        prompt_secret: 'answer=$(prompt_secret "Token"); echo "got=${answer}"',
        prompt_yes_no: 'if prompt_yes_no "Upgrade nginx now?" "Y"; then echo "got=yes"; else echo "got=no"; fi',
        prompt_choice: 'answer=$(prompt_choice "Choose" "1" "root" "user"); echo "got=${answer}"',
      };
      for (const name of names) {
        for (const [what, tty] of Object.entries(unreadable)) {
          const body = prelude.map((part) => part.replaceAll('/dev/tty', tty));
          const result = runShell([...body, calls[name], 'echo AFTER'].join('\n'));
          assert.equal(result.status, 1, `${script} ${name} with a terminal that is ${what}\n${result.output}`);
          assert.match(result.output, /Cannot read an answer from the terminal/, `${script} ${name}`);
          assert.match(result.output, /pass -y to install non-interactively/, `${script} ${name}`);
          assert.doesNotMatch(result.output, /got=|AFTER/, `${script} ${name} did not default (${what})`);
        }
        // A readable terminal still answers, and an empty reply takes the default shown to the user.
        const answered = (reply) => {
          runShell(`printf '%s' '${reply}' > '${answers}'`);
          const body = prelude.map((part) => part.replaceAll('/dev/tty', answers));
          return runShell([...body, calls[name]].join('\n'));
        };
        assert.equal(answered('\n').status, 0, `${script} ${name}`);
        if (name === 'prompt_yes_no') {
          assert.match(answered('n\n').output, /got=no/, script);
          assert.match(answered('y\n').output, /got=yes/, script);
          assert.match(answered('\n').output, /got=yes/, script);
        }
        if (name === 'prompt_input') assert.match(answered('\n').output, /got=default-host/, script);
      }
    }
    // The node type menu of setup-daemon.sh does not pick its default for an unreadable terminal either.
    const daemon = readFileSync(path.join(scriptsDir, 'setup-daemon.sh'), 'utf8');
    assert.match(daemon, /read -r reply < "\$tty" 2>\/dev\/null \|\| die "Cannot read an answer from the terminal/);
    // -y stays the way to run without a terminal: it upgrades an nginx older than the minimum without asking (security
    // fixes), an interactive run asks first.
    const node = readFileSync(path.join(scriptsDir, 'setup-node.sh'), 'utf8');
    assert.match(node, /if \[\[ "\$NON_INTERACTIVE" -eq 0 \]\] && ! prompt_yes_no "Upgrade nginx to the official stable repository now\?" "Y"; then\n\s+die "Opfield node setup aborted\./);
    assert.doesNotMatch(node, /Re-run interactively to approve the stable nginx upgrade/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// An Alpine host whose nginx service still has the PID-directory line an earlier installer wrote (owner root:root), and
// whose operator ran nginx as the daemon's user (command_user in /etc/conf.d/nginx) before installing: that nginx
// cannot start, so there is no nginx master to find. The preflight only detects this and the summary announces the
// repair; the service line is migrated and nginx started after the user confirmed (or under -y). Nothing on the host
// changes before the prompt, and a dry run only prints the plan.
test('the nginx service repair of a non-root install is planned before the prompt and done after it', { skip: !linux }, async () => {
  const source = readFileSync(path.join(scriptsDir, 'setup-node.sh'), 'utf8');
  const { functions } = parseShell(source);
  const preflight = functions.get('preflight_run_user_nginx');
  assert.ok(preflight.calls.has('nginx_openrc_service_repair_needed'), 'the preflight detects the case');
  for (const change of ['ensure_nginx_openrc_pid_directory', 'start_nginx_after_service_repair', 'backup_if_exists']) {
    assert.ok(!preflight.calls.has(change), `the preflight does not call ${change}`);
  }
  const preflightCode = shellFunction(source, 'preflight_run_user_nginx')
    .split('\n')
    .filter((line) => !/^\s*err "/.test(line))
    .join('\n');
  assert.doesNotMatch(preflightCode, /rc-service/, 'the preflight runs no service command');
  assert.doesNotMatch(shellFunction(source, 'nginx_openrc_service_repair_needed'), /rc-service nginx (zap|start|restart)/);
  // The summary announces the plan before the prompt; the repair runs in the configuration step after it.
  const prompt = source.indexOf('prompt_yes_no "Proceed with installation?"');
  assert.ok(source.indexOf('summary_row "Nginx fix:   will update the nginx PID lines and start nginx"') < prompt);
  assert.ok(source.indexOf('\npreflight_run_user_nginx\n') < prompt);
  const configure = shellFunction(source, 'configure_nginx');
  assert.ok(configure.indexOf('ensure_nginx_openrc_pid_directory') < configure.indexOf('start_nginx_after_service_repair'));
  const runStart = source.indexOf('\n# ── Run ─');
  assert.ok(runStart > prompt && source.indexOf('\nconfigure_nginx\n') > runStart, 'configure_nginx runs after the prompt');
  assert.match(source, /dry_run_preview\(\) \{[\s\S]*Would update the nginx OpenRC service's PID lines and start nginx \(dry run\)/);
  assert.deepEqual(definedBeforeUseErrors(source), []);

  const dir = await mkdtemp(path.join(tmpdir(), 'opfield-nginx-migrate-'));
  try {
    const service = path.join(dir, 'nginx');
    const confd = path.join(dir, 'conf-nginx');
    const calls = path.join(dir, 'calls');
    const earlier = [
      '#!/sbin/openrc-run',
      'pidfile=/run/nginx/nginx.pid',
      'start_pre() {',
      '\tcheckpath --directory --mode 0755 --owner root:root ${pidfile%/*}',
      '}',
      '',
    ].join('\n');
    const text = [
      'nginx_openrc_pid_file_line_missing',
      'ensure_nginx_openrc_pid_directory',
      'nginx_openrc_service_repair_needed',
      'start_nginx_after_service_repair',
      'preflight_run_user_nginx',
    ]
      .map((name) => shellFunction(source, name).replaceAll('/etc/init.d', dir).replaceAll('/etc/conf.d/nginx', confd))
      .join('\n');
    const constants = source
      .split('\n')
      .filter((line) => /^NGINX_OPENRC_(STOCK|EARLIER|PID_FILE)_LINE=|^NGINX_SERVICE_REPAIR_PLANNED=/.test(line))
      .join('\n');
    const stubs = (dryRun) => [
      'RUN_USER=nginx; RUN_GROUP=nginx; NGINX_MODE=integrate; LOG_FILE=/dev/null',
      `DRY_RUN=${dryRun}`,
      constants,
      'has_openrc() { return 0; }',
      'command_exists() { return 0; }',
      'log() { echo "LOG $*"; }',
      'err() { echo "ERR $*" >&2; }',
      'die() { err "$@"; exit 1; }',
      'backup_if_exists() { :; }',
      'grant_daemon_paths_to_run_user() { :; }',
      'id() { case "$1" in -u) echo 1000 ;; *) echo nginx ;; esac; }',
      'stat() { case "$*" in *"/proc/"*) echo 1000 ;; *"-c %u"*) echo 0 ;; *) echo 755 ;; esac; }',
      // The service is down until something starts it; every call is recorded.
      `rc-service() { echo "$*" >> '${calls}'; case "$2" in start) touch '${dir}/up' ;; esac; [[ "$2" != status ]] || [[ -e '${dir}/up' ]]; }`,
      `nginx_master_pid() { [[ -e '${dir}/up' ]] && echo $$; }`,
      text,
    ];
    const run = async ({ confdText, dryRun = 0, afterPrompt = false, script = earlier }) => {
      await writeFile(service, script, { mode: 0o755 });
      await writeFile(confd, confdText);
      await writeFile(calls, '');
      runShell(`rm -f '${dir}/up'`);
      const steps = ['preflight_run_user_nginx', 'echo "PLANNED=${NGINX_SERVICE_REPAIR_PLANNED}"'];
      if (afterPrompt) steps.push('ensure_nginx_openrc_pid_directory', 'start_nginx_after_service_repair');
      const result = runShell([...stubs(dryRun), ...steps, 'echo DONE'].join('\n'));
      return { ...result, script: readFileSync(service, 'utf8'), calls: readFileSync(calls, 'utf8') };
    };
    const prepared = 'command_user="nginx:nginx"\ncapabilities="^cap_net_bind_service"\n';
    // Before the prompt: planned, nothing changed, nothing started.
    const planned = await run({ confdText: prepared });
    assert.equal(planned.status, 0, planned.output);
    assert.match(planned.output, /PLANNED=1/);
    assert.equal(planned.script, earlier, 'the service file is untouched before the prompt');
    assert.doesNotMatch(planned.calls, /zap|start/, 'no service action before the prompt');
    // After the prompt: the line is migrated, then nginx is started.
    const done = await run({ confdText: prepared, afterPrompt: true });
    assert.equal(done.status, 0, done.output);
    assert.match(done.script, /--owner "\$\{command_user:-root:root\}" \$\{pidfile%\/\*\}/);
    assert.match(done.script, /\n\tcheckpath --file --mode 0644 --owner "\$\{command_user:-root:root\}" \$\{pidfile\}\n/);
    assert.match(done.calls, /nginx zap\nnginx start\n/);
    // A service that already gives the directory to the run user but leaves the pid file of its root nginx -t to root:
    // the same plan (Alpine's own service; nginx failed with "open() /run/nginx/nginx.pid failed (13)").
    const secured = earlier.replace('--owner root:root', '--owner "${command_user:-root:root}"');
    const pidFilePlanned = await run({ confdText: prepared, script: secured });
    assert.match(pidFilePlanned.output, /PLANNED=1/);
    assert.equal(pidFilePlanned.script, secured, 'the service file is untouched before the prompt');
    const pidFileDone = await run({ confdText: prepared, script: secured, afterPrompt: true });
    assert.equal(pidFileDone.status, 0, pidFileDone.output);
    assert.equal(
      pidFileDone.script,
      secured.replace('${pidfile%/*}\n', '${pidfile%/*}\n\tcheckpath --file --mode 0644 --owner "${command_user:-root:root}" ${pidfile}\n')
    );
    assert.match(pidFileDone.calls, /nginx zap\nnginx start\n/);
    // A dry run only prints the plan; the repair functions change nothing.
    const dry = await run({ confdText: prepared, dryRun: 1, afterPrompt: true });
    assert.equal(dry.script, earlier);
    assert.doesNotMatch(dry.calls, /zap|start/);
    // Without command_user for the run user nothing is planned and the refusal stays as before.
    for (const confdText of ['', 'command_user="www-data"\n']) {
      const refused = await run({ confdText });
      assert.equal(refused.status, 1, refused.output);
      assert.match(refused.output, /no running nginx master process was found/);
      assert.match(refused.output, /rc-service nginx zap, then rc-service nginx start/);
      assert.match(refused.output, /nothing was changed\./);
      assert.equal(refused.script, earlier);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The relay installer re-runs like the monitoring, nginx and Docker installers: an enrolled relay re-run without a token
// keeps its identity and takes what is not given from its configuration (the documented user switch is such a re-run);
// with a token it re-enrolls, and when Opfield refuses the token the relay keeps running as it was but the install
// fails; a new relay still needs every argument.
test('an enrolled relay re-runs without a token and keeps its identity', { skip: !linux }, async () => {
  const host = path.join(work, 'host');
  // A relay installed before the Opfield names: the installer reads it there and moves it.
  const legacyConfigDir = path.join(host, 'etc', LEGACY.LEGACY_RELAY_SUPERVISOR);
  const legacyStateDir = path.join(host, 'var/lib', LEGACY.LEGACY_RELAY_SUPERVISOR);
  const config = path.join(legacyConfigDir, 'config.yaml');
  const identity = path.join(legacyStateDir, 'supervisor-identity/node.pem');
  const relayArgs = ['--version', RELAY_VERSION];
  const full = ['--opfield', 'gw.example.com:9443', '--opfield-cert-sha256', CERT, '--advertise-address', 'relay.example.com'];
  try {
    // A new relay: every argument is still required.
    for (const args of [relayArgs, [...relayArgs, ...full], ['--token', 'gw_node_x', ...relayArgs, '--opfield', 'gw.example.com:9443']]) {
      const fresh = dryRun('setup-relay-node.sh', args);
      assert.equal(fresh.status, 2, `${args.join(' ')}\n${fresh.output}`);
      assert.match(fresh.output, /Usage: setup-relay-node\.sh/);
    }
    await writeFile(
      path.join(work, 'relay-config.yaml'),
      [
        `${LEGACY.LEGACY_CONFIG_SECTION}:`,
        '  address: gw.example.com:9443',
        '  token: gw_node_used',
        `  cert_sha256: ${CERT}`,
        'worker:',
        '  service_port: 853',
        '  advertised_addresses:',
        '    - relay.example.com',
        '',
      ].join('\n')
    );
    runShell(`mkdir -p '${path.dirname(config)}' '${path.dirname(identity)}' && cp '${path.join(work, 'relay-config.yaml')}' '${config}' && echo pem > '${identity}'`);
    // Enrolled, no token: Opfield address, pin, advertised address and port come from the configuration.
    const kept = dryRun('setup-relay-node.sh', relayArgs);
    assert.equal(kept.status, 0, kept.output);
    assert.match(kept.output, /for Opfield gw\.example\.com:9443, advertised at relay\.example\.com:853\./);
    assert.match(kept.output, /no token was given: it keeps its identity/);
    assert.match(kept.output, /Would stop the relay supervisor and move the relay from its pre-Opfield names/);
    // What is given wins.
    const given = dryRun('setup-relay-node.sh', [...relayArgs, '--opfield', 'other.example.com:9443', '--service-port', '9444']);
    assert.match(given.output, /for Opfield other\.example\.com:9443, advertised at relay\.example\.com:9444\./, given.output);
    // With a token it re-enrolls.
    const reenroll = dryRun('setup-relay-node.sh', ['--token', 'gw_node_new', ...relayArgs]);
    assert.equal(reenroll.status, 2, 'a token alone is not a complete command for a new relay');
    const reenrollFull = dryRun('setup-relay-node.sh', ['--token', 'gw_node_new', ...relayArgs, ...full]);
    assert.equal(reenrollFull.status, 0, reenrollFull.output);
    assert.match(reenrollFull.output, /a token was given: it re-enrolls, and keeps its previous identity if Opfield refuses the token/);
    // A configuration that lacks the values cannot be re-run without them.
    runShell(`printf '${LEGACY.LEGACY_CONFIG_SECTION}:\\n  token: x\\n' > '${config}'`);
    const incomplete = dryRun('setup-relay-node.sh', relayArgs);
    assert.equal(incomplete.status, 2, incomplete.output);
    assert.match(incomplete.output, /does not name its Opfield address, certificate pin and advertised address/);
    // The same relay under the Opfield names (an opfield: section) needs no move.
    const current = path.join(host, 'etc/opfield-relay/config.yaml');
    const currentIdentity = path.join(host, 'var/lib/opfield-relay/supervisor-identity/node.pem');
    runShell(
      `rm -rf '${legacyConfigDir}' '${legacyStateDir}' && mkdir -p '${path.dirname(current)}' '${path.dirname(currentIdentity)}' && sed 's/^${LEGACY.LEGACY_CONFIG_SECTION}:/opfield:/' '${path.join(work, 'relay-config.yaml')}' > '${current}' && echo pem > '${currentIdentity}'`
    );
    const moved = dryRun('setup-relay-node.sh', relayArgs);
    assert.equal(moved.status, 0, moved.output);
    assert.match(moved.output, /for Opfield gw\.example\.com:9443, advertised at relay\.example\.com:853\./);
    assert.doesNotMatch(moved.output, /pre-Opfield names/);
    // Releases before the Opfield names come with the installer of their release.
    const old = dryRun('setup-relay-node.sh', ['--version', 'v2.12.0']);
    assert.equal(old.status, 1, old.output);
    assert.match(old.output, /installs relay v2\.12\.1-rc\.3 or newer/);
    runShell(`rm -rf '${path.join(host, 'etc/opfield-relay')}' '${path.join(host, 'var/lib/opfield-relay')}'`);
  } finally {
    runShell(`rm -rf '${config}' '${identity}' '${path.join(work, 'relay-config.yaml')}' '${legacyConfigDir}' '${legacyStateDir}'`);
  }

  const source = readFileSync(path.join(scriptsDir, 'setup-relay-node.sh'), 'utf8');
  // No token, no token line: a token in the configuration of an enrolled supervisor starts a re-enrollment.
  const start = source.indexOf('OPFIELD_TOKEN_YAML=""');
  const end = source.indexOf('\nCONFIG\n', start) + '\nCONFIG\n'.length;
  const rendered = path.join(work, 'rendered-relay-config.yaml');
  const render = (token) => {
    const result = runShell(
      [
        `OPFIELD_ADDRESS=gw.example.com:9443; TOKEN='${token}'; OPFIELD_CERT_SHA256=${CERT}; HOST_IDENTITY_PATH=/h; SERVICE_PORT=9443; ADVERTISE_ADDRESS=relay.example.com`,
        `RELAY_CONFIG='${rendered}'; RELAY_STATE_DIR=/var/lib/opfield-relay; RELAY_WORKER_BINARY=/usr/local/lib/opfield-relay/opfield-relay`,
        source.slice(start, end),
      ].join('\n')
    );
    assert.equal(result.status, 0, result.output);
    return readFileSync(rendered, 'utf8');
  };
  assert.doesNotMatch(render(''), /token:/);
  assert.match(render(''), /^opfield:\n {2}address: gw\.example\.com:9443\n {2}cert_sha256: /);
  assert.match(render(''), /^state_dir: \/var\/lib\/opfield-relay$/m);
  assert.match(render(''), /^ {2}binary_path: \/usr\/local\/lib\/opfield-relay\/opfield-relay$/m);
  assert.match(render('gw_node_new'), /^ {2}address: gw\.example\.com:9443\n {2}token: gw_node_new\n {2}cert_sha256:/m);
  // Without a token there is no enrollment result to wait for, only the control session.
  assert.match(source, /Without a token there is no enrollment to wait for[^\n]*\n\s+\[\[ -n "\$TOKEN" \]\] \|\| enrolled=1/);
  // A refused re-enrollment token is a failure that says the relay still runs.
  assert.match(source, /enrollment_status" -eq 1 && "\$REENROLLMENT" -eq 1[\s\S]*keeps running with its previous identity, but it was not re-enrolled[\s\S]*without --token[\s\S]*exit 1/);
});

// Secure Runtime is optional: a host that does not support it gets a warning with the reason and no question; only an
// explicit --secure-runtime fails the install, with that reason. An install that is declined or stopped after the
// summary never exits 0 ("Installation not completed" with exit 0 left a pending node and a green script).
test('Docker install without Secure Runtime support continues with the reason, and no installer exits 0 when incomplete', { skip: !linux }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'opfield-secure-runtime-'));
  try {
    const source = readFileSync(path.join(scriptsDir, 'setup-docker-node.sh'), 'utf8');
    assert.doesNotMatch(source, /Continue without Secure Runtimes\?/, 'the question is gone');
    const body = shellFunction(source, 'setup_secure_runtime');
    const run = async ({ secureRuntime, preflightExit, installExit = 0 }) => {
      const daemon = path.join(dir, 'docker-daemon');
      await writeFile(
        daemon,
        [
          '#!/bin/sh',
          'case "$*" in',
          `  *--silent*) exit ${preflightExit} ;;`,
          '  *--plain*) printf "unsupported\\tdocker_reload_unavailable\\tsystemd Docker service cannot be reloaded\\n"; exit 20 ;;',
          `  *"runtime install"*) exit ${installExit} ;;`,
          'esac',
          '',
        ].join('\n'),
        { mode: 0o755 }
      );
      return runShell(
        [
          'set -euo pipefail',
          `DOCKER_MODE=docker; EXISTING_INSTALL=0; SECURE_RUNTIME=${secureRuntime}; NON_INTERACTIVE=0; ROOT_DAEMON_BINARY='${daemon}'`,
          'prepare_root_daemon_binary() { :; }',
          'ok() { echo "OK $*"; }',
          'log() { echo "LOG $*"; }',
          'warn() { echo "WARN $*"; }',
          'err() { echo "ERR $*" >&2; }',
          'die() { err "$@"; exit 1; }',
          'prompt_yes_no() { echo PROMPTED; return 1; }',
          'complete_incomplete() { echo INCOMPLETE; exit 1; }',
          body,
          'setup_secure_runtime',
          'echo CONTINUED',
        ].join('\n')
      );
    };
    // Unsupported, not requested: warns with the reason, no question, continues.
    const unsupported = await run({ secureRuntime: 0, preflightExit: 20 });
    assert.equal(unsupported.status, 0, unsupported.output);
    assert.match(unsupported.output, /WARN Continuing without Secure Runtime \(systemd Docker service cannot be reloaded\)/);
    assert.match(unsupported.output, /CONTINUED/);
    assert.doesNotMatch(unsupported.output, /PROMPTED|INCOMPLETE/);
    // A setup that fails behaves the same.
    const failed = await run({ secureRuntime: 0, preflightExit: 10, installExit: 1 });
    assert.equal(failed.status, 0, failed.output);
    assert.doesNotMatch(failed.output, /PROMPTED/);
    // Requested explicitly: the install fails with the reason.
    const requested = await run({ secureRuntime: 1, preflightExit: 20 });
    assert.equal(requested.status, 1, requested.output);
    assert.match(requested.output, /Secure Runtime is not installed on this node: systemd Docker service cannot be reloaded\./);
    assert.doesNotMatch(requested.output, /CONTINUED/);
    // A ready Secure Runtime is not a warning.
    const ready = await run({ secureRuntime: 0, preflightExit: 0 });
    assert.match(ready.output, /OK Secure Runtime is ready/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  for (const script of ['setup-docker-node.sh', 'setup-monitoring-node.sh', 'setup-node.sh']) {
    const source = readFileSync(path.join(scriptsDir, script), 'utf8');
    assert.match(shellFunction(source, 'complete_incomplete'), /\n\s+exit 1\n\}$/, `${script} declined install exits non-zero`);
    assert.doesNotMatch(source, /complete_incomplete\n\s+exit 0/, script);
  }
  // Installers without that helper have no "not completed" path at all.
  for (const script of installers) {
    const source = readFileSync(path.join(scriptsDir, script), 'utf8');
    if (!source.includes('complete_incomplete()')) assert.doesNotMatch(source, /Installation not completed/, script);
  }
});

// A launcher that stopped but whose parent never reaps it (PID 1 of a container) stays a zombie, which kill -0 counts as
// running: a re-run in manual mode waited 30 s, gave up and left the host without a daemon.
test('a zombie launcher counts as stopped in every installer that stops launchers', { skip: !linux }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'opfield-zombie-'));
  const holder = spawn('bash', ['-c', 'trap "" TERM; sleep 120'], { stdio: 'ignore' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const pid = holder.pid;
    const proc = path.join(dir, 'proc');
    const fake = (name, content) => runShell(`mkdir -p '${proc}/${pid}' '${proc}/self' && printf '%s' '${content}' > '${proc}/${name}'`);
    fake('self/stat', '1 (bash) S 0');
    const scripts = {
      'setup-monitoring-node.sh': 'monitoring',
      'setup-docker-node.sh': 'docker',
      'setup-node.sh': 'nginx',
      'setup-relay-node.sh': 'relay',
    };
    for (const [script, type] of Object.entries(scripts)) {
      const source = readFileSync(path.join(scriptsDir, script), 'utf8');
      const functionsText = ['launcher_pid_is_live', 'launcher_pid_from_json', 'stop_manual_launcher']
        .map((name) => shellFunction(source, name).replaceAll('/proc/', `${proc}/`))
        .join('\n');
      const check = (stat, withStop = false) => {
        fake(`${pid}/stat`, stat);
        // The process is alive for the kernel (it ignores TERM) and has the launcher's command line.
        runShell(`printf '%s\\0' x launcher --daemon-type ${type} y > '${proc}/${pid}/cmdline'`);
        const launcherDir = path.join(dir, `launcher-${type}`);
        runShell(`mkdir -p '${launcherDir}' && printf '{"pid":${pid}}' > '${launcherDir}/owner.json'`);
        const started = Date.now();
        const live = runShell(`${functionsText}\nlauncher_pid_is_live ${pid} && echo LIVE || echo STOPPED`);
        // Stopping a launcher that is really alive waits 30 s, so only the zombie is stopped here.
        const stopped = withStop
          ? runShell(`${functionsText}\nstop_manual_launcher '${launcherDir}' ${type} && echo STOP-OK || echo STOP-FAILED`)
          : { output: '' };
        return { live: live.output.trim(), stopped: stopped.output.trim(), seconds: (Date.now() - started) / 1000 };
      };
      const zombie = check(`${pid} (relay-sup) Z 1 1 1`, true);
      assert.equal(zombie.live, 'STOPPED', script);
      assert.equal(zombie.stopped, 'STOP-OK', script);
      assert.ok(zombie.seconds < 10, `${script} does not wait for a zombie (${zombie.seconds} s)`);
      // A command name with ") " in it does not hide the state; a running launcher is alive.
      assert.equal(check(`${pid} (a) b) Z 1`).live, 'STOPPED', script);
      assert.equal(check(`${pid} (a) b) S 1`).live, 'LIVE', script);
      assert.equal(check(`${pid} (launcher) R 1`).live, 'LIVE', script);
    }
  } finally {
    holder.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

// Switching a node away from a non-root user: the old daemon used to be stopped first, long before the new one started,
// and systemd drops its file descriptor store at a stop, so the link sockets it had handed over were closed and the
// traffic reset (about 1-2 s lost; root to user, a restart, lost nothing). The daemon now keeps serving with what its
// user owns until just before the new process starts; the store is kept through the stop, the ownership change and the
// start, so connections made meanwhile wait in the sockets' backlog.
test('a switch away from a non-root user stops the daemon last and keeps its link sockets', { skip: !linux }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'opfield-switch-'));
  try {
    const nodes = {
      'setup-docker-node.sh': { unit: 'docker-daemon', own: 'DOCKER_DAEMON_OWN_DIR=/o; DOCKER_REGISTRY_PROXY_TRUST_DIR=/t' },
      'setup-node.sh': { unit: 'nginx-daemon', own: 'NGINX_DAEMON_OWN_DIR=/o; NGINX_DAEMON_RUNTIME_DIRS=(nginx-daemon)' },
    };
    for (const [script, { unit, own }] of Object.entries(nodes)) {
      const source = readFileSync(path.join(scriptsDir, script), 'utf8');
      // Static order: the stop comes right before the start, after everything else is prepared.
      const { topLevel, functions } = parseShell(source);
      const firstRun = (name) => Math.min(...topLevel.filter((entry) => entry.calls.includes(name)).map((entry) => entry.line));
      const finish = firstRun('finish_run_user_switch');
      assert.ok(Number.isFinite(finish), `${script} finishes the switch at the top level`);
      for (const before of ['enroll_daemon', 'apply_host_access_config', 'install_daemon']) assert.ok(firstRun(before) < finish, `${script}: ${before} before the stop`);
      assert.ok(finish < firstRun('start_daemon'), `${script}: the stop is right before the start`);
      assert.ok(!functions.get('install_daemon').calls.has('stop_daemon_service'));
      assert.match(source, /systemctl restart [a-z-]+ >> "\$LOG_FILE" 2>&1 \|\| \{ release_fd_store_hold; fail_daemon_start[^\n]*\n\s+release_fd_store_hold\n/);

      const launcher = path.join(dir, `${unit}-launcher`);
      const holdFile = path.join(dir, `${unit}-hold.conf`);
      const unitFile = path.join(dir, `${unit}.service`);
      await writeFile(unitFile, '[Service]\n');
      const calls = path.join(dir, `${unit}-calls`);
      // The Docker installer also hands the lease watchdog records over with the daemon's paths (to a directory of the
      // test here).
      const names = ['grant_daemon_paths_to_run_user', 'prepare_run_user_switch', 'hold_fd_store', 'release_fd_store_hold', 'finish_run_user_switch'];
      if (source.includes('\nhand_lease_records_to_run_user() {')) names.push('hand_lease_records_to_run_user');
      const text = names
        .map((name) =>
          shellFunction(source, name)
            .replaceAll(`/var/lib/${unit}/launcher`, launcher)
            .replaceAll(`/etc/systemd/system/${unit}.service`, unitFile)
        )
        .join('\n');
      const fdHold = `FD_STORE_HOLD='${holdFile}'; LEASE_RECORDS_DIR='${path.join(dir, `${unit}-records`)}'`;
      const run = async ({ enrolled, token = '', stopFails = false, steps }) => {
        await writeFile(calls, '');
        runShell(`mkdir -p '${launcher}'`);
        const result = runShell(
          [
            'set -euo pipefail',
            `RUN_USER=root; PREVIOUS_RUN_UID=1000; EXISTING_ENROLLED=${enrolled}; ENROLL_TOKEN='${token}'; LOG_FILE=/dev/null; RUN_GROUP=root; RUN_USER_SWITCH_PENDING=0`,
            own,
            fdHold,
            'log() { echo "LOG $*"; }',
            'err() { echo "ERR $*" >&2; }',
            'die() { err "$@"; exit 1; }',
            'id() { echo 0; }',
            'has_systemd() { return 0; }',
            `systemctl() { echo "systemctl $*" >> '${calls}'; }`,
            'install() { mkdir -p "${@: -1}"; }',
            `stop_daemon_service() { echo "stop launcher-present=$([[ -d '${launcher}' ]] && echo yes || echo no) preserve=$(grep -c '^FileDescriptorStorePreserve=yes$' '${holdFile}' 2>/dev/null || true)" >> '${calls}'; ${stopFails ? 'return 1' : 'return 0'}; }`,
            `return_paths_to_root() { echo "return_paths_to_root launcher-present=$([[ -d '${launcher}' ]] && echo yes || echo no)" >> '${calls}'; }`,
            text,
            ...steps,
          ].join('\n')
        );
        return { ...result, calls: readFileSync(calls, 'utf8'), hold: spawnSync('test', ['-e', holdFile]).status === 0 };
      };
      // Enrolled, no token: nothing stops at the start, ownership stays with the old user, and the stop comes last.
      const early = await run({ enrolled: 1, steps: ['prepare_run_user_switch', 'grant_daemon_paths_to_run_user', 'echo AFTER-PREPARE'] });
      assert.equal(early.status, 0, early.output);
      assert.match(early.output, /switching it to root/);
      assert.equal(early.calls, '', `${script}: no stop and no ownership change before the start is near`);
      assert.equal(spawnSync('test', ['-d', launcher]).status, 0, 'the launcher copies stay until the stop');
      const late = await run({
        enrolled: 1,
        steps: ['prepare_run_user_switch', 'grant_daemon_paths_to_run_user', 'finish_run_user_switch', `echo "HOLD-AFTER-FINISH=$([[ -f '${holdFile}' ]] && echo yes || echo no)"`, 'release_fd_store_hold'],
      });
      assert.equal(late.status, 0, late.output);
      assert.match(late.calls, /systemctl daemon-reload\nstop launcher-present=yes preserve=1\nreturn_paths_to_root launcher-present=no\n/, `${script}\n${late.calls}`);
      assert.match(late.output, /HOLD-AFTER-FINISH=yes/, 'the store is kept until the new process started');
      assert.equal(late.hold, false, 'the hold is released afterwards');
      // A node that enrolls again runs steps as the new user first, so its daemon stops at once, as before.
      const withToken = await run({ enrolled: 1, token: 'gw_node_x', steps: ['prepare_run_user_switch', 'echo AFTER'] });
      const notEnrolled = await run({ enrolled: 0, steps: ['prepare_run_user_switch', 'echo AFTER'] });
      for (const immediate of script === 'setup-node.sh' ? [withToken, notEnrolled] : [notEnrolled]) {
        assert.match(immediate.calls, /^stop launcher-present=yes/, `${script} stops at once\n${immediate.calls}`);
        assert.equal(spawnSync('test', ['-d', launcher]).status, 1, 'and removes the launcher copies');
      }
      // A stop that fails does not leave the store held, and the install stops.
      const failed = await run({ enrolled: 1, stopFails: true, steps: ['prepare_run_user_switch', 'finish_run_user_switch', 'echo AFTER'] });
      assert.equal(failed.status, 1, failed.output);
      assert.match(failed.output, new RegExp(`Could not stop ${unit} to switch its user`));
      assert.equal(failed.hold, false);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Every upgrade by an installer backs the previous binary (and nginx configs) up; only the newest backup is kept, so
// re-running an installer does not pile up copies of the daemon binary on the host.
test('an installer keeps only the newest backup of a file it replaces', { skip: !linux }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'opfield-backups-'));
  try {
    for (const name of ['setup-docker-node.sh', 'setup-monitoring-node.sh', 'setup-node.sh']) {
      const source = readFileSync(path.join(scriptsDir, name), 'utf8');
      const target = path.join(dir, `${name}.bin`);
      const older = [`${target}.backup.20260101_000000`, `${target}.backup.20260102_000000`];
      const keep = `${target}.backup.20260103_000000`;
      const unrelated = [`${target}.backup.mine`, `${target}.previous`, `${target}-other.backup.20260101_000000`];
      for (const file of [...older, keep, ...unrelated]) await writeFile(file, 'x');
      const run = runShell(["IFS=$'\\n\\t'", shellFunction(source, 'prune_older_backups'), `prune_older_backups '${target}' '${keep}'`].join('\n'));
      assert.equal(run.status, 0, run.output);
      const left = (await readdir(dir)).filter((file) => file.startsWith(`${name}.bin`)).sort();
      assert.deepEqual(
        left,
        [keep, ...unrelated].map((file) => path.basename(file)).filter((file) => file.startsWith(`${name}.bin`)).sort(),
        name
      );
      for (const file of await readdir(dir)) await rm(path.join(dir, file));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A re-run without --version on a node running a newer pre-release resolved "latest" to the older stable release and
// downgraded the node (stand rc.20). No installer moves a node to an older daemon unless --version names it.
test('a re-run never installs an older daemon than the installed one unless --version names it', { skip: !linux }, () => {
  const order = [
    ['v2.11.0', 'v2.11.1-rc.20', true],
    ['v2.11.1-rc.20', 'v2.11.1', true],
    ['v2.11.1-rc.9', 'v2.11.1-rc.20', true],
    ['v2.10.9', 'v2.11.0', true],
    ['v2.11.1', 'v2.11.1-rc.20', false],
    ['v2.11.1', 'v2.11.1', false],
    ['v2.12.0', 'v2.11.9', false],
  ];
  for (const name of ['setup-docker-node.sh', 'setup-node.sh', 'setup-monitoring-node.sh', 'setup-relay-node.sh']) {
    const source = readFileSync(path.join(scriptsDir, name), 'utf8');
    for (const [older, newer, expected] of order) {
      const run = runShell(
        ["IFS=$'\\n\\t'", shellFunction(source, 'daemon_version_older'), `daemon_version_older '${older}' '${newer}'`].join('\n')
      );
      assert.equal(run.status === 0, expected, `${name}: ${older} < ${newer}`);
    }
  }
  for (const name of ['setup-docker-node.sh', 'setup-node.sh', 'setup-monitoring-node.sh']) {
    const source = readFileSync(path.join(scriptsDir, name), 'utf8');
    const keep = (requested, installed) =>
      runShell(
        [
          "IFS=$'\\n\\t'",
          shellFunction(source, 'daemon_version_older'),
          shellFunction(source, 'keep_installed_newer_daemon'),
          'warn() { echo "WARN $*"; }',
          'resolve_download_url() { RESOLVED_DAEMON_VERSION="$1"; }',
          `DAEMON_VERSION='${requested}' EXISTING_INSTALL=1 EXISTING_VERSION='${installed}' RESOLVED_DAEMON_VERSION=v2.11.0`,
          'keep_installed_newer_daemon test-daemon',
          'echo "install=$RESOLVED_DAEMON_VERSION"',
        ].join('\n')
      ).output;
    const kept = keep('latest', 'v2.11.1-rc.20');
    assert.match(kept, /test-daemon v2\.11\.1-rc\.20 is installed; latest resolves to the older v2\.11\.0/, name);
    assert.match(kept, /install=v2\.11\.1-rc\.20/, name);
    assert.match(keep('v2.11.0', 'v2.11.1-rc.20'), /install=v2\.11\.0/, name);
    assert.doesNotMatch(keep('latest', 'v2.10.4'), /WARN/, name);
    assert.match(keep('latest', 'unknown'), /install=v2\.11\.0/, name);
  }
  const relay = readFileSync(path.join(scriptsDir, 'setup-relay-node.sh'), 'utf8');
  const relayVersion = (requested, installed) =>
    runShell(
      [
        "IFS=$'\\n\\t'",
        shellFunction(relay, 'daemon_version_older'),
        shellFunction(relay, 'relay_version_to_install'),
        `installed_supervisor_version() { echo '${installed}'; }`,
        `relay_version_to_install '${requested}' v2.11.0`,
      ].join('\n')
    ).output;
  assert.match(relayVersion('latest', 'v2.11.1-rc.20'), /^v2\.11\.1-rc\.20\n[\s\S]*Keeping v2\.11\.1-rc\.20; pass --version v2\.11\.0/);
  assert.match(relayVersion('v2.11.0', 'v2.11.1-rc.20'), /^v2\.11\.0\n?$/);
  assert.match(relayVersion('latest', ''), /^v2\.11\.0\n?$/);
});

// rc.20: a run-user switch left the watchdog records to the previous daemon user. The watchdog is restarted (with the
// new records owner) after the switch, and whenever it is installed, even when no release could be resolved.
test('the Docker installer restarts an installed lease watchdog after the run-user switch', { skip: !linux }, async () => {
  const source = readFileSync(path.join(scriptsDir, 'setup-docker-node.sh'), 'utf8');
  const { topLevel } = parseShell(source);
  const firstRun = (name) => Math.min(...topLevel.filter((entry) => entry.calls.includes(name)).map((entry) => entry.line));
  assert.ok(firstRun('finish_run_user_switch') < firstRun('start_lease_watchdog'));
  assert.ok(firstRun('start_lease_watchdog') < firstRun('start_daemon'));
  const dir = await mkdtemp(path.join(tmpdir(), 'opfield-watchdog-'));
  try {
    const binary = path.join(dir, LEGACY.LEGACY_LEASE_WATCHDOG);
    await writeFile(binary, '#!/bin/sh\n', { mode: 0o755 });
    const run = (installed, bin, mode = 'docker') =>
      runShell(
        [
          "IFS=$'\\n\\t'",
          // Its heredocs hold a `}` line of their own (OpenRC depend()): the function ends at the `}` before a blank line.
          /^lease_watchdog_profile\(\) \{\n[\s\S]*?^\}$/m.exec(source)[0],
          /^start_lease_watchdog\(\) \{\n[\s\S]*?^\}$(?=\n\n)/m.exec(source)[0],
          'has_systemd() { return 1; }; has_openrc() { return 1; }; warn() { echo "WARN $*"; }; ok() { echo "OK $*"; }',
          `DOCKER_MODE=${mode} LEASE_WATCHDOG_INSTALLED=${installed} LEASE_WATCHDOG_BIN='${bin}' RUN_USER=gwdock`,
          'start_lease_watchdog; echo done',
        ].join('\n')
      ).output;
    // Installed but not (re)downloaded by this run: it is still restarted (here: no service manager to do it with).
    assert.match(run(0, binary), /No service manager for the lease watchdog/);
    assert.doesNotMatch(run(0, path.join(dir, 'missing')), /WARN/);
    // Storage nodes (availability sets) run it too; the Build Worker does not.
    assert.match(run(0, binary, 'storage'), /No service manager for the lease watchdog/);
    assert.match(run(0, binary, 'databases'), /No service manager for the lease watchdog/);
    assert.doesNotMatch(run(0, binary, 'builder'), /WARN/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// rc.21: a switch to a non-root daemon left the record files to root (only the directory followed), the new daemon could
// not read them and the watchdog fenced the node's Availability copies. The switch hands the directory and the record
// files to the new user, never a file linked in from elsewhere; the watchdog follows the daemon's release channel.
test('a run-user switch hands the lease watchdog records to the new daemon user', { skip: !linux || userInfo().uid !== 0 }, async () => {
  const source = readFileSync(path.join(scriptsDir, 'setup-docker-node.sh'), 'utf8');
  const dir = await mkdtemp(path.join(tmpdir(), 'opfield-records-'));
  try {
    const records = path.join(dir, 'records');
    const outside = path.join(dir, 'outside');
    const record = path.join(records, `${'a'.repeat(64)}.json`);
    const run = (user, group) =>
      runShell(
        [
          /^hand_lease_records_to_run_user\(\) \{\n[\s\S]*?^\}$/m.exec(source)[0],
          'warn() { echo "WARN $*"; }',
          `LOG_FILE=/dev/null LEASE_RECORDS_DIR='${records}' RUN_USER=${user} RUN_GROUP=${group}`,
          `mkdir -p '${records}' && touch '${record}' '${outside}' && ln -f '${outside}' '${records}/linked.json'`,
          `hand_lease_records_to_run_user && stat -c '%u' '${records}' '${record}' '${outside}'`,
        ].join('\n')
      ).output;
    const nobody = String(Number(spawnSync('id', ['-u', 'nobody'], { encoding: 'utf8' }).stdout.trim()));
    const group = spawnSync('id', ['-gn', 'nobody'], { encoding: 'utf8' }).stdout.trim();
    assert.deepEqual(run('nobody', group).trim().split('\n'), [nobody, nobody, '0']);
    assert.deepEqual(run('root', 'root').trim().split('\n'), ['0', '0', '0']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const channel = (version) =>
    runShell([/^lease_watchdog_channel\(\) \{\n[\s\S]*?^\}$/m.exec(source)[0], `RESOLVED_DAEMON_VERSION=${version}`, 'lease_watchdog_channel'].join('\n'))
      .output.trim();
  assert.equal(channel('v2.11.1-rc.22'), 'preview');
  assert.equal(channel('v2.11.1'), 'stable');
  assert.match(source, /component=lease-watchdog&channel=\$\(lease_watchdog_channel\)/);
  assert.match(source, /--records-owner \$\{RUN_USER\}.*--channel \$\(lease_watchdog_channel\)/);
});

// F-C5: re-running the generated nginx command with its used token moved the working enrollment aside, Opfield refused
// the token and the node was left without an enrollment. The refused run restores it and restarts the daemon on it, and
// a re-run with the token a completed enrollment used keeps the enrollment from the start.
test('the nginx installer keeps or restores the enrollment when its token was used', { skip: !linux }, async () => {
  const source = readFileSync(path.join(scriptsDir, 'setup-node.sh'), 'utf8');
  const dir = await mkdtemp(path.join(tmpdir(), 'opfield-enrollment-'));
  try {
    const etc = path.join(dir, 'etc');
    const lib = path.join(dir, 'lib');
    const functions = ['reset_existing_enrollment_for_token', 'restore_previous_enrollment', 'enrollment_token_digest', 'keep_enrollment_of_used_token', 'remember_enrollment_token']
      .map((name) => shellFunction(source, name).replaceAll('/etc/nginx-daemon', etc).replaceAll('/var/lib/nginx-daemon', lib))
      .join('\n');
    const run = (steps) =>
      runShell(
        [
          'set -euo pipefail',
          `LOG_FILE=/dev/null RUN_USER=$(id -un) RUN_GROUP=$(id -gn) ENROLLMENT_BACKUP_DIR='' ENROLLMENT_RESTORED=0 ENROLLMENT_TOKEN_DIGEST_FILE='${lib}/enrollment-token.sha256'`,
          'log() { echo "LOG $*"; }; ok() { echo "OK $*"; }; warn() { echo "WARN $*"; }',
          'stop_daemon_service() { echo STOP; }; restart_daemon_service() { echo RESTART; }; grant_daemon_paths_to_run_user() { :; }',
          'forget_control_session() { :; }; apply_host_access_config() { :; }',
          functions,
          `mkdir -p '${etc}/certs' '${lib}' && echo OLD > '${etc}/certs/node.pem' && echo '{}' > '${lib}/state.json'`,
          `printf 'opfield:\\n  token: ""\\n' > '${etc}/config.yaml'`,
          ...steps,
        ].join('\n')
      );
    // Refused: the enrollment set aside comes back with its configuration, and the daemon restarts on it.
    let result = run([
      'ENROLL_TOKEN=used; reset_existing_enrollment_for_token',
      `printf 'opfield:\\n  token: "used"\\n' > '${etc}/config.yaml'`,
      'restore_previous_enrollment; echo "restored=$ENROLLMENT_RESTORED"',
      `cat '${etc}/certs/node.pem' '${lib}/state.json' '${etc}/config.yaml'`,
    ]);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /RESTART\n[\s\S]*restored=1\nOLD\n\{\}\nopfield:\n {2}token: ""/);
    // A new enrollment that completed stays.
    result = run([
      'ENROLL_TOKEN=fresh; reset_existing_enrollment_for_token',
      `mkdir -p '${etc}/certs' && echo NEW > '${etc}/certs/node.pem'`,
      'restore_previous_enrollment; echo "restored=$ENROLLMENT_RESTORED"',
      `cat '${etc}/certs/node.pem'`,
    ]);
    assert.match(result.output, /restored=0\nNEW/);
    assert.doesNotMatch(result.output, /RESTART/);
    // The token of a completed enrollment is remembered (as a digest) and a re-run with it keeps the enrollment.
    result = run([
      'ENROLL_TOKEN=done; remember_enrollment_token',
      `grep -c done '${lib}/enrollment-token.sha256' || true`,
      'EXISTING_ENROLLED=1; ENROLL_TOKEN=done; keep_enrollment_of_used_token; echo "token=[$ENROLL_TOKEN]"',
      'ENROLL_TOKEN=other; keep_enrollment_of_used_token; echo "token=[$ENROLL_TOKEN]"',
    ]);
    assert.match(result.output, /^0\n[\s\S]*token=\[\]\ntoken=\[other\]/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// F-B2: a package manager that stays locked ended the install silently with apt's exit status. The installer names
// apt's reason (the lock holder) and its log.
test('the nginx installer names the apt failure', { skip: !linux }, () => {
  const source = readFileSync(path.join(scriptsDir, 'setup-node.sh'), 'utf8');
  const result = runShell(
    [
      'set -euo pipefail',
      'LOG_FILE=/tmp/opfield-node-test.log; APT_LOCK_RETRY_ATTEMPTS=2; APT_LOCK_RETRY_DELAY_SECONDS=0',
      'warn() { echo "WARN $*"; }; die() { echo "ERROR $*"; exit 1; }',
      'apt-get() { echo "E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 906 (python3)"; return 100; }',
      shellFunction(source, 'apt_failed'),
      shellFunction(source, 'run_apt_with_lock_retry')
        .replaceAll('>> "$LOG_FILE"', '>/dev/null')
        .replaceAll('mktemp /tmp/opfield-node-apt.XXXXXX', 'mktemp "${TMPDIR:-/tmp}/opfield-node-apt.XXXXXX"'),
      'run_apt_with_lock_retry install -y -qq nginx',
    ].join('\n')
  );
  assert.notEqual(result.status, 0);
  assert.match(result.output, /WARN Package manager is busy; retrying/);
  assert.match(result.output, /ERROR apt-get install failed: E: Could not get lock \/var\/lib\/dpkg\/lock-frontend\. It is held by process 906 \(python3\) See \/tmp\/opfield-node-test\.log/);
});

// F-C6: a root nginx -t gives nginx's temp directories to the user nginx.conf names (www-data); an nginx running as the
// daemon's user then truncated every response larger than its buffers. The installer gives them back to that user.
test('the nginx installer gives the nginx temp directories to a non-root run user', { skip: !linux }, async () => {
  const source = readFileSync(path.join(scriptsDir, 'setup-node.sh'), 'utf8');
  const dir = await mkdtemp(path.join(tmpdir(), 'opfield-nginx-temp-'));
  try {
    const build = `nginx version: nginx/1.22.1\\nconfigure arguments: --prefix=${dir}/share --http-client-body-temp-path=${dir}/body --http-proxy-temp-path=${dir}/proxy --http-fastcgi-temp-path=fastcgi`;
    const paths = runShell([`nginx() { printf '%b\\n' '${build}' >&2; }`, shellFunction(source, 'nginx_temp_paths'), 'nginx_temp_paths'].join('\n'));
    assert.deepEqual(paths.output.trim().split('\n'), [`${dir}/body`, `${dir}/proxy`, `${dir}/share/fastcgi`]);
    assert.match(shellFunction(source, 'configure_nginx'), /hand_nginx_temp_paths_to_run_user\n\}$/);
    if (userInfo().uid !== 0) return;
    const result = runShell(
      [
        `nginx() { printf '%b\\n' '${build}' >&2; }; command_exists() { return 0; }; warn() { echo "WARN $*"; }`,
        shellFunction(source, 'nginx_temp_paths'),
        shellFunction(source, 'hand_nginx_temp_paths_to_run_user'),
        `mkdir -p '${dir}/body' '${dir}/proxy/1' && LOG_FILE=/dev/null RUN_USER=nobody RUN_GROUP=$(id -gn nobody) hand_nginx_temp_paths_to_run_user`,
        `stat -c '%U' '${dir}/body' '${dir}/proxy/1'`,
      ].join('\n')
    );
    assert.equal(result.output.trim(), 'nobody\nnobody', result.output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// F-B5: a relay installed through a mirror (OPFIELD_ARTIFACT_BASE_URL) took its binaries from the origin named in the
// signed manifest. It takes them from the mirror, next to their manifests, and they must still match the signed
// checksum. F-B4: the latest release resolves without jq, which a dry run cannot install.
test('the relay installer downloads its binaries from the mirror and checks them against the signed manifest', { skip: !linux || spawnSync('sh', ['-c', 'command -v jq']).status !== 0 }, async () => {
  const source = readFileSync(path.join(scriptsDir, 'setup-relay-node.sh'), 'utf8');
  const dir = await mkdtemp(path.join(tmpdir(), 'opfield-relay-mirror-'));
  try {
    const name = 'relay-supervisor-linux-amd64';
    const tag = 'v2.11.1-relay';
    const binary = 'relay supervisor binary\n';
    const sha256 = (text) => spawnSync('sha256sum', { input: text, encoding: 'utf8' }).stdout.split(' ')[0];
    const base64url = (text) => Buffer.from(text).toString('base64url');
    const manifest = (digest) =>
      JSON.stringify({
        schemaVersion: 1,
        keyId: LEGACY_UPDATE_KEY_ID,
        payload: base64url(
          JSON.stringify({
            kind: 'daemon-binary',
            version: 'v2.11.1',
            tag,
            daemonType: 'relay',
            arch: 'amd64',
            artifactName: name,
            // Not the artifact base: the test tells the two sources apart.
            downloadUrl: `https://objects.thesqlabs.com/opfield/relay-supervisor/${tag}/${name}`,
            sha256: digest,
          })
        ),
        signature: base64url('signature'),
      });
    const run = (env, digest, served = binary) => {
      runShell(`mkdir -p '${dir}/serve' '${dir}/tmp' && rm -f '${dir}/tmp/'* '${dir}/requests'`);
      return runShell(
        [
          'set -euo pipefail',
          `${env} LEGACY_ENV_PREFIX=${LEGACY.LEGACY_ENV_PREFIX} LEGACY_UPDATE_KEY_ID=${LEGACY.LEGACY_UPDATE_KEY_ID}`,
          shellFunction(source, 'legacy_installer_env'),
          'OPFIELD_ARTIFACT_BASE_URL="${OPFIELD_ARTIFACT_BASE_URL:-$(legacy_installer_env ARTIFACT_BASE_URL)}"',
          'ARTIFACT_BASE_URL="${OPFIELD_ARTIFACT_BASE_URL:-https://get.opfield.dev/opfield}"',
          `TAG=${tag}; VERSION=v2.11.1; ARCH=amd64; LOG_FILE=/dev/null; TEMP_DIR='${dir}/tmp'`,
          'PACKAGE_BASE="${ARTIFACT_BASE_URL%/}/relay-supervisor/${TAG}"',
          // The signature check is the real openssl call in the installer; here every signature verifies.
          'openssl() { case "$1" in pkeyutl) return 0 ;; base64) base64 -d ;; esac; }',
          `curl() { local url="" out=""; while [[ $# -gt 0 ]]; do case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done; echo "$url" >> '${dir}/requests'; case "$url" in *.update.json) printf '%s' "$MANIFEST" > "$out" ;; *) printf '%s' "$SERVED" > "$out" ;; esac; }`,
          `MANIFEST='${manifest(digest)}'; SERVED='${served}'`,
          shellFunction(source, 'decode_base64url'),
          shellFunction(source, 'relay_artifact_url'),
          shellFunction(source, 'fetch_verified'),
          `fetch_verified ${name} relay && echo FETCHED`,
          `cat '${dir}/requests'`,
        ].join('\n')
      );
    };
    const mirrored = run("OPFIELD_ARTIFACT_BASE_URL='http://mirror.example:18991/opfield/';", sha256(binary));
    assert.equal(mirrored.status, 0, mirrored.output);
    assert.match(mirrored.output, /FETCHED/);
    assert.deepEqual(mirrored.output.trim().split('\n').slice(-2), [
      `http://mirror.example:18991/opfield/relay-supervisor/${tag}/${name}.update.json`,
      `http://mirror.example:18991/opfield/relay-supervisor/${tag}/${name}`,
    ]);
    // Without a mirror the binary comes from the URL the signed manifest names.
    const origin = run('', sha256(binary));
    assert.equal(origin.status, 0, origin.output);
    assert.equal(origin.output.trim().split('\n').at(-1), `https://objects.thesqlabs.com/opfield/relay-supervisor/${tag}/${name}`);
    // A mirror that serves another binary is refused, as before.
    const tampered = run(`${LEGACY.LEGACY_ENV_PREFIX}ARTIFACT_BASE_URL='http://mirror.example:18991/opfield';`, sha256(binary), 'tampered\n');
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.output, /Checksum mismatch for relay-supervisor-linux-amd64/);
    assert.doesNotMatch(tampered.output, /FETCHED/);

    // The feed names its target release; jq is not needed to read it.
    const feed = JSON.stringify({ component: 'relay', current: null, target: { tag_name: 'v2.11.0-relay', body: 'x "tag_name":"v9.9.9-relay"' }, reason: 'latest' });
    const tagOf = (answer) =>
      runShell(
        [
          `RELEASES_API_URL=https://updates.example/opfield/releases; LOG_FILE=/dev/null`,
          `curl() { printf '%s' '${answer}'; }`,
          'jq() { echo "jq is not installed" >&2; return 127; }',
          shellFunction(source, 'relay_feed_tag'),
          'echo "tag=[$(relay_feed_tag)]"',
        ].join('\n')
      ).output.trim();
    assert.equal(tagOf(feed), 'tag=[v2.11.0-relay]');
    assert.equal(tagOf(feed.replace('v2.11.0-relay', 'v2.11.1-rc.24-relay')), 'tag=[v2.11.1-rc.24-relay]');
    assert.equal(tagOf('{"error":"release_source_unavailable"}'), 'tag=[]');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// INS-RLY-02: the relay setup log (OPFIELD_RELAY_SETUP_LOG) stayed empty and the package manager wrote to the terminal. The log holds what
// the terminal shows and the detail it does not.
test('the relay installer keeps a setup log with the terminal output and the detail', { skip: !linux }, async () => {
  const source = readFileSync(path.join(scriptsDir, 'setup-relay-node.sh'), 'utf8');
  const dir = await mkdtemp(path.join(tmpdir(), 'opfield-relay-log-'));
  try {
    const log = path.join(dir, 'relay-setup.log');
    const result = runShell(
      [
        'set -euo pipefail',
        // OPFIELD_RELAY_SETUP_LOG, as the installer reads it.
        `OPFIELD_RELAY_SETUP_LOG='${log}'; SETUP_LOG_PATH="\${OPFIELD_RELAY_SETUP_LOG:-}"; LOG_FILE=/dev/null`,
        'command_exists() { command -v "$1" >/dev/null 2>&1; }',
        'apt-get() { echo "apt-get $* output"; }',
        shellFunction(source, 'open_setup_log'),
        shellFunction(source, 'close_setup_log'),
        'SETUP_LOG_OUT_PID=""; SETUP_LOG_ERR_PID=""',
        'open_setup_log',
        'trap close_setup_log EXIT',
        'echo "Installing missing Relay installer dependencies: jq"',
        'apt-get install -y jq >>"$LOG_FILE" 2>&1',
        'echo "Relay enrollment failed: refused" >&2',
      ].join('\n')
    );
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Installing missing Relay installer dependencies: jq/);
    assert.match(result.output, /Relay enrollment failed: refused/);
    assert.doesNotMatch(result.output, /apt-get install -y jq output/, 'the package manager output stays out of the terminal');
    const written = await readFile(log, 'utf8');
    for (const line of ['Installing missing Relay installer dependencies: jq', 'apt-get install -y jq output', 'Relay enrollment failed: refused']) {
      assert.ok(written.includes(line), `${line}\n---\n${written}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// F-C1: a refused storage preflight removed only the storage root it created and left its new parents behind (an
// empty /var/lib/docker-daemon). It removes every directory it created, and none it found.
test('a refused storage preflight removes exactly the directories it created', { skip: !linux }, async () => {
  const source = readFileSync(path.join(scriptsDir, 'setup-docker-node.sh'), 'utf8');
  const dir = await mkdtemp(path.join(tmpdir(), 'opfield-storage-preflight-'));
  try {
    const result = runShell(
      [
        'set -euo pipefail',
        "IFS=$'\\n\\t'",
        'LOG_FILE=/dev/null; DATABASE_PREFLIGHT_DIR=""; DATABASE_PREFLIGHT_MOUNT_DIR=""; DATABASE_PREFLIGHT_LOOP_DEVICE=""; DATABASE_PREFLIGHT_CREATED_DIRS=""',
        'command_exists() { command -v "$1" >/dev/null 2>&1; }; die() { echo "DIE $*"; exit 1; }',
        shellFunction(source, 'create_database_storage_root'),
        shellFunction(source, 'cleanup_database_preflight'),
        `mkdir -p '${dir}/var/lib/kept' && echo data > '${dir}/var/lib/kept/file'`,
        `DATABASE_STORAGE_ROOT='${dir}/var/lib/docker-daemon/databases'`,
        'create_database_storage_root "$DATABASE_STORAGE_ROOT"',
        `test -d '${dir}/var/lib/docker-daemon/databases' && echo CREATED`,
        // A refused preflight: its probe directory is there, then the exit cleanup runs.
        'DATABASE_PREFLIGHT_DIR=$(mktemp -d "$DATABASE_STORAGE_ROOT/.opfield-db-preflight.XXXXXX"); mkdir "$DATABASE_PREFLIGHT_DIR/mnt"',
        'cleanup_database_preflight || true',
        `find '${dir}' -mindepth 1 | sort`,
        // A root that exists is never removed, nor are its parents.
        `mkdir -p '${dir}/srv/disk2/opfield-databases'`,
        `create_database_storage_root '${dir}/srv/disk2/opfield-databases/images'`,
        'cleanup_database_preflight || true',
        `find '${dir}/srv' | sort`,
      ].join('\n')
    );
    assert.equal(result.status, 0, result.output);
    const lines = result.output.trim().split('\n');
    assert.equal(lines[0], 'CREATED');
    assert.deepEqual(lines.slice(1, 5), [`${dir}/var`, `${dir}/var/lib`, `${dir}/var/lib/kept`, `${dir}/var/lib/kept/file`]);
    assert.deepEqual(lines.slice(5), [`${dir}/srv`, `${dir}/srv/disk2`, `${dir}/srv/disk2/opfield-databases`]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// F-B13: the daemon rewrites its config with four-space indentation; a re-run of the installer then inserted the
// profile again and nested the daemon's docker keys under docker.database. The installer reads and writes
// docker.mode and docker.database.storage_root, the keys the daemon reads, at any indentation and once.
test('the storage profile is written once to the keys the docker-daemon reads', { skip: !linux }, async () => {
  const source = readFileSync(path.join(scriptsDir, 'setup-docker-node.sh'), 'utf8');
  const dir = await mkdtemp(path.join(tmpdir(), 'opfield-storage-config-'));
  const config = path.join(dir, 'config.yaml');
  const write = async (content, root = '/srv/disk2/opfield-databases') => {
    await writeFile(config, content);
    const result = runShell(
      [
        'set -euo pipefail',
        "IFS=$'\\n\\t'",
        'ok() { echo "OK $*"; }; log() { echo "INFO $*"; }; die() { echo "DIE $*"; exit 1; }',
        `DOCKER_MODE=storage; RUN_USER=root; DATABASE_STORAGE_ROOT='${root}'`,
        shellFunction(source, 'docker_config_value'),
        shellFunction(source, 'restricted_node_kind'),
        shellFunction(source, 'repair_duplicated_database_profile'),
        shellFunction(source, 'set_database_profile_keys'),
        shellFunction(source, 'write_database_profile_config').replaceAll('/etc/docker-daemon/config.yaml', config),
        'write_database_profile_config',
        `for key in docker.mode docker.database.storage_root docker.socket; do printf '%s=%s\\n' "$key" "$(docker_config_value '${config}' "$key" || echo MISSING)"; done`,
      ].join('\n')
    );
    return { ...result, content: await readFile(config, 'utf8') };
  };
  const daemonLayout = [
    'opfield:',
    '    address: gw.example.com:9443',
    'docker:',
    '    allowlist:',
    "        - '*'",
    '    database:',
    '        storage_root: /srv/disk2/opfield-databases',
    '    mode: storage',
    '    socket: unix:///var/run/docker.sock',
    'state_dir: /var/lib/docker-daemon',
    '',
  ].join('\n');
  const keys = (output) => output.trim().split('\n').slice(-3);
  const expected = ['docker.mode=storage', 'docker.database.storage_root=/srv/disk2/opfield-databases', 'docker.socket=unix:///var/run/docker.sock'];
  try {
    // A config just enrolled (two spaces) gets the profile.
    let result = await write('opfield:\n  address: gw.example.com:9443\ndocker:\n  socket: "unix:///var/run/docker.sock"\nstate_dir: /var/lib/docker-daemon\n');
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /OK Database docker profile written/);
    assert.deepEqual(keys(result.output), expected);
    assert.equal(result.content.match(/storage_root/g).length, 1, result.content);
    // A re-run on the config the daemon rewrote changes nothing.
    result = await write(daemonLayout);
    assert.match(result.output, /OK Database docker profile already configured/, result.output);
    assert.equal(result.content, daemonLayout);
    // Keys a four-space config lacks go into its sections with its indentation.
    result = await write('docker:\n    database:\n        reserve_bytes: 1073741824\n    socket: unix:///var/run/docker.sock\n');
    assert.equal(result.status, 0, result.output);
    assert.equal(
      result.content,
      'docker:\n    mode: "storage"\n    database:\n        storage_root: "/srv/disk2/opfield-databases"\n        reserve_bytes: 1073741824\n    socket: unix:///var/run/docker.sock\n'
    );
    // The config an rc.21 re-run left (the profile again on top, the daemon's keys under docker.database) is repaired.
    const damaged = daemonLayout.replace('docker:\n', 'docker:\n  mode: "storage"\n  database:\n    storage_root: "/srv/disk2/opfield-databases"\n');
    result = await write(damaged);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Removed the duplicated database profile lines/);
    assert.equal(result.content, daemonLayout);
    assert.deepEqual(keys(result.output), expected);
    // Another storage root or another profile is never overwritten.
    result = await write(daemonLayout, '/var/lib/docker-daemon/databases');
    assert.match(result.output, /DIE Refusing to overwrite an existing database storage root \(\/srv\/disk2\/opfield-databases\)/);
    assert.equal(result.content, daemonLayout);
    result = await write(daemonLayout.replace('mode: storage', 'mode: databases'));
    assert.match(result.output, /DIE Refusing to overwrite an existing docker profile/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// F-B8: on an enrolled host the monitoring and Docker installers skipped a new node's token and exited 0, and the new
// node stayed pending. With the digest of the token the node enrolled with, another token is refused before anything
// changes, and the node's own token (its setup command run again) keeps working. An enrollment without a digest (an
// installer of v2.11.0 or before) cannot tell its own used token, which operators re-run to update, from a new one: the
// run goes on without the token and warns, and records no digest of it.
test('the monitoring and Docker installers refuse a new token on an enrolled host', { skip: !linux }, async () => {
  const host = path.join(work, 'host');
  const withoutToken = ['--opfield', 'gw.example.com:9443', '--opfield-cert-sha256', CERT, '--version', VERSION];
  const withToken = (token) => ['--opfield', 'gw.example.com:9443', '--token', token, '--opfield-cert-sha256', CERT, '--version', VERSION];
  for (const [script, daemon, extra] of [
    ['setup-monitoring-node.sh', 'monitoring-daemon', []],
    ['setup-docker-node.sh', 'docker-daemon', ['--mode', 'docker']],
  ]) {
    const etc = path.join(host, 'etc', daemon);
    const lib = path.join(host, 'var/lib', daemon);
    const digest = path.join(lib, 'enrollment-token.sha256');
    try {
      runShell(`mkdir -p '${etc}/certs' '${lib}' && echo PEM > '${etc}/certs/node.pem' && echo '{"node_id":"0eb357ee-node"}' > '${lib}/state.json'`);
      // A legacy enrollment: the original setup command (its token used) updates the node as before.
      const legacy = dryRun(script, ['-y', ...withToken('gw_node_original'), ...extra]);
      assert.equal(legacy.status, 0, `${script}\n${legacy.output}`);
      assert.match(legacy.output, /WARN .*already enrolled as (monitoring|docker) node 0eb357ee-node; the run keeps that enrollment and does not use the enrollment token/, script);
      assert.match(legacy.output, /If this is this node's own setup command \(its token already used\), nothing else is needed/, script);
      assert.match(legacy.output, new RegExp(`move \\S*/etc/${daemon}/certs and[\\s\\S]*?/var/lib/${daemon}/state\\.json out of the way`), script);
      assert.match(legacy.output, /Node already enrolled/, script);
      assert.match(legacy.output, /Dry run completed/, script);
      assert.equal(spawnSync('test', ['-e', digest]).status, 1, `${script} records no digest of an unused token`);
      // Without a token the enrolled node re-runs as before.
      const kept = dryRun(script, ['-y', ...withoutToken, ...extra]);
      assert.equal(kept.status, 0, `${script}\n${kept.output}`);
      assert.match(kept.output, /Node already enrolled/, script);
      assert.doesNotMatch(kept.output, /WARN .*already enrolled as/, script);
      // With the digest of the node's own token: that token keeps the enrollment, another one is refused.
      runShell(`printf '%s' gw_node_original | sha256sum | awk '{print $1}' > '${digest}'`);
      const same = dryRun(script, ['-y', ...withToken('gw_node_original'), ...extra]);
      assert.equal(same.status, 0, `${script}\n${same.output}`);
      assert.match(same.output, /already enrolled with this setup command's token; keeping its enrollment/, script);
      const refused = dryRun(script, ['-y', ...withToken('gw_node_new'), ...extra]);
      assert.equal(refused.status, 1, `${script}\n${refused.output}`);
      assert.match(refused.output, /already enrolled as (monitoring|docker) node 0eb357ee-node; the enrollment token was not used, and nothing was changed/, script);
      assert.match(refused.output, /run the installer again without --token/, script);
      assert.doesNotMatch(refused.output, /Dry run completed/, script);
      assert.equal(readFileSync(path.join(etc, 'certs/node.pem'), 'utf8'), 'PEM\n', `${script} keeps the enrollment`);
    } finally {
      runShell(`rm -rf '${etc}' '${lib}'`);
    }
  }
});

// The daemons enroll when they first run, not at `install`: the digest of the token was looked for before the daemon
// had its certificate and never written, so a new token on a host the current installer enrolled took the legacy path.
// A fresh install through the whole run (stubbed downloads and a stub daemon that enrolls and records its Opfield
// session when it runs) leaves the digest, and a re-run with another token is refused while the node's own token keeps it.
test('a fresh monitoring install records its token, so a new token is refused afterwards', { skip: !linux || userInfo().uid !== 0 }, async () => {
  for (const script of ['setup-monitoring-node.sh', 'setup-docker-node.sh']) {
    const { topLevel } = parseShell(readFileSync(path.join(scriptsDir, script), 'utf8'));
    const line = (name) => topLevel.find((entry) => entry.calls.includes(name))?.line ?? -1;
    assert.ok(line('remember_enrollment_token') > line('await_opfield_connection'), `${script} records the token after the daemon connected`);
    assert.ok(line('await_opfield_connection') > line('start_daemon'), script);
  }
  const host = path.join(work, 'host');
  const dir = await mkdtemp(path.join(tmpdir(), 'opfield-monitoring-fresh-'));
  const etc = path.join(host, 'etc/monitoring-daemon');
  const lib = path.join(host, 'var/lib/monitoring-daemon');
  const arch = spawnSync('uname', ['-m'], { encoding: 'utf8' }).stdout.trim() === 'aarch64' ? 'arm64' : 'amd64';
  const binaryName = `monitoring-daemon-linux-${arch}`;
  try {
    // The daemon: install writes its config; run starts as its own launcher, enrolls (certificate, state) and records
    // the Opfield session, as the real daemon does on its first start.
    const daemon = [
      '#!/bin/bash',
      'case "$1" in',
      '  version) echo "monitoring-daemon v2.11.1" ;;',
      `  install) mkdir -p '${etc}' && printf 'opfield:\n  address: gw.example.com:9443\n  token: %s\nlog_level: info\n' "$5" > '${etc}/config.yaml' ;;`,
      '  run)',
      `    printf '{"protocolVersion":1,"daemonType":"monitoring","pid":%s}' $$ > '${lib}/launcher/owner.json'`,
      `    printf '{"pid":%s,"ready":true}' $$ > '${lib}/launcher/child.json'`,
      `    mkdir -p '${etc}/certs' && echo PEM > '${etc}/certs/node.pem' && echo '{"node_id":"fresh-node"}' > '${lib}/state.json'`,
      `    printf '{"pid":%s,"connected_at":%s}' $$ "$(date +%s)" > '${lib}/control-session.json'`,
      '    exec -a opfield-test-monitoring-stub sleep 60 ;;',
      'esac',
    ].join('\n');
    await writeFile(path.join(dir, binaryName), `${daemon}\n`);
    const digest = spawnSync('sha256sum', [path.join(dir, binaryName)], { encoding: 'utf8' }).stdout.split(' ')[0];
    await writeFile(path.join(dir, 'checksums.txt'), `${digest}  ${binaryName}\n`);
    // The directories a host has before any install.
    await spawnAsync('mkdir', ['-p', path.join(dir, 'bin'), path.join(host, 'usr/local/bin')]);
    await writeFile(
      path.join(dir, 'bin/curl'),
      `#!/bin/sh\nout=""; url=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done\nfile='${dir}'/$(basename "$url")\n[ -f "$file" ] || exit 22\nif [ -n "$out" ]; then cp "$file" "$out"; else cat "$file"; fi\n`
    );
    await chmod(path.join(dir, 'bin/curl'), 0o755);
    const install = (token) => {
      const result = spawnSync(
        'bash',
        [path.join(work, 'scripts/setup-monitoring-node.sh'), '-y', '--no-logo', '--opfield', 'gw.example.com:9443', '--token', token, '--opfield-cert-sha256', CERT, '--version', VERSION, '--user', 'root'],
        {
          encoding: 'utf8',
          timeout: 90_000,
          input: '',
          env: {
            ...process.env,
            PATH: `${path.join(dir, 'bin')}:${path.join(work, 'bin')}:${process.env.PATH}`,
            OPFIELD_ARTIFACT_BASE_URL: 'https://mirror.example/opfield',
            OPFIELD_MONITORING_ENROLLMENT_WAIT_SECONDS: '20',
            OPFIELD_MANUAL_LAUNCH_TIMEOUT_SECONDS: '20',
          },
        }
      );
      return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
    };
    const fresh = install('gw_node_fresh');
    assert.equal(fresh.status, 0, fresh.output);
    assert.match(fresh.output, /monitoring-daemon is connected to Opfield/);
    const recorded = readFileSync(path.join(lib, 'enrollment-token.sha256'), 'utf8').trim();
    assert.equal(recorded, spawnSync('sh', ['-c', "printf '%s' gw_node_fresh | sha256sum | cut -d' ' -f1"], { encoding: 'utf8' }).stdout.trim());
    const config = readFileSync(path.join(etc, 'config.yaml'), 'utf8');
    // A new node's token: refused, nothing changed.
    const refused = install('gw_node_other');
    assert.equal(refused.status, 1, refused.output);
    assert.match(refused.output, /already enrolled as monitoring node fresh-node of Opfield gw\.example\.com:9443; the enrollment token was not used, and nothing was changed/);
    assert.equal(readFileSync(path.join(etc, 'config.yaml'), 'utf8'), config);
    // The node's own setup command again: it keeps its enrollment and the run completes.
    const same = install('gw_node_fresh');
    assert.equal(same.status, 0, same.output);
    assert.match(same.output, /already enrolled with this setup command's token; keeping its enrollment/);
  } finally {
    runShell(`pkill -f 'opfield-test-monitoring-stu[b]' || true; rm -rf '${etc}' '${lib}' '${path.join(host, 'usr/local/bin/monitoring-daemon')}'*`);
    await rm(dir, { recursive: true, force: true });
  }
});

test('install.sh --restore reads the export version and refuses what it cannot restore', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'install-restore-'));
  try {
    const run = (file, extra = []) =>
      spawnSync(
        'bash',
        [path.join(scriptsDir, 'install.sh'), '--dry-run', '--install-dir', path.join(work, 'opt'), '--restore', file, ...extra],
        { encoding: 'utf8', timeout: 30_000, input: '', env: { ...process.env, TERM: 'dumb' } }
      );
    const zip = path.join(work, 'backup.zip');
    await writeFile(zip, 'PK\u0003\u0004 not an export');
    const notExport = run(zip);
    assert.notEqual(notExport.status, 0);
    assert.match(notExport.stdout + notExport.stderr, /is not an Opfield configuration export/);

    const header = (version, field = 'opfieldVersion') =>
      `OPFIELD-EXPORT/1\n${JSON.stringify({ format: 1, [field]: version, schemaMigration: 'x' })}\n\u0001\u0002binary`;
    const development = path.join(work, 'dev.opfield-export');
    // Exports made before 2.12.1 name the version LEGACY_EXPORT_VERSION_FIELD.
    for (const field of ['opfieldVersion', LEGACY.LEGACY_EXPORT_VERSION_FIELD]) {
      await writeFile(development, header('local-20261011120000', field));
      const refused = run(development);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stdout + refused.stderr, /made by a development build \(local-20261011120000\)/, field);
    }

    const missing = run(path.join(work, 'missing.opfield-export'));
    assert.notEqual(missing.status, 0);
    assert.match(missing.stdout + missing.stderr, /Cannot read the export file/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

// O-8: release candidates (and any exact release) can be installed on purpose, never by default.
test('install.sh --version installs an exact release on a fresh host, with the relay of that release or its line', async () => {
  const installSh = path.join(scriptsDir, 'install.sh');
  const source = readFileSync(installSh, 'utf8');
  const help = spawnSync('bash', [installSh, '--help'], { encoding: 'utf8', timeout: 30_000, input: '' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--version VERSION installs exactly that Opfield release/);
  const work = await mkdtemp(path.join(tmpdir(), 'install-version-'));
  try {
    const run = (args) =>
      spawnSync('bash', [installSh, '--dry-run', '--install-dir', path.join(work, 'opt'), ...args], {
        encoding: 'utf8',
        timeout: 30_000,
        input: '',
        env: { ...process.env, TERM: 'dumb', RELEASES_API_URL: 'http://127.0.0.1:9/never' },
      });
    for (const [args, message] of [
      [['--version', '2.12'], /--version takes a release such as v2\.12\.1/],
      [['--version', 'v2.12.1-beta.1'], /--version takes a release/],
      [['--version', 'v2.12.1', '--restore', path.join(work, 'x.opfield-export')], /cannot be combined: a restore/],
      [['--version', 'v2.12.1-rc.5', '--source-dir', work], /cannot be combined: a source build/],
    ]) {
      const result = run(args);
      assert.notEqual(result.status, 0, args.join(' '));
      assert.match(result.stdout + result.stderr, message, args.join(' '));
    }

    // The relay: the pinned release's own, else the newest of its line; never one of the next line.
    const relay = (published, resolverTag) =>
      runShell(
        [
          'LOG_FILE=/dev/null',
          `download_release_artifact() { [[ " ${published.join(' ')} " == *" $2 "* ]]; }`,
          `fetch_release() { echo "fetch $*" >&2; ${resolverTag ? `printf '{"target":{"tag_name":"%s"}}' '${resolverTag}'` : ':'}; }`,
          shellFunction(source, 'pinned_relay_tag'),
          'pinned_relay_tag v2.12.1-rc.5',
        ].join('\n')
      );
    const own = relay(['v2.12.1-rc.5-relay'], 'v2.12.1-rc.7-relay');
    assert.equal(own.output.trim(), 'v2.12.1-rc.5-relay');
    const line = relay([], 'v2.12.1-rc.3-relay');
    assert.match(line.output, /fetch relay v2\.12\.0-rc\.0 preview/);
    assert.match(line.output, /^v2\.12\.1-rc\.3-relay$/m);
    const nextLine = relay([], 'v2.13.0-relay');
    assert.equal(nextLine.status, 0, nextLine.output);
    assert.doesNotMatch(nextLine.output, /v2\.13\.0-relay/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('install.sh --domain and --acme-email: help, validation before any host change, and the console ports', async () => {
  const installSh = path.join(scriptsDir, 'install.sh');
  const source = readFileSync(installSh, 'utf8');
  const work = await mkdtemp(path.join(tmpdir(), 'install-domain-'));
  try {
    const run = (args) =>
      spawnSync('bash', [installSh, '--dry-run', '--install-dir', path.join(work, 'opt'), ...args], {
        encoding: 'utf8',
        timeout: 30_000,
        input: '',
        env: { ...process.env, TERM: 'dumb', RELEASES_API_URL: 'http://127.0.0.1:9/never' },
      });
    const help = spawnSync('bash', [installSh, '--help'], { encoding: 'utf8', timeout: 30_000, input: '' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--domain FQDN --acme-email EMAIL/);
    assert.match(help.stdout, /Let's Encrypt/);

    for (const [args, message] of [
      [['--domain', 'not a domain', '--acme-email', 'ops@example.com'], /--domain must be a DNS name/],
      [['--domain', '10.0.0.1', '--acme-email', 'ops@example.com'], /--domain must be a DNS name/],
      [['--domain', '*.example.com', '--acme-email', 'ops@example.com'], /--domain must be a DNS name/],
      [['--domain', 'console.example.com'], /--domain needs --acme-email/],
      [['--acme-email', 'ops@example.com'], /--acme-email is used with --domain/],
      [['--domain', 'console.example.com', '--acme-email', 'nobody'], /--acme-email must be an email address/],
    ]) {
      const result = run(args);
      assert.notEqual(result.status, 0, args.join(' '));
      assert.match(result.stdout + result.stderr, message, args.join(' '));
    }
    // Validation runs before anything else: nothing was created.
    assert.equal(spawnSync('test', ['-e', path.join(work, 'opt')]).status, 1);

    // The fresh Compose file the installer writes, with the console ports added to the app service only, once.
    const compose = /cat >docker-compose\.yml <<'COMPOSE'\n([\s\S]*?)\nCOMPOSE\n/.exec(source)?.[1];
    assert.ok(compose, 'install.sh writes a Compose file');
    const file = path.join(work, 'docker-compose.yml');
    await writeFile(file, `${compose}\n`);
    const add = `${shellFunction(source, 'add_console_ports')}\nadd_console_ports '${file}'`;
    assert.equal(runShell(add).status, 0);
    assert.equal(runShell(add).status, 0);
    const updated = await readFile(file, 'utf8');
    const appPorts = /\n  app:\n[\s\S]*?\n    ports:\n((?:      - .*\n)+)/.exec(updated)?.[1];
    assert.equal(appPorts, '      - "80:3080"\n      - "443:3443"\n      - "3000:3000"\n');
    assert.equal(updated.match(/443:3443/g)?.length, 1);
    assert.match(updated, /\n  relay:\n[\s\S]*?\n    ports:\n      - "9443:9443"\n    volumes:/);

    // A Compose file without an app ports block is refused, not silently left without 443.
    await writeFile(file, 'services:\n  app:\n    image: x\n');
    assert.notEqual(runShell(add).status, 0);

    // The domain check of the installer.
    const valid = `${shellFunction(source, 'valid_console_domain')}\n`;
    for (const name of ['console.example.com', 'a-1.opfield.cloud']) {
      assert.equal(runShell(`${valid}valid_console_domain '${name}'`).status, 0, name);
    }
    for (const name of ['localhost', 'example.com:443', '-a.example.com', 'a..example.com', '1.2.3.4']) {
      assert.notEqual(runShell(`${valid}valid_console_domain '${name}'`).status, 0, name);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

