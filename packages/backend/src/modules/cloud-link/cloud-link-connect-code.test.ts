import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { LicenseServerRequestError, parseConnectCode } from '@/modules/license/license.service.js';
import { CryptoService } from '@/services/crypto.service.js';
import { CloudLinkService } from './cloud-link.service.js';
import { CloudLinkConnectCode } from './cloud-link-connect-code.js';

const CODE = 'K7M3-Q9TX';
const ENROLLED = {
  agentId: 'agent-0001-abcd',
  secret: 'secret_abcdefghijklmnopqrstuvwxyz',
  accountEmail: 'owner@example.com',
  portalUrl: 'https://account.example.test',
};

/** Settings rows in memory, enough for the enrolment the link stores and reads. */
function settingsDb() {
  const rows = new Map<string, unknown>();
  const result = () => [...rows].map(([key, value]) => ({ key, value }));
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => result(),
    // biome-ignore lint/suspicious/noThenProperty: a drizzle query is awaited directly
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(result()).then(resolve, reject),
  });
  return {
    rows,
    select: () => chain,
    insert: () => ({
      values: (value: { key: string; value: unknown }) => ({
        onConflictDoUpdate: async () => void rows.set(value.key, value.value),
      }),
    }),
    delete: () => ({ where: async () => undefined }),
  };
}

function portal(answers: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), { status: answer.status });
  });
  return { fetcher, calls };
}

function setup(
  answers: Array<{ status: number; body?: unknown }>,
  options: {
    now?: () => number;
    issue?: () => Promise<{ code: string; expiresAt: string }>;
  } = {}
) {
  const db = settingsDb();
  const { fetcher, calls } = portal(answers);
  const service = new CloudLinkService(
    db as never,
    new CryptoService(randomBytes(32).toString('hex')),
    { CLOUD_PORTAL_URL: 'https://account.example.test', APP_VERSION: 'v2.12.0' },
    { getInstallationId: async () => 'installation-1', getInstallationName: () => 'gw-1' },
    null,
    fetcher as unknown as typeof fetch
  );
  const log = vi.fn(async (_entry: { action: string; details?: unknown }) => true);
  service.setAuditService({ log });
  const license = {
    requestConnectCode: vi.fn(
      options.issue ?? (async () => ({ code: CODE, expiresAt: new Date(Date.now() + 600_000).toISOString() }))
    ),
  };
  const flow = new CloudLinkConnectCode(service, license, null, 5, options.now, () => 0);
  const actions = () =>
    log.mock.calls.map(([entry]) => [entry.action, (entry.details as { outcome?: string }).outcome]);
  return { db, service, flow, calls, log, license, actions };
}

