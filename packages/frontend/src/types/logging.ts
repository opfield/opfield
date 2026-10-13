import type { AppMembershipRef } from "./apps";

export type LoggingSchemaMode = "loose" | "strip" | "reject";
export type LoggingSeverity = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
export type LoggingFieldType = "string" | "number" | "boolean" | "datetime" | "json";

export interface LoggingFieldDefinition {
  key: string;
  location: "label" | "field";
  type: LoggingFieldType;
  required: boolean;
  description?: string;
}

export interface LoggingEnvironment {
  /** Set when the environment is a member of an app environment. */
  app?: AppMembershipRef | null;
  /** Last use of one of its ingest tokens (null: never). */
  lastIngestAt?: string | null;
  id: string;
  name: string;
  slug: string;
  description: string | null;
  enabled: boolean;
  schemaId: string | null;
  schemaName: string | null;
  schemaMode: LoggingSchemaMode;
  retentionDays: number;
  rateLimitRequestsPerWindow: number | null;
  rateLimitEventsPerWindow: number | null;
  fieldSchema: LoggingFieldDefinition[];
  folderId?: string | null;
  sortOrder?: number;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LoggingSchema {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  schemaMode: LoggingSchemaMode;
  fieldSchema: LoggingFieldDefinition[];
  folderId?: string | null;
  sortOrder?: number;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LoggingIngestToken {
  id: string;
  environmentId: string;
  name: string;
  tokenPrefix: string;
  enabled: boolean;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdById: string | null;
  createdAt: string;
  token?: string;
}

export interface LoggingSearchRequest {
  from?: string;
  to?: string;
  severities?: LoggingSeverity[];
  services?: string[];
  sources?: string[];
  message?: string;
  messageMatch?: "contains" | "startsWith" | "endsWith";
  traceId?: string;
  spanId?: string;
  requestId?: string;
  labels?: Record<string, string>;
  fields?: Record<string, { op: string; value: unknown }>;
  expression?: LoggingSearchExpression;
  limit?: number;
  cursor?: string | null;
}

export type LoggingSearchExpression =
  | { type: "and" | "or"; children: LoggingSearchExpression[] }
  | { type: "not"; child: LoggingSearchExpression }
  | { type: "text"; value: string; match?: "contains" | "startsWith" | "endsWith" }
  | { type: "label"; key: string; op: "exists" | "eq" | "neq"; value?: string }
  | {
      type: "field";
      key: string;
      op: "eq" | "neq" | "contains" | "gt" | "gte" | "lt" | "lte";
      value: unknown;
    }
  | { type: "severity"; op: "eq" | "gt" | "gte" | "lt" | "lte"; value: LoggingSeverity }
  | {
      type: "service" | "source" | "traceId" | "spanId" | "requestId";
      op: "eq" | "neq";
      value: string;
    };

export interface LoggingSearchResult {
  eventId: string;
  timestamp: string;
  ingestedAt: string;
  environmentId: string;
  severity: LoggingSeverity;
  message: string;
  service: string;
  source: string;
  traceId: string;
  spanId: string;
  requestId: string;
  labels: Record<string, string>;
  fields: Record<string, unknown>;
}

export interface LoggingFacets {
  services: string[];
  sources: string[];
  severities: Array<{ severity: LoggingSeverity; count: number }>;
  labels: Record<string, string[]>;
}

export interface LoggingMetadata {
  services: string[];
  sources: string[];
  labelKeys: string[];
  fieldKeys: string[];
  labelValues: Record<string, string[]>;
}

export type LoggingStorageHealth =
  | "disabled"
  | "healthy"
  | "pressure"
  | "exhausted"
  | "degraded"
  | "unavailable";

export interface LoggingMaintenanceSnapshot {
  configured: boolean;
  status: LoggingStorageHealth;
  reason: string | null;
  checkedAt: string | null;
  structured: {
    rows: number;
    bytes: number;
    maxRows: number | null;
    maxSizeBytes: number | null;
    usageRatio: number;
  };
  internal: { rows: number; bytes: number; capBytes: number; warningBytes: number };
  disk: { totalBytes: number; freeBytes: number; freeRatio: number };
  maintenance: { lastCleanupAt: string | null; lastCleanupError: string | null };
}
