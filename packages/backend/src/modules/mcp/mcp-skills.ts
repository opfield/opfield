import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Agent Skills shipped with Opfield (the repository's `skills/` folder, copied
 * into the image). MCP clients get them as resources and prompts, so an agent
 * connected to this Opfield reads the version that matches it.
 */
export interface GatewaySkill {
  name: string;
  description: string;
  /** Markdown files keyed by path relative to the skill folder; `SKILL.md` first. */
  files: Array<{ path: string; content: string }>;
}

export function gatewaySkillsDirectory(): string {
  return process.env.GATEWAY_SKILLS_DIR || resolve(process.cwd(), '../../skills');
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

function frontmatterValue(frontmatter: string, key: string): string | null {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
}

function markdownFiles(directory: string): string[] {
  return readdirSync(directory)
    .sort()
    .flatMap((entry) => {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) return markdownFiles(path);
      return entry.endsWith('.md') ? [path] : [];
    });
}

export function loadGatewaySkills(directory = gatewaySkillsDirectory()): GatewaySkill[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .sort()
    .flatMap((entry): GatewaySkill[] => {
      const folder = join(directory, entry);
      const skillFile = join(folder, 'SKILL.md');
      if (!statSync(folder).isDirectory() || !existsSync(skillFile)) return [];
      const skill = readFileSync(skillFile, 'utf8');
      const frontmatter = skill.match(FRONTMATTER)?.[1] ?? '';
      const name = frontmatterValue(frontmatter, 'name');
      const description = frontmatterValue(frontmatter, 'description');
      if (!name || !description || name !== entry) return [];
      const files = markdownFiles(folder).map((path) => ({
        path: relative(folder, path),
        content: readFileSync(path, 'utf8'),
      }));
      files.sort((a, b) => (a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)));
      return [{ name, description, files }];
    });
}

let cachedSkills: GatewaySkill[] | null = null;

function gatewaySkills(): GatewaySkill[] {
  cachedSkills ??= loadGatewaySkills();
  return cachedSkills;
}

/**
 * Earlier names of renamed skills. Agents and installed skill sets from before the rename still read
 * gateway://skills/<old name>/... and the skill-<old name> prompt; the index lists only the current name.
 */
export const GATEWAY_SKILL_ALIASES: Readonly<Record<string, string>> = { 'using-gateway': 'using-opfield' };

function skillUri(name: string, path?: string): string {
  return path ? `gateway://skills/${name}/${path}` : `gateway://skills/${name}`;
}

/** Skills are product documentation and need no scope beyond MCP access itself. */
export function registerMcpSkills(server: McpServer, skills: GatewaySkill[] = gatewaySkills()): void {
  if (skills.length === 0) return;

  server.registerResource(
    'gateway-skills',
    'gateway://skills',
    {
      title: 'Opfield agent skills',
      description: 'Index of the Agent Skills for operating Opfield. Start with using-opfield.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify(
            skills.map((skill) => ({
              name: skill.name,
              description: skill.description,
              uri: skillUri(skill.name, 'SKILL.md'),
              files: skill.files.map((file) => skillUri(skill.name, file.path)),
            }))
          ),
        },
      ],
    })
  );

  const aliasesOf = (name: string) =>
    Object.entries(GATEWAY_SKILL_ALIASES)
      .filter(([alias, target]) => target === name && !skills.some((skill) => skill.name === alias))
      .map(([alias]) => alias);

  for (const skill of skills) {
    for (const name of [skill.name, ...aliasesOf(skill.name)]) {
      const renamed = name === skill.name ? '' : ` (earlier name of ${skill.name})`;
      for (const file of skill.files) {
        server.registerResource(
          `gateway-skill-${name}-${file.path.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
          skillUri(name, file.path),
          {
            title: file.path === 'SKILL.md' ? `Skill: ${name}${renamed}` : `Skill ${name}: ${file.path}${renamed}`,
            description: file.path === 'SKILL.md' ? skill.description : `Reference for the ${skill.name} skill.`,
            mimeType: 'text/markdown',
          },
          async (uri) => ({ contents: [{ uri: uri.toString(), mimeType: 'text/markdown', text: file.content }] })
        );
      }
    }

    const references = skill.files.filter((file) => file.path !== 'SKILL.md');
    const body = skill.files[0].content.replace(FRONTMATTER, '').trim();
    const referenceNote = references.length
      ? `\n\nReference files for this skill are MCP resources: ${references
          .map((file) => skillUri(skill.name, file.path))
          .join(', ')}.`
      : '';
    for (const name of [skill.name, ...aliasesOf(skill.name)]) {
      server.registerPrompt(
        `skill-${name}`,
        {
          title: name === skill.name ? `Skill: ${name}` : `Skill: ${name} (earlier name of ${skill.name})`,
          description: skill.description,
        },
        () => ({
          messages: [
            {
              role: 'user' as const,
              content: { type: 'text' as const, text: `${body}${referenceNote}` },
            },
          ],
        })
      );
    }
  }
}
