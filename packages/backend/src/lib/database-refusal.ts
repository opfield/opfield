/** What a request is told about a statement PostgreSQL refused: never the statement, its values or the driver's text. */
export interface DatabaseRefusal {
  status: 400 | 409 | 503;
  code: string;
  message: string;
  /** A constraint a request cannot normally reach on its own: logged as an error so a server bug stays visible. */
  unexpected?: boolean;
}

interface PostgresErrorFields {
  code?: unknown;
  constraint?: unknown;
  table?: unknown;
  detail?: unknown;
  cause?: unknown;
}

const VALUE_REFUSED: DatabaseRefusal = {
  status: 400,
  code: 'VALIDATION_ERROR',
  message: 'A value in the request cannot be stored: it is too long, out of range or not valid text.',
};

const IN_USE: DatabaseRefusal = {
  status: 409,
  code: 'RESOURCE_IN_USE',
  message: 'Other resources still use this one. Remove or reassign them first.',
};

// 503, not 409: nothing was changed and the same request succeeds when sent again, which clients do only for a 5xx.
const CONCURRENT_CHANGE: DatabaseRefusal = {
  status: 503,
  code: 'CONFLICT',
  message: 'Another change to this resource ran at the same time. Try again.',
};

/** SQLSTATEs a request causes with what it sends, or with what already exists. */
const REFUSALS: Readonly<Record<string, DatabaseRefusal>> = {
  // A delete or update the references of a row do not allow.
  '23001': IN_USE,
  '23505': { status: 409, code: 'ALREADY_EXISTS', message: 'A resource with these values already exists.' },
  // A missing or disallowed value: the schemas refuse these first, so reaching the table is usually this server's bug.
  '23502': { ...VALUE_REFUSED, unexpected: true },
  '23514': { ...VALUE_REFUSED, unexpected: true },
  '22001': VALUE_REFUSED,
  '22003': VALUE_REFUSED,
  '22007': VALUE_REFUSED,
  '22008': VALUE_REFUSED,
  '22021': VALUE_REFUSED,
  '22P02': VALUE_REFUSED,
  '22P05': VALUE_REFUSED,
  // Two requests on the same rows: nothing was changed and the same request can be sent again.
  '40001': CONCURRENT_CHANGE,
  '40P01': CONCURRENT_CHANGE,
};

// Five characters with a digit: a Node system error (EPIPE, EPERM) has the same shape without one.
const SQLSTATE = /^(?=.*\d)[0-9A-Z]{5}$/;

/** The PostgreSQL error inside a thrown error: Drizzle wraps the driver's error, whose SQLSTATE sits on `cause`. */
function postgresError(err: unknown): PostgresErrorFields | null {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const candidate = current as PostgresErrorFields;
    if (typeof candidate.code === 'string' && SQLSTATE.test(candidate.code)) return candidate;
    current = candidate.cause;
  }
  return null;
}

/** Whether a thrown error is a failed statement, whose text must not reach a caller. */
export function isDatabaseError(err: unknown): boolean {
  if (err instanceof Error && typeof (err as { query?: unknown }).query === 'string') return true;
  return postgresError(err) !== null;
}

/** The answer to a statement the request itself caused to fail, or null for a failure of this server. */
export function databaseRefusal(err: unknown): DatabaseRefusal | null {
  const failure = postgresError(err);
  if (!failure) return null;
  if (failure.code === '23503') {
    // The same SQLSTATE covers both directions: deleting a row still referenced, and naming a row that does not exist.
    const inserted = typeof failure.detail === 'string' && /is not present in table/i.test(failure.detail);
    return inserted
      ? { status: 400, code: 'REFERENCE_NOT_FOUND', message: 'The request names a resource that does not exist.' }
      : IN_USE;
  }
  return REFUSALS[failure.code as string] ?? null;
}

/** What is logged about a refusal: the constraint and table, never the statement or its values. */
export function databaseRefusalContext(err: unknown): { sqlState?: unknown; constraint?: unknown; table?: unknown } {
  const failure = postgresError(err);
  return { sqlState: failure?.code, constraint: failure?.constraint, table: failure?.table };
}
