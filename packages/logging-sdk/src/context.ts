import type { NormalizedOpfieldLogEvent, OpfieldLogContext, OpfieldLogEvent } from './types.js';

export function mergeContext(...contexts: Array<OpfieldLogContext | undefined>): OpfieldLogContext {
  const merged: OpfieldLogContext = {};

  for (const context of contexts) {
    if (!context) continue;
    if (context.service !== undefined) merged.service = context.service;
    if (context.source !== undefined) merged.source = context.source;
    if (context.traceId !== undefined) merged.traceId = context.traceId;
    if (context.spanId !== undefined) merged.spanId = context.spanId;
    if (context.requestId !== undefined) merged.requestId = context.requestId;
    if (context.labels) merged.labels = { ...(merged.labels ?? {}), ...context.labels };
    if (context.fields) merged.fields = { ...(merged.fields ?? {}), ...context.fields };
  }

  return merged;
}

export function normalizeEvent(event: OpfieldLogEvent): NormalizedOpfieldLogEvent {
  const normalized: NormalizedOpfieldLogEvent = {
    severity: event.severity,
    message: event.message,
  };

  if (event.timestamp) normalized.timestamp = normalizeTimestamp(event.timestamp);
  if (event.service) normalized.service = event.service;
  if (event.source) normalized.source = event.source;
  if (event.traceId) normalized.traceId = event.traceId;
  if (event.spanId) normalized.spanId = event.spanId;
  if (event.requestId) normalized.requestId = event.requestId;

  const labels = normalizeLabels(event.labels);
  if (labels) normalized.labels = labels;

  const fields = normalizeFields(event.fields);
  if (fields) normalized.fields = fields;

  return normalized;
}

function normalizeTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeLabels(labels: OpfieldLogContext['labels']): Record<string, string> | undefined {
  if (!labels) return undefined;
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(labels)) {
    if (value === undefined || value === null) continue;
    normalized[key] = String(value);
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeFields(fields: OpfieldLogContext['fields']): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    normalized[key] = value instanceof Date ? value.toISOString() : value;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}
