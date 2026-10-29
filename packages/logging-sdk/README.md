# Opfield Logging SDK

`@opfield/logger` is a Node-first TypeScript SDK for sending application logs into Opfield. It handles Opfield ingest tokens, context merging, batching, retries, rate-limit backoff, trace/span identifiers, and graceful shutdown flushing.

Use it when an external service, worker, script, or backend needs to write structured logs into Opfield without calling the ingest API manually.

## Installation

```sh
pnpm add @opfield/logger
```

```sh
npm install @opfield/logger
```

The package is ESM-only and ships TypeScript declarations. It expects a runtime with `fetch`; modern Node.js versions provide it globally. For older runtimes, pass a custom `fetch` implementation in the logger options.

### Moving from the 1.x package

`@opfield/logger` is the same SDK under a new name. Replace the 1.x package and the import path; the classes and types are named `Opfield*` (`OpfieldLogger`, `OpfieldLoggerHook`, `OpfieldLogOptions`, ...). 2.x still exports the 1.x names as deprecated aliases; 3.0 removes them, so move to the `Opfield*` names before updating to 3.0.

```sh
pnpm add @opfield/logger   # then remove the 1.x package
```

## Opfield Setup

1. Open Opfield.
2. Create a logging ingest token for the target schema/source.
3. Store the token as a server-side secret, for example `OPFIELD_LOGGING_TOKEN`.
4. Configure the SDK with your Opfield URL and token.

Logging ingest tokens use the `opfl_` prefix. Keep them server-side. Do not put them in browser bundles, public config, mobile apps, or any client-controlled code.

## Quick Start

```ts
import { OpfieldLogger } from "@opfield/logger";

const logger = new OpfieldLogger({
  endpoint: "https://opfield.example.com",
  token: process.env.OPFIELD_LOGGING_TOKEN!,
  service: "billing-api",
  source: "api",
  labels: {
    app: "billing",
    environment: process.env.NODE_ENV ?? "development",
  },
  fields: {
    version: process.env.npm_package_version,
  },
});

logger.info("Service started");

logger.error("Payment capture failed", {
  requestId: "req_123",
  labels: { provider: "stripe" },
  fields: {
    statusCode: 502,
    durationMs: 1834,
  },
});

await logger.flush();
await logger.close();
```

## Configuration

```ts
const logger = new OpfieldLogger({
  endpoint: "https://opfield.example.com",
  token: process.env.OPFIELD_LOGGING_TOKEN!,
  service: "billing-api",
  source: "api",
  traceId: "trace_123",
  spanId: "span_456",
  requestId: "req_123",
  labels: { app: "billing" },
  fields: { version: "1.4.0" },
  batching: {
    enabled: true,
    maxBatchSize: 100,
    flushIntervalMs: 5000,
    flushDebounceMs: 250,
    maxQueueSize: 10000,
    overflow: "drop-oldest",
  },
  retry: {
    maxAttempts: 5,
    minDelayMs: 500,
    maxDelayMs: 30000,
    jitter: true,
  },
  onError: (error, logs, failure) => {
    console.error("Opfield logging delivery failed", {
      reason: failure?.reason,
      status: failure?.status,
      count: logs?.length ?? 0,
      error,
    });
  },
  onDrop: (log, reason) => {
    console.warn("Opfield log dropped", reason, log.message);
  },
  onFallback: async (logs, failure) => {
    await persistFailedOpfieldLogs(logs, failure);
  },
});
```

### Logger Options

