import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationLeaseStore } from '@/db/operation-lease.js';
import { CloudLinkRequestError, type CloudLinkService } from './cloud-link.service.js';
import { CloudLinkEnrollFile } from './cloud-link-enroll-file.js';

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
    return {
      isEnrolled: vi.fn(async () => enrolled),
      connect: vi.fn(connect),
      recordEnrollFileEvent: vi.fn(async () => undefined),
    };
  }

  it('enrols with the file code and portal, then removes the file', async () => {
    await writeFile(path, JSON.stringify({ code: 'CLD-7K3M-Q9TX', portalUrl: 'https://account.example.test' }));
    const fake = service(async () => ({}));
    const runner = new CloudLinkEnrollFile(fake as unknown as CloudLinkService, leases, path);
    await expect(runner.runOnce()).resolves.toBe(false);
    expect(fake.connect).toHaveBeenCalledWith(
      'CLD-7K3M-Q9TX',
      { userId: null },
      { source: 'enroll-file', portalUrl: 'https://account.example.test', auditRetryableFailure: true }
    );
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fake.recordEnrollFileEvent).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'enrolled' }));
  });

  it('retries while the portal may still accept the code and removes the file once it calls it invalid', async () => {
    await writeFile(path, JSON.stringify({ code: 'CLD-7K3M-Q9TX' }));
    const unavailable = service(async () => {
      throw new CloudLinkRequestError(502, 'CLOUD_PORTAL_UNAVAILABLE', 'unreachable', true);
    });
    await expect(
      new CloudLinkEnrollFile(unavailable as unknown as CloudLinkService, leases, path).runOnce()
    ).resolves.toBe(true);
    await expect(readFile(path, 'utf8')).resolves.toContain('CLD-7K3M-Q9TX');

    const invalid = service(async () => {
      throw new CloudLinkRequestError(400, 'CLOUD_CODE_INVALID', 'invalid');
    });
    await expect(new CloudLinkEnrollFile(invalid as unknown as CloudLinkService, leases, path).runOnce()).resolves.toBe(
      false
    );
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves the file alone when the installation is enrolled already', async () => {
    await writeFile(path, JSON.stringify({ code: 'CLD-7K3M-Q9TX' }));
    const fake = service(async () => ({}), true);
    await expect(new CloudLinkEnrollFile(fake as unknown as CloudLinkService, leases, path).runOnce()).resolves.toBe(
      false
    );
    expect(fake.connect).not.toHaveBeenCalled();
    await expect(readFile(path, 'utf8')).resolves.toContain('CLD');
  });
});
