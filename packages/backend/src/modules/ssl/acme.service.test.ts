import { describe, expect, it } from 'vitest';
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
