// The schema barrel first: loading the template service alone enters the schema import cycle mid-way.
import '@/db/schema/index.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigValidatorService } from '@/services/config-validator.service.js';
import type { ProxyHostConfig } from '@/services/nginx-config-generator.service.js';
import { type NginxConfigDirective, parseNginxConfig } from './nginx-config-tree.js';
import {
  ERROR_PAGE_PATH,
  OPFIELD_ERROR_PAGE_CODES,
  OPFIELD_SPECIAL_ERROR_PAGE_CODES,
  withOpfieldErrorPages,
} from './nginx-error-pages.js';
import { renderMaintenanceFlagGuard } from './nginx-maintenance-flag-guard.js';
import { maintenanceAccessListDirectives, NginxTemplateService } from './nginx-template.service.js';

// Owner request for 2.12.3: every page nginx itself generates is an Opfield page, while an upstream's own error
// responses pass through and the codes a route answers itself (Pages 404, SPA fallback) keep their handling.
const HOST_ID = '11111111-1111-4111-8111-111111111111';
const accessList: NonNullable<ProxyHostConfig['accessList']> = {
  id: '22222222-2222-4222-8222-222222222222',
  ipRules: [
    { type: 'allow', value: '10.0.0.0/8' },
    { type: 'deny', value: 'all' },
  ],
  basicAuthEnabled: true,
};
const host: ProxyHostConfig = {
  id: HOST_ID,
  type: 'proxy',
  domainNames: ['example.com'],
  enabled: true,
  forwardHost: '127.0.0.1',
  forwardPort: 8080,
  forwardScheme: 'http',
  sslEnabled: true,
  sslForced: true,
  http2Support: true,
  websocketSupport: true,
  redirectUrl: null,
  redirectStatusCode: 301,
  customHeaders: [{ name: 'X-Route', value: 'blue' }],
  cacheEnabled: false,
  cacheOptions: null,
  rateLimitEnabled: true,
  rateLimitOptions: null,
  customRewrites: [],
  advancedConfig: 'location /api/ {\n    proxy_set_header Host $host;\n    proxy_pass http://127.0.0.1:9000;\n}',
  templateVariables: {},
  accessList,
  sslCertPath: '/etc/nginx/certs/example/current/fullchain.pem',
  sslKeyPath: '/etc/nginx/certs/example/current/privkey.pem',
  sslChainPath: null,
};

function templates() {
  const db = { query: { nginxTemplates: { findFirst: async () => undefined } } };
  return new NginxTemplateService(db as never, {} as never, new ConfigValidatorService());
}

async function render(overrides: Partial<ProxyHostConfig> = {}): Promise<string> {
  return templates().renderForHost({ ...host, ...overrides }, null);
}

function servers(config: string): NginxConfigDirective[] {
  return parseNginxConfig(config).filter((directive) => directive.name === 'server');
}

/** The codes each error_page directly in a scope hands to where. */
function errorPages(scope: NginxConfigDirective): Map<number, string> {
  const result = new Map<number, string>();
  for (const directive of scope.block!.children.filter((child) => child.name === 'error_page')) {
    const target = directive.args.at(-1)!.value;
    for (const arg of directive.args.slice(0, -1)) if (/^\d{3}$/.test(arg.value)) result.set(Number(arg.value), target);
  }
  return result;
}

function locations(scope: NginxConfigDirective): NginxConfigDirective[] {
  const result: NginxConfigDirective[] = [];
  const visit = (children: NginxConfigDirective[]) => {
    for (const child of children) {
      if (child.name === 'location' && child.block) {
        result.push(child);
        visit(child.block.children);
      }
    }
  };
  visit(scope.block!.children);
  return result;
}

