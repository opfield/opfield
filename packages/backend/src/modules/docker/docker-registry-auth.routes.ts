import { Hono } from 'hono';
import { container } from '@/container.js';
import { getClientIpForContext } from '@/lib/request-ip.js';
import { hasTokenPrefix } from '@/lib/token-prefixes.js';
import { AppError } from '@/middleware/error-handler.js';
import { demoRestriction, isDemoMode } from '@/modules/demo/demo-mode.js';
import {
  REGISTRY_REPOSITORY_PATTERN,
  type RegistryAction,
  type RegistryRepositoryWorkloads,
  tokenAllowsRegistryAction,
} from '@/modules/tokens/token-registry-access.js';
import { registryRepositoryWorkloads } from '@/modules/tokens/token-registry-workloads.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import type { AppEnv } from '@/types.js';
import { DockerInternalRegistryService } from './docker-registry-internal.service.js';
import { configuredRegistryTokenService, isRegistryTokenService } from './docker-registry-token.service.js';

const MAX_SCOPE_COUNT = 64;
const MAX_SCOPE_LENGTH = 1024;

export const dockerRegistryAuthRoutes = new Hono<AppEnv>();

function basicPassword(header: string | undefined): string | null {
  if (!header?.startsWith('Basic ')) return null;
  const encoded = header.slice(6).trim();
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  const password = decoded.slice(separator + 1);
  return hasTokenPrefix(password, 'api') ? password : null;
}

function requestedRegistryGrants(url: URL) {
  const rawScopes = url.searchParams
    .getAll('scope')
    .flatMap((value) => value.split(/\s+/))
    .filter(Boolean);
  if (rawScopes.length > MAX_SCOPE_COUNT || rawScopes.some((scope) => scope.length > MAX_SCOPE_LENGTH)) {
    throw new AppError(400, 'REGISTRY_SCOPE_INVALID', 'Registry scope request is too large');
  }
  return rawScopes.map((scope) => {
    const match = /^repository:([^:]+):([^:]+)$/.exec(scope);
    if (!match || !REGISTRY_REPOSITORY_PATTERN.test(match[1]!)) {
      throw new AppError(400, 'REGISTRY_SCOPE_INVALID', 'Registry repository scope is invalid');
    }
    const actions = [...new Set(match[2]!.split(',').filter(Boolean))];
    if (!actions.length || actions.some((action) => action !== 'pull' && action !== 'push')) {
      throw new AppError(400, 'REGISTRY_SCOPE_INVALID', 'Registry action scope is invalid');
    }
    return { repository: match[1]!, actions: actions as Array<'pull' | 'push'> };
  });
}

dockerRegistryAuthRoutes.get('/token', async (c) => {
  if (isDemoMode()) throw demoRestriction('Use external registry automation');
  const registry = container.resolve(DockerInternalRegistryService);
  await registry.assertExternalAccessEntitled();

  const service = c.req.query('service') || configuredRegistryTokenService();
  if (!isRegistryTokenService(service)) {
    throw new AppError(403, 'REGISTRY_SERVICE_DENIED', 'Registry token audience is not allowed');
  }
  const rawToken = basicPassword(c.req.header('Authorization'));
  const authenticated = rawToken
    ? await container.resolve(TokensService).validateToken(rawToken, { clientIp: await getClientIpForContext(c) })
    : null;
  if (!authenticated) {
    c.header('WWW-Authenticate', 'Basic realm="Opfield Internal Registry"');
    c.header('Cache-Control', 'no-store');
    return c.json({ code: 'REGISTRY_AUTH_REQUIRED', message: 'Valid Opfield API token required' }, 401);
  }

  const requested = requestedRegistryGrants(new URL(c.req.url));
  // The token's registry access (not its scopes), bounded by what its owner may do with the workloads using each
  // repository right now.
  const ownerScopes = authenticated.user.accountScopes ?? authenticated.user.scopes;
  const workloads = new Map<string, ReturnType<RegistryRepositoryWorkloads>>();
  const workloadsOf: RegistryRepositoryWorkloads = (repository) => {
    if (!workloads.has(repository)) workloads.set(repository, registryRepositoryWorkloads(repository));
    return workloads.get(repository)!;
  };
  const allowed: typeof requested = [];
  for (const grant of requested) {
    const actions: RegistryAction[] = [];
    for (const action of grant.actions) {
      if (
        await tokenAllowsRegistryAction(
          authenticated.registryAccess,
          ownerScopes,
          action,
          grant.repository,
          workloadsOf
        )
      ) {
        actions.push(action);
      }
    }
    allowed.push({ repository: grant.repository, actions });
  }
  if (allowed.some((grant, index) => grant.actions.length !== requested[index]!.actions.length)) {
    throw new AppError(403, 'REGISTRY_SCOPE_DENIED', 'API token does not grant the requested registry action');
  }

  const issued = await registry.issueToken({
    subject: `api-token:${authenticated.tokenId}:${authenticated.user.id}`,
    service,
    requested,
    allowed,
    ttlSeconds: 300,
    externalAccess: true,
  });
  c.header('Cache-Control', 'no-store');
  return c.json({
    token: issued.token,
    access_token: issued.accessToken,
    expires_in: issued.expiresIn,
    issued_at: issued.issuedAt,
  });
});

export const __testOnly = { basicPassword, requestedRegistryGrants };
