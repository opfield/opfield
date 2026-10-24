import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '@/app.js';
import { isEligibleMcpTool } from '@/modules/mcp/mcp-tools.js';
import { AI_TOOLS } from './ai.tools.js';
import { COMMERCIAL_MCP_REST_COVERAGE } from './mcp-rest-coverage.commercial.js';
import { HOST_MCP_REST_COVERAGE } from './mcp-rest-coverage.js';
import { checkMcpRestCoverage, collectRestOperations } from './mcp-rest-coverage-check.js';
import { REST_NOT_OPERATION_HANDLERS } from './mcp-rest-coverage-fallbacks.js';

beforeAll(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('APP_URL', 'http://opfield.test');
  vi.stubEnv('DATABASE_URL', 'http://localhost/db');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  vi.stubEnv('PKI_MASTER_KEY', '0'.repeat(64));
});
afterAll(() => {
  vi.unstubAllEnvs();
});

// The commercial module serves the COMMERCIAL_MCP_REST_COVERAGE operations; without it they are validated only.
describe('MCP and REST parity', () => {
  it('maps every REST operation the application serves to an MCP tool or a product exclusion', () => {
    const served = collectRestOperations(createApp().app.routes, REST_NOT_OPERATION_HANDLERS);
    const report = checkMcpRestCoverage({
      served,
      required: HOST_MCP_REST_COVERAGE,
      optional: COMMERCIAL_MCP_REST_COVERAGE,
      tools: AI_TOOLS,
      isMcpTool: isEligibleMcpTool,
    });
    expect(
      report,
      'A REST operation was added, removed or renamed, or a tool changed: give it MCP coverage (or a product exclusion) in src/modules/ai/mcp-rest-coverage.ts'
    ).toEqual({ unmapped: [], stale: [], invalid: [] });
  });
});
