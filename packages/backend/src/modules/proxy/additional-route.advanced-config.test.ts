// The schema barrel first: loading the proxy services alone enters the schema import cycle mid-way.
import '@/db/schema/index.js';
import { describe, expect, it, vi } from 'vitest';
import { ConfigValidatorService } from '@/services/config-validator.service.js';
import type { ProxyHostConfig } from '@/services/nginx-config-generator.service.js';
import { AdditionalRouteService } from './additional-route.service.js';
import { additionalRouteAdvancedConfigErrors } from './additional-route.validation.js';
import { NginxTemplateService } from './nginx-template.service.js';
import { LEGACY_INSTALL_DIR_NAME } from '@/lib/legacy-compat.js';

const HOST = '11111111-1111-4111-8111-111111111111';

describe('Additional Route advanced config', () => {
  it.each([
    ['include', 'include /etc/nginx/nginx.conf;'],
    ['access_log', `access_log /etc/cron.d/${LEGACY_INSTALL_DIR_NAME};`],
    ['load_module', 'load_module /tmp/evil.so;'],
    ['lua_', 'access_by_lua_file /tmp/a.lua;'],
    ['allow', 'allow all;'],
  ])('refuses %s without proxy:unrestricted on the Route and accepts it with it', (directive, config) => {
    expect(additionalRouteAdvancedConfigErrors(config, false)).toContain(
      `Forbidden directive "${directive}" found on line 1`
    );
    expect(additionalRouteAdvancedConfigErrors(config, true)).toEqual([]);
  });

  it('allows location directives such as proxy_pass', () => {
    expect(
      additionalRouteAdvancedConfigErrors('proxy_set_header X-Env "prod";\nproxy_pass http://app:8080;', false)
    ).toEqual([]);
  });

  it('requires complete directives even with proxy:unrestricted', () => {
    expect(additionalRouteAdvancedConfigErrors('add_header X-A "open', true)).toEqual([
      'Unexpected end of config, expecting ";" or "}" on line 1',
    ]);
  });

  it('checks the config before the Additional Route is stored', async () => {
    class TestService extends AdditionalRouteService {
      protected override async withHostLock<T>(_hostId: string, work: () => Promise<T>): Promise<T> {
        return work();
      }
    }
    const insert = vi.fn(() => {
      throw new Error('stored');
    });
    const db = {
      query: {
        proxyHosts: {
          findFirst: async () => ({ id: HOST, type: 'proxy', rawConfigEnabled: false, nginxTemplateId: null }),
        },
      },
      insert,
    };
    const service = new TestService(db as never, { log: vi.fn() } as never);
    const input = {
      path: '/api',
      targetKind: 'manual',
      forwardHost: 'app',
      forwardPort: 8080,
      advancedConfig: 'include /etc/nginx/nginx.conf;',
    };

    await expect(service.create(HOST, input, 'user-1', [`proxy:advanced:${HOST}`])).rejects.toMatchObject({
      code: 'INVALID_ADVANCED_CONFIG',
    });
    expect(insert).not.toHaveBeenCalled();
    await expect(service.create(HOST, input, 'user-1', [`proxy:unrestricted:${HOST}`])).rejects.toThrow('stored');
  });

  it('refuses to render stored config that would run into the directives after it', async () => {
    const db = { query: { nginxTemplates: { findFirst: async () => undefined } } };
    const host: ProxyHostConfig = {
      id: HOST,
      type: 'proxy',
      domainNames: ['example.com'],
      enabled: true,
      forwardHost: '10.0.0.2',
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
      accessList: null,
      sslCertPath: null,
      sslKeyPath: null,
      sslChainPath: null,
      additionalRoutes: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          path: '/api',
          targetKind: 'manual',
          forwardScheme: 'http',
          forwardHost: '10.0.0.3',
          forwardPort: 8080,
          advancedConfig: 'add_header X-A "open',
          stripPrefix: false,
          websocketSupport: false,
          requestBuffering: true,
          responseBuffering: true,
          connectTimeoutSeconds: 60,
          readTimeoutSeconds: 60,
          sendTimeoutSeconds: 60,
        },
      ],
    };
    const service = new NginxTemplateService(db as never, {} as never, new ConfigValidatorService());

    await expect(service.renderForHost(host, null)).rejects.toMatchObject({ code: 'INVALID_ADDITIONAL_ROUTE_CONFIG' });
  });
});
