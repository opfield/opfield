import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type AccessDecision,
  type AccessIdentity,
  type AccessIdentitySource,
  type AccessPolicyList,
  evaluateAccess,
} from './access-policy-evaluator.js';

interface Vector {
  name: string;
  list: AccessPolicyList;
  clientIp: string;
  identity?: AccessIdentity;
  source?: AccessIdentitySource;
  expect: AccessDecision;
}

// The same vectors the nginx daemon's evaluator passes (contract: Decision).
const vectorsPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../testdata/access/vectors.json');
const { cases } = JSON.parse(readFileSync(vectorsPath, 'utf8')) as { cases: Vector[] };

describe('access decision vectors (testdata/access/vectors.json)', () => {
  it('has vectors', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases.map((vector) => [vector.name, vector] as const))('%s', (_name, vector) => {
    const presented = vector.identity ? { source: vector.source ?? 'cookie', identity: vector.identity } : undefined;
    expect(evaluateAccess(vector.list, { clientIp: vector.clientIp }, presented)).toBe(vector.expect);
  });

  it('treats an IPv4-mapped IPv6 client as its IPv4 address', () => {
    const list = cases.find((vector) => vector.name === 'skip range passes without identity')!.list;
    expect(evaluateAccess(list, { clientIp: '::ffff:10.0.40.15' })).toBe('allow');
  });
});
