import { envLineKey } from './opfield-names.js';

/**
 * Where the managed registry keeps images: its local volume (the default) or an S3 bucket. The installation's .env
 * holds the choice and the bucket settings, and docker-compose.yml refers to them, so every update, foundation
 * migration and `docker compose up` starts the registry on the same storage. Without the .env keys the registry stays
 * on its volume, as installations always did.
 */
export type RegistryStorageBackend = 'filesystem' | 's3';

export const REGISTRY_STORAGE_ENV_KEYS = {
  backend: 'OPFIELD_REGISTRY_STORAGE',
  region: 'OPFIELD_REGISTRY_S3_REGION',
  endpoint: 'OPFIELD_REGISTRY_S3_ENDPOINT',
  bucket: 'OPFIELD_REGISTRY_S3_BUCKET',
  rootDirectory: 'OPFIELD_REGISTRY_S3_ROOTDIRECTORY',
  forcePathStyle: 'OPFIELD_REGISTRY_S3_FORCEPATHSTYLE',
  secure: 'OPFIELD_REGISTRY_S3_SECURE',
  accessKeyId: 'OPFIELD_REGISTRY_S3_ACCESSKEY',
  secretAccessKey: 'OPFIELD_REGISTRY_S3_SECRETKEY',
} as const;

/** Where the registry's filesystem driver keeps its data inside the container (the registry volume). */
export const REGISTRY_FILESYSTEM_ROOT = '/var/lib/registry';

