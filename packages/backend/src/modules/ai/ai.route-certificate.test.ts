import { describe, expect, it } from 'vitest';
import { compactProxyHostForAgent } from './ai.service-helpers.js';

// get_route showed sslCertificateId null and nothing else for a route that served a PKI certificate attached
// directly with internalCertificateId (X-O-3).
const base = {
  id: 'route-1',
  domainNames: ['app.example.com'],
  sslEnabled: true,
  sslCertificateId: null,
  internalCertificateId: 'pki-1',
  sslCertificate: null,
  internalCertificate: {
    id: 'pki-1',
    commonName: 'app.example.com',
    status: 'active',
    notAfter: '2027-01-01T00:00:00.000Z',
  },
};

describe('the certificate of a route for agents', () => {
  it('names a PKI certificate attached directly', () => {
    expect(compactProxyHostForAgent(base)).toMatchObject({
      sslCertificateId: null,
      internalCertificateId: 'pki-1',
      certificate: {
        source: 'pki',
        id: 'pki-1',
        name: 'app.example.com',
        status: 'active',
        notAfter: '2027-01-01T00:00:00.000Z',
      },
    });
  });

  it('names the SSL store certificate when both are set, as nginx serves it', () => {
    const host = {
      ...base,
      sslCertificateId: 'ssl-1',
      sslCertificate: { id: 'ssl-1', name: 'Wildcard', type: 'acme', domainNames: ['*.example.com'], status: 'active' },
    };
    expect(compactProxyHostForAgent(host).certificate).toMatchObject({ source: 'ssl', id: 'ssl-1', name: 'Wildcard' });
  });

  it('serves none without HTTPS, and a list item without the resolved certificates carries the ids only', () => {
    expect(compactProxyHostForAgent({ ...base, sslEnabled: false }).certificate).toBeNull();
    const listItem = compactProxyHostForAgent({ ...base, sslCertificate: undefined, internalCertificate: undefined });
    expect(listItem).not.toHaveProperty('certificate');
    expect(listItem.internalCertificateId).toBe('pki-1');
  });
});