| Option | Type | Description |
| --- | --- | --- |
| `endpoint` | `string` | Base Opfield URL, for example `https://opfield.example.com`. Trailing slashes are removed automatically. |
| `token` | `string` | Opfield logging ingest token. |
| `service` | `string` | Logical service name attached to every log from this logger. |
| `source` | `string` | Source/channel name, such as `api`, `worker`, `cron`, or `queue`. |
| `traceId` | `string` | Default trace identifier attached to every log. |
| `spanId` | `string` | Default span identifier attached to every log. |
| `requestId` | `string` | Default request/correlation identifier attached to every log. |
| `labels` | `Record<string, string \| number \| boolean \| null \| undefined>` | Indexed dimensions. Values are normalized to strings; `null` and `undefined` values are dropped. |
| `fields` | `Record<string, OpfieldLogValue \| undefined>` | Structured event data. `Date` values are serialized to ISO strings; `undefined` values are dropped. |
| `batching` | `OpfieldBatchingOptions` | Queue and flush behavior. |
| `retry` | `OpfieldRetryOptions` | Retry and backoff behavior for transient delivery failures. |
| `fetch` | `typeof fetch` | Optional fetch implementation for custom runtimes or tests. |
| `onError` | `(error, logs?, failure?) => void` | Called when delivery fails or a fallback handler throws. Failed logs and failure metadata are included when available. |
| `onDrop` | `(log, reason) => void` | Called for each dropped log. |
| `onFallback` | `(logs, failure) => void \| Promise<void>` | Optional final handler for logs that could not be delivered after retries or were rejected permanently. Use this to write logs to disk, another queue, or another transport. |

## Writing Logs

The logger provides severity helpers for all Opfield severities:

```ts
logger.trace("Cache lookup", { fields: { key: "user:123" } });
logger.debug("Computed quote", { fields: { amount: 42.13 } });
logger.info("Checkout started");
logger.warn("Provider latency is high", { fields: { durationMs: 2900 } });
logger.error("Capture failed", { fields: { statusCode: 502 } });
logger.fatal("Worker cannot start", { fields: { reason: "missing_config" } });
```

You can also submit a complete event with `log`:

```ts
logger.log({
  timestamp: new Date(),
  severity: "info",
  message: "Invoice generated",
  service: "billing-worker",
  source: "invoice",
  labels: { tenant: "acme" },
  fields: { invoiceId: "inv_123", total: 149.99 },
});
```

## Context Merging

Context is inherited and merged from parent loggers, child loggers, and per-event options.

```ts
const root = new OpfieldLogger({
  endpoint: "https://opfield.example.com",
  token: process.env.OPFIELD_LOGGING_TOKEN!,
  service: "api",
  labels: { app: "billing", region: "eu" },
});

const payments = root.child({
  service: "billing-payments",
  labels: { module: "payments" },
  fields: { provider: "stripe" },
});

payments.error("Payment capture failed", {
  labels: { region: "us" },
  fields: { statusCode: 502 },
});
```

The emitted event uses:

- `service: "billing-payments"` because later scalar context overrides earlier scalar context.
- `labels: { app: "billing", region: "us", module: "payments" }` because labels are merged by key.
- `fields: { provider: "stripe", statusCode: 502 }` because fields are merged by key.

## Request Scoped Logging

Use `withContext` to create a temporary derived logger for a request, job, or operation.

```ts
await logger.withContext(
  {
    requestId: "req_123",
    labels: { route: "POST /payments" },
  },
  async (requestLogger) => {
    requestLogger.info("Request started");
    requestLogger.info("Request completed", { fields: { durationMs: 148 } });
  }
);
```

`withContext` returns the value returned by your callback and supports async callbacks.

## Traces And Spans

The SDK can create lightweight trace and span contexts. This does not require a separate tracing backend; it only attaches `traceId`, `spanId`, and optional names to Opfield log events.

```ts
const trace = logger.createTrace({
  name: "checkout",
  requestId: "req_123",
  labels: { flow: "checkout" },
});

trace.info("Checkout started");

const span = trace.createSpan("stripe.capture");
span.info("Capture requested");
span.error("Capture failed", {
  fields: { statusCode: 502, durationMs: 1834 },
});

await span.end();
await trace.end();
```

`createTrace` generates a UUID trace ID when one is not provided. `createSpan` keeps the trace ID and generates a UUID span ID when one is not provided. Passing a trace or span `name` stores it in `fields.traceName` or `fields.spanName`.

## Batching And Delivery

Logs are queued in memory and delivered to Opfield over HTTP:

- One event is sent to `/api/logging/ingest`.
- Multiple events are sent to `/api/logging/ingest/batch`.
- `Authorization: Bearer <token>` is used for every request.
- `Content-Type: application/json` is set automatically.

