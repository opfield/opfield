import { createPrivateKey, generateKeyPairSync, type KeyObject, randomBytes } from 'node:crypto';
import { createChildLogger } from '@/lib/logger.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { AccessSigningKeyRow, AccessSigningKeyStore } from './access-signing-key-store.js';
import {
  type AccessTokenPayload,
  ed25519PublicKeyFromRaw,
  signAccessToken,
  verifyAccessToken,
} from './access-token.js';

const logger = createChildLogger('AccessSigningKeys');

/** The active key signs this long before a successor replaces it. */
export const ACCESS_KEY_ROTATION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * A successor key is published (synced to every ingress node, listed in the JWKS) this long before it signs, so a
 * node that was briefly away already knows it when the first token it signed arrives.
 */
export const ACCESS_KEY_PUBLICATION_MS = 60 * 60 * 1000;
/** Clock skew between Opfield and the nodes that verify the tokens. */
const VERIFY_SKEW_MS = 5 * 60 * 1000;
const PUBLISHED_KEYS_CACHE_MS = 5 * 60 * 1000;

export interface AccessVerificationKeyView {
  keyId: string;
  /** Raw 32-byte Ed25519 public key. */
  publicKey: Buffer;
}

function isPending(key: AccessSigningKeyRow): boolean {
  return key.status === 'verification_only' && !key.activatedAt;
}

/**
 * Ed25519 keys that sign access tokens. An active key always exists (created on first need); every 30 days a
 * successor is published, then takes over signing an hour later. The replaced key keeps verifying until every session
 * that could hold a token it signed has expired, then it retires. Its private key is destroyed as soon as it stops
 * signing, so a retired or replaced key can never sign again. All of this runs from rotateIfDue while Opfield runs.
 */
export class AccessSigningKeyService {
  private readonly privateKeys = new Map<string, KeyObject>();
  /** The published keys and their KeyObjects, kept until the key set changes (rotation, first key). */
  private published: { views: AccessVerificationKeyView[]; map: Map<string, KeyObject>; at: number } | null = null;

  constructor(
    private readonly store: AccessSigningKeyStore,
    private readonly cryptoService: Pick<CryptoService, 'encryptPrivateKey' | 'decryptPrivateKey'>,
    private readonly clock: () => Date = () => new Date()
  ) {}

  /** The active key and every key that still verifies (a published successor included). */
  async verificationKeys(): Promise<AccessVerificationKeyView[]> {
    return (await this.publishedKeys()).views;
  }

  private async publishedKeys() {
    // Another Opfield process may rotate too: the cache also expires on its own.
    if (this.published && Date.now() - this.published.at < PUBLISHED_KEYS_CACHE_MS) return this.published;
    await this.ensureActiveKey();
    const keys = await this.store.listPublished();
    const views = keys
      .filter((key) => key.status === 'active' || key.status === 'verification_only')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((key) => ({ keyId: key.keyId, publicKey: Buffer.from(key.publicKey, 'base64') }));
    const map = new Map(views.map((key) => [key.keyId, ed25519PublicKeyFromRaw(key.publicKey)]));
    this.published = { views, map, at: Date.now() };
    return this.published;
  }

  /** The JSON Web Key Set of /.well-known/opfield-access/jwks. */
  async jwks(): Promise<{ keys: Array<Record<string, string>> }> {
    const keys = await this.verificationKeys();
    return {
      keys: keys.map((key) => ({
        kty: 'OKP',
        crv: 'Ed25519',
        x: key.publicKey.toString('base64url'),
        kid: key.keyId,
        use: 'sig',
        alg: 'EdDSA',
      })),
    };
  }

  /** Signs a token with the active key. */
  async sign(input: Omit<AccessTokenPayload, 'kid'>): Promise<string> {
    const active = await this.activeKey();
    return signAccessToken({ ...input, kid: active.keyId }, this.privateKeyOf(active));
  }

