import { parseDocument } from 'yaml';
import { COMMERCIAL_HOST_DIR, LEGACY_COMMERCIAL_HOST_DIR } from '@/edition/prepare-update.js';
import { LEGACY_REGISTRY_TOKEN_REALM } from '@/lib/legacy-compat.js';
import {
  DEFAULT_SANDBOX_WORKSPACE_DIR,
  findDirectNestedBlock,
  findTopLevelBlock,
  firstChildIndent,
  LEGACY_SANDBOX_WORKSPACE_DIR,
  upsertServiceKeyedEntries,
} from './foundation-migrator.js';
import {
  applyComposeVocabulary,
  envFileValue,
  envLineKey,
  escapeRegExp,
  LEGACY_DATABASE,
  LEGACY_DATABASE_ROLE,
  LEGACY_REGISTRY_TOKEN_SERVICE,
  OPFIELD_COMPOSE_PROJECT,
  OPFIELD_DATABASE,
  OPFIELD_DATABASE_ROLE,
  OPFIELD_VOLUME_KEYS,
  REGISTRY_TOKEN_SERVICE,
  relayBinary,
  renameLegacyEnvFileKeys,
  withRelayBinary,
} from './opfield-names.js';

/**
 * docker-compose.yml and .env of the Opfield layout, made from the files of an installation in the earlier layout:
 * project `opfield`, database and role `opfield`, the Opfield registry audience and volume keys. Docker volumes keep
 * their physical names (bound with `name:`), so no data is copied. Pure: the host move (host-move.ts) writes the
 * result only while the stack is stopped.
 */

export interface OpfieldLayoutInput {
  compose: string;
  env: string;
  /** Compose project the installation runs under now. */
  currentProject: string;
  /** Docker volumes that exist on the host. */
  existingVolumes: ReadonlySet<string>;
  /** Whether the move renames `LEGACY_COMMERCIAL_DIR_NAME` to `.opfield-commercial`. */
  renameCommercialDir: boolean;
}

export interface MovedVolume {
  /** Key in the earlier docker-compose.yml. */
  key: string;
  /** Key in the Opfield docker-compose.yml. */
  newKey: string;
  /** Docker volume name; it does not change. */
  physical: string;
  /** Bound as an external volume (it exists already). */
  external: boolean;
}

export interface OpfieldLayoutOutput {
  compose: string;
  env: string;
  volumes: MovedVolume[];
  /** Host sandbox workspace directory the app uses after the move. */
  sandboxWorkspaceDir: string | null;
}

export function toOpfieldLayout(input: OpfieldLayoutInput): OpfieldLayoutOutput {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(input.currentProject)) {
    throw new Error(`Invalid Compose project name: ${input.currentProject}`);
  }
  let compose = applyComposeVocabulary(input.compose).replace(/\r\n/g, '\n');
  const hadTrailingNewline = compose.endsWith('\n');
  let lines = compose.split('\n');
  if (hadTrailingNewline) lines.pop();

  lines = setProjectName(lines);
  const moved = moveVolumeDeclarations(lines, input);
  lines = renameVolumeReferences(moved.lines, moved.volumes);
  lines = lines.map(renameDatabaseLine);
  lines = lines.map((line) =>
    line
      .replace(
        new RegExp(
          `^(\\s*(?:-\\s*)?REGISTRY_AUTH_TOKEN_(?:SERVICE|ISSUER)\\s*[:=]\\s*["']?)${escapeRegExp(LEGACY_REGISTRY_TOKEN_SERVICE)}`
        ),
        `$1${REGISTRY_TOKEN_SERVICE}`
      )
      .replace(LEGACY_REGISTRY_TOKEN_REALM, 'https://opfield.invalid/api/docker/registry/token')
      .replaceAll(LEGACY_SANDBOX_WORKSPACE_DIR, DEFAULT_SANDBOX_WORKSPACE_DIR)
  );
  // The move recreates the relay: it runs the Opfield binary when its image has one.
  const binary = relayBinary(envFileValue(input.env, 'RELAY_BUILD_VERSION'));
  lines = lines.map((line) => withRelayBinary(line, binary));
  if (input.renameCommercialDir) {
    lines = lines.map((line) => line.replace(`./${LEGACY_COMMERCIAL_HOST_DIR}:`, `./${COMMERCIAL_HOST_DIR}:`));
  }
  // The app signs registry tokens for the audience the recreated registry checks.
  lines = upsertServiceKeyedEntries(
    lines,
    'app',
    'environment',
    ['OPFIELD_REGISTRY_TOKEN_SERVICE'],
    [`OPFIELD_REGISTRY_TOKEN_SERVICE: ${REGISTRY_TOKEN_SERVICE}`]
  );
  compose = `${lines.join('\n')}${hadTrailingNewline ? '\n' : ''}`;
  const parsed = parseDocument(compose, { uniqueKeys: true });
  if (parsed.errors.length > 0) {
    throw new Error(`The Opfield docker-compose.yml is not valid YAML: ${parsed.errors[0]!.message}`);
  }

  const env = moveEnv(input.env);
  return {
    compose,
    env: env.content,
    volumes: moved.volumes,
    sandboxWorkspaceDir: env.sandboxWorkspaceDir,
  };
}

function setProjectName(lines: string[]): string[] {
  const index = lines.findIndex((line) => /^name\s*:/.test(line));
  if (index >= 0) {
    const next = [...lines];
    next[index] = `name: ${OPFIELD_COMPOSE_PROJECT}`;
    return next;
  }
  return [`name: ${OPFIELD_COMPOSE_PROJECT}`, ...lines];
}

