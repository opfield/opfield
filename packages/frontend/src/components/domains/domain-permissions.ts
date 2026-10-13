export interface DomainPermissions {
  canCreateDomain: boolean;
  canEditDomain: boolean;
  canDeleteDomain: boolean;
  canInspectCloudflare: boolean;
}

/**
 * Opfield-managed domain actions are authorized exclusively by domains:*
 * scopes. Cloudflare scopes only control whether the UI may inspect connector
 * status; they never enable a domain action.
 */
export function getDomainPermissions(
  hasScope: (scope: string) => boolean,
  domainId?: string | null,
  hasScopedAccess?: (scopeBase: string) => boolean
): DomainPermissions {
  const grants = (scope: string) =>
    hasScope(scope) || (!!domainId && hasScope(`${scope}:${domainId}`));
  return {
    // Like the backend creation helpers, any domains:create grant (broad, folder or
    // node) opens the create flow; the dialog then offers only allowed destinations.
    canCreateDomain: hasScopedAccess
      ? hasScopedAccess("domains:create")
      : hasScope("domains:create"),
    canEditDomain: grants("domains:edit"),
    canDeleteDomain: grants("domains:delete"),
    canInspectCloudflare:
      hasScope("integrations:cloudflare:view") || hasScope("integrations:cloudflare:manage"),
  };
}
