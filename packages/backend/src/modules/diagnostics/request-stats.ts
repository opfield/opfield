/**
 * Rolling statistics of the API requests this process handled, fed by the request logger. Kept in
 * memory for an hour in one-minute buckets; the diagnostics sampler stores one summary per minute
 * for the longer history.
 */

const BUCKET_MS = 60_000;
const RETAINED_BUCKETS = 60;
/** Latencies kept per bucket for percentiles; beyond this a reservoir sample stands in for all. */
const BUCKET_LATENCY_SAMPLES = 2_000;
const ROUTE_LATENCY_SAMPLES = 200;
const UNMATCHED_ROUTE = '(no route)';

interface Tally {
  count: number;
  errors5xx: number;
  errors4xx: number;
  maxMs: number;
  totalMs: number;
  latencies: number[];
}

interface Bucket extends Tally {
  minute: number;
  routes: Map<string, Tally>;
}

export interface RequestSummary {
  from: string;
  to: string;
  count: number;
  errors5xx: number;
  errors4xx: number;
  /** Share of requests that ended with a 5xx status, in percent; null without requests. */
  errorRatePercent: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
}

export interface RouteSummary extends Omit<RequestSummary, 'from' | 'to'> {
  route: string;
  avgMs: number | null;
}

function emptyTally(): Tally {
  return { count: 0, errors5xx: 0, errors4xx: 0, maxMs: 0, totalMs: 0, latencies: [] };
}

function addToTally(tally: Tally, status: number, durationMs: number, sampleLimit: number): void {
  tally.count += 1;
  if (status >= 500) tally.errors5xx += 1;
  else if (status >= 400) tally.errors4xx += 1;
  tally.totalMs += durationMs;
  tally.maxMs = Math.max(tally.maxMs, durationMs);
  if (tally.latencies.length < sampleLimit) {
    tally.latencies.push(durationMs);
  } else {
    // Reservoir sampling keeps an unbiased sample of every request in the bucket.
    const slot = Math.floor(Math.random() * tally.count);
    if (slot < sampleLimit) tally.latencies[slot] = durationMs;
  }
}

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? null;
}

function summarizeTallies(tallies: Tally[]): Omit<RequestSummary, 'from' | 'to'> {
  const count = tallies.reduce((sum, tally) => sum + tally.count, 0);
  const errors5xx = tallies.reduce((sum, tally) => sum + tally.errors5xx, 0);
  const errors4xx = tallies.reduce((sum, tally) => sum + tally.errors4xx, 0);
  const latencies = tallies.flatMap((tally) => tally.latencies).sort((a, b) => a - b);
  return {
    count,
    errors5xx,
    errors4xx,
    errorRatePercent: count > 0 ? Math.round((errors5xx / count) * 10_000) / 100 : null,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    maxMs: count > 0 ? Math.max(...tallies.map((tally) => tally.maxMs)) : null,
  };
}

export class RequestStats {
  private readonly buckets: Bucket[] = [];

  record(route: string | null, status: number, durationMs: number, now = Date.now()): void {
    const minute = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    let bucket = this.buckets.at(-1);
    if (!bucket || bucket.minute !== minute) {
      bucket = { ...emptyTally(), minute, routes: new Map() };
      this.buckets.push(bucket);
      while (this.buckets.length > RETAINED_BUCKETS) this.buckets.shift();
    }
    addToTally(bucket, status, durationMs, BUCKET_LATENCY_SAMPLES);
    const key = route || UNMATCHED_ROUTE;
    let routeTally = bucket.routes.get(key);
    if (!routeTally) {
      routeTally = emptyTally();
      bucket.routes.set(key, routeTally);
    }
    addToTally(routeTally, status, durationMs, ROUTE_LATENCY_SAMPLES);
  }

  /** All requests that started in [fromMs, toMs). */
  summarize(fromMs: number, toMs: number): RequestSummary {
    const buckets = this.buckets.filter((bucket) => bucket.minute >= fromMs && bucket.minute < toMs);
    return {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      ...summarizeTallies(buckets),
    };
  }

  /** Per-route statistics since fromMs, busiest first. */
  routes(fromMs: number): RouteSummary[] {
    const byRoute = new Map<string, Tally[]>();
    for (const bucket of this.buckets) {
      if (bucket.minute < fromMs) continue;
      for (const [route, tally] of bucket.routes) {
        const tallies = byRoute.get(route) ?? [];
        tallies.push(tally);
        byRoute.set(route, tallies);
      }
    }
    return [...byRoute]
      .map(([route, tallies]) => {
        const summary = summarizeTallies(tallies);
        const totalMs = tallies.reduce((sum, tally) => sum + tally.totalMs, 0);
        return { route, ...summary, avgMs: summary.count > 0 ? Math.round(totalMs / summary.count) : null };
      })
      .sort((a, b) => b.count - a.count);
  }

  /** Start of the oldest minute still held in memory. */
  oldestMinute(): number | null {
    return this.buckets[0]?.minute ?? null;
  }
}

export const requestStats = new RequestStats();
