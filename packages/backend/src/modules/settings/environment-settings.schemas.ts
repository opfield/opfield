import { z } from '@hono/zod-openapi';

const positiveInt = (min: number, max: number) => z.number().int().min(min).max(max);

export const REQUEST_LIMIT_MAXIMUMS = {
  requestBodyMaxBytes: 32 * 1024 * 1024,
  oauthBodyMaxBytes: 1024 * 1024,
  inferenceHttpBodyMaxBytes: 2048 * 1024 * 1024,
  inferenceWebSocketMaxPayloadBytes: 512 * 1024 * 1024,
  inferenceMaxConcurrentRequestsPerToken: 128,
  inferenceConcurrencyLeaseSeconds: 2_400,
} as const;

export const RateLimitSettingsSchema = z
  .object({
    windowMs: positiveInt(1_000, 3_600_000),
    maxRequests: positiveInt(1, 1_000_000),
    sessionMaxRequests: positiveInt(1, 1_000_000),
    authMaxRequests: positiveInt(1, 1_000_000),
    authLoginMaxRequests: positiveInt(1, 1_000_000),
    authCallbackMaxRequests: positiveInt(1, 1_000_000),
    setupMaxRequests: positiveInt(1, 1_000_000),
    publicStatusMaxRequests: positiveInt(1, 1_000_000),
    publicWebhookMaxRequests: positiveInt(1, 1_000_000),
    pkiMaxRequests: positiveInt(1, 1_000_000),
    streamMaxRequests: positiveInt(1, 1_000_000),
    aiWebSocketMaxRequests: positiveInt(1, 1_000_000),
    inferenceMaxRequests: positiveInt(1, 1_000_000),
  })
  .strict();

export const LoggingIngestSettingsSchema = z
  .object({
    maxBodyBytes: positiveInt(1_024, 256 * 1024 * 1024),
    maxBatchSize: positiveInt(1, 10_000),
    maxMessageBytes: positiveInt(256, 4 * 1024 * 1024),
    maxLabels: positiveInt(1, 1_024),
    maxFields: positiveInt(1, 1_024),
    maxKeyLength: positiveInt(1, 1_024),
    maxValueBytes: positiveInt(256, 4 * 1024 * 1024),
    maxJsonDepth: positiveInt(1, 32),
    rateLimitWindowSeconds: positiveInt(1, 3_600),
    globalRequestsPerWindow: positiveInt(1, 10_000_000),
    globalEventsPerWindow: positiveInt(1, 100_000_000),
    tokenRequestsPerWindow: positiveInt(1, 10_000_000),
    tokenEventsPerWindow: positiveInt(1, 100_000_000),
  })
  .strict();

export const RequestLimitSettingsSchema = z
  .object({
    requestBodyMaxBytes: positiveInt(64 * 1024, REQUEST_LIMIT_MAXIMUMS.requestBodyMaxBytes),
    oauthBodyMaxBytes: positiveInt(8 * 1024, REQUEST_LIMIT_MAXIMUMS.oauthBodyMaxBytes),
    inferenceHttpBodyMaxBytes: positiveInt(1024 * 1024, REQUEST_LIMIT_MAXIMUMS.inferenceHttpBodyMaxBytes),
    inferenceWebSocketMaxPayloadBytes: positiveInt(
      1024 * 1024,
      REQUEST_LIMIT_MAXIMUMS.inferenceWebSocketMaxPayloadBytes
    ),
    inferenceMaxConcurrentRequestsPerToken: positiveInt(
      1,
      REQUEST_LIMIT_MAXIMUMS.inferenceMaxConcurrentRequestsPerToken
    ),
    inferenceConcurrencyLeaseSeconds: positiveInt(30, REQUEST_LIMIT_MAXIMUMS.inferenceConcurrencyLeaseSeconds),
  })
  .strict();

export const SessionSettingsSchema = z
  .object({
    expirySeconds: positiveInt(300, 365 * 24 * 60 * 60),
    /** The longest a browser session lives from sign-in, renewals included; null: no such limit. */
    absoluteLifetimeSeconds: positiveInt(300, 365 * 24 * 60 * 60).nullable(),
  })
  .strict();

export const PkiDefaultSettingsBaseSchema = z
  .object({
    crlValidityHours: positiveInt(1, 30 * 24),
    expiryWarningDays: positiveInt(1, 10 * 365),
    expiryCriticalDays: positiveInt(1, 10 * 365),
  })
  .strict();

export const PkiDefaultSettingsSchema = PkiDefaultSettingsBaseSchema.refine(
  (value) => value.expiryCriticalDays <= value.expiryWarningDays,
  {
    message: 'Critical expiry threshold must not exceed warning threshold',
    path: ['expiryCriticalDays'],
  }
);

export const EnvironmentSettingsSchema = z
  .object({
    rateLimits: RateLimitSettingsSchema,
    loggingIngest: LoggingIngestSettingsSchema,
    requestLimits: RequestLimitSettingsSchema,
    sessions: SessionSettingsSchema,
    pkiDefaults: PkiDefaultSettingsSchema,
  })
  .strict();

export const EnvironmentSettingsUpdateSchema = z
  .object({
    rateLimits: RateLimitSettingsSchema.omit({ setupMaxRequests: true }).partial().strict().optional(),
    loggingIngest: LoggingIngestSettingsSchema.partial().strict().optional(),
    requestLimits: RequestLimitSettingsSchema.partial().strict().optional(),
    sessions: SessionSettingsSchema.partial().strict().optional(),
    pkiDefaults: PkiDefaultSettingsBaseSchema.partial().strict().optional(),
  })
  .strict();

export type EnvironmentSettings = z.infer<typeof EnvironmentSettingsSchema>;
export type EnvironmentSettingsUpdate = z.infer<typeof EnvironmentSettingsUpdateSchema>;
export type EnvironmentSettingsLegacyUpdate = {
  [Group in keyof EnvironmentSettings]?: Partial<EnvironmentSettings[Group]>;
};
