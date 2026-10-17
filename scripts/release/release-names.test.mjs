// The names a release publishes under: signed manifests name the opfield image repository once the opfield
// organization publishes (the earlier repository stays a mirror), and stamp get.opfield.dev as the artifact host.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const OPFIELD = 'ghcr.io/opfield/opfield';
const EARLIER = 'ghcr.io/the-square-labs/gateway';

function resolve(env) {
  const result = spawnSync(
    'bash',
    [
      '-c',
      'source scripts/release/image-repositories.sh && printf "%s|%s|%s" "$OPFIELD_IMAGE" "$OPFIELD_IMAGE_MIRROR" "$OPFIELD_SIGNED_IMAGE"',
    ],
    { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } }
  );
  if (result.status !== 0) return { error: result.stderr.trim() };
  const [primary, mirror, signed] = result.stdout.split('|');
  return { primary, mirror, signed };
}

test('with the opfield organization publishing, manifests name ghcr.io/opfield/opfield and the earlier one mirrors', () => {
  assert.deepEqual(resolve({ OPFIELD_GHCR: 'true' }), { primary: OPFIELD, mirror: EARLIER, signed: OPFIELD });
});

test('before the move everything stays on the earlier repository', () => {
  assert.deepEqual(resolve({}), { primary: EARLIER, mirror: '', signed: EARLIER });
});

test('a fork publishes and signs for its own repository', () => {
  assert.deepEqual(resolve({ OPFIELD_IMAGE: 'ghcr.io/example/opfield' }), {
    primary: 'ghcr.io/example/opfield',
    mirror: '',
    signed: 'ghcr.io/example/opfield',
  });
  // legacy-name: GATEWAY_IMAGE repository variable of forks set up before 2.12.1.
  assert.deepEqual(resolve({ GATEWAY_IMAGE: 'ghcr.io/example/opfield' }), {
    primary: 'ghcr.io/example/opfield',
    mirror: '',
    signed: 'ghcr.io/example/opfield',
  });
  assert.equal(resolve({ OPFIELD_IMAGE: 'ghcr.io/example/opfield', GATEWAY_IMAGE: 'ghcr.io/example/opfield' }).primary, 'ghcr.io/example/opfield');
});

test('the signed repository can still be pinned to the mirror, never to a foreign one', () => {
  assert.deepEqual(resolve({ OPFIELD_GHCR: 'true', OPFIELD_SIGNED_IMAGE: EARLIER }), {
    primary: OPFIELD,
    mirror: EARLIER,
    signed: EARLIER,
  });
  assert.match(resolve({ OPFIELD_GHCR: 'true', OPFIELD_SIGNED_IMAGE: 'ghcr.io/example/x' }).error, /neither/);
});

test('signed daemon, relay and witness manifests name their artifact on get.opfield.dev', () => {
  const source = readFileSync(path.join(root, 'scripts/release/manifest-download-base.sh'), 'utf8');
  assert.equal(/^MANIFEST_DOWNLOAD_BASE_URL="([^"]+)"$/m.exec(source)?.[1], 'https://get.opfield.dev/gateway');
  for (const script of ['scripts/github-release.sh', 'scripts/release/witness-artifacts.sh']) {
    const text = readFileSync(path.join(root, script), 'utf8');
    assert.match(text, /manifest-download-base\.sh/, `${script} sources the manifest host`);
    assert.doesNotMatch(text, /updates\.thesqlabs\.com/, `${script} names no earlier host`);
  }
});
