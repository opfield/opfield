import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { redactArgsForAudit } from '@/modules/ai/ai.service.tool-helpers.js';
import { AI_TOOLS } from '@/modules/ai/ai.tools.js';
import { classifyAIToolForApproval } from '@/modules/ai/ai-approval-policy.js';
import { CloudLinkService, normalizeCloudCode } from './cloud-link.service.js';
import type { CloudLinkAccess, CloudLinkProbe, CloudRequest } from './cloud-link.types.js';
import { CloudLinkAgent, cloudAgentSocketUrl, cloudBackoffDelay, cloudRequestAudit } from './cloud-link-agent.js';
import { answerCloudRequest, parseCloudRequest } from './cloud-link-requests.js';

const managed: CloudLinkAccess = { privilegedAllowed: async () => true, managedByCloud: async () => true };
const allowed: CloudLinkAccess = { privilegedAllowed: async () => true, managedByCloud: async () => false };
const denied: CloudLinkAccess = { privilegedAllowed: async () => false, managedByCloud: async () => false };
const ask = (probe: CloudLinkProbe, request: CloudRequest, access: CloudLinkAccess = allowed) =>
  answerCloudRequest(probe, request, access);

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
      setupLink: async () => {
        throw new Error('already set up');
      },
      nodeToken: async ({ name }) => ({
        token: 'gwn_token',
        expiresAt: '2026-10-12T10:00:00Z',
        command: `curl … ${name ?? 'Node'}`,
        nodeId: 'n1',
        kind: 'nginx',
      }),
      updateStatus: async () => ({
        current: 'v2.11.4',
        latest: 'v2.11.5',
        channel: 'stable',
        available: true,
        updating: false,
      }),
      update: async (version) => ({ started: true, version: version ?? 'v2.11.5' }),
      ssoSecret: async () => ({ saved: true }),
      ssoClient: async () => ({ saved: true, applied: true }),
      ssoRevoke: async () => ({ revoked: [], unknown: [] }),
    };

    const request = parseCloudRequest(
      JSON.stringify({ id: 'r1', type: 'logs', params: { service: 'app', tail: 5000 } })
    );
    expect(request).not.toBeNull();
    await expect(ask(probe, request!)).resolves.toEqual({
      id: 'r1',
      ok: true,
      data: { service: 'app', lines: [{ t: '2026-10-11T10:00:00Z', stream: 'stdout', line: 'ready' }] },
    });
    expect(logs).toHaveBeenCalledWith('app', { tail: 2000 });

    await expect(ask(probe, { id: 'r2', type: 'services', params: {} })).resolves.toEqual({
      id: 'r2',
      ok: true,
      data: { services: ['app', 'postgres'] },
    });
    await expect(ask(probe, { id: 'r3', type: 'state', params: {} })).resolves.toEqual({
      id: 'r3',
      ok: false,
      error: 'Host readings are not available here',
    });
    await expect(
      ask(probe, { id: 'r4', type: 'logs', params: { service: 'app', since: 'yesterday' } })
    ).resolves.toMatchObject({ id: 'r4', ok: false });
    await expect(ask(probe, { id: 'r5', type: 'shell', params: {} })).resolves.toMatchObject({
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

  it('answers the setup-link, node-token, update-status and update requests', async () => {
    const probe = {
      setupLink: async () => {
        throw new Error('already set up');
      },
      nodeToken: vi.fn(async ({ name, kind }: { name?: string; kind?: string }) => ({
        token: 'gwn_token',
        expiresAt: '2026-10-12T10:00:00Z',
        command: `curl -fsSL … --name ${name ?? 'Node'}`,
        nodeId: 'n1',
        kind: kind ?? 'nginx',
      })),
      updateStatus: async () => ({
        current: 'v2.11.4',
        latest: 'v2.11.5',
        channel: 'stable',
        available: true,
        updating: false,
      }),
      update: vi.fn(async (version?: string) => ({ started: true as const, version: version ?? 'v2.11.5' })),
    } as unknown as CloudLinkProbe;
    await expect(ask(probe, { id: 's', type: 'setup-link', params: {} })).resolves.toEqual({
      id: 's',
      ok: false,
      error: 'already set up',
    });
    await expect(ask(probe, { id: 'n', type: 'node-token', params: { name: 'edge-1' } })).resolves.toEqual({
      id: 'n',
      ok: true,
      data: {
        token: 'gwn_token',
        expiresAt: '2026-10-12T10:00:00Z',
        command: 'curl -fsSL … --name edge-1',
        kind: 'nginx',
      },
    });
    await expect(ask(probe, { id: 'n2', type: 'node-token', params: { kind: 'databases' } })).resolves.toMatchObject({
      ok: true,
      data: { kind: 'storage' },
    });
    await expect(ask(probe, { id: 'n3', type: 'node-token', params: { kind: 'bastion' } })).resolves.toMatchObject({
      ok: false,
    });
    await expect(ask(probe, { id: 'n4', type: 'node-token', params: { kind: 'relay' } })).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      ask(probe, {
        id: 'n5',
        type: 'node-token',
        params: { kind: 'relay', address: 'relay.example.test', port: 9443 },
      })
    ).resolves.toMatchObject({ ok: true, data: { kind: 'relay' } });
    expect(probe.nodeToken).toHaveBeenLastCalledWith({ kind: 'relay', address: 'relay.example.test', port: 9443 });
    await expect(ask(probe, { id: 'u', type: 'update-status', params: {} })).resolves.toMatchObject({
      ok: true,
      data: { current: 'v2.11.4', latest: 'v2.11.5', available: true, updating: false },
    });
    await expect(ask(probe, { id: 'p', type: 'update', params: {} })).resolves.toEqual({
      id: 'p',
      ok: true,
      data: { started: true },
    });
    await expect(ask(probe, { id: 'q', type: 'update', params: { version: 5 } })).resolves.toMatchObject({ ok: false });
  });

  it('reports remote management and a sign-in client request in the hello, and sends it again when they change', async () => {
    const service = new CloudLinkService(
      {} as never,
      {} as never,
      { CLOUD_PORTAL_URL: 'https://account.example.test', APP_VERSION: 'v2.12.0' },
      { getInstallationId: async () => 'installation', getInstallationName: () => 'gw' },
      null
    );
    let allowedNow = false;
    let pending: { redirectUri: string; requestedAt: string } | null = null;
    vi.spyOn(service, 'privilegedAllowed').mockImplementation(async () => allowedNow);
    vi.spyOn(service, 'pendingSsoClientRequest').mockImplementation(async () => pending);
    const first = await service.helloInfo();
    expect(first).toEqual({
      installationId: 'installation',
      name: 'gw',
      version: 'v2.12.0',
      remoteManagement: false,
      ssoRevoke: true,
    });

    const agent = new CloudLinkAgent(service, {} as never, {} as never);
    const send = vi.fn();
    const internals = agent as unknown as {
      socket: unknown;
      helloSent: string | null;
      refreshHello: () => Promise<void>;
    };
    internals.socket = { readyState: 1, send };
    internals.helloSent = JSON.stringify(first);
    await internals.refreshHello();
    expect(send).not.toHaveBeenCalled();
    allowedNow = true;
    await internals.refreshHello();
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0][0])).toMatchObject({ type: 'hello', remoteManagement: true });

    // Use Opfield account for sign-in asked for a client: every hello carries the request until it is answered.
    pending = { redirectUri: 'https://gw.example.test/auth/callback', requestedAt: '2026-10-13T10:00:00.000Z' };
    await internals.refreshHello();
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(send.mock.calls[1][0])).toMatchObject({
      type: 'hello',
      ssoClientRequest: { redirectUri: 'https://gw.example.test/auth/callback' },
    });
    await internals.refreshHello();
    expect(send).toHaveBeenCalledTimes(2);
    pending = null;
    await internals.refreshHello();
    expect(send).toHaveBeenCalledTimes(3);
    expect(JSON.parse(send.mock.calls[2][0])).not.toHaveProperty('ssoClientRequest');
  });

  it('refuses privileged requests while remote management is off, and still answers reads', async () => {
    const nodeToken = vi.fn();
    const update = vi.fn();
    const setupLink = vi.fn();
    const probe = {
      services: async () => ['app'],
      updateStatus: async () => ({ current: 'v1', latest: null, channel: 'stable', available: false, updating: false }),
      nodeToken,
      update,
      setupLink,
    } as unknown as CloudLinkProbe;
    for (const type of ['node-token', 'update', 'setup-link']) {
      await expect(ask(probe, { id: type, type, params: {} }, denied)).resolves.toEqual({
        id: type,
        ok: false,
        code: 'REMOTE_MANAGEMENT_OFF',
        error: 'Remote management is off on this installation',
      });
    }
    expect(nodeToken).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(setupLink).not.toHaveBeenCalled();
    await expect(ask(probe, { id: 's', type: 'services', params: {} }, denied)).resolves.toMatchObject({ ok: true });
    await expect(ask(probe, { id: 'u', type: 'update-status', params: {} }, denied)).resolves.toMatchObject({
      ok: true,
    });
    expect(
      cloudRequestAudit(
        { id: 'x', type: 'update', params: {} },
        { id: 'x', ok: false, code: 'REMOTE_MANAGEMENT_OFF', error: 'Remote management is off on this installation' },
        90,
        1
      )
    ).toMatchObject({ ok: false, errorCode: 'REMOTE_MANAGEMENT_OFF' });
  });

  it('passes a new sign-in client secret to the installation without remote management, and never echoes or audits it', async () => {
    const SECRET = 'portal-secret-6f1d2c';
    const ssoSecret = vi.fn(async (secret: string) => {
      if (secret === 'fails') throw new Error(`could not store ${secret}`);
      if (secret === 'removed') {
        throw new AppError(409, 'OPFIELD_ACCOUNT_PROVIDER_MISSING', 'Sign-in with the Opfield account is not in use');
      }
      return { saved: true as const };
    });
    const probe = { ssoSecret } as unknown as CloudLinkProbe;
    const request = { id: 'k', type: 'sso-secret', params: { clientSecret: SECRET } };
    // The installation decides (a client the account gave it); remote management is not needed.
    await expect(ask(probe, request, denied)).resolves.toMatchObject({ ok: true });
    const answer = await ask(probe, request, managed);
    expect(answer).toEqual({ id: 'k', ok: true, data: { saved: true } });
    expect(ssoSecret).toHaveBeenCalledWith(SECRET);
    await expect(ask(probe, { id: 'e', type: 'sso-secret', params: {} }, managed)).resolves.toMatchObject({
      ok: false,
    });
    const failed = await ask(probe, { id: 'f', type: 'sso-secret', params: { clientSecret: 'fails' } }, managed);
    expect(failed).toEqual({ id: 'f', ok: false, error: 'could not store [REDACTED]' });
    // The admin removed the Opfield account provider or chose another client: a clean refusal with its code.
    await expect(
      ask(probe, { id: 'g', type: 'sso-secret', params: { clientSecret: 'removed' } }, managed)
    ).resolves.toEqual({
      id: 'g',
      ok: false,
      code: 'OPFIELD_ACCOUNT_PROVIDER_MISSING',
      error: 'Sign-in with the Opfield account is not in use',
    });
    const audit = cloudRequestAudit(request, answer, 20, 1);
    expect(JSON.stringify(audit)).not.toContain(SECRET);
    expect(audit).toMatchObject({ type: 'sso-secret', ok: true });
  });

  it('takes a sign-in client only through the installation, with a coded refusal and never the secret', async () => {
    const SECRET = 'client-secret-7c2e';
    const ssoClient = vi.fn(async (client: { clientSecret: string; redirectUri: string }) => {
      if (client.redirectUri.includes('other')) {
        throw new AppError(409, 'SSO_CLIENT_NOT_REQUESTED', `not asked for ${client.clientSecret}`);
      }
      return { saved: true as const, applied: true };
    });
    const probe = { ssoClient } as unknown as CloudLinkProbe;
    const params = {
      issuer: 'https://account.example.test',
      clientId: 'gw-self',
      clientSecret: SECRET,
      redirectUri: 'https://gw.example.test/auth/callback',
    };
    const request = { id: 'c', type: 'sso-client', params };
    // An answer to the installation's own request: no remote management needed.
    const answer = await ask(probe, request, denied);
    expect(answer).toEqual({ id: 'c', ok: true, data: { saved: true, applied: true } });
    expect(ssoClient).toHaveBeenCalledWith(params);
    await expect(
      ask(probe, { id: 'd', type: 'sso-client', params: { ...params, clientSecret: '' } }, denied)
    ).resolves.toMatchObject({ ok: false, code: 'INVALID_SSO_CLIENT' });
    const refused = await ask(
      probe,
      { id: 'e', type: 'sso-client', params: { ...params, redirectUri: 'https://other.example.test/cb' } },
      denied
    );
    expect(refused).toEqual({
      id: 'e',
      ok: false,
      code: 'SSO_CLIENT_NOT_REQUESTED',
      error: 'not asked for [REDACTED]',
    });
    const audit = cloudRequestAudit(request, answer, 30, 1);
    expect(audit).toMatchObject({ type: 'sso-client', clientId: 'gw-self', ok: true });
    expect(JSON.stringify(audit)).not.toContain(SECRET);
    expect(JSON.stringify(cloudRequestAudit(request, refused, 0, 1))).not.toContain(SECRET);
  });

  it('removes access of Opfield accounts without remote management, validates the request and never echoes a subject', async () => {
    const ssoRevoke = vi.fn(async (input: { subjects: string[] }) => {
      if (input.subjects.includes('fails')) throw new Error('could not block ada@example.com');
      return { revoked: [{ sub: input.subjects[0]!, userId: 'u1' }], unknown: input.subjects.slice(1) };
    });
    const probe = { ssoRevoke } as unknown as CloudLinkProbe;
    const params = {
      issuer: 'https://account.example.test',
      subjects: ['0b6f1a52-6a51-4c5e-9d8e-0f3f4a2b7c11', '3e904d85-9d84-4f81-a0b1-3c6c7d5eaf44'],
      reason: 'removed_from_team',
    };
    // Only removes access: no remote management needed.
    const answer = await ask(probe, { id: 'v', type: 'sso-revoke', params }, denied);
    expect(answer).toEqual({
      id: 'v',
      ok: true,
      data: {
        revoked: [{ sub: params.subjects[0], userId: 'u1' }],
        unknown: [params.subjects[1]],
      },
    });
    expect(ssoRevoke).toHaveBeenCalledWith(params);

    const invalid = [
      { ...params, issuer: '' },
      { ...params, issuer: 'not a url' },
      { ...params, issuer: 'ftp://account.example.test' },
      { ...params, subjects: [] },
      { ...params, subjects: 'one' },
      { ...params, subjects: ['ok', 7] },
      { ...params, subjects: [' padded@example.com '] },
      { ...params, subjects: Array.from({ length: 501 }, (_, i) => `s${i}`) },
      { ...params, reason: 'because' },
      { issuer: params.issuer, subjects: params.subjects },
    ];
    for (const bad of invalid) {
      const refused = await ask(probe, { id: 'w', type: 'sso-revoke', params: bad }, denied);
      expect(refused).toMatchObject({ id: 'w', ok: false, code: 'INVALID_SSO_REVOKE' });
      expect(JSON.stringify(refused)).not.toContain('@');
    }
    expect(ssoRevoke).toHaveBeenCalledTimes(1);
    await expect(
      ask(probe, { id: 'x', type: 'sso-revoke', params: { ...params, subjects: Array(500).fill('a') } }, denied)
    ).resolves.toMatchObject({ ok: true });

    // A failure never carries what the error said (it could name a person).
    const failed = await ask(
      probe,
      { id: 'y', type: 'sso-revoke', params: { ...params, subjects: ['fails'] } },
      denied
    );
    expect(failed).toEqual({ id: 'y', ok: false, error: 'The installation could not remove the access' });
    expect(cloudRequestAudit({ id: 'v', type: 'sso-revoke', params }, answer, 10, 1)).toMatchObject({
      type: 'sso-revoke',
      ok: true,
    });
  });
});
