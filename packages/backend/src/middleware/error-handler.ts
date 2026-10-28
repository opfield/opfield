import type { Context, ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { logger } from '@/lib/logger.js';
import { isNodeConnectionError } from '@/lib/node-connection-error.js';
import { redactQueryError } from '@/lib/query-error-redaction.js';
import { InferenceProtocolError } from '@/modules/inference/protocol/inference-protocol.error.js';
import type { AppEnv } from '@/types.js';

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

/** Only explicit permission metadata is rendered; never serialize arbitrary error details into messages. */
function permissionErrorMessage(statusCode: number, message: string, details: unknown): string {
  if (statusCode !== 403 || !details || typeof details !== 'object' || Array.isArray(details)) return message;
  const metadata = details as Record<string, unknown>;
  const readScopes = (value: unknown): string[] => {
    const values = Array.isArray(value) ? value : [value];
    return [
      ...new Set(values.filter((scope): scope is string => typeof scope === 'string' && scope.trim().length > 0)),
    ];
  };
  const missing = readScopes(metadata.missingScope).concat(readScopes(metadata.missingScopes));
  const required = readScopes(metadata.requiredScope).concat(readScopes(metadata.requiredScopes));
  const scopes = [...new Set(missing.length ? missing : required)];
  if (!scopes.length) return message;
  // Do not infer AND/OR from an unqualified requiredScopes list. A missing list
  // is the guard's evaluated result, while requiredScopes may contain alternatives.
  const label =
    scopes.length === 1
      ? 'Required permission'
      : metadata.scopeMatch === 'any'
        ? 'Requires any one of these permissions'
        : missing.length || metadata.scopeMatch === 'all'
          ? 'Requires all of these permissions'
          : 'Required permissions';
  return `${message}. ${label}: ${scopes.join(', ')}`;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(permissionErrorMessage(statusCode, message, details));
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/** The code a thrown HTTPException answers with: what the status means, as the AI tools report it too. */
export const HTTP_EXCEPTION_CODES: Readonly<Record<number, string>> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
};

export function httpExceptionCode(status: number): string {
  return HTTP_EXCEPTION_CODES[status] ?? (status < 500 ? 'REQUEST_REFUSED' : 'HTTP_ERROR');
}

/**
 * PostgreSQL invalid_text_representation (22P02) for a uuid column, e.g. a
 * non-UUID path id reaching `WHERE id = $1`. Drizzle wraps the driver error,
 * so the SQLSTATE lives on `cause`; the message must sit on the same error
 * as the code (the wrapper's own message embeds the query text).
 */
export function isInvalidUuidError(err: unknown): boolean {
  return invalidUuidValue(err) !== null;
}

/** The value PostgreSQL refused as a uuid (see isInvalidUuidError), or null for any other error. */
export function invalidUuidValue(err: unknown): string | null {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const { code, message, cause } = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (code === '22P02' && typeof message === 'string' && /invalid input syntax for type uuid/i.test(message)) {
      return /type uuid: "(.*)"$/is.exec(message)?.[1] ?? '';
    }
    current = cause;
  }
  return null;
}

/**
 * The 404 text for an id that is not a UUID: says so, instead of a bare "Resource not found" that reads as if the
 * resource had been deleted.
 */
export function invalidUuidMessage(value: string | null): string {
  if (value === null) return 'Resource not found';
  const shown = value.length > 60 ? `${value.slice(0, 60)}...` : value;
  return value === ''
    ? 'Resource not found: an id is empty. Pass the resource id (a UUID) from the matching list operation.'
    : `Resource not found: "${shown}" is not a UUID. Pass the resource id (a UUID) from the matching list operation.`;
}

/** A zod validation error, also one thrown by another copy of zod (a separately built edition module). */
export function isZodError(err: unknown): err is ZodError {
  return (
    err instanceof ZodError ||
    (err instanceof Error && err.name === 'ZodError' && Array.isArray((err as ZodError).errors))
  );
}

/**
 * The `details` of a VALIDATION_ERROR: one entry per failed field, whose message says what the field expects (the
 * type of a missing field, a UUID, the allowed values) rather than only that it is wrong. The value sent is never
 * repeated.
 */
export function validationErrorDetails(err: ZodError): Array<{ path: string; message: string }> {
  return err.errors.map((e) => ({
    path: e.path.join('.'),
    message: describeValidationIssue(e),
  }));
}

