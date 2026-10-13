import { describe, expect, it, vi } from 'vitest';
import { SetupTokenPolicyService } from './setup-token-policy.js';

function makeUserCountDb(realUserCount: number) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [{ count: realUserCount }]),
      })),
    })),
  } as any;
}

/** A db whose settings table holds `markers`, read with one `inArray` query. */
function makeMarkerDb(markers: Record<string, unknown>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => Object.entries(markers).map(([key, value]) => ({ key, value }))),
      })),
    })),
  } as any;
}

function makeService() {
  const service = new SetupTokenPolicyService({} as any) as any;
  vi.spyOn(service, 'isForcedOpen').mockResolvedValue(false);
  return service;
}

describe('SetupTokenPolicyService', () => {
  it('detects whether Gateway already has a real non-system user', async () => {
    await expect(new SetupTokenPolicyService(makeUserCountDb(0)).isOpfieldConfigured()).resolves.toBe(false);
    await expect(new SetupTokenPolicyService(makeUserCountDb(1)).isOpfieldConfigured()).resolves.toBe(true);
  });

  it('keeps setup API enabled until setup is explicitly completed', async () => {
    const service = new SetupTokenPolicyService(makeMarkerDb({}));

    await expect(service.isSetupApiEnabled()).resolves.toBe(true);
  });

  it('recognizes the JSONB boolean written by the forced-open marker', async () => {
    const db = makeMarkerDb({ 'setup:forced_open': true, 'setup:completed_at': new Date().toISOString() });

    await expect(new SetupTokenPolicyService(db).isSetupComplete()).resolves.toBe(false);
  });

  it('recognizes the string forced-open marker', async () => {
    const db = makeMarkerDb({ 'setup:forced_open': 'true', 'setup:completed_at': new Date().toISOString() });

    await expect(new SetupTokenPolicyService(db).isSetupComplete()).resolves.toBe(false);
  });

  it('disables setup API after setup is completed', async () => {
    const service = new SetupTokenPolicyService(makeMarkerDb({ 'setup:completed_at': new Date().toISOString() }));

    await expect(service.isSetupApiEnabled()).resolves.toBe(false);
  });

  it('ignores a completion marker that is not a timestamp', async () => {
    const service = new SetupTokenPolicyService(makeMarkerDb({ 'setup:completed_at': 'not a date' }));

    await expect(service.isSetupComplete()).resolves.toBe(false);
  });

  it('commits the completion marker and forced-open removal atomically', async () => {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    const where = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn(() => ({ where }));
    const transaction = vi.fn(async (callback) => callback({ insert, delete: remove }));

    await new SetupTokenPolicyService({ transaction } as any).markSetupComplete();

    expect(transaction).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });

  it('leaves a fresh installer-created Gateway pending', async () => {
    const service = new SetupTokenPolicyService({} as any, true) as any;
    vi.spyOn(service, 'isForcedOpen').mockResolvedValue(false);
    vi.spyOn(service, 'getTimestampSetting').mockResolvedValue(null);
    vi.spyOn(service, 'isOpfieldConfigured').mockResolvedValue(false);
    const markComplete = vi.spyOn(service, 'markSetupComplete').mockResolvedValue(undefined);
    const upsertSetting = vi.spyOn(service, 'upsertSetting').mockResolvedValue(undefined);

    await service.ensureSetupStarted();

    expect(markComplete).not.toHaveBeenCalled();
    expect(upsertSetting).toHaveBeenCalledWith('setup:forced_open', 'true');
  });

  it('marks configured installs complete instead of honoring a new installer bootstrap flag', async () => {
    const service = new SetupTokenPolicyService({} as any, true) as any;
    vi.spyOn(service, 'isForcedOpen').mockResolvedValue(false);
    vi.spyOn(service, 'getTimestampSetting').mockResolvedValue(null);
    vi.spyOn(service, 'isOpfieldConfigured').mockResolvedValue(true);
    const markComplete = vi.spyOn(service, 'markSetupComplete').mockResolvedValue(undefined);

    await service.ensureSetupStarted();

    expect(markComplete).toHaveBeenCalledOnce();
  });

  it('marks legacy installs without setup markers complete instead of reopening setup', async () => {
    const service = makeService();
    vi.spyOn(service, 'getTimestampSetting').mockResolvedValue(null);
    vi.spyOn(service, 'isOpfieldConfigured').mockResolvedValue(false);
    const markComplete = vi.spyOn(service, 'markSetupComplete').mockResolvedValue(undefined);

    await service.ensureSetupStarted();

    expect(markComplete).toHaveBeenCalledOnce();
  });
});
