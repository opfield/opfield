import type { CredentialStore } from './credentials.js';
import { discoverInference, fetchSetupOAuthMetadata } from './discovery.js';
import { CliError } from './errors.js';
import type { Fetch } from './http.js';
import { refreshCredential } from './oauth.js';
import type { ProfileStore } from './profiles.js';
import { InferenceSetupClient } from './tokens.js';

export async function authenticatedSetupClient(
  profileName: string,
  profiles: ProfileStore,
  credentials: CredentialStore,
  fetcher?: Fetch
) {
  const profile = await profiles.getRequired(profileName);
  const discovery = await discoverInference(profile.origin, fetcher);
  const stored = await credentials.get(profileName);
  if (stored?.authMode === 'inference-token' || stored?.accessToken.startsWith('gwi_')) {
    return {
      client: new InferenceSetupClient(profile.origin, stored.accessToken, fetcher),
      credential: stored,
      discovery,
      profile,
    };
  }
  if (!profile.clientId) {
    throw new CliError('NOT_LOGGED_IN', 'Opfield connection is not logged in.', { exitCode: 2 });
  }
  const metadata = await fetchSetupOAuthMetadata(discovery, fetcher);
  const credential = await refreshCredential({
    profile: profileName,
    clientId: profile.clientId,
    resource: discovery.oauth.resource,
    tokenEndpoint: metadata.token_endpoint,
    credentials,
    fetch: fetcher,
    lockFile: profiles.credentialLockFile(profileName),
  });
  return {
    client: new InferenceSetupClient(profile.origin, credential.accessToken, fetcher),
    credential,
    discovery,
    metadata,
    profile,
  };
}