function describeValidationIssue(issue: ZodError['errors'][number]): string {
  if (issue.code === 'invalid_type' && issue.received === 'undefined' && issue.message === 'Required') {
    return `Required (expected ${issue.expected})`;
  }
  if (issue.code === 'invalid_string' && issue.validation === 'uuid' && issue.message === 'Invalid uuid') {
    return 'Invalid uuid: expected the UUID of the resource (look it up with the matching list operation)';
  }
  if (issue.code === 'invalid_enum_value' && issue.message.startsWith('Invalid enum value')) {
    return `Expected one of: ${issue.options.map(String).join(', ')}`;
  }
  return issue.message;
}

/**
 * A 403 for a caller limited to folders, nodes or resources also names where it may act, as the MCP tool
 * errors do (lib/access-denied.ts); anything else, or a failed lookup, keeps the message.
 */
async function withLimitedAccessPointer(c: Context<AppEnv>, statusCode: number, message: string): Promise<string> {
  const scopes = c.get('effectiveScopes') ?? c.get('user')?.scopes;
  if (statusCode !== 403 || !scopes?.length) return message;
  try {
    // Loaded on use: nearly every module imports this one for AppError, so it pulls in no folder lookup itself.
    const [{ withLimitedAccessGuidance }, { accessSummaryDatabase }] = await Promise.all([
      import('@/lib/access-denied.js'),
      import('@/lib/access-summary-resolver.js'),
    ]);
    return await withLimitedAccessGuidance(message, scopes, accessSummaryDatabase());
  } catch {
    return message;
  }
}

export const errorHandler: ErrorHandler<AppEnv> = async (err, c) => {
  const requestId = c.get('requestId');

  if (err instanceof AppError) {
    if ((err.statusCode === 429 || err.statusCode === 503) && err.details && typeof err.details === 'object') {
      const retryAfterSeconds = (err.details as { retryAfterSeconds?: unknown }).retryAfterSeconds;
      if (typeof retryAfterSeconds === 'number') {
        c.header('Retry-After', String(retryAfterSeconds));
      }
    }
    logger.warn('Application error', {
      requestId,
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
    });

    return c.json<ApiError>(
      {
        code: err.code,
        message: await withLimitedAccessPointer(c, err.statusCode, err.message),
        details: err.details,
      },
      err.statusCode as 400
    );
  }

  if (err instanceof HTTPException) {
    logger.warn('HTTP exception', {
      requestId,
      status: err.status,
      message: err.message,
    });

    return c.json<ApiError>(
      {
        code: httpExceptionCode(err.status),
        message: await withLimitedAccessPointer(c, err.status, err.message),
      },
      err.status
    );
  }

  if (err instanceof InferenceProtocolError) {
    logger.warn('Inference application error', {
      requestId,
      code: err.code,
      message: err.message,
      statusCode: err.status,
    });
    return c.json<ApiError>(
      {
        code: err.code,
        message: err.message,
        details: err.details,
      },
      err.status as 400
    );
  }

  if (isZodError(err)) {
    logger.warn('Validation error', {
      requestId,
      errors: err.errors,
    });

    return c.json<ApiError>(
      {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: validationErrorDetails(err),
      },
      400
    );
  }

  if (isInvalidUuidError(err)) {
    logger.warn('Invalid uuid in request', {
      requestId,
      path: c.req.path,
    });
    return c.json<ApiError>({ code: 'NOT_FOUND', message: invalidUuidMessage(invalidUuidValue(err)) }, 404);
  }

  // A node lost while the request read from it (its control stream dropped): the node is unavailable, not Opfield.
  if (isNodeConnectionError(err)) {
    logger.warn('Node unavailable during a request', { requestId, path: c.req.path, message: (err as Error).message });
    return c.json<ApiError>(
      {
        code: 'NODE_UNAVAILABLE',
        message: 'The node lost its connection or did not answer. Try again once the node is online.',
      },
      503
    );
  }

  // A failed query's message carries its bound values: credential-like ones are redacted (lib/query-error-redaction.ts).
  const safeError = redactQueryError(err);
  logger.error('Unhandled error', {
    requestId,
    error:
      safeError instanceof Error
        ? {
            name: safeError.name,
            message: safeError.message,
            stack: safeError.stack,
          }
        : safeError,
  });

  const isProduction = process.env.NODE_ENV === 'production';

  return c.json<ApiError>(
    {
      code: 'INTERNAL_ERROR',
      message: isProduction
        ? 'An unexpected error occurred'
        : safeError instanceof Error
          ? safeError.message
          : 'Unknown error',
    },
    500
  );
};
