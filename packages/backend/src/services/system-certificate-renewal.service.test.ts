import forge from 'node-forge';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemCertificateRenewalRow } from '@/db/schema/system-certificate-renewals.js';
import {
  certificateFingerprintSha256,
  evaluateCertificateRenewal,
  type RenewalCertificate,
  type RenewalDeliveryResult,
  type ServedCertificateInfo,
  type SystemCertificateRenewalAdapter,
  SystemCertificateRenewalService,
  type SystemCertificateRenewalStateStore,
  type SystemCertificateRenewalTarget,
} from './system-certificate-renewal.service.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2027, 8, 1);
const keys = forge.pki.rsa.generateKeyPair(1024);
let serial = 1000;

function leaf(options: {
  issuedDaysAgo: number;
  lifetimeDays?: number;
  sans?: string[];
  caId?: string;
}): RenewalCertificate {
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  serial += 1;
  certificate.serialNumber = serial.toString(16);
  const notBefore = new Date(NOW - options.issuedDaysAgo * DAY);
  const notAfter = new Date(notBefore.getTime() + (options.lifetimeDays ?? 365) * DAY);
  certificate.validity.notBefore = notBefore;
  certificate.validity.notAfter = notAfter;
  certificate.setSubject([{ name: 'commonName', value: `leaf-${serial}` }]);
  certificate.setIssuer([{ name: 'commonName', value: 'storage-ca' }]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  return {
    id: `certificate-${serial}`,
    serialNumber: serial.toString(16),
    caId: options.caId ?? 'ca-1',
    notBefore,
    notAfter,
    sans: options.sans ?? ['10.0.0.5', 'localhost', '127.0.0.1'],
    certificatePem: forge.pki.certificateToPem(certificate),
  };
}

function served(certificate: RenewalCertificate, names = certificate.sans): ServedCertificateInfo {
  return {
    fingerprintSha256: certificateFingerprintSha256(certificate.certificatePem),
    dnsNames: names.filter((name) => !/^\d/.test(name)),
    ipAddresses: names.filter((name) => /^\d/.test(name)),
  };
}

class MemoryStore implements SystemCertificateRenewalStateStore {
  rows = new Map<string, SystemCertificateRenewalRow>();
  async load(ownerType: string, ownerId: string) {
    return this.rows.get(`${ownerType}:${ownerId}`) ?? null;
  }
  async save(ownerType: string, ownerId: string, patch: Partial<SystemCertificateRenewalRow>, now: Date) {
    const key = `${ownerType}:${ownerId}`;
    const previous = this.rows.get(key) ?? {
      ownerType,
      ownerId,
      state: 'idle',
      reason: null,
      pendingCertificateId: null,
      pendingSerial: null,
      attempts: 0,
      lastAttemptAt: null,
      nextAttemptAt: null,
      deliveredAt: null,
      lastSuccessAt: null,
      lastError: null,
      servedFingerprint: null,
      lastMethod: null,
      lastRestarted: false,
      createdAt: now,
      updatedAt: now,
    };
    const next = { ...previous } as Record<string, unknown>;
    for (const [field, value] of Object.entries(patch)) if (value !== undefined) next[field] = value;
    this.rows.set(key, { ...(next as SystemCertificateRenewalRow), updatedAt: now });
  }
  async list(ownerType: string) {
    return [...this.rows.values()].filter((row) => row.ownerType === ownerType);
  }
  async delete(ownerType: string, ownerId: string) {
    this.rows.delete(`${ownerType}:${ownerId}`);
  }
}

interface Harness {
  service: SystemCertificateRenewalService;
  adapter: SystemCertificateRenewalAdapter & {
    issuePending: ReturnType<typeof vi.fn>;
    deliver: ReturnType<typeof vi.fn>;
    probe: ReturnType<typeof vi.fn>;
    promote: ReturnType<typeof vi.fn>;
    fallback: ReturnType<typeof vi.fn>;
    findPending: ReturnType<typeof vi.fn>;
  };
  target: SystemCertificateRenewalTarget;
  store: MemoryStore;
  audit: { log: ReturnType<typeof vi.fn> };
  events: { publish: ReturnType<typeof vi.fn> };
  clock: { now: number };
  pending: RenewalCertificate;
  scheduled: Array<{ task: () => void; delayMs: number }>;
}

function harness(overrides: Partial<SystemCertificateRenewalTarget> = {}): Harness {
  const clock = { now: NOW };
  const store = new MemoryStore();
  const audit = { log: vi.fn().mockResolvedValue(true) };
  const events = { publish: vi.fn() };
  const pending = leaf({ issuedDaysAgo: 0 });
  const target: SystemCertificateRenewalTarget = {
    ownerType: 'managed_storage',
    ownerId: 'cluster-1',
    name: 'Backups',
    resourceType: 'managed_storage_cluster',
    current: leaf({ issuedDaysAgo: 250 }),
    expectedCaId: 'ca-1',
    requiredSans: ['10.0.0.5', 'localhost', '127.0.0.1'],
    supportsHotReload: true,
    ...overrides,
  };
  const adapter = {
    ownerType: 'managed_storage' as const,
    listTargets: vi.fn(async () => [target]),
    getTarget: vi.fn(async () => target),
    issuePending: vi.fn(async () => pending),
    findPending: vi.fn(async () => null),
    deliver: vi.fn(
      async (): Promise<RenewalDeliveryResult> => ({
        status: 'reloaded',
        servedFingerprint: certificateFingerprintSha256(pending.certificatePem),
        restarted: false,
        method: 'file_watch',
      })
    ),
    probe: vi.fn(async () => served(target.current!)),
    promote: vi.fn(async () => undefined),
    fallback: vi.fn(async () => undefined),
  };
  const scheduled: Harness['scheduled'] = [];
  const service = new SystemCertificateRenewalService({} as never, {
    audit,
    eventBus: events,
    store,
    now: () => new Date(clock.now),
    schedule: (task, delayMs) => scheduled.push({ task, delayMs }),
  });
  service.registerAdapter(adapter);
  return { service, adapter, target, store, audit, events, clock, pending, scheduled };
}

describe('evaluateCertificateRenewal', () => {
  const desired = { requiredSans: ['10.0.0.5', 'localhost', '127.0.0.1'], expectedCaId: 'ca-1' };
  const now = new Date(NOW);

  it('leaves a fresh certificate alone', () => {
    expect(evaluateCertificateRenewal(leaf({ issuedDaysAgo: 30 }), desired, now)).toMatchObject({
      due: false,
      reason: null,
      urgent: false,
    });
  });

  it('renews once two thirds of the lifetime passed', () => {
    expect(evaluateCertificateRenewal(leaf({ issuedDaysAgo: 244 }), desired, now)).toMatchObject({
      due: true,
      reason: 'lifetime',
    });
    expect(evaluateCertificateRenewal(leaf({ issuedDaysAgo: 242 }), desired, now).due).toBe(false);
  });

  it('renews a short-lived certificate 30 days before expiry and marks the last week urgent', () => {
    // 25 days left: expiring wins over the lifetime rule; 5 days left is urgent.
    expect(evaluateCertificateRenewal(leaf({ issuedDaysAgo: 340 }), desired, now)).toMatchObject({
      due: true,
      reason: 'expiring',
      urgent: false,
      daysRemaining: 25,
    });
    expect(evaluateCertificateRenewal(leaf({ issuedDaysAgo: 360 }), desired, now)).toMatchObject({
      reason: 'expiring',
      urgent: true,
    });
  });

  it('renews a set member leaf without clientAuth (issued while the database ran on one server)', () => {
    const member = { ...desired, requiredExtKeyUsage: ['serverAuth', 'clientAuth'] };
    expect(
      evaluateCertificateRenewal({ ...leaf({ issuedDaysAgo: 10 }), extKeyUsage: ['serverAuth'] }, member, now)
    ).toMatchObject({ due: true, reason: 'usage_missing' });
    expect(
      evaluateCertificateRenewal(
        { ...leaf({ issuedDaysAgo: 10 }), extKeyUsage: ['serverAuth', 'clientAuth'] },
        member,
        now
      ).due
    ).toBe(false);
    // A single-node database requires no client usage.
    expect(
      evaluateCertificateRenewal({ ...leaf({ issuedDaysAgo: 10 }), extKeyUsage: ['serverAuth'] }, desired, now).due
    ).toBe(false);
  });

  it('renews when a required name is missing (pre-rc.8 storage without loopback names)', () => {
    const result = evaluateCertificateRenewal(leaf({ issuedDaysAgo: 10, sans: ['10.0.0.5'] }), desired, now);
    expect(result).toMatchObject({ due: true, reason: 'names_missing', urgent: false });
    expect(result.missingNames).toEqual(['localhost', '127.0.0.1']);
  });

  it('renews a certificate issued by an older CA', () => {
    expect(evaluateCertificateRenewal(leaf({ issuedDaysAgo: 10, caId: 'ca-0' }), desired, now)).toMatchObject({
      due: true,
      reason: 'ca_changed',
    });
  });
});

describe('SystemCertificateRenewalService', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('delivers a due certificate without a restart, verifies the served leaf, then promotes it', async () => {
    const summary = await h.service.renewDue();

    expect(summary.renewed).toBe(1);
    expect(h.adapter.issuePending).toHaveBeenCalledWith(h.target);
    expect(h.adapter.deliver).toHaveBeenCalledWith(h.target, h.pending, { allowRestart: false });
    expect(h.adapter.promote).toHaveBeenCalledWith(h.target, h.pending);
    expect(h.adapter.fallback).not.toHaveBeenCalled();
    expect(h.adapter.deliver.mock.invocationCallOrder[0]).toBeLessThan(h.adapter.promote.mock.invocationCallOrder[0]!);
    expect(await h.store.load('managed_storage', 'cluster-1')).toMatchObject({ state: 'idle', lastError: null });
  });

  it('does not promote a leaf the workload does not serve', async () => {
    h.adapter.deliver.mockResolvedValueOnce({
      status: 'reloaded',
      servedFingerprint: 'something-else',
      restarted: false,
      method: 'sighup',
    });
    const summary = await h.service.renewDue();
    expect(summary.failed).toBe(1);
    expect(h.adapter.promote).not.toHaveBeenCalled();
  });

  it('leaves a certificate that is not due alone and checks the served leaf still matches', async () => {
    h = harness({ current: leaf({ issuedDaysAgo: 20 }) });
    const summary = await h.service.renewDue();
    expect(summary.not_due).toBe(1);
    expect(h.adapter.issuePending).not.toHaveBeenCalled();
    expect(h.adapter.deliver).not.toHaveBeenCalled();
    expect(h.adapter.probe).toHaveBeenCalledTimes(1);
  });

  it('redelivers the current certificate when the workload serves another one', async () => {
    const current = leaf({ issuedDaysAgo: 20 });
    h = harness({ current });
    h.adapter.probe.mockResolvedValueOnce(served(leaf({ issuedDaysAgo: 400 })));
    h.adapter.deliver.mockResolvedValueOnce({
      status: 'reloaded',
      servedFingerprint: certificateFingerprintSha256(current.certificatePem),
      restarted: false,
      method: 'sighup',
    });
    expect((await h.service.renewDue()).redelivered).toBe(1);
    expect(h.adapter.deliver).toHaveBeenCalledWith(h.target, current, { allowRestart: false });
    expect(h.adapter.promote).not.toHaveBeenCalled();
  });

  it('promotes a staged leaf the workload already serves', async () => {
    h = harness({ current: leaf({ issuedDaysAgo: 20 }) });
    const staged = leaf({ issuedDaysAgo: 0 });
    h.adapter.probe.mockResolvedValueOnce(served(staged));
    h.adapter.findPending.mockResolvedValueOnce(staged);
    expect((await h.service.renewDue()).renewed).toBe(1);
    expect(h.adapter.promote).toHaveBeenCalledWith(h.target, staged);
    expect(h.adapter.deliver).not.toHaveBeenCalled();
  });

  it('keeps a delivered leaf pending until the engine rereads it, redelivering the same serial', async () => {
    h.adapter.deliver.mockResolvedValueOnce({
      status: 'pending',
      servedFingerprint: certificateFingerprintSha256(h.target.current!.certificatePem),
      restarted: false,
      method: 'file_watch',
      reloadIntervalSeconds: 5 * 60 * 60,
    });
    expect((await h.service.renewDue()).awaiting_reload).toBe(1);
    expect(h.adapter.promote).not.toHaveBeenCalled();
    const awaiting = await h.store.load('managed_storage', 'cluster-1');
    expect(awaiting).toMatchObject({
      state: 'awaiting_reload',
      pendingSerial: h.pending.serialNumber,
      lastError: null,
    });
    expect(awaiting?.nextAttemptAt?.getTime()).toBe(NOW + HOUR);

    // Still waiting inside the recheck window: nothing is sent again.
    h.clock.now += 30 * 60 * 1000;
    expect((await h.service.renewDue()).backoff).toBe(1);
    expect(h.adapter.deliver).toHaveBeenCalledTimes(1);

    h.clock.now += HOUR;
    expect((await h.service.renewDue()).renewed).toBe(1);
    expect(h.adapter.issuePending).toHaveBeenCalledTimes(2);
    expect(h.adapter.deliver).toHaveBeenLastCalledWith(h.target, h.pending, { allowRestart: false });
    expect(h.adapter.promote).toHaveBeenCalledWith(h.target, h.pending);
  });

  it('treats a delivery the engine never loads as a failure after six hours', async () => {
    h.adapter.deliver.mockResolvedValue({
      status: 'pending',
      servedFingerprint: 'old',
      restarted: false,
      method: 'file_watch',
      reloadIntervalSeconds: 60,
    });
    await h.service.renewDue();
    h.clock.now += 7 * HOUR;
    expect((await h.service.renewDue()).failed).toBe(1);
    expect((await h.store.load('managed_storage', 'cluster-1'))?.lastError).toMatch(/still serves the previous one/);
  });

  it('records a failed attempt, alerts, and retries after a backoff with the same staged leaf', async () => {
    h.adapter.deliver.mockRejectedValue(new Error('node daemon unavailable'));
    expect((await h.service.renewDue()).failed).toBe(1);
    let state = await h.store.load('managed_storage', 'cluster-1');
    expect(state).toMatchObject({ state: 'failed', attempts: 1, lastError: 'node daemon unavailable' });
    expect(h.events.publish).toHaveBeenCalledWith(
      'system-certificate.renewal',
      expect.objectContaining({ action: 'renewal_failed' })
    );

    h.clock.now += 30 * 60 * 1000;
    expect((await h.service.renewDue()).backoff).toBe(1);
    expect(h.adapter.deliver).toHaveBeenCalledTimes(1);

    h.clock.now += HOUR;
    await h.service.renewDue();
    state = await h.store.load('managed_storage', 'cluster-1');
    expect(state).toMatchObject({ attempts: 2 });
    expect(h.adapter.deliver).toHaveBeenCalledTimes(2);
    // Every retry reuses the same staged leaf.
    expect(h.adapter.deliver).toHaveBeenLastCalledWith(h.target, h.pending, { allowRestart: false });

    // The engine recovers: the next retry promotes the leaf.
    h.adapter.deliver.mockResolvedValue({
      status: 'reloaded',
      servedFingerprint: certificateFingerprintSha256(h.pending.certificatePem),
      restarted: false,
      method: 'file_watch',
    });
    h.clock.now += 2 * HOUR + 60_000;
    expect((await h.service.renewDue()).renewed).toBe(1);
    expect(h.adapter.promote).toHaveBeenCalledWith(h.target, h.pending);
    expect(await h.store.load('managed_storage', 'cluster-1')).toMatchObject({ state: 'idle', lastError: null });
  });

  it('allows a restart once seven days or fewer remain', async () => {
    h = harness({ current: leaf({ issuedDaysAgo: 360 }) });
    await h.service.renewDue();
    expect(h.adapter.deliver).toHaveBeenCalledWith(h.target, h.pending, { allowRestart: true });
  });

  it('waits for the daemon update instead of restarting while more than seven days remain', async () => {
    h = harness({ supportsHotReload: false });
    expect((await h.service.renewDue()).waiting_for_daemon).toBe(1);
    expect(h.adapter.issuePending).not.toHaveBeenCalled();
    expect(h.adapter.fallback).not.toHaveBeenCalled();
    expect(await h.store.load('managed_storage', 'cluster-1')).toMatchObject({
      state: 'waiting_for_daemon',
      lastError: expect.stringMatching(/daemon/),
    });
  });

  it('falls back to a restart or recreate when the daemon cannot reload and expiry is near', async () => {
    h = harness({ supportsHotReload: false, current: leaf({ issuedDaysAgo: 360 }) });
    // The update carrying the pending leaf succeeded and its hook promoted it.
    h.adapter.fallback.mockImplementation(async () => {
      h.target.current = h.pending;
    });
    expect((await h.service.renewDue()).renewed).toBe(1);
    expect(h.adapter.fallback).toHaveBeenCalledWith(h.target, h.pending);
    expect(h.adapter.deliver).not.toHaveBeenCalled();
    expect(await h.store.load('managed_storage', 'cluster-1')).toMatchObject({
      state: 'idle',
      lastMethod: 'fallback_restart',
      lastRestarted: true,
    });
  });

  it('keeps the leaf pending when the fallback update did not make it current', async () => {
    h = harness({ supportsHotReload: false, current: leaf({ issuedDaysAgo: 360 }) });
    // The update returned, but its success hook never promoted the leaf.
    expect((await h.service.renewDue()).failed).toBe(1);
    expect(h.adapter.promote).not.toHaveBeenCalled();
    expect(await h.store.load('managed_storage', 'cluster-1')).toMatchObject({
      state: 'failed',
      pendingSerial: h.pending.serialNumber,
      lastError: expect.stringMatching(/stays pending/),
    });
  });

  describe('ensureNamesServed (backups)', () => {
    it('checks the served certificate, not the database row, and starts the repair', async () => {
      // The database already names the loopback identities (issued before the
      // daemon had it), but the cluster still serves the old leaf.
      const current = leaf({ issuedDaysAgo: 20 });
      h = harness({ current });
      h.adapter.probe.mockResolvedValue(served(current, ['10.0.0.5']));
      const readiness = await h.service.ensureNamesServed('managed_storage', 'cluster-1', ['localhost', '127.0.0.1']);
      expect(readiness).toMatchObject({ ready: false, reason: 'renewing' });
      await vi.waitFor(() => expect(h.adapter.promote).toHaveBeenCalled());
      expect(h.adapter.deliver).toHaveBeenCalledWith(h.target, h.pending, { allowRestart: false });
    });
  });
});

describe('certificate attention summary', () => {
  it('lists failed, waiting and soon-expiring certificates and leaves healthy ones out', async () => {
    const h = harness();
    expect(await h.service.listAttention()).toEqual([]);

    const expiring = harness({ current: leaf({ issuedDaysAgo: 360 }) });
    expect(await expiring.service.listAttention()).toEqual([
      expect.objectContaining({
        ownerType: 'managed_storage',
        ownerId: 'cluster-1',
        reason: 'expiring',
        daysRemaining: 5,
      }),
    ]);

    const failed = harness();
    await failed.store.save(
      'managed_storage',
      'cluster-1',
      { state: 'failed', lastError: 'daemon offline' },
      new Date(NOW)
    );
    expect(await failed.service.listAttention()).toEqual([expect.objectContaining({ reason: 'renewal_failed' })]);
  });
});
