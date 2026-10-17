// The schema barrel first: loading the template service alone enters the schema import cycle mid-way.
import '@/db/schema/index.js';
import { describe, expect, it, vi } from 'vitest';
import { ConfigValidatorService } from '@/services/config-validator.service.js';
import { type NginxConfigDirective, parseNginxConfig } from './nginx-config-tree.js';
import { MAINTENANCE_FLAG_CAPABILITY, MAINTENANCE_FLAG_DIR } from './nginx-maintenance-flag-guard.js';
import { NGINX_OPFIELD_NAMES_CAPABILITY } from './nginx-node-names.js';
import { NginxTemplateService } from './nginx-template.service.js';
import { ProxyService } from './proxy.service.js';
import { LEGACY_INSTALL_DIR_NAME, LEGACY_NGINX_DIR } from '@/lib/legacy-compat.js';

const HOST_ID = '22222222-2222-4222-8222-222222222222';

function route(maintenanceEnabled: boolean, advancedConfig: string | null = null) {
  return {
    id: HOST_ID,
    type: 'proxy',
    domainNames: ['shop.example.com'],
    enabled: true,
    isSystem: false,
    nodeId: 'nginx-node',
    ingressGroupId: null,
    upstreamKind: 'manual',
    dockerNodeId: null,
    dockerDeploymentId: null,
    forwardHost: '10.0.0.5',
    forwardPort: 8080,
    forwardScheme: 'http',
    secureLinkGeneration: 0,
    secureLinkMigratedAt: null,
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
    advancedConfig,
    rawConfig: null,
    rawConfigEnabled: false,
    accessListId: null,
    nginxTemplateId: null,
    templateVariables: {},
    maintenanceEnabled,
    maintenanceStartedAt: maintenanceEnabled ? new Date('2026-10-01T00:00:00Z') : null,
    healthCheckEnabled: false,
    healthStatus: 'unknown',
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  } as any;
}

/** A maintenance toggle over fakes: the stored row before and after, and a node reporting `capabilities`. */
function toggleHarness(
  before: any,
  after: any,
  capabilities: string[],
  apply: () => Promise<{ success: boolean; error?: string }> = async () => ({ success: true })
) {
  const db = {
    query: {
      proxyHosts: { findFirst: vi.fn().mockResolvedValue(before) },
      nodes: {
        findFirst: vi.fn().mockResolvedValue({ type: 'nginx', status: 'online', capabilities: { capabilities } }),
      },
      nginxTemplates: { findFirst: vi.fn().mockResolvedValue(undefined) },
    },
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([after]) })) })),
    })),
    // The answer's display fields: the route has no additional Secure Links.
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })),
  } as any;
  const applyConfig = vi.fn((..._args: unknown[]) => apply());
  const maintenanceAccess = {
    secretForHost: () => 'route-secret',
    isNodeSupported: vi.fn().mockResolvedValue(true),
  } as any;
  const service = new ProxyService(
    db,
    new NginxTemplateService(db, {} as never, new ConfigValidatorService()),
    { log: vi.fn().mockResolvedValue(undefined) } as any,
    {} as any,
    { resolveNodeId: vi.fn().mockResolvedValue('nginx-node'), applyConfig } as any,
    {} as any,
    undefined,
    undefined,
    undefined,
    maintenanceAccess
  );
  return { service, applyConfig };
}

