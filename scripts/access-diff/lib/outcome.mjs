// Outcome of one probe, and the comparison of a baseline and a candidate outcome. Pure functions: no I/O.

/**
 * Outcome kinds. `denied` is an authentication or permission refusal; every other answered kind means the request got
 * past authentication and scope checks (`allowed`, `validation`, `not_found`, `other`). `missing` means the
 * installation does not serve the route at all; `error` means the probe gave no usable answer (network error, timeout,
 * 5xx, a rate limit that never cleared).
 */
export const OUTCOMES = ['allowed', 'validation', 'not_found', 'other', 'denied', 'missing', 'error'];

const PASSED = new Set(['allowed', 'validation', 'not_found', 'other']);

/** 403 codes that refuse for a reason other than the caller's identity or permissions (plan, feature switch). */
export const NON_AUTH_403_CODES = new Set([
  'LICENSE_ENTITLEMENT_REQUIRED',
  'FEATURE_DISABLED',
  'HOSTING_FINANCE_UNAVAILABLE',
  'AI_MODEL_SELECTION_DISABLED',
  'AI_REASONING_EFFORT_SELECTION_DISABLED',
]);

/** 503 codes of a disabled feature or an unreachable node (LOGGING_DISABLED, NODE_UNAVAILABLE), not of a fault. */
const FEATURE_UNAVAILABLE_503 = /(_DISABLED|^NODE_UNAVAILABLE)$/;

/** The JSON 404 Opfield answers for a path no route serves (unknownApiPathHandler). */
const UNKNOWN_PATH_MESSAGE = /^No API endpoint at /;

/**
 * Classifies a REST answer.
 * @param {{status?: number, code?: string|null, message?: string|null, error?: string|null}} response
 */
export function classifyRest(response) {
  const { status, code, message, error } = response;
  if (error || typeof status !== 'number') return 'error';
  if (status >= 200 && status < 400) return 'allowed';
  if (status === 401) return 'denied';
  if (status === 403) return code && NON_AUTH_403_CODES.has(code) ? 'other' : 'denied';
  if (status === 400 || status === 422) return 'validation';
  if (status === 404) return typeof message === 'string' && UNKNOWN_PATH_MESSAGE.test(message) ? 'missing' : 'not_found';
  if (status === 405) return 'missing';
  // A switched-off feature or an unreachable node is a deliberate answer past authentication, not a broken probe.
  if (status === 501) return 'other';
  if (status === 503 && code && FEATURE_UNAVAILABLE_503.test(code)) return 'other';
  if (status === 429 || status >= 500) return 'error';
  return 'other';
}

// Tool-level refusals: the tool is not visible to the token, or the call names a target or action the token or the
// session kind may not use. Checked after the validation patterns: a validation message never names a permission.
const MCP_DENIED_PATTERNS = [
  /is unavailable for this MCP token/i,
  /\bPERMISSION_DENIED\b/,
  /\bFORBIDDEN\b/,
  /\bUNAUTHORIZED\b/,
  /missing required scope/i,
  /is not granted/i,
  /requires? (a )?browser session/i,
  /from a browser session/i,
  /available only through/i,
  /not allowed/i,
  /permission/i,
  /impersonat/i,
  /access denied/i,
];
// IDEMPOTENCY_KEY_INVALID: the key is read only from tools the token may use, before the other arguments.
const MCP_VALIDATION_PATTERNS = [
  /^Invalid tool arguments/i,
  /\bVALIDATION_ERROR\b/,
  /^Unknown MCP toolset/i,
  /^IDEMPOTENCY_KEY_INVALID\b/,
];
const MCP_NOT_FOUND_PATTERNS = [/\bnot found\b/i, /\bNOT_FOUND\b/, /does not exist/i];

/**
 * Classifies an MCP tools/call answer.
 * @param {{httpStatus?: number, rpcError?: {code:number,message:string}|null, isError?: boolean, text?: string, error?: string|null}} result
 */
export function classifyMcp(result) {
  const { httpStatus, rpcError, isError, text, error } = result;
  if (error) return 'error';
  if (typeof httpStatus === 'number' && httpStatus !== 200) {
    return classifyRest({ status: httpStatus, code: result.code, message: result.message });
  }
  if (rpcError) {
    // -32602 invalid params, -32601 unknown method/tool.
    if (rpcError.code === -32602) return 'validation';
    if (rpcError.code === -32601) return 'missing';
    return 'error';
  }
  if (!isError) return 'allowed';
  const message = text ?? '';
  if (MCP_VALIDATION_PATTERNS.some((pattern) => pattern.test(message))) return 'validation';
  if (MCP_DENIED_PATTERNS.some((pattern) => pattern.test(message))) return 'denied';
  if (MCP_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(message))) return 'not_found';
  return 'other';
}

