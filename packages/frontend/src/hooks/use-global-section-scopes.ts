import { useMemo } from "react";
import { globalSectionScopes } from "@/lib/app-navigation";
import { hasScopeBase, scopeMatches } from "@/lib/scope-utils";
import { useAuthStore } from "@/stores/auth";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";

const NO_SCOPES: readonly string[] = [];

/** Scope bases the user holds only through app places (UI bootstrap). */
export function useAppOnlyScopeBases(): readonly string[] | undefined {
  return useUIBootstrapStore((state) => state.snapshot?.navigation.appOnlyScopeBases);
}

export interface GlobalSectionAccess {
  scopes: readonly string[];
  /** Any grant of the base outside app places (broad, node, user folder or resource). */
  hasScopedAccess: (scopeBase: string) => boolean;
  hasScope: (scope: string) => boolean;
}

/**
 * Access to the global sections (Docker, Routes, Databases, Storage, Pages): grants held only
 * through app places do not count, so a user limited to an app works through Apps. Pages reached
 * from an app (member details) keep using the full scopes.
 */
export function useGlobalSectionAccess(): GlobalSectionAccess {
  const userScopes = useAuthStore((state) => state.user?.scopes ?? NO_SCOPES);
  const appOnlyScopeBases = useAppOnlyScopeBases();
  return useMemo(() => {
    const scopes = globalSectionScopes(userScopes, appOnlyScopeBases);
    return {
      scopes,
      hasScopedAccess: (scopeBase: string) => hasScopeBase(scopes, scopeBase),
      hasScope: (scope: string) => scopeMatches(scopes, scope),
    };
  }, [appOnlyScopeBases, userScopes]);
}
