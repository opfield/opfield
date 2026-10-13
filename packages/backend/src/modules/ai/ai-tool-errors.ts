import { HTTPException } from 'hono/http-exception';
import { AppError, isInvalidUuidError, isZodError, validationErrorDetails } from '@/middleware/error-handler.js';

/**
 * A failed tool call as the REST API reports the same failure: its error code, message and details. MCP clients
 * and the assistant read the code from the text (`NOT_FOUND: Deployment not found`), as REST callers read it from
 * the JSON body.
 */
export interface ToolError {
  code?: string;
  message: string;
  details?: unknown;
  /**
   * A refusal the caller can act on (permission, validation, not found, conflict), logged without a stack; an
   * unexpected failure keeps its stack.
   */
  expected: boolean;
}

/** Tool helpers report a refusal as a plain error that starts with its code (`PERMISSION_DENIED: ...`). */
const CODE_PREFIX = /^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+):\s/;
const DETAILS_MAX_LENGTH = 2000;
const HTTP_EXCEPTION_CODES: Readonly<Record<number, string>> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
};

export function describeToolError(err: unknown): ToolError {
  if (err instanceof AppError) {
    // A 403 already names the missing permissions in its message (AppError renders that metadata).
    const details = err.statusCode === 403 ? undefined : err.details;
    return { code: err.code, message: err.message, details, expected: err.statusCode < 500 };
  }
  if (isZodError(err)) {
    return {
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: validationErrorDetails(err),
      expected: true,
    };
  }
  if (isInvalidUuidError(err)) return { code: 'NOT_FOUND', message: 'Resource not found', expected: true };
  // Route middleware reused by tools (Docker resource access) refuses with an HTTPException: report it with the
  // code the REST API would give it, so a missing scope reads as PERMISSION_DENIED instead of a failure.
  if (err instanceof HTTPException) {
    const code = HTTP_EXCEPTION_CODES[err.status] ?? (err.status < 500 ? 'REQUEST_REFUSED' : undefined);
    return { code, message: err.message || 'Request failed', expected: err.status < 500 };
  }
  const message = err instanceof Error ? err.message : 'Tool execution failed';
  const code = CODE_PREFIX.exec(message)?.[1];
  return code ? { code, message, expected: true } : { message, expected: false };
}

function detailsText(details: unknown): string {
  try {
    const text = JSON.stringify(details);
    return text.length > DETAILS_MAX_LENGTH ? `${text.slice(0, DETAILS_MAX_LENGTH)}...` : text;
  } catch {
    return '';
  }
}

/** The error text of a tool result: `CODE: message`, then the field errors of a validation error or the details. */
export function formatToolError(error: ToolError): string {
  const message =
    error.code && !error.message.startsWith(`${error.code}:`) ? `${error.code}: ${error.message}` : error.message;
  if (error.details === undefined || error.details === null) return message;
  if (error.code === 'VALIDATION_ERROR' && Array.isArray(error.details)) {
    const fields = error.details.map((entry: { path?: unknown; message?: unknown }) => {
      const path = typeof entry?.path === 'string' && entry.path ? entry.path : '(root)';
      return `${path}: ${String(entry?.message ?? 'invalid')}`;
    });
    return fields.length > 0 ? `${message}: ${fields.join('; ')}` : message;
  }
  const details = detailsText(error.details);
  if (!details) return message;
  return `${message}${/[.!?]$/.test(message) ? '' : '.'} Details: ${details}`;
}
