import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';

const verifier = path.resolve('scripts/verify-continuity-grant.mjs');
let fixtureDir;
let canonicalGrant;

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), 'opfield-continuity-grant-'));
  canonicalGrant = await readFile('CONTINUITY-GRANT.md', 'utf8');
});

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

async function verifyGrant(contents) {
  const fixture = path.join(fixtureDir, 'CONTINUITY-GRANT.md');
  await writeFile(fixture, contents, 'utf8');
  return spawnSync(process.execPath, [verifier, fixture], { encoding: 'utf8' });
}

async function assertRejected(from, to) {
  assert.ok(canonicalGrant.includes(from), `canonical grant lacks: ${from}`);
  const result = await verifyGrant(canonicalGrant.replace(from, to));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the canonical continuity grant digest/);
}

test('accepts the complete canonical continuity grant', async () => {
  const result = await verifyGrant(canonicalGrant);

  assert.equal(result.status, 0, result.stderr);
});

test('the inference package carries the same grant', async () => {
  assert.equal(await readFile('packages/gateway-inference/CONTINUITY-GRANT.md', 'utf8'), canonicalGrant);
});

test('rejects any change to the inactivity trigger', async () => {
  await assertRejected('for 12 consecutive months', 'for 36 consecutive months');
});

test('rejects removal of the end-of-life and incapacity triggers', async () => {
  await assertRejected('3. the Licensor dies or is legally declared unable to act.\n', '');
});

test('rejects removal of the right to run without the license server', async () => {
  await assertRejected('- the right to run that release without the license server', '- the right to run that release');
});

test('rejects removal of the commercial core from the grant', async () => {
  await assertRejected(', including its commercial core', '');
});
