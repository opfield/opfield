// The grep gate for the old product names (scripts/legacy-brand.mjs): its rules on small trees, the allowlist's shape,
// and the repository itself.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatFailures, globToRegExp, listTrackedFiles, loadAllowlist, scan } from './legacy-brand.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = mkdtempSync(path.join(tmpdir(), 'legacy-brand-'));
after(() => rmSync(work, { recursive: true, force: true }));

function tree(name, files, allowlist) {
  const dir = path.join(work, name);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
  const listFile = path.join(work, `${name}.json`);
  writeFileSync(listFile, JSON.stringify(allowlist));
  return (repo = 'opfield') =>
    scan({ root: dir, files: Object.keys(files), repo, allowlist: loadAllowlist(listFile) }).map(
      (hit) => `${hit.file}:${hit.line}:${hit.text}`,
    );
}

test('globs: ** spans directories, * stays in one segment, braces and classes', () => {
  assert.ok(globToRegExp('packages/**/x.ts').test('packages/a/b/x.ts'));
  assert.ok(globToRegExp('packages/**/x.ts').test('packages/x.ts'));
  assert.ok(!globToRegExp('packages/*.ts').test('packages/a/x.ts'));
  assert.ok(globToRegExp('m/{0[01][0-9][0-9],024[0-4]}_*.sql').test('m/0244_a.sql'));
  assert.ok(!globToRegExp('m/{0[01][0-9][0-9],024[0-4]}_*.sql').test('m/0245_a.sql'));
});

test('flags the old names in text, comments, identifiers and paths', () => {
  const run = tree(
    'flags',
    {
      'a.ts': '// Gateway restarts\nconst wiolettClient = 1;\nconst token = "gw_abc";\n',
      'gateway-tool.sh': 'echo ok\n',
    },
    { entries: [] },
  );
  assert.deepEqual(run(), ['a.ts:1:Gateway', 'a.ts:2:wiolett', 'a.ts:3:gw_', 'gateway-tool.sh:0:gateway']);
});

test('passes history, the networking word, marked legacy code and allowlisted names', () => {
  const run = tree(
    'passes',
    {
      'CHANGELOG.md': 'Gateway 2.0\n',
      'm/0001_init.sql': 'CREATE TABLE gateway_settings ();\n',
      'net.go': '// the default gateway of the API gateway\nreturn http.StatusBadGateway\n',
      'legacy.ts': [
        '// legacy-name: GATEWAY_* settings of 2.12.0 — remove once every node reports none',
        'const legacy = env.GATEWAY_URL ??',
        '  env.GATEWAY_HOST;',
        'const next = env.GATEWAY_PORT;',
        '',
      ].join('\n'),
      'labels.go': 'const legacyLabel = "wiolett.gateway.managed"\nx := "aGVsbG8gw_abc" // base64, not a token\n',
    },
    {
      excludedPaths: ['**/CHANGELOG*', 'm/0001_*.sql'],
      genericPhrases: ['\\bdefault gateway\\b', '\\bAPI gateways?\\b', '\\bStatusBadGateway\\b'],
      entries: [{ paths: ['labels.go'], pattern: 'wiolett\\.gateway\\.[\\w.]*', reason: 'old labels', removeIn: 'never' }],
    },
  );
  assert.deepEqual(run(), ['legacy.ts:4:GATEWAY']);
});

test('commercial: paths apply to the commercial core only', () => {
  const files = { 'core.ts': 'const role = "gateway-core";\n' };
  const allowlist = {
    entries: [{ paths: ['commercial:core.ts'], pattern: 'gateway-core', reason: 'r', removeIn: 'never' }],
  };
  assert.deepEqual(tree('commercial', files, allowlist)('commercial'), []);
  assert.deepEqual(tree('host', files, allowlist)('opfield'), ['core.ts:1:gateway']);
});

test('the allowlist is machine-checkable and its host paths name tracked files', () => {
  const allowlist = loadAllowlist();
  const files = listTrackedFiles(root);
  const unmatched = [];
  for (const entry of allowlist.entries) {
    for (const glob of entry.paths) {
      if (glob.startsWith('commercial:')) continue;
      if (!files.some((file) => globToRegExp(glob).test(file))) unmatched.push(`entries[${entry.index}] ${glob}`);
    }
  }
  assert.deepEqual(unmatched, []);
});

test('the repository names the product Opfield outside the allowlist', () => {
  assert.equal(formatFailures(scan({ root })), '');
});
