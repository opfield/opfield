import { describe, expect, it } from 'vitest';
import type { AIToolDefinition } from '@/modules/ai/ai.types.js';
import { extractMcpIdempotencyKey, mcpToolListing } from './mcp-idempotency.js';

const compose = {
  name: 'manage_docker_compose',
  description: 'Compose',
  parameters: {
    type: 'object',
    properties: {
      operation: { type: 'string' },
      idempotencyKey: { type: 'string', description: 'operation_start: optional key of the lifecycle operation.' },
    },
    required: ['operation'],
  },
} as unknown as AIToolDefinition;

describe('the idempotencyKey of a tool that also uses it for other operations', () => {
  it('keeps the description of that use next to the retry-safe create', () => {
    const description = (mcpToolListing(compose).inputSchema.properties?.idempotencyKey as { description: string })
      .description;
    expect(description).toContain('operation_start: optional key of the lifecycle operation.');
    expect(description).toContain('Retry-safe with operation "create"');
  });

  it('leaves the key in the arguments of a lifecycle operation', () => {
    expect(extractMcpIdempotencyKey(compose, { operation: 'operation_start', idempotencyKey: 'retry-key-1' })).toEqual({
      ok: true,
      args: { operation: 'operation_start', idempotencyKey: 'retry-key-1' },
    });
  });
});
