import { useEffect, useState } from "react";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { AccessIdentityProvider } from "@/types";

export interface AccessChoice {
  value: string;
  label: string;
}

/** What the access list dialog offers in its selects; null where the caller may not read it. */
export interface AccessChoices {
  providers: AccessIdentityProvider[] | null;
  users: AccessChoice[] | null;
  groups: AccessChoice[] | null;
  serviceTokens: AccessChoice[] | null;
  defaultSessionTtlSeconds: number | null;
  loading: boolean;
}

const settle = <T>(promise: Promise<T>) => promise.catch(() => null);

/**
 * Loads the identity providers, Opfield users and groups, service tokens and the default session
 * length the access list dialog shows. Lists the caller has no scope for are skipped and stay null.
 */
export function useAccessChoices(): AccessChoices {
  const hasScope = useAuthStore((state) => state.hasScope);
  const hasScopedAccess = useAuthStore((state) => state.hasScopedAccess);
  const [choices, setChoices] = useState<AccessChoices>({
    providers: null,
    users: null,
    groups: null,
    serviceTokens: null,
    defaultSessionTtlSeconds: null,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    const canReadUsers = hasScopedAccess("admin:users");
    const canReadGroups = hasScopedAccess("admin:groups");
    const canReadSettings = hasScope("admin:system");
    void Promise.all([
      settle(api.listAccessIdentityProviders()),
      canReadUsers ? settle(api.listUsers()) : null,
      canReadGroups ? settle(api.listGroups()) : null,
      settle(api.listAccessServiceTokens()),
      canReadSettings ? settle(api.getAccessSignInSettings()) : null,
    ]).then(([providers, users, groups, serviceTokens, settings]) => {
      if (cancelled) return;
      setChoices({
        providers,
        users:
          users
            ?.filter((user) => !user.isDeleted)
            .map((user) => ({ value: user.id, label: user.name || user.email })) ?? null,
        groups: groups?.map((group) => ({ value: group.id, label: group.name })) ?? null,
        serviceTokens:
          serviceTokens?.map((token) => ({ value: token.id, label: token.name })) ?? null,
        defaultSessionTtlSeconds: settings?.defaultSessionTtlSeconds ?? null,
        loading: false,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [hasScope, hasScopedAccess]);

  return choices;
}
