// The schema barrel first, in its production order: the per-table modules import each other circularly.
import '@/db/schema/index.js';
import { describe, expect, it } from 'vitest';
import { x509, x509DnValue } from '@/lib/x509.js';
import { IssueCertificateSchema } from './cert.schemas.js';

const issued = { caId: '11111111-1111-4111-8111-111111111111', type: 'tls-server', keyAlgorithm: 'ecdsa-p256' };

describe('names in certificates', () => {
  it.each([
    'a, O=Other',
    'a,b',
    'a+b',
    '#hash',
    'back\\slash',
    'quo"te',
    '<x>',
    'semi;colon',
    'a=b',
  ])('keeps %s as one attribute: a value cannot add attributes to the subject', (value) => {
    expect(new x509.Name(`CN=${x509DnValue(value)}`).toJSON()).toEqual([{ CN: [value] }]);
  });

  it('refuses control characters, which a name cannot carry', () => {
    const parsed = IssueCertificateSchema.safeParse({
      ...issued,
      commonName: 'line\nbreak',
      validityDays: 1,
    });
    expect(parsed.success).toBe(false);
  });
});
