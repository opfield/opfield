import { createHash, createPublicKey, type KeyObject, verify } from 'node:crypto';

/**
 * Update signing trust. A signed manifest verifies when a trusted key that is not revoked signed it. The keys sit in
 * slots: primary is the release signing key (config/update-trust/update-signing-public-key.pem); secondary is the
 * owner's standby key, kept offline and empty until it is added here, so that a lost or leaked primary can be retired
 * by a release signed with the standby key. Release signing is unchanged: the envelope's keyId names the update
 * trust, not one key of it.
 *
 * The same slots and revocation list are in the daemons (packages/daemons/shared/updateauth/trust.go) and in the node
 * installers (scripts/setup-*.sh, UPDATE_TRUST_* lines); docs/security.md describes a rotation.
 */

/**
 * The standby key: the base64 body of its PEM PUBLIC KEY block (one line, e.g.
 * `openssl pkey -pubin -in standby.pem -outform DER | base64 -w0`). Empty: no standby key yet.
 */
export const SECONDARY_UPDATE_SIGNING_PUBLIC_KEY = '';

/**
 * Keys that verify nothing any more, by key id (updateSigningKeyId): the SHA-256 of the key's SubjectPublicKeyInfo
 * DER in hex (`openssl pkey -pubin -in key.pem -outform DER | sha256sum`).
 */
export const REVOKED_UPDATE_SIGNING_KEY_IDS: readonly string[] = [];

export type SigningKey = string | Buffer | KeyObject;

/**
 * The id a revocation names a key by. The envelope's keyId is not used for it: whoever holds a key writes any keyId
 * into what it signs.
 */
export function updateSigningKeyId(key: SigningKey): string {
  const der = toPublicKey(key).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

/**
 * The trusted keys of the slots (a PEM block or its base64 body; empty: an unused slot), without the revoked ones. A
 * slot that does not parse fails the whole set: a broken trust anchor must not go unnoticed.
 */
export function trustedKeySet(slots: readonly string[], revoked: readonly string[]): KeyObject[] {
  const keys = slots
    .filter((slot) => slot.trim().length > 0)
    .map((slot, index) => {
      let key: KeyObject;
      try {
        key = slot.includes('-----BEGIN')
          ? createPublicKey(slot)
          : createPublicKey({ key: Buffer.from(slot.trim(), 'base64'), format: 'der', type: 'spki' });
      } catch {
        throw new Error(`Trusted update public key ${index + 1} does not parse`);
      }
      if (key.asymmetricKeyType !== 'ed25519') throw new Error(`Trusted update public key ${index + 1} is not Ed25519`);
      return key;
    });
  const trusted = withoutRevoked(keys, revoked);
  if (trusted.length === 0) throw new Error('No trusted update public key is left');
  return trusted;
}

/** Whether a key that is not revoked among keys signed payload. */
export function signedByTrustedKey(
  payload: Buffer,
  signature: Buffer,
  keys: SigningKey | readonly SigningKey[],
  revoked: readonly string[] = REVOKED_UPDATE_SIGNING_KEY_IDS
): boolean {
  const candidates = withoutRevoked((Array.isArray(keys) ? keys : [keys]) as SigningKey[], revoked);
  return candidates.some((key) => verify(null, payload, key, signature));
}

function withoutRevoked<T extends SigningKey>(keys: readonly T[], revoked: readonly string[]): T[] {
  if (revoked.length === 0) return [...keys];
  const ids = new Set(revoked.map((id) => id.trim().toLowerCase()));
  return keys.filter((key) => !ids.has(updateSigningKeyId(key)));
}

function toPublicKey(key: SigningKey): KeyObject {
  return typeof key === 'string' || Buffer.isBuffer(key) ? createPublicKey(key) : key;
}
