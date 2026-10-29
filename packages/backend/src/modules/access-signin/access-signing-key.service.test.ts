import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemorySigningKeyStore, testCrypto } from './access-signin.test-support.js';
import {
  ACCESS_KEY_PUBLICATION_MS,
  ACCESS_KEY_ROTATION_MS,
  AccessSigningKeyService,
} from './access-signing-key.service.js';
import { ed25519PublicKeyFromRaw, signAccessToken, verifyAccessToken } from './access-token.js';

const DAY = 24 * 60 * 60 * 1000;
const unix = (date: Date) => Math.floor(date.getTime() / 1000);

describe('access token format', () => {
  it('is v1.<payload>.<signature> with an Ed25519 signature over "opfield-access-v1.<payload>"', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const token = signAccessToken(
      {
        kid: 'k1',
        sid: 's1',
        aud: 'app.example.com',
        iat: 1_700_000_000,
        exp: 1_700_003_600,
        idn: { m: 'idp:g1', sub: 'g-1', em: 'lena@acme.dev', grp: [] },
        non: 'nonce-1',
      },
      privateKey
    );
    const [version, payloadB64, signatureB64] = token.split('.');
    expect(version).toBe('v1');
    // Field order and the dropped empty grp as the daemon reads them.
    expect(Buffer.from(payloadB64, 'base64url').toString()).toBe(
      '{"kid":"k1","sid":"s1","aud":"app.example.com","iat":1700000000,"exp":1700003600,"idn":{"m":"idp:g1","sub":"g-1","em":"lena@acme.dev"},"non":"nonce-1"}'
    );
    expect(
      verify(
        null,
        Buffer.from(`opfield-access-v1.${payloadB64}`, 'ascii'),
        createPublicKey(publicKey.export({ format: 'pem', type: 'spki' })),
        Buffer.from(signatureB64, 'base64url')
      )
    ).toBe(true);

    const keys = new Map([['k1', publicKey]]);
    expect(verifyAccessToken(token, { keys, host: 'APP.example.com:443', now: 1_700_000_100 })?.sid).toBe('s1');
    expect(verifyAccessToken(token, { keys, host: 'other.example.com', now: 1_700_000_100 })).toBeNull();
    expect(verifyAccessToken(token, { keys, host: 'app.example.com', now: 1_700_003_600 })).toBeNull();
    expect(verifyAccessToken(token, { keys: new Map(), host: 'app.example.com', now: 1_700_000_100 })).toBeNull();
    const forged = `v1.${Buffer.from(Buffer.from(payloadB64, 'base64url').toString().replace('s1', 's2')).toString('base64url')}.${signatureB64}`;
    expect(verifyAccessToken(forged, { keys, host: 'app.example.com', now: 1_700_000_100 })).toBeNull();
  });
});

describe('access signing key rotation', () => {
  it('publishes a successor, lets it sign an hour later and retires the old key once its sessions ended', async () => {
    const store = new MemorySigningKeyStore();
    let now = new Date('2026-01-01T00:00:00Z');
    store.now = () => now;
    const keys = new AccessSigningKeyService(store, testCrypto, () => now);

    // First use creates the active key.
    const first = await keys.sign({
      sid: 's1',
      aud: 'a.example.com',
      iat: unix(now),
      exp: unix(now) + 3600,
      idn: { m: 'opfield', sub: 'u1' },
    });
    const [firstKey] = await keys.verificationKeys();
    expect(store.rows).toHaveLength(1);
    expect(await keys.rotateIfDue(new Date(now.getTime() + ACCESS_KEY_ROTATION_MS - 1000))).toBe(false);

    // Due: the successor is published, the old key still signs.
    now = new Date(now.getTime() + ACCESS_KEY_ROTATION_MS);
    expect(await keys.rotateIfDue(now)).toBe(true);
    expect((await keys.verificationKeys()).map((key) => key.keyId)).toHaveLength(2);
    const stillOld = await keys.sign({
      sid: 's2',
      aud: 'a.example.com',
      iat: unix(now),
      exp: unix(now) + 86_400,
      idn: { m: 'opfield', sub: 'u1' },
    });
    expect(JSON.parse(Buffer.from(stillOld.split('.')[1], 'base64url').toString()).kid).toBe(firstKey.keyId);
    expect(await keys.rotateIfDue(new Date(now.getTime() + ACCESS_KEY_PUBLICATION_MS - 1000))).toBe(false);

    // Published long enough: it takes over; the old key verifies until the last session ends, without its private key.
    now = new Date(now.getTime() + ACCESS_KEY_PUBLICATION_MS);
    store.latestSession = new Date(now.getTime() + 2 * DAY);
    expect(await keys.rotateIfDue(now)).toBe(true);
    const old = store.rows.find((row) => row.keyId === firstKey.keyId)!;
    expect(old.status).toBe('verification_only');
    expect(old.encryptedPrivateKey).toBeNull();
    expect(old.verifyUntil!.getTime()).toBe(store.latestSession.getTime() + 5 * 60 * 1000);
    const next = await keys.sign({
      sid: 's3',
      aud: 'a.example.com',
      iat: unix(now),
      exp: unix(now) + 60,
      idn: { m: 'opfield', sub: 'u1' },
    });
    expect(JSON.parse(Buffer.from(next.split('.')[1], 'base64url').toString()).kid).not.toBe(firstKey.keyId);
    expect(await keys.verify(stillOld, 'a.example.com', now)).not.toBeNull();
    expect(await keys.verify(next, 'a.example.com', now)).not.toBeNull();

    // Past its window: retired, gone from the published keys.
    now = new Date(old.verifyUntil!.getTime());
    expect(await keys.rotateIfDue(now)).toBe(true);
    expect(old.status).toBe('retired');
    const published = await keys.verificationKeys();
    expect(published.map((key) => key.keyId)).not.toContain(firstKey.keyId);
    expect(published).toHaveLength(1);
    expect(first).toMatch(/^v1\./);
    // The JWKS lists the remaining key as an OKP Ed25519 key.
    const jwks = await keys.jwks();
    expect(jwks.keys).toEqual([expect.objectContaining({ kty: 'OKP', crv: 'Ed25519', kid: published[0].keyId })]);
    expect(ed25519PublicKeyFromRaw(published[0].publicKey).asymmetricKeyType).toBe('ed25519');
  });
});
