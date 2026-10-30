import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { CryptoService } from '@/services/crypto.service.js';
import { DockerWebhookService } from './docker-webhook.service.js';
import { hashWebhookToken, presentWebhook, sealWebhookToken } from './docker-webhook-token.js';

describe('DockerWebhookService token storage', () => {
  const TOKEN = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    container.registerInstance(CryptoService, new CryptoService('ab'.repeat(32)));
  });

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

  it('stores the hash and the encrypted token, never the plaintext, and returns the URL token', async () => {
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
    expect(created).not.toHaveProperty('tokenEncrypted');
    expect(created.tokenLost).toBe(false);
    expect(inserted[0]).toMatchObject({ token: null, tokenHash: hashWebhookToken(created.token!) });
    expect(String(inserted[0]!.tokenEncrypted)).not.toContain(created.token!);
    // The change event never carries the token, its hash or its ciphertext.
    expect(events[0]).not.toHaveProperty('token');
    expect(events[0]).not.toHaveProperty('tokenHash');
    expect(events[0]).not.toHaveProperty('tokenEncrypted');
  });

  it('rotates to a new hash and ciphertext and returns the new token', async () => {
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
    expect(typeof patches[0]!.tokenEncrypted).toBe('string');
    expect(rotated).not.toHaveProperty('tokenHash');
  });

  it('shows the URL token of a stored webhook again on reads', async () => {
    const row = { id: 'webhook-1', ...sealWebhookToken(TOKEN), enabled: true };
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }) };
    const service = serviceWithDb(db);

    const read = await service.getByContainer('node-1', 'app');

    expect(read).toEqual({ id: 'webhook-1', token: TOKEN, tokenLost: false, enabled: true });
  });

  it('marks a webhook that 2.13.0 reduced to a hash as lost: no token, regenerate to show a URL', () => {
    const row = { id: 'webhook-1', token: null, tokenHash: hashWebhookToken(TOKEN), tokenEncrypted: null };
    expect(presentWebhook(row)).toEqual({ id: 'webhook-1', token: null, tokenLost: true });
  });

  it('matches incoming calls by hash, for encrypted and hash-only webhooks alike', async () => {
    for (const row of [
      { id: 'webhook-1', ...sealWebhookToken(TOKEN), enabled: true },
      { id: 'webhook-1', token: null, tokenHash: hashWebhookToken(TOKEN), tokenEncrypted: null, enabled: true },
    ]) {
      const wheres: unknown[] = [];
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

      // The row a webhook call acts on does not carry the token.
      await expect(service.getByToken(TOKEN.toUpperCase())).resolves.toMatchObject({ id: 'webhook-1', token: null });
      expect(wheres).toHaveLength(1);
    }
    expect(hashWebhookToken(TOKEN.toUpperCase())).toBe(hashWebhookToken(TOKEN));
  });

  it('stores a plaintext webhook that a writer inserted without a hash hashed and encrypted, on first use', async () => {
    const legacy = { id: 'webhook-2', token: TOKEN, tokenHash: null, tokenEncrypted: null, enabled: true };
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
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ tokenHash: hashWebhookToken(TOKEN), token: null });
    expect(presentWebhook({ ...legacy, ...patches[0] }).token).toBe(TOKEN);
  });

  it('answers null for a token that matches neither a hash nor a legacy row', async () => {
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) };
    await expect(serviceWithDb(db).getByToken(TOKEN)).resolves.toBeNull();
  });
});
