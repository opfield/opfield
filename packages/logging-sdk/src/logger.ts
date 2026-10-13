import { mergeContext, normalizeEvent } from './context.js';
import { createSpanId, createTraceId } from './ids.js';
import { OpfieldLogQueue } from './queue.js';
import { createOpfieldTransport } from './transport.js';
import type {
  OpfieldBatchingOptions,
  OpfieldLogContext,
  OpfieldLogEvent,
  OpfieldLoggerHooks,
  OpfieldLoggerMethods,
  OpfieldLoggerOptions,
  OpfieldLogOptions,
  OpfieldLogSeverity,
  OpfieldRetryOptions,
  OpfieldSpanContext,
  OpfieldSpanLogger,
  OpfieldTraceContext,
  OpfieldTraceLogger,
} from './types.js';
import { OpfieldLoggerHook } from './types.js';

interface OpfieldLoggerState {
  context: OpfieldLogContext;
  queue: OpfieldLogQueue;
  hooks: OpfieldLoggerHookRegistry;
}

const loggerState = new WeakMap<OpfieldLogger, OpfieldLoggerState>();

const DEFAULT_BATCHING: Required<OpfieldBatchingOptions> = {
  enabled: true,
  maxBatchSize: 100,
  flushIntervalMs: 5000,
  flushDebounceMs: 250,
  maxQueueSize: 10_000,
  overflow: 'drop-oldest',
};

const DEFAULT_RETRY: Required<OpfieldRetryOptions> = {
  maxAttempts: 5,
  minDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: true,
};

export class OpfieldLogger implements OpfieldLoggerMethods {
  constructor(options: OpfieldLoggerOptions) {
    const batching = normalizeBatchingOptions(options.batching);
    const retry = { ...DEFAULT_RETRY, ...options.retry };
    const transport = createOpfieldTransport({
      endpoint: options.endpoint,
      token: options.token,
      fetch: options.fetch,
    });
    const queue = new OpfieldLogQueue({
      transport,
      maxBatchSize: batching.maxBatchSize,
      flushIntervalMs: batching.flushIntervalMs,
      flushDebounceMs: batching.flushDebounceMs,
      maxQueueSize: batching.maxQueueSize,
      overflow: batching.overflow,
      retry,
      onError: options.onError,
      onDrop: options.onDrop,
      onFallback: options.onFallback,
    });
    loggerState.set(this, {
      context: {
        service: options.service,
        source: options.source,
        traceId: options.traceId,
        spanId: options.spanId,
        requestId: options.requestId,
        labels: options.labels,
        fields: options.fields,
      },
      queue,
      hooks: new OpfieldLoggerHookRegistry(queue),
    });
  }

  get hooks(): OpfieldLoggerHooks {
    return getLoggerState(this).hooks;
  }

  trace(message: string, options?: OpfieldLogOptions): void {
    this.emit('trace', message, options);
  }

  debug(message: string, options?: OpfieldLogOptions): void {
    this.emit('debug', message, options);
  }

  info(message: string, options?: OpfieldLogOptions): void {
    this.emit('info', message, options);
  }

  warn(message: string, options?: OpfieldLogOptions): void {
    this.emit('warn', message, options);
  }

  error(message: string, options?: OpfieldLogOptions): void {
    this.emit('error', message, options);
  }

  fatal(message: string, options?: OpfieldLogOptions): void {
    this.emit('fatal', message, options);
  }

  log(event: OpfieldLogEvent): void {
    const state = getLoggerState(this);
    const merged = mergeContext(state.context, event);
    state.queue.enqueue(
      normalizeEvent({
        ...merged,
        severity: event.severity,
        message: event.message,
        timestamp: event.timestamp,
      })
    );
  }

  child(context: OpfieldLogContext): OpfieldLogger {
    const state = getLoggerState(this);
    return createLoggerFromState({
      context: mergeContext(state.context, context),
      queue: state.queue,
      hooks: state.hooks,
    });
  }

