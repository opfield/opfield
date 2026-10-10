import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { appDetailCacheKey } from "@/services/api-apps";
import { APPS_REALTIME_CHANNEL, type AppDetail, type AppsChangedPayload } from "@/types";

/**
 * The app of an Apps page, by slug or id, kept current by the `apps` realtime channel.
 * `version` bumps on every realtime change of this app so tabs can reload their rows.
 */
export function useAppDetail(idOrSlug: string | undefined, initial?: AppDetail | null) {
  const [app, setApp] = useState<AppDetail | null>(
    () =>
      initial ?? (idOrSlug ? (api.getCached<AppDetail>(appDetailCacheKey(idOrSlug)) ?? null) : null)
  );
  const [loading, setLoading] = useState(!app);
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);
  const appIdRef = useRef<string | null>(app?.id ?? null);

  const reload = useCallback(async () => {
    if (!idOrSlug) return;
    try {
      const next = await api.getApp(idOrSlug);
      appIdRef.current = next.id;
      api.setCache(appDetailCacheKey(idOrSlug), next);
      setApp(next);
      setError(null);
    } catch (reason) {
      setError(reason);
    } finally {
      setLoading(false);
    }
  }, [idOrSlug]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useRealtime(APPS_REALTIME_CHANNEL, (raw) => {
    const payload = raw as AppsChangedPayload;
    if (appIdRef.current && payload?.appId && payload.appId !== appIdRef.current) return;
    setVersion((current) => current + 1);
    void reload();
  });

  const refresh = useCallback(async () => {
    setVersion((current) => current + 1);
    await reload();
  }, [reload]);

  return { app, setApp, loading, error, version, refresh };
}
