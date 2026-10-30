import { and, count, desc, eq, gt, ilike, inArray, isNull, lt, or, type SQL } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { accessLists, accessSessions } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { scheduleAccessPolicySync } from './access-policy-sync.js';
import type { AccessSessionListQuery } from './access-signin.schemas.js';
import type { AccessSignInDirectory, OpfieldAccessUser } from './access-signin-directory.js';
import type { AccessTokenIdentity } from './access-token.js';

export type AccessSessionRow = typeof accessSessions.$inferSelect;

export interface NewAccessSession {
  method: string;
  subject: string;
  email: string | null;
  name: string | null;
  groups: string[];
  accessListId: string | null;
  clientIp: string | null;
  userAgent: string | null;
  expiresAt: Date;
}

/** The access_sessions operations the sign-in flow needs. */
export interface AccessSessionStore {
  create(session: NewAccessSession): Promise<AccessSessionRow>;
  get(id: string): Promise<AccessSessionRow | null>;
  touch(id: string, now: Date): Promise<void>;
  /** False when the session was already revoked or does not exist. */
  revoke(id: string, now: Date): Promise<boolean>;
}

/** Expired sessions stay listed (as ended) this long before the cleanup deletes them. */
const ENDED_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** lastSeenAt is written at most this often per session. */
const TOUCH_INTERVAL_MS = 60_000;

export class DrizzleAccessSessionStore implements AccessSessionStore {
  private readonly touched = new Map<string, number>();

  constructor(private readonly db: DrizzleClient) {}

  async create(session: NewAccessSession): Promise<AccessSessionRow> {
    const [row] = await this.db.insert(accessSessions).values(session).returning();
    return row;
  }

  async get(id: string): Promise<AccessSessionRow | null> {
    const [row] = await this.db.select().from(accessSessions).where(eq(accessSessions.id, id)).limit(1);
    return row ?? null;
  }

  async touch(id: string, now: Date): Promise<void> {
    const last = this.touched.get(id) ?? 0;
    if (now.getTime() - last < TOUCH_INTERVAL_MS) return;
    this.touched.set(id, now.getTime());
    if (this.touched.size > 10_000) this.touched.clear();
    await this.db.update(accessSessions).set({ lastSeenAt: now }).where(eq(accessSessions.id, id));
  }

  async revoke(id: string, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(accessSessions)
      .set({ revokedAt: now })
      .where(and(eq(accessSessions.id, id), isNull(accessSessions.revokedAt)))
      .returning({ id: accessSessions.id });
    return rows.length > 0;
  }
}

/** A session that can still present tokens. */
export function isLiveSession(session: AccessSessionRow | null, now: Date): session is AccessSessionRow {
  return !!session && !session.revokedAt && session.expiresAt.getTime() > now.getTime();
}

/** The identity a session's tokens carry (`idn`). */
export function sessionIdentity(session: AccessSessionRow): AccessTokenIdentity {
  const identity: AccessTokenIdentity = { m: session.method, sub: session.subject };
  if (session.email) identity.em = session.email;
  if (session.name) identity.nm = session.name;
  if (session.groups?.length) identity.grp = [...session.groups];
  if (session.accessListId) identity.lst = session.accessListId;
  return identity;
}

/** Whether an Opfield account session still carries the account's current email and groups. */
export function opfieldSessionMatches(
  session: Pick<AccessSessionRow, 'email' | 'groups'>,
  user: Pick<OpfieldAccessUser, 'email' | 'groups'> | null
): boolean {
  if (!user) return false;
  if ((session.email ?? '') !== user.email) return false;
  const current = new Set(user.groups);
  const held = new Set(session.groups ?? []);
  return held.size === current.size && [...held].every((group) => current.has(group));
}

export type AccessSessionStatus = 'active' | 'expired' | 'revoked';

function sessionStatus(session: Pick<AccessSessionRow, 'revokedAt' | 'expiresAt'>, now: Date): AccessSessionStatus {
  if (session.revokedAt) return 'revoked';
  return session.expiresAt.getTime() > now.getTime() ? 'active' : 'expired';
}