  createTrace(context?: OpfieldTraceContext): OpfieldTraceLogger {
    const state = getLoggerState(this);
    return new OpfieldTraceLoggerImpl(state.context, state.queue, state.hooks, context);
  }

  async withContext<T>(context: OpfieldLogContext, fn: (logger: OpfieldLogger) => T | Promise<T>): Promise<T> {
    return fn(this.child(context));
  }

  flush(): Promise<void> {
    return getLoggerState(this).queue.flush();
  }

  close(): Promise<void> {
    return getLoggerState(this).queue.close();
  }

  private emit(severity: OpfieldLogSeverity, message: string, options?: OpfieldLogOptions): void {
    const state = getLoggerState(this);
    const merged = mergeContext(state.context, options);
    state.queue.enqueue(normalizeEvent({ ...merged, severity, message, timestamp: options?.timestamp }));
  }
}

function createLoggerFromState(state: OpfieldLoggerState): OpfieldLogger {
  const logger = Object.create(OpfieldLogger.prototype) as OpfieldLogger;
  loggerState.set(logger, state);
  return logger;
}

function getLoggerState(logger: OpfieldLogger): OpfieldLoggerState {
  const state = loggerState.get(logger);
  if (!state) {
    throw new TypeError('OpfieldLogger was not initialized');
  }
  return state;
}

function normalizeBatchingOptions(options: OpfieldBatchingOptions | undefined): Required<OpfieldBatchingOptions> {
  const batching = { ...DEFAULT_BATCHING, ...options };
  if (batching.enabled) return batching;
  return { ...batching, maxBatchSize: 1, flushDebounceMs: 0 };
}

class OpfieldTraceLoggerImpl implements OpfieldTraceLogger {
  readonly traceId: string;
  private readonly base: OpfieldLogger;
  private readonly context: OpfieldLogContext;

  constructor(
    parentContext: OpfieldLogContext,
    private readonly queue: OpfieldLogQueue,
    private readonly hooksRegistry: OpfieldLoggerHookRegistry,
    traceContext?: OpfieldTraceContext
  ) {
    this.traceId = traceContext?.traceId ?? parentContext.traceId ?? createTraceId();
    const fields = traceContext?.name ? { ...traceContext.fields, traceName: traceContext.name } : traceContext?.fields;
    this.context = mergeContext(parentContext, traceContext, { traceId: this.traceId, fields });
    this.base = createLoggerFromState({ context: this.context, queue, hooks: hooksRegistry });
  }

  get hooks(): OpfieldLoggerHooks {
    return this.base.hooks;
  }

  trace(message: string, options?: OpfieldLogOptions): void {
    this.base.trace(message, options);
  }

  debug(message: string, options?: OpfieldLogOptions): void {
    this.base.debug(message, options);
  }

  info(message: string, options?: OpfieldLogOptions): void {
    this.base.info(message, options);
  }

  warn(message: string, options?: OpfieldLogOptions): void {
    this.base.warn(message, options);
  }

  error(message: string, options?: OpfieldLogOptions): void {
    this.base.error(message, options);
  }

  fatal(message: string, options?: OpfieldLogOptions): void {
    this.base.fatal(message, options);
  }

  log(event: OpfieldLogEvent): void {
    this.base.log(event);
  }

  child(context: OpfieldLogContext): OpfieldLoggerMethods {
    return this.base.child(context);
  }

  createTrace(context?: OpfieldTraceContext): OpfieldTraceLogger {
    return this.base.createTrace(context);
  }

  async withContext<T>(context: OpfieldLogContext, fn: (logger: OpfieldLoggerMethods) => T | Promise<T>): Promise<T> {
    return this.base.withContext(context, fn);
  }

  flush(): Promise<void> {
    return this.base.flush();
  }

  close(): Promise<void> {
    return this.base.close();
  }

  createSpan(spanContext?: OpfieldSpanContext | string): OpfieldSpanLogger {
    return new OpfieldSpanLoggerImpl(this.context, this.queue, this.hooksRegistry, spanContext);
  }

