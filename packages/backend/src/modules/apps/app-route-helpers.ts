import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from '@/types.js';
import type { AppActor } from './apps.service.js';

export type AppsRouter = OpenAPIHono<AppEnv>;

/** The caller of an apps route: its user and effective (delegated, folder-expanded) scopes. */
export function appActor(c: Context<AppEnv>): AppActor {
  return { userId: c.get('user')!.id, scopes: c.get('effectiveScopes') || [] };
}
