import winston from 'winston';
import { redactQueryError, redactQueryErrorsDeep } from './query-error-redaction.js';

const { combine, timestamp, printf, colorize, errors } = winston.format;

const MAX_CAUSE_DEPTH = 3;

/**
 * JSON drops an Error's non-enumerable `message` and `stack`, so `{ error }` in log metadata
 * printed `{}`. Keep its enumerable fields (code, statusCode, ...) plus name, message and cause;
 * the stack only for error-level entries.
 */
export function serializeLogError(error: Error, withStack: boolean, depth = 0): Record<string, unknown> {
  const serialized: Record<string, unknown> = { ...error, name: error.name, message: error.message };
  if (withStack && error.stack) serialized.stack = error.stack;
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    serialized.cause =
      depth < MAX_CAUSE_DEPTH ? serializeLogError(cause, withStack, depth + 1) : `${cause.name}: ${cause.message}`;
  } else if (cause !== undefined) {
    serialized.cause = cause;
  }
  return serialized;
}

export const serializeMetadataErrors = winston.format((info) => {
  const withStack = info.level === 'error';
  for (const key of Object.keys(info)) {
    if (key === 'message' || key === 'level') continue;
    const value = info[key];
    if (value instanceof Error) info[key] = serializeLogError(value, withStack);
  }
  return info;
});

/** Values bound to credential-like columns of a failed query never reach a log line (lib/query-error-redaction.ts). */
export const redactFailedQueryParams = winston.format((info) => {
  // logger.error(error) logs the error itself: its message and stack are not enumerable keys.
  if (info instanceof Error) {
    const redacted = redactQueryError(info);
    if (redacted !== info) {
      info.message = redacted.message;
      info.stack = redacted.stack;
      if ('params' in redacted) (info as { params?: unknown }).params = redacted.params;
    }
  }
  for (const key of Object.keys(info)) {
    if (key === 'level') continue;
    const value = info[key];
    const redacted = redactQueryErrorsDeep(value);
    if (redacted !== value) info[key] = redacted;
  }
  return info;
});

const logFormat = printf(({ level, message, timestamp, stack, ...metadata }) => {
  let msg = `${timestamp} [${level}]: ${message}`;

  if (Object.keys(metadata).length > 0) {
    msg += ` ${JSON.stringify(metadata)}`;
  }

  if (stack) {
    msg += `\n${stack}`;
  }

  return msg;
});

const developmentFormat = combine(
  redactFailedQueryParams(),
  // Before colorize(): it rewrites `level` with colour codes.
  serializeMetadataErrors(),
  colorize(),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  logFormat
);

const productionFormat = combine(
  redactFailedQueryParams(),
  timestamp(),
  errors({ stack: true }),
  serializeMetadataErrors(),
  winston.format.json()
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  format: process.env.NODE_ENV === 'production' ? productionFormat : developmentFormat,
  transports: [new winston.transports.Console()],
  exceptionHandlers: [new winston.transports.Console()],
  rejectionHandlers: [new winston.transports.Console()],
});

export function createChildLogger(context: string) {
  return logger.child({ context });
}

export async function closeApplicationLogger(timeoutMs = 250): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logger.off('finish', finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, timeoutMs));
    logger.once('finish', finish);
    logger.end();
  });
}
