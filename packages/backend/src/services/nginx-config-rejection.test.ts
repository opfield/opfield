import { describe, expect, it } from 'vitest';
import { LEGACY_NGINX_DIR } from '@/lib/legacy-compat.js';
import { nginxConfigRejection } from './nginx-config-rejection.js';

const UNKNOWN_DIRECTIVE = `nginx config test failed: nginx: [emerg] unknown directive "bogus_directive" in ${LEGACY_NGINX_DIR}/conf.d/proxy-host-1.conf:54`;

describe('nginx config rejection', () => {
  it('reports a config the node rejected as the caller error on HTTP and HTTPS routes alike', () => {
    expect(nginxConfigRejection(UNKNOWN_DIRECTIVE)).toMatchObject({
      statusCode: 422,
      code: 'NGINX_CONFIG_FAILED',
      message: `Failed to apply Nginx config: ${UNKNOWN_DIRECTIVE}`,
    });
    expect(nginxConfigRejection(UNKNOWN_DIRECTIVE, 'redacted')).toMatchObject({
      statusCode: 422,
      code: 'NGINX_CONFIG_FAILED',
      message: 'Failed to apply Nginx config: redacted',
    });
  });

  it('leaves certificate loading and delivery failures to the caller', () => {
    expect(
      nginxConfigRejection(
        'nginx config test failed: nginx: [emerg] cannot load certificate "/etc/nginx/certs/x/fullchain.pem": PEM_read_bio_X509_AUX() failed'
      )
    ).toBeNull();
    expect(nginxConfigRejection('Node 1 is not connected')).toBeNull();
    expect(nginxConfigRejection('write TLS proxy configuration failed')).toBeNull();
  });
});
