import { describe, expect, it, vi } from 'vitest';
import type { Env } from '@/config/env.js';
import { checkOutboundWebhookTarget, DEFAULT_OUTBOUND_WEBHOOK_POLICY } from './outbound-webhook-policy.service.js';

// The Opfield hostname resolves to a public address without asking real DNS, which can outlast the test timeout in CI.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '203.0.113.1', family: 4 }]),
}));

const ENV = {
  APP_URL: 'https://gateway.example.com',
  BIND_HOST: '0.0.0.0',
} as Env;

describe('checkOutboundWebhookTarget', () => {
  it('allows default private CIDRs that are explicitly enabled', async () => {
    const result = await checkOutboundWebhookTarget('http://10.2.3.4/hook', DEFAULT_OUTBOUND_WEBHOOK_POLICY, ENV);

    expect(result.allowed).toBe(true);
  });

  it('blocks private CIDRs outside the default allowlist', async () => {
    const result = await checkOutboundWebhookTarget('http://192.168.1.20/hook', DEFAULT_OUTBOUND_WEBHOOK_POLICY, ENV);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('private and not allowlisted');
  });

  it('blocks shared and benchmarking address spaces unless explicitly allowlisted', async () => {
    const shared = await checkOutboundWebhookTarget('http://100.64.1.20/hook', DEFAULT_OUTBOUND_WEBHOOK_POLICY, ENV);
    const benchmarking = await checkOutboundWebhookTarget(
      'http://198.18.1.20/hook',
      DEFAULT_OUTBOUND_WEBHOOK_POLICY,
      ENV
    );

    expect(shared.allowed).toBe(false);
    expect(shared.reason).toContain('private and not allowlisted');
    expect(benchmarking.allowed).toBe(false);
    expect(benchmarking.reason).toContain('private and not allowlisted');
  });

  it('always blocks loopback targets', async () => {
    const result = await checkOutboundWebhookTarget('http://127.0.0.1:3000/hook', DEFAULT_OUTBOUND_WEBHOOK_POLICY, ENV);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not allowed');
  });

  it('does not block a public Gateway address because deployments may run behind NAT', async () => {
    const result = await checkOutboundWebhookTarget('https://203.0.113.10/api', DEFAULT_OUTBOUND_WEBHOOK_POLICY, {
      ...ENV,
      APP_URL: 'https://203.0.113.10',
    } as Env);

    expect(result.allowed).toBe(true);
  });

  it('blocks configured private Gateway app addresses', async () => {
    const result = await checkOutboundWebhookTarget('https://10.2.3.4/api', DEFAULT_OUTBOUND_WEBHOOK_POLICY, {
      ...ENV,
      APP_URL: 'https://10.2.3.4',
    } as Env);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Opfield address');
  });

  it('blocks configured local bind addresses', async () => {
    const result = await checkOutboundWebhookTarget('http://10.1.2.3/api', DEFAULT_OUTBOUND_WEBHOOK_POLICY, {
      ...ENV,
      BIND_HOST: '10.1.2.3',
    } as Env);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Opfield address');
  });
});
