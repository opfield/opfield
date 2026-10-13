import { injectable } from 'tsyringe';
import type { EventBusService } from '@/services/event-bus.service.js';

/** Live-event channel the UI listens on to refetch the inference model catalog. */
export const INFERENCE_CATALOG_CHANGED_CHANNEL = 'inference.catalog.changed';

export type InferenceCatalogEvent = {
  id: string;
  type: 'catalog.changed';
  occurredAt: string;
};

@injectable()
export class InferenceCatalogEventsService {
  private sequence = 0;

  constructor(private readonly eventBus: EventBusService) {
    // Catalog visibility can change without a model mutation when a user or
    // permission group changes. A global invalidation is intentionally cheap:
    // every open settings or usage view refetches what it shows.
    this.eventBus.subscribe('user.changed', () => this.publishCatalogChanged());
    this.eventBus.subscribe('group.changed', () => this.publishCatalogChanged());
  }

  publishCatalogChanged(): InferenceCatalogEvent {
    const event: InferenceCatalogEvent = {
      id: `${Date.now()}-${++this.sequence}`,
      type: 'catalog.changed',
      occurredAt: new Date().toISOString(),
    };
    this.eventBus.publish(INFERENCE_CATALOG_CHANGED_CHANNEL, event);
    return event;
  }
}
