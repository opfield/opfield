import { describe, expect, it, vi } from 'vitest';
import { DockerWebhookService } from './docker-webhook.service.js';
import { hashWebhookToken } from './docker-webhook-token.js';

describe('DockerWebhookService token storage', () => {
  const TOKEN = '11111111-1111-4111-8111-111111111111';

  function serviceWithDb(db: unknown) {
    return new DockerWebhookService(
      db as never,
      {} as never,
      {} as never,
      { log: vi.fn().mockResolvedValue({}) } as never,
      {} as never,
      {} as never,
      {} as never
    );
  }

  it('stores only the hash and shows the token in the response that issued it', async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const db = {
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          inserted.push(values);
          return { returning: async () => [{ id: 'webhook-1', ...values }] };
        },
      }),
    };
    const service = serviceWithDb(db);
    vi.spyOn(service, 'getByContainer').mockResolvedValue(null as never);
    const events: Array<Record<string, unknown>> = [];
    service.setEventBus({
      publish: (_channel: string, payload: Record<string, unknown>) => events.push(payload),
    } as never);

    const created = await service.upsert('node-1', 'app', { enabled: true }, 'creator');

    expect(created.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(created).not.toHaveProperty('tokenHash');
    expect(inserted[0]).toMatchObject({ token: null, tokenHash: hashWebhookToken(created.token!) });
    // The change event never carries the token or its hash.
    expect(events[0]).not.toHaveProperty('token');
    expect(events[0]).not.toHaveProperty('tokenHash');
  });

  it('rotates to a new hash and returns the new token once', async () => {
    const patches: Array<Record<string, unknown>> = [];
    const db = {
      update: () => ({
        set: (patch: Record<string, unknown>) => {
          patches.push(patch);
          return { where: () => ({ returning: async () => [{ id: 'webhook-1', ...patch }] }) };
        },
      }),
    };
    const service = serviceWithDb(db);
    vi.spyOn(service, 'getByContainer').mockResolvedValue({ id: 'webhook-1' } as never);

    const rotated = await service.regenerateToken('node-1', 'app', 'rotator');

    expect(patches[0]).toMatchObject({ token: null, tokenHash: hashWebhookToken(rotated.token!) });
    expect(rotated).not.toHaveProperty('tokenHash');
  });

  it('never returns a stored token on reads', async () => {
    const row = { id: 'webhook-1', token: TOKEN, tokenHash: hashWebhookToken(TOKEN), enabled: true };
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }) };
    const service = serviceWithDb(db);

    const read = await service.getByContainer('node-1', 'app');

    expect(read).toEqual({ id: 'webhook-1', token: null, enabled: true });
  });

  it('finds a webhook by the hash of the URL token', async () => {
    const wheres: unknown[] = [];
    const row = { id: 'webhook-1', tokenHash: hashWebhookToken(TOKEN), enabled: true };
    const db = {
      select: () => ({
        from: () => ({
          where: (condition: unknown) => {
            wheres.push(condition);
            return { limit: async () => [row] };
          },
        }),
      }),
    };
    const service = serviceWithDb(db);

    await expect(service.getByToken(TOKEN.toUpperCase())).resolves.toMatchObject({ id: 'webhook-1', token: null });
    expect(wheres).toHaveLength(1);
    expect(hashWebhookToken(TOKEN.toUpperCase())).toBe(hashWebhookToken(TOKEN));
  });

  it('hashes a plaintext webhook that a writer inserted without a hash, on first use', async () => {
    const legacy = { id: 'webhook-2', token: TOKEN, tokenHash: null, enabled: true };
    const selects = [[], [legacy]];
    const patches: Array<Record<string, unknown>> = [];
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => selects.shift() }) }) }),
      update: () => ({
        set: (patch: Record<string, unknown>) => {
          patches.push(patch);
          return { where: async () => undefined };
        },
      }),
    };
    const service = serviceWithDb(db);

    await expect(service.getByToken(TOKEN)).resolves.toMatchObject({ id: 'webhook-2', token: null });
    expect(patches).toEqual([{ tokenHash: hashWebhookToken(TOKEN), token: null }]);
  });

  it('answers null for a token that matches neither a hash nor a legacy row', async () => {
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) };
    await expect(serviceWithDb(db).getByToken(TOKEN)).resolves.toBeNull();
  });
});
