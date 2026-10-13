import type { LoggingFieldDefinition, LoggingSchemaMode } from '@/db/schema/index.js';
import type { AppMemberRef } from '@/modules/apps/app-membership.js';

export type LoggingSeverity = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export const LOGGING_SEVERITIES: LoggingSeverity[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

export const SEVERITY_NUMBER: Record<LoggingSeverity, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export interface LoggingEnvironmentView {
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
  folderId: string | null;
  sortOrder: number;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  /** Its app and environment when it is an app member (null outside apps). */
  app?: AppMemberRef | null;
  /** Last time one of its ingest tokens was used (null: never). */
  lastIngestAt?: string | null;
}

export interface LoggingSchemaView {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  schemaMode: LoggingSchemaMode;
  fieldSchema: LoggingFieldDefinition[];
  folderId: string | null;
  sortOrder: number;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LoggingClickHouseRow {
  EventId: string;
  Timestamp: string;
  EnvironmentId: string;
  RetentionDays: number;
  Service: string;
  Source: string;
  Severity: LoggingSeverity;
  SeverityNumber: number;
  Message: string;
  TraceId: string;
  SpanId: string;
  RequestId: string;
  Labels: Record<string, string>;
  FieldStrings: Record<string, string>;
  FieldNumbers: Record<string, number>;
  FieldBooleans: Record<string, 0 | 1>;
  FieldDatetimes: Record<string, string>;
  FieldsJson: string;
}

export interface LoggingSearchRequest {
  from?: string;
  to?: string;
  severities?: LoggingSeverity[];
  services?: string[];
  sources?: string[];
  message?: string;
  messageMatch?: 'contains' | 'startsWith' | 'endsWith';
  traceId?: string;
  spanId?: string;
  requestId?: string;
  labels?: Record<string, string>;
  fields?: Record<string, { op: string; value: unknown }>;
  expression?: LoggingSearchExpression;
  limit: number;
  cursor?: string | null;
}

export type LoggingSearchExpression =
  | { type: 'and' | 'or'; children: LoggingSearchExpression[] }
  | { type: 'not'; child: LoggingSearchExpression }
  | { type: 'text'; value: string; match?: 'contains' | 'startsWith' | 'endsWith' }
  | { type: 'label'; key: string; op: 'exists' | 'eq' | 'neq'; value?: string }
  | { type: 'field'; key: string; op: 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte'; value: unknown }
  | { type: 'severity'; op: 'eq' | 'gt' | 'gte' | 'lt' | 'lte'; value: LoggingSeverity }
  | { type: 'service' | 'source' | 'traceId' | 'spanId' | 'requestId'; op: 'eq' | 'neq'; value: string };

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
