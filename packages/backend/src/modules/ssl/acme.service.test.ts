import * as acme from 'acme-client';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { ACMEService } from './acme.service.js';

describe('ACMEService errors', () => {
  it('answers a failed order with a code and the reason instead of a bare 500', async () => {
    const service = new ACMEService({ directoryUrl: 'http://127.0.0.1:9/directory' });
    service.onHttp01Preflight = async () => {
      throw new Error('no ingress node serves app.internal');
    };
    const error = await service.requestCertHTTP01(['app.internal'], false, 'ops@example.com').catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ statusCode: 400, code: 'ACME_ISSUANCE_FAILED' });
    expect(error.message).toContain('app.internal');
    expect(error.message).toContain('no ingress node serves app.internal');
  });

  it('keeps the coded errors it raises itself', async () => {
    const error = await new ACMEService().requestCertDNS01Start(['app.example.com']).catch((e) => e);
    expect(error).toMatchObject({ statusCode: 400, code: 'ACME_CONTACT_EMAIL_MISSING' });
  });
});

describe('ACMEService challenge self-check', () => {
  const authz = { identifier: { type: 'dns', value: 'app.example.com' } } as never;

  async function budget(type: 'http-01' | 'dns-01') {
    const seen: unknown[] = [];
    const spy = vi.spyOn(acme.Client.prototype, 'verifyChallenge').mockImplementation(async function (this: any) {
      seen.push(this.backoffOpts);
      return true;
    });
    try {
      await (new ACMEService() as any).selfCheck(Buffer.from('key'), true, authz, { type, token: 't' });
    } finally {
      spy.mockRestore();
    }
    return seen[0];
  }

  it('waits about three minutes for a DNS-01 record, as acme-client did, and 30 s for HTTP-01', async () => {
    expect(await budget('dns-01')).toEqual({ attempts: 10, min: 5000, max: 30000 });
    expect(await budget('http-01')).toEqual({ attempts: 3, min: 2000, max: 4000 });
  });
});
