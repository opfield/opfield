import type { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { requireScopeBase } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { missingRouteDomainsRoute } from './proxy.docs.js';
import { MissingRouteDomainsSchema } from './proxy.schemas.js';
import { ProxyService } from './proxy.service.js';
import { planMissingRouteDomains } from './route-missing-domains.js';

/** POST /proxy-hosts/missing-domains: what createMissingDomains would create for a route about to be created. */
export function registerMissingRouteDomainsRoutes(router: OpenAPIHono<AppEnv>): void {
  router.openapi({ ...missingRouteDomainsRoute, middleware: requireScopeBase('proxy:create') }, async (c) => {
    const input = MissingRouteDomainsSchema.parse(await c.req.json());
    const scopes = c.get('effectiveScopes') || [];
    // Like a create: without nodeId the node or group of its registered domains, or the caller's only node.
    const placement =
      input.nodeId && !input.ingressGroupId
        ? { nodeId: input.nodeId, ingressGroupId: null }
        : await container.resolve(ProxyService).resolveRouteIngressNode(scopes, input);
    const data = await planMissingRouteDomains(scopes, {
      domainNames: input.domainNames,
      folderId: input.folderId ?? null,
      nodeId: placement.nodeId,
      ingressGroupId: placement.ingressGroupId,
    });
    return c.json({ data });
  });
}
