import { and, eq, gt, isNotNull, isNull, lte, max, ne, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { accessSessions, accessSigningKeys } from '@/db/schema/index.js';

const ROTATION_LOCK = 'opfield:access-signing-key-rotation';

export type AccessSigningKeyRow = typeof accessSigningKeys.$inferSelect;

export interface NewAccessSigningKey {
  keyId: string;
  publicKey: string;
  encryptedPrivateKey: string;
  encryptedDek: string;
  status: 'active' | 'verification_only';
  activatedAt: Date | null;
}

/** The access_signing_keys operations the key service needs; each one is atomic. */
export interface AccessSigningKeyStore {
  /** Every key that is not retired. */
  listPublished(): Promise<AccessSigningKeyRow[]>;
  /** False when the insert conflicts (another active key, or a pending key already exists). */
  insertKey(key: NewAccessSigningKey, options?: { onlyWithoutPending?: boolean }): Promise<boolean>;
  /**
   * The pending key signs from now on: the active key turns verification_only until verifyUntil and its private key
   * is destroyed (it never signs again). False when the pending key is gone.
   */
  activatePending(pendingId: string, verifyUntil: Date, now: Date): Promise<boolean>;
  /** Retires replaced keys whose verifyUntil passed; returns how many. */
  retireExpired(now: Date): Promise<number>;
  /** The latest expiry of a session that can still present a token, or null. */
  latestSessionExpiry(now: Date): Promise<Date | null>;
}

export class DrizzleAccessSigningKeyStore implements AccessSigningKeyStore {
  constructor(private readonly db: DrizzleClient) {}

  listPublished(): Promise<AccessSigningKeyRow[]> {
    return this.db.select().from(accessSigningKeys).where(ne(accessSigningKeys.status, 'retired'));
  }

  async insertKey(key: NewAccessSigningKey, options: { onlyWithoutPending?: boolean } = {}): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ROTATION_LOCK}))`);
      if (options.onlyWithoutPending) {
        const [pending] = await tx
          .select({ id: accessSigningKeys.id })
          .from(accessSigningKeys)
          .where(and(eq(accessSigningKeys.status, 'verification_only'), isNull(accessSigningKeys.activatedAt)))
          .limit(1);
        if (pending) return false;
      }
      const inserted = await tx
        .insert(accessSigningKeys)
        .values(key)
        .onConflictDoNothing()
        .returning({ id: accessSigningKeys.id });
      return inserted.length > 0;
    });
  }

  async activatePending(pendingId: string, verifyUntil: Date, now: Date): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ROTATION_LOCK}))`);
      const [pending] = await tx
        .select({ id: accessSigningKeys.id })
        .from(accessSigningKeys)
        .where(
          and(
            eq(accessSigningKeys.id, pendingId),
            eq(accessSigningKeys.status, 'verification_only'),
            isNull(accessSigningKeys.activatedAt)
          )
        )
        .limit(1);
      if (!pending) return false;
      await tx
        .update(accessSigningKeys)
        .set({ status: 'verification_only', verifyUntil, encryptedPrivateKey: null, encryptedDek: null })
        .where(eq(accessSigningKeys.status, 'active'));
      await tx
        .update(accessSigningKeys)
        .set({ status: 'active', activatedAt: now })
        .where(eq(accessSigningKeys.id, pendingId));
      return true;
    });
  }

  async retireExpired(now: Date): Promise<number> {
    const retired = await this.db
      .update(accessSigningKeys)
      .set({ status: 'retired', retiredAt: now, encryptedPrivateKey: null, encryptedDek: null })
      .where(
        and(
          eq(accessSigningKeys.status, 'verification_only'),
          isNotNull(accessSigningKeys.verifyUntil),
          lte(accessSigningKeys.verifyUntil, now)
        )
      )
      .returning({ id: accessSigningKeys.id });
    return retired.length;
  }

  async latestSessionExpiry(now: Date): Promise<Date | null> {
    const [row] = await this.db
      .select({ latest: max(accessSessions.expiresAt) })
      .from(accessSessions)
      .where(and(gt(accessSessions.expiresAt, now), isNull(accessSessions.revokedAt)));
    return row?.latest ? new Date(row.latest) : null;
  }
}
