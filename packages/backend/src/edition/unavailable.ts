import { AppError } from '@/middleware/error-handler.js';

export function commercialModuleUnavailable(): never {
  throw new AppError(503, 'COMMERCIAL_MODULE_UNAVAILABLE', 'This operation requires an available commercial module');
}

/**
 * The handler of the routes that stand in for the commercial module while it is absent. It is not an operation of its
 * own: the MCP/REST coverage check (mcp-rest-coverage-check.ts) skips it.
 */
export const commercialModuleUnavailableHandler = (): never => commercialModuleUnavailable();
