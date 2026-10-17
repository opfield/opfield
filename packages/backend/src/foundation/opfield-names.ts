import { ENV_PREFIX, LEGACY_ENV_PREFIX, opfieldEnvName } from '@/config/env.js';
import { compareSemver, parseSemver } from '@/lib/semver.js';

/**
 * Names of the Opfield app host: install directory, Compose project, database, managed-service labels and the
 * installer-managed markers of docker-compose.yml. Installations made before 2.12.1 use the legacy names until the
 * host move (foundation/host-move) gives them the Opfield layout; every legacy name below is read, never written.
 */

export const OPFIELD_INSTALL_DIR_NAME = 'opfield';
export const OPFIELD_COMPOSE_PROJECT = 'opfield';
export const OPFIELD_DATABASE = 'opfield';
export const OPFIELD_DATABASE_ROLE = 'opfield';
export const OPFIELD_LOGS_DATABASE = 'opfield_logs';
export const OPFIELD_CLICKHOUSE_ALIAS = 'opfield-clickhouse';

// legacy-name: the layout of installations made before 2.12.1 (legacy install directory, Compose project, database
// and ClickHouse database; see legacy-compat.ts) — remove once every installation reports the Opfield layout.
export const LEGACY_INSTALL_DIR_NAME = 'gateway';
export const LEGACY_COMPOSE_PROJECT = 'gateway';
export const LEGACY_DATABASE = 'gateway';
export const LEGACY_DATABASE_ROLE = 'gateway';
export const LEGACY_LOGS_DATABASE = 'gateway_logs';
export const LEGACY_CLICKHOUSE_ALIAS = 'gateway-clickhouse';

/** The first release in the Opfield layout; its relay image is the first with RELAY_BINARY. */
export const FIRST_OPFIELD_RELEASE = 'v2.12.1-rc.3';
export const RELAY_BINARY = '/opfield-relay';
// legacy-name: the legacy relay binary path — the only binary of relay images before 2.12.1; later relay images keep it as a link,
// so Compose names it until the relay image of the installation is new enough.
export const LEGACY_RELAY_BINARY = '/gateway-relay';

/** The relay binary Compose may run for a relay image of `buildVersion` (unknown versions get the one every image has). */
export function relayBinary(buildVersion: string | null | undefined): string {
  if (!buildVersion || !parseSemver(buildVersion)) return LEGACY_RELAY_BINARY;
  return compareSemver(buildVersion, FIRST_OPFIELD_RELEASE) >= 0 ? RELAY_BINARY : LEGACY_RELAY_BINARY;
}

/** Points the relay entrypoint and healthcheck of docker-compose.yml lines at `binary`. */
export function withRelayBinary(line: string, binary: string): string {
  return line
    .replace(/^(\s*entrypoint:\s*\[")\/(?:gateway|opfield)-relay("\]\s*)$/, `$1${binary}$2`)
    .replace(/^(\s*test:\s*\["CMD",\s*")\/(?:gateway|opfield)-relay(",\s*"healthcheck"\]\s*)$/, `$1${binary}$2`);
}

/** Label of the installer-managed Compose services (app, relay, registry). */
export const MANAGED_SERVICE_LABEL = 'net.opfield.managed-service';
// legacy-name: the pre-2.12.1 managed-service label — containers created before 2.12.1 keep it until they are
// recreated (the host move recreates all of them) — remove once every installation reports the Opfield layout.
export const LEGACY_MANAGED_SERVICE_LABEL = 'com.wiolett.gateway.managed-service';

/** Labels of the local ClickHouse container the logging core manages. */
export const MANAGED_CLICKHOUSE_LABEL = 'net.opfield.managed';
export const MANAGED_CLICKHOUSE_OWNER_LABEL = 'net.opfield.owner';
// legacy-name: the pre-2.12.1 managed/owner labels of a local ClickHouse created before 2.12.1
// (the host move recreates it with the new labels) — remove once every installation reports the Opfield layout.
export const LEGACY_MANAGED_CLICKHOUSE_LABEL = 'net.wiolett.gateway.managed';
export const LEGACY_MANAGED_CLICKHOUSE_OWNER_LABEL = 'net.wiolett.gateway.owner';

