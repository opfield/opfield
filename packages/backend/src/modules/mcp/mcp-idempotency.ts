import { createChildLogger } from '@/lib/logger.js';
import {
  beginIdempotentOperation,
  findSecretMaterial,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_STORED_RESPONSE_MAX_BYTES,
  idempotencyFingerprint,
  idempotencyScopeHash,
  isValidIdempotencyKey,
} from '@/middleware/idempotency.js';
import type { AIToolDefinition, ToolExecutionResult } from '@/modules/ai/ai.types.js';
import type { User } from '@/types.js';
import type { McpAuthContext } from './mcp-types.js';

const logger = createChildLogger('McpIdempotency');

export const MCP_IDEMPOTENCY_KEY_ARGUMENT = 'idempotencyKey';

interface McpIdempotentToolRule {
  /** Argument naming the operation; omitted for single-purpose create tools. */
  operationField?: 'operation' | 'action';
  /** Operations that create a resource and honor the key. */
  operations?: readonly string[];
}

/**
 * Create-type MCP tools that accept an `idempotencyKey` argument. The key maps onto the same
 * Redis-backed mechanism as the REST `Idempotency-Key` header, scoped to the MCP token and tool.
 * Tools whose results carry secret material are left out: node enrollment tokens, API/inference/
 * Pages tokens, access keys, binding credentials, PKI private keys, access-list password hashes and
 * webhook auth headers. The shared secret guard withholds any stored result that still looks secret.
 */
export const MCP_IDEMPOTENT_CREATE_TOOLS: Readonly<Record<string, McpIdempotentToolRule>> = {
  create_docker_container: {},
  duplicate_docker_container: {},
  manage_docker_deployment: { operationField: 'operation', operations: ['create'] },
  manage_docker_compose: { operationField: 'operation', operations: ['create'] },
  manage_docker_source: { operationField: 'operation', operations: ['create'] },
  manage_docker_volume: { operationField: 'operation', operations: ['create'] },
  manage_docker_network: { operationField: 'operation', operations: ['create'] },
  manage_container_link: { operationField: 'operation', operations: ['create'] },
  manage_docker_registry: { operationField: 'operation', operations: ['create'] },
  create_route: {},
  create_route_folder: {},
  create_domain: {},
  request_acme_cert: {},
  manage_ssl_certificate: { operationField: 'operation', operations: ['upload'] },
  create_root_ca: {},
  create_intermediate_ca: {},
  manage_database_connection: { operationField: 'operation', operations: ['create'] },
  manage_managed_database: { operationField: 'operation', operations: ['create'] },
  manage_storage_connection: { operationField: 'action', operations: ['create'] },
  manage_managed_storage: { operationField: 'action', operations: ['create'] },
  manage_pages: { operationField: 'operation', operations: ['project_create'] },
  create_alert_rule: {},
  create_siem_destination: {},
};

type JsonSchemaObject = {
  type: 'object';
  properties?: Record<string, object>;
  required?: string[];
  [key: string]: unknown;
};

function declaresIdempotencyKey(tool: Pick<AIToolDefinition, 'parameters'>): boolean {
  const properties = (tool.parameters as JsonSchemaObject).properties;
  return !!properties && Object.hasOwn(properties, MCP_IDEMPOTENCY_KEY_ARGUMENT);
}

function ownPropertyDescription(schema: JsonSchemaObject): string {
  const property = schema.properties?.[MCP_IDEMPOTENCY_KEY_ARGUMENT] as { description?: unknown } | undefined;
  return typeof property?.description === 'string' ? property.description : '';
}

function operationsText(rule: McpIdempotentToolRule): string {
  if (!rule.operations?.length || !rule.operationField) return '';
  const list = rule.operations.map((operation) => `"${operation}"`).join(' or ');
  return ` with ${rule.operationField} ${list}`;
}

function idempotencyDescription(rule: McpIdempotentToolRule): string {
  return `Retry-safe${operationsText(rule)}: pass idempotencyKey (1-${IDEMPOTENCY_KEY_MAX_LENGTH} printable characters, e.g. a UUID). Retrying with the same key and arguments within 24 hours returns the original result instead of creating a duplicate; other arguments under the same key fail with IDEMPOTENCY_KEY_REUSED, and a retry while the first call still runs fails with IDEMPOTENCY_KEY_IN_PROGRESS.`;
}

/** Description and input schema advertised through MCP, with the idempotencyKey argument when supported. */
export function mcpToolListing(tool: AIToolDefinition): { description: string; inputSchema: JsonSchemaObject } {
  const inputSchema = tool.parameters as JsonSchemaObject;
  const rule = MCP_IDEMPOTENT_CREATE_TOOLS[tool.name];
  if (!rule) return { description: tool.description, inputSchema };
  const propertyDescription = idempotencyDescription(rule);
  return {
    description: `${tool.description} ${propertyDescription}`,
    inputSchema: {
      ...inputSchema,
      properties: {
        ...(inputSchema.properties ?? {}),
        [MCP_IDEMPOTENCY_KEY_ARGUMENT]: {
          ...((inputSchema.properties?.[MCP_IDEMPOTENCY_KEY_ARGUMENT] as object | undefined) ?? {}),
          type: 'string',
          ...(declaresIdempotencyKey(tool) ? {} : { minLength: 1, maxLength: IDEMPOTENCY_KEY_MAX_LENGTH }),
          // A tool that declares the key for other operations keeps its own description of that use.
          description: declaresIdempotencyKey(tool)
            ? [ownPropertyDescription(inputSchema), propertyDescription].filter(Boolean).join(' ')
            : propertyDescription,
        },
      },
    },
  };
}

