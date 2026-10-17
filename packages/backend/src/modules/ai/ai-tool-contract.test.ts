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

// rc.3 stand srcparity O-4: real tool schemas mostly do not set additionalProperties, so an unknown argument was named
// only by the tools that did, and a tool that ignored it failed with an unrelated error (SSL_CERT_NOT_FOUND).
describe('unknown arguments of schemas without additionalProperties', async () => {
  const { unknownArgumentsNote } = await import('./ai-tool-contract.js');
  const open = [
    {
      name: 'rename_open',
      description: 'Rename',
      parameters: {
        type: 'object',
        properties: { nodeId: { type: 'string' }, name: { type: 'string' } },
        required: ['nodeId', 'name'],
      },
    },
    {
      name: 'manage_ssl_open',
      description: 'SSL',
      parameters: {
        type: 'object',
        properties: { operation: { type: 'string' }, sslCertificateId: { type: 'string' } },
        required: ['operation'],
      },
    },
  ] as unknown as AIToolDefinition[];
  const validator = createAIToolArgumentValidator(open);

  it('names the unknown argument next to the missing one', () => {
    expect(validator.validate('rename_open', { nodeId: 'n', newName: 'x' })).toEqual({
      ok: false,
      error: 'Invalid tool arguments: $/name is required; $/newName is not an argument here (arguments: nodeId, name)',
    });
  });

  it('lets a call with an unknown argument through, and a failure of it names the argument', () => {
    const args = { operation: 'delete', certificateId: 'c' };
    expect(validator.validate('manage_ssl_open', args)).toEqual({ ok: true, arguments: args });
    expect(unknownArgumentsNote(open[1]!, args)).toBe(
      'The tool ignored "certificateId": not an argument of this tool (arguments: operation, sslCertificateId).'
    );
    expect(unknownArgumentsNote(open[1]!, { operation: 'delete', sslCertificateId: 'c' })).toBeNull();
  });
});
