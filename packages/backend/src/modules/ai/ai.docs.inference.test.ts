import { describe, expect, it } from 'vitest';
import { INTERNAL_DOCS } from './ai.docs.js';
import { INFERENCE_AI_TOOLS } from './ai.tools.inference.js';

describe('inference documentation topic', () => {
  const topic = INTERNAL_DOCS.inference!;

  it('names every operation the inference tools accept', () => {
    for (const tool of INFERENCE_AI_TOOLS) {
      const operation = (tool.parameters as { properties: { operation: { enum: string[] } } }).properties.operation;
      for (const name of operation.enum) {
        expect(topic, `${tool.name} ${name}`).toMatch(new RegExp(`\\b${name}\\b`));
      }
    }
  });

  it('does not deny operations the tools have, and names the MCP documentation tool', () => {
    expect(topic).not.toMatch(/does not expose reorder|not currently exposed|does not reset accumulated/);
    expect(topic).toContain('read_opfield_documentation({ topic: "inference" })');
  });
});
