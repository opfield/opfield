import { createChildLogger } from '@/lib/logger.js';
import type { SiemDeliveryService } from '@/modules/audit/siem-delivery.service.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';

const logger = createChildLogger('SiemDeliveryJob');

/**
 * Thin scheduler adapter. Delivery state, leases, and retries live in the
 * database service so every Opfield replica can safely run this job.
 */
export class SiemDeliveryJob {
  constructor(
    private readonly deliveryService: SiemDeliveryService,
    private readonly generalSettingsService: GeneralSettingsService
  ) {}

  async run(): Promise<void> {
    try {
      if (!(await this.generalSettingsService.isFeatureEnabled('siemEnabled'))) return;
      await this.deliveryService.runDueDeliveries();
    } catch (error) {
      logger.error('SIEM delivery job failed', { error });
    }
  }
}
