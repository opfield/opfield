import type { Redis } from 'ioredis';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import type { EffectiveInferenceLimits, InferenceBudgetUsage } from './inference-budget-policy.js';
import { SUBSCRIPTION_ADMISSION_OVERAGE_CREDITS } from './inference-budget-policy.js';

const RESERVATION_TTL_MS = 15 * 60_000;
const RESERVATION_HEARTBEAT_MS = 60_000;
const UNLIMITED_RESERVATION_LIMIT = Number.MAX_SAFE_INTEGER;

export type InferenceBudgetDimension = 'credits5h' | 'credits7d' | 'credits30d' | 'apiMonthlyMicrodollars';

export interface BudgetReservationAmounts {
  credits5h: number;
  credits7d: number;
  credits30d: number;
  apiMonthlyMicrodollars: number;
}

export interface BudgetReservation {
  id: string;
  userId: string;
  /** Credits held against the real configured window balance. */
  amounts: BudgetReservationAmounts;
  /** Principal plus the atomically allocated terminal overage allowance. */
  admittedAmounts: BudgetReservationAmounts;
  expiresAt: Date;
}

const RESERVE_SCRIPT = `
local function amounts_for_window(value, window)
  if not value then return 0, 0 end
  local separator = string.find(value, ':', 1, true)
  if not separator then return tonumber(value) or 0, 0 end
  if string.sub(value, 1, separator - 1) ~= window then return 0, 0 end
  local body = string.sub(value, separator + 1)
  local overage_separator = string.find(body, ':', 1, true)
  if not overage_separator then return tonumber(body) or 0, 0 end
  return tonumber(string.sub(body, 1, overage_separator - 1)) or 0, tonumber(string.sub(body, overage_separator + 1)) or 0
end
local now = tonumber(ARGV[1])
local reservation = ARGV[2]
local max_overage = tonumber(ARGV[20])
local reserved = {}
local overages = {}
for i = 1, 4 do
  local zkey = KEYS[(i - 1) * 2 + 1]
  local hkey = KEYS[(i - 1) * 2 + 2]
  local expired = redis.call('ZRANGEBYSCORE', zkey, '-inf', now)
  for _, member in ipairs(expired) do redis.call('HDEL', hkey, member) end
  if #expired > 0 then redis.call('ZREM', zkey, unpack(expired)) end
  local values = redis.call('HVALS', hkey)
  local window = ARGV[14 + i]
  local live = 0
  for _, value in ipairs(values) do
    local principal, overage = amounts_for_window(value, window)
    live = live + principal + overage
  end
  local existing, existing_overage = amounts_for_window(redis.call('HGET', hkey, reservation), window)
  local requested = tonumber(ARGV[2 + i])
  local spent = tonumber(ARGV[6 + i])
  local limit = tonumber(ARGV[10 + i])
  local available = limit - spent - live + existing + existing_overage
  if i <= 3 and requested > 0 then
    if available <= 0 then return {i} end
    reserved[i] = math.min(requested, available)
    -- Counting the full admitted cost in live makes a terminal allowance
    -- consume the entire tail, so a parallel turn cannot take another one.
    overages[i] = math.min(requested - reserved[i], max_overage)
  elseif spent + live - existing + requested > limit then
    return {i}
  else
    reserved[i] = requested
    overages[i] = 0
  end
end
local expiry = tonumber(ARGV[19])
for i = 1, 4 do
  local zkey = KEYS[(i - 1) * 2 + 1]
  local hkey = KEYS[(i - 1) * 2 + 2]
  local amount = reserved[i]
  if amount > 0 then
    local window = ARGV[14 + i]
    redis.call('ZADD', zkey, expiry, reservation)
    -- Keep the existing window:amount format readable after Opfield rollback.
    redis.call('HSET', hkey, reservation, window .. ':' .. (amount + overages[i]))
    redis.call('PEXPIRE', zkey, expiry - now + 60000)
    redis.call('PEXPIRE', hkey, expiry - now + 60000)
  end
end
-- RESP integers truncate Lua numbers. Return credits as bulk strings so a
-- sub-credit tail reservation (for example 0.5) survives the round trip.
return {
  0,
  tostring(reserved[1]), tostring(reserved[2]), tostring(reserved[3]), tostring(reserved[4]),
  tostring(overages[1]), tostring(overages[2]), tostring(overages[3]), tostring(overages[4])
}
`;

