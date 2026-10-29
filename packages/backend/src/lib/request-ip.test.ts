import { describe, expect, it } from 'vitest';
import { resolveClientIp } from './request-ip.js';

function headers(values: Record<string, string>) {
  return new Headers(values);
}

describe('resolveClientIp', () => {
  it('ignores spoofed proxy headers in direct mode', () => {
    const result = resolveClientIp(
      headers({
        'cf-connecting-ip': '203.0.113.10',
        'x-forwarded-for': '203.0.113.11',
      }),
      '198.51.100.20',
      { clientIpSource: 'direct', trustedProxyCidrs: [], trustCloudflareHeaders: false }
    );

    expect(result.ipAddress).toBe('198.51.100.20');
    expect(result.source).toBe('remote');
  });

  it('uses Cloudflare connecting IP when the peer is Cloudflare', () => {
    const result = resolveClientIp(headers({ 'cf-connecting-ip': '203.0.113.10' }), '173.245.48.10', {
      clientIpSource: 'auto',
      trustedProxyCidrs: [],
      trustCloudflareHeaders: false,
    });

    expect(result.ipAddress).toBe('203.0.113.10');
    expect(result.source).toBe('cloudflare');
  });

  it('does not trust forwarded headers in auto mode only because the peer is private', () => {
    const result = resolveClientIp(headers({ 'x-forwarded-for': '198.51.100.10, 10.0.0.2' }), '172.18.0.5', {
      clientIpSource: 'auto',
      trustedProxyCidrs: [],
      trustCloudflareHeaders: false,
    });

    expect(result.ipAddress).toBe('172.18.0.5');
    expect(result.source).toBe('remote');
    expect(result.warning).toContain('ignored');
  });

  it('uses real IP before forwarded IP in explicit reverse proxy mode', () => {
    const result = resolveClientIp(
      headers({
        'x-real-ip': '198.51.100.30',
        'x-forwarded-for': '1.2.3.4, 198.51.100.30',
      }),
      '172.18.0.5',
      {
        clientIpSource: 'reverse_proxy',
        trustedProxyCidrs: [],
        trustCloudflareHeaders: false,
      }
    );

    expect(result.ipAddress).toBe('198.51.100.30');
    expect(result.source).toBe('real-ip');
  });

  it('requires trusted CIDR in reverse proxy mode when configured', () => {
    const untrusted = resolveClientIp(headers({ 'x-forwarded-for': '198.51.100.10' }), '203.0.113.20', {
      clientIpSource: 'reverse_proxy',
      trustedProxyCidrs: ['10.0.0.0/8'],
      trustCloudflareHeaders: false,
    });
    const trusted = resolveClientIp(headers({ 'x-forwarded-for': '198.51.100.10' }), '10.0.0.5', {
      clientIpSource: 'reverse_proxy',
      trustedProxyCidrs: ['10.0.0.0/8'],
      trustCloudflareHeaders: false,
    });

    expect(untrusted.ipAddress).toBe('203.0.113.20');
    expect(untrusted.warning).toContain('not trusted');
    expect(trusted.ipAddress).toBe('198.51.100.10');
  });

  it('takes the rightmost untrusted X-Forwarded-For hop instead of the spoofable leftmost entry', () => {
    const singleProxy = resolveClientIp(headers({ 'x-forwarded-for': '1.2.3.4, 198.51.100.10' }), '172.18.0.5', {
      clientIpSource: 'reverse_proxy',
      trustedProxyCidrs: [],
      trustCloudflareHeaders: false,
    });
    const chained = resolveClientIp(headers({ 'x-forwarded-for': '1.2.3.4, 198.51.100.10, 10.0.0.7' }), '10.0.0.5', {
      clientIpSource: 'reverse_proxy',
      trustedProxyCidrs: ['10.0.0.0/8'],
      trustCloudflareHeaders: false,
    });
    const autoMode = resolveClientIp(headers({ 'x-forwarded-for': '1.2.3.4, 198.51.100.10' }), '10.0.0.5', {
      clientIpSource: 'auto',
      trustedProxyCidrs: ['10.0.0.0/8'],
      trustCloudflareHeaders: false,
    });

    expect(singleProxy.ipAddress).toBe('198.51.100.10');
    expect(chained.ipAddress).toBe('198.51.100.10');
    expect(autoMode.ipAddress).toBe('198.51.100.10');
  });

  it('does not let private peers bypass configured proxy CIDRs', () => {
    const result = resolveClientIp(headers({ 'x-real-ip': '198.51.100.10' }), '172.18.0.5', {
      clientIpSource: 'reverse_proxy',
      trustedProxyCidrs: ['10.0.0.0/8'],
      trustCloudflareHeaders: false,
    });

    expect(result.ipAddress).toBe('172.18.0.5');
    expect(result.warning).toContain('not trusted');
  });

  it('supports Cloudflare IPv6 edge ranges', () => {
    const result = resolveClientIp(headers({ 'cf-connecting-ip': '2001:db8::10' }), '2606:4700::1', {
      clientIpSource: 'auto',
      trustedProxyCidrs: [],
      trustCloudflareHeaders: false,
    });

    expect(result.ipAddress).toBe('2001:db8::10');
    expect(result.source).toBe('cloudflare');
  });
});

describe('resolveClientIp: addresses that do not tell clients apart (M-03)', () => {
  const auto = { clientIpSource: 'auto' as const, trustedProxyCidrs: [], trustCloudflareHeaders: false };

  it('marks the peer address shared when proxy headers came in but are ignored', () => {
    const behindProxy = resolveClientIp(headers({ 'x-forwarded-for': '198.51.100.10' }), '172.18.0.5', auto);
    expect(behindProxy).toMatchObject({ ipAddress: '172.18.0.5', sharedAddress: true });
  });

  it('marks it shared for settings with the reverse_proxy-without-trusted-proxies marker', () => {
    const marked = resolveClientIp(headers({}), '172.18.0.5', { ...auto, reverseProxyWithoutTrustedProxies: true });
    expect(marked).toMatchObject({ ipAddress: '172.18.0.5', sharedAddress: true });
  });

  it('keeps direct peers and trusted proxy clients distinct', () => {
    expect(resolveClientIp(headers({}), '203.0.113.7', auto).sharedAddress).toBeUndefined();
    const trusted = resolveClientIp(headers({ 'x-forwarded-for': '198.51.100.10' }), '10.0.0.2', {
      clientIpSource: 'reverse_proxy',
      trustedProxyCidrs: ['10.0.0.0/8'],
      trustCloudflareHeaders: false,
    });
    expect(trusted).toMatchObject({ ipAddress: '198.51.100.10' });
    expect(trusted.sharedAddress).toBeUndefined();
  });
});
