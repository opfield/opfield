export interface RateLimitSettings {
  windowMs: number;
  maxRequests: number;
  sessionMaxRequests: number;
  authMaxRequests: number;
  authLoginMaxRequests: number;
  authCallbackMaxRequests: number;
  setupMaxRequests: number;
  publicStatusMaxRequests: number;
  publicWebhookMaxRequests: number;
  pkiMaxRequests: number;
  streamMaxRequests: number;
  aiWebSocketMaxRequests: number;
  inferenceMaxRequests: number;
}

export interface LoggingIngestSettings {
  maxBodyBytes: number;
  maxBatchSize: number;
  maxMessageBytes: number;
  maxLabels: number;
  maxFields: number;
  maxKeyLength: number;
  maxValueBytes: number;
  maxJsonDepth: number;
  rateLimitWindowSeconds: number;
  globalRequestsPerWindow: number;
  globalEventsPerWindow: number;
  tokenRequestsPerWindow: number;
  tokenEventsPerWindow: number;
}

export interface RequestLimitSettings {
  requestBodyMaxBytes: number;
  oauthBodyMaxBytes: number;
  inferenceHttpBodyMaxBytes: number;
  inferenceWebSocketMaxPayloadBytes: number;
  inferenceMaxConcurrentRequestsPerToken: number;
  inferenceConcurrencyLeaseSeconds: number;
}

export interface SessionSettings {
  expirySeconds: number;
  /** Longest a session lives from sign-in, renewals included; null: no limit. */
  absoluteLifetimeSeconds: number | null;
}

export interface PkiDefaultSettings {
  crlValidityHours: number;
  expiryWarningDays: number;
  expiryCriticalDays: number;
}

export interface EnvironmentSettings {
  rateLimits: RateLimitSettings;
  loggingIngest: LoggingIngestSettings;
  requestLimits: RequestLimitSettings;
  sessions: SessionSettings;
  pkiDefaults: PkiDefaultSettings;
}

export type EnvironmentSettingsGroup = keyof EnvironmentSettings;

export type EnvironmentSettingsUpdate = {
  rateLimits?: Partial<Omit<RateLimitSettings, "setupMaxRequests">>;
  loggingIngest?: Partial<LoggingIngestSettings>;
  requestLimits?: Partial<RequestLimitSettings>;
  sessions?: Partial<SessionSettings>;
  pkiDefaults?: Partial<PkiDefaultSettings>;
};

export interface EnvironmentSettingsResponse {
  data: EnvironmentSettings;
  defaults: EnvironmentSettings;
}
