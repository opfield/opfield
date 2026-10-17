import { AsyncResource } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { createChildLogger } from '@/lib/logger.js';

const logger = createChildLogger('EventBus');
const RETAINED_CHANNELS = new Set(['system.update.changed']);

/**
 * In-process realtime event bus.
 *
 * Designed with the same shape as a future Redis pub/sub interface so that
 * swapping the backing store later (for horizontal scaling) is mechanical.
 *
 * Channel naming: dotted strings, e.g. `docker.container.changed`,
 * `permissions.changed.<userId>`. Subscribers may subscribe to a literal
 * channel name only — no wildcards (kept simple to match Redis pub/sub).
 */
export class EventBusService {
  private emitter = new EventEmitter();
  private readonly retained = new Map<string, unknown>();

  constructor() {
    // Each connection gets its own listener; bump the cap so we don't see
    // spurious "MaxListenersExceededWarning" with many concurrent clients.
    this.emitter.setMaxListeners(0);
  }

  publish(channel: string, payload: unknown): void {
    try {
      if (RETAINED_CHANNELS.has(channel)) {
        const updating = (payload as { updating?: unknown } | null)?.updating;
        if (updating === true) this.retained.set(channel, payload);
        else if (updating === false) this.retained.delete(channel);
      }
      this.emitter.emit(channel, payload);
    } catch (err) {
      logger.error('event publish failed', { channel, error: err });
    }
  }

  /**
   * Subscribe to a channel. Returns an unsubscribe function. Always call
   * the returned function on connection close to avoid leaks.
   *
   * The handler runs in the async context of the subscription, never in the
   * publisher's: an event published inside an API request must not hand that
   * request's audit context (its user agent, IP, MCP token and tool arguments),
   * held locks or admission to the background work a subscriber starts (timers,
   * pulls, reconciliations). A Redis-backed bus would not carry it either.
   */
  subscribe(channel: string, fn: (payload: unknown) => void): () => void {
    const handler = AsyncResource.bind(fn);
    this.emitter.on(channel, handler);
    return () => {
      this.emitter.off(channel, handler);
    };
  }

  getRetained(channel: string): unknown | undefined {
    return this.retained.get(channel);
  }
}
