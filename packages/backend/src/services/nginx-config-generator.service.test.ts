import { describe, expect, it } from 'vitest';
import { NginxConfigGenerator, type ProxyHostConfig } from './nginx-config-generator.service.js';

const proxyHost: ProxyHostConfig = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'proxy',
  domainNames: ['origin.example.test'],
  enabled: true,
  forwardHost: '127.0.0.1',
  forwardPort: 8080,
  forwardScheme: 'http',
  sslEnabled: true,
  sslForced: false,
  http2Support: true,
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
  accessList: { id: 'basic-only', ipRules: [], basicAuthEnabled: true },
  sslCertPath: '/etc/nginx/certs/origin/fullchain.pem',
  sslKeyPath: '/etc/nginx/certs/origin/privkey.pem',
  sslChainPath: '/etc/nginx/certs/origin/chain.pem',
};

describe('NginxConfigGenerator proxy TLS and ACL rendering', () => {
  it('renders websocket support without requiring an http-scope connection_upgrade map', () => {
    const rendered = new NginxConfigGenerator({} as never).generateConfig({
      ...proxyHost,
      websocketSupport: true,
    });

    expect(rendered).toContain('proxy_set_header Upgrade $http_upgrade;');
    expect(rendered).toContain('proxy_set_header Connection "upgrade";');
    expect(rendered).not.toContain('$connection_upgrade');
  });

  it('uses a two-hour inactivity timeout for Secure Link and WebSocket upstreams', () => {
    const secure = new NginxConfigGenerator({} as never).generateConfig({
      ...proxyHost,
      websocketSupport: true,
      secureLinkUpstream: true,
    });
    const websocket = new NginxConfigGenerator({} as never).generateConfig({
      ...proxyHost,
      websocketSupport: true,
    });
    const regular = new NginxConfigGenerator({} as never).generateConfig(proxyHost);

    expect(secure).toContain('proxy_send_timeout 2h;');
    expect(secure).toContain('proxy_read_timeout 2h;');
    expect(secure).toContain('# opfield-managed-secure-link-upstream');
    expect(websocket).toContain('proxy_send_timeout 2h;');
    expect(websocket).toContain('proxy_read_timeout 2h;');
    expect(websocket).not.toContain('# opfield-managed-secure-link-upstream');
    expect(regular).toContain('proxy_send_timeout 60s;');
    expect(regular).toContain('proxy_read_timeout 60s;');
    expect(regular).not.toContain('# opfield-managed-secure-link-upstream');
  });

  it('applies inherited per-IP request and concurrent connection limits', () => {
    const rendered = new NginxConfigGenerator({} as never).generateConfig(proxyHost);

    expect(rendered).toContain('rate=1000r/s;');
    expect(rendered).toContain('burst=3000 nodelay;');
    expect(rendered).toContain('limit_conn_zone $binary_remote_addr zone=connlimit_');
    expect(rendered).toContain('limit_conn connlimit_11111111-1111-4111-8111-111111111111 1000;');
    expect(rendered).toContain('limit_conn_status 429;');
  });

  it('allows custom per-IP limits or disables both request and connection limiting', () => {
    const custom = new NginxConfigGenerator({} as never).generateConfig({
      ...proxyHost,
      rateLimitMode: 'custom',
      rateLimitOptions: { requestsPerSecond: 10, burst: 20, connectionsPerIp: 30 },
    });
    const disabled = new NginxConfigGenerator({} as never).generateConfig({
      ...proxyHost,
      rateLimitMode: 'disabled',
    });

    expect(custom).toContain('rate=10r/s;');
    expect(custom).toContain('burst=20 nodelay;');
    expect(custom).toContain('limit_conn connlimit_11111111-1111-4111-8111-111111111111 30;');
    expect(disabled).not.toContain('limit_req_zone');
    expect(disabled).not.toContain('limit_conn_zone');
  });

  it('uses shared TLS policy and scopes a basic-auth-only ACL to the upstream', () => {
    const rendered = new NginxConfigGenerator({} as never).generateConfig(proxyHost);

    expect(rendered).toContain('listen 443 ssl;');
    expect(rendered).toContain('http2 on;');
    expect(rendered).toContain('ssl_certificate /etc/nginx/certs/origin/fullchain.pem;');
    expect(rendered).toContain('ssl_certificate_key /etc/nginx/certs/origin/privkey.pem;');
    expect(rendered).not.toContain('ssl_protocols');
    expect(rendered).not.toContain('ssl_ciphers');
    expect(rendered).toContain('ssl_trusted_certificate /etc/nginx/certs/origin/chain.pem;');
    expect(rendered).not.toContain('deny all;');
    expect(rendered).toMatch(
      /location \/ \{[\s\S]*auth_basic "Restricted Access";[\s\S]*auth_basic_user_file \/etc\/nginx\/opfield\/htpasswd\/access-list-basic-only;[\s\S]*proxy_pass/
    );
  });

  it('adds the host ACL to advanced locations without applying it to ACME challenges', () => {
    const rendered = new NginxConfigGenerator({} as never).generateConfig({
      ...proxyHost,
      advancedConfig: `location /api/ {
    proxy_pass http://127.0.0.1:9000;
}`,
      accessList: { id: 'ip-only', ipRules: [{ type: 'allow', value: '192.0.2.0/24' }], basicAuthEnabled: true },
    });
    const upstreamLocation = rendered.lastIndexOf('location / {');
    const advancedLocation = rendered.indexOf('location /api/ {');
    const acmeLocation = rendered.indexOf('location /.well-known/acme-challenge/ {');
    const denyAll = rendered.indexOf('deny all;');
    const rootEnd = rendered.indexOf('\n    }', upstreamLocation);
    const advancedEnd = rendered.indexOf('\n    }', advancedLocation);
    const acmeEnd = rendered.indexOf('\n    }', acmeLocation);
    const rootConfig = rendered.slice(upstreamLocation, rootEnd);
    const advancedConfig = rendered.slice(advancedLocation, advancedEnd);
    const acmeConfig = rendered.slice(acmeLocation, acmeEnd);

    expect(denyAll).toBeGreaterThan(upstreamLocation);
    expect(upstreamLocation).toBeLessThan(advancedLocation);
    expect(rendered.slice(0, upstreamLocation)).not.toContain('deny all;');
    for (const config of [rootConfig, advancedConfig]) {
      expect(config).toContain('allow 192.0.2.0/24;');
      expect(config).toContain('deny all;');
      expect(config).toContain('auth_basic "Restricted Access";');
    }
    expect(acmeConfig).toContain('auth_basic off;');
    expect(acmeConfig).not.toContain('deny all;');
  });

  it.each(['redirect', '404'] as const)('uses the same shared TLS policy for %s hosts', (type) => {
    const rendered = new NginxConfigGenerator({} as never).generateConfig({ ...proxyHost, type });

    expect(rendered).toContain('ssl_certificate /etc/nginx/certs/origin/fullchain.pem;');
    expect(rendered).toContain('ssl_certificate_key /etc/nginx/certs/origin/privkey.pem;');
    expect(rendered).toContain('ssl_trusted_certificate /etc/nginx/certs/origin/chain.pem;');
    expect(rendered).not.toContain('ssl_protocols');
    expect(rendered).not.toContain('ssl_ciphers');
    expect(rendered).not.toContain('ssl_session_');
  });
});
