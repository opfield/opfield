// The schema barrel first: loading the template service alone enters the schema import cycle mid-way.
import '@/db/schema/index.js';
import { describe, expect, it, vi } from 'vitest';
import { ConfigValidatorService } from '@/services/config-validator.service.js';
import type { ProxyHostConfig } from '@/services/nginx-config-generator.service.js';
import { NginxTemplateService } from './nginx-template.service.js';
import { testTemplateContent } from './nginx-template-preview.js';
import { LEGACY_INSTALL_DIR_NAME, LEGACY_NGINX_DIR } from '@/lib/legacy-compat.js';

// Grant cleanup on delete is covered against PostgreSQL in resource-scope-cleanup.database.test.ts.
vi.mock('@/lib/resource-scope-cleanup.js', () => ({
  transactionWithScopeCleanup: (db: any, work: (tx: any) => unknown) =>
    db.transaction ? db.transaction(work) : work(db),
}));

const host: ProxyHostConfig = {
  id: '11111111-1111-4111-8111-111111111111',
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
  advancedConfig: '{{directive}} /etc/nginx/conf.d/*.conf;',
  templateVariables: { directive: 'include' },
  accessList: null,
  sslCertPath: null,
  sslKeyPath: null,
  sslChainPath: null,
};

function service() {
  return new NginxTemplateService({} as never, {} as never, new ConfigValidatorService());
}

describe('NginxTemplateService advanced config rendering', () => {
  it('rejects forbidden directives assembled through template variables', () => {
    expect(() => service().renderTemplate('server { {{{advancedConfig}}} }', host)).toThrow(
      'Rendered advanced config is unsafe'
    );
  });

  it('preserves safe advanced config interpolation', () => {
    const rendered = service().renderTemplate('server { {{{advancedConfig}}} }', {
      ...host,
      advancedConfig: 'add_header X-Upstream "{{forwardHost}}";',
    });
    expect(rendered).toContain('add_header X-Upstream "app";');
  });
});

describe('NginxTemplateService custom rewrites', () => {
  const rewriteHost: ProxyHostConfig = {
    ...host,
    advancedConfig: null,
    templateVariables: {},
    customRewrites: [{ source: '^/old-shop/(.*)$', destination: '/$1', type: 'permanent' }],
  };

  it('keeps regex anchors and capture references in the built-in template', async () => {
    const db = { query: { nginxTemplates: { findFirst: async () => undefined } } };
    const rendered = await new NginxTemplateService(
      db as never,
      {} as never,
      new ConfigValidatorService()
    ).renderForHost(rewriteHost, null);

    expect(rendered).toContain('rewrite ^/old-shop/(.*)$ /$1 permanent;');
  });

  it('upgrades custom templates cloned before regex rewrites worked', () => {
    const legacy =
      '{{#each customRewrites}}rewrite {{sanitize this.source}} {{sanitize this.destination}} redirect;{{/each}}';

    expect(service().renderTemplate(legacy, rewriteHost)).toBe('rewrite ^/old-shop/(.*)$ /$1 redirect;');
  });

  it('still removes characters that would end or break out of the directive', () => {
    const rendered = service().renderTemplate(
      '{{#each customRewrites}}rewrite {{sanitizeRewrite this.source}} {{sanitizeRewrite this.destination}};{{/each}}',
      {
        ...rewriteHost,
        customRewrites: [{ source: '^/a$; return 200 "x"; #', destination: '/b{}`\n', type: 'temporary' }],
      }
    );

    expect(rendered).toBe('rewrite ^/a$return200x /b;');
  });
});

const TEMPLATE = '22222222-2222-4222-8222-222222222222';
const ROUTE = '33333333-3333-4333-8333-333333333333';
const OTHER_ROUTE = '44444444-4444-4444-8444-444444444444';

function templateService(options: { content?: string; routes?: Array<{ id: string }> } = {}) {
  const stored = {
    id: TEMPLATE,
    name: 'Custom',
    type: 'proxy',
    isBuiltin: false,
    content: options.content ?? 'server {\n    listen 80;\n}',
    variables: [],
  };
  const writes: unknown[] = [];
  const db = {
    query: {
      nginxTemplates: {
        findFirst: async ({ where }: { where?: unknown }) => (typeof where === 'function' ? undefined : stored),
      },
    },
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        returning: async () => {
          writes.push(row);
          return [{ ...stored, ...row }];
        },
      }),
    }),
    update: () => ({
      set: (row: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            writes.push(row);
            return [{ ...stored, ...row }];
          },
        }),
      }),
    }),
    select: () => ({ from: () => ({ where: async () => options.routes ?? [] }) }),
  };
  const svc = new NginxTemplateService(db as never, { log: vi.fn() } as never, new ConfigValidatorService());
  return { svc, writes };
}

