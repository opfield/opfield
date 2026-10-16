import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import {
  COMMERCIAL_HOST_DIR,
  LEGACY_COMMERCIAL_HOST_DIR,
  type PreparedCommercialUpdate,
} from '@/edition/prepare-update.js';
import {
  applyComposeVocabulary,
  type ComposeVolumeKeys,
  envLineKey,
  FOUNDATION_BACKUPS_DIR,
  isOpfieldComposeLayout,
  LEGACY_COMPOSE_VOLUME_KEYS,
  LEGACY_MANAGED_SERVICE_LABEL,
  LEGACY_REGISTRY_TOKEN_SERVICE,
  MANAGED_MARKER_PREFIX,
  MANAGED_SERVICE_LABEL,
  OPFIELD_COMPOSE_VOLUME_KEYS,
  REGISTRY_TOKEN_SERVICE,
  relayBinary,
  renameLegacyEnvFileKeys,
} from './opfield-names.js';
import {
  type RegistryStorageBackend,
  registryStorageBackendFromCompose,
  registryStorageBackendFromEnv,
  registryStorageComposeEnvironment,
} from './registry-storage.js';

export const DEFAULT_SANDBOX_WORKSPACE_DIR = '/var/lib/opfield/sandbox-workspaces';
// legacy-name: the sandbox workspace directory of installations made before 2.12.1; the host move switches a .env
// that still has it to DEFAULT_SANDBOX_WORKSPACE_DIR — remove once every installation reports the Opfield layout.
export const LEGACY_SANDBOX_WORKSPACE_DIR = '/var/lib/gateway/sandbox-workspaces';

const SANDBOX_VOLUME_START = `${MANAGED_MARKER_PREFIX}start sandbox-workspace`;
const SANDBOX_VOLUME_END = `${MANAGED_MARKER_PREFIX}end sandbox-workspace`;
const RELAY_SERVICE_START = `${MANAGED_MARKER_PREFIX}start relay-service`;
const RELAY_SERVICE_END = `${MANAGED_MARKER_PREFIX}end relay-service`;
const REGISTRY_SERVICE_START = `${MANAGED_MARKER_PREFIX}start registry-service`;
const REGISTRY_SERVICE_END = `${MANAGED_MARKER_PREFIX}end registry-service`;
const MANAGED_SERVICE_LABEL_PATTERN = `(?:${escapeRegExp(MANAGED_SERVICE_LABEL)}|${escapeRegExp(LEGACY_MANAGED_SERVICE_LABEL)})`;
const DEFAULT_REGISTRY_IMAGE_REF =
  'ghcr.io/the-square-labs/gateway/registry@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8';
/** Bounded container logs for installer-managed services; Docker keeps json-file logs forever otherwise. */
export const COMPOSE_LOG_MAX_SIZE = '50m';
export const COMPOSE_LOG_MAX_FILE = '3';
const LOG_LIMITED_SERVICES = ['app', 'postgres', 'redis'] as const;

export interface FoundationMigrationOptions {
  commercial?: PreparedCommercialUpdate;
  hostDir: string;
  targetVersion?: string;
  imageRef?: string;
  secureLinkConnectorImage?: string;
  relayBuildVersion?: string;
  relayProtocolMajor?: number;
  relayImageRef?: string;
  sandboxWorkspaceDir?: string;
  /** Name of the commercial directory in the install directory; see commercialHostRoot. */
  commercialDirName?: string;
  /**
   * The host Docker daemon's default logging, as the caller (which has the
   * Docker socket) sees it. Bounded json-file logs are added only when the
   * default is json-file without default log-opts; see dockerLogDefaultsFromEnv.
   */
  dockerLogDefaults?: DockerLogDefaults;
}

/** The host Docker daemon's default log driver and whether daemon.json sets default log-opts. */
export interface DockerLogDefaults {
  driver: string | null;
  logOpts: 'none' | 'set' | null;
}

/**
 * Whether bounded json-file logging may be added to installer-managed
 * services: true when the host default is json-file without default log-opts,
 * false when the operator configured anything else (their logging wins), null
 * when unknown (nothing is added, and what earlier updates added is kept).
 */
export function composeLoggingEligibility(defaults: DockerLogDefaults | undefined): boolean | null {
  if (!defaults?.driver) return null;
  if (defaults.driver !== 'json-file') return false;
  if (defaults.logOpts === 'set') return false;
  return defaults.logOpts === 'none' ? true : null;
}

const MANAGED_LOG_OPTIONS: Record<string, string> = {
  'max-size': COMPOSE_LOG_MAX_SIZE,
  'max-file': COMPOSE_LOG_MAX_FILE,
};

/**
 * Derive the host logging defaults from what a caller with the Docker socket
 * sees: the daemon's default driver (Docker info) and the log configuration
 * of the Opfield app container. Docker copies the daemon's default log-opts
 * into a container that has no logging of its own, so the app shows them
 * unless it already carries Opfield's own bounded logging (or the operator
 * set another driver for it, which leaves the defaults unknown).
 */
export function hostDockerLogDefaults(
  daemonDriver: string | null | undefined,
  appLogConfig: { Type?: string; Config?: Record<string, string> | null } | null | undefined
): DockerLogDefaults | undefined {
  const driver = daemonDriver?.trim();
  if (!driver) return undefined;
  if (driver !== 'json-file') return { driver, logOpts: null };
  if (appLogConfig?.Type !== 'json-file') return { driver, logOpts: null };
  const options = Object.entries(appLogConfig.Config ?? {});
  const opfieldOwn =
    options.length === Object.keys(MANAGED_LOG_OPTIONS).length &&
    options.every(([key, value]) => MANAGED_LOG_OPTIONS[key] === value);
  return { driver, logOpts: options.length === 0 || opfieldOwn ? 'none' : 'set' };
}

/** Environment for the migrator container (see dockerLogDefaultsFromEnv). */
export function dockerLogDefaultsEnv(defaults: DockerLogDefaults | undefined): string[] {
  if (!defaults?.driver) return [];
  return [
    `OPFIELD_DOCKER_LOG_DRIVER=${defaults.driver}`,
    ...(defaults.logOpts ? [`OPFIELD_DOCKER_LOG_OPTS=${defaults.logOpts}`] : []),
  ];
}

/**
 * Read the host logging defaults the update caller passes in the environment
 * (OPFIELD_DOCKER_LOG_DRIVER, OPFIELD_DOCKER_LOG_OPTS=none|set). Environment
 * variables, unlike new CLI flags, are ignored by older migrator images.
 */
export function dockerLogDefaultsFromEnv(env: NodeJS.ProcessEnv): DockerLogDefaults | undefined {
  // legacy-name: GATEWAY_DOCKER_LOG_* — what an updating 2.12.0 passes to this migrator; remove once no supported
  // update starts from a version before 2.12.1.
  const driver = (env.OPFIELD_DOCKER_LOG_DRIVER ?? env.GATEWAY_DOCKER_LOG_DRIVER)?.trim();
  if (!driver) return undefined;
  const opts = (env.OPFIELD_DOCKER_LOG_OPTS ?? env.GATEWAY_DOCKER_LOG_OPTS)?.trim();
  return { driver, logOpts: opts === 'none' || opts === 'set' ? opts : null };
}

export interface FoundationMigrationResult {
  changedFiles: string[];
  backupDir: string | null;
  sandboxWorkspaceDir: string;
}

interface PendingFoundationWrite {
  relativePath: string;
  filePath: string;
  content: string;
}

interface EnvPatchResult {
  content: string;
  values: Map<string, string>;
}

