import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Agent Skills shipped with Opfield (the repository's `skills/` folder, copied
 * into the image). MCP clients get them as resources and prompts, so an agent
 * connected to this Opfield reads the version that matches it.
 */
export interface OpfieldSkill {
  name: string;
  description: string;
  /** Markdown files keyed by path relative to the skill folder; `SKILL.md` first. */
  files: Array<{ path: string; content: string }>;
}

export function opfieldSkillsDirectory(): string {
  return process.env.OPFIELD_SKILLS_DIR || resolve(process.cwd(), '../../skills');
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

export function loadOpfieldSkills(directory = opfieldSkillsDirectory()): OpfieldSkill[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .sort()
    .flatMap((entry): OpfieldSkill[] => {
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

let cachedSkills: OpfieldSkill[] | null = null;

function opfieldSkills(): OpfieldSkill[] {
  cachedSkills ??= loadOpfieldSkills();
  return cachedSkills;
}

function skillUri(name: string, path?: string): string {
  return path ? `opfield://skills/${name}/${path}` : `opfield://skills/${name}`;
}

/** Skills are product documentation and need no scope beyond MCP access itself. */
export function registerMcpSkills(server: McpServer, skills: OpfieldSkill[] = opfieldSkills()): void {
  if (skills.length === 0) return;

  server.registerResource(
    'opfield-skills',
    'opfield://skills',
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

  for (const skill of skills) {
    for (const file of skill.files) {
      server.registerResource(
        `opfield-skill-${skill.name}-${file.path.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
        skillUri(skill.name, file.path),
        {
          title: file.path === 'SKILL.md' ? `Skill: ${skill.name}` : `Skill ${skill.name}: ${file.path}`,
          description: file.path === 'SKILL.md' ? skill.description : `Reference for the ${skill.name} skill.`,
          mimeType: 'text/markdown',
        },
        async (uri) => ({ contents: [{ uri: uri.toString(), mimeType: 'text/markdown', text: file.content }] })
      );
    }

    const references = skill.files.filter((file) => file.path !== 'SKILL.md');
    const body = skill.files[0].content.replace(FRONTMATTER, '').trim();
    const referenceNote = references.length
      ? `\n\nReference files for this skill are MCP resources: ${references
          .map((file) => skillUri(skill.name, file.path))
          .join(', ')}.`
      : '';
    server.registerPrompt(
      `skill-${skill.name}`,
      {
        title: `Skill: ${skill.name}`,
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