describe('NginxTemplateService template content', () => {
  const manager = ['proxy:templates:manage'];
  const unrestricted = ['proxy:templates:manage', 'proxy:unrestricted'];

  it.each([
    'proxy',
    'redirect',
    '404',
  ])('keeps the built-in %s template savable without proxy:unrestricted', async (type) => {
    const { svc } = templateService();
    const content = await svc.getBuiltinTemplateContent(type);

    expect(svc.templateContentErrors(content, manager)).toEqual([]);
  });

  it.each([
    ['include', 'server {\n    include /etc/nginx/nginx.conf;\n}', 'Forbidden directive "include"'],
    [
      'load_module',
      'load_module /usr/lib/nginx/modules/evil.so;\nserver { listen 80; }',
      'Forbidden directive "load_module"',
    ],
    ['lua_', 'server {\n    location / { access_by_lua_file /tmp/a.lua; }\n}', 'Forbidden directive "lua_"'],
    [
      'access_log',
      `log_format cron '* * * * * root $arg_c';\nserver {\n    access_log /etc/cron.d/${LEGACY_INSTALL_DIR_NAME} cron;\n}`,
      'Directive "access_log" may only write to /var/log/nginx/',
    ],
  ])('refuses %s without proxy:unrestricted and accepts it with it', async (_directive, content, error) => {
    const { svc, writes } = templateService();
    const input = { name: 'T', type: 'proxy' as const, content, variables: [] };

    await expect(svc.createTemplate(input, 'user-1', manager)).rejects.toMatchObject({
      code: 'INVALID_TEMPLATE_CONTENT',
      message: expect.stringContaining(error),
    });
    await expect(svc.updateTemplate(TEMPLATE, { content }, 'user-1', manager)).rejects.toMatchObject({
      code: 'INVALID_TEMPLATE_CONTENT',
    });
    expect(writes).toEqual([]);

    await svc.createTemplate(input, 'user-1', unrestricted);
    await svc.updateTemplate(TEMPLATE, { content }, 'user-1', unrestricted);
    expect(writes).toHaveLength(2);
  });

  it('refuses a folder-scoped manager changing a template that routes outside their access use', async () => {
    const content = 'server {\n    listen 8080;\n}';
    const folderManager = [`proxy:templates:manage:${TEMPLATE}`, `proxy:edit:${OTHER_ROUTE}`];
    const { svc, writes } = templateService({ routes: [{ id: ROUTE }, { id: OTHER_ROUTE }] });

    await expect(svc.updateTemplate(TEMPLATE, { content }, 'user-1', folderManager)).rejects.toMatchObject({
      statusCode: 403,
      code: 'TEMPLATE_ROUTES_FORBIDDEN',
    });
    // Renaming does not change any route.
    await svc.updateTemplate(TEMPLATE, { name: 'Renamed' }, 'user-1', folderManager);
    await svc.updateTemplate(TEMPLATE, { content }, 'user-1', [...folderManager, `proxy:edit:${ROUTE}`]);
    await svc.updateTemplate(TEMPLATE, { content }, 'user-1', manager);
    expect(writes).toHaveLength(3);
  });

  it('refuses a directive the template assembles with Handlebars when rendering a route', async () => {
    const { svc } = templateService({
      content: 'server {\n    {{sanitize "include"}} /etc/passwd;\n    listen 80;\n}',
    });

    expect(svc.templateContentErrors((await svc.getTemplate(TEMPLATE)).content, manager)).toEqual([]);
    await expect(svc.renderForHost({ ...host, advancedConfig: null }, TEMPLATE)).rejects.toMatchObject({
      code: 'INVALID_TEMPLATE_RENDER',
    });
  });

  it('renders the Pages include and access list password file of a custom template', async () => {
    const { svc } = templateService({
      content: [
        'server {',
        '    listen 80;',
        '    include {{pagesRouteIncludePath}};',
        '    location / {',
        `        auth_basic_user_file ${LEGACY_NGINX_DIR}/htpasswd/access-list-{{accessList.id}};`,
        '    }',
        '}',
      ].join('\n'),
    });
    const rendered = await svc.renderForHost(
      {
        ...host,
        advancedConfig: null,
        pagesRouteIncludePath: `${LEGACY_NGINX_DIR}/pages/routes/a.conf`,
        accessList: { id: TEMPLATE, ipRules: [], basicAuthEnabled: true },
      },
      TEMPLATE
    );

    expect(rendered).toContain(`include ${LEGACY_NGINX_DIR}/pages/routes/a.conf;`);
  });

  it('never sends test content with forbidden directives to a node', async () => {
    const { svc } = templateService();
    const nodeDispatch = { getFirstNginxNodeId: vi.fn(), applyConfig: vi.fn() };

    for (const content of ['server { include /etc/shadow; }', 'server { {{sanitize "include"}} /etc/shadow; }']) {
      const result = await testTemplateContent(svc, nodeDispatch as never, content, manager);
      expect(result.valid).toBe(false);
      expect(result.errors.join('\n')).toContain('Forbidden directive "include"');
    }
    expect(nodeDispatch.getFirstNginxNodeId).not.toHaveBeenCalled();
  });
});

