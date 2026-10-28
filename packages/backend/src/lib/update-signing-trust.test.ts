import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LEGACY_UPDATE_KEY_ID } from '@/lib/legacy-compat.js';
import {
  UPDATE_SIGNING_PUBLIC_KEY_PEM,
  UPDATE_SIGNING_TRUSTED_KEYS,
  UpdateArtifactTrustError,
  verifySignedPayload,
} from './update-artifact-trust.js';
import { signedByTrustedKey, trustedKeySet, updateSigningKeyId } from './update-signing-trust.js';

const primary = generateKeyPairSync('ed25519');
const standby = generateKeyPairSync('ed25519');
const primaryPem = primary.publicKey.export({ type: 'spki', format: 'pem' }) as string;
// The secondary slot holds one line: the base64 body of the PEM block.
const standbyLine = (standby.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
const payload = Buffer.from(JSON.stringify({ kind: 'daemon-binary' }));

function envelope(privateKey: typeof primary.privateKey): string {
  return JSON.stringify({
    schemaVersion: 1,
    keyId: LEGACY_UPDATE_KEY_ID,
    payload: payload.toString('base64url'),
    signature: sign(null, payload, privateKey).toString('base64url'),
  });
}

describe('update signing trust', () => {
  it('trusts the primary key while the secondary slot is empty', () => {
    const keys = trustedKeySet([primaryPem, ''], []);
    expect(keys).toHaveLength(1);
    expect(signedByTrustedKey(payload, sign(null, payload, primary.privateKey), keys, [])).toBe(true);
    expect(signedByTrustedKey(payload, sign(null, payload, standby.privateKey), keys, [])).toBe(false);
  });

  it('verifies a manifest signed by the standby key once it fills the secondary slot', () => {
    const keys = trustedKeySet([primaryPem, standbyLine], []);
    expect(verifySignedPayload(envelope(standby.privateKey), keys)).toEqual({ kind: 'daemon-binary' });
    expect(verifySignedPayload(envelope(primary.privateKey), keys)).toEqual({ kind: 'daemon-binary' });
  });

  it('refuses everything a revoked key signed, whatever keyId its envelope names', () => {
    const revoked = [updateSigningKeyId(primary.publicKey).toUpperCase()];
    const keys = trustedKeySet([primaryPem, standbyLine], revoked);
    expect(keys).toHaveLength(1);
    expect(signedByTrustedKey(payload, sign(null, payload, primary.privateKey), [primaryPem], revoked)).toBe(false);
    expect(() => verifySignedPayload(envelope(primary.privateKey), keys)).toThrow(UpdateArtifactTrustError);
    expect(verifySignedPayload(envelope(standby.privateKey), keys)).toEqual({ kind: 'daemon-binary' });
  });

  it('refuses a trust without a usable key or with a broken slot', () => {
    expect(() => trustedKeySet([primaryPem, ''], [updateSigningKeyId(primaryPem)])).toThrow(/No trusted update/);
    expect(() => trustedKeySet([primaryPem, 'not a key'], [])).toThrow(/does not parse/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
    expect(() => trustedKeySet([rsa as string], [])).toThrow(/not Ed25519/);
  });

  it('gives callers that name the release key the whole update trust', () => {
    expect(UPDATE_SIGNING_TRUSTED_KEYS.length).toBeGreaterThan(0);
    // A key outside the trust is refused through the release key's name as through the default.
    expect(() => verifySignedPayload(envelope(standby.privateKey), UPDATE_SIGNING_PUBLIC_KEY_PEM)).toThrow(
      'Update manifest signature is invalid'
    );
    expect(() => verifySignedPayload(envelope(standby.privateKey))).toThrow('Update manifest signature is invalid');
  });
});
