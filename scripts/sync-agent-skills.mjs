// Copies the Agent Skills from opfield/opfield-skills into skills/,
// which the MCP server serves as opfield://skills so a connected agent reads
// the version matching this Opfield release. Run before tagging a release:
//   node scripts/sync-agent-skills.mjs [path/to/opfield-skills]
// Without a path it uses a sibling checkout named opfield-skills.
import { cpSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const checkout = process.argv[2] ?? ['../opfield-skills', '../gateway-skills'].find((path) => existsSync(path)) ?? '../opfield-skills';
const source = join(resolve(checkout), 'skills');
const target = resolve('skills');
if (!existsSync(source)) {
  console.error(`No skills folder at ${source}`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
const names = readdirSync(source)
  .sort()
  .filter((name) => statSync(join(source, name)).isDirectory() && existsSync(join(source, name, 'SKILL.md')));
for (const name of names) cpSync(join(source, name), join(target, name), { recursive: true });
writeFileSync(
  join(target, 'README.md'),
  '# Agent skills\n\nCopied from [opfield/opfield-skills](https://github.com/opfield/opfield-skills) by `scripts/sync-agent-skills.mjs`; edit them there. The MCP server serves them as `opfield://skills`.\n'
);
console.log(`${names.length} skills copied to ${target}`);
