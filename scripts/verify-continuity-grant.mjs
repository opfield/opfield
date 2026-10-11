import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const grantPath = process.argv[2] ?? 'CONTINUITY-GRANT.md';
const grant = await readFile(grantPath, 'utf8');
const expectedSha256 = '053d9d00ce049363153edbe7450e50038ff6a539d7d9cc6485b3b6c1ddb4c986';
const actualSha256 = createHash('sha256').update(grant).digest('hex');

if (actualSha256 !== expectedSha256) {
  throw new Error(
    `${grantPath} does not match the canonical continuity grant digest: expected ${expectedSha256}, received ${actualSha256}`
  );
}

const required = [
  '# Opfield Product Continuity Grant 1.0',
  'Alexandr Slavinschii, Republic of Moldova',
  'It cannot be revoked.',
  'at any address the Licensor publishes for it. It is available while any of those addresses answers.',
  'for 12 consecutive months, no new Opfield release is published and the license service is not available',
  'end of life',
  'dies or is legally declared unable to act',
  'including its commercial core, to everyone under the MIT License terms below. This license is irrevocable.',
  'within 90 days of the Continuity Event',
  'valid at the moment of the Continuity Event',
  'perpetual, worldwide, royalty-free license',
  'without the license service',
  'MIT License Terms',
];

for (const marker of required) {
  if (!grant.includes(marker)) {
    throw new Error(`${grantPath} is missing required continuity marker: ${marker}`);
  }
}

// Terms of earlier continuity grants that must not come back.
const forbidden = [
  /PolyForm Countdown/i,
  /^## Start Date$/m,
  /Permanent Cessation Event/i,
  /Company Rights Holder/i,
  /Final Dissolution Event/i,
  /legal entity/i,
];

for (const pattern of forbidden) {
  if (pattern.test(grant)) {
    throw new Error(`${grantPath} contains obsolete continuity terms matching ${pattern}`);
  }
}

console.log(`Verified static product continuity grant in ${grantPath}.`);