/** Row classes, in report order. */
export const ROW_CLASSES = ['narrowed', 'removed', 'inconclusive', 'widened', 'added', 'same', 'skipped'];

/**
 * Compares one route × credential.
 * @param {{baseline: string|null, candidate: string|null, inBaseline: boolean, inCandidate: boolean}} input
 *   outcomes (null when the probe did not run) and whether each installation documents the route.
 */
export function classifyRow({ baseline, candidate, inBaseline, inCandidate }) {
  if (inBaseline && !inCandidate) return 'removed';
  if (!inBaseline && inCandidate) return 'added';
  if (baseline === null || candidate === null) return 'skipped';
  if (baseline !== 'missing' && candidate === 'missing') return 'removed';
  if (baseline === 'missing' && candidate !== 'missing') return 'added';
  if (baseline === candidate) return 'same';
  if (baseline === 'error' || candidate === 'error') return 'inconclusive';
  const baselinePassed = PASSED.has(baseline);
  const candidatePassed = PASSED.has(candidate);
  if (baselinePassed && candidate === 'denied') return 'narrowed';
  if (baseline === 'denied' && candidatePassed) return 'widened';
  // Both passed authentication (for example 404 → 400): the access did not change.
  return 'same';
}

/** Normalizes an OpenAPI path for matching across versions: parameter names may change, positions do not. */
export function normalizePath(path) {
  return path.replace(/\{[^}]+\}/g, '{}');
}

/** The approval key of a row route (`METHOD /path` with normalized parameters, or an MCP key). */
export function routeKey(route) {
  const match = /^([A-Z]+) (\/.*)$/.exec(route);
  return match ? `${match[1]} ${normalizePath(match[2])}` : route;
}

/**
 * Validates approved.json. Returns { approvals, problems }.
 * @param {unknown} document
 */
export function parseApprovals(document) {
  const problems = [];
  const list = Array.isArray(document) ? document : document && Array.isArray(document.approvals) ? document.approvals : null;
  if (!list) return { approvals: [], problems: ['approved.json must be {"approvals": [...]}'] };
  const approvals = [];
  list.forEach((entry, index) => {
    const where = `approvals[${index}]`;
    if (!entry || typeof entry !== 'object') {
      problems.push(`${where} is not an object`);
      return;
    }
    for (const field of ['route', 'credential', 'reason', 'approvedBy', 'date']) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') problems.push(`${where}.${field} is required`);
    }
    if (typeof entry.date === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
      problems.push(`${where}.date must be YYYY-MM-DD`);
    }
    if (entry.change !== undefined && !['narrowed', 'removed'].includes(entry.change)) {
      problems.push(`${where}.change must be "narrowed" or "removed" when set`);
    }
    approvals.push({ ...entry, index, key: routeKey(String(entry.route ?? '')) });
  });
  return { approvals, problems };
}

/** The approval covering a row, or null. Credential "*" covers every credential; `change` limits the row class. */
export function findApproval(row, approvals) {
  const key = routeKey(row.route);
  return (
    approvals.find(
      (approval) =>
        approval.key === key &&
        (approval.credential === '*' || approval.credential === row.credential) &&
        (approval.change === undefined || approval.change === row.class)
    ) ?? null
  );
}

/**
 * Applies approvals and decides the gate.
 * @param {Array<{route: string, credential: string, class: string}>} rows
 * @param {Array<object>} approvals
 * @param {{strict?: boolean}} options strict also fails on inconclusive rows
 */
export function evaluateGate(rows, approvals, options = {}) {
  const used = new Set();
  const blocking = [];
  for (const row of rows) {
    if (row.class !== 'narrowed' && row.class !== 'removed') continue;
    const approval = findApproval(row, approvals);
    if (approval) {
      row.approval = {
        reason: approval.reason,
        approvedBy: approval.approvedBy,
        date: approval.date,
      };
      used.add(approval.index);
    } else {
      blocking.push(row);
    }
  }
  const inconclusive = rows.filter((row) => row.class === 'inconclusive');
  const counts = Object.fromEntries(ROW_CLASSES.map((name) => [name, 0]));
  for (const row of rows) counts[row.class] = (counts[row.class] ?? 0) + 1;
  const unusedApprovals = approvals.filter((approval) => !used.has(approval.index));
  const failed = blocking.length > 0 || (options.strict === true && inconclusive.length > 0);
  return { blocking, inconclusive, counts, unusedApprovals, failed };
}