/** Visitors signed in on protected routes: listing, revoking and the expiry cleanup. */
export class AccessSessionService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly store: AccessSessionStore,
    private readonly auditService?: Pick<AuditService, 'log'>
  ) {}

  async list(query: AccessSessionListQuery) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const now = new Date();
    const filters: SQL[] = [];
    if (!query.includeEnded) filters.push(isNull(accessSessions.revokedAt), gt(accessSessions.expiresAt, now));
    if (query.accessListId) filters.push(eq(accessSessions.accessListId, query.accessListId));
    if (query.search) {
      const pattern = `%${query.search.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
      const match = or(
        ilike(accessSessions.email, pattern),
        ilike(accessSessions.name, pattern),
        ilike(accessSessions.subject, pattern)
      );
      if (match) filters.push(match);
    }
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select({ session: accessSessions, accessListName: accessLists.name })
        .from(accessSessions)
        .leftJoin(accessLists, eq(accessLists.id, accessSessions.accessListId))
        .where(where)
        .orderBy(desc(accessSessions.lastSeenAt))
        .limit(limit)
        .offset((page - 1) * limit),
      this.db.select({ total: count() }).from(accessSessions).where(where),
    ]);
    const totalCount = Number(total);
    return {
      data: rows.map(({ session, accessListName }) => ({
        id: session.id,
        method: session.method,
        subject: session.subject,
        email: session.email,
        name: session.name,
        groups: session.groups,
        accessListId: session.accessListId,
        accessListName: accessListName ?? null,
        clientIp: session.clientIp,
        userAgent: session.userAgent,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        revokedAt: session.revokedAt,
        status: sessionStatus(session, now),
      })),
      pagination: { page, limit, total: totalCount, totalPages: Math.ceil(totalCount / limit) },
    };
  }

  /** Revokes a session: every token it issued stops working on every ingress node after the next sync. */
  async revoke(id: string, userId: string | null): Promise<void> {
    const session = await this.store.get(id);
    if (!session) throw new AppError(404, 'ACCESS_SESSION_NOT_FOUND', 'Access session not found');
    const revoked = await this.store.revoke(id, new Date());
    if (!revoked) return;
    scheduleAccessPolicySync();
    await this.auditService?.log({
      userId,
      action: 'access_session.revoke',
      resourceType: 'access_session',
      resourceId: id,
      details: { method: session.method, email: session.email, subject: session.subject },
    });
  }

  /**
   * Revokes the live sessions of an Opfield account whose tokens no longer describe it: the account is blocked or
   * deleted, or its email or permission groups changed (rules may match them). Returns how many.
   */
  async revokeChangedOpfieldSessions(
    userId: string,
    directory: Pick<AccessSignInDirectory, 'getOpfieldUser'>
  ): Promise<number> {
    const now = new Date();
    const live = await this.db
      .select({ id: accessSessions.id, email: accessSessions.email, groups: accessSessions.groups })
      .from(accessSessions)
      .where(
        and(
          eq(accessSessions.method, 'opfield'),
          eq(accessSessions.subject, userId),
          isNull(accessSessions.revokedAt),
          gt(accessSessions.expiresAt, now)
        )
      );
    if (live.length === 0) return 0;
    const user = await directory.getOpfieldUser(userId);
    const stale = live.filter((session) => !opfieldSessionMatches(session, user));
    if (stale.length === 0) return 0;
    const revoked = await this.db
      .update(accessSessions)
      .set({ revokedAt: now })
      .where(
        and(
          inArray(
            accessSessions.id,
            stale.map((session) => session.id)
          ),
          isNull(accessSessions.revokedAt)
        )
      )
      .returning({ id: accessSessions.id });
    return revoked.length;
  }

  /** Deletes sessions that ended more than a week ago; revoked ones leave the synced policy once expired. */
  async cleanup(now = new Date()): Promise<number> {
    const before = new Date(now.getTime() - ENDED_SESSION_RETENTION_MS);
    const deleted = await this.db
      .delete(accessSessions)
      .where(lt(accessSessions.expiresAt, before))
      .returning({ id: accessSessions.id });
    return deleted.length;
  }
}
