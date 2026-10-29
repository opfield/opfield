import { eq } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/index.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import {
  type EnvironmentSettings,
  type EnvironmentSettingsLegacyUpdate,
  EnvironmentSettingsSchema,
  type EnvironmentSettingsUpdate,
  EnvironmentSettingsUpdateSchema,
  LoggingIngestSettingsSchema,
  PkiDefaultSettingsBaseSchema,
  RateLimitSettingsSchema,
  REQUEST_LIMIT_MAXIMUMS,
  RequestLimitSettingsSchema,
  SessionSettingsSchema,
} from './environment-settings.schemas.js';

const SETTINGS_KEY = 'environment:settings';

export const DEFAULT_ENVIRONMENT_SETTINGS: EnvironmentSettings = {
  rateLimits: {
    windowMs: 60_000,
    maxRequests: 1_200,
    sessionMaxRequests: 6_000,
    authMaxRequests: 120,
    authLoginMaxRequests: 20,
    authCallbackMaxRequests: 60,
    setupMaxRequests: 20,
    publicStatusMaxRequests: 600,
    publicWebhookMaxRequests: 60,
    pkiMaxRequests: 600,
    streamMaxRequests: 120,
    aiWebSocketMaxRequests: 120,
    inferenceMaxRequests: 1_800,
  },
  loggingIngest: {
    maxBodyBytes: 1_048_576,
    maxBatchSize: 500,
    maxMessageBytes: 16_384,
    maxLabels: 32,
    maxFields: 64,
    maxKeyLength: 100,
    maxValueBytes: 8_192,
    maxJsonDepth: 5,
    rateLimitWindowSeconds: 60,
    globalRequestsPerWindow: 600,
    globalEventsPerWindow: 60_000,
    tokenRequestsPerWindow: 300,
    tokenEventsPerWindow: 10_000,
  },
  requestLimits: {
    requestBodyMaxBytes: 2_097_152,
    oauthBodyMaxBytes: 32_768,
    inferenceHttpBodyMaxBytes: 256 * 1024 * 1024,
    inferenceWebSocketMaxPayloadBytes: 128 * 1024 * 1024,
    inferenceMaxConcurrentRequestsPerToken: 32,
    inferenceConcurrencyLeaseSeconds: 600,
  },
  sessions: {
    expirySeconds: 2_592_000,
    absoluteLifetimeSeconds: null,
  },
  pkiDefaults: {
    crlValidityHours: 24,
    expiryWarningDays: 30,
    expiryCriticalDays: 7,
  },
};

export class EnvironmentSettingsService {
  private current: EnvironmentSettings = structuredClone(DEFAULT_ENVIRONMENT_SETTINGS);

  constructor(
    private readonly db: DrizzleClient,
    private readonly eventBus?: EventBusService
  ) {}

  async initialize(): Promise<EnvironmentSettings> {
    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, SETTINGS_KEY))
      .limit(1);
    this.current = normalizeEnvironmentSettings(row?.value);
    return this.getSnapshot();
  }

  getSnapshot(): EnvironmentSettings {
    return structuredClone(this.current);
  }

  async update(input: EnvironmentSettingsUpdate): Promise<EnvironmentSettings> {
    const validated = EnvironmentSettingsUpdateSchema.parse(input);
    const next = EnvironmentSettingsSchema.parse({
      rateLimits: { ...this.current.rateLimits, ...validated.rateLimits },
      loggingIngest: { ...this.current.loggingIngest, ...validated.loggingIngest },
      requestLimits: { ...this.current.requestLimits, ...validated.requestLimits },
      sessions: { ...this.current.sessions, ...validated.sessions },
      pkiDefaults: { ...this.current.pkiDefaults, ...validated.pkiDefaults },
    });
    await this.persist(next);
    this.current = next;
    this.eventBus?.publish('system.config.changed', { key: SETTINGS_KEY });
    return this.getSnapshot();
  }

  /**
   * Keeps the values a pre-2.11 install still had in its .env. Previous updaters run this from the target image before
   * they snapshot the database, so whatever it writes is restored by a rollback: it writes only the values the .env
   * provided (the defaults stay in code, and a key added since the previous release never reaches its strict schema),
   * and no row at all when there is nothing to import.
   */
  async importLegacy(input: EnvironmentSettingsLegacyUpdate): Promise<boolean> {
    const overrides = legacyEnvironmentOverrides(input);
    if (!overrides) return false;
    const [existing] = await this.db
      .select({ key: settings.key })
      .from(settings)
      .where(eq(settings.key, SETTINGS_KEY))
      .limit(1);
    if (existing) return false;
    // Refuse values this release would not accept, as before; only the given ones are stored.
    const next = EnvironmentSettingsSchema.parse({
      rateLimits: { ...DEFAULT_ENVIRONMENT_SETTINGS.rateLimits, ...overrides.rateLimits },
      loggingIngest: { ...DEFAULT_ENVIRONMENT_SETTINGS.loggingIngest, ...overrides.loggingIngest },
      requestLimits: { ...DEFAULT_ENVIRONMENT_SETTINGS.requestLimits, ...overrides.requestLimits },
      sessions: { ...DEFAULT_ENVIRONMENT_SETTINGS.sessions, ...overrides.sessions },
      pkiDefaults: { ...DEFAULT_ENVIRONMENT_SETTINGS.pkiDefaults, ...overrides.pkiDefaults },
    });
    await this.persist(overrides);
    this.current = next;
    return true;
  }

  private async persist(value: EnvironmentSettings | EnvironmentSettingsLegacyUpdate): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key: SETTINGS_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  }
}

