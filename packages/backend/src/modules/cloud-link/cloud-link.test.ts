import { describe, expect, it, vi } from 'vitest';
import { normalizeCloudCode } from './cloud-link.service.js';
import type { CloudLinkProbe } from './cloud-link.types.js';
import { cloudAgentSocketUrl, cloudBackoffDelay } from './cloud-link-agent.js';
import { answerCloudRequest, parseCloudRequest } from './cloud-link-requests.js';

describe('cloud link', () => {
  it('reads a code in any of the forms the account shows', () => {
    expect(normalizeCloudCode('CLD-7K3M-Q9TX')).toBe('CLD-7K3M-Q9TX');
    expect(normalizeCloudCode(' cld 7k3m q9tx ')).toBe('CLD-7K3M-Q9TX');
    expect(normalizeCloudCode('7K3M-Q9TX')).toBe('CLD-7K3M-Q9TX');
    expect(normalizeCloudCode('7K3M-Q9TO')).toBeNull();
    expect(normalizeCloudCode('7K3M-Q9T')).toBeNull();
  });

  it('backs off from 1 s doubling up to 60 s, with jitter', () => {
    expect(cloudBackoffDelay(0, () => 1)).toBe(1_000);
    expect(cloudBackoffDelay(0, () => 0)).toBe(500);
    expect(cloudBackoffDelay(3, () => 1)).toBe(8_000);
    expect(cloudBackoffDelay(10, () => 1)).toBe(60_000);
    expect(cloudBackoffDelay(50, () => 0)).toBe(30_000);
  });

  it('turns the portal URL into its agent socket URL', () => {
    expect(cloudAgentSocketUrl('https://account.example.test/')).toBe('wss://account.example.test/api/cloud/agent');
    expect(cloudAgentSocketUrl('http://localhost:8080/portal')).toBe('ws://localhost:8080/portal/api/cloud/agent');
  });

  it('answers requests, caps the log tail and reports failures as ok:false', async () => {
    const logs = vi.fn(async () => [{ t: '2026-10-11T10:00:00Z', stream: 'stdout' as const, line: 'ready' }]);
    const probe: CloudLinkProbe = {
      state: async () => {
        throw new Error('Host readings are not available here');
      },
      services: async () => ['app', 'postgres'],
      logs,
    };

    const request = parseCloudRequest(
      JSON.stringify({ id: 'r1', type: 'logs', params: { service: 'app', tail: 5000 } })
    );
    expect(request).not.toBeNull();
    await expect(answerCloudRequest(probe, request!)).resolves.toEqual({
      id: 'r1',
      ok: true,
      data: { service: 'app', lines: [{ t: '2026-10-11T10:00:00Z', stream: 'stdout', line: 'ready' }] },
    });
    expect(logs).toHaveBeenCalledWith('app', { tail: 2000 });

    await expect(answerCloudRequest(probe, { id: 'r2', type: 'services', params: {} })).resolves.toEqual({
      id: 'r2',
      ok: true,
      data: { services: ['app', 'postgres'] },
    });
    await expect(answerCloudRequest(probe, { id: 'r3', type: 'state', params: {} })).resolves.toEqual({
      id: 'r3',
      ok: false,
      error: 'Host readings are not available here',
    });
    await expect(
      answerCloudRequest(probe, { id: 'r4', type: 'logs', params: { service: 'app', since: 'yesterday' } })
    ).resolves.toMatchObject({ id: 'r4', ok: false });
    await expect(answerCloudRequest(probe, { id: 'r5', type: 'shell', params: {} })).resolves.toMatchObject({
      id: 'r5',
      ok: false,
    });
    expect(parseCloudRequest('not json')).toBeNull();
    expect(parseCloudRequest(JSON.stringify({ type: 'state' }))).toBeNull();
  });
});
