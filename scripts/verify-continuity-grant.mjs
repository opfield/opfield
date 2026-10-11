import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const grantPath = process.argv[2] ?? 'CONTINUITY-MIT-GRANT.md';
const grant = await readFile(grantPath, 'utf8');
const expectedSha256 = '5bfa6752462be410374a0f964b5b00b8cbdccc5ac9e0fbc3ebcbb9491dd2d222';
const actualSha256 = createHash('sha256').update(grant).digest('hex');

if (actualSha256 !== expectedSha256) {
  throw new Error(
    `${grantPath} does not match the canonical continuity grant digest: expected ${expectedSha256}, received ${actualSha256}`
  );
}

const required = [
  '# Opfield Product Continuity MIT Grant 1.0',
  'Alexandr Slavinschii',
  'legally effective written assignment',
  'does not reduce rights already granted to users',
  'Company Rights Holder',
  'Final Dissolution Event',
  'ninety-first consecutive calendar day',
  'Service And Activity Are Not Triggers',
  'Voluntary MIT Election',
  'MIT License Terms',
];

for (const marker of required) {
  if (!grant.includes(marker)) {
    throw new Error(`${grantPath} is missing required continuity marker: ${marker}`);
  }
}

const forbidden = [
  /PolyForm Countdown/i,
  /^## Start Date$/m,
  /24 months/i,
  /180 consecutive calendar days/i,
  /Permanent Cessation Event/i,
];

for (const pattern of forbidden) {
  if (pattern.test(grant)) {
    throw new Error(`${grantPath} contains obsolete release-countdown terms matching ${pattern}`);
  }
}

console.log(`Verified static product continuity grant in ${grantPath}.`);
