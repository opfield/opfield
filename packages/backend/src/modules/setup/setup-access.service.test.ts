import { describe, expect, it, vi } from 'vitest';
import { SetupAccessService } from './setup-access.service.js';

function createHarness() {
  let stored: unknown;
  const sessions = new Map<string, unknown>();
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => (stored ? [{ value: stored }] : [])) })) })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((row: { value: unknown }) => ({
        onConflictDoUpdate: vi.fn(async () => {
          stored = row.value;
        }),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => {
        stored = undefined;
      }),
    })),
  } as any;
  const cache = {
    set: vi.fn(async (key: string, value: unknown) => {
      sessions.set(key, value);
    }),
    setIfAbsent: vi.fn(async (key: string, value: unknown) => {
      if (sessions.has(key)) return false;
      sessions.set(key, value);
      return true;
    }),
    get: vi.fn(async (key: string) => sessions.get(key) ?? null),
    exists: vi.fn(async (key: string) => sessions.has(key)),
    delete: vi.fn(async (key: string) => {
      sessions.delete(key);
    }),
    deletePattern: vi.fn(async () => sessions.clear()),
    getClient: vi.fn(() => ({
      eval: vi.fn(async (_script: string, _keys: number, key: string, lease: string) => {
        if (sessions.get(key) !== lease) return 0;
        sessions.delete(key);
        return 1;
      }),
    })),
  } as any;
  const policy = { isSetupComplete: vi.fn().mockResolvedValue(false) } as any;
  return { service: new SetupAccessService(db, cache, policy), policy, getStored: () => stored };
}

describe('SetupAccessService', () => {
  it('persists only access-code metadata and a hash for 24 hours', async () => {
    const harness = createHarness();
    const generated = await harness.service.generateCode();
    const stored = harness.getStored() as Record<string, unknown>;

    expect(generated.code).toMatch(/^opfs_/);
    expect(stored).toMatchObject({ id: generated.id, expiresAt: generated.expiresAt });
    expect(stored.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(generated.code);
    expect(Date.parse(generated.expiresAt) - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
  });

  it('creates a bounded setup session for the valid code', async () => {
    const harness = createHarness();
    const generated = await harness.service.generateCode();
    const session = await harness.service.createSession(generated.code);
    await expect(harness.service.validateSession(session.sessionId)).resolves.toBe(true);
    await expect(harness.service.getCsrfToken(session.sessionId)).resolves.toBe(session.csrfToken);
    await expect(harness.service.validateCsrfToken(session.sessionId, session.csrfToken)).resolves.toBe(true);
    await expect(harness.service.validateCsrfToken(session.sessionId, 'wrong')).resolves.toBe(false);
  });

  it('allows only one active setup session for an access code', async () => {
    const harness = createHarness();
    const generated = await harness.service.generateCode();
    const first = await harness.service.createSession(generated.code);

    await expect(harness.service.createSession(generated.code)).rejects.toThrow('Opfield setup is already in progress');
    await expect(harness.service.getProgress(undefined)).resolves.toEqual({
      inProgress: true,
      currentSession: false,
    });
    await expect(harness.service.getProgress(first.sessionId)).resolves.toEqual({
      inProgress: true,
      currentSession: true,
    });
  });

  it('rejects a wrong code and refuses generation after completion', async () => {
    const harness = createHarness();
    await harness.service.generateCode();
    await expect(harness.service.createSession('wrong')).rejects.toThrow('Invalid or expired setup code');
    harness.policy.isSetupComplete.mockResolvedValue(true);
    await expect(harness.service.generateCode()).rejects.toThrow('already complete');
  });

  it('serializes final apply calls for the active setup session', async () => {
    const harness = createHarness();
    const generated = await harness.service.generateCode();
    const session = await harness.service.createSession(generated.code);
    let release!: () => void;
    const pending = harness.service.withApplyLock(
      session.sessionId,
      () => new Promise<void>((resolve) => (release = resolve))
    );
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));

    await expect(harness.service.withApplyLock(session.sessionId, async () => undefined)).rejects.toThrow(
      'already being applied'
    );
    release();
    await pending;
    await expect(harness.service.withApplyLock(session.sessionId, async () => 'ok')).resolves.toBe('ok');
  });
});
