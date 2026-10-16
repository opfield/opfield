import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { inferenceProviderConnections, inferenceProviderSettings, inferenceQuotaSnapshots } from '@/db/schema/index.js';
import type { InferenceConnectionStatus, InferenceRoutingStrategy } from '@/db/schema/inference-providers.js';
import { createChildLogger } from '@/lib/logger.js';
import { QUOTA_READ_LIMIT } from '@/services/inference-usage-retention.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import { latestValidQuota, quotaAppliesToModel } from './inference-provider.service.helpers.js';

const AFFINITY_TTL_SECONDS = 24 * 60 * 60;
const AFFINITY_REBALANCE_IDLE_MS = 60 * 60 * 1000;
const AFFINITY_REBALANCE_HYSTERESIS_MS = 60 * 60 * 1000;
const ACTIVE_THREAD_WINDOW_MS = AFFINITY_REBALANCE_IDLE_MS;
const AFFINITY_TURN_LEASE_MS = 5 * 60 * 1000;
const MISSING_AFFINITY = '__missing_affinity__';
const UPDATE_AFFINITY_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if ARGV[1] == '${MISSING_AFFINITY}' then
  if current ~= false then return 0 end
elseif current ~= ARGV[1] then
  return 0
end
if KEYS[2] ~= KEYS[3] then redis.call('ZREM', KEYS[2], ARGV[3]) end
redis.call('ZADD', KEYS[3], tonumber(ARGV[4]), ARGV[3])
redis.call('EXPIRE', KEYS[3], tonumber(ARGV[5]))
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[5]))
return 1
`;
const CLEAR_AFFINITY_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[2])
return 1
`;
const DELETE_MALFORMED_AFFINITY_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;
const ACQUIRE_AFFINITY_TURN_SCRIPT = `
local now = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), ARGV[3])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]))
return 1
`;
const RENEW_AFFINITY_TURN_SCRIPT = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) == false then return 0 end
redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1
`;
const RELEASE_AFFINITY_TURN_SCRIPT = `return redis.call('ZREM', KEYS[1], ARGV[1])`;
const ACTIVE_AFFINITY_TURNS_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]))
return redis.call('ZCARD', KEYS[1])
`;
const logger = createChildLogger('InferenceRoutingService');

export interface InferenceRoutingInput {
  /** Omit only when a logical model intentionally spans multiple providers. */
  providerId?: string;
  allowedConnectionIds?: string[];
  /** Upstream model each connection would serve, so model-scoped quota windows gate only that model. */
  upstreamModelByConnection?: Record<string, string>;
  affinityKey?: string;
  preferredConnectionId?: string;
  existingThread: boolean;
}

export interface InferenceRoutingSelection {
  connectionId: string;
  providerId: string;
  remainingFraction: number | null;
}

interface Candidate {
  id: string;
  providerId: string;
  order: number;
  status: string;
  remainingFraction: number | null;
  minimumRemainingFraction: number;
}

interface AffinityRecord {
  connectionId: string;
  lastActivityAt: number | null;
  lastRebalancedAt: number | null;
}

interface AffinityPreference extends AffinityRecord {
  raw: string | null;
  explicit: boolean;
}

