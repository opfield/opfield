import type { Context } from 'hono';
import { getDeploymentMode } from '@/config/env.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AppEnv, User } from '@/types.js';

export const DEMO_ADMIN_GROUP_NAME = 'demo-admin';
export const DEMO_MODE_RESTRICTED = 'DEMO_MODE_RESTRICTED';
export const DEMO_MODE_CTA_URL = 'https://opfield.dev';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DEMO_READ_ONLY_POST_PATHS = [
  /^\/api\/monitoring\/dashboard\/bootstrap$/,
  /^\/api\/logging\/environments\/[^/]+\/search$/,
  /^\/api\/domains\/preview$/,
  /^\/api\/proxy-hosts\/validate-config$/,
  /^\/api\/nginx-templates\/(?:preview|test)$/,
  /^\/api\/docker\/nodes\/[^/]+\/compose-projects\/validate$/,
  /^\/api\/docker\/folders\/placements$/,
] as const;

const DEMO_ALWAYS_RESTRICTED_PATHS = [
  /^\/api\/(?:ai|mcp|oauth|inference)(?:\/|$)/,
  /^\/api\/audit(?:\/|$)/,
  /^\/api\/admin\/users\/[^/]+(?:\/|$)/,
  /^\/api\/tokens(?:\/|$)/,
  /\/webhooks?(?:\/|$)/,
  /^\/api\/nodes\/[^/]+\/files(?:\/|$)/,
  /^\/api\/nodes\/[^/]+\/config(?:\/|$)/,
  /^\/api\/docker\/nodes\/[^/]+\/(?:containers\/[^/]+|volumes\/[^/]+)\/files(?:\/|$)/,
  /^\/api\/docker\/nodes\/[^/]+\/containers\/[^/]+\/env(?:\/|$)/,
  /\/(?:exec|console)(?:\/|$)/,
  /\/(?:reveal-credentials|credentials\/reveal|secrets)(?:\/|$)/,
  /\/(?:query|sql)(?:\/|$)/,
  /\/(?:export|download)(?:\/|$)/,
  /\/(?:deploy-?tokens?|logging-?tokens?|tokens?)(?:\/|$)/,
] as const;

export function isDemoMode(): boolean {
  return getDeploymentMode() === 'demo';
}

export function isDemoVisitor(user: User | undefined): boolean {
  return (
    isDemoMode() &&
    Boolean(
      user &&
        (user.groupNames ?? [user.groupName]).includes(DEMO_ADMIN_GROUP_NAME) &&
        !isCanonicalSystemAdmin(user, user.scopes)
    )
  );
}

export function isCanonicalSystemAdmin(
  user: User | undefined,
  effectiveScopes: readonly string[] | undefined
): boolean {
  return Boolean(
    user && (user.groupNames ?? [user.groupName]).includes('system-admin') && effectiveScopes?.includes('admin:system')
  );
}

export function isDemoRealtimeCapabilityAllowed(
  user: User | undefined,
  effectiveScopes: readonly string[] | undefined,
  capability: string
): boolean {
  if (!isDemoMode() || isCanonicalSystemAdmin(user, effectiveScopes)) return true;
  return !capability.startsWith('ai:') && !capability.includes(':console');
}

export function demoRestriction(capability?: string): AppError {
  return new AppError(403, DEMO_MODE_RESTRICTED, 'This action is unavailable in demo mode.', {
    capability: capability?.trim() || 'Change Opfield configuration',
    ctaUrl: DEMO_MODE_CTA_URL,
  });
}

function isRestrictedPath(path: string): boolean {
  return DEMO_ALWAYS_RESTRICTED_PATHS.some((pattern) => pattern.test(path));
}

function isReadOnlyPost(path: string): boolean {
  return DEMO_READ_ONLY_POST_PATHS.some((pattern) => pattern.test(path));
}

/**
 * Enforce demo restrictions after authentication but before a route handler,
 * service write, credential read, WebSocket upgrade, or daemon dispatch.
 * Standard deployments return before inspecting the principal or path.
 */
export function assertDemoRequestAllowed(c: Context<AppEnv>): void {
  if (!isDemoMode()) return;

  const user = c.get('user');
  const scopes = c.get('effectiveScopes');
  if (isCanonicalSystemAdmin(user, scopes)) return;

  const method = c.req.method.toUpperCase();
  const path = new URL(c.req.url).pathname;
  if (path === '/auth/logout') return;
  if (!isRestrictedPath(path) && (SAFE_METHODS.has(method) || (method === 'POST' && isReadOnlyPost(path)))) return;

  throw demoRestriction();
}

export const __testOnly = {
  isReadOnlyPost,
  isRestrictedPath,
};
