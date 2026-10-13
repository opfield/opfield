import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/index.js';
import {
  LEGACY_CLICKHOUSE_ALIAS,
  OPFIELD_CLICKHOUSE_ALIAS,
  OPFIELD_LOGS_DATABASE,
} from '@/foundation/opfield-names.js';
import { AppError } from '@/middleware/error-handler.js';
import type { CryptoService } from '@/services/crypto.service.js';
import { validateClickHouseIdentifier } from './logging-query-builder.js';

/** User of a local ClickHouse created by this release. */
const OPFIELD_CLICKHOUSE_USER = 'opfield';

const SETTINGS_KEY = 'logging:clickhouse';

export type LoggingStorageMode = 'disabled' | 'local' | 'external';

interface EncryptedSecret {
  encryptedKey: string;
  encryptedDek: string;
}

interface StoredLoggingSettings {
  mode: LoggingStorageMode;
  url: string;
  username: string;
  password: EncryptedSecret | null;
  database: string;
  table: string;
  requestTimeoutMs: number;
}

export interface LoggingRuntimeSettings {
  mode: LoggingStorageMode;
  url: string;
  username: string;
  password: string;
  database: string;
  table: string;
  requestTimeoutMs: number;
}

export interface LegacyLoggingEnvironment {
  CLICKHOUSE_URL: string;
  CLICKHOUSE_USERNAME: string;
  CLICKHOUSE_PASSWORD: string;
  CLICKHOUSE_DATABASE: string;
  CLICKHOUSE_LOGS_TABLE: string;
  CLICKHOUSE_REQUEST_TIMEOUT_MS: number;
}

export interface LoggingSettingsInput {
  mode: LoggingStorageMode;
  url?: string;
  username?: string;
  password?: string;
  database?: string;
  table?: string;
  requestTimeoutMs?: number;
}

export class LoggingSettingsService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService: CryptoService
  ) {}

  async getRuntimeConfig(): Promise<LoggingRuntimeSettings> {
    const stored = await this.getStored();
    if (!stored) return disabledConfig();
    return {
      ...stored,
      password: stored.password ? this.cryptoService.decryptString(stored.password) : '',
    };
  }

  async getPublicConfig() {
    const runtime = await this.getRuntimeConfig();
    return {
      ...runtime,
      password: undefined,
      passwordLast4: runtime.password ? runtime.password.slice(-4) : null,
    };
  }

  async saveConfig(input: LoggingSettingsInput): Promise<LoggingRuntimeSettings> {
    const previous = await this.getStored();
    if (input.mode === 'disabled') {
      await this.setStored(previous ? { ...previous, mode: 'disabled' } : { ...disabledConfig(), password: null });
      return this.getRuntimeConfig();
    }

    const local = input.mode === 'local';
    const previousUrl = parseUrlOrNull(previous?.url);
    const previousWasLocal = !!previousUrl && isLocalClickHouseHost(previousUrl.hostname);
    const requestedUrl = input.url?.trim();
    const rawUrl = local
      ? requestedUrl || (previousWasLocal ? previous?.url : undefined) || `http://${OPFIELD_CLICKHOUSE_ALIAS}:8123`
      : (requestedUrl ?? '');
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw invalidLoggingConfig('ClickHouse URL must be a valid absolute URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw invalidLoggingConfig('ClickHouse URL must use http or https');
    }

    // An existing local ClickHouse keeps the user it was created with.
    const username = (
      input.username ??
      (local ? (previousWasLocal ? previous?.username : undefined) || OPFIELD_CLICKHOUSE_USER : previous?.username) ??
      ''
    ).trim();
    if (!username) throw invalidLoggingConfig('ClickHouse username is required');
    const rawPassword =
      input.password ?? (local && !previousWasLocal ? randomBytes(32).toString('base64url') : undefined);
    // The stored password is sent only where it was entered for: the same ClickHouse origin, or the bundled
    // ClickHouse whose password Opfield generated. A new address needs the password again, like a SIEM destination.
    const storedPasswordApplies =
      !!previousUrl && (previousUrl.origin === url.origin || (previousWasLocal && isLocalClickHouseHost(url.hostname)));
    const password =
      rawPassword !== undefined
        ? this.cryptoService.encryptString(rawPassword)
        : (previousWasLocal || !local) && storedPasswordApplies
          ? previous?.password
          : undefined;
    if (!password && previous?.password && !storedPasswordApplies) {
      throw new AppError(
        400,
        'CLICKHOUSE_PASSWORD_REQUIRED',
        'Enter the ClickHouse password again when the ClickHouse URL changes'
      );
    }
    if (!password) throw invalidLoggingConfig('ClickHouse password is required');
    const database = validateClickHouseIdentifier(input.database ?? previous?.database ?? OPFIELD_LOGS_DATABASE);
    const table = validateClickHouseIdentifier(input.table ?? previous?.table ?? 'logs');
    const requestTimeoutMs = input.requestTimeoutMs ?? previous?.requestTimeoutMs ?? 5000;
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1)
      throw invalidLoggingConfig('ClickHouse request timeout must be positive');

    await this.setStored({
      mode: input.mode,
      url: url.toString(),
      username,
      password,
      database,
      table,
      requestTimeoutMs,
    });
    return this.getRuntimeConfig();
  }

  async importLegacyEnv(env: LegacyLoggingEnvironment): Promise<boolean> {
    if (await this.getStored()) return false;
    if (!env.CLICKHOUSE_URL) {
      await this.saveConfig({ mode: 'disabled' });
      return false;
    }
    const hostname = new URL(env.CLICKHOUSE_URL).hostname;
    await this.saveConfig({
      mode: isLocalClickHouseHost(hostname) ? 'local' : 'external',
      url: env.CLICKHOUSE_URL,
      username: env.CLICKHOUSE_USERNAME,
      password: env.CLICKHOUSE_PASSWORD,
      database: env.CLICKHOUSE_DATABASE,
      table: env.CLICKHOUSE_LOGS_TABLE,
      requestTimeoutMs: env.CLICKHOUSE_REQUEST_TIMEOUT_MS,
    });
    return true;
  }

  private async getStored(): Promise<StoredLoggingSettings | null> {
    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, SETTINGS_KEY))
      .limit(1);
    return (row?.value as StoredLoggingSettings | undefined) ?? null;
  }

  private async setStored(value: StoredLoggingSettings): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key: SETTINGS_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  }
}

function invalidLoggingConfig(message: string): AppError {
  return new AppError(400, 'LOGGING_CONFIG_INVALID', message);
}

function disabledConfig(): LoggingRuntimeSettings {
  return {
    mode: 'disabled',
    url: '',
    username: '',
    password: '',
    database: OPFIELD_LOGS_DATABASE,
    table: 'logs',
    requestTimeoutMs: 5000,
  };
}

function parseUrlOrNull(value: string | undefined): URL | null {
  try {
    return new URL(value ?? '');
  } catch {
    return null;
  }
}

function isLocalClickHouseHost(hostname: string): boolean {
  // legacy-name: gateway-clickhouse — the alias of a local ClickHouse in settings saved before 2.12.1; the host move
  // rewrites it — remove once every installation reports the Opfield layout.
  return hostname === 'clickhouse' || hostname === OPFIELD_CLICKHOUSE_ALIAS || hostname === LEGACY_CLICKHOUSE_ALIAS;
}
