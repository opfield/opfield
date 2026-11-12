// The schema barrel first, in its production order: the per-table modules import each other circularly.
import '@/db/schema/index.js';
import { describe, expect, it } from 'vitest';
import { x509, x509DnValue } from '@/lib/x509.js';
import { subjectDnFieldsFromDn } from '@/modules/ssl/internal-cert-renewal.service.js';
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
    'x=y=z',
    'Team #1',
    'a\\b, c',
  ])('keeps %s as one attribute: a value cannot add attributes to the subject', (value) => {
    expect(new x509.Name(`CN=${x509DnValue(value)}`).toJSON()).toEqual([{ CN: [value] }]);
  });

  it('reads a stored subject back as the names it was issued with, so a reissue keeps the subject', () => {
    const fields = { o: 'Acme, Inc.', ou: 'Team #1', l: 'Washington, D.C.', st: 'R+D \\ ops', c: 'US' };
    const stored = [
      `CN=${x509DnValue('host, O=Other')}`,
      `O=${x509DnValue(fields.o)}`,
      `OU=${x509DnValue(fields.ou)}`,
      `L=${x509DnValue(fields.l)}`,
      `ST=${x509DnValue(fields.st)}`,
      `C=${fields.c}`,
    ].join(', ');
    expect(subjectDnFieldsFromDn(stored)).toEqual(fields);
    // A subject stored before values were escaped.
    expect(subjectDnFieldsFromDn('CN=host, O=Acme, Inc., C=US')).toEqual({ o: 'Acme, Inc.', c: 'US' });
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
