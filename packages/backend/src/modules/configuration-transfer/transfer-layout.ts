import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { BUILT_IN_GITHUB_OAUTH_CLIENT_ID } from '@/config/env.js';
import { isOpfieldComposeLayout, OPFIELD_VOLUME_KEYS } from '@/foundation/opfield-names.js';

/**
 * What a configuration export carries and where each piece lives on a Compose installation. Shared
 * by the export (in the running app) and the restore (dist/cli/configuration-restore.js).
 */

export const CONFIGURATION_EXPORT_FORMAT = 1;

/**
 * Docker volumes of an export, by their key in the docker-compose.yml of the earlier layout (the export format keeps
 * these keys; composeVolumeKey maps them to the Opfield layout).
 */
export type TransferVolumeKey =
  | 'gateway_data'
  | 'gateway_relay_identity'
  | 'gateway_registry_auth'
  | 'gateway_registry_data'
  | 'clickhouse_data'
  /** The local relay's state: never exported; a restore empties it so the relay pins the restored policy key. */
  | 'gateway_relay_state';

export interface TransferVolumeSpec {
  key: TransferVolumeKey;
  /** Path the volume is mounted at in the app container, when it is. */
  appMount?: string;
  /** Included only when the export asks for it. */
  optional?: 'registry' | 'logs';
  description: string;
}

export const TRANSFER_VOLUMES: readonly TransferVolumeSpec[] = [
  {
    key: 'gateway_data',
    appMount: '/var/lib/gateway',
    description: 'Pages artifacts, avatars, AI artifacts, listener certificates and other Opfield files',
  },
  {
    key: 'gateway_relay_identity',
    appMount: '/var/lib/gateway-relay',
    description: 'Identity of the local relay',
  },
  {
    key: 'gateway_registry_auth',
    appMount: '/var/lib/gateway-registry-auth',
    description: 'Token signing material of the internal registry',
  },
  {
    key: 'gateway_registry_data',
    optional: 'registry',
    description: 'Images in the internal registry',
  },
  {
    key: 'clickhouse_data',
    optional: 'logs',
    description: 'Structured logs in the Opfield-managed ClickHouse',
  },
];

/** Directory of gateway_data where the setup wizard keeps an uploaded export; a restore keeps it until the end. */
export const RESTORE_STAGING_DIR = 'configuration-restore';

/**
 * Environment values that travel. PKI_MASTER_KEY decrypts every stored secret and key; the rest are
 * optional tunables an operator may have set in .env.
 */
export const PORTABLE_ENV_KEYS = [
  'PKI_MASTER_KEY',
  'GITHUB_OAUTH_CLIENT_ID',
  'HEALTH_CHECK_INTERVAL_SECONDS',
  'ACME_RENEWAL_CRON',
  'EXPIRY_CHECK_CRON',
  'DNS_RESOLVERS',
  'DNS_CHECK_INTERVAL_SECONDS',
  'UPDATE_CHECK_INTERVAL_HOURS',
  'SECURE_LINK_LOOPBACK_PORT',
] as const;

/** What the new host keeps or asks for instead of the exported value; shown before an export and in the docs. */
export const HOST_SPECIFIC_VALUES = [
  'The public URL and the gRPC address nodes connect to (asked during the restore)',
  'Database and registry passwords (the new installation makes its own)',
  'PUBLIC_IPV4, PUBLIC_IPV6, OPFIELD_LOCAL_HOSTS and GRPC_TLS_* overrides in .env',
  'The sandbox workspace directory and Docker logging of the new host',
  'Reverse proxy, firewall and DNS records in front of Opfield',
  'Sign-in sessions: everyone signs in again',
] as const;

export type PortableEnvKey = (typeof PORTABLE_ENV_KEYS)[number];

export interface TransferVolumeManifest {
  key: TransferVolumeKey;
  part: string;
  /** Name of the top directory in the part's tar stream; restore mounts the volume there. */
  root: string;
}

export interface ConfigurationExportManifest {
  format: number;
  createdAt: string;
  opfieldVersion: string;
  schemaMigration: string;
  installationId: string;
  source: {
    publicUrl: string | null;
    grpcPublicTarget: string | null;
    grpcLocalIp: string | null;
    composeProject: string;
  };
  includes: { registry: boolean; logs: boolean };
  /** OPFIELD_COMMERCIAL_DIR of the exporting app, when a commercial core is installed. */
  commercialDir: string | null;
  database: { part: string; file: string };
  volumes: TransferVolumeManifest[];
  /** The commercial directory of the install dir (see commercialHostRoot), as a tar part rooted at `root`. */
  commercial: { part: string; root: string } | null;
  environmentPart: string;
}

