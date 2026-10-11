// The license endpoints generator signs config/license-service.json exactly as installations verify it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./license-endpoints.mjs', import.meta.url));
const config = JSON.parse(readFileSync(new URL('../../config/license-service.json', import.meta.url), 'utf8'));

function keyPair(dir, name) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicPath = join(dir, `${name}.pem`);
  writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }));
  const privateB64 = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
  return { publicKey, publicPath, privateB64 };
}

function run(dir, key, publicPath, ...extra) {
  const out = join(dir, 'out', 'license-endpoints.json');
  const result = spawnSync(process.execPath, [script, out, '--public-key', publicPath, ...extra], {
    env: { ...process.env, UPDATE_SIGNING_PRIVATE_KEY_PEM_B64: key.privateB64 },
    encoding: 'utf8',
  });
  return { result, out };
}

test('signs the configured endpoints with the update key envelope and a validity period', () => {
  const dir = mkdtempSync(join(tmpdir(), 'license-endpoints-'));
  const key = keyPair(dir, 'update');
  const { result, out } = run(dir, key, key.publicPath, '--valid-days', '30');
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.keyId, 'wiolett-update-v1');
  const payload = Buffer.from(envelope.payload, 'base64url');
  assert.ok(verify(null, payload, key.publicKey, Buffer.from(envelope.signature, 'base64url')));
  const document = JSON.parse(payload.toString('utf8'));
  assert.equal(document.kind, 'license-endpoints');
  assert.deepEqual(document.endpoints, config.endpoints);
  assert.equal(Date.parse(document.expiresAt) - Date.parse(document.issuedAt), 30 * 24 * 60 * 60 * 1000);
});

test('refuses a signing key that is not the update trust anchor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'license-endpoints-'));
  const key = keyPair(dir, 'update');
  const other = keyPair(dir, 'other');
  const { result } = run(dir, key, other.publicPath);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the update trust anchor/);
});
