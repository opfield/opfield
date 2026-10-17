import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import type { AIToolDefinition } from './ai.types.js';

export type AIToolArgumentsResult = { ok: true; arguments: Record<string, unknown> } | { ok: false; error: string };

export interface AIToolArgumentValidator {
  parseAndValidate(toolName: string, rawArguments: string): AIToolArgumentsResult;
  validate(toolName: string, argumentsValue: unknown): AIToolArgumentsResult;
}

export function createAIToolArgumentValidator(tools: readonly AIToolDefinition[]): AIToolArgumentValidator {
  // verbose: errors carry their schema, so a refusal can name the allowed arguments and values.
  const ajv = new Ajv({ allErrors: true, strict: true, validateFormats: false, verbose: true });
  const validators = new Map<string, { tool: AIToolDefinition; validate: ValidateFunction }>();

  for (const tool of tools) {
    if (validators.has(tool.name)) throw new Error(`Duplicate AI tool definition: ${tool.name}`);
    validators.set(tool.name, { tool, validate: ajv.compile(tool.parameters) });
  }

  return {
    parseAndValidate(toolName, rawArguments) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawArguments || '{}');
      } catch {
        return { ok: false, error: 'Invalid tool arguments: malformed JSON' };
      }

      return validateArguments(validators, toolName, parsed);
    },
    validate: (toolName, argumentsValue) => validateArguments(validators, toolName, argumentsValue),
  };
}

function validateArguments(
  validators: ReadonlyMap<string, { tool: AIToolDefinition; validate: ValidateFunction }>,
  toolName: string,
  argumentsValue: unknown
): AIToolArgumentsResult {
  const compiled = validators.get(toolName);
  if (!compiled) return { ok: false, error: `Unknown AI tool: ${toolName}` };
  if (!isPlainObject(argumentsValue)) {
    return { ok: false, error: 'Invalid tool arguments: expected a JSON object' };
  }
  if (!compiled.validate(argumentsValue)) {
    // A misspelled argument usually explains the missing one ("name is required" for newName): name both.
    const reported = new Set(
      (compiled.validate.errors ?? [])
        .filter((error) => error.keyword === 'additionalProperties' && error.instancePath === '')
        .map((error) => String((error.params as Record<string, unknown>).additionalProperty))
    );
    const unknown = unknownToolArguments(compiled.tool, argumentsValue).filter((name) => !reported.has(name));
    return {
      ok: false,
      error: formatValidationErrors(compiled.validate.errors, unknownArgumentProblems(compiled.tool, unknown)),
    };
  }
  const operationDiscriminator = compiled.tool.operationDiscriminator;
  if (operationDiscriminator) {
    const values = operationDiscriminator.arguments.map((argument) => argumentsValue[argument]);
    const key = values.join('.');
    if (values.some((value) => typeof value !== 'string') || !operationDiscriminator.operations[key]) {
      const paths = operationDiscriminator.arguments.map((argument) => `$/${argument}`).join(', ');
      return {
        ok: false,
        error: `Invalid tool arguments: ${paths} must be one of: ${listed(Object.keys(operationDiscriminator.operations))}`,
      };
    }
  }
  return { ok: true, arguments: argumentsValue };
}

/** The arguments a tool schema names at its top level, across oneOf/anyOf/allOf branches. */
export function declaredToolArguments(tool: Pick<AIToolDefinition, 'parameters'>): string[] {
  const names = new Set<string>();
  const visit = (schema: unknown) => {
    if (!schema || typeof schema !== 'object') return;
    const node = schema as Record<string, unknown>;
    if (node.properties && typeof node.properties === 'object') {
      for (const name of Object.keys(node.properties)) names.add(name);
    }
    for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
      if (Array.isArray(node[key])) for (const branch of node[key] as unknown[]) visit(branch);
    }
  };
  visit(tool.parameters);
  return [...names];
}

/**
 * Top-level arguments a call sent that the tool does not take. Schemas that allow any argument
 * (additionalProperties: true, or no properties at all) have none. A tool ignores such an argument, so a call that
 * then fails ("SSL_CERT_NOT_FOUND" for certificateId instead of sslCertificateId) names it.
 */
export function unknownToolArguments(
  tool: Pick<AIToolDefinition, 'parameters'>,
  argumentsValue: Record<string, unknown>
): string[] {
  const parameters = tool.parameters as Record<string, unknown>;
  if (parameters.additionalProperties === true) return [];
  const declared = declaredToolArguments(tool);
  if (declared.length === 0) return [];
  return Object.keys(argumentsValue).filter((name) => !declared.includes(name));
}

function unknownArgumentProblems(tool: Pick<AIToolDefinition, 'parameters'>, unknown: readonly string[]): string[] {
  if (unknown.length === 0) return [];
  const allowed = listed(declaredToolArguments(tool));
  return unknown.map((name) => `$/${name} is not an argument here (arguments: ${allowed})`);
}

/** The note a failed call gets when it also sent arguments the tool ignores, or null. */
export function unknownArgumentsNote(
  tool: Pick<AIToolDefinition, 'parameters'>,
  argumentsValue: Record<string, unknown>
): string | null {
  const unknown = unknownToolArguments(tool, argumentsValue);
  if (unknown.length === 0) return null;
  return `The tool ignored ${unknown.map((name) => `"${name}"`).join(', ')}: not ${unknown.length === 1 ? 'an argument' : 'arguments'} of this tool (arguments: ${listed(declaredToolArguments(tool))}).`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const MAX_LISTED_VALUES = 40;
const MAX_REPORTED_ERRORS = 8;

function listed(values: readonly unknown[]): string {
  const shown = values
    .slice(0, MAX_LISTED_VALUES)
    .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)));
  return values.length > MAX_LISTED_VALUES ? `${shown.join(', ')}, ...` : shown.join(', ');
}

/**
 * The refusal of arguments that do not match the tool schema: each problem with its argument path and what is
 * expected there (the missing argument, the allowed values, the arguments the object takes), never the value sent.
 */
function formatValidationErrors(errors: ErrorObject[] | null | undefined, extra: readonly string[] = []): string {
  const problems = [...new Set([...(errors ?? []).map(describeValidationError), ...extra])].sort();
  if (problems.length === 0) return 'Invalid tool arguments';
  const shown = problems.slice(0, MAX_REPORTED_ERRORS);
  const more = problems.length > shown.length ? `; ${problems.length - shown.length} more` : '';
  return `Invalid tool arguments: ${shown.join('; ')}${more}`;
}

function describeValidationError(error: ErrorObject): string {
  const path = `$${error.instancePath}`;
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case 'required':
      return `${path}/${String(params.missingProperty)} is required`;
    case 'additionalProperties': {
      const properties = (error.parentSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
      const allowed = properties ? Object.keys(properties) : [];
      return `${path}/${String(params.additionalProperty)} is not an argument here${allowed.length > 0 ? ` (arguments: ${listed(allowed)})` : ''}`;
    }
    case 'enum':
      return `${path} must be one of: ${listed(Array.isArray(params.allowedValues) ? params.allowedValues : [])}`;
    case 'const':
      return `${path} must be ${JSON.stringify(params.allowedValue)}`;
    case 'type':
      return `${path} must be ${Array.isArray(params.type) ? params.type.join(' or ') : String(params.type)}`;
    default:
      return `${path} ${error.message ?? 'is invalid'}`;
  }
}