export async function runFoundationMigrations(options: FoundationMigrationOptions): Promise<FoundationMigrationResult> {
  const hostDir = path.resolve(options.hostDir);
  const envPath = path.join(hostDir, '.env');
  const composePath = path.join(hostDir, 'docker-compose.yml');
  const backupDir = path.join(hostDir, FOUNDATION_BACKUPS_DIR, timestampForPath(new Date()));

  const envContent = await fs.readFile(envPath, 'utf8');
  const composeContent = await fs.readFile(composePath, 'utf8');
  const opfieldLayout = isOpfieldComposeLayout(composeContent);
  // A legacy installation keeps its sandbox directory until the host move; it is in its .env anyway.
  const defaultSandboxWorkspaceDir =
    options.sandboxWorkspaceDir ?? (opfieldLayout ? DEFAULT_SANDBOX_WORKSPACE_DIR : LEGACY_SANDBOX_WORKSPACE_DIR);
  // Environment names first: everything below reads and writes the OPFIELD_* keys.
  const renamedEnvContent = renameLegacyEnvFileKeys(envContent);
  const currentRelayImageRef = envValue(renamedEnvContent, 'OPFIELD_RELAY_IMAGE_REF');
  const effectiveRelayImageRef = options.relayImageRef ?? currentRelayImageRef;
  if (!effectiveRelayImageRef) {
    throw new Error('foundation migration requires a relay image reference');
  }
  if (options.relayProtocolMajor !== undefined && options.relayProtocolMajor !== 1) {
    throw new Error(`foundation migration does not support relay protocol major ${options.relayProtocolMajor}`);
  }
  const relayImageChanged = currentRelayImageRef !== effectiveRelayImageRef;
  const effectiveRelayBuildVersion =
    relayImageChanged || !envValue(renamedEnvContent, 'OPFIELD_RELAY_BUILD_VERSION')
      ? options.relayBuildVersion
      : envValue(renamedEnvContent, 'OPFIELD_RELAY_BUILD_VERSION');
  const effectiveRelayProtocolMajor =
    relayImageChanged || !envValue(renamedEnvContent, 'OPFIELD_RELAY_PROTOCOL_MAJOR')
      ? (options.relayProtocolMajor ?? 1)
      : Number(envValue(renamedEnvContent, 'OPFIELD_RELAY_PROTOCOL_MAJOR'));
  const sanitizedEnvContent = removeEnvKeys(renamedEnvContent, [
    'OPFIELD_RELAY_DB_PASSWORD',
    'OPFIELD_RELAY_VERSION',
    'RELAY_DATABASE_URL',
    'DATABASE_CONNECTOR_IMAGE',
  ]);
  const envPatch = patchEnv(sanitizedEnvContent, {
    ...(options.commercial
      ? {
          OPFIELD_COMMERCIAL_DIR:
            options.commercial.edition === 'commercial'
              ? `/var/lib/gateway/commercial/versions/${options.commercial.hostVersion}`
              : '/var/lib/gateway/commercial/community',
        }
      : {}),
    ...(options.targetVersion ? { OPFIELD_VERSION: options.targetVersion } : {}),
    ...(options.imageRef ? { OPFIELD_IMAGE_REF: options.imageRef } : {}),
    ...(options.secureLinkConnectorImage ? { SECURE_LINK_CONNECTOR_IMAGE: options.secureLinkConnectorImage } : {}),
    OPFIELD_RELAY_IMAGE_REF: effectiveRelayImageRef,
    OPFIELD_RELAY_TARGET: 'relay:9443',
    ...(effectiveRelayBuildVersion ? { OPFIELD_RELAY_BUILD_VERSION: effectiveRelayBuildVersion } : {}),
    OPFIELD_RELAY_PROTOCOL_MAJOR: String(effectiveRelayProtocolMajor),
    SANDBOX_RUNNER_WORKSPACE_DIR:
      envValue(renamedEnvContent, 'SANDBOX_RUNNER_WORKSPACE_DIR') ?? defaultSandboxWorkspaceDir,
    OPFIELD_REGISTRY_IMAGE_REF: envValue(renamedEnvContent, 'OPFIELD_REGISTRY_IMAGE_REF') ?? DEFAULT_REGISTRY_IMAGE_REF,
    OPFIELD_REGISTRY_HTTP_SECRET:
      envValue(renamedEnvContent, 'OPFIELD_REGISTRY_HTTP_SECRET') ?? randomBytes(32).toString('hex'),
  });

  const commercialDirName =
    options.commercialDirName ??
    ((await fs
      .stat(path.join(hostDir, LEGACY_COMMERCIAL_HOST_DIR))
      .then(() => true)
      .catch(() => false))
      ? LEGACY_COMMERCIAL_HOST_DIR
      : COMMERCIAL_HOST_DIR);
  const composePatch = patchCompose(composeContent, Boolean(options.commercial), {
    boundedLogging: composeLoggingEligibility(options.dockerLogDefaults),
    commercialDirName,
    relayBuildVersion: envPatch.values.get('OPFIELD_RELAY_BUILD_VERSION') ?? null,
    // The storage chosen in Settings lives in the .env: the registry block follows it on every update.
    registryStorage: registryStorageBackendFromEnv(envPatch.content),
  });

  const effectiveSandboxWorkspaceDir =
    envPatch.values.get('SANDBOX_RUNNER_WORKSPACE_DIR') ?? defaultSandboxWorkspaceDir;
  // Refuse before anything is written or restarted: a reference left to a renamed key empties the value.
  assertEnvReferencesResolve(envPatch.content, composePatch);

  const pendingWrites: PendingFoundationWrite[] = [];
  if (envPatch.content !== envContent) {
    pendingWrites.push({ relativePath: '.env', filePath: envPath, content: envPatch.content });
  }
  if (composePatch !== composeContent) {
    pendingWrites.push({ relativePath: 'docker-compose.yml', filePath: composePath, content: composePatch });
  }

  if (pendingWrites.length > 0) {
    for (const write of pendingWrites) {
      await backupFile(write.filePath, backupDir);
    }

    try {
      for (const write of pendingWrites) {
        await writeFileAtomic(write.filePath, write.content);
      }
    } catch (error) {
      await restoreBackups(backupDir, pendingWrites).catch((rollbackError) => {
        throw new Error(
          `foundation migration failed and rollback failed: ${formatError(error)}; rollback: ${formatError(rollbackError)}`
        );
      });
      throw error;
    }
  }

  // The installer writes both files for root only: they carry the installation's secrets. The host move of 2.12.1
  // release candidates wrote docker-compose.yml readable for everyone; every update puts the mode back.
  await restrictToOwner(composePath);
  await restrictToOwner(envPath);

  if (path.isAbsolute(effectiveSandboxWorkspaceDir)) {
    await fs.mkdir(effectiveSandboxWorkspaceDir, { recursive: true, mode: 0o700 }).catch(() => {});
    await fs.chmod(effectiveSandboxWorkspaceDir, 0o700).catch(() => {});
  }

  return {
    changedFiles: pendingWrites.map((write) => write.relativePath),
    backupDir: pendingWrites.length > 0 ? backupDir : null,
    sandboxWorkspaceDir: effectiveSandboxWorkspaceDir,
  };
}

/**
 * The migrated .env and docker-compose.yml must not refer to a GATEWAY_* variable the .env no longer defines, and an
 * APP_VERSION set in the .env must not come out empty: either would start Opfield without the value (in 2.12.1 an
 * early Go installer's `APP_VERSION=${GATEWAY_VERSION}` lost its key and the paid core refused the versionless host).
 */
