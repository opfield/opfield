// The schema barrel first: loading the template service alone enters the schema import cycle mid-way.
import '@/db/schema/index.js';
import { describe, expect, it } from 'vitest';
import { ConfigValidatorService } from '@/services/config-validator.service.js';
import type { ProxyHostConfig } from '@/services/nginx-config-generator.service.js';
import { legacyAccessRules } from '../access-lists/access-list-legacy.js';
import { fallbackAccess, type NginxAccessList } from './nginx-access-list.js';
import { type NginxConfigDirective, parseNginxConfig } from './nginx-config-tree.js';
import { NginxTemplateService } from './nginx-template.service.js';

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const LIST_ID = '22222222-2222-4222-8222-222222222222';
const TEMPLATE_ID = '33333333-3333-4333-8333-333333333333';

const signIn: NginxAccessList = {
  id: LIST_ID,
  authRequest: true,
  signInPage: true,
  signInMethods: ['opfield'],
  hasUsers: false,
  skipIpRanges: ['10.0.40.0/24'],
  includeRules: [{ selector: 'email_domain', values: ['acme.dev'] }],
  requireRules: [],
  excludeRules: [{ selector: 'ip', values: ['198.51.100.0/24'] }],
};

const basicOnly: NginxAccessList = {
  ...signIn,
  signInMethods: ['basic'],
  hasUsers: true,
  skipIpRanges: [],
  includeRules: [{ selector: 'everyone', values: [] }],
  excludeRules: [],
};

const host: ProxyHostConfig = {
  id: HOST_ID,
  type: 'proxy',
  domainNames: ['app.example.com'],
  enabled: true,
  forwardHost: '127.0.0.1',
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
  accessList: signIn,
  sslCertPath: null,
  sslKeyPath: null,
  sslChainPath: null,
};

// The access list block every custom template copied from a built-in one before sign-in based lists has.
const LEGACY_CUSTOM_TEMPLATE = `server {
    listen 80;
    server_name {{serverNames}};

    location / {
{{#if accessList}}
{{#each accessList.ipRules}}
        {{sanitize this.type}} {{sanitize this.value}};
{{/each}}
{{#if accessListHasIpRules}}
        deny all;
{{/if}}
{{#if accessList.basicAuthEnabled}}
        auth_basic "Restricted Access";
        auth_basic_user_file /etc/nginx/opfield/htpasswd/access-list-{{accessList.id}};
{{/if}}

{{/if}}
        proxy_pass {{upstream}};
        proxy_set_header Host $host;
    }
}
`;

function render(overrides: Partial<ProxyHostConfig>, customContent?: string): Promise<string> {
  const stored = { id: TEMPLATE_ID, type: 'proxy', isBuiltin: false, content: customContent ?? '', variables: [] };
  const db = {
    query: {
      nginxTemplates: {
        findFirst: async ({ where }: { where?: unknown }) => (typeof where === 'function' ? undefined : stored),
      },
    },
  };
  const service = new NginxTemplateService(db as never, {} as never, new ConfigValidatorService());
  return service.renderForHost({ ...host, ...overrides }, customContent ? TEMPLATE_ID : null);
}

function locations(config: string): Map<string, NginxConfigDirective> {
  const found = new Map<string, NginxConfigDirective>();
  const visit = (directives: NginxConfigDirective[]) => {
    for (const directive of directives) {
      if (directive.name === 'location') found.set(directive.args.map((arg) => arg.value).join(' '), directive);
      if (directive.block) visit(directive.block.children);
    }
  };
  visit(parseNginxConfig(config));
  return found;
}

function lines(location: NginxConfigDirective | undefined): string[] {
  return (location?.block?.children ?? []).map(
    (child) => `${child.name} ${child.args.map((arg) => arg.raw).join(' ')}`
  );
}

