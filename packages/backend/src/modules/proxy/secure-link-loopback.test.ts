import { describe, expect, it } from 'vitest';
import { LEGACY_NGINX_RUN_PREFIX } from '@/lib/legacy-compat.js';
import { managedSecureLinkUpstreamBody } from './nginx-availability-upstream.js';
import {
  referencedSecureLinkIds,
  secureLinkLoopbackAddress,
  withSecureLinkLoopbackUpstreams,
} from './secure-link-loopback.js';

const LINK = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

describe('Secure Link loopback endpoints', () => {
  it('gives every slot its own address off 127.0.0.0/16, on one port', () => {
    expect(secureLinkLoopbackAddress(1, 17613)).toBe('127.64.0.1:17613');
    expect(secureLinkLoopbackAddress(256, 17613)).toBe('127.64.1.0:17613');
    expect(secureLinkLoopbackAddress(65536 + 2, 9000)).toBe('127.65.0.2:9000');
    const seen = new Set<string>();
    for (const slot of [1, 2, 255, 256, 65535, 65536, 65537, 192 * 65536 - 1]) {
      const address = secureLinkLoopbackAddress(slot, 1)!;
      expect(address).toMatch(/^127\.(6[4-9]|[7-9][0-9]|1[0-9]{2}|2[0-5][0-9])\.[0-9]+\.[0-9]+:1$/);
      expect(seen.has(address)).toBe(false);
      seen.add(address);
    }
    expect(secureLinkLoopbackAddress(0, 1)).toBeUndefined();
    expect(secureLinkLoopbackAddress(null, 1)).toBeUndefined();
    expect(secureLinkLoopbackAddress(192 * 65536, 1)).toBeUndefined();
  });

  it('points the upstream servers of known links at their endpoints and leaves everything else alone', () => {
    const config = [
      `upstream link {\n${managedSecureLinkUpstreamBody([`${LEGACY_NGINX_RUN_PREFIX}secure-links/${LINK}.sock`], false)}\n}`,
      `upstream members {\n${managedSecureLinkUpstreamBody(
        [
          `${LEGACY_NGINX_RUN_PREFIX}secure-links/${MEMBER}.sock`,
          `${LEGACY_NGINX_RUN_PREFIX}secure-links/${OTHER}.sock`,
        ],
        true
      )}\n}`,
      `upstream registry {\n    server unix:${LEGACY_NGINX_RUN_PREFIX}registry-links/${LINK}.sock;\n}`,
      `location /raw { proxy_pass http://unix:${LEGACY_NGINX_RUN_PREFIX}secure-links/${LINK}.sock:/; }`,
    ].join('\n');
    expect(referencedSecureLinkIds(config).sort()).toEqual([LINK, MEMBER, OTHER]);
    const rewritten = withSecureLinkLoopbackUpstreams(
      config,
      new Map([
        [LINK, '127.64.0.1:17613'],
        [MEMBER, '127.64.0.2:17613'],
      ])
    );
    expect(rewritten).toContain('    server 127.64.0.1:17613;\n    keepalive 64;');
    expect(rewritten).toContain('    server 127.64.0.2:17613 max_fails=1 fail_timeout=1s;');
    expect(rewritten).toContain('    server 127.64.0.2:17613 max_fails=0 backup;');
    // A link without an endpoint keeps its socket; so do the registry and a direct unix proxy_pass.
    expect(rewritten).toContain(
      `    server unix:${LEGACY_NGINX_RUN_PREFIX}secure-links/${OTHER}.sock max_fails=1 fail_timeout=1s;`
    );
    expect(rewritten).toContain(`server unix:${LEGACY_NGINX_RUN_PREFIX}registry-links/${LINK}.sock;`);
    expect(rewritten).toContain(`proxy_pass http://unix:${LEGACY_NGINX_RUN_PREFIX}secure-links/${LINK}.sock:/;`);
    expect(withSecureLinkLoopbackUpstreams(config, new Map())).toBe(config);
  });
});
