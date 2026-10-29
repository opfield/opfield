// The schema barrel first: loading the template service alone enters the schema import cycle mid-way.
import '@/db/schema/index.js';
import { describe, expect, it } from 'vitest';
import { ConfigValidatorService } from '@/services/config-validator.service.js';
import type { ProxyHostConfig } from '@/services/nginx-config-generator.service.js';
import { maintenanceAccessListDirectives, type NginxAccessList } from './nginx-access-list.js';
import { type NginxConfigDirective, parseNginxConfig } from './nginx-config-tree.js';
import { renderMaintenanceFlagGuard } from './nginx-maintenance-flag-guard.js';
import { NginxTemplateService } from './nginx-template.service.js';

// A client the route's access list denies got the 503 maintenance page (and could read the maintenance state) while
// the route was in maintenance, because the guard answers from its own locations before `location /` with the
// access list is reached. Deny must win: the guard's locations carry the allow/deny rules (X-O-5).
const HOST_ID = '11111111-1111-4111-8111-111111111111';
const ROUTE =
  'server {\n    listen 80;\n    location / {\n        allow 10.0.0.0/8;\n        deny all;\n        proxy_set_header Host $host;\n        proxy_pass http://10.0.0.5;\n    }\n}\n';
// A basic authentication list from the networks 10.0.0.0/8, except 192.0.2.7 (a list migration 0279 converted).
const accessList: NonNullable<ProxyHostConfig['accessList']> = {
  id: '22222222-2222-4222-8222-222222222222',
  authRequest: true,
  signInMethods: ['basic'],
  hasUsers: true,
  skipIpRanges: [],
  includeRules: [{ selector: 'everyone', values: [] }],
  requireRules: [{ selector: 'ip', values: ['10.0.0.0/8'] }],
  excludeRules: [{ selector: 'ip', values: ['192.0.2.7'] }],
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

const RULES = ['deny 192.0.2.7', 'allow 10.0.0.0/8', 'deny all'];

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
  it('takes the address rules of the list, without its sign-in', () => {
    expect(maintenanceAccessListDirectives(accessList)).toEqual(['deny 192.0.2.7;', 'allow 10.0.0.0/8;', 'deny all;']);
    expect(maintenanceAccessListDirectives(null)).toEqual([]);
    // Anyone may sign in: only the excluded addresses are turned away by address.
    expect(maintenanceAccessListDirectives({ ...accessList, signInMethods: ['opfield'], requireRules: [] })).toEqual([
      'deny 192.0.2.7;',
    ]);
    // Without sign-in only the skip ranges get in.
    const ipOnly: NginxAccessList = {
      ...accessList,
      signInMethods: [],
      requireRules: [],
      skipIpRanges: ['10.0.0.0/8'],
    };
    expect(maintenanceAccessListDirectives(ipOnly)).toEqual(['deny 192.0.2.7;', 'allow 10.0.0.0/8;', 'deny all;']);
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