/** Configs written for the nginx -t run on a real nginx (OPFIELD_NGINX_RENDER_DIR, see the rc.4 report). */
function keep(name: string, config: string) {
  const dir = process.env.OPFIELD_NGINX_RENDER_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.conf`), config);
}

describe('Opfield error pages', () => {
  it('hands every code nginx generates in a proxy route to the pages, and keeps proxy_intercept_errors off', async () => {
    const config = withOpfieldErrorPages(await render());
    keep('proxy', config);
    expect(config).not.toMatch(/proxy_intercept_errors\s+on/);
    const all = servers(config);
    expect(all.length).toBeGreaterThan(0);
    for (const server of all) {
      const pages = errorPages(server);
      for (const code of OPFIELD_ERROR_PAGE_CODES) {
        expect(pages.get(code), String(code)).toBe(code === 400 || code === 414 ? ERROR_PAGE_PATH : '@opfield_error');
      }
      for (const code of OPFIELD_SPECIAL_ERROR_PAGE_CODES) expect(pages.get(code)).toBe(`@opfield_error_${code}`);
      const named = locations(server).map((location) => location.args.map((arg) => arg.value).join(' '));
      expect(named).toEqual(
        expect.arrayContaining(['@opfield_error', `= ${ERROR_PAGE_PATH}`, '@opfield_error_494', '@opfield_error_497'])
      );
    }
    // The answer keeps the status: return 200 in a location error_page reaches without "=code".
    expect(config).toContain('return 200 $opfield_error_page;');
    // A client the server's own rules deny, or who has no password, still gets the page.
    expect(config).toMatch(/location @opfield_error \{\s+allow all;\s+auth_basic off;/);
  });

  it('keeps the 404 handling of Pages and gives its locations the codes they do not name', async () => {
    const config = withOpfieldErrorPages(
      await render({ pagesRouteIncludePath: '/etc/nginx/opfield/pages/routes/route.inc', pagesSpaFallback: true }),
      true
    );
    keep('pages-spa', config);
    // The HTTP server of a forced-HTTPS route only redirects; the Pages server answers its own 404.
    const pagesServers = servers(config).filter((server) =>
      locations(server).some((location) => location.args.at(-1)?.value.startsWith('@opfield_pages_'))
    );
    expect(pagesServers.length).toBeGreaterThan(0);
    for (const server of pagesServers) {
      const own = errorPages(server);
      expect(own.get(404)).not.toBe('@opfield_error');
      for (const location of locations(server)) {
        const pages = errorPages(location);
        if (pages.size === 0) continue;
        // The SPA fallback and the project's 404.html stay; 403 of limit_except and the rest get the page.
        expect(pages.get(404)).not.toBe('@opfield_error');
        expect(pages.get(403)).toBe('@opfield_error');
        expect(pages.get(400)).toBe(ERROR_PAGE_PATH);
      }
    }
    // Hide external branding picks the unbranded pages.
    expect(config).toContain('return 200 $opfield_error_page_unbranded;');
    expect(config).not.toContain('return 200 $opfield_error_page;');
  });

  it('answers a denied client with the 403 page during maintenance, on both guards', async () => {
    const rendered = await render();
    const flag = renderMaintenanceFlagGuard(rendered, {
      hostId: HOST_ID,
      secret: 'route-secret',
      pageText: '"<html>maintenance</html>"',
      accessDirectives: maintenanceAccessListDirectives(accessList),
    })!;
    const reload = templates().applyMaintenanceGuard(
      rendered,
      { hostId: HOST_ID, secret: 'route-secret' },
      false,
      accessList
    );
    const plain = templates().applyMaintenanceGuard(rendered, undefined, false, accessList);
    for (const [name, guarded] of Object.entries({ flag, reload, plain })) {
      const config = withOpfieldErrorPages(guarded);
      keep(`maintenance-${name}`, config);
      for (const server of servers(config)) {
        const page = locations(server).find((location) => location.args.at(-1)?.value === 'opfield-maintenance')!;
        const pages = errorPages(page);
        expect(pages.get(503), name).toBe('@opfield-maintenance-page');
        expect(pages.get(403), name).toBe('@opfield_error');
      }
    }
  });

  it('renders redirect and 404 routes with the pages too', async () => {
    keep('redirect', withOpfieldErrorPages(await render({ type: 'redirect', redirectUrl: 'https://example.org' })));
    const notFound = withOpfieldErrorPages(await render({ type: '404' }));
    keep('not-found', notFound);
    for (const server of servers(notFound)) expect(errorPages(server).get(403)).toBe('@opfield_error');
  });

  it('leaves the codes a server answers itself, and a config that already names the pages, alone', () => {
    const custom =
      'server {\n    listen 80;\n    error_page 404 /custom-404.html;\n    location / { return 404; }\n}\n';
    const config = withOpfieldErrorPages(custom);
    const [server] = servers(config);
    expect(errorPages(server!).get(404)).toBe('/custom-404.html');
    expect(errorPages(server!).get(403)).toBe('@opfield_error');
    expect(withOpfieldErrorPages(config)).toBe(config);
    expect(withOpfieldErrorPages('server { location / { return 200 "unterminated; } }')).toBe(
      'server { location / { return 200 "unterminated; } }'
    );
  });
});
