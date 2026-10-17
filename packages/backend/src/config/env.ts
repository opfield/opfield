import { z } from 'zod';
import {
  DEFAULT_CLOUD_PORTAL_URL,
  OFFICIAL_IMAGE_REPOSITORIES,
  OFFICIAL_INFERENCE_CORE_IMAGE_REPOSITORIES,
  UPDATES_BASE_URL,
} from './vendor-urls.js';
import { LEGACY_ENV_PREFIX, LEGACY_IMAGE_REPOSITORY } from '@/lib/legacy-compat.js';

export const DEVELOPMENT_SECURE_LINK_CONNECTOR_IMAGE = 'opfield-secure-link-connector:dev';
export const BUILT_IN_GITHUB_OAUTH_CLIENT_ID = 'Ov23likbDL1gM8asWzfC';
const IMMUTABLE_CONNECTOR_IMAGE_PATTERN = /^.+@sha256:[0-9a-f]{64}$/i;
const OFFICIAL_CONNECTOR_RELEASE_TAG_PATTERN =
  new RegExp(
    String.raw`^(?:ghcr\.io\/opfield\/opfield|${LEGACY_IMAGE_REPOSITORY.replaceAll('.', '\\.')})\/secure-link-connector:v[0-9]+\.[0-9]+\.[0-9]+(?:-rc\.[0-9]+)?-relay$`
  );
const deploymentModeSchema = z.enum(['standard', 'demo']).default('standard');

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().optional()
);
const nonEmptyStringWithDefault = (fallback: string) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().optional().default(fallback)
  );

