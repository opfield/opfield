/**
 * Drizzle wraps a failed statement as `Failed query: <sql>\nparams: <values>` (message, stack and the enumerable
 * `params`). A failed insert of a node, a token or a connection then printed enrollment selectors, bcrypt hashes and
 * encrypted secrets into the error log and, outside production, into the 500 body. Every value bound to a
 * credential-like column, and every value whose column cannot be told from the statement, is replaced before the
 * error is logged or returned.
 */

const REDACTED = '[redacted]';
// Marks params already redacted per column, so the text-only pass below leaves the ordinary values in place.
const REDACTED_PARAMS_MARKER = '\nparams (credentials redacted): ';
const CREDENTIAL_COLUMN =
  /pass(word|wd|phrase)?|secret|token|hash|selector|credential|private|api_?key|access_?key|(^|_)key$|encrypt|cookie|session|otp|salt|signature|seed|mnemonic|cert_?key|authorization|config/i;
const COMPARISON_BEFORE_PARAM =
  /"([^"]+)"\s*(?:=|<>|!=|<=|>=|<|>|\bi?like\b|\bin\s*\(|=\s*any\s*\(|\bis distinct from\b|\bis not distinct from\b)\s*$/i;
const MAX_DEPTH = 4;

interface QueryErrorShape {
  query: string;
  params: unknown[];
}

function isQueryError(value: unknown): value is Error & QueryErrorShape {
  return (
    value instanceof Error &&
    typeof (value as { query?: unknown }).query === 'string' &&
    Array.isArray((value as { params?: unknown }).params)
  );
}

export function isCredentialColumn(column: string): boolean {
  return CREDENTIAL_COLUMN.test(column);
}

/** Column name per placeholder number ($1 → index 1), or undefined where the statement does not show it. */
export function placeholderColumns(query: string): Map<number, string> {
  const columns = new Map<number, string>();
  const insert = /^\s*insert\s+into\s+(?:"[^"]+"\.)?"[^"]+"\s*\(([^)]*)\)\s*values\s*/i.exec(query);
  let tail = query;
  let tailOffset = 0;
  if (insert) {
    const insertColumns = [...insert[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
    let depth = 0;
    let position = 0;
    let index = insert[0].length;
    for (; index < query.length; index += 1) {
      const character = query[index]!;
      if (character === "'") {
        const end = query.indexOf("'", index + 1);
        if (end < 0) break;
        index = end;
        continue;
      }
      if (character === '(') {
        if (depth === 0) position = 0;
        depth += 1;
        continue;
      }
      if (character === ')') {
        depth -= 1;
        continue;
      }
      if (depth === 1 && character === ',') {
        position += 1;
        continue;
      }
      if (depth === 0 && /[a-z]/i.test(character)) break;
      if (depth >= 1 && character === '$') {
        const number = /^\$(\d+)/.exec(query.slice(index));
        if (number) {
          const column = insertColumns[position];
          if (column) columns.set(Number(number[1]), column);
          index += number[0].length - 1;
        }
      }
    }
    tail = query.slice(index);
    tailOffset = index;
  }
  for (const match of tail.matchAll(/\$(\d+)/g)) {
    const number = Number(match[1]);
    if (columns.has(number)) continue;
    const before = query.slice(Math.max(0, tailOffset + match.index - 200), tailOffset + match.index);
    const comparison = COMPARISON_BEFORE_PARAM.exec(before);
    if (comparison) columns.set(number, comparison[1]!);
  }
  return columns;
}

function redactParamValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  return REDACTED;
}

/** The params with credential-like and unidentified values replaced, in the `${params}` form Drizzle prints. */
export function redactQueryParams(query: string, params: readonly unknown[]): string[] {
  const columns = placeholderColumns(query);
  return params.map((value, index) => {
    const column = columns.get(index + 1);
    if (column === undefined || isCredentialColumn(column)) return redactParamValue(value);
    return String(value);
  });
}

/** For text only (a message copied into a string): drop every bound value after `params:` of a failed query. */
export function redactQueryErrorText(text: string): string {
  if (!text.includes('Failed query:')) return text;
  return text.replace(/(Failed query: [\s\S]*?)\nparams: [^\n]*(?:\n(?! {4}at )[^\n]*)*/g, `$1\nparams: ${REDACTED}`);
}

/**
 * A copy of the error safe to log or return: a Drizzle query error keeps its SQL and the values of ordinary columns;
 * the cause chain is redacted the same way. Any other error is returned unchanged.
 */
export function redactQueryError<T>(error: T, depth = 0): T {
  if (!(error instanceof Error) || depth > MAX_DEPTH) return error;
  const cause = (error as { cause?: unknown }).cause;
  const redactedCause = cause instanceof Error ? redactQueryError(cause, depth + 1) : cause;
  if (!isQueryError(error)) {
    if (!error.message.includes('Failed query:') && redactedCause === cause) return error;
    const copy = Object.create(Object.getPrototypeOf(error)) as Error;
    Object.assign(copy, error);
    copy.name = error.name;
    copy.message = redactQueryErrorText(error.message);
    if (error.stack) copy.stack = redactQueryErrorText(error.stack);
    if (redactedCause !== undefined) (copy as { cause?: unknown }).cause = redactedCause;
    return copy as T;
  }
  const params = redactQueryParams(error.query, error.params);
  const message = `Failed query: ${error.query}${REDACTED_PARAMS_MARKER}${params.join(',')}`;
  const copy = Object.create(Object.getPrototypeOf(error)) as Error & QueryErrorShape;
  Object.assign(copy, error);
  copy.name = error.name;
  copy.params = params;
  copy.message = message;
  if (error.stack) {
    copy.stack = error.stack.startsWith(`${error.name}: ${error.message}`)
      ? `${error.name}: ${message}${error.stack.slice(error.name.length + 2 + error.message.length)}`
      : redactQueryErrorText(error.stack);
  }
  if (redactedCause !== undefined) (copy as { cause?: unknown }).cause = redactedCause;
  return copy as T;
}

/** Strings and errors anywhere in log metadata (bounded depth), for the logger's format. */
export function redactQueryErrorsDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === 'string') return redactQueryErrorText(value);
  if (value instanceof Error) return redactQueryError(value);
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const redacted = redactQueryErrorsDeep(item, depth + 1);
      if (redacted !== item) changed = true;
      return redacted;
    });
    return changed ? next : value;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const redacted = redactQueryErrorsDeep(item, depth + 1);
      if (redacted !== item) changed = true;
      next[key] = redacted;
    }
    return changed ? next : value;
  }
  return value;
}
