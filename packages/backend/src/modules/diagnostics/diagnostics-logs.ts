/**
 * Parsing, filtering and redaction of Opfield container logs read through Docker. The app writes
 * winston JSON lines; other containers (Postgres, Redis, relay, registry) write plain text.
 */

import { OPFIELD_TOKEN_PATTERN, PRIVATE_KEY_PATTERN } from '@/lib/secret-patterns.js';

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogEntry {
  at: string | null;
  level: string | null;
  context?: string;
  message: string;
  /** Other structured fields of an app log line (requestId, path, status, error…). */
  fields?: Record<string, unknown>;
}

export interface LogFilter {
  level?: LogLevel;
  text?: string;
  context?: string;
  requestId?: string;
}

const MAX_FIELD_TEXT = 2_000;
const MAX_MESSAGE_TEXT = 4_000;
const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key/i;
/**
 * A name that holds a secret, as a `.env` variable, a query parameter, a header or a `key: value` pair:
 * POSTGRES_PASSWORD, GITHUB_TOKEN, access_token, x-api-key, PKI_MASTER_KEY. Bounded so a long run of name characters
 * cannot make the scan quadratic.
 */
const SECRET_NAME =
  '[A-Za-z0-9_.-]{0,64}(?:pass(?:word|wd)|pwd|secret|token|credential|api[-_]?key|access[-_]?key|private[-_]?key)[A-Za-z0-9_.-]{0,64}|[A-Za-z0-9_.-]{0,64}_key';
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // A private key block, also one cut off by the log line limit.
  [
    new RegExp(`${PRIVATE_KEY_PATTERN.source}(?:[\\s\\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----|[\\s\\S]*$)`, 'g'),
    '[REDACTED PRIVATE KEY]',
  ],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[REDACTED JWT]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [REDACTED]'],
  // URL userinfo, also without a user name (`redis://:password@host`, the form Opfield builds itself).
  [/\b([a-z][a-z0-9+.-]*:\/\/[^:/\s@]*):[^@\s/]+@/gi, '$1:[REDACTED]@'],
  // SQL as Postgres logs it: CREATE/ALTER ROLE … PASSWORD 'value'.
  [/\b(PASSWORD)\s+'(?:[^']|'')*'/gi, "$1 '[REDACTED]'"],
  [new RegExp(`(\\b(?:${SECRET_NAME})["']?\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s&"',;]+)`, 'gi'), '$1[REDACTED]'],
  [new RegExp(OPFIELD_TOKEN_PATTERN.source, 'g'), '[REDACTED]'],
];

const RELATIVE_TIME = /^(\d+)\s*(s|m|h|d)$/i;
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "15m", "2h", "1d" (before now) or an ISO timestamp, in epoch milliseconds. */
export function parseTimeArgument(value: unknown, now = Date.now()): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') throw new Error('Times are ISO timestamps or durations such as 15m, 2h or 1d');
  const relative = RELATIVE_TIME.exec(value.trim());
  if (relative?.[1] && relative[2]) return now - Number(relative[1]) * (UNIT_MS[relative[2].toLowerCase()] ?? 0);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`Cannot read the time "${value}"; use ISO 8601 or a duration such as 15m`);
  return parsed;
}

export function redactText(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) result = result.replace(pattern, replacement);
  return result;
}

function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    const redacted = redactText(value);
    return redacted.length > MAX_FIELD_TEXT ? `${redacted.slice(0, MAX_FIELD_TEXT)}…` : redacted;
  }
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) && item !== null && item !== undefined && item !== ''
        ? '[REDACTED]'
        : redactValue(item, depth + 1),
    ])
  );
}

const TIMESTAMP_PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s?(.*)$/;
const PLAIN_LEVEL = /\b(FATAL|PANIC|ERROR|ERR|WARN(?:ING)?|INFO|NOTICE|LOG|DEBUG)\b/;

function normalizePlainLevel(raw: string | undefined): string | null {
  switch (raw) {
    case 'FATAL':
    case 'PANIC':
    case 'ERROR':
    case 'ERR':
      return 'error';
    case 'WARN':
    case 'WARNING':
      return 'warn';
    case 'INFO':
    case 'NOTICE':
    case 'LOG':
      return 'info';
    case 'DEBUG':
      return 'debug';
    default:
      return null;
  }
}

/** One Docker log line, requested with timestamps, as an entry. */
export function parseLogLine(line: string): LogEntry | null {
  if (!line.trim()) return null;
  const stamped = TIMESTAMP_PREFIX.exec(line);
  const dockerAt = stamped?.[1] ?? null;
  const body = stamped ? (stamped[2] ?? '') : line;
  if (body.startsWith('{')) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const { level, message, timestamp, context, ...fields } = parsed;
      const text = typeof message === 'string' ? message : JSON.stringify(message ?? '');
      return {
        at: typeof timestamp === 'string' ? timestamp : dockerAt,
        level: typeof level === 'string' ? level : null,
        ...(typeof context === 'string' ? { context } : {}),
        message: redactText(text).slice(0, MAX_MESSAGE_TEXT),
        ...(Object.keys(fields).length > 0 ? { fields: redactValue(fields) as Record<string, unknown> } : {}),
      };
    } catch {
      // Not JSON after all: fall through to plain text.
    }
  }
  return {
    at: dockerAt,
    level: normalizePlainLevel(PLAIN_LEVEL.exec(body)?.[1]),
    message: redactText(body).slice(0, MAX_MESSAGE_TEXT),
  };
}

export function matchesLogFilter(entry: LogEntry, filter: LogFilter): boolean {
  if (filter.level) {
    const wanted = LOG_LEVELS.indexOf(filter.level);
    const actual = entry.level ? LOG_LEVELS.indexOf(entry.level as LogLevel) : -1;
    // Lines without a recognised level pass only an unfiltered or debug query.
    if (actual === -1 ? filter.level !== 'debug' : actual > wanted) return false;
  }
  if (filter.context && entry.context?.toLowerCase() !== filter.context.toLowerCase()) return false;
  if (filter.requestId && entry.fields?.requestId !== filter.requestId) return false;
  if (filter.text) {
    const needle = filter.text.toLowerCase();
    const haystack = `${entry.message} ${entry.fields ? JSON.stringify(entry.fields) : ''}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}
