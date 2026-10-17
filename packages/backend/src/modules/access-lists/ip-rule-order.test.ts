// The schema barrel first: loading the template service alone enters the schema import cycle mid-way.
import '@/db/schema/index.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NginxTemplateService } from '@/modules/proxy/nginx-template.service.js';
import { ConfigValidatorService } from '@/services/config-validator.service.js';
import { NginxConfigGenerator, type ProxyHostConfig } from '@/services/nginx-config-generator.service.js';
import { AccessListService } from './access-list.service.js';
import { analyzeAccessListIpRules } from './ip-rule-analysis.js';

const ACCESS_LIST_ID = '11111111-1111-4111-8111-111111111111';

const rule = (type: 'allow' | 'deny', value: string) => ({ type, value });

describe('Access list IP rule analysis', () => {
  it('marks a rule behind deny all as shadowed and points at the covering rule', () => {
    const warnings = analyzeAccessListIpRules([rule('deny', 'all'), rule('allow', '1.2.3.4')]);
    expect(warnings).toEqual([expect.objectContaining({ index: 1, kind: 'shadowed', coveredByIndex: 0 })]);
    expect(warnings[0].message).toContain('rule 1 (deny all)');
  });

  it('names the 0-based index the API fields use when asked to, so "rule N" is never read as an index', () => {
    const [warning] = analyzeAccessListIpRules(
      [rule('allow', '203.0.113.0/24'), rule('deny', 'all'), rule('allow', '172.20.0.138')],
      'index'
    );
    expect(warning).toEqual(expect.objectContaining({ index: 2, coveredByIndex: 1 }));
    expect(warning.message).toBe(
      'Never matches: the rule at index 1 (deny all) denies these addresses first. Move this rule (index 2) above it to allow them.'
    );
    expect(warning.message).not.toMatch(/\brule 2\b/);
  });

  it('marks a narrower rule behind a wider CIDR with either action, and not the other way round', () => {
    expect(analyzeAccessListIpRules([rule('allow', '10.0.0.0/8'), rule('deny', '10.1.2.0/24')])).toEqual([
      expect.objectContaining({ index: 1, kind: 'shadowed', coveredByIndex: 0 }),
    ]);
    // Same action: a duplicate that can be removed.
    expect(analyzeAccessListIpRules([rule('allow', '10.0.0.0/8'), rule('allow', '10.9.9.9')])).toEqual([
      expect.objectContaining({ index: 1, kind: 'shadowed', coveredByIndex: 0 }),
    ]);
    // The narrower deny first is the usual "block one, allow the rest of the range" pattern.
    expect(analyzeAccessListIpRules([rule('deny', '10.1.2.0/24'), rule('allow', '10.0.0.0/8')])).toEqual([]);
  });

  it('applies the CIDR host bits like nginx and keeps address families apart', () => {
    // 10.0.0.5/8 is 10.0.0.0/8 to nginx.
    expect(analyzeAccessListIpRules([rule('allow', '10.0.0.5/8'), rule('allow', '10.200.0.1')])).toHaveLength(1);
    expect(analyzeAccessListIpRules([rule('allow', '2001:db8::/32'), rule('deny', '2001:db8:0:1::1')])).toEqual([
      expect.objectContaining({ index: 1, kind: 'shadowed' }),
    ]);
    expect(
      analyzeAccessListIpRules([rule('allow', '::ffff:192.0.2.0/120'), rule('allow', '::ffff:192.0.2.7')])
    ).toEqual([expect.objectContaining({ index: 1, kind: 'shadowed' })]);
    // nginx checks IPv4 and IPv6 rules in separate lists: ::/0 does not cover an IPv4 address.
    expect(analyzeAccessListIpRules([rule('allow', '::/0'), rule('allow', '192.0.2.1')])).toEqual([]);
    expect(analyzeAccessListIpRules([rule('allow', '0.0.0.0/0'), rule('allow', 'all')])).toEqual([]);
  });

  it('marks a deny rule no later allow overlaps as having no effect, but not an explicit deny all', () => {
    expect(analyzeAccessListIpRules([rule('deny', '192.0.2.7')])).toEqual([
      expect.objectContaining({ index: 0, kind: 'no_effect' }),
    ]);
    expect(
      analyzeAccessListIpRules([rule('deny', '192.0.2.7'), rule('allow', '198.51.100.0/24'), rule('deny', 'all')])
    ).toEqual([expect.objectContaining({ index: 0, kind: 'no_effect' })]);
    expect(analyzeAccessListIpRules([rule('deny', '192.0.2.7'), rule('allow', 'all')])).toEqual([]);
    expect(analyzeAccessListIpRules([rule('allow', '192.0.2.0/24'), rule('deny', 'all')])).toEqual([]);
  });

  it('skips values that do not parse instead of guessing', () => {
    expect(analyzeAccessListIpRules([rule('deny', 'all'), rule('allow', '10.0.0.')])).toEqual([]);
    expect(analyzeAccessListIpRules([rule('allow', '1::2::3'), rule('allow', '1.2.3.4/33')])).toEqual([]);
  });

  it('is the same code the access list dialog runs', () => {
    const body = (path: URL) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => !line.startsWith('//'))
        .join('\n')
        // The packages format with different quotes and line widths: compare the code, not the layout.
        .replace(/["']/g, "'")
        .replace(/\s+/g, '')
        .replace(/,([)\]}])/g, '$1');
    expect(body(new URL('../../../../frontend/src/pages/access-lists/ip-rule-analysis.ts', import.meta.url))).toBe(
      body(new URL('./ip-rule-analysis.ts', import.meta.url))
    );
  });
});

