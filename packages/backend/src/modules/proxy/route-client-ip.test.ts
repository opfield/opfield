// The schema barrel first: loading the template service alone enters the schema import cycle mid-way.
import '@/db/schema/index.js';
import { describe, expect, it } from 'vitest';
import { BAKED_CLOUDFLARE_IPV4_CIDRS, validateCloudflareCidrs } from '@/lib/cloudflare-ip-ranges.js';
import { ConfigValidatorService } from '@/services/config-validator.service.js';
import type { ProxyHostConfig } from '@/services/nginx-config-generator.service.js';
import { NginxTemplateService } from './nginx-template.service.js';
import {
  clientIpDirectives,
  clientIpSettingsErrors,
  clientIpUpdateFields,
  markCopiedClientIpBlocks,
  withClientIpDirectives,
  withRawClientIpMarker,
} from './route-client-ip.js';

const CLOUDFLARE = ['173.245.48.0/20', '2400:cb00::/32'];

const host: ProxyHostConfig = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'proxy',
  domainNames: ['app.example.com'],
  enabled: true,
  forwardHost: '10.0.0.5',
  forwardPort: 8080,
  forwardScheme: 'http',
  sslEnabled: true,
  sslForced: true,
  http2Support: true,
  websocketSupport: true,
  redirectUrl: null,
  redirectStatusCode: 301,
  customHeaders: [],
  cacheEnabled: false,
  cacheOptions: null,
  rateLimitEnabled: false,
  rateLimitOptions: null,
  customRewrites: [],
  advancedConfig: null,
  accessList: {
    id: '22222222-2222-4222-8222-222222222222',
    authRequest: false,
    signInMethods: [],
    hasUsers: false,
    skipIpRanges: ['203.0.113.7'],
    includeRules: [],
    requireRules: [],
    excludeRules: [],
  },
  sslCertPath: '/etc/nginx/certs/c/current/fullchain.pem',
  sslKeyPath: '/etc/nginx/certs/c/current/privkey.pem',
  sslChainPath: null,
};

async function renderBuiltin(overrides: Partial<ProxyHostConfig> = {}): Promise<string> {
  const db = { query: { nginxTemplates: { findFirst: async () => undefined } } };
  const service = new NginxTemplateService(db as never, {} as never, new ConfigValidatorService());
  return service.renderForHost({ ...host, ...overrides }, null);
}

function serverBlocks(config: string): string[] {
  return config.split(/^server \{/m).slice(1);
}

describe('route client IP directives', () => {
  it('trusts CF-Connecting-IP from the Cloudflare ranges only', () => {
    expect(clientIpDirectives('cloudflare', null, CLOUDFLARE)).toEqual([
      'set_real_ip_from 173.245.48.0/20;',
      'set_real_ip_from 2400:cb00::/32;',
      'real_ip_header CF-Connecting-IP;',
      'real_ip_recursive on;',
    ]);
  });

  it('trusts the listed proxies with the chosen header', () => {
    expect(
      clientIpDirectives(
        'reverse_proxy',
        { trustedProxyCidrs: ['10.0.0.0/8', '192.0.2.10'], header: 'x_real_ip' },
        CLOUDFLARE
      )
    ).toEqual([
      'set_real_ip_from 10.0.0.0/8;',
      'set_real_ip_from 192.0.2.10;',
      'real_ip_header X-Real-IP;',
      'real_ip_recursive on;',
    ]);
    expect(
      clientIpDirectives('reverse_proxy', { trustedProxyCidrs: ['10.0.0.1'], header: 'x_forwarded_for' }, [])
    ).toContain('real_ip_header X-Forwarded-For;');
  });

  it('renders nothing for a direct route or without a trusted peer', () => {
    expect(clientIpDirectives('direct', null, CLOUDFLARE)).toEqual([]);
    expect(
      clientIpDirectives('reverse_proxy', { trustedProxyCidrs: ['10.0.0.1;evil'], header: 'x_real_ip' }, [])
    ).toEqual([]);
  });

  it('puts the directives into every server block of the default proxy template', async () => {
    const rendered = await renderBuiltin();
    const result = withClientIpDirectives(rendered, clientIpDirectives('cloudflare', null, CLOUDFLARE));
    const blocks = serverBlocks(result);
    // The HTTPS redirect server and the main server.
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block).toContain('set_real_ip_from 173.245.48.0/20;');
      expect(block).toContain('real_ip_header CF-Connecting-IP;');
      expect(block.indexOf('real_ip_header')).toBeLessThan(block.indexOf('location '));
    }
    // The access list, the rate limit key and the upstream headers then all use the client address.
    expect(result).toContain('allow 203.0.113.7;');
    expect(result).toContain('limit_req_zone $binary_remote_addr');
    expect(result).toContain('proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;');
    expect(result.match(/real_ip_header/g)).toHaveLength(2);
  });

  it('leaves a server block that sets real_ip_header itself to its own setting', async () => {
    const rendered = await renderBuiltin({
      advancedConfig: 'set_real_ip_from 198.51.100.0/24;\nreal_ip_header X-Forwarded-For;',
    });
    const result = withClientIpDirectives(rendered, clientIpDirectives('cloudflare', null, CLOUDFLARE));
    const [redirect, main] = serverBlocks(result);
    expect(redirect).toContain('real_ip_header CF-Connecting-IP;');
    expect(main).not.toContain('CF-Connecting-IP');
    expect(main?.match(/real_ip_header/g)).toHaveLength(1);
  });

  it('still covers a server whose own real_ip_header is only inside a location', () => {
    const config = 'server {\n    listen 80;\n    location /x {\n        real_ip_header X-Real-IP;\n    }\n}\n';
    const result = withClientIpDirectives(config, clientIpDirectives('cloudflare', null, CLOUDFLARE));
    expect(result.match(/real_ip_header/g)).toHaveLength(2);
    expect(result.indexOf('CF-Connecting-IP')).toBeLessThan(result.indexOf('location /x'));
  });

  it('leaves the config alone for a direct route', async () => {
    const rendered = await renderBuiltin();
    expect(withClientIpDirectives(rendered, [])).toBe(rendered);
  });

  it('fills the raw config marker with the directives at its indentation', () => {
    const raw = 'server {\n    listen 80;\n    # opfield:client-ip\n    location / { return 204; }\n}\n';
    const result = withRawClientIpMarker(raw, clientIpDirectives('cloudflare', null, CLOUDFLARE));
    expect(result).toContain(
      '    set_real_ip_from 173.245.48.0/20;\n    set_real_ip_from 2400:cb00::/32;\n    real_ip_header CF-Connecting-IP;'
    );
    expect(result).not.toContain('opfield:client-ip');
    expect(withRawClientIpMarker(raw, [])).toBe(raw);
    expect(withRawClientIpMarker('server { listen 80; }', ['real_ip_header X;'])).toBe('server { listen 80; }');
  });
});