describe('Maintenance mode on a node that keeps maintenance flags', () => {
  it('switches only the flag: entering and leaving send the route config unchanged', async () => {
    const enter = toggleHarness(route(false), route(true), [
      'proxy_maintenance_access_v1',
      MAINTENANCE_FLAG_CAPABILITY,
      NGINX_OPFIELD_NAMES_CAPABILITY,
    ]);
    await enter.service.toggleMaintenance(HOST_ID, true, 'user-id');
    const leave = toggleHarness(route(true), route(false), [
      'proxy_maintenance_access_v1',
      MAINTENANCE_FLAG_CAPABILITY,
      NGINX_OPFIELD_NAMES_CAPABILITY,
    ]);
    await leave.service.toggleMaintenance(HOST_ID, false, 'user-id');

    const [entered] = enter.applyConfig.mock.calls;
    const [left] = leave.applyConfig.mock.calls;
    expect(entered![2]).toBe(left![2]);
    expect(entered![2]).toContain(`if (-f ${MAINTENANCE_FLAG_DIR}/${HOST_ID})`);
    // (node, host, config, testOnly, ownership, deferReload, maintenance)
    expect(entered![6]).toBe(true);
    expect(left![6]).toBe(false);
  });

  it('renders the guard with the pre-Opfield names for a node that has not moved to the Opfield ones', async () => {
    const enter = toggleHarness(route(false), route(true), [
      'proxy_maintenance_access_v1',
      MAINTENANCE_FLAG_CAPABILITY,
    ]);
    await enter.service.toggleMaintenance(HOST_ID, true, 'user-id');
    const config = enter.applyConfig.mock.calls[0]![2] as string;
    expect(config).toContain(`if (-f ${LEGACY_NGINX_DIR}/maintenance/${HOST_ID})`);
    expect(config).toContain(`set $${LEGACY_INSTALL_DIR_NAME}_maintenance 1;`);
    expect(config).toContain('location = opfield-maintenance-access {');
    expect(config).not.toMatch(/\$opfield_|opfield-maintenance|\/etc\/nginx\/opfield|X-Opfield-/);
  });

  it('keeps reloading on a node without maintenance flags', async () => {
    const enter = toggleHarness(route(false), route(true), ['proxy_maintenance_access_v1']);
    await enter.service.toggleMaintenance(HOST_ID, true, 'user-id');
    const leave = toggleHarness(route(true), route(false), ['proxy_maintenance_access_v1']);
    await leave.service.toggleMaintenance(HOST_ID, false, 'user-id');

    const [entered] = enter.applyConfig.mock.calls;
    const [left] = leave.applyConfig.mock.calls;
    expect(entered![2]).toContain('return 503');
    expect(left![2]).not.toContain('return 503');
    expect(entered![6]).toBeUndefined();
    expect(left![6]).toBeUndefined();
  });
});

describe('App kill switch lockdown', () => {
  const withMode = (mode: string) => ({ ...route(false), appMaintenanceMode: mode });

  it.each([
    ['a node that keeps maintenance flags', ['proxy_maintenance_access_v1', MAINTENANCE_FLAG_CAPABILITY]],
    ['a node without maintenance flags', ['proxy_maintenance_access_v1']],
  ])('renders the plain maintenance page without team access on %s', async (_label, capabilities) => {
    const harness = toggleHarness(withMode('maintenance'), withMode('lockdown'), capabilities);
    expect(await harness.service.setAppMaintenanceMode(HOST_ID, 'lockdown')).toBe(true);
    const [call] = harness.applyConfig.mock.calls;
    expect(call).toBeDefined();
    const config = call![2] as string;
    expect(config).toContain('return 503');
    expect(config).not.toContain('maintenance-access.sock');
    expect(config).not.toContain(MAINTENANCE_FLAG_DIR);
  });

  it('delivers leaving lockdown back to maintenance with team access again', async () => {
    const harness = toggleHarness(withMode('lockdown'), withMode('maintenance'), ['proxy_maintenance_access_v1']);
    expect(await harness.service.setAppMaintenanceMode(HOST_ID, 'maintenance')).toBe(true);
    const [call] = harness.applyConfig.mock.calls;
    expect(call![2]).toContain('maintenance-access.sock');
  });
});

/** The names of the directives each server block sets itself, once per occurrence. */
function serverDirectives(config: string): string[][] {
  return parseNginxConfig(config)
    .filter((directive) => directive.name === 'server' && directive.block)
    .map((server) => server.block!.children.map((directive: NginxConfigDirective) => directive.name));
}

const ACCESS_ONLY = ['proxy_maintenance_access_v1'];
const ACCESS_AND_FLAGS = ['proxy_maintenance_access_v1', MAINTENANCE_FLAG_CAPABILITY];
const OWN_SECURE_LINK = 'secure_link $arg_md5,$arg_expires;\nsecure_link_md5 "$secure_link_expires$uri route-secret";';