describe('access list rendering on a node with the access socket', () => {
  it('asks the socket in the route and answers the challenge and callback from the server', async () => {
    const config = await render({});
    const byPath = locations(config);

    expect(lines(byPath.get('/'))).toEqual(
      expect.arrayContaining([
        'auth_request /_opfield/access/check',
        'error_page 401 = @opfield_access_challenge',
        'proxy_set_header Opfield-Access-User $opfield_access_user',
        'proxy_set_header Host $host',
      ])
    );
    expect(lines(byPath.get('= /_opfield/access/check'))).toContain(
      `proxy_set_header X-Opfield-Access-List "${LIST_ID}"`
    );
    // The callback's query string carries the host token: it is not logged.
    expect(lines(byPath.get('= /_opfield/access/callback'))).toEqual(
      expect.arrayContaining(['auth_request off', 'access_log off'])
    );
    // Service token credentials never reach the upstream.
    expect(lines(byPath.get('/'))).toEqual(
      expect.arrayContaining([
        'proxy_set_header Opfield-Access-Client-Id ""',
        'proxy_set_header Opfield-Access-Client-Secret ""',
      ])
    );
    expect(lines(byPath.get('@opfield_access_challenge'))).toContain('rewrite ^ /challenge break');
    expect(lines(byPath.get('/.well-known/acme-challenge/'))).toContain('auth_request off');
    expect(config).not.toMatch(/\b(allow|deny) (10\.0\.40|198\.51)/);
    expect(config).not.toContain('auth_basic "');
  });

  it('serves the route sign-in page from the daemon, and answers 403 where the daemon has none', async () => {
    const byPath = locations(await render({}));
    expect(lines(byPath.get('^~ /_opfield/access/'))).toEqual(
      expect.arrayContaining([
        'access_log off',
        'auth_request off',
        'proxy_pass http://unix:/run/nginx-daemon/access.sock:/ui/',
        `proxy_set_header X-Opfield-Access-List "${LIST_ID}"`,
        'proxy_set_header X-Opfield-Access-Host $host',
        'proxy_set_header X-Opfield-Access-Client-IP $remote_addr',
        'proxy_set_header X-Opfield-Access-Scheme $scheme',
      ])
    );

    // An older daemon: no sign-in page, and nobody is sent anywhere else.
    const older = locations(await render({ accessList: { ...signIn, signInPage: false } }));
    expect(older.has('^~ /_opfield/access/')).toBe(false);
    expect(lines(older.get('@opfield_access_challenge'))).toEqual(['auth_request off', 'return 403']);

    // A basic-only list keeps the daemon's basic challenge and needs no sign-in page.
    const basic = locations(await render({ accessList: { ...basicOnly, signInPage: false } }));
    expect(basic.has('^~ /_opfield/access/')).toBe(false);
    expect(lines(basic.get('@opfield_access_challenge'))).toContain('rewrite ^ /challenge break');
  });

  it('keeps the Pages 404 handling the route location inherited before its own error_page', async () => {
    const config = await render({ pagesRouteIncludePath: '/etc/nginx/opfield/pages/routes/a.conf' });
    expect(lines(locations(config).get('/'))).toEqual(
      expect.arrayContaining([
        'error_page 401 = @opfield_access_challenge',
        `error_page 404 @opfield_pages_404_${HOST_ID}`,
      ])
    );
    expect(lines(locations(config).get('= /_opfield/pages/config.js'))).toContain(
      'auth_request /_opfield/access/check'
    );
  });

  it('upgrades the access list block of a copied built-in template', async () => {
    const config = await render({}, LEGACY_CUSTOM_TEMPLATE);
    expect(lines(locations(config).get('/'))).toContain('auth_request /_opfield/access/check');
    expect(config).toContain('location = /_opfield/access/check {');
  });

  it('denies what a template written for the old fields cannot check (no htpasswd file on this node)', async () => {
    const config = await render(
      { accessList: basicOnly },
      LEGACY_CUSTOM_TEMPLATE.replace('{{#if accessList}}\n{{#each', '{{#if accessList}}\n# own\n{{#each')
    );
    expect(lines(locations(config).get('/'))).toEqual(expect.arrayContaining(['deny all']));
    expect(config).not.toContain('auth_basic');
  });
});

describe('access list rendering on a node without the access socket', () => {
  it('renders basic authentication for a basic-only list and denies other sign-in methods', async () => {
    const basic = lines(locations(await render({ accessList: { ...basicOnly, authRequest: false } })).get('/'));
    expect(basic).toEqual(
      expect.arrayContaining([
        'auth_basic "Restricted Access"',
        `auth_basic_user_file /etc/nginx/opfield/htpasswd/access-list-${LIST_ID}`,
      ])
    );
    expect(basic).not.toContain('deny all');

    const sso = lines(locations(await render({ accessList: { ...signIn, authRequest: false } })).get('/'));
    expect(sso.filter((line) => /^(allow|deny) /.test(line))).toEqual([
      'deny 198.51.100.0/24',
      'allow 10.0.40.0/24',
      'deny all',
    ]);
    expect(sso.some((line) => line.startsWith('auth_'))).toBe(false);
  });

  it('keeps the outcome of lists migration 0279 converted', () => {
    const cases = [
      // Old rules, old basic auth, then the allow/deny nginx rendered and whether it asked for a password.
      { ipRules: [], basic: false, rules: ['allow 0.0.0.0/0', 'allow ::/0', 'deny all'], basicAuth: false },
      {
        ipRules: [{ type: 'allow' as const, value: '10.0.0.0/8' }],
        basic: true,
        rules: ['allow 10.0.0.0/8', 'deny all'],
        basicAuth: true,
      },
      {
        ipRules: [
          { type: 'deny' as const, value: '192.0.2.7' },
          { type: 'allow' as const, value: 'all' },
        ],
        basic: false,
        rules: ['deny 192.0.2.7', 'allow 0.0.0.0/0', 'allow ::/0', 'deny all'],
        basicAuth: false,
      },
      { ipRules: [], basic: true, rules: [], basicAuth: true },
    ];
    for (const { ipRules, basic, rules, basicAuth } of cases) {
      const list = { ...legacyAccessRules({ ipRules, basicAuthEnabled: basic }), hasUsers: true };
      const fallback = fallbackAccess(list, { basic: true });
      expect(fallback.rules.map((rule) => `${rule.type} ${rule.value}`)).toEqual(rules);
      expect(fallback.basicAuth).toBe(basicAuth);
    }
  });
});
