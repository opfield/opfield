import { eq, like } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/index.js';
import { type LeaseTakeoverSource, leaseExactHolderSince } from './lease-planning.js';
import type { LeaseHolderChangeNotice, LeaseTakeoverSighting } from './lease-reports.js';

/** How long a takeover time from voter sightings waits for the holder's own time or an earlier sighting. */
export const LEASE_TAKEOVER_SETTLE_MS = 60_000;
/**
 * How long a takeover nobody reported a time for waits for the holder's own report: after Opfield comes back the
 * nodes reconnect only after their backoff, well after the relays.
 */
export const LEASE_TAKEOVER_UNKNOWN_SETTLE_MS = 5 * 60_000;
/** Settings rows `availability.lease.takeover:<policy>/<slot>/<holder>/<round>` hold the audits still waiting. */
export const LEASE_TAKEOVER_SETTING_PREFIX = 'availability.lease.takeover:';

export interface SettledLeaseTakeover {
  /** Stable id of the holder change, also in the audit details: a replay after a crash finds the written row. */
  takeoverId: string;
  notice: LeaseHolderChangeNotice;
  takeoverAt: Date;
  source: LeaseTakeoverSource;
  noticedAt: Date;
}

export interface PendingLeaseTakeover {
  id: string;
  notice: LeaseHolderChangeNotice;
  noticedAt: Date;
  /** The holder's own acquisition time once it reported it: final. */
  exact: Date | null;
  /** The earliest voter sighting of the takeover so far; null while nobody reported one. */
  best: Date | null;
  /** The holder itself reported without a time: waiting for it gains nothing, only for voters. */
  holderReported: boolean;
}

type Writer = Pick<DrizzleClient, 'insert'>;

export function leaseTakeoverId(notice: Pick<LeaseHolderChangeNotice, 'policyId' | 'slot' | 'to' | 'ballot'>): string {
  return `${notice.policyId}/${notice.slot}/${notice.to}/${notice.ballot?.incarnation ?? '0'}.${notice.ballot?.round ?? '0'}`;
}

/** The waiting audit of an audited holder change (failover or handoff) as it is noticed. */
export function pendingLeaseTakeover(notice: LeaseHolderChangeNotice): PendingLeaseTakeover {
  return {
    id: leaseTakeoverId(notice),
    notice,
    noticedAt: notice.noticedAt ?? new Date(),
    exact: notice.takeoverSource === 'holder' ? (notice.holderSince ?? null) : null,
    best: notice.takeoverSource === 'voters' ? (notice.holderSince ?? null) : null,
    holderReported: notice.source === 'daemon' && notice.sourceId === notice.to,
  };
}

/**
 * Stores the waiting audit in the transaction that records the holder change: a crash before it is written to the
 * audit log leaves it here for the next start (B-14).
 */
