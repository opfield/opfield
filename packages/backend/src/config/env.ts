import { z } from 'zod';
import {
  DEFAULT_CLOUD_PORTAL_URL,
  OFFICIAL_IMAGE_REPOSITORIES,
  OFFICIAL_INFERENCE_CORE_IMAGE_REPOSITORIES,
  UPDATES_BASE_URL,
} from './vendor-urls.js';

export const DEVELOPMENT_SECURE_LINK_CONNECTOR_IMAGE = 'gateway-secure-link-connector:dev';
export const BUILT_IN_GITHUB_OAUTH_CLIENT_ID = 'Ov23likbDL1gM8asWzfC';
const IMMUTABLE_CONNECTOR_IMAGE_PATTERN = /^.+@sha256:[0-9a-f]{64}$/i;
const OFFICIAL_CONNECTOR_RELEASE_TAG_PATTERN =
  /^ghcr\.io\/(?:opfield\/opfield|the-square-labs\/gateway)\/secure-link-connector:v[0-9]+\.[0-9]+\.[0-9]+(?:-rc\.[0-9]+)?-relay$/;
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
  GATEWAY_COMMERCIAL_DIR: z.string().min(1).default('/var/lib/gateway/commercial'),
  GATEWAY_DEPLOYMENT_MODE: deploymentModeSchema,
  BIND_HOST: z.string().default('0.0.0.0'),
  GATEWAY_LOCAL_HOSTS: z.string().optional(),
  WEB_TLS_BOOTSTRAP_MODE: z.enum(['http', 'https']).optional(),
  WEB_TLS_AUTO_DIR: nonEmptyStringWithDefault('/var/lib/gateway/tls'),
  PAGES_STORAGE_DIR: nonEmptyStringWithDefault('/var/lib/gateway/pages'),

  // Node-level transport for Docker Route Secure Links. Production accepts
  // either the digest-pinned release image or the official GHCR Relay release tag.
  SECURE_LINK_CONNECTOR_IMAGE: z.string().trim().default(''),

  // Compose project dir (for self-update sidecar)
  COMPOSE_PROJECT_DIR: z.string().optional(),

  // Updates
  RELEASES_API_URL: z.string().url().default(`${UPDATES_BASE_URL}/releases`),
  ARTIFACT_BASE_URL: z.string().url().default(UPDATES_BASE_URL),
  // Signed update images are accepted from the installation's own repository and these (comma-separated).
  GATEWAY_UPDATE_IMAGE_REPOSITORIES: z.string().default(OFFICIAL_IMAGE_REPOSITORIES.join(',')),
  INFERENCE_CORE_UPDATE_IMAGE_REPOSITORIES: z.string().default(OFFICIAL_INFERENCE_CORE_IMAGE_REPOSITORIES.join(',')),
  UPDATE_CHECK_INTERVAL_HOURS: z.coerce.number().default(4),

  // Cloud account portal that a connected installation enrols with and keeps its cloud link socket to.
  CLOUD_PORTAL_URL: z.string().url().default(DEFAULT_CLOUD_PORTAL_URL),

  // Managed inference core. The distribution image repository is derived from
  // the Gateway's own image; the override exists for development/lab installs
  // where the Gateway image is a local build without the production repo name.
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
  GRPC_TLS_AUTO_DIR: nonEmptyStringWithDefault('/var/lib/gateway/tls'),
  GATEWAY_RELAY_IDENTITY_DIR: nonEmptyStringWithDefault('/var/lib/gateway-relay'),
  GATEWAY_RELAY_TARGET: nonEmptyStringWithDefault('relay:9443'),
  GATEWAY_RELAY_REQUIRED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  GATEWAY_RELAY_MANAGED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  GATEWAY_RELAY_IMAGE_REF: optionalNonEmptyString,
  GATEWAY_RELAY_SERVICE_NAME: nonEmptyStringWithDefault('relay'),
  GATEWAY_RELAY_BUILD_VERSION: optionalNonEmptyString,
  GATEWAY_RELAY_PROTOCOL_MAJOR: z.coerce.number().int().positive().default(1),

  BACKUP_RUNNER_IMAGE: optionalNonEmptyString,

  // AI sandbox artifacts
  AI_SANDBOX_ARTIFACT_DIR: nonEmptyStringWithDefault('/var/lib/gateway/ai-artifacts'),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

export function getEnv(): Env {
  if (cachedEnv) {
    return cachedEnv;
  }

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

export function getDeploymentMode(): Env['GATEWAY_DEPLOYMENT_MODE'] {
  const result = deploymentModeSchema.safeParse(process.env.GATEWAY_DEPLOYMENT_MODE);
  if (!result.success) throw new Error('Invalid GATEWAY_DEPLOYMENT_MODE');
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
