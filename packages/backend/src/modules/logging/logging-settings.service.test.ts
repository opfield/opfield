import { describe, expect, it, vi } from 'vitest';
import { LEGACY_INSTALL_DIR_NAME, LEGACY_LOGS_DATABASE } from '@/lib/legacy-compat.js';
import { LoggingSettingsService } from './logging-settings.service.js';

function serviceWithStored(stored: Record<string, unknown>) {
  let value: Record<string, unknown> = stored;
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ value }] }) }) }),
    insert: () => ({
      values: (row: { value: Record<string, unknown> }) => ({
        onConflictDoUpdate: vi.fn(async () => {
          value = row.value;
        }),
      }),
    }),
  };
  const crypto = {
    encryptString: (plain: string) => ({ encryptedKey: plain, encryptedDek: 'dek' }),
    decryptString: (secret: { encryptedKey: string }) => secret.encryptedKey,
  };
  return { service: new LoggingSettingsService(db as never, crypto as never), stored: () => value };
}

const EXTERNAL = {
  mode: 'external',
  url: 'https://clickhouse.example.com:8443/',
  username: `${LEGACY_INSTALL_DIR_NAME}`,
  password: { encryptedKey: 'stored-password', encryptedDek: 'dek' },
  database: LEGACY_LOGS_DATABASE,
  table: 'logs',
  requestTimeoutMs: 5000,
};

describe('LoggingSettingsService.saveConfig', () => {
  it('does not send the stored ClickHouse password to a new address', async () => {
    const { service, stored } = serviceWithStored(EXTERNAL);

    await expect(
      service.saveConfig({ mode: 'external', url: 'https://clickhouse.attacker.example/' })
    ).rejects.toMatchObject({ statusCode: 400, code: 'CLICKHOUSE_PASSWORD_REQUIRED' });
    expect(stored()).toBe(EXTERNAL);
  });

  it('keeps the stored password for the same ClickHouse and takes a re-entered one for a new address', async () => {
    const { service } = serviceWithStored(EXTERNAL);

    await expect(
      service.saveConfig({ mode: 'external', url: 'https://clickhouse.example.com:8443/', requestTimeoutMs: 9000 })
    ).resolves.toMatchObject({ password: 'stored-password', requestTimeoutMs: 9000 });
    await expect(
      service.saveConfig({ mode: 'external', url: 'https://other.example.com/', password: 'new-password' })
    ).resolves.toMatchObject({ url: 'https://other.example.com/', password: 'new-password' });
  });
});