export function getEnvironmentSettingsSnapshot(): EnvironmentSettings {
  if (!container.isRegistered(EnvironmentSettingsService)) {
    return structuredClone(DEFAULT_ENVIRONMENT_SETTINGS);
  }
  return container.resolve(EnvironmentSettingsService).getSnapshot();
}

const SETTINGS_GROUPS = {
  rateLimits: RateLimitSettingsSchema,
  loggingIngest: LoggingIngestSettingsSchema,
  requestLimits: RequestLimitSettingsSchema,
  sessions: SessionSettingsSchema,
  pkiDefaults: PkiDefaultSettingsBaseSchema,
} as const;

type SettingsGroup = keyof typeof SETTINGS_GROUPS;

/** The values a legacy .env gave, by group, without the ones it left out; null when it gave none. */
export function legacyEnvironmentOverrides(
  input: EnvironmentSettingsLegacyUpdate
): EnvironmentSettingsLegacyUpdate | null {
  const overrides: Record<string, Record<string, unknown>> = {};
  for (const group of Object.keys(SETTINGS_GROUPS) as SettingsGroup[]) {
    const known = Object.keys(DEFAULT_ENVIRONMENT_SETTINGS[group]);
    const given = Object.entries((input[group] ?? {}) as Record<string, unknown>).filter(
      ([key, value]) => value !== undefined && known.includes(key)
    );
    if (given.length > 0) overrides[group] = Object.fromEntries(given);
  }
  return Object.keys(overrides).length > 0 ? (overrides as EnvironmentSettingsLegacyUpdate) : null;
}

/**
 * The stored row over the defaults. Tolerant of rows other releases wrote: a key it lacks (a partial import, an older
 * release) takes the default, a key this release does not know (a newer release before a rollback) is dropped, and a
 * value this release would not accept takes the default too, so a stored row never keeps Opfield from starting.
 */
export function normalizeEnvironmentSettings(value: unknown): EnvironmentSettings {
  const stored = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const group = <G extends SettingsGroup>(name: G): EnvironmentSettings[G] => {
    const defaults = DEFAULT_ENVIRONMENT_SETTINGS[name] as Record<string, number | null>;
    const record = stored[name] && typeof stored[name] === 'object' ? (stored[name] as Record<string, unknown>) : {};
    const shape = SETTINGS_GROUPS[name].shape as Record<string, { safeParse(input: unknown): { success: boolean } }>;
    const result: Record<string, number | null> = { ...defaults };
    for (const key of Object.keys(defaults)) {
      let candidate = record[key];
      // Request limits above this release's maximum are lowered to it rather than dropped.
      const maximum = name === 'requestLimits' ? REQUEST_LIMIT_MAXIMUMS[key as keyof typeof REQUEST_LIMIT_MAXIMUMS] : 0;
      if (maximum && typeof candidate === 'number') candidate = Math.min(candidate, maximum);
      if (candidate !== undefined && shape[key]?.safeParse(candidate).success) result[key] = candidate as number | null;
    }
    return result as EnvironmentSettings[G];
  };
  const pkiDefaults = group('pkiDefaults');
  return EnvironmentSettingsSchema.parse({
    rateLimits: group('rateLimits'),
    loggingIngest: group('loggingIngest'),
    requestLimits: group('requestLimits'),
    sessions: group('sessions'),
    pkiDefaults:
      pkiDefaults.expiryCriticalDays <= pkiDefaults.expiryWarningDays
        ? pkiDefaults
        : structuredClone(DEFAULT_ENVIRONMENT_SETTINGS.pkiDefaults),
  });
}
