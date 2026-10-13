export type OpfieldLogSeverity = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export type OpfieldJsonObject = { [key: string]: OpfieldLogValue };
export type OpfieldJsonArray = OpfieldLogValue[];
export type OpfieldLogValue = string | number | boolean | Date | null | OpfieldJsonObject | OpfieldJsonArray;

export interface OpfieldLogContext {
  service?: string;
  source?: string;
  traceId?: string;
  spanId?: string;
  requestId?: string;
  labels?: Record<string, string | number | boolean | null | undefined>;
  fields?: Record<string, OpfieldLogValue | undefined>;
}

export interface OpfieldLogEvent extends OpfieldLogContext {
  timestamp?: string | Date;
  severity: OpfieldLogSeverity;
  message: string;
}

export interface OpfieldLogOptions extends OpfieldLogContext {
  timestamp?: string | Date;
}

export interface OpfieldBatchingOptions {
  enabled?: boolean;
  maxBatchSize?: number;
  flushIntervalMs?: number;
  flushDebounceMs?: number;
  maxQueueSize?: number;
  overflow?: 'drop-oldest' | 'drop-newest';
}

export interface OpfieldRetryOptions {
  maxAttempts?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
}

export type OpfieldLog = NormalizedOpfieldLogEvent;
export type OpfieldLogFailureReason = 'permanent_failure' | 'retry_exhausted';

export interface OpfieldLogFailureInfo {
  reason: OpfieldLogFailureReason;
  error?: unknown;
  status?: number;
}

export enum OpfieldLoggerHook {
  SHUTDOWN = 'shutdown',
}

export interface OpfieldLoggerHooks {
  install(hook: OpfieldLoggerHook): () => void;
  uninstall(hook: OpfieldLoggerHook): void;
}

export interface OpfieldLoggerOptions extends OpfieldLogContext {
  endpoint: string;
  token: string;
  batching?: OpfieldBatchingOptions;
  retry?: OpfieldRetryOptions;
  fetch?: typeof fetch;
  onError?: (error: unknown, logs?: readonly OpfieldLog[], failure?: OpfieldLogFailureInfo) => void;
  onDrop?: (log: OpfieldLog, reason: OpfieldLogDropReason) => void;
  onFallback?: (logs: readonly OpfieldLog[], failure: OpfieldLogFailureInfo) => void | Promise<void>;
}

export type OpfieldLogDropReason = 'queue_full' | 'closed' | 'invalid_event' | 'permanent_failure' | 'retry_exhausted';

export interface OpfieldLoggerMethods {
  readonly hooks: OpfieldLoggerHooks;
  trace(message: string, options?: OpfieldLogOptions): void;
  debug(message: string, options?: OpfieldLogOptions): void;
  info(message: string, options?: OpfieldLogOptions): void;
  warn(message: string, options?: OpfieldLogOptions): void;
  error(message: string, options?: OpfieldLogOptions): void;
  fatal(message: string, options?: OpfieldLogOptions): void;
  log(event: OpfieldLogEvent): void;
  child(context: OpfieldLogContext): OpfieldLoggerMethods;
  createTrace(context?: OpfieldTraceContext): OpfieldTraceLogger;
  withContext<T>(context: OpfieldLogContext, fn: (logger: OpfieldLoggerMethods) => T | Promise<T>): Promise<T>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface OpfieldTraceContext extends OpfieldLogContext {
  name?: string;
  traceId?: string;
}

export interface OpfieldSpanContext extends OpfieldLogContext {
  name?: string;
  spanId?: string;
}

export interface OpfieldTraceLogger extends OpfieldLoggerMethods {
  readonly traceId: string;
  createSpan(context?: OpfieldSpanContext | string): OpfieldSpanLogger;
  end(message?: string, options?: OpfieldLogOptions): Promise<void>;
}

export interface OpfieldSpanLogger extends OpfieldLoggerMethods {
  readonly traceId: string;
  readonly spanId: string;
  end(message?: string, options?: OpfieldLogOptions): Promise<void>;
}

export interface NormalizedOpfieldLogEvent {
  timestamp?: string;
  severity: OpfieldLogSeverity;
  message: string;
  service?: string;
  source?: string;
  traceId?: string;
  spanId?: string;
  requestId?: string;
  labels?: Record<string, string>;
  fields?: Record<string, unknown>;
}
