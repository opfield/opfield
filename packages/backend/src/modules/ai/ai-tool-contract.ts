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
    return { ok: false, error: formatValidationErrors(compiled.validate.errors) };
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
function formatValidationErrors(errors: ErrorObject[] | null | undefined): string {
  const problems = [...new Set((errors ?? []).map(describeValidationError))].sort();
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