const RELEASE_SCRIPT = `
for i = 1, 4 do
  redis.call('ZREM', KEYS[(i - 1) * 2 + 1], ARGV[1])
  redis.call('HDEL', KEYS[(i - 1) * 2 + 2], ARGV[1])
end
return 1
`;

const RENEW_SCRIPT = `
local found = 0
local now = tonumber(ARGV[2])
local expiry = tonumber(ARGV[3])
for i = 1, 4 do
  local zkey = KEYS[(i - 1) * 2 + 1]
  local hkey = KEYS[(i - 1) * 2 + 2]
  if redis.call('HEXISTS', hkey, ARGV[1]) == 1 then
    found = 1
    redis.call('ZADD', zkey, expiry, ARGV[1])
    redis.call('PEXPIRE', zkey, expiry - now + 60000)
    redis.call('PEXPIRE', hkey, expiry - now + 60000)
  end
end
return found
`;

@injectable()
export class InferenceBudgetReservationService {
  private readonly renewals = new Map<string, NodeJS.Timeout>();

  constructor(@inject(TOKENS.RedisClient) private readonly redis: Redis) {}

  async reserve(input: {
    reservationId: string;
    userId: string;
    amounts: BudgetReservationAmounts;
    usage: InferenceBudgetUsage;
    limits: EffectiveInferenceLimits;
    isCompaction: boolean;
    /**
     * The source the request runs on: the monthly API budget gates only API sources, and the subscription credit
     * windows only subscription sources.
     */
    sourceType: 'api' | 'subscription';
    /** The request has no API price: the monthly API budget does not cap it (API usage switched off still does). */
    apiBudgetExempt?: boolean;
  }): Promise<BudgetReservation> {
    const now = Date.now();
    const expiresAt = new Date(now + RESERVATION_TTL_MS);
    const dimensions: InferenceBudgetDimension[] = ['credits5h', 'credits7d', 'credits30d', 'apiMonthlyMicrodollars'];
    const limits = dimensions.map((dimension) => {
      if (dimension !== 'apiMonthlyMicrodollars') {
        return input.sourceType === 'api'
          ? UNLIMITED_RESERVATION_LIMIT
          : reservationLimit(dimension, input.limits, input.isCompaction);
      }
      return input.sourceType !== 'api' || (input.apiBudgetExempt && input.limits.apiMonthlyMicrodollars > 0)
        ? UNLIMITED_RESERVATION_LIMIT
        : reservationLimit(dimension, input.limits, input.isCompaction);
    });
    let result: unknown;
    try {
      result = await this.redis.eval(
        RESERVE_SCRIPT,
        8,
        ...reservationKeys(input.userId),
        now,
        input.reservationId,
        ...dimensions.map((dimension) => input.amounts[dimension]),
        ...dimensions.map((dimension) => input.usage[dimension]),
        ...limits,
        ...reservationWindowIds(input.usage),
        expiresAt.getTime(),
        SUBSCRIPTION_ADMISSION_OVERAGE_CREDITS
      );
    } catch (error) {
      throw new InferenceProtocolError(503, 'reservation_unavailable', 'Budget admission is temporarily unavailable', {
        cause: error,
      });
    }
    const values = Array.isArray(result) ? result.map(Number) : [Number(result)];
    const rejected = values[0];
    if (
      !Array.isArray(result) ||
      !Number.isInteger(rejected) ||
      rejected! < 0 ||
      rejected! > dimensions.length ||
      (rejected === 0 && (values.length !== 9 || values.some((value) => !Number.isFinite(value) || value < 0)))
    ) {
      throw new InferenceProtocolError(503, 'reservation_unavailable', 'Invalid budget reservation response');
    }
    if (rejected! > 0) {
      const dimension = dimensions[rejected! - 1]!;
      const recoveryAt = recoveryFor(dimension, input.usage);
      throw new InferenceProtocolError(
        429,
        dimension === 'apiMonthlyMicrodollars' ? 'api_budget_exhausted' : 'subscription_budget_exhausted',
        'Inference budget exhausted',
        { recoveryAt: recoveryAt.toISOString(), dimension: publicDimension(dimension) }
      );
    }
    const amounts =
      values.length === dimensions.length * 2 + 1
        ? Object.fromEntries(dimensions.map((dimension, index) => [dimension, values[index + 1] ?? 0]))
        : input.amounts;
    const admittedAmounts =
      values.length === dimensions.length * 2 + 1
        ? Object.fromEntries(
            dimensions.map((dimension, index) => [dimension, (values[index + 1] ?? 0) + (values[index + 5] ?? 0)])
          )
        : amounts;
    const reservation = {
      id: input.reservationId,
      userId: input.userId,
      amounts: amounts as BudgetReservationAmounts,
      admittedAmounts: admittedAmounts as BudgetReservationAmounts,
      expiresAt,
    };
    this.startRenewal(reservation);
    return reservation;
  }

