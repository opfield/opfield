// The release test matrix (scripts/release-matrix.json) stays complete: every option, option value and OPFIELD_*
// environment variable that an installer parses, every daemon config key that docs/nodes.md documents, every declared
// feature and every node lifecycle operation has a scenario that lists it in `covers`, and the matrix names nothing
// that no longer exists. The inventory comes from the sources: the `case "$1" in` option blocks, the validating
// `case "$VAR" in` blocks that end in `*) die`, the `${OPFIELD_*}` reads outside quoted heredocs, and the YAML blocks
// and `Key` tables of docs/nodes.md.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve('.');
const scriptsDir = path.join(root, 'scripts');
const CONFIG_DOCS = ['docs/nodes.md'];
const AREAS = new Set(['installer', 'daemon', 'feature']);
const WHERE = new Set(['stand', 'static']);

// Lines of a shell script with comments removed and heredoc bodies marked: `quoted` bodies are literal text, the
// bodies of unquoted heredocs are expanded by the shell.
function shellLines(source) {
  const out = [];
  let heredoc = null;
  source.split('\n').forEach((raw, index) => {
    if (heredoc) {
      if ((heredoc.strip ? raw.replace(/^\t+/, '') : raw) === heredoc.word) {
        heredoc = null;
        return;
      }
      out.push({ line: index + 1, code: heredoc.quoted ? '' : raw, heredoc: true });
      return;
    }
    const code = stripComment(raw);
    const opened = /(?<!<)<<(?!<)(-?)\s*(\\?)(['"]?)([A-Za-z_][A-Za-z0-9_]*)\3/.exec(code);
    if (opened) heredoc = { strip: opened[1] === '-', quoted: opened[2] === '\\' || opened[3] !== '', word: opened[4] };
    out.push({ line: index + 1, code, heredoc: false });
  });
  return out;
}

function stripComment(line) {
  let quote = null;
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
    if (quote === '"') {
      if (char === '"') quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index);
  }
  return line;
}

// The arms of the case block that starts at lines[start]: patterns and body text, up to its own esac.
function caseArms(lines, start) {
  const arms = [];
  let depth = 0;
  let current = null;
  for (let index = start + 1; index < lines.length; index++) {
    let { code, heredoc } = lines[index];
    if (heredoc) continue;
    if (/^\s*case\s.+\sin\s*$/.test(code)) depth++;
    if (/^\s*esac\b/.test(code)) {
      if (depth === 0) break;
      depth--;
      continue;
    }
    const arm = depth === 0 && !current ? /^\s*\(?\s*([^()\s][^()]*?)\)\s?(.*)$/.exec(code) : null;
    if (arm) {
      current = { patterns: arm[1].split('|').map((pattern) => pattern.trim().replace(/^"(.*)"$/, '$1')), body: '' };
      arms.push(current);
      code = arm[2];
    }
    if (current) {
      current.body += `${code}\n`;
      if (/;;\s*$/.test(code)) current = null;
    }
  }
  return arms;
}

// Options, option values and environment variables one installer parses.
export function installerInventory(name, source) {
  const lines = shellLines(source);
  const options = new Map();
  const variableOption = new Map();
  lines.forEach(({ code, heredoc }, index) => {
    if (heredoc || !/^\s*case "\$1" in\s*$/.test(code)) return;
    for (const arm of caseArms(lines, index)) {
      const names = arm.patterns.filter((pattern) => /^-{1,2}[A-Za-z0-9][-A-Za-z0-9]*$/.test(pattern));
      if (names.length === 0) continue;
      const option = {
        name: names.find((pattern) => pattern.startsWith('--')) ?? names[0],
        aliases: names,
        values: [],
      };
      for (const alias of names) options.set(alias, option);
      for (const bound of arm.body.matchAll(/\b([A-Z_][A-Z0-9_]*)="\$(?:2|\{2[^}]*\})"/g)) {
        variableOption.set(bound[1], option);
      }
    }
  });

  const env = new Map();
  const assigned = new Set();
  const reads = new Set();
  for (const { code } of lines) {
    for (const match of code.matchAll(/\$\{(OPFIELD_[A-Z0-9_]+)(:?[-=])/g))
      env.set(match[1], { name: match[1], values: [] });
    for (const match of code.matchAll(/\$\{?(OPFIELD_[A-Z0-9_]+)/g)) reads.add(match[1]);
    for (const match of code.matchAll(/(?<![\w${])(OPFIELD_[A-Z0-9_]+)\+?=/g)) assigned.add(match[1]);
  }
  for (const name of reads) if (!assigned.has(name) && !env.has(name)) env.set(name, { name, values: [] });

  // Values of an option or environment variable that the script validates with a case block ending in `*) die`.
  lines.forEach(({ code, heredoc }, index) => {
    const match = heredoc ? null : /^\s*case "\$\{?([A-Z_][A-Z0-9_]*)\}?" in\s*$/.exec(code);
    if (!match) return;
    const target = variableOption.get(match[1]) ?? env.get(match[1]);
    if (!target) return;
    const arms = caseArms(lines, index);
    const fallback = arms.find((arm) => arm.patterns.includes('*'));
    if (!fallback || !/\b(die|exit)\b/.test(fallback.body)) return;
    for (const arm of arms) {
      for (const pattern of arm.patterns) {
        if (/^[a-z][a-z0-9_-]*$/.test(pattern) && !target.values.includes(pattern)) target.values.push(pattern);
      }
    }
  });

  return { name, options: [...new Set(options.values())], env: [...env.values()] };
}

// Leaf keys of the YAML examples and the backticked first column of `Key` tables in a Markdown document.
export function documentedConfigKeys(markdown) {
  const keys = new Set();
  const lines = markdown.split('\n');
  let yaml = null;
  let table = false;
  for (const line of lines) {
    if (yaml) {
      if (/^\s*```\s*$/.test(line)) {
        for (const entry of yaml) if (entry.leaf) keys.add(entry.path);
        yaml = null;
        continue;
      }
      const match = /^(\s*)([A-Za-z_][A-Za-z0-9_]*):(?:\s+(.*))?$/.exec(line);
      if (!match) continue;
      const indent = match[1].length;
      const value = (match[3] ?? '').replace(/\s+#.*$/, '').trim();
      while (yaml.stack.length > 0 && yaml.stack.at(-1).indent >= indent) yaml.stack.pop();
      const parent = yaml.stack.at(-1);
      if (parent) parent.entry.leaf = false;
      const entry = { path: parent ? `${parent.entry.path}.${match[2]}` : match[2], leaf: true };
      yaml.push(entry);
      if (value === '') yaml.stack.push({ indent, entry });
      continue;
    }
    if (/^\s*```ya?ml\s*$/.test(line)) {
      yaml = [];
      yaml.stack = [];
      continue;
    }
    const cells = /^\s*\|(.*)\|\s*$/
      .exec(line)?.[1]
      .split('|')
      .map((cell) => cell.trim());
    if (!cells) {
      table = false;
      continue;
    }
    if (cells[0] === 'Key') {
      table = true;
      continue;
    }
    const key = table ? /^`([a-z_][a-z0-9_.]*)`$/.exec(cells[0]) : null;
    if (key) keys.add(key[1]);
  }
  return [...keys].sort();
}

async function loadInventory() {
  const names = (await readdir(scriptsDir))
    .filter((name) => /^setup-.*\.sh$/.test(name) || name === 'install.sh')
    .sort();
  const installers = new Map();
  for (const name of names)
    installers.set(name, installerInventory(name, await readFile(path.join(scriptsDir, name), 'utf8')));
  const config = new Set();
  for (const doc of CONFIG_DOCS) {
    for (const key of documentedConfigKeys(await readFile(path.join(root, doc), 'utf8'))) config.add(key);
  }
  return { installers, config };
}

const matrix = JSON.parse(await readFile(path.join(scriptsDir, 'release-matrix.json'), 'utf8'));
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const inventory = await loadInventory();

// What one covers token names, or an error for a token that names nothing that exists.
function resolveToken(spec, token) {
  const script = /^(\S+\.sh) (\S+)$/.exec(token);
  if (script) {
    const installer = inventory.installers.get(script[1]);
    if (!installer) return { error: `no installer ${script[1]}` };
    const [name, value] = script[2].split('=');
    if (name.startsWith('$')) {
      const variable = installer.env.find((entry) => entry.name === name.slice(1));
      if (!variable) return { error: `${script[1]} reads no ${name.slice(1)}` };
      if (value !== undefined && !variable.values.includes(value))
        return { error: `${script[1]} ${name} has no value ${value}` };
      return { keys: [`${script[1]} ${name}`, ...(value === undefined ? [] : [`${script[1]} ${name}=${value}`])] };
    }
    const option = installer.options.find((entry) => entry.aliases.includes(name));
    if (!option) return { error: `${script[1]} has no option ${name}` };
    if (value !== undefined && !option.values.includes(value))
      return { error: `${script[1]} ${name} has no value ${value}` };
    return {
      keys: [`${script[1]} ${option.name}`, ...(value === undefined ? [] : [`${script[1]} ${option.name}=${value}`])],
    };
  }
  const config = /^config (\S+)$/.exec(token);
  if (config) {
    return inventory.config.has(config[1])
      ? { keys: [token] }
      : { error: `${CONFIG_DOCS.join(', ')} documents no ${config[1]}` };
  }
  const feature = /^feature (\S+)$/.exec(token);
  if (feature)
    return spec.features?.[feature[1]] ? { keys: [token] } : { error: `feature ${feature[1]} is not declared` };
  const lifecycle = /^lifecycle (\S+) (\S+)$/.exec(token);
  if (lifecycle) {
    const daemon = spec.lifecycle?.daemons?.[lifecycle[1]];
    if (!daemon) return { error: `lifecycle daemon ${lifecycle[1]} is not declared` };
    if (!daemon.operations?.[lifecycle[2]])
      return { error: `lifecycle ${lifecycle[1]} has no operation ${lifecycle[2]}` };
    return { keys: [token] };
  }
  return { error: 'unknown token form' };
}

// Every key with the scenarios that cover it and the operating systems their stand runs use.
function coverage(spec) {
  const covered = new Map();
  for (const scenario of spec.scenarios ?? []) {
    for (const token of scenario.covers ?? []) {
      for (const key of resolveToken(spec, token).keys ?? []) {
        const entry = covered.get(key) ?? { scenarios: [], os: new Set() };
        entry.scenarios.push(scenario.id);
        if (scenario.where === 'stand') for (const os of scenario.os ?? []) entry.os.add(os);
        covered.set(key, entry);
      }
    }
  }
  return covered;
}

// Scenarios that miss a required field, name an unknown OS or CI script, or name a real stand host.
function malformedScenarios(spec) {
  const problems = [];
  const osNames = new Set(Object.keys(spec.os ?? {}));
  if (osNames.size === 0) problems.push('the matrix declares no operating systems');
  const ids = new Set();
  for (const scenario of spec.scenarios ?? []) {
    const label = scenario.id ?? JSON.stringify(scenario).slice(0, 80);
    const fail = (message) => problems.push(`${label}: ${message}`);
    if (!/^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+$/.test(scenario.id ?? '')) fail('id must look like AREA-NAME');
    if (ids.has(scenario.id)) fail('duplicate id');
    ids.add(scenario.id);
    if (!AREAS.has(scenario.area)) fail(`area must be one of ${[...AREAS].join(', ')}`);
    if (!WHERE.has(scenario.where)) fail('where must be stand or static');
    if (typeof scenario.title !== 'string' || scenario.title.length === 0) fail('title is missing');
    for (const field of ['covers', 'steps', 'expect']) {
      if (!Array.isArray(scenario[field]) || scenario[field].length === 0) fail(`${field} must list something`);
    }
    if (!Array.isArray(scenario.preconditions)) fail('preconditions must be a list');
    if (scenario.where === 'stand') {
      if (!Array.isArray(scenario.os) || scenario.os.length === 0) fail('a stand scenario names its OS');
      for (const os of scenario.os ?? []) if (!osNames.has(os)) fail(`unknown OS ${os}`);
      if (scenario.ci !== undefined) fail('only static scenarios name a CI script');
    } else if (scenario.where === 'static') {
      if (scenario.os !== undefined) fail('a static scenario runs in CI, not on an OS of the stand');
      if (!packageJson.scripts?.[scenario.ci]) fail(`ci must name a package.json script, got ${scenario.ci}`);
    }
    // The repository is public: no addresses, guest ids or host names of a real stand.
    const text = JSON.stringify(scenario);
    for (const address of text.match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) ?? []) {
      if (!['127.0.0.1', '0.0.0.0'].includes(address)) fail(`names the address ${address}`);
    }
    if (/\b(CT|VM|VMID|pct)\s*\d{3,}/i.test(text)) fail('names a guest id');
  }
  return problems;
}

function staleTokens(spec) {
  const problems = [];
  for (const scenario of spec.scenarios ?? []) {
    for (const token of scenario.covers ?? []) {
      const { error } = resolveToken(spec, token);
      if (error) problems.push(`${scenario.id}: "${token}": ${error}`);
    }
  }
  return problems;
}

function uncoveredInstallerInputs(spec) {
  const covered = coverage(spec);
  const missing = [];
  const need = (key) => covered.has(key) || missing.push(key);
  for (const [script, installer] of inventory.installers) {
    for (const option of installer.options) {
      need(`${script} ${option.name}`);
      for (const value of option.values) need(`${script} ${option.name}=${value}`);
    }
    for (const variable of installer.env) {
      need(`${script} $${variable.name}`);
      for (const value of variable.values) need(`${script} $${variable.name}=${value}`);
    }
  }
  return missing;
}

function uncoveredConfigKeys(spec) {
  const covered = coverage(spec);
  return [...inventory.config].filter((key) => !covered.has(`config ${key}`)).map((key) => `config ${key}`);
}

function uncoveredFeatures(spec) {
  const covered = coverage(spec);
  const osNames = new Set(Object.keys(spec.os ?? {}));
  const missing = [];
  for (const [id, feature] of Object.entries(spec.features ?? {})) {
    if (typeof feature.description !== 'string' || feature.description.length === 0)
      missing.push(`feature ${id} has no description`);
    const entry = covered.get(`feature ${id}`);
    if (!entry) {
      missing.push(`feature ${id}`);
      continue;
    }
    for (const os of feature.os ?? []) {
      if (!osNames.has(os)) missing.push(`feature ${id} names the unknown OS ${os}`);
      else if (!entry.os.has(os)) missing.push(`feature ${id} on ${os}`);
    }
  }
  return missing;
}

function uncoveredLifecycle(spec) {
  const { operations = {}, daemons = {} } = spec.lifecycle ?? {};
  const covered = coverage(spec);
  const osNames = new Set(Object.keys(spec.os ?? {}));
  const missing = [];
  if (Object.keys(operations).length === 0 || Object.keys(daemons).length === 0) missing.push('no lifecycle declared');
  for (const [daemon, entry] of Object.entries(daemons)) {
    for (const operation of Object.keys(operations)) {
      const required = entry.operations?.[operation];
      const reason = entry.notApplicable?.[operation];
      if (Boolean(required) === Boolean(reason)) {
        missing.push(`lifecycle ${daemon} ${operation} must be listed under operations or notApplicable, not both`);
        continue;
      }
      if (!required) continue;
      const scenarios = covered.get(`lifecycle ${daemon} ${operation}`);
      if (!scenarios) {
        missing.push(`lifecycle ${daemon} ${operation}`);
        continue;
      }
      for (const os of required.os ?? []) {
        if (!osNames.has(os)) missing.push(`lifecycle ${daemon} ${operation} names the unknown OS ${os}`);
        else if (!scenarios.os.has(os)) missing.push(`lifecycle ${daemon} ${operation} on ${os}`);
      }
    }
    for (const operation of [...Object.keys(entry.operations ?? {}), ...Object.keys(entry.notApplicable ?? {})]) {
      if (!operations[operation]) missing.push(`lifecycle ${daemon} lists the undeclared operation ${operation}`);
    }
  }
  return missing;
}

test('the extractor finds the options, values and environment variables the installers are known to parse', () => {
  const anchors = {
    'setup-node.sh': [
      '--nginx-mode=managed',
      '--nginx-mode=integrate',
      '--skip-nginx',
      '--yes',
      '-y',
      '$OPFIELD_NODE_TOKEN',
    ],
    'setup-docker-node.sh': [
      '--mode=builder',
      '--mode=storage',
      '--builder-egress=offline',
      '--secure-runtime',
      '$OPFIELD_LEASE_WATCHDOG_VERSION',
    ],
    'setup-database-node.sh': ['--storage-root', '$OPFIELD_DOCKER_MODE=storage'],
    'setup-monitoring-node.sh': ['--disable-files', '$OPFIELD_MONITORING_ENROLLMENT_WAIT_SECONDS'],
    'setup-relay-node.sh': ['--advertise-address', '--dry-run', '$OPFIELD_RELAY_RUN_USER'],
    'setup-daemon.sh': ['--type=storage', '--script-dir', '$OPFIELD_SETUP_VERSION'],
    'setup-storage-node.sh': ['$OPFIELD_RELEASE_DOWNLOAD_BASE'],
    'install.sh': ['--https', '--source-dir', '$OPFIELD_WEB_TRANSPORT', '$OPFIELD_DOCKER_DAEMON_CONFIG'],
  };
  for (const [script, items] of Object.entries(anchors)) {
    for (const item of items)
      assert.equal(resolveToken(matrix, `${script} ${item}`).error, undefined, `${script} ${item}`);
  }
  // Internal variables are not inputs: the installers assign them before they read them.
  assert.ok(resolveToken(matrix, 'setup-node.sh $OPFIELD_SESSION_FILE').error);
  assert.ok(resolveToken(matrix, 'setup-docker-node.sh $OPFIELD_ADDR').error);
  assert.ok(
    resolveToken(matrix, 'install.sh $OPFIELD_RELAY_MANAGED').error,
    'a compose file in a quoted heredoc is not a read'
  );
  for (const key of [
    'console.enabled',
    'files.enabled',
    'console.user',
    'opfield.cert_sha256',
    'nginx.stub_status_url',
  ]) {
    assert.ok(inventory.config.has(key), key);
  }
});

test('every scenario is well formed and stand-agnostic', () => {
  assert.deepEqual(malformedScenarios(matrix), []);
});

test('every token in covers names something that exists', () => {
  assert.deepEqual(staleTokens(matrix), []);
});

test('every installer option, option value and environment variable has a scenario', () => {
  assert.deepEqual(uncoveredInstallerInputs(matrix), [], 'add a scenario that lists these in covers');
});

test('every daemon config key that docs/nodes.md documents has a scenario', () => {
  assert.deepEqual(uncoveredConfigKeys(matrix), [], 'add a scenario that lists these in covers');
});

test('every declared feature has a scenario on each OS it must run on', () => {
  assert.deepEqual(uncoveredFeatures(matrix), [], 'add a scenario that lists these in covers');
});

test('every node lifecycle operation of every daemon has a scenario on each OS it must run on', () => {
  assert.deepEqual(uncoveredLifecycle(matrix), [], 'add a scenario that lists these in covers');
});

test('the checks report a missing, a stale and a public-unsafe entry', () => {
  const copy = structuredClone(matrix);
  const drop = (token) => {
    for (const scenario of copy.scenarios) scenario.covers = scenario.covers.filter((item) => item !== token);
  };
  drop('setup-node.sh --skip-nginx');
  drop('config log_level');
  drop('feature relay.reenroll');
  for (const scenario of copy.scenarios) {
    if (scenario.covers.includes('lifecycle relay reboot')) scenario.os = scenario.os.filter((os) => os !== 'alpine');
  }
  copy.scenarios[0].covers.push(
    'setup-node.sh --no-such-option',
    'setup-docker-node.sh --mode=cluster',
    'setup-node.sh $OPFIELD_NO_SUCH'
  );
  copy.scenarios.at(-1).steps.push('Open https://10.1.2.3:3000 on CT 1130.');
  assert.ok(uncoveredInstallerInputs(copy).includes('setup-node.sh --skip-nginx'));
  assert.deepEqual(uncoveredConfigKeys(copy), ['config log_level']);
  assert.ok(uncoveredFeatures(copy).includes('feature relay.reenroll'));
  assert.ok(uncoveredLifecycle(copy).includes('lifecycle relay reboot on alpine'));
  assert.equal(staleTokens(copy).length, 3);
  assert.equal(malformedScenarios(copy).length, 2);
});