describe('Maintenance mode of a route whose config collides with the guard', () => {
  it.each([
    ['a node that keeps maintenance flags', ACCESS_AND_FLAGS],
    ['a node without maintenance flags', ACCESS_ONLY],
  ])('enters maintenance with its own secure_link on %s: one secure_link, the page without team access', async (_, capabilities) => {
    const enter = toggleHarness(route(false, OWN_SECURE_LINK), route(true, OWN_SECURE_LINK), capabilities);
    await enter.service.toggleMaintenance(HOST_ID, true, 'user-id');

    const config = enter.applyConfig.mock.calls[0]![2] as string;
    for (const directives of serverDirectives(config)) {
      expect(directives.filter((name) => name === 'secure_link')).toHaveLength(1);
      expect(directives.filter((name) => name === 'secure_link_md5')).toHaveLength(1);
    }
    expect(config).toContain('return 503');
    expect(config).not.toContain('maintenance-access.sock');
    expect(config).not.toContain('Team access');
  });

  it('enters maintenance with its own server-level default_type on a node without maintenance flags', async () => {
    const own = 'default_type application/json;';
    const enter = toggleHarness(route(false, own), route(true, own), ACCESS_ONLY);
    await enter.service.toggleMaintenance(HOST_ID, true, 'user-id');

    const config = enter.applyConfig.mock.calls[0]![2] as string;
    for (const directives of serverDirectives(config)) {
      expect(directives.filter((name) => name === 'default_type')).toHaveLength(1);
    }
    // The access-code bypass fits this config, so the page keeps it.
    expect(config).toContain('maintenance-access.sock');
    expect(config).toContain('Team access');
  });

  it('answers a config the node rejected with one prefix and its own status', async () => {
    const rejected = 'nginx config test failed: nginx: [emerg] unknown directive "bogus" in /etc/nginx/x.conf:3';
    const enter = toggleHarness(route(false), route(true), ACCESS_AND_FLAGS, async () => ({
      success: false,
      error: rejected,
    }));

    await expect(enter.service.toggleMaintenance(HOST_ID, true, 'user-id')).rejects.toMatchObject({
      statusCode: 422,
      code: 'NGINX_CONFIG_FAILED',
      message: `Failed to apply Nginx config: ${rejected}`,
    });
  });
});

/** Evaluates an nginx map of `config` the way nginx does: the first matching regular expression gives the value. */
function applyMap(config: string, variable: string, input: string): string {
  const block = config.slice(config.indexOf(` ${variable} {`));
  const rules = [...block.slice(0, block.indexOf('\n}')).matchAll(/"~(.+)" "(.*)";/g)];
  for (const [, pattern, value] of rules) {
    const match = new RegExp(pattern!).exec(input);
    if (match) return value!.replace(/\$(\d)/g, (_, group: string) => match[Number(group)] ?? '');
  }
  return input;
}

describe('Maintenance access cookies on a node without maintenance flags', () => {
  it('forwards the request cookies without the access cookies and without an empty or leading separator', () => {
    const templates = new NginxTemplateService({} as never, {} as never, new ConfigValidatorService());
    const config = templates.applyMaintenanceGuard(
      'server {\n    listen 80;\n    location / { proxy_pass http://10.0.0.5; }\n}\n',
      {
        hostId: HOST_ID,
        secret: 'route-secret',
      }
    );
    const suffix = HOST_ID.replace(/-/g, '_');
    const forward = (cookie: string) =>
      applyMap(config, `$gm_cookie_${suffix}`, applyMap(config, `$gms_${suffix}`, cookie));
    const sig = 'opfield_maintenance_access_sig=S1g';
    const exp = 'opfield_maintenance_access_exp=1700000000';

    expect(forward(`${sig}; ${exp}; mine=1`)).toBe('mine=1');
    expect(forward(`${sig}; mine=1; ${exp}`)).toBe('mine=1');
    expect(forward(`mine=1; ${sig}; ${exp}`)).toBe('mine=1');
    expect(forward(`a=1; ${sig}; b=2; ${exp}; c=3`)).toBe('a=1; b=2; c=3');
    expect(forward(`a=1;${sig};b=2;${exp}`)).toBe('a=1;b=2');
    expect(forward(`${sig}; ${exp}`)).toBe('');
    expect(forward('mine=1')).toBe('mine=1');
  });
});