  async end(message = 'Trace ended', options?: OpfieldLogOptions): Promise<void> {
    this.info(message, options);
    await this.flush();
  }
}

class OpfieldSpanLoggerImpl implements OpfieldSpanLogger {
  readonly traceId: string;
  readonly spanId: string;
  private readonly base: OpfieldLogger;

  constructor(
    traceContext: OpfieldLogContext,
    queue: OpfieldLogQueue,
    hooks: OpfieldLoggerHookRegistry,
    spanContext?: OpfieldSpanContext | string
  ) {
    const normalizedContext: OpfieldSpanContext | undefined =
      typeof spanContext === 'string' ? { name: spanContext } : spanContext;
    this.traceId = traceContext.traceId ?? createTraceId();
    this.spanId = normalizedContext?.spanId ?? createSpanId();
    const fields = normalizedContext?.name
      ? { ...normalizedContext.fields, spanName: normalizedContext.name }
      : normalizedContext?.fields;
    this.base = createLoggerFromState({
      context: mergeContext(traceContext, normalizedContext, { traceId: this.traceId, spanId: this.spanId, fields }),
      queue,
      hooks,
    });
  }

  get hooks(): OpfieldLoggerHooks {
    return this.base.hooks;
  }

  trace(message: string, options?: OpfieldLogOptions): void {
    this.base.trace(message, options);
  }

  debug(message: string, options?: OpfieldLogOptions): void {
    this.base.debug(message, options);
  }

  info(message: string, options?: OpfieldLogOptions): void {
    this.base.info(message, options);
  }

  warn(message: string, options?: OpfieldLogOptions): void {
    this.base.warn(message, options);
  }

  error(message: string, options?: OpfieldLogOptions): void {
    this.base.error(message, options);
  }

  fatal(message: string, options?: OpfieldLogOptions): void {
    this.base.fatal(message, options);
  }

  log(event: OpfieldLogEvent): void {
    this.base.log(event);
  }

  child(context: OpfieldLogContext): OpfieldLoggerMethods {
    return this.base.child(context);
  }

  createTrace(context?: OpfieldTraceContext): OpfieldTraceLogger {
    return this.base.createTrace(context);
  }

  async withContext<T>(context: OpfieldLogContext, fn: (logger: OpfieldLoggerMethods) => T | Promise<T>): Promise<T> {
    return this.base.withContext(context, fn);
  }

  flush(): Promise<void> {
    return this.base.flush();
  }

  close(): Promise<void> {
    return this.base.close();
  }

  async end(message = 'Span ended', options?: OpfieldLogOptions): Promise<void> {
    this.info(message, options);
    await this.flush();
  }
}

class OpfieldLoggerHookRegistry implements OpfieldLoggerHooks {
  private readonly installedHooks = new Map<OpfieldLoggerHook, () => void>();

  constructor(private readonly queue: OpfieldLogQueue) {}

  install(hook: OpfieldLoggerHook): () => void {
    if (!this.installedHooks.has(hook)) {
      this.installedHooks.set(hook, this.createHookUninstaller(hook));
    }
    return () => this.uninstall(hook);
  }

  uninstall(hook: OpfieldLoggerHook): void {
    const uninstall = this.installedHooks.get(hook);
    if (!uninstall) return;
    this.installedHooks.delete(hook);
    uninstall();
  }

  private createHookUninstaller(hook: OpfieldLoggerHook): () => void {
    switch (hook) {
      case OpfieldLoggerHook.SHUTDOWN:
        return this.installShutdownHook();
    }
  }

  private installShutdownHook(): () => void {
    const handler = () => {
      void this.queue.close();
    };

    process.once('SIGINT', handler);
    process.once('SIGTERM', handler);
    process.once('beforeExit', handler);

    return () => {
      process.off('SIGINT', handler);
      process.off('SIGTERM', handler);
      process.off('beforeExit', handler);
    };
  }
}
