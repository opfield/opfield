// Builds the probes: one harmless request per documented REST operation, and invalid arguments per MCP tool.
// Pure functions: no I/O.

import { normalizePath } from './outcome.mjs';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** A UUID no installation holds: valid v4 syntax, so it reaches the lookup (404) instead of a syntax refusal. */
export const FAKE_UUID = '00000000-0000-4000-8000-00000000ad1f';
export const FAKE_STRING = 'access-diff-nonexistent-0000';
export const FAKE_NUMBER = '999999937';

/** JSON that cannot parse: every route that reads a JSON body answers 400 before it changes anything. */
export const MALFORMED_JSON = '{"access-diff": "this body is deliberately malformed",';

/**
 * Routes never probed, for every credential. Each entry: [method regex or '*', path regex, reason].
 * Paths are matched against the OpenAPI path template.
 */
export const SKIP_RULES = [
  ['*', /^\/api\/mcp\/?$/, 'probed through MCP initialize / tools/call instead'],
  ['*', /^\/auth\/logout$/, 'would end the probing session'],
  ['*', /^\/auth\/impersonation\/stop$/, 'would end the impersonation session'],
  ['*', /^\/auth\/(login|callback)$/, 'starts a sign-in flow and spends the per-IP sign-in budget'],
  ['*', /^\/auth\/(password|email-otp|demo|mfa|passkeys)(\/|$)/, 'spends the per-IP sign-in budget other people share'],
  ['*', /^\/api\/setup(\/|$)/, 'setup wizard only; refused once setup is complete'],
  ['*', /^\/api\/oauth\/authorize(\/|$)/, 'starts an OAuth authorization'],
  ['*', /\/authorize$/, 'starts an authorization flow'],
];

/** Installation-wide actions: never sent without an id that points at nothing, whatever the body. */
const GLOBAL_ACTION_PATTERN =
  /\/(update|updates|upgrade|check-update|restart|reboot|shutdown|install|uninstall|gc|prune|cleanup|run|trigger|rotate|reset|restore|rollback|sync|purge|apply|import|reconcile|repair|migrate|start|stop)(\/|$)/i;

/** The SKIP_RULES reason for an operation, or null. */
export function skipReason(method, path, extraRules = []) {
  for (const [ruleMethod, pattern, reason] of [...SKIP_RULES, ...extraRules]) {
    if ((ruleMethod === '*' || ruleMethod.toUpperCase() === method.toUpperCase()) && pattern.test(path)) return reason;
  }
  return null;
}

function resolveRef(doc, value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 20) return value;
  if (typeof value.$ref === 'string' && value.$ref.startsWith('#/')) {
    const target = value.$ref
      .slice(2)
      .split('/')
      .reduce((node, segment) => (node ? node[segment.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), doc);
    return resolveRef(doc, target, depth + 1);
  }
  return value;
}

/** The fake value of one path parameter, and whether it protects a write (a lookup of something that is not there). */
export function fakePathValue(name, schema) {
  const s = schema ?? {};
  const enumValues = Array.isArray(s.enum) ? s.enum : Array.isArray(s.anyOf?.[0]?.enum) ? s.anyOf[0].enum : null;
  if (enumValues?.length) return { value: String(enumValues[0]), protects: false };
  if (s.type === 'integer' || s.type === 'number') return { value: FAKE_NUMBER, protects: true };
  if (s.format === 'uuid' || /(^id$|Id$|_id$|uuid$)/i.test(name)) return { value: FAKE_UUID, protects: true };
  return { value: FAKE_STRING, protects: true };
}

/**
 * The probe of one OpenAPI operation: the request to send, or why it is not sent.
 * @returns {{path: string, headers: Record<string,string>, body?: string, skip?: undefined} | {skip: string}}
 */
export function buildRestRequest(doc, method, path, pathItem, operation, extraRules = []) {
  const reason = skipReason(method, path, extraRules);
  if (reason) return { skip: reason };

  const parameters = [...(pathItem?.parameters ?? []), ...(operation?.parameters ?? [])].map((p) => resolveRef(doc, p));
  const pathParams = new Map(parameters.filter((p) => p?.in === 'path').map((p) => [p.name, resolveRef(doc, p.schema)]));
  let protectedByFakeId = false;
  const concretePath = path.replace(/\{([^}]+)\}/g, (_, name) => {
    const fake = fakePathValue(name, pathParams.get(name));
    if (fake.protects) protectedByFakeId = true;
    return encodeURIComponent(fake.value);
  });

  const upper = method.toUpperCase();
  if (upper === 'GET') return { path: concretePath, headers: { Accept: 'application/json' } };

  const requestBody = resolveRef(doc, operation?.requestBody);
  const content = requestBody?.content ?? {};
  const jsonType = Object.keys(content).find((type) => /^application\/(?:[\w.+-]+\+)?json\b/i.test(type));
  if (!protectedByFakeId) {
    // Nothing points at a missing id, so only the body can stop the route before it acts.
    if (!jsonType) return { skip: 'write with no JSON body and no id to point at nothing (would act for real)' };
    if (GLOBAL_ACTION_PATTERN.test(path)) return { skip: 'global action with no id to point at nothing' };
    // A route whose handler reads its body itself and falls back to {} on bad JSON would act on an optional body;
    // a body with required fields fails there too.
    const schema = resolveRef(doc, content[jsonType]?.schema);
    const requiredFields = Array.isArray(schema?.required) ? schema.required : [];
    if (requestBody.required !== true || requiredFields.length === 0) {
      return { skip: 'write with no id and an optional or all-optional JSON body (a lenient handler would act)' };
    }
  }
  return {
    path: concretePath,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: MALFORMED_JSON,
  };
}

