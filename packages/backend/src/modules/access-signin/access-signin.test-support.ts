import { randomUUID } from 'node:crypto';
import { CryptoService } from '@/services/crypto.service.js';
import type { AccessSessionRow, AccessSessionStore, NewAccessSession } from './access-sessions.service.js';
import type { AccessSigningKeyRow, AccessSigningKeyStore, NewAccessSigningKey } from './access-signing-key-store.js';

// In-memory stores with the semantics of the Drizzle ones, for tests of the sign-in services.

export const testCrypto = new CryptoService('ab'.repeat(32));

export class MemorySigningKeyStore implements AccessSigningKeyStore {
  readonly rows: AccessSigningKeyRow[] = [];
  latestSession: Date | null = null;
  now = () => new Date();

  async listPublished() {
    return this.rows.filter((row) => row.status !== 'retired').map((row) => ({ ...row }));
  }

  async insertKey(key: NewAccessSigningKey, options: { onlyWithoutPending?: boolean } = {}) {
    if (key.status === 'active' && this.rows.some((row) => row.status === 'active')) return false;
    const pending = this.rows.some((row) => row.status === 'verification_only' && !row.activatedAt);
    if (options.onlyWithoutPending && pending) return false;
    this.rows.push({
      id: randomUUID(),
      ...key,
      createdAt: this.now(),
      verifyUntil: null,
      retiredAt: null,
    });
    return true;
  }

  async activatePending(pendingId: string, verifyUntil: Date, now: Date) {
    const pending = this.rows.find(
      (row) => row.id === pendingId && row.status === 'verification_only' && !row.activatedAt
    );
    if (!pending) return false;
    for (const row of this.rows.filter((candidate) => candidate.status === 'active')) {
      Object.assign(row, { status: 'verification_only', verifyUntil, encryptedPrivateKey: null, encryptedDek: null });
    }
    Object.assign(pending, { status: 'active', activatedAt: now });
    return true;
  }

  async retireExpired(now: Date) {
    const expired = this.rows.filter(
      (row) => row.status === 'verification_only' && row.verifyUntil && row.verifyUntil <= now
    );
    for (const row of expired) {
      Object.assign(row, { status: 'retired', retiredAt: now, encryptedPrivateKey: null, encryptedDek: null });
    }
    return expired.length;
  }

  async latestSessionExpiry() {
    return this.latestSession;
  }
}

export class MemorySessionStore implements AccessSessionStore {
  readonly rows = new Map<string, AccessSessionRow>();

  async create(session: NewAccessSession) {
    const now = new Date();
    const row: AccessSessionRow = { id: randomUUID(), ...session, createdAt: now, lastSeenAt: now, revokedAt: null };
    this.rows.set(row.id, row);
    return { ...row };
  }

  async get(id: string) {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async touch(id: string, now: Date) {
    const row = this.rows.get(id);
    if (row) row.lastSeenAt = now;
  }

  async revoke(id: string, now: Date) {
    const row = this.rows.get(id);
    if (!row || row.revokedAt) return false;
    row.revokedAt = now;
    return true;
  }
}
