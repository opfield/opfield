import { parse } from 'dotenv';
import { LEGACY_LOGS_DATABASE } from '@/lib/legacy-compat.js';
import type { LegacyOidcEnvironment } from '@/modules/auth/oidc-settings.service.js';
import type { LegacyLoggingEnvironment } from '@/modules/logging/logging-settings.service.js';
import type { EnvironmentSettingsLegacyUpdate } from '@/modules/settings/environment-settings.schemas.js';

export interface LegacySettingsEnv {
  env: LegacyOidcEnvironment & LegacyLoggingEnvironment;
  environment: EnvironmentSettingsLegacyUpdate;
  appUrl: string | undefined;
}

export function parseLegacySettingsEnv(content: string): LegacySettingsEnv {
  const values = parse(content);
  const optional = (key: string) => {
    const value = values[key]?.trim();
    return value || undefined;
  };
  const integer = (key: string, fallback: number) => {
    const value = optional(key);
    if (!value) return fallback;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  const optionalInteger = (key: string) => {
    const value = optional(key);
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  };
  const compact = <T extends Record<string, number | undefined>>(value: T) =>
    Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
      [K in keyof T]?: Exclude<T[K], undefined>;
    };
  const legacyInferenceBodyBytes = optionalInteger('INFERENCE_BODY_MAX_BYTES');

  return {
    env: {
      OIDC_ISSUER: optional('OIDC_ISSUER'),
      OIDC_CLIENT_ID: optional('OIDC_CLIENT_ID'),
      OIDC_CLIENT_SECRET: optional('OIDC_CLIENT_SECRET'),
      OIDC_REDIRECT_URI: optional('OIDC_REDIRECT_URI'),
      OIDC_SCOPES: optional('OIDC_SCOPES') ?? 'openid email profile',
      CLICKHOUSE_URL: optional('CLICKHOUSE_URL') ?? '',
      CLICKHOUSE_USERNAME: optional('CLICKHOUSE_USERNAME') ?? 'default',
      CLICKHOUSE_PASSWORD: optional('CLICKHOUSE_PASSWORD') ?? '',
      CLICKHOUSE_DATABASE: optional('CLICKHOUSE_DATABASE') ?? LEGACY_LOGS_DATABASE,
      CLICKHOUSE_LOGS_TABLE: optional('CLICKHOUSE_LOGS_TABLE') ?? 'logs',
      CLICKHOUSE_REQUEST_TIMEOUT_MS: integer('CLICKHOUSE_REQUEST_TIMEOUT_MS', 5000),
    },
    environment: {
      rateLimits: compact({
        windowMs: optionalInteger('RATE_LIMIT_WINDOW_MS'),
        maxRequests: optionalInteger('RATE_LIMIT_MAX_REQUESTS'),
        authMaxRequests: optionalInteger('RATE_LIMIT_AUTH_MAX_REQUESTS'),
        authLoginMaxRequests: optionalInteger('RATE_LIMIT_AUTH_LOGIN_MAX_REQUESTS'),
        authCallbackMaxRequests: optionalInteger('RATE_LIMIT_AUTH_CALLBACK_MAX_REQUESTS'),
        setupMaxRequests: optionalInteger('RATE_LIMIT_SETUP_MAX_REQUESTS'),
        publicStatusMaxRequests: optionalInteger('RATE_LIMIT_PUBLIC_STATUS_MAX_REQUESTS'),
        publicWebhookMaxRequests: optionalInteger('RATE_LIMIT_PUBLIC_WEBHOOK_MAX_REQUESTS'),
        pkiMaxRequests: optionalInteger('RATE_LIMIT_PKI_MAX_REQUESTS'),
        streamMaxRequests: optionalInteger('RATE_LIMIT_STREAM_MAX_REQUESTS'),
        aiWebSocketMaxRequests: optionalInteger('RATE_LIMIT_AI_WS_MAX_REQUESTS'),
        inferenceMaxRequests: optionalInteger('RATE_LIMIT_INFERENCE_MAX_REQUESTS'),
      }),
      loggingIngest: compact({
        maxBodyBytes: optionalInteger('LOGGING_INGEST_MAX_BODY_BYTES'),
        maxBatchSize: optionalInteger('LOGGING_INGEST_MAX_BATCH_SIZE'),
        maxMessageBytes: optionalInteger('LOGGING_INGEST_MAX_MESSAGE_BYTES'),
        maxLabels: optionalInteger('LOGGING_INGEST_MAX_LABELS'),
        maxFields: optionalInteger('LOGGING_INGEST_MAX_FIELDS'),
        maxKeyLength: optionalInteger('LOGGING_INGEST_MAX_KEY_LENGTH'),
        maxValueBytes: optionalInteger('LOGGING_INGEST_MAX_VALUE_BYTES'),
        maxJsonDepth: optionalInteger('LOGGING_INGEST_MAX_JSON_DEPTH'),
        rateLimitWindowSeconds: optionalInteger('LOGGING_RATE_LIMIT_WINDOW_SECONDS'),
        globalRequestsPerWindow: optionalInteger('LOGGING_GLOBAL_REQUESTS_PER_WINDOW'),
        globalEventsPerWindow: optionalInteger('LOGGING_GLOBAL_EVENTS_PER_WINDOW'),
        tokenRequestsPerWindow: optionalInteger('LOGGING_TOKEN_REQUESTS_PER_WINDOW'),
        tokenEventsPerWindow: optionalInteger('LOGGING_TOKEN_EVENTS_PER_WINDOW'),
      }),
      requestLimits: compact({
        requestBodyMaxBytes: optionalInteger('REQUEST_BODY_MAX_BYTES'),
        oauthBodyMaxBytes: optionalInteger('OAUTH_BODY_MAX_BYTES'),
        inferenceHttpBodyMaxBytes: legacyInferenceBodyBytes,
        inferenceWebSocketMaxPayloadBytes:
          legacyInferenceBodyBytes === undefined ? undefined : Math.min(legacyInferenceBodyBytes, 512 * 1024 * 1024),
        inferenceMaxConcurrentRequestsPerToken: optionalInteger('INFERENCE_MAX_CONCURRENT_REQUESTS_PER_TOKEN'),
        inferenceConcurrencyLeaseSeconds: optionalInteger('INFERENCE_CONCURRENCY_LEASE_SECONDS'),
      }),
      sessions: compact({ expirySeconds: optionalInteger('SESSION_EXPIRY') }),
      pkiDefaults: compact({
        crlValidityHours: optionalInteger('DEFAULT_CRL_VALIDITY_HOURS'),
        expiryWarningDays: optionalInteger('EXPIRY_WARNING_DAYS'),
        expiryCriticalDays: optionalInteger('EXPIRY_CRITICAL_DAYS'),
      }),
    },
    appUrl: optional('APP_URL'),
  };
}