@injectable()
export class InferenceRoutingService {
  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    @inject(TOKENS.RedisClient) private readonly redis: Redis
  ) {}

  async select(input: InferenceRoutingInput): Promise<InferenceRoutingSelection> {
    const candidates = await this.loadCandidates(input);
    const preferred = await this.preferred(input);
    const usable = usableCandidates(candidates);
    if (usable.length === 0) {
      logger.warn('No inference provider connection has usable capacity', {
        providerId: input.providerId ?? null,
        allowedConnectionIds: input.allowedConnectionIds ?? [],
        existingThread: input.existingThread,
        hasAffinityKey: Boolean(input.affinityKey),
        candidates: candidates.map(candidateDiagnostic),
      });
      throw new InferenceProtocolError(
        503,
        'provider_capacity_unavailable',
        'No provider connection has usable capacity'
      );
    }

    const sticky = preferredCandidate(preferred?.connectionId, usable);
    const capacityPriorityRequired = !input.providerId || usable.some((candidate) => candidate.status === 'quota_hot');
    let selected = sticky
      ? await this.rebalanceStickyCandidate(input, preferred!, sticky, usable)
      : capacityPriorityRequired
        ? highestCapacityCandidate(input.affinityKey ?? crypto.randomUUID(), usable)
        : await this.choose(input.providerId!, input.affinityKey, usable);
    let affinityPersisted = false;
    if (input.affinityKey) {
      const committed = await this.commitAffinity(input.affinityKey, preferred?.raw ?? null, selected, usable);
      selected = committed.candidate;
      affinityPersisted = committed.persisted;
    }
    if (sticky && selected.id !== sticky.id && affinityPersisted) {
      logger.info('Committed idle inference thread affinity rebalance', {
        fromConnectionId: sticky.id,
        toConnectionId: selected.id,
        quotaImbalance: hasQuotaImbalance(sticky, selected),
      });
    }
    return {
      connectionId: selected.id,
      providerId: selected.providerId,
      remainingFraction: selected.remainingFraction,
    };
  }

  async clearAffinity(affinityKey: string): Promise<void> {
    const hash = affinityHash(affinityKey);
    const key = this.affinityKey(hash);
    const raw = await this.redis.get(key);
    if (raw === null) return;
    const current = parseAffinityRecord(raw);
    if (!current) {
      await this.redis.eval(DELETE_MALFORMED_AFFINITY_SCRIPT, 1, key, raw);
      return;
    }
    await this.redis.eval(CLEAR_AFFINITY_SCRIPT, 2, key, this.activeThreadsKey(current.connectionId), raw, hash);
  }

  async markAffinityActive(affinityKey: string): Promise<void> {
    const hash = affinityHash(affinityKey);
    const key = this.affinityKey(hash);
    try {
      const raw = await this.redis.get(key);
      const current = parseAffinityRecord(raw);
      if (!current) return;
      await this.updateAffinity(hash, raw, current.connectionId, current.connectionId, Date.now());
    } catch (error) {
      logger.warn('Failed to refresh inference thread affinity activity', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async beginAffinityTurn(affinityKey: string): Promise<() => Promise<void>> {
    const key = this.affinityTurnsKey(affinityHash(affinityKey));
    const leaseId = crypto.randomUUID();
    const leaseTtlMs = AFFINITY_TURN_LEASE_MS + 60_000;
    let released = false;
    let leasePresent = false;
    let renewalTimer: ReturnType<typeof setTimeout> | undefined;
    let maintenanceInFlight: Promise<void> | undefined;
    const renewalIntervalMs = Math.max(1000, Math.floor(AFFINITY_TURN_LEASE_MS / 3));

    const scheduleMaintenance = () => {
      if (released) return;
      renewalTimer = setTimeout(() => void maintainLease(), renewalIntervalMs);
      renewalTimer.unref();
    };
    const maintainLease = (): Promise<void> => {
      if (released) return Promise.resolve();
      if (maintenanceInFlight) return maintenanceInFlight;
      maintenanceInFlight = (async () => {
        const now = Date.now();
        try {
          if (leasePresent) {
            const renewed = await this.redis.eval(
              RENEW_AFFINITY_TURN_SCRIPT,
              1,
              key,
              leaseId,
              now + AFFINITY_TURN_LEASE_MS,
              leaseTtlMs
            );
            leasePresent = Number(renewed) === 1;
          }
          if (!leasePresent && !released) {
            await this.redis.eval(
              ACQUIRE_AFFINITY_TURN_SCRIPT,
              1,
              key,
              now,
              now + AFFINITY_TURN_LEASE_MS,
              leaseId,
              leaseTtlMs
            );
            leasePresent = true;
          }
        } catch (error) {
          logger.warn('Failed to maintain inference affinity turn lease; retrying', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })().finally(() => {
        maintenanceInFlight = undefined;
        scheduleMaintenance();
      });
      return maintenanceInFlight;
    };

    await maintainLease();

    return async () => {
      if (released) return;
      released = true;
      if (renewalTimer) clearTimeout(renewalTimer);
      await maintenanceInFlight?.catch(() => undefined);
      try {
        await this.redis.eval(RELEASE_AFFINITY_TURN_SCRIPT, 1, key, leaseId);
      } catch (error) {
        logger.warn('Failed to release inference affinity turn lease', { error });
      }
    };
  }

  async markCooldown(connectionId: string, seconds: number, reason = 'Provider requested cooldown'): Promise<void> {
    await Promise.all([
      this.redis.set(`inference:provider-cooldown:${connectionId}`, reason, 'EX', Math.max(1, seconds)),
      this.db
        .update(inferenceProviderConnections)
        .set({ status: 'cooldown', healthReason: reason, updatedAt: new Date() })
        .where(eq(inferenceProviderConnections.id, connectionId)),
    ]);
  }

  private async preferred(input: InferenceRoutingInput): Promise<AffinityPreference | undefined> {
    if (input.preferredConnectionId) {
      const raw = input.affinityKey ? await this.redis.get(this.affinityKey(affinityHash(input.affinityKey))) : null;
      return {
        connectionId: input.preferredConnectionId,
        lastActivityAt: null,
        lastRebalancedAt: null,
        raw,
        explicit: true,
      };
    }
    if (!input.affinityKey) return undefined;
    const raw = await this.redis.get(this.affinityKey(affinityHash(input.affinityKey)));
    const record = parseAffinityRecord(raw);
    return record ? { ...record, raw, explicit: false } : undefined;
  }

  private async choose(
    providerId: string,
    affinityKey: string | undefined,
    candidates: Candidate[]
  ): Promise<Candidate> {
    const strategy = await this.routingStrategy(providerId);
    if (strategy === 'sequential') {
      return firstSequentialCandidate(candidates);
    }
    const seed = affinityKey ?? crypto.randomUUID();
    if (strategy === 'even') return highestScore(seed, candidates, () => 1);
    return quotaWeightedCandidate(seed, candidates);
  }

  private async routingStrategy(providerId: string): Promise<InferenceRoutingStrategy> {
    const settings = await this.db.query.inferenceProviderSettings.findFirst({
      where: eq(inferenceProviderSettings.providerId, providerId),
    });
    return settings?.routingStrategy ?? 'balanced';
  }

  private async rebalanceStickyCandidate(
    input: InferenceRoutingInput,
    preference: AffinityPreference,
    sticky: Candidate,
    candidates: Candidate[]
  ): Promise<Candidate> {
    if (preference.explicit || !input.providerId) return sticky;
    if ((await this.routingStrategy(input.providerId)) !== 'balanced') return sticky;
    if (preference.lastActivityAt === null || Date.now() - preference.lastActivityAt <= AFFINITY_REBALANCE_IDLE_MS) {
      return sticky;
    }
    if (
      preference.lastRebalancedAt !== null &&
      Date.now() - preference.lastRebalancedAt < AFFINITY_REBALANCE_HYSTERESIS_MS
    ) {
      return sticky;
    }
    if (await this.hasActiveAffinityTurn(input.affinityKey!)) return sticky;

    try {
      const activeThreads = await this.activeThreadCounts(candidates);
      const currentActiveThreads = activeThreads.get(sticky.id) ?? 0;
      const alternatives = candidates.filter((candidate) => {
        if (candidate.id === sticky.id) return false;
        return (
          hasQuotaImbalance(sticky, candidate) ||
          hasThreadLoadImbalance(currentActiveThreads, activeThreads.get(candidate.id) ?? 0)
        );
      });
      if (alternatives.length === 0) return sticky;

      return loadAdjustedCandidate(input.affinityKey!, alternatives, activeThreads);
    } catch (error) {
      logger.warn('Failed to evaluate idle inference affinity rebalance; retaining current account', {
        connectionId: sticky.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return sticky;
    }
  }

  private async activeThreadCounts(candidates: Candidate[]): Promise<Map<string, number>> {
    const cutoff = Date.now() - ACTIVE_THREAD_WINDOW_MS;
    const pipeline = this.redis.pipeline();
    for (const candidate of candidates) {
      const key = this.activeThreadsKey(candidate.id);
      pipeline.zremrangebyscore(key, '-inf', cutoff);
      pipeline.zcard(key);
    }
    const results = await pipeline.exec();
    if (!Array.isArray(results)) throw new Error('Invalid Redis active thread response');
    const counts = new Map<string, number>();
    for (const [index, candidate] of candidates.entries()) {
      const count = results[index * 2 + 1]?.[1];
      if (typeof count !== 'number') throw new Error('Invalid Redis active thread count');
      counts.set(candidate.id, count);
    }
    return counts;
  }

  private async hasActiveAffinityTurn(affinityKey: string): Promise<boolean> {
    try {
      const active = await this.redis.eval(
        ACTIVE_AFFINITY_TURNS_SCRIPT,
        1,
        this.affinityTurnsKey(affinityHash(affinityKey)),
        Date.now()
      );
      return Number(active) > 0;
    } catch (error) {
      logger.warn('Failed to inspect inference affinity turn leases; retaining current account', {
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  private async commitAffinity(
    affinityKey: string,
    expectedRaw: string | null,
    selected: Candidate,
    candidates: Candidate[]
  ): Promise<{ candidate: Candidate; persisted: boolean }> {
    const hash = affinityHash(affinityKey);
    try {
      const committed = await this.updateAffinity(
        hash,
        expectedRaw,
        parseAffinityRecord(expectedRaw)?.connectionId ?? selected.id,
        selected.id,
        Date.now()
      );
      if (committed) return { candidate: selected, persisted: true };

      const currentRaw = await this.redis.get(this.affinityKey(hash));
      const current = parseAffinityRecord(currentRaw);
      const concurrent = current ? candidates.find((candidate) => candidate.id === current.connectionId) : undefined;
      if (concurrent) return { candidate: concurrent, persisted: true };

      const retryCommitted = await this.updateAffinity(
        hash,
        currentRaw,
        current?.connectionId ?? selected.id,
        selected.id,
        Date.now()
      );
      if (retryCommitted) return { candidate: selected, persisted: true };
      const final = parseAffinityRecord(await this.redis.get(this.affinityKey(hash)));
      const finalCandidate = final ? candidates.find((candidate) => candidate.id === final.connectionId) : undefined;
      return finalCandidate
        ? { candidate: finalCandidate, persisted: true }
        : { candidate: selected, persisted: false };
    } catch (error) {
      logger.warn('Failed to persist inference thread affinity bookkeeping', {
        connectionId: selected.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { candidate: selected, persisted: false };
    }
  }

  private async updateAffinity(
    threadHash: string,
    expectedRaw: string | null,
    previousConnectionId: string,
    connectionId: string,
    activityAt: number
  ): Promise<boolean> {
    const previous = parseAffinityRecord(expectedRaw);
    const next = JSON.stringify({
      connectionId,
      lastActivityAt: activityAt,
      lastRebalancedAt:
        previous && previous.connectionId !== connectionId ? activityAt : (previous?.lastRebalancedAt ?? null),
    });
    const updated = await this.redis.eval(
      UPDATE_AFFINITY_SCRIPT,
      3,
      this.affinityKey(threadHash),
      this.activeThreadsKey(previousConnectionId),
      this.activeThreadsKey(connectionId),
      expectedRaw ?? MISSING_AFFINITY,
      next,
      threadHash,
      activityAt,
      AFFINITY_TTL_SECONDS
    );
    return Number(updated) === 1;
  }

  private async loadCandidates(input: InferenceRoutingInput): Promise<Candidate[]> {
    const conditions = [eq(inferenceProviderConnections.enabled, true), isNull(inferenceProviderConnections.deletedAt)];
    if (input.providerId) conditions.push(eq(inferenceProviderConnections.providerId, input.providerId));
    if (input.allowedConnectionIds?.length) {
      conditions.push(inArray(inferenceProviderConnections.id, input.allowedConnectionIds));
    }
    const connections = await this.db
      .select()
      .from(inferenceProviderConnections)
      .where(and(...conditions));
    const rows = await Promise.all(
      connections.map(async (connection): Promise<Candidate | null> => {
        const cooldownActive = Boolean(await this.redis.exists(`inference:provider-cooldown:${connection.id}`));
        if (cooldownActive) return null;
        const connectionStatus = statusAfterCooldown(connection.status, cooldownActive);
        if (connectionStatus !== connection.status) {
          await this.db
            .update(inferenceProviderConnections)
            .set({ status: connectionStatus, healthReason: null, updatedAt: new Date() })
            .where(
              and(
                eq(inferenceProviderConnections.id, connection.id),
                eq(inferenceProviderConnections.status, 'cooldown')
              )
            );
        }
        const quotas = await this.db.query.inferenceQuotaSnapshots.findMany({
          where: and(
            eq(inferenceQuotaSnapshots.connectionId, connection.id),
            eq(inferenceQuotaSnapshots.status, 'fresh')
          ),
          orderBy: [desc(inferenceQuotaSnapshots.fetchedAt)],
          limit: QUOTA_READ_LIMIT,
        });
        const latestQuotas = latestQuotaWindows(quotas);
        const now = Date.now();
        const upstreamModelId = input.upstreamModelByConnection?.[connection.id];
        const validQuotas = latestValidQuota(quotas, now).filter((quota) =>
          quotaAppliesToModel(quota, upstreamModelId)
        );
        const minimumRemainingFraction = connection.minimumRemainingPercent / 100;
        const remainingFractions = validQuotas.flatMap((quota) =>
          quota.remainingFraction === null || quota.remainingFraction === undefined
            ? []
            : [Number(quota.remainingFraction)]
        );
        const hasExhaustedQuota = remainingFractions.some((remaining) => remaining <= minimumRemainingFraction);
        return {
          id: connection.id,
          providerId: connection.providerId,
          order: connection.routingOrder,
          status: routingStatus(connectionStatus, {
            hasExpiredQuota: latestQuotas.some((quota) => quotaIsExpired(quota, now)),
            hasExhaustedQuota,
            hasQuotaHistory: quotas.length > 0,
            healthReason: connection.healthReason,
          }),
          remainingFraction: remainingFractions.length ? Math.min(...remainingFractions) : null,
          minimumRemainingFraction,
        };
      })
    );
    return rows.filter((row): row is Candidate => row !== null);
  }

  private affinityKey(hash: string): string {
    return `inference:affinity:${hash}`;
  }

  private activeThreadsKey(connectionId: string): string {
    return `inference:active-threads:${connectionId}`;
  }

  private affinityTurnsKey(hash: string): string {
    return `inference:affinity-turns:${hash}`;
  }
}

function isUsable(candidate: Candidate): boolean {
  if (['disabled', 'unavailable', 'reauth_required', 'cooldown'].includes(candidate.status)) return false;
  if (candidate.remainingFraction === null) return true;
  return candidate.remainingFraction > candidate.minimumRemainingFraction;
}

function usableCandidates(candidates: Candidate[]): Candidate[] {
  return candidates.filter(isUsable);
}

function preferredCandidate(preferred: string | undefined, candidates: Candidate[]): Candidate | undefined {
  return preferred ? candidates.find((candidate) => candidate.id === preferred) : undefined;
}

function candidateDiagnostic(candidate: Candidate) {
  return {
    connectionId: candidate.id,
    providerId: candidate.providerId,
    status: candidate.status,
    remainingFraction: candidate.remainingFraction,
    minimumRemainingFraction: candidate.minimumRemainingFraction,
    usable: isUsable(candidate),
  };
}

function latestQuotaWindows(rows: Array<typeof inferenceQuotaSnapshots.$inferSelect>) {
  const latestFetchedAt = rows.reduce(
    (latest, row) => Math.max(latest, row.fetchedAt.getTime()),
    Number.NEGATIVE_INFINITY
  );
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (row.fetchedAt.getTime() !== latestFetchedAt) return false;
    const key = `${row.dimension}:${row.modelBucket ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function quotaIsExpired(quota: typeof inferenceQuotaSnapshots.$inferSelect, now: number): boolean {
  return (
    quota.validUntil.getTime() <= now ||
    (quota.resetAt !== null && quota.resetAt !== undefined && quota.resetAt.getTime() <= now)
  );
}

function routingStatus(
  status: string,
  input: {
    hasExpiredQuota: boolean;
    hasExhaustedQuota: boolean;
    hasQuotaHistory: boolean;
    healthReason: string | null;
  }
): string {
  if (['disabled', 'reauth_required', 'cooldown'].includes(status)) return status;
  if (input.hasExhaustedQuota) return 'unavailable';
  if (status === 'unavailable') {
    return input.healthReason === null && input.hasQuotaHistory ? 'stale' : status;
  }
  if (input.hasExpiredQuota) return 'stale';
  return status;
}

function statusAfterCooldown(status: InferenceConnectionStatus, cooldownActive: boolean): InferenceConnectionStatus {
  return status === 'cooldown' && !cooldownActive ? 'healthy' : status;
}

function uniformScore(seed: string, candidate: Candidate): number {
  const digest = createHash('sha256').update(`${seed}:${candidate.id}`).digest();
  return (digest.readUInt32BE(0) + 1) / 0x1_0000_0000;
}

/** Deterministic weighted rendezvous score. Larger weights win proportionally more keys. */
function weightedScore(seed: string, candidate: Candidate, weight: number): number {
  return Math.log(uniformScore(seed, candidate)) / Math.max(Number.EPSILON, weight);
}

function highestScore(seed: string, candidates: Candidate[], weightFor: (candidate: Candidate) => number): Candidate {
  return [...candidates].sort(
    (a, b) => weightedScore(seed, b, weightFor(b)) - weightedScore(seed, a, weightFor(a)) || a.id.localeCompare(b.id)
  )[0]!;
}

function quotaWeightedCandidate(seed: string, candidates: Candidate[]): Candidate {
  const knownCandidates = candidates.filter((candidate) => candidate.remainingFraction !== null);
  if (knownCandidates.length === 0) return highestScore(seed, candidates, () => 1);
  return highestScore(seed, knownCandidates, (candidate) => candidate.remainingFraction!);
}

/** Capacity-sensitive admission prefers the route furthest above its configured reserve. */
function highestCapacityCandidate(seed: string, candidates: Candidate[]): Candidate {
  const knownCandidates = candidates.filter((candidate) => candidate.remainingFraction !== null);
  if (knownCandidates.length === 0) return highestScore(seed, candidates, () => 1);
  return [...knownCandidates].sort(
    (a, b) =>
      normalizedHeadroom(b) - normalizedHeadroom(a) ||
      b.remainingFraction! - a.remainingFraction! ||
      a.id.localeCompare(b.id)
  )[0]!;
}

function normalizedHeadroom(candidate: Candidate): number {
  if (candidate.remainingFraction === null) return Number.NEGATIVE_INFINITY;
  const usableRange = Math.max(Number.EPSILON, 1 - candidate.minimumRemainingFraction);
  return (candidate.remainingFraction - candidate.minimumRemainingFraction) / usableRange;
}

function hasQuotaImbalance(current: Candidate, alternative: Candidate): boolean {
  if (current.remainingFraction === null || alternative.remainingFraction === null) return false;
  return normalizedHeadroom(alternative) >= normalizedHeadroom(current) * 2;
}

function hasThreadLoadImbalance(currentActiveThreads: number, alternativeActiveThreads: number): boolean {
  return currentActiveThreads >= 2 * Math.max(1, alternativeActiveThreads);
}

function loadAdjustedCandidate(
  seed: string,
  candidates: Candidate[],
  activeThreads: ReadonlyMap<string, number>
): Candidate {
  const knownCandidates = candidates.filter((candidate) => candidate.remainingFraction !== null);
  const pool = knownCandidates.length > 0 ? knownCandidates : candidates;
  return highestScore(seed, pool, (candidate) => {
    const capacity = candidate.remainingFraction === null ? 1 : Math.max(Number.EPSILON, normalizedHeadroom(candidate));
    return capacity / ((activeThreads.get(candidate.id) ?? 0) + 1);
  });
}

function affinityHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseAffinityRecord(raw: string | null): AffinityRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      connectionId?: unknown;
      lastActivityAt?: unknown;
      lastRebalancedAt?: unknown;
    };
    if (typeof parsed.connectionId !== 'string' || parsed.connectionId.length === 0) return null;
    return {
      connectionId: parsed.connectionId,
      lastActivityAt:
        typeof parsed.lastActivityAt === 'number' && Number.isFinite(parsed.lastActivityAt)
          ? parsed.lastActivityAt
          : null,
      lastRebalancedAt:
        typeof parsed.lastRebalancedAt === 'number' && Number.isFinite(parsed.lastRebalancedAt)
          ? parsed.lastRebalancedAt
          : null,
    };
  } catch {
    return { connectionId: raw, lastActivityAt: null, lastRebalancedAt: null };
  }
}

function firstSequentialCandidate(candidates: Candidate[]): Candidate {
  return [...candidates].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))[0]!;
}

export function canFailOver(error: unknown, emittedOutput: boolean): boolean {
  if (emittedOutput) return false;
  if (!(error instanceof InferenceProtocolError)) return false;
  if (
    [
      'duplicate_request',
      'cyber_policy',
      'invalid_request_error',
      'model_not_found',
      'reservation_unavailable',
      'budget_policy_unavailable',
    ].includes(error.code)
  )
    return false;
  return [401, 408, 409, 429, 502, 503, 504].includes(error.status);
}

export const __testOnly = {
  uniformScore,
  weightedScore,
  quotaWeightedCandidate,
  highestCapacityCandidate,
  normalizedHeadroom,
  hasQuotaImbalance,
  hasThreadLoadImbalance,
  loadAdjustedCandidate,
  affinityHash,
  parseAffinityRecord,
  highestScore,
  firstSequentialCandidate,
  isUsable,
  usableCandidates,
  preferredCandidate,
  candidateDiagnostic,
  statusAfterCooldown,
  latestQuotaWindows,
  latestValidQuotaWindows: latestValidQuota,
  quotaIsExpired,
  routingStatus,
};
