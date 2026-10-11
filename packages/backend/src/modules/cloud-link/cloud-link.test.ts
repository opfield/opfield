import { describe, expect, it, vi } from 'vitest';
import { redactArgsForAudit } from '@/modules/ai/ai.service.tool-helpers.js';
import { AI_TOOLS } from '@/modules/ai/ai.tools.js';
import { classifyAIToolForApproval } from '@/modules/ai/ai-approval-policy.js';
import { CloudLinkService, normalizeCloudCode } from './cloud-link.service.js';
import type { CloudLinkProbe } from './cloud-link.types.js';
import { cloudAgentSocketUrl, cloudBackoffDelay, cloudRequestAudit } from './cloud-link-agent.js';
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

  it('exposes the cloud connection to agents with the license scopes', () => {
    const status = AI_TOOLS.find((tool) => tool.name === 'get_cloud_status');
    const manage = AI_TOOLS.find((tool) => tool.name === 'manage_cloud');
    expect(status).toMatchObject({ requiredScope: 'license:view', category: 'Maintenance', destructive: false });
    expect(manage).toMatchObject({ requiredScope: 'license:manage', category: 'Maintenance', destructive: true });
    expect(classifyAIToolForApproval('manage_cloud', { operation: 'connect' })).toBe('destructive');
    expect(classifyAIToolForApproval('manage_cloud', { operation: 'disconnect' })).toBe('delete');
    expect(redactArgsForAudit('manage_cloud', { operation: 'connect', code: 'CLD-7K3M-Q9TX' })).toEqual({
      operation: 'connect',
      code: '[REDACTED]',
    });
  });

  it('audits every served request with what was asked and how it was answered', () => {
    const request = { id: 'r9', type: 'logs', params: { service: 'relay', tail: 500, since: '2026-10-11T09:00:00Z' } };
    expect(cloudRequestAudit(request, { id: 'r9', ok: true, data: {} }, 1234, 41.6)).toEqual({
      requestId: 'r9',
      type: 'logs',
      service: 'relay',
      tail: 500,
      since: '2026-10-11T09:00:00Z',
      ok: true,
      resultBytes: 1234,
      durationMs: 42,
    });
    expect(
      cloudRequestAudit({ id: 'r10', type: 'state', params: {} }, { id: 'r10', ok: false, error: 'no host' }, 40, 3)
    ).toEqual({ requestId: 'r10', type: 'state', ok: false, error: 'no host', resultBytes: 40, durationMs: 3 });
  });

  it('audits a failed connect without the code', async () => {
    const log = vi.fn(async () => true);
    const service = new CloudLinkService(
      {} as never,
      {} as never,
      { CLOUD_PORTAL_URL: 'https://account.example.test', APP_VERSION: 'v2.12.0' },
      { getInstallationId: async () => 'installation', getInstallationName: () => 'gw' },
      null
    );
    service.setAuditService({ log });
    await expect(service.connect('not-a-code', { userId: 'user-1' })).rejects.toMatchObject({
      code: 'CLOUD_CODE_INVALID',
    });
    expect(log).toHaveBeenCalledWith({
      userId: 'user-1',
      action: 'cloud.connect',
      resourceType: 'cloud-link',
      details: expect.objectContaining({ success: false, errorCode: 'CLOUD_CODE_INVALID' }),
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('not-a-code');
  });
});