export type McpIdempotencyExtraction =
  | { ok: true; args: Record<string, unknown>; key?: string }
  | { ok: false; error: string };

/**
 * Split the MCP-level idempotency key off the tool arguments. Tools whose own schema declares
 * `idempotencyKey` (Compose lifecycle operations) keep it in their arguments.
 */
export function extractMcpIdempotencyKey(
  tool: Pick<AIToolDefinition, 'name' | 'parameters'>,
  args: Record<string, unknown>
): McpIdempotencyExtraction {
  const rule = MCP_IDEMPOTENT_CREATE_TOOLS[tool.name];
  if (!rule || !Object.hasOwn(args, MCP_IDEMPOTENCY_KEY_ARGUMENT)) return { ok: true, args };

  const value = args[MCP_IDEMPOTENCY_KEY_ARGUMENT];
  const toolArgs = declaresIdempotencyKey(tool)
    ? args
    : Object.fromEntries(Object.entries(args).filter(([name]) => name !== MCP_IDEMPOTENCY_KEY_ARGUMENT));
  const operation = rule.operationField ? args[rule.operationField] : undefined;
  const createsResource = !rule.operations || (typeof operation === 'string' && rule.operations.includes(operation));
  if (!createsResource || value === undefined || value === null) return { ok: true, args: toolArgs };
  if (!isValidIdempotencyKey(value)) {
    return {
      ok: false,
      error: `IDEMPOTENCY_KEY_INVALID: idempotencyKey must be 1-${IDEMPOTENCY_KEY_MAX_LENGTH} printable ASCII characters.`,
    };
  }
  return { ok: true, args: toolArgs, key: value };
}

interface StoredMcpToolResult {
  result: unknown;
}

export const MCP_IDEMPOTENCY_WITHHELD_ERROR =
  'IDEMPOTENCY_RESULT_WITHHELD: the original call with this idempotencyKey already completed, but its result is not stored for replay. Look up the created resource instead of retrying.';

export type McpIdempotentOutcome =
  | { kind: 'executed'; execution: ToolExecutionResult }
  | { kind: 'replayed'; result: unknown }
  | { kind: 'withheld' }
  | { kind: 'rejected'; error: string };

/**
 * Run a create tool once per (MCP token, token scopes, owner's live scopes, tool, idempotencyKey).
 * Successful results are stored encrypted for 24 hours and replayed; a secret-looking or oversized
 * result is recorded as completed without its content; a failed call releases the key.
 */
export async function runMcpToolIdempotently(
  input: { auth: McpAuthContext; user: User; toolName: string; key: string; args: Record<string, unknown> },
  execute: () => Promise<ToolExecutionResult>
): Promise<McpIdempotentOutcome> {
  const { [MCP_IDEMPOTENCY_KEY_ARGUMENT]: _key, ...fingerprintArgs } = input.args;
  // Any change to the token's scopes or the owner's live scopes starts a new key space.
  const scopeHash = idempotencyScopeHash(input.auth.scopes, input.user.scopes, input.user.accountScopes);
  const principal = `mcp-${input.auth.authType ?? 'token'}:${input.auth.tokenId || input.auth.tokenPrefix}:scopes:${scopeHash}`;
  const begin = await beginIdempotentOperation<StoredMcpToolResult>(
    { principal, method: 'MCP', path: `tools/${input.toolName}`, key: input.key },
    idempotencyFingerprint({ arguments: fingerprintArgs })
  );

  switch (begin.kind) {
    case 'unavailable':
      return { kind: 'executed', execution: await execute() };
    case 'mismatch':
      return {
        kind: 'rejected',
        error:
          'IDEMPOTENCY_KEY_REUSED: this idempotencyKey was already used with different arguments for this tool. Use a new key for a new request.',
      };
    case 'in_progress':
      return {
        kind: 'rejected',
        error: `IDEMPOTENCY_KEY_IN_PROGRESS: a call with this idempotencyKey is still running. Retry the same call in ${begin.retryAfterSeconds} seconds to get its result.`,
      };
    case 'replay':
      return { kind: 'replayed', result: begin.payload.result };
    case 'withheld':
      return { kind: 'withheld' };
    case 'proceed': {
      let execution: ToolExecutionResult;
      try {
        execution = await execute();
      } catch (error) {
        await begin.lease.release();
        throw error;
      }
      if (execution.error || execution.credentialChallenge) {
        await begin.lease.release();
        return { kind: 'executed', execution };
      }
      const stored: StoredMcpToolResult = { result: execution.result ?? null };
      const secret = findSecretMaterial(stored.result);
      if (secret || storedSize(stored) > IDEMPOTENCY_STORED_RESPONSE_MAX_BYTES) {
        if (secret) logger.warn('Tool result looks secret; storing completion only', { tool: input.toolName, secret });
        await begin.lease.withhold({});
      } else {
        await begin.lease.complete(stored);
      }
      return { kind: 'executed', execution };
    }
  }
}

function storedSize(value: StoredMcpToolResult): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
