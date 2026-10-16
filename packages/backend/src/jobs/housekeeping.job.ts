import { createChildLogger } from '@/lib/logger.js';
import type { HousekeepingService } from '@/services/housekeeping.service.js';

const logger = createChildLogger('HousekeepingJob');

export class HousekeepingJob {
  constructor(private readonly housekeepingService: HousekeepingService) {}

  async run(): Promise<void> {
    logger.debug('Running scheduled housekeeping');
    try {
      const config = await this.housekeepingService.getConfig();
      // With Housekeeping off, what keeps Opfield's own data bounded (registry, history, build logs, inference usage,
      // tokens, host files) still runs; everything else waits until it is turned back on.
      if (!config.enabled) logger.debug('Housekeeping is off: running only the categories that bound Opfield data');
      const result = await this.housekeepingService.runAll('scheduled', undefined, { safetyOnly: !config.enabled });
      if (result.overallSuccess) {
        logger.info('Housekeeping completed successfully', {
          durationMs: result.totalDurationMs,
          categories: result.categories.length,
        });
      } else {
        const failures = result.categories.filter((c) => !c.success);
        logger.warn('Housekeeping completed with errors', {
          durationMs: result.totalDurationMs,
          failures: failures.map((f) => ({ category: f.category, error: f.error })),
        });
      }
    } catch (error) {
      logger.error('Housekeeping job failed', { error });
    }
  }
}
