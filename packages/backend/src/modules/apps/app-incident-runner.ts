import { type OperationLeaseStore, operationLeaseKey } from '@/db/operation-lease.js';
import type { AppIncident, AppIncidentItem } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { AppIncidentActions } from './app-incident-actions.js';
import type { AppIncidentsRepo } from './app-incidents.repo.js';

const logger = createChildLogger('AppIncidentRunner');

/** Items applied side by side within one phase (each mostly waits on a daemon). */
const PHASE_CONCURRENCY = 4;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function inBatches<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  for (let index = 0; index < items.length; index += size) {
    await Promise.all(items.slice(index, index + size).map(run));
  }
}

function byPhase(items: readonly AppIncidentItem[], direction: 'asc' | 'desc'): AppIncidentItem[][] {
  const phases = [...new Set(items.map((item) => item.phase))].sort((a, b) => (direction === 'asc' ? a - b : b - a));
  return phases.map((phase) => items.filter((item) => item.phase === phase));
}

export interface IncidentRunHooks {
  /** After every run step (state or item changes): realtime `apps` event and the freeze cache. */
  changed(incident: AppIncident): void;
  /** When an incident reaches `released` (audit, overlay recompute already done by items). */
  released?(incident: AppIncident): Promise<void>;
}

/**
 * Runs incidents: applies pending/failed items phase by phase (ascending) while the incident is applying or active,
 * and restores every item from its recorded prior state phase by phase (descending) while it is releasing. Failures
 * stay on the item (failed / restore_failed) and are retried by the next run (the 30 s job and node reconnects); the
 * incident ends `released` once every item is restored or gone. One run per incident at a time across processes
 * (operation lease), and within this process.
 */
export class AppIncidentRunner {
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly repo: AppIncidentsRepo,
    private readonly actions: AppIncidentActions,
    private readonly hooks: IncidentRunHooks,
    private readonly leases: Pick<OperationLeaseStore, 'claim' | 'hold' | 'release'>
  ) {}

  /** Start (or join) a run of one incident. */
  run(incidentId: string): Promise<void> {
    const current = this.running.get(incidentId);
    if (current) return current;
    const promise = this.runLeased(incidentId)
      .catch((error) => {
        logger.warn('App incident run failed', { incidentId, error: errorMessage(error) });
      })
      .finally(() => {
        if (this.running.get(incidentId) === promise) this.running.delete(incidentId);
      });
    this.running.set(incidentId, promise);
    return promise;
  }

  /** Runs every open incident with work left (retry job, node reconnect, startup). */
  async runOpen(): Promise<void> {
    for (const incident of await this.repo.open()) {
      const items = await this.repo.items(incident.id);
      const work =
        incident.state === 'releasing'
          ? items.some((item) => item.status !== 'restored' && item.status !== 'gone')
          : incident.state === 'applying' ||
            items.some((item) => item.status === 'pending' || item.status === 'failed');
      if (work) await this.run(incident.id);
    }
  }

  private async runLeased(incidentId: string): Promise<void> {
    const key = operationLeaseKey('app-incident', incidentId);
    const claim = await this.leases.claim([key], { incidentId });
    if (!claim.acquired) return;
    const hold = this.leases.hold(() => [key], claim.token, undefined, { since: claim.claimedAt });
    try {
      const incident = await this.repo.get(incidentId);
      if (!incident) return;
      if (incident.state === 'applying' || incident.state === 'active') await this.applyItems(incident);
      else if (incident.state === 'releasing') await this.restoreItems(incident);
    } finally {
      hold.stop();
      await this.leases.release([key], claim.token).catch(() => undefined);
    }
  }

  private async applyItems(incident: AppIncident): Promise<void> {
    const items = (await this.repo.items(incident.id)).filter(
      (item) => item.status === 'pending' || item.status === 'failed'
    );
    for (const phase of byPhase(items, 'asc')) {
      await inBatches(phase, PHASE_CONCURRENCY, async (item) => {
        // The incident may have been released meanwhile: stop applying.
        const current = await this.repo.get(incident.id);
        if (!current || (current.state !== 'applying' && current.state !== 'active')) return;
        try {
          const outcome = await this.actions.apply(item, { incidentId: incident.id, userId: incident.startedById });
          await this.repo.updateItem(item.id, {
            status: outcome.status === 'gone' ? 'gone' : 'applied',
            priorState: outcome.status === 'applied' ? outcome.priorState : item.priorState,
            attempts: item.attempts + 1,
            lastError: null,
          });
        } catch (error) {
          await this.repo.updateItem(item.id, {
            status: 'failed',
            attempts: item.attempts + 1,
            lastError: errorMessage(error),
          });
        }
      });
      this.hooks.changed(incident);
    }
    const after = await this.repo.get(incident.id);
    if (!after || (after.state !== 'applying' && after.state !== 'active')) return;
    const failed = (await this.repo.items(incident.id)).filter((item) => item.status === 'failed').length;
    const updated = await this.repo.setState(incident.id, 'active', {
      lastError: failed > 0 ? `${failed} item${failed === 1 ? '' : 's'} could not be applied yet; retrying` : null,
    });
    if (updated) this.hooks.changed(updated);
  }

  private async restoreItems(incident: AppIncident): Promise<void> {
    const items = (await this.repo.items(incident.id)).filter(
      (item) => item.status !== 'restored' && item.status !== 'gone'
    );
    for (const phase of byPhase(items, 'desc')) {
      await inBatches(phase, PHASE_CONCURRENCY, async (item) => {
        // Nothing was changed for an item that never applied (a failed apply rolls itself back), except route
        // overlays, which are in effect from their creation.
        if (!item.priorState && item.itemKind !== 'route_overlay') {
          await this.repo.updateItem(item.id, { status: 'restored', lastError: null });
          return;
        }
        try {
          if (item.itemKind === 'route_overlay') await this.repo.updateItem(item.id, { status: 'restored' });
          const outcome = await this.actions.restore(item, { incidentId: incident.id, userId: incident.releasedById });
          await this.repo.updateItem(item.id, {
            status: outcome.status === 'gone' ? 'gone' : 'restored',
            attempts: item.attempts + 1,
            lastError: null,
          });
        } catch (error) {
          await this.repo.updateItem(item.id, {
            status: 'restore_failed',
            attempts: item.attempts + 1,
            lastError: errorMessage(error),
          });
        }
      });
      this.hooks.changed(incident);
    }
    const remaining = (await this.repo.items(incident.id)).filter(
      (item) => item.status !== 'restored' && item.status !== 'gone'
    ).length;
    if (remaining > 0) {
      await this.repo.setLastError(
        incident.id,
        `${remaining} item${remaining === 1 ? '' : 's'} could not be restored yet; retrying`
      );
      this.hooks.changed(incident);
      return;
    }
    const released = await this.repo.setState(incident.id, 'released', { releasedAt: new Date(), lastError: null });
    if (released) {
      this.hooks.changed(released);
      await this.hooks.released?.(released);
    }
  }
}