Default batching options:

| Option | Default | Description |
| --- | ---: | --- |
| `enabled` | `true` | Enables queued batching. When set to `false`, the SDK flushes one event at a time. |
| `maxBatchSize` | `100` | Maximum events sent in one batch. |
| `flushIntervalMs` | `5000` | Periodic flush interval. |
| `flushDebounceMs` | `250` | Delay after enqueue before a flush is scheduled. |
| `maxQueueSize` | `10000` | Maximum in-memory queued events. |
| `overflow` | `"drop-oldest"` | Queue overflow strategy: `"drop-oldest"` or `"drop-newest"`. |

Call `flush()` when you need to wait until currently queued logs are delivered:

```ts
logger.info("Job completed");
await logger.flush();
```

Call `close()` during shutdown. It stops timers, marks the logger closed, and flushes queued events:

```ts
await logger.close();
```

Events logged after `close()` are dropped with reason `"closed"`.

## Retries And Failures

The SDK retries transient delivery failures:

- Network errors.
- HTTP `408`.
- HTTP `425`.
- HTTP `429`.
- HTTP `5xx`.

Default retry options:

| Option | Default | Description |
| --- | ---: | --- |
| `maxAttempts` | `5` | Total send attempts for a batch. |
| `minDelayMs` | `500` | Initial backoff delay. |
| `maxDelayMs` | `30000` | Maximum backoff delay. |
| `jitter` | `true` | Adds random jitter to retry delays. |

For `429` responses, the SDK prefers the HTTP `Retry-After` header. If the header is absent, it also understands Opfield's `details.retryAfterSeconds` response shape.

Permanent validation or authorization failures are not retried. Those batches are dropped with reason `"permanent_failure"`. Retryable batches that still fail after `maxAttempts` are dropped with reason `"retry_exhausted"`.

When Opfield answers `409 LOGGING_DISABLED` (logging is turned off on that Opfield), the batch is dropped with reason `"permanent_failure"` and the logger sends nothing for 60 seconds. New logs wait in the queue meanwhile, within `maxQueueSize`; `close()` does not wait for the pause and drops them with reason `"closed"`.

When a batch cannot be delivered, the SDK calls callbacks in this order:

1. `onDrop(log, reason)` once for each failed log.
2. `onError(error, logs, failure)` with the failed log array and metadata.
3. `onFallback(logs, failure)` if configured.

`onFallback` is intended for recovery paths where logs should not disappear after Opfield delivery fails:

```ts
const logger = new OpfieldLogger({
  endpoint: "https://opfield.example.com",
  token: process.env.OPFIELD_LOGGING_TOKEN!,
  async onFallback(logs, failure) {
    await backupLogSink.write({
      reason: failure.reason,
      status: failure.status,
      logs,
    });
  },
});
```

If `onFallback` throws, the SDK calls `onError` again with the fallback error.

## Drop Reasons

`onDrop` receives the dropped log and one of these reasons:

| Reason | Meaning |
| --- | --- |
| `queue_full` | The in-memory queue reached `maxQueueSize`. |
| `closed` | Code attempted to log after `close()`. |
| `invalid_event` | Reserved for invalid event handling. |
| `permanent_failure` | Opfield rejected the batch with a non-retryable response. |
| `retry_exhausted` | Retry attempts were exhausted. |

Example:

```ts
const logger = new OpfieldLogger({
  endpoint: "https://opfield.example.com",
  token: process.env.OPFIELD_LOGGING_TOKEN!,
  onDrop(log, reason) {
    console.warn(`Dropped Opfield log: ${reason}`, log);
  },
});
```

## Shutdown Hooks

For long-running Node processes, install the shutdown hook so queued logs are flushed on common process shutdown signals:

```ts
import { OpfieldLoggerHook } from "@opfield/logger";

const uninstallHook = logger.hooks.install(OpfieldLoggerHook.SHUTDOWN);

logger.hooks.uninstall(OpfieldLoggerHook.SHUTDOWN);

// Later, if the logger lifecycle ends before the process:
uninstallHook();
await logger.close();
```

