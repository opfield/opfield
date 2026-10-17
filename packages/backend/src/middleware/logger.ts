import type { Context, MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import { logger } from '@/lib/logger.js';
import { ONE_TIME_LINK_TOKEN_PATH } from '@/lib/one-time-link-path.js';
import { requestStats } from '@/modules/diagnostics/request-stats.js';
import type { AppEnv } from '@/types.js';
import { LEGACY_HEALTH_PROBE_HEADER } from '@/lib/legacy-compat.js';

const DOCKER_WEBHOOK_TOKEN_PATH = /^(\/api\/webhooks\/docker\/)[^/]+(?=\/|$)/;

export function redactRequestPath(path: string): string {
  return path.replace(DOCKER_WEBHOOK_TOKEN_PATH, '$1[REDACTED]').replace(ONE_TIME_LINK_TOKEN_PATH, '$1[REDACTED]');
}

export const loggerMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const start = Date.now();
  const requestId = c.get('requestId');
  const method = c.req.method;
  const path = redactRequestPath(c.req.path);

  logger.info('Incoming request', {
    requestId,
    method,
    path,
    ...(path === '/health'
      ? {
          healthProbe:
            c.req.header('x-opfield-health-probe') ??
            // legacy-name: LEGACY_HEALTH_PROBE_HEADER — sent by a browser that still runs the console of a release before
            // 2.12.1 (cached across the update) — remove once no supported update starts from a version before 2.12.1.
            c.req.header(LEGACY_HEALTH_PROBE_HEADER) ??
            'unattributed',
        }
      : {}),
    userAgent: c.req.header('user-agent'),
  });

  await next();

  const duration = Date.now() - start;
  const status = c.res.status;

  // A protocol switch (WebSocket) is not a request that completes, so it would skew latency.
  if (status !== 101) requestStats.record(matchedRoutePath(c), status, duration);

  const logLevel = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';

  logger[logLevel]('Request completed', {
    requestId,
    method,
    path,
    status,
    duration: `${duration}ms`,
  });
};

/** The route pattern (`/api/nodes/:id`) that answered, so statistics group requests without IDs. */
function matchedRoutePath(c: Context<AppEnv>): string | null {
  try {
    const path = routePath(c);
    return path && path !== '*' && path !== '/*' ? `${c.req.method} ${path}` : null;
  } catch {
    return null;
  }
}
