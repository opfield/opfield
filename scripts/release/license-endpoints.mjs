#!/usr/bin/env node
// Writes the signed license endpoints document: the license service addresses of config/license-service.json, signed
// with the update signing key like every update manifest (schema 1, the update key id) and valid for a limited
// time. The release workflow attaches it to each Opfield release and .github/workflows/license-endpoints.yml re-signs
// it on the latest one weekly; the update Worker serves it as /opfield/license-endpoints.json and installations
// fetch it daily (packages/backend/src/modules/license/license-endpoints.ts).
//
// Usage: UPDATE_SIGNING_PRIVATE_KEY_PEM_B64=... node scripts/release/license-endpoints.mjs <out>
//          [--valid-days <days>] [--config <license-service.json>] [--public-key <pem>]
// The document is verified against the public key (by default the repository's update trust anchor) before it is
// written, so a wrong signing key fails here instead of on installations.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_UPDATE_KEY_ID } from '../../packages/backend/src/lib/legacy-compat.ts';

const KIND = 'license-endpoints';
const KEY_ID = LEGACY_UPDATE_KEY_ID;
const DAY_MS = 24 * 60 * 60 * 1000;
// Installations reject a document valid for longer than 400 days.
const MAX_VALID_DAYS = 365;

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(
    'Usage: node scripts/release/license-endpoints.mjs <out> [--valid-days <days>] [--config <file>] [--public-key <pem>]\n'
  );
  process.exit(2);
}

const options = {
  out: null,
  validDays: 90,
  config: fileURLToPath(new URL('../../config/license-service.json', import.meta.url)),
  publicKey: fileURLToPath(new URL('../../config/update-trust/update-signing-public-key.pem', import.meta.url)),
};
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  const value = () => args[++index] ?? usage(`${arg} needs a value`);
  if (arg === '--valid-days') options.validDays = Number(value());
  else if (arg === '--config') options.config = value();
  else if (arg === '--public-key') options.publicKey = value();
  else if (arg.startsWith('-') || options.out) usage(`Unknown argument: ${arg}`);
  else options.out = arg;
}
if (!options.out) usage('The output path is required');
if (!Number.isInteger(options.validDays) || options.validDays < 1 || options.validDays > MAX_VALID_DAYS)
  usage(`--valid-days must be a whole number of days from 1 to ${MAX_VALID_DAYS}`);

const config = JSON.parse(readFileSync(options.config, 'utf8'));
const endpoints = config.endpoints;
if (!Array.isArray(endpoints) || endpoints.length === 0) throw new Error(`${options.config} lists no endpoints`);
for (const endpoint of endpoints) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.search || url.hash || url.username || endpoint.endsWith('/'))
    throw new Error(`License service endpoint ${endpoint} must be an https URL without a trailing slash`);
}

const encodedKey = process.env.UPDATE_SIGNING_PRIVATE_KEY_PEM_B64;
if (!encodedKey) throw new Error('UPDATE_SIGNING_PRIVATE_KEY_PEM_B64 is required');
const privateKey = createPrivateKey(Buffer.from(encodedKey, 'base64').toString('utf8'));

const issuedAt = new Date();
const payload = Buffer.from(
  JSON.stringify({
    kind: KIND,
    endpoints,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + options.validDays * DAY_MS).toISOString(),
  }),
  'utf8'
);
const signature = sign(null, payload, privateKey);
if (!verify(null, payload, createPublicKey(readFileSync(options.publicKey, 'utf8')), signature))
  throw new Error(`The signing key does not match the update trust anchor ${options.publicKey}`);

mkdirSync(dirname(options.out), { recursive: true });
writeFileSync(
  options.out,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      keyId: KEY_ID,
      payload: payload.toString('base64url'),
      signature: signature.toString('base64url'),
    },
    null,
    2
  )}\n`
);
process.stdout.write(`Signed ${endpoints.length} license service endpoints, valid ${options.validDays} days: ${options.out}\n`);
