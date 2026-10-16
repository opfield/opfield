import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INTERNAL_DOCS } from './ai.docs.js';
import { STORAGE_AI_TOOLS } from './ai.storage-tools.js';
import { RESOURCE_SETUP_AI_TOOLS } from './ai.tools.resource-setup.js';

// A failed create on several servers keeps the resource, and the availability conflicts have their own codes: an
// agent that gets one of them must learn from the docs what it means and what to do next.
const CODES = ['AVAILABILITY_CREATE_FAILED', 'AVAILABILITY_OPERATION_PENDING', 'INVALID_AVAILABILITY_MEMBER_ORDER'];

describe('database and storage availability error documentation', () => {
  const tools = [...RESOURCE_SETUP_AI_TOOLS, ...STORAGE_AI_TOOLS].filter((tool) =>
    ['manage_managed_database', 'manage_managed_storage'].includes(tool.name)
  );

  it('names every code with its next step in both tool descriptions', () => {
    expect(tools).toHaveLength(2);
    for (const tool of tools) {
      for (const code of CODES) expect(tool.description, `${tool.name} ${code}`).toContain(code);
      expect(tool.description).toMatch(/never deleted for the failure/);
      expect(tool.description).toMatch(/make_available, or delete it/);
    }
  });

  it('names every code in the databases MCP topic and in capabilities.md', () => {
    const capabilities = readFileSync(new URL('../../../../../docs/capabilities.md', import.meta.url), 'utf8');
    for (const code of CODES) {
      expect(INTERNAL_DOCS.databases, code).toContain(code);
      expect(capabilities, code).toContain(code);
    }
  });
});