const envSchema = z.object({
  // Server
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Database
  DATABASE_URL: z.string().url(),

  // Redis
  REDIS_URL: z.string().url(),

  // Optional override for the built-in public OAuth App client used by GitHub Device Flow.
  // Device Flow does not use a client secret or a per-instance callback URL.
  GITHUB_OAUTH_CLIENT_ID: nonEmptyStringWithDefault(BUILT_IN_GITHUB_OAUTH_CLIENT_ID),

  // App
  APP_URL: z.string().url().default('http://localhost:3000'),
  APP_VERSION: z.string().default('dev'),
  OPFIELD_COMMERCIAL_DIR: z.string().min(1).default('/var/lib/opfield/commercial'),
  OPFIELD_DEPLOYMENT_MODE: deploymentModeSchema,
  BIND_HOST: z.string().default('0.0.0.0'),
  OPFIELD_LOCAL_HOSTS: z.string().optional(),
  WEB_TLS_BOOTSTRAP_MODE: z.enum(['http', 'https']).optional(),
  WEB_TLS_AUTO_DIR: nonEmptyStringWithDefault('/var/lib/opfield/tls'),
  PAGES_STORAGE_DIR: nonEmptyStringWithDefault('/var/lib/opfield/pages'),

  // Console on its own domain (managed cloud VMs, installer --domain/--acme-email): HTTPS with a Let's Encrypt
  // certificate the app obtains over HTTP-01 and renews itself. Unset keeps only the PORT listener.
  OPFIELD_CONSOLE_DOMAIN: optionalNonEmptyString,
  OPFIELD_ACME_EMAIL: optionalNonEmptyString,
  // ACME directory override for tests: a directory URL, or "staging" for the Let's Encrypt staging CA.
  OPFIELD_ACME_DIRECTORY_URL: optionalNonEmptyString,
  // Container ports of the console listeners; the installer publishes them as 443 and 80.
  OPFIELD_CONSOLE_HTTPS_PORT: z.coerce.number().int().min(1).max(65535).default(3443),
  OPFIELD_CONSOLE_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3080),

  // Node-level transport for Docker Route Secure Links. Production accepts
  // either the digest-pinned release image or the official GHCR Relay release tag.
  SECURE_LINK_CONNECTOR_IMAGE: z.string().trim().default(''),

  // Compose project dir (for self-update sidecar)
  COMPOSE_PROJECT_DIR: z.string().optional(),

  // Updates
  RELEASES_API_URL: z.string().url().default(`${UPDATES_BASE_URL}/releases`),
  ARTIFACT_BASE_URL: z.string().url().default(UPDATES_BASE_URL),
  // Signed update images are accepted from the installation's own repository and these (comma-separated).
  OPFIELD_UPDATE_IMAGE_REPOSITORIES: z.string().default(OFFICIAL_IMAGE_REPOSITORIES.join(',')),
  INFERENCE_CORE_UPDATE_IMAGE_REPOSITORIES: z.string().default(OFFICIAL_INFERENCE_CORE_IMAGE_REPOSITORIES.join(',')),
  UPDATE_CHECK_INTERVAL_HOURS: z.coerce.number().default(4),

  // Cloud account portal that a connected installation enrols with and keeps its cloud link socket to.
  CLOUD_PORTAL_URL: z.string().url().default(DEFAULT_CLOUD_PORTAL_URL),

  // License service address(es), comma-separated, tried before the ones Opfield finds by itself (docs/licensing.md).
  LICENSE_SERVICE_URL: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .string()
      .refine(
        (value) =>
          value
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean)
            .every((entry) => URL.canParse(entry) && /^https?:$/.test(new URL(entry).protocol)),
        'LICENSE_SERVICE_URL must be a comma-separated list of http(s) URLs'
      )
      .optional()
  ),

  // Managed inference core. The distribution image repository is derived from
  // Opfield's own image; the override exists for development/lab installs
  // where the Opfield image is a local build without the production repo name.
  INFERENCE_CORE_DISTRIBUTION_IMAGE: z.string().trim().optional(),

  // PKI Master Key — 32 bytes as 64-char hex string for envelope encryption
  PKI_MASTER_KEY: z
    .string()
    .length(64)
    .regex(/^[0-9a-fA-F]+$/),

  // DNS / Domains
  PUBLIC_IPV4: z.string().optional(),
  PUBLIC_IPV6: z.string().optional(),
  DNS_RESOLVERS: z.string().default('8.8.8.8,1.1.1.1'),
  DNS_CHECK_INTERVAL_SECONDS: z.coerce.number().default(300),

  // Background Jobs
  HEALTH_CHECK_INTERVAL_SECONDS: z.coerce.number().default(30),
  ACME_RENEWAL_CRON: z.string().default('0 3 * * *'), // 3 AM daily
  EXPIRY_CHECK_CRON: z.string().default('0 6 * * *'), // 6 AM daily

  SETUP_BOOTSTRAP: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  // The port of every Route Secure Link loopback endpoint on nginx nodes (127.64.0.0 onwards, one address per link).
  // Move it when another service on the nginx nodes listens on this port on all addresses.
  SECURE_LINK_LOOPBACK_PORT: z.coerce.number().int().min(1).max(65535).default(17613),

  // gRPC server for daemon communication
  GRPC_PORT: z.coerce.number().default(9443),
  GRPC_TLS_CERT: optionalNonEmptyString,
  GRPC_TLS_KEY: optionalNonEmptyString,
  GRPC_TLS_AUTO_DIR: nonEmptyStringWithDefault('/var/lib/opfield/tls'),
  OPFIELD_RELAY_IDENTITY_DIR: nonEmptyStringWithDefault('/var/lib/opfield-relay'),
  OPFIELD_RELAY_TARGET: nonEmptyStringWithDefault('relay:9443'),
  OPFIELD_RELAY_REQUIRED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  OPFIELD_RELAY_MANAGED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  OPFIELD_RELAY_IMAGE_REF: optionalNonEmptyString,
  OPFIELD_RELAY_SERVICE_NAME: nonEmptyStringWithDefault('relay'),
  OPFIELD_RELAY_BUILD_VERSION: optionalNonEmptyString,
  OPFIELD_RELAY_PROTOCOL_MAJOR: z.coerce.number().int().positive().default(1),

  BACKUP_RUNNER_IMAGE: optionalNonEmptyString,

  // AI sandbox artifacts
  AI_SANDBOX_ARTIFACT_DIR: nonEmptyStringWithDefault('/var/lib/opfield/ai-artifacts'),
});

export type Env = z.infer<typeof envSchema>;

