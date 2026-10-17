// The schema barrel first: loading the template service alone enters the schema import cycle mid-way.
import '@/db/schema/index.js';
import { describe, expect, it } from 'vitest';
import { ConfigValidatorService } from '@/services/config-validator.service.js';
import type { ProxyHostConfig } from '@/services/nginx-config-generator.service.js';
import { type NginxConfigDirective, parseNginxConfig } from './nginx-config-tree.js';
import { renderMaintenanceFlagGuard } from './nginx-maintenance-flag-guard.js';
import { maintenanceAccessListDirectives, NginxTemplateService } from './nginx-template.service.js';

// A client the route's access list denies got the 503 maintenance page (and could read the maintenance state) while
// the route was in maintenance, because the guard answers from its own locations before `location /` with the
// access list is reached. Deny must win: the guard's locations carry the allow/deny rules (X-O-5).
const HOST_ID = '11111111-1111-4111-8111-111111111111';
const ROUTE =
  'server {\n    listen 80;\n    location / {\n        allow 10.0.0.0/8;\n        deny all;\n        proxy_set_header Host $host;\n        proxy_pass http://10.0.0.5;\n    }\n}\n';
const accessList: NonNullable<ProxyHostConfig['accessList']> = {
  id: '22222222-2222-4222-8222-222222222222',
  ipRules: [
    { type: 'allow', value: '10.0.0.0/8' },
    { type: 'deny', value: '192.0.2.7' },
  ],
  basicAuthEnabled: true,
};

function guardLocations(config: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const visit = (directives: NginxConfigDirective[]) => {
    for (const directive of directives) {
      if (directive.name === 'location') {
        const name = directive.args.at(-1)!.value;
        // Named locations answer after the access phase of the location that hands the request to them.
        if (/maintenance/.test(name) && !name.startsWith('@')) {
          result.set(
            name,
            directive
              .block!.children.filter((child) => child.name === 'allow' || child.name === 'deny')
              .map((child) => `${child.name} ${child.args.map((arg) => arg.value).join(' ')}`)
          );
        }
      }
      if (directive.block) visit(directive.block.children);
    }
  };
  visit(parseNginxConfig(config));
  return result;
}

const RULES = ['allow 10.0.0.0/8', 'deny 192.0.2.7', 'deny all'];

/**
 * `return` runs in nginx's rewrite phase, before allow/deny: a guard location with access rules must answer through
 * try_files + error_page instead, or deny never applies (X-O-5, still broken in rc.3).
 */
function expectAnswersAfterAccess(config: string) {
  const visit = (directives: NginxConfigDirective[]) => {
    for (const directive of directives) {
      if (directive.name === 'location' && directive.block) {
        const children = directive.block.children;
        if (children.some((child) => child.name === 'deny')) {
          const name = directive.args.at(-1)!.value;
          expect(
            children.some((child) => child.name === 'return' || (child.block && child.name === 'if')),
            name
          ).toBe(false);
          if (!children.some((child) => child.name === 'proxy_pass')) {
            expect(
              children.map((child) => child.name),
              name
            ).toEqual(expect.arrayContaining(['error_page', 'try_files']));
          }
        }
      }
      if (directive.block) visit(directive.block.children);
    }
  };
  visit(parseNginxConfig(config));
}

describe('maintenance behind the access list', () => {
  it('takes the allow/deny rules of the list, without its basic authentication', () => {
    expect(maintenanceAccessListDirectives(accessList)).toEqual(['allow 10.0.0.0/8;', 'deny 192.0.2.7;', 'deny all;']);
    expect(maintenanceAccessListDirectives(null)).toEqual([]);
    expect(maintenanceAccessListDirectives({ ...accessList, ipRules: [] })).toEqual([]);
  });

  it('guards every location of the flag-based guard', () => {
    const guarded = renderMaintenanceFlagGuard(ROUTE, {
      hostId: HOST_ID,
      secret: 'route-secret',
      pageText: '"<html>maintenance</html>"',
      accessDirectives: maintenanceAccessListDirectives(accessList),
    })!;
    const locations = guardLocations(guarded);
    expect([...locations.keys()]).toEqual([
      'opfield-maintenance',
      'opfield-maintenance-access',
      'opfield-maintenance-status',
    ]);
    for (const [name, rules] of locations) expect(rules, name).toEqual(RULES);
    expectAnswersAfterAccess(guarded);
  });

  it('emits "deny all" once when the list ends in its own', () => {
    const own = { ...accessList, ipRules: [...accessList.ipRules, { type: 'deny' as const, value: 'all' }] };
    expect(maintenanceAccessListDirectives(own)).toEqual(['allow 10.0.0.0/8;', 'deny 192.0.2.7;', 'deny all;']);
  });

  it('guards every location of the reload-based guard, with and without team access', () => {
    const templates = new NginxTemplateService({} as never, {} as never, new ConfigValidatorService());
    const withAccess = guardLocations(
      templates.applyMaintenanceGuard(ROUTE, { hostId: HOST_ID, secret: 'route-secret' }, false, accessList)
    );
    expect([...withAccess.keys()]).toEqual([
      'opfield-maintenance',
      '/_opfield/maintenance-access',
      '/_opfield/maintenance-access/status',
    ]);
    for (const [name, rules] of withAccess) expect(rules, name).toEqual(RULES);
    expectAnswersAfterAccess(
      templates.applyMaintenanceGuard(ROUTE, { hostId: HOST_ID, secret: 'route-secret' }, false, accessList)
    );

    const plainConfig = templates.applyMaintenanceGuard(ROUTE, undefined, false, accessList);
    expect(guardLocations(plainConfig).get('opfield-maintenance')).toEqual(RULES);
    expectAnswersAfterAccess(plainConfig);
  });

  it('adds nothing for a route without an access list', () => {
    const templates = new NginxTemplateService({} as never, {} as never, new ConfigValidatorService());
    for (const rules of guardLocations(templates.applyMaintenanceGuard(ROUTE, undefined)).values()) {
      expect(rules).toEqual([]);
    }
  });
});
