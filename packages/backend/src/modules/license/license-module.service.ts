import type { CommercialEditionRuntime } from '@/edition/runtime.js';
import { createChildLogger } from '@/lib/logger.js';
import { parseSemver } from '@/lib/semver.js';
import { AppError } from '@/middleware/error-handler.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { UpdateService } from '@/services/update.service.js';
import type { LicenseService } from './license.service.js';

const logger = createChildLogger('LicenseModuleService');

/** Activate the matching core through the ordinary verified update/rollback path. */
export class LicenseModuleService {
  private preparation?: Promise<{ restarting: boolean }>;

  constructor(
    private readonly license: LicenseService,
    private readonly edition: CommercialEditionRuntime,
    private readonly updates: UpdateService,
    private readonly events: EventBusService,
    private readonly schedule: (work: () => void) => void = (work) => {
      setTimeout(work, 500);
    }
  ) {}

  ensureAvailable(): Promise<{ restarting: boolean }> {
    if (this.edition.status.state === 'ready') return Promise.resolve({ restarting: false });
    if (this.preparation) return this.preparation;
    const preparation = this.prepare();
    this.preparation = preparation;
    void preparation.catch(() => {
      if (this.preparation === preparation) this.preparation = undefined;
    });
    return preparation;
  }

  private async prepare(): Promise<{ restarting: boolean }> {
    const version = this.updates.getCurrentVersion();
    if (!parseSemver(version))
      throw new AppError(
        409,
        'COMMERCIAL_MODULE_ACTIVATION_UNAVAILABLE',
        'Automatic activation requires a released Opfield version'
      );
    // Activation restarts Gateway through the update path: never start it on top of a running update.
    this.assertNoUpdateInProgress();
    const grant = await this.license.authorizeCommercialUpdate(version);
    if (grant.edition !== 'commercial')
      throw new AppError(403, 'LICENSE_ENTITLEMENT_REQUIRED', 'A paid license is required to activate paid features');
    const artifact = await this.updates.prepareGatewayUpdate(version);
    // Re-checked after the downloads; this also refuses while a Relay Pool update runs.
    await this.updates.assertGatewayUpdateAllowed();
    // A new attempt supersedes the report of a previous rolled-back one.
    await this.updates.acknowledgeGatewayUpdateFailure();
    this.events.publish('system.update.changed', { updating: true, component: 'gateway', targetVersion: version });
    // Send the activation response before the update can replace this process.
    // performUpdate stages/verifies private files while this Gateway still serves traffic.
    this.schedule(() => {
      void this.updates.performUpdate(version, artifact).catch((error) => {
        this.preparation = undefined;
        // Another update won the race and keeps running: its screen must stay.
        if (error instanceof AppError && error.code === 'UPDATE_IN_PROGRESS') {
          logger.warn('Paid feature activation deferred: a Gateway update is already in progress');
          return;
        }
        this.events.publish('system.update.changed', { updating: false, component: 'gateway', targetVersion: version });
        logger.error('Paid feature activation failed before completion', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    });
    return { restarting: true };
  }

  private assertNoUpdateInProgress(): void {
    if (this.updates.isGatewayUpdateInProgress())
      throw new AppError(
        409,
        'UPDATE_IN_PROGRESS',
        'An Opfield update is in progress. Activate paid features after it has finished.'
      );
  }
}
