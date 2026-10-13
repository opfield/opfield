// The schema barrel first: loading the template service alone enters the schema import cycle mid-way.
import '@/db/schema/index.js';
import { describe, expect, it } from 'vitest';
import { ConfigValidatorService } from '@/services/config-validator.service.js';
import type { ProxyHostConfig } from '@/services/nginx-config-generator.service.js';
import { parseNginxConfig } from './nginx-config-tree.js';
import { MAINTENANCE_FLAG_DIR, renderMaintenanceFlagGuard } from './nginx-maintenance-flag-guard.js';
import { NginxTemplateService } from './nginx-template.service.js';

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const HEX = HOST_ID.replace(/-/g, '');
const ACCESS = { hostId: HOST_ID, secret: 'route-secret', pageText: '"<html>maintenance</html>"' };

const host: ProxyHostConfig = {
  id: HOST_ID,
  type: 'proxy',
  domainNames: ['example.com'],
  enabled: true,
  forwardHost: '127.0.0.1',
  forwardPort: 8080,
  forwardScheme: 'http',
  secureLinkUpstream: true,
  secureLinkSocketPath: `/run/opfield-secure-links/${HOST_ID}.sock`,
  sslEnabled: true,
  sslForced: true,
  http2Support: true,
  websocketSupport: false,
  redirectUrl: null,
  redirectStatusCode: 301,
  customHeaders: [{ name: 'X-Route', value: 'blue' }],
  cacheEnabled: false,
  cacheOptions: null,
  rateLimitEnabled: false,
  rateLimitOptions: null,
  customRewrites: [],
  advancedConfig: [
    'add_header Strict-Transport-Security "max-age=63072000" always;',
    'location /api/ {',
    '    proxy_pass http://127.0.0.1:9000;',
    '    proxy_set_header Host $host;',
    '    proxy_set_header Cookie "tenant=a; $http_cookie";',
    '    location /api/v2/ {',
    '        proxy_pass http://127.0.0.1:9001;',
    '    }',
    '}',
    'location = /braces { return 200 "a { b } c; d"; }',
  ].join('\n'),
  templateVariables: {},
  accessList: null,
  sslCertPath: '/etc/nginx/certs/example/current/fullchain.pem',
  sslKeyPath: '/etc/nginx/certs/example/current/privkey.pem',
  sslChainPath: null,
};

async function renderRoute(overrides: Partial<ProxyHostConfig> = {}): Promise<string> {
  const db = { query: { nginxTemplates: { findFirst: async () => undefined } } };
  const service = new NginxTemplateService(db as never, {} as never, new ConfigValidatorService());
  return service.renderForHost({ ...host, ...overrides }, null);
}

/** Removes exactly what the guard adds; what is left must be the route as rendered without it. */
function withoutGuard(guarded: string, original: string): string {
  // The maps come first; the route starts with its first block header (the guard is inserted after a "{").
  const body = guarded.indexOf(original.slice(0, original.indexOf('{') + 1));
  const maps = parseNginxConfig(guarded.slice(0, body));
  expect(maps.every((directive) => directive.name === 'map' && directive.args[1]?.value.startsWith('$gm'))).toBe(true);
  const defaults = new Map(
    maps.map((map) => [map.args[1]!.value, map.block!.children.find((entry) => entry.name === 'default')!.args[0]!.raw])
  );
  return guarded
    .slice(body)
    .replace(
      /\n {4}# Opfield maintenance mode: answers only while[\s\S]*?\{"active":\$opfield_maintenance_access\}';\n {4}\}\n/g,
      ''
    )
    .replace(/\n[\t ]*proxy_set_header Cookie \$opfield_maintenance_cookie;/g, '')
    .replace(new RegExp(`\\$gm_cookie_${HEX}_\\d+`, 'g'), (variable) => defaults.get(variable)!);
}