export async function persistPendingLeaseTakeover(writer: Writer, pending: PendingLeaseTakeover): Promise<void> {
  const value = encode(pending);
  await writer
    .insert(settings)
    .values({ key: `${LEASE_TAKEOVER_SETTING_PREFIX}${pending.id}`, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

export interface LeaseTakeoverAuditPorts {
  /** Writes the audit row; false when it failed (the entry stays waiting and is retried). */
  write(settled: SettledLeaseTakeover): Promise<boolean>;
  /** Whether an audit row for this change exists already (a crash between writing it and clearing the entry). */
  written(settled: SettledLeaseTakeover): Promise<boolean>;
  /** A better takeover time for the key's current holder. */
  correct(policyId: string, slot: number, holderId: string, since: Date): Promise<void>;
}

/**
 * B-14: the audit of a lease holder change carries the takeover time, whichever member reports it first, and is never
 * lost. The holder's own acquisition time is exact and audited at once. A voter's sighting is only an upper bound: a
 * voter that was down or cut off during the takeover sees it late (stand run rc20 c: the local relay, restarted with
 * Opfield, reported the takeover 86 s late). Such a change waits until the holder reports its time, taking the
 * earliest sighting meanwhile, for LEASE_TAKEOVER_SETTLE_MS, or LEASE_TAKEOVER_UNKNOWN_SETTLE_MS when nobody reported a
 * time at all. Better times also correct the key's recorded holderSince.
 *
 * Every waiting audit is stored (settings, written with the holder change itself) until its audit row exists: after a
 * crash the next start continues the wait from the stored state and writes what is due, dated at the best time known.
 */
export class LeaseTakeoverAudit {
  private entries: Map<string, PendingLeaseTakeover & { recovered?: boolean }> | null = null;

  constructor(
    private readonly db: DrizzleClient,
    private readonly ports: LeaseTakeoverAuditPorts
  ) {}

  /** Waiting audits known to this process (after the stored ones were loaded). */
  get pendingCount(): number {
    return this.entries?.size ?? 0;
  }

  /** An audited holder change, already stored with the change: written now when its time is the holder's own. */
  async record(notice: LeaseHolderChangeNotice): Promise<void> {
    const entries = await this.load();
    const pending = pendingLeaseTakeover(notice);
    // The key changed holder again before an earlier change settled: that one is final as it stands.
    for (const earlier of [...entries.values()]) {
      if (sameKey(earlier, pending) && earlier.id !== pending.id) await this.finalize(earlier, settle(earlier));
    }
    entries.set(pending.id, pending);
    if (pending.exact) await this.finalize(pending, settle(pending));
  }

  /** Later reports of the keys with a waiting audit: the holder's own time settles it, a voter's may improve it. */
  async observe(sightings: LeaseTakeoverSighting[], now = new Date()): Promise<void> {
    const entries = await this.load();
    if (entries.size === 0) return;
    for (const sighting of sightings) {
      const pending = latestFor(entries, sighting.policyId, sighting.slot);
      if (!pending) continue;
      const holderId = pending.notice.to;
      const exact = leaseExactHolderSince(holderId, sighting.candidates, now);
      if (exact) {
        pending.exact = exact;
        // Stored first: if the audit row cannot be written now, the retry still carries the holder's time.
        await persistPendingLeaseTakeover(this.db, pending);
        await this.ports.correct(sighting.policyId, sighting.slot, holderId, exact);
        await this.finalize(pending, settle(pending));
        continue;
      }
      let changed = false;
      if (
        !pending.holderReported &&
        sighting.candidates.some((candidate) => candidate.source === 'daemon' && candidate.sourceId === holderId)
      ) {
        pending.holderReported = true;
        changed = true;
      }
      const floor = pending.notice.takeoverNotBefore?.getTime() ?? Number.NEGATIVE_INFINITY;
      const earliest = sighting.candidates
        .filter((candidate) => candidate.holderId === holderId && !candidate.exact && candidate.since instanceof Date)
        .map((candidate) => candidate.since!.getTime())
        .filter((time) => Number.isFinite(time) && time <= now.getTime() && time >= floor)
        .reduce((min, time) => Math.min(min, time), Number.POSITIVE_INFINITY);
      if (Number.isFinite(earliest) && (!pending.best || earliest < pending.best.getTime())) {
        pending.best = new Date(earliest);
        changed = true;
        await this.ports.correct(sighting.policyId, sighting.slot, holderId, pending.best);
      }
      if (changed && entries.get(pending.id) === pending) await persistPendingLeaseTakeover(this.db, pending);
    }
  }

  /**
   * Writes every waiting audit whose wait is over, or that a later change of the same key superseded. The first run
   * after a start loads what a crashed process left.
   */
  async settleDue(now = new Date()): Promise<void> {
    const entries = await this.load();
    for (const pending of [...entries.values()]) {
      if (entries.get(pending.id) !== pending) continue;
      const superseded = latestFor(entries, pending.notice.policyId, pending.notice.slot) !== pending;
      const wait = pending.best || pending.holderReported ? LEASE_TAKEOVER_SETTLE_MS : LEASE_TAKEOVER_UNKNOWN_SETTLE_MS;
      if (!superseded && !pending.exact && now.getTime() - pending.noticedAt.getTime() < wait) continue;
      await this.finalize(pending, settle(pending));
    }
  }

  /** Shutdown: nothing waiting is left for the next start to guess about. */
  async flush(): Promise<void> {
    const entries = await this.load();
    for (const pending of [...entries.values()]) {
      if (entries.get(pending.id) === pending) await this.finalize(pending, settle(pending));
    }
  }

  private async load(): Promise<Map<string, PendingLeaseTakeover & { recovered?: boolean }>> {
    if (this.entries) return this.entries;
    const rows = await this.db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(like(settings.key, `${LEASE_TAKEOVER_SETTING_PREFIX}%`));
    // Another call may have loaded meanwhile; the first load wins so no entry is tracked twice.
    if (this.entries) return this.entries;
    const entries = new Map<string, PendingLeaseTakeover & { recovered?: boolean }>();
    for (const row of rows) {
      const pending = decode(row.value);
      if (pending) entries.set(pending.id, { ...pending, recovered: true });
    }
    this.entries = entries;
    return entries;
  }

  /** Audit row first, then the stored entry: a crash in between is found by its takeover id and not written twice. */
  private async finalize(
    pending: PendingLeaseTakeover & { recovered?: boolean },
    settled: SettledLeaseTakeover
  ): Promise<void> {
    const entries = this.entries;
    if (!entries || entries.get(pending.id) !== pending) return;
    entries.delete(pending.id);
    try {
      const done = (pending.recovered && (await this.ports.written(settled))) || (await this.ports.write(settled));
      if (!done) {
        entries.set(pending.id, pending);
        return;
      }
    } catch (error) {
      entries.set(pending.id, pending);
      throw error;
    }
    await this.db.delete(settings).where(eq(settings.key, `${LEASE_TAKEOVER_SETTING_PREFIX}${pending.id}`));
  }
}

function sameKey(left: PendingLeaseTakeover, right: PendingLeaseTakeover): boolean {
  return left.notice.policyId === right.notice.policyId && left.notice.slot === right.notice.slot;
}

function latestFor(
  entries: Map<string, PendingLeaseTakeover>,
  policyId: string,
  slot: number
): PendingLeaseTakeover | null {
  let latest: PendingLeaseTakeover | null = null;
  for (const pending of entries.values()) {
    if (pending.notice.policyId !== policyId || pending.notice.slot !== slot) continue;
    if (!latest || pending.noticedAt.getTime() >= latest.noticedAt.getTime()) latest = pending;
  }
  return latest;
}

function settle(pending: PendingLeaseTakeover): SettledLeaseTakeover {
  if (pending.exact) {
    return {
      takeoverId: pending.id,
      notice: pending.notice,
      takeoverAt: pending.exact,
      source: 'holder',
      noticedAt: pending.noticedAt,
    };
  }
  return pending.best
    ? {
        takeoverId: pending.id,
        notice: pending.notice,
        takeoverAt: pending.best,
        source: 'voters',
        noticedAt: pending.noticedAt,
      }
    : {
        takeoverId: pending.id,
        notice: pending.notice,
        takeoverAt: pending.notice.holderSince ?? pending.noticedAt,
        source: 'noticed',
        noticedAt: pending.noticedAt,
      };
}

interface StoredPendingTakeover {
  id: string;
  notice: Omit<LeaseHolderChangeNotice, 'holderSince' | 'takeoverNotBefore' | 'noticedAt'> & {
    holderSince: string | null;
    takeoverNotBefore: string | null;
  };
  noticedAt: string;
  exact: string | null;
  best: string | null;
  holderReported: boolean;
}

function encode(pending: PendingLeaseTakeover): StoredPendingTakeover {
  const { holderSince, takeoverNotBefore, noticedAt: _noticedAt, ...notice } = pending.notice;
  return {
    id: pending.id,
    notice: {
      ...notice,
      holderSince: holderSince?.toISOString() ?? null,
      takeoverNotBefore: takeoverNotBefore?.toISOString() ?? null,
    },
    noticedAt: pending.noticedAt.toISOString(),
    exact: pending.exact?.toISOString() ?? null,
    best: pending.best?.toISOString() ?? null,
    holderReported: pending.holderReported,
  };
}

function date(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function decode(value: unknown): PendingLeaseTakeover | null {
  const stored = value as Partial<StoredPendingTakeover> | null;
  const noticedAt = date(stored?.noticedAt);
  if (!stored || typeof stored.id !== 'string' || !stored.notice || !noticedAt) return null;
  const { holderSince, takeoverNotBefore, ...notice } = stored.notice;
  if (typeof notice.policyId !== 'string' || typeof notice.to !== 'string' || !Number.isInteger(notice.slot)) {
    return null;
  }
  return {
    id: stored.id,
    notice: {
      ...notice,
      holderSince: date(holderSince) ?? undefined,
      takeoverNotBefore: date(takeoverNotBefore),
      noticedAt,
    } as LeaseHolderChangeNotice,
    noticedAt,
    exact: date(stored.exact),
    best: date(stored.best),
    holderReported: stored.holderReported === true,
  };
}