/** Audience and issuer of internal registry tokens; the registry checks both against its own environment. */
export const REGISTRY_TOKEN_SERVICE = 'opfield-internal-registry';
// legacy-name: the legacy internal registry name — the registry of an installation that has not moved to the Opfield layout
// keeps checking it (the move recreates the registry with the new name) — remove once every installation reports the
// Opfield layout.
export const LEGACY_REGISTRY_TOKEN_SERVICE = 'gateway-internal-registry';

/** Backups of .env and docker-compose.yml (and the pre-update database dump) in the install directory. */
export const FOUNDATION_BACKUPS_DIR = '.opfield-foundation-backups';
// legacy-name: the foundation backup directory written by updates before 2.12.1; only pruned — remove once every
// installation reports the Opfield layout.
export const LEGACY_FOUNDATION_BACKUPS_DIR = '.gateway-foundation-backups';
export const DATABASE_SNAPSHOT_FILE = 'opfield-db.dump';
// legacy-name: database dump snapshots of updates before 2.12.1; only pruned.
export const LEGACY_DATABASE_SNAPSHOT_FILE = 'gateway-db.dump';

/** Marker comments around the installer-managed blocks of docker-compose.yml. */
export const MANAGED_MARKER_PREFIX = '# opfield-managed:';
// legacy-name: the managed-block markers of docker-compose.yml files written before 2.12.1; the migrator rewrites
// them — remove once every installation reports the Opfield layout.
export const LEGACY_MANAGED_MARKER_PREFIX = '# gateway-managed:';

/** Compose volume keys of the Opfield layout, by the key the earlier layout used. */
export const OPFIELD_VOLUME_KEYS: Readonly<Record<string, string>> = {
  // legacy-name: the earlier keys on the left — the host move renames them and binds the physical volumes by name.
  gateway_data: 'app_data',
  gateway_relay_identity: 'relay_identity',
  gateway_relay_state: 'relay_state',
  gateway_registry_data: 'registry_data',
  gateway_registry_auth: 'registry_auth',
  postgres_data: 'postgres_data',
  redis_data: 'redis_data',
};

/** The Compose volume keys a layout uses for the installer-managed volumes. */
export interface ComposeVolumeKeys {
  appData: string;
  relayIdentity: string;
  relayState: string;
  registryData: string;
  registryAuth: string;
}

export const OPFIELD_COMPOSE_VOLUME_KEYS: ComposeVolumeKeys = {
  appData: 'app_data',
  relayIdentity: 'relay_identity',
  relayState: 'relay_state',
  registryData: 'registry_data',
  registryAuth: 'registry_auth',
};

// legacy-name: volume keys of docker-compose.yml files before the host move.
export const LEGACY_COMPOSE_VOLUME_KEYS: ComposeVolumeKeys = {
  appData: 'gateway_data',
  relayIdentity: 'gateway_relay_identity',
  relayState: 'gateway_relay_state',
  registryData: 'gateway_registry_data',
  registryAuth: 'gateway_registry_auth',
};

