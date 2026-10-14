import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  INGRESS_HEALTH_LOCATION,
  INGRESS_HEALTH_PATH,
  LEGACY_INGRESS_HEALTH_PATH,
  withIngressHealthLocation,
} from '@/modules/ingress-groups/ingress-health.js';
import { NGINX_NAME_PAIRS, nginxNamesForNode, toLegacyNginxNames, toOpfieldNginxNames } from './nginx-node-names.js';
import { rawConfigUsesSecureLink } from './proxy.service-helpers.js';
import { referencedSecureLinkIds } from './secure-link-loopback.js';

const HOST = '22222222-2222-4222-8222-222222222222';

const OPFIELD_CONFIG = `upstream opfield_secure_link_x {
    server unix:/run/opfield-secure-links/${HOST}.sock;
}
server {
    if (-f /etc/nginx/opfield/maintenance/${HOST}) {
        set $opfield_maintenance 1;
    }
    secure_link "$cookie_opfield_maintenance_access_sig,$cookie_opfield_maintenance_access_exp";
    location = opfield-maintenance-access {
        proxy_set_header X-Opfield-Maintenance-Host $host;
    }
    location = /_opfield/maintenance-access { return 204; }
${INGRESS_HEALTH_LOCATION}    location = /_opfield/pages/config.js { alias $opfield_pages_runtime_config_path; }
    location = /_gateway/pages/config.js { alias $opfield_pages_runtime_config_path; }
    location / {
        auth_basic_user_file /etc/nginx/opfield/htpasswd/access-list-1;
        # opfield-managed-secure-link-upstream ${HOST}
        proxy_pass http://opfield_secure_link_x;
    }
}
`;

describe('nginx names of a node', () => {
  it('renders the pre-Opfield names for a node that has not moved, and back', () => {
    const legacy = toLegacyNginxNames(OPFIELD_CONFIG);
    expect(legacy).not.toMatch(
      /opfield_|opfield-(?!ingress-health)|X-Opfield|\/_opfield\/maintenance|\/etc\/nginx\/opfield/
    );
    expect(legacy).toContain(`server unix:/run/gateway-secure-links/${HOST}.sock;`);
    expect(legacy).toContain('set $gateway_maintenance 1;');
    expect(legacy).toContain('proxy_set_header X-Gateway-Ingress-Generation $gateway_ingress_generation;');
    expect(toOpfieldNginxNames(legacy)).toBe(OPFIELD_CONFIG);
    expect(nginxNamesForNode(legacy, true)).toBe(OPFIELD_CONFIG);
    expect(nginxNamesForNode(OPFIELD_CONFIG, false)).toBe(legacy);
  });

  it('logs a route with the access log format only on a node that defines it before its includes', () => {
    const route = 'server {\n    access_log /var/log/nginx/proxy-1.access.log opfield_combined;\n}\n';
    expect(nginxNamesForNode(route, true, true)).toContain('proxy-1.access.log opfield_combined;');
    expect(nginxNamesForNode(route, false, true)).toContain('proxy-1.access.log gateway_combined;');
    expect(nginxNamesForNode(route, true, false)).toContain('proxy-1.access.log;');
    expect(nginxNamesForNode(route, false, false)).toContain('proxy-1.access.log;');
  });

  it('keeps both public paths: the health path monitors probe and the Pages script pages load', () => {
    const legacy = toLegacyNginxNames(OPFIELD_CONFIG);
    for (const path of [INGRESS_HEALTH_PATH, LEGACY_INGRESS_HEALTH_PATH]) {
      expect(legacy.split(`location = ${path} {`)).toHaveLength(2);
    }
    expect(legacy).toContain('location = /_opfield/pages/config.js {');
    expect(legacy).toContain('location = /_gateway/pages/config.js {');
  });

  it('matches the pairs of the nginx daemon', () => {
    const goFile = fileURLToPath(new URL('../../../../daemons/nginx/internal/naming/naming.go', import.meta.url));
    if (!existsSync(goFile)) return;
    const source = readFileSync(goFile, 'utf8');
    const constants = new Map(
      [...source.matchAll(/^\s+(\w+)\s+= "([^"]+)"$/gm)].map((match) => [match[1]!, match[2]!] as const)
    );
    const value = (expression: string) =>
      expression
        .split('+')
        .map((part) => part.trim())
        .map((part) => (part.startsWith('"') ? JSON.parse(part) : constants.get(part)))
        .join('');
    const block = source.slice(
      source.indexOf('var pairs = [][2]string{'),
      source.indexOf('\n}\n', source.indexOf('var pairs'))
    );
    const goPairs = [...block.matchAll(/\{([^,{}]+), ([^{}]+)\},/g)].map((match) => [
      value(match[1]!),
      value(match[2]!),
    ]);
    expect(goPairs).toEqual(NGINX_NAME_PAIRS.map((pair) => [...pair]));
  });

  it('adds only the reserved health locations a config lacks', () => {
    const legacyOnly = `server {\n    listen 80;\n    location = ${LEGACY_INGRESS_HEALTH_PATH} {\n    }\n}\n`;
    const added = withIngressHealthLocation(legacyOnly);
    expect(added.split(`location = ${LEGACY_INGRESS_HEALTH_PATH} {`)).toHaveLength(2);
    expect(added.split(`location = ${INGRESS_HEALTH_PATH} {`)).toHaveLength(2);
    expect(withIngressHealthLocation(added)).toBe(added);
  });

  it('recognises the Secure Link of a raw config under either names', () => {
    for (const prefix of ['opfield', 'gateway']) {
      const raw = `upstream ${prefix}_secure_link_x {\n    server unix:/run/${prefix}-secure-links/${HOST}.sock;\n}\n`;
      expect(rawConfigUsesSecureLink(HOST, raw)).toBe(true);
      expect(referencedSecureLinkIds(raw)).toEqual([HOST]);
    }
    expect(rawConfigUsesSecureLink(HOST, 'server { listen 80; }')).toBe(false);
  });
});
