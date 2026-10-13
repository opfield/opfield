import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import type { DatabaseMonitoringService } from '@/modules/databases/database-monitoring.service.js';
import type { ObjectStorageMonitoringService } from '@/modules/object-storage/object-storage-monitoring.service.js';

const logger = createChildLogger('AppOverview');

export type OverviewRange = '1h' | '24h';
export type OverviewSample = { timestamp: string; metrics: Record<string, number | null> };

/**
 * Samples per database or storage over the range: the core's overview series (one per 2.5 minutes, kept a day) when
 * it provides them, else the short live history the monitoring service keeps, else nothing (no commercial core).
 */
export async function overviewSamples(
  service: typeof DatabaseMonitoringService | typeof ObjectStorageMonitoringService,
  ids: readonly string[],
  range: OverviewRange
): Promise<Map<string, OverviewSample[]>> {
  const result = new Map<string, OverviewSample[]>();
  const token = service as unknown as typeof DatabaseMonitoringService;
  if (ids.length === 0 || !container.isRegistered(token)) return result;
  const monitoring = container.resolve(token) as unknown as {
    getOverviewSeries(ids: readonly string[], range: OverviewRange): Promise<Record<string, OverviewSample[]>>;
    getHistory(id: string): Promise<OverviewSample[]>;
  };
  try {
    const series = await monitoring.getOverviewSeries(ids, range);
    for (const id of ids) result.set(id, Array.isArray(series?.[id]) ? series[id] : []);
    return result;
  } catch (error) {
    logger.debug('Overview series unavailable; using the live history', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  for (const id of ids) {
    result.set(id, await monitoring.getHistory(id).catch(() => []));
  }
  return result;
}

/**
 * The newest known value of a metric over the samples: a sample that missed it (a poll right after a restart, before
 * the node reported) does not blank the card while its chart still shows the value.
 */
export function latestOf(samples: readonly OverviewSample[], metric: string): number | null {
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const raw = samples[index]!.metrics[metric];
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    if (value !== null) return value;
  }
  return null;
}
