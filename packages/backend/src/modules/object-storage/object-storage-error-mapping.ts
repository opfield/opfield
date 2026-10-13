import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';

const logger = createChildLogger('ObjectStorageErrors');

export type ObjectStorageOperation = 'connect' | 'object';

/**
 * Errors a managed cluster produces while it is still coming up: the daemon
 * has published the port but the server behind it is not accepting requests
 * yet. Distinguished from the rest because they are worth retrying, whereas a
 * bad certificate or a refused credential will fail identically forever.
 */
const WARMUP_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE']);

export function isStorageWarmupError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && WARMUP_ERROR_CODES.has(code);
}

const CONNECTIVITY_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EPIPE',
  // A TLS handshake the server ended with an alert, e.g. while it is still loading its certificate.
  'EPROTO',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'NetworkingError',
  'TimeoutError',
]);

const AUTH_ERROR_NAMES = new Set([
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'AccessDenied',
  'InvalidToken',
  'ExpiredToken',
  'AccountProblem',
]);

const NOT_FOUND_NAMES = new Set(['NoSuchBucket', 'NoSuchKey', 'NotFound']);

/** Statuses of a server that is up but cannot serve the request right now (not 501: an unsupported operation). */
const UNAVAILABLE_HTTP_STATUSES = new Set([500, 502, 503, 504]);

interface AwsLikeError extends Error {
  code?: string;
  name: string;
  $metadata?: { httpStatusCode?: number };
}

/**
 * The SDK could not parse the reply (an HTML error page, a proxy or a non-S3 server): the message is the
 * parser's text plus a hint about the hidden `$response` field. Neither belongs in the UI. Modeled S3 errors
 * (AccessDenied, NoSuchBucket) also carry `$response`, so the message decides, not the field.
 */
function isUnparsableResponse(message: string): boolean {
  return message.includes('Deserialization error') || message.includes('XML parse error');
}

/** Short user message for a reply the SDK could not read; the raw SDK text goes to the server log only. */
function unparsableResponseError(err: AwsLikeError, operation: ObjectStorageOperation): AppError {
  const httpStatus = err.$metadata?.httpStatusCode;
  logger.warn('Object storage endpoint returned a response the S3 client could not read', {
    operation,
    httpStatus,
    error: err.message,
  });
  const status = httpStatus !== undefined ? ` (HTTP ${httpStatus})` : '';
  if (httpStatus !== undefined && UNAVAILABLE_HTTP_STATUSES.has(httpStatus)) {
    return new AppError(
      503,
      'STORAGE_UNAVAILABLE',
      `The storage server could not handle the request right now${status}. Retry shortly.`
    );
  }
  return new AppError(
    422,
    'STORAGE_CONNECTION_FAILED',
    `The endpoint is reachable but did not return a valid S3 response${status}. Check the endpoint URL and credentials.`
  );
}

/**
 * Map an AWS SDK / networking error to an AppError. Returns null when the caller
 * should keep its own generic handling.
 */
export function mapObjectStorageError(error: unknown, operation: ObjectStorageOperation): AppError | null {
  if (error instanceof AppError) return error;
  if (!(error instanceof Error)) return null;

  const err = error as AwsLikeError;
  const name = err.name || '';
  const code = typeof err.code === 'string' ? err.code : '';
  const message = err.message || `object storage ${operation} failed`;
  const lower = message.toLowerCase();

  if (isUnparsableResponse(message)) return unparsableResponseError(err, operation);

  if (AUTH_ERROR_NAMES.has(name) || lower.includes('access denied') || lower.includes('signature')) {
    // Not 401: that status means the Opfield session itself is invalid and signs the user out.
    return new AppError(422, 'STORAGE_AUTH_FAILED', message);
  }

  if (name === 'BucketNotEmpty') {
    return new AppError(409, 'STORAGE_BUCKET_NOT_EMPTY', message);
  }

  if (NOT_FOUND_NAMES.has(name) || err.$metadata?.httpStatusCode === 404 || lower.includes('does not exist')) {
    // A HEAD response has no body: the SDK then reports a missing object or bucket as "UnknownError".
    return new AppError(
      404,
      'STORAGE_NOT_FOUND',
      /^unknown(error)?$/i.test(message) ? 'The bucket or object does not exist' : message
    );
  }

  const httpStatus = err.$metadata?.httpStatusCode;
  if (httpStatus !== undefined && UNAVAILABLE_HTTP_STATUSES.has(httpStatus)) {
    return new AppError(
      503,
      'STORAGE_UNAVAILABLE',
      `The storage server could not handle the request right now (${message}). Retry shortly.`
    );
  }

  if (
    CONNECTIVITY_ERROR_CODES.has(code) ||
    CONNECTIVITY_ERROR_CODES.has(name) ||
    lower.includes('getaddrinfo') ||
    lower.includes('connect timeout') ||
    lower.includes('socket hang up') ||
    lower.includes('self signed certificate') ||
    lower.includes('unable to verify the first certificate')
  ) {
    return new AppError(422, 'STORAGE_CONNECTION_FAILED', message);
  }

  return null;
}
