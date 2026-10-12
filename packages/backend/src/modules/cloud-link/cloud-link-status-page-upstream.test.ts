import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { StatusPageService } from '@/modules/status-page/status-page.service.js';
import type { AppEnv } from '@/types.js';
import { CloudLinkService } from './cloud-link.service.js';
import { assertStatusPageUpstreamUnchanged, statusPageUpstreamGuard } from './cloud-link-status-page-upstream.js';

function register(managed: boolean, upstreamUrl: string | null) {
  container.registerInstance(CloudLinkService, {
    managedByCloud: vi.fn().mockResolvedValue(managed),
  } as unknown as CloudLinkService);
  container.registerInstance(StatusPageService, {
    getConfig: vi.fn().mockResolvedValue({ upstreamUrl }),
  } as unknown as StatusPageService);
}

afterEach(() => {
  container.clearInstances();
});

describe('status page upstream on a managed installation', () => {
  it('refuses a change and accepts the same value resubmitted', async () => {
    register(true, 'http://127.0.0.1:3000');
    await expect(assertStatusPageUpstreamUnchanged({ upstreamUrl: 'http://10.0.0.5:3000' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CLOUD_MANAGED',
    });
    await expect(assertStatusPageUpstreamUnchanged({ upstreamUrl: '' })).rejects.toMatchObject({
      code: 'CLOUD_MANAGED',
    });
    await expect(
      assertStatusPageUpstreamUnchanged({ upstreamUrl: ' http://127.0.0.1:3000 ' })
    ).resolves.toBeUndefined();
    await expect(assertStatusPageUpstreamUnchanged({})).resolves.toBeUndefined();
  });

  it('lets an installation that is not managed change it', async () => {
    register(false, null);
    await expect(assertStatusPageUpstreamUnchanged({ upstreamUrl: 'http://10.0.0.5:3000' })).resolves.toBeUndefined();
  });

  it('answers the settings route with 409 before the route runs, and passes other updates through', async () => {
    register(true, null);
    const route = vi.fn((_body: unknown) => undefined);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.put('/settings', statusPageUpstreamGuard);
    app.put('/settings', async (c) => {
      route(await c.req.json());
      return c.json({ data: 'saved' });
    });
    const put = (body: unknown) =>
      app.request('/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const refused = await put({ enabled: true, upstreamUrl: 'http://10.0.0.5:3000' });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'CLOUD_MANAGED' });
    expect(route).not.toHaveBeenCalled();

    const saved = await put({ enabled: true, upstreamUrl: null, domain: 'status.example.com' });
    expect(saved.status).toBe(200);
    expect(route).toHaveBeenCalledWith({ enabled: true, upstreamUrl: null, domain: 'status.example.com' });
  });
});
