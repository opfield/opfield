import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { type GatewaySkill, registerMcpSkills } from './mcp-skills.js';

function recordingServer() {
  const resources: string[] = [];
  const prompts: string[] = [];
  const server = {
    registerResource: (_name: string, uri: string) => resources.push(uri),
    registerPrompt: (name: string) => prompts.push(name),
  } as unknown as McpServer;
  return { server, resources, prompts };
}

const skill = (name: string): GatewaySkill => ({
  name,
  description: `${name} skill`,
  files: [
    { path: 'SKILL.md', content: `---\nname: ${name}\ndescription: x\n---\n# ${name}\n` },
    { path: 'references/connection.md', content: '# Connection\n' },
  ],
});

describe('registerMcpSkills', () => {
  it('serves using-opfield under its earlier name using-gateway too', () => {
    const { server, resources, prompts } = recordingServer();
    registerMcpSkills(server, [skill('using-opfield'), skill('databases')]);
    expect(resources).toEqual(
      expect.arrayContaining([
        'gateway://skills/using-opfield/SKILL.md',
        'gateway://skills/using-gateway/SKILL.md',
        'gateway://skills/using-gateway/references/connection.md',
      ])
    );
    expect(prompts).toEqual(['skill-using-opfield', 'skill-using-gateway', 'skill-databases']);
    expect(resources.filter((uri) => uri.startsWith('gateway://skills/databases/'))).toHaveLength(2);
  });
});
