import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const grantPath = process.argv[2] ?? 'CONTINUITY-GRANT.md';
const grant = await readFile(grantPath, 'utf8');
const expectedSha256 = 'a2f9d203cd85870532c16690e88d11e50c3b2396aef3c70e91ba84a7623ec477';
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
  'for 12 consecutive months, no new Opfield release is published and the Opfield license server is not available',
  'end of life',
  'dies or is legally declared unable to act',
  'valid at the moment of the Continuity Event',
  'perpetual, worldwide, royalty-free license',
  'including its commercial core',
  'without the license server',
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