/** Every operation of an OpenAPI document: key → { method, path, pathItem, operation }. */
export function listOperations(doc) {
  const operations = new Map();
  for (const [path, pathItem] of Object.entries(doc?.paths ?? {})) {
    for (const method of METHODS) {
      const operation = pathItem?.[method];
      if (!operation) continue;
      const route = `${method.toUpperCase()} ${path}`;
      operations.set(`${method.toUpperCase()} ${normalizePath(path)}`, { method, path, pathItem, operation, route });
    }
  }
  return operations;
}

/**
 * The union of both documents' operations, with presence flags and the request built from the candidate's
 * definition when it has one (else the baseline's).
 */
export function planRestProbes(baselineDoc, candidateDoc, extraRules = []) {
  const baseline = listOperations(baselineDoc);
  const candidate = listOperations(candidateDoc);
  const keys = [...new Set([...baseline.keys(), ...candidate.keys()])].sort();
  return keys.map((key) => {
    const fromCandidate = candidate.get(key);
    const source = fromCandidate ?? baseline.get(key);
    const doc = fromCandidate ? candidateDoc : baselineDoc;
    const request = buildRestRequest(doc, source.method, source.path, source.pathItem, source.operation, extraRules);
    return {
      kind: 'rest',
      route: source.route,
      method: source.method.toUpperCase(),
      inBaseline: baseline.has(key),
      inCandidate: candidate.has(key),
      request,
    };
  });
}

function wrongTypedValue(schema) {
  const types = Array.isArray(schema?.type) ? schema.type : schema?.type ? [schema.type] : [];
  if (types.length === 0) {
    return Array.isArray(schema?.enum) && !schema.enum.includes('access-diff-not-an-option')
      ? 'access-diff-not-an-option'
      : undefined;
  }
  // A value of none of the allowed types. No coercion is configured for tool arguments.
  const candidates = [
    ['object', { 'access-diff': 'wrong type' }],
    ['array', ['access-diff']],
    ['number', 987654.321],
    ['string', 'access-diff-wrong-type'],
  ];
  for (const [type, value] of candidates) {
    const accepts = types.includes(type) || (type === 'number' && types.includes('integer'));
    if (!accepts) return value;
  }
  return undefined;
}

/**
 * Arguments that fail the tool's input schema, so the server answers with a validation error when the token may use
 * the tool and with a refusal when it may not. Read-only tools that take no arguments are called with none (a read).
 * @param {{name: string, inputSchema?: object, annotations?: {readOnlyHint?: boolean}}} tool
 * @returns {{arguments: object} | {skip: string}}
 */
export function buildMcpArguments(tool) {
  const schema = tool.inputSchema ?? {};
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const args = {};
  let invalid = false;
  for (const [name, propertySchema] of Object.entries(properties)) {
    const value = wrongTypedValue(propertySchema);
    if (value !== undefined) {
      args[name] = value;
      invalid = true;
    }
  }
  if (schema.additionalProperties === false) {
    args.__access_diff_unknown_argument__ = true;
    invalid = true;
  }
  if (invalid) return { arguments: args };
  if (Object.keys(properties).length === 0 && tool.annotations?.readOnlyHint === true) return { arguments: {} };
  return { skip: 'no argument can be made invalid and the tool is not read-only (would act for real)' };
}

/**
 * MCP probes over the union of tool lists.
 * @param {Map<string, object>} baselineTools name → tool definition (any credential listed it)
 * @param {Map<string, object>} candidateTools
 */
export function planMcpProbes(baselineTools, candidateTools, extraSkip = []) {
  const names = [...new Set([...baselineTools.keys(), ...candidateTools.keys()])].sort();
  return names.map((name) => {
    const tool = candidateTools.get(name) ?? baselineTools.get(name);
    const skipped = extraSkip.find(([pattern]) => pattern.test(name));
    return {
      kind: 'mcp',
      route: `MCP ${name}`,
      tool: name,
      inBaseline: baselineTools.has(name),
      inCandidate: candidateTools.has(name),
      request: skipped ? { skip: skipped[1] } : name === 'discover_tools' ? { arguments: {} } : buildMcpArguments(tool),
    };
  });
}
