import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { LEGACY_INSTALL_DIR_NAME } from '@/lib/legacy-compat.js';
import { type OpfieldSkill, registerMcpSkills } from './mcp-skills.js';

function recordingServer() {
  const resources: string[] = [];
  const prompts: string[] = [];
  const server = {
    registerResource: (_name: string, uri: string) => resources.push(uri),
    registerPrompt: (name: string) => prompts.push(name),
  } as unknown as McpServer;
  return { server, resources, prompts };
}

const skill = (name: string): OpfieldSkill => ({
  name,
  description: `${name} skill`,
  files: [
    { path: 'SKILL.md', content: `---\nname: ${name}\ndescription: x\n---\n# ${name}\n` },
    { path: 'references/connection.md', content: '# Connection\n' },
  ],
});

describe('registerMcpSkills', () => {
  it('serves each skill under its own name only', () => {
    const { server, resources, prompts } = recordingServer();
    registerMcpSkills(server, [skill('using-opfield'), skill('databases')]);
    expect(resources).toEqual([
      'opfield://skills',
      'opfield://skills/using-opfield/SKILL.md',
      'opfield://skills/using-opfield/references/connection.md',
      'opfield://skills/databases/SKILL.md',
      'opfield://skills/databases/references/connection.md',
    ]);
    expect(prompts).toEqual(['skill-using-opfield', 'skill-databases']);
    expect(resources.some((uri) => uri.includes(`using-${LEGACY_INSTALL_DIR_NAME}`))).toBe(false);
  });
});
