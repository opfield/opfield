import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { proxyHosts } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { StatusPageService } from '@/modules/status-page/status-page.service.js';
import type { AppEnv } from '@/types.js';
import { CloudLinkService } from './cloud-link.service.js';

export const CLOUD_MANAGED_STATUS_PAGE_UPSTREAM_MESSAGE =
  'This Opfield installation is managed by the cloud; the status page upstream URL cannot be changed here.';

function normalizedUpstream(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * On a managed installation the internal Opfield URL the status page proxy host uses is the cloud's: a settings
 * update may resubmit it unchanged, never change it (HTTP route and MCP alike).
 */
export async function assertStatusPageUpstreamUnchanged(input: { upstreamUrl?: string | null }): Promise<void> {
  if (input.upstreamUrl === undefined) return;
  if (!(await container.resolve(CloudLinkService).managedByCloud())) return;
  const current = await container.resolve(StatusPageService).getConfig();
  if (normalizedUpstream(input.upstreamUrl) !== normalizedUpstream(current.upstreamUrl)) {
    throw new AppError(409, 'CLOUD_MANAGED', CLOUD_MANAGED_STATUS_PAGE_UPSTREAM_MESSAGE);
  }
}

/** Runs ahead of PUT /api/status-page/settings (after authentication) and refuses a managed upstream change. */
export const statusPageUpstreamGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  let body: unknown = null;
  try {
    body = await c.req.json();
  } catch {
    // The route itself answers a body it cannot read.
  }
  if (body && typeof body === 'object' && 'upstreamUrl' in body) {
    const upstreamUrl = (body as { upstreamUrl?: unknown }).upstreamUrl;
    if (upstreamUrl === null || typeof upstreamUrl === 'string')
      await assertStatusPageUpstreamUnchanged({ upstreamUrl });
  }
  await next();
};

export interface StatusPageUpstreamView {
  /** Managed cloud installation: the upstream is the cloud's and read-only. */
  cloudManaged: boolean;
  /** The console is served by Opfield itself on 443 (OPFIELD_CONSOLE_DOMAIN). */
  consoleDirect: boolean;
  /** Where the generated status page proxy host forwards to; null without one. */
  inUse: string | null;
}

/** The upstream the status page proxy host actually forwards to, for the read-only field of a managed installation. */
export async function readStatusPageUpstream(consoleDomain: string | undefined): Promise<StatusPageUpstreamView> {
  const db = container.resolve<DrizzleClient>(TOKENS.DrizzleClient);
  const [cloudManaged, host] = await Promise.all([
    container.resolve(CloudLinkService).managedByCloud(),
    db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.systemKind, 'status_page'),
      columns: { forwardScheme: true, forwardHost: true, forwardPort: true },
    }),
  ]);
  return {
    cloudManaged,
    consoleDirect: Boolean(consoleDomain?.trim()),
    inUse: host?.forwardHost ? `${host.forwardScheme}://${host.forwardHost}:${host.forwardPort}` : null,
  };
}