The shutdown hook listens for `SIGINT`, `SIGTERM`, and `beforeExit`. Hook installation is idempotent: calling `install(OpfieldLoggerHook.SHUTDOWN)` more than once does not register duplicate process listeners. The hook registry is intentionally exposed as `logger.hooks` so future SDK versions can add more hook types without adding more top-level logger methods.

## Framework Examples

### Express-style request middleware

```ts
app.use(async (req, res, next) => {
  const startedAt = Date.now();

  await logger.withContext(
    {
      requestId: req.headers["x-request-id"]?.toString(),
      labels: {
        method: req.method,
        route: req.path,
      },
    },
    async (requestLogger) => {
      requestLogger.info("Request started");

      res.once("finish", () => {
        requestLogger.info("Request completed", {
          fields: {
            statusCode: res.statusCode,
            durationMs: Date.now() - startedAt,
          },
        });
      });

      next();
    }
  );
});
```

### Worker job

```ts
export async function runJob(job: { id: string; tenantId: string }) {
  await logger.withContext(
    {
      requestId: job.id,
      labels: { worker: "invoice-sync", tenant: job.tenantId },
    },
    async (jobLogger) => {
      jobLogger.info("Job started");
      try {
        await syncInvoices(job);
        jobLogger.info("Job completed");
      } catch (error) {
        jobLogger.error("Job failed", {
          fields: { error: error instanceof Error ? error.message : String(error) },
        });
        throw error;
      } finally {
        await jobLogger.flush();
      }
    }
  );
}
```

## Data Modeling Guidance

Use `labels` for low-cardinality dimensions you want to filter or group by, such as `app`, `environment`, `region`, `tenant`, `module`, `route`, or `provider`.

Use `fields` for event-specific structured data, such as durations, status codes, entity IDs, error messages, payload sizes, or version information.

Avoid placing secrets, passwords, API keys, tokens, raw authorization headers, private keys, or credential material in either labels or fields. Opfield can store and search logs, so treat log content as durable operational data.

## API Reference

### `new OpfieldLogger(options)`

Creates an Opfield logger instance.

```ts
import { OpfieldLogger } from "@opfield/logger";
```

### `OpfieldLogger` class

```ts
class OpfieldLogger {
  readonly hooks: OpfieldLoggerHooks;
  constructor(options: OpfieldLoggerOptions);
  trace(message: string, options?: OpfieldLogOptions): void;
  debug(message: string, options?: OpfieldLogOptions): void;
  info(message: string, options?: OpfieldLogOptions): void;
  warn(message: string, options?: OpfieldLogOptions): void;
  error(message: string, options?: OpfieldLogOptions): void;
  fatal(message: string, options?: OpfieldLogOptions): void;
  log(event: OpfieldLogEvent): void;
  child(context: OpfieldLogContext): OpfieldLogger;
  createTrace(context?: OpfieldTraceContext): OpfieldTraceLogger;
  withContext<T>(context: OpfieldLogContext, fn: (logger: OpfieldLogger) => T | Promise<T>): Promise<T>;
  flush(): Promise<void>;
  close(): Promise<void>;
}
```

### Runtime Exports

- `OpfieldLogger`
- `OpfieldLoggerHook`

### Exported Types

The package exports these public types:

- `OpfieldBatchingOptions`
- `OpfieldLoggerMethods`
- `OpfieldLoggerHooks`
- `OpfieldLog`
- `OpfieldLogContext`
- `OpfieldLogDropReason`
- `OpfieldLogEvent`
- `OpfieldLogFailureInfo`
- `OpfieldLogFailureReason`
- `OpfieldLoggerOptions`
- `OpfieldLogOptions`
- `OpfieldLogSeverity`
- `OpfieldLogValue`
- `OpfieldRetryOptions`
- `OpfieldSpanContext`
- `OpfieldSpanLogger`
- `OpfieldTraceContext`
- `OpfieldTraceLogger`

## Development

From the repository root:

```sh
pnpm --filter @opfield/logger test
pnpm --filter @opfield/logger lint
pnpm --filter @opfield/logger typecheck
pnpm --filter @opfield/logger build
```

The package publishes `dist` only.
