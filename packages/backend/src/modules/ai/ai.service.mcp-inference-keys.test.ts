import 'reflect-metadata';
// The schema barrel first: loading the services alone enters the schema import cycle mid-way.
import '@/db/schema/index.js';
import { describe, expect, it } from 'vitest';
import type { User } from '@/types.js';
import { AIService } from './ai.service.js';

const user = { id: 'user-1', scopes: ['feat:ai:use'] } as unknown as User;

describe('AIService.executeTool through remote MCP', () => {
  // The service's collaborators are never reached: the refusal comes before any of them.
  const service = Object.create(AIService.prototype) as AIService;

  it.each(['create', 'update'])('refuses to %s an inference key', async (operation) => {
    const result = await service.executeTool(
      user,
      'manage_inference_token',
      { operation, name: 'ci', tokenId: 'token-1' },
      { source: 'mcp' }
    );
    expect(result.error).toMatch(/browser session/);
  });
});