describe('maintenance guard of a node that keeps maintenance flags', () => {
  it('leaves every directive of the route as rendered and adds only the guard', async () => {
    const original = await renderRoute();
    const guarded = renderMaintenanceFlagGuard(original, ACCESS);

    expect(guarded).not.toBeNull();
    expect(withoutGuard(guarded!, original)).toBe(original);
    // Both server blocks (the HTTPS redirect and the route) check the flag before anything else of the server.
    expect(guarded!.match(new RegExp(`if \\(-f ${MAINTENANCE_FLAG_DIR}/${HOST_ID}\\)`, 'g'))).toHaveLength(2);
    // The scopes that set proxy_set_header themselves send the Cookie through the maintenance-aware variable; the
    // nested /api/v2/ location keeps inheriting them, and the route's own Cookie override stays its value outside
    // maintenance.
    expect(guarded).toContain(`proxy_set_header Cookie $gm_cookie_${HEX}_1;`);
    expect(guarded).toContain(
      `map $opfield_maintenance $gm_cookie_${HEX}_1 {\n    volatile;\n    default "tenant=a; $http_cookie";`
    );
    expect(guarded!.match(/proxy_set_header Cookie \$opfield_maintenance_cookie;/g)).toHaveLength(1);
    // nginx's default variables_hash_bucket_size (64) takes names of up to 46 bytes.
    expect(`gm_cookie_${HEX}_99`.length).toBeLessThanOrEqual(46);
  });

  it('keeps the maintenance page, its headers and the access paths in locations no request URI can name', async () => {
    const guarded = renderMaintenanceFlagGuard(await renderRoute(), ACCESS)!;
    const server = parseNginxConfig(guarded).filter((directive) => directive.name === 'server')[1]!;
    const serverLevel = server.block!.children.map((directive) => directive.name);
    expect(serverLevel).not.toContain('default_type');
    const guardLocations = server
      .block!.children.filter((directive) => directive.name === 'location' && directive.args[0]?.value === '=')
      .map((directive) => directive.args[1]!.value)
      .filter((name) => name.startsWith('opfield-maintenance'));
    expect(guardLocations).toEqual(['opfield-maintenance', 'opfield-maintenance-access', 'opfield-maintenance-status']);
    expect(guardLocations.every((name) => !name.startsWith('/'))).toBe(true);
    // The page carries the server's own response headers, as the guard rendered during maintenance does.
    expect(guarded).toContain(
      'add_header Cache-Control "no-store" always;\n        add_header Strict-Transport-Security "max-age=63072000" always;\n        return 503 "<html>maintenance</html>";'
    );
  });

  it('falls back to the reload-based guard when the route config could not keep its meaning', async () => {
    const cases = {
      'secure_link of its own': 'secure_link $arg_s,$arg_e;\nsecure_link_md5 "$secure_link_expires$uri secret";',
      'a location that proxies with the headers of nginx.conf':
        'location /raw/ {\n    proxy_pass http://127.0.0.1:9002;\n}',
      proxy_pass_request_headers:
        'location /bare/ {\n    proxy_pass_request_headers off;\n    proxy_set_header Host $host;\n    proxy_pass http://127.0.0.1:9003;\n}',
      'two Cookie overrides in one scope':
        'location /two/ {\n    proxy_set_header Cookie a;\n    proxy_set_header cookie b;\n    proxy_pass http://127.0.0.1:9004;\n}',
    };
    for (const [name, advancedConfig] of Object.entries(cases)) {
      expect(renderMaintenanceFlagGuard(await renderRoute({ advancedConfig }), ACCESS), name).toBeNull();
    }
    expect(renderMaintenanceFlagGuard('server { location / { return 200 "unterminated; } }', ACCESS)).toBeNull();
    expect(renderMaintenanceFlagGuard('upstream app { server 127.0.0.1:1; }', ACCESS)).toBeNull();
  });

  it('accepts the Pages route include and a location inheriting the server headers', () => {
    const config = [
      'server {',
      '    listen 80;',
      '    proxy_set_header X-Server-Level yes;',
      '    include /etc/nginx/opfield/conf.d/pages/routes/route-1.inc;',
      '    location / {',
      '        proxy_pass http://127.0.0.1:9000;',
      '    }',
      '}',
      '',
    ].join('\n');
    const guarded = renderMaintenanceFlagGuard(config, ACCESS);
    expect(guarded).toContain(
      '    proxy_set_header X-Server-Level yes;\n    proxy_set_header Cookie $opfield_maintenance_cookie;\n    include'
    );
    expect(withoutGuard(guarded!, config)).toBe(config);
  });
});