  async release(reservation: Pick<BudgetReservation, 'id' | 'userId'>): Promise<void> {
    this.stopRenewal(reservation);
    try {
      await this.redis.eval(RELEASE_SCRIPT, 8, ...reservationKeys(reservation.userId), reservation.id);
    } catch {
      // The reservation has a bounded TTL. Keeping it on Redis failure is fail-closed.
    }
  }

  /** Keep the debit held for late settlement, but bound an abandoned lease by its Redis TTL. */
  awaitSettlement(reservation: Pick<BudgetReservation, 'id' | 'userId'>): void {
    this.stopRenewal(reservation);
  }

  async isActive(reservation: Pick<BudgetReservation, 'id' | 'userId'>): Promise<boolean> {
    const keys = reservationKeys(reservation.userId);
    const values = await Promise.all([1, 3, 5, 7].map((index) => this.redis.hexists(keys[index]!, reservation.id)));
    return values.some((value) => value === 1);
  }

  private startRenewal(reservation: BudgetReservation): void {
    this.stopRenewal(reservation);
    const timer = setInterval(() => {
      void this.renew(reservation).catch(() => undefined);
    }, RESERVATION_HEARTBEAT_MS);
    timer.unref();
    this.renewals.set(renewalKey(reservation), timer);
  }

  private stopRenewal(reservation: Pick<BudgetReservation, 'id' | 'userId'>): void {
    const key = renewalKey(reservation);
    const timer = this.renewals.get(key);
    if (timer) clearInterval(timer);
    this.renewals.delete(key);
  }

  private async renew(reservation: BudgetReservation): Promise<void> {
    const now = Date.now();
    const expiresAt = new Date(now + RESERVATION_TTL_MS);
    const found = await this.redis.eval(
      RENEW_SCRIPT,
      8,
      ...reservationKeys(reservation.userId),
      reservation.id,
      now,
      expiresAt.getTime()
    );
    if (Number(found) === 0) this.stopRenewal(reservation);
    else reservation.expiresAt = expiresAt;
  }
}

function renewalKey(reservation: Pick<BudgetReservation, 'id' | 'userId'>): string {
  return `${reservation.userId}:${reservation.id}`;
}

function reservationKeys(userId: string): string[] {
  const prefix = `inference:budget:{${userId}}`;
  return ['5h', '7d', '30d', 'api'].flatMap((dimension) => [
    `${prefix}:${dimension}:expiries`,
    `${prefix}:${dimension}:amounts`,
  ]);
}

function reservationLimit(
  dimension: InferenceBudgetDimension,
  limits: EffectiveInferenceLimits,
  _isCompaction: boolean
): number {
  const value = limits[dimension];
  if (dimension === 'credits5h' && !limits.credits5hEnabled) return UNLIMITED_RESERVATION_LIMIT;
  if (dimension === 'credits7d' && !limits.credits7dEnabled) return UNLIMITED_RESERVATION_LIMIT;
  if (dimension === 'credits30d' && !limits.credits30dEnabled) return UNLIMITED_RESERVATION_LIMIT;
  return value;
}

function recoveryFor(dimension: InferenceBudgetDimension, usage: InferenceBudgetUsage): Date {
  if (dimension === 'apiMonthlyMicrodollars') return usage.recoveryAt.apiMonthly;
  return usage.recoveryAt[dimension];
}

function publicDimension(dimension: InferenceBudgetDimension): string {
  if (dimension === 'apiMonthlyMicrodollars') return 'monthly';
  return dimension.replace('credits', '').toLowerCase();
}

function reservationWindowIds(usage: InferenceBudgetUsage): string[] {
  return [
    usage.recoveryAt.credits5h,
    usage.recoveryAt.credits7d,
    usage.recoveryAt.credits30d,
    usage.recoveryAt.apiMonthly,
  ].map((date) => String(date.getTime()));
}

export const __testOnly = { reservationKeys, reservationLimit, reservationWindowIds, publicDimension };