const host: ProxyHostConfig = {
  id: '22222222-2222-4222-8222-222222222222',
  type: 'proxy',
  domainNames: ['example.com'],
  enabled: true,
  forwardHost: 'app',
  forwardPort: 8080,
  forwardScheme: 'http',
  sslEnabled: false,
  sslForced: false,
  http2Support: false,
  websocketSupport: false,
  redirectUrl: null,
  redirectStatusCode: 301,
  customHeaders: [],
  cacheEnabled: false,
  cacheOptions: null,
  rateLimitEnabled: false,
  rateLimitOptions: null,
  customRewrites: [],
  advancedConfig: null,
  templateVariables: {},
  accessList: {
    id: ACCESS_LIST_ID,
    ipRules: [rule('deny', '203.0.113.7'), rule('allow', '203.0.113.0/24'), rule('allow', '10.0.0.0/8')],
    basicAuthEnabled: false,
  },
  sslCertPath: null,
  sslKeyPath: null,
  sslChainPath: null,
};

function expectRulesInOrder(rendered: string) {
  const location = rendered.slice(rendered.indexOf('location / {'));
  const positions = ['deny 203.0.113.7;', 'allow 203.0.113.0/24;', 'allow 10.0.0.0/8;', 'deny all;'].map((line) =>
    location.indexOf(line)
  );
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
}

describe('Access list IP rule render order', () => {
  it('renders the rules in stored order, then deny all, in the built-in route template', async () => {
    const db = { query: { nginxTemplates: { findFirst: async () => undefined } } };
    const rendered = await new NginxTemplateService(
      db as never,
      {} as never,
      new ConfigValidatorService()
    ).renderForHost(host, null);
    expectRulesInOrder(rendered);
  });

  it('renders the rules in stored order, then deny all, in the config generator', () => {
    expectRulesInOrder(new NginxConfigGenerator({} as never).generateConfig(host));
  });
});

function moveHarness(ipRules: { type: 'allow' | 'deny'; value: string }[]) {
  const existing = {
    id: ACCESS_LIST_ID,
    name: 'office',
    description: null,
    ipRules,
    basicAuthEnabled: false,
    basicAuthUsers: [],
    updatedAt: new Date(0),
  };
  const writes: Record<string, unknown>[] = [];
  const db = {
    query: {
      accessLists: { findFirst: vi.fn().mockResolvedValue(existing) },
      proxyHosts: { findMany: vi.fn().mockResolvedValue([]) },
      pageProjects: { findMany: vi.fn().mockResolvedValue([]) },
    },
    update: vi.fn(() => ({
      set: (data: Record<string, unknown>) => {
        writes.push(data);
        return { where: () => ({ returning: async () => [{ ...existing, ...data }] }) };
      },
    })),
    select: vi.fn(() => ({ from: () => ({ where: async () => [] }) })),
  } as any;
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const service = new AccessListService(
    db,
    {} as any,
    {} as any,
    audit as any,
    { isNodeConnected: vi.fn(() => false) } as any,
    {} as any
  );
  return { service, writes, audit };
}

describe('Access list IP rule move', () => {
  it('moves one rule against the stored list, audits the move and returns the warnings', async () => {
    const { service, writes, audit } = moveHarness([
      rule('deny', 'all'),
      rule('allow', '198.51.100.0/24'),
      rule('allow', '203.0.113.7'),
    ]);

    const result = await service.moveIpRule(ACCESS_LIST_ID, { fromIndex: 0, toIndex: 2 }, 'user-id');

    const moved = [rule('allow', '198.51.100.0/24'), rule('allow', '203.0.113.7'), rule('deny', 'all')];
    expect(writes).toEqual([expect.objectContaining({ ipRules: moved })]);
    expect(result.ipRules).toEqual(moved);
    expect(result.ipRuleWarnings).toEqual([]);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'access_list.move_ip_rule',
        resourceId: ACCESS_LIST_ID,
        details: { fromIndex: 0, toIndex: 2, rule: rule('deny', 'all') },
      })
    );
  });

  it('rejects a position outside the list without writing', async () => {
    const { service, writes } = moveHarness([rule('allow', '10.0.0.0/8')]);

    await expect(service.moveIpRule(ACCESS_LIST_ID, { fromIndex: 0, toIndex: 1 }, 'user-id')).rejects.toMatchObject({
      code: 'IP_RULE_INDEX_OUT_OF_RANGE',
    });
    expect(writes).toEqual([]);
  });

  it('reports a shadowed rule on a list that is not moved', async () => {
    const { service, writes } = moveHarness([rule('deny', 'all'), rule('allow', '203.0.113.7')]);

    const result = await service.moveIpRule(ACCESS_LIST_ID, { fromIndex: 1, toIndex: 1 }, 'user-id');

    expect(writes).toEqual([]);
    expect(result.ipRuleWarnings).toEqual([expect.objectContaining({ index: 1, kind: 'shadowed', coveredByIndex: 0 })]);
    expect(result.basicAuthUsers).toEqual([]);
  });
});

// rc.3 stand O-13: POST /api/access-lists dropped an unknown field (folderId) silently and created the list at the root.
describe('access list fields over REST', () => {
  it('names a field the API does not take instead of dropping it', async () => {
    const { assertAccessListFields } = await import('./access-list.schemas.js');
    expect(() => assertAccessListFields({ name: 'a', ipRules: [] })).not.toThrow();
    expect(() => assertAccessListFields({ name: 'a', folderId: 'x' })).toThrow(
      /folderId is not a field of an access list \(fields: name, description, ipRules, basicAuthEnabled, basicAuthUsers\)\. Access lists have no folders\./
    );
  });
});
