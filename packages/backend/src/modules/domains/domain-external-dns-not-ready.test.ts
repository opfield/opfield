// The schema barrel first, in its production order: the per-table modules import each other circularly.
import '@/db/schema/index.js';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { DomainsService } from './domain.service.js';

// Like the Add Domain dialog, an external-DNS domain is registered only once its DNS points at the ingress. The
// refusal must say which record to create and that the domain is then added again (X-O-2).
function serviceWithPlan(status: 'missing' | 'invalid' | 'unknown') {
  const insert = vi.fn();
  const service = Object.create(DomainsService.prototype) as DomainsService;
  Object.assign(service, {
    db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }), insert },
    prepareExternalDomain: vi.fn(async () => ({
      domainName: 'app.example.com',
      queryName: 'app.example.com',
      nginxNode: { id: 'node-1' },
      ingressGroupId: null,
      targetIps: ['203.0.113.10'],
      dnsRecords: { a: [], aaaa: [], cname: [], caa: [], mx: [], txt: [] },
      status,
    })),
  });
  return { service, insert };
}

describe('external DNS domain before its DNS resolves', () => {
  it.each([
    'missing',
    'invalid',
    'unknown',
  ] as const)('refuses (%s) with the record to create and the next step', async (status) => {
    const { service, insert } = serviceWithPlan(status);
    const error = await (service as any)
      .createExternalDomain({ domain: 'app.example.com', dnsProvider: 'external' }, 'user-1')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ statusCode: 409, code: 'DOMAIN_DNS_NOT_READY' });
    expect(error.message).toContain('app.example.com to 203.0.113.10');
    expect(error.message).toMatch(/then add the domain again\.$/);
    expect(error.details).toMatchObject({ status, targetIps: ['203.0.113.10'] });
    expect(insert).not.toHaveBeenCalled();
  });
});
