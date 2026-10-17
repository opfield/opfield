// The schema barrel first, in its production order: the per-table modules import each other circularly.
import '@/db/schema/index.js';
import { describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import type { domains } from '@/db/schema/domains.js';
import { LEGACY_DNS_RECORD_COMMENT_PREFIX } from '@/lib/legacy-compat.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import { DomainsService } from './domain.service.js';
import { domainRecordComment, legacyDomainRecordComment } from './domain.service.shared.js';

const DOMAIN_ID = '22222222-2222-4222-8222-222222222222';
const TARGET = '203.0.113.10';

type DomainRow = typeof domains.$inferSelect;
type DnsRecord = {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  comment?: string | null;
};

function row(providerRecordIds: string[]): DomainRow {
  return {
    id: DOMAIN_ID,
    domain: 'app.example.com',
    dnsProvider: 'cloudflare',
    nginxNodeId: '11111111-1111-4111-8111-111111111111',
    ingressGroupId: null,
    integrationConnectorId: 'connector-1',
    providerZoneId: 'zone-1',
    providerRecordIds,
    dnsTargetIps: [TARGET],
    pendingDnsTargetIp: null,
    dnsRecordType: 'A',
    dnsTtl: 1,
    dnsProxied: false,
    dnsStatus: 'valid',
  } as unknown as DomainRow;
}

function setup(records: DnsRecord[]) {
  const db = {
    update: vi.fn(() => ({ set: () => ({ where: async () => undefined }) })),
  };
  const client = {
    listDnsRecords: vi.fn(async () => records),
    createDnsRecord: vi.fn(async () => ({ id: 'created' })),
    updateDnsRecord: vi.fn(async (_zone: string, id: string) => ({ id })),
    deleteDnsRecord: vi.fn(async () => undefined),
  };
  const integrations = {
    getCloudflareDnsContextForRecord: vi.fn(async () => ({ zone: { remoteId: 'zone-1' }, client })),
  };
  const audit = { log: vi.fn(async () => undefined) };
  const service = new DomainsService(db as unknown as DrizzleClient, audit as unknown as AuditService);
  service.setIntegrationsService(integrations as unknown as IntegrationsService);
  const internals = service as unknown as {
    reconcileDomainTarget(row: DomainRow, target: string): Promise<void>;
    persistReconciledDomainTarget(row: DomainRow, targetIps: string[], ids: string[]): Promise<void>;
  };
  const persist = vi.spyOn(internals, 'persistReconciledDomainTarget').mockResolvedValue(undefined);
  return { client, audit, persist, reconcile: (r: DomainRow) => internals.reconcileDomainTarget(r, TARGET) };
}

const record = (id: string, comment: string | null): DnsRecord => ({
  id,
  type: 'A',
  name: 'app.example.com',
  content: TARGET,
  ttl: 1,
  proxied: false,
  comment,
});

describe('Cloudflare ownership comment of domain address records', () => {
  it('names records with the Opfield comment', () => {
    expect(domainRecordComment(DOMAIN_ID)).toBe(`opfield:domain:${DOMAIN_ID}`);
    expect(legacyDomainRecordComment(DOMAIN_ID)).toBe(`${LEGACY_DNS_RECORD_COMMENT_PREFIX}${DOMAIN_ID}`);
  });

  it('rewrites the pre-2.12.1 comment of a tracked record on reconcile and changes nothing else', async () => {
    const { client, persist, reconcile } = setup([record('record-1', legacyDomainRecordComment(DOMAIN_ID))]);
    await reconcile(row(['record-1']));
    expect(persist).toHaveBeenCalledWith(expect.anything(), [TARGET], ['record-1']);
    expect(client.updateDnsRecord).toHaveBeenCalledWith('zone-1', 'record-1', {
      type: 'A',
      name: 'app.example.com',
      content: TARGET,
      ttl: 1,
      proxied: false,
      comment: domainRecordComment(DOMAIN_ID),
    });
    expect(client.createDnsRecord).not.toHaveBeenCalled();
    expect(client.deleteDnsRecord).not.toHaveBeenCalled();
  });

  it('recovers an untracked record by either comment and leaves a current one alone', async () => {
    const legacy = setup([record('record-9', legacyDomainRecordComment(DOMAIN_ID))]);
    await legacy.reconcile(row(['record-1']));
    expect(legacy.client.updateDnsRecord).toHaveBeenCalledWith(
      'zone-1',
      'record-9',
      expect.objectContaining({ comment: domainRecordComment(DOMAIN_ID) })
    );
    expect(legacy.persist).toHaveBeenCalledWith(expect.anything(), [TARGET], ['record-9']);

    const current = setup([record('record-9', domainRecordComment(DOMAIN_ID))]);
    await current.reconcile(row(['record-1']));
    expect(current.client.updateDnsRecord).not.toHaveBeenCalled();
    expect(current.persist).toHaveBeenCalledWith(expect.anything(), [TARGET], ['record-9']);
  });

  it('treats an address record with any other comment as a conflict', async () => {
    const { client, audit, persist, reconcile } = setup([record('record-9', 'someone-else')]);
    await reconcile(row(['record-1']));
    expect(persist).not.toHaveBeenCalled();
    expect(client.updateDnsRecord).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'domain.dns_target.reconcile_failed' }));
  });
});