function moveVolumeDeclarations(
  lines: string[],
  input: OpfieldLayoutInput
): { lines: string[]; volumes: MovedVolume[] } {
  const block = findTopLevelBlock(lines, 'volumes');
  if (!block) return { lines, volumes: [] };
  const indent = firstChildIndent(lines, block);
  if (indent === null) return { lines, volumes: [] };
  const entryPattern = new RegExp(
    `^ {${indent}}([A-Za-z0-9][A-Za-z0-9_.-]*)\\s*:\\s*(\\{\\s*\\}|null|~)?\\s*(?:#.*)?$`
  );
  const volumes: MovedVolume[] = [];
  const output = lines.slice(0, block.start + 1);
  let index = block.start + 1;
  while (index < block.end) {
    const line = lines[index]!;
    const match = entryPattern.exec(line);
    if (!match) {
      output.push(line);
      index += 1;
      continue;
    }
    const key = match[1]!;
    const entry = findDirectNestedBlock(lines, { ...block, start: index - 1, end: block.end }, key) ?? {
      start: index,
      end: index + 1,
      indent,
    };
    const body = lines.slice(entry.start + 1, entry.end);
    const bodyIndent = ' '.repeat(indent + 2);
    const hasKey = (name: string) => body.some((bodyLine) => new RegExp(`^\\s+${name}\\s*:`).test(bodyLine));
    const declaredName = body
      .map((bodyLine) => /^\s+name\s*:\s*["']?([^"'#\s]+)["']?/.exec(bodyLine)?.[1])
      .find((value): value is string => Boolean(value));
    const physical = declaredName ?? `${input.currentProject}_${key}`;
    const newKey = OPFIELD_VOLUME_KEYS[key] ?? key;
    const exists = input.existingVolumes.has(physical);
    const external = hasKey('external') || (exists && !hasKey('driver') && !hasKey('driver_opts'));
    const added: string[] = [];
    // A volume that exists keeps its data under its name; one that does not yet gets the Opfield name.
    if (exists && !declaredName) added.push(`${bodyIndent}name: ${physical}`);
    if (external && !hasKey('external')) added.push(`${bodyIndent}external: true`);
    output.push(`${' '.repeat(indent)}${newKey}:`, ...added, ...body);
    volumes.push({ key, newKey, physical: exists ? physical : `${OPFIELD_COMPOSE_PROJECT}_${newKey}`, external });
    index = entry.end;
  }
  return { lines: [...output, ...lines.slice(block.end)], volumes };
}

function renameVolumeReferences(lines: string[], volumes: MovedVolume[]): string[] {
  const renamed = volumes.filter((volume) => volume.key !== volume.newKey);
  if (renamed.length === 0) return lines;
  const services = findTopLevelBlock(lines, 'services');
  if (!services) return lines;
  return lines.map((line, index) => {
    if (index <= services.start || index >= services.end) return line;
    let next = line;
    for (const volume of renamed) {
      const key = escapeRegExp(volume.key);
      next = next
        .replace(new RegExp(`^(\\s*-\\s*["']?)${key}(:)`), `$1${volume.newKey}$2`)
        .replace(new RegExp(`^(\\s*source\\s*:\\s*["']?)${key}(["']?\\s*(?:#.*)?)$`), `$1${volume.newKey}$2`);
    }
    return next;
  });
}

function renameDatabaseLine(line: string): string {
  const role = escapeRegExp(LEGACY_DATABASE_ROLE);
  const database = escapeRegExp(LEGACY_DATABASE);
  if (/DATABASE_URL/.test(line)) {
    return line
      .replace(new RegExp(`(postgres(?:ql)?://)${role}(:)`), `$1${OPFIELD_DATABASE_ROLE}$2`)
      .replace(new RegExp(`(@postgres:5432/)${database}(?=$|["'?\\s])`), `$1${OPFIELD_DATABASE}`);
  }
  return line
    .replace(
      new RegExp(`^(\\s*(?:-\\s*)?POSTGRES_(?:DB|USER)\\s*[:=]\\s*["']?)(?:${database}|${role})(["']?\\s*(?:#.*)?)$`),
      (_match, before: string, after: string) =>
        `${before}${before.includes('POSTGRES_DB') ? OPFIELD_DATABASE : OPFIELD_DATABASE_ROLE}${after}`
    )
    .replace(
      `pg_isready -U ${LEGACY_DATABASE_ROLE} -d ${LEGACY_DATABASE}`,
      `pg_isready -U ${OPFIELD_DATABASE_ROLE} -d ${OPFIELD_DATABASE}`
    );
}

function moveEnv(content: string): { content: string; sandboxWorkspaceDir: string | null } {
  const renamed = renameLegacyEnvFileKeys(content);
  let sandboxWorkspaceDir: string | null = null;
  const lines = renamed.split('\n').map((line) => {
    if (envLineKey(line) !== 'SANDBOX_RUNNER_WORKSPACE_DIR') return line;
    const value = line.slice('SANDBOX_RUNNER_WORKSPACE_DIR='.length);
    // Workspaces hold only the files of running sandbox runs; the app is stopped during the move.
    sandboxWorkspaceDir = value === LEGACY_SANDBOX_WORKSPACE_DIR ? DEFAULT_SANDBOX_WORKSPACE_DIR : value;
    return `SANDBOX_RUNNER_WORKSPACE_DIR=${sandboxWorkspaceDir}`;
  });
  return { content: lines.join('\n'), sandboxWorkspaceDir };
}
