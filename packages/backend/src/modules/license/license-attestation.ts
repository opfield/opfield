import { createPublicKey, type KeyObject, randomBytes, verify } from 'node:crypto';
import type { LicenseServerState } from './license.types.js';
import { LEGACY_LICENSE_STATE_DOMAIN, LEGACY_LICENSE_STATE_DOMAIN_SHORT } from '@/lib/legacy-compat.js';

/**
 * Ed25519 keys that sign license states, pinned per release by key ID. To rotate,
 * ship a release that pins the next key first; the license server keeps signing
 * with a key an installation lists in `attestationKeyIds` until it has updated.
 */
export const LICENSE_SIGNING_PUBLIC_KEYS: Readonly<Record<string, string>> = {
  'gls-2026-09': 'MCowBQYDK2VwAyEAZX35QFLWBje3DAcauLqCM7iie8fGYcheVEVKMO+TuQM=',
};

export const LICENSE_ATTESTATION_KIND = LEGACY_LICENSE_STATE_DOMAIN_SHORT;
/** A fresh response must be issued within this window of the local clock. */
export const LICENSE_ATTESTATION_MAX_CLOCK_SKEW_MS = 15 * 60 * 1000;

const SCHEMA_VERSION = 1;
const ALGORITHM = 'Ed25519';
const MESSAGE_PREFIX = Buffer.from(`${LEGACY_LICENSE_STATE_DOMAIN}\n`, 'utf8');
const MAX_ATTESTATION_BYTES = 256 * 1024;

export type LicenseAttestationPurpose = 'register' | 'heartbeat' | 'activate' | 'deactivate' | 'release-authorize';

export interface LicenseAttestation {
  schemaVersion: number;
  keyId: string;
  algorithm: string;
  payload: string;
  signature: string;
}

export interface LicenseAttestationPayload {
  kind: typeof LICENSE_ATTESTATION_KIND;
  installationId: string;
  purpose: LicenseAttestationPurpose;
  requestNonce: string;
  issuedAt: string;
  state: LicenseServerState;
}

/** A license state whose signature, installation, and request binding were verified. */
export interface SignedLicenseState {
  state: LicenseServerState;
  attestation: LicenseAttestation;
  issuedAt: string;
}

export interface LicenseRequestBinding {
  purpose: LicenseAttestationPurpose;
  requestNonce: string;
}

export class LicenseAttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LicenseAttestationError';
  }
}

export function createLicenseRequestNonce(): string {
  return randomBytes(24).toString('base64url');
}

export class LicenseAttestationVerifier {
  private readonly keys = new Map<string, KeyObject>();
  private readonly verified = new Map<string, LicenseAttestationPayload>();

  constructor(publicKeys: Readonly<Record<string, string | KeyObject>> = LICENSE_SIGNING_PUBLIC_KEYS) {
    for (const [keyId, key] of Object.entries(publicKeys)) {
      const publicKey =
        typeof key === 'string'
          ? createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' })
          : key;
      if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error(`License signing key ${keyId} is not Ed25519`);
      this.keys.set(keyId, publicKey);
    }
  }

  get keyIds(): string[] {
    return [...this.keys.keys()];
  }

  /** Checks a fresh response: signature, installation, purpose, echoed nonce, and issue time. */
  verifyResponse(
    value: unknown,
    installationId: string,
    binding: LicenseRequestBinding,
    now = Date.now()
  ): LicenseAttestationPayload {
    const payload = this.verifyStored(value, installationId);
    if (payload.purpose !== binding.purpose)
      throw new LicenseAttestationError('License state was signed for another request');
    // LICENSE ENFORCEMENT: A replayed signature carries another request's nonce.
    if (!binding.requestNonce || payload.requestNonce !== binding.requestNonce) {
      throw new LicenseAttestationError('License state was signed for another request');
    }
    if (Math.abs(now - Date.parse(payload.issuedAt)) > LICENSE_ATTESTATION_MAX_CLOCK_SKEW_MS) {
      throw new LicenseAttestationError('License state is stale or the local clock is wrong');
    }
    return payload;
  }

  /** Checks a stored state: signature and installation only, because its request is long gone. */
  verifyStored(value: unknown, installationId: string): LicenseAttestationPayload {
    const attestation = this.parseEnvelope(value);
    const cacheKey = `${attestation.keyId}:${attestation.signature}:${attestation.payload}`;
    let payload = this.verified.get(cacheKey);
    if (!payload) {
      payload = this.verifySignature(attestation);
      if (this.verified.size >= 16) this.verified.clear();
      this.verified.set(cacheKey, payload);
    }
    // LICENSE ENFORCEMENT: A state signed for another installation never applies here.
    if (payload.installationId !== installationId) {
      throw new LicenseAttestationError('License state was signed for another installation');
    }
    return payload;
  }

  private parseEnvelope(value: unknown): LicenseAttestation {
    if (!value || typeof value !== 'object') throw new LicenseAttestationError('License state is not signed');
    const attestation = value as Partial<LicenseAttestation>;
    if (
      attestation.schemaVersion !== SCHEMA_VERSION ||
      attestation.algorithm !== ALGORITHM ||
      typeof attestation.keyId !== 'string' ||
      typeof attestation.payload !== 'string' ||
      typeof attestation.signature !== 'string' ||
      attestation.payload.length > MAX_ATTESTATION_BYTES
    ) {
      throw new LicenseAttestationError('License state signature format is unsupported');
    }
    return attestation as LicenseAttestation;
  }

  private verifySignature(attestation: LicenseAttestation): LicenseAttestationPayload {
    const key = this.keys.get(attestation.keyId);
    if (!key) throw new LicenseAttestationError('License state is signed with an unknown key');
    const payloadBytes = Buffer.from(attestation.payload, 'base64url');
    const signature = Buffer.from(attestation.signature, 'base64url');
    if (
      payloadBytes.toString('base64url') !== attestation.payload ||
      !verify(null, Buffer.concat([MESSAGE_PREFIX, payloadBytes]), key, signature)
    ) {
      throw new LicenseAttestationError('License state signature is invalid');
    }
    let payload: Partial<LicenseAttestationPayload>;
    try {
      payload = JSON.parse(payloadBytes.toString('utf8')) as Partial<LicenseAttestationPayload>;
    } catch {
      throw new LicenseAttestationError('License state payload is invalid');
    }
    if (
      payload.kind !== LICENSE_ATTESTATION_KIND ||
      typeof payload.installationId !== 'string' ||
      typeof payload.purpose !== 'string' ||
      typeof payload.requestNonce !== 'string' ||
      typeof payload.issuedAt !== 'string' ||
      !Number.isFinite(Date.parse(payload.issuedAt)) ||
      !payload.state ||
      typeof payload.state !== 'object'
    ) {
      throw new LicenseAttestationError('License state payload is invalid');
    }
    return payload as LicenseAttestationPayload;
  }
}
