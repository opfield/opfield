import { hasScope, hasScopeBase } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';

export const APP_VIEW_SCOPE = 'apps:view';
export const APP_CREATE_SCOPE = 'apps:create';
export const APP_EDIT_SCOPE = 'apps:edit';
export const APP_DELETE_SCOPE = 'apps:delete';
export const APP_ENV_MANAGE_SCOPE = 'apps:env:manage';
export const APP_PROMOTE_SCOPE = 'apps:promote';
export const APP_OPERATE_SCOPE = 'apps:operate';

/** Every app scope; holding any of them (any qualifier) lets a caller reach the apps API. */
export const APP_SCOPES = [
  APP_VIEW_SCOPE,
  APP_CREATE_SCOPE,
  APP_EDIT_SCOPE,
  APP_DELETE_SCOPE,
  APP_ENV_MANAGE_SCOPE,
  APP_PROMOTE_SCOPE,
  APP_OPERATE_SCOPE,
] as const;

export function envScopeTarget(environmentId: string): string {
  return `env/${environmentId}`;
}

/** Broad or on the whole app (`<base>:<appId>`). Action scopes imply view with the same qualifier. */
export function hasAppWideScope(scopes: readonly string[], base: string, appId: string): boolean {
  return hasScope(scopes, base) || hasScope(scopes, `${base}:${appId}`);
}

/** Broad, on the whole app, or on this environment (`<base>:env/<envId>`). */
export function hasAppScope(
  scopes: readonly string[],
  base: string,
  appId: string,
  environmentId?: string | null
): boolean {
  if (hasAppWideScope(scopes, base, appId)) return true;
  return !!environmentId && hasScope(scopes, `${base}:${envScopeTarget(environmentId)}`);
}

/** The environments of an app the caller may view (all of them with app-wide view). */
export function visibleEnvironmentIds(
  scopes: readonly string[],
  appId: string,
  environmentIds: readonly string[]
): string[] {
  if (hasAppWideScope(scopes, APP_VIEW_SCOPE, appId)) return [...environmentIds];
  return environmentIds.filter((id) => hasScope(scopes, `${APP_VIEW_SCOPE}:${envScopeTarget(id)}`));
}

export function canViewApp(scopes: readonly string[], appId: string, environmentIds: readonly string[]): boolean {
  return (
    visibleEnvironmentIds(scopes, appId, environmentIds).length > 0 || hasAppWideScope(scopes, APP_VIEW_SCOPE, appId)
  );
}

/** Any app scope at all (broad or qualified): the gate of the apps routes and tools; each action checks the app. */
export function hasAnyAppScope(scopes: readonly string[]): boolean {
  return APP_SCOPES.some((scope) => hasScopeBase([...scopes], scope));
}

export function assertAppWideScope(scopes: readonly string[], base: string, appId: string): void {
  if (!hasAppWideScope(scopes, base, appId)) {
    throw new AppError(403, 'FORBIDDEN', `Missing ${base} for this app`, { requiredScope: `${base}:${appId}` });
  }
}

export function assertAppScope(
  scopes: readonly string[],
  base: string,
  appId: string,
  environmentId?: string | null
): void {
  if (!hasAppScope(scopes, base, appId, environmentId)) {
    throw new AppError(
      403,
      'FORBIDDEN',
      environmentId ? `Missing ${base} for this environment` : `Missing ${base} for this app`,
      { requiredScope: environmentId ? `${base}:${envScopeTarget(environmentId)}` : `${base}:${appId}` }
    );
  }
}
