import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { watchLegacySignInRoute, withdrawLegacySignInRoute } from './access-signin.registration.js';

const SERVING_NODE = '33333333-3333-4333-8333-333333333333';

function legacyRoute(removal: () => Promise<void> = async () => {}) {
  return {
    removeLegacySystemRoute: vi.fn(removal),
    legacySystemRouteServedBy: vi.fn(async (nodeId: string) => nodeId === SERVING_NODE),
  };
}

function eventBus() {
  const handlers: Array<(payload: unknown) => void> = [];
  return {
    subscribe: (event: string, handler: (payload: unknown) => void) => {
      if (event === 'node.changed') handlers.push(handler);
      return () => {};
    },
    publish: (payload: unknown) => {
      for (const handler of handlers) handler(payload);
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('old sign-in domain route', () => {
  it('is withdrawn as soon as a node that serves it connects', async () => {
    const route = legacyRoute();
    const bus = eventBus();
    watchLegacySignInRoute(bus as never, route as never);

    bus.publish({ id: SERVING_NODE, action: 'updated', status: 'offline' });
    bus.publish({ id: '44444444-4444-4444-8444-444444444444', action: 'updated', status: 'online' });
    await settle();
    expect(route.removeLegacySystemRoute).not.toHaveBeenCalled();

    bus.publish({ id: SERVING_NODE, action: 'updated', status: 'online' });
    await settle();
    expect(route.legacySystemRouteServedBy).toHaveBeenLastCalledWith(SERVING_NODE);
    expect(route.removeLegacySystemRoute).toHaveBeenCalledTimes(1);
  });

  it('runs one withdrawal at a time and keeps going after a failure (the next trigger retries)', async () => {
    let finish!: () => void;
    const route = legacyRoute(() => new Promise<void>((resolve) => (finish = resolve)));
    const first = withdrawLegacySignInRoute('startup', route);
    const second = withdrawLegacySignInRoute('node connected', route);
    expect(route.removeLegacySystemRoute).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([first, second]);

    const failing = legacyRoute(async () => {
      throw new Error('node offline');
    });
    await expect(withdrawLegacySignInRoute('startup', failing)).resolves.toBeUndefined();
    await withdrawLegacySignInRoute('maintenance', failing);
    expect(failing.removeLegacySystemRoute).toHaveBeenCalledTimes(2);
  });
});