describe('raw configs seeded from the rendered config', () => {
  it('store the marker instead of an unchanged copy of the directives', async () => {
    const directives = clientIpDirectives('cloudflare', null, CLOUDFLARE);
    const rendered = withClientIpDirectives(await renderBuiltin(), directives);
    const stored = markCopiedClientIpBlocks(rendered, directives);
    expect(stored).not.toContain('set_real_ip_from');
    expect(stored.match(/^ {4}# opfield:client-ip$/gm)).toHaveLength(2);
    // Rendered again, the raw config has the directives of the moment.
    const next = clientIpDirectives('cloudflare', null, [...CLOUDFLARE, '198.51.100.0/24']);
    expect(withRawClientIpMarker(stored, next).match(/set_real_ip_from 198\.51\.100\.0\/24;/g)).toHaveLength(2);
  });

  it('keep a block that was edited', async () => {
    const directives = clientIpDirectives('cloudflare', null, CLOUDFLARE);
    const edited = withClientIpDirectives(await renderBuiltin(), directives).replace(
      'real_ip_header CF-Connecting-IP;',
      'real_ip_header X-Real-IP;'
    );
    const stored = markCopiedClientIpBlocks(edited, directives);
    expect(stored).toContain('real_ip_header X-Real-IP;');
    expect(stored.match(/# opfield:client-ip/g)).toHaveLength(1);
  });
});

describe('route client IP settings', () => {
  it('needs a valid proxy for trusted proxies', () => {
    expect(clientIpSettingsErrors('reverse_proxy', { trustedProxyCidrs: [] })).toEqual([
      'Trusted proxies need at least one proxy address or CIDR',
    ]);
    expect(clientIpSettingsErrors('reverse_proxy', { trustedProxyCidrs: ['10.0.0.0/33', 'proxy.local'] })).toHaveLength(
      2
    );
    expect(clientIpSettingsErrors('reverse_proxy', { trustedProxyCidrs: ['10.0.0.0/8', '2001:db8::1'] })).toEqual([]);
    expect(clientIpSettingsErrors('cloudflare', null)).toEqual([]);
  });

  it('checks an update against the stored value it leaves out', () => {
    expect(() =>
      clientIpUpdateFields({ clientIpSource: 'reverse_proxy' }, { clientIpSource: 'auto', clientIpOptions: null })
    ).toThrow('Trusted proxies need at least one');
    expect(
      clientIpUpdateFields(
        { clientIpSource: 'reverse_proxy' },
        { clientIpSource: 'auto', clientIpOptions: { trustedProxyCidrs: ['10.0.0.1'], header: 'x_real_ip' } }
      )
    ).toEqual({ clientIpSource: 'reverse_proxy' });
    expect(
      clientIpUpdateFields(
        { clientIpOptions: { trustedProxyCidrs: [' 10.0.0.1 ', '10.0.0.1'], header: 'x_forwarded_for' } },
        { clientIpSource: 'reverse_proxy', clientIpOptions: null }
      )
    ).toEqual({ clientIpOptions: { trustedProxyCidrs: ['10.0.0.1'], header: 'x_forwarded_for' } });
    expect(clientIpUpdateFields({}, { clientIpSource: 'auto' })).toEqual({});
  });
});

describe('Cloudflare range validation', () => {
  it('accepts the built-in list and rejects lists that would trust too much', () => {
    expect(validateCloudflareCidrs([...BAKED_CLOUDFLARE_IPV4_CIDRS], 4).ok).toBe(true);
    expect(validateCloudflareCidrs([...BAKED_CLOUDFLARE_IPV4_CIDRS, '0.0.0.0/0'], 4).ok).toBe(false);
    expect(validateCloudflareCidrs(['<html>'], 4).ok).toBe(false);
    expect(validateCloudflareCidrs([...BAKED_CLOUDFLARE_IPV4_CIDRS, '2400:cb00::/32'], 4).ok).toBe(false);
    expect(validateCloudflareCidrs('173.245.48.0/20', 4).ok).toBe(false);
  });
});