/** Prefix of every Opfield environment variable. */
export const ENV_PREFIX = 'OPFIELD_';
// legacy-name: the pre-2.12.1 environment names of .env and docker-compose.yml files written before 2.12.1 — remove once
// every installation's files were rewritten by the 2.12.1 foundation migrator, which renames them to OPFIELD_*.
export { LEGACY_ENV_PREFIX };

/** The OPFIELD_* name of a pre-2.12.1 environment variable; null for any other name. */
export function opfieldEnvName(legacyName: string): string | null {
  if (!legacyName.startsWith(LEGACY_ENV_PREFIX) || legacyName.length === LEGACY_ENV_PREFIX.length) return null;
  return `${ENV_PREFIX}${legacyName.slice(LEGACY_ENV_PREFIX.length)}`;
}

/**
 * Gives every pre-2.12.1 variable its OPFIELD_* name, unless the OPFIELD_* one is set: an installation whose
 * files still carry the old names runs as if it had the new ones. Mutates and returns `env`.
 */
export function applyLegacyEnvNames(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const [name, value] of Object.entries(env)) {
    const current = opfieldEnvName(name);
    if (!current || value === undefined || env[current] !== undefined) continue;
    env[current] = value;
  }
  return env;
}

/**
 * An empty APP_VERSION takes the installed version from OPFIELD_VERSION: a .env whose APP_VERSION referred to a
 * variable that was later renamed (an `APP_VERSION` reference to the pre-2.12.1 version variable of the early Go installer) would otherwise run with
 * no version, and the paid core refuses a host without one. Mutates and returns `env`.
 */
export function applyVersionFallback(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const installed = readOpfieldEnv('VERSION', env)?.trim();
  if (!env.APP_VERSION?.trim() && installed) env.APP_VERSION = installed;
  return env;
}

/** The OPFIELD_<suffix> variable, or its pre-2.12.1 name when only that is set. */
export function readOpfieldEnv(suffix: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  // legacy-name: the pre-2.12.1 name — see LEGACY_ENV_PREFIX.
  return env[`${ENV_PREFIX}${suffix}`] ?? env[`${LEGACY_ENV_PREFIX}${suffix}`];
}

let cachedEnv: Env | null = null;

export function getEnv(): Env {
  if (cachedEnv) {
    return cachedEnv;
  }

  // Code that reads process.env directly sees the OPFIELD_* names too.
  applyLegacyEnvNames(process.env);
  applyVersionFallback(process.env);
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid environment variables:');
    console.error(result.error.format());
    throw new Error('Invalid environment variables');
  }

  const parsedEnv = result.data;
  if (
    parsedEnv.NODE_ENV === 'production' &&
    parsedEnv.SECURE_LINK_CONNECTOR_IMAGE &&
    !IMMUTABLE_CONNECTOR_IMAGE_PATTERN.test(parsedEnv.SECURE_LINK_CONNECTOR_IMAGE) &&
    !OFFICIAL_CONNECTOR_RELEASE_TAG_PATTERN.test(parsedEnv.SECURE_LINK_CONNECTOR_IMAGE)
  ) {
    throw new Error(
      'SECURE_LINK_CONNECTOR_IMAGE must use an immutable sha256 digest or an official Opfield Relay release tag in production'
    );
  }
  cachedEnv = parsedEnv;
  if (cachedEnv.NODE_ENV === 'development' && !cachedEnv.SECURE_LINK_CONNECTOR_IMAGE) {
    cachedEnv.SECURE_LINK_CONNECTOR_IMAGE = DEVELOPMENT_SECURE_LINK_CONNECTOR_IMAGE;
  }
  return cachedEnv;
}

export function getDeploymentMode(): Env['OPFIELD_DEPLOYMENT_MODE'] {
  const result = deploymentModeSchema.safeParse(readOpfieldEnv('DEPLOYMENT_MODE'));
  if (!result.success) throw new Error('Invalid OPFIELD_DEPLOYMENT_MODE');
  return result.data;
}

export function isDevelopment(): boolean {
  return getEnv().NODE_ENV === 'development';
}

export function isProduction(): boolean {
  return getEnv().NODE_ENV === 'production';
}

export function isTest(): boolean {
  return getEnv().NODE_ENV === 'test';
}