describe('NginxTemplateService escaping of route values', () => {
  it('keeps a header value ending in a backslash from escaping the closing quote', async () => {
    const db = { query: { nginxTemplates: { findFirst: async () => undefined } } };
    const rendered = await new NginxTemplateService(
      db as never,
      {} as never,
      new ConfigValidatorService()
    ).renderForHost(
      {
        ...host,
        advancedConfig: null,
        templateVariables: {},
        customHeaders: [
          { name: 'X-Trailing', value: 'abc\\' },
          { name: 'X Split\tName', value: 'a\tb c' },
        ],
        customRewrites: [{ source: '^/old path\\', destination: '/new\\', type: 'permanent' }],
      },
      null
    );

    expect(rendered).toContain('proxy_set_header X-Trailing "abc";');
    expect(rendered).toContain('proxy_set_header XSplitName "ab c";');
    expect(rendered).toContain('rewrite ^/oldpath /new permanent;');
    expect(new ConfigValidatorService().validate(rendered, true, true)).toEqual({ valid: true, errors: [] });
  });
});

describe('NginxTemplateService Pages missing-path answer', () => {
  const routeId = '22222222-2222-4222-8222-222222222222';
  const routeSuffix = routeId.replace(/-/g, '_');
  const pagesHost: ProxyHostConfig = {
    ...host,
    advancedConfig: null,
    templateVariables: {},
    pagesRouteIncludePath: `${LEGACY_NGINX_DIR}/pages/routes/a.inc`,
    additionalRoutes: [
      {
        id: routeId,
        path: '/docs',
        targetKind: 'pages',
        forwardScheme: 'http',
        forwardHost: null,
        forwardPort: null,
        pagesRouteIncludePath: `${LEGACY_NGINX_DIR}/pages/routes/b.inc`,
        pagesRuntimeConfigPath: '/var/lib/pages/b.js',
        stripPrefix: true,
        websocketSupport: false,
        requestBuffering: true,
        responseBuffering: true,
        connectTimeoutSeconds: 60,
        readTimeoutSeconds: 60,
        sendTimeoutSeconds: 60,
      },
    ],
  };
  const render = (value: ProxyHostConfig) => {
    const db = { query: { nginxTemplates: { findFirst: async () => undefined } } };
    return new NginxTemplateService(db as never, {} as never, new ConfigValidatorService()).renderForHost(value, null);
  };

  it("serves the deployment's 404.html with the original status before the generic page", async () => {
    const rendered = await render(pagesHost);

    // No "=": a "=" override would turn the project page into a 200.
    expect(rendered).toContain(`error_page 404 @opfield_pages_404_${host.id};`);
    expect(rendered).toContain(
      `location @opfield_pages_404_${host.id} {\n        try_files /404.html @opfield_pages_not_found_${host.id};`
    );
    expect(rendered).toContain(`location @opfield_pages_not_found_${host.id} {`);
    expect(rendered).toContain(`error_page 404 @opfield_pages_404_${routeSuffix};`);
    expect(rendered).toContain(`try_files /404.html @opfield_pages_not_found_${routeSuffix};`);
    expect(rendered).not.toMatch(/error_page 404 = @opfield_pages_not_found/);
  });

  it('keeps the fallback URL redirect and the SPA fallback ahead of the 404.html', async () => {
    const withUrl = await render({ ...pagesHost, pagesFallbackUrl: 'https://errors.example.com/x' });
    expect(withUrl).toContain('error_page 404 =302 https://errors.example.com/x;');
    expect(withUrl).not.toContain(`location @opfield_pages_404_${host.id}`);

    const spa = await render({
      ...pagesHost,
      pagesSpaFallback: true,
      additionalRoutes: [{ ...pagesHost.additionalRoutes![0]!, pagesSpaFallback: true }],
    });
    expect(spa).toContain('try_files $uri $uri/ /index.html;');
    expect(spa).toContain(`error_page 404 = @opfield_pages_spa_${routeSuffix};`);
    // The SPA fallback covers app paths only: a missing path with a file extension stays a 404, as on a preview.
    expect(spa).toContain('location ~ \\.[^/]+$ {\n            limit_except GET HEAD { deny all; }');
    expect(spa).toContain('            try_files $uri =404;\n        }');
    expect(spa).toContain('if ($uri ~ "\\.[^/]+$") { return 404; }');
    expect(spa).toContain(`error_page 404 = @opfield_pages_spa_${routeSuffix};\n        recursive_error_pages on;`);
    expect(spa).toContain(`error_page 404 @opfield_pages_404_${routeSuffix};`);
  });

  it('serves app paths of an SPA through index.html and leaves a missing file path a 404', async () => {
    const plain = await render(pagesHost);
    expect(plain).not.toContain('location ~ \\.[^/]+$ {');
  });
});