export interface RegistryS3Settings {
  /** S3 API endpoint (`https://host[:port]`); null uses AWS S3 of the region. */
  endpoint: string | null;
  region: string;
  bucket: string;
  /** Folder in the bucket, without leading or trailing slash; empty for the bucket root. */
  rootDirectory: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

/** The S3 settings without the secret key, as the API shows them. */
export type RegistryS3SettingsView = Omit<RegistryS3Settings, 'secretAccessKey'>;

const UNSAFE_ENV_VALUE = /['\r\n\0]/;

/** Values go into .env in single quotes (literal for Compose): a value must not contain a quote or a line break. */
export function assertRegistryStorageEnvValue(name: string, value: string): void {
  if (UNSAFE_ENV_VALUE.test(value)) throw new Error(`${name} must not contain quotes or line breaks`);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(['"])(.*)\1$/.exec(trimmed);
  return quoted ? quoted[2]! : trimmed;
}

function envFileValues(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
    const key = envLineKey(line);
    if (!key || values.has(key)) continue;
    values.set(key, unquote(line.slice(key.length + 1)));
  }
  return values;
}

/** The storage the .env selects; anything but `s3` keeps the registry volume. */
export function registryStorageBackendFromEnv(content: string): RegistryStorageBackend {
  return envFileValues(content).get(REGISTRY_STORAGE_ENV_KEYS.backend) === 's3' ? 's3' : 'filesystem';
}

/** The storage the registry block of a docker-compose.yml runs on. */
export function registryStorageBackendFromCompose(lines: readonly string[]): RegistryStorageBackend {
  return lines.some((line) => /^\s*REGISTRY_STORAGE\s*:\s*["']?s3["']?\s*(?:#.*)?$/.test(line)) ? 's3' : 'filesystem';
}

/**
 * The registry's storage environment in docker-compose.yml. The S3 values come from the .env, so the file itself holds
 * no key. The filesystem setting must be absent for S3: the registry refuses two storage drivers.
 */
export function registryStorageComposeEnvironment(backend: RegistryStorageBackend): string[] {
  if (backend === 'filesystem') return [`REGISTRY_STORAGE_FILESYSTEM_ROOTDIRECTORY: ${REGISTRY_FILESYSTEM_ROOT}`];
  const keys = REGISTRY_STORAGE_ENV_KEYS;
  return [
    'REGISTRY_STORAGE: s3',
    `REGISTRY_STORAGE_S3_REGION: \${${keys.region}}`,
    `REGISTRY_STORAGE_S3_REGIONENDPOINT: \${${keys.endpoint}:-}`,
    `REGISTRY_STORAGE_S3_BUCKET: \${${keys.bucket}}`,
    `REGISTRY_STORAGE_S3_ROOTDIRECTORY: \${${keys.rootDirectory}:-}`,
    `REGISTRY_STORAGE_S3_FORCEPATHSTYLE: \${${keys.forcePathStyle}:-false}`,
    `REGISTRY_STORAGE_S3_SECURE: \${${keys.secure}:-true}`,
    `REGISTRY_STORAGE_S3_ACCESSKEY: \${${keys.accessKeyId}}`,
    `REGISTRY_STORAGE_S3_SECRETKEY: \${${keys.secretAccessKey}}`,
    // Nodes pull through the registry; a redirect would send them to the bucket, which they may not reach.
    'REGISTRY_STORAGE_REDIRECT_DISABLE: "true"',
  ];
}

/** The .env values of a storage choice; null removes the key (the registry volume needs none). */
export function registryStorageEnvValues(settings: RegistryS3Settings | null): Record<string, string | null> {
  const keys = REGISTRY_STORAGE_ENV_KEYS;
  if (!settings) return Object.fromEntries(Object.values(keys).map((key) => [key, null]));
  const values: Record<string, string> = {
    [keys.backend]: 's3',
    [keys.region]: settings.region,
    [keys.endpoint]: settings.endpoint ?? '',
    [keys.bucket]: settings.bucket,
    [keys.rootDirectory]: settings.rootDirectory,
    [keys.forcePathStyle]: String(settings.forcePathStyle),
    [keys.secure]: String(!settings.endpoint?.startsWith('http://')),
    [keys.accessKeyId]: settings.accessKeyId,
    [keys.secretAccessKey]: settings.secretAccessKey,
  };
  for (const [key, value] of Object.entries(values)) assertRegistryStorageEnvValue(key, value);
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, `'${value}'`]));
}

/** The .env with the storage keys set, or removed for the registry volume; other lines stay as they are. */
export function applyRegistryStorageEnv(content: string, settings: RegistryS3Settings | null): string {
  const values = registryStorageEnvValues(settings);
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const hadTrailingNewline = lines.at(-1) === '';
  if (hadTrailingNewline) lines.pop();
  const next = lines.filter((line) => {
    const key = envLineKey(line);
    return !key || !(key in values);
  });
  const added = Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== null);
  while (next.at(-1) === '') next.pop();
  if (added.length > 0 && next.length > 0) next.push('');
  for (const [key, value] of added) next.push(`${key}=${value}`);
  return `${next.join('\n')}\n`;
}

/**
 * The storage the running registry container uses, read from its environment (what Compose resolved from the .env).
 * The secret is returned for reuse when only other settings change; callers never show it.
 */
export function registryStorageFromContainerEnv(env: readonly string[]): {
  backend: RegistryStorageBackend;
  s3: RegistryS3Settings | null;
} {
  const values = new Map<string, string>();
  for (const entry of env) {
    const index = entry.indexOf('=');
    if (index > 0) values.set(entry.slice(0, index), entry.slice(index + 1));
  }
  if (values.get('REGISTRY_STORAGE') !== 's3') return { backend: 'filesystem', s3: null };
  const value = (name: string) => values.get(`REGISTRY_STORAGE_S3_${name}`) ?? '';
  return {
    backend: 's3',
    s3: {
      endpoint: value('REGIONENDPOINT') || null,
      region: value('REGION'),
      bucket: value('BUCKET'),
      rootDirectory: normalizeRegistryRootDirectory(value('ROOTDIRECTORY')),
      forcePathStyle: value('FORCEPATHSTYLE') === 'true',
      accessKeyId: value('ACCESSKEY'),
      secretAccessKey: value('SECRETKEY'),
    },
  };
}

/** A bucket folder without leading, trailing or repeated slashes. */
export function normalizeRegistryRootDirectory(value: string): string {
  return value
    .split('/')
    .filter((segment) => segment.length > 0)
    .join('/');
}

/** The object key under the registry's folder in the bucket. */
export function registryObjectKey(rootDirectory: string, path: string): string {
  const relative = path.replace(/^\/+/, '');
  return rootDirectory ? `${rootDirectory}/${relative}` : relative;
}
