import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MCP_SERVER_INSTRUCTIONS } from '@/modules/mcp/mcp-server.factory.js';
import { getInternalDocumentation } from './ai.docs.js';
import { OPFIELD_ABOUT_MARKDOWN, OPFIELD_DIFFERENCE, OPFIELD_WHAT } from './opfield-about.js';

describe('What Opfield is', () => {
  it('is the same text in the MCP instructions, the overview topic and the using-opfield skill', () => {
    expect(MCP_SERVER_INSTRUCTIONS).toContain(OPFIELD_WHAT);
    expect(MCP_SERVER_INSTRUCTIONS).toContain(OPFIELD_DIFFERENCE);
    expect(getInternalDocumentation('overview', ['mcp:use']).content).toContain(OPFIELD_ABOUT_MARKDOWN);
    // The skill is synced from opfield/opfield-skills; this catches the two drifting apart.
    const skill = readFileSync(new URL('../../../../../skills/using-opfield/SKILL.md', import.meta.url), 'utf8');
    expect(skill).toContain(OPFIELD_ABOUT_MARKDOWN);
  });
});
