import { describe, expect, it } from 'vitest';
import { LEGACY_NGINX_DIR } from '@/lib/legacy-compat.js';
import { injectAccessListIntoAdvancedLocations } from './nginx-advanced-location.js';

describe('injectAccessListIntoAdvancedLocations', () => {
  const directives = [
    'allow 192.0.2.0/24;',
    'deny all;',
    'auth_basic "Restricted Access";',
    `auth_basic_user_file ${LEGACY_NGINX_DIR}/htpasswd/access-list-list-1;`,
  ];

  it('injects directives into each top-level location, including inline locations', () => {
    const rendered = injectAccessListIntoAdvancedLocations(
      `# location /commented/ { proxy_pass http://ignored; }
set $marker "location /quoted/ {";
location /api/ { proxy_pass http://127.0.0.1:9000; }
location ~ ^/assets/ {
  try_files $uri =404;
}`,
      directives
    );

    expect(rendered.match(/deny all;/g)).toHaveLength(2);
    expect(rendered).toContain(
      'location /api/ {\n    allow 192.0.2.0/24;\n    deny all;\n    auth_basic "Restricted Access";'
    );
    expect(rendered).toContain(
      'location ~ ^/assets/ {\n    allow 192.0.2.0/24;\n    deny all;\n    auth_basic "Restricted Access";'
    );
  });

  it('relies on parent inheritance for nested locations', () => {
    const rendered = injectAccessListIntoAdvancedLocations(
      `location /api/ {
  location /api/private/ {
    proxy_pass http://127.0.0.1:9000;
  }
}`,
      directives
    );

    expect(rendered.match(/deny all;/g)).toHaveLength(1);
  });
});