describe('connect with one code started from Gateway', () => {
  it('shows the code, waits while the account has not entered it, then stores the link once', async () => {
    const answers = [{ status: 202, body: { state: 'pending' } }, { status: 202 }, { status: 200, body: ENROLLED }];
    const t = setup(answers);
    const started = await t.flow.start({ userId: 'user-1' });
    expect(started).toMatchObject({ state: 'pending', code: CODE, error: null });

    await vi.waitFor(async () => expect((await t.flow.status()).state).toBe('connected'), { timeout: 2_000 });
    expect(await t.flow.status()).toMatchObject({ state: 'connected', code: null, accountEmail: 'owner@example.com' });
    expect(t.calls).toHaveLength(3);
    expect(t.calls[0]).toEqual({
      url: 'https://account.example.test/api/cloud/claim',
      body: { code: CODE, installationId: 'installation-1', name: 'gw-1', version: 'v2.12.0' },
    });
    expect(await t.service.isEnrolled()).toBe(true);
    expect(await t.service.readCredentials()).toMatchObject({ agentId: ENROLLED.agentId, secret: ENROLLED.secret });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(t.calls).toHaveLength(3);
    expect(t.actions()).toEqual([
      ['cloud.connect_code', 'requested'],
      ['cloud.connect', undefined],
    ]);
    expect(t.log.mock.calls[1]![0]).toMatchObject({ details: { success: true, source: 'connect-code' } });
    expect(JSON.stringify(t.log.mock.calls)).not.toContain(CODE);
    expect(JSON.stringify(t.log.mock.calls)).not.toContain(ENROLLED.secret);

    // Connected: a new code switches accounts, and says which connection it ends.
    const other = { ...ENROLLED, agentId: 'agent-0002-efgh', accountEmail: 'other@example.com' };
    answers.push({ status: 202 }, { status: 200, body: other });
    expect(await t.flow.start({ userId: 'user-1' })).toMatchObject({
      state: 'pending',
      replacesAccount: 'owner@example.com',
    });
    expect(t.log.mock.calls.at(-1)![0]).toMatchObject({
      action: 'cloud.connect_code',
      details: { outcome: 'requested', replacesAccount: 'owner@example.com' },
    });
    await vi.waitFor(async () => expect((await t.flow.status()).accountEmail).toBe('other@example.com'), {
      timeout: 2_000,
    });
    expect(await t.service.readCredentials()).toMatchObject({ agentId: 'agent-0002-efgh' });
  });

  it('backs off while the portal rate limits the claims, and keeps the code', async () => {
    const t = setup([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 200, body: ENROLLED }]);
    await t.flow.start();
    await vi.waitFor(() => expect(t.calls.length).toBeGreaterThanOrEqual(2), { timeout: 2_000 });
    expect((await t.flow.status()).state).toBe('pending');
    await vi.waitFor(async () => expect((await t.flow.status()).state).toBe('connected'), { timeout: 2_000 });
    expect(t.calls).toHaveLength(4);
  });

  it('shows the code the license service issued as XXXX-XXXX', () => {
    const expiresAt = '2026-10-12T10:10:00.000Z';
    expect(parseConnectCode({ code: 'abcd2345', expiresAt })).toEqual({ code: 'ABCD-2345', expiresAt });
    expect(parseConnectCode({ code: 'ABCD-2345', expiresAt })).toEqual({ code: 'ABCD-2345', expiresAt });
    expect(parseConnectCode({ code: 'ABC2345', expiresAt })).toBeNull();
    expect(parseConnectCode({ code: 'ABCD2345' })).toBeNull();
  });

  it('expires with the code and stops asking', async () => {
    let now = Date.now();
    const t = setup([{ status: 202 }], {
      now: () => now,
      issue: async () => ({ code: CODE, expiresAt: new Date(now + 60_000).toISOString() }),
    });
    await t.flow.start();
    await vi.waitFor(() => expect(t.calls.length).toBeGreaterThan(0));
    now += 61_000;
    // Read anywhere, a pending code past its expiry is expired, also before the poller noticed.
    expect(await t.flow.status()).toMatchObject({ state: 'expired', code: null, errorCode: 'CLOUD_CLAIM_EXPIRED' });
    await vi.waitFor(() => expect(t.actions()).toContainEqual(['cloud.connect_code', 'expired']));
    const asked = t.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(t.calls).toHaveLength(asked);
  });

  it.each([
    [404, 'CLOUD_CLAIM_INVALID', 'invalid'],
    [410, 'CLOUD_CLAIM_USED', 'used'],
    [409, 'CLOUD_CLAIM_WRONG_INSTALLATION', 'wrong_installation'],
  ])('stops on HTTP %i (%s) with a clear message', async (status, code, state) => {
    const t = setup([{ status: 202 }, { status, body: { error: { code, message: 'no' } } }]);
    await t.flow.start();
    await vi.waitFor(async () => expect((await t.flow.status()).state).toBe(state), { timeout: 2_000 });
    const view = await t.flow.status();
    expect(view).toMatchObject({ code: null, errorCode: code });
    expect(view.error).toMatch(/code/i);
    expect(t.actions()).toContainEqual(['cloud.connect_code', state]);
    expect(await t.service.isEnrolled()).toBe(false);
    const asked = t.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(t.calls).toHaveLength(asked);
  });

  it('keeps asking while the account cannot be reached, and stops when cancelled', async () => {
    const t = setup([{ status: 503 }]);
    await t.flow.start();
    await vi.waitFor(() => expect(t.calls.length).toBeGreaterThan(2));
    expect((await t.flow.status()).state).toBe('pending');
    expect(await t.flow.cancel({ userId: 'user-1' })).toMatchObject({ state: 'none', code: null });
    const asked = t.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(t.calls.length).toBeLessThanOrEqual(asked + 1);
    expect(t.actions()).toContainEqual(['cloud.connect_code', 'cancelled']);
  });

  it('reports a license service that cannot issue a code, and audits it', async () => {
    const t = setup([], {
      issue: async () => {
        throw new LicenseServerRequestError(503, 'LICENSE_SERVER_UNAVAILABLE', 'License server is unavailable');
      },
    });
    await expect(t.flow.start()).rejects.toMatchObject({ code: 'LICENSE_SERVER_UNAVAILABLE', retryable: true });
    expect(t.actions()).toEqual([['cloud.connect_code', 'request_failed']]);
    expect(t.calls).toHaveLength(0);
  });

  it('keeps a managed installation on its account: no code, connect or disconnect', async () => {
    const t = setup([{ status: 200, body: ENROLLED }]);
    t.db.rows.set('cloud:enrollment', {
      agentId: ENROLLED.agentId,
      secret: 'encrypted',
      portalUrl: ENROLLED.portalUrl,
      accountEmail: ENROLLED.accountEmail,
      enrolledAt: '2026-10-01T00:00:00.000Z',
      managed: true,
    });
    const refused = {
      status: 409,
      code: 'CLOUD_MANAGED',
      message: 'A managed cloud installation stays connected to its account.',
    };
    await expect(t.flow.start({ userId: 'user-1' })).rejects.toMatchObject(refused);
    await expect(t.service.connect('CLD-7K3M-Q9TX', { userId: 'user-1' })).rejects.toMatchObject(refused);
    await expect(t.service.claim(CODE, ENROLLED.portalUrl)).rejects.toMatchObject(refused);
    await expect(t.service.disconnect({ userId: 'user-1' })).rejects.toMatchObject(refused);
    expect(t.license.requestConnectCode).not.toHaveBeenCalled();
    expect(t.calls).toHaveLength(0);
    expect(await t.service.getStatus()).toMatchObject({ state: 'connected', accountEmail: ENROLLED.accountEmail });
    expect(t.actions()).toEqual([
      ['cloud.connect_code', 'refused'],
      ['cloud.connect', undefined],
      ['cloud.disconnect', undefined],
    ]);
    expect(t.log.mock.calls.at(-1)![0]).toMatchObject({ details: { success: false, errorCode: 'CLOUD_MANAGED' } });
  });

  it('keeps the link when the account refuses to disconnect a managed installation', async () => {
    const t = setup([
      { status: 200, body: ENROLLED },
      { status: 409, body: { error: { code: 'MANAGED_INSTALLATION' } } },
    ]);
    await t.service.connect('CLD-7K3M-Q9TX', { userId: 'user-1' });
    const remove = vi.spyOn(t.db, 'delete');
    await expect(t.service.disconnect({ userId: 'user-1' })).rejects.toMatchObject({
      status: 409,
      code: 'CLOUD_MANAGED',
      message: 'A managed cloud installation stays connected to its account.',
    });
    expect(t.calls.at(-1)!.url).toBe('https://account.example.test/api/cloud/agent/disconnect');
    expect(remove).not.toHaveBeenCalled();
    expect(await t.service.readCredentials()).toMatchObject({ agentId: ENROLLED.agentId });
  });
});
