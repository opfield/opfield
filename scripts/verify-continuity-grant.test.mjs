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
  fixtureDir = await mkdtemp(path.join(tmpdir(), 'gateway-continuity-grant-'));
  canonicalGrant = await readFile('CONTINUITY-MIT-GRANT.md', 'utf8');
});

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

async function verifyGrant(contents) {
  const fixture = path.join(fixtureDir, 'CONTINUITY-MIT-GRANT.md');
  await writeFile(fixture, contents, 'utf8');
  return spawnSync(process.execPath, [verifier, fixture], { encoding: 'utf8' });
}

test('accepts the complete canonical continuity grant', async () => {
  const result = await verifyGrant(canonicalGrant);

  assert.equal(result.status, 0, result.stderr);
});

test('rejects any change to the canonical trigger', async () => {
  const result = await verifyGrant(
    canonicalGrant.replace(
      'ninety-first consecutive calendar day after a **Final Dissolution Event**',
      'thirty-first consecutive calendar day after a **Final Dissolution Event**'
    )
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the canonical continuity grant digest/);
});

test('rejects removal of the pre-company-assignment boundary', async () => {
  const result = await verifyGrant(
    canonicalGrant.replace(
      'The automatic transition described below is unavailable unless and until the relevant rights are owned by a Company Rights Holder.\n',
      ''
    )
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the canonical continuity grant digest/);
});

test('rejects removal of key continuity during succession', async () => {
  const result = await verifyGrant(
    canonicalGrant.replace(
      'A succession does not reduce rights already granted to users, change the conditions of this grant, terminate applicable paid-key terms, or revoke, invalidate, or deactivate any valid commercial key.\n',
      ''
    )
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the canonical continuity grant digest/);
});

test('rejects removal of the successor condition', async () => {
  const result = await verifyGrant(
    canonicalGrant.replace(
      '- the relevant rights in the Covered Source have been transferred or assigned to a legal successor or another person or entity;\n',
      ''
    )
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the canonical continuity grant digest/);
});

test('rejects removal of a service non-trigger', async () => {
  const result = await verifyGrant(
    canonicalGrant.replace(
      '- unavailability of a company website, documentation website, source repository, update service, licensing service, or any other online service, for any duration;\n',
      ''
    )
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the canonical continuity grant digest/);
});
