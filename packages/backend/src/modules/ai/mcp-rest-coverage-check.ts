import type { AIToolDefinition } from './ai.types.js';
import {
  MCP_REST_EXCLUSION_CATEGORIES,
  type McpRestCoverage,
  type McpRestCoverageMap,
} from './mcp-rest-coverage.types.js';

/** A served route as Hono lists it (`app.routes`). */
export interface ServedRoute {
  method: string;
  path: string;
  handler?: unknown;
}

/** `app.route()` wraps a sub-app handler when the sub-app has its own error handler; Hono keeps the original here. */
const HONO_COMPOSED_HANDLER = '__COMPOSED_HANDLER';

function innermostHandler(handler: unknown): unknown {
  let current = handler;
  while (typeof current === 'function') {
    const inner = (current as unknown as Record<string, unknown>)[HONO_COMPOSED_HANDLER];
    if (typeof inner !== 'function') break;
    current = inner;
  }
  return current;
}

/**
 * Every REST operation the application serves, as `METHOD /path` with OpenAPI-style `{param}` segments. Hono lists
 * `app.use` middleware and `app.all` handlers alike under method ALL; an ALL route counts as an operation (`ALL /path`)
 * unless its handler is middleware (it takes `next`) or one of `notOperations`: handlers that only answer that no
 * operation is there (the commercial-unavailable fallback, the unknown-path 404, retired-API tombstones).
 */
export function collectRestOperations(
  routes: readonly ServedRoute[],
  notOperations: ReadonlySet<unknown> = new Set()
): Set<string> {
  const operations = new Set<string>();
  for (const route of routes) {
    if (route.method === 'ALL') {
      const handler = innermostHandler(route.handler);
      if (typeof handler !== 'function' || handler.length >= 2 || notOperations.has(handler)) continue;
    }
    operations.add(`${route.method} ${route.path.replace(/:([A-Za-z0-9_]+)(\{[^}]*\})?/g, '{$1}')}`);
  }
  return operations;
}

/** Operation values a tool selects with its `operation` and `action` arguments. */
function toolOperations(tool: AIToolDefinition): Set<string> | null {
  const properties = ((tool.parameters as { properties?: Record<string, { enum?: unknown[] }> }).properties ??
    {}) as Record<string, { enum?: unknown[] }>;
  const values = ['operation', 'action'].flatMap((key) =>
    Array.isArray(properties[key]?.enum) ? (properties[key].enum as unknown[]).map(String) : []
  );
  return values.length > 0 ? new Set(values) : null;
}

function validateEntry(
  key: string,
  entry: McpRestCoverage,
  tools: ReadonlyMap<string, AIToolDefinition>,
  isMcpTool: (tool: AIToolDefinition) => boolean
): string[] {
  if ('excluded' in entry) {
    const problems: string[] = [];
    if (!MCP_REST_EXCLUSION_CATEGORIES.includes(entry.excluded)) {
      problems.push(`${key}: unknown exclusion category "${entry.excluded}"`);
    }
    if (entry.reason.trim().length < 10) problems.push(`${key}: exclusion needs a reason`);
    return problems;
  }
  if (entry.mcp.length === 0) return [`${key}: no MCP tool listed`];
  return entry.mcp.flatMap((reference) => {
    const [name, operation] = reference.split(':');
    const tool = tools.get(name);
    if (!tool) return [`${key}: tool "${name}" is not in AI_TOOLS`];
    if (!isMcpTool(tool)) return [`${key}: tool "${name}" is not served through MCP`];
    const operations = toolOperations(tool);
    if (operations && !operation) return [`${key}: tool "${name}" needs an operation (${[...operations].join('|')})`];
    if (!operations && operation) return [`${key}: tool "${name}" takes no operation, got "${operation}"`];
    if (operations && operation && !operations.has(operation)) {
      return [`${key}: tool "${name}" has no operation "${operation}"`];
    }
    return [];
  });
}

export interface McpRestCoverageReport {
  /** Served operations the manifest does not list. */
  unmapped: string[];
  /** Manifest entries for operations the application no longer serves. */
  stale: string[];
  /** Entries naming a missing tool or operation, or an exclusion without a valid category or reason. */
  invalid: string[];
}

/**
 * Compares the served operations with the coverage manifests. `required` must match the served set exactly;
 * `optional` entries (operations another edition serves) are validated but may be absent from this application.
 */
export function checkMcpRestCoverage(input: {
  served: ReadonlySet<string>;
  required: McpRestCoverageMap;
  optional?: McpRestCoverageMap;
  tools: readonly AIToolDefinition[];
  isMcpTool: (tool: AIToolDefinition) => boolean;
}): McpRestCoverageReport {
  const tools = new Map(input.tools.map((tool) => [tool.name, tool]));
  const optional = input.optional ?? {};
  const invalid: string[] = [];
  for (const map of [input.required, optional]) {
    for (const [key, entry] of Object.entries(map)) {
      if (!/^(GET|POST|PUT|PATCH|DELETE|ALL) \/\S*$/.test(key)) invalid.push(`${key}: key must be "METHOD /path"`);
      invalid.push(...validateEntry(key, entry, tools, input.isMcpTool));
    }
  }
  for (const key of Object.keys(optional)) {
    if (key in input.required) invalid.push(`${key}: listed in both manifests`);
  }
  const unmapped = [...input.served].filter((key) => !(key in input.required) && !(key in optional)).sort();
  const stale = Object.keys(input.required)
    .filter((key) => !input.served.has(key))
    .sort();
  return { unmapped, stale, invalid };
}