export const ENVIRONMENT_PART = 'environment.json';
export const DATABASE_PART = 'database.tar';
export const DATABASE_DUMP_FILE = 'opfield-configuration-export.dump';
export const COMMERCIAL_PART = 'host/gateway-commercial.tar';

export function volumePartName(key: TransferVolumeKey): string {
  return `volume/${key}.tar`;
}

/** The portable environment values present in `env`. */
export function portableEnvironment(env: NodeJS.ProcessEnv): Partial<Record<PortableEnvKey, string>> {
  const values: Partial<Record<PortableEnvKey, string>> = {};
  for (const key of PORTABLE_ENV_KEYS) {
    const value = env[key]?.trim();
    if (!value) continue;
    if (key === 'GITHUB_OAUTH_CLIENT_ID' && value === BUILT_IN_GITHUB_OAUTH_CLIENT_ID) continue;
    values[key] = value;
  }
  if (!values.PKI_MASTER_KEY || !/^[0-9a-fA-F]{64}$/.test(values.PKI_MASTER_KEY)) {
    throw new Error('PKI_MASTER_KEY is not available to the export');
  }
  return values;
}

/** Validates the environment part of an export before it is written to .env. */
export function parsePortableEnvironment(value: unknown): Partial<Record<PortableEnvKey, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The export environment is invalid');
  const result: Partial<Record<PortableEnvKey, string>> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!(PORTABLE_ENV_KEYS as readonly string[]).includes(key)) continue;
    if (typeof raw !== 'string' || raw.length > 4096 || /[\r\n\0]/.test(raw)) {
      throw new Error(`The exported value of ${key} is invalid`);
    }
    result[key as PortableEnvKey] = raw;
  }
  if (!result.PKI_MASTER_KEY || !/^[0-9a-fA-F]{64}$/.test(result.PKI_MASTER_KEY)) {
    throw new Error('The export has no valid PKI_MASTER_KEY');
  }
  return result;
}

/** Tag of the last database migration this build ships (the app runs them all on start). */
export function currentSchemaMigration(migrationsFolder = resolve('src/db/migrations')): string {
  const journal = JSON.parse(readFileSync(resolve(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
    entries?: Array<{ tag?: string }>;
  };
  const tag = journal.entries?.at(-1)?.tag;
  if (!tag) throw new Error('The database migration journal is empty');
  return tag;
}

/** The key of an exported volume in docker-compose.yml: the Opfield layout renamed the earlier keys. */
export function composeVolumeKey(key: TransferVolumeKey, compose?: string | null): string {
  if (key === 'clickhouse_data' || !compose || !isOpfieldComposeLayout(compose)) return key;
  return OPFIELD_VOLUME_KEYS[key] ?? key;
}

function declaredVolumeName(compose: string, composeKey: string): string | null {
  try {
    const volumes = (parseDocument(compose).toJS() as { volumes?: Record<string, { name?: unknown } | null> } | null)
      ?.volumes;
    const name = volumes?.[composeKey]?.name;
    return typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

/**
 * Compose names a project volume `<project>_<key>` unless docker-compose.yml names it (an installation moved to the
 * Opfield layout keeps its earlier volumes by name); the managed ClickHouse volume follows the same pattern.
 */
export function composeVolumeName(project: string, key: TransferVolumeKey, compose?: string | null): string {
  if (key === 'clickhouse_data') return `${project.replace(/[^a-zA-Z0-9_.-]/g, '-')}_clickhouse_data`;
  const composeKey = composeVolumeKey(key, compose);
  return (compose ? declaredVolumeName(compose, composeKey) : null) ?? `${project}_${composeKey}`;
}

/** Same version only: an export restores into the Opfield release and schema it was made by. */
export function versionMismatch(
  exported: { opfieldVersion: string; schemaMigration: string },
  current: { opfieldVersion: string; schemaMigration: string }
): string | null {
  if (exported.opfieldVersion !== current.opfieldVersion) {
    return `This export was made by Opfield ${exported.opfieldVersion}, and this installation runs ${current.opfieldVersion}. Restore it into Opfield ${exported.opfieldVersion}: install that exact version, restore, then update.`;
  }
  if (exported.schemaMigration !== current.schemaMigration) {
    return `This export was made by a build of Opfield ${exported.opfieldVersion} with another database schema (${exported.schemaMigration}, this build has ${current.schemaMigration}). Restore it into the build it was made by.`;
  }
  return null;
}

export function exportFileName(publicUrl: string | null, createdAt: Date): string {
  let host = 'opfield';
  try {
    if (publicUrl) host = new URL(publicUrl).hostname.replace(/[^a-zA-Z0-9.-]/g, '-') || host;
  } catch {
    // The default name stays.
  }
  const stamp = createdAt.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return `${host}-${stamp}.opfield-export`;
}
