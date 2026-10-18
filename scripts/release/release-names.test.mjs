// The names a release publishes under: signed manifests name the opfield image repository and stamp get.opfield.dev
// as the artifact host.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const OPFIELD = 'ghcr.io/opfield/opfield';

function resolve(env) {
  const result = spawnSync(
    'bash',
    ['-c', 'source scripts/release/image-repositories.sh && printf "%s|%s" "$OPFIELD_IMAGE" "$OPFIELD_SIGNED_IMAGE"'],
    { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } }
  );
  if (result.status !== 0) return { error: result.stderr.trim() };
  const [primary, signed] = result.stdout.split('|');
  return { primary, signed };
}

test('releases publish and sign for ghcr.io/opfield/opfield', () => {
  assert.deepEqual(resolve({}), { primary: OPFIELD, signed: OPFIELD });
});

test('a fork publishes and signs for its own repository', () => {
  assert.deepEqual(resolve({ OPFIELD_IMAGE: 'ghcr.io/example/opfield' }), {
    primary: 'ghcr.io/example/opfield',
    signed: 'ghcr.io/example/opfield',
  });
});

test('signed daemon, relay and witness manifests name their artifact on get.opfield.dev', () => {
  const source = readFileSync(path.join(root, 'scripts/release/manifest-download-base.sh'), 'utf8');
  assert.match(source, /^MANIFEST_DOWNLOAD_BASE_URL="https:\/\/get\.opfield\.dev\/opfield"$/m);
  for (const script of ['scripts/github-release.sh', 'scripts/release/witness-artifacts.sh']) {
    const text = readFileSync(path.join(root, script), 'utf8');
    assert.match(text, /manifest-download-base\.sh/, `${script} sources the manifest host`);
    assert.doesNotMatch(text, /updates\.thesqlabs\.com/, `${script} names no earlier host`);
  }
});