/** Whether docker-compose.yml is in the Opfield layout: it names its project `opfield` itself. */
export function isOpfieldComposeLayout(compose: string): boolean {
  return /^name\s*:\s*["']?opfield["']?\s*(?:#.*)?$/m.test(compose.replace(/\r\n/g, '\n'));
}

/** References to pre-2.12.1 variable names in a value or a compose file, under their OPFIELD_* names. */
export function renameLegacyEnvReferences(content: string): string {
  return content.replace(/\$\{GATEWAY_([A-Z0-9_]+)/g, '${OPFIELD_$1').replace(/\$GATEWAY_([A-Z0-9_]+)/g, '$OPFIELD_$1');
}

/**
 * Renames the legacy GATEWAY_* keys of a .env file to OPFIELD_*, and the references to them in the values
 * (`APP_VERSION=${GATEWAY_VERSION}` of the early Go installer). When both names are set, the OPFIELD_* value wins
 * and the legacy line is dropped. Comments, blank lines and every other key stay as they are. A .env renamed before
 * 2.12.2 still holding a reference to a GATEWAY_* key it no longer has is repaired the same way.
 */
export function renameLegacyEnvFileKeys(content: string): string {
  const hadTrailingNewline = content.endsWith('\n');
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const present = new Set(lines.map(envLineKey).filter((key): key is string => key !== null));
  const next: string[] = [];
  for (const line of lines) {
    const key = envLineKey(line);
    const renamed = key ? opfieldEnvName(key) : null;
    const value = key ? renameLegacyEnvReferences(line.slice(key.length)) : '';
    if (!key || !renamed) {
      next.push(key ? `${key}${value}` : line);
      continue;
    }
    if (present.has(renamed)) continue;
    present.add(renamed);
    next.push(`${renamed}${value}`);
  }
  return `${next.join('\n')}${hadTrailingNewline && next.length > 0 ? '\n' : ''}`;
}

/**
 * The names of docker-compose.yml that do not identify Docker objects: environment variables (keys and
 * interpolation), the managed-service label, the installer markers and the installer's comments. Running containers
 * are not touched by this; the services pick the names up when they are recreated. The project, volumes, database
 * and registry audience stay: those change only in the host move, once the new version has proved healthy.
 */
export function applyComposeVocabulary(content: string): string {
  const legacyLabel = escapeRegExp(LEGACY_MANAGED_SERVICE_LABEL);
  return renameLegacyEnvReferences(content)
    .replace(/^(\s*(?:-\s*)?["']?)GATEWAY_([A-Z0-9_]+)(["']?\s*[:=])/gm, '$1OPFIELD_$2$3')
    .replace(/^(\s*-\s*["']?)GATEWAY_([A-Z0-9_]+)(["']?\s*)$/gm, '$1OPFIELD_$2$3')
    .replace(new RegExp(`^(\\s*(?:-\\s*)?["']?)${legacyLabel}(["']?\\s*[:=])`, 'gm'), `$1${MANAGED_SERVICE_LABEL}$2`)
    .replaceAll(LEGACY_MANAGED_MARKER_PREFIX, MANAGED_MARKER_PREFIX)
    .replace(/^(\s*#.*?)\bGateway-managed\b/gm, '$1Opfield-managed')
    .replace(/^(\s*#.*?)\bRun Gateway on\b/gm, '$1Run Opfield on');
}

export function envLineKey(line: string): string | null {
  const match = /^([A-Z_][A-Z0-9_]*)=/.exec(line);
  return match?.[1] ?? null;
}

/** The value of `name` in a .env file, under its OPFIELD_* name or its pre-2.12.1 name. */
export function envFileValue(content: string, suffix: string): string | null {
  const values = new Map<string, string>();
  for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
    const key = envLineKey(line);
    if (!key || values.has(key)) continue;
    values.set(key, line.slice(key.length + 1));
  }
  // legacy-name: GATEWAY_<suffix> of a .env file the migrator has not rewritten yet.
  return values.get(`${ENV_PREFIX}${suffix}`) ?? values.get(`${LEGACY_ENV_PREFIX}${suffix}`) ?? null;
}

/** Database role and name of a postgres:// URL; null when it is not one. */
export function databaseIdentity(url: string | undefined | null): { role: string; database: string } | null {
  if (!url) return null;
  const match = /^postgres(?:ql)?:\/\/([^:@/]+)(?::[^@]*)?@[^/]+\/([^?#]+)/.exec(url.trim());
  if (!match) return null;
  try {
    return { role: decodeURIComponent(match[1]!), database: decodeURIComponent(match[2]!) };
  } catch {
    return null;
  }
}

/** A Postgres identifier this code may put into a shell command or SQL unquoted. */
export function isSafeDatabaseIdentifier(value: string): boolean {
  return /^[a-z_][a-z0-9_]{0,62}$/.test(value);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