  /** The payload of a token one of the published keys signed for host, else null (see verifyAccessToken). */
  async verify(token: string, host: string, now = this.clock()): Promise<AccessTokenPayload | null> {
    const { map } = await this.publishedKeys();
    return verifyAccessToken(token, { keys: map, host, now: Math.floor(now.getTime() / 1000) });
  }

  async ensureActiveKey(): Promise<void> {
    const keys = await this.store.listPublished();
    if (keys.some((key) => key.status === 'active')) return;
    // A concurrent first use inserts the same way; the single-active index keeps one.
    await this.store.insertKey(this.newKey('active', this.clock()));
    this.published = null;
  }

  /**
   * One step of the rotation: publish a successor when the active key is due, let a successor published long enough
   * take over, retire replaced keys past their verification window. True when the published key set changed (the
   * caller syncs the access policy to the nodes).
   */
  async rotateIfDue(now = this.clock()): Promise<boolean> {
    let changed = false;
    const keys = await this.store.listPublished();
    const active = keys.find((key) => key.status === 'active');
    if (!active) {
      await this.store.insertKey(this.newKey('active', now));
      this.published = null;
      return true;
    }
    const pending = keys.find(isPending);
    if (!pending) {
      const activeSince = (active.activatedAt ?? active.createdAt).getTime();
      if (now.getTime() - activeSince >= ACCESS_KEY_ROTATION_MS) {
        changed = await this.store.insertKey(this.newKey('verification_only', null), { onlyWithoutPending: true });
        if (changed) logger.info('Published the next access signing key', { replaces: active.keyId });
      }
    } else if (now.getTime() - pending.createdAt.getTime() >= ACCESS_KEY_PUBLICATION_MS) {
      const verifyUntil = await this.replacedKeyVerifyUntil(now);
      if (await this.store.activatePending(pending.id, verifyUntil, now)) {
        this.privateKeys.delete(active.keyId);
        logger.info('Rotated the access signing key', { keyId: pending.keyId, verifyUntil });
        changed = true;
      }
    }
    const retired = await this.store.retireExpired(now);
    if (retired > 0) logger.info('Retired replaced access signing keys', { count: retired });
    if (changed || retired > 0) this.published = null;
    return changed || retired > 0;
  }

  /** The replaced key verifies every token it signed: none outlives its session. */
  private async replacedKeyVerifyUntil(now: Date): Promise<Date> {
    const latest = await this.store.latestSessionExpiry(now);
    const until = Math.max(now.getTime(), latest?.getTime() ?? 0) + VERIFY_SKEW_MS;
    return new Date(until);
  }

  private async activeKey(): Promise<AccessSigningKeyRow> {
    let active = (await this.store.listPublished()).find((key) => key.status === 'active');
    if (!active) {
      await this.ensureActiveKey();
      active = (await this.store.listPublished()).find((key) => key.status === 'active');
    }
    if (!active?.encryptedPrivateKey || !active.encryptedDek) {
      throw new Error('No access signing key can sign');
    }
    return active;
  }

  private privateKeyOf(key: AccessSigningKeyRow): KeyObject {
    const cached = this.privateKeys.get(key.keyId);
    if (cached) return cached;
    const pem = this.cryptoService.decryptPrivateKey({
      encryptedPrivateKey: key.encryptedPrivateKey!,
      encryptedDek: key.encryptedDek!,
      dekIv: '',
    });
    const privateKey = createPrivateKey(pem);
    this.privateKeys.set(key.keyId, privateKey);
    return privateKey;
  }

  private newKey(status: 'active' | 'verification_only', activatedAt: Date | null) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' });
    if (!jwk.x) throw new Error('Generated Ed25519 public key is missing x coordinate');
    const encrypted = this.cryptoService.encryptPrivateKey(
      privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    );
    return {
      keyId: randomBytes(12).toString('base64url'),
      publicKey: Buffer.from(jwk.x, 'base64url').toString('base64'),
      encryptedPrivateKey: encrypted.encryptedPrivateKey,
      encryptedDek: encrypted.encryptedDek,
      status,
      activatedAt,
    };
  }
}
