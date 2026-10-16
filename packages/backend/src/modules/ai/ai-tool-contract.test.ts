import { describe, expect, it } from 'vitest';
import type { AIToolDefinition } from './ai.types.js';
import { createAIToolArgumentValidator } from './ai-tool-contract.js';

const tools = [
  {
    name: 'rename_docker_container',
    description: 'Rename',
    parameters: {
      type: 'object',
      properties: { nodeId: { type: 'string' }, containerId: { type: 'string' }, name: { type: 'string' } },
      required: ['nodeId', 'containerId', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'manage_docker_build',
    description: 'Builds',
    parameters: {
      type: 'object',
      properties: { operation: { type: 'string', enum: ['get', 'logs', 'cancel', 'retry'] } },
      required: ['operation'],
    },
  },
] as unknown as AIToolDefinition[];

describe('tool argument refusals', () => {
  const validator = createAIToolArgumentValidator(tools);

  it('name the missing argument and the arguments an unknown one could have been', () => {
    const result = validator.validate('rename_docker_container', { nodeId: 'n', containerId: 'c', newName: 'x' });
    expect(result).toEqual({
      ok: false,
      error:
        'Invalid tool arguments: $/name is required; $/newName is not an argument here (arguments: nodeId, containerId, name)',
    });
  });

  it('list the allowed values of an enum, without repeating the value sent', () => {
    const result = validator.validate('manage_docker_build', { operation: 'status' });
    expect(result).toEqual({
      ok: false,
      error: 'Invalid tool arguments: $/operation must be one of: get, logs, cancel, retry',
    });
  });
});
