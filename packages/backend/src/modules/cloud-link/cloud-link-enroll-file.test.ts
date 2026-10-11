import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationLeaseStore } from '@/db/operation-lease.js';
import { LicenseServerRequestError } from '@/modules/license/license.service.js';
import { CloudLinkRequestError, type CloudLinkService } from './cloud-link.service.js';
import {
  CloudLinkEnrollFile,
  createEnrollFileLicense,
  type EnrollFileLicense,
  type EnrollFileSso,
} from './cloud-link-enroll-file.js';

const KEY = 'WLT-GW-AAAA-BBBB-CCCC-DDDD';
const leases = {
  claim: vi.fn(async () => ({ acquired: true as const, token: 't', claimedAt: 0 })),
  release: vi.fn(async () => undefined),
} as unknown as OperationLeaseStore;

describe('cloud enrolment file', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cloud-enroll-'));
    path = join(dir, 'cloud-enroll.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function service(connect: (...args: unknown[]) => Promise<unknown>, enrolled = false) {
    let isEnrolled = enrolled;
    return {
      isEnrolled: vi.fn(async () => isEnrolled),
      connect: vi.fn(async (...args: unknown[]) => {
        const result = await connect(...args);
        isEnrolled = true;
        return result;
      }),
      recordEnrollFileEvent: vi.fn(async (_details: Record<string, unknown>) => undefined),
      recordLicenseActivation: vi.fn(async (_details: Record<string, unknown>) => undefined),
      recordManagedSso: vi.fn(async (_details: Record<string, unknown>) => undefined),
    };
  }

  function license(activate: () => Promise<{ plan: string; moduleRestarting: boolean | null }>): EnrollFileLicense {
    let active = false;
    return {
      isActive: vi.fn(async () => active),
      activate: vi.fn(async () => {
        const result = await activate();
        active = true;
        return result;
      }),
      isRetryable: createEnrollFileLicense({} as never, {} as never).isRetryable,
    };
  }

  const exists = (file: string) =>
    readFile(file).then(
      () => true,
      () => false
    );

  it('enrols, activates the key, and only then removes the file; the key is never audited', async () => {
    await writeFile(
      path,
      JSON.stringify({ code: 'CLD-7K3M-Q9TX', portalUrl: 'https://account.example.test', licenseKey: KEY })
    );
    const fake = service(async () => ({}));
    const keys = license(async () => ({ plan: 'business', moduleRestarting: true }));
    const runner = new CloudLinkEnrollFile(fake as unknown as CloudLinkService, leases, keys, path);
    await expect(runner.runOnce()).resolves.toBe(false);
    expect(fake.connect).toHaveBeenCalledWith(
      'CLD-7K3M-Q9TX',
      { userId: null },
      { source: 'enroll-file', portalUrl: 'https://account.example.test', auditRetryableFailure: true }
    );
    expect(keys.activate).toHaveBeenCalledWith(KEY);
    expect(fake.recordLicenseActivation).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, source: 'enroll-file', plan: 'business' })
    );
    expect(await exists(path)).toBe(false);
    expect(fake.recordEnrollFileEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'settled', enrollment: 'done', license: 'done', removed: true })
    );
    expect(
      JSON.stringify([fake.recordEnrollFileEvent.mock.calls, fake.recordLicenseActivation.mock.calls])
    ).not.toContain('AAAA');
  });

  it('keeps the file while the license server is unreachable, then finishes without enrolling twice', async () => {
    await writeFile(path, JSON.stringify({ code: 'CLD-7K3M-Q9TX', licenseKey: KEY }));
    const fake = service(async () => ({}));
    let reachable = false;
    const keys = license(async () => {
      if (!reachable) throw new LicenseServerRequestError(503, 'LICENSE_SERVER_UNAVAILABLE', 'unavailable');
      return { plan: 'personal', moduleRestarting: false };
    });
    const runner = new CloudLinkEnrollFile(fake as unknown as CloudLinkService, leases, keys, path);
    await expect(runner.runOnce()).resolves.toBe(true);
    expect(await exists(path)).toBe(true);
    reachable = true;
    await expect(runner.runOnce()).resolves.toBe(false);
    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(await exists(path)).toBe(false);
  });

  it('removes the file once the portal and the license server refused for good', async () => {
    await writeFile(path, JSON.stringify({ code: 'CLD-7K3M-Q9TX', licenseKey: KEY }));
    const fake = service(async () => {
      throw new CloudLinkRequestError(400, 'CLOUD_CODE_INVALID', 'invalid');
    });
    const keys = license(async () => {
      throw new LicenseServerRequestError(400, 'INVALID_LICENSE_KEY', `Key ${KEY} is not valid`);
    });
    await expect(
      new CloudLinkEnrollFile(fake as unknown as CloudLinkService, leases, keys, path).runOnce()
    ).resolves.toBe(false);
    expect(await exists(path)).toBe(false);
    expect(fake.recordEnrollFileEvent).toHaveBeenCalledWith(
      expect.objectContaining({ enrollment: 'rejected', license: 'rejected' })
    );
    expect(JSON.stringify(fake.recordLicenseActivation.mock.calls)).not.toContain('AAAA');
  });

  it('retries while the portal may still accept the code', async () => {
    await writeFile(path, JSON.stringify({ code: 'CLD-7K3M-Q9TX' }));
    const unavailable = service(async () => {
      throw new CloudLinkRequestError(502, 'CLOUD_PORTAL_UNAVAILABLE', 'unreachable', true);
    });
    const keys = license(async () => ({ plan: 'business', moduleRestarting: false }));
    await expect(
      new CloudLinkEnrollFile(unavailable as unknown as CloudLinkService, leases, keys, path).runOnce()
    ).resolves.toBe(true);
    expect(await exists(path)).toBe(true);
    expect(keys.activate).not.toHaveBeenCalled();
  });

  describe('a file written into the running app', () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const noBackoff = () => 5;

    it('enrols once when the file appears after start', async () => {
      const fake = service(async () => ({}));
      const runner = new CloudLinkEnrollFile(
        fake as unknown as CloudLinkService,
        leases,
        license(async () => ({ plan: 'business', moduleRestarting: false })),
        path,
        noBackoff,
        10
      );
      runner.start();
      try {
        await sleep(40);
        expect(fake.connect).not.toHaveBeenCalled();
        await writeFile(path, JSON.stringify({ code: 'CLD-7K3M-Q9TX' }));
        await vi.waitFor(async () => expect(await exists(path)).toBe(false), { timeout: 2_000, interval: 10 });
        await sleep(60);
        expect(fake.connect).toHaveBeenCalledTimes(1);
        // Settled: the file is no longer looked for.
        await writeFile(path, JSON.stringify({ code: 'CLD-7K3M-Q9TX' }));
        await sleep(60);
        expect(fake.connect).toHaveBeenCalledTimes(1);
      } finally {
        await runner.stop();
      }
    });

    it('does nothing while there is no file, and stops looking on an installation enrolled before start', async () => {
      const fake = service(async () => ({}));
      const keys = license(async () => ({ plan: 'business', moduleRestarting: false }));
      const runner = new CloudLinkEnrollFile(fake as unknown as CloudLinkService, leases, keys, path, noBackoff, 10);
      runner.start();
      await sleep(80);
      await runner.stop();
      expect(fake.connect).not.toHaveBeenCalled();
      expect(fake.recordEnrollFileEvent).not.toHaveBeenCalled();
      // Asked once, not on every poll.
      expect(fake.isEnrolled).toHaveBeenCalledTimes(1);

      const enrolled = service(async () => ({}), true);
      const done = new CloudLinkEnrollFile(enrolled as unknown as CloudLinkService, leases, keys, path, noBackoff, 10);
      done.start();
      await sleep(40);
      await writeFile(path, JSON.stringify({ code: 'CLD-7K3M-Q9TX' }));
      await sleep(60);
      await done.stop();
      expect(enrolled.connect).not.toHaveBeenCalled();
    });

    it('waits for a file still being written instead of giving up, and audits that once', async () => {
      await writeFile(path, '{"code": "CLD-7K3M');
      const fake = service(async () => ({}));
      const runner = new CloudLinkEnrollFile(
        fake as unknown as CloudLinkService,
        leases,
        license(async () => ({ plan: 'business', moduleRestarting: false })),
        path,
        noBackoff,
        10
      );
      runner.start();
      try {
        await sleep(60);
        expect(fake.recordEnrollFileEvent).toHaveBeenCalledTimes(1);
        await writeFile(path, JSON.stringify({ code: 'CLD-7K3M-Q9TX' }));
        await vi.waitFor(async () => expect(await exists(path)).toBe(false), { timeout: 2_000, interval: 10 });
        expect(fake.connect).toHaveBeenCalledTimes(1);
      } finally {
        await runner.stop();
      }
    });
  });

  describe('Opfield account sign-in', () => {
    const SECRET = 'client-secret-9f8e7d';
    const file = {
      code: 'CLD-7K3M-Q9TX',
      publicUrl: 'https://acme.opfield.cloud:3000',
      sso: { issuer: 'https://account.opfield.dev', clientId: 'gw-acme', clientSecret: SECRET },
      owner: { sub: '0b6f3c8e-6a1e-4d43-9b8e-2b8d3c1f0a77', email: 'Owner@Example.com', name: 'Ada Owner' },
    };

    it('sets up sign-in before enrolling and takes the client secret out of the file while enrolment retries', async () => {
      await writeFile(path, JSON.stringify(file));
      let reachable = false;
      const fake = service(async () => {
        if (!reachable) throw new CloudLinkRequestError(502, 'CLOUD_PORTAL_UNAVAILABLE', 'unreachable', true);
        return {};
      });
      const sso: EnrollFileSso = { apply: vi.fn(async () => 'done' as const) };
      const runner = new CloudLinkEnrollFile(
        fake as unknown as CloudLinkService,
        leases,
        license(async () => ({ plan: 'x', moduleRestarting: null })),
        path
      );
      runner.setManagedSso(sso);
      await expect(runner.runOnce()).resolves.toBe(true);
      expect(sso.apply).toHaveBeenCalledWith({
        publicUrl: 'https://acme.opfield.cloud:3000',
        sso: file.sso,
        owner: { ...file.owner, email: 'owner@example.com' },
      });
      const left = JSON.parse(await readFile(path, 'utf8'));
      expect(left.sso).toEqual({ issuer: 'https://account.opfield.dev', clientId: 'gw-acme' });
      expect(left.owner.sub).toBe(file.owner.sub);
      expect(fake.recordManagedSso).toHaveBeenCalledWith(
        expect.objectContaining({ step: 'secret_removed', outcome: 'done' })
      );

      // The next pass (or the next start) does not set sign-in up twice, and finishes once the account answers.
      reachable = true;
      await expect(runner.runOnce()).resolves.toBe(false);
      expect(sso.apply).toHaveBeenCalledTimes(1);
      expect(await exists(path)).toBe(false);
      expect(fake.recordEnrollFileEvent).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'settled', enrollment: 'done', sso: 'done', removed: true })
      );
      expect(
        JSON.stringify([
          fake.recordEnrollFileEvent.mock.calls,
          fake.recordManagedSso.mock.calls,
          fake.connect.mock.calls,
        ])
      ).not.toContain(SECRET);
    });

    it('keeps the file and the secret while sign-in waits for another pass', async () => {
      await writeFile(path, JSON.stringify(file));
      const fake = service(async () => ({}));
      let calls = 0;
      const sso: EnrollFileSso = { apply: vi.fn(async () => (++calls === 1 ? ('retry' as const) : ('done' as const))) };
      const runner = new CloudLinkEnrollFile(
        fake as unknown as CloudLinkService,
        leases,
        license(async () => ({ plan: 'x', moduleRestarting: null })),
        path
      );
      runner.setManagedSso(sso);
      await expect(runner.runOnce()).resolves.toBe(true);
      expect(JSON.parse(await readFile(path, 'utf8')).sso.clientSecret).toBe(SECRET);
      await expect(runner.runOnce()).resolves.toBe(false);
      expect(sso.apply).toHaveBeenCalledTimes(2);
      expect(await exists(path)).toBe(false);
    });

    it('removes the secret too when sign-in was refused for good, and leaves the setup link flow', async () => {
      await writeFile(path, JSON.stringify({ ...file, owner: undefined }));
      const fake = service(async () => {
        throw new CloudLinkRequestError(502, 'CLOUD_PORTAL_UNAVAILABLE', 'unreachable', true);
      });
      const sso: EnrollFileSso = { apply: vi.fn(async () => 'rejected' as const) };
      const runner = new CloudLinkEnrollFile(
        fake as unknown as CloudLinkService,
        leases,
        license(async () => ({ plan: 'x', moduleRestarting: null })),
        path
      );
      runner.setManagedSso(sso);
      await expect(runner.runOnce()).resolves.toBe(true);
      expect(JSON.parse(await readFile(path, 'utf8')).sso.clientSecret).toBeUndefined();
    });

    it('ignores a malformed owner, and files without sso or owner stay on the current flow', async () => {
      await writeFile(path, JSON.stringify({ code: 'CLD-7K3M-Q9TX', owner: { sub: '', email: 'not-an-email' } }));
      const fake = service(async () => ({}));
      const sso: EnrollFileSso = { apply: vi.fn(async () => 'done' as const) };
      const runner = new CloudLinkEnrollFile(
        fake as unknown as CloudLinkService,
        leases,
        license(async () => ({ plan: 'x', moduleRestarting: null })),
        path
      );
      runner.setManagedSso(sso);
      await expect(runner.runOnce()).resolves.toBe(false);
      expect(sso.apply).not.toHaveBeenCalled();
    });
  });
});
