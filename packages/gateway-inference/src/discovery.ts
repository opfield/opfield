import { CliError } from './errors.js';
import { assertTrustedEndpoint, type Fetch, requestJson } from './http.js';
import type { InferenceDiscovery, OAuthMetadata } from './types.js';

export const CLI_VERSION = '0.3.13';

interface RawInferenceDiscovery {
  schemaVersion?: number;
  enabled?: boolean;
  minimumCliVersion?: string;
  oauth?: { resource?: string; authorizationServer?: string };
  adapters?: {
    openai?: { baseUrl?: string };
    anthropic?: { baseUrl?: string };
    // Schema v1 advertised this extra harness endpoint. The v0.3 companion
    // deliberately does not use it, but accepts the document while it rolls
    // out alongside v2 Gateways.
    codex?: { baseUrl?: string; catalogUrl?: string };
  };
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

export async function discoverInference(
  origin: string,
  fetcher?: Fetch,
  requireEnabled = true
): Promise<InferenceDiscovery> {
  const discovery = await requestJson<RawInferenceDiscovery>(
    new URL('/.well-known/wiolett-inference', origin).href,
    {},
    { fetch: fetcher }
  );
  if (
    (discovery.schemaVersion !== 1 && discovery.schemaVersion !== 2) ||
    !discovery.oauth?.resource ||
    !discovery.oauth.authorizationServer ||
    !discovery.adapters?.openai?.baseUrl ||
    !discovery.adapters.anthropic?.baseUrl ||
    !discovery.minimumCliVersion ||
    !validUrl(discovery.adapters.openai.baseUrl) ||
    !validUrl(discovery.adapters.anthropic.baseUrl)
  ) {
    throw new CliError('INCOMPATIBLE_GATEWAY', 'Opfield inference discovery uses an unsupported schema.');
  }
  const expectedOrigin = new URL(origin).origin;
  if (
    new URL(discovery.oauth.resource).origin !== expectedOrigin ||
    new URL(discovery.oauth.authorizationServer).origin !== expectedOrigin
  ) {
    throw new CliError('UNTRUSTED_OAUTH_ENDPOINT', 'Opfield discovery advertised OAuth URLs on another origin.');
  }
  assertTrustedEndpoint(discovery.adapters.openai.baseUrl, origin, 'OpenAI adapter endpoint');
  assertTrustedEndpoint(discovery.adapters.anthropic.baseUrl, origin, 'Anthropic adapter endpoint');
  if (requireEnabled && discovery.enabled === false)
    throw new CliError('INFERENCE_DISABLED', 'Inference is disabled on this Opfield installation.');
  if (compareVersions(CLI_VERSION, discovery.minimumCliVersion) < 0) {
    throw new CliError(
      'CLI_UPDATE_REQUIRED',
      `Opfield requires @sqgateway/inference ${discovery.minimumCliVersion} or newer (current ${CLI_VERSION}).`
    );
  }
  // Both schemas expose the standard OpenAI and Anthropic adapter URLs. Keep
  // the served version for diagnostics, while returning one internal shape so
  // setup never needs to select a legacy harness-specific route.
  return {
    schemaVersion: discovery.schemaVersion,
    ...(discovery.enabled === undefined ? {} : { enabled: discovery.enabled }),
    minimumCliVersion: discovery.minimumCliVersion,
    oauth: {
      resource: discovery.oauth.resource,
      authorizationServer: discovery.oauth.authorizationServer,
    },
    adapters: {
      openai: { baseUrl: discovery.adapters.openai.baseUrl },
      anthropic: { baseUrl: discovery.adapters.anthropic.baseUrl },
    },
  };
}

function validUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export async function fetchSetupOAuthMetadata(discovery: InferenceDiscovery, fetcher?: Fetch): Promise<OAuthMetadata> {
  const issuer = new URL(discovery.oauth.authorizationServer);
  const path = '/.well-known/oauth-authorization-server/api/inference/setup';
  const metadata = await requestJson<OAuthMetadata>(new URL(path, issuer).href, {}, { fetch: fetcher });
  if (
    new URL(metadata.issuer).href !== new URL(discovery.oauth.authorizationServer).href ||
    !metadata.authorization_endpoint ||
    !metadata.token_endpoint ||
    !metadata.registration_endpoint ||
    !metadata.revocation_endpoint ||
    !metadata.code_challenge_methods_supported?.includes('S256') ||
    !metadata.grant_types_supported?.includes('authorization_code') ||
    !metadata.grant_types_supported?.includes('refresh_token') ||
    !metadata.scopes_supported?.includes('inference:setup')
  ) {
    throw new CliError(
      'INCOMPATIBLE_OAUTH_SERVER',
      'Opfield does not advertise the required inference setup OAuth contract.'
    );
  }
  assertTrustedEndpoint(metadata.authorization_endpoint, discovery.oauth.authorizationServer, 'authorization endpoint');
  assertTrustedEndpoint(metadata.token_endpoint, discovery.oauth.authorizationServer, 'token endpoint');
  assertTrustedEndpoint(metadata.registration_endpoint, discovery.oauth.authorizationServer, 'registration endpoint');
  assertTrustedEndpoint(metadata.revocation_endpoint, discovery.oauth.authorizationServer, 'revocation endpoint');
  return metadata;
}
