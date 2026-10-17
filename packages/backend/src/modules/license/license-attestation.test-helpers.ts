import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import type { LicenseServerState } from './license.types.js';
import {
  LICENSE_ATTESTATION_KIND,
  type LicenseAttestation,
  type LicenseAttestationPurpose,
  LicenseAttestationVerifier,
} from './license-attestation.js';
import { LEGACY_LICENSE_STATE_DOMAIN } from '@/lib/legacy-compat.js';

export const TEST_INSTALLATION_ID = '11111111-1111-4111-8111-111111111111';

const MESSAGE_PREFIX = Buffer.from(`${LEGACY_LICENSE_STATE_DOMAIN}\n`, 'utf8');

export interface TestLicenseSigner {
  keyId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export function createTestLicenseSigner(keyId = 'gls-test'): TestLicenseSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { keyId, privateKey, publicKey };
}

export function createTestLicenseVerifier(...signers: TestLicenseSigner[]): LicenseAttestationVerifier {
  return new LicenseAttestationVerifier(Object.fromEntries(signers.map((signer) => [signer.keyId, signer.publicKey])));
}

/** Signs a state exactly as the license server does. */
export function signTestLicenseState(
  signer: TestLicenseSigner,
  state: LicenseServerState,
  binding: {
    installationId?: string;
    purpose: LicenseAttestationPurpose;
    requestNonce: string;
    issuedAt?: string;
    kind?: string;
  }
): LicenseAttestation {
  const { attestation: _unsigned, ...unsigned } = state;
  const issuedAt = binding.issuedAt ?? unsigned.serverTime;
  const payload = Buffer.from(
    JSON.stringify({
      kind: binding.kind ?? LICENSE_ATTESTATION_KIND,
      installationId: binding.installationId ?? TEST_INSTALLATION_ID,
      purpose: binding.purpose,
      requestNonce: binding.requestNonce,
      issuedAt,
      state: { ...unsigned, serverTime: issuedAt },
    }),
    'utf8'
  );
  return {
    schemaVersion: 1,
    keyId: signer.keyId,
    algorithm: 'Ed25519',
    payload: payload.toString('base64url'),
    signature: sign(null, Buffer.concat([MESSAGE_PREFIX, payload]), signer.privateKey).toString('base64url'),
  };
}

const PURPOSES: Record<string, LicenseAttestationPurpose> = {
  '/api/v1/installations/register': 'register',
  '/api/v1/installations/heartbeat': 'heartbeat',
  '/api/v1/licenses/activate': 'activate',
  '/api/v1/licenses/deactivate': 'deactivate',
  '/api/v1/releases/authorize': 'release-authorize',
};

type MockResponse = { ok: boolean; status: number; json(): Promise<unknown> };

/**
 * Wraps a mocked license server so every successful state response is signed for the
 * request that asked for it, like a current license server. Error responses and the
 * private-core file stream pass through unchanged.
 */
export function signedLicenseServer(
  fetcher: (url: string, init: RequestInit) => unknown,
  signer: TestLicenseSigner,
  installationId = TEST_INSTALLATION_ID
) {
  return async (url: string, init: RequestInit) => {
    const response = (await fetcher(url, init)) as MockResponse | Response | undefined;
    const purpose = PURPOSES[new URL(url).pathname];
    if (!purpose || !response?.ok || response instanceof Response) return response;
    const body = JSON.parse(String(init.body)) as { requestNonce: string; installationId?: string };
    const envelope = (await response.json()) as { data: Record<string, unknown> };
    const holder = (purpose === 'register' || purpose === 'release-authorize' ? envelope.data.state : envelope.data) as
      | LicenseServerState
      | undefined;
    if (holder && typeof holder === 'object') {
      const issuedAt = new Date().toISOString();
      holder.serverTime = issuedAt;
      holder.attestation = signTestLicenseState(signer, holder, {
        installationId: body.installationId ?? installationId,
        purpose,
        requestNonce: body.requestNonce,
        issuedAt,
      });
    }
    return { ok: response.ok, status: response.status, json: () => Promise.resolve(envelope) };
  };
}