export function assertEnvReferencesResolve(envContent: string, composeContent: string): void {
  const values = parseEnvValues(envContent);
  const uncommented = (content: string) =>
    content
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
  for (const [file, content] of [
    ['.env', uncommented(envContent)],
    ['docker-compose.yml', uncommented(composeContent)],
  ] as const) {
    for (const match of content.matchAll(/\$\{?(GATEWAY_[A-Z0-9_]+)/g)) {
      const name = match[1]!;
      if (!values.has(name)) {
        throw new Error(`foundation migration left ${file} referring to ${name}, which the .env does not define`);
      }
    }
  }
  const appVersion = values.get('APP_VERSION');
  if (appVersion !== undefined && !resolveEnvValue(appVersion, values).trim()) {
    throw new Error(
      `foundation migration would start Opfield with an empty APP_VERSION (.env: APP_VERSION=${appVersion})`
    );
  }
}

/** A .env value with its `${NAME}`, `${NAME:-default}` and `$NAME` references taken from the same file. */
function resolveEnvValue(value: string, values: Map<string, string>, depth = 0): string {
  const unquoted = value.trim().replace(/^(["'])(.*)\1$/, '$2');
  if (depth > 5) return unquoted;
  return unquoted.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_match, braced: string | undefined, fallback: string | undefined, bare: string | undefined) => {
      const raw = values.get((braced ?? bare)!);
      const resolved = raw === undefined ? '' : resolveEnvValue(raw, values, depth + 1);
      return resolved || fallback || '';
    }
  );
}

export function patchEnv(content: string, values: Record<string, string>): EnvPatchResult {
  const hadTrailingNewline = content.endsWith('\n');
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();

  const remaining = new Set(Object.keys(values));
  const seen = new Set<string>();
  const nextLines: string[] = [];
  const nextValues = parseEnvValues(content);

  for (const line of lines) {
    const key = envLineKey(line);
    if (!key || !(key in values)) {
      nextLines.push(line);
      continue;
    }
    if (seen.has(key)) continue;
    nextLines.push(`${key}=${values[key]}`);
    nextValues.set(key, values[key]);
    seen.add(key);
    remaining.delete(key);
  }

  if (remaining.size > 0 && nextLines.length > 0 && nextLines.at(-1) !== '') {
    nextLines.push('');
  }
  for (const key of remaining) {
    nextLines.push(`${key}=${values[key]}`);
    nextValues.set(key, values[key]);
  }

  return {
    content: `${nextLines.join('\n')}${hadTrailingNewline || nextLines.length > 0 ? '\n' : ''}`,
    values: nextValues,
  };
}

function removeEnvKeys(content: string, keys: string[]): string {
  const removed = new Set(keys);
  return content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => {
      const key = envLineKey(line);
      return !key || !removed.has(key);
    })
    .join('\n');
}

export function patchCompose(
  content: string,
  commercialPrepared = false,
  options: {
    boundedLogging?: boolean | null;
    commercialDirName?: string;
    /** Build version of the relay image the file runs; picks the relay binary (see relayBinary). */
    relayBuildVersion?: string | null;
    /** Storage of the registry block; without it the block keeps the storage it has. */
    registryStorage?: RegistryStorageBackend;
  } = {}
): string {
  const boundedLogging = options.boundedLogging ?? null;
  // Variable names, labels and markers in their Opfield form first; the steps below know only those.
  const renamed = applyComposeVocabulary(content);
  const layout = composeLayout(renamed);
  let lines = renamed.replace(/\r\n/g, '\n').split('\n');
  const hadTrailingNewline = lines.at(-1) === '';
  if (hadTrailingNewline) lines = lines.slice(0, -1);

  const appBlock = findServiceBlock(lines, 'app');
  if (!appBlock) throw new Error('foundation migration failed: services.app block not found in docker-compose.yml');

  const imagePatched = patchAppImage(lines, appBlock);
  const gracePatched = patchAppStopGracePeriod(imagePatched);
  const volumesPatched = patchAppSandboxVolume(
    gracePatched,
    findServiceBlock(gracePatched, 'app') ?? appBlock,
    layout.sandboxWorkspaceDir
  );
  const runtimePatched = patchAppRuntimeStorageAndSocket(
    commercialPrepared
      ? patchCommercialCore(volumesPatched, options.commercialDirName ?? mountedCommercialDirName(volumesPatched))
      : volumesPatched,
    layout
  );
  // Before the relay and registry volumes, which those steps move to the end of the list on every run.
  const healthcheckPatched = patchAppHealthcheck(upsertAppHostDiagnosticsMounts(runtimePatched));
  const environmentPatched = removeLegacyAppEnvironment(healthcheckPatched);
  const clickHousePatched = removeLegacyClickHouseService(environmentPatched);
  const relayPatched = patchRelayFoundation(clickHousePatched, boundedLogging, layout, options.relayBuildVersion);
  const registryPatched = patchRegistryFoundation(relayPatched, boundedLogging, layout, options.registryStorage);
  const loggingPatched =
    boundedLogging === true ? keepValidYaml(registryPatched, patchServiceLogging(registryPatched)) : registryPatched;
  return `${loggingPatched.join('\n')}${hadTrailingNewline ? '\n' : ''}`;
}

/** What the managed blocks of docker-compose.yml name differently in the two layouts. */
interface ComposeLayout {
  volumes: ComposeVolumeKeys;
  /** Fallback of SANDBOX_RUNNER_WORKSPACE_DIR in the sandbox mount. */
  sandboxWorkspaceDir: string;
  /** Audience and issuer of the registry's token auth; see configuredRegistryTokenService. */
  registryTokenService: string;
  registryTokenRealm: string;
}

/**
 * The layout of docker-compose.yml. A legacy file keeps its volume keys and registry audience: the running registry
 * checks that audience until the host move recreates it, and the volumes are bound by the project's name.
 */
export function composeLayout(content: string): ComposeLayout {
  return isOpfieldComposeLayout(content)
    ? {
        volumes: OPFIELD_COMPOSE_VOLUME_KEYS,
        sandboxWorkspaceDir: DEFAULT_SANDBOX_WORKSPACE_DIR,
        registryTokenService: REGISTRY_TOKEN_SERVICE,
        registryTokenRealm: 'https://opfield.invalid/api/docker/registry/token',
      }
    : {
        volumes: LEGACY_COMPOSE_VOLUME_KEYS,
        sandboxWorkspaceDir: LEGACY_SANDBOX_WORKSPACE_DIR,
        registryTokenService: LEGACY_REGISTRY_TOKEN_SERVICE,
        // legacy-name: the registry token realm of the legacy layout; replaced by the host move.
        registryTokenRealm: 'https://gateway.invalid/api/docker/registry/token',
      };
}

/** The commercial directory docker-compose.yml mounts already, or the Opfield one. */
function mountedCommercialDirName(lines: string[]): string {
  return lines.some((line) => line.includes(`./${LEGACY_COMMERCIAL_HOST_DIR}:/var/lib/gateway/commercial`))
    ? LEGACY_COMMERCIAL_HOST_DIR
    : COMMERCIAL_HOST_DIR;
}

function yamlErrorCount(lines: string[]): number {
  try {
    return parseDocument(lines.join('\n'), { uniqueKeys: true }).errors.length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * An optional patch must never turn a valid Compose file into an invalid one
 * (the updater validates the result and rolls the whole update back). Keep the
 * unpatched lines when the patch adds any YAML error, such as a duplicate key.
 */
function keepValidYaml(before: string[], after: string[]): string[] {
  if (after === before) return before;
  return yamlErrorCount(after) > yamlErrorCount(before) ? before : after;
}

function composeLoggingBlock(indent: number): string[] {
  const pad = ' '.repeat(indent);
  return [
    `${pad}logging:`,
    `${pad}  driver: json-file`,
    `${pad}  options:`,
    `${pad}    max-size: "${COMPOSE_LOG_MAX_SIZE}"`,
    `${pad}    max-file: "${COMPOSE_LOG_MAX_FILE}"`,
  ];
}

/**
 * Service keys that mean the operator already decides the logging: an explicit
 * `logging` in any form (block, inline map, alias), a YAML merge key that may
 * carry one, or `extends` from another service.
 */
const OPERATOR_LOGGING_KEYS = ['logging', '<<', 'extends'];

function hasDirectKey(lines: string[], block: { start: number; end: number; indent: number }, keys: string[]) {
  const childIndent = firstChildIndent(lines, block);
  if (childIndent === null) return false;
  const pattern = new RegExp(
    `^ {${childIndent}}(?:["']?)(?:${keys.map(escapeRegExp).join('|')})(?:["']?)\\s*:(?:\\s|$)`
  );
  for (let index = block.start + 1; index < block.end; index += 1) {
    if (pattern.test(lines[index] ?? '')) return true;
  }
  return false;
}

/**
 * Give installer-managed services bounded json-file logs (only when the host
 * default is json-file without log-opts, see composeLoggingEligibility). A
 * service where the operator already decides logging is left untouched; the
 * relay and registry blocks carry the limit in their canonical form.
 */
function patchServiceLogging(lines: string[]): string[] {
  let next = lines;
  for (const name of LOG_LIMITED_SERVICES) {
    const service = findServiceBlock(next, name);
    if (!service) continue;
    if (hasDirectKey(next, service, OPERATOR_LOGGING_KEYS)) continue;
    const indent = firstChildIndent(next, service) ?? service.indent + 2;
    next = [...next.slice(0, service.end), ...composeLoggingBlock(indent), ...next.slice(service.end)];
  }
  return next;
}

function patchCommercialCore(lines: string[], commercialDirName: string): string[] {
  const app = findServiceBlock(lines, 'app');
  if (!app) throw new Error('Commercial core requires services.app');
  const volumes = findNestedBlock(lines, app, 'volumes');
  if (!volumes) throw new Error('Commercial core requires app volumes');
  const mount = `${' '.repeat(volumes.indent + 2)}- ./${commercialDirName}:/var/lib/gateway/commercial:ro`;
  const next = [...lines];
  const existing = next.findIndex(
    (line, index) =>
      index > volumes.start &&
      index < volumes.end &&
      /^\s*-\s*[^#]+:\/var\/lib\/gateway\/commercial(?::(?:ro|rw))?\s*$/.test(line)
  );
  if (existing >= 0) next[existing] = mount;
  else next.splice(volumes.end, 0, mount);
  const updatedApp = findServiceBlock(next, 'app')!;
  const environment = findNestedBlock(next, updatedApp, 'environment');
  if (!environment) {
    const indent = ' '.repeat(updatedApp.indent + 2);
    next.splice(
      updatedApp.start + 1,
      0,
      `${indent}environment:`,
      `${indent}  OPFIELD_COMMERCIAL_DIR: \${OPFIELD_COMMERCIAL_DIR}`
    );
    return next;
  }
  const listStyle = next.slice(environment.start + 1, environment.end).some((line) => /^\s*-\s/.test(line));
  const value = `${' '.repeat(environment.indent + 2)}OPFIELD_COMMERCIAL_DIR: \${OPFIELD_COMMERCIAL_DIR}`;
  if (listStyle) {
    const listValue = `${' '.repeat(environment.indent + 2)}- OPFIELD_COMMERCIAL_DIR=\${OPFIELD_COMMERCIAL_DIR}`;
    const index = next.findIndex(
      (line, i) => i > environment.start && i < environment.end && /^\s*-\s*OPFIELD_COMMERCIAL_DIR(?:=|\s*$)/.test(line)
    );
    if (index >= 0) next[index] = listValue;
    else next.splice(environment.end, 0, listValue);
    return next;
  }
  const envIndex = next.findIndex(
    (line, index) => index > environment.start && index < environment.end && /^\s*OPFIELD_COMMERCIAL_DIR\s*:/.test(line)
  );
  if (envIndex >= 0) next[envIndex] = value;
  else next.splice(environment.end, 0, value);
  return next;
}

function patchAppStopGracePeriod(lines: string[]): string[] {
  const app = findServiceBlock(lines, 'app');
  if (!app) return lines;
  const directIndent = ' '.repeat(app.indent + 2);
  for (let index = app.start + 1; index < app.end; index += 1) {
    const match = /^(\s*)stop_grace_period\s*:\s*(.*?)\s*$/.exec(lines[index] ?? '');
    if (!match || match[1] !== directIndent) continue;
    const seconds = parseComposeDurationSeconds(match[2] ?? '');
    if (seconds !== null && seconds >= 60) return lines;
    const next = [...lines];
    next[index] = `${directIndent}stop_grace_period: 60s`;
    return next;
  }

  let insertAt = app.start + 1;
  for (let index = app.start + 1; index < app.end; index += 1) {
    if (/^\s*restart\s*:/.test(lines[index] ?? '')) {
      insertAt = index + 1;
      break;
    }
  }
  return [...lines.slice(0, insertAt), `${directIndent}stop_grace_period: 60s`, ...lines.slice(insertAt)];
}

function parseComposeDurationSeconds(value: string): number | null {
  const normalized = value.trim().replace(/^['"]|['"]$/g, '');
  if (!normalized) return null;
  const unitSeconds: Record<string, number> = {
    h: 3600,
    m: 60,
    s: 1,
    ms: 0.001,
    us: 0.000001,
    ns: 0.000000001,
  };
  const token = /(\d+(?:\.\d+)?)(ms|us|ns|h|m|s)/gy;
  let seconds = 0;
  let consumed = 0;
  for (let match = token.exec(normalized); match; match = token.exec(normalized)) {
    seconds += Number(match[1]) * unitSeconds[match[2]!]!;
    consumed = token.lastIndex;
  }
  return consumed === normalized.length ? seconds : null;
}

function patchAppRuntimeStorageAndSocket(lines: string[], layout: ComposeLayout): string[] {
  const app = findServiceBlock(lines, 'app');
  if (!app) return lines;
  const volumes = findNestedBlock(lines, app, 'volumes');
  if (!volumes) return lines;

  let next = lines.map((line, index) => {
    if (index <= volumes.start || index >= volumes.end) return line;
    return line.replace(/^(\s*-\s*\/var\/run\/docker\.sock:\/var\/run\/docker\.sock):ro(?:\s*)$/, '$1');
  });

  const refreshedApp = findServiceBlock(next, 'app');
  const refreshedVolumes = refreshedApp ? findNestedBlock(next, refreshedApp, 'volumes') : null;
  if (!refreshedVolumes) return next;

  const hasRuntimeStorage = next
    .slice(refreshedVolumes.start + 1, refreshedVolumes.end)
    .some((line) => /^\s*-\s*[^#]+:\/var\/lib\/gateway(?::(?:ro|rw))?\s*$/.test(line));
  if (hasRuntimeStorage) return next;

  const indent = ' '.repeat(refreshedVolumes.indent + 2);
  const socketLine = findDockerSocketVolume(next, refreshedVolumes.start + 1, refreshedVolumes.end);
  const insertAt = socketLine >= 0 ? socketLine + 1 : refreshedVolumes.end;
  next = [...next.slice(0, insertAt), `${indent}- ${layout.volumes.appData}:/var/lib/gateway`, ...next.slice(insertAt)];
  return ensureTopLevelVolume(next, layout.volumes.appData);
}

function patchAppHealthcheck(lines: string[]): string[] {
  const app = findServiceBlock(lines, 'app');
  if (!app) return lines;
  const healthcheck = findNestedBlock(lines, app, 'healthcheck');
  if (!healthcheck) return lines;

  // Drop only our legacy override so the new image owns the probe. Images
  // predating the Node probe still inherit their own healthcheck on rollback.
  // Operator-defined checks must not be rewritten.
  const legacy =
    /^\s*test:\s*\["CMD-SHELL",\s*"wget (?:--no-check-certificate -qO- https:\/\/127\.0\.0\.1:3000\/health \|\| wget )?-qO- http:\/\/127\.0\.0\.1:3000\/health"\]\s*$/;
  const next = lines.filter(
    (line, index) => index <= healthcheck.start || index >= healthcheck.end || !legacy.test(line)
  );
  const updatedApp = findServiceBlock(next, 'app');
  const updatedHealthcheck = updatedApp ? findNestedBlock(next, updatedApp, 'healthcheck') : null;
  if (
    updatedHealthcheck &&
    !next.slice(updatedHealthcheck.start + 1, updatedHealthcheck.end).some((line) => line.trim())
  ) {
    next.splice(updatedHealthcheck.start, 1);
  }
  return next;
}

function removeLegacyAppEnvironment(lines: string[]): string[] {
  const app = findServiceBlock(lines, 'app');
  if (!app) return lines;
  const environment = findNestedBlock(lines, app, 'environment');
  if (!environment) return lines;
  return lines.filter((line, index) => {
    if (index <= environment.start || index >= environment.end) return true;
    return !/^\s*(?:-\s*)?(?:OIDC_|CLICKHOUSE_|RATE_LIMIT_|LOGGING_(?:INGEST|RATE_LIMIT|GLOBAL|TOKEN)_|REQUEST_BODY_MAX_BYTES\s*[:=]|OAUTH_BODY_MAX_BYTES\s*[:=]|DOCKER_FILE_WRITE_MAX_BODY_BYTES\s*[:=]|INFERENCE_(?:BODY_MAX_BYTES|MAX_CONCURRENT_REQUESTS_PER_TOKEN|CONCURRENCY_LEASE_SECONDS|CONTINUATION_MAX_BYTES|CONTINUATION_TTL_SECONDS)\s*[:=]|SESSION_EXPIRY\s*[:=]|DEFAULT_CRL_VALIDITY_HOURS\s*[:=]|DEFAULT_OCSP_VALIDITY_MINUTES\s*[:=]|EXPIRY_WARNING_DAYS\s*[:=]|EXPIRY_CRITICAL_DAYS\s*[:=]|ACME_EMAIL\s*[:=]|ACME_STAGING\s*[:=]|APP_URL\s*[:=]|SETUP_TOKEN\s*[:=])/.test(
      line
    );
  });
}

function removeLegacyClickHouseService(lines: string[]): string[] {
  const service = findServiceBlock(lines, 'clickhouse');
  let next = service ? [...lines.slice(0, service.start), ...lines.slice(service.end)] : lines;
  const app = findServiceBlock(next, 'app');
  const dependsOn = app ? findNestedBlock(next, app, 'depends_on') : null;
  const dependency = dependsOn ? findDirectNestedBlock(next, dependsOn, 'clickhouse') : null;
  if (dependency) next = [...next.slice(0, dependency.start), ...next.slice(dependency.end)];

  const volumes = findTopLevelBlock(next, 'volumes');
  if (volumes) {
    const clickHouseVolume = findDirectNestedBlock(next, volumes, 'clickhouse_data');
    if (clickHouseVolume) next = [...next.slice(0, clickHouseVolume.start), ...next.slice(clickHouseVolume.end)];
  }
  return next;
}

/**
 * Whether the canonical relay/registry block carries bounded logging: added
 * when eligible, removed when the host has its own defaults, and otherwise
 * (unknown) kept as the current block has it.
 */
function managedBlockLogging(
  lines: string[],
  serviceName: string,
  start: string,
  end: string,
  boundedLogging: boolean | null
): boolean {
  if (boundedLogging !== null) return boundedLogging;
  const markerStart = findLineInRange(lines, 0, lines.length, start);
  const markerEnd = findLineInRange(lines, 0, lines.length, end);
  const block =
    markerStart >= 0 && markerEnd > markerStart
      ? { start: markerStart, end: markerEnd }
      : findServiceBlock(lines, serviceName);
  if (!block) return false;
  const logging = composeLoggingBlock(4);
  const body = lines.slice(block.start, block.end);
  return body.some((_, index) => logging.every((expected, offset) => body[index + offset] === expected));
}

function patchRelayFoundation(
  lines: string[],
  boundedLogging: boolean | null = null,
  layout: ComposeLayout = composeLayout(''),
  relayBuildVersion: string | null = null
): string[] {
  let next = removeAppPublicGrpcPort(lines);
  next = upsertAppRelayEnvironment(next, layout);
  next = upsertAppRelayDependency(next);
  next = upsertAppLabel(next);
  next = upsertAppRelayIdentityVolume(next, layout);
  next = upsertAppGrpcExpose(next);
  next = upsertRelayService(
    next,
    managedBlockLogging(next, 'relay', RELAY_SERVICE_START, RELAY_SERVICE_END, boundedLogging),
    layout,
    relayBinary(relayBuildVersion)
  );
  next = ensureTopLevelVolume(next, layout.volumes.relayIdentity);
  return ensureTopLevelVolume(next, layout.volumes.relayState);
}

function upsertAppRelayDependency(lines: string[]): string[] {
  const app = findServiceBlock(lines, 'app');
  if (!app) throw new Error('foundation migration failed: services.app block not found');
  const dependsOn = findNestedBlock(lines, app, 'depends_on');
  if (!dependsOn) {
    return [
      ...lines.slice(0, app.end),
      `${' '.repeat(app.indent + 2)}depends_on:`,
      `${' '.repeat(app.indent + 4)}relay:`,
      `${' '.repeat(app.indent + 6)}condition: service_started`,
      ...lines.slice(app.end),
    ];
  }

  const directIndent = dependsOn.indent + 2;
  const content = lines.slice(dependsOn.start + 1, dependsOn.end);
  const listStyle = content
    .find((line) => line.trim() && !line.trimStart().startsWith('#'))
    ?.trimStart()
    .startsWith('-');
  const next = lines.filter((line, index) => {
    if (index <= dependsOn.start || index >= dependsOn.end) return true;
    const indent = line.length - line.trimStart().length;
    if (listStyle) return !(indent === directIndent && /^\s*-\s*relay\s*(?:#.*)?$/.test(line));
    if (indent === directIndent && /^\s*relay\s*:/.test(line)) return false;
    const previousRelay = lines
      .slice(dependsOn.start + 1, index)
      .reverse()
      .find((candidate) => {
        const candidateIndent = candidate.length - candidate.trimStart().length;
        return candidate.trim() && candidateIndent <= directIndent;
      });
    return !previousRelay || !/^\s*relay\s*:/.test(previousRelay);
  });
  const refreshedApp = findServiceBlock(next, 'app');
  const refreshed = refreshedApp ? findNestedBlock(next, refreshedApp, 'depends_on') : null;
  if (!refreshed) throw new Error('foundation migration failed: services.app.depends_on block disappeared');
  const entries = listStyle
    ? [`${' '.repeat(directIndent)}- relay`]
    : [`${' '.repeat(directIndent)}relay:`, `${' '.repeat(directIndent + 2)}condition: service_started`];
  return [...next.slice(0, refreshed.end), ...entries, ...next.slice(refreshed.end)];
}

function removeAppPublicGrpcPort(lines: string[]): string[] {
  const app = findServiceBlock(lines, 'app');
  const ports = app ? findNestedBlock(lines, app, 'ports') : null;
  if (!ports) return lines;
  if (lines.slice(ports.start + 1, ports.end).some((line) => /^\s*target\s*:\s*9443\s*$/.test(line))) {
    throw new Error('foundation migration failed: long-form app port 9443 mapping is unsupported');
  }
  return lines.filter((line, index) => {
    if (index <= ports.start || index >= ports.end) return true;
    const match = /^\s*-\s*["']?([^"'#]+)["']?\s*(?:#.*)?$/.exec(line);
    if (!match) return true;
    const parts = match[1]!.trim().split(':');
    return !(parts.length >= 2 && parts.at(-1) === '9443');
  });
}

function upsertAppRelayEnvironment(lines: string[], layout: ComposeLayout): string[] {
  return upsertServiceKeyedEntries(
    lines,
    'app',
    'environment',
    [
      'OPFIELD_RELAY_REQUIRED',
      'OPFIELD_RELAY_MANAGED',
      'OPFIELD_RELAY_TARGET',
      'OPFIELD_RELAY_IDENTITY_DIR',
      'OPFIELD_RELAY_IMAGE_REF',
      'OPFIELD_RELAY_SERVICE_NAME',
      'OPFIELD_RELAY_DB_PASSWORD',
      'OPFIELD_RELAY_VERSION',
      'OPFIELD_RELAY_BUILD_VERSION',
      'OPFIELD_RELAY_PROTOCOL_MAJOR',
      'OPFIELD_REGISTRY_TOKEN_SERVICE',
    ],
    [
      'OPFIELD_RELAY_REQUIRED: "true"',
      'OPFIELD_RELAY_MANAGED: "true"',
      'OPFIELD_RELAY_TARGET: relay:9443',
      'OPFIELD_RELAY_IDENTITY_DIR: /var/lib/gateway-relay',
      `OPFIELD_RELAY_IMAGE_REF: \${OPFIELD_RELAY_IMAGE_REF}`,
      'OPFIELD_RELAY_SERVICE_NAME: relay',
      `OPFIELD_RELAY_BUILD_VERSION: \${OPFIELD_RELAY_BUILD_VERSION}`,
      `OPFIELD_RELAY_PROTOCOL_MAJOR: \${OPFIELD_RELAY_PROTOCOL_MAJOR}`,
      // The app signs registry tokens for the audience the registry block below checks.
      ...(layout.registryTokenService === REGISTRY_TOKEN_SERVICE
        ? [`OPFIELD_REGISTRY_TOKEN_SERVICE: ${REGISTRY_TOKEN_SERVICE}`]
        : []),
    ]
  );
}

function upsertAppLabel(lines: string[]): string[] {
  return upsertServiceKeyedEntries(
    lines,
    'app',
    'labels',
    [MANAGED_SERVICE_LABEL, LEGACY_MANAGED_SERVICE_LABEL],
    [`${MANAGED_SERVICE_LABEL}: app`]
  );
}

export function upsertServiceKeyedEntries(
  lines: string[],
  serviceName: string,
  blockName: string,
  keys: string[],
  mappingEntries: string[]
): string[] {
  let next = [...lines];
  let service = findServiceBlock(next, serviceName);
  if (!service) throw new Error(`foundation migration failed: services.${serviceName} block not found`);
  let block = findNestedBlock(next, service, blockName);
  if (!block) {
    const blockIndent = service.indent + 2;
    const entryIndent = blockIndent + 2;
    return [
      ...next.slice(0, service.end),
      `${' '.repeat(blockIndent)}${blockName}:`,
      ...mappingEntries.map((entry) => `${' '.repeat(entryIndent)}${entry}`),
      ...next.slice(service.end),
    ];
  }

  const directIndent = block.indent + 2;
  const keyPattern = new RegExp(`^\\s*(?:-\\s*)?(?:${keys.map(escapeRegExp).join('|')})(?:\\s*[:=])`);
  next = next.filter((line, index) => {
    if (index <= block!.start || index >= block!.end) return true;
    const indent = line.length - line.trimStart().length;
    return !(indent === directIndent && keyPattern.test(line));
  });
  service = findServiceBlock(next, serviceName);
  block = service ? findNestedBlock(next, service, blockName) : null;
  if (!block) throw new Error(`foundation migration failed: services.${serviceName}.${blockName} block disappeared`);
  const listStyle = next
    .slice(block.start + 1, block.end)
    .find((line) => line.trim() && !line.trimStart().startsWith('#'))
    ?.trimStart()
    .startsWith('-');
  const entries = mappingEntries.map((entry) => {
    if (!listStyle) return `${' '.repeat(directIndent)}${entry}`;
    const separator = entry.indexOf(':');
    return `${' '.repeat(directIndent)}- ${entry.slice(0, separator)}=${entry
      .slice(separator + 1)
      .trim()
      .replace(/^"|"$/g, '')}`;
  });
  return [...next.slice(0, block.end), ...entries, ...next.slice(block.end)];
}

function upsertAppRelayIdentityVolume(lines: string[], layout: ComposeLayout): string[] {
  const app = findServiceBlock(lines, 'app');
  const volumes = app ? findNestedBlock(lines, app, 'volumes') : null;
  if (!volumes) throw new Error('foundation migration failed: services.app.volumes block not found');
  const indent = volumes.indent + 2;
  const next = lines.filter((line, index) => {
    if (index <= volumes.start || index >= volumes.end) return true;
    return !/^\s*-\s*[^#]*:\/var\/lib\/gateway-relay(?::(?:ro|rw))?\s*(?:#.*)?$/.test(line);
  });
  const refreshedApp = findServiceBlock(next, 'app');
  const refreshed = refreshedApp ? findNestedBlock(next, refreshedApp, 'volumes') : null;
  if (!refreshed) throw new Error('foundation migration failed: services.app.volumes block disappeared');
  return [
    ...next.slice(0, refreshed.end),
    `${' '.repeat(indent)}- ${layout.volumes.relayIdentity}:/var/lib/gateway-relay`,
    ...next.slice(refreshed.end),
  ];
}

function upsertAppGrpcExpose(lines: string[]): string[] {
  const app = findServiceBlock(lines, 'app');
  if (!app) throw new Error('foundation migration failed: services.app block not found');
  const expose = findNestedBlock(lines, app, 'expose');
  if (!expose) {
    return [
      ...lines.slice(0, app.end),
      `${' '.repeat(app.indent + 2)}expose:`,
      `${' '.repeat(app.indent + 4)}- "9443"`,
      ...lines.slice(app.end),
    ];
  }
  const indent = expose.indent + 2;
  const next = lines.filter((line, index) => {
    if (index <= expose.start || index >= expose.end) return true;
    return !/^\s*-\s*["']?9443["']?\s*(?:#.*)?$/.test(line);
  });
  const refreshedApp = findServiceBlock(next, 'app');
  const refreshed = refreshedApp ? findNestedBlock(next, refreshedApp, 'expose') : null;
  if (!refreshed) throw new Error('foundation migration failed: services.app.expose block disappeared');
  return [...next.slice(0, refreshed.end), `${' '.repeat(indent)}- "9443"`, ...next.slice(refreshed.end)];
}

function upsertRelayService(lines: string[], logging: boolean, layout: ComposeLayout, binary: string): string[] {
  const canonical = relayServiceBlock(logging, layout, binary);
  const markerStart = findLineInRange(lines, 0, lines.length, RELAY_SERVICE_START);
  const markerEnd = findLineInRange(lines, 0, lines.length, RELAY_SERVICE_END);
  if (markerStart >= 0 || markerEnd >= 0) {
    if (markerStart < 0 || markerEnd < markerStart) {
      throw new Error('foundation migration failed: malformed relay service managed block');
    }
    return [...lines.slice(0, markerStart), ...canonical, ...lines.slice(markerEnd + 1)];
  }

  const relay = findServiceBlock(lines, 'relay');
  if (relay) {
    const owned = lines
      .slice(relay.start, relay.end)
      .some((line) => new RegExp(`${MANAGED_SERVICE_LABEL_PATTERN}\\s*[:=]\\s*relay`).test(line));
    if (!owned) throw new Error('foundation migration failed: existing relay service is not installer-managed');
    return [...lines.slice(0, relay.start), ...canonical, ...lines.slice(relay.end)];
  }

  const services = findTopLevelBlock(lines, 'services');
  if (!services) throw new Error('foundation migration failed: services block not found');
  return [...lines.slice(0, services.end), '', ...canonical, ...lines.slice(services.end)];
}

function relayServiceBlock(logging: boolean, layout: ComposeLayout, binary: string): string[] {
  return [
    `  ${RELAY_SERVICE_START}`,
    '  relay:',
    `    image: \${OPFIELD_RELAY_IMAGE_REF}`,
    `    entrypoint: ["${binary}"]`,
    '    restart: unless-stopped',
    '    labels:',
    `      ${MANAGED_SERVICE_LABEL}: relay`,
    '    environment:',
    '      RELAY_IDENTITY_DIR: /var/lib/gateway-relay/identity',
    '      RELAY_STATE_DIR: /var/lib/gateway-relay/state',
    '      RELAY_APP_GRPC_TARGET: app:9443',
    '      RELAY_POOL_ID: system',
    '      RELAY_INSTANCE_ID: 00000000-0000-4000-8000-000000000001',
    '    ports:',
    '      - "9443:9443"',
    '    volumes:',
    `      - ${layout.volumes.relayIdentity}:/var/lib/gateway-relay/identity:ro`,
    `      - ${layout.volumes.relayState}:/var/lib/gateway-relay/state`,
    '    healthcheck:',
    `      test: ["CMD", "${binary}", "healthcheck"]`,
    '      interval: 5s',
    '      timeout: 3s',
    '      retries: 2',
    '      start_period: 20s',
    ...(logging ? composeLoggingBlock(4) : []),
    `  ${RELAY_SERVICE_END}`,
  ];
}

/** docker-compose.yml with the managed registry block on the given storage; the rest of the file stays as it is. */
export function patchComposeRegistryStorage(content: string, storage: RegistryStorageBackend): string {
  const renamed = applyComposeVocabulary(content);
  let lines = renamed.replace(/\r\n/g, '\n').split('\n');
  const hadTrailingNewline = lines.at(-1) === '';
  if (hadTrailingNewline) lines = lines.slice(0, -1);
  const patched = patchRegistryFoundation(lines, null, composeLayout(renamed), storage);
  return `${patched.join('\n')}${hadTrailingNewline ? '\n' : ''}`;
}

function patchRegistryFoundation(
  lines: string[],
  boundedLogging: boolean | null = null,
  layout: ComposeLayout = composeLayout(''),
  storage: RegistryStorageBackend = registryStorageBackendFromCompose(lines)
): string[] {
  const canonical = registryServiceBlock(
    managedBlockLogging(lines, 'registry', REGISTRY_SERVICE_START, REGISTRY_SERVICE_END, boundedLogging),
    layout,
    storage
  );
  const markerStart = findLineInRange(lines, 0, lines.length, REGISTRY_SERVICE_START);
  const markerEnd = findLineInRange(lines, 0, lines.length, REGISTRY_SERVICE_END);
  let next: string[];
  if (markerStart >= 0 || markerEnd >= 0) {
    if (markerStart < 0 || markerEnd < markerStart) {
      throw new Error('foundation migration failed: malformed registry service managed block');
    }
    next = [...lines.slice(0, markerStart), ...canonical, ...lines.slice(markerEnd + 1)];
  } else {
    const registry = findServiceBlock(lines, 'registry');
    if (registry) {
      const owned = lines
        .slice(registry.start, registry.end)
        .some((line) => new RegExp(`${MANAGED_SERVICE_LABEL_PATTERN}\\s*[:=]\\s*registry`).test(line));
      if (!owned) throw new Error('foundation migration failed: existing registry service is not installer-managed');
      next = [...lines.slice(0, registry.start), ...canonical, ...lines.slice(registry.end)];
    } else {
      const services = findTopLevelBlock(lines, 'services');
      if (!services) throw new Error('foundation migration failed: services block not found');
      next = [...lines.slice(0, services.end), '', ...canonical, ...lines.slice(services.end)];
    }
  }
  next = upsertAppRegistryAuthVolume(next, layout);
  next = ensureTopLevelVolume(next, layout.volumes.registryData);
  return ensureTopLevelVolume(next, layout.volumes.registryAuth);
}

function upsertAppRegistryAuthVolume(lines: string[], layout: ComposeLayout): string[] {
  const app = findServiceBlock(lines, 'app');
  const volumes = app ? findNestedBlock(lines, app, 'volumes') : null;
  if (!volumes) throw new Error('foundation migration failed: services.app.volumes block not found');
  const indent = volumes.indent + 2;
  const next = lines.filter((line, index) => {
    if (index <= volumes.start || index >= volumes.end) return true;
    return !/^\s*-\s*[^#]*:\/var\/lib\/gateway-registry-auth(?::(?:ro|rw))?\s*(?:#.*)?$/.test(line);
  });
  const refreshedApp = findServiceBlock(next, 'app');
  const refreshed = refreshedApp ? findNestedBlock(next, refreshedApp, 'volumes') : null;
  if (!refreshed) throw new Error('foundation migration failed: services.app.volumes block disappeared');
  return [
    ...next.slice(0, refreshed.end),
    `${' '.repeat(indent)}- ${layout.volumes.registryAuth}:/var/lib/gateway-registry-auth`,
    ...next.slice(refreshed.end),
  ];
}

/**
 * The host's files the diagnostics read, as `source:target`. In a Proxmox LXC, LXCFS serves the /proc files per
 * reading cgroup, so the LXC's own memory use comes from its cgroup root and its uptime from its init's start;
 * MemTotal, the CPU list and the load still come from /proc.
 */
export const HOST_DIAGNOSTICS_MOUNTS = [
  '/proc/meminfo:/host/proc/meminfo',
  '/proc/loadavg:/host/proc/loadavg',
  '/proc/stat:/host/proc/stat',
  '/proc/1/stat:/host/proc/1/stat',
  '/sys/fs/cgroup:/host/cgroup',
] as const;

/** Earlier mounts the diagnostics no longer read: LXCFS answers /proc/uptime for the app container, not the LXC. */
const LEGACY_HOST_DIAGNOSTICS_TARGETS = ['/host/proc/uptime'] as const;

function volumeTargetPattern(target: string): RegExp {
  return new RegExp(`^\\s*-\\s*[^#]*:${escapeRegExp(target)}(?::(?:ro|rw))?\\s*(?:#.*)?$`);
}

function upsertAppHostDiagnosticsMounts(lines: string[]): string[] {
  const app = findServiceBlock(lines, 'app');
  const volumes = app ? findNestedBlock(lines, app, 'volumes') : null;
  if (!volumes) throw new Error('foundation migration failed: services.app.volumes block not found');
  const legacy = LEGACY_HOST_DIAGNOSTICS_TARGETS.map(volumeTargetPattern);
  const before = lines.slice(0, volumes.start + 1);
  const present = lines
    .slice(volumes.start + 1, volumes.end)
    .filter((line) => !legacy.some((pattern) => pattern.test(line)));
  const indent = ' '.repeat(volumes.indent + 2);
  const missing = HOST_DIAGNOSTICS_MOUNTS.filter((mount) => {
    const target = mount.slice(mount.indexOf(':') + 1);
    return !present.some((line) => volumeTargetPattern(target).test(line));
  }).map((mount) => `${indent}- ${mount}:ro`);
  return [...before, ...present, ...missing, ...lines.slice(volumes.end)];
}

function registryServiceBlock(logging: boolean, layout: ComposeLayout, storage: RegistryStorageBackend): string[] {
  return [
    `  ${REGISTRY_SERVICE_START}`,
    '  registry:',
    `    image: \${OPFIELD_REGISTRY_IMAGE_REF}`,
    '    restart: unless-stopped',
    '    labels:',
    `      ${MANAGED_SERVICE_LABEL}: registry`,
    '    environment:',
    '      REGISTRY_HTTP_ADDR: 0.0.0.0:5000',
    '      REGISTRY_HTTP_DEBUG_ADDR: 127.0.0.1:5001',
    `      REGISTRY_HTTP_SECRET: \${OPFIELD_REGISTRY_HTTP_SECRET}`,
    '      REGISTRY_AUTH: token',
    `      REGISTRY_AUTH_TOKEN_REALM: \${OPFIELD_REGISTRY_TOKEN_REALM:-${layout.registryTokenRealm}}`,
    `      REGISTRY_AUTH_TOKEN_SERVICE: ${layout.registryTokenService}`,
    `      REGISTRY_AUTH_TOKEN_ISSUER: ${layout.registryTokenService}`,
    '      REGISTRY_AUTH_TOKEN_ROOTCERTBUNDLE: /var/lib/gateway-registry-auth/token-cert.pem',
    ...registryStorageComposeEnvironment(storage).map((entry) => `      ${entry}`),
    '      REGISTRY_STORAGE_DELETE_ENABLED: "true"',
    '      REGISTRY_HEALTH_STORAGEDRIVER_ENABLED: "true"',
    '      REGISTRY_HEALTH_STORAGEDRIVER_INTERVAL: 10s',
    '      REGISTRY_HEALTH_STORAGEDRIVER_THRESHOLD: "3"',
    '    expose:',
    '      - "5000"',
    '    volumes:',
    `      - ${layout.volumes.registryData}:/var/lib/registry`,
    `      - ${layout.volumes.registryAuth}:/var/lib/gateway-registry-auth:ro`,
    '    healthcheck:',
    '      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:5001/debug/health >/dev/null"]',
    '      interval: 10s',
    '      timeout: 5s',
    '      retries: 6',
    '      start_period: 20s',
    ...(logging ? composeLoggingBlock(4) : []),
    `  ${REGISTRY_SERVICE_END}`,
  ];
}

function patchAppImage(lines: string[], appBlock: { start: number; end: number; indent: number }): string[] {
  const next = [...lines];
  for (let index = appBlock.start + 1; index < appBlock.end; index += 1) {
    const match = /^(\s*)image\s*:/.exec(next[index]);
    if (!match) continue;
    next[index] = `${match[1]}image: \${OPFIELD_IMAGE_REF}`;
    return next;
  }

  // Pre-v2.5 installer-managed foundations built the application locally and
  // therefore have no app.image field. Replace that build block rather than
  // retaining it: a production update must run the verified, pinned image.
  const legacyBuild = findNestedBlock(next, appBlock, 'build');
  if (!legacyBuild) throw new Error('foundation migration failed: services.app.image or build block not found');

  const withoutBuild = [...next.slice(0, legacyBuild.start), ...next.slice(legacyBuild.end)];
  const refreshedApp = findServiceBlock(withoutBuild, 'app');
  if (!refreshedApp) throw new Error('foundation migration failed: services.app block not found');
  const indent = ' '.repeat(refreshedApp.indent + 2);
  return [
    ...withoutBuild.slice(0, refreshedApp.start + 1),
    `${indent}image: \${OPFIELD_IMAGE_REF}`,
    ...withoutBuild.slice(refreshedApp.start + 1),
  ];
}

function patchAppSandboxVolume(
  lines: string[],
  appBlock: { start: number; end: number; indent: number },
  defaultDir: string
): string[] {
  const volumes = findNestedBlock(lines, appBlock, 'volumes');
  if (!volumes)
    throw new Error('foundation migration failed: services.app.volumes block not found in docker-compose.yml');

  const volumeIndent = `${' '.repeat(volumes.indent + 2)}`;
  const canonicalBlock = [
    `${volumeIndent}${SANDBOX_VOLUME_START}`,
    `${volumeIndent}- \${SANDBOX_RUNNER_WORKSPACE_DIR:-${defaultDir}}:\${SANDBOX_RUNNER_WORKSPACE_DIR:-${defaultDir}}`,
    `${volumeIndent}${SANDBOX_VOLUME_END}`,
  ];

  const markerStart = findLineInRange(lines, volumes.start + 1, volumes.end, SANDBOX_VOLUME_START);
  const markerEnd = findLineInRange(lines, volumes.start + 1, volumes.end, SANDBOX_VOLUME_END);
  if (markerStart >= 0 || markerEnd >= 0) {
    if (markerStart < 0 || markerEnd < markerStart) {
      throw new Error('foundation migration failed: malformed sandbox workspace managed block');
    }
    return [...lines.slice(0, markerStart), ...canonicalBlock, ...lines.slice(markerEnd + 1)];
  }

  const existingVolume = findExistingSandboxVolume(lines, volumes.start + 1, volumes.end);
  if (existingVolume >= 0) {
    return [...lines.slice(0, existingVolume), ...canonicalBlock, ...lines.slice(existingVolume + 1)];
  }

  const dockerSocketLine = findDockerSocketVolume(lines, volumes.start + 1, volumes.end);
  const insertAt = dockerSocketLine >= 0 ? dockerSocketLine + 1 : volumes.end;
  return [...lines.slice(0, insertAt), ...canonicalBlock, ...lines.slice(insertAt)];
}

export function findServiceBlock(
  lines: string[],
  serviceName: string
): { start: number; end: number; indent: number } | null {
  const servicesBlock = findTopLevelBlock(lines, 'services');
  if (!servicesBlock) return null;
  return findDirectNestedBlock(lines, servicesBlock, serviceName);
}

export function findTopLevelBlock(lines: string[], key: string): { start: number; end: number; indent: number } | null {
  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*:\\s*(?:#.*)?$`);
  for (let index = 0; index < lines.length; index += 1) {
    if (!pattern.test(lines[index])) continue;
    return { start: index, end: findBlockEnd(lines, index + 1, 0), indent: 0 };
  }
  return null;
}

export function findDirectNestedBlock(
  lines: string[],
  parent: { start: number; end: number; indent: number },
  key: string
): { start: number; end: number; indent: number } | null {
  const directIndent = firstChildIndent(lines, parent);
  if (directIndent === null) return null;
  const nestedPattern = new RegExp(`^(\\s{${directIndent}})${escapeRegExp(key)}\\s*:\\s*(?:#.*)?$`);
  for (let index = parent.start + 1; index < parent.end; index += 1) {
    const match = nestedPattern.exec(lines[index]);
    if (!match) continue;
    return {
      start: index,
      end: Math.min(findBlockEnd(lines, index + 1, directIndent), parent.end),
      indent: directIndent,
    };
  }
  return null;
}

export function firstChildIndent(
  lines: string[],
  parent: { start: number; end: number; indent: number }
): number | null {
  for (let index = parent.start + 1; index < parent.end; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent > parent.indent) return indent;
  }
  return null;
}

export function findNestedBlock(
  lines: string[],
  parent: { start: number; end: number; indent: number },
  key: string
): { start: number; end: number; indent: number } | null {
  const nestedPattern = new RegExp(`^(\\s*)${escapeRegExp(key)}\\s*:\\s*(?:#.*)?$`);
  for (let index = parent.start + 1; index < parent.end; index += 1) {
    const match = nestedPattern.exec(lines[index]);
    if (!match) continue;
    const indent = match[1].length;
    if (indent <= parent.indent) continue;
    return { start: index, end: Math.min(findBlockEnd(lines, index + 1, indent), parent.end), indent };
  }
  return null;
}

function findBlockEnd(lines: string[], start: number, indent: number): number {
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const currentIndent = line.length - line.trimStart().length;
    if (currentIndent <= indent) {
      end = index;
      break;
    }
  }
  // Keep sibling managed markers outside this block. Otherwise a later upsert
  // inserts keys after the marker and the sibling rewrite silently removes them.
  while (end > start) {
    const previous = lines[end - 1];
    const previousIndent = previous.length - previous.trimStart().length;
    if (previous.trim() && !(previous.trimStart().startsWith('#') && previousIndent <= indent)) break;
    end -= 1;
  }
  return end;
}

function findLineInRange(lines: string[], start: number, end: number, text: string): number {
  for (let index = start; index < end; index += 1) {
    if (lines[index].includes(text)) return index;
  }
  return -1;
}

function findExistingSandboxVolume(lines: string[], start: number, end: number): number {
  for (let index = start; index < end; index += 1) {
    const line = lines[index];
    if (
      line.includes('SANDBOX_RUNNER_WORKSPACE_DIR') ||
      line.includes(`${DEFAULT_SANDBOX_WORKSPACE_DIR}:${DEFAULT_SANDBOX_WORKSPACE_DIR}`) ||
      line.includes(`${LEGACY_SANDBOX_WORKSPACE_DIR}:${LEGACY_SANDBOX_WORKSPACE_DIR}`)
    ) {
      return index;
    }
  }
  return -1;
}

function findDockerSocketVolume(lines: string[], start: number, end: number): number {
  for (let index = start; index < end; index += 1) {
    if (/^\s*-\s+\/var\/run\/docker\.sock:/.test(lines[index])) return index;
  }
  return -1;
}

function ensureTopLevelVolume(lines: string[], volumeName: string): string[] {
  const volumes = findTopLevelBlock(lines, 'volumes');
  if (!volumes) {
    const separator = lines.length > 0 && lines.at(-1)?.trim() ? [''] : [];
    return [...lines, ...separator, 'volumes:', `  ${volumeName}:`];
  }

  const pattern = new RegExp(`^\\s+${escapeRegExp(volumeName)}\\s*:`);
  if (lines.slice(volumes.start + 1, volumes.end).some((line) => pattern.test(line))) return lines;
  return [...lines.slice(0, volumes.end), `  ${volumeName}:`, ...lines.slice(volumes.end)];
}

function envValue(content: string, key: string): string | null {
  return parseEnvValues(content).get(key) ?? null;
}

function parseEnvValues(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
    const key = envLineKey(line);
    if (!key || values.has(key)) continue;
    values.set(key, line.slice(key.length + 1));
  }
  return values;
}

async function backupFile(filePath: string, backupDir: string): Promise<void> {
  await fs.mkdir(backupDir, { recursive: true });
  await fs.copyFile(filePath, path.join(backupDir, path.basename(filePath)));
}

async function restoreBackups(backupDir: string, writes: PendingFoundationWrite[]): Promise<void> {
  for (const write of writes) {
    const backupPath = path.join(backupDir, path.basename(write.filePath));
    const backupStat = await fs.stat(backupPath);
    await fs.copyFile(backupPath, write.filePath);
    await fs.chmod(write.filePath, backupStat.mode & 0o777);
  }
}

/** Takes group and other permissions off a file; the owner keeps what it has. */
async function restrictToOwner(filePath: string): Promise<void> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (stat && (stat.mode & 0o077) !== 0) await fs.chmod(filePath, stat.mode & 0o700);
}

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const stat = await fs.stat(filePath).catch(() => null);
  await fs.writeFile(tempPath, content, { mode: stat ? stat.mode & 0o777 : 0o600 });
  await fs.rename(tempPath, filePath);
}

function timestampForPath(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
