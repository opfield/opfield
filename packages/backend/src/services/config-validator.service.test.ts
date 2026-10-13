import { describe, expect, it } from 'vitest';
import { ConfigValidatorService } from './config-validator.service.js';

describe('ConfigValidatorService', () => {
  const service = new ConfigValidatorService();

  it('rejects top-level upstream directives in advanced mode', () => {
    const result = service.validate(
      `
proxy_pass http://127.0.0.1:3000;
`.trim()
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Forbidden top-level directive "proxy_pass" found on line 1');
  });

  it('allows upstream directives inside custom non-root location blocks', () => {
    const result = service.validate(
      `
location /api/ {
  proxy_pass http://127.0.0.1:3000/api/;
  proxy_http_version 1.1;
}
`.trim()
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('allows inline custom non-root location blocks', () => {
    const result = service.validate(
      'location /api/ { proxy_http_version 1.1; proxy_pass http://127.0.0.1:3000/api/; }'
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it.each([
    ['allow', 'allow all;'],
    ['deny', 'deny all;'],
    ['auth_basic', 'auth_basic off;'],
  ])('rejects %s overrides inside custom locations', (directive, statement) => {
    const result = service.validate(
      `location /api/ {
  ${statement}
  proxy_pass http://127.0.0.1:3000/api/;
}`
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(`Forbidden directive "${directive}" found on line 2`);
  });

  it('rejects forbidden directives even when chained after safe directives on one line', () => {
    const result = service.validate('proxy_http_version 1.1; proxy_pass http://127.0.0.1:3000;');

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Forbidden top-level directive "proxy_pass" found on line 1');
  });

  it('rejects custom root location blocks', () => {
    const result = service.validate(
      `
location / {
  proxy_pass http://127.0.0.1:3000;
}
`.trim()
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Forbidden root location block found on line 1');
  });

  it('keeps dangerous directives blocked even inside nested blocks', () => {
    const result = service.validate(
      `
location /api/ {
  include /etc/nginx/conf.d/shared.conf;
}
`.trim()
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Forbidden directive "include" found on line 2');
  });

  it('rejects dangerous directives in raw mode by default', () => {
    const result = service.validate(
      `
server {
  include /etc/nginx/conf.d/private.conf;
}
`.trim(),
      true
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Forbidden directive "include" found on line 2');
  });

  it.each([
    'ssl_certificate_by_lua_block { ngx.say(1) }',
    'ssl_certificate_by_lua_file /tmp/a.lua;',
  ])('rejects lua execution directives in advanced mode: %s', (snippet) => {
    const result = service.validate(snippet);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Forbidden directive "lua_" found on line 1');
  });

  it.each([
    'ssl_certificate_by_lua_block { ngx.say(1) }',
    'access_by_lua_file /tmp/a.lua;',
  ])('rejects lua execution directives in raw mode without bypass: %s', (snippet) => {
    const result = service.validate(snippet, true);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Forbidden directive "lua_" found on line 1');
  });

  it.each(['env FOO;', 'env\tFOO;'])('rejects raw env directives with nginx whitespace: %s', (snippet) => {
    const result = service.validate(snippet, true);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Forbidden directive "env" found on line 1');
  });

  it.each([
    'access_log /etc/cron.d/gateway gateway_combined;',
    'error_log /root/.ssh/authorized_keys;',
    'access_log /var/log/nginx/../../etc/cron.d/gateway;',
    'access_log /var/log/nginx/$host.log;',
  ])('keeps raw mode logs in the nginx log directory: %s', (snippet) => {
    expect(service.validate(snippet, true).errors).toEqual([
      expect.stringMatching(/^Directive "(access|error)_log" may only write to \/var\/log\/nginx\/ found on line 1$/),
    ]);
    expect(service.validate(snippet, true, true).valid).toBe(true);
  });

  it('allows raw mode logs in the nginx log directory, syslog and off', () => {
    const result = service.validate(
      [
        'access_log /var/log/nginx/proxy-1.access.log gateway_combined;',
        'error_log /var/log/nginx/proxy-1.error.log warn;',
        'access_log syslog:server=127.0.0.1;',
        'access_log off;',
      ].join('\n'),
      true
    );

    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('allows raw mode dangerous directives only with raw bypass', () => {
    const result = service.validate(
      `
server {
  include /etc/nginx/conf.d/private.conf;
}
`.trim(),
      true,
      true
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('does not apply advanced top-level restrictions to raw mode', () => {
    const result = service.validate(
      `
location / {
  proxy_pass http://127.0.0.1:3000;
}
`.trim(),
      true
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('allows ssl certificate directives in raw mode without bypass', () => {
    const result = service.validate(
      `
server {
  ssl_certificate /etc/nginx/certs/fullchain.pem;
  ssl_certificate_key /etc/nginx/certs/privkey.pem;
}
`.trim(),
      true
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('keeps advanced snippet ssl key directives forbidden', () => {
    const result = service.validate('ssl_certificate_key /etc/nginx/certs/privkey.pem;');

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Forbidden directive "ssl_certificate_key" found on line 1');
  });

  // Each snippet hides `include` from a tokenizer that reads comments, strings or escapes differently than nginx.
  it.each([
    ['a "#" inside a token', 'add_header X-A a#b; include /etc/passwd;'],
    ['a quote inside a token', 'add_header X-A a"b; include /etc/passwd; #"'],
    ['an escaped backslash before the closing quote', 'add_header X-A "a\\\\"; include /etc/passwd; #"'],
    ['a quoted directive name', '"include" /etc/passwd;'],
    ['a single-quoted directive name', "'include' /etc/passwd;"],
  ])('reads %s the way nginx does', (_case, snippet) => {
    for (const rawMode of [false, true]) {
      const result = service.validate(snippet, rawMode);
      expect(result.errors).toContain('Forbidden directive "include" found on line 1');
    }
  });

  it('rejects a quoted brace that would let a snippet close the enclosing block', () => {
    const result = service.validate('return 200 "{"; }\nserver { location / { root /; } }');

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Unexpected "}" on line 1');
  });

  it('rejects a directive left without its semicolon', () => {
    const result = service.validate('proxy_buffering off');

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Unexpected end of config, expecting ";" or "}" on line 1');
  });
});

describe('ConfigValidatorService templates', () => {
  const service = new ConfigValidatorService();

  it('allows the Pages include and access list password file Opfield templates emit', () => {
    const result = service.validateTemplate(
      [
        'server {',
        '    include {{pagesRouteIncludePath}};',
        '    location / {',
        '        auth_basic_user_file /etc/nginx/gateway/htpasswd/access-list-{{accessList.id}};',
        '        proxy_pass {{upstream}};',
        '    }',
        '}',
      ].join('\n')
    );

    expect(result).toEqual({ valid: true, errors: [] });
  });

  it.each([
    ['include', 'server { include /etc/nginx/nginx.conf; }'],
    ['include', 'server { include {{logPath}}; }'],
    ['load_module', 'load_module /tmp/evil.so;\nserver { listen 80; }'],
    ['lua_', 'server { location / { content_by_lua_block { ngx.say(1) } } }'],
    ['auth_basic_user_file', 'server { auth_basic_user_file /etc/shadow; }'],
  ])('rejects %s in template content', (directive, content) => {
    expect(service.validateTemplate(content).errors.join('\n')).toContain(`Forbidden directive "${directive}"`);
  });

  it('hides no directive behind a Handlebars block on the same line', () => {
    const result = service.validateTemplate('server { {{#if sslEnabled}} include /etc/passwd; {{/if}} }');

    expect(result.errors).toContain('Forbidden directive "include" found on line 1');
  });

  it('allows forbidden statements in rendered output only where the route authorized them', () => {
    const rendered = 'server {\n  include /var/lib/gateway/pages/a.conf;\n  include /etc/nginx/snippets/x.conf;\n}';

    expect(
      service.validateRenderedTemplate(rendered, { statements: [['include', '/var/lib/gateway/pages/a.conf']] }).errors
    ).toEqual(['Forbidden directive "include" found on line 3']);
    expect(
      service.validateRenderedTemplate(rendered, {
        statements: [['include', '/var/lib/gateway/pages/a.conf']],
        snippets: ['include /etc/nginx/snippets/x.conf;'],
      }).valid
    ).toBe(true);
  });
});
