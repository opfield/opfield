import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationLeaseStore } from '@/db/operation-lease.js';
import { LicenseServerRequestError } from '@/modules/license/license.service.js';
import { CloudLinkRequestError, type CloudLinkService } from './cloud-link.service.js';
import { CloudLinkEnrollFile, createEnrollFileLicense, type EnrollFileLicense } from './cloud-link-enroll-file.js';

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
});
